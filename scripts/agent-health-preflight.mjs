#!/usr/bin/env node

/**
 * Executable contract for the six-hour agent-health routine (BLO-30936).
 *
 * Every fixture here derives its result from input it is given and compares
 * against a value it cannot reach by restating a literal — the synthetic
 * renderer fixture compares SHA-256 of serialized output bytes, the detail
 * shard fixtures compare exact identifier ranges, and the comparator cases
 * assert orderings that a naive implementation gets wrong. A tautological
 * assertion (`"error" === "error"`, `assigned + (n - assigned) === n`) cannot
 * fail and therefore proves nothing; none are used.
 *
 * Source of truth for the expected values: document `agent-health-renderer-fixture-v1`
 * (revision 4) on BLO-3202.
 */

import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

export const V4_FIXTURE_MANIFEST = Object.freeze([
  "agent_health_status_overrides_interleaved_runs",
  "population_conservation_large_state",
  "superseded_fingerprint",
  "human_review_gate",
  "terminal_blocker",
  "cap_raise_july_backtest",
  "large_state_detail_write_312_rows",
]);

const REQUIRED_STATES = [
  "classification-producing",
  "receipt-only",
  "silent",
  "duplicate",
  "runless",
  "coalesced",
  "completed-without-comment",
];

export const DETAIL_ROWS_PER_SHARD = 120;
export const DETAIL_MAX_SHARDS = 5;
export const DETAIL_MAX_ROW_CHARS = 240;
export const DETAIL_MAX_BLOCKERS_PER_ROW = 6;

// Exact UTF-8 bytes from the fixture document, one trailing LF, no BOM.
export const CANONICAL_INPUT_BYTES =
  '{"components":[{"componentKey":"c1","roots":["r1","r2","r3","r4"],"rows":[{"id":"x1","blockers":["r1","r2"]},{"id":"x2","blockers":["r2"]},{"id":"x3","blockers":["r3"]},{"id":"x4","blockers":["r3"]},{"id":"x5","blockers":["r4"]}]}],"stateBoundaryCounts":[0,1,10,11,40,41]}\n';
export const CANONICAL_INPUT_SHA256 =
  "12f50b8169555d128927a068b0832228c296e7fa581c929a161ec3f185915f79";
export const EXPECTED_OUTPUT_SHA256 =
  "c2e9b12ccd27fb508e2c749e5449d35c36af59acc9a848023157248b957addc2";

export function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function fixture(name, passed, detail) {
  return { name, status: passed ? "pass" : "fail", detail };
}

/**
 * Compare identifiers as (prefix ASCII, numeric suffix as integer).
 * Raw string ordering puts BLO-13238 before BLO-9812; this must not.
 */
export function compareIdentifier(a, b) {
  const parse = (value) => {
    const match = /^([A-Za-z]+)-(\d+)$/.exec(value);
    return match ? { prefix: match[1], number: Number(match[2]) } : { prefix: value, number: null };
  };
  const left = parse(a);
  const right = parse(b);
  if (left.prefix !== right.prefix) return left.prefix < right.prefix ? -1 : 1;
  if (left.number == null || right.number == null) {
    if (a === b) return 0;
    return a < b ? -1 : 1;
  }
  return left.number - right.number;
}

/** Rows released by clearing `cleared`, including the completion cascade. */
function releasedRows(cleared, rows) {
  const done = new Set(cleared);
  const released = new Set();
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const row of rows) {
      if (released.has(row.id)) continue;
      if (row.blockers.every((blocker) => done.has(blocker))) {
        released.add(row.id);
        done.add(row.id);
        progressed = true;
      }
    }
  }
  return released;
}

/** Blocker -> blocked-row adjacency. A property of `rows`, not of any root. */
function buildAdjacency(rows) {
  const adjacency = new Map();
  for (const row of rows) {
    for (const blocker of row.blockers) {
      if (!adjacency.has(blocker)) adjacency.set(blocker, []);
      adjacency.get(blocker).push(row.id);
    }
  }
  return adjacency;
}

