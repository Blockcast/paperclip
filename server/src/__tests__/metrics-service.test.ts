import { afterEach, describe, expect, it } from "vitest";
import {
  AGENT_NO_USAGE_STREAK_METRIC,
  AUTH_REQUEST_METRIC,
  BACKSTOP_CANDIDATES_SKIPPED_METRIC,
  BACKSTOP_DEFERRED_CANDIDATES_METRIC,
  BACKSTOP_SWEEP_COMPLETED_METRIC,
  CONCURRENT_RUN_BLOCKED_METRIC,
  DEP_BLOCKED_WAKEUP_METRIC,
  ROUTINE_DISPATCH_METRIC,
  HEARTBEAT_RUN_FAILED_METRIC,
  ISOLATED_RUN_STARTED_METRIC,
  KNOWN_BLOCKED_REASONS,
  KNOWN_INVOCATION_SOURCES,
  KNOWN_ISOLATION_MODES,
  UNKNOWN_AGENT_ID,
  UNKNOWN_INVOCATION_SOURCE,
  UNKNOWN_ISOLATION_MODE,
  UNKNOWN_REASON,
  __resetMetricsForTest,
  classifyAuthOperation,
  classifyAuthOutcome,
  classifyAuthResponse,
  normalizeAgentId,
  normalizeInvocationSource,
  normalizeIsolationMode,
  normalizeReason,
  recordConcurrentRunBlocked,
  recordAgentZeroTokenCompletedRunStreak,
  recordAuthRequest,
  recordBackstopCandidateSkipped,
  recordBackstopSweepCompleted,
  recordGbrainRecallOutcome,
  GBRAIN_RECALL_METRIC,
  UNKNOWN_GBRAIN_RECALL_STATUS,
  normalizeGbrainRecallStatus,
  recordHeartbeatRunFailed,
  recordIsolatedRunStarted,
  renderMetrics,
  setBackstopDeferredCandidates,
  EXTERNAL_LIFECYCLE_RUNNING_RUNS_METRIC,
  GITHUB_REVIEW_REQUEST_SUPPRESSION_METRIC,
  GITHUB_SUPPRESSION_CAUSE_REVIEWER_LOCK_CONTENDED,
  UNKNOWN_GITHUB_SUPPRESSION_CAUSE,
  recordGithubReviewRequestSuppressed,
  GITHUB_WORKFLOW_RUN_CONCLUSION_METRIC,
  KNOWN_PROCESS_LOSS_CLASSIFICATIONS,
  KNOWN_WORKFLOW_RUN_CONCLUSIONS,
  PROCESS_LOST_LIVENESS_NULL_METRIC,
  PROCESS_LOST_TOTAL_METRIC,
  QUEUED_RUN_AGE_METRICS_REFRESH_SUCCESS_METRIC,
  QUEUED_RUN_OLDEST_AGE_METRIC,
  UNKNOWN_EXTERNAL_ADAPTER,
  UNKNOWN_PROCESS_LOSS_CLASSIFICATION,
  UNKNOWN_PROCESS_LOST_BUCKET,
  UNKNOWN_WORKFLOW_RUN_CONCLUSION,
  normalizeExternalAdapter,
  normalizeProcessLossClassification,
  normalizeProcessLostBucket,
  normalizeWorkflowRunConclusion,
  normalizeWorkflowRunSupersession,
  recordGithubWorkflowRunConclusion,
  recordProcessLost,
  recordProcessLostLivenessNull,
  setExternalLifecycleRunningRuns,
  EXTERNAL_LIFECYCLE_RUN_SILENCE_GAP_METRIC,
  EXTERNAL_LIFECYCLE_RUN_SILENCE_GAP_LAST_METRIC,
  KNOWN_EXTERNAL_LIFECYCLE_TERMINAL_STATUSES,
  UNKNOWN_EXTERNAL_LIFECYCLE_TERMINAL_STATUS,
  computeExternalLifecycleSilenceGapSeconds,
  normalizeExternalLifecycleTerminalStatus,
  recordExternalLifecycleRunSilenceGap,
  setQueuedRunOldestAgeMetrics,
  setQueuedRunAgeMetricsRefreshSuccess,
  QUEUED_RUN_OLDEST_AGE_METRIC,
  setAgentLivenessMetrics,
  AGENT_HEARTBEAT_AGE_SECONDS_METRIC,
  AGENT_HEARTBEAT_INTERVAL_SECONDS_METRIC,
  AGENT_ERROR_DURATION_SECONDS_METRIC,
  PLUGIN_ERROR_METRIC,
  PLUGIN_STATUS_COLLECTOR_LAST_SUCCESS_METRIC,
  setPluginErrorStatus,
  setPluginStatusCollectorLastSuccessSeconds,
  PR_REVIEW_QUEUE_WAIT_METRIC,
  PR_REVIEW_QUEUE_WAIT_BUCKETS_SECONDS,
  computePrReviewQueueWaitSeconds,
  recordPrReviewQueueWait,
} from "../services/metrics.js";
import {
  incrementRoutineDispatchMetric,
  resetRoutineDispatchMetrics,
  snapshotRoutineDispatchMetrics,
} from "../services/routine-dispatch-metrics.js";
import {
  getDepBlockedMetric,
  incrementDepBlockedMetric,
  resetDepBlockedMetrics,
  snapshotDepBlockedMetrics,
} from "../services/dep-blocked-metrics.js";

afterEach(() => {
  __resetMetricsForTest();
});

describe("PR-review queue-wait metrics (BLO-30623)", () => {
  it("computes only valid pr_review queue waits and ignores other or never-started runs", () => {
    expect(computePrReviewQueueWaitSeconds(
      "pr_review:Blockcast/paperclip:123",
      "2026-08-31T00:00:00.000Z",
      "2026-08-31T01:05:00.000Z",
    )).toBe(3900);
    expect(computePrReviewQueueWaitSeconds("issue_board:123", "2026-08-31T00:00:00Z", "2026-08-31T01:00:00Z")).toBeNull();
    expect(computePrReviewQueueWaitSeconds("pr_review:repo:123", "2026-08-31T00:00:00Z", null)).toBeNull();
    expect(computePrReviewQueueWaitSeconds("pr_review:repo:123", "not-a-date", "2026-08-31T01:00:00Z")).toBeNull();
  });

  it("emits the bounded histogram buckets without unbounded labels", async () => {
    expect(recordPrReviewQueueWait({
      taskKey: "pr_review:Blockcast/paperclip:123",
      createdAt: "2026-08-31T00:00:00.000Z",
      startedAt: "2026-08-31T01:05:00.000Z",
    })).toBe(3900);
    const { body } = await renderMetrics();
    expect(body).toContain(`${PR_REVIEW_QUEUE_WAIT_METRIC}_bucket{le="3600"} 0`);
    expect(body).toContain(`${PR_REVIEW_QUEUE_WAIT_METRIC}_bucket{le="7200"} 1`);
    expect(body).toContain(`${PR_REVIEW_QUEUE_WAIT_METRIC}_count 1`);
    expect(PR_REVIEW_QUEUE_WAIT_BUCKETS_SECONDS).toEqual([60, 300, 600, 900, 1800, 3600, 7200, 14400, 28800]);
    expect(body).not.toContain("Blockcast");
  });
});

describe("authentication request metrics", () => {
  it("classifies auth paths and response outcomes into bounded labels", () => {
    expect(classifyAuthOperation("/api/auth/sign-in/oauth2?next=%2F")).toBe("oidc_start");
    expect(classifyAuthOperation("/api/auth/oauth2/callback/dex?code=redacted")).toBe("oidc_callback");
    expect(classifyAuthOperation("/api/auth/sign-in/email")).toBe("password_sign_in");
    expect(classifyAuthOperation("/api/auth/sign-up/email")).toBe("password_sign_up");
    expect(classifyAuthOperation("/api/auth/sign-out")).toBe("other");
    expect(classifyAuthOutcome(200)).toBe("success");
    expect(classifyAuthOutcome(400)).toBe("client_error");
    expect(classifyAuthOutcome(429)).toBe("rate_limited");
    expect(classifyAuthOutcome(503)).toBe("server_error");
  });

  it("classifies successful and failed OIDC callback redirects", () => {
    expect(classifyAuthResponse({
      operation: "oidc_callback",
      statusCode: 302,
      location: "/",
    })).toBe("success");
    expect(classifyAuthResponse({
      operation: "oidc_callback",
      statusCode: 302,
      location: 0,
    })).toBe("success");
    expect(classifyAuthResponse({
      operation: "oidc_callback",
      statusCode: 302,
      location: "/api/auth/error?error=access_denied&error_description=cancelled",
    })).toBe("client_error");
    expect(classifyAuthResponse({
      operation: "oidc_callback",
      statusCode: 302,
      location: "/api/auth/error?error=oauth_code_verification_failed",
    })).toBe("server_error");
  });

  it("exposes and increments the auth counter without unbounded labels", async () => {
    expect(recordAuthRequest({ operation: "untrusted-path", outcome: "untrusted-outcome" })).toEqual({
      operation: "other",
      outcome: "server_error",
    });
    recordAuthRequest({ operation: "oidc_callback", outcome: "rate_limited" });

    const { body } = await renderMetrics();
    expect(body).toContain(`# TYPE ${AUTH_REQUEST_METRIC} counter`);
    expect(body).toContain(`${AUTH_REQUEST_METRIC}{operation="other",outcome="server_error"} 1`);
    expect(body).toContain(`${AUTH_REQUEST_METRIC}{operation="oidc_callback",outcome="rate_limited"} 1`);
  });
});

