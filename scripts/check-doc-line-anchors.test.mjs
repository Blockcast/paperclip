import { strict as assert } from "node:assert";
import test from "node:test";

import {
  applyFixes,
  applyUnverified,
  checkDocument,
  locateConstruct,
  parseAnchorSpan,
  parseDirective,
  resolveConstruct,
  spansOf,
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
  assert.equal(f.status, "drifted");
  assert.deepEqual(f.actual, [2]);
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

test("applyFixes rewrites a drifted anchor whose construct is unique", () => {
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

test("a manifest entry downgrades its own anchor and nothing else", () => {
  const doc = "`parseThing` (`src/a.ts:5`) and `input: unknown,` (`src/a.ts:6`)";
  const manifest = [{ doc: "d.md", anchor: "src/a.ts:5", construct: "parseThing" }];
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

test("manifest entries for documents outside this run are not judged", () => {
  // A narrowed --glob must not report every other document's entries as stale.
  const doc = "`parseThing` (`src/a.ts:5`)";
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

test("the real corpus is clean under the committed manifest", async () => {
  // The detector is only worth running if it is green on master: a check that
  // ships red is a check that gets ignored. This fails on a PR that drifts an
  // enforced anchor -- including a PR that never opens the document.
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
  const { findings, stale } = applyUnverified(all, manifest, docs);
  const failing = findings.filter((f) =>
    ["drifted", "no-construct", "no-file-context", "missing-file"].includes(f.status),
  );
  assert.deepEqual(
    failing.map((f) => `${f.docPath}:${f.docLine} \`${f.anchor}\``),
    [],
  );
  assert.deepEqual(stale, []);
  // Guard the enforced population directly: were every anchor to land in the
  // manifest the two assertions above would still pass, saying nothing.
  assert.ok(
    findings.filter((f) => f.status === "ok").length >= 25,
    "too few anchors are actually enforced",
  );
});
