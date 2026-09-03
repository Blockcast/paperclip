import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CANONICAL_INPUT_BYTES,
  CANONICAL_INPUT_SHA256,
  EXPECTED_OUTPUT_SHA256,
  MAX_SILENT_WINDOWS,
  boundBlockers,
  classifyAgentHealth,
  classifyRoutineRuns,
  compareIdentifier,
  currentWindowEnd,
  deriveRendererOutput,
  executeDetailWrite,
  planDetailShards,
  runComparatorCases,
  runDetailWriteFixture,
  runMandatoryFixtures,
  runPreflight,
  runSyntheticRendererFixture,
  sevenDayWindowKeys,
  sha256,
  stateForCount,
  truncateRow,
} from "./agent-health-preflight.mjs";

describe("agent-health v4 preflight", () => {
  it("passes every mandatory executable fixture", () => {
    const result = runMandatoryFixtures();
    assert.equal(result.version, 4);
    assert.equal(result.fixtures.length, 7);
    assert.equal(result.pass, true);
    assert.ok(result.fixtures.every((fixture) => fixture.status === "pass"));
  });

  it("censuses all 28 six-hour windows and distinguishes every run shape", () => {
    const windows = sevenDayWindowKeys();
    const rows = windows.map((windowKey, index) => ({
      windowKey,
      runId: `run-${index}`,
      status: "completed",
      commentId: `comment-${index}`,
      classification: "agent_in_error",
      fingerprint: `fingerprint-${index}`,
    }));
    rows[1].commentId = null;
    rows[1].classification = null;
    rows[2].runId = null;
    rows[2].commentId = "receipt-2";
    rows[2].classification = null;
    rows[3].coalescedIntoRunId = "run-0";
    rows[4].fingerprint = "duplicate-fingerprint";
    rows.push({ ...rows[4], runId: "duplicate-run", fingerprint: "duplicate-fingerprint" });
    rows[5].commentId = null;
    rows[5].classification = null;
    rows[5].status = "running";
    rows.splice(6, 1);
    const census = classifyRoutineRuns(rows);
    assert.equal(census.complete, true);
    assert.equal(census.slots.length, 28);
    assert.equal(census.counts["silent"], 1);
    assert.equal(census.counts["completed-without-comment"], 1);
    assert.equal(census.counts.runless, 1);
    assert.equal(census.counts.coalesced, 1);
    assert.equal(census.counts.duplicate, 1);
    assert.equal(census.counts["receipt-only"], 1);
    assert.equal(census.counts["classification-producing"], 22);
  });

  it("does not let the first row hide a later classification or run id", () => {
    const [windowKey] = sevenDayWindowKeys();
    const census = classifyRoutineRuns([
      { windowKey, status: "running", runId: null, classification: null, commentId: null },
      { windowKey, status: "succeeded", runId: "run-later", classification: "stalled_issue", commentId: "comment-later" },
    ]);
    assert.equal(census.slots[0].state, "classification-producing");
    assert.deepEqual(census.slots[0].runIds, ["run-later"]);
  });

  it("reports every candidate run id, so a duplicate slot does not name an arbitrary member", () => {
    const [windowKey] = sevenDayWindowKeys();
    const census = classifyRoutineRuns([
      { windowKey, runId: "run-a", status: "succeeded", commentId: "c-a", fingerprint: "same" },
      { windowKey, runId: "run-b", status: "succeeded", commentId: "c-b", fingerprint: "same" },
    ]);
    assert.equal(census.slots[0].state, "duplicate");
    assert.deepEqual(census.slots[0].runIds, ["run-a", "run-b"]);
  });

  it("reports rows that fall outside the expected window instead of dropping them", () => {
    const outside = "2026-07-01T06:00:00Z";
    const census = classifyRoutineRuns([
      { windowKey: outside, runId: "stray", status: "succeeded", commentId: "c", classification: "x" },
      { windowKey: sevenDayWindowKeys()[0], runId: "run-0", status: "succeeded", commentId: "c0", classification: "x" },
    ]);
    assert.deepEqual(census.outOfWindowKeys, [outside]);
    // A wrong census `end` used to hide every real run here while the empty
    // expected windows counted as `silent`, and `complete` stayed true. Note the
    // failure below is driven by the `silent` term, NOT by the out-of-window
    // rows — see the two isolating cases that follow.
    assert.equal(census.complete, false);
    assert.equal(census.counts.silent, 27);
  });

  // --- Regression: Ally finding #2 on PR #1571, head 6fab2547 -----------------
  // An out-of-range row is REPORTED, not failed: `unexpectedWindows.size === 0`
  // made a healthy census go red on input shape alone. Isolating, because every
  // pre-existing case that touched this term also carried >=27 silent windows,
  // so `complete: false` was over-determined and would have survived deleting it.
  it("does not fail a complete census merely because a row falls outside the window", () => {
    const healthy = sevenDayWindowKeys().map((windowKey, index) => ({
      windowKey,
      runId: `run-${index}`,
      status: "succeeded",
      commentId: `c-${index}`,
      classification: "x",
      fingerprint: `fp-${index}`,
    }));
    const baseline = classifyRoutineRuns(healthy);
    assert.equal(baseline.complete, true);
    assert.equal(baseline.counts.silent, 0);

    // The natural CLI input — a dump of the routine's runs, not a slice
    // pre-scoped to exactly the censused week.
    const census = classifyRoutineRuns([
      ...healthy,
      { windowKey: "2026-07-01T06:00:00Z", runId: "older", status: "succeeded", commentId: "c", classification: "x" },
    ]);
    assert.equal(census.complete, true, "an out-of-window row must not fail a 28/28 census");
    assert.deepEqual(census.outOfWindowKeys, ["2026-07-01T06:00:00Z"]);
    assert.equal(census.counts.silent, 0);
  });

  it("separates a key that is not a boundary from one that is merely out of range", () => {
    const census = classifyRoutineRuns([
      // A bucketing bug: cannot be placed on the six-hour grid at all.
      { windowKey: "not-a-window", runId: "unparseable" },
      // Also a bucketing bug: parses, but is not a six-hour boundary.
      { windowKey: "2026-08-31T07:00:00Z", runId: "off-grid" },
      // Not a bug: a good boundary, just not in this week.
      { windowKey: "2026-07-01T06:00:00Z", runId: "older" },
    ]);
    assert.deepEqual(census.malformedRows, [
      { runId: "unparseable", windowKey: "not-a-window" },
      { runId: "off-grid", windowKey: "2026-08-31T07:00:00Z" },
    ]);
    assert.deepEqual(census.outOfWindowKeys, ["2026-07-01T06:00:00Z"]);
    // Only the mis-bucketed rows fail the gate.
    assert.equal(census.complete, false);
  });

  it("normalizes a grid-aligned key in non-canonical form rather than rejecting it", () => {
    const [canonical] = sevenDayWindowKeys();
    const census = classifyRoutineRuns([
      { windowKey: canonical.replace(/Z$/, ".000Z"), runId: "run-0", status: "succeeded", commentId: "c0", classification: "x" },
    ]);
    assert.deepEqual(census.malformedRows, []);
    assert.deepEqual(census.outOfWindowKeys, []);
    assert.equal(census.slots[0].state, "classification-producing");
  });

  it("reports malformed rows instead of dropping them", () => {
    const rows = sevenDayWindowKeys().map((windowKey, index) => ({
      windowKey,
      runId: `run-${index}`,
      status: "succeeded",
      commentId: `c-${index}`,
      classification: "x",
      fingerprint: `fp-${index}`,
    }));
    rows.push({ windowKey: 123, runId: "malformed" });
    const census = classifyRoutineRuns(rows);
    assert.deepEqual(census.malformedRows, [{ runId: "malformed", windowKey: 123 }]);
    // Isolating: the other 28 windows are all covered, so the malformed row is
    // the only thing that can be failing this census.
    assert.equal(census.counts.silent, 0);
    assert.equal(census.complete, false);
  });

  it("keeps malformed and unrelated rows out of the classified slots, but still reports them", () => {
    const census = classifyRoutineRuns([
      { windowKey: "not-a-window", runId: "wrong", classification: "fake", commentId: "fake" },
      { windowKey: sevenDayWindowKeys()[0], runId: "run-0", status: "succeeded", fingerprint: "fp-0" },
    ]);
    // Neither row is silently absorbed into a slot...
    assert.equal(census.counts["completed-without-comment"], 1);
    assert.equal(census.counts["silent"], 27);
    // ...and a non-boundary key is a bucketing bug, so it lands in the failing
    // bucket the title names — not alongside merely-out-of-range boundaries.
    assert.deepEqual(census.malformedRows, [{ runId: "wrong", windowKey: "not-a-window" }]);
    assert.deepEqual(census.outOfWindowKeys, []);
    // ...and 27 of 28 windows unobserved is not a complete census.
    assert.equal(census.complete, false);
  });

  // --- Regression: Ally finding #1 on PR #1571 ---------------------------------
  it("does not let runless precedence mask a completed-without-comment slot", () => {
    const [windowKey] = sevenDayWindowKeys();
    const census = classifyRoutineRuns([
      { windowKey, status: "completed", runId: null, commentId: null, classification: null },
    ]);
    // Checking `runless` first would report "runless" and hide an emission-contract failure.
    assert.equal(census.slots[0].state, "completed-without-comment");
  });

  it("still reports runless when no terminal run produced the slot", () => {
    const [windowKey] = sevenDayWindowKeys();
    const census = classifyRoutineRuns([
      { windowKey, status: "queued", runId: null, commentId: "receipt", classification: null },
    ]);
    assert.equal(census.slots[0].state, "runless");
  });

  // --- Regression: Ally finding #2 on PR #1571, one branch up from #1 --------
  it("does not let duplicate or coalesced precedence mask a completed-without-comment slot", () => {
    const [windowKey] = sevenDayWindowKeys();
    const receiptless = { windowKey, status: "completed", runId: "r1", commentId: null, classification: null };

    const withCoalesced = classifyRoutineRuns([
      receiptless,
      { windowKey, runId: "r2", status: "succeeded", commentId: "c2", coalescedIntoRunId: "r9" },
    ]);
    assert.equal(withCoalesced.slots[0].state, "completed-without-comment");
    assert.equal(withCoalesced.counts["completed-without-comment"], 1);
    // The coalesced finding is not lost either — the compound records both.
    assert.ok(withCoalesced.slots[0].states.includes("coalesced"));

    const withDuplicate = classifyRoutineRuns([
      receiptless,
      { windowKey, runId: "r3", status: "succeeded", commentId: "c3", fingerprint: "same" },
      { windowKey, runId: "r4", status: "succeeded", commentId: "c4", fingerprint: "same" },
    ]);
    assert.equal(withDuplicate.slots[0].state, "completed-without-comment");
    assert.ok(withDuplicate.slots[0].states.includes("duplicate"));
  });

  // --- Regression: Ally finding #1 on PR #1571, head 6fab2547 -----------------
  // The same masking, one level further up: `counts` histogrammed only
  // `states[0]`, so a duplicate storm co-occurring with a receiptless terminal
  // run reported `counts.duplicate === 0` in the summary an operator reads.
  it("aggregates counts over every state of a compound slot, not just the primary", () => {
    const [windowKey] = sevenDayWindowKeys();
    const census = classifyRoutineRuns([
      { windowKey, runId: "r1", status: "completed", commentId: null, fingerprint: "same" },
      { windowKey, runId: "r2", status: "completed", commentId: "c2", fingerprint: "same" },
      { windowKey, runId: "r3", status: "completed", commentId: "c3", coalescedIntoRunId: "r2" },
    ]);
    assert.deepEqual(census.slots[0].states, ["completed-without-comment", "duplicate", "coalesced"]);
    assert.equal(census.slots[0].state, "completed-without-comment", "primary stays the highest-precedence finding");
    // Every secondary finding is visible in the aggregate, not just per-slot.
    assert.equal(census.counts["completed-without-comment"], 1);
    assert.equal(census.counts.duplicate, 1, "a duplicate storm must not vanish behind a receiptless run");
    assert.equal(census.counts.coalesced, 1);
  });

  it("counts a compound slot once per state, so the histogram over-counts windows by design", () => {
    const [windowKey] = sevenDayWindowKeys();
    const census = classifyRoutineRuns([
      { windowKey, runId: "r1", status: "completed", commentId: null, fingerprint: "same" },
      { windowKey, runId: "r2", status: "completed", commentId: "c2", fingerprint: "same" },
    ]);
    const total = Object.values(census.counts).reduce((sum, n) => sum + n, 0);
    assert.equal(total, 29, "28 windows, one of which is two things at once");
    // `silent` is the term the completeness gate reads, and a slot with no rows
    // carries exactly one state — so aggregating over `states` cannot move it.
    assert.equal(census.counts.silent, 27);
    assert.equal(census.observedWindows, 1);
  });

  it("still reports coalesced and duplicate when no receipt is missing", () => {
    const [windowKey] = sevenDayWindowKeys();
    const coalesced = classifyRoutineRuns([
      { windowKey, runId: "r1", status: "succeeded", commentId: "c1", coalescedIntoRunId: "r9" },
    ]);
    assert.equal(coalesced.slots[0].state, "coalesced");

    const duplicate = classifyRoutineRuns([
      { windowKey, runId: "r1", status: "succeeded", commentId: "c1", fingerprint: "same" },
      { windowKey, runId: "r2", status: "succeeded", commentId: "c2", fingerprint: "same" },
    ]);
    assert.equal(duplicate.slots[0].state, "duplicate");
  });
});

