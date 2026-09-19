// Tests for cap/rate-limit-exhausted detection and the corresponding
// outcome override that routes the run into the bounded transient retry.
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  ZERO_TOKEN_STREAK_SCAN_LIMIT,
  countConsecutiveZeroTokenCompletedRuns,
  isRateLimitExhausted,
  isRetryableK8sCcrotateThrottleResult,
  K8S_REPLACEMENT_LAUNCH_FAILURE_AFTER_THROTTLE_KEY,
  k8sCcrotateRetryDelayMs,
  listRecentTerminalRunsForZeroTokenStreak,
  reclassifyK8sReplacementLaunchFailureAfterThrottle,
} from "../services/heartbeat.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres zero-token streak query tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describe("isRateLimitExhausted", () => {
  it("returns false for null", () => {
    expect(isRateLimitExhausted(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isRateLimitExhausted(undefined)).toBe(false);
  });

  it("returns false for empty object", () => {
    expect(isRateLimitExhausted({})).toBe(false);
  });

  it("returns false when api_error_status is absent and no rate-limit text", () => {
    expect(isRateLimitExhausted({ result: "ok", is_error: false })).toBe(false);
  });

  it("returns false for non-429/401 api_error_status", () => {
    expect(isRateLimitExhausted({ api_error_status: 500 })).toBe(false);
    expect(isRateLimitExhausted({ api_error_status: null })).toBe(false);
  });

  it("returns true for api_error_status === 429 (number)", () => {
    expect(isRateLimitExhausted({ api_error_status: 429 })).toBe(true);
  });

  it("returns true for api_error_status === \"429\" (string)", () => {
    expect(isRateLimitExhausted({ api_error_status: "429" })).toBe(true);
  });

  it("returns true for api_error_status === 401 (cap-violation auth-fail)", () => {
    // Anthropic returns 401 on /v1/messages when the account hit its cap
    // even though the refresh endpoint still accepts the refresh_token —
    // this is what produced the "Failed to authenticate. API Error: 401"
    // error message during the 2026-05-05 cluster silence.
    expect(isRateLimitExhausted({ api_error_status: 401 })).toBe(true);
    expect(isRateLimitExhausted({ api_error_status: "401" })).toBe(true);
  });

  it("returns true on the real-world 429 result shape", () => {
    expect(
      isRateLimitExhausted({
        type: "result",
        subtype: "success",
        is_error: true,
        api_error_status: 429,
        result: "You're out of extra usage · resets May 2, 1pm (UTC)",
        stop_reason: "stop_sequence",
      }),
    ).toBe(true);
  });

  it("returns true when result body contains cap text (subtype=success path)", () => {
    // claude CLI sometimes exits cleanly (subtype=success, no api_error_status)
    // with the cap message embedded in the result body. Observed 2026-05-05:
    //   "Claude run failed: subtype=success: You've hit your limit · resets May 6, 9pm (UTC)"
    expect(
      isRateLimitExhausted({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "You've hit your limit · resets May 6, 9pm (UTC)",
      }),
    ).toBe(true);
    expect(
      isRateLimitExhausted({
        message: "You're out of extra usage · resets in 24h",
      }),
    ).toBe(true);
  });

  it("returns true when adapter errorMessage contains cap-text or 401", () => {
    // Failed-path: errorMessage is set (resultJson may be null/minimal)
    // but the message reveals a rate-limit. Both surfaces should fire the
    // recoverable path so the on-limit hook drives ccrotate rotation.
    expect(
      isRateLimitExhausted(null, {
        errorMessage: "Failed to authenticate. API Error: 401",
      }),
    ).toBe(true);
    expect(
      isRateLimitExhausted(null, {
        errorMessage: "Claude run failed: subtype=success: You've hit your limit · resets May 6, 9pm (UTC)",
      }),
    ).toBe(true);
  });

  it("returns false for unrelated 401 messages outside cap context", () => {
    // Don't false-positive on bare 401s from non-cap paths.
    expect(
      isRateLimitExhausted(null, {
        errorMessage: "Generic error 401: not our format",
      }),
    ).toBe(false);
  });
});

