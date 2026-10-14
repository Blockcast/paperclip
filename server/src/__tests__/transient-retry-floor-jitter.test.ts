// PEN-2509 — `transient_failure` retries clamp to a shared wake instant.
//
// `scheduleBoundedRetryForRun` treats an adapter-advertised `retryNotBefore` as
// a floor and, when it is later than the computed backoff, adopted it VERBATIM
// as `dueAt`. That floor is an absolute provider instant, so every run holding
// the same one landed on the same millisecond; and because the floor is
// routinely 4-5h out while the largest backoff hop is 2h, the floor won whenever
// it was present. Both reported symptoms are that one substitution:
//
//   * cohorts converge — 25 runs / 5 agents / attempts 2-11 at 0ms spread
//     (2026-08-24), 23 runs / 7 agents / attempts 1-12 inside 1.1s (2026-08-25)
//   * backoff stops varying with attempt — the attempt-scaled curve is exactly
//     what the floor discards, so attempt 1 and attempt 12 wait the same
//
// The base curve already jitters (BOUNDED_TRANSIENT_HEARTBEAT_RETRY_JITTER_RATIO)
// and the capacity path already jitters its clamped reset (BLO-23438). Neither
// covers this path: the first is discarded when the floor wins, the second only
// runs for `ccrotate_capacity`. This file pins the gap closed.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.ts";
import {
  BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS,
  computeBoundedTransientHeartbeatRetrySchedule,
  heartbeatService,
} from "../services/heartbeat.js";
import {
  CCROTATE_CAPACITY_FIRST_DEFERRED_AT_KEY,
  CCROTATE_CAPACITY_PARK_CLAMPED_FROM_KEY,
  isCapacityGovernedRetryFloor,
  jitterTransientRetryFloor,
  TRANSIENT_RETRY_FLOOR_JITTER_MAX_MS,
  TRANSIENT_RETRY_FLOOR_JITTER_RATIO,
} from "../services/ccrotate-capacity-retry.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { cleanupHeartbeatTestState } from "./helpers/cleanup-heartbeat-test-state.js";

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => ({ track: vi.fn() }),
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return { ...actual, trackAgentFirstHeartbeat: vi.fn() };
});

