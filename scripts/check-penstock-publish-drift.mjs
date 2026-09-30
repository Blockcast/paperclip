#!/usr/bin/env node
/**
 * check-penstock-publish-drift.mjs — fail when the fork's SDK packages have
 * changed but the corresponding `@penstock/*` publish has not happened.
 *
 * WHY THIS EXISTS
 * ---------------
 * Plugins load `@paperclipai/{plugin-sdk,shared}` from the shared plugin store,
 * which resolves them through an npm alias to the fork's own publish:
 *
 *   "@paperclipai/plugin-sdk": "npm:@penstock/plugin-sdk@<ver>"
 *
 * Until 2026-09-01 a boot-time vendor copy in server/src/index.ts pasted the
 * workspace `dist` over whatever the store had installed, so a missed publish
 * was invisible — the copy silently covered it. That copy is gone (PR #1589),
 * which is correct but removes the safety net: a missed publish now surfaces at
 * runtime as a plugin worker crashing on `does not provide an export named ...`,
 * which is louder but strictly worse than the torn store it replaced.
 *
 * Nothing else enforces the pairing, and the drift is invisible in review: a PR
 * touching packages/plugins/sdk looks complete and merges green while the store
 * quietly falls a revision behind. This check closes that gap by comparing what
 * master builds against what npm actually serves.
 *
 * WHAT IT COMPARES
 * ----------------
 * The emitted `dist/**\/*.js` of each workspace package against the same files in
 * the published tarball. Rationale:
 *   - `.js` only. `.js.map` and `.d.ts.map` embed absolute source paths that
 *     differ between a CI checkout and the release runner, so including them
 *     would report drift on every run.
 *   - Emitted output, not source, because that is what a plugin actually loads.
 *     Comment-only or type-only source edits that emit identical JS are not
 *     drift and must not fail this check.
 *
 * This comparison assumes `tsc` emit is deterministic for identical source.
 * That held when measured on 2026-09-01: the then-published plugin-sdk and the
 * workspace build were byte-identical across all 60 files.
 *
 * PREREQUISITE: both packages must already be built (`pnpm --filter ... build`).
 *
 * Usage:
 *   node scripts/check-penstock-publish-drift.mjs
 *   node scripts/check-penstock-publish-drift.mjs --json
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

// Workspace package dir -> published name under the Blockcast-owned scope.
// Mirrors the RENAME map in scripts/publish-penstock-scope.mjs; keep in sync.
const PACKAGES = [
  { dir: "packages/shared", published: "@penstock/shared" },
  { dir: "packages/plugins/sdk", published: "@penstock/plugin-sdk" },
];

const asJson = process.argv.includes("--json");

/** Every .js file under `root`, as posix-relative paths. Sorted for stable hashing. */
export function listJs(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".js")) out.push(relative(root, full).split(sep).join("/"));
    }
  };
  walk(root);
  return out.sort();
}

/** Content hash over (path, bytes) pairs, so a renamed or dropped file is drift too. */
export function hashTree(root, files) {
  const h = createHash("sha256");
  for (const f of files) {
    h.update(f);
    h.update("\0");
    h.update(readFileSync(join(root, f)));
    h.update("\0");
  }
  return h.digest("hex");
}

/**
 * Compare two emitted `dist` trees. Pure: no network, no npm, no process exit —
 * so the drift semantics can be tested directly against fixtures.
 *
 * Returns `{ inSync, changed, onlyInWorkspace, onlyInPublished }`, where the
 * three arrays are posix-relative `.js` paths. A rename shows up as one entry in
 * each of the `only*` arrays rather than as `changed`.
 */
export function compareDistTrees(workspaceDist, publishedDist) {
  const wsFiles = listJs(workspaceDist);
  const pubFiles = listJs(publishedDist);
  const inSync = hashTree(workspaceDist, wsFiles) === hashTree(publishedDist, pubFiles);
  const onlyInWorkspace = wsFiles.filter((f) => !pubFiles.includes(f));
  const onlyInPublished = pubFiles.filter((f) => !wsFiles.includes(f));
  const changed = wsFiles
    .filter((f) => pubFiles.includes(f))
    .filter((f) => !readFileSync(join(workspaceDist, f)).equals(readFileSync(join(publishedDist, f))));
  return { inSync, changed, onlyInWorkspace, onlyInPublished, workspaceFileCount: wsFiles.length };
}

// Importing this module (e.g. from scripts/__tests__) must not run the CLI.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
const results = [];
let drifted = false;

for (const { dir, published } of PACKAGES) {
  const workspaceDist = resolve(dir, "dist");
  let tmp;
  try {
    statSync(workspaceDist);
  } catch {
    console.error(`Error: ${dir}/dist not found — build the packages before running this check.`);
    process.exit(2);
  }

  try {
    tmp = mkdtempSync(join(tmpdir(), "penstock-drift-"));
    let tarball;
    try {
      tarball = execFileSync("npm", ["pack", `${published}@latest`, "--pack-destination", tmp], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      })
        .trim()
        .split("\n")
        .pop();
    } catch (err) {
      // A package that has never been published is drift by definition, not an
      // infrastructure error — report it in the same shape so the fix is obvious.
      results.push({ package: published, status: "never-published", detail: String(err.message).slice(0, 200) });
      drifted = true;
      continue;
    }

    execFileSync("tar", ["xzf", join(tmp, tarball), "-C", tmp]);
    const publishedDist = join(tmp, "package", "dist");

    const cmp = compareDistTrees(workspaceDist, publishedDist);
    if (cmp.inSync) {
      results.push({ package: published, status: "in-sync", files: cmp.workspaceFileCount });
    } else {
      drifted = true;
      results.push({
        package: published,
        status: "drift",
        onlyInWorkspace: cmp.onlyInWorkspace,
        onlyInPublished: cmp.onlyInPublished,
        changed: cmp.changed,
      });
    }
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
}

if (asJson) {
  console.log(JSON.stringify({ drifted, results }, null, 2));
} else {
  for (const r of results) {
    if (r.status === "in-sync") {
      console.log(`✓ ${r.package}: in sync with npm (${r.files} emitted .js files)`);
    } else if (r.status === "never-published") {
      console.log(`✗ ${r.package}: not published to npm`);
    } else {
      console.log(`✗ ${r.package}: DRIFT`);
      for (const f of r.changed) console.log(`    changed:            ${f}`);
      for (const f of r.onlyInWorkspace) console.log(`    only in workspace:  ${f}`);
      for (const f of r.onlyInPublished) console.log(`    only in published:  ${f}`);
    }
  }
}

if (drifted) {
  console.error(
    [
      "",
      "The fork's SDK packages differ from what npm serves.",
      "",
      "Plugins resolve @paperclipai/{plugin-sdk,shared} to @penstock/* through an",
      "npm alias in the plugin store, so until these are republished the store is a",
      "revision behind master. Any plugin importing a newly-added runtime export",
      "will crash on 'does not provide an export named ...'.",
      "",
      "Publish (unattended, ~4 min) with a fresh CalVer YYYY.MMDD.N:",
      "",
      "  gh workflow run release-penstock-scope.yml --repo Blockcast/paperclip \\",
      "    --ref master -f version=YYYY.MMDD.N -f dry_run=false",
      "",
      "Then repoint the plugin store to the new version. See",
      "scripts/publish-penstock-scope.mjs for the full release rationale.",
      "",
    ].join("\n"),
  );
  process.exit(1);
}
}
