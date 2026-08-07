// BLO-18278 — a provider 429 that advertises WHEN capacity returns must be
// waited out, not retried into and then stranded.
//
// `heartbeat-hintless-transient-upstream.test.ts` (BLO-18285, PR #859) covers
// the sibling case: a gateway 503 carrying nothing to honor. This file covers
// the hint-PRESENT case. Live proof it stranded is run
// 9727eaf0-9cea-461d-9101-f833f8de29fe:
//
//   API Error: Request rejected (429) · BYOS provider capacity for 'anthropic'
//   is temporarily unavailable; capacity may reset at 2026-07-26T21:29:59.782Z;
//   retry in 9571s
//
// The critical detail — and the reason a test that seeds a structured
// `retryNotBefore` would pass on master and prove nothing — is that on the k8s
// adapters the horizon arrives ONLY as that prose. claude-local/codex-local
// parse it adapter-side and hand back a structured `retryNotBefore`, but the
// shipped claude_k8s / opencode_k8s bundles under
// /opt/paperclip-bundled-adapters contain no occurrence of `retryNotBefore`,
// `capacity may reset`, `resume_at` or `retry_after` at all. So the test
// adapters below deliberately emit the message and NOTHING else, exactly as
// claude_k8s does. On master that horizon is dropped, `retryNotBefore`
// persists null, and the run takes the rate-limit family's flat 90s hop —
// ~18x short of the 9571s asked for.
//
// The end-to-end cases drive REAL heartbeat finalization through a registered
// test adapter rather than re-implementing the override chain, so they cannot
// drift from production.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.ts";
import {
  RATE_LIMIT_HEARTBEAT_RETRY_DELAY_MS,
  heartbeatService,
  isHintlessTransientUpstreamFault,
  isRateLimitExhausted,
  parseProviderCapacityResetHorizon,
  resolveProviderCapacityHorizon,
} from "../services/heartbeat.js";
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

// The horizon BLO-18278's run was handed, to the second.
const ADVERTISED_RESET_SECONDS = 9571;

const BLO_18278_ERROR_MESSAGE = (resetIso: string) =>
  `API Error: Request rejected (429) · BYOS provider capacity for 'anthropic' is temporarily ` +
  `unavailable; capacity may reset at ${resetIso}; retry in ${ADVERTISED_RESET_SECONDS}s`;

// What the SDK's final event carries for this fault. `api_error_status` 429 is
// the surface isRateLimitExhausted keys on.
const BLO_18278_RESULT_JSON = { api_error_status: 429 } as const;
const PROVIDER_CAPACITY_RESET_PROVENANCE_SOURCE = "server_parse_provider_capacity_horizon";

// BLO-18285: the horizon production actually emitted, from run b48c8b30 on this
// very issue — 319565s = 88.8h, 3.7x the 24h cap. The cap was calibrated on the
// single ~2h40m sample BLO-18278 observed, so the first longer real window fell
// straight through it.
const OVER_CAP_RETRY_SECONDS = 319565;
const PROVIDER_CAPACITY_MAX_HORIZON_MS = 24 * 60 * 60 * 1000;
// The literal instant run b48c8b30 was handed. Only ever used with that run's
// own clock passed in explicitly — it is in the past now, so a suite that
// replayed it against the live clock would resolve `none` (already elapsed) and
// quietly assert nothing. The e2e adapters below build the same message shape
// around a live-clock instant instead.
const BLO_18285_OVER_CAP_RESET_ISO = "2026-08-06T21:59:59.671Z";
const BLO_18285_OVER_CAP_RUN_STARTED_AT = Date.parse("2026-08-03T05:13:56.000Z");
const BLO_18285_OVER_CAP_MESSAGE = (resetIso: string) =>
  `API Error: Request rejected (429) · BYOS provider capacity for 'anthropic' is temporarily ` +
  `unavailable; capacity may reset at ${resetIso}; retry in ${OVER_CAP_RETRY_SECONDS}s`;
