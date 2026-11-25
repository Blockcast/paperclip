import { strict as assert } from "node:assert";
import test from "node:test";

import {
  applyFixes,
  applyUnverified,
  attributeInherited,
  changedSince,
  checkDocument,
  isMainModule,
  isRenumberable,
  locateConstruct,
  ownsStaleNumber,
  parseAnchorSpan,
  parseDirective,
  resolveConstruct,
  spansOf,
  worktreeChangedSince,
} from "./check-doc-line-anchors.mjs";

const SOURCE = [
  "const a = 1;", // 1
  "function parseThing(", // 2
  "  input: unknown,", // 3
  ") {", // 4
  "  return null;", // 5
  "}", // 6
].join("\n");

const check = (docText, source = SOURCE) =>
  checkDocument({ docPath: "d.md", docText, readSource: () => source });

const only = (docText, source) => {
  const f = check(docText, source);
  assert.equal(f.length, 1, `expected exactly one anchor, got ${f.length}`);
  return f[0];
};

test("parseAnchorSpan accepts qualified, bare and range anchors", () => {
  assert.deepEqual(parseAnchorSpan("src/a.ts:12"), { path: "src/a.ts", lo: 12, hi: 12 });
  assert.deepEqual(parseAnchorSpan(":12"), { path: null, lo: 12, hi: 12 });
  assert.deepEqual(parseAnchorSpan(":12-20"), { path: null, lo: 12, hi: 20 });
  assert.deepEqual(parseAnchorSpan("Dockerfile.runtime:5"), {
    path: "Dockerfile.runtime",
    lo: 5,
    hi: 5,
  });
});

test("parseAnchorSpan rejects colon-separated text that is not an anchor", () => {
  // These appear throughout the corpus and must not be read as files named
  // "issue" or "tasks", nor as a device:inode pair (PEN-4986's `4194488:2374866`).
  assert.equal(parseAnchorSpan("issue:coordination_metadata"), null);
  assert.equal(parseAnchorSpan("tasks:assign"), null);
  assert.equal(parseAnchorSpan("4194488:2374866"), null);
  assert.equal(parseAnchorSpan("plain text"), null);
});

test("parseAnchorSpan rejects an inverted range", () => {
  assert.equal(parseAnchorSpan(":20-12"), null);
});

test("parseDirective reads both directive forms and nothing else", () => {
  assert.deepEqual(parseDirective("<!-- anchor-file: src/a.ts -->"), {
    path: "src/a.ts",
    external: null,
  });
  assert.deepEqual(parseDirective("<!-- anchor-external: other-repo -->"), {
    path: null,
    external: "other-repo",
  });
  assert.equal(parseDirective("ordinary <!-- comment -->"), null);
  assert.equal(parseDirective("text before <!-- anchor-file: src/a.ts -->"), null);
});

test("spansOf reports the line each code span is on", () => {
  const spans = spansOf("a `one`\nb `two`\n\nc `three`");
  assert.deepEqual(spans.map((s) => [s.text, s.line]), [
    ["one", 1],
    ["two", 2],
    ["three", 4],
  ]);
});

test("a qualified anchor resolves against the construct to its left", () => {
  const f = only("`parseThing` (`src/a.ts:2`) parses input.");
  assert.equal(f.status, "ok");
  assert.equal(f.construct, "parseThing");
});

test("a construct to the right is used when nothing qualifies to the left", () => {
  // `Read at `src/a.ts` `:2`, `parseThing`` -- the only span to the left is the
  // path, which is skipped, so the search must continue rightwards.
  const f = only("<!-- anchor-file: src/a.ts -->\n\nRead at `src/a.ts` `:2`, `parseThing`.");
  assert.equal(f.status, "ok");
  assert.equal(f.construct, "parseThing");
});

test("the parenthesised form overrides a construct on the left", () => {
  const f = only("`someUnrelatedThing` `src/a.ts:5` (`return null;`)");
  assert.equal(f.status, "ok");
  assert.equal(f.construct, "return null;");
});

test("the parenthesised form is read through markdown emphasis and one wrap", () => {
  // Both shapes occur in the corpus: the 100-column wrap splits the annotation,
  // and anchors are routinely bolded.
  assert.equal(only("x **`src/a.ts:5`**\n(`return null;`)").construct, "return null;");
  assert.equal(only("x **`src/a.ts:5`** (`return null;`)").construct, "return null;");
});

test("an ordinary parenthetical is not mistaken for an annotation", () => {
  // Words between the anchor and the next span mean this is prose, so the
  // construct must come from inference instead.
  const f = only("`parseThing` `src/a.ts:2` (see also `unrelatedSymbol`)");
  assert.equal(f.construct, "parseThing");
});

test("inference never crosses a line, though the explicit form may", () => {
  // `parseThing` is on the previous line and must not be reached by inference;
  // with nothing on its own line the anchor has no construct at all.
  const f = only("`parseThing` does this:\n`src/a.ts:2`\n");
  assert.equal(f.status, "no-construct");
});

test("a drifted anchor is reported with the construct's current line", () => {
  const f = only("`parseThing` (`src/a.ts:5`)");
  assert.deepEqual(f.actual, [2]);
});

// PEN-6674. Drift splits by whether a human has anything to decide. The number moved
// and the construct is still there, once: the citation holds, this tool is holding the
// right line, and there is nothing to adjudicate -- so it must not fail a PR. Making it
// fail was unsatisfiable in the merge queue, where the correct number is a function of
// the whole merge group and no single entry can carry it.
test("a single-line anchor whose construct moved to exactly one place is a stale number", () => {
  const f = only("`parseThing` (`src/a.ts:5`)");
  assert.equal(f.status, "stale-number");
  assert.equal(f.actual.length, 1);
  assert.ok(isRenumberable(f));
});

// The other half is untouched, and these are the anchor rot the check exists for.
test("a construct that has left the file entirely stays drifted and fatal", () => {
  const f = only("`parseThing` (`src/a.ts:5`)", "const a = 1;\nconst b = 2;");
  assert.equal(f.status, "drifted");
  assert.deepEqual(f.actual, []);
  assert.ok(!isRenumberable(f));
});

test("a construct now at several places stays drifted: --fix would have to guess", () => {
  const f = only("`return null;` (`src/a.ts:2`)", "return null;\nx\nreturn null;");
  assert.equal(f.status, "drifted");
  assert.deepEqual(f.actual, [1, 3]);
});

test("a drifted range stays drifted even where its construct is unique", () => {
  // --fix never relocates a range -- re-deriving its extent is a judgement -- so the
  // class that is never fatal must not widen to one the tool refuses to repair.
  const f = only("`parseThing` (`src/a.ts:4-5`)");
  assert.equal(f.status, "drifted");
  assert.deepEqual(f.actual, [2]);
});

test("a stale number is never fatal, under either base kind", () => {
  const atHead = check("`parseThing` (`src/a.ts:2`)", `// pushed down\n${SOURCE}`);
  const atBase = check("`parseThing` (`src/a.ts:2`)");
  assert.equal(atHead[0].status, "stale-number");
  for (const queueBase of [false, true]) {
    // `changed` carries the cited file: the strongest attribution arm there is, the one
    // a merge group always satisfies. It must still not make this fatal.
    const [f] = attributeInherited(atHead, atBase, new Set(["src/a.ts"]), { queueBase });
    assert.equal(f.status, "stale-number", `queueBase=${queueBase}`);
    assert.ok(!f.inherited, "not inherited either -- it is simply not a failure");
  }
});

test("a range passes when the construct is anywhere inside it", () => {
  assert.equal(only("`input: unknown,` (`src/a.ts:2-4`)").status, "ok");
  assert.equal(only("`input: unknown,` (`src/a.ts:4-6`)").status, "drifted");
});