describe("normalizeReason", () => {
  it("keeps every known reason", () => {
    for (const reason of KNOWN_BLOCKED_REASONS) {
      expect(normalizeReason(reason)).toBe(reason);
    }
  });

  it("coerces unknown/empty reasons to the bounded fallback", () => {
    expect(normalizeReason("totally_made_up")).toBe(UNKNOWN_REASON);
    expect(normalizeReason("")).toBe(UNKNOWN_REASON);
    expect(normalizeReason(undefined)).toBe(UNKNOWN_REASON);
    expect(normalizeReason(null)).toBe(UNKNOWN_REASON);
  });
});

describe("normalizeAgentId", () => {
  const roster = new Set(["agent-a", "agent-b"]);

  it("keeps ids that are in the active roster", () => {
    expect(normalizeAgentId("agent-a", roster)).toBe("agent-a");
    expect(normalizeAgentId("agent-b", roster)).toBe("agent-b");
  });

  it("coerces ids outside the roster (or empty) to unknown", () => {
    expect(normalizeAgentId("agent-z", roster)).toBe(UNKNOWN_AGENT_ID);
    expect(normalizeAgentId("", roster)).toBe(UNKNOWN_AGENT_ID);
    expect(normalizeAgentId(undefined, roster)).toBe(UNKNOWN_AGENT_ID);
    expect(normalizeAgentId(null, roster)).toBe(UNKNOWN_AGENT_ID);
    // Empty roster => nothing is known => everything collapses.
    expect(normalizeAgentId("agent-a", new Set())).toBe(UNKNOWN_AGENT_ID);
  });
});

describe("recordConcurrentRunBlocked + renderMetrics", () => {
  it("registers the counter so /metrics carries its TYPE line before any event", async () => {
    const { contentType, body } = await renderMetrics();
    expect(contentType).toContain("text/plain");
    expect(body).toContain(`# TYPE ${CONCURRENT_RUN_BLOCKED_METRIC} counter`);
  });

  it("emits the real agent_id for a roster member (isolation_mode defaults to unknown)", async () => {
    const labels = recordConcurrentRunBlocked({
      agentId: "agent-a",
      reason: "live_job_for_unknown_run",
      knownAgentIds: new Set(["agent-a"]),
    });
    expect(labels).toEqual({
      agent_id: "agent-a",
      reason: "live_job_for_unknown_run",
      isolation_mode: "unknown",
    });

    const { body } = await renderMetrics();
    expect(body).toContain(
      `${CONCURRENT_RUN_BLOCKED_METRIC}{agent_id="agent-a",reason="live_job_for_unknown_run",isolation_mode="unknown"} 1`,
    );
  });

  it("collapses an unknown agent id, reason, and isolation_mode (cardinality guardrail)", async () => {
    const labels = recordConcurrentRunBlocked({
      agentId: "spoofed-or-typo",
      reason: "garbage",
      isolationMode: "not-a-mode",
      knownAgentIds: new Set(["agent-a"]),
    });
    expect(labels).toEqual({
      agent_id: UNKNOWN_AGENT_ID,
      reason: UNKNOWN_REASON,
      isolation_mode: UNKNOWN_ISOLATION_MODE,
    });

    const { body } = await renderMetrics();
    expect(body).toContain(
      `${CONCURRENT_RUN_BLOCKED_METRIC}{agent_id="${UNKNOWN_AGENT_ID}",reason="${UNKNOWN_REASON}",isolation_mode="${UNKNOWN_ISOLATION_MODE}"} 1`,
    );
  });

  it("keeps the bounded isolation_mode label and the new isolation-audit reasons", async () => {
    const roster = new Set(["agent-a"]);
    recordConcurrentRunBlocked({
      agentId: "agent-a",
      reason: "shared_mode_serialized",
      isolationMode: "shared",
      knownAgentIds: roster,
    });
    recordConcurrentRunBlocked({
      agentId: "agent-a",
      reason: "unknown_isolation_blocked",
      isolationMode: "workspace",
      knownAgentIds: roster,
    });

    const { body } = await renderMetrics();
    expect(body).toContain(
      `${CONCURRENT_RUN_BLOCKED_METRIC}{agent_id="agent-a",reason="shared_mode_serialized",isolation_mode="shared"} 1`,
    );
    expect(body).toContain(
      `${CONCURRENT_RUN_BLOCKED_METRIC}{agent_id="agent-a",reason="unknown_isolation_blocked",isolation_mode="workspace"} 1`,
    );
  });

  it("accumulates repeated events into the same bounded series", async () => {
    const roster = new Set(["agent-a"]);
    recordConcurrentRunBlocked({ agentId: "agent-a", reason: "live_job_for_active_run", isolationMode: "shared", knownAgentIds: roster });
    recordConcurrentRunBlocked({ agentId: "agent-a", reason: "live_job_for_active_run", isolationMode: "shared", knownAgentIds: roster });

    const { body } = await renderMetrics();
    expect(body).toContain(
      `${CONCURRENT_RUN_BLOCKED_METRIC}{agent_id="agent-a",reason="live_job_for_active_run",isolation_mode="shared"} 2`,
    );
  });
});

describe("normalizeIsolationMode", () => {
  it("keeps every known isolation mode", () => {
    for (const mode of KNOWN_ISOLATION_MODES) {
      expect(normalizeIsolationMode(mode)).toBe(mode);
    }
  });

  it("coerces unknown/empty modes to the bounded fallback", () => {
    expect(normalizeIsolationMode("isolated")).toBe(UNKNOWN_ISOLATION_MODE);
    expect(normalizeIsolationMode("")).toBe(UNKNOWN_ISOLATION_MODE);
    expect(normalizeIsolationMode(undefined)).toBe(UNKNOWN_ISOLATION_MODE);
    expect(normalizeIsolationMode(null)).toBe(UNKNOWN_ISOLATION_MODE);
  });
});

describe("recordIsolatedRunStarted + renderMetrics", () => {
  it("registers the counter TYPE line and bounds its labels", async () => {
    const roster = new Set(["agent-a"]);
    const labels = recordIsolatedRunStarted({
      agentId: "agent-a",
      isolationMode: "workspace",
      knownAgentIds: roster,
    });
    expect(labels).toEqual({ agent_id: "agent-a", isolation_mode: "workspace" });

    const { body } = await renderMetrics();
    expect(body).toContain(`# TYPE ${ISOLATED_RUN_STARTED_METRIC} counter`);
    expect(body).toContain(
      `${ISOLATED_RUN_STARTED_METRIC}{agent_id="agent-a",isolation_mode="workspace"} 1`,
    );
  });

  it("collapses an off-roster agent and bad mode to bounded fallbacks", async () => {
    const labels = recordIsolatedRunStarted({
      agentId: "ghost",
      isolationMode: "nope",
      knownAgentIds: new Set(["agent-a"]),
    });
    expect(labels).toEqual({ agent_id: UNKNOWN_AGENT_ID, isolation_mode: UNKNOWN_ISOLATION_MODE });

    // Symmetry with the blocked-counter tests: confirm the bounded fallback
    // labels actually land on the rendered /metrics series (no "ghost"/"nope").
    const { body } = await renderMetrics();
    expect(body).toContain(
      `${ISOLATED_RUN_STARTED_METRIC}{agent_id="${UNKNOWN_AGENT_ID}",isolation_mode="${UNKNOWN_ISOLATION_MODE}"} 1`,
    );
    expect(body).not.toContain("ghost");
    expect(body).not.toContain('isolation_mode="nope"');
  });
});