const BLO_18285_OVER_CAP_ERROR_MESSAGE = BLO_18285_OVER_CAP_MESSAGE(BLO_18285_OVER_CAP_RESET_ISO);

describe("parseProviderCapacityResetHorizon", () => {
  const now = Date.parse("2026-07-26T18:50:31.000Z");
  const resetIso = "2026-07-26T21:29:59.782Z";

  it("recovers the absolute horizon from the BLO-18278 message", () => {
    expect(
      parseProviderCapacityResetHorizon({ errorMessage: BLO_18278_ERROR_MESSAGE(resetIso) }, now)?.toISOString(),
    ).toBe(resetIso);
  });

  it("reads the horizon from resultJson text fields too", () => {
    for (const key of ["result", "message", "error", "summary"] as const) {
      expect(
        parseProviderCapacityResetHorizon({ resultJson: { [key]: BLO_18278_ERROR_MESSAGE(resetIso) } }, now)
          ?.toISOString(),
      ).toBe(resetIso);
    }
  });

  it("falls back to the relative `retry in Ns` form when no absolute instant is given", () => {
    const parsed = parseProviderCapacityResetHorizon(
      { errorMessage: "provider capacity unavailable; retry in 9571s" },
      now,
    );
    expect(parsed?.getTime()).toBe(now + ADVERTISED_RESET_SECONDS * 1000);
  });

  it("prefers the absolute instant over the relative one when both are present", () => {
    // Emission-time skew makes "retry in Ns" drift; the timestamp does not.
    const staleRelative = `capacity may reset at ${resetIso}; retry in 30s`;
    expect(parseProviderCapacityResetHorizon({ errorMessage: staleRelative }, now)?.toISOString()).toBe(resetIso);
  });

  it("ignores a horizon that has already elapsed", () => {
    expect(
      parseProviderCapacityResetHorizon(
        { errorMessage: "capacity may reset at 2020-01-01T00:00:00.000Z" },
        now,
      ),
    ).toBeNull();
  });

  it("refuses to park verbatim on an absurd horizon", () => {
    expect(
      parseProviderCapacityResetHorizon({ errorMessage: "capacity may reset at 2031-01-01T00:00:00.000Z" }, now),
    ).toBeNull();
    expect(parseProviderCapacityResetHorizon({ errorMessage: "retry in 999999s" }, now)).toBeNull();
  });

  it("returns null for unrelated failures", () => {
    expect(parseProviderCapacityResetHorizon({ errorMessage: "TypeError: x is not a function" }, now)).toBeNull();
    expect(parseProviderCapacityResetHorizon({ resultJson: null, errorMessage: null }, now)).toBeNull();
  });
});

