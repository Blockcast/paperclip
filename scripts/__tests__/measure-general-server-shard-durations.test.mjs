import assert from "node:assert/strict";
import test from "node:test";

import {
  mergeDurations,
  parseVitestJsonReport,
  selectTargetFiles,
} from "../measure-general-server-shard-durations.mjs";

test("selectTargetFiles defaults to only the suites missing from the manifest", () => {
  const allFiles = ["a.test.ts", "b.test.ts", "c.test.ts"];
  // Mixed fixture on purpose: a.test.ts is already measured, so the default
  // mode must skip it. Seeding every key as missing would assert the same
  // result as the --all case below and would still pass with the filter
  // deleted, proving nothing about the filter.
  const durations = { "a.test.ts": 10 };

  const target = selectTargetFiles({ allFiles, durations, all: false, shardIndex: null, shardCount: null });

  assert.deepEqual(target, ["b.test.ts", "c.test.ts"]);
});

test("selectTargetFiles defaults to an empty list when the manifest already covers every suite", () => {
  const allFiles = ["a.test.ts", "b.test.ts"];
  const durations = { "a.test.ts": 10, "b.test.ts": 20 };

  const target = selectTargetFiles({ allFiles, durations, all: false, shardIndex: null, shardCount: null });

  assert.deepEqual(target, [], "a fully covered manifest must leave nothing to measure");
});

test("selectTargetFiles treats a zero-millisecond entry as measured, not missing", () => {
  const allFiles = ["a.test.ts", "b.test.ts"];
  const durations = { "a.test.ts": 0 };

  const target = selectTargetFiles({ allFiles, durations, all: false, shardIndex: null, shardCount: null });

  assert.deepEqual(target, ["b.test.ts"], "0 is a real measurement and must not re-measure");
});

test("selectTargetFiles --all re-measures every suite regardless of manifest state", () => {
  const allFiles = ["b.test.ts", "a.test.ts"];
  const durations = { "a.test.ts": 10, "b.test.ts": 20 };

  const target = selectTargetFiles({ allFiles, durations, all: true, shardIndex: null, shardCount: null });

  assert.deepEqual(target, ["a.test.ts", "b.test.ts"]);
});

test("selectTargetFiles slices the target list across shard-index/shard-count", () => {
  const allFiles = ["a.test.ts", "b.test.ts", "c.test.ts", "d.test.ts"];
  const durations = {};

  const shard0 = selectTargetFiles({ allFiles, durations, all: true, shardIndex: 0, shardCount: 2 });
  const shard1 = selectTargetFiles({ allFiles, durations, all: true, shardIndex: 1, shardCount: 2 });

  assert.deepEqual([...shard0, ...shard1].sort(), [...allFiles].sort());
  assert.deepEqual(shard0.filter((file) => shard1.includes(file)), [], "shards must not overlap");
});

test("parseVitestJsonReport rebases absolute test file paths onto repo-relative keys", () => {
  const report = {
    testResults: [
      {
        name: "/repo/server/src/__tests__/a.test.ts",
        startTime: 1000,
        endTime: 1250,
        status: "passed",
        assertionResults: [{ status: "passed" }],
      },
      {
        name: "/repo/server/src/__tests__/b.test.ts",
        startTime: 2000,
        endTime: 2000.7,
        status: "passed",
        assertionResults: [{ status: "passed" }],
      },
    ],
  };

  const measured = parseVitestJsonReport(JSON.stringify(report), "/repo");

  assert.deepEqual(measured, {
    "server/src/__tests__/a.test.ts": 250,
    "server/src/__tests__/b.test.ts": 1,
  });
});

// A failing suite still ran, so its span is a real cost the partition should
// carry. Only a suite that never executed is excluded below.
test("parseVitestJsonReport keeps a failed suite's duration", () => {
  const report = {
    testResults: [
      {
        name: "/repo/server/src/__tests__/a.test.ts",
        startTime: 1000,
        endTime: 4000,
        status: "failed",
        assertionResults: [{ status: "failed" }],
      },
    ],
  };

  const measured = parseVitestJsonReport(JSON.stringify(report), "/repo");

  assert.deepEqual(measured, { "server/src/__tests__/a.test.ts": 3000 });
});

// The regression: a collection error yields no tests and a ~0 span, and
// because vitest folds test results to derive file status it reports `passed`.
// Recorded as-is, the suite would carry a near-zero partition weight for a week.
test("parseVitestJsonReport drops a suite that collected no tests", () => {
  const report = {
    testResults: [
      {
        name: "/repo/server/src/__tests__/broken.test.ts",
        startTime: 5000,
        endTime: 5000,
        status: "passed",
        assertionResults: [],
      },
      {
        name: "/repo/server/src/__tests__/ok.test.ts",
        startTime: 6000,
        endTime: 6800,
        status: "passed",
        assertionResults: [{ status: "passed" }],
      },
    ],
  };

  const measured = parseVitestJsonReport(JSON.stringify(report), "/repo");

  assert.deepEqual(
    measured,
    { "server/src/__tests__/ok.test.ts": 800 },
    "a suite that ran nothing must not be recorded as a 0ms measurement",
  );
});

test("parseVitestJsonReport drops a suite whose reported status is neither passed nor failed", () => {
  const report = {
    testResults: [
      {
        name: "/repo/server/src/__tests__/skipped.test.ts",
        startTime: 1000,
        endTime: 1005,
        status: "skipped",
        assertionResults: [{ status: "skipped" }],
      },
    ],
  };

  const measured = parseVitestJsonReport(JSON.stringify(report), "/repo");

  assert.deepEqual(measured, {}, "an unrecognised file status is not a measurement");
});

// The guard must key off positive evidence of a non-run. If a reporter upgrade
// drops these fields, recording the span is the correct fallback -- a guard
// that quietly emptied the manifest would be worse than the bug it closes.
test("parseVitestJsonReport still records entries when the reporter omits status metadata", () => {
  const report = {
    testResults: [{ name: "/repo/server/src/__tests__/a.test.ts", startTime: 1000, endTime: 1250 }],
  };

  const measured = parseVitestJsonReport(JSON.stringify(report), "/repo");

  assert.deepEqual(measured, { "server/src/__tests__/a.test.ts": 250 });
});

test("mergeDurations overwrites existing entries with fresh measurements and keeps keys sorted", () => {
  const existing = { "z.test.ts": 100, "a.test.ts": 50 };
  const measured = { "a.test.ts": 75, "m.test.ts": 10 };

  const merged = mergeDurations(existing, measured);

  assert.deepEqual(Object.keys(merged), ["a.test.ts", "m.test.ts", "z.test.ts"]);
  assert.equal(merged["a.test.ts"], 75, "a fresh measurement must win over the stale entry");
  assert.equal(merged["z.test.ts"], 100, "an un-remeasured suite keeps its prior duration");
});
