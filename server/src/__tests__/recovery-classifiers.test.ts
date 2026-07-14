import { describe, expect, it } from "vitest";
import { classifyIssueGraphLiveness as classifyIssueGraphLivenessCompat } from "../services/issue-liveness.js";
import { decideRunLivenessContinuation as decideRunLivenessContinuationCompat } from "../services/run-continuations.js";
import {
  RECOVERY_KEY_PREFIXES,
  RECOVERY_ORIGIN_KINDS,
  RECOVERY_REASON_KINDS,
  buildIssueGraphLivenessIncidentKey,
  buildIssueGraphLivenessLeafKey,
  buildRunLivenessContinuationIdempotencyKey,
  classifyIssueGraphLiveness,
  decideRunLivenessContinuation,
  isStrandedIssueRecoveryOriginKind,
  isZeroTokenStartupFailureRun,
  isZeroTokenSessionResetRetryRun,
  parseIssueGraphLivenessIncidentKey,
} from "../services/recovery/index.js";
import {
  classifyContinuationFailure,
  isContinuationAttemptRetryReason,
} from "../services/recovery/service.js";

const companyId = "company-1";
const agentId = "agent-1";
const managerId = "manager-1";
const issueId = "issue-1";
const blockerId = "blocker-1";
const runId = "run-1";

describe("recovery classifier boundary", () => {
  it("keeps issue graph liveness classifier parity with the compatibility export", () => {
    const input = {
      issues: [
        {
          id: issueId,
          companyId,
          identifier: "PAP-2073",
          title: "Centralize recovery classifiers",
          status: "blocked",
          assigneeAgentId: agentId,
          assigneeUserId: null,
          createdByAgentId: null,
          createdByUserId: null,
          executionState: null,
        },
        {
          id: blockerId,
          companyId,
          identifier: "PAP-2074",
          title: "Move recovery side effects",
          status: "todo",
          assigneeAgentId: null,
          assigneeUserId: null,
          createdByAgentId: null,
          createdByUserId: null,
          executionState: null,
        },
      ],
      relations: [{ companyId, blockerIssueId: blockerId, blockedIssueId: issueId }],
      agents: [
        {
          id: agentId,
          companyId,
          name: "Coder",
          role: "engineer",
          status: "idle",
          reportsTo: managerId,
        },
        {
          id: managerId,
          companyId,
          name: "CTO",
          role: "cto",
          status: "idle",
          reportsTo: null,
        },
      ],
    };

    expect(classifyIssueGraphLiveness(input)).toEqual(classifyIssueGraphLivenessCompat(input));
  });

  it("treats a scheduled monitor as an explicit review action path", () => {
    const findings = classifyIssueGraphLiveness({
      now: "2026-04-30T18:00:00.000Z",
      issues: [
        {
          id: issueId,
          companyId,
          identifier: "PAP-2945",
          title: "Wait for external review",
          status: "in_review",
          assigneeAgentId: agentId,
          assigneeUserId: null,
          createdByAgentId: null,
          createdByUserId: null,
          executionState: null,
          monitorNextCheckAt: "2026-04-30T19:00:00.000Z",
        },
      ],
      relations: [],
      agents: [
        {
          id: agentId,
          companyId,
          name: "Coder",
          role: "engineer",
          status: "idle",
          reportsTo: managerId,
        },
      ],
    });

    expect(findings).toEqual([]);
  });

  it("does not treat overdue or exhausted monitors as explicit waiting paths", () => {
    const baseIssue = {
      id: issueId,
      companyId,
      identifier: "PAP-2945",
      title: "Wait for external review",
      status: "in_review",
      assigneeAgentId: agentId,
      assigneeUserId: null,
      createdByAgentId: null,
      createdByUserId: null,
    };
    const agents = [
      {
        id: agentId,
        companyId,
        name: "Coder",
        role: "engineer",
        status: "idle",
        reportsTo: managerId,
      },
    ];

    const overdue = classifyIssueGraphLiveness({
      now: "2026-04-30T20:00:00.000Z",
      issues: [
        {
          ...baseIssue,
          executionState: null,
          monitorNextCheckAt: "2026-04-30T19:00:00.000Z",
        },
      ],
      relations: [],
      agents,
    });

    const exhausted = classifyIssueGraphLiveness({
      now: "2026-04-30T18:00:00.000Z",
      issues: [
        {
          ...baseIssue,
          executionPolicy: {
            monitor: {
              nextCheckAt: "2026-04-30T19:00:00.000Z",
              maxAttempts: 1,
            },
          },
          executionState: null,
          monitorNextCheckAt: "2026-04-30T19:00:00.000Z",
          monitorAttemptCount: 1,
        },
      ],
      relations: [],
      agents,
    });

    expect(overdue[0]?.state).toBe("in_review_without_action_path");
    expect(exhausted[0]?.state).toBe("in_review_without_action_path");
  });

  it("keeps run liveness continuation decision parity with the compatibility export", () => {
    const input = {
      run: {
        id: runId,
        companyId,
        agentId,
        continuationAttempt: 0,
      } as never,
      issue: {
        id: issueId,
        companyId,
        identifier: "PAP-2073",
        title: "Centralize recovery classifiers",
        status: "in_progress",
        assigneeAgentId: agentId,
        executionState: null,
        projectId: null,
      } as never,
      agent: {
        id: agentId,
        companyId,
        status: "idle",
      } as never,
      livenessState: "plan_only" as const,
      livenessReason: "Planned without acting",
      nextAction: "Take the first concrete action.",
      budgetBlocked: false,
      idempotentWakeExists: false,
    };

    expect(decideRunLivenessContinuation(input)).toEqual(decideRunLivenessContinuationCompat(input));
  });

  it("keeps recovery origin and idempotency keys stable", () => {
    expect(RECOVERY_ORIGIN_KINDS).toMatchObject({
      issueGraphLivenessEscalation: "harness_liveness_escalation",
      strandedIssueRecovery: "stranded_issue_recovery",
      staleActiveRunEvaluation: "stale_active_run_evaluation",
    });
    expect(RECOVERY_REASON_KINDS.runLivenessContinuation).toBe("run_liveness_continuation");
    expect(RECOVERY_KEY_PREFIXES.issueGraphLivenessIncident).toBe("harness_liveness");
    expect(RECOVERY_KEY_PREFIXES.issueGraphLivenessLeaf).toBe("harness_liveness_leaf");

    const incidentKey = buildIssueGraphLivenessIncidentKey({
      companyId,
      issueId,
      state: "blocked_by_unassigned_issue",
      blockerIssueId: blockerId,
    });
    expect(incidentKey).toBe(
      "harness_liveness:company-1:issue-1:blocked_by_unassigned_issue:blocker-1",
    );
    expect(parseIssueGraphLivenessIncidentKey(incidentKey)).toEqual({
      companyId,
      issueId,
      state: "blocked_by_unassigned_issue",
      leafIssueId: blockerId,
    });
    expect(buildIssueGraphLivenessLeafKey({
      companyId,
      state: "blocked_by_unassigned_issue",
      leafIssueId: blockerId,
    })).toBe("harness_liveness_leaf:company-1:blocked_by_unassigned_issue:blocker-1");
    expect(buildRunLivenessContinuationIdempotencyKey({
      issueId,
      sourceRunId: runId,
      livenessState: "plan_only",
      nextAttempt: 1,
    })).toBe("run_liveness_continuation:issue-1:run-1:plan_only:1");
  });

  it("classifies stranded recovery origins as recovery-owned work", () => {
    expect(isStrandedIssueRecoveryOriginKind("stranded_issue_recovery")).toBe(true);
    expect(isStrandedIssueRecoveryOriginKind("harness_liveness_escalation")).toBe(false);
    expect(isStrandedIssueRecoveryOriginKind("manual")).toBe(false);
    expect(isStrandedIssueRecoveryOriginKind(null)).toBe(false);
  });
});