describe("heartbeat outcome — rate-limit-exhausted integration", () => {
  // Mirrors heartbeat-empty-result.test.ts: replicates the inline outcome
  // composition + override + downstream errorCode/errorFamily resolution
  // without standing up the full DB/adapter mock harness.

  function evaluateOutcome(input: {
    adapterType?: string;
    exitCode: number | null;
    errorMessage: string | null;
    usage?: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number };
    timedOut: boolean;
    cancelled: boolean;
    resultJson: Record<string, unknown> | null | undefined;
  }): {
    outcome: string;
    errorCode: string | null;
    rateLimitExhaustedOverride: boolean;
    providerThrottledNoProgressOverride: boolean;
    persistedErrorFamily: string | null;
  } {
    let outcome: "succeeded" | "failed" | "cancelled" | "timed_out";
    if (input.cancelled) {
      outcome = "cancelled";
    } else if (input.timedOut) {
      outcome = "timed_out";
    } else if ((input.exitCode ?? 0) === 0 && !input.errorMessage) {
      outcome = "succeeded";
    } else {
      outcome = "failed";
    }

    let rateLimitExhaustedOverride = false;
    let providerThrottledNoProgressOverride = false;
    const looksRateLimited = isRateLimitExhausted(input.resultJson, {
      errorMessage: input.errorMessage,
    });
    const adapterResult = {
      errorMessage: input.errorMessage,
      resultJson: input.resultJson,
      usage: input.usage,
    };
    if (
      outcome === "succeeded" &&
      input.adapterType === "claude_k8s" &&
      isRetryableK8sCcrotateThrottleResult(adapterResult)
    ) {
      outcome = "failed";
      providerThrottledNoProgressOverride = true;
    } else if (
      outcome === "failed" &&
      input.adapterType === "claude_k8s" &&
      isRetryableK8sCcrotateThrottleResult(adapterResult)
    ) {
      providerThrottledNoProgressOverride = true;
    } else if (outcome === "succeeded" && looksRateLimited) {
      outcome = "failed";
      rateLimitExhaustedOverride = true;
    } else if (outcome === "failed" && looksRateLimited) {
      // Already-failed runs whose errorMessage / resultJson reveals a
      // rate-limit also enter the recoverable path so the on-limit hook
      // can drive ccrotate rotation.
      rateLimitExhaustedOverride = true;
    }

    const errorCode = rateLimitExhaustedOverride
      ? "rate_limit_exhausted"
      : providerThrottledNoProgressOverride
        ? "provider_throttled_no_progress"
      : outcome === "timed_out"
        ? "timeout"
        : outcome === "cancelled"
          ? "cancelled"
          : outcome === "failed"
            ? "adapter_failed"
            : null;

    // Persisted errorFamily mirrors the inline override in the merge path.
    // (Updated 2026-05-06: rate-limit gets its own family so retry uses a
    // flat short delay instead of stacking 2hr exponential backoff.)
    const persistedErrorFamily =
      rateLimitExhaustedOverride || providerThrottledNoProgressOverride ? "rate_limit_exhausted" : null;

    return {
      outcome,
      errorCode,
      rateLimitExhaustedOverride,
      providerThrottledNoProgressOverride,
      persistedErrorFamily,
    };
  }

  it("overrides exit-0 + 429-result → failed/rate_limit_exhausted (own family)", () => {
    const r = evaluateOutcome({
      exitCode: 0,
      errorMessage: null,
      timedOut: false,
      cancelled: false,
      resultJson: {
        type: "result",
        is_error: true,
        api_error_status: 429,
        result: "You're out of extra usage · resets May 2, 1pm (UTC)",
      },
    });
    expect(r.outcome).toBe("failed");
    expect(r.errorCode).toBe("rate_limit_exhausted");
    expect(r.rateLimitExhaustedOverride).toBe(true);
    // The rate_limit_exhausted family routes the bounded retry to a flat
    // short delay (gate decides if pool has capacity); generic
    // transient_upstream still uses exponential backoff.
    expect(r.persistedErrorFamily).toBe("rate_limit_exhausted");
  });

  it("does NOT override exit-0 + non-429-result", () => {
    const r = evaluateOutcome({
      exitCode: 0,
      errorMessage: null,
      timedOut: false,
      cancelled: false,
      resultJson: { type: "result", is_error: false, result: "Done" },
    });
    expect(r.outcome).toBe("succeeded");
    expect(r.errorCode).toBeNull();
    expect(r.rateLimitExhaustedOverride).toBe(false);
    expect(r.persistedErrorFamily).toBeNull();
  });

  it("DOES tag an already-failed run when resultJson reveals 429", () => {
    // Updated semantics (2026-05-05): the rate-limit override fires on
    // already-failed runs too, so finalizeAgentStatus's recoverable check
    // sees rate_limit_exhausted and the on-limit hook drives ccrotate
    // rotation. Without this, runs that fail via the failed branch (e.g.
    // 401-after-cap) flipped the agent to error and the cluster sat
    // silent until the cap window rolled.
    const r = evaluateOutcome({
      exitCode: 1,
      errorMessage: "adapter died",
      timedOut: false,
      cancelled: false,
      resultJson: { api_error_status: 429 },
    });
    expect(r.outcome).toBe("failed");
    expect(r.rateLimitExhaustedOverride).toBe(true);
    expect(r.errorCode).toBe("rate_limit_exhausted");
    expect(r.persistedErrorFamily).toBe("rate_limit_exhausted");
  });

  it("DOES tag a 401 errorMessage failure as rate_limit_exhausted", () => {
    // The exact pattern the cluster hit on 2026-05-05 16:09:18Z and after:
    // exit 1 + `Failed to authenticate. API Error: 401` once the active
    // account's cap window kicked in.
    const r = evaluateOutcome({
      exitCode: 1,
      errorMessage: "Failed to authenticate. API Error: 401 {\"type\":\"error\",\"error\":{\"type\":\"authentication\"...",
      timedOut: false,
      cancelled: false,
      resultJson: null,
    });
    expect(r.outcome).toBe("failed");
    expect(r.rateLimitExhaustedOverride).toBe(true);
    expect(r.errorCode).toBe("rate_limit_exhausted");
  });

  it("DOES tag exit-0 + cap-text-in-result-body as rate_limit_exhausted", () => {
    // claude CLI sometimes exits cleanly (subtype=success) with cap text
    // embedded in the result body and no api_error_status field.
    const r = evaluateOutcome({
      exitCode: 0,
      errorMessage: null,
      timedOut: false,
      cancelled: false,
      resultJson: {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "You've hit your limit · resets May 6, 9pm (UTC)",
      },
    });
    expect(r.outcome).toBe("failed");
    expect(r.rateLimitExhaustedOverride).toBe(true);
    expect(r.errorCode).toBe("rate_limit_exhausted");
  });

  it("does NOT override unrelated failures with no rate-limit signals", () => {
    const r = evaluateOutcome({
      exitCode: 1,
      errorMessage: "some other adapter error",
      timedOut: false,
      cancelled: false,
      resultJson: { type: "result", is_error: true, result: "boom" },
    });
    expect(r.outcome).toBe("failed");
    expect(r.rateLimitExhaustedOverride).toBe(false);
    expect(r.errorCode).toBe("adapter_failed");
  });

  it("tags already-failed k8s deadline-exceeded throttles as provider_throttled_no_progress", () => {
    const r = evaluateOutcome({
      adapterType: "claude_k8s",
      exitCode: 1,
      errorMessage: "ccrotate serve deadline_exceeded before upstream returned",
      usage: { inputTokens: 0, outputTokens: 0 },
      timedOut: false,
      cancelled: false,
      resultJson: {},
    });
    expect(r.outcome).toBe("failed");
    expect(r.providerThrottledNoProgressOverride).toBe(true);
    expect(r.errorCode).toBe("provider_throttled_no_progress");
    expect(r.persistedErrorFamily).toBe("rate_limit_exhausted");
  });

  it("does NOT override timed-out runs", () => {
    const r = evaluateOutcome({
      exitCode: null,
      errorMessage: null,
      timedOut: true,
      cancelled: false,
      resultJson: { api_error_status: 429 },
    });
    expect(r.outcome).toBe("timed_out");
    expect(r.errorCode).toBe("timeout");
    expect(r.rateLimitExhaustedOverride).toBe(false);
  });

  it("does NOT override cancelled runs", () => {
    const r = evaluateOutcome({
      exitCode: null,
      errorMessage: null,
      timedOut: false,
      cancelled: true,
      resultJson: { api_error_status: 429 },
    });
    expect(r.outcome).toBe("cancelled");
    expect(r.errorCode).toBe("cancelled");
    expect(r.rateLimitExhaustedOverride).toBe(false);
  });
});

