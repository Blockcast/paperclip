import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  REWRITTEN_KEYS,
  formatProvenanceComment,
  mergeManifest,
  readShardMeasurements,
} from "../merge-shard-duration-manifest.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const durationsManifest = path.join(repoRoot, "scripts", "general-server-shard-durations.json");

function manifestFixture() {
  return {
    $comment: "STALE PROVENANCE from run 111 on 2026-01-01.",
    $notes: "NOTE ON UNITS: these are test-execution durations; do not 'fix' a small value by hand.",
    unit: "ms",
    durations: { "a.test.ts": 10, "z.test.ts": 30 },
  };
}

// The regression this file exists for: the workflow's original inline merge
// overwrote $comment with a provenance-only template, deleting the units note
// that explains why a trivial suite reads as single-digit ms. First scheduled
// run would have destroyed it, unwatched (BLO-24241).
test("a refresh preserves the durable $notes prose verbatim", () => {
  const manifest = manifestFixture();

  const next = mergeManifest({
    manifest,
    measured: { "a.test.ts": 12 },
    runId: "999",
    date: "2026-08-19",
  });

  assert.equal(next["$notes"], manifest["$notes"], "$notes must survive a refresh untouched");
});

test("a refresh rewrites only $comment and durations, passing every other key through", () => {
  const manifest = manifestFixture();

  const next = mergeManifest({ manifest, measured: { "a.test.ts": 12 }, runId: "999", date: "2026-08-19" });

  const changed = Object.keys({ ...manifest, ...next }).filter(
    (key) => JSON.stringify(next[key]) !== JSON.stringify(manifest[key]),
  );
  assert.deepEqual(changed.sort(), [...REWRITTEN_KEYS].sort());
  assert.equal(next.unit, "ms");
});

test("a refresh replaces the provenance sentence with the current run and date", () => {
  const manifest = manifestFixture();

  const next = mergeManifest({ manifest, measured: { "a.test.ts": 12 }, runId: "999", date: "2026-08-19" });

  assert.ok(!next["$comment"].includes("run 111"), "stale run id must not survive");
  assert.ok(next["$comment"].includes("999"));
  assert.ok(next["$comment"].includes("2026-08-19"));
});

test("fresh measurements win over stale entries and un-measured suites keep their duration", () => {
  const next = mergeManifest({
    manifest: manifestFixture(),
    measured: { "a.test.ts": 12, "m.test.ts": 5 },
    runId: "999",
    date: "2026-08-19",
  });

  assert.deepEqual(Object.keys(next.durations), ["a.test.ts", "m.test.ts", "z.test.ts"]);
  assert.equal(next.durations["a.test.ts"], 12, "a fresh measurement must win");
  assert.equal(next.durations["z.test.ts"], 30, "an un-remeasured suite keeps its prior duration");
});

// Without a prune the merge is purely additive, so a deleted suite keeps its
// entry forever and totalCount in the provenance sentence overstates coverage.
test("a refresh prunes entries for suites no longer on disk", () => {
  const next = mergeManifest({
    manifest: manifestFixture(),
    measured: { "a.test.ts": 12 },
    runId: "999",
    date: "2026-08-19",
    knownSuites: ["a.test.ts"],
  });

  assert.deepEqual(Object.keys(next.durations), ["a.test.ts"], "z.test.ts was deleted from the repo");
  assert.ok(next["$comment"].includes("1 total"), "totalCount must reflect the prune");
});

// The prune is keyed on the suite set ON DISK, never on what this run
// measured. The measure matrix is fail-fast: false across four shards, so a
// measured-keyed prune would let one failed shard delete a quarter of the
// manifest, unattended, on a Monday-morning schedule.
test("a refresh keeps on-disk suites that this run did not measure", () => {
  const next = mergeManifest({
    manifest: manifestFixture(),
    measured: { "a.test.ts": 12 },
    runId: "999",
    date: "2026-08-19",
    knownSuites: ["a.test.ts", "z.test.ts"],
  });

  assert.deepEqual(Object.keys(next.durations), ["a.test.ts", "z.test.ts"]);
  assert.equal(next.durations["z.test.ts"], 30, "an unmeasured but still-present suite keeps its duration");
});

test("a refresh prunes nothing when the suite set is empty or absent", () => {
  for (const knownSuites of [undefined, null, []]) {
    const next = mergeManifest({
      manifest: manifestFixture(),
      measured: { "a.test.ts": 12 },
      runId: "999",
      date: "2026-08-19",
      knownSuites,
    });

    assert.deepEqual(
      Object.keys(next.durations),
      ["a.test.ts", "z.test.ts"],
      `knownSuites=${JSON.stringify(knownSuites)} means a broken checkout, not a mass deletion`,
    );
  }
});

// The prune must not become a way to smuggle a new suite in without a
// measurement: knownSuites filters, it does not seed.
test("a refresh does not invent entries for on-disk suites that have no duration", () => {
  const next = mergeManifest({
    manifest: manifestFixture(),
    measured: { "a.test.ts": 12 },
    runId: "999",
    date: "2026-08-19",
    knownSuites: ["a.test.ts", "z.test.ts", "brand-new.test.ts"],
  });

  assert.deepEqual(Object.keys(next.durations), ["a.test.ts", "z.test.ts"]);
});

test("readShardMeasurements folds every shard artifact together and ignores non-JSON files", () => {  const files = { "shard-0.json": { "a.test.ts": 1 }, "shard-1.json": { "b.test.ts": 2 }, "README.md": null };

  const measured = readShardMeasurements("/tmp/shards", {
    readDir: () => Object.keys(files),
    readFile: (filePath) => JSON.stringify(files[path.basename(filePath)]),
  });

  assert.deepEqual(measured, { "a.test.ts": 1, "b.test.ts": 2 });
});

test("formatProvenanceComment points the reader at $notes for durable guidance", () => {
  const comment = formatProvenanceComment({ runId: "1", date: "2026-08-19", measuredCount: 4, totalCount: 10 });

  assert.ok(comment.includes("$notes"), "regenerated prose must point at the durable key");
});

// Guards the split itself: if someone folds the units note back into
// $comment, the weekly refresh silently starts deleting it again.
test("the real manifest keeps its durable guidance in $notes, not in the regenerated $comment", () => {
  const manifest = JSON.parse(readFileSync(durationsManifest, "utf8"));

  assert.ok(manifest["$notes"], "manifest must carry a $notes key");
  assert.ok(manifest["$notes"].includes("NOTE ON UNITS"), "the units note belongs in $notes");
  assert.ok(
    !manifest["$comment"].includes("NOTE ON UNITS"),
    "the units note must not live in $comment -- the weekly refresh regenerates that field",
  );
});
