import { afterEach, describe, expect, it } from "vitest";

import type { Db } from "@paperclipai/db";
import type { ReclaimClaimOutcome } from "../services/isolation-reclaim-driver.js";
import { sweepIsolationReclaim } from "../services/isolation-reclaim-sweep.js";
import type { IsolationReclaimSweepOptions } from "../services/isolation-reclaim-sweep.js";
import type { ReclaimJobPort } from "../services/isolation-reclaim-runner.js";
import type {
  IsolationReclaimExecutionResult,
  ReclaimableClaim,
} from "../services/isolation-workspace-reaper.js";
import {
  ISOLATION_RECLAIM_CLAIMS_METRIC,
  ISOLATION_RECLAIM_LAST_SWEEP_METRIC,
  ISOLATION_RECLAIM_RECLAIMED_METRIC,
  ISOLATION_RECLAIM_SWEEPS_METRIC,
  ISOLATION_RECLAIM_UNKNOWN_OUTCOME_METRIC,
  __resetMetricsForTest,
  renderMetrics,
} from "../services/metrics.js";

/**
 * PEN-5151 done-when 2: the companion to
 * `paperclip_isolation_workspace_reaper_unreachable_agents`.
 *
 * That gauge counts agents whose trees the MOUNTED sweep cannot reach. It goes
 * non-zero on the first opted-in agent and stays there — nothing this row
 * builds makes the mounted sweep able to walk a claim it does not mount. So
 * the standing finding is retired by evidence that something ELSE reclaims
 * those trees, which means these series have exactly one job: being readable
 * enough that "unreachable and unreclaimed" and "unreachable but reclaimed"
 * are different shapes on a dashboard.
 *
 * Everything below is asserted against LITERAL metric names and literal label
 * strings rather than against the exported constants. An assertion written as
 * `body.includes(ISOLATION_RECLAIM_CLAIMS_METRIC)` passes after a rename that
 * silently breaks every operator query and alert built on the old name; the
 * exposition is the contract, so the test states it. The constants are pinned
 * to those literals separately, which is what keeps the two from drifting.
 */

const db = {} as Db;
const port = {} as ReclaimJobPort;

const TEMPLATE = {
  namespace: "paperclip",
  image: "harbor.blockcast.net/paperclip/paperclip@sha256:abc",
};

function claim(name: string): ReclaimableClaim {
  return { claimName: name, source: "agent_per_agent_volume", agentId: null };
}

function execResult(deleted: number, wouldDelete = 0): IsolationReclaimExecutionResult {
  return {
    requested: deleted + wouldDelete,
    deleted,
    wouldDelete,
    skippedUnsafeName: 0,
    skippedLayout: 0,
    retainedNestedCheckout: 0,
    vanished: 0,
    failed: 0,
    notAttempted: 0,
    capped: false,
    stopReason: "complete",
  };
}

function outcome(c: ReclaimableClaim, overrides: Partial<ReclaimClaimOutcome> = {}): ReclaimClaimOutcome {
  return {
    claimName: c.claimName,
    agentId: c.agentId,
    source: c.source,
    phase: "execute",
    ok: true,
    failureKind: null,
    detail: null,
    plan: null,
    result: execResult(0),
    nothingEligible: false,
    dryRun: false,
    adoptedInventory: false,
    adoptedExecute: false,
    deletionOutcomeUnknown: false,
    inventoryJobName: null,
    executeJobName: null,
    ...overrides,
  };
}

const FIXED_NOW_MS = 1_900_000_000_000;

function sweepWith(
  overrides: Partial<IsolationReclaimSweepOptions> & {
    listClaims: IsolationReclaimSweepOptions["listClaims"];
    drive: IsolationReclaimSweepOptions["drive"];
  },
): ReturnType<typeof sweepIsolationReclaim> {
  return sweepIsolationReclaim(db, {
    template: TEMPLATE,
    port,
    selfClaimName: "paperclip-data",
    maxAgeDays: 7,
    invocationId: "abc1234",
    lookupWorkspaceUsage: async () => new Map(),
    now: () => FIXED_NOW_MS,
    ...overrides,
  });
}

