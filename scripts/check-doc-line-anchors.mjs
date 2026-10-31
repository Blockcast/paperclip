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
// Usage:
//   check-doc-line-anchors.mjs [--root <dir>] [--glob <pattern>] [--fix] [--quiet]
//
// --fix rewrites a drifted line number in place when the construct occurs EXACTLY
// ONCE in the file. An ambiguous construct is left alone and reported: picking one
// of several matches would silently re-point a security citation at the wrong one.
//
// Exit 0 clean, 1 anchors need attention, 2 cannot judge.

import { readFileSync, writeFileSync, existsSync, globSync } from "node:fs";
import { join } from "node:path";

const CODE_SPAN = /`([^`\n]+)`/g;
const ANCHOR = /^([\w./-]*):(\d+)(?:-(\d+))?$/;
const DIRECTIVE_FILE = /^\s*<!--\s*anchor-file:\s*(\S+?)\s*-->\s*$/;
const DIRECTIVE_EXTERNAL = /^\s*<!--\s*anchor-external:\s*(.+?)\s*-->\s*$/;
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

function report(findings, { quiet, stale = [] }) {
  const count = (s) => findings.filter((f) => f.status === s).length;
  const failures = findings.filter((f) => FAILING.has(f.status));

  for (const key of stale) {
    const [doc, anchor, construct] = key.split("\t");
    console.error(`STALE MANIFEST ENTRY  ${doc}  \`${anchor}\` (\`${construct}\`)`);
    console.error(`         this anchor now resolves, or no longer exists. Remove the entry.`);
  }

  for (const f of failures) {
    const where = `${f.docPath}:${f.docLine}`;
    if (f.status === "drifted") {
      const actual = f.actual.length === 0
        ? "the construct is no longer in the file at all"
        : `now at ${f.actual.map((n) => `:${n}`).join(", ")}`;
      console.error(`DRIFTED  ${where}  \`${f.anchor}\` -> ${f.file}`);
      console.error(`         construct \`${f.construct}\` is not in lines ${f.lo}-${f.hi}; ${actual}`);
    } else if (f.status === "ambiguous") {
      console.error(`AMBIGUOUS  ${where}  \`${f.anchor}\` -> ${f.file}`);
      console.error(
        `         construct \`${f.construct}\` is in lines ${f.lo}-${f.hi}, but occurs at ` +
          `${f.sites.length} sites (${f.sites.map((n) => `:${n}`).join(", ")}); a range must ` +
          `name a construct unique to the file. Pin it: \`${f.anchor}\` (\`<unique construct>\`)`,
      );
    } else if (f.status === "no-construct") {
      console.error(`NO CONSTRUCT  ${where}  \`${f.anchor}\``);
      console.error(`         nothing to assert. Annotate it: \`${f.anchor}\` (\`<symbol>\`)`);
    } else if (f.status === "no-file-context") {
      console.error(`NO FILE  ${where}  \`${f.anchor}\``);
      console.error(`         a bare anchor needs <!-- anchor-file: <path> --> above it`);
    } else {
      console.error(`MISSING FILE  ${where}  \`${f.anchor}\` -> ${f.file} does not exist`);
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
        `, ${failures.length} need attention, ${count("unverified")} unverified, ` +
        `${externals.length} external`,
    );
  }
  return failures.length + stale.length;
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
  const { findings, stale } = applyUnverified(all, manifest, docs);
  return report(findings, { quiet, stale }) === 0 ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
