import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { checkAnchors, parseAnchors } from "./check-ally-bundle-anchors.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoDoc = readFileSync(join(here, "../.planning/ally-agent/AGENTS.md"), "utf8");

test("a control anchor in the repo only is divergent; removing it is clean", () => {
  const bundle = "prose `headsWithUndispositionedFinding` and an ally-verdict:1 block";
  const base = "<!-- bundle-anchor: headsWithUndispositionedFinding -->\n<!-- bundle-anchor: ally-verdict:1 -->\n";
  assert.deepEqual(checkAnchors(base, bundle).missing, []);
  const withControl = `${base}<!-- bundle-anchor: BLO43668-CONTROL -->\n`;
  assert.deepEqual(checkAnchors(withControl, bundle).missing, ["BLO43668-CONTROL"]);
});

test("an anchor must be its own line, so a quoted example is not an anchor", () => {
  assert.deepEqual(parseAnchors("see `<!-- bundle-anchor: x -->` above\n<!-- bundle-anchor: y -->"), ["y"]);
});

test("nothing to judge is an error, not a clean pass", () => {
  assert.throws(() => checkAnchors("no anchors here", "bundle"), /no bundle-anchor/);
  assert.throws(() => checkAnchors("<!-- bundle-anchor: a -->", "  "), /empty/);
});

test("the repo contract declares the producer clauses known to have gone missing", () => {
  const anchors = parseAnchors(repoDoc);
  for (const a of ["ally-verdict:1", "headsWithUndispositionedFinding"]) assert.ok(anchors.includes(a), a);
});