describe("jitterTransientRetryFloor", () => {
  const now = new Date("2026-08-25T02:30:00.000Z");
  // The live shape: the 2026-08-25 cohort parked ~02:30Z against a floor of
  // 06:59:59Z, i.e. ~4.5h out. Long enough that the ratio is not the binding
  // control — the cap is.
  const floor = new Date("2026-08-25T06:59:59.000Z");

  it("never returns an instant earlier than the floor", () => {
    // The floor means "not before". Every sample, including the degenerate
    // ends, must respect it — pulling a retry in front of an advertised reset
    // would probe a door the provider told us is shut.
    for (const sample of [0, 0.5, 1, -1, 2, Number.NaN]) {
      const { dueAt } = jitterTransientRetryFloor({ dueAt: floor, now, random: () => sample });
      expect(dueAt.getTime()).toBeGreaterThanOrEqual(floor.getTime());
    }
  });

  it("adds nothing at sample 0 and the whole window at sample 1", () => {
    const low = jitterTransientRetryFloor({ dueAt: floor, now, random: () => 0 });
    expect(low.jitterMs).toBe(0);
    expect(low.dueAt.getTime()).toBe(floor.getTime());

    const high = jitterTransientRetryFloor({ dueAt: floor, now, random: () => 1 });
    expect(high.jitterMs).toBe(TRANSIENT_RETRY_FLOOR_JITTER_MAX_MS);
    expect(high.dueAt.getTime()).toBe(floor.getTime() + TRANSIENT_RETRY_FLOOR_JITTER_MAX_MS);
  });

  it("caps the window so a multi-hour floor is not pushed out by hours", () => {
    // Without the cap, ratio * delay on a 4.5h floor would be ~54 minutes.
    const delayMs = floor.getTime() - now.getTime();
    expect(delayMs * TRANSIENT_RETRY_FLOOR_JITTER_RATIO).toBeGreaterThan(
      TRANSIENT_RETRY_FLOOR_JITTER_MAX_MS,
    );
    const { jitterMs } = jitterTransientRetryFloor({ dueAt: floor, now, random: () => 1 });
    expect(jitterMs).toBe(TRANSIENT_RETRY_FLOOR_JITTER_MAX_MS);
    // And the added delay is a rounding error against the park it is spreading.
    expect(jitterMs / delayMs).toBeLessThan(0.02);
  });

  it("scales with the remaining delay while the ratio still binds", () => {
    // Below the cap's crossover the window is proportional, which is what
    // keeps a short floor from being pushed out by a window sized for a long
    // one. 60s floor -> 12s window, not 5 minutes.
    const shortFloor = new Date(now.getTime() + 60_000);
    const { jitterMs } = jitterTransientRetryFloor({ dueAt: shortFloor, now, random: () => 1 });
    expect(jitterMs).toBe(60_000 * TRANSIENT_RETRY_FLOOR_JITTER_RATIO);
    expect(jitterMs).toBeLessThan(TRANSIENT_RETRY_FLOOR_JITTER_MAX_MS);
  });

  it("adds nothing to a floor that is already in the past", () => {
    // delayMs clamps at 0, so a stale floor is not turned into a fresh park.
    const stale = new Date(now.getTime() - 60 * 60 * 1000);
    const { dueAt, jitterMs } = jitterTransientRetryFloor({ dueAt: stale, now, random: () => 1 });
    expect(jitterMs).toBe(0);
    expect(dueAt.getTime()).toBe(stale.getTime());
  });

  it("disperses a cohort that shares one floor, and collapses when defeated", () => {
    // Both arms of the same measurement, so the assertion cannot pass for a
    // reason other than the jitter. Live arm: 25 runs (the 2026-08-24 cohort
    // size) against one floor.
    const samples = Array.from({ length: 25 }, (_, i) => (i + 0.5) / 25);
    const spreadOf = (opts: { jitterRatio?: number }) => {
      const times = samples.map(
        (s) => jitterTransientRetryFloor({ dueAt: floor, now, random: () => s, ...opts }).dueAt.getTime(),
      );
      return { spreadMs: Math.max(...times) - Math.min(...times), distinct: new Set(times).size };
    };

    // Mechanism live: the cohort spreads across minutes and no two runs share
    // a millisecond.
    const live = spreadOf({});
    expect(live.distinct).toBe(25);
    expect(live.spreadMs).toBeGreaterThan(60_000);

    // Mechanism defeated (ratio 0) — this is precisely the pre-fix
    // "adopt the floor verbatim" behaviour, and it reproduces the reported
    // 0ms spread. If the live arm above ever passed vacuously, this arm would
    // pass too.
    const defeated = spreadOf({ jitterRatio: 0 });
    expect(defeated.spreadMs).toBe(0);
    expect(defeated.distinct).toBe(1);
  });
});