describe("zero-token startup-failure classifier (BLO-5681)", () => {
  it("flags terminal zero-token pre-model startup failures (camelCase usage)", () => {
    expect(
      isZeroTokenStartupFailureRun({
        status: "failed",
        errorCode: "context_overflow",
        usageJson: { inputTokens: 0, outputTokens: 0 },
      }),
    ).toBe(true);
  });

  it("flags zero-token failures with snake_case usage keys", () => {
    expect(
      isZeroTokenStartupFailureRun({
        status: "failed",
        errorCode: "context_overflow",
        usageJson: { input_tokens: 0, output_tokens: 0 },
      }),
    ).toBe(true);
  });

  it("treats an absent usage blob as zero work", () => {
    expect(isZeroTokenStartupFailureRun({ status: "failed", errorCode: "context_overflow" })).toBe(true);
    expect(
      isZeroTokenStartupFailureRun({ status: "failed", errorCode: "context_overflow", usageJson: null }),
    ).toBe(true);
  });

  it("flags every member of the pre-model startup-failure family across terminal statuses", () => {
    expect(isZeroTokenStartupFailureRun({ status: "failed", errorCode: "context_length_exceeded" })).toBe(true);
    expect(isZeroTokenStartupFailureRun({ status: "timed_out", errorCode: "startup_error_pre_model" })).toBe(true);
    expect(isZeroTokenStartupFailureRun({ status: "cancelled", errorCode: "context_overflow" })).toBe(true);
  });

  it("trims surrounding whitespace on the error code", () => {
    expect(isZeroTokenStartupFailureRun({ status: "failed", errorCode: "  context_overflow  " })).toBe(true);
  });

  it("does NOT flag a run that actually burned tokens", () => {
    expect(
      isZeroTokenStartupFailureRun({
        status: "failed",
        errorCode: "context_overflow",
        usageJson: { inputTokens: 5000, outputTokens: 0 },
      }),
    ).toBe(false);
    expect(
      isZeroTokenStartupFailureRun({
        status: "failed",
        errorCode: "context_overflow",
        usageJson: { input_tokens: 0, output_tokens: 12 },
      }),
    ).toBe(false);
  });

  it("does NOT flag transient failure codes (recovery wrapper still applies)", () => {
    for (const errorCode of ["rate_limit_exhausted", "mcp_timeout", "adapter_failed", "process_lost"]) {
      expect(isZeroTokenStartupFailureRun({ status: "failed", errorCode, usageJson: { inputTokens: 0, outputTokens: 0 } })).toBe(false);
    }
  });

  it("does NOT flag non-terminal-unsuccessful or empty runs", () => {
    expect(isZeroTokenStartupFailureRun({ status: "succeeded", errorCode: "context_overflow" })).toBe(false);
    expect(isZeroTokenStartupFailureRun({ status: "running", errorCode: "context_overflow" })).toBe(false);
    expect(isZeroTokenStartupFailureRun({ status: "failed", errorCode: null })).toBe(false);
    expect(isZeroTokenStartupFailureRun(null)).toBe(false);
    expect(isZeroTokenStartupFailureRun(undefined)).toBe(false);
  });
});

