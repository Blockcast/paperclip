#!/usr/bin/env node
// Re-resolves the source line-anchors in docs/security/** against the tree (PEN-5091).
//
// A decision record that cites source as `file.ts:2871` is making a claim that
// decays every time that file moves. Between 2026-10-29 and 2026-10-30 the anchors
// in PEN-5016-github-publish-broker-enablement-plan.md were corrected four separate
// times, and on three of those the correction went stale before it merged --
// `job-manifest.ts` moved three times in six hours. No amount of re-measuring wins
// that race, because the falsifying change is in a PR that never opens the document.
//
// So: THE NAMED CONSTRUCT IS THE CITATION AND THE LINE NUMBER IS A CACHE. This check
// re-resolves the cache. Run it on every PR -- a `paths:` filter on the document
// would make it structurally unable to catch the case it exists for.
//
// ANCHOR SYNTAX
//
//   `server/src/services/heartbeat.ts:8286`   qualified -- carries its own path
//   `:7050`                                   bare -- resolves against the file context
//   `:3962-3964`                              a range; the construct may be anywhere in it
//
// A RANGE must additionally name a construct that occurs exactly ONCE in the file.
// "Somewhere in these N lines" is a weak assertion that an unrelated occurrence can
// satisfy by drifting into the window, so a range on a repeated symbol can report
// `ok` while citing the wrong code. Pin it with the explicit form below.
//
// File context for bare anchors is declared by an HTML comment, invisible when
// rendered, and holds until the next one:
//
//   <!-- anchor-file: server/src/services/heartbeat.ts -->
//
// Inheriting context from prose instead was tried and does not work: in
// issue-authorization-model.md the governing path sits in a TABLE HEADER, and a
// parser that tracks "the most recent path-shaped code span" silently resolved 25
// anchors against the wrong file and reported them all as drifted. A wrong file is
// worse than no file, so a bare anchor with no declared context is an error.
//
// Anchors into another repository cannot be resolved from this tree. Declare them
// and they are reported and skipped rather than silently passing:
//
//   <!-- anchor-external: penstock-vault-node -->
//
// A region ends where the next directive begins, so a cross-repo aside in the middle
// of a document needs a way to hand the rest of the file back. `<!-- anchor-local -->`
// clears the context: qualified anchors below it resolve against this tree again, and
// a bare one reports as having no file context rather than silently inheriting the
// aside's repository.
//
// THE CONSTRUCT
//
// The construct is the code span the anchor points at: the nearest one on the same
// line, searching LEFT first, skipping spans that are themselves anchors or bare
// file paths. Left-first is not arbitrary -- it is the convention the corpus already
// uses (`mergeModelProfileAdapterConfig` (`:7050`), or a table cell naming the symbol
// in the column before the anchor). Where nothing qualifies to the left the search
// goes right, which covers `Read at `job-manifest.ts` `:2901`, `asBoolean(...)``.
//
// To override the inference, put the construct in parentheses directly after the
// anchor -- this wins over both directions:
//
//   `job-manifest.ts:2901` (`asBoolean(config.enableGitHubPublishBroker, false)`)
//
// Assertion: the construct's text, with runs of whitespace collapsed, must appear
// within the cited lines. Matching is on the collapsed text rather than the raw
// line so that a reformat which only rewraps a call does not report as drift.
//
// ATTRIBUTION
//
// A failure this PR did not cause is INHERITED: reported in full, never fatal. One this
// PR did cause is INTRODUCED and fails it. Pass --base <ref> to enable that comparison;
// without it every failure is fatal, which is the right shape for a local run against
// one tree but not for a gate. See attributeInherited below for the two introduced
// cases, and for why INHERITED is wider than "already failing on the base": an anchor
// that RESOLVED at the base and drifted because master moved mid-run is inherited too,
// and is reported under its own label so the output does not claim the run checked
// something it did not.
//
// Usage:
//   check-doc-line-anchors.mjs [--root <dir>] [--glob <pattern>] [--base <ref>]
//                              [--head <ref>] [--fix] [--quiet]
//
// --head names the commit whose diff against --base is "what this PR changed". It
// defaults to the worktree HEAD, which is right locally and WRONG under a
// `pull_request` checkout of `refs/pull/N/merge`; see changedSince.
//
// --fix rewrites a drifted line number in place when the construct occurs EXACTLY
// ONCE in the file. An ambiguous construct is left alone and reported: picking one
// of several matches would silently re-point a security citation at the wrong one.
//
// Exit 0 clean, 1 anchors need attention, 2 cannot judge.