describe("normalizeInvocationSource", () => {
  it("keeps every known invocation source", () => {
    for (const source of KNOWN_INVOCATION_SOURCES) {
      expect(normalizeInvocationSource(source)).toBe(source);
    }
  });

  it("coerces unknown/empty sources to the bounded fallback", () => {
    expect(normalizeInvocationSource("totally_made_up")).toBe(UNKNOWN_INVOCATION_SOURCE);
    expect(normalizeInvocationSource("")).toBe(UNKNOWN_INVOCATION_SOURCE);
    expect(normalizeInvocationSource(undefined)).toBe(UNKNOWN_INVOCATION_SOURCE);
    expect(normalizeInvocationSource(null)).toBe(UNKNOWN_INVOCATION_SOURCE);
  });
});

describe("recordHeartbeatRunFailed + renderMetrics", () => {
  it("registers the counter so /metrics carries its TYPE line before any event", async () => {
    const { contentType, body } = await renderMetrics();
    expect(contentType).toContain("text/plain");
    expect(body).toContain(`# TYPE ${HEARTBEAT_RUN_FAILED_METRIC} counter`);
  });

  it("emits normalized labels for a known invocation source", async () => {
    const labels = recordHeartbeatRunFailed({
      agentId: "agent-a",
      issueId: "issue-a",
      adapter: "claude_k8s",
      errorCode: "k8s_pod_schedule_failed",
      invocationSource: "github_pr_review_submitted",
      isolationMode: "run",
    });
    expect(labels).toEqual({
      agent_id: "agent-a",
      issue_id: "issue-a",
      adapter: "claude_k8s",
      error_code: "k8s_pod_schedule_failed",
      invocation_source: "github_pr_review_submitted",
      isolation_mode: "run",
    });

    const { body } = await renderMetrics();
    expect(body).toContain(
      `${HEARTBEAT_RUN_FAILED_METRIC}{agent_id="agent-a",issue_id="issue-a",adapter="claude_k8s",error_code="k8s_pod_schedule_failed",invocation_source="github_pr_review_submitted",isolation_mode="run"} 1`,
    );
  });

  it.each([
    ["workspace", "workspace"],
    ["shared", "shared"],
    ["not-a-mode", UNKNOWN_ISOLATION_MODE],
  ])(
    "collapses source identifiers for %s pod-schedule failures",
    async (isolationMode, expectedIsolationMode) => {
      const labels = recordHeartbeatRunFailed({
        agentId: "agent-a",
        issueId: "issue-a",
        adapter: "claude_k8s",
        errorCode: "k8s_pod_schedule_failed",
        invocationSource: "github_pr_review_submitted",
        isolationMode,
      });

      expect(labels).toEqual({
        agent_id: UNKNOWN_AGENT_ID,
        issue_id: "none",
        adapter: "claude_k8s",
        error_code: "k8s_pod_schedule_failed",
        invocation_source: "github_pr_review_submitted",
        isolation_mode: expectedIsolationMode,
      });

      const { body } = await renderMetrics();
      expect(body).toContain(
        `${HEARTBEAT_RUN_FAILED_METRIC}{agent_id="${UNKNOWN_AGENT_ID}",issue_id="none",adapter="claude_k8s",error_code="k8s_pod_schedule_failed",invocation_source="github_pr_review_submitted",isolation_mode="${expectedIsolationMode}"} 1`,
      );
    },
  );

  it("collapses unknown invocation source to the bounded fallback (cardinality guardrail)", async () => {
    const labels = recordHeartbeatRunFailed({
      agentId: "agent-a",
      issueId: "issue-a",
      adapter: "claude_k8s",
      errorCode: "process_lost",
      invocationSource: "some_unlisted_source",
      isolationMode: "workspace",
    });
    expect(labels.invocation_source).toBe(UNKNOWN_INVOCATION_SOURCE);

    const { body } = await renderMetrics();
    expect(body).toContain(
      `${HEARTBEAT_RUN_FAILED_METRIC}{agent_id="${UNKNOWN_AGENT_ID}",issue_id="none",adapter="claude_k8s",error_code="process_lost",invocation_source="${UNKNOWN_INVOCATION_SOURCE}",isolation_mode="workspace"} 1`,
    );
  });

  it("falls back adapter/error_code to 'unknown' when null or empty", async () => {
    const labels = recordHeartbeatRunFailed({
      agentId: null,
      issueId: null,
      adapter: null,
      errorCode: "",
      invocationSource: "capacity_blocked_retry",
      isolationMode: "invalid",
    });
    expect(labels).toEqual({
      agent_id: UNKNOWN_AGENT_ID,
      issue_id: "none",
      adapter: "unknown",
      error_code: "unknown",
      invocation_source: "capacity_blocked_retry",
      isolation_mode: UNKNOWN_ISOLATION_MODE,
    });
  });

  it("accumulates repeated failures into the same bounded series", async () => {
    const input = {
      agentId: "agent-a",
      issueId: "issue-a",
      adapter: "claude_k8s",
      errorCode: "k8s_pod_schedule_failed",
      invocationSource: "transient_failure_retry",
      isolationMode: "run",
    };
    recordHeartbeatRunFailed(input);
    recordHeartbeatRunFailed(input);

    const { body } = await renderMetrics();
    expect(body).toContain(
      `${HEARTBEAT_RUN_FAILED_METRIC}{agent_id="agent-a",issue_id="issue-a",adapter="claude_k8s",error_code="k8s_pod_schedule_failed",invocation_source="transient_failure_retry",isolation_mode="run"} 2`,
    );
  });
});

describe("recordAgentZeroTokenCompletedRunStreak + renderMetrics", () => {
  it("sets a bounded per-agent gauge for consecutive zero-token completed runs", async () => {
    const labels = recordAgentZeroTokenCompletedRunStreak({
      agentId: "agent-a",
      adapter: "opencode_k8s",
      streak: 3,
      knownAgentIds: new Set(["agent-a"]),
    });

    expect(labels).toEqual({ agent_id: "agent-a", adapter: "opencode_k8s", streak: 3 });

    const { body } = await renderMetrics();
    expect(body).toContain(`# TYPE ${AGENT_NO_USAGE_STREAK_METRIC} gauge`);
    expect(body).toContain(
      `${AGENT_NO_USAGE_STREAK_METRIC}{agent_id="agent-a",adapter="opencode_k8s"} 3`,
    );
  });

  it("collapses unknown agents and invalid streaks to bounded values", async () => {
    const labels = recordAgentZeroTokenCompletedRunStreak({
      agentId: "ghost",
      adapter: "",
      streak: Number.NaN,
      knownAgentIds: new Set(["agent-a"]),
    });

    expect(labels).toEqual({ agent_id: UNKNOWN_AGENT_ID, adapter: "unknown", streak: 0 });

    const { body } = await renderMetrics();
    expect(body).toContain(
      `${AGENT_NO_USAGE_STREAK_METRIC}{agent_id="${UNKNOWN_AGENT_ID}",adapter="unknown"} 0`,
    );
    expect(body).not.toContain("ghost");
  });

  // BLO-21415: `adapter` used to latch. This gauge is written per-agent from
  // that agent's own heartbeat finalization, so nothing ever retired the child
  // minted under a previous adapterType -- it stayed frozen at its last value
  // for the process lifetime and kept firing PaperclipAgentZeroTokenRunStreak
  // while the agent's live series read healthy.
  it("retires the previous adapter's series when an agent changes adapter", async () => {
    const knownAgentIds = new Set(["agent-a"]);
    recordAgentZeroTokenCompletedRunStreak({
      agentId: "agent-a",
      adapter: "opencode_k8s",
      streak: 10,
      knownAgentIds,
    });

    const before = await renderMetrics();
    expect(before.body).toContain(
      `${AGENT_NO_USAGE_STREAK_METRIC}{agent_id="agent-a",adapter="opencode_k8s"} 10`,
    );

    recordAgentZeroTokenCompletedRunStreak({
      agentId: "agent-a",
      adapter: "claude_k8s",
      streak: 0,
      knownAgentIds,
    });

    const { body } = await renderMetrics();
    expect(body).toContain(
      `${AGENT_NO_USAGE_STREAK_METRIC}{agent_id="agent-a",adapter="claude_k8s"} 0`,
    );
    // The orphaned series is gone entirely, not merely zeroed -- a lingering
    // `opencode_k8s` child at 10 is exactly what fired the alert forever.
    expect(body).not.toContain(
      `${AGENT_NO_USAGE_STREAK_METRIC}{agent_id="agent-a",adapter="opencode_k8s"}`,
    );
  });

  it("keeps other agents' series when one agent changes adapter", async () => {
    const knownAgentIds = new Set(["agent-a", "agent-b"]);
    recordAgentZeroTokenCompletedRunStreak({
      agentId: "agent-b",
      adapter: "opencode_k8s",
      streak: 7,
      knownAgentIds,
    });
    recordAgentZeroTokenCompletedRunStreak({
      agentId: "agent-a",
      adapter: "opencode_k8s",
      streak: 4,
      knownAgentIds,
    });
    recordAgentZeroTokenCompletedRunStreak({
      agentId: "agent-a",
      adapter: "claude_k8s",
      streak: 1,
      knownAgentIds,
    });

    const { body } = await renderMetrics();
    expect(body).toContain(
      `${AGENT_NO_USAGE_STREAK_METRIC}{agent_id="agent-b",adapter="opencode_k8s"} 7`,
    );
    expect(body).toContain(
      `${AGENT_NO_USAGE_STREAK_METRIC}{agent_id="agent-a",adapter="claude_k8s"} 1`,
    );
    expect(body).not.toContain(
      `${AGENT_NO_USAGE_STREAK_METRIC}{agent_id="agent-a",adapter="opencode_k8s"}`,
    );
  });

  it("re-recording the same adapter keeps a single series at the newest value", async () => {
    const knownAgentIds = new Set(["agent-a"]);
    recordAgentZeroTokenCompletedRunStreak({
      agentId: "agent-a",
      adapter: "opencode_k8s",
      streak: 2,
      knownAgentIds,
    });
    recordAgentZeroTokenCompletedRunStreak({
      agentId: "agent-a",
      adapter: "opencode_k8s",
      streak: 5,
      knownAgentIds,
    });

    const { body } = await renderMetrics();
    expect(body).toContain(
      `${AGENT_NO_USAGE_STREAK_METRIC}{agent_id="agent-a",adapter="opencode_k8s"} 5`,
    );
    expect(
      body.split("\n").filter((line) => line.startsWith(`${AGENT_NO_USAGE_STREAK_METRIC}{`)),
    ).toHaveLength(1);
  });
});

