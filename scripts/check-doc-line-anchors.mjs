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
//                              [--head <ref>] [--fix | --fix-all] [--quiet]
//
// --head names the commit whose diff against --base is "what this PR changed". It
// defaults to the worktree HEAD, which is right locally and WRONG under a
// `pull_request` checkout of `refs/pull/N/merge`; see changedSince.
//
// --fix rewrites a drifted line number in place when the construct occurs EXACTLY
// ONCE in the file. An ambiguous construct is left alone and reported: picking one
// of several matches would silently re-point a security citation at the wrong one.
//
// --fix is NARROWED TO WHAT THIS CHANGE MADE STALE and needs --base to know it; see
// ownsStaleNumber. Without one it refuses rather than guessing wide. --fix-all is the
// wide mode, named so that taking it is a decision: it rewrites every renumberable
// anchor in the corpus, which only a single writer on master can do without
// manufacturing the conflicts PEN-6674 removed the mandate for.
//
// WHAT --fix OWNS IS A WORKTREE QUESTION, NOT A COMMIT ONE. `--fix` writes to the
// worktree, so the change it is narrowed to is the one IN the worktree -- committed or
// not. Attribution for the FAIL decision is `base...head`, which is committed-only and
// correct for a gate; reusing it to decide what to REWRITE made `--fix --base
// origin/master` a silent no-op before you commit, which is its most common local use:
// an uncommitted source move is not "a file you moved" and an uncommitted doc edit is
// not "a document you are already editing", so both ownership arms came back empty and
// the report then recommended the same command again. See worktreeChangedSince and
// fixScope in main. Under an explicit --head the worktree is somebody else's tree -- a
// `pull_request` merge ref -- so the union is NOT taken there.
//
// SEVERITY: A STALE NUMBER IS NOT ANCHOR ROT (PEN-6674)
//
// Drift splits in two, and only one half is a claim this check cannot settle.
//
// A single-line anchor whose construct is still in the file at exactly ONE place is
// STALE-NUMBER. The citation holds -- the construct names the code, and by the time
// the finding is built this tool is holding the correct line in a variable. It is
// reported on every run, with that line, and it is never fatal. Everything else --
// the construct GONE from the file, several candidate sites, or a RANGE whose extent
// cannot be re-derived -- stays DRIFTED and stays fatal. That is the rot the check was
// built for, and it is exactly the set `--fix` refuses to touch.
//
// Failing the stale-number half was unsatisfiable in the merge queue, not merely
// strict. The correct number is a function of the WHOLE merge group, so no entry can
// carry it: it is fixed against the tree the author had and wrong against the tree the
// queue builds. Measured 2026-11-14 on Blockcast/paperclip -- #3715 evicted
// `merge_conflict` three times (10:50:36Z attributed first-party to this document),
// #3476 at 10:25:33Z with ours :38414 / theirs :38336 / correct :38440, a number
// neither side held; #3774 red in 3s on 8 anchors; #3760 clean -> conflicting on the
// single event of #3751 merging. Every eviction cost one human enqueue act that no
// agent seat may replace.
//
// Both failure modes come from the same root -- the fix is a WRITE to a shared
// document -- so making the gate demand it made every concurrent editor of a hot
// source file pairwise-conflicting:
//
//   1. Two PRs that each move a cited construct must each rewrite the same doc lines
//      to DIFFERENT numbers, because each computes against a tree carrying only its
//      own insertions. They conflict textually and the queue evicts on staging.
//   2. An entry whose numbers are right against its own base is wrong against the
//      merge-group head, which carries the entries queued ahead of it. `changed`
//      holds the cited file, so case 1 of attributeInherited makes it fatal and the
//      entry is ejected having done nothing wrong.
//
// Neither is reachable once the number is not load-bearing: nothing forces the write,
// so there is nothing to conflict on and nothing to be stale at a tree the author
// could not see. Nothing about ROT is relaxed -- a construct that stops resolving
// still fails, which is the assertion this module exists to make.
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

// The repairable half of drift: a single-line anchor whose construct is still in the
// file at exactly one place. One predicate, read by both the status assignment and
// --fix, so the class that is never fatal and the class the tool can rewrite with no
// judgement in it cannot drift apart. Widening this widens what `--fix` will rewrite.
export const isRenumberable = (f) => f.lo === f.hi && f.actual?.length === 1;

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
    const actual = locateConstruct(sourceLines, construct);
    findings.push({
      ...base,
      status: isRenumberable({ lo: anchor.lo, hi: anchor.hi, actual })
        ? "stale-number"
        : "drifted",
      file,
      construct,
      actual,
    });
  });

  return findings;
}