// --- Regression: Ally finding #3 on PR #1571 --------------------------------
describe("census completeness is derived from observed coverage, not from the key list", () => {
  const fullyCovered = (end) =>
    sevenDayWindowKeys(end).map((windowKey, index) => ({
      windowKey,
      runId: `run-${index}`,
      status: "succeeded",
      commentId: `c-${index}`,
      classification: "agent_in_error",
      fingerprint: `fp-${index}`,
    }));

  it("fails a total outage instead of reporting green", () => {
    const census = classifyRoutineRuns([]);
    assert.equal(census.counts.silent, 28);
    assert.equal(census.observedWindows, 0);
    // `classified.length === 28` restated its own construction and was always
    // true, so this exact condition — the outage the census exists to detect —
    // used to pass.
    assert.equal(census.complete, false);
  });

  it("fails the whole preflight on a total outage, so pass is not just fixtures.pass", () => {
    const result = runPreflight([]);
    assert.equal(result.fixtures.pass, true);
    assert.equal(result.census.complete, false);
    assert.equal(result.pass, false);
  });

  it("passes a fully covered census", () => {
    const census = classifyRoutineRuns(fullyCovered());
    assert.equal(census.observedWindows, 28);
    assert.equal(census.counts.silent, 0);
    assert.equal(census.complete, true);
  });

  it("holds the documented silent-window tolerance from both sides", () => {
    const atTolerance = fullyCovered().slice(MAX_SILENT_WINDOWS);
    const atCensus = classifyRoutineRuns(atTolerance);
    assert.equal(atCensus.counts.silent, MAX_SILENT_WINDOWS);
    assert.equal(atCensus.complete, true);

    const overTolerance = fullyCovered().slice(MAX_SILENT_WINDOWS + 1);
    const overCensus = classifyRoutineRuns(overTolerance);
    assert.equal(overCensus.counts.silent, MAX_SILENT_WINDOWS + 1);
    assert.equal(overCensus.complete, false);
  });

  it("snaps the executable census end to the six-hour boundary rather than a pinned past date", () => {
    assert.equal(currentWindowEnd(Date.parse("2026-09-02T17:59:59.999Z")), "2026-09-02T12:00:00Z");
    assert.equal(currentWindowEnd(Date.parse("2026-09-02T18:00:00.000Z")), "2026-09-02T18:00:00Z");
    assert.throws(() => currentWindowEnd("not-a-date"), /invalid census now/);

    // The pinned fixture default is kept for determinism, and is exactly what
    // the executable path must not inherit: run today it censuses a window
    // already two days past.
    assert.equal(sevenDayWindowKeys().at(-1), "2026-08-31T06:00:00Z");
    const today = currentWindowEnd(Date.parse("2026-09-02T18:00:00.000Z"));
    assert.equal(sevenDayWindowKeys(today).at(-1), today);

    // A run in today's window is counted against today's census, not dropped.
    const census = classifyRoutineRuns(fullyCovered(today), today);
    assert.equal(census.complete, true);
    assert.equal(census.counts["classification-producing"], 28);
  });
});

