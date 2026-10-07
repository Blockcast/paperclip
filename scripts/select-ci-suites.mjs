#!/usr/bin/env node
// Path-scoped selection of the expensive PR suites.
//
// pr.yml's `policy` job runs this once and publishes one boolean per suite
// group; the heavy steps of `general_tests`, `e2e` and `canary_dry_run` read
// them. The only question answered here is "can the diff possibly change the
// outcome of this suite?". The answer FAILS OPEN: a suite is skipped only when
// EVERY changed path is positively classified as unable to reach it. Anything
// unclassified, any failure of this script, and an empty diff all mean "run".
//
// How a suite group G is analysed (everything is derived from the checkout, no
// package names are hard-coded):
//
//  1. Closure. Start from the workspace directories that hold G's test code
//     (`roots`). Add every workspace named in a package.json dependency field of
//     a member, and every workspace a member's sources reach by a relative path
//     (`../../packages/x/...`) or a repo-rooted path literal (`packages/x/...`).
//     Repeat to a fixpoint. A changed file inside a closure workspace is relevant.
//  2. References. Every path literal found in closure sources, in the root
//     package.json scripts and, transitively, in the non-workspace files those
//     name (scripts importing scripts) is recorded. A changed file equal to, or
//     inside, a recorded path is relevant: this is what keeps
//     `doc/execution-semantics.md`, `deploy/helm/**` and the workflows that
//     server tests read relevant.
//  3. Always relevant: pr.yml, .github/actions/**, this selector and the shard /
//     runner scripts, every root file that is not plainly prose, and every
//     directory this file does not know.
//  4. Reference-checked inert directories (docs, ops, CI metadata, vendored code
//     with its own lane, scripts not reachable from a test command): skippable
//     only when step 2 found no reference to the changed file.
//
// scripts/__tests__/select-ci-suites.test.mjs pins each rule.

import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_SOURCE_BYTES = 1_500_000;
// Non-workspace files scanned for further references. Loose data files (for
// example scripts/general-server-shard-durations.json) are references, not sources.
const LOOSE_SOURCE_EXT = /\.(?:[cm]?[jt]sx?|sh)$/;
// Inside a workspace package.json files carry `node ../../scripts/x.mjs` hooks.
const WORKSPACE_SOURCE_EXT = /\.(?:[cm]?[jt]sx?|sh|json)$/;

export const UNIT_GROUP_A_ROOTS = ["ui", "cli"];

// `roots` are workspace dirs holding the suite's test code; `sourceDirs` are
// extra non-workspace dirs scanned as sources; `rootScripts` are the root package.json
// scripts CI runs for the suite; `notInert` are loose paths the
// suite owns outright; `scriptsAlwaysRelevant` treats every script as a suite
// input (release.sh and the e2e harness shell out to siblings by name).
export function groupDefinitions(workspaces, vitestProjectDirs) {
  const all = workspaces.map((w) => w.dir);
  const bRoots = vitestProjectDirs.filter((d) => d !== "server" && !UNIT_GROUP_A_ROOTS.includes(d));
  const unitScripts = ["test:run", "test:run:general", "test:run:serialized", "preflight:workspace-links"];
  const unit = { sourceDirs: [], notInert: [], scriptsAlwaysRelevant: false, rootScripts: unitScripts };
  return {
    server_tests_needed: { ...unit, roots: ["server"] },
    workspaces_a_tests_needed: { ...unit, roots: [...UNIT_GROUP_A_ROOTS] },
    workspaces_b_tests_needed: { ...unit, roots: bRoots },
    // The Playwright suite boots `paperclipai onboard --yes --run` (cli -> server)
    // against the built ui bundle; tests/e2e is its own source tree.
    ui_e2e_needed: {
      roots: ["server", "ui", "cli"],
      sourceDirs: ["tests/e2e"],
      notInert: ["tests/e2e"],
      scriptsAlwaysRelevant: true,
      rootScripts: [...unitScripts, "test:e2e", "paperclipai", "build"],
    },
    // release.sh builds and packs every workspace package and writes release notes.
    release_dry_run_needed: { roots: all, sourceDirs: [], notInert: ["releases"],
      scriptsAlwaysRelevant: true,
      rootScripts: ["release", "release:canary", "build", "build:npm", "typecheck"],
    },
  };
}