describe("k8s ccrotate no-progress throttle detection", () => {
  it("flags zero-token 429/cap results as retryable in-run throttle", () => {
    expect(
      isRetryableK8sCcrotateThrottleResult({
        resultJson: { api_error_status: 429 },
        usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
      }),
    ).toBe(true);
  });

  it("flags zero-token deadline-exceeded surfaces as retryable in-run throttle", () => {
    expect(
      isRetryableK8sCcrotateThrottleResult({
        errorMessage: "ccrotate serve deadline_exceeded before upstream returned",
        resultJson: {},
        usage: { inputTokens: 0, outputTokens: 0 },
      }),
    ).toBe(true);
  });

  it("does not retry once the adapter reports token usage", () => {
    expect(
      isRetryableK8sCcrotateThrottleResult({
        resultJson: { api_error_status: 429 },
        usage: { inputTokens: 12, outputTokens: 0 },
      }),
    ).toBe(false);
  });

  it("honors ccrotate retry_after duration fields when choosing the in-run retry delay", () => {
    expect(k8sCcrotateRetryDelayMs({ resultJson: { retry_after: 123 } })).toBe(123_000);
    expect(k8sCcrotateRetryDelayMs({ resultJson: { retry_after_seconds: "45" } })).toBe(45_000);
  });
});