describe("synthetic renderer fixture is a real derivation, not a restated literal", () => {
  it("matches the persisted canonical-input and transformed-output hashes", () => {
    assert.equal(sha256(CANONICAL_INPUT_BYTES), CANONICAL_INPUT_SHA256);
    const result = runSyntheticRendererFixture();
    assert.equal(result.status, "pass");
    assert.equal(result.outputHash, EXPECTED_OUTPUT_SHA256);
  });

  it("derives the documented roots, reaches, solo yields and frees", () => {
    const derived = deriveRendererOutput(JSON.parse(CANONICAL_INPUT_BYTES));
    const [line] = derived.componentLines;
    assert.deepEqual(line.printedRoots, ["r2", "r3", "r1"]);
    assert.equal(line.rootCount, "3 of 4");
    assert.deepEqual(line.reaches, [2, 2, 1]);
    // Per-root and independent — NOT the component-line frees value.
    assert.deepEqual(line.soloClearYield, [1, 2, 0]);
    assert.equal(line.frees, 4);
    assert.notEqual(line.frees, line.soloClearYield[0]);
    assert.deepEqual(derived.states, ["empty", "small", "small", "medium", "medium", "large"]);
  });

  // Mutation tests: a wrong derivation MUST break the hash. Without these the
  // fixture could be satisfied by hardcoding the expected object.
  it("fails the output hash when solo yield is confused with frees", () => {
    const derived = deriveRendererOutput(JSON.parse(CANONICAL_INPUT_BYTES));
    derived.componentLines[0].soloClearYield = [4, 4, 4];
    assert.notEqual(sha256(`${JSON.stringify(derived)}\n`), EXPECTED_OUTPUT_SHA256);
  });

  it("fails the output hash when roots are ordered by identifier instead of reaches", () => {
    const derived = deriveRendererOutput(JSON.parse(CANONICAL_INPUT_BYTES));
    derived.componentLines[0].printedRoots = ["r1", "r2", "r3"];
    assert.notEqual(sha256(`${JSON.stringify(derived)}\n`), EXPECTED_OUTPUT_SHA256);
  });

  it("fails the output hash when a state boundary is off by one", () => {
    const derived = deriveRendererOutput(JSON.parse(CANONICAL_INPUT_BYTES));
    derived.states[3] = "small";
    assert.notEqual(sha256(`${JSON.stringify(derived)}\n`), EXPECTED_OUTPUT_SHA256);
  });

  it("pins the exact state boundaries 0 / 1-10 / 11-40 / 41+", () => {
    assert.equal(stateForCount(0), "empty");
    assert.equal(stateForCount(1), "small");
    assert.equal(stateForCount(10), "small");
    assert.equal(stateForCount(11), "medium");
    assert.equal(stateForCount(40), "medium");
    assert.equal(stateForCount(41), "large");
  });
});