describe("dep-blocked metrics counters", () => {
  afterEach(() => {
    resetDepBlockedMetrics();
  });

  it("starts at zero for all keys", () => {
    const snap = snapshotDepBlockedMetrics();
    for (const value of Object.values(snap)) {
      expect(value).toBe(0);
    }
  });

  it("increments a specific counter", () => {
    incrementDepBlockedMetric("dep_blocked_scheduled");
    incrementDepBlockedMetric("dep_blocked_scheduled");
    expect(getDepBlockedMetric("dep_blocked_scheduled")).toBe(2);
    expect(getDepBlockedMetric("dep_blocked_coalesced")).toBe(0);
  });

  it("increments multiple distinct counters independently", () => {
    incrementDepBlockedMetric("dep_blocked_scheduled");
    incrementDepBlockedMetric("dep_blocked_coalesced");
    incrementDepBlockedMetric("dep_blocked_reset");
    const snap = snapshotDepBlockedMetrics();
    expect(snap.dep_blocked_scheduled).toBe(1);
    expect(snap.dep_blocked_coalesced).toBe(1);
    expect(snap.dep_blocked_reset).toBe(1);
    expect(snap.dep_blocked_promoted).toBe(0);
  });

  it("renders dep-blocked counters in Prometheus output", async () => {
    incrementDepBlockedMetric("dep_blocked_scheduled");
    incrementDepBlockedMetric("dep_blocked_coalesced");

    const { body } = await renderMetrics();
    expect(body).toContain(`# TYPE ${DEP_BLOCKED_WAKEUP_METRIC} counter`);
    expect(body).toContain(`${DEP_BLOCKED_WAKEUP_METRIC}{outcome="dep_blocked_scheduled"} 1`);
    expect(body).toContain(`${DEP_BLOCKED_WAKEUP_METRIC}{outcome="dep_blocked_coalesced"} 1`);
  });

  it("snapshot returns a copy that does not mutate on further increments", () => {
    incrementDepBlockedMetric("dep_blocked_redeferred");
    const snap = snapshotDepBlockedMetrics();
    incrementDepBlockedMetric("dep_blocked_redeferred");
    expect(snap.dep_blocked_redeferred).toBe(1);
    expect(getDepBlockedMetric("dep_blocked_redeferred")).toBe(2);
  });

  it("resets all counters to zero", () => {
    incrementDepBlockedMetric("dep_blocked_exhausted");
    incrementDepBlockedMetric("dep_blocked_promoted");
    resetDepBlockedMetrics();
    const snap = snapshotDepBlockedMetrics();
    for (const value of Object.values(snap)) {
      expect(value).toBe(0);
    }
  });
});

describe("process_lost monitor normalizers (BLO-16184)", () => {
  it("bounds the external adapter label to the allow-list", () => {
    expect(normalizeExternalAdapter("claude_k8s")).toBe("claude_k8s");
    expect(normalizeExternalAdapter("opencode_k8s")).toBe("opencode_k8s");
    for (const bad of ["codex_local", "", null, undefined, "claude_k8s_evil"]) {
      expect(normalizeExternalAdapter(bad as string)).toBe(UNKNOWN_EXTERNAL_ADAPTER);
    }
  });

  it("maps the four canonical reaper failure strings to fixed buckets", () => {
    expect(
      normalizeProcessLostBucket(
        "Process lost before external adapter invocation -- k8s job terminated or server restarted",
      ),
    ).toBe("pre_adapter");
    expect(normalizeProcessLostBucket("Process lost -- child pid 4213 is no longer running")).toBe("child_pid");
    expect(normalizeProcessLostBucket("Process lost -- process group 4213 is no longer running")).toBe(
      "process_group",
    );
    expect(normalizeProcessLostBucket("Process lost -- server may have restarted")).toBe("server_restart");
  });

  it("still buckets the pre-adapter string when the retry suffix is appended", () => {
    expect(
      normalizeProcessLostBucket(
        "Process lost before external adapter invocation -- k8s job terminated or server restarted; retrying once",
      ),
    ).toBe("pre_adapter");
  });

  it("collapses an unknown/empty error string to the bounded fallback", () => {
    for (const bad of ["something new", "", null, undefined]) {
      expect(normalizeProcessLostBucket(bad as string)).toBe(UNKNOWN_PROCESS_LOST_BUCKET);
    }
  });

  it("keeps every known classification and collapses the rest to unknown", () => {
    for (const c of KNOWN_PROCESS_LOSS_CLASSIFICATIONS) {
      expect(normalizeProcessLossClassification(c)).toBe(c);
    }
    for (const bad of ["started_job_missing", "", null, undefined, "legacy"]) {
      expect(normalizeProcessLossClassification(bad as string)).toBe(UNKNOWN_PROCESS_LOSS_CLASSIFICATION);
    }
  });
});

describe("recordProcessLost + renderMetrics (BLO-16184 numerator)", () => {
  it("registers the counter so /metrics carries its TYPE line before any event", async () => {
    const { body } = await renderMetrics();
    expect(body).toContain(`# TYPE ${PROCESS_LOST_TOTAL_METRIC} counter`);
  });

  it("emits the bounded label set and returns it", async () => {
    const labels = recordProcessLost({
      adapter: "opencode_k8s",
      errorString: "Process lost before external adapter invocation -- k8s job terminated or server restarted",
      classification: "pre_adapter_job_unstamped",
    });
    expect(labels).toEqual({
      adapter: "opencode_k8s",
      error_bucket: "pre_adapter",
      classification: "pre_adapter_job_unstamped",
    });
    const { body } = await renderMetrics();
    expect(body).toContain(
      `${PROCESS_LOST_TOTAL_METRIC}{adapter="opencode_k8s",error_bucket="pre_adapter",classification="pre_adapter_job_unstamped"} 1`,
    );
  });

  it("collapses an off-list adapter, string, and classification to bounded fallbacks", async () => {
    recordProcessLost({ adapter: "codex_local", errorString: "totally new msg", classification: "bogus" });
    const { body } = await renderMetrics();
    expect(body).toContain(
      `${PROCESS_LOST_TOTAL_METRIC}{adapter="other",error_bucket="other",classification="unknown"} 1`,
    );
  });

  it("accumulates repeated events into the same bounded series", async () => {
    for (let i = 0; i < 3; i++) {
      recordProcessLost({
        adapter: "claude_k8s",
        errorString: "Process lost -- server may have restarted",
        classification: "started_job_absent",
      });
    }
    const { body } = await renderMetrics();
    expect(body).toContain(
      `${PROCESS_LOST_TOTAL_METRIC}{adapter="claude_k8s",error_bucket="server_restart",classification="started_job_absent"} 3`,
    );
  });
});