test("a construct split across lines by a reformat still matches", () => {
  // The assertion is on whitespace-collapsed text, so rewrapping a call is not drift.
  const f = only("`function parseThing( input: unknown,` (`src/a.ts:2-3`)");
  assert.equal(f.status, "ok");
});

test("a bare anchor needs a declared file context", () => {
  assert.equal(only("`parseThing` (`:2`)").status, "no-file-context");
  const f = only("<!-- anchor-file: src/a.ts -->\n\n`parseThing` (`:2`)");
  assert.equal(f.status, "ok");
});

test("a file context holds until the next directive replaces it", () => {
  const findings = checkDocument({
    docPath: "d.md",
    docText: [
      "<!-- anchor-file: a.ts -->",
      "",
      "`parseThing` (`:2`)",
      "",
      "<!-- anchor-file: b.ts -->",
      "",
      "`parseThing` (`:2`)",
    ].join("\n"),
    readSource: (file) => (file === "a.ts" ? SOURCE : "nothing here\n"),
  });
  assert.deepEqual(findings.map((f) => [f.file, f.status]), [
    ["a.ts", "ok"],
    ["b.ts", "drifted"],
  ]);
});

test("a directive below an anchor does not reach back up to it", () => {
  const f = only("`parseThing` (`:2`)\n\n<!-- anchor-file: src/a.ts -->");
  assert.equal(f.status, "no-file-context");
});

test("anchor-external covers its region, qualified anchors included", () => {
  const findings = checkDocument({
    docPath: "d.md",
    docText: "<!-- anchor-external: other-repo -->\n\n`x` (`:2`) and `y` (`src/far.rs:9`)",
    readSource: () => {
      throw new Error("must not read source for an external anchor");
    },
  });
  assert.deepEqual(findings.map((f) => f.status), ["external", "external"]);
  assert.equal(findings[0].repo, "other-repo");
});

test("a declared in-tree file that does not exist is an error, not a skip", () => {
  const f = checkDocument({
    docPath: "d.md",
    docText: "`parseThing` (`src/gone.ts:2`)",
    readSource: () => null,
  })[0];
  assert.equal(f.status, "missing-file");
});

test("locateConstruct returns every occurrence", () => {
  assert.deepEqual(locateConstruct(SOURCE.split("\n"), "parseThing"), [2]);
  assert.deepEqual(locateConstruct(SOURCE.split("\n"), "a"), [1, 2]);
});

test("applyFixes rewrites exactly the stale-number findings", () => {
  const doc = "`parseThing` (`src/a.ts:5`)";
  const { text, fixed } = applyFixes(doc, check(doc));
  assert.equal(text, "`parseThing` (`src/a.ts:2`)");
  assert.equal(fixed[0].to, 2);
  assert.equal(check(text)[0].status, "ok");
});

test("applyFixes refuses an ambiguous construct rather than guessing", () => {
  // `a` is on three lines; picking one would silently re-point the citation.
  const doc = "`a` (`src/a.ts:6`)";
  const { text, fixed } = applyFixes(doc, check(doc));
  assert.equal(fixed.length, 0);
  assert.equal(text, doc);
});

test("applyFixes leaves ranges alone", () => {
  const doc = "`parseThing` (`src/a.ts:5-6`)";
  assert.equal(applyFixes(doc, check(doc)).fixed.length, 0);
});

test("applyFixes keeps offsets valid when one line carries several anchors", () => {
  // Both corrections must widen the anchor from one digit to two, or a
  // left-to-right rewrite happens to land correctly and proves nothing.
  const wide = ["x", "x", "x", "x", "x", "x", "x", "x", "x", "alpha", "omega"].join("\n");
  const doc = "`alpha` (`src/w.ts:2`) and `omega` (`src/w.ts:3`)";
  const findings = checkDocument({ docPath: "d.md", docText: doc, readSource: () => wide });
  const { text } = applyFixes(doc, findings);
  assert.equal(text, "`alpha` (`src/w.ts:10`) and `omega` (`src/w.ts:11`)");
  assert.deepEqual(
    checkDocument({ docPath: "d.md", docText: text, readSource: () => wide }).map((f) => f.status),
    ["ok", "ok"],
  );
});

// PEN-6680. `--fix` is the remedy the report recommends, so what it writes is what an
// author who follows the instruction writes. Rewriting every stale number in the corpus
// made that instruction widen the diff into documents the author never opened -- and a
// write to a shared line is the pairwise conflict PEN-6674 removed the MANDATE for,
// arrived at voluntarily.
test("ownsStaleNumber: this change moved the cited file, so it owns the number", () => {
  const f = { status: "stale-number", docPath: "docs/d.md", file: "src/a.ts" };
  assert.equal(ownsStaleNumber(f, new Set(["src/a.ts"])), true);
});

test("ownsStaleNumber: this change is already editing the document", () => {
  // The arm that keeps "I am writing this citation, renumber it for me" working. The
  // document is already in the diff, so the rewrite takes no conflict surface the
  // change has not taken.
  const f = { status: "stale-number", docPath: "docs/d.md", file: "src/a.ts" };
  assert.equal(ownsStaleNumber(f, new Set(["docs/d.md"])), true);
});

test("ownsStaleNumber: a number this change touched neither end of is not its own", () => {
  // The #3774 case: the run's own report scored this `1 inherited from the base`, and
  // --fix rewrote it anyway.
  const f = { status: "stale-number", docPath: "docs/d.md", file: "src/a.ts" };
  assert.equal(ownsStaleNumber(f, new Set(["src/unrelated.ts"])), false);
});

test("ownsStaleNumber: no base is the caller accepting the whole corpus", () => {
  // `null` is reachable only under --fix-all; main refuses a bare --fix without a base.
  const f = { status: "stale-number", docPath: "docs/d.md", file: "src/a.ts" };
  assert.equal(ownsStaleNumber(f, null), true);
});

test("ownsStaleNumber: only stale numbers are ever rewritten, whatever changed", () => {
  // The widening must not reach the statuses --fix has always refused. A drifted range
  // is a judgement about what the citation covers, not a renumber.
  for (const status of ["drifted", "ambiguous", "ok", "unverified", "missing-file"]) {
    const f = { status, docPath: "docs/d.md", file: "src/a.ts" };
    assert.equal(ownsStaleNumber(f, new Set(["docs/d.md", "src/a.ts"])), false, status);
  }
});

test("applyFixes rewrites only the stale numbers this change owns", () => {
  const doc = "`parseThing` (`src/a.ts:5`)";
  const findings = check(doc);
  assert.equal(findings[0].status, "stale-number", "fixture must be renumberable");

  const mine = applyFixes(doc, findings, new Set(["src/a.ts"]));
  assert.equal(mine.text, "`parseThing` (`src/a.ts:2`)");

  const theirs = applyFixes(doc, findings, new Set(["src/elsewhere.ts"]));
  assert.equal(theirs.text, doc, "an inherited stale number must be left byte-identical");
  assert.deepEqual(theirs.fixed, []);
});

// The manifest carries anchors a human has to settle, so these fixtures use RANGES:
// since PEN-6674 a drifted single-line anchor with one candidate site is a stale number
// and not a failure at all, so it has nothing to downgrade.
test("a manifest entry downgrades its own anchor and nothing else", () => {
  const doc = "`parseThing` (`src/a.ts:4-5`) and `input: unknown,` (`src/a.ts:5-6`)";
  const manifest = [{ doc: "d.md", anchor: "src/a.ts:4-5", construct: "parseThing" }];
  const { findings, stale } = applyUnverified(check(doc), manifest, ["d.md"]);
  assert.deepEqual(findings.map((f) => f.status), ["unverified", "drifted"]);
  assert.equal(findings[0].was, "drifted");
  assert.deepEqual(stale, []);
});