describe("constructed comparator cases", () => {
  it("orders identifiers numerically, not as raw strings", () => {
    assert.ok(compareIdentifier("BLO-9812", "BLO-13238") < 0);
    // The discriminating failure: raw string ordering gives the opposite.
    assert.ok("BLO-9812" > "BLO-13238");
  });

  it("breaks a yield tie by min(K), not by first displayed root", () => {
    const result = runComparatorCases();
    assert.equal(result.status, "pass");
    assert.equal(result.order, "A,B");
    assert.equal(result.discriminatedAlternative, "B,A");
  });
});

describe("§8d bounded shard contract", () => {
  const rows312 = Array.from({ length: 312 }, (_, index) => `SYN-${1001 + index}`);

  it("plans exactly three head-first shards of 120/120/72", () => {
    const { plan } = planDetailShards(rows312);
    assert.equal(plan.length, 3);
    assert.deepEqual(plan.map((shard) => shard.key), [
      "agent-health-detail",
      "agent-health-detail-p01",
      "agent-health-detail-p02",
    ]);
    assert.deepEqual(plan.map((shard) => shard.rowCount), [120, 120, 72]);
    assert.equal(plan[2].range, "SYN-1241–SYN-1312");
  });

  it("branch A writes every identifier exactly once with no degradation line", () => {
    const result = executeDetailWrite(rows312);
    assert.equal(result.detailWriteOutcome, "complete");
    assert.equal(result.detailFailureCode, null);
    assert.equal(result.detailMaterialisedRowCount, 312);
    assert.equal(result.detailUnmaterialisedRowCount, 0);
    assert.equal(result.renderingIntegrityLine, null);
    assert.equal(result.receiptEmitted, true);
  });

  it("branch B stops at the shard boundary and discloses the exact tail", () => {
    const result = executeDetailWrite(rows312, { reserveTripsBeforeShard: 3 });
    assert.equal(result.detailWriteOutcome, "partial");
    assert.equal(result.detailFailureCode, "detail_write_partial_receipt_reserve");
    assert.equal(result.detailMaterialisedRowCount, 240);
    assert.equal(result.detailUnmaterialisedRowCount, 72);
    assert.equal(result.detailUnmaterialisedRowIds[0], "SYN-1241");
    assert.equal(result.detailUnmaterialisedRowIds.at(-1), "SYN-1312");
    // The head shard must be written so §8e can link it.
    assert.equal(result.detailDocumentKey, "agent-health-detail");
    assert.equal(
      result.renderingIntegrityLine,
      "**Rendering degraded — detail_write_partial_receipt_reserve: 240 of 312 P3/informational rows materialised, 72 unreachable.**",
    );
    assert.equal(result.conserved, true);
    assert.equal(result.receiptEmitted, true);
  });

  it("branch C writes nothing but stays discriminable from not_required", () => {
    const result = executeDetailWrite(rows312, { reserveTripsBeforeShard: 1 });
    assert.equal(result.detailWriteOutcome, "skipped");
    assert.equal(result.detailFailureCode, "detail_write_skipped_no_budget");
    assert.deepEqual(result.detailShardKeys, []);
    assert.equal(result.detailDocumentKey, null);
    assert.equal(result.detailRevisionId, null);
    assert.notEqual(result.detailFailureCode, "detail_not_required");
    assert.notEqual(result.detailFailureCode, "detail_write_fallback_inline");
    assert.equal(result.detailUnmaterialisedRowCount, 312);
    // The 2026-08-19T18:00Z defect: the receipt must survive.
    assert.equal(result.receiptEmitted, true);
  });

  it("branch D caps at five shards and names the unmaterialised tail", () => {
    const rows700 = Array.from({ length: 700 }, (_, index) => `SYN-${2001 + index}`);
    const result = executeDetailWrite(rows700);
    assert.equal(result.detailWriteOutcome, "partial");
    assert.equal(result.detailFailureCode, "detail_write_partial_shard_cap");
    assert.equal(result.detailMaterialisedRowCount, 600);
    assert.equal(result.detailUnmaterialisedRowCount, 100);
    assert.equal(result.detailUnmaterialisedRowIds[0], "SYN-2601");
    assert.equal(result.detailUnmaterialisedRowIds.at(-1), "SYN-2700");
  });

  it("never records not_required at large state", () => {
    for (const options of [{}, { reserveTripsBeforeShard: 3 }, { reserveTripsBeforeShard: 1 }]) {
      assert.notEqual(executeDetailWrite(rows312, options).detailWriteOutcome, "not_required");
    }
  });

  it("bounds blockers per row and elides an over-long row at a field boundary", () => {
    const rendered = boundBlockers(Array.from({ length: 11 }, (_, i) => `BLO-${i + 1}`));
    assert.ok(rendered.endsWith("+5 more"));
    assert.equal(rendered.split(",").length, 6);
    const long = truncateRow(`${"A".repeat(200)} · ${"B".repeat(100)}`);
    assert.equal(long.elided, true);
    assert.ok(long.text.endsWith("… (elided)"));
    assert.ok(truncateRow("short row").elided === false);
  });

  it("runs all four documented branches green", () => {
    const result = runDetailWriteFixture();
    assert.equal(result.status, "pass", result.checks.filter((c) => !c.ok).map((c) => c.name).join("; "));
  });
});