// Review follow-up. The first cut of this fix dispersed EVERY floor, which
// silently re-tuned a neighbouring mechanism: a capacity floor's instant is
// owned by the capacity arithmetic (the resolver arm jitters it, and both arms
// are bounded by CCROTATE_CAPACITY_MAX_PARK_MS), so a second window here would
// stack on the one and push the other past that ceiling. Four assertions in
// heartbeat-provider-capacity-horizon.test.ts caught it by pinning the exact
// instant, and they still pass unchanged — this predicate is what keeps them
// passing, so it is pinned directly rather than only through that suite.
describe("isCapacityGovernedRetryFloor", () => {
  // Two writers produce a capacity floor and mark it differently. Testing one
  // marker would answer "not capacity" for half of them, so both are pinned.
  it("recognises a floor written by applyCcrotateCapacityDecision", () => {
    expect(
      isCapacityGovernedRetryFloor({
        [CCROTATE_CAPACITY_FIRST_DEFERRED_AT_KEY]: "2026-08-25T02:30:00.000Z",
      }),
    ).toBe(true);
  });

  it("recognises a CLAMPED floor written by the finalize path", () => {
    // Shape taken from a live row. The finalize path writes no chain-origin
    // key, so the clamp marker is the only routing evidence present — and it is
    // present precisely because `capacityFloorClampApplies` was true, i.e. the
    // floor beside it is `resolveCcrotateCapacityRetry`'s output. The four
    // exact-instant assertions in heartbeat-provider-capacity-horizon.test.ts
    // depend on this staying true.
    expect(
      isCapacityGovernedRetryFloor({
        retryNotBefore: "2026-08-25T06:59:59.000Z",
        transientRetryNotBefore: "2026-08-25T06:59:59.000Z",
        [CCROTATE_CAPACITY_PARK_CLAMPED_FROM_KEY]: "2026-08-27T10:00:00.000Z",
        providerCapacityResetProvenance: { source: "server", errorFamily: "rate_limit_exhausted" },
      }),
    ).toBe(true);
  });

  // PEN-2509 reopen (2026-10-13). THE REGRESSION THIS PREDICATE WAS NARROWED
  // FOR. The original fix exempted any row carrying
  // `providerCapacityResetProvenance`, on the premise that a capacity denial's
  // instant is owned by the capacity arithmetic. That premise is false for one
  // of the three writers: the finalize path records the provenance of every
  // reset it recovers, but only ROUTES the instant through
  // `resolveCcrotateCapacityRetry` when the resolved value lands earlier than
  // the advertised one. When it does not, `retryNotBefore` is the raw
  // advertised instant — a whole second, shared verbatim by every agent that
  // saw the same denial — and the exemption pinned the whole cohort to it.
  //
  // Measured consequence: 20.0% of 380 post-fix `transient_failure` parks
  // landed on a whole second (~0.1% by chance), 76/76 of them on a 10-minute
  // grid, across 8 agents. The jitter was deployed and unregressed throughout.
  it("leaves a provenance-marked but UNCLAMPED finalize floor dispersible", () => {
    expect(
      isCapacityGovernedRetryFloor({
        errorFamily: "rate_limit_exhausted",
        retryNotBefore: "2026-10-12T21:59:59.000Z",
        transientRetryNotBefore: "2026-10-12T21:59:59.000Z",
        providerCapacityResetAt: "2026-10-12T21:59:59.000Z",
        // Written by the finalize path for every recovered reset. It records
        // WHERE the instant came from, not that anything recomputed it, so on
        // its own it must not exempt.
        providerCapacityResetProvenance: {
          source: "server",
          errorFamily: "rate_limit_exhausted",
          observedStatusCode: 429,
          horizonSource: "server_prose_parse",
        },
        // and crucially: no chain-origin key, no clamp marker.
      }),
    ).toBe(false);
  });

  it("exempts on the clamp marker ALONE, with no provenance beside it", () => {
    // Positive control for the narrowed arm. The case above still passes under
    // the OLD predicate (its row carries provenance too), so it cannot show the
    // clamp marker is load-bearing. This row can: provenance is absent, so only
    // the routing evidence is left to carry the exemption.
    expect(
      isCapacityGovernedRetryFloor({
        retryNotBefore: "2026-08-25T06:59:59.000Z",
        [CCROTATE_CAPACITY_PARK_CLAMPED_FROM_KEY]: "2026-08-27T10:00:00.000Z",
      }),
    ).toBe(true);
  });

  it("does not exempt on a blank or non-string clamp marker", () => {
    // Fail-closed direction: an unusable marker means "disperse it". Exempting
    // on a blank string would reinstate the herd through a corrupt field.
    expect(isCapacityGovernedRetryFloor({ [CCROTATE_CAPACITY_PARK_CLAMPED_FROM_KEY]: "   " })).toBe(
      false,
    );
    expect(isCapacityGovernedRetryFloor({ [CCROTATE_CAPACITY_PARK_CLAMPED_FROM_KEY]: 1 })).toBe(false);
    expect(isCapacityGovernedRetryFloor({ [CCROTATE_CAPACITY_PARK_CLAMPED_FROM_KEY]: null })).toBe(
      false,
    );
  });

  it("leaves a raw advertised transient floor dispersible", () => {
    // The measured PEN-2509 herd. No capacity marker, so this must stay false
    // or the fix is inert on the one path it exists to cover.
    expect(
      isCapacityGovernedRetryFloor({
        errorFamily: "transient_upstream",
        retryNotBefore: "2026-08-25T06:59:59.000Z",
        transientRetryNotBefore: "2026-08-25T06:59:59.000Z",
      }),
    ).toBe(false);
  });

  it("rejects malformed and absent markers rather than guessing", () => {
    // A non-round-trippable origin is not a usable marker; treating it as one
    // would suppress dispersion off a corrupt field.
    expect(isCapacityGovernedRetryFloor({ [CCROTATE_CAPACITY_FIRST_DEFERRED_AT_KEY]: "nonsense" })).toBe(
      false,
    );
    expect(isCapacityGovernedRetryFloor({ providerCapacityResetProvenance: null })).toBe(false);
    expect(isCapacityGovernedRetryFloor({})).toBe(false);
    expect(isCapacityGovernedRetryFloor(null)).toBe(false);
    expect(isCapacityGovernedRetryFloor("not-an-object")).toBe(false);
  });
});