test("a manifest entry whose anchor now resolves is itself reported", () => {
  // This is what stops the manifest becoming a permanent hole.
  const doc = "`parseThing` (`src/a.ts:2`)";
  const manifest = [{ doc: "d.md", anchor: "src/a.ts:5", construct: "parseThing" }];
  const { stale } = applyUnverified(check(doc), manifest, ["d.md"]);
  assert.equal(stale.length, 1);
});

// A file where the cited symbol also lives elsewhere -- the shape that let
// `:811-820` (`narrowWritableSurface`, 19 sites) report `ok` while citing code
// ~270 lines from the branch its prose described.
const REPEATED = [
  "if (narrowWritableSurface) {", // 1
  "  const a = 1;", // 2
  "}", // 3
  "if (mode === \"shared\") {", // 4
  "  // narrowWritableSurface holds here", // 5
  "  const b = 2;", // 6
  "}", // 7
].join("\n");

test("a range anchor on a construct with several sites is ambiguous, not ok", () => {
  // The construct IS inside 4-7, so the old assertion passed. It is also at :1,
  // so "somewhere in this range" cannot distinguish the cited branch from any
  // other occurrence that drifts into the window.
  const f = only("`narrowWritableSurface` (`src/a.ts:4-7`)", REPEATED);
  assert.equal(f.status, "ambiguous");
  assert.deepEqual(f.sites, [1, 5]);
});

test("a range anchor pinned to a unique construct resolves", () => {
  const f = only("`if (mode === \"shared\") {` (`src/a.ts:4-7`)", REPEATED);
  assert.equal(f.status, "ok");
  assert.deepEqual(f.sites, [4]);
});

test("a single-line anchor on a repeated construct stays ok but is counted", () => {
  // Deliberately not failed: a single line is the tightest assertion a line
  // number can carry. `sites` is still reported so the weaker form is visible.
  const f = only("`narrowWritableSurface` (`src/a.ts:5`)", REPEATED);
  assert.equal(f.status, "ok");
  assert.equal(f.sites.length, 2);
});

test("a drifted range anchor reports as drifted, not ambiguous", () => {
  // Ambiguity is only ever asked about an anchor that otherwise resolves --
  // a drifted one already names its current sites.
  const f = only("`narrowWritableSurface` (`src/a.ts:2-3`)", REPEATED);
  assert.equal(f.status, "drifted");
  assert.deepEqual(f.actual, [1, 5]);
});

test("an ambiguous anchor can still be carried by the manifest", () => {
  const doc = "`narrowWritableSurface` (`src/a.ts:4-7`)";
  const findings = checkDocument({ docPath: "d.md", docText: doc, readSource: () => REPEATED });
  const manifest = [{ doc: "d.md", anchor: "src/a.ts:4-7", construct: "narrowWritableSurface" }];
  const { findings: out, stale } = applyUnverified(findings, manifest, ["d.md"]);
  assert.equal(out[0].status, "unverified");
  assert.equal(out[0].was, "ambiguous");
  assert.deepEqual(stale, []);
});

test("a manifest entry matching an anchor that now resolves is reported stale", () => {
  // The key MATCHES and the anchor is `ok`. Before PEN-5091's review fix the
  // entry was marked matched regardless of status, so a corrected anchor left
  // its manifest line behind as a permanent hole -- exempting it again the next
  // time it drifted. Distinct from the test below, where the key differs.
  const doc = "`parseThing` (`src/a.ts:2`)";
  const manifest = [{ doc: "d.md", anchor: "src/a.ts:2", construct: "parseThing" }];
  const { findings, stale } = applyUnverified(check(doc), manifest, ["d.md"]);
  assert.equal(findings[0].status, "ok", "a resolving anchor must not be downgraded");
  assert.deepEqual(stale, ["d.md\tsrc/a.ts:2\tparseThing"]);
});

test("manifest entries for documents outside this run are not judged", () => {
  // A narrowed --glob must not report every other document's entries as stale.
  const doc = "`parseThing` (`src/a.ts:4-5`)";
  const manifest = [{ doc: "other.md", anchor: "x.ts:1", construct: "q" }];
  const { findings, stale } = applyUnverified(check(doc), manifest, ["d.md"]);
  assert.deepEqual(stale, []);
  assert.equal(findings[0].status, "drifted");
});

test("resolveConstruct skips path-shaped spans when inferring", () => {
  const text = "`src/a.ts` `parseThing` `:2`";
  const spans = spansOf(text);
  const anchorIndex = spans.findIndex((s) => s.text === ":2");
  assert.equal(resolveConstruct(text, spans, anchorIndex), "parseThing");
});

const failing = (f) => ["drifted", "ambiguous", "no-construct", "no-file-context", "missing-file"]
  .includes(f.status);

test("a failure the base already had is inherited, not this PR's", () => {
  const head = [{ docPath: "d.md", start: 10, status: "drifted", file: "src/a.ts" }];
  const base = [{ docPath: "d.md", start: 10, status: "drifted", file: "src/a.ts" }];
  const [out] = attributeInherited(head, base, new Set(["unrelated.ts"]));
  assert.equal(out.inherited, true);
});

test("touching the cited file owns the citation, even without opening the document", () => {
  // The PEN-4932 case this check exists for: the PR moves the source and never
  // opens the record that cites it.
  const head = [{ docPath: "d.md", start: 10, status: "drifted", file: "src/a.ts" }];
  const base = [{ docPath: "d.md", start: 10, status: "drifted", file: "src/a.ts" }];
  const [out] = attributeInherited(head, base, new Set(["src/a.ts"]));
  assert.equal(out.inherited, undefined);
});

test("an anchor this PR writes that never resolved is introduced", () => {
  const head = [{ docPath: "d.md", start: 10, status: "drifted", file: "src/a.ts" }];
  const base = [{ docPath: "d.md", start: 10, status: "drifted", file: "src/a.ts" }];
  const [out] = attributeInherited(head, base, new Set(["d.md"]));
  assert.equal(out.inherited, undefined);
});

test("an anchor that held against the base is inherited even when this PR edits the document", () => {
  // The race that ejected this PR from the merge queue at a head whose anchors were
  // correct when written: a master commit lands mid-run and moves the HEAD source
  // only. The base source does not move, so the document's own PR stays green for
  // the length of its CI run.
  const head = [{ docPath: "d.md", start: 10, status: "drifted", file: "src/a.ts" }];
  const base = [{ docPath: "d.md", start: 10, status: "ok", file: "src/a.ts" }];
  const [out] = attributeInherited(head, base, new Set(["d.md"]));
  assert.equal(out.inherited, true);
  // ...and it is tagged as the base-OK case, so the report does not file it under
  // "already failing on the base" -- a claim about the base that this run refutes.
  assert.equal(out.driftedSinceBase, true);
});

test("under a merge-queue base, drift master landed before the entry is inherited", () => {
  // Case 2 asks whether the anchor resolved against the base's copy of the source, to
  // tell a number that was never right from one the base moved out from under. Under a
  // merge-queue base there is no such distinction to draw: the base IS master's tip at
  // enqueue time, so every line master moved since the entry forked answers "no" and
  // the document's own PR is charged with all of it. #3151 was ejected twice that way,
  // spending a code-owner sign-off on each head.
  const head = [{ docPath: "d.md", start: 10, status: "drifted", file: "src/a.ts" }];
  const base = [{ docPath: "d.md", start: 10, status: "drifted", file: "src/a.ts" }];
  const [out] = attributeInherited(head, base, new Set(["d.md"]), { queueBase: true });
  assert.equal(out.inherited, true);
});