/** Transitive count of distinct rows reachable from a root. */
function transitiveReaches(root, adjacency) {
  const seen = new Set();
  const queue = [root];
  while (queue.length > 0) {
    const node = queue.shift();
    for (const next of adjacency.get(node) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen.size;
}

export function stateForCount(count) {
  if (count === 0) return "empty";
  if (count <= 10) return "small";
  if (count <= 40) return "medium";
  return "large";
}

/** Real derivation: canonical input object -> transformed output object. */
export function deriveRendererOutput(input) {
  const componentLines = input.components.map((component) => {
    const rows = component.rows;
    const adjacency = buildAdjacency(rows);
    const ranked = component.roots
      .map((root) => ({ root, reaches: transitiveReaches(root, adjacency) }))
      .sort((a, b) => b.reaches - a.reaches || compareIdentifier(a.root, b.root));
    const printed = ranked.slice(0, 3);
    const printedRoots = printed.map((entry) => entry.root);
    return {
      componentKey: component.componentKey,
      printedRoots,
      rootCount: `${printedRoots.length} of ${component.roots.length}`,
      reaches: printed.map((entry) => entry.reaches),
      // Independent per root, while every OTHER open root remains.
      soloClearYield: printedRoots.map((root) => releasedRows([root], rows).size),
      // Display label over exactly the printed root set.
      frees: releasedRows(printedRoots, rows).size,
    };
  });
  return {
    componentLines,
    states: input.stateBoundaryCounts.map(stateForCount),
  };
}

export function runSyntheticRendererFixture() {
  const inputHash = sha256(CANONICAL_INPUT_BYTES);
  if (inputHash !== CANONICAL_INPUT_SHA256) {
    return {
      status: "fail",
      failureCode: "renderer_fixture_canonical_input_sha256_mismatch",
      detail: `canonical input sha256 ${inputHash} != ${CANONICAL_INPUT_SHA256}`,
    };
  }
  const derived = deriveRendererOutput(JSON.parse(CANONICAL_INPUT_BYTES));
  const serialized = `${JSON.stringify(derived)}\n`;
  const outputHash = sha256(serialized);
  if (outputHash !== EXPECTED_OUTPUT_SHA256) {
    return {
      status: "fail",
      failureCode: "renderer_fixture_transformed_bytes_mismatch",
      detail: `transformed sha256 ${outputHash} != ${EXPECTED_OUTPUT_SHA256}`,
      serialized,
    };
  }
  return { status: "pass", inputHash, outputHash, derived };
}

/**
 * Constructed comparator cases. Mandatory even when the historical population
 * happens to order correctly under a wrong comparator.
 */
export function runComparatorCases() {
  const identifierCase = compareIdentifier("BLO-9812", "BLO-13238") < 0;

  const components = [
    { key: "A", rows: 4, K: ["BLO-20", "BLO-30"], reaches: { "BLO-30": 3, "BLO-20": 1 } },
    { key: "B", rows: 4, K: ["BLO-25", "BLO-40"], reaches: { "BLO-25": 3, "BLO-40": 1 } },
  ];
  const ranked = [...components].sort((a, b) => {
    const yieldA = a.rows / a.K.length;
    const yieldB = b.rows / b.K.length;
    if (yieldA !== yieldB) return yieldB - yieldA;
    if (a.rows !== b.rows) return b.rows - a.rows;
    const minA = [...a.K].sort(compareIdentifier)[0];
    const minB = [...b.K].sort(compareIdentifier)[0];
    return compareIdentifier(minA, minB);
  });
  const order = ranked.map((component) => component.key).join(",");

  // Sorting the tie by first displayed root would give B,A — that must not happen.
  const firstDisplayedRoot = (component) =>
    [...component.K].sort((a, b) => component.reaches[b] - component.reaches[a] || compareIdentifier(a, b))[0];
  const wrongOrder = [...components]
    .sort((a, b) => compareIdentifier(firstDisplayedRoot(a), firstDisplayedRoot(b)))
    .map((component) => component.key)
    .join(",");

  return {
    status: identifierCase && order === "A,B" && wrongOrder === "B,A" ? "pass" : "fail",
    identifierCase,
    order,
    discriminatedAlternative: wrongOrder,
  };
}

/** §8d shard planner: head key first, then p01..p(N-1), tail-truncating. */
export function planDetailShards(rowIds, { rowsPerShard = DETAIL_ROWS_PER_SHARD, maxShards = DETAIL_MAX_SHARDS } = {}) {
  const plan = [];
  for (let index = 0; index * rowsPerShard < rowIds.length; index += 1) {
    const slice = rowIds.slice(index * rowsPerShard, (index + 1) * rowsPerShard);
    plan.push({
      key: index === 0 ? "agent-health-detail" : `agent-health-detail-p${String(index).padStart(2, "0")}`,
      rowCount: slice.length,
      rows: slice,
      range: `${slice[0]}–${slice[slice.length - 1]}`,
    });
  }
  const capped = plan.slice(0, maxShards);
  return { plan: capped, cappedOut: plan.slice(maxShards), plannedShardCount: plan.length };
}

/**
 * §8d execution. `reserveTripsBeforeShard` is a 1-based shard ordinal; the run
 * stops AT that boundary and never mid-body. The receipt is emitted in every
 * branch — that is the invariant the 2026-08-19T18:00Z window violated.
 */
export function executeDetailWrite(rowIds, { reserveTripsBeforeShard = null, state = "large" } = {}) {
  const { plan, cappedOut, plannedShardCount } = planDetailShards(rowIds);
  const written = [];
  let stopped = false;
  for (let index = 0; index < plan.length; index += 1) {
    if (reserveTripsBeforeShard != null && index + 1 >= reserveTripsBeforeShard) {
      stopped = true;
      break;
    }
    written.push(plan[index]);
  }

  const materialised = written.flatMap((shard) => shard.rows);
  const materialisedSet = new Set(materialised);
  const unmaterialised = rowIds.filter((id) => !materialisedSet.has(id));

  let outcome;
  let failureCode;
  if (stopped && written.length === 0) {
    outcome = "skipped";
    failureCode = "detail_write_skipped_no_budget";
  } else if (stopped) {
    outcome = "partial";
    failureCode = "detail_write_partial_receipt_reserve";
  } else if (cappedOut.length > 0) {
    outcome = "partial";
    failureCode = "detail_write_partial_shard_cap";
  } else {
    outcome = "complete";
    failureCode = null;
  }

  const headWroteCleanly = written.some((shard) => shard.key === "agent-health-detail");
  const degraded = outcome !== "complete" && outcome !== "not_required";
  return {
    state,
    detailShardPlan: plan.map(({ key, rowCount, range }) => ({ key, rowCount, range })),
    plannedShardCount,
    detailShardKeys: written.map((shard) => shard.key),
    detailWriteOutcome: outcome,
    detailFailureCode: failureCode,
    detailMaterialisedRowCount: materialised.length,
    detailUnmaterialisedRowCount: unmaterialised.length,
    detailUnmaterialisedRowIds: unmaterialised,
    detailDocumentKey: headWroteCleanly ? "agent-health-detail" : null,
    detailRevisionId: headWroteCleanly ? `rev-${written.length}` : null,
    renderingIntegrityLine: degraded
      ? `**Rendering degraded — ${failureCode}: ${materialised.length} of ${rowIds.length} P3/informational rows materialised, ${unmaterialised.length} unreachable.**`
      : null,
    receiptEmitted: true,
    conserved: materialised.length + unmaterialised.length === rowIds.length
      && materialised.every((id) => !unmaterialised.includes(id)),
  };
}

export function boundBlockers(blockers, max = DETAIL_MAX_BLOCKERS_PER_ROW) {
  if (blockers.length <= max) return blockers.join(", ");
  return `${blockers.slice(0, max).join(", ")} +${blockers.length - max} more`;
}

export function truncateRow(text, max = DETAIL_MAX_ROW_CHARS) {
  if (text.length <= max) return { text, elided: false };
  const cut = text.lastIndexOf(" · ", max);
  const boundary = cut > 0 ? cut : max;
  return { text: `${text.slice(0, boundary)} … (elided)`, elided: true };
}

export function runDetailWriteFixture() {
  const rows312 = Array.from({ length: 312 }, (_, index) => `SYN-${1001 + index}`);
  const rows700 = Array.from({ length: 700 }, (_, index) => `SYN-${2001 + index}`);
  const checks = [];
  const check = (name, condition, detail) => checks.push({ name, ok: Boolean(condition), detail });

  const { plan } = planDetailShards(rows312);
  check("plan is head-first 120/120/72", plan.length === 3
    && plan[0].key === "agent-health-detail" && plan[0].rowCount === 120
    && plan[1].key === "agent-health-detail-p01" && plan[1].rowCount === 120
    && plan[2].key === "agent-health-detail-p02" && plan[2].rowCount === 72,
    plan.map((shard) => `${shard.key}:${shard.rowCount}`).join(" "));

  const a = executeDetailWrite(rows312);
  const seen = a.detailShardPlan.length > 0 ? plan.flatMap((shard) => shard.rows) : [];
  check("A: complete, no failure code", a.detailWriteOutcome === "complete" && a.detailFailureCode === null);
  check("A: every id exactly once", new Set(seen).size === 312 && seen.length === 312);
  check("A: 312 materialised, 0 unreachable",
    a.detailMaterialisedRowCount === 312 && a.detailUnmaterialisedRowCount === 0);
  check("A: no rendering-integrity line", a.renderingIntegrityLine === null);
  check("A: receipt emitted", a.receiptEmitted === true);

  const b = executeDetailWrite(rows312, { reserveTripsBeforeShard: 3 });
  check("B: partial/receipt_reserve", b.detailWriteOutcome === "partial"
    && b.detailFailureCode === "detail_write_partial_receipt_reserve");
  check("B: stops at boundary, 240/72", b.detailMaterialisedRowCount === 240
    && b.detailUnmaterialisedRowCount === 72);
  check("B: unmaterialised tail is SYN-1241..SYN-1312",
    b.detailUnmaterialisedRowIds[0] === "SYN-1241"
    && b.detailUnmaterialisedRowIds.at(-1) === "SYN-1312"
    && b.detailUnmaterialisedRowIds.length === 72);
  check("B: head shard written and linkable", b.detailDocumentKey === "agent-health-detail");
  check("B: exact §8e item-4 line", b.renderingIntegrityLine
    === "**Rendering degraded — detail_write_partial_receipt_reserve: 240 of 312 P3/informational rows materialised, 72 unreachable.**");
  check("B: conservation identity holds", b.conserved === true);
  check("B: receipt emitted", b.receiptEmitted === true);

  const c = executeDetailWrite(rows312, { reserveTripsBeforeShard: 1 });
  check("C: skipped/no_budget, nothing written", c.detailWriteOutcome === "skipped"
    && c.detailFailureCode === "detail_write_skipped_no_budget"
    && c.detailShardKeys.length === 0);
  check("C: 0 materialised, 312 unreachable",
    c.detailMaterialisedRowCount === 0 && c.detailUnmaterialisedRowCount === 312);
  check("C: null key/revision but discriminating failure code",
    c.detailDocumentKey === null && c.detailRevisionId === null
    && c.detailFailureCode !== "detail_not_required"
    && c.detailFailureCode !== "detail_write_fallback_inline");
  check("C: receipt emitted", c.receiptEmitted === true);

  const d = executeDetailWrite(rows700);
  check("D: partial/shard_cap 600/100", d.detailWriteOutcome === "partial"
    && d.detailFailureCode === "detail_write_partial_shard_cap"
    && d.detailMaterialisedRowCount === 600 && d.detailUnmaterialisedRowCount === 100);
  check("D: unmaterialised tail is SYN-2601..SYN-2700",
    d.detailUnmaterialisedRowIds[0] === "SYN-2601" && d.detailUnmaterialisedRowIds.at(-1) === "SYN-2700");

  check("row bound: 11 blockers render 6 + '+5 more'",
    boundBlockers(Array.from({ length: 11 }, (_, i) => `B-${i + 1}`)).endsWith("+5 more"));
  check("row bound: over-long row elided at a field boundary",
    truncateRow(`${"A".repeat(200)} · ${"B".repeat(100)}`).elided === true);

  check("large state never records not_required", a.detailWriteOutcome !== "not_required");

  return { status: checks.every((entry) => entry.ok) ? "pass" : "fail", checks };
}

export function runMandatoryFixtures() {
  const fixtures = [];

  // 1. status:error survives interleaved cancelled/scheduled_retry rows, and the
  //    three-consecutive predicate is independently false on the same input.
  const interleavedAgent = {
    id: "fixture-agent",
    status: "error",
    errorReason: null,
    runtimeConfig: { heartbeat: { enabled: false } },
    openIssues: [{ identifier: "BLO-1", priority: "high" }],
    runs: ["cancelled", "failed", "scheduled_retry", "scheduled_retry", "failed"],
  };
  const interleaved = classifyAgentHealth(interleavedAgent);
  // Discriminator: the same agent reading `running` must lose only the status row.
  const runningVariant = classifyAgentHealth({ ...interleavedAgent, status: "running" });
  fixtures.push(fixture(
    V4_FIXTURE_MANIFEST[0],
    interleaved.rows.includes("agent_in_error")
      && interleaved.rows.includes("agent_heartbeat_disabled_with_work")
      && interleaved.cause === "cause unavailable — see run list"
      && interleaved.threeConsecutiveFailures === false
      && interleaved.selectedFailingRun === "failed"
      && !runningVariant.rows.includes("agent_in_error")
      && runningVariant.rows.includes("agent_heartbeat_disabled_with_work"),
    `rows=${interleaved.rows.join("+")} cause="${interleaved.cause}" threeConsecutive=${interleaved.threeConsecutiveFailures}`,
  ));

  // 2. Population conservation at large state: every canonical row appears in
  //    exactly one of comment / document / disclosed-unmaterialised.
  const conservation = executeDetailWrite(
    Array.from({ length: 312 }, (_, index) => `SYN-${1001 + index}`),
    { reserveTripsBeforeShard: 3 },
  );
  fixtures.push(fixture(
    V4_FIXTURE_MANIFEST[1],
    conservation.conserved
      && conservation.detailMaterialisedRowCount + conservation.detailUnmaterialisedRowCount === 312
      && conservation.receiptEmitted,
    `materialised=${conservation.detailMaterialisedRowCount} unmaterialised=${conservation.detailUnmaterialisedRowCount}`,
  ));

  // 3. Superseded approvals contribute nothing to the canonical fingerprint.
  const canonical = [
    { category: "agent_in_error", subjectId: "agent-1", severity: "p1" },
    { category: "stalled_issue", subjectId: "BLO-1", severity: "p2" },
  ];
  // Total, not partial: a row that reached this sort without a `category` is
  // exactly the regression this fixture exists to catch, and it must report as a
  // clean fixture `fail` with a differing fingerprint rather than throwing a
  // TypeError that takes the other six fixtures' reporting down with it.
  const fingerprintOf = (rows) => sha256(JSON.stringify(
    [...rows].sort((a, b) => (a.category ?? "").localeCompare(b.category ?? "")
      || compareIdentifier(a.subjectId, b.subjectId)),
  ));
  const f0 = fingerprintOf(canonical);
  const supersededRows = [{
    approvalId: "fixture-1", agentId: "fixture-agent", agentName: "FixtureAgent",
    requestedCapCents: 800000, currentCapCents: 1200000, capSource: "explicit_requested_cap",
  }];
  // The superseded rows ARE fed in now, through the drop that is supposed to
  // exclude them, so a regression letting one reach the fingerprint fails here.
  const fWithSuperseded = fingerprintOf(canonicalRows([...canonical, ...supersededRows]));
  // ...and the same holds for a row that is superseded while otherwise carrying a
  // canonical shape, so the rule under test is the supersession itself and not
  // merely the absent `category`.
  const fWithSupersededAlert = fingerprintOf(canonicalRows([
    ...canonical,
    { ...canonical[0], subjectId: "agent-9", superseded: true },
  ]));
  // Two-sided. Without this, a drop that discarded EVERYTHING would satisfy both
  // assertions above: the fingerprint must still respond to a genuine canonical
  // row, which is what makes "stable" mean stable rather than empty.
  const fWithExtraCanonical = fingerprintOf(canonicalRows([
    ...canonical,
    { category: "stalled_issue", subjectId: "BLO-2", severity: "p2" },
  ]));
  const renderedWithout = supersededSection([]);
  const renderedWith = supersededSection(supersededRows);
  fixtures.push(fixture(
    V4_FIXTURE_MANIFEST[2],
    fWithSuperseded === f0
      && fWithSupersededAlert === f0
      && fWithExtraCanonical !== f0
      && renderedWithout === null
      && renderedWith === "$8,000 requested vs $12,000 current",
    `fingerprint stable across superseded=${fWithSuperseded === f0 && fWithSupersededAlert === f0}`
      + ` responsive=${fWithExtraCanonical !== f0} sectionAbsentWithout=${renderedWithout === null}`,
  ));

  // 4. Human-review gate parks only on a LIVE pending card.
  const gate = (approvalStatus) => (approvalStatus === "pending"
    ? { classification: "parked", reason: "human_review_gate:appr-1" }
    : { classification: "stalled_issue", reason: "agent_actionable" });
  const parked = gate("pending");
  const rejected = gate("rejected");
  fixtures.push(fixture(
    V4_FIXTURE_MANIFEST[3],
    parked.classification === "parked"
      && parked.reason === "human_review_gate:appr-1"
      && rejected.classification === "stalled_issue",
    "pending parks with card id; rejected is a counted stalled_issue",
  ));

  // 5. Terminal-blocker precedence: cancelled > reaffirmed > stale edge.
  const classifyTerminal = ({ edges, comments, assigneeAgentId, lastBlockerTerminalAt }) => {
    if (edges.some((edge) => edge.status === "cancelled")) return "blocked_cancelled_edge";
    if (lastBlockerTerminalAt == null) return "blocked_attention";
    const reaffirmed = comments.some((comment) => comment.createdAt > lastBlockerTerminalAt
      && comment.authorType === "agent"
      && comment.authorAgentId === assigneeAgentId);
    return reaffirmed ? "blocked_reaffirmed" : "blocked_attention";
  };
  const base = {
    assigneeAgentId: "fixture-assignee",
    lastBlockerTerminalAt: "2026-08-02T00:00:00Z",
    edges: [{ status: "done" }, { status: "done" }],
  };
  const assigneeComment = [{ createdAt: "2026-08-03T00:00:00Z", authorType: "agent", authorAgentId: "fixture-assignee" }];
  const terminalPass =
    classifyTerminal({ ...base, comments: assigneeComment }) === "blocked_reaffirmed"
    && classifyTerminal({ ...base, comments: [] }) === "blocked_attention"
    && classifyTerminal({ ...base, comments: [{ createdAt: "2026-08-03T00:00:00Z", authorType: "system", authorAgentId: null }] }) === "blocked_attention"
    && classifyTerminal({ ...base, comments: [{ createdAt: "2026-08-03T00:00:00Z", authorType: "agent", authorAgentId: "fixture-other-agent" }] }) === "blocked_attention"
    && classifyTerminal({ ...base, comments: assigneeComment, lastBlockerTerminalAt: null }) === "blocked_attention"
    && classifyTerminal({ ...base, comments: assigneeComment, edges: [{ status: "cancelled" }, { status: "done" }] }) === "blocked_cancelled_edge";
  fixtures.push(fixture(
    V4_FIXTURE_MANIFEST[4],
    terminalPass,
    "cases 1-5: reaffirmed, stale, system-author, other-agent, unprovable, cancelled-wins",
  ));

  // 6. Cap raise: cumulative over a rolling 30d window, not per-step.
  const capAt = (events, baseline) => events.reduce((acc, event) => event.to, baseline);
  const july = {
    cto: capAt([{ to: 1100000 }, { to: 1200000 }, { to: 2320000 }], 800000),
    multicast: capAt([{ to: 1300000 }, { to: 1380000 }, { to: 2650000 }], 1000000),
  };
  const pct = (current, prior) => ((current - prior) / prior) * 100;
  const ctoPct = pct(july.cto, 800000);
  const multicastPct = pct(july.multicast, 1000000);
  const decompositionSteps = [1.08, 1.08, 1.08];
  const decomposition = decompositionSteps.reduce((acc, step) => acc * step, 1);
  const decompositionPct = (decomposition - 1) * 100;
  // Derived from the SAME array the cumulative reads — see maxStepPercent.
  const maxStepPct = maxStepPercent(decompositionSteps);
  const capRaisePass =
    Math.round(ctoPct) === 190 && ctoPct > 25
    && Math.round(multicastPct) === 165 && multicastPct > 25
    && decompositionPct > 25 && maxStepPct < 25;
  fixtures.push(fixture(
    V4_FIXTURE_MANIFEST[5],
    capRaisePass,
    `cto=+${Math.round(ctoPct)}% multicast=+${Math.round(multicastPct)}% decomposition=+${decompositionPct.toFixed(0)}% (max step ${maxStepPct.toFixed(0)}%)`,
  ));

  // 7. Large-state detail write, all four branches.
  const detail = runDetailWriteFixture();
  fixtures.push(fixture(
    V4_FIXTURE_MANIFEST[6],
    detail.status === "pass",
    detail.checks.filter((entry) => !entry.ok).map((entry) => entry.name).join("; ") || "A/B/C/D + row bounds",
  ));

  const renderer = runSyntheticRendererFixture();
  const comparator = runComparatorCases();

  return {
    version: 4,
    fixtures,
    renderer,
    comparator,
    detail,
    pass: fixtures.every((row) => row.status === "pass")
      && renderer.status === "pass"
      && comparator.status === "pass",
  };
}

const FAILING_RUN_STATUSES = new Set(["failed", "error", "adapter_failed"]);

/**
 * Agent-health row selection. Agent state is authoritative and evaluated
 * independently of run history: an interleaved `cancelled` / `scheduled_retry`
 * row must not displace the newest genuinely failing run, and must not make
 * `status: error` invisible.
 */
export function classifyAgentHealth(agent) {
  const rows = [];
  if (agent.status === "error") rows.push("agent_in_error");
  if (agent.status === "paused" && agent.pauseReason != null && agent.pauseReason !== "manual") {
    rows.push("agent_paused_non_manual");
  }
  const runs = agent.runs ?? [];
  const threeConsecutiveFailures = runs.length >= 3
    && runs.slice(0, 3).every((status) => FAILING_RUN_STATUSES.has(status));
  if (threeConsecutiveFailures && !rows.includes("agent_in_error")) rows.push("agent_in_error");

  const openIssues = agent.openIssues ?? [];
  if (agent.runtimeConfig?.heartbeat?.enabled === false && openIssues.length >= 1) {
    rows.push("agent_heartbeat_disabled_with_work");
  }

  const cause = agent.errorReason == null || String(agent.errorReason).trim() === ""
    ? "cause unavailable — see run list"
    : agent.errorReason;

  return {
    rows,
    cause,
    threeConsecutiveFailures,
    selectedFailingRun: runs.find((status) => FAILING_RUN_STATUSES.has(status)) ?? null,
  };
}

/**
 * The drop the `superseded_fingerprint` fixture exists to pin: a superseded
 * approval row, and any row carrying no alert `category`, contributes nothing
 * to the canonical fingerprint input.
 *
 * Scope, deliberately stated: this rule is defined HERE and has no counterpart
 * elsewhere in the repo. The alert-row shapes it operates on (`category`,
 * `subjectId`, `requestedCapCents`) appear in no file outside this script and
 * its test — the receipt is composed by the agent from the runbook, not by
 * shared code — so this is the only executable statement of the rule, not a
 * mirror of one. If a renderer ever grows its own superseded-drop, import it
 * rather than restating it: a divergence between the two would not fail here.
 *
 * Exported so the fixture's claim is reachable from a test. The fixture used to
 * assert `fingerprintOf(canonical) === fingerprintOf(canonical)` — the
 * determinism of a closure defined three lines above it — while the superseded
 * rows it is named for were never passed into anything, so a regression that let
 * one reach the fingerprint could not fail it (Ally review, PR #1571).
 */
export function canonicalRows(rows) {
  return (rows ?? []).filter((row) => row?.category != null && row?.superseded !== true);
}

/**
 * Largest single step of a multiplicative raise sequence, as a percentage.
 *
 * Derived from the same array the cumulative product reads. The
 * `cap_raise_july_backtest` fixture asserted the literal `8 < 25` instead, so
 * its discriminating claim — that no INDIVIDUAL step crosses the 25% threshold
 * while the cumulative does — was asserted against a constant: replacing the
 * three 1.08 steps with 1.30 left the fixture green and still printed
 * "(max step 8%)" (Ally review, PR #1571).
 */
export function maxStepPercent(steps) {
  return Math.max(...steps.map((step) => (step - 1) * 100));
}

function supersededSection(rows) {
  if (rows.length === 0) return null;
  const money = (cents) => `$${(cents / 100).toLocaleString("en-US")}`;
  return rows
    .map((row) => `${money(row.requestedCapCents)} requested vs ${money(row.currentCapCents)} current`)
    .join("; ");
}

function windowKey(date) {
  return new Date(date).toISOString().replace(/\.\d{3}Z$/, "Z");
}

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

/**
 * The pinned default keeps the fixtures deterministic. The executable CLI must
 * NOT inherit it: run on any later day it censuses a window already in the
 * past, so real runs land in no expected bucket and are dropped while the
 * missing older windows count as `silent` (Ally review, PR #1571). Callers on
 * the executable path pass `currentWindowEnd()`.
 */
export function sevenDayWindowKeys(end = "2026-08-31T06:00:00.000Z") {
  const endMs = Date.parse(end);
  if (!Number.isFinite(endMs)) throw new Error(`invalid census end: ${end}`);
  return Array.from({ length: 28 }, (_, index) => windowKey(endMs - (27 - index) * SIX_HOURS_MS));
}

/** Newest six-hour boundary at or before `now`. */
export function currentWindowEnd(now = Date.now()) {
  const ms = typeof now === "number" ? now : Date.parse(now);
  if (!Number.isFinite(ms)) throw new Error(`invalid census now: ${now}`);
  return windowKey(Math.floor(ms / SIX_HOURS_MS) * SIX_HOURS_MS);
}

/**
 * Documented tolerance for `census.complete`. Completeness is derived from
 * OBSERVED coverage, never from the generated key list: `classified.length === 28`
 * restates its own construction (`classified` is built by iterating `expected`,
 * which is always 28 long) and so can never be false, which made `pass` reduce
 * to `fixtures.pass` and let a 28/28-silent total outage — the exact condition
 * this census exists to detect — report green (Ally review, PR #1571).
 *
 * Two silent windows (half a day) absorb one late or missed routine slot; a
 * sustained outage fails the gate.
 *
 * ONE OF THE TWO IS SPENT BY DEFAULT on the executable path. `currentWindowEnd()`
 * snaps to the boundary at-or-before now, so the newest expected window is still
 * in progress and is legitimately `silent` for up to six hours: the effective
 * tolerance for a genuinely late slot is therefore ONE, not two. It is not
 * excluded from the denominator because the census cannot tell a partial newest
 * window from a completed one — an explicit `end` (the fixtures, a backfill) may
 * be either — and silently widening the tolerance by one would be the more
 * dangerous default (Ally review, PR #1571).
 *
 * Since BLO-31838 `silent` is keyed on the RECEIPT, not on the run row, which
 * makes that default spend reliable rather than incidental: the newest window is
 * now silent whether or not its run row has appeared, where before a started-but-
 * not-yet-emitted run made it `receipt-only` and left both slots of tolerance
 * nominally free. The budget is unchanged and still absorbs one late older slot;
 * what changed is that the census no longer under-reports the newest window's
 * true state. Read `silent` as "no receipt", never as "no run" — see
 * classifyWindowRows.
 */
export const MAX_SILENT_WINDOWS = 2;

function hasClassificationReceipt(row) {
  return row?.classification != null && row?.commentId != null;
}

/**
 * A receipt of ANY kind — deliberately weaker than hasClassificationReceipt.
 *
 * `failed_preflight` and `missed_window` receipts carry no classification but
 * ARE emissions, so the two predicates separate "emitted something that did not
 * classify" (`receipt-only`) from "emitted nothing" (`silent`, which runbook §0
 * defines as an emission-contract failure). Collapsing them into one predicate
 * is what let a sustained outage read green: see classifyWindowRows.
 *
 * `classification != null` is NOT sufficient. A run row can record what it
 * decided and still never post the comment — the recorded `2026-09-03T12` slot
 * classified `issue_created` with `commentId: null`. A decision is not an
 * emission, so this keys on `commentId` alone.
 */
function hasAnyReceipt(row) {
  return row?.commentId != null;
}

/**
 * Precedence, in full. `completed-without-comment` is checked FIRST: a terminal
 * run that produced no receipt is an emission-contract failure and must stay
 * visible. Checking `runless` first masked it; so did checking `duplicate` and
 * `coalesced` first, because a window holding a receiptless terminal run
 * alongside a duplicate-fingerprint or coalesced sibling reported only the
 * sibling (Ally review, PR #1571 — the second masking was found one branch up
 * from the first).
 *
 * A slot can genuinely be several of these at once, so the compound is returned
 * too: `state` is the highest-precedence finding (used for display) and `states`
 * lists every applicable one. `counts` aggregates over `states`, NOT over
 * `state` — histogramming only the primary reproduced the very masking this
 * precedence fix closed, one level up: a duplicate-run storm co-occurring with a
 * receiptless terminal run reported `counts.duplicate === 0` in the summary an
 * operator actually reads (Ally review, PR #1571).
 *
 * `silent` is checked SECOND, and is an independent check rather than part of
 * the terminal fallback below, for two reasons (BLO-31838):
 *
 *   1. It used to be reachable only from the zero-candidate-rows branch in
 *      classifyRoutineRuns, so it meant "no routine run fired" while runbook §0
 *      means "no qualifying receipt exists". A window that ran and emitted
 *      nothing fell through to `receipt-only` — and since `census.complete` is
 *      derived from the silent count, a fleet whose routine fires reliably while
 *      every run fails to post a receipt reported `counts.silent === 0` and
 *      `complete: true`. That is precisely the sustained emission-contract
 *      outage this census exists to detect.
 *   2. It sits above the run-SHAPE states (`duplicate`, `coalesced`, `runless`)
 *      for the same reason `completed-without-comment` does: an emission-contract
 *      failure must not be masked for display by a co-occurring shape finding.
 *      Placing it below would let a duplicate storm that emitted nothing display
 *      as `duplicate` — the identical masking the PR #1571 review chain found
 *      twice. It sits BELOW `completed-without-comment` because that is the
 *      strictly more specific diagnosis of the same failure: it names a terminal
 *      run that owed a receipt, where `silent` alone does not.
 *
 * `silent` and `classification-producing` are mutually exclusive by
 * construction — a classification receipt has a `commentId`, so a window
 * carrying one can never be silent — which is what keeps published coverage
 * ratios for historical windows unmoved by this change.
 */
function classifyWindowRows(candidates) {
  const fingerprints = candidates
    .map((row) => row.fingerprint)
    .filter((value) => typeof value === "string" && value.length > 0);

  const states = [];
  if (candidates.some((row) => ["completed", "succeeded"].includes(row.status) && !row.commentId)) {
    states.push("completed-without-comment");
  }
  if (!candidates.some(hasAnyReceipt)) states.push("silent");
  if (new Set(fingerprints).size !== fingerprints.length) states.push("duplicate");
  if (candidates.some((row) => row.coalescedIntoRunId != null)) states.push("coalesced");
  if (candidates.every((row) => row.runId == null)) states.push("runless");
  if (states.length === 0) {
    states.push(candidates.some(hasClassificationReceipt) ? "classification-producing" : "receipt-only");
  }
  return { state: states[0], states };
}

/**
 * Places a row's `windowKey` on the six-hour grid.
 *
 * The two failure modes are NOT the same thing and must not share a bucket: a
 * key that cannot be placed on the grid at all is a bucketing bug in whatever
 * produced the row, while a key that is a perfectly good boundary outside the
 * censused week is just an out-of-scope row. Only the first is a defect, so only
 * the first fails the gate (Ally review, PR #1571).
 *
 * A grid-aligned instant in non-canonical string form (`...T06:00:00.000Z`) is
 * normalized rather than rejected: it names the right window, and `expectedSet`
 * compares strings.
 */
function placeWindowKey(rawKey) {
  if (typeof rawKey !== "string") return { kind: "malformed" };
  const ms = Date.parse(rawKey);
  if (!Number.isFinite(ms)) return { kind: "malformed" };
  if (ms % SIX_HOURS_MS !== 0) return { kind: "malformed" };
  return { kind: "boundary", key: windowKey(ms) };
}

export function classifyRoutineRuns(rows, end) {
  const expected = sevenDayWindowKeys(end);
  const expectedSet = new Set(expected);
  const byWindow = new Map();
  const malformedRows = [];
  const outOfWindowKeys = new Set();
  for (const row of rows ?? []) {
    const placed = placeWindowKey(row.windowKey);
    if (placed.kind === "malformed") {
      malformedRows.push({ runId: row.runId ?? null, windowKey: row.windowKey ?? null });
      continue;
    }
    if (!expectedSet.has(placed.key)) {
      // Reported, NOT failing: a healthy 28/28 census must not go red because the
      // caller handed the CLI a dump of the routine's runs rather than a slice
      // pre-scoped to exactly the censused week. A wrong census `end` is still
      // caught, by the `silent` term — every real run falling out of window
      // leaves all 28 expected windows empty.
      outOfWindowKeys.add(placed.key);
      continue;
    }
    const bucket = byWindow.get(placed.key) ?? [];
    bucket.push(row);
    byWindow.set(placed.key, bucket);
  }

  const classified = [];
  for (const key of expected) {
    const candidates = byWindow.get(key) ?? [];
    if (candidates.length === 0) {
      classified.push({ windowKey: key, state: "silent", states: ["silent"], runIds: [] });
      continue;
    }
    const { state, states } = classifyWindowRows(candidates);
    const runIds = candidates.map((candidate) => candidate.runId).filter((id) => id != null);
    classified.push({ windowKey: key, state, states, runIds });
  }

  const counts = Object.fromEntries(REQUIRED_STATES.map((state) => [state, 0]));
  // Over `states`, not `state`: a slot can be several things at once, so these
  // counts sum to MORE than the 28 windows. That over-count is the honest
  // reading — see classifyWindowRows.
  //
  // `silent` is now a compound state too (BLO-31838): a window that ran and
  // emitted nothing is both `completed-without-comment` and `silent`. The
  // completeness arithmetic below is unaffected, because what it needs is not
  // that a silent slot carries exactly one state but that each slot contributes
  // AT MOST ONE to `counts.silent` — and both branches push "silent" at most
  // once per slot, so `observedWindows` stays a true window count.
  for (const row of classified) for (const state of row.states) counts[state] += 1;

  // Derived from what was observed, so it can actually be false. Expressed in
  // terms of observed coverage rather than the silent count so the rule reads as
  // the same thing its rationale appeals to. See MAX_SILENT_WINDOWS.
  const observedWindows = expected.length - counts.silent;
  const complete =
    observedWindows >= expected.length - MAX_SILENT_WINDOWS && malformedRows.length === 0;

  return {
    complete,
    observedWindows,
    maxSilentWindows: MAX_SILENT_WINDOWS,
    outOfWindowKeys: [...outOfWindowKeys].sort(),
    malformedRows,
    expectedWindows: expected,
    slots: classified,
    counts,
  };
}

export function runPreflight(rows, end) {
  const fixtures = runMandatoryFixtures();
  const census = classifyRoutineRuns(rows, end);
  return { fixtures, census, pass: fixtures.pass && census.complete };
}

// `fileURLToPath`, not `new URL(...).pathname`: the latter percent-encodes, so a
// checkout under a directory containing a space made this comparison fail and the
// CLI block silently no-op — exiting 0 having done nothing, which is the one
// failure mode this file works hardest everywhere else to eliminate (Ally review,
// PR #1571).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const input = process.argv[2]
    ? JSON.parse(await import("node:fs/promises").then((fs) => fs.readFile(process.argv[2], "utf8")))
    : [];
  // Explicit `end` — never the pinned fixture default, which drifts into the past.
  const end = process.argv[3] ?? currentWindowEnd();
  const result = runPreflight(input, end);
  console.log(JSON.stringify({ censusEnd: end, ...result }, null, 2));
  if (!result.pass) process.exitCode = 1;
}