// Done-when #3: "Backoff actually varies with attempt count, or it is stated why
// attempt 8 and attempt 1 should wait the same."
//
// Recorded answer: backoff DOES vary with attempt on the hintless path, and it
// is correct that it does not on the floor path. A floor is an absolute instant
// the provider named; waiting longer than it because we have tried more times
// buys nothing, and the curve is dominated by construction (every hop is <= 2h,
// every observed floor 4-5h). Attempt-invariance under a floor is therefore the
// intended behaviour and the herd — not the flat wait — is the defect. These
// two tests pin both halves of that statement so neither can rot silently.
describe("attempt scaling", () => {
  it("varies with attempt count on the hintless curve", () => {
    const now = new Date("2026-08-25T02:30:00.000Z");
    // Mid-sample kills the jitter's contribution so the comparison is of base
    // hops, not of two random draws.
    const delayFor = (attempt: number) =>
      computeBoundedTransientHeartbeatRetrySchedule(attempt, now, () => 0.5)!.delayMs;

    const delays = [1, 2, 3, 4].map(delayFor);
    expect(delays).toEqual([...BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS]);
    // Strictly increasing: attempt 4 does not wait what attempt 1 waits.
    for (let i = 1; i < delays.length; i += 1) {
      expect(delays[i]).toBeGreaterThan(delays[i - 1]!);
    }
  });

  it("holds at the last hop past the curve, so a floor still decides dueAt", () => {
    const now = new Date("2026-08-25T02:30:00.000Z");
    const lastHop = BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS.at(-1)!;
    // Attempt 11 was live in the 2026-08-24 census. Its base delay is the 2h
    // hop, which every observed floor (4-5h) exceeds — this is why the floor
    // wins regardless of attempt, and why jitter rather than attempt scaling
    // is the lever that disperses the cohort.
    const beyond = computeBoundedTransientHeartbeatRetrySchedule(11, now, () => 0.5, 12)!;
    expect(beyond.baseDelayMs).toBe(lastHop);
    const observedFloorMs = 4.5 * 60 * 60 * 1000;
    expect(observedFloorMs).toBeGreaterThan(lastHop);
  });
});

// The end-to-end arm. Drives real heartbeat finalization through a registered
// test adapter that advertises a shared floor, so the assertion covers the
// production wiring in `scheduleBoundedRetryForRun` and cannot drift from it.
// On master every row here lands on the identical millisecond.
const SHARED_FLOOR_TEST_ADAPTER = "pen2509_shared_floor_test_adapter";

// A gateway brownout that also names a reset — the shape that produces a
// `transient_upstream` family WITH a floor. 503 (not 429) keeps this off the
// provider-capacity override path, so the floor reaches the bounded scheduler
// as an ordinary transient floor rather than being clamped as capacity.
const GATEWAY_503_RESULT_JSON = {
  subtype: "api_retry",
  attempt: 10,
  max_retries: 10,
  error_status: 503,
  error: "server_error",
} as const;

// PEN-2509 reopen (2026-10-13): the shape that actually herds in production.
//
// A 429 WITH a structured reset instant. That combination makes the finalize
// path write `providerCapacityResetProvenance` (the marker the original fix
// exempted on) while still adopting the advertised instant VERBATIM as the
// floor, because its capacity clamp only applies when it resolves EARLIER than
// what the provider advertised — and for a reset inside
// CCROTATE_CAPACITY_MAX_PARK_MS it never does. So the row reads
// "capacity-governed" and carries a raw shared instant at the same time.
const RATE_LIMIT_429_TEST_ADAPTER = "pen2509_unclamped_capacity_floor_test_adapter";