test("the SAME finding is introduced under the default `pr` base kind", () => {
  // The control for the test above. Without it the assertion would pass just as well
  // against an attributeInherited that inherited everything, which is the mutation
  // this pair exists to catch.
  const head = [{ docPath: "d.md", start: 10, status: "drifted", file: "src/a.ts" }];
  const base = [{ docPath: "d.md", start: 10, status: "drifted", file: "src/a.ts" }];
  const [out] = attributeInherited(head, base, new Set(["d.md"]));
  assert.equal(out.inherited, undefined);
});

test("a queue base does NOT excuse the combined tree moving the cited file", () => {
  // Case 1 is why the queue runs this check at all: an entry queued ahead moves the
  // source, and no single PR's own run can see the combination. Unchanged under a
  // queue base -- the flag retires case 2 and nothing else.
  const head = [{ docPath: "d.md", start: 10, status: "drifted", file: "src/a.ts" }];
  const base = [{ docPath: "d.md", start: 10, status: "ok", file: "src/a.ts" }];
  const [out] = attributeInherited(head, base, new Set(["src/a.ts"]), { queueBase: true });
  assert.equal(out.inherited, undefined);
});

test("an inherited anchor that also failed at the base is not tagged drifted-since-base", () => {
  // The other inherited case: broken at the base too, so "already failing on the base"
  // is the accurate label for it and the two must not share one.
  const head = [{ docPath: "d.md", start: 10, status: "drifted", file: "src/a.ts" }];
  const base = [{ docPath: "d.md", start: 10, status: "drifted", file: "src/a.ts" }];
  const [out] = attributeInherited(head, base, new Set());
  assert.equal(out.inherited, true);
  assert.equal(out.driftedSinceBase, false);
});

