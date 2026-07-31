import { afterEach, describe, expect, it } from "vitest";
import {
  AGENT_NO_USAGE_STREAK_METRIC,
  AUTH_REQUEST_METRIC,
  CONCURRENT_RUN_BLOCKED_METRIC,
  DEP_BLOCKED_WAKEUP_METRIC,
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
  recordHeartbeatRunFailed,
  recordIsolatedRunStarted,
  renderMetrics,
  EXTERNAL_LIFECYCLE_RUNNING_RUNS_METRIC,
  KNOWN_PROCESS_LOSS_CLASSIFICATIONS,
  PROCESS_LOST_LIVENESS_NULL_METRIC,
  PROCESS_LOST_TOTAL_METRIC,
  UNKNOWN_EXTERNAL_ADAPTER,
  UNKNOWN_PROCESS_LOSS_CLASSIFICATION,
  UNKNOWN_PROCESS_LOST_BUCKET,
  normalizeExternalAdapter,
  normalizeProcessLossClassification,
  normalizeProcessLostBucket,
  recordProcessLost,
  recordProcessLostLivenessNull,
  setExternalLifecycleRunningRuns,
} from "../services/metrics.js";
import {
  getDepBlockedMetric,
  incrementDepBlockedMetric,
  resetDepBlockedMetrics,
  snapshotDepBlockedMetrics,
} from "../services/dep-blocked-metrics.js";

afterEach(() => {
  __resetMetricsForTest();
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