// Rewrite the stale-number findings -- isRenumberable, i.e. a single-line anchor whose
// construct occurs exactly once. Relocating a RANGE means re-deriving its extent, which
// is a judgement about what the citation covers and not something to guess, so a drifted
// range is reported and left alone. This set is exactly the set that is never fatal.
//
// WHICH of them a run may rewrite is a second question (PEN-6680). `--fix` used to rewrite every one
// in the corpus, so running the prescribed remedy silently widened your diff into
// documents you never opened: measured on #3774, a `--fix` run also renumbered a
// Dockerfile anchor, from line 674 to line 705, in an unrelated security document, over
// drift the same run's own report had scored as the base's. That write is a fresh
// pairwise conflict with whoever owns the drift -- the conflict PEN-6674 removed the
// MANDATE for, reached voluntarily through the remedy the report recommends.
//
// The FAIL decision already distinguishes introduced from inherited. It could not be
// read here as it stood: attributeInherited returns early on every status outside
// FAILING, and `stale-number` is outside it by construction -- a stale number is never
// fatal -- so no stale-number finding has ever carried an `inherited` flag to consult.
// Hence a predicate of its own, on the same `changed` set and in the same two cases.
//
// `changed === null` is "there is nothing to attribute against, and the caller has said
// so". `main` refuses `--fix` without `--base` rather than arriving here by accident,
// and reaches it only under the explicit `--fix-all`.
export function ownsStaleNumber(f, changed) {
  if (f.status !== "stale-number") return false;
  if (changed === null) return true;
  // This change moved the cited code, so this change is what made the number stale --
  // the case the check exists for, where the PR moves the source and never opens the
  // document.
  if (f.file && changed.has(f.file)) return true;
  // Or this change is already editing the document. Renumbering a line in a file it
  // ALREADY touches adds no conflict surface it has not taken, and keeping that arm is
  // what leaves "I am writing this citation, renumber it for me" working.
  return changed.has(f.docPath);
}

