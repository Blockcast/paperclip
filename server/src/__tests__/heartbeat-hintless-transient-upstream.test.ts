// BLO-18285 — companion to BLO-18278.
//
// BLO-18278 covers transient provider faults that carry a retry-after /
// capacity-reset hint. This file covers the variant that carries NO hint at
// all: a gateway 503 brownout. Live proof it stranded on master is BLO-18138
// run 05d8c03e, whose log ends:
//
//   {"subtype":"api_retry","attempt":10,"max_retries":10,
//    "retry_delay_ms":35039,"error_status":503,"error":"server_error"}
//   API Error: 503 Service temporarily unavailable. ...
//
// All 10 in-process SDK retries burned in ~4 minutes with nothing to honor,
// then BackoffLimitExceeded -> job_failed -> stranded_assigned_issue.
//
// The fix classifies that shape as errorFamily `transient_upstream` at
// finalization, which routes it into the bounded exponential curve
// (2m/10m/30m/2h) and parks it in a `scheduled_retry` row. That row is what
// `hasActiveExecutionPath` (recovery/service.ts) looks for, so the strand
// sweep skips the issue instead of escalating it.
//
// The end-to-end case below drives the REAL heartbeat finalization through a
// registered test adapter rather than re-implementing the override chain, so
// it cannot drift from production. On master it fails at the poll for a retry
// row: master writes none.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.ts";
import {
  BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS,
  heartbeatService,
  isHintlessTransientUpstreamFault,
  isRateLimitExhausted,
  isRetryableK8sCcrotateThrottleResult,
  shouldScheduleAutomaticRunRetry,
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

// The exact terminal payload BLO-18138 run 05d8c03e carried. Note `error_status`
// (the per-attempt `api_retry` field), NOT `api_error_status` — matching only the
// latter misses this run, which is why both surfaces are checked.
const BLO_18138_RESULT_JSON = {
  subtype: "api_retry",
  attempt: 10,
  max_retries: 10,
  retry_delay_ms: 35039,
  error_status: 503,
  error: "server_error",
} as const;

const BLO_18138_ERROR_MESSAGE =
  "API Error: 503 Service temporarily unavailable. This is a server-side issue, usually " +
  "temporary — try again in a moment. If it persists, check your inference gateway (api.penstock.run).";

describe("isHintlessTransientUpstreamFault", () => {
  it("matches the BLO-18138 gateway-503 payload on the error_status surface", () => {
    expect(isHintlessTransientUpstreamFault(BLO_18138_RESULT_JSON)).toBe(true);
  });

  it("matches the 503 API Error text when only an errorMessage survives", () => {
    expect(isHintlessTransientUpstreamFault(null, { errorMessage: BLO_18138_ERROR_MESSAGE })).toBe(true);
  });

  it("matches the SDK's final-event api_error_status surface too", () => {
    expect(isHintlessTransientUpstreamFault({ api_error_status: 503 })).toBe(true);
    expect(isHintlessTransientUpstreamFault({ api_error_status: "503" })).toBe(true);
  });

  it("matches 529 overloaded", () => {
    expect(isHintlessTransientUpstreamFault({ api_error_status: 529 })).toBe(true);
    expect(isHintlessTransientUpstreamFault(null, { errorMessage: "overloaded_error" })).toBe(true);
    expect(isHintlessTransientUpstreamFault(null, { errorMessage: "server overloaded, retry" })).toBe(true);
  });

  it("does not fire on a clean or unrelated failure", () => {
    expect(isHintlessTransientUpstreamFault(null)).toBe(false);
    expect(isHintlessTransientUpstreamFault({})).toBe(false);
    expect(isHintlessTransientUpstreamFault({ result: "ok", is_error: false })).toBe(false);
    // 500 is a real server bug, not a brownout — it must stay terminal.
    expect(isHintlessTransientUpstreamFault({ api_error_status: 500 })).toBe(false);
    expect(isHintlessTransientUpstreamFault(null, { errorMessage: "TypeError: x is not a function" })).toBe(false);
  });

  // The rate-limit family owns 429/quota and uses a flat 90s curve, because the
  // ccrotate gate (not backoff) decides when a closed account window reopens.
  // Widening this predicate into that territory would swap the correct schedule
  // for a 2h one, so the two classifiers must stay disjoint.
  it("stays disjoint from the rate-limit family", () => {
    const rateLimited = [
      { resultJson: { api_error_status: 429 }, errorMessage: null },
      { resultJson: null, errorMessage: "You've hit your limit" },
      { resultJson: null, errorMessage: "You're out of extra usage" },
      { resultJson: { api_error_status: 401 }, errorMessage: null },
    ];
    for (const input of rateLimited) {
      expect(isRateLimitExhausted(input.resultJson, { errorMessage: input.errorMessage })).toBe(true);
      expect(
        isHintlessTransientUpstreamFault(input.resultJson, { errorMessage: input.errorMessage }),
      ).toBe(false);
    }
  });

  // Guards the ordering assumption in the finalize override chain: the k8s
  // ccrotate-throttle check runs first and must NOT claim a hint-less 503,
  // otherwise the run would be tagged rate_limit_exhausted and take the flat
  // 90s curve instead of the exponential one this fix intends.
  it("is not already claimed by the k8s ccrotate throttle classifier", () => {
    expect(
      isRetryableK8sCcrotateThrottleResult({
        errorMessage: BLO_18138_ERROR_MESSAGE,
        resultJson: BLO_18138_RESULT_JSON as unknown as Record<string, unknown>,
      }),
    ).toBe(false);
  });
});

describe("shouldScheduleAutomaticRunRetry for a hint-less transient upstream run", () => {
  const contextSnapshot = { issueId: randomUUID(), wakeReason: "issue_assigned" };

  it("retries once the run is tagged transient_upstream", () => {
    expect(
      shouldScheduleAutomaticRunRetry({
        errorCode: "provider_transient_upstream",
        resultJson: { errorFamily: "transient_upstream" },
        contextSnapshot,
      }),
    ).toBe(true);
  });

  it("resolves the family from the errorCode alone when resultJson is trimmed", () => {
    expect(
      shouldScheduleAutomaticRunRetry({
        errorCode: "provider_transient_upstream",
        resultJson: {},
        contextSnapshot,
      }),
    ).toBe(true);
  });

  // This is the master behaviour the fix removes: the same fault, left
  // untagged, is not retryable, which is exactly how BLO-18138 stranded.
  it("documents that an untagged adapter_failed run is NOT retryable", () => {
    expect(
      shouldScheduleAutomaticRunRetry({
        errorCode: "adapter_failed",
        resultJson: {},
        contextSnapshot,
      }),
    ).toBe(false);
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const HINTLESS_503_TEST_ADAPTER = "hintless_transient_upstream_test";
const PLAIN_FAILURE_TEST_ADAPTER = "hintless_transient_upstream_control_test";

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres hint-less transient upstream tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
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

describeEmbeddedPostgres("hint-less gateway 503 does not strand", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-hintless-transient-upstream-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);

    const testEnvironment = (type: string) => async () => ({
      adapterType: type,
      status: "pass" as const,
      checks: [],
      testedAt: new Date().toISOString(),
    });

    // Emits exactly what a claude_k8s run sees when the gateway browns out:
    // a non-zero exit and the 503 text, with NO errorCode, NO errorFamily and
    // NO retryNotBefore — nothing for the server to honor.
    registerServerAdapter({
      type: HINTLESS_503_TEST_ADAPTER,
      execute: async () => ({
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: BLO_18138_ERROR_MESSAGE,
        resultJson: { ...BLO_18138_RESULT_JSON } as Record<string, unknown>,
      }),
      testEnvironment: testEnvironment(HINTLESS_503_TEST_ADAPTER),
    });

    // Control: an ordinary failure with no transient signature at all.
    registerServerAdapter({
      type: PLAIN_FAILURE_TEST_ADAPTER,
      execute: async () => ({
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: "TypeError: cannot read property 'id' of undefined",
        resultJson: { subtype: "error", error: "assertion_failed" } as Record<string, unknown>,
      }),
      testEnvironment: testEnvironment(PLAIN_FAILURE_TEST_ADAPTER),
    });
  }, 120_000);

  afterAll(async () => {
    unregisterServerAdapter(HINTLESS_503_TEST_ADAPTER);
    unregisterServerAdapter(PLAIN_FAILURE_TEST_ADAPTER);
    await cleanupHeartbeatTestState(db, heartbeat, {
      errorLabel: "hint-less transient upstream cleanup",
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
      name: `Gateway503 ${agentId.slice(0, 8)}`,
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

  it("classifies the fault and schedules a bounded retry instead of stranding", async () => {
    const { agentId } = await seedAgent(HINTLESS_503_TEST_ADAPTER);
    const startedAt = Date.now();

    const run = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(run).not.toBeNull();

    const failedRun = await waitForRunToFinish(heartbeat, run!.id);
    expect(failedRun?.status).toBe("failed");
    expect(failedRun?.errorCode).toBe("provider_transient_upstream");
    expect((failedRun?.resultJson as Record<string, unknown> | null)?.errorFamily).toBe(
      "transient_upstream",
    );

    // On master this poll times out at 0: no retry row is ever written, the
    // strand sweep finds no active execution path, and the issue is escalated
    // to `stranded_assigned_issue`.
    await expect
      .poll(() => countRetriesOf(run!.id), { timeout: 5_000, interval: 50 })
      .toBe(1);

    const retryRun = await db
      .select({
        status: heartbeatRuns.status,
        scheduledRetryAt: heartbeatRuns.scheduledRetryAt,
        scheduledRetryReason: heartbeatRuns.scheduledRetryReason,
        scheduledRetryAttempt: heartbeatRuns.scheduledRetryAttempt,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.retryOfRunId, run!.id))
      .then((rows) => rows[0] ?? null);

    // `scheduled_retry` is the explicit waiting posture the AC asks for, and is
    // one of the statuses hasActiveExecutionPath treats as "still alive".
    expect(retryRun?.status).toBe("scheduled_retry");
    expect(retryRun?.scheduledRetryReason).toBe("transient_failure");
    expect(retryRun?.scheduledRetryAttempt).toBe(1);
    expect((retryRun?.contextSnapshot as Record<string, unknown> | null)?.errorFamily).toBe(
      "transient_upstream",
    );

    // The exponential curve, not the flat 90s rate-limit one: with no hint to
    // honor, the horizon itself is the fix. First hop is 2m ±25% jitter, and
    // the full chain runs 2m/10m/30m/2h — materially past the ~4 minutes the
    // in-process SDK retries covered before the run died.
    const firstDelayMs = BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS[0];
    const scheduledInMs = (retryRun?.scheduledRetryAt?.getTime() ?? 0) - startedAt;
    expect(scheduledInMs).toBeGreaterThan(firstDelayMs * 0.7);
    expect(scheduledInMs).toBeLessThan(firstDelayMs * 1.3);

    const totalHorizonMs = BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);
    expect(totalHorizonMs).toBeGreaterThan(30 * 60 * 1000);
  }, 60_000);

  it("leaves an ordinary failure terminal, so the fix is not a blanket retry", async () => {
    const { agentId } = await seedAgent(PLAIN_FAILURE_TEST_ADAPTER);

    const run = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(run).not.toBeNull();

    const failedRun = await waitForRunToFinish(heartbeat, run!.id);
    expect(failedRun?.status).toBe("failed");
    expect(failedRun?.errorCode).toBe("adapter_failed");
    expect((failedRun?.resultJson as Record<string, unknown> | null)?.errorFamily ?? null).toBeNull();

    // Give the scheduler the same window the positive case needed, then assert
    // nothing was scheduled.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(await countRetriesOf(run!.id)).toBe(0);
  }, 60_000);
});