// BLO-18285. `parseProviderCapacityResetHorizon` answers one question — "may we
// park on this instant verbatim?" — and its `null` therefore says nothing about
// whether a horizon was advertised at all. Callers that route the fault need
// that distinction, because discarding an over-cap horizon drops the run onto
// the flat 90s curve that strands it.
describe("resolveProviderCapacityHorizon separates silence from an over-cap advertisement", () => {
  const now = Date.parse("2026-07-26T18:50:31.000Z");
  const CAP_MS = PROVIDER_CAPACITY_MAX_HORIZON_MS;

  it("reports a within-cap horizon as usable", () => {
    const resetIso = new Date(now + ADVERTISED_RESET_SECONDS * 1000).toISOString();
    const resolved = resolveProviderCapacityHorizon({ errorMessage: BLO_18278_ERROR_MESSAGE(resetIso) }, now);
    expect(resolved.kind).toBe("usable");
    expect(resolved.kind === "usable" && resolved.at.toISOString()).toBe(resetIso);
  });

  it("reports genuine silence as none", () => {
    expect(resolveProviderCapacityHorizon({ errorMessage: "TypeError: x is not a function" }, now).kind).toBe("none");
    expect(resolveProviderCapacityHorizon({ resultJson: null, errorMessage: null }, now).kind).toBe("none");
  });

  // The exact payload from run b48c8b30 on BLO-18285, replayed at that run's
  // own clock: 88.8h out, 3.7x the cap. The message states the window twice —
  // `capacity may reset at 2026-08-06T21:59:59.671Z` and `retry in 319565s`,
  // which agree to 1.3s — and the absolute form is authoritative, so that is
  // the instant reported as advertised. On master this whole reading was
  // indistinguishable from the `none` case above, which is what put it on the
  // 90s curve.
  it("reports the 88.8h b48c8b30 advertisement as over_horizon, parked at the cap", () => {
    const runStartedAt = BLO_18285_OVER_CAP_RUN_STARTED_AT;
    const resolved = resolveProviderCapacityHorizon(
      { errorMessage: BLO_18285_OVER_CAP_ERROR_MESSAGE },
      runStartedAt,
    );
    expect(resolved.kind).toBe("over_horizon");
    if (resolved.kind !== "over_horizon") throw new Error("unreachable");
    expect(resolved.advertisedAt.toISOString()).toBe(BLO_18285_OVER_CAP_RESET_ISO);
    expect(resolved.parkAt.getTime()).toBe(runStartedAt + CAP_MS);

    // The park is far shorter than what was asked for — that is the point. We
    // bound the blast radius of a figure we do not trust, while still never
    // returning inside a window this long the way the 90s curve did.
    expect(resolved.advertisedAt.getTime() - runStartedAt).toBeGreaterThan(CAP_MS * 3);
    expect(resolved.parkAt.getTime()).toBeLessThan(resolved.advertisedAt.getTime());
  });

  it("treats an over-cap absolute timestamp the same way", () => {
    const resolved = resolveProviderCapacityHorizon(
      { errorMessage: "capacity may reset at 2031-01-01T00:00:00.000Z" },
      now,
    );
    expect(resolved.kind).toBe("over_horizon");
    expect(resolved.kind === "over_horizon" && resolved.parkAt.getTime()).toBe(now + CAP_MS);
  });

  // An elapsed horizon describes a window that has already reopened, so there
  // is nothing to wait for — it must stay `none` and take the normal curve
  // rather than being parked for 24h.
  it("keeps an already-elapsed horizon as none, not over_horizon", () => {
    expect(
      resolveProviderCapacityHorizon({ errorMessage: "capacity may reset at 2020-01-01T00:00:00.000Z" }, now).kind,
    ).toBe("none");
  });

  // Ordering guard: a usable horizon anywhere in the candidate set beats an
  // over-cap reading seen earlier, so the remembered over_horizon can never
  // shadow a value we could have parked on exactly.
  it("prefers a usable horizon over an over-cap one seen first", () => {
    const usableIso = new Date(now + 60_000).toISOString();
    const resolved = resolveProviderCapacityHorizon(
      {
        errorMessage: BLO_18285_OVER_CAP_ERROR_MESSAGE,
        resultJson: { result: `capacity may reset at ${usableIso}` },
      },
      now,
    );
    expect(resolved.kind).toBe("usable");
    expect(resolved.kind === "usable" && resolved.at.toISOString()).toBe(usableIso);
  });
});