export function applyFixes(docText, findings, changed = null) {
  const fixable = findings.filter((f) => ownsStaleNumber(f, changed));
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
//
// `queueBase` says the base is a MERGE-QUEUE base rather than the PR's own: master's
// tip at the moment the entry was built, which the head forked from earlier. Case 2
// then has no premise left. Its question -- "does this anchor resolve against the
// base's copy of the source?" -- separates a number that was never right from one the
// base moved out from under only while the base IS the tree the document was written
// against. A queue base is not; every line master moved between the fork and the
// enqueue answers "no", and the document's own PR is charged with all of it.
//
// That is not hypothetical and it is not rare. #3151, the PR that introduced this
// check, was ejected on 2026-11-06 and again on 2026-11-07 with a code-owner sign-off
// spent on each head, and measured green at its own base and 10 INTRODUCED against a
// master tip ten commits newer -- off-by-one and off-by-51 drift in `heartbeat.ts`,
// a file it does not touch. Master moves faster than a queue entry can be signed off,
// so the correction is stale before it is reviewed: the same race this whole module
// exists to take away from humans, applied to the module's own delivery.
//
// Case 1 is UNCHANGED under a queue base, and it is the one the queue is for: if the
// combined tree -- this entry plus everything queued ahead of it -- moves a cited
// file, `changed` carries that file and the anchor is still fatal. So the queue keeps
// catching the interaction no single PR's own run can see, and stops charging an entry
// for drift that landed on master before it was ever queued.
export function attributeInherited(headFindings, baseSourceFindings, changed, options = {}) {
  const { queueBase = false } = options;
  const key = (f) => `${f.docPath}\t${f.start}`;
  const resolvedAtBase = new Set(
    baseSourceFindings.filter((f) => !FAILING.has(f.status)).map(key),
  );
  return headFindings.map((f) => {
    if (!FAILING.has(f.status)) return f;
    if (f.file && changed.has(f.file)) return f;
    if (!queueBase && changed.has(f.docPath) && !resolvedAtBase.has(key(f))) return f;
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

function report(findings, { quiet, stale = [], inheritedStale = [], fixScope = null }) {
  const count = (s) => findings.filter((f) => f.status === s).length;
  const failing = findings.filter((f) => FAILING.has(f.status));
  const staleNumbers = findings.filter((f) => f.status === "stale-number");
  const failures = failing.filter((f) => !f.inherited);
  const inherited = failing.filter((f) => f.inherited && !f.driftedSinceBase);
  const driftedSinceBase = failing.filter((f) => f.inherited && f.driftedSinceBase);

  for (const key of stale) {
    const [doc, anchor, construct] = key.split("\t");
    console.error(`STALE MANIFEST ENTRY  ${doc}  \`${anchor}\` (\`${construct}\`)`);
    console.error(
      `         this anchor now resolves, carries only a stale number, or no longer ` +
        `exists. Remove the entry.`,
    );
  }

  const explain = (f, prefix) => {
    const where = `${f.docPath}:${f.docLine}`;
    if (f.status === "stale-number") {
      console.error(`${prefix}STALE NUMBER  ${where}  \`${f.anchor}\` -> ${f.file}`);
      console.error(
        `         construct \`${f.construct}\` is now at :${f.actual[0]}; the citation ` +
          `holds and only the cached number moved`,
      );
    } else if (f.status === "drifted") {
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
  const FIX_HINT =
    `\`node scripts/check-doc-line-anchors.mjs --fix --base origin/master\` corrects the ` +
    `renumberable ones THIS change made stale`;
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

  // Reported on every run and never fatal -- see the SEVERITY block at the top. The
  // current line is printed beside each one, so the report carries the answer whether
  // or not anyone runs --fix, and the count below keeps the number from quietly
  // growing behind an unqualified `resolved`.
  //
  // Split by ownership, because the two halves take DIFFERENT remedies and one
  // unconditional hint sends half the readers back to the command that just declined
  // them: a run that WAS `--fix --base ...` and left a number alone left it alone on
  // purpose, and recommending the same command again reads as the fix having failed.
  // `fixScope === null` is "no base, so nothing can be attributed" -- there the single
  // block and the single hint are both honest, and the refusal above has already said
  // the rest.
  const ownedStale =
    fixScope === null ? staleNumbers : staleNumbers.filter((f) => ownsStaleNumber(f, fixScope));
  const baseStale =
    fixScope === null ? [] : staleNumbers.filter((f) => !ownsStaleNumber(f, fixScope));
  if (ownedStale.length > 0) {
    console.error(
      `STALE LINE NUMBERS (the construct still resolves, uniquely, so the citation ` +
        `holds -- reported, NOT fatal; ${FIX_HINT}):`,
    );
    for (const f of ownedStale) explain(f, "  ");
  }
  if (baseStale.length > 0) {
    console.error(
      `STALE LINE NUMBERS INHERITED FROM THE BASE (the citation holds and the drift is ` +
        `the base's, not this change's -- reported, NOT fatal. \`--fix\` leaves these ` +
        `alone BY DESIGN: rewriting one writes a shared line in a document this change ` +
        `never opened. Only a single writer on master can take them, with --fix-all):`,
    );
    for (const f of baseStale) explain(f, "  ");
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
        (staleNumbers.length > 0 ? `, ${staleNumbers.length} with a stale number` : "") +
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

// Every path the WORKTREE differs from `ref` at: committed, staged, unstaged, and
// untracked. The two-dot `git diff --name-only <ref>` already covers the first three
// (it compares the ref against the working tree, not against HEAD); `ls-files --others`
// adds a file this change has created and not yet added, which an anchor can cite and a
// document can be.
//
// This is the FIX scope and never the attribution scope. A gate must judge a commit --
// a worktree is not a thing CI has or a reviewer can read -- but `--fix` writes to the
// worktree, so narrowing it to committed work refuses exactly the edit in front of you.
//
// --no-renames for the same reason as changedSince: with rename detection on, a
// `git mv` lists only the destination, and an anchor still citing the old path matches
// neither ownership arm.
//
// Returns null on a git failure, which main refuses on rather than silently falling
// back to the narrow set -- a quiet fallback here is indistinguishable from the no-op
// this function exists to remove.
export function worktreeChangedSince(ref, root) {
  const opts = { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 };
  const tracked = spawnSync("git", ["diff", "--no-renames", "--name-only", ref], opts);
  if (tracked.status !== 0) return null;
  const untracked = spawnSync("git", ["ls-files", "--others", "--exclude-standard"], opts);
  if (untracked.status !== 0) return null;
  return new Set(
    [...tracked.stdout.split("\n"), ...untracked.stdout.split("\n")].filter(Boolean),
  );
}

function main(argv) {
  const arg = (name, fallback) => {
    const i = argv.indexOf(name);
    return i === -1 ? fallback : argv[i + 1];
  };
  const root = arg("--root", process.cwd());
  const pattern = arg("--glob", "docs/security/**/*.md");
  const manifestPath = arg("--unverified", join(root, "scripts/doc-line-anchors.unverified.json"));
  // --fix-all implies fixing: a run that passed it and silently did nothing would read
  // as the narrowing refusing, which is the opposite of what it asked for.
  const fixAll = argv.includes("--fix-all");
  const fix = argv.includes("--fix") || fixAll;
  const quiet = argv.includes("--quiet");
  const writeManifest = argv.includes("--update-unverified");
  // Empty is "no base": CI passes $PR_BASE_SHA straight through, and it is unset on
  // event types that have no base. Absent a base every failure is fatal, which is the
  // right shape for a local run against one tree.
  const baseRef = arg("--base", "") || "";
  // What KIND of commit `--base` is: `pr` (default) means it is the tree this head
  // was written against; `queue` means it is a merge-queue base -- master's tip at the
  // moment the entry was built. See attributeInherited for what turns on it. CI passes
  // `queue` on `merge_group` only. An unknown value is refused rather than defaulting,
  // because defaulting a misspelling to `pr` reinstates the ejection silently.
  const baseKind = arg("--base-kind", "pr") || "pr";
  if (baseKind !== "pr" && baseKind !== "queue") {
    console.error(`cannot judge: --base-kind ${baseKind} is not one of: pr, queue`);
    return 2;
  }
  const queueBase = baseKind === "queue";
  // The worktree is what gets judged; this is only the right-hand end of the
  // "what did this PR change" diff. CI passes $PR_HEAD_SHA because its worktree is a
  // merge commit that also carries master's changes.
  const headRef = arg("--head", "HEAD") || "HEAD";

  const docs = globSync(pattern, { cwd: root }).sort();
  if (docs.length === 0) {
    console.error(`cannot judge: no documents matched ${pattern} under ${root}`);
    return 2;
  }

  // The base is resolved BEFORE the documents are read, because `--fix` needs it: WHAT
  // TO REWRITE is the same attribution question as what to fail on, and answering it
  // after the write has answered it too late. `changed` is a diff of two commits, so
  // nothing the fix loop writes into the worktree can move it, and the attribution
  // below reads the same set.
  let changed = null;
  // What `--fix` may rewrite. Deliberately a SECOND set: `changed` answers "what is this
  // PR judged on", which has to be a commit, and fixScope answers "what is this change",
  // which for a tool that writes to the worktree includes work not committed yet.
  // Computed whether or not --fix was passed, so the report's hint predicts what --fix
  // would actually do rather than what the gate would fail on.
  let fixScope = null;
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
    changed = changedSince(baseRef, root, headRef);
    if (changed === null) {
      console.error(`cannot judge: cannot diff ${baseRef}...${headRef} in ${root}`);
      return 2;
    }
    // An explicit --head says "the thing being attributed is that commit, not this
    // worktree" -- CI passes $PR_HEAD_SHA precisely because its worktree is a merge ref
    // carrying master's changes too. Unioning that worktree in would hand every file
    // master touched to the fix scope, which is the widening this flag exists to stop.
    if (argv.includes("--head")) {
      fixScope = changed;
    } else {
      const worktree = worktreeChangedSince(baseRef, root);
      if (worktree === null) {
        console.error(`cannot judge: cannot read the worktree delta against ${baseRef} in ${root}`);
        return 2;
      }
      fixScope = new Set([...changed, ...worktree]);
    }
  }

  // Without a base there is no introduced set to narrow to, and the wide answer is the
  // foot-gun itself: it writes shared lines in documents this change never opened. The
  // documented remedy was a bare `--fix`, so this is the invocation the corpus actually
  // sees. Refuse it, and name the wide mode rather than defaulting to it -- a single
  // writer on master can hold it safely and an arbitrary PR cannot.
  if (fix && changed === null && !fixAll) {
    console.error(`cannot judge: --fix needs --base <ref> to tell the anchors this change`);
    console.error(`         made stale from the ones it inherited (PEN-6680). Pass`);
    console.error(`         --base origin/master, or --fix-all to rewrite every`);
    console.error(`         renumberable anchor in the corpus.`);
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
      const { text, fixed } = applyFixes(readFileSync(abs, "utf8"), findings, fixAll ? null : fixScope);
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
    // Read AFTER the fix loop on purpose: collectAgainstBaseSource resolves the
    // worktree's document text against the base source, so it has to see whatever
    // --fix just wrote. The base commit itself was resolved above.
    const baseSource = collectAgainstBaseSource(baseRef, docs, root);
    attributed = attributeInherited(all, baseSource, changed, { queueBase });
    inheritedStale = applyUnverified(baseSource, manifest, docs).stale.filter(
      (k) => !changed.has(k.split("\t")[0]),
    );
  }

  const { findings, stale } = applyUnverified(attributed, manifest, docs);
  const introducedStale = stale.filter((k) => !inheritedStale.includes(k));
  return report(findings, { quiet, stale: introducedStale, inheritedStale, fixScope }) === 0
    ? 0
    : 1;
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