describe("recordGithubWorkflowRunConclusion (BLO-21078 mass-cancellation detector numerator)", () => {
  it("registers the counter so /metrics carries its TYPE line before any event", async () => {
    const { body } = await renderMetrics();
    expect(body).toContain(`# TYPE ${GITHUB_WORKFLOW_RUN_CONCLUSION_METRIC} counter`);
  });

  it("keeps every known conclusion and collapses the rest to other", () => {
    for (const c of KNOWN_WORKFLOW_RUN_CONCLUSIONS) {
      expect(normalizeWorkflowRunConclusion(c)).toBe(c);
    }
    for (const bad of ["queued", "in_progress", "", null, undefined]) {
      expect(normalizeWorkflowRunConclusion(bad as string)).toBe(UNKNOWN_WORKFLOW_RUN_CONCLUSION);
    }
  });

  it("accumulates repeated cancelled conclusions into the same bounded series", async () => {
    for (let i = 0; i < 4; i++) {
      recordGithubWorkflowRunConclusion("cancelled", "none");
    }
    const { body } = await renderMetrics();
    expect(body).toContain(`${GITHUB_WORKFLOW_RUN_CONCLUSION_METRIC}{conclusion="cancelled",supersession="none"} 4`);
    // Ordinary failure conclusions land on a distinct series -- this is what
    // lets the mass-cancellation alert key on "cancelled" alone without also
    // tripping on the background rate of real test failures.
    expect(body).toContain(`${GITHUB_WORKFLOW_RUN_CONCLUSION_METRIC}{conclusion="failure",supersession="none"} 0`);
  });

  it("collapses a conclusion outside the bounded set instead of growing cardinality", async () => {
    const label = recordGithubWorkflowRunConclusion("action_required_v2_unknown");
    expect(label).toBe(UNKNOWN_WORKFLOW_RUN_CONCLUSION);
    const { body } = await renderMetrics();
    expect(body).toContain(`${GITHUB_WORKFLOW_RUN_CONCLUSION_METRIC}{conclusion="other",supersession="none"} 1`);
  });

  it("keeps a superseded cancellation on a distinct series from an unexplained one", async () => {
    recordGithubWorkflowRunConclusion("cancelled", "superseded");
    recordGithubWorkflowRunConclusion("cancelled", "none");
    recordGithubWorkflowRunConclusion("cancelled", "none");
    const { body } = await renderMetrics();
    // The mass-cancellation alert must key on supersession="none" alone --
    // ordinary cancel-in-progress force-push churn lands on "superseded" and
    // must not inflate the count the alert reads.
    expect(body).toContain(`${GITHUB_WORKFLOW_RUN_CONCLUSION_METRIC}{conclusion="cancelled",supersession="superseded"} 1`);
    expect(body).toContain(`${GITHUB_WORKFLOW_RUN_CONCLUSION_METRIC}{conclusion="cancelled",supersession="none"} 2`);
  });

  it("normalizes an unknown supersession value to none rather than growing cardinality", () => {
    expect(normalizeWorkflowRunSupersession("something_else")).toBe("none");
    expect(normalizeWorkflowRunSupersession(null)).toBe("none");
    expect(normalizeWorkflowRunSupersession("superseded")).toBe("superseded");
  });
});

describe("setExternalLifecycleRunningRuns (BLO-16184 denominator #1)", () => {
  it("writes an explicit 0 for a known adapter with no running runs (drop-to-0 observable)", async () => {
    setExternalLifecycleRunningRuns({ claude_k8s: 5, opencode_k8s: 2 });
    let body = (await renderMetrics()).body;
    expect(body).toContain(`${EXTERNAL_LIFECYCLE_RUNNING_RUNS_METRIC}{adapter="claude_k8s"} 5`);
    expect(body).toContain(`${EXTERNAL_LIFECYCLE_RUNNING_RUNS_METRIC}{adapter="opencode_k8s"} 2`);

    // Next cycle: claude drops to 0. reset-then-set must write 0, not leave 5.
    setExternalLifecycleRunningRuns({ opencode_k8s: 1 });
    body = (await renderMetrics()).body;
    expect(body).toContain(`${EXTERNAL_LIFECYCLE_RUNNING_RUNS_METRIC}{adapter="claude_k8s"} 0`);
    expect(body).toContain(`${EXTERNAL_LIFECYCLE_RUNNING_RUNS_METRIC}{adapter="opencode_k8s"} 1`);
    expect(body).not.toContain(`${EXTERNAL_LIFECYCLE_RUNNING_RUNS_METRIC}{adapter="claude_k8s"} 5`);
  });

  it("folds unknown external adapters into the 'other' series", async () => {
    setExternalLifecycleRunningRuns({ claude_k8s: 1, some_future_k8s: 3, another: 4 });
    const { body } = await renderMetrics();
    expect(body).toContain(`${EXTERNAL_LIFECYCLE_RUNNING_RUNS_METRIC}{adapter="other"} 7`);
  });
});

describe("queued-run age metrics (BLO-21116)", () => {
  it("publishes explicit queue zeros and a separate refresh-success signal", async () => {
    const agentA = "11111111-1111-1111-1111-111111111111";
    const agentB = "22222222-2222-2222-2222-222222222222";
    const known = new Set([agentA, agentB]);

    setQueuedRunOldestAgeMetrics([{ agentId: agentA, ageSeconds: 54000 }], known);
    setQueuedRunAgeMetricsRefreshSuccess(true);
    let body = (await renderMetrics()).body;
    expect(body).toContain(`${QUEUED_RUN_OLDEST_AGE_METRIC}{agent_id="${agentA}"} 54000`);
    expect(body).toContain(`${QUEUED_RUN_OLDEST_AGE_METRIC}{agent_id="${agentB}"} 0`);
    expect(body).toContain(`${QUEUED_RUN_AGE_METRICS_REFRESH_SUCCESS_METRIC} 1`);

    // A successful next refresh with no queued rows resolves the age. A
    // failed refresh is independently visible rather than being mistaken for
    // a fresh zero.
    setQueuedRunOldestAgeMetrics([], known);
    setQueuedRunAgeMetricsRefreshSuccess(false);
    body = (await renderMetrics()).body;
    expect(body).toContain(`${QUEUED_RUN_OLDEST_AGE_METRIC}{agent_id="${agentA}"} 0`);
    expect(body).toContain(`${QUEUED_RUN_AGE_METRICS_REFRESH_SUCCESS_METRIC} 0`);
  });
});