describe("agent-health classification seam", () => {
  const base = {
    status: "error",
    errorReason: null,
    runtimeConfig: { heartbeat: { enabled: false } },
    openIssues: [{ identifier: "BLO-1", priority: "high" }],
    runs: ["cancelled", "failed", "scheduled_retry", "scheduled_retry", "failed"],
  };

  it("keeps status:error visible behind interleaved retry and cancellation rows", () => {
    const result = classifyAgentHealth(base);
    assert.ok(result.rows.includes("agent_in_error"));
    assert.ok(result.rows.includes("agent_heartbeat_disabled_with_work"));
    assert.equal(result.cause, "cause unavailable — see run list");
    assert.equal(result.threeConsecutiveFailures, false);
    assert.equal(result.selectedFailingRun, "failed");
  });

  it("drops only the status row when the agent reads running", () => {
    const result = classifyAgentHealth({ ...base, status: "running" });
    assert.ok(!result.rows.includes("agent_in_error"));
    assert.ok(result.rows.includes("agent_heartbeat_disabled_with_work"));
  });

  it("emits agent_in_error from three consecutive failures even while running", () => {
    const result = classifyAgentHealth({
      ...base,
      status: "running",
      runs: ["failed", "adapter_failed", "error", "cancelled"],
    });
    assert.equal(result.threeConsecutiveFailures, true);
    assert.ok(result.rows.includes("agent_in_error"));
  });

  it("treats missing heartbeat config as different from explicit false", () => {
    const result = classifyAgentHealth({ ...base, runtimeConfig: { heartbeat: {} } });
    assert.ok(!result.rows.includes("agent_heartbeat_disabled_with_work"));
  });

  it("does not raise heartbeat-disabled without verified open work", () => {
    const result = classifyAgentHealth({ ...base, openIssues: [] });
    assert.ok(!result.rows.includes("agent_heartbeat_disabled_with_work"));
  });

  it("alerts on non-manual pause only", () => {
    assert.ok(classifyAgentHealth({ ...base, status: "paused", pauseReason: "budget" }).rows
      .includes("agent_paused_non_manual"));
    assert.ok(!classifyAgentHealth({ ...base, status: "paused", pauseReason: "manual" }).rows
      .includes("agent_paused_non_manual"));
    assert.ok(!classifyAgentHealth({ ...base, status: "paused", pauseReason: null }).rows
      .includes("agent_paused_non_manual"));
  });

  it("renders a present cause verbatim instead of the unavailable placeholder", () => {
    assert.equal(classifyAgentHealth({ ...base, errorReason: "rate_limit_exhausted" }).cause,
      "rate_limit_exhausted");
    assert.equal(classifyAgentHealth({ ...base, errorReason: "   " }).cause,
      "cause unavailable — see run list");
  });
});