export const GROUP_NAMES = [
  "server_tests_needed",
  "workspaces_a_tests_needed",
  "workspaces_b_tests_needed",
  "ui_e2e_needed",
  "release_dry_run_needed",
];

// Directories that are prose, ops, CI metadata or code with its own lane. Each is
// skippable ONLY when no closure source references the changed file. Everything
// not listed here and not owned by a workspace is "unknown" and therefore relevant.
const INERT_DIRS = [
  "docs",
  "doc",
  ".planning",
  "runbooks",
  "screenshots",
  "report",
  "evals",
  ".merge-evidence",
  "deploy",
  ".agents",
  ".claude",
  "releases",
  ".github",
  "docker",
  "tests",
  // vendor/ is not a pnpm workspace; the vendored adapter has its own CI lane
  // (`vendor_claude_k8s`). Only the files closure sources name by path are relevant.
  "vendor",
  // Scripts are inert only for the unit groups, and only when no test command or
  // closure source reaches them.
  "scripts",
];
const INERT_ROOT_FILE = /^(?:[^/]+\.md|LICENSE|\.mailmap|\.markdownlintignore|\.gitattributes)$/;
const ALWAYS_RELEVANT = [
  /^\.github\/workflows\/pr\.yml$/,
  /^\.github\/actions\//,
  /^patches\//,
  // The selector, its test, and everything that decides which tests run and how.
  /^scripts\/select-ci-suites\.mjs$/,
  /^scripts\/__tests__\/select-ci-suites\.test\.mjs$/,
  /^scripts\/(?:run-vitest-|general-server-shard|measure-general-server-shard|merge-shard-duration|check-shard-manifest|vitest-flake|ensure-)/,
];

export function normalize(p) {
  return p.split(path.sep).join("/").replace(/^\.\//, "");
}

export function gitLs(root) {
  const out = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 1 << 28 });
  return out.split("\0").filter(Boolean);
}

export function readText(root, file) {
  try {
    const abs = path.join(root, file);
    if (statSync(abs).size > MAX_SOURCE_BYTES) return "";
    return readFileSync(abs, "utf8");
  } catch {
    return "";
  }
}