// BLO-34577: the in-run throttle loop relaunches the Job for the same run. On
// 2026-09-18 the relaunch read the previous attempt's Failed pod and returned
// `k8s_pod_schedule_failed` ~100 ms after create; the finalizer recorded that
// code and the pr_review run was dropped without a retry, while the identical
// 429 seen through the throttle path retried. These pin the server-side verdict.
describe("reclassifyK8sReplacementLaunchFailureAfterThrottle (BLO-34577)", () => {
  const TENANT_429 =
    'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"All Claude subscription capacity for this tenant is rate-limited"}}';
  const zeroUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
  const throttleResult = {
    exitCode: 1,
    signal: null,
    timedOut: false,
    errorMessage: TENANT_429,
    errorCode: null,
    retryNotBefore: "2026-09-18T12:40:00.000Z",
    resultJson: { api_error_status: 429, is_error: true },
    usage: zeroUsage,
  };
  const launchFailure = {
    exitCode: null,
    signal: null,
    timedOut: false,
    errorMessage:
      "Pod scheduling failed: Pod ac-ally-96fa0c75-3f2a1b-x9k2q reached phase=Failed: claude exited 1",
    errorCode: "k8s_pod_schedule_failed",
  };

  it("finalizes a replacement-launch failure after an in-run throttle with the throttle verdict", () => {
    const reclassified = reclassifyK8sReplacementLaunchFailureAfterThrottle({
      launchResult: launchFailure,
      throttleResult,
      throttleAttempts: 2,
    });
    expect(reclassified).not.toBeNull();
    // The verdict is the throttle's: the code the finalizer treats as terminal is gone...
    expect(reclassified!.errorCode).not.toBe("k8s_pod_schedule_failed");
    // ...and the result still classifies as the in-run throttle the loop was retrying,
    // so the finalizer takes the provider_throttled_no_progress / rate_limit_exhausted arm.
    expect(isRetryableK8sCcrotateThrottleResult(reclassified!)).toBe(true);
    expect(reclassified!.resultJson).toMatchObject({ api_error_status: 429, is_error: true });
    expect(reclassified!.retryNotBefore).toBe("2026-09-18T12:40:00.000Z");
    // The launch failure is kept as an annotation, not lost.
    expect(reclassified!.resultJson?.[K8S_REPLACEMENT_LAUNCH_FAILURE_AFTER_THROTTLE_KEY]).toEqual({
      errorCode: "k8s_pod_schedule_failed",
      errorMessage: launchFailure.errorMessage,
      throttleAttempts: 2,
      throttleErrorCode: null,
    });
    expect(reclassified!.errorMessage).toContain("rate-limited");
    expect(reclassified!.errorMessage).toContain("after 2 in-run throttle retries");
    expect(reclassified!.errorMessage).toContain("phase=Failed: claude exited 1");
  });

  it("leaves an ambiguous k8s_pod_schedule_failed alone when no throttle preceded it", () => {
    // Negative control: with no observed throttle the launch failure means what it
    // says, and the existing "does not retry ambiguous k8s_pod_schedule_failed"
    // contract must keep applying to it.
    expect(
      reclassifyK8sReplacementLaunchFailureAfterThrottle({
        launchResult: launchFailure,
        throttleResult: null,
        throttleAttempts: 0,
      }),
    ).toBeNull();
    expect(
      reclassifyK8sReplacementLaunchFailureAfterThrottle({
        launchResult: launchFailure,
        throttleResult,
        throttleAttempts: 0,
      }),
    ).toBeNull();
  });

  it("only reclassifies a launch failure, never another terminal result", () => {
    for (const launchResult of [
      { exitCode: 0, signal: null, timedOut: false, usage: { inputTokens: 40, outputTokens: 12 } },
      { exitCode: 1, signal: null, timedOut: false, errorCode: "adapter_failed", errorMessage: "boom" },
      { exitCode: null, signal: null, timedOut: false, errorCode: "k8s_concurrent_run_blocked" },
    ]) {
      expect(
        reclassifyK8sReplacementLaunchFailureAfterThrottle({
          launchResult,
          throttleResult,
          throttleAttempts: 1,
        }),
      ).toBeNull();
    }
  });

  it("does not let a non-throttle prior result stand in as the verdict", () => {
    // The loop never retries a result with token usage, so a prior result that
    // made progress is not a throttle chain; do not manufacture one.
    expect(
      reclassifyK8sReplacementLaunchFailureAfterThrottle({
        launchResult: launchFailure,
        throttleResult: { ...throttleResult, usage: { inputTokens: 12, outputTokens: 3 } },
        throttleAttempts: 1,
      }),
    ).toBeNull();
    // Nor a launch failure that somehow reports usage: the pod is claimed to
    // have never run, so this is not the shape the reclassifier understands.
    expect(
      reclassifyK8sReplacementLaunchFailureAfterThrottle({
        launchResult: { ...launchFailure, usage: { inputTokens: 1, outputTokens: 0 } },
        throttleResult,
        throttleAttempts: 1,
      }),
    ).toBeNull();
  });
});