import { readFileSync, writeFileSync, existsSync, globSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const CODE_SPAN = /`([^`\n]+)`/g;
const ANCHOR = /^([\w./-]*):(\d+)(?:-(\d+))?$/;
const DIRECTIVE_FILE = /^\s*<!--\s*anchor-file:\s*(\S+?)\s*-->\s*$/;
const DIRECTIVE_EXTERNAL = /^\s*<!--\s*anchor-external:\s*(.+?)\s*-->\s*$/;
const DIRECTIVE_LOCAL = /^\s*<!--\s*anchor-local\s*-->\s*$/;
const PATH_LIKE = /^(?:[\w./-]*\/)?[\w.-]+\.(?:ts|tsx|mjs|cjs|js|jsx|rs|go|py|sql|ya?ml|json|md|sh)$|^Dockerfile[\w.-]*$/;

const collapse = (s) => s.replace(/\s+/g, " ").trim();

// A code span is an anchor only if its path half is empty or actually looks like a
// path. Without that, `issue:coordination_metadata` and `tasks:assign` parse as
// anchors into a file named "issue".
export function parseAnchorSpan(text) {
  const m = ANCHOR.exec(text);
  if (!m) return null;
  const [, path, lo, hi] = m;
  if (path && !PATH_LIKE.test(path)) return null;
  if (hi !== undefined && Number(hi) < Number(lo)) return null;
  return { path: path || null, lo: Number(lo), hi: hi === undefined ? Number(lo) : Number(hi) };
}

// Spans are collected over the whole document rather than per line, because an
// annotation is routinely split by the 100-column wrap these documents are written
// to -- the anchor ends one line and `(`construct`)` opens the next.
export function spansOf(text) {
  CODE_SPAN.lastIndex = 0;
  let line = 1;
  let scanned = 0;
  return [...text.matchAll(CODE_SPAN)].map((m) => {
    for (let i = scanned; i < m.index; i++) if (text[i] === "\n") line++;
    scanned = m.index;
    return { text: m[1], start: m.index, end: m.index + m[0].length, line };
  });
}

// Explicit form wins: `anchor` (`construct`). Between the two may sit only the open
// paren, whitespace (including ONE wrap), and markdown emphasis markers -- `**`:3418`**
// (`...`)` is the same annotation as ``:3418` (`...`)`. Anything else and this is an
// ordinary parenthetical sentence, not an annotation.
const BETWEEN_ANCHOR_AND_CONSTRUCT = /^[*_ \t]*\n?[*_ \t]*\(\s*$/;

function explicitConstruct(text, spans, index) {
  const next = spans[index + 1];
  if (!next) return null;
  const between = text.slice(spans[index].end, next.start);
  return BETWEEN_ANCHOR_AND_CONSTRUCT.test(between) ? next.text : null;
}

// The inferred construct stays strictly same-line. Letting inference wrap would let
// it reach across a paragraph and name a span the author never meant, and silently:
// an inferred construct that happens to be present reports `ok`.
export function resolveConstruct(text, spans, index) {
  const explicit = explicitConstruct(text, spans, index);
  if (explicit) return explicit;
  const usable = (s) =>
    s.line === spans[index].line && !parseAnchorSpan(s.text) && !PATH_LIKE.test(s.text);
  const left = spans.slice(0, index).reverse().find(usable);
  if (left) return left.text;
  return spans.slice(index + 1).find(usable)?.text ?? null;
}

export function parseDirective(line) {
  if (DIRECTIVE_LOCAL.test(line)) return { path: null, external: null };
  const file = DIRECTIVE_FILE.exec(line);
  if (file) return { path: file[1], external: null };
  // `anchor-external` names the repository and NOT a path, deliberately. A section
  // citing several files of another repo (PEN-1650 cites two) would otherwise have
  // to pick one of them to stand for all, and the report would print a path the
  // anchor does not belong to.
  const external = DIRECTIVE_EXTERNAL.exec(line);
  if (external) return { path: null, external: external[1] };
  return null;
}

// Every occurrence of the construct in the file, as 1-based line numbers. Used to
// tell the author where the construct went, and by --fix to decide whether the
// relocation is unambiguous.
export function locateConstruct(sourceLines, construct) {
  const needle = collapse(construct);
  const hits = [];
  for (let i = 0; i < sourceLines.length; i++) {
    if (collapse(sourceLines[i]).includes(needle)) hits.push(i + 1);
  }
  return hits;
}

export function checkDocument({ docPath, docText, readSource }) {
  const findings = [];

  // Directives are line-scoped; anchors are not. Build the line -> context map
  // first, then resolve each anchor against the directive in force at its line.
  const contexts = [];
  docText.split("\n").forEach((line, i) => {
    const directive = parseDirective(line);
    if (directive) contexts.push({ line: i + 1, ...directive });
  });
  const contextAt = (line) => {
    let found = null;
    for (const c of contexts) {
      if (c.line > line) break;
      found = c;
    }
    return found;
  };

  const spans = spansOf(docText);
  spans.forEach((span, index) => {
    const anchor = parseAnchorSpan(span.text);
    if (!anchor) return;

    const context = contextAt(span.line);
    const base = {
      docPath,
      docLine: span.line,
      anchor: span.text,
      lo: anchor.lo,
      hi: anchor.hi,
      start: span.start,
      end: span.end,
    };

    // `anchor-external` covers its whole region, qualified anchors included: a
    // section citing another repo cites it by path too, and `src/mcp_worker.rs:78`
    // is no more resolvable here for being spelled out.
    const external = context?.external ?? null;
    if (external) {
      findings.push({ ...base, status: "external", file: null, repo: external });
      return;
    }
    const file = anchor.path ?? context?.path ?? null;
    if (!file) {
      findings.push({ ...base, status: "no-file-context", file: null });
      return;
    }

    const construct = resolveConstruct(docText, spans, index);
    if (!construct) {
      findings.push({ ...base, status: "no-construct", file });
      return;
    }

    const source = readSource(file);
    if (source === null) {
      findings.push({ ...base, status: "missing-file", file, construct });
      return;
    }

    const sourceLines = source.split("\n");
    const cited = collapse(sourceLines.slice(anchor.lo - 1, anchor.hi).join("\n"));
    if (cited.includes(collapse(construct))) {
      // A hit inside the range is not proof the range is the right one. When the
      // construct also occurs elsewhere in the file, "somewhere in these N lines"
      // can be satisfied by an unrelated occurrence that drifted into the window.
      // Measured on this corpus: `:811-820` (`narrowWritableSurface`, 19 sites in
      // the file) reported `ok` while citing a refusal clause ~270 lines away from
      // the branch its prose describes. The check cannot tell those apart, so a
      // RANGE must name a construct that is unique to the file.
      //
      // A single-line anchor is deliberately not failed on the same ground: its
      // assertion is already as tight as a line number can make it, and all four
      // of the corpus's ambiguous single-line anchors land on what their prose
      // describes. They are counted in the summary so the weaker form stays
      // visible instead of being reported as unqualified `ok`.
      const sites = locateConstruct(sourceLines, construct);
      const ambiguous = anchor.hi > anchor.lo && sites.length > 1;
      findings.push({ ...base, status: ambiguous ? "ambiguous" : "ok", file, construct, sites });
      return;
    }
    findings.push({
      ...base,
      status: "drifted",
      file,
      construct,
      actual: locateConstruct(sourceLines, construct),
    });
  });

  return findings;
}

// Rewrite drifted anchors whose construct occurs exactly once. Single-line anchors
// only: relocating a RANGE means re-deriving its extent, which is a judgement about
// what the citation covers and not something to guess.
export function applyFixes(docText, findings) {
  const fixable = findings.filter(
    (f) => f.status === "drifted" && f.lo === f.hi && f.actual?.length === 1,
  );
  if (fixable.length === 0) return { text: docText, fixed: [] };

  let text = docText;
  // Right-to-left so earlier offsets stay valid as later spans change width.
  for (const f of [...fixable].sort((a, b) => b.start - a.start)) {
    text = text.slice(0, f.start) + `\`${f.anchor.replace(/:\d+$/, `:${f.actual[0]}`)}\`` + text.slice(f.end);
  }
  return { text, fixed: fixable.map((f) => ({ ...f, to: f.actual[0] })) };
}

const FAILING = new Set(["drifted", "ambiguous", "no-construct", "no-file-context", "missing-file"]);

// An anchor's identity for the unverified manifest is (document, anchor, construct) --
// never the line it sits on in the document, which moves whenever the document is
// edited. Changing the anchor or the construct changes the key, so correcting an
// entry drops it out of the manifest on its own.
export const unverifiedKey = (f) => `${f.docPath}\t${f.anchor}\t${f.construct ?? ""}`;

// ATTRIBUTION: an anchor fails the PR only when THIS PR is what stopped it resolving.
//
// Without that distinction the check is a repo-wide tripwire with a manual reset. Any
// merged change that moves a cited file drifts an anchor on master, and from that
// moment every open PR goes red in `policy` -- including PRs that touch neither the
// document nor the source -- until someone lands a correction. This PR measured that
// on itself before it was ever merged: four separate "heal N anchors master drifted
// under this PR" commits, and then a merge-queue ejection (run 42209953505,
// 2026-11-06) at a head whose anchors were correct when they were written and whose
// code-owner sign-off had already been spent on that head. A gate that no PR can hold
// green for the length of its own CI run is not a gate.
//
// A failing anchor is INTRODUCED -- and fatal -- in exactly two cases:
//
//   1. THIS PR TOUCHES THE CITED FILE. You moved the code, so you own the citation.
//      This is the PEN-4932 case the check exists for: the PR moves `job-manifest.ts`
//      and never opens the document.
//   2. THIS PR TOUCHES THE DOCUMENT, and the anchor does not resolve against the
//      BASE's copy of the source either -- so it is a number that was never right,
//      not one the base moved out from under you.
//
// Everything else is INHERITED: the drift reached master by some other route. It is
// printed in full on every run and `--fix` corrects the renumberable ones, but it does
// not fail a PR that did not cause it and often cannot judge it.
//
// Case 2 is what makes the document's own PR survive its CI run. Its anchors are
// checked against the base source, which does not move while the run is in flight;
// a master commit landing mid-run moves the HEAD source only, and that is inherited.
//
// Head and base findings are matched by the anchor's byte offset in the document.
// Both runs read the same document text -- only the source tree differs -- so the
// offsets are identical by construction, and nothing has to be inferred from an
// anchor's line number, which is the one part of it that drifts.
export function attributeInherited(headFindings, baseSourceFindings, changed) {
  const key = (f) => `${f.docPath}\t${f.start}`;
  const resolvedAtBase = new Set(
    baseSourceFindings.filter((f) => !FAILING.has(f.status)).map(key),
  );
  return headFindings.map((f) => {
    if (!FAILING.has(f.status)) return f;
    if (f.file && changed.has(f.file)) return f;
    if (changed.has(f.docPath) && !resolvedAtBase.has(key(f))) return f;
    // Both are inherited and neither is fatal, but they are not the same fact and the
    // report must not state the stronger one. `driftedSinceBase` RESOLVED against the
    // base source and fails only at HEAD -- master moved under a run in flight -- so
    // "already failing on the base" would describe a check that was never made.
    return { ...f, inherited: true, driftedSinceBase: resolvedAtBase.has(key(f)) };
  });
}

// `docs/security/**` predates this check by a year and carries anchors whose construct
// cannot be inferred and has never been established -- PEN-1650 cites bare `Location:`
// ranges, and issue-authorization-model.md's reason strings each occur at several sites
// in a 3000-line file, so picking one is a judgement about which branch the citation
// means and not a refresh. Those are listed in the manifest and REPORTED rather than
// enforced; everything else is enforced from the first run.
//
// The manifest can only shrink. An entry that no longer matches any finding is itself
// an error, so an anchor that gets corrected -- or deleted -- forces its line out
// rather than leaving a permanent hole behind.
export function applyUnverified(findings, manifest, scannedDocs) {
  // Only entries for documents in THIS run are judged. Without that, narrowing
  // --glob to one document reports every other document's entries as stale and
  // buries the real finding -- which is what a narrowed run is for.
  const scanned = scannedDocs ? new Set(scannedDocs) : null;
  const inScope = scanned ? manifest.filter((e) => scanned.has(e.doc)) : manifest;
  const keys = new Set(inScope.map((e) => `${e.doc}\t${e.anchor}\t${e.construct ?? ""}`));
  const matched = new Set();
  const out = findings.map((f) => {
    const key = unverifiedKey(f);
    if (!keys.has(key)) return f;
    // Only a STILL-FAILING anchor discharges its entry. One that now resolves
    // leaves its key unmatched and is reported stale -- which is what makes a
    // corrected anchor force its own line out of the manifest, rather than
    // leaving a hole that silently exempts the anchor again the next time it
    // drifts.
    if (!FAILING.has(f.status)) return f;
    matched.add(key);
    return { ...f, status: "unverified", was: f.status };
  });
  const stale = [...keys].filter((k) => !matched.has(k));
  return { findings: out, stale };
}

function report(findings, { quiet, stale = [], inheritedStale = [] }) {
  const count = (s) => findings.filter((f) => f.status === s).length;
  const failing = findings.filter((f) => FAILING.has(f.status));
  const failures = failing.filter((f) => !f.inherited);
  const inherited = failing.filter((f) => f.inherited && !f.driftedSinceBase);
  const driftedSinceBase = failing.filter((f) => f.inherited && f.driftedSinceBase);

  for (const key of stale) {
    const [doc, anchor, construct] = key.split("\t");
    console.error(`STALE MANIFEST ENTRY  ${doc}  \`${anchor}\` (\`${construct}\`)`);
    console.error(`         this anchor now resolves, or no longer exists. Remove the entry.`);
  }

  const explain = (f, prefix) => {
    const where = `${f.docPath}:${f.docLine}`;
    if (f.status === "drifted") {
      const actual = f.actual.length === 0
        ? "the construct is no longer in the file at all"
        : `now at ${f.actual.map((n) => `:${n}`).join(", ")}`;
      console.error(`${prefix}DRIFTED  ${where}  \`${f.anchor}\` -> ${f.file}`);
      console.error(`         construct \`${f.construct}\` is not in lines ${f.lo}-${f.hi}; ${actual}`);
    } else if (f.status === "ambiguous") {
      console.error(`${prefix}AMBIGUOUS  ${where}  \`${f.anchor}\` -> ${f.file}`);
      console.error(
        `         construct \`${f.construct}\` is in lines ${f.lo}-${f.hi}, but occurs at ` +
          `${f.sites.length} sites (${f.sites.map((n) => `:${n}`).join(", ")}); a range must ` +
          `name a construct unique to the file. Pin it: \`${f.anchor}\` (\`<unique construct>\`)`,
      );
    } else if (f.status === "no-construct") {
      console.error(`${prefix}NO CONSTRUCT  ${where}  \`${f.anchor}\``);
      console.error(`         nothing to assert. Annotate it: \`${f.anchor}\` (\`<symbol>\`)`);
    } else if (f.status === "no-file-context") {
      console.error(`${prefix}NO FILE  ${where}  \`${f.anchor}\``);
      console.error(`         a bare anchor needs <!-- anchor-file: <path> --> above it`);
    } else {
      console.error(`${prefix}MISSING FILE  ${where}  \`${f.anchor}\` -> ${f.file} does not exist`);
    }
  };

  for (const f of failures) explain(f, "");

  // Printed in full and deliberately not fatal. This PR is not what broke them and is
  // usually not the change that can judge them -- but leaving them silent is how the
  // corpus rotted in the first place.
  //
  // Two labels, because they are two different facts and only one of them was checked
  // against the base. Claiming the stronger one for both is what made a reader trust a
  // statement the run never established.
  const FIX_HINT = `\`node scripts/check-doc-line-anchors.mjs --fix\` corrects the renumberable ones`;
  if (driftedSinceBase.length > 0) {
    console.error(
      `DRIFTED ON MASTER SINCE THE BASE (resolved at the base, not caused by this PR's ` +
        `changes -- reported, not fatal; ${FIX_HINT}):`,
    );
    for (const f of driftedSinceBase) explain(f, "  ");
  }
  if (inherited.length > 0 || inheritedStale.length > 0) {
    console.error(
      `INHERITED (already failing on the base, not caused by this PR's changes -- ` +
        `reported, not fatal; ${FIX_HINT}):`,
    );
    for (const f of inherited) explain(f, "  ");
    for (const key of inheritedStale) {
      const [doc, anchor, construct] = key.split("\t");
      console.error(`  STALE MANIFEST ENTRY  ${doc}  \`${anchor}\` (\`${construct}\`)`);
    }
  }

  if (!quiet) {
    const externals = findings.filter((f) => f.status === "external");
    for (const f of externals) {
      console.log(`skipped (${f.repo}) ${f.docPath}:${f.docLine} \`${f.anchor}\``);
    }
    // Single-line anchors resting on a non-unique construct are the weaker form
    // of the hazard AMBIGUOUS fails on. Not enforced, but counted, so the number
    // cannot quietly grow behind an unqualified `resolved`.
    const loose = findings.filter((f) => f.status === "ok" && f.sites?.length > 1).length;
    console.log(
      `anchors: ${findings.length} total, ${count("ok")} resolved` +
        (loose > 0 ? ` (${loose} on a construct with several sites)` : "") +
        `, ${failures.length} need attention` +
        (inherited.length > 0 ? `, ${inherited.length} inherited from the base` : "") +
        (driftedSinceBase.length > 0
          ? `, ${driftedSinceBase.length} drifted on master since the base`
          : "") +
        `, ${count("unverified")} unverified, ${externals.length} external`,
    );
  }
  return failures.length + stale.length;
}

// Read one path as it stands at `ref`. Null when the path does not exist there, which
// is how a document or a source file added by this PR reports: nothing to inherit.
function readAtRef(ref, path, root) {
  const r = spawnSync("git", ["show", `${ref}:${path}`], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  return r.status === 0 ? r.stdout : null;
}

// The same documents as the working tree, resolved against the source tree at `ref`.
// The document text is deliberately the HEAD copy: the question this answers is "would
// the anchors this PR is proposing have held against the tree it started from", which
// is only meaningful about the anchors it is actually proposing.
function collectAgainstBaseSource(ref, docs, root) {
  const cache = new Map();
  const readSource = (file) => {
    if (!cache.has(file)) cache.set(file, readAtRef(ref, file, root));
    return cache.get(file);
  };
  let out = [];
  for (const rel of docs) {
    const docText = readFileSync(join(root, rel), "utf8");
    out = out.concat(checkDocument({ docPath: rel, docText, readSource }));
  }
  return out;
}

// The paths THIS PR changes: `base...head`, where `head` is the PR's own head commit
// and NOT the checked-out worktree.
//
// On `pull_request`, actions/checkout checks out `refs/pull/N/merge` -- a merge of the
// PR head into current master -- so the worktree HEAD carries master's commits as well
// as the PR's. `PR_BASE_SHA` is an ancestor of that merge, which makes the three-dot
// `base...HEAD` identical to two-dot: it lists everything master landed since the base
// alongside the PR's own files. Reading that as "this PR touches the cited file" hands
// case 1 below every file master moved, and the gate is a repo-wide tripwire again --
// measured on this PR at `d9871cea3`, where master's 353-line edit to
// `scripts/gh-token-wrapper.sh` made six anchors fatal on a PR that never opened it.
// (An earlier revision of this comment claimed three-dot already excluded master's
// commits. It does not, and cannot, when the base is an ancestor of the head.)
//
// Defaults to `HEAD` for a local run, where the worktree is the thing being judged.
// On `merge_group` the checkout IS the head sha, so passing it changes nothing and the
// documented queue behaviour -- a diff spanning every entry ahead -- is preserved.
//
// --no-renames is load-bearing. With rename detection on, `git mv a.ts b.ts` lists only
// `b.ts`, so an anchor still citing `a.ts` matches neither attribution arm and falls
// through to INHERITED -- a PR that moves a cited file without opening the document,
// which is the exact case this check exists for, passes with a MISSING FILE it caused.
export function changedSince(ref, root, head = "HEAD") {
  const r = spawnSync("git", ["diff", "--no-renames", "--name-only", `${ref}...${head}`], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return r.status === 0 ? new Set(r.stdout.split("\n").filter(Boolean)) : null;
}

function main(argv) {
  const arg = (name, fallback) => {
    const i = argv.indexOf(name);
    return i === -1 ? fallback : argv[i + 1];
  };
  const root = arg("--root", process.cwd());
  const pattern = arg("--glob", "docs/security/**/*.md");
  const manifestPath = arg("--unverified", join(root, "scripts/doc-line-anchors.unverified.json"));
  const fix = argv.includes("--fix");
  const quiet = argv.includes("--quiet");
  const writeManifest = argv.includes("--update-unverified");
  // Empty is "no base": CI passes $PR_BASE_SHA straight through, and it is unset on
  // event types that have no base. Absent a base every failure is fatal, which is the
  // right shape for a local run against one tree.
  const baseRef = arg("--base", "") || "";
  // The worktree is what gets judged; this is only the right-hand end of the
  // "what did this PR change" diff. CI passes $PR_HEAD_SHA because its worktree is a
  // merge commit that also carries master's changes.
  const headRef = arg("--head", "HEAD") || "HEAD";

  const docs = globSync(pattern, { cwd: root }).sort();
  if (docs.length === 0) {
    console.error(`cannot judge: no documents matched ${pattern} under ${root}`);
    return 2;
  }

  const sourceCache = new Map();
  const readSource = (file) => {
    if (!sourceCache.has(file)) {
      const abs = join(root, file);
      sourceCache.set(file, existsSync(abs) ? readFileSync(abs, "utf8") : null);
    }
    return sourceCache.get(file);
  };

  let all = [];
  for (const rel of docs) {
    const abs = join(root, rel);
    const findings = checkDocument({ docPath: rel, docText: readFileSync(abs, "utf8"), readSource });
    if (fix) {
      const { text, fixed } = applyFixes(readFileSync(abs, "utf8"), findings);
      if (fixed.length > 0) {
        writeFileSync(abs, text);
        for (const f of fixed) console.log(`fixed ${rel}:${f.docLine} \`${f.anchor}\` -> :${f.to}`);
        all = all.concat(
          checkDocument({ docPath: rel, docText: readFileSync(abs, "utf8"), readSource }),
        );
        continue;
      }
    }
    all = all.concat(findings);
  }

  // A detector that finds nothing to check reports clean forever. Say so instead.
  if (all.length === 0) {
    console.error(`cannot judge: ${docs.length} document(s) matched but contain no anchors`);
    return 2;
  }

  if (writeManifest) {
    const entries = all
      .filter((f) => FAILING.has(f.status))
      .map((f) => ({ doc: f.docPath, anchor: f.anchor, construct: f.construct ?? "", was: f.status }));
    writeFileSync(manifestPath, `${JSON.stringify(entries, null, 2)}\n`);
    console.log(`wrote ${entries.length} entries to ${manifestPath}`);
    return 0;
  }

  const manifest = existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, "utf8"))
    : [];

  let attributed = all;
  let inheritedStale = [];
  if (baseRef) {
    // A base that cannot be read would mark every inherited failure as introduced and
    // fail the PR for drift it did not cause. Say so instead of judging on it.
    const resolved = spawnSync("git", ["rev-parse", "--verify", `${baseRef}^{commit}`], {
      cwd: root,
      encoding: "utf8",
    });
    if (resolved.status !== 0) {
      console.error(`cannot judge: --base ${baseRef} does not resolve in ${root}`);
      console.error(`         the job needs the base commit on disk (fetch-depth: 0)`);
      return 2;
    }
    // A head that is not on disk needs no guard of its own: the diff below fails, and
    // `changed === null` already refuses to judge rather than attributing everything
    // to this PR. --base has an explicit pre-check only because it is ALSO read by
    // collectAgainstBaseSource, where a silent miss would read as "clean at the base".
    const changed = changedSince(baseRef, root, headRef);
    if (changed === null) {
      console.error(`cannot judge: cannot diff ${baseRef}...${headRef} in ${root}`);
      return 2;
    }
    const baseSource = collectAgainstBaseSource(baseRef, docs, root);
    attributed = attributeInherited(all, baseSource, changed);
    inheritedStale = applyUnverified(baseSource, manifest, docs).stale.filter(
      (k) => !changed.has(k.split("\t")[0]),
    );
  }

  const { findings, stale } = applyUnverified(attributed, manifest, docs);
  const introducedStale = stale.filter((k) => !inheritedStale.includes(k));
  return report(findings, { quiet, stale: introducedStale, inheritedStale }) === 0 ? 0 : 1;
}

// Whether this module was invoked as a program, rather than imported by the tests.
//
// The naive `import.meta.url === \`file://${process.argv[1]}\`` FAILS OPEN, which on a
// gate is the worst direction: the comparison is false, `main()` never runs, and the
// process exits 0 having checked nothing. Two ways to get there, both reproduced --
// a path needing percent-encoding (a space) never equals the encoded `import.meta.url`,
// and under a symlink `argv[1]` is the link while `import.meta.url` is already the real
// path. So canonicalize BOTH sides: decode the URL to a path, then resolve symlinks on
// each. `realpathSync` throws on a path that does not exist, which is the ordinary case
// for the unit tests, so fall back to a lexical resolve there.
export function isMainModule(argvPath = process.argv[1], moduleUrl = import.meta.url) {
  if (!argvPath) return false;
  const canonical = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  return canonical(argvPath) === canonical(fileURLToPath(moduleUrl));
}

if (isMainModule()) {
  process.exit(main(process.argv.slice(2)));
}