test("renaming a cited file owns the citation: the old path counts as changed", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const root = mkdtempSync(join(tmpdir(), "anchor-rename-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  try {
    git("init", "-q");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src/a.ts"), SOURCE);
    git("add", "-A");
    git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD");
    git("mv", "src/a.ts", "src/b.ts");
    git("commit", "-qm", "rename");

    const changed = changedSince(base, root);
    assert.ok(changed.has("src/a.ts"), "a rename must report the path it removed");

    // End to end: the document is untouched, the cited file moved. Fatal, not inherited.
    const doc = "`parseThing` (`src/a.ts:2`)";
    const head = checkDocument({ docPath: "d.md", docText: doc, readSource: () => null });
    const atBase = checkDocument({ docPath: "d.md", docText: doc, readSource: () => SOURCE });
    const [f] = attributeInherited(head, atBase, changed);
    assert.equal(f.status, "missing-file");
    assert.ok(!f.inherited, "a file this PR moved away cannot be inherited drift");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// A `pull_request` checkout is `refs/pull/N/merge`, not the PR head. The fixture below
// builds that exact shape -- base, a master commit, a PR commit, and a merge of the two
// -- because the defect is invisible against a linear history: the three-dot diff only
// over-reports once the base is an ancestor of the thing being diffed.
const mergeRefFixture = async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const root = mkdtempSync(join(tmpdir(), "anchor-mergeref-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "master");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "src/a.ts"), SOURCE);
  writeFileSync(join(root, "docs/d.md"), "x\n");
  git("add", "-A");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");

  // The PR: it edits the document only. It never opens src/a.ts.
  git("checkout", "-q", "-b", "pr");
  writeFileSync(join(root, "docs/d.md"), "`parseThing` (`src/a.ts:2`)\n");
  git("add", "-A");
  git("commit", "-qm", "pr edits the doc");
  const head = git("rev-parse", "HEAD");

  // Master, independently: it moves src/a.ts's contents down. Nothing to do with the PR.
  git("checkout", "-q", "master");
  writeFileSync(join(root, "src/a.ts"), `// pushed down\n${SOURCE}`);
  git("add", "-A");
  git("commit", "-qm", "master moves the cited file");

  // What actions/checkout gives the job on a pull_request event.
  git("checkout", "-q", "-b", "mergeref");
  git("merge", "-q", "--no-ff", "-m", "Merge pr into master", "pr");
  return { root, base, head, rm: () => rmSync(root, { recursive: true, force: true }) };
};

test("changedSince reports only the PR's files when the worktree is a merge ref", async () => {
  const { root, base, head, rm } = await mergeRefFixture();
  try {
    const viaWorktree = changedSince(base, root);
    assert.ok(
      viaWorktree.has("src/a.ts"),
      "the merge ref carries master's commits, so the worktree diff over-reports",
    );

    const viaHead = changedSince(base, root, head);
    assert.ok(viaHead.has("docs/d.md"), "the PR's own file must still be reported");
    assert.ok(
      !viaHead.has("src/a.ts"),
      "a file only master touched must not be attributed to this PR",
    );
  } finally {
    rm();
  }
});

test("master moving a cited file under a merge-ref checkout is inherited, not fatal", async () => {
  const { root, base, head, rm } = await mergeRefFixture();
  try {
    // A RANGE, so the drift stays FATAL and there is an attribution question to ask:
    // the same single-line anchor is a stale number since PEN-6674 and is never fatal,
    // which would make this test pass for the wrong reason.
    const doc = "`parseThing` (`src/a.ts:1-2`)";
    const atHead = checkDocument({
      docPath: "docs/d.md",
      docText: doc,
      readSource: () => `// pushed down\n${SOURCE}`,
    });
    const atBase = checkDocument({ docPath: "docs/d.md", docText: doc, readSource: () => SOURCE });
    assert.equal(atHead[0].status, "drifted", "the fixture must actually drift");
    assert.equal(atBase[0].status, "ok", "and must resolve at the base");

    const [wrong] = attributeInherited(atHead, atBase, changedSince(base, root));
    assert.ok(
      !wrong.inherited,
      "regression guard: the worktree diff attributes master's move to this PR",
    );

    const [right] = attributeInherited(atHead, atBase, changedSince(base, root, head));
    assert.ok(right.inherited, "drift master caused must not fail this PR");
    assert.ok(right.driftedSinceBase, "it resolved at the base, so it is drifted-since-base");
  } finally {
    rm();
  }
});

test("a PR that moves the cited file still owns it under a merge-ref checkout", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const root = mkdtempSync(join(tmpdir(), "anchor-mergeref-own-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  try {
    git("init", "-q", "-b", "master");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "src/a.ts"), SOURCE);
    writeFileSync(join(root, "docs/d.md"), "`parseThing` (`src/a.ts:1-2`)\n");
    git("add", "-A");
    git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD");

    // This time the PR itself moves the cited code and never opens the document --
    // the PEN-4932 case the whole check exists for. Narrowing attribution to the PR
    // must not lose it.
    git("checkout", "-q", "-b", "pr");
    writeFileSync(join(root, "src/a.ts"), `// pushed down\n${SOURCE}`);
    git("add", "-A");
    git("commit", "-qm", "pr moves the cited file");
    const head = git("rev-parse", "HEAD");

    git("checkout", "-q", "master");
    writeFileSync(join(root, "unrelated.txt"), "master did something else\n");
    git("add", "-A");
    git("commit", "-qm", "master");
    git("checkout", "-q", "-b", "mergeref");
    git("merge", "-q", "--no-ff", "-m", "Merge pr into master", "pr");

    // A RANGE, for the reason given in the test above: a single-line stale number is
    // not a failure, so it could not show that the PR still OWNS the citation.
    const doc = "`parseThing` (`src/a.ts:1-2`)";
    const atHead = checkDocument({
      docPath: "docs/d.md",
      docText: doc,
      readSource: () => `// pushed down\n${SOURCE}`,
    });
    const atBase = checkDocument({ docPath: "docs/d.md", docText: doc, readSource: () => SOURCE });
    const [f] = attributeInherited(atHead, atBase, changedSince(base, root, head));
    assert.equal(f.status, "drifted");
    assert.ok(!f.inherited, "the PR moved the cited file, so it owns the citation");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The three tests above pin `changedSince` and `attributeInherited`. This one pins the
// wiring between them and the command line -- a `main()` that parsed --head and then
// never passed it on would satisfy all three and still ship the defect.
test("end to end: --head decides whether master's drift fails the run", async () => {
  const { writeFileSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const script = join(dirname(fileURLToPath(import.meta.url)), "check-doc-line-anchors.mjs");

  const { root, base, head, rm } = await mergeRefFixture();
  try {
    // The glob the real run uses is docs/security/**; this fixture keeps its document
    // at docs/, so point the checker at it explicitly.
    writeFileSync(join(root, "docs/d.md"), "`parseThing` (`src/a.ts:1-2`)\n");
    const run = (...extra) =>
      spawnSync(process.execPath, [script, "--root", root, "--glob", "docs/*.md", "--quiet",
        "--base", base, ...extra], { encoding: "utf8" });

    const worktree = run();
    assert.equal(worktree.status, 1, "without --head the merge ref's master commits are fatal");
    assert.match(worktree.stderr, /DRIFTED/);

    const pinned = run("--head", head);
    assert.equal(pinned.status, 0, `--head confines attribution to the PR: ${pinned.stderr}`);
    assert.match(pinned.stderr, /DRIFTED ON MASTER SINCE THE BASE/);

    // A head the repository does not have must refuse to judge, not fall back to
    // attributing everything to this PR. Asserted on the behaviour, not on which
    // branch produces it -- the diff failing is a refusal just as much as a pre-check.
    const bogus = run("--head", "0000000000000000000000000000000000000000");
    assert.equal(bogus.status, 2, "an unresolvable --head is a refusal, not a verdict");
    assert.match(bogus.stderr, /cannot judge/);
  } finally {
    rm();
  }
});

// PEN-6674, pinned end to end because it is the command line that decides it: a
// severity split in checkDocument that report() or main() did not carry through would
// satisfy every unit test above and still eject the entry.
//
// This is the merge-queue shape, and it is the one no entry can win by being careful.
// The entry is prepared correctly against its own base and enqueued. The group the
// queue builds carries the entries ahead of it, which moved the same source file, so
// the entry's numbers are wrong against a tree that did not exist when it was written.
// `changed` holds the cited file, so attribution case 1 charges the entry for all of
// it. Measured on Blockcast/paperclip 2026-11-14: #3715 evicted three times, #3476
// once, #3774 red on 8 anchors, each eviction spending a human enqueue act.
const queueFixture = async (docAnchor, queueSource) => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const root = mkdtempSync(join(tmpdir(), "anchor-queue-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "master");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "src/a.ts"), SOURCE);
  writeFileSync(join(root, "docs/d.md"), "x\n");
  git("add", "-A");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");

  // The merge-group head: this entry moved the cited file, and so did an entry queued
  // ahead of it, so the file sits two lines lower than anything the entry could see.
  // The document carries the number that was correct for the entry alone.
  writeFileSync(join(root, "src/a.ts"), queueSource);
  writeFileSync(join(root, "docs/d.md"), docAnchor);
  git("add", "-A");
  git("commit", "-qm", "merge group");
  const head = git("rev-parse", "HEAD");
  return { root, base, head, rm: () => rmSync(root, { recursive: true, force: true }) };
};

test("a stale number does not eject a merge-group entry, and real rot still does", async () => {
  const { join, dirname } = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const script = join(dirname(fileURLToPath(import.meta.url)), "check-doc-line-anchors.mjs");

  const run = (f) =>
    spawnSync(
      process.execPath,
      [script, "--root", f.root, "--glob", "docs/*.md", "--quiet",
        "--base", f.base, "--head", f.head, "--base-kind", "queue"],
      { encoding: "utf8" },
    );

  // The entry's `:3` was right against its own base; the group pushed the construct
  // to :4. Nothing here needs a human, and it must not cost an enqueue act.
  const stale = await queueFixture("`parseThing` (`src/a.ts:3`)\n", `// ahead\n// entry\n${SOURCE}`);
  try {
    const r = run(stale);
    assert.equal(r.status, 0, `a stale number must not eject the entry: ${r.stderr}`);
    assert.match(r.stderr, /STALE NUMBER/, "and it must still be reported, with its new line");
    assert.match(r.stderr, /:4/);
    assert.doesNotMatch(r.stderr, /need attention/);
  } finally {
    stale.rm();
  }

  // The must-fail arm. Same shape, same attribution, but the construct is GONE from
  // the combined tree -- the anchor rot this check was built for. Without this the
  // test above passes just as well against a checker that fails on nothing.
  const rot = await queueFixture("`parseThing` (`src/a.ts:3`)\n", "const a = 1;\nconst b = 2;");
  try {
    const r = run(rot);
    assert.equal(r.status, 1, "a construct that left the file must still eject the entry");
    assert.match(r.stderr, /DRIFTED/);
    assert.match(r.stderr, /no longer in the file at all/);
  } finally {
    rot.rm();
  }
});

// PEN-6680, pinned end to end because `--fix` is a COMMAND LINE: the narrowing lives in
// main's ordering as much as in the predicate. The fix loop used to run before the base
// was even resolved, so there was no attribution in scope to consult -- a change that
// only taught applyFixes the term would have satisfied every unit test above and still
// written the inherited number.
//
// The fixture carries one of each. `src/a.ts` is moved by this change, so the number
// citing it is this change's doing. `src/b.ts` and the document citing it are untouched,
// and that number was already stale at the base -- master's drift, which #3774 measured
// --fix rewriting into an unrelated security document.
const OTHER_SOURCE = [
  "const b = 1;", // 1
  "function otherThing(", // 2
  "  input: unknown,", // 3
  ") {", // 4
  "  return null;", // 5
  "}", // 6
].join("\n");

const INHERITED_DOC = "`otherThing` (`src/b.ts:4`)\n";

const introducedInheritedFixture = async ({
  touchDoc = null,
  manifest = null,
  commit = true,
} = {}) => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const root = mkdtempSync(join(tmpdir(), "anchor-narrow-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "master");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "src/a.ts"), SOURCE);
  writeFileSync(join(root, "src/b.ts"), OTHER_SOURCE);
  writeFileSync(join(root, "docs/one.md"), "`parseThing` (`src/a.ts:2`)\n");
  // Stale at the base already: `otherThing` is at :2 and has never been at :4.
  writeFileSync(join(root, "docs/two.md"), INHERITED_DOC);
  if (manifest) writeFileSync(join(root, "m.json"), JSON.stringify(manifest));
  git("add", "-A");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");

  // The change: it pushes src/a.ts down two lines. It opens neither src/b.ts nor, by
  // default, either document.
  writeFileSync(join(root, "src/a.ts"), `// this change added\n// two lines\n${SOURCE}`);
  if (touchDoc) {
    writeFileSync(join(root, touchDoc), `${INHERITED_DOC}\nthis change edited the document.\n`);
  }
  // `commit: false` leaves exactly the same change sitting in the WORKTREE. Everything
  // about the tree is identical; the only difference is whether `base...HEAD` can see
  // it, which is the whole of PEN-6680's follow-up.
  if (commit) {
    git("add", "-A");
    git("commit", "-qm", "the change moves the cited file");
  }
  const head = git("rev-parse", "HEAD");
  return { root, base, head, rm: () => rmSync(root, { recursive: true, force: true }) };
};

const checkerPath = async () => {
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  return join(dirname(fileURLToPath(import.meta.url)), "check-doc-line-anchors.mjs");
};

test("end to end: --fix rewrites what this change made stale and nothing else", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const script = await checkerPath();

  const f = await introducedInheritedFixture();
  try {
    const run = (...extra) =>
      spawnSync(process.execPath, [script, "--root", f.root, "--glob", "docs/*.md", ...extra], {
        encoding: "utf8",
      });
    const doc = (rel) => readFileSync(join(f.root, rel), "utf8");

    const r = run("--base", f.base, "--head", f.head, "--fix");
    assert.equal(r.status, 0, `a stale number is never fatal: ${r.stderr}`);
    assert.equal(doc("docs/one.md"), "`parseThing` (`src/a.ts:4`)\n", "the introduced one");
    assert.equal(
      doc("docs/two.md"),
      INHERITED_DOC,
      "an inherited stale number must be left textually untouched, not merely unreported",
    );

    // And still REPORTED. Narrowing what --fix writes must not narrow what it says:
    // the number is the one thing the run is holding, and dropping it would trade a
    // widened diff for a silent corpus.
    assert.match(r.stderr, /STALE NUMBER {2}docs\/two\.md/);
    assert.match(r.stderr, /construct `otherThing` is now at :2/);
    assert.match(r.stdout, /1 with a stale number/, "the inherited one still counts");

    // The must-fail half. Without it this test passes just as well against a --fix that
    // writes nothing at all, and the fixture would not be shown to contain two
    // rewritable anchors in the first place.
    const wide = run("--fix-all");
    assert.equal(wide.status, 0, wide.stderr);
    assert.equal(doc("docs/two.md"), "`otherThing` (`src/b.ts:2`)\n", "--fix-all takes both");
  } finally {
    f.rm();
  }
});

test("end to end: --fix without a base refuses rather than guessing wide", async () => {
  // The remedy the report and docs/security both recommended was a bare `--fix`, so
  // this is the invocation the corpus actually sees. With no base there is no
  // introduced set, and the wide answer is the foot-gun itself.
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const script = await checkerPath();

  const f = await introducedInheritedFixture();
  try {
    const r = spawnSync(
      process.execPath,
      [script, "--root", f.root, "--glob", "docs/*.md", "--fix"],
      { encoding: "utf8" },
    );
    assert.equal(r.status, 2, "a run that cannot attribute must refuse, not judge");
    assert.match(r.stderr, /cannot judge/);
    assert.match(r.stderr, /--fix-all/, "and must name the deliberate wide mode");
    assert.equal(readFileSync(join(f.root, "docs/one.md"), "utf8"), "`parseThing` (`src/a.ts:2`)\n");
    assert.equal(readFileSync(join(f.root, "docs/two.md"), "utf8"), INHERITED_DOC);
  } finally {
    f.rm();
  }
});

// PEN-6680 follow-up (Ally review on #3788). `--fix` WRITES TO THE WORKTREE, and the
// set it was narrowed to was `base...HEAD` -- committed work only. Locally, before you
// commit, BOTH ownership arms are therefore empty: an uncommitted source move is not "a
// file you moved" and an uncommitted doc edit is not "a document you are already
// editing". So the documented remedy was a silent no-op in its most common use, and the
// report then recommended the same command again. It failed CLOSED -- fewer writes, the
// number still reported -- which is why no test and no gate caught it.
test("end to end: --fix owns an UNCOMMITTED move of the cited file", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const script = await checkerPath();

  const f = await introducedInheritedFixture({ commit: false });
  try {
    const run = (...extra) =>
      spawnSync(process.execPath, [script, "--root", f.root, "--glob", "docs/*.md", ...extra], {
        encoding: "utf8",
      });
    const doc = (rel) => readFileSync(join(f.root, rel), "utf8");

    // The must-fail half FIRST, and it is the same command with --head pinned to the
    // commit. That is the old behaviour exactly: attribution against a commit cannot see
    // the worktree, so the fix is a no-op. It is also the CI shape, which must not move.
    const pinned = run("--base", f.base, "--head", f.head, "--fix");
    assert.equal(pinned.status, 0, pinned.stderr);
    assert.equal(
      doc("docs/one.md"),
      "`parseThing` (`src/a.ts:2`)\n",
      "an explicit --head says the worktree is not the change; the union must not apply",
    );

    // And without --head, where the worktree IS the change being judged.
    const r = run("--base", f.base, "--fix");
    assert.equal(r.status, 0, `a stale number is never fatal: ${r.stderr}`);
    assert.equal(doc("docs/one.md"), "`parseThing` (`src/a.ts:4`)\n", "the uncommitted move");
    assert.equal(
      doc("docs/two.md"),
      INHERITED_DOC,
      "widening to the worktree must not widen past it: the base's drift stays untouched",
    );
  } finally {
    f.rm();
  }
});

// The other ownership arm, and the case ownsStaleNumber keeps the doc-arm for at all:
// "I am writing this citation, renumber it for me". That almost always happens BEFORE
// the commit, so it was the arm most completely broken by attributing against one.
test("end to end: --fix owns a citation in a document edited but not committed", async () => {
  const { readFileSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const script = await checkerPath();

  // Nothing is committed on top of the base at all: the only change in this tree is an
  // unstaged edit to the document that carries the already-stale citation.
  const f = await introducedInheritedFixture({ commit: false });
  try {
    writeFileSync(
      join(f.root, "docs/two.md"),
      `${INHERITED_DOC}\nI am editing this document right now.\n`,
    );
    const r = spawnSync(
      process.execPath,
      [script, "--root", f.root, "--glob", "docs/*.md", "--base", f.base, "--fix"],
      { encoding: "utf8" },
    );
    assert.equal(r.status, 0, r.stderr);
    assert.match(
      readFileSync(join(f.root, "docs/two.md"), "utf8"),
      /`otherThing` \(`src\/b\.ts:2`\)/,
      "editing the document is what owns the number in it",
    );
  } finally {
    f.rm();
  }
});

// The hint half. A run that declined a number declined it on purpose, so pointing the
// reader back at the command that just declined them reads as the fix having failed.
test("an inherited stale number is reported apart, and not under the --fix hint", async () => {
  const { spawnSync } = await import("node:child_process");
  const script = await checkerPath();

  const f = await introducedInheritedFixture();
  try {
    const r = spawnSync(
      process.execPath,
      [script, "--root", f.root, "--glob", "docs/*.md", "--base", f.base, "--head", f.head],
      { encoding: "utf8" },
    );
    assert.equal(r.status, 0, r.stderr);
    const lines = r.stderr.split("\n");
    const heading = lines.findIndex((l) => l.startsWith("STALE LINE NUMBERS INHERITED FROM THE BASE"));
    assert.ok(heading >= 0, `expected the inherited heading in:\n${r.stderr}`);
    assert.match(lines[heading + 1], /STALE NUMBER {2}docs\/two\.md/);
    // The must-fail half: the fixture's OTHER number is this change's, so the owned
    // block must still be printed. A rule that moved everything into the new bucket
    // would pass the assertion above and say nothing true.
    assert.ok(
      lines.some((l) => /^STALE LINE NUMBERS \(/.test(l)),
      `the introduced number keeps the actionable heading:\n${r.stderr}`,
    );
  } finally {
    f.rm();
  }
});

// PEN-6680, second Ally review on #3788. The worktree union was a TWO-DOT diff against
// `ref` itself, so it asked "how does my tree differ from master's TIP" -- and being
// behind master is the normal state of anyone who fetched after branching. Every file
// master changed since the fork then landed in the fix scope, and `--fix --base
// origin/master` renumbered citations in documents this change never opened, over drift
// that is the base's. That is the #3774 widening the narrowing exists to remove,
// arriving through the union instead of through the missing filter. Reproduced on
// 110b74f0 before the fix: `fixed docs/two.md:1 \`src/b.ts:4\` -> :2`, rc 0.
//
// The existing fixtures cannot see it: their base IS the fork, so the two-dot and
// merge-base forms are the same set and every assertion passes either way.
const behindBaseFixture = async ({ commit = true } = {}) => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const root = mkdtempSync(join(tmpdir(), "anchor-behind-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "master");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "src/a.ts"), SOURCE);
  writeFileSync(join(root, "src/b.ts"), OTHER_SOURCE);
  writeFileSync(join(root, "docs/one.md"), "`parseThing` (`src/a.ts:2`)\n");
  // Stale at the fork already, and it stays the base's: nothing in this change opens
  // either `src/b.ts` or the document citing it.
  writeFileSync(join(root, "docs/two.md"), INHERITED_DOC);
  git("add", "-A");
  git("commit", "-qm", "fork point");
  const fork = git("rev-parse", "HEAD");

  // MASTER MOVES ON, and this branch does not follow. `src/b.ts` is now a file the BASE
  // TIP differs from this tree at, while being no part of this change.
  writeFileSync(join(root, "src/b.ts"), `${OTHER_SOURCE}\n// master appended this\n`);
  git("add", "-A");
  git("commit", "-qm", "master moves the cited file");
  const base = git("rev-parse", "HEAD");

  git("checkout", "-q", "-b", "feature", fork);
  // This change, and all of it: two lines above `parseThing`, in `src/a.ts` only.
  writeFileSync(join(root, "src/a.ts"), `// this change added\n// two lines\n${SOURCE}`);
  if (commit) {
    git("add", "-A");
    git("commit", "-qm", "the change moves src/a.ts");
  }
  const head = git("rev-parse", "HEAD");
  return { root, fork, base, head, rm: () => rmSync(root, { recursive: true, force: true }) };
};

test("end to end: a branch behind master does not inherit master's files into --fix", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const script = await checkerPath();

  // Both halves of the local shape: the change committed, and the same change sitting
  // uncommitted in the worktree. The union is taken in both, so the base tip can leak
  // into both, and only the merge-base anchor keeps either narrow.
  for (const commit of [true, false]) {
    const f = await behindBaseFixture({ commit });
    try {
      const doc = (rel) => readFileSync(join(f.root, rel), "utf8");
      const run = (...extra) =>
        spawnSync(process.execPath, [script, "--root", f.root, "--glob", "docs/*.md", ...extra], {
          encoding: "utf8",
        });

      // The documented command, verbatim in shape: a base ref whose tip is ahead of
      // this branch, and no --head.
      const r = run("--base", f.base, "--fix");
      assert.equal(r.status, 0, `a stale number is never fatal: ${r.stderr}`);

      // THE MUST-FAIL ASSERTION. Against the two-dot form this reads `src/b.ts:2`,
      // because master's commit put `src/b.ts` in the diff and ownership arm 1 then
      // scored the citation as this change's.
      assert.equal(
        doc("docs/two.md"),
        INHERITED_DOC,
        `commit=${commit}: master's own files must not become this change's fix scope`,
      );

      // ...and the fixture is not vacuous: the number this change DID make stale is
      // still rewritten, so the test cannot be satisfied by a --fix that writes nothing.
      assert.equal(
        doc("docs/one.md"),
        "`parseThing` (`src/a.ts:4`)\n",
        `commit=${commit}: the owned number must still be rewritten`,
      );

      // ...and `docs/two.md` was rewritable all along, so the assertion above is a
      // narrowing and not an anchor the checker simply cannot place.
      const wide = run("--fix-all");
      assert.equal(wide.status, 0, wide.stderr);
      assert.equal(doc("docs/two.md"), "`otherThing` (`src/b.ts:2`)\n", "--fix-all takes it");
    } finally {
      f.rm();
    }
  }
});

test("worktreeChangedSince is anchored at the merge base, not at the ref's tip", async () => {
  const { execFileSync } = await import("node:child_process");

  const f = await behindBaseFixture({ commit: false });
  try {
    const wt = worktreeChangedSince(f.base, f.root);
    assert.ok(wt.has("src/a.ts"), "this change's own uncommitted work is in scope");
    assert.ok(!wt.has("src/b.ts"), "a file only MASTER moved is not this change's");

    // The control that makes it a comparison rather than a tautology: the two-dot form
    // against the same ref does list master's file, which is the defect in one line.
    const twoDot = execFileSync("git", ["diff", "--no-renames", "--name-only", f.base], {
      cwd: f.root,
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean);
    assert.ok(twoDot.includes("src/b.ts"), "fixture must actually put master ahead");
  } finally {
    f.rm();
  }
});

test("worktreeChangedSince sees staged, unstaged and untracked work; changedSince does not", async () => {
  const { writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");

  const f = await introducedInheritedFixture({ commit: false });
  try {
    const git = (...args) => execFileSync("git", args, { cwd: f.root, encoding: "utf8" });
    writeFileSync(join(f.root, "docs/staged.md"), "staged\n");
    git("add", "docs/staged.md");
    writeFileSync(join(f.root, "docs/untracked.md"), "untracked\n");

    const wt = worktreeChangedSince(f.base, f.root);
    assert.ok(wt.has("src/a.ts"), "unstaged");
    assert.ok(wt.has("docs/staged.md"), "staged");
    assert.ok(wt.has("docs/untracked.md"), "untracked");

    // The control that makes the test a comparison rather than a tautology: the
    // committed-only set sees none of it, which is the defect in one line.
    assert.deepEqual([...changedSince(f.base, f.root)], [], "base...HEAD sees committed work only");
  } finally {
    f.rm();
  }
});

// PEN-6680 R1. Since PEN-6674 a single-line anchor whose construct is still uniquely
// placed is a STALE NUMBER, which is outside FAILING -- so a manifest entry naming it is
// no longer discharged, and comes back as STALE MANIFEST ENTRY. That is intended: only a
// STILL-FAILING anchor discharges an entry, which is what makes the manifest shrink and
// stops it becoming a permanent hole. It was carried on prose alone, with the manifest
// empty at master, which is exactly the state in which the next author meets it cold.
test("a manifest entry whose anchor is now a stale number is reported, not discharged", () => {
  const doc = "`parseThing` (`src/a.ts:5`)";
  const findings = check(doc);
  assert.equal(findings[0].status, "stale-number", "fixture must be renumberable");
  const manifest = [{ doc: "d.md", anchor: "src/a.ts:5", construct: "parseThing" }];
  const { findings: out, stale } = applyUnverified(findings, manifest, ["d.md"]);
  assert.equal(out[0].status, "stale-number", "a stale number must not be downgraded");
  assert.deepEqual(stale, ["d.md\tsrc/a.ts:5\tparseThing"]);
});

test("that entry is fatal for a change that touches the document, inherited otherwise", async () => {
  const { spawnSync } = await import("node:child_process");
  const script = await checkerPath();
  const manifest = [{ doc: "docs/two.md", anchor: "src/b.ts:4", construct: "otherThing" }];
  const run = (f) =>
    spawnSync(
      process.execPath,
      [script, "--root", f.root, "--glob", "docs/*.md", "--base", f.base, "--head", f.head,
        "--unverified", `${f.root}/m.json`],
      { encoding: "utf8" },
    );

  // Untouched: the entry is stale against the base too, so it is the base's to settle.
  const away = await introducedInheritedFixture({ manifest });
  try {
    const r = run(away);
    assert.equal(r.status, 0, `an inherited stale entry must not fail this change: ${r.stderr}`);
    assert.match(r.stderr, /INHERITED[\s\S]*STALE MANIFEST ENTRY {2}docs\/two\.md/);
  } finally {
    away.rm();
  }

  // Touched: the change is editing the document the entry exempts, so it is the change
  // that has to drop the line. This is the arm that makes the manifest shrink.
  const here = await introducedInheritedFixture({ manifest, touchDoc: "docs/two.md" });
  try {
    const r = run(here);
    assert.equal(r.status, 1, "a change editing the document owns the stale entry");
    assert.match(r.stderr, /^STALE MANIFEST ENTRY {2}docs\/two\.md/m);
    assert.match(r.stderr, /Remove the entry/);
  } finally {
    here.rm();
  }
});

test("attribution leaves passing anchors alone", () => {
  // The changed set is empty on purpose: every later branch would fall through to
  // `inherited` here, so this pins the status guard itself rather than riding on one
  // of the attribution branches returning first.
  const head = [{ docPath: "d.md", start: 10, status: "ok", file: "src/a.ts" }];
  const [out] = attributeInherited(head, [], new Set());
  assert.equal(out.inherited, undefined);
});

test("anchor-local hands the document back to this tree", () => {
  assert.deepEqual(parseDirective("<!-- anchor-local -->"), { path: null, external: null });

  const doc = [
    "<!-- anchor-external: other-repo -->",
    "an aside citing `other/thing.rs:3`",
    "<!-- anchor-local -->",
    "back home: `parseThing` (`src/a.ts:2`)",
  ].join("\n");
  const f = check(doc);
  assert.equal(f[0].status, "external");
  assert.equal(f[1].status, "ok");
});

test("a bare anchor below anchor-local has no file context, rather than the aside's repo", () => {
  const doc = [
    "<!-- anchor-external: other-repo -->",
    "<!-- anchor-local -->",
    "`parseThing` (`:2`)",
  ].join("\n");
  assert.equal(only(doc).status, "no-file-context");
});

test("the real corpus still has anchors to check, and most of them are enforced", async () => {
  // Deliberately NOT an assertion that the corpus is clean. That assertion is what
  // the CI step makes, with `--base $PR_BASE_SHA`, so it can tell drift this PR
  // caused from drift it inherited from master. Repeating it here without a base
  // re-creates the tripwire: this suite runs in the same `policy` job, so a master
  // commit moving a cited file would turn it red on every open PR -- which is the
  // failure this PR was ejected from the merge queue by (run 42209953505).
  //
  // What is worth asserting here is the one thing a green run cannot distinguish
  // itself from: a detector that has quietly stopped finding anything.
  const { readFileSync, existsSync, globSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");

  const docs = globSync("docs/security/**/*.md", { cwd: root }).sort();
  assert.ok(docs.length > 0, "no security documents matched");

  let all = [];
  for (const rel of docs) {
    all = all.concat(
      checkDocument({
        docPath: rel,
        docText: readFileSync(join(root, rel), "utf8"),
        readSource: (f) =>
          existsSync(join(root, f)) ? readFileSync(join(root, f), "utf8") : null,
      }),
    );
  }
  assert.ok(all.length > 0, "documents matched but carry no anchors");

  const manifest = JSON.parse(
    readFileSync(join(root, "scripts/doc-line-anchors.unverified.json"), "utf8"),
  );
  const { findings } = applyUnverified(all, manifest, docs);
  // Were every anchor to land in the manifest, or to be declared external, the
  // checker would report clean while asserting nothing at all. A `drifted` anchor
  // is still one the checker resolved and judged, so it counts as enforced:
  // counting `ok` alone made master drift trip this floor (11 anchors drifted
  // under the merge-queue tree, ok fell 35 -> 24; run 42602310293). So does a
  // `stale-number` anchor (PEN-6674): its construct was located, exactly once, so the
  // detector is demonstrably reading what the document cites and only the line
  // number is stale. Leaving that status out re-created the same tripwire when #3876
  // moved code under 13 PEN-5016 anchors: ok fell 35 -> 22, below the floor, and
  // `policy` went red on master and on every merge-queue entry (run 45587868108).
  const enforced = (f) =>
    f.status === "ok" || f.status === "drifted" || f.status === "stale-number";
  assert.ok(
    findings.filter(enforced).length >= 25,
    "too few anchors are actually enforced",
  );
  assert.ok(
    findings.filter(failing).length < findings.length / 2,
    "most of the corpus is failing; the checker is probably misreading it",
  );
});

// The main-module guard decides whether this check RUNS AT ALL, so its failure mode is
// a silent exit 0 -- a gate reporting clean without having looked. The naive
// `file://${process.argv[1]}` comparison fails open two ways, both reproduced below.

test("isMainModule: matches the direct path, rejects a different one", async () => {
  const { fileURLToPath } = await import("node:url");
  const self = fileURLToPath(import.meta.url);
  assert.equal(isMainModule(self, import.meta.url), true);
  assert.equal(isMainModule("/tmp/some-other-script.mjs", import.meta.url), false);
});

test("isMainModule: a missing argv[1] is not a match", () => {
  // `undefined` would re-trigger the default parameter and silently test the real
  // argv instead, so drive the falsy branch with values that do not default.
  assert.equal(isMainModule(null, import.meta.url), false);
  assert.equal(isMainModule("", import.meta.url), false);
});

test("isMainModule: a path needing percent-encoding still matches", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { pathToFileURL } = await import("node:url");
  const { join } = await import("node:path");

  const base = mkdtempSync(join(tmpdir(), "anchor-main-guard-"));
  try {
    // A space is the cheap reproducer; `pathToFileURL` encodes it as %20, so the naive
    // string comparison against `file://${argv}` can never be true.
    const dir = join(base, "dir with space");
    mkdirSync(dir);
    const script = join(dir, "s.mjs");
    writeFileSync(script, "");
    assert.ok(pathToFileURL(script).href.includes("%20"), "fixture did not encode");
    assert.equal(isMainModule(script, pathToFileURL(script).href), true);
    assert.notEqual(pathToFileURL(script).href, `file://${script}`);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("isMainModule: a symlinked argv[1] matches the real module url", async () => {
  const { mkdtempSync, writeFileSync, symlinkSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { pathToFileURL } = await import("node:url");
  const { join } = await import("node:path");

  const base = mkdtempSync(join(tmpdir(), "anchor-main-guard-link-"));
  try {
    const real = join(base, "real.mjs");
    writeFileSync(real, "");
    const link = join(base, "link.mjs");
    symlinkSync(real, link);
    // Node resolves symlinks for `import.meta.url` but leaves argv[1] as typed, so the
    // two differ as strings and only a realpath on both sides makes them agree.
    assert.equal(isMainModule(link, pathToFileURL(real).href), true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("the real script still runs when invoked through a symlink in an encoded path", async () => {
  const { mkdtempSync, mkdirSync, symlinkSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");

  const self = fileURLToPath(import.meta.url);
  const script = join(dirname(self), "check-doc-line-anchors.mjs");

  const base = mkdtempSync(join(tmpdir(), "anchor-main-guard-e2e-"));
  try {
    const dir = join(base, "dir with space");
    mkdirSync(dir);
    const link = join(dir, "link.mjs");
    symlinkSync(script, link);

    // `--root` at a path with no documents is the cheapest deterministic non-zero: the
    // checker refuses to judge rather than reporting clean. If the guard regresses, this
    // comes back exit 0 with empty output -- which is the whole defect.
    const run = spawnSync(process.execPath, [link, "--root", "/nonexistent-anchor-root"], {
      encoding: "utf8",
    });
    assert.equal(run.status, 2, `expected a refusal to judge, got ${run.status}`);
    assert.match(`${run.stdout}${run.stderr}`, /cannot judge/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