// `api_error_status: 429` satisfies both `isRateLimitExhausted` (giving the
// rate_limit_exhausted family) and `readProviderCapacityResetStatusEvidence`
// (the 429 substantiation the structured-hint path requires before it records
// provenance). No prose horizon: the structured `retryNotBefore` is the hint.
const RATE_LIMIT_429_RESULT_JSON = {
  subtype: "api_retry",
  api_error_status: 429,
  error: "rate_limit_error",
} as const;

const RATE_LIMIT_429_ERROR_MESSAGE =
  "API Error: 429 rate_limit_error. Request rate limit exceeded for this organization.";

const GATEWAY_503_ERROR_MESSAGE =
  "API Error: 503 Service temporarily unavailable. This is a server-side issue, usually " +
  "temporary — try again in a moment. If it persists, check your inference gateway (api.penstock.run).";

// `getEmbeddedPostgresTestSupport` is async, and `startEmbeddedPostgresTestDatabase`
// takes a name PREFIX (not the support object). Resolving support at module scope
// also lets the suite skip cleanly where embedded Postgres is unavailable, instead
// of failing the file for an environmental reason.
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("a cohort sharing one advertised floor", () => {
  let db: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let heartbeat: ReturnType<typeof heartbeatService>;
  // Every agent's run advertises this same instant, which is what a real fleet
  // sees: one upstream, one reset, N runs. ~4.5h out, matching the live census.
  let sharedFloor: Date;
  // Deliberately INSIDE CCROTATE_CAPACITY_MAX_PARK_MS (15m) and outside the
  // rate-limit curve's flat 90s hop. Inside the ceiling is what makes the
  // capacity clamp decline to apply, which is the whole point of this fixture;
  // outside 90s is what makes the floor beat the base curve so it reaches the
  // dispersion branch at all.
  let sharedCapacityFloor: Date;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-pen2509-shared-floor-");
    db = createDb(tempDb!.connectionString);
    heartbeat = heartbeatService(db, { skipQueuedRunDispatch: true });
    sharedFloor = new Date(Date.now() + 4.5 * 60 * 60 * 1000);
    sharedCapacityFloor = new Date(Date.now() + 5 * 60 * 1000);

    registerServerAdapter({
      type: SHARED_FLOOR_TEST_ADAPTER,
      execute: async () => ({
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: GATEWAY_503_ERROR_MESSAGE,
        resultJson: { ...GATEWAY_503_RESULT_JSON } as Record<string, unknown>,
        retryNotBefore: sharedFloor.toISOString(),
      }),
      testEnvironment: async () => ({
        status: "pass" as const,
        checks: [],
        testedAt: new Date().toISOString(),
      }),
    });

    registerServerAdapter({
      type: RATE_LIMIT_429_TEST_ADAPTER,
      execute: async () => ({
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: RATE_LIMIT_429_ERROR_MESSAGE,
        resultJson: { ...RATE_LIMIT_429_RESULT_JSON } as Record<string, unknown>,
        retryNotBefore: sharedCapacityFloor.toISOString(),
      }),
      testEnvironment: async () => ({
        status: "pass" as const,
        checks: [],
        testedAt: new Date().toISOString(),
      }),
    });
  }, 240_000);

  afterAll(async () => {
    unregisterServerAdapter(SHARED_FLOOR_TEST_ADAPTER);
    unregisterServerAdapter(RATE_LIMIT_429_TEST_ADAPTER);
    await cleanupHeartbeatTestState(db, heartbeat, {
      errorLabel: "PEN-2509 shared-floor cohort cleanup",
      drainTimeoutMs: 30_000,
    });
    await tempDb?.cleanup();
  });

  async function seedAgent(adapterType: string = SHARED_FLOOR_TEST_ADAPTER) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `SharedFloor ${agentId.slice(0, 8)}`,
      role: "engineer",
      status: "idle",
      adapterType,
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    return agentId;
  }

  it("parks each run past the shared floor but not on the same instant", async () => {
    const COHORT = 8;
    const agentIds: string[] = [];
    for (let i = 0; i < COHORT; i += 1) agentIds.push(await seedAgent());

    const originRunIds: string[] = [];
    for (const agentId of agentIds) {
      const run = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
      await heartbeat.__test_executeRunForTesting(run.id);
      originRunIds.push(run.id);
    }

    const parked = [];
    for (const runId of originRunIds) {
      const row = await db
        .select({
          scheduledRetryAt: heartbeatRuns.scheduledRetryAt,
          scheduledRetryReason: heartbeatRuns.scheduledRetryReason,
          contextSnapshot: heartbeatRuns.contextSnapshot,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.retryOfRunId, runId))
        .then((rows) => rows[0] ?? null);
      expect(row, `run ${runId} should have parked a scheduled retry`).not.toBeNull();
      expect(row!.scheduledRetryReason).toBe("transient_failure");
      parked.push(row!);
    }

    const dueMs = parked.map((row) => row.scheduledRetryAt!.getTime());

    // The floor is still honoured: nothing probes before the advertised reset.
    // This is the invariant that forbids subtracting jitter.
    for (const ms of dueMs) {
      expect(ms).toBeGreaterThanOrEqual(sharedFloor.getTime());
      expect(ms).toBeLessThanOrEqual(sharedFloor.getTime() + TRANSIENT_RETRY_FLOOR_JITTER_MAX_MS);
    }

    // Provenance lives on the ORIGIN run's resultJson, not the successor's:
    // `readTransientRecoveryContractFromRun` reads the failed run, and the
    // successor is created fresh, so it carries no adapter result at all.
    //
    // The unjittered floor is NOT lost, though — the successor preserves it in
    // `contextSnapshot.transientRetryNotBefore` (pinned by the existing
    // assertions in heartbeat-retry-scheduling.test.ts, which still compare it
    // exactly and still pass under jitter). So an operator auditing a parked row
    // can still recover the instant the cohort was dispersed from; it is simply
    // in the snapshot rather than the result. Both halves are asserted here so
    // neither can rot.
    for (const runId of originRunIds) {
      const origin = await db
        .select({ resultJson: heartbeatRuns.resultJson })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      const resultJson = (origin?.resultJson ?? {}) as Record<string, unknown>;
      expect(resultJson.retryNotBefore).toBe(sharedFloor.toISOString());
    }
    for (const row of parked) {
      const snapshot = (row.contextSnapshot ?? {}) as Record<string, unknown>;
      expect(snapshot.transientRetryNotBefore).toBe(sharedFloor.toISOString());
    }

    // The acceptance criterion, measured the way the census measures it.
    // On master this spread is 0 and `distinct` is 1.
    const spreadMs = Math.max(...dueMs) - Math.min(...dueMs);
    const distinct = new Set(dueMs).size;
    expect(distinct, `cohort of ${COHORT} collapsed onto ${distinct} instant(s)`).toBe(COHORT);
    expect(spreadMs, "a wake cohort must span more than one second").toBeGreaterThan(1_000);

    // Uses real Math.random, so state the flake budget rather than leaving it
    // implicit: 8 draws uniform over a 300s window collapse inside 1s with
    // probability ~8*(1/300)^7 = 3e-17. The deterministic bounds are pinned in
    // the `jitterTransientRetryFloor` suite above; this arm exists to prove the
    // wiring, and the loose threshold is what keeps it non-flaky.
  }, 240_000);

  // PEN-2509 reopen (2026-10-13). The case above never herded in production,
  // because a hintless 503 writes no capacity provenance. THIS one did: the
  // original fix exempted any row carrying `providerCapacityResetProvenance`,
  // and the finalize path writes that marker for a 429-substantiated structured
  // hint while still adopting the advertised instant verbatim.
  //
  // Measured consequence before this narrowing: 20.4% of 749 `transient_failure`
  // parks across 8 agents landed on a whole second (~0.1% by chance), 152/153 of
  // them on a 10-minute grid, with cohorts of up to 6 agents sharing one instant
  // to 0.000s.
  //
  // This is the end-to-end arm: the predicate unit tests prove the decision, and
  // this proves the decision reaches `scheduledRetryAt` through the real
  // finalize + schedule path rather than only through a hand-built row.
  it("disperses a provenance-marked cohort whose capacity clamp did not apply", async () => {
    const COHORT = 8;
    const agentIds: string[] = [];
    const originResultJson: Record<string, unknown>[] = [];
    for (let i = 0; i < COHORT; i += 1) agentIds.push(await seedAgent(RATE_LIMIT_429_TEST_ADAPTER));

    const originRunIds: string[] = [];
    for (const agentId of agentIds) {
      const run = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
      await heartbeat.__test_executeRunForTesting(run.id);
      originRunIds.push(run.id);
    }

    // The fixture only reproduces the bug if the finalize path really did take
    // the branch this test is about. Assert that directly rather than assuming
    // it: provenance present (so the OLD predicate would have exempted the row)
    // AND no clamp marker (so the floor is the raw advertised instant). If a
    // future change makes the capacity clamp apply here, these fail loudly
    // instead of leaving a test that passes for the wrong reason.
    for (const runId of originRunIds) {
      const origin = await db
        .select({ resultJson: heartbeatRuns.resultJson })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      const resultJson = (origin?.resultJson ?? {}) as Record<string, unknown>;
      expect(
        resultJson.providerCapacityResetProvenance,
        "fixture must reproduce the provenance marker the old predicate exempted on",
      ).toBeTruthy();
      expect(
        resultJson[CCROTATE_CAPACITY_PARK_CLAMPED_FROM_KEY],
        "fixture must NOT be capacity-clamped, or it is testing the exempt path",
      ).toBeUndefined();
      expect(resultJson.retryNotBefore).toBe(sharedCapacityFloor.toISOString());
      originResultJson.push(resultJson);
    }

    const dueMs: number[] = [];
    for (const runId of originRunIds) {
      const row = await db
        .select({
          scheduledRetryAt: heartbeatRuns.scheduledRetryAt,
          scheduledRetryReason: heartbeatRuns.scheduledRetryReason,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.retryOfRunId, runId))
        .then((rows) => rows[0] ?? null);
      expect(row, `run ${runId} should have parked a scheduled retry`).not.toBeNull();
      expect(row!.scheduledRetryReason).toBe("transient_failure");
      dueMs.push(row!.scheduledRetryAt!.getTime());
    }

    // Forward-only, and bounded by the jitter cap: the advertised reset is still
    // honoured and the park is not pushed past the window this fix sizes.
    for (const ms of dueMs) {
      expect(ms).toBeGreaterThanOrEqual(sharedCapacityFloor.getTime());
      expect(ms).toBeLessThanOrEqual(
        sharedCapacityFloor.getTime() + TRANSIENT_RETRY_FLOOR_JITTER_MAX_MS,
      );
    }

    // The acceptance criterion. On the pre-narrowing predicate this spread is 0
    // and `distinct` is 1 — that is the production reading this ticket reopened
    // on, reproduced in-process.
    const distinct = new Set(dueMs).size;
    const spreadMs = Math.max(...dueMs) - Math.min(...dueMs);
    expect(distinct, `cohort of ${COHORT} collapsed onto ${distinct} instant(s)`).toBe(COHORT);
    expect(spreadMs, "a wake cohort must span more than one second").toBeGreaterThan(1_000);

    // Flake budget, stated as above. The window here is min(300s*0.2, 300s) =
    // 60s rather than 300s, so 8 draws collapse inside 1s with probability
    // ~8*(1/60)^7 = 2.9e-11. Still far below any threshold worth engineering
    // around, and the deterministic bounds live in the unit suite.
    //
    // ALSO the whole-second instrument the reopen adjudication adopts: a
    // verbatim provider floor lands on `.000` with p=1, a jittered one with
    // p~1/1000. Asserting it here ties the production instrument to the code.
    const wholeSecond = dueMs.filter((ms) => ms % 1000 === 0).length;
    expect(wholeSecond, "a dispersed cohort must not land on whole seconds").toBeLessThanOrEqual(1);

    // Named last on purpose. This is the decision the assertions above are a
    // consequence of, so asserting it first would make a pre-fix run fail here
    // with "expected true to be false" and hide the thing worth seeing — the
    // cohort collapsing onto one instant, which is the production reading.
    for (const resultJson of originResultJson) {
      expect(isCapacityGovernedRetryFloor(resultJson)).toBe(false);
    }
  }, 240_000);
});
