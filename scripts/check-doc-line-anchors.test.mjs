import { strict as assert } from "node:assert";
import test from "node:test";

import {
  applyFixes,
  applyUnverified,
  attributeInherited,
  changedSince,
  checkDocument,
  isMainModule,
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
    const doc = "`parseThing` (`src/a.ts:2`)";
    const atHead = checkDocument({
      docPath: "docs/d.md",
      docText: doc,
      readSource: () => `// pushed down\n${SOURCE}`,
    });
    const atBase = checkDocument({ docPath: "docs/d.md", docText: doc, readSource: () => SOURCE });
    assert.equal(atHead[0].status, "drifted", "the fixture must actually drift");

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
    writeFileSync(join(root, "docs/d.md"), "`parseThing` (`src/a.ts:2`)\n");
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

    const doc = "`parseThing` (`src/a.ts:2`)";
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
    writeFileSync(join(root, "docs/d.md"), "`parseThing` (`src/a.ts:2`)\n");
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
  // checker would report clean while asserting nothing at all.
  assert.ok(
    findings.filter((f) => f.status === "ok").length >= 25,
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
