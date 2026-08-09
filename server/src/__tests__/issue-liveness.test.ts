import { describe, expect, it } from "vitest";
import { classifyIssueGraphLiveness } from "../services/issue-liveness.js";

const companyId = "company-1";
const managerId = "manager-1";
const coderId = "coder-1";
const blockerId = "blocker-1";
const blockedId = "blocked-1";

function issue(overrides: Record<string, unknown> = {}) {
  return {
    id: blockedId,
    companyId,
    identifier: "PAP-1703",
    title: "Parent work",
    status: "blocked",
    assigneeAgentId: coderId,
    assigneeUserId: null,
    createdByAgentId: null,
    createdByUserId: null,
    executionState: null,
    ...overrides,
  };
}

function agent(overrides: Record<string, unknown> = {}) {
  return {
    id: coderId,
    companyId,
    name: "Coder",
    role: "engineer",
    title: null,
    status: "idle",
    reportsTo: managerId,
    ...overrides,
  };
}

const manager = agent({
  id: managerId,
  name: "CTO",
  role: "cto",
  reportsTo: null,
});
const blocks = [{ companyId, blockerIssueId: blockerId, blockedIssueId: blockedId }];

describe("issue graph liveness classifier", () => {
  it("detects a PAP-1703-style blocked chain with an unassigned blocker and stable incident key", () => {
    const findings = classifyIssueGraphLiveness({
      issues: [
        issue(),
        issue({
          id: blockerId,
          identifier: "PAP-1704",
          title: "Missing unblock work",
          status: "todo",
          assigneeAgentId: null,
        }),
      ],
      relations: blocks,
      agents: [agent(), manager],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      issueId: blockedId,
      identifier: "PAP-1703",
      state: "blocked_by_unassigned_issue",
      recoveryIssueId: blockerId,
      recommendedOwnerAgentId: managerId,
      dependencyPath: [
        expect.objectContaining({ issueId: blockedId }),
        expect.objectContaining({ issueId: blockerId }),
      ],
      incidentKey: `harness_liveness:${companyId}:${blockedId}:blocked_by_unassigned_issue:${blockerId}`,
    });
  });

  it("does not use free-form executive role or name matching for recovery ownership", () => {
    const rootAgentId = "root-agent";
    const spoofedExecutiveId = "spoofed-executive";

    const findings = classifyIssueGraphLiveness({
      issues: [
        issue({
          assigneeAgentId: null,
          createdByAgentId: null,
        }),
        issue({
          id: blockerId,
          identifier: "PAP-1704",
          title: "Missing unblock work",
          status: "todo",
          assigneeAgentId: null,
          createdByAgentId: null,
        }),
      ],
      relations: blocks,
      agents: [
        agent({
          id: spoofedExecutiveId,
          name: "Chief Executive Recovery",
          role: "cto",
          title: "CEO",
          reportsTo: rootAgentId,
        }),
        agent({
          id: rootAgentId,
          name: "Root Operator",
          role: "operator",
          title: null,
          reportsTo: null,
        }),
      ],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.recommendedOwnerAgentId).toBe(rootAgentId);
    expect(findings[0]?.recommendedOwnerCandidates[0]).toMatchObject({
      agentId: rootAgentId,
      reason: "root_agent",
      sourceIssueId: blockerId,
    });
    expect(findings[0]?.recommendedOwnerCandidateAgentIds).toEqual([
      rootAgentId,
      spoofedExecutiveId,
    ]);
  });

  it("does not flag a live blocked chain with an active assignee and wake path", () => {
    const findings = classifyIssueGraphLiveness({
      issues: [
        issue(),
        issue({
          id: blockerId,
          identifier: "PAP-1704",
          title: "Live unblock work",
          status: "todo",
          assigneeAgentId: "blocker-agent",
        }),
      ],
      relations: blocks,
      agents: [
        agent(),
        manager,
        agent({ id: "blocker-agent", name: "Blocker Agent", reportsTo: managerId }),
      ],
      queuedWakeRequests: [{ companyId, issueId: blockerId, agentId: "blocker-agent", status: "queued" }],
    });

    expect(findings).toEqual([]);
  });

  it("detects an assigned backlog blocker leaf with no action path", () => {
    const findings = classifyIssueGraphLiveness({
      issues: [
        issue(),
        issue({
          id: blockerId,
          identifier: "PAP-1704",
          title: "Parked assigned unblock work",
          status: "backlog",
          assigneeAgentId: "blocker-agent",
        }),
      ],
      relations: blocks,
      agents: [
        agent(),
        manager,
        agent({ id: "blocker-agent", name: "Blocker Agent", reportsTo: managerId }),
      ],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      issueId: blockedId,
      identifier: "PAP-1703",
      state: "blocked_by_assigned_backlog_issue",
      recoveryIssueId: blockerId,
      recommendedOwnerAgentId: "blocker-agent",
      dependencyPath: [
        expect.objectContaining({ issueId: blockedId }),
        expect.objectContaining({ issueId: blockerId, status: "backlog" }),
      ],
      incidentKey: `harness_liveness:${companyId}:${blockedId}:blocked_by_assigned_backlog_issue:${blockerId}`,
    });
  });

  it("does not flag an assigned backlog blocker that has an explicit waiting path", () => {
    const backlogBlocker = issue({
      id: blockerId,
      identifier: "PAP-1704",
      title: "Explicitly parked unblock work",
      status: "backlog",
      assigneeAgentId: "blocker-agent",
    });
    const baseInput = {
      issues: [issue(), backlogBlocker],
      relations: blocks,
      agents: [
        agent(),
        manager,
        agent({ id: "blocker-agent", name: "Blocker Agent", reportsTo: managerId }),
      ],
    };

    expect(classifyIssueGraphLiveness({
      ...baseInput,
      issues: [issue(), { ...backlogBlocker, assigneeAgentId: null, assigneeUserId: "board-user-1" }],
    })).toEqual([]);
    expect(classifyIssueGraphLiveness({
      ...baseInput,
      activeRuns: [{ companyId, issueId: blockerId, agentId: "blocker-agent", status: "running" }],
    })).toEqual([]);
    expect(classifyIssueGraphLiveness({
      ...baseInput,
      openRecoveryIssues: [{ companyId, issueId: blockerId, status: "todo" }],
    })).toEqual([]);
  });

  it("does not flag an unassigned blocker that already has an active execution path", () => {
    const findings = classifyIssueGraphLiveness({
      issues: [
        issue(),
        issue({
          id: blockerId,
          identifier: "PAP-1704",
          title: "Unassigned but already running",
          status: "todo",
          assigneeAgentId: null,
        }),
      ],
      relations: blocks,
      agents: [agent(), manager],
      activeRuns: [{ companyId, issueId: blockerId, agentId: coderId, status: "running" }],
    });

    expect(findings).toEqual([]);
  });

  it("detects cancelled blockers and uninvokable blocker assignees deterministically", () => {
    const cancelled = classifyIssueGraphLiveness({
      issues: [
        issue(),
        issue({
          id: blockerId,
          identifier: "PAP-1704",
          title: "Cancelled unblock work",
          status: "cancelled",
          assigneeAgentId: "blocker-agent",
        }),
      ],
      relations: blocks,
      agents: [agent(), manager, agent({ id: "blocker-agent", name: "Paused", status: "paused" })],
    });
    expect(cancelled[0]?.state).toBe("blocked_by_cancelled_issue");

    const paused = classifyIssueGraphLiveness({
      issues: [
        issue(),
        issue({
          id: blockerId,
          identifier: "PAP-1704",
          title: "Paused unblock work",
          status: "todo",
          assigneeAgentId: "blocker-agent",
        }),
      ],
      relations: blocks,
      agents: [agent(), manager, agent({ id: "blocker-agent", name: "Paused", status: "paused" })],
    });
    expect(paused[0]?.state).toBe("blocked_by_uninvokable_assignee");
  });

  it("detects a cancelled blocker on an assigned todo source", () => {
    const findings = classifyIssueGraphLiveness({
      issues: [
        issue({ status: "todo" }),
        issue({
          id: blockerId,
          identifier: "PAP-1704",
          title: "Cancelled unblock work",
          status: "cancelled",
          assigneeAgentId: "blocker-agent",
        }),
      ],
      relations: blocks,
      agents: [agent(), manager, agent({ id: "blocker-agent", name: "Cancelled owner" })],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      issueId: blockedId,
      state: "blocked_by_cancelled_issue",
      recoveryIssueId: blockerId,
    });
  });

  it("prefers the blocker finding for an in-review source with a cancelled blocker", () => {
    const findings = classifyIssueGraphLiveness({
      issues: [
        issue({ status: "in_review" }),
        issue({
          id: blockerId,
          identifier: "PAP-1704",
          title: "Cancelled unblock work",
          status: "cancelled",
          assigneeAgentId: "blocker-agent",
        }),
      ],
      relations: blocks,
      agents: [agent(), manager, agent({ id: "blocker-agent", name: "Cancelled owner" })],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.state).toBe("blocked_by_cancelled_issue");
  });

  it("detects blocker assignees under terminated org ancestors as uninvokable", () => {
    const findings = classifyIssueGraphLiveness({
      issues: [
        issue(),
        issue({
          id: blockerId,
          identifier: "PAP-1704",
          title: "Invalid tree unblock work",
          status: "todo",
          assigneeAgentId: "qa-2",
        }),
      ],
      relations: blocks,
      agents: [
        agent(),
        manager,
        agent({ id: "qa-2", name: "QA 2", status: "active", reportsTo: "cto-2" }),
        agent({ id: "cto-2", name: "CTO 2", status: "terminated", reportsTo: "ceo-2" }),
        agent({ id: "ceo-2", name: "CEO 2", status: "terminated", reportsTo: null }),
      ],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      state: "blocked_by_uninvokable_assignee",
      reason: "PAP-1703 is blocked by PAP-1704, but its assignee is in an invalid org chain.",
      recommendedOwnerAgentId: managerId,
    });
  });

  it("does not exempt attribution agents under terminated org ancestors", () => {
    const findings = classifyIssueGraphLiveness({
      issues: [
        issue(),
        issue({
          id: blockerId,
          identifier: "PAP-1704",
          title: "Invalid attribution tree unblock work",
          status: "todo",
          assigneeAgentId: "operator-agent",
        }),
      ],
      relations: blocks,
      agents: [
        agent(),
        manager,
        agent({
          id: "operator-agent",
          name: "Operator",
          status: "paused",
          pauseReason: "manual",
          runtimeConfig: { heartbeat: { enabled: false } },
          reportsTo: "cto-2",
        }),
        agent({ id: "cto-2", name: "CTO 2", status: "terminated", reportsTo: "ceo-2" }),
        agent({ id: "ceo-2", name: "CEO 2", status: "terminated", reportsTo: null }),
      ],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      state: "blocked_by_uninvokable_assignee",
      reason: "PAP-1703 is blocked by PAP-1704, but its assignee is paused.",
      recommendedOwnerAgentId: managerId,
    });
  });

  it("detects invalid in_review execution participant", () => {
    const findings = classifyIssueGraphLiveness({
      issues: [
        issue({
          status: "in_review",
          executionState: {
            status: "pending",
            currentStageId: "stage-1",
            currentStageIndex: 0,
            currentStageType: "review",
            currentParticipant: { type: "agent", agentId: "missing-agent" },
            returnAssignee: { type: "agent", agentId: coderId },
            completedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: null,
          },
        }),
      ],
      relations: [],
      agents: [agent(), manager],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      state: "invalid_review_participant",
      incidentKey: `harness_liveness:${companyId}:${blockedId}:invalid_review_participant:missing-agent`,
    });
  });

  it("detects the PAP-2239-style blocked chain at the first stalled in_review leaf without duplicate findings", () => {
    const phaseIssueId = "phase-issue-1";
    const reviewLeafId = "review-leaf-1";

    const findings = classifyIssueGraphLiveness({
      issues: [
        issue({
          id: "pap-2239",
          identifier: "PAP-2239",
          title: "External object reference project",
          status: "blocked",
        }),
        issue({
          id: phaseIssueId,
          identifier: "PAP-2276",
          title: "UX acceptance review phase",
          status: "blocked",
          assigneeAgentId: coderId,
        }),
        issue({
          id: reviewLeafId,
          identifier: "PAP-2279",
          title: "Screenshot acceptance review",
          status: "in_review",
          assigneeAgentId: coderId,
          executionState: null,
        }),
      ],
      relations: [
        { companyId, blockerIssueId: phaseIssueId, blockedIssueId: "pap-2239" },
        { companyId, blockerIssueId: reviewLeafId, blockedIssueId: phaseIssueId },
      ],
      agents: [agent(), manager],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      issueId: "pap-2239",
      identifier: "PAP-2239",
      state: "in_review_without_action_path",
      recoveryIssueId: reviewLeafId,
      recommendedOwnerAgentId: coderId,
      dependencyPath: [
        expect.objectContaining({ issueId: "pap-2239" }),
        expect.objectContaining({ issueId: phaseIssueId }),
        expect.objectContaining({ issueId: reviewLeafId }),
      ],
      incidentKey: `harness_liveness:${companyId}:pap-2239:in_review_without_action_path:${reviewLeafId}`,
    });
  });

  it("skips paused stalled review assignees when choosing recovery owner candidates", () => {
    const reviewIssueId = "review-1";

    const findings = classifyIssueGraphLiveness({
      issues: [
        issue({
          id: reviewIssueId,
          identifier: "PAP-2279",
          title: "Screenshot acceptance review",
          status: "in_review",
          assigneeAgentId: coderId,
          executionState: null,
        }),
      ],
      relations: [],
      agents: [agent({ status: "paused" }), manager],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      state: "in_review_without_action_path",
      recommendedOwnerAgentId: managerId,
    });
    expect(findings[0]?.recommendedOwnerCandidates).toEqual([
      {
        agentId: managerId,
        reason: "assignee_reporting_chain",
        sourceIssueId: reviewIssueId,
      },
    ]);
  });

  it("does not flag healthy in_review issues with an explicit action path", () => {
    const reviewIssueId = "review-1";
    const baseReviewIssue = issue({
      id: reviewIssueId,
      identifier: "PAP-2279",
      title: "Screenshot acceptance review",
      status: "in_review",
      assigneeAgentId: coderId,
      executionState: null,
    });

    const cases = [
      {
        name: "typed agent participant",
        issue: {
          ...baseReviewIssue,
          executionState: {
            currentParticipant: { type: "agent", agentId: coderId },
          },
        },
      },
      {
        name: "typed user participant",
        issue: {
          ...baseReviewIssue,
          executionState: {
            currentParticipant: { type: "user", userId: "board-user-1" },
          },
        },
      },
      {
        name: "user owner",
        issue: { ...baseReviewIssue, assigneeAgentId: null, assigneeUserId: "board-user-1" },
      },
      {
        name: "active run",
        issue: baseReviewIssue,
        activeRuns: [{ companyId, issueId: reviewIssueId, agentId: coderId, status: "running" }],
      },
      {
        name: "queued wake",
        issue: baseReviewIssue,
        queuedWakeRequests: [{ companyId, issueId: reviewIssueId, agentId: coderId, status: "queued" }],
      },
      {
        name: "pending interaction",
        issue: baseReviewIssue,
        pendingInteractions: [{ companyId, issueId: reviewIssueId, status: "pending" }],
      },
      {
        name: "pending approval",
        issue: baseReviewIssue,
        pendingApprovals: [{ companyId, issueId: reviewIssueId, status: "pending" }],
      },
      {
        name: "open recovery issue",
        issue: baseReviewIssue,
        openRecoveryIssues: [{ companyId, issueId: reviewIssueId, status: "todo" }],
      },
    ];

    for (const testCase of cases) {
      const findings = classifyIssueGraphLiveness({
        issues: [testCase.issue],
        relations: [],
        agents: [agent(), manager],
        activeRuns: testCase.activeRuns,
        queuedWakeRequests: testCase.queuedWakeRequests,
        pendingInteractions: testCase.pendingInteractions,
        pendingApprovals: testCase.pendingApprovals,
        openRecoveryIssues: testCase.openRecoveryIssues,
      });

      expect(findings, testCase.name).toEqual([]);
    }
  });

  it("still flags a stalled in_review issue when its blocker has an active run", () => {
    const reviewIssueId = "review-1";
    const activeBlockerId = "active-blocker-1";

    const findings = classifyIssueGraphLiveness({
      issues: [
        issue({
          id: reviewIssueId,
          identifier: "PAP-2279",
          title: "Screenshot acceptance review",
          status: "in_review",
          assigneeAgentId: coderId,
          executionState: null,
        }),
        issue({
          id: activeBlockerId,
          identifier: "PAP-2280",
          title: "Active blocker",
          status: "in_progress",
          assigneeAgentId: coderId,
        }),
      ],
      relations: [{ companyId, blockerIssueId: activeBlockerId, blockedIssueId: reviewIssueId }],
      agents: [agent(), manager],
      activeRuns: [{ companyId, issueId: activeBlockerId, agentId: coderId, status: "running" }],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      issueId: reviewIssueId,
      state: "in_review_without_action_path",
      recoveryIssueId: reviewIssueId,
    });
  });

  it("ignores cross-company waiting paths for stalled in_review issues", () => {
    const reviewIssueId = "review-1";

    const findings = classifyIssueGraphLiveness({
      issues: [
        issue({
          id: reviewIssueId,
          identifier: "PAP-2279",
          title: "Screenshot acceptance review",
          status: "in_review",
          assigneeAgentId: coderId,
          executionState: null,
        }),
      ],
      relations: [],
      agents: [agent(), manager],
      pendingInteractions: [{ companyId: "other-company", issueId: reviewIssueId, status: "pending" }],
      openRecoveryIssues: [{ companyId: "other-company", issueId: reviewIssueId, status: "todo" }],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      state: "in_review_without_action_path",
      recoveryIssueId: reviewIssueId,
    });
  });

  it("does not flag a monitored in_review issue when the service projection carries monitor columns (BLO-8140)", () => {
    // Regression: the issueRows SELECT in collectIssueGraphLivenessFindings() previously omitted
    // monitorNextCheckAt/monitorAttemptCount/executionPolicy, causing hasScheduledMonitor() to
    // return false for any validly-monitored in_review issue and spuriously emit
    // invalid_review_participant findings.
    const now = new Date("2026-06-01T00:00:00.000Z");
    const reviewIssueId = "review-monitored-1";

    // Mirror exactly what collectIssueGraphLivenessFindings() projects from the DB:
    // a row that includes executionPolicy, monitorNextCheckAt, monitorAttemptCount.
    const projectedIssue = {
      id: reviewIssueId,
      companyId,
      identifier: "BLO-7934",
      title: "Monitor trafficcontrol builder",
      status: "in_review",
      projectId: null,
      goalId: null,
      parentId: null,
      assigneeAgentId: coderId,
      assigneeUserId: null,
      createdByAgentId: null,
      createdByUserId: null,
      executionPolicy: {
        monitor: {
          timeoutAt: "2026-06-03T00:00:00.000Z",
          maxAttempts: 3,
        },
      },
      executionState: {
        status: "pending",
        currentStageId: "stage-1",
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: "missing-agent" },
        returnAssignee: { type: "agent", agentId: coderId },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
        monitor: {
          timeoutAt: "2026-06-03T00:00:00.000Z",
          attemptCount: 1,
        },
      },
      lastActivityAt: new Date("2026-05-30T00:00:00.000Z"),
      monitorNextCheckAt: new Date("2026-06-02T00:00:00.000Z"),
      monitorAttemptCount: 1,
    };

    const findings = classifyIssueGraphLiveness({
      issues: [projectedIssue],
      relations: [],
      agents: [agent(), manager],
      now,
    });

    expect(findings.filter((f) => f.state === "invalid_review_participant")).toEqual([]);
    expect(findings).toEqual([]);
  });

  describe("monitor-only executionState is not a review workflow (BLO-20725)", () => {
    const now = new Date("2026-08-02T00:00:00.000Z");
    const reviewIssueId = "review-monitor-only-1";

    // The exact BLO-19001 shape that produced the false BLO-20627 escalation: no
    // execution policy, no stages, no participant -- the monitor is the only
    // populated substructure, and it has already fired without being re-armed.
    function monitorOnlyIssue(overrides: Record<string, unknown> = {}) {
      return issue({
        id: reviewIssueId,
        identifier: "BLO-19001",
        title: "Parked in review behind a monitor",
        status: "in_review",
        assigneeAgentId: coderId,
        executionPolicy: null,
        executionState: {
          status: "idle",
          currentStageId: null,
          currentStageIndex: null,
          currentStageType: null,
          currentParticipant: null,
          returnAssignee: null,
          reviewRequest: null,
          completedStageIds: [],
          lastDecisionId: null,
          lastDecisionOutcome: null,
          monitor: {
            status: "triggered",
            nextCheckAt: null,
            lastTriggeredAt: "2026-08-01T22:00:00.000Z",
            attemptCount: 4,
          },
        },
        monitorNextCheckAt: null,
        monitorAttemptCount: 4,
        ...overrides,
      });
    }

    it("does not report invalid_review_participant when an expired monitor is the only executionState content", () => {
      const findings = classifyIssueGraphLiveness({
        issues: [monitorOnlyIssue()],
        relations: [],
        agents: [agent(), manager],
        now,
      });

      expect(findings.filter((f) => f.state === "invalid_review_participant")).toEqual([]);
    });

    it("classifies the monitor-only issue exactly like an executionState: null issue", () => {
      const monitorFindings = classifyIssueGraphLiveness({
        issues: [monitorOnlyIssue()],
        relations: [],
        agents: [agent(), manager],
        now,
      });
      const bareFindings = classifyIssueGraphLiveness({
        issues: [monitorOnlyIssue({ executionState: null, monitorAttemptCount: null })],
        relations: [],
        agents: [agent(), manager],
        now,
      });

      // The inconsistency this fixes: arming a monitor was the only difference
      // between these two issues, and it flipped the finding to a participant
      // repair for a review workflow that never existed.
      expect(monitorFindings).toEqual(bareFindings);
      expect(monitorFindings).toHaveLength(1);
      expect(monitorFindings[0]).toMatchObject({
        state: "in_review_without_action_path",
        recoveryIssueId: reviewIssueId,
      });
    });

    it("still reports invalid_review_participant when a participant names an unresolvable agent", () => {
      const findings = classifyIssueGraphLiveness({
        issues: [
          monitorOnlyIssue({
            executionState: {
              status: "pending",
              currentStageId: "stage-1",
              currentStageIndex: 0,
              currentStageType: "review",
              currentParticipant: { type: "agent", agentId: "missing-agent" },
              returnAssignee: { type: "agent", agentId: coderId },
              reviewRequest: null,
              completedStageIds: [],
              lastDecisionId: null,
              lastDecisionOutcome: null,
              monitor: { status: "triggered", nextCheckAt: null, attemptCount: 4 },
            },
          }),
        ],
        relations: [],
        agents: [agent(), manager],
        now,
      });

      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({
        state: "invalid_review_participant",
        incidentKey: `harness_liveness:${companyId}:${reviewIssueId}:invalid_review_participant:missing-agent`,
      });
    });

    it("still reports invalid_review_participant when a configured review stage has an unresolvable participant", () => {
      // No participant agent id and no resolvable participant user, but the
      // policy carries a real review stage -- the genuine "review workflow is
      // corrupt" case that must keep firing.
      const findings = classifyIssueGraphLiveness({
        issues: [
          monitorOnlyIssue({
            executionPolicy: {
              mode: "normal",
              commentRequired: true,
              stages: [{ id: "stage-1", type: "review", approvalsNeeded: 1, participants: [] }],
            },
            executionState: {
              status: "pending",
              currentStageId: null,
              currentStageIndex: null,
              currentStageType: null,
              currentParticipant: { type: "agent" },
              returnAssignee: null,
              reviewRequest: null,
              completedStageIds: [],
              lastDecisionId: null,
              lastDecisionOutcome: null,
              monitor: { status: "triggered", nextCheckAt: null, attemptCount: 4 },
            },
          }),
        ],
        relations: [],
        agents: [agent(), manager],
        now,
      });

      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({
        state: "invalid_review_participant",
        recoveryIssueId: reviewIssueId,
      });
    });

    it("keeps suppressing every finding while the monitor is still scheduled", () => {
      const findings = classifyIssueGraphLiveness({
        issues: [
          monitorOnlyIssue({
            executionState: {
              status: "idle",
              currentStageId: null,
              currentStageIndex: null,
              currentStageType: null,
              currentParticipant: null,
              returnAssignee: null,
              reviewRequest: null,
              completedStageIds: [],
              lastDecisionId: null,
              lastDecisionOutcome: null,
              monitor: { status: "scheduled", nextCheckAt: "2026-08-02T01:00:00.000Z", attemptCount: 1 },
            },
            monitorNextCheckAt: new Date("2026-08-02T01:00:00.000Z"),
            monitorAttemptCount: 1,
          }),
        ],
        relations: [],
        agents: [agent(), manager],
        now,
      });

      expect(findings).toEqual([]);
    });
  });
});