describe("setAgentLivenessMetrics (BLO-23413 outcome-side agent liveness)", () => {
  it("publishes heartbeat age + interval only for heartbeat-enabled agents, and error duration for every agent", async () => {
    setAgentLivenessMetrics([
      {
        agentId: "agent-enabled",
        heartbeatEnabled: true,
        heartbeatExpected: true,
        heartbeatAgeSeconds: 120,
        heartbeatIntervalSeconds: 1800,
        errorDurationSeconds: 0,
      },
      {
        agentId: "agent-disabled",
        heartbeatEnabled: false,
        heartbeatExpected: true,
        heartbeatAgeSeconds: 99999,
        heartbeatIntervalSeconds: 3600,
        errorDurationSeconds: 45,
      },
    ]);

    const { body } = await renderMetrics();
    expect(body).toContain(`# TYPE ${AGENT_HEARTBEAT_AGE_SECONDS_METRIC} gauge`);
    expect(body).toContain(`${AGENT_HEARTBEAT_AGE_SECONDS_METRIC}{agent_id="agent-enabled"} 120`);
    expect(body).toContain(`${AGENT_HEARTBEAT_INTERVAL_SECONDS_METRIC}{agent_id="agent-enabled"} 1800`);
    // heartbeat-disabled agent is expected to be dark, so it must not appear
    // on the age/interval gauges at all -- not even as a 0.
    expect(body).not.toContain(`${AGENT_HEARTBEAT_AGE_SECONDS_METRIC}{agent_id="agent-disabled"}`);
    expect(body).not.toContain(`${AGENT_HEARTBEAT_INTERVAL_SECONDS_METRIC}{agent_id="agent-disabled"}`);
    // error duration is published for every agent regardless of heartbeat.enabled.
    expect(body).toContain(`${AGENT_ERROR_DURATION_SECONDS_METRIC}{agent_id="agent-enabled"} 0`);
    expect(body).toContain(`${AGENT_ERROR_DURATION_SECONDS_METRIC}{agent_id="agent-disabled"} 45`);
  });

  it("reset-then-sets so an agent dropped from the next snapshot disappears rather than freezing stale", async () => {
    setAgentLivenessMetrics([
      { agentId: "agent-a", heartbeatEnabled: true, heartbeatExpected: true, heartbeatAgeSeconds: 10, heartbeatIntervalSeconds: 1800, errorDurationSeconds: 0 },
      { agentId: "agent-b", heartbeatEnabled: true, heartbeatExpected: true, heartbeatAgeSeconds: 20, heartbeatIntervalSeconds: 1800, errorDurationSeconds: 0 },
    ]);
    let body = (await renderMetrics()).body;
    expect(body).toContain(`${AGENT_HEARTBEAT_AGE_SECONDS_METRIC}{agent_id="agent-b"} 20`);

    // Next publish: agent-b is gone (deleted, or heartbeat disabled).
    setAgentLivenessMetrics([
      { agentId: "agent-a", heartbeatEnabled: true, heartbeatExpected: true, heartbeatAgeSeconds: 40, heartbeatIntervalSeconds: 1800, errorDurationSeconds: 0 },
    ]);
    body = (await renderMetrics()).body;
    expect(body).toContain(`${AGENT_HEARTBEAT_AGE_SECONDS_METRIC}{agent_id="agent-a"} 40`);
    expect(body).not.toContain('agent_id="agent-b"');
  });

  it("clamps negative values to 0 and skips non-finite ages", async () => {
    setAgentLivenessMetrics([
      {
        agentId: "agent-c",
        heartbeatEnabled: true,
        heartbeatExpected: true,
        heartbeatAgeSeconds: Number.NaN,
        heartbeatIntervalSeconds: -5,
        errorDurationSeconds: -10,
      },
    ]);
    const { body } = await renderMetrics();
    // NaN age is skipped entirely (no bogus series), negative interval clamps to 0.
    expect(body).not.toContain(`${AGENT_HEARTBEAT_AGE_SECONDS_METRIC}{agent_id="agent-c"}`);
    expect(body).toContain(`${AGENT_HEARTBEAT_INTERVAL_SECONDS_METRIC}{agent_id="agent-c"} 0`);
    expect(body).toContain(`${AGENT_ERROR_DURATION_SECONDS_METRIC}{agent_id="agent-c"} 0`);
  });

  // BLO-28861: `heartbeat.enabled` is not cleared on termination, so config
  // alone let terminated agents export an age that grows forever and could
  // never fall back under the alert threshold. `heartbeatExpected` is the
  // second, independent gate; error duration must survive it untouched.
  it("suppresses age+interval for a heartbeat-enabled agent that is not expected to heartbeat, while keeping its error duration", async () => {
    setAgentLivenessMetrics([
      {
        agentId: "agent-not-expected",
        heartbeatEnabled: true,
        heartbeatExpected: false,
        heartbeatAgeSeconds: 9_876_543,
        heartbeatIntervalSeconds: 30,
        errorDurationSeconds: 77,
      },
      {
        agentId: "agent-expected",
        heartbeatEnabled: true,
        heartbeatExpected: true,
        heartbeatAgeSeconds: 42,
        heartbeatIntervalSeconds: 1800,
        errorDurationSeconds: 0,
      },
    ]);

    const { body } = await renderMetrics();
    expect(body).not.toContain(`${AGENT_HEARTBEAT_AGE_SECONDS_METRIC}{agent_id="agent-not-expected"}`);
    expect(body).not.toContain(`${AGENT_HEARTBEAT_INTERVAL_SECONDS_METRIC}{agent_id="agent-not-expected"}`);
    // The gate is age/interval-only: error duration is a status observation,
    // not a liveness claim, and BLO-28861 preserves its series set.
    expect(body).toContain(`${AGENT_ERROR_DURATION_SECONDS_METRIC}{agent_id="agent-not-expected"} 77`);
    // Control: the gate is not simply suppressing everything.
    expect(body).toContain(`${AGENT_HEARTBEAT_AGE_SECONDS_METRIC}{agent_id="agent-expected"} 42`);
    expect(body).toContain(`${AGENT_HEARTBEAT_INTERVAL_SECONDS_METRIC}{agent_id="agent-expected"} 1800`);
  });
});

describe("setPluginErrorStatus (BLO-21092)", () => {
  it("registers the gauge and reports 1 for an errored plugin, 0 for a ready one", async () => {
    setPluginErrorStatus([
      { id: "11111111-1111-1111-1111-111111111111", pluginKey: "lucitra.plugin-secrets", isError: true },
      { id: "22222222-2222-2222-2222-222222222222", pluginKey: "example.plugin", isError: false },
    ]);
    const { body } = await renderMetrics();
    expect(body).toContain(`# TYPE ${PLUGIN_ERROR_METRIC} gauge`);
    expect(body).toContain(
      `${PLUGIN_ERROR_METRIC}{plugin_id="11111111-1111-1111-1111-111111111111",plugin_key="lucitra.plugin-secrets"} 1`,
    );
    expect(body).toContain(
      `${PLUGIN_ERROR_METRIC}{plugin_id="22222222-2222-2222-2222-222222222222",plugin_key="example.plugin"} 0`,
    );
  });

  it("drops a plugin's series once it is no longer in the installed roster (reset-then-set)", async () => {
    setPluginErrorStatus([
      { id: "11111111-1111-1111-1111-111111111111", pluginKey: "lucitra.plugin-secrets", isError: true },
    ]);
    let body = (await renderMetrics()).body;
    expect(body).toContain(
      `${PLUGIN_ERROR_METRIC}{plugin_id="11111111-1111-1111-1111-111111111111",plugin_key="lucitra.plugin-secrets"} 1`,
    );

    // Plugin uninstalled: next tick's roster no longer includes it.
    setPluginErrorStatus([]);
    body = (await renderMetrics()).body;
    expect(body).not.toContain("plugin_id=\"11111111-1111-1111-1111-111111111111\"");
  });

  it("flips an existing plugin's series from error to ready without leaving a stale 1", async () => {
    setPluginErrorStatus([
      { id: "11111111-1111-1111-1111-111111111111", pluginKey: "lucitra.plugin-secrets", isError: true },
    ]);
    setPluginErrorStatus([
      { id: "11111111-1111-1111-1111-111111111111", pluginKey: "lucitra.plugin-secrets", isError: false },
    ]);
    const { body } = await renderMetrics();
    expect(body).toContain(
      `${PLUGIN_ERROR_METRIC}{plugin_id="11111111-1111-1111-1111-111111111111",plugin_key="lucitra.plugin-secrets"} 0`,
    );
  });
});

describe("setPluginStatusCollectorLastSuccessSeconds (BLO-21092 review follow-up)", () => {
  it("registers no series until first set -- unlike a bare gauge, prom-client does not auto-publish a labeled gauge at 0 (Ally review: this is what keeps the API tier, which never calls this setter, from freezing the series at 0 and permanently satisfying a staleness alert)", async () => {
    const { body } = await renderMetrics();
    expect(body).toContain(`# TYPE ${PLUGIN_STATUS_COLLECTOR_LAST_SUCCESS_METRIC} gauge`);
    expect(body).not.toContain(`${PLUGIN_STATUS_COLLECTOR_LAST_SUCCESS_METRIC}{`);
  });

  it("reports the exact unix-seconds value passed in under role=\"worker\", and only advances on an explicit call", async () => {
    setPluginStatusCollectorLastSuccessSeconds(1_700_000_000);
    let body = (await renderMetrics()).body;
    expect(body).toContain(`${PLUGIN_STATUS_COLLECTOR_LAST_SUCCESS_METRIC}{role="worker"} 1700000000`);

    // A second success tick advances it; nothing else can move it backward or forward.
    setPluginStatusCollectorLastSuccessSeconds(1_700_000_030);
    body = (await renderMetrics()).body;
    expect(body).toContain(`${PLUGIN_STATUS_COLLECTOR_LAST_SUCCESS_METRIC}{role="worker"} 1700000030`);
  });
});

describe("recordProcessLostLivenessNull (BLO-16184 denominator #2)", () => {
  it("registers the counter TYPE line and increments per blind cycle", async () => {
    let body = (await renderMetrics()).body;
    expect(body).toContain(`# TYPE ${PROCESS_LOST_LIVENESS_NULL_METRIC} counter`);
    recordProcessLostLivenessNull();
    recordProcessLostLivenessNull();
    body = (await renderMetrics()).body;
    expect(body).toContain(`${PROCESS_LOST_LIVENESS_NULL_METRIC} 2`);
  });
});