/**
 * One sample's value, or `undefined` when that exact series is absent.
 *
 * Absent and zero must stay distinguishable here: a materialized zero is the
 * property most of these tests exist to assert, so a helper that folded a
 * missing series into 0 would make every one of them pass vacuously.
 */
function sample(body: string, name: string, labels: string): number | undefined {
  const line = body
    .split("\n")
    .find((l) => l.startsWith(`${name}{`) && l.includes(labels));
  if (!line) return undefined;
  return Number(line.slice(line.lastIndexOf(" ") + 1));
}

afterEach(() => {
  __resetMetricsForTest();
});

describe("isolation reclaim sweep metrics", () => {
  it("pins the exported constants to the names operators query", () => {
    expect(ISOLATION_RECLAIM_SWEEPS_METRIC).toBe("paperclip_isolation_reclaim_sweeps_total");
    expect(ISOLATION_RECLAIM_CLAIMS_METRIC).toBe("paperclip_isolation_reclaim_claims_total");
    expect(ISOLATION_RECLAIM_RECLAIMED_METRIC).toBe("paperclip_isolation_reclaim_reclaimed_total");
    expect(ISOLATION_RECLAIM_UNKNOWN_OUTCOME_METRIC).toBe(
      "paperclip_isolation_reclaim_unknown_outcome_claims_total",
    );
    expect(ISOLATION_RECLAIM_LAST_SWEEP_METRIC).toBe(
      "paperclip_isolation_reclaim_last_sweep_timestamp_seconds",
    );
  });

  it("materializes every zero-valued child on a clean tick", async () => {
    const a = claim("pvc-a");
    await sweepWith({
      listClaims: async () => [a],
      drive: async () => outcome(a),
    });

    const { body } = await renderMetrics();

    // The point of the whole helper: a tick that defers nothing and fails
    // nothing must still publish those as readable zeros, so "swept, all
    // healthy" is a different shape from "this series was never written" --
    // the latter being how a sweep that is deployed but never ticking reads.
    expect(sample(body, "paperclip_isolation_reclaim_claims_total", 'outcome="ok"')).toBe(1);
    expect(sample(body, "paperclip_isolation_reclaim_claims_total", 'outcome="failed"')).toBe(0);
    expect(sample(body, "paperclip_isolation_reclaim_claims_total", 'outcome="deferred"')).toBe(0);
    expect(
      sample(body, "paperclip_isolation_reclaim_unknown_outcome_claims_total", 'dry_run="false"'),
    ).toBe(0);
  });

  it.each([
    { deferred: 0, complete: 1, capped: 0, label: "nothing deferred" },
    { deferred: 2, complete: 0, capped: 1, label: "claims deferred past the bound" },
  ])("records stop_reason with both children present: $label", async ({ deferred, complete, capped }) => {
    const claims = Array.from({ length: 1 + deferred }, (_, i) => claim(`pvc-${i}`));
    await sweepWith({
      maxClaimsPerTick: 1,
      listClaims: async () => claims,
      drive: async ({ claim: c }) => outcome(c),
    });

    const { body } = await renderMetrics();

    // Both directions asserted, and both children read on each, so a mutation
    // that hard-codes either stop_reason fails one of the two cases rather
    // than passing whichever single case was written.
    expect(sample(body, "paperclip_isolation_reclaim_sweeps_total", 'stop_reason="complete"')).toBe(
      complete,
    );
    expect(
      sample(body, "paperclip_isolation_reclaim_sweeps_total", 'stop_reason="claims_capped"'),
    ).toBe(capped);
    expect(sample(body, "paperclip_isolation_reclaim_claims_total", 'outcome="deferred"')).toBe(
      deferred,
    );
  });

  it.each([
    { dryRun: false, expected: 3, label: "a live pass reports what it unlinked" },
    { dryRun: true, expected: 11, label: "a dry run reports what it would unlink" },
  ])("reclaimed_total follows dry_run: $label", async ({ dryRun, expected }) => {
    const a = claim("pvc-a");
    await sweepWith({
      dryRun,
      listClaims: async () => [a],
      // deleted and wouldDelete are DIFFERENT numbers on purpose. With one
      // fixture carrying both, a recorder that reads the wrong field reports a
      // number that is wrong rather than one that happens to agree, so the
      // swap is caught in both directions.
      drive: async () => outcome(a, { dryRun, result: execResult(3, 11) }),
    });

    const { body } = await renderMetrics();

    expect(
      sample(body, "paperclip_isolation_reclaim_reclaimed_total", `dry_run="${dryRun}"`),
    ).toBe(expected);
  });

  it("counts claims whose deletion total is unknown, making reclaimed a lower bound", async () => {
    const a = claim("pvc-a");
    const b = claim("pvc-b");
    await sweepWith({
      listClaims: async () => [a, b],
      drive: async ({ claim: c }) =>
        c.claimName === "pvc-a"
          ? outcome(c, { result: execResult(5) })
          : outcome(c, {
              ok: false,
              failureKind: "execute_run_failed",
              result: null,
              deletionOutcomeUnknown: true,
            }),
    });

    const { body } = await renderMetrics();

    expect(
      sample(body, "paperclip_isolation_reclaim_unknown_outcome_claims_total", 'dry_run="false"'),
    ).toBe(1);
    // Still published, and still 5 — the series does not become absent or
    // suppressed because it is a lower bound. An operator reads the pair.
    expect(sample(body, "paperclip_isolation_reclaim_reclaimed_total", 'dry_run="false"')).toBe(5);
    expect(sample(body, "paperclip_isolation_reclaim_claims_total", 'outcome="failed"')).toBe(1);
  });

  it("stamps the liveness gauge from the sweep's own clock", async () => {
    const a = claim("pvc-a");
    await sweepWith({
      listClaims: async () => [a],
      drive: async () => outcome(a),
    });

    const { body } = await renderMetrics();

    // Literal seconds, not derived from FIXED_NOW_MS by repeating the same
    // division the recorder performs — that arithmetic IS the thing under test.
    expect(
      sample(body, "paperclip_isolation_reclaim_last_sweep_timestamp_seconds", 'dry_run="false"'),
    ).toBe(1_900_000_000);
  });

  it("stamps the gauge even on a tick that found no claims at all", async () => {
    await sweepWith({
      listClaims: async () => [],
      drive: async () => {
        throw new Error("no claim should be driven");
      },
    });

    const { body } = await renderMetrics();

    // The reason the gauge is set unconditionally: an empty fleet and a sweep
    // that silently stopped finding claims produce the same counters, and only
    // a fresh timestamp separates them. A recorder that skipped the stamp when
    // nothing was driven would leave the last value standing and read healthy
    // forever.
    expect(
      sample(body, "paperclip_isolation_reclaim_last_sweep_timestamp_seconds", 'dry_run="false"'),
    ).toBe(1_900_000_000);
    expect(sample(body, "paperclip_isolation_reclaim_claims_total", 'outcome="ok"')).toBe(0);
  });

  it("records nothing when the claim list could not be read", async () => {
    await expect(
      sweepWith({
        listClaims: async () => {
          throw new Error("apiserver unavailable");
        },
        drive: async () => {
          throw new Error("no claim should be driven");
        },
      }),
    ).rejects.toThrow("apiserver unavailable");

    const { body } = await renderMetrics();

    // No sweep is recorded, deliberately: no claim was assessed, so there is
    // no population to report success over. The gauge staying ABSENT is the
    // signal — the same shape a sweep that stopped ticking produces, which is
    // correct because the consequence is identical.
    expect(
      sample(body, "paperclip_isolation_reclaim_last_sweep_timestamp_seconds", 'dry_run="false"'),
    ).toBeUndefined();
    expect(sample(body, "paperclip_isolation_reclaim_sweeps_total", 'stop_reason="complete"')).toBeUndefined();
  });
});