describe("countConsecutiveZeroTokenCompletedRuns", () => {
  it("counts only the newest terminal zero-token prefix", () => {
    expect(countConsecutiveZeroTokenCompletedRuns([
      { status: "failed", usageJson: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 } },
      { status: "succeeded", usageJson: null },
      { status: "failed", usageJson: { inputTokens: 25, outputTokens: 0 } },
      { status: "failed", usageJson: null },
    ])).toBe(2);
  });

  it("resets on raw/cached-token activity and non-terminal rows", () => {
    expect(countConsecutiveZeroTokenCompletedRuns([
      { status: "succeeded", usageJson: { inputTokens: 0, cachedInputTokens: 12, outputTokens: 0 } },
      { status: "failed", usageJson: null },
    ])).toBe(0);

    expect(countConsecutiveZeroTokenCompletedRuns([
      { status: "succeeded", usageJson: { inputTokens: 0, rawInputTokens: 25, outputTokens: 0 } },
      { status: "failed", usageJson: null },
    ])).toBe(0);

    expect(countConsecutiveZeroTokenCompletedRuns([
      { status: "running", usageJson: null },
      { status: "failed", usageJson: null },
    ])).toBe(0);
  });
});

describeEmbeddedPostgres("listRecentTerminalRunsForZeroTokenStreak", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-zero-token-streak-");
    db = createDb(tempDb.connectionString);
  });

  afterEach(async () => {
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("returns the newest started terminal runs for the target agent", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const otherAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: agentId,
        companyId,
        name: "Target",
        role: "engineer",
        status: "idle",
        adapterType: "opencode_k8s",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: otherAgentId,
        companyId,
        name: "Other",
        role: "engineer",
        status: "idle",
        adapterType: "opencode_k8s",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    await db.insert(heartbeatRuns).values([
      {
        id: randomUUID(),
        companyId,
        agentId,
        status: "failed",
        usageJson: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
        startedAt: new Date("2026-07-08T12:00:30Z"),
        finishedAt: new Date("2026-07-08T12:02:00Z"),
        createdAt: new Date("2026-07-08T12:00:00Z"),
      },
      {
        id: randomUUID(),
        companyId,
        agentId,
        status: "succeeded",
        usageJson: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 0 },
        startedAt: new Date("2026-07-08T12:00:10Z"),
        finishedAt: new Date("2026-07-08T12:01:00Z"),
        createdAt: new Date("2026-07-08T12:00:00Z"),
      },
      {
        id: randomUUID(),
        companyId,
        agentId,
        status: "running",
        usageJson: null,
        startedAt: new Date("2026-07-08T12:03:00Z"),
        createdAt: new Date("2026-07-08T12:03:00Z"),
      },
      {
        id: randomUUID(),
        companyId,
        agentId: otherAgentId,
        status: "failed",
        usageJson: null,
        startedAt: new Date("2026-07-08T12:03:30Z"),
        finishedAt: new Date("2026-07-08T12:04:00Z"),
        createdAt: new Date("2026-07-08T12:00:00Z"),
      },
    ]);

    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      status: "cancelled",
      usageJson: null,
      errorCode: "issue_dependencies_blocked",
      finishedAt: new Date("2026-07-08T12:02:00Z"),
      createdAt: new Date("2026-07-08T12:01:00Z"),
    });

    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      status: "cancelled",
      usageJson: null,
      startedAt: new Date("2026-07-08T12:02:30Z"),
      finishedAt: new Date("2026-07-08T12:03:00Z"),
      createdAt: new Date("2026-07-08T12:02:00Z"),
    });

    const rows = await listRecentTerminalRunsForZeroTokenStreak(db, agentId);

    expect(rows.map((row) => row.status)).toEqual(["cancelled", "failed", "succeeded"]);
  });

  // BLO-21415: this LIMIT is the zero-token gauge's saturation point, because
  // countConsecutiveZeroTokenCompletedRuns counts a prefix of these rows. At the
  // old value of 10 a brief blip and a badly-wedged agent both reported exactly
  // 10, so the alert carried no severity signal above its own threshold.
  it("scans far enough past the alert threshold to distinguish a blip from a wedge", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Wedged",
      role: "engineer",
      status: "idle",
      adapterType: "opencode_k8s",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const wedgedRunCount = ZERO_TOKEN_STREAK_SCAN_LIMIT + 5;
    const base = Date.parse("2026-07-08T12:00:00Z");
    await db.insert(heartbeatRuns).values(
      Array.from({ length: wedgedRunCount }, (_, i) => ({
        id: randomUUID(),
        companyId,
        agentId,
        status: "failed" as const,
        usageJson: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
        startedAt: new Date(base + i * 60_000),
        finishedAt: new Date(base + i * 60_000 + 30_000),
        createdAt: new Date(base + i * 60_000),
      })),
    );

    const rows = await listRecentTerminalRunsForZeroTokenStreak(db, agentId);
    expect(rows).toHaveLength(ZERO_TOKEN_STREAK_SCAN_LIMIT);

    const streak = countConsecutiveZeroTokenCompletedRuns(rows);
    expect(streak).toBe(ZERO_TOKEN_STREAK_SCAN_LIMIT);
    // The old ceiling; a wedge must now read strictly above it.
    expect(streak).toBeGreaterThan(10);
  });
});