describe("computeExternalLifecycleSilenceGapSeconds + recordExternalLifecycleRunSilenceGap (BLO-20815)", () => {
  const t0 = new Date("2026-08-01T00:00:00.000Z");

  it("registers the histogram so /metrics carries its TYPE line before any event", async () => {
    const { body } = await renderMetrics();
    expect(body).toContain(`# TYPE ${EXTERNAL_LIFECYCLE_RUN_SILENCE_GAP_METRIC} histogram`);
  });

  it("uses lastUsefulActionAt when present, ignoring the older lastOutputAt/startedAt", () => {
    const finalizedAt = new Date(t0.getTime() + 130_000);
    const gap = computeExternalLifecycleSilenceGapSeconds(
      {
        lastUsefulActionAt: t0,
        lastOutputAt: new Date(t0.getTime() - 60_000),
        startedAt: new Date(t0.getTime() - 3_600_000),
      },
      finalizedAt,
    );
    expect(gap).toBe(130);
  });

  it("falls back to lastOutputAt when lastUsefulActionAt is absent", () => {
    const finalizedAt = new Date(t0.getTime() + 900_000);
    const gap = computeExternalLifecycleSilenceGapSeconds(
      {
        lastUsefulActionAt: null,
        lastOutputAt: t0,
        startedAt: new Date(t0.getTime() - 3_600_000),
      },
      finalizedAt,
    );
    expect(gap).toBe(900);
  });

  it("falls back to startedAt when both lastUsefulActionAt and lastOutputAt are absent", () => {
    const finalizedAt = new Date(t0.getTime() + 2_700_000);
    const gap = computeExternalLifecycleSilenceGapSeconds(
      { lastUsefulActionAt: null, lastOutputAt: null, startedAt: t0 },
      finalizedAt,
    );
    expect(gap).toBe(2700);
  });

  it("returns null when no signal timestamp is available at all (never-started cancelled run)", () => {
    const gap = computeExternalLifecycleSilenceGapSeconds(
      { lastUsefulActionAt: null, lastOutputAt: null, startedAt: null },
      new Date(t0.getTime() + 60_000),
    );
    expect(gap).toBeNull();
  });

  it("clamps to 0 rather than going negative under clock skew", () => {
    const gap = computeExternalLifecycleSilenceGapSeconds(
      { lastUsefulActionAt: t0, lastOutputAt: null, startedAt: null },
      new Date(t0.getTime() - 5_000),
    );
    expect(gap).toBe(0);
  });

  it("keeps every known terminal status and collapses the rest to 'other'", () => {
    for (const status of KNOWN_EXTERNAL_LIFECYCLE_TERMINAL_STATUSES) {
      expect(normalizeExternalLifecycleTerminalStatus(status)).toBe(status);
    }
    for (const bad of ["interrupted", "queued", "running", "", null, undefined]) {
      expect(normalizeExternalLifecycleTerminalStatus(bad as string)).toBe(
        UNKNOWN_EXTERNAL_LIFECYCLE_TERMINAL_STATUS,
      );
    }
  });

  it("observes the histogram at the expected labels and value for each precedence branch", async () => {
    const labels = recordExternalLifecycleRunSilenceGap({
      adapter: "claude_k8s",
      status: "succeeded",
      run: { lastUsefulActionAt: t0, lastOutputAt: null, startedAt: null },
      finalizedAt: new Date(t0.getTime() + 300_000),
    });
    expect(labels).toEqual({ adapter: "claude_k8s", status: "succeeded", silenceGapSeconds: 300 });
    const { body } = await renderMetrics();
    expect(body).toContain(
      `${EXTERNAL_LIFECYCLE_RUN_SILENCE_GAP_METRIC}_sum{adapter="claude_k8s",status="succeeded"} 300`,
    );
    expect(body).toContain(
      `${EXTERNAL_LIFECYCLE_RUN_SILENCE_GAP_METRIC}_count{adapter="claude_k8s",status="succeeded"} 1`,
    );
    // The 300s observation must fall in the 300 bucket and every larger bucket,
    // and must NOT be counted in the 60s bucket below it.
    expect(body).toContain(
      `${EXTERNAL_LIFECYCLE_RUN_SILENCE_GAP_METRIC}_bucket{le="300",adapter="claude_k8s",status="succeeded"} 1`,
    );
    expect(body).toContain(
      `${EXTERNAL_LIFECYCLE_RUN_SILENCE_GAP_METRIC}_bucket{le="60",adapter="claude_k8s",status="succeeded"} 0`,
    );
    // Companion last-value gauge (BLO-20815 review follow-up): the histogram alone
    // cannot answer "what was the max", so this observation must also land on the
    // gauge at the same labels/value so max_over_time(...[7d]) can recover it.
    expect(body).toContain(`# TYPE ${EXTERNAL_LIFECYCLE_RUN_SILENCE_GAP_LAST_METRIC} gauge`);
    expect(body).toContain(
      `${EXTERNAL_LIFECYCLE_RUN_SILENCE_GAP_LAST_METRIC}{adapter="claude_k8s",status="succeeded"} 300`,
    );
  });

  it("overwrites the last-value gauge with each new observation regardless of direction (last-write, not running max)", async () => {
    recordExternalLifecycleRunSilenceGap({
      adapter: "claude_k8s",
      status: "succeeded",
      run: { lastUsefulActionAt: t0, lastOutputAt: null, startedAt: null },
      finalizedAt: new Date(t0.getTime() + 1_800_000),
    });
    recordExternalLifecycleRunSilenceGap({
      adapter: "claude_k8s",
      status: "succeeded",
      run: { lastUsefulActionAt: t0, lastOutputAt: null, startedAt: null },
      finalizedAt: new Date(t0.getTime() + 90_000),
    });
    const { body } = await renderMetrics();
    // The gauge itself only ever exposes the most recent value (90s, smaller
    // than the prior 1800s) — the max is recovered at query time via
    // max_over_time over Prometheus's already-scraped sample history, not by
    // this gauge holding a running maximum in-process.
    expect(body).toContain(
      `${EXTERNAL_LIFECYCLE_RUN_SILENCE_GAP_LAST_METRIC}{adapter="claude_k8s",status="succeeded"} 90`,
    );
  });

  it("collapses an off-list adapter and status to bounded fallbacks", async () => {
    recordExternalLifecycleRunSilenceGap({
      adapter: "codex_local",
      status: "interrupted",
      run: { lastUsefulActionAt: null, lastOutputAt: null, startedAt: t0 },
      finalizedAt: new Date(t0.getTime() + 60_000),
    });
    const { body } = await renderMetrics();
    expect(body).toContain(
      `${EXTERNAL_LIFECYCLE_RUN_SILENCE_GAP_METRIC}_count{adapter="other",status="other"} 1`,
    );
  });

  it("records nothing for a run with no signal timestamp at all", async () => {
    const result = recordExternalLifecycleRunSilenceGap({
      adapter: "claude_k8s",
      status: "cancelled",
      run: { lastUsefulActionAt: null, lastOutputAt: null, startedAt: null },
      finalizedAt: t0,
    });
    expect(result).toBeNull();
    const { body } = await renderMetrics();
    expect(body).not.toContain(
      `${EXTERNAL_LIFECYCLE_RUN_SILENCE_GAP_METRIC}_count{adapter="claude_k8s",status="cancelled"}`,
    );
    expect(body).not.toContain(
      `${EXTERNAL_LIFECYCLE_RUN_SILENCE_GAP_LAST_METRIC}{adapter="claude_k8s",status="cancelled"}`,
    );
  });
});

describe("routine dispatch metrics counters (BLO-23379)", () => {
  afterEach(() => {
    resetRoutineDispatchMetrics();
  });

  it("renders the parked-execution-issue bypass counter in Prometheus output", async () => {
    incrementRoutineDispatchMetric("routine_dispatch_bypassed_parked_execution_issue");
    incrementRoutineDispatchMetric("routine_dispatch_bypassed_parked_execution_issue");

    const { body } = await renderMetrics();
    expect(body).toContain(`# TYPE ${ROUTINE_DISPATCH_METRIC} counter`);
    expect(body).toContain(
      `${ROUTINE_DISPATCH_METRIC}{outcome="routine_dispatch_bypassed_parked_execution_issue"} 2`,
    );
  });

  // BLO-25692: the stale-run bypass is a sibling label, not a replacement --
  // both must render, or an operator cannot tell a provider-quota park from an
  // execution that stalled or overran.
  it("renders the stale-execution-issue bypass counter alongside the parked one", async () => {
    incrementRoutineDispatchMetric("routine_dispatch_bypassed_stale_execution_issue");
    incrementRoutineDispatchMetric("routine_dispatch_bypassed_parked_execution_issue");

    const { body } = await renderMetrics();
    expect(body).toContain(
      `${ROUTINE_DISPATCH_METRIC}{outcome="routine_dispatch_bypassed_stale_execution_issue"} 1`,
    );
    expect(body).toContain(
      `${ROUTINE_DISPATCH_METRIC}{outcome="routine_dispatch_bypassed_parked_execution_issue"} 1`,
    );
  });

  it("starts at zero so a quiet routine is distinguishable from a bypassed one", () => {
    const snap = snapshotRoutineDispatchMetrics();
    for (const value of Object.values(snap)) {
      expect(value).toBe(0);
    }
  });
});

