import { describe, expect, it } from "vitest";
import {
  FINISH_SUCCESSFUL_RUN_HANDOFF_REASON,
  SUCCESSFUL_RUN_HANDOFF_EXHAUSTED_NOTICE_BODY,
  SUCCESSFUL_RUN_HANDOFF_REQUIRED_NOTICE_BODY,
  SUCCESSFUL_RUN_MISSING_STATE_REASON,
  buildFinishSuccessfulRunHandoffIdempotencyKey,
  buildSuccessfulRunHandoffExhaustedNotice,
  buildSuccessfulRunHandoffRequiredNotice,
  decideSuccessfulRunHandoff,
  isIdempotentFinishSuccessfulRunHandoffWakeStatus,
  isSuccessfulRunHandoffValidPathSkip,
  isSuccessfulRunHandoffRequiredNoticeBody,
  noticeMetadataReferencesRecoveryAction,
  type IssueRow,
} from "./successful-run-handoff.js";
import { ALERTMANAGER_ORIGIN_KIND, isAlertEscalationLadderOriginKind } from "./origins.js";
import { UNMANAGED_BACKGROUND_TASK_LIVENESS_REASON } from "@paperclipai/adapter-utils/server-utils";

const run = {
  id: "run-1",
  companyId: "company-1",
  agentId: "agent-1",
  status: "succeeded",
  contextSnapshot: { issueId: "issue-1" },
} as any;

// Typed rather than `as any`: the PEN-2918 guard reads `originKind`, so the
// spreads below have to be type-checked against `IssueRow` for the test to
// prove anything about the shape the production caller actually passes.
const issue: IssueRow = {
  id: "issue-1",
  companyId: "company-1",
  identifier: "PAP-1",
  title: "Finish backend handoff",
  status: "in_progress",
  workMode: "standard",
  assigneeAgentId: "agent-1",
  assigneeUserId: null,
  executionState: null,
  // `issues.origin_kind` is NOT NULL with default `manual`, so this -- not
  // `null` -- is what an ordinary hand-filed row carries in production.
  originKind: "manual",
};

const agent = {
  id: "agent-1",
  companyId: "company-1",
  status: "idle",
} as any;

function decide(overrides: Partial<Parameters<typeof decideSuccessfulRunHandoff>[0]> = {}) {
  return decideSuccessfulRunHandoff({
    run,
    issue,
    agent,
    livenessState: "advanced",
    detectedProgressSummary: "Run produced concrete action evidence: 1 issue comment(s)",
    taskKey: "issue-1",
    hasActiveExecutionPath: false,
    hasQueuedWake: false,
    hasPendingInteractionOrApproval: false,
    hasPersistedMonitor: false,
    hasExplicitBlockerPath: false,
    hasOpenRecoveryIssue: false,
    hasPauseHold: false,
    isRoutineReceiverParent: false,
    hasActiveRoutineContinuation: false,
    budgetBlocked: false,
    idempotentWakeExists: false,
    ...overrides,
  });
}