describe("provider 429 classification (hint-present variant)", () => {
  const resetIso = new Date(Date.now() + ADVERTISED_RESET_SECONDS * 1000).toISOString();

  it("matches the BLO-18278 capacity-429 payload", () => {
    expect(isRateLimitExhausted({ ...BLO_18278_RESULT_JSON })).toBe(true);
  });

  // The mirror of the disjointness assertion in the hint-less file. Together
  // they pin the boundary from both sides: a 429 is never claimed by the
  // hint-less 503 classifier, so it keeps its own family and its own curve, and
  // the hint is what carries it past that curve.
  it("is not claimed by the hint-less transient-upstream classifier", () => {
    expect(isHintlessTransientUpstreamFault({ ...BLO_18278_RESULT_JSON })).toBe(false);
    expect(
      isHintlessTransientUpstreamFault({ ...BLO_18278_RESULT_JSON }, {
        errorMessage: BLO_18278_ERROR_MESSAGE(resetIso),
      }),
    ).toBe(false);
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const HINTED_429_TEST_ADAPTER = "provider_capacity_horizon_test";
const UNHINTED_429_TEST_ADAPTER = "provider_capacity_horizon_control_test";
const STRUCTURED_429_TEST_ADAPTER = "provider_capacity_horizon_structured_test";
const OVER_CAP_429_TEST_ADAPTER = "provider_capacity_horizon_over_cap_test";

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres provider-capacity-horizon tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function waitForRunToFinish(
  heartbeat: ReturnType<typeof heartbeatService>,
  runId: string,
  timeoutMs = 5_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (run && !["queued", "running"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return await heartbeat.getRun(runId);
}

describeEmbeddedPostgres("provider 429 advertising a capacity reset honors that horizon", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  // Fixed for the lifetime of the suite so the adapter closure and the
  // assertions agree on the exact instant.
  const advertisedResetAt = new Date(Date.now() + ADVERTISED_RESET_SECONDS * 1000);
  const advertisedResetIso = advertisedResetAt.toISOString();

  // BLO-18285: the same fault shape, but advertising 88.8h — past the 24h cap.
  // Built off the live clock rather than replaying b48c8b30's literal instant,
  // which is now in the past and would resolve as an elapsed horizon.
  const overCapAdvertisedAt = new Date(Date.now() + OVER_CAP_RETRY_SECONDS * 1000);
  const overCapAdvertisedIso = overCapAdvertisedAt.toISOString();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-provider-capacity-horizon-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);

    const testEnvironment = (type: string) => async () => ({
      adapterType: type,
      status: "pass" as const,
      checks: [],
      testedAt: new Date().toISOString(),
    });

    // Exactly what claude_k8s hands finalization: the 429 status surface and
    // the prose horizon, and NO structured `retryNotBefore` — because the
    // shipped k8s adapter bundle has no code that could produce one. This is
    // what makes the test fail on master.
    registerServerAdapter({
      type: HINTED_429_TEST_ADAPTER,
      execute: async () => ({
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: BLO_18278_ERROR_MESSAGE(advertisedResetIso),
        resultJson: { ...BLO_18278_RESULT_JSON } as Record<string, unknown>,
      }),
      testEnvironment: testEnvironment(HINTED_429_TEST_ADAPTER),
    });

    // Control: the same 429 with the capacity horizon stripped from the server
    // parse surfaces — the shape we get when the provider rejects without
    // advertising a reset. It deliberately tries to smuggle persisted reset
    // fields through adapter-owned resultJson; finalization must strip them.
    registerServerAdapter({
      type: UNHINTED_429_TEST_ADAPTER,
      execute: async () => ({
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: "API Error: Request rejected (429) · provider capacity temporarily unavailable",
        resultJson: {
          ...BLO_18278_RESULT_JSON,
          providerCapacityResetAt: advertisedResetIso,
          providerCapacityResetProvenance: {
            source: PROVIDER_CAPACITY_RESET_PROVENANCE_SOURCE,
            errorFamily: "rate_limit_exhausted",
            observedStatusCode: 429,
          },
        } as Record<string, unknown>,
      }),
      testEnvironment: testEnvironment(UNHINTED_429_TEST_ADAPTER),
    });

    // The structured counterpart: claude-local/codex-local parse the horizon
    // adapter-side and hand back `retryNotBefore`, which makes the server's
    // prose parser skip this result entirely. Before the follow-up fix that
    // meant such a run reached recovery with NO provenance at all and was
    // forced into the generic rate-limit/quota wording — discarding a 429 we
    // can substantiate from `api_error_status` sitting right beside the hint.
    registerServerAdapter({
      type: STRUCTURED_429_TEST_ADAPTER,
      execute: async () => ({
        exitCode: 1,
        signal: null,
        timedOut: false,
        // No prose horizon anywhere — the parser must not be what rescues this.
        errorMessage: "API Error: Request rejected (429) · provider capacity temporarily unavailable",
        retryNotBefore: advertisedResetIso,
        resultJson: { ...BLO_18278_RESULT_JSON } as Record<string, unknown>,
      }),
      testEnvironment: testEnvironment(STRUCTURED_429_TEST_ADAPTER),
    });

    // BLO-18285: identical to HINTED, except the advertised window is 88.8h —
    // past the cap. Same prose shape, same 429 surface, no structured hint.
    registerServerAdapter({
      type: OVER_CAP_429_TEST_ADAPTER,
      execute: async () => ({
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: BLO_18285_OVER_CAP_MESSAGE(overCapAdvertisedIso),
        resultJson: { ...BLO_18278_RESULT_JSON } as Record<string, unknown>,
      }),
      testEnvironment: testEnvironment(OVER_CAP_429_TEST_ADAPTER),
    });
  }, 120_000);

  afterAll(async () => {
    unregisterServerAdapter(HINTED_429_TEST_ADAPTER);
    unregisterServerAdapter(UNHINTED_429_TEST_ADAPTER);
    unregisterServerAdapter(STRUCTURED_429_TEST_ADAPTER);
    unregisterServerAdapter(OVER_CAP_429_TEST_ADAPTER);
    await cleanupHeartbeatTestState(db, heartbeat, {
      errorLabel: "provider capacity horizon cleanup",
      drainTimeoutMs: 30_000,
    });
    await tempDb?.cleanup();
  });

  async function seedAgent(adapterType: string) {
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
      name: `Capacity429 ${agentId.slice(0, 8)}`,
      role: "engineer",
      status: "idle",
      adapterType,
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    return { companyId, agentId };
  }

  function countRetriesOf(runId: string) {
    return db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.retryOfRunId, runId))
      .then((rows) => rows.length);
  }

  function retryRowOf(runId: string) {
    return db
      .select({
        status: heartbeatRuns.status,
        scheduledRetryAt: heartbeatRuns.scheduledRetryAt,
        scheduledRetryReason: heartbeatRuns.scheduledRetryReason,
        scheduledRetryAttempt: heartbeatRuns.scheduledRetryAttempt,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.retryOfRunId, runId))
      .then((rows) => rows[0] ?? null);
  }

  it("schedules the continuation at the advertised reset, not the flat 90s hop", async () => {
    const { agentId } = await seedAgent(HINTED_429_TEST_ADAPTER);

    const run = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(run).not.toBeNull();

    const failedRun = await waitForRunToFinish(heartbeat, run!.id);
    expect(failedRun?.status).toBe("failed");
    expect(failedRun?.errorCode).toBe("rate_limit_exhausted");

    const resultJson = failedRun?.resultJson as Record<string, unknown> | null;
    expect(resultJson?.errorFamily).toBe("rate_limit_exhausted");
    // The horizon was recovered from prose and persisted on both surfaces —
    // the scheduler reads `transientRetryNotBefore`, the recovery sweep reads
    // `retryNotBefore`. On master both are null.
    expect(resultJson?.retryNotBefore).toBe(advertisedResetIso);
    expect(resultJson?.transientRetryNotBefore).toBe(advertisedResetIso);
    expect(resultJson?.providerCapacityResetAt).toBe(advertisedResetIso);
    expect(resultJson?.providerCapacityResetProvenance).toEqual({
      source: PROVIDER_CAPACITY_RESET_PROVENANCE_SOURCE,
      errorFamily: "rate_limit_exhausted",
      observedStatusCode: 429,
      observedStatusField: "api_error_status",
      observedCause: "rate_limit_exhausted",
      horizonSource: "server_prose_parse",
    });

    await expect
      .poll(() => countRetriesOf(run!.id), { timeout: 5_000, interval: 50 })
      .toBe(1);

    const retryRun = await retryRowOf(run!.id);

    // `scheduled_retry` is the explicit waiting posture the AC asks for, and is
    // one of the statuses hasActiveExecutionPath treats as "still alive" —
    // which is what keeps the strand sweep from escalating this issue to
    // `stranded_assigned_issue`. The run never reaches BackoffLimitExceeded.
    expect(retryRun?.status).toBe("scheduled_retry");
    expect(retryRun?.scheduledRetryAttempt).toBe(1);

    // The assertion this file exists for: `dueAt` is the provider's advertised
    // reset exactly, not the family's own hop.
    expect(retryRun?.scheduledRetryAt?.toISOString()).toBe(advertisedResetIso);

    // ...and that is materially beyond the flat 90s the rate-limit family would
    // otherwise have used — the ~18x gap BLO-18278 measured.
    const scheduledInMs = (retryRun?.scheduledRetryAt?.getTime() ?? 0) - Date.now();
    expect(scheduledInMs).toBeGreaterThan(RATE_LIMIT_HEARTBEAT_RETRY_DELAY_MS * 10);
  }, 60_000);

  // The structured sibling of the case above. An adapter that parses the
  // horizon itself skips the server's prose parser, so before this fix it
  // reached recovery with no provenance and lost the 429 diagnosis — on exactly
  // the adapters that report the fault most precisely.
  it("substantiates a structured retryNotBefore paired with an observed 429", async () => {
    const { agentId } = await seedAgent(STRUCTURED_429_TEST_ADAPTER);

    const run = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(run).not.toBeNull();

    const failedRun = await waitForRunToFinish(heartbeat, run!.id, 20_000);
    expect(failedRun?.status).toBe("failed");
    expect(failedRun?.errorCode).toBe("rate_limit_exhausted");

    const resultJson = failedRun?.resultJson as Record<string, unknown> | null;
    expect(resultJson?.errorFamily).toBe("rate_limit_exhausted");
    expect(resultJson?.retryNotBefore).toBe(advertisedResetIso);

    // The horizon is re-derived server-side and re-emitted canonically rather
    // than trusted verbatim, so the value the comment can quote is ours.
    expect(resultJson?.providerCapacityResetAt).toBe(advertisedResetIso);
    expect(resultJson?.providerCapacityResetProvenance).toEqual({
      source: PROVIDER_CAPACITY_RESET_PROVENANCE_SOURCE,
      errorFamily: "rate_limit_exhausted",
      observedStatusCode: 429,
      observedStatusField: "api_error_status",
      observedCause: "rate_limit_exhausted",
      horizonSource: "adapter_structured_retry_not_before",
    });

    // And it still parks at the advertised instant rather than stranding.
    await expect
      .poll(() => countRetriesOf(run!.id), { timeout: 5_000, interval: 50 })
      .toBe(1);
    const retryRun = await retryRowOf(run!.id);
    expect(retryRun?.status).toBe("scheduled_retry");
    expect(retryRun?.scheduledRetryAt?.toISOString()).toBe(advertisedResetIso);
  }, 60_000);

  // Pins the causal claim: it is the advertised horizon, not merely the 429
  // family, that moves the schedule. The same fault without one still parks in
  // `scheduled_retry` (so it does not strand either) but takes the flat hop.
  it("falls back to the flat hop when the same 429 advertises no reset", async () => {    const { agentId } = await seedAgent(UNHINTED_429_TEST_ADAPTER);
    const startedAt = Date.now();

    const run = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(run).not.toBeNull();

    const failedRun = await waitForRunToFinish(heartbeat, run!.id);
    expect(failedRun?.status).toBe("failed");
    expect(failedRun?.errorCode).toBe("rate_limit_exhausted");
    const resultJson = failedRun?.resultJson as Record<string, unknown> | null;
    expect(resultJson?.retryNotBefore ?? null).toBeNull();
    expect(resultJson?.providerCapacityResetAt ?? null).toBeNull();
    expect(resultJson?.providerCapacityResetProvenance ?? null).toBeNull();

    await expect
      .poll(() => countRetriesOf(run!.id), { timeout: 5_000, interval: 50 })
      .toBe(1);

    const retryRun = await retryRowOf(run!.id);
    expect(retryRun?.status).toBe("scheduled_retry");

    const scheduledInMs = (retryRun?.scheduledRetryAt?.getTime() ?? 0) - startedAt;
    expect(scheduledInMs).toBeLessThan(RATE_LIMIT_HEARTBEAT_RETRY_DELAY_MS * 2);
  }, 60_000);

  // BLO-18285. The gap between the two tests above: a 429 that advertises a
  // window PAST the cap. On master the cap collapsed that reading into the same
  // `null` as the no-hint control, so this fault took the flat 90s hop — with
  // 12 attempts that is ~18min of post-gate retries against an 88.8h window,
  // every one of them landing inside it, ending in BackoffLimitExceeded and a
  // `stranded_assigned_issue`. Live proof: run b48c8b30 on BLO-18285 itself.
  //
  // Note what this test does NOT assert. A single over-cap failure parks in
  // `scheduled_retry` on master too — the strand comes from exhausting the
  // chain, not from the first hop — so "did not strand" would pass either way
  // and prove nothing. The load-bearing assertion is the schedule: ~24h out
  // instead of ~90s. That is what makes the chain unable to exhaust inside the
  // window in the first place.
  it("parks an over-cap 429 at the horizon cap instead of discarding it", async () => {
    const { agentId } = await seedAgent(OVER_CAP_429_TEST_ADAPTER);
    const startedAt = Date.now();

    const run = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(run).not.toBeNull();

    const failedRun = await waitForRunToFinish(heartbeat, run!.id, 20_000);
    expect(failedRun?.status).toBe("failed");
    expect(failedRun?.errorCode).toBe("rate_limit_exhausted");

    const resultJson = failedRun?.resultJson as Record<string, unknown> | null;
    expect(resultJson?.errorFamily).toBe("rate_limit_exhausted");

    // Both scheduler surfaces carry the capped park, not the advertised 88.8h
    // instant and not null. On master all three of these are null.
    const parkedIso = resultJson?.retryNotBefore as string | undefined;
    expect(parkedIso).toBeTruthy();
    expect(resultJson?.transientRetryNotBefore).toBe(parkedIso);
    expect(resultJson?.providerCapacityResetAt).toBe(parkedIso);
    expect(parkedIso).not.toBe(overCapAdvertisedIso);

    // Provenance records BOTH numbers: what we parked on, and what was actually
    // asked for. Without the latter the 88.8h advertisement — the whole reason
    // this is not a verbatim park — is unrecoverable from the persisted run.
    expect(resultJson?.providerCapacityResetProvenance).toEqual({
      source: PROVIDER_CAPACITY_RESET_PROVENANCE_SOURCE,
      errorFamily: "rate_limit_exhausted",
      observedStatusCode: 429,
      observedStatusField: "api_error_status",
      observedCause: "rate_limit_exhausted",
      horizonSource: "server_prose_parse_over_horizon_park",
      advertisedResetAt: overCapAdvertisedIso,
      horizonCapMs: PROVIDER_CAPACITY_MAX_HORIZON_MS,
    });

    await expect
      .poll(() => countRetriesOf(run!.id), { timeout: 5_000, interval: 50 })
      .toBe(1);

    const retryRun = await retryRowOf(run!.id);
    expect(retryRun?.status).toBe("scheduled_retry");
    expect(retryRun?.scheduledRetryAt?.toISOString()).toBe(parkedIso);

    // The assertion that fails on master: the continuation sits at the cap,
    // three orders of magnitude past the 90s hop it used to take. Measured from
    // before `invoke`, so the elapsed run time makes it drift slightly past the
    // cap — the park itself is computed at finalization.
    const scheduledInMs = (retryRun?.scheduledRetryAt?.getTime() ?? 0) - startedAt;
    expect(scheduledInMs).toBeGreaterThan(PROVIDER_CAPACITY_MAX_HORIZON_MS * 0.9);
    expect(scheduledInMs).toBeLessThanOrEqual(PROVIDER_CAPACITY_MAX_HORIZON_MS + 60_000);
  }, 60_000);
});
