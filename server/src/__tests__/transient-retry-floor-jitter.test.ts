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

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-pen2509-shared-floor-");
    db = createDb(tempDb!.connectionString);
    heartbeat = heartbeatService(db, { skipQueuedRunDispatch: true });
    sharedFloor = new Date(Date.now() + 4.5 * 60 * 60 * 1000);

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
  }, 240_000);

  afterAll(async () => {
    unregisterServerAdapter(SHARED_FLOOR_TEST_ADAPTER);
    await cleanupHeartbeatTestState(db, heartbeat, {
      errorLabel: "PEN-2509 shared-floor cohort cleanup",
      drainTimeoutMs: 30_000,
    });
    await tempDb?.cleanup();
  });

  async function seedAgent() {
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
      adapterType: SHARED_FLOOR_TEST_ADAPTER,
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
          resultJson: heartbeatRuns.resultJson,
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

    // Provenance lives on the ORIGIN run, not the parked successor.
    // `readTransientRecoveryContractFromRun` reads the failed run's resultJson,
    // and the successor is created fresh — it has not executed, so it carries no
    // adapter result at all. Asserting it here would be asserting `undefined`.
    //
    // ⚠️ Worth stating plainly rather than burying: this means the unjittered
    // floor is NOT recoverable from the parked row alone. An operator auditing
    // `paperclipListParkedAgents` — which is exactly how this defect was found —
    // sees the successor, so they can observe that a cohort is dispersed but
    // cannot recover the instant it was dispersed from. That is an acceptable
    // trade (dispersion is the goal, and the origin row retains the floor), but
    // it is a real observability limit and not the "derivable from the row
    // alone" property an earlier draft of this test claimed.
    for (const runId of originRunIds) {
      const origin = await db
        .select({ resultJson: heartbeatRuns.resultJson })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      const resultJson = (origin?.resultJson ?? {}) as Record<string, unknown>;
      expect(resultJson.retryNotBefore).toBe(sharedFloor.toISOString());
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
});