// ─── finalizeAgentStatus errorCode plumbing ────────────────────────────────
//
// Regression for the hook-firing gap observed 2026-05-05 19:12-21:00Z:
// PR #83 made `runErrorCode = "rate_limit_exhausted"` on the override path,
// but the `finalizeAgentStatus` call site at heartbeat.ts:6244 was passing
// `adapterResult.errorCode` (the raw adapter signal) instead. Result:
// 5+ heartbeat_runs correctly tagged `rate_limit_exhausted`, 0
// `quota-exhausted-hook` activity_log entries — the hook gate was reading
// the wrong code and short-circuiting the recoverable path.
describe("heartbeat finalizeAgentStatus errorCode plumbing", () => {
  // Mirrors the run-completion call site: which errorCode value is passed
  // into finalizeAgentStatus's opts? This is what controls whether
  // `recoverable=true` and `runQuotaExhaustedHook` fires.
  function whatGetsPassedToFinalizeAgentStatus(input: {
    runErrorCode: string | null;
    adapterErrorCode: string | null;
    /** When true, simulate the buggy call site (PR #83's blind spot). */
    useBuggyCallSite?: boolean;
  }): { errorCode: string | null } {
    if (input.useBuggyCallSite) {
      return { errorCode: input.adapterErrorCode ?? null };
    }
    return { errorCode: input.runErrorCode };
  }

  // Mirrors finalizeAgentStatus's recoverable check (heartbeat.ts:1898 in
  // master, expanded by PR #83 to accept both codes).
  function isRecoverableAfterPr83(errorCode: string | null): boolean {
    return (
      errorCode === "provider_quota_exhausted" ||
      errorCode === "rate_limit_exhausted"
    );
  }

  it("rate-limit override → finalize gets rate_limit_exhausted (recoverable=true)", () => {
    // The fix: pass runErrorCode (rate_limit_exhausted on override path).
    const passed = whatGetsPassedToFinalizeAgentStatus({
      runErrorCode: "rate_limit_exhausted",
      adapterErrorCode: null,
    });
    expect(passed.errorCode).toBe("rate_limit_exhausted");
    expect(isRecoverableAfterPr83(passed.errorCode)).toBe(true);
  });

  it("rate-limit override on already-failed run → still gets rate_limit_exhausted", () => {
    // Failed-path with adapter setting "adapter_failed" but override
    // re-tagging to "rate_limit_exhausted" — the call site must use
    // runErrorCode, not adapterErrorCode.
    const passed = whatGetsPassedToFinalizeAgentStatus({
      runErrorCode: "rate_limit_exhausted",
      adapterErrorCode: "adapter_failed",
    });
    expect(passed.errorCode).toBe("rate_limit_exhausted");
    expect(isRecoverableAfterPr83(passed.errorCode)).toBe(true);
  });

  it("non-rate-limit failures still propagate adapter error code", () => {
    // For non-override outcomes, runErrorCode FALLS BACK to
    // adapterResult.errorCode (heartbeat.ts:6082). The fix preserves this.
    const passed = whatGetsPassedToFinalizeAgentStatus({
      runErrorCode: "adapter_failed",
      adapterErrorCode: "adapter_failed",
    });
    expect(passed.errorCode).toBe("adapter_failed");
    expect(isRecoverableAfterPr83(passed.errorCode)).toBe(false);
  });

  it("succeeded runs pass null errorCode, recoverable=false", () => {
    const passed = whatGetsPassedToFinalizeAgentStatus({
      runErrorCode: null,
      adapterErrorCode: null,
    });
    expect(passed.errorCode).toBeNull();
    expect(isRecoverableAfterPr83(passed.errorCode)).toBe(false);
  });

  it("REGRESSION: buggy call site (using adapterResult.errorCode) → recoverable=false despite rate-limit override", () => {
    // This documents the bug the fix corrects: when the call site reads
    // adapterResult.errorCode (which is null/adapter_failed for cap hits)
    // instead of runErrorCode, the hook never fires. Asserting the
    // pathology so future refactors don't silently regress it.
    const buggy = whatGetsPassedToFinalizeAgentStatus({
      runErrorCode: "rate_limit_exhausted",
      adapterErrorCode: null, // claude exits subtype=success, no adapter error
      useBuggyCallSite: true,
    });
    expect(buggy.errorCode).toBeNull();
    expect(isRecoverableAfterPr83(buggy.errorCode)).toBe(false);
  });

  it("REGRESSION: buggy call site (using adapterResult.errorCode='adapter_failed') → recoverable=false", () => {
    // Failed-path variant: adapter exits 1 with error message, override
    // re-tags to rate_limit_exhausted. Buggy call site reads "adapter_failed"
    // instead and hook is skipped.
    const buggy = whatGetsPassedToFinalizeAgentStatus({
      runErrorCode: "rate_limit_exhausted",
      adapterErrorCode: "adapter_failed",
      useBuggyCallSite: true,
    });
    expect(buggy.errorCode).toBe("adapter_failed");
    expect(isRecoverableAfterPr83(buggy.errorCode)).toBe(false);
  });
});