describe("successful run handoff decision", () => {
  it("queues one status-only corrective wake to the original agent when a successful run has no disposition", () => {
    const decision = decide();

    expect(decision.kind).toBe("enqueue");
    if (decision.kind !== "enqueue") return;
    expect(decision.targetAgentId).toBe(run.agentId);
    expect(decision.idempotencyKey).toBe("finish_successful_run_handoff:issue-1:run-1:1");
    expect(decision.payload).toMatchObject({
      issueId: "issue-1",
      sourceRunId: "run-1",
      handoffRequired: true,
      handoffReason: SUCCESSFUL_RUN_MISSING_STATE_REASON,
      missingDisposition: "clear_next_step",
      handoffAttempt: 1,
      maxHandoffAttempts: 1,
      resumeIntent: true,
      resumeFromRunId: "run-1",
      modelProfile: "cheap",
      allowDeliverableWork: false,
      allowDocumentUpdates: false,
      resumeRequiresNormalModel: true,
    });
    expect(decision.contextSnapshot).toMatchObject({
      wakeReason: FINISH_SUCCESSFUL_RUN_HANDOFF_REASON,
      handoffRequired: true,
      modelProfile: "cheap",
      allowDeliverableWork: false,
      allowDocumentUpdates: false,
      resumeRequiresNormalModel: true,
    });
    expect(decision.instruction).toContain(
      "This is a status-only retry to the original agent. Record a disposition; do not start new work.",
    );
    expect(decision.instruction).toContain("Resolve the missing disposition before creating or revising any new artifacts");
    expect(decision.instruction).toContain("Choose **exactly one** outcome");
    expect(decision.instruction).toContain(
      "Mark it `done` only after verifying the acceptance criteria and one qualifying completion artifact: a committed, remotely resolvable artifact or PR, a run-attributed durable issue artifact, or the valid checked-out execution path",
    );
    expect(decision.instruction).toContain("record an explicit continuation path");
  });

  it("uses the normal model lane when a planning handoff must revise an issue document", () => {
    const decision = decide({ issue: { ...issue, workMode: "planning" } as any });

    expect(decision.kind).toBe("enqueue");
    if (decision.kind !== "enqueue") return;
    expect(decision.payload).not.toHaveProperty("modelProfile");
    expect(decision.payload).toMatchObject({
      recoveryIntent: "planning_only",
      allowDeliverableWork: false,
      allowDocumentUpdates: true,
      resumeRequiresNormalModel: false,
    });
    expect(decision.contextSnapshot).not.toHaveProperty("modelProfile");
    expect(decision.contextSnapshot).toMatchObject({
      recoveryIntent: "planning_only",
      allowDeliverableWork: false,
      allowDocumentUpdates: true,
      resumeRequiresNormalModel: false,
    });
    expect(decision.instruction).toContain("normal-model planning continuation");
    expect(decision.instruction).toContain("Complete the required plan or issue-document update");
    expect(decision.instruction).not.toContain("document or plan updates are not allowed");
  });

  // BLO-23197. The deadlock: a status-only run is refused an issue-document
  // write, ends without a disposition, and the corrective wake queued in
  // response inherits the same status-only lane — so it hits the identical 403
  // and the issue can never self-heal. `workMode` cannot detect this; the issue
  // in the live report (and BLO-23032 before it) is `standard`.
  //
  // `workMode: "standard"` is asserted explicitly here rather than inherited
  // from the fixture: if that fixture ever changes to `planning`, this test
  // would pass via the pre-existing escalation and stop covering the defect.
  it("escalates off the status-only lane when the source run was refused an issue-document write", () => {
    expect(issue.workMode).toBe("standard");
    const decision = decide({
      run: { ...run, statusOnlyDocumentWriteRefusedAt: new Date("2026-09-04T17:00:00Z") } as any,
    });

    expect(decision.kind).toBe("enqueue");
    if (decision.kind !== "enqueue") return;
    // The load-bearing assertion, straight off the acceptance criteria: the
    // follow-up wake is not cheap/status_only, so it can write the artifact.
    expect(decision.payload).not.toHaveProperty("modelProfile");
    expect(decision.contextSnapshot).not.toHaveProperty("modelProfile");
    expect(decision.payload).toMatchObject({
      recoveryIntent: "planning_only",
      allowDocumentUpdates: true,
      resumeRequiresNormalModel: false,
    });
    expect(decision.contextSnapshot).toMatchObject({
      recoveryIntent: "planning_only",
      allowDocumentUpdates: true,
      resumeRequiresNormalModel: false,
    });
    // Escalation is to planning_only, NOT to unrestricted work: the refused
    // write was a document, and deliverables still require a full normal-model
    // run that this detector does not hand out on its own.
    expect(decision.payload).toMatchObject({ allowDeliverableWork: false });
    // The instruction must not contradict the lane it is dispatched on. It used
    // to re-derive this sentence from `workMode` independently, so on a
    // `standard` issue it would have told the agent document updates were
    // barred while granting a lane that permits them.
    expect(decision.instruction).not.toContain("document or plan updates are not allowed");
    expect(decision.instruction).toContain("Complete the required plan or issue-document update");
  });

  // Guards the sign of the check. `statusOnlyDocumentWriteRefusedAt` is absent
  // (rather than null) on any partially-constructed run row, and a truthiness
  // slip such as `!== null` would read that as "refused" and silently escalate
  // EVERY corrective wake to the normal model — a cost regression invisible to
  // the test above, which only ever sets the field.
  it.each([
    ["null", null],
    ["undefined", undefined],
  ])("keeps the status-only lane when no document write was refused (%s)", (_label, refusedAt) => {
    const decision = decide({ run: { ...run, statusOnlyDocumentWriteRefusedAt: refusedAt } as any });

    expect(decision.kind).toBe("enqueue");
    if (decision.kind !== "enqueue") return;
    expect(decision.payload).toMatchObject({
      modelProfile: "cheap",
      recoveryIntent: "status_only",
      allowDocumentUpdates: false,
      resumeRequiresNormalModel: true,
    });
    expect(decision.instruction).toContain("This is a status-only retry to the original agent.");
  });

  it("does not queue when the issue already has a valid disposition", () => {
    expect(decide({ issue: { ...issue, status: "done" } as any })).toEqual({
      kind: "skip",
      reason: "issue status done is a valid disposition",
    });
  });

  it("does not queue when a successful run records an accepted next-action path", () => {
    expect(decide({ issue: { ...issue, status: "in_review" } as any })).toEqual({
      kind: "skip",
      reason: "issue status in_review is a valid disposition",
    });
    expect(decide({ issue: { ...issue, status: "blocked" } as any })).toEqual({
      kind: "skip",
      reason: "issue status blocked is a valid disposition",
    });
    expect(decide({ hasPendingInteractionOrApproval: true })).toEqual({
      kind: "skip",
      reason: "pending interaction or approval owns the next action",
    });
    expect(decide({ hasPersistedMonitor: true })).toEqual({
      kind: "skip",
      reason: "persisted issue monitor owns the next action",
    });
    expect(decide({ hasActiveExecutionPath: true })).toEqual({
      kind: "skip",
      reason: "issue already has an active execution path",
    });
  });

  it("identifies valid-path skips that can durably resolve a stale required event", () => {
    expect(isSuccessfulRunHandoffValidPathSkip(decide({ hasActiveExecutionPath: true }))).toBe(true);
    expect(isSuccessfulRunHandoffValidPathSkip(decide({ hasQueuedWake: true }))).toBe(true);
    expect(isSuccessfulRunHandoffValidPathSkip(decide({ budgetBlocked: true }))).toBe(false);
  });

  it("does not treat killed background-task evidence as a missing live path when a durable monitor owns the wait", () => {
    expect(decide({
      detectedProgressSummary: UNMANAGED_BACKGROUND_TASK_LIVENESS_REASON,
      livenessState: "needs_followup",
      hasPersistedMonitor: true,
    })).toEqual({
      kind: "skip",
      reason: "persisted issue monitor owns the next action",
    });
  });

  it("does not queue when another wake or dependency path already owns the next action", () => {
    expect(decide({ hasQueuedWake: true })).toEqual({
      kind: "skip",
      reason: "issue already has a queued or deferred wake",
    });
    expect(decide({ hasPersistedMonitor: true })).toEqual({
      kind: "skip",
      reason: "persisted issue monitor owns the next action",
    });
    expect(decide({ hasExplicitBlockerPath: true })).toEqual({
      kind: "skip",
      reason: "explicit blocker path owns the next action",
    });
  });

  it("does not queue for an alert row — the escalation ladder owns its next action (PEN-2918)", () => {
    const alertIssue: IssueRow = { ...issue, originKind: ALERTMANAGER_ORIGIN_KIND };
    const decision = decide({ issue: alertIssue });

    expect(decision).toEqual({
      kind: "skip",
      reason: "alert escalation ladder owns the next action",
    });
    // A valid-path skip, not a fault: the ladder IS the disposition mechanism,
    // so this must not be reported as an unresolved recovery.
    expect(isSuccessfulRunHandoffValidPathSkip(decision)).toBe(true);
  });

  it("skips the alert row even when it looks maximally like a stranded one (PEN-2918)", () => {
    // Every signal disposition recovery keys on says "abandoned": the run
    // produced progress, the row is in_progress, and no monitor, blocker,
    // wake, interaction or execution path is attending it. That is exactly the
    // shape of an unacknowledged alert mid-ladder — PEN-5094 at rung 0 — and
    // it is the case the guard exists for. Without the skip this returns
    // `queue`, and the wake it queues asks the owner for a disposition that
    // would stop or defer the ladder.
    expect(decide({
      issue: { ...issue, originKind: ALERTMANAGER_ORIGIN_KIND },
      livenessState: "advanced",
      detectedProgressSummary: "Run produced concrete action evidence: 1 issue comment(s)",
    })).toEqual({
      kind: "skip",
      reason: "alert escalation ladder owns the next action",
    });
  });

  it("still queues for a non-alert row with the same shape (PEN-2918 negative control)", () => {
    // Pins the guard to the origin kind rather than to anything the alert row
    // happens to share with ordinary work. `manual` is the ordinary case -- the
    // NOT NULL column default -- and the second assertion rejects a near-miss
    // origin kind so a future rename cannot widen the skip silently.
    expect(decide({ issue: { ...issue, originKind: "manual" } }).kind).toBe("enqueue");
    expect(decide({ issue: { ...issue, originKind: "plugin:paperclip-plugin-slack" } }).kind).toBe("enqueue");
    // The helper's signature is deliberately wider than the column, so the
    // nullish arms are exercised directly. They cannot be reached through
    // `decide()`: `issues.origin_kind` is NOT NULL, so building a row with
    // `originKind: null` only type-checks behind a cast, and casting it is what
    // hid the missing `IssueRow` field in the first place.
    expect(isAlertEscalationLadderOriginKind(null)).toBe(false);
    expect(isAlertEscalationLadderOriginKind(undefined)).toBe(false);
    expect(isAlertEscalationLadderOriginKind(ALERTMANAGER_ORIGIN_KIND)).toBe(true);
  });

  it("does not queue when the issue is the recurring parent of an active routine", () => {
    expect(decide({ hasActiveRoutineContinuation: true })).toEqual({
      kind: "skip",
      reason: "active routine continuation owns the next action",
    });
    expect(decide({
      hasActiveRoutineContinuation: true,
      detectedProgressSummary: null,
      livenessState: null,
    })).toEqual({
      kind: "skip",
      reason: "active routine continuation owns the next action",
    });
    expect(decide({
      hasActiveRoutineContinuation: true,
      livenessState: "advanced",
      detectedProgressSummary: "Run produced concrete action evidence: 1 issue comment(s)",
    })).toEqual({
      kind: "skip",
      reason: "active routine continuation owns the next action",
    });
  });

  it("does not queue when a successful run has no progress signal", () => {
    expect(decide({ livenessState: null, detectedProgressSummary: null })).toEqual({
      kind: "skip",
      reason: "successful run did not produce handoff-relevant progress",
    });
  });

  it("does not treat adapter or runtime failures as missing-disposition handoffs", () => {
    expect(decide({ run: { ...run, status: "failed", errorCode: "adapter_failed" } as any })).toEqual({
      kind: "skip",
      reason: "source run did not succeed",
    });
  });

  it("does not queue on missing-comment retry bookkeeping runs", () => {
    expect(decide({ run: { ...run, issueCommentStatus: "retry_exhausted" } as any })).toEqual({
      kind: "skip",
      reason: "missing issue comment retry owns the next action",
    });
  });

  it("does not loop from a corrective handoff run", () => {
    expect(decide({
      run: {
        ...run,
        id: "run-2",
        contextSnapshot: {
          issueId: "issue-1",
          wakeReason: FINISH_SUCCESSFUL_RUN_HANDOFF_REASON,
          handoffRequired: true,
        },
      } as any,
    })).toEqual({
      kind: "skip",
      reason: "source run is already a corrective handoff run",
    });
  });

  it("does not re-run a successful GitHub PR review after only the issue disposition write failed", () => {
    expect(decide({
      run: {
        ...run,
        contextSnapshot: {
          issueId: "issue-1",
          taskId: "issue-1",
          wakeReason: "github_pr_review_requested",
          reviewKind: "pr_review",
          githubRepoFullName: "Blockcast/linux-amt",
          githubPrNumber: 51,
          githubHeadSha: "54900568",
        },
      } as any,
    })).toEqual({
      kind: "skip",
      reason: "successful PR review run already may have emitted an external side effect",
    });
  });

  // BLO-47468: a PR-event wake that only commented leaves the checkout restore
  // marker in place; the deferred restore owns the disposition.
  it("does not queue for a PR-event wake that made no status write", () => {
    expect(decide({
      run: { ...run, contextSnapshot: { issueId: "issue-1", wakeReason: "github_pr_review_submitted" } } as any,
      issue: { ...issue, checkoutRestoreStatus: "todo" } as any,
    })).toEqual({
      kind: "skip",
      reason: "PR-event wake made no status write; checkout restore owns the disposition",
    });
  });

  it("still queues for a PR-event wake whose run explicitly wrote in_progress", () => {
    expect(decide({
      run: { ...run, contextSnapshot: { issueId: "issue-1", wakeReason: "github_pr_closed" } } as any,
      issue: { ...issue, checkoutRestoreStatus: null } as any,
    }).kind).toBe("enqueue");
  });

  it("still queues for an actionable PR-event wake that made no status write", () => {
    expect(decide({
      run: { ...run, contextSnapshot: { issueId: "issue-1", wakeReason: "github_pr_review_gate_failed" } } as any,
      issue: { ...issue, checkoutRestoreStatus: "in_review" } as any,
    }).kind).toBe("enqueue");
  });

  it("still queues for a non-PR wake that made no status write", () => {
    expect(decide({
      run: { ...run, contextSnapshot: { issueId: "issue-1", wakeReason: "issue_assigned" } } as any,
      issue: { ...issue, checkoutRestoreStatus: "todo" } as any,
    }).kind).toBe("enqueue");
  });

  it("queues a status-only handoff for a preserved missing-Job PR review outcome", () => {
    const decision = decide({
      run: {
        ...run,
        contextSnapshot: {
          issueId: "issue-1",
          taskId: "issue-1",
          wakeReason: "github_pr_review_requested",
          reviewKind: "pr_review",
          githubRepoFullName: "Blockcast/linux-amt",
          githubPrNumber: 51,
          githubHeadSha: "54900568",
        },
        resultJson: {
          externalLifecycleRecovery: {
            reason: "job_missing_recorded_outcome_preserved",
          },
        },
      } as any,
    });

    expect(decision).toMatchObject({
      kind: "enqueue",
      targetAgentId: "agent-1",
      payload: {
        handoffReason: SUCCESSFUL_RUN_MISSING_STATE_REASON,
      },
    });
  });

  it("does not queue for issue monitor maintenance runs", () => {
    expect(decide({
      run: {
        ...run,
        contextSnapshot: {
          issueId: "issue-1",
          source: "issue.monitor",
          wakeReason: "issue_monitor_due",
        },
      } as any,
    })).toEqual({
      kind: "skip",
      reason: "issue monitor run owns its own recovery path",
    });
  });

  it("does not queue for a routine receiver-parent issue", () => {
    expect(decide({ isRoutineReceiverParent: true })).toEqual({
      kind: "skip",
      reason: "issue is a routine receiver parent",
    });
  });

  it("does not queue for successful comment-driven wakes", () => {
    expect(decide({
      run: {
        ...run,
        contextSnapshot: {
          issueId: "issue-1",
          wakeReason: "issue_commented",
          commentId: "comment-1",
          wakeCommentIds: ["comment-1"],
        },
      } as any,
    })).toEqual({
      kind: "skip",
      reason: "comment-driven wake already owns the next action",
    });
  });

  it("uses a stable one-attempt idempotency key", () => {
    expect(buildFinishSuccessfulRunHandoffIdempotencyKey({
      issueId: "issue-1",
      sourceRunId: "run-1",
    })).toBe("finish_successful_run_handoff:issue-1:run-1:1");
  });

  it("allows failed or cancelled corrective wakes to be retried", () => {
    expect(isIdempotentFinishSuccessfulRunHandoffWakeStatus("queued")).toBe(true);
    expect(isIdempotentFinishSuccessfulRunHandoffWakeStatus("claimed")).toBe(true);
    expect(isIdempotentFinishSuccessfulRunHandoffWakeStatus("completed")).toBe(true);
    expect(isIdempotentFinishSuccessfulRunHandoffWakeStatus("failed")).toBe(false);
    expect(isIdempotentFinishSuccessfulRunHandoffWakeStatus("cancelled")).toBe(false);
  });

  it("builds the required system notice with hidden structured metadata", () => {
    const notice = buildSuccessfulRunHandoffRequiredNotice({
      issue: {
        id: "11111111-1111-4111-8111-111111111111",
        identifier: "PAP-1",
        title: "Finish backend handoff",
        status: "in_progress",
      } as any,
      run: {
        id: "22222222-2222-4222-8222-222222222222",
        status: "succeeded",
      } as any,
      agent: {
        id: "33333333-3333-4333-8333-333333333333",
        name: "CodexCoder",
      } as any,
      detectedProgressSummary: "Run produced concrete action evidence: 1 issue comment(s)",
    });

    expect(notice.body).toBe(SUCCESSFUL_RUN_HANDOFF_REQUIRED_NOTICE_BODY);
    expect(notice.presentation).toEqual({
      kind: "system_notice",
      tone: "warning",
      title: "Missing issue disposition",
      detailsDefaultOpen: false,
    });
    expect(notice.metadata.sourceRunId).toBe("22222222-2222-4222-8222-222222222222");
    expect(notice.metadata.sections).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: "Required action",
        rows: expect.arrayContaining([
          expect.objectContaining({ type: "issue_link", identifier: "PAP-1" }),
          expect.objectContaining({ type: "agent_link", name: "CodexCoder" }),
          expect.objectContaining({ type: "key_value", label: "Missing disposition", value: "clear_next_step" }),
        ]),
      }),
      expect.objectContaining({
        title: "Run evidence",
        rows: expect.arrayContaining([
          expect.objectContaining({ type: "run_link", runId: "22222222-2222-4222-8222-222222222222" }),
          expect.objectContaining({ type: "key_value", label: "Normalized cause", value: SUCCESSFUL_RUN_MISSING_STATE_REASON }),
          expect.objectContaining({ type: "key_value", label: "Detected progress" }),
        ]),
      }),
    ]));
  });

  it("builds the exhausted system notice with recovery metadata", () => {
    const notice = buildSuccessfulRunHandoffExhaustedNotice({
      issue: {
        id: "11111111-1111-4111-8111-111111111111",
        identifier: "PAP-1",
        title: "Finish backend handoff",
        status: "in_progress",
      } as any,
      sourceRun: { id: "22222222-2222-4222-8222-222222222222", status: "succeeded" } as any,
      correctiveRun: { id: "44444444-4444-4444-8444-444444444444", status: "failed" } as any,
      sourceAssignee: { id: "33333333-3333-4333-8333-333333333333", name: "CodexCoder" } as any,
      recoveryIssue: {
        id: "55555555-5555-4555-8555-555555555555",
        identifier: "PAP-2",
        title: "Recover missing next step PAP-1",
        status: "todo",
      } as any,
      recoveryActionId: "77777777-7777-4777-8777-777777777777",
      recoveryOwner: { id: "66666666-6666-4666-8666-666666666666", name: "CTO" } as any,
      latestIssueStatus: "in_progress",
      latestHandoffRunStatus: "failed",
      missingDisposition: "clear_next_step",
    });

    expect(notice.body).toBe(SUCCESSFUL_RUN_HANDOFF_EXHAUSTED_NOTICE_BODY);
    expect(notice.presentation).toMatchObject({
      kind: "system_notice",
      tone: "danger",
      detailsDefaultOpen: false,
    });
    expect(notice.metadata.sourceRunId).toBe("22222222-2222-4222-8222-222222222222");
    expect(notice.metadata.sections).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: "Recovery owner",
        rows: expect.arrayContaining([
          expect.objectContaining({ type: "key_value", label: "Recovery action", value: "77777777-7777-4777-8777-777777777777" }),
          expect.objectContaining({ type: "agent_link", label: "Recovery owner", name: "CTO" }),
        ]),
      }),
      expect.objectContaining({
        title: "Run evidence",
        rows: expect.arrayContaining([
          expect.objectContaining({ type: "run_link", label: "Source run" }),
          expect.objectContaining({ type: "run_link", label: "Corrective handoff run" }),
          expect.objectContaining({ type: "key_value", label: "Missing disposition", value: "clear_next_step" }),
        ]),
      }),
    ]));
    expect(noticeMetadataReferencesRecoveryAction(notice.metadata, "77777777-7777-4777-8777-777777777777")).toBe(true);
    expect(noticeMetadataReferencesRecoveryAction(notice.metadata, "88888888-8888-4888-8888-888888888888")).toBe(false);
  });

  it("recognizes new notices and legacy markdown headings for fallback deduplication", () => {
    expect(isSuccessfulRunHandoffRequiredNoticeBody(SUCCESSFUL_RUN_HANDOFF_REQUIRED_NOTICE_BODY)).toBe(true);
    expect(isSuccessfulRunHandoffRequiredNoticeBody("## Successful run missing issue disposition\n\nold body")).toBe(true);
    expect(isSuccessfulRunHandoffRequiredNoticeBody("## This issue still needs a next step\n\nold body")).toBe(true);
    expect(isSuccessfulRunHandoffRequiredNoticeBody("Unrelated comment")).toBe(false);
  });
});

describe("successful run handoff notice metadata bounds (BLO-48950)", () => {
  it("truncates over-long issue titles and agent names so the notice passes the comment-metadata schema", async () => {
    const { issueCommentMetadataSchema } = await import("@paperclipai/shared");
    const longIssue = { id: "11111111-1111-4111-8111-111111111111", identifier: "BLO-1", title: "x".repeat(300), status: "in_progress" };
    const longAgent = { id: "22222222-2222-4222-8222-222222222222", name: "a".repeat(200) };
    const notice = buildSuccessfulRunHandoffExhaustedNotice({
      issue: longIssue,
      sourceRun: null,
      correctiveRun: null,
      sourceAssignee: longAgent,
      recoveryIssue: longIssue,
      recoveryOwner: longAgent,
      latestIssueStatus: "in_progress",
      latestHandoffRunStatus: "succeeded",
      missingDisposition: "none",
    });
    const parsed = issueCommentMetadataSchema.safeParse(notice.metadata);
    expect(parsed.success).toBe(true);
    const row = notice.metadata.sections[0]!.rows[0] as { title?: string };
    expect(row.title).toHaveLength(240);
    expect(row.title!.endsWith("...")).toBe(true);
  });
});