describe("setQueuedRunOldestAgeMetrics (BLO-21116)", () => {
  it("writes an explicit 0 for a known agent whose queue has drained (drop-to-0 observable)", async () => {
    const agentA = "11111111-1111-1111-1111-111111111111";
    const agentB = "22222222-2222-2222-2222-222222222222";
    const known = new Set([agentA, agentB]);

    setQueuedRunOldestAgeMetrics([{ agentId: agentA, ageSeconds: 54000 }], known);
    let body = (await renderMetrics()).body;
    expect(body).toContain(`${QUEUED_RUN_OLDEST_AGE_METRIC}{agent_id="${agentA}"} 54000`);
    expect(body).toContain(`${QUEUED_RUN_OLDEST_AGE_METRIC}{agent_id="${agentB}"} 0`);

    // Next refresh: agentA's queue drained. reset-then-set must write 0, not
    // leave the stale 54000 -- that stale value is what would keep an alert
    // on this series from ever resolving.
    setQueuedRunOldestAgeMetrics([], known);
    body = (await renderMetrics()).body;
    expect(body).toContain(`${QUEUED_RUN_OLDEST_AGE_METRIC}{agent_id="${agentA}"} 0`);
    expect(body).not.toContain(`${QUEUED_RUN_OLDEST_AGE_METRIC}{agent_id="${agentA}"} 54000`);
  });

  it("takes the oldest of multiple queued runs per agent, and collapses an unknown agent id", async () => {
    const agentA = "33333333-3333-3333-3333-333333333333";
    const known = new Set([agentA]);

    setQueuedRunOldestAgeMetrics(
      [
        { agentId: agentA, ageSeconds: 120 },
        { agentId: agentA, ageSeconds: 9000 },
        { agentId: "not-a-known-agent", ageSeconds: 4500 },
      ],
      known,
    );
    const { body } = await renderMetrics();
    expect(body).toContain(`${QUEUED_RUN_OLDEST_AGE_METRIC}{agent_id="${agentA}"} 9000`);
    expect(body).toContain(`${QUEUED_RUN_OLDEST_AGE_METRIC}{agent_id="${UNKNOWN_AGENT_ID}"} 4500`);
  });
});

describe("backstop metrics (BLO-29763)", () => {
  it("publishes both bounded streams at zero, then records depth, completion, and skips", async () => {
    let body = (await renderMetrics()).body;
    expect(body).toContain(`${BACKSTOP_DEFERRED_CANDIDATES_METRIC}{source="issue_graph_liveness.backstop"} 0`);
    expect(body).toContain(`${BACKSTOP_DEFERRED_CANDIDATES_METRIC}{source="stranded_recovery_wake_backstop"} 0`);

    setBackstopDeferredCandidates("issue_graph_liveness.backstop", 7);
    recordBackstopSweepCompleted("stranded_recovery_wake_backstop");
    recordBackstopCandidateSkipped("issue_graph_liveness.backstop", "not_ready");
    recordBackstopCandidateSkipped("issue_graph_liveness.backstop", "deferred_or_failed");
    recordBackstopCandidateSkipped("issue_graph_liveness.backstop", "enqueue_failed");
    body = (await renderMetrics()).body;

    expect(body).toContain(`${BACKSTOP_DEFERRED_CANDIDATES_METRIC}{source="issue_graph_liveness.backstop"} 7`);
    expect(body).toContain(`${BACKSTOP_SWEEP_COMPLETED_METRIC}{source="stranded_recovery_wake_backstop"} 1`);
    expect(body).toContain(
      `${BACKSTOP_CANDIDATES_SKIPPED_METRIC}{source="issue_graph_liveness.backstop",reason="not_ready"} 1`,
    );
    expect(body).toContain(
      `${BACKSTOP_CANDIDATES_SKIPPED_METRIC}{source="issue_graph_liveness.backstop",reason="deferred_or_failed"} 1`,
    );
    expect(body).toContain(
      `${BACKSTOP_CANDIDATES_SKIPPED_METRIC}{source="issue_graph_liveness.backstop",reason="enqueue_failed"} 1`,
    );

    setBackstopDeferredCandidates("issue_graph_liveness.backstop", 0);
    body = (await renderMetrics()).body;
    expect(body).toContain(`${BACKSTOP_DEFERRED_CANDIDATES_METRIC}{source="issue_graph_liveness.backstop"} 0`);
  });
});

describe("github review request suppression causes (BLO-20526 reviewer lock contention)", () => {
  it("preserves reviewer_lock_contended rather than collapsing it to the unknown bucket", async () => {
    // `normalizeGithubSuppressionCause` maps any cause absent from
    // KNOWN_GITHUB_SUPPRESSION_CAUSES to UNKNOWN_GITHUB_SUPPRESSION_CAUSES's
    // "other" — which the outage alert pages on as an UNTRIAGED cause. So
    // emitting this cause without registering it would not merely mislabel the
    // series, it would page on every occurrence of a known, expected drop.
    __resetMetricsForTest();

    const recorded = recordGithubReviewRequestSuppressed({
      reason: "github_pr_review_requested",
      cause: GITHUB_SUPPRESSION_CAUSE_REVIEWER_LOCK_CONTENDED,
    });

    expect(recorded.cause).toBe("reviewer_lock_contended");
    expect(recorded.cause).not.toBe(UNKNOWN_GITHUB_SUPPRESSION_CAUSE);

    const body = (await renderMetrics()).body;
    expect(body).toContain(
      `${GITHUB_REVIEW_REQUEST_SUPPRESSION_METRIC}{cause="reviewer_lock_contended",reason="github_pr_review_requested"} 1`,
    );
  });

  it("still collapses an unregistered cause, so the check above is not vacuous", () => {
    __resetMetricsForTest();

    const recorded = recordGithubReviewRequestSuppressed({
      reason: "github_pr_review_requested",
      cause: "reviewer_lock_contended_typo",
    });

    expect(recorded.cause).toBe(UNKNOWN_GITHUB_SUPPRESSION_CAUSE);
  });

  it("zero-initializes the contended series so absent is distinguishable from zero", async () => {
    // The series must exist before the first event or the outage alert cannot
    // tell "nothing suppressed" from "the scrape is broken".
    __resetMetricsForTest();

    const body = (await renderMetrics()).body;
    expect(body).toContain(`${GITHUB_REVIEW_REQUEST_SUPPRESSION_METRIC}{cause="reviewer_lock_contended"`);
  });
});

describe("recordGbrainRecallOutcome + renderMetrics (BLO-25892)", () => {
  it("zero-initializes every known status plus 'other' before any event", async () => {
    const { body } = await renderMetrics();
    expect(body).toContain(`# TYPE ${GBRAIN_RECALL_METRIC} counter`);
    for (const status of ["ok", "no-issue-page", "empty", "island", "skipped", "error", "other"]) {
      expect(body).toContain(`${GBRAIN_RECALL_METRIC}{status="${status}"} 0`);
    }
  });

  it("increments the matching status series", async () => {
    recordGbrainRecallOutcome("error");
    recordGbrainRecallOutcome("error");
    recordGbrainRecallOutcome("ok");
    const { body } = await renderMetrics();
    expect(body).toContain(`${GBRAIN_RECALL_METRIC}{status="error"} 2`);
    expect(body).toContain(`${GBRAIN_RECALL_METRIC}{status="ok"} 1`);
  });

  it("collapses an unrecognized or missing status into 'other' (cardinality guardrail)", async () => {
    expect(normalizeGbrainRecallStatus("not-a-real-status")).toBe(UNKNOWN_GBRAIN_RECALL_STATUS);
    expect(normalizeGbrainRecallStatus(undefined)).toBe(UNKNOWN_GBRAIN_RECALL_STATUS);
    recordGbrainRecallOutcome(undefined);
    const { body } = await renderMetrics();
    expect(body).toContain(`${GBRAIN_RECALL_METRIC}{status="other"} 1`);
  });
});