// pnpm-workspace.yaml: `dir/*`, `dir/**` and literal entries plus `!` excludes.
// Anything else throws, which the caller turns into "run everything".
export function listWorkspaces(root, files) {
  const yaml = readText(root, "pnpm-workspace.yaml");
  const include = [];
  const exclude = [];
  for (const rawLine of yaml.split("\n")) {
    const line = rawLine.replace(/#.*$/, "").trim();
    const m = /^-\s*(["']?)(.+?)\1$/.exec(line);
    if (!m) continue;
    const negated = m[2].startsWith("!");
    const pattern = negated ? m[2].slice(1) : m[2];
    if (/[?{}[\]]/.test(pattern) || /\*/.test(pattern.replace(/\/\*\*?$/, ""))) {
      throw new Error(`unsupported workspace pattern: ${m[2]}`);
    }
    (negated ? exclude : include).push(pattern);
  }
  if (include.length === 0) throw new Error("pnpm-workspace.yaml lists no packages");
  const matches = (dir, pattern) => {
    if (pattern.endsWith("/**")) return dir.startsWith(pattern.slice(0, -2));
    if (pattern.endsWith("/*")) return path.posix.dirname(dir) === pattern.slice(0, -2);
    return dir === pattern;
  };
  const pkgDirs = files.filter((f) => f.endsWith("/package.json")).map((f) => path.posix.dirname(f));
  return pkgDirs
    .filter((dir) => include.some((p) => matches(dir, p)) && !exclude.some((p) => matches(dir, p)))
    .sort()
    .map((dir) => {
      const pkg = JSON.parse(readText(root, `${dir}/package.json`));
      return { dir, name: pkg.name, pkg };
    });
}

export function vitestProjectDirs(root) {
  const text = readText(root, "vitest.config.ts");
  const block = /projects:\s*\[([\s\S]*?)\]/.exec(text);
  if (!block) throw new Error("vitest.config.ts has no projects array");
  const dirs = [...block[1].matchAll(/["']([^"']+)["']/g)].map((m) => m[1]);
  if (dirs.length === 0) throw new Error("vitest.config.ts projects array is empty");
  return dirs;
}

function ownerWorkspace(workspaces, file) {
  let best = null;
  for (const w of workspaces) {
    if ((file === w.dir || file.startsWith(`${w.dir}/`)) && (!best || w.dir.length > best.dir.length)) best = w;
  }
  return best;
}

function stripComments(text, isShell) {
  if (isShell) return text.replace(/^[ \t]*#.*$/gm, "");
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

const PATH_LIKE = /^(?:\.{1,2}\/)*[\w@.-]+(?:\/[\w@.-]*)*$/;
const TOKEN_EDGE = /^[\s`'"()[\]{}<>,;:=$]+|[\s`'"()[\]{}<>,;:]+$/g;

// Every repo path a source file may reach, as repo-relative strings. Over-
// approximates on purpose: a spurious reference only keeps a path relevant.
// A string literal counts when it is in whole a path, or (if it contains
// whitespace, i.e. a shell command or message) for each whitespace-separated
// token that is rooted at a top-level repo entry or starts with ./ or ../ .
export function referencedPaths(rawText, fileDir, topNames, { shell = false } = {}) {
  const refs = new Set();
  const text = stripComments(rawText, shell);
  const topAlt = topNames.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const rooted = new RegExp(`^(?:${topAlt})(?:/[\\w.@-]+)+/?$`);
  // path.join(root, "a", "b") -> "a/b" so segment-wise joins read as one path.
  const joined = text.replace(/["'`]\s*,\s*["'`]/g, "/");
  const addPath = (candidate) => {
    if (candidate.length > 300) return;
    if (/^\.{1,2}\//.test(candidate)) {
      const resolved = normalize(path.posix.normalize(path.posix.join(fileDir, candidate)));
      if (!resolved.startsWith("..") && resolved !== ".") refs.add(resolved.replace(/\/$/, ""));
    } else if (rooted.test(candidate)) {
      refs.add(candidate.replace(/\/$/, ""));
    }
  };
  for (const lit of joined.matchAll(/(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g)) {
    let body = lit[2];
    if (body.includes("${")) {
      body = body.slice(0, body.indexOf("${"));
      if (!body.endsWith("/")) body = body.replace(/[^/]*$/, "");
      if (body) addPath(body);
    } else if (PATH_LIKE.test(body)) {
      addPath(body);
    } else if (/\s/.test(body)) {
      for (const token of body.split(/\s+/)) {
        const cleaned = token.replace(TOKEN_EDGE, "");
        // A command or message names a file it runs or reads; a bare directory in
        // `COPY vendor/x /dst` or `git -C packages/y` is an argument, not a read.
        if (/\.\w+$/.test(cleaned)) addPath(cleaned);
      }
    }
  }
  // `repoRoot, "README.md"`: root-level files and bare directories anchored on a
  // root variable. A file that builds throwaway repos (mkdtemp/tmpdir) and never
  // anchors on its own location uses `repoRoot` for the fixture, not for this repo.
  const tempFixtureOnly = /mkdtemp|tmpdir\(|os\.tmpdir/.test(text) && !/import\.meta|__dirname|__filename|process\.cwd\(/.test(text);
  const rootContext = /repoRoot|REPO_ROOT|rootDir|projectRoot|ROOT_DIR/;
  for (const line of joined.split("\n")) {
    if (!rootContext.test(line) || tempFixtureOnly) continue;
    for (const m of line.matchAll(/["'`]([\w.@-]+(?:\/[\w.@/-]+)?)["'`]/g)) {
      if (topNames.includes(m[1].split("/")[0])) refs.add(m[1].replace(/\/$/, ""));
    }
  }
  return refs;
}

// Paths named by the given root package.json scripts, following `pnpm run other`.
function rootScriptRefs(ctx, names) {
  const scripts = JSON.parse(readText(ctx.root, "package.json")).scripts ?? {};
  const seen = new Set();
  const pending = [...names];
  const commands = [];
  while (pending.length > 0) {
    const name = pending.pop();
    if (seen.has(name) || typeof scripts[name] !== "string") continue;
    seen.add(name);
    commands.push(scripts[name]);
    for (const m of scripts[name].matchAll(/\bpnpm(?: run)?(?: --filter \S+)?(?: exec)? ([\w:.-]+)/g)) pending.push(m[1]);
  }
  return referencedPaths(JSON.stringify(commands), ".", ctx.topNames);
}

// A script naming a sibling by file name (`source "$(dirname "$0")/release-lib.sh"`).
function siblingScriptRefs(rawText, fileDir, looseFiles) {
  const out = new Set();
  for (const m of rawText.matchAll(/(?<![\w.-])([\w-]+(?:\.[\w-]+)*\.(?:sh|mjs|cjs|js|ts|py))(?![\w-])/g)) {
    const candidate = fileDir === "." ? m[1] : `${fileDir}/${m[1]}`;
    if (looseFiles.has(candidate)) out.add(candidate);
  }
  return out;
}

export function buildContext(root) {
  const files = gitLs(root);
  const workspaces = listWorkspaces(root, files);
  const byName = new Map(workspaces.map((w) => [w.name, w]));
  const topNames = [...new Set(files.map((f) => f.split("/")[0]))].filter((n) => n.length > 0);
  const filesByDir = new Map(workspaces.map((w) => [w.dir, []]));
  const loose = new Set();
  for (const f of files) {
    const w = ownerWorkspace(workspaces, f);
    if (w) filesByDir.get(w.dir).push(f);
    else loose.add(f);
  }
  return { root, files, workspaces, byName, topNames, filesByDir, looseFiles: loose, refCache: new Map(), reachCache: {} };
}

// Fixpoint over workspaces and referenced non-workspace source files.
export function computeReach(ctx, group) {
  const { root, workspaces, byName, topNames, filesByDir, looseFiles, refCache } = ctx;
  const closure = new Set();
  const refs = new Set();
  const provenance = new Map();
  const scanned = new Set();
  const workspaceQueue = [];
  const looseQueue = [];

  const refsOf = (f) => {
    let cached = refCache.get(f);
    if (!cached) {
      const text = readText(root, f);
      const dir = path.posix.dirname(f);
      cached = referencedPaths(text, dir, topNames, { shell: f.endsWith(".sh") });
      if (looseFiles.has(f) && /\.(?:sh|mjs|cjs|js|ts)$/.test(f)) {
        for (const sibling of siblingScriptRefs(text, dir, looseFiles)) cached.add(sibling);
      }
      refCache.set(f, cached);
    }
    return cached;
  };
  const addWorkspace = (dir) => {
    if (!closure.has(dir)) {
      closure.add(dir);
      workspaceQueue.push(dir);
    }
  };
  const enqueueLoose = (f) => {
    if (looseFiles.has(f) && LOOSE_SOURCE_EXT.test(f) && !scanned.has(f)) {
      scanned.add(f);
      looseQueue.push(f);
    }
  };
  const enqueueLooseDir = (dir) => {
    for (const f of looseFiles) if (f.startsWith(`${dir}/`)) enqueueLoose(f);
  };
  const absorb = (fileRefs, from) => {
    for (const ref of fileRefs) {
      if (!refs.has(ref)) {
        refs.add(ref);
        provenance.set(ref, from);
        const owner = ownerWorkspace(workspaces, ref);
        if (owner) addWorkspace(owner.dir);
        // A reference to a directory that CONTAINS workspaces reaches them all.
        if (ref.includes("/")) for (const w of workspaces) if (w.dir.startsWith(`${ref}/`)) addWorkspace(w.dir);
        if (looseFiles.has(ref)) enqueueLoose(ref);
        else if (ref.includes("/")) enqueueLooseDir(ref);
      }
    }
  };

  for (const dir of group.roots) addWorkspace(dir);
  for (const dir of group.sourceDirs) enqueueLooseDir(dir);
  // The root package.json scripts are the commands CI runs (`pnpm test:run:general`,
  // `pnpm test:e2e`, `preflight:workspace-links`, `release:canary`).
  absorb(rootScriptRefs(ctx, group.rootScripts), "package.json");

  while (workspaceQueue.length > 0 || looseQueue.length > 0) {
    const dir = workspaceQueue.shift();
    if (dir !== undefined) {
      const { pkg } = workspaces.find((x) => x.dir === dir);
      for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
        for (const dep of Object.keys(pkg[field] ?? {})) {
          const target = byName.get(dep);
          if (target) addWorkspace(target.dir);
        }
      }
      for (const f of filesByDir.get(dir)) if (WORKSPACE_SOURCE_EXT.test(f)) absorb(refsOf(f), f);
      continue;
    }
    const f = looseQueue.shift();
    absorb(refsOf(f), f);
  }
  return { closure, refs, provenance };
}

function referencedBy(file, reach) {
  for (const ref of reach.refs) {
    if (file === ref || file.startsWith(`${ref}/`)) return `${reach.provenance.get(ref)} -> ${ref}`;
  }
  return null;
}

export function classifyPath(file, ctx, group, reach) {
  if (ALWAYS_RELEVANT.some((re) => re.test(file))) return { relevant: true, why: "always-relevant" };
  const owner = ownerWorkspace(ctx.workspaces, file);
  if (owner) {
    if (reach.closure.has(owner.dir)) return { relevant: true, why: `workspace ${owner.dir} in closure` };
    const via = referencedBy(file, reach);
    return via
      ? { relevant: true, why: `referenced: ${via}` }
      : { relevant: false, why: `workspace ${owner.dir} outside closure` };
  }
  if (!file.includes("/")) {
    if (!INERT_ROOT_FILE.test(file)) return { relevant: true, why: "root file" };
    const via = referencedBy(file, reach);
    return via ? { relevant: true, why: `root file referenced: ${via}` } : { relevant: false, why: "inert root file" };
  }
  const top = file.split("/")[0];
  if (group.notInert.some((p) => file === p || file.startsWith(`${p}/`))) return { relevant: true, why: "suite-owned path" };
  if (top === "scripts" && group.scriptsAlwaysRelevant) return { relevant: true, why: "scripts are inputs of this suite" };
  if (INERT_DIRS.includes(top)) {
    const via = referencedBy(file, reach);
    return via ? { relevant: true, why: `referenced: ${via}` } : { relevant: false, why: `inert ${top}/` };
  }
  return { relevant: true, why: "unclassified path" };
}

export function selectSuites(changedFiles, ctx, groups) {
  const decisions = {};
  for (const [name, group] of Object.entries(groups)) {
    const reach = (ctx.reachCache[name] ??= computeReach(ctx, group));
    let trigger = null;
    for (const file of changedFiles) {
      const verdict = classifyPath(file, ctx, group, reach);
      if (verdict.relevant) {
        trigger = { file, why: verdict.why };
        break;
      }
    }
    decisions[name] = { needed: trigger !== null, trigger };
  }
  return decisions;
}

export function allNeeded(reason) {
  const out = {};
  for (const name of GROUP_NAMES) out[name] = { needed: true, trigger: { file: "*", why: reason } };
  return out;
}

export function diffNames(root, base, head) {
  if (!base || !head) throw new Error("PR_BASE_SHA/PR_HEAD_SHA missing");
  const out = execFileSync("git", ["diff", "--name-only", "--no-renames", "-z", `${base}...${head}`], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 1 << 28,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return out.split("\0").filter(Boolean).map(normalize);
}

// Never throws: every failure path is "run everything".
export function decide({ root, base, head, changed, ctx: given }) {
  try {
    const files = changed ?? diffNames(root, base, head);
    if (files.length === 0) return allNeeded("empty diff");
    const ctx = given ?? buildContext(root);
    const groups = groupDefinitions(ctx.workspaces, vitestProjectDirs(root));
    const missing = GROUP_NAMES.filter((n) => !(n in groups));
    if (missing.length > 0) return allNeeded(`group definition missing: ${missing.join(",")}`);
    return selectSuites(files, ctx, groups);
  } catch (error) {
    return allNeeded(`selector error: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function formatOutputs(decisions) {
  return GROUP_NAMES.map((name) => `${name}=${decisions[name].needed ? "true" : "false"}`).join("\n") + "\n";
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const decisions = decide({ root, base: process.env.PR_BASE_SHA, head: process.env.PR_HEAD_SHA });
  const describe = (d) => (d.trigger ? `${d.trigger.why}: ${d.trigger.file}` : "no changed path can reach this suite");
  console.log(GROUP_NAMES.map((n) => `${n}=${decisions[n].needed}  (${describe(decisions[n])})`).join("\n"));
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, formatOutputs(decisions));
  if (process.env.GITHUB_STEP_SUMMARY) {
    const rows = GROUP_NAMES.map((n) => `| ${n} | ${decisions[n].needed} | ${describe(decisions[n])} |`).join("\n");
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### CI suite selection\n\n| output | needed | first reason |\n|---|---|---|\n${rows}\n`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