describe("zero-token session-reset retry marker (BLO-10889 / BLO-10866 WS2)", () => {
  it("flags a run dispatched with the reset-and-retry retryReason", () => {
    expect(
      isZeroTokenSessionResetRetryRun({
        contextSnapshot: { retryReason: "zero_token_session_reset" },
      }),
    ).toBe(true);
  });

  it("does not flag a run with a different or missing retryReason", () => {
    expect(
      isZeroTokenSessionResetRetryRun({ contextSnapshot: { retryReason: "assignment_recovery" } }),
    ).toBe(false);
    expect(isZeroTokenSessionResetRetryRun({ contextSnapshot: {} })).toBe(false);
    expect(isZeroTokenSessionResetRetryRun({ contextSnapshot: null })).toBe(false);
    expect(isZeroTokenSessionResetRetryRun(null)).toBe(false);
    expect(isZeroTokenSessionResetRetryRun(undefined)).toBe(false);
  });
});

describe("classifyContinuationFailure — process_lost reclassify (BLO-16182)", () => {
  it("classifies process_lost as retryable transient-infra (3 attempts + 60s backoff), not default", () => {
    const c = classifyContinuationFailure({ errorCode: "process_lost" } as never);
    expect(c.kind).toBe("transient_infra");
    expect(c.maxAttempts).toBe(3);
    expect(c.baseBackoffMs).toBe(60_000);
  });

  it("keeps the pre-existing transient-infra codes classified as transient", () => {
    for (const code of ["adapter_failed", "timeout", "codex_transient_upstream", "claude_transient_upstream"]) {
      expect(classifyContinuationFailure({ errorCode: code } as never).kind).toBe("transient_infra");
    }
  });

  it("still classifies an unknown code as default (1 attempt, no backoff)", () => {
    const c = classifyContinuationFailure({ errorCode: "some_unknown_code" } as never);
    expect(c.kind).toBe("default");
    expect(c.maxAttempts).toBe(1);
    expect(c.baseBackoffMs).toBe(0);
  });

  it("still classifies a genuinely non-retryable code as non_retryable", () => {
    expect(classifyContinuationFailure({ errorCode: "budget_exhausted" } as never).kind).toBe("non_retryable");
  });
});

describe("isContinuationAttemptRetryReason — combined process_lost attempt cap (BLO-16182)", () => {
  // process_lost has two automatic retry engines: the continuation sweep
  // (retryReason 'issue_continuation_needed') and the in-reaper
  // enqueueProcessLossRetry (retryReason 'process_lost'). Once process_lost is
  // reclassified as transient_infra (3 attempts), both engines' retries must
  // count toward the SAME bounded budget — otherwise the sweep would grant a
  // fresh 3 attempts on top of the reaper's retry, tripling re-dispatch during
  // an infra storm.
  it("counts continuation-sweep retries toward any matched error code's budget", () => {
    expect(isContinuationAttemptRetryReason("issue_continuation_needed", "process_lost")).toBe(true);
    expect(isContinuationAttemptRetryReason("issue_continuation_needed", "adapter_failed")).toBe(true);
    expect(isContinuationAttemptRetryReason("issue_continuation_needed", null)).toBe(true);
  });

  it("counts in-reaper process_lost retries toward the process_lost budget", () => {
    expect(isContinuationAttemptRetryReason("process_lost", "process_lost")).toBe(true);
  });

  it("does NOT let a process_lost-reason retry shorten a different error code's separate budget", () => {
    expect(isContinuationAttemptRetryReason("process_lost", "adapter_failed")).toBe(false);
    expect(isContinuationAttemptRetryReason("process_lost", null)).toBe(false);
  });

  it("does not count first-generation or unrelated retry reasons", () => {
    expect(isContinuationAttemptRetryReason(null, "process_lost")).toBe(false);
    expect(isContinuationAttemptRetryReason("assignment_recovery", "process_lost")).toBe(false);
    expect(isContinuationAttemptRetryReason("zero_token_session_reset", "process_lost")).toBe(false);
  });
});

