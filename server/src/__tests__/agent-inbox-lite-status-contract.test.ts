import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_INBOX_LITE_STATUS_FILTER,
  loadAgentInboxLite,
} from "../services/agent-inbox-lite.js";

// BLO-18858: paperclipInboxLite's tool description claimed it returned in_review work while the
// route filtered to todo/in_progress/blocked. An agent with only in_review assignments therefore
// read the (correct) empty response as a platform failure, hand-rolled a checkout-lock-blind
// issue-list sweep, and duplicated a concurrent run's work. The filter is deliberate — review
// waits resume via comment/interaction/monitor wakes — so lock the status set here to keep the
// route and its documented contract from drifting apart again.

const mockIssueService = {
  list: vi.fn(),
  listDependencyReadiness: vi.fn(),
};

const mockRecoveryActionService = {
  listActiveForIssues: vi.fn(),
};

type LoadInboxInput = Parameters<typeof loadAgentInboxLite>[0];

const inactiveWorktreeActivation: LoadInboxInput["worktreeActivation"] = {
  armed: false,
  cutoff: null,
  activationInstanceId: null,
  reason: "not_worktree_runtime",
};

function loadInbox(
  options: Pick<LoadInboxInput, "isWorktreeRuntime" | "worktreeActivation"> = {
    isWorktreeRuntime: false,
    worktreeActivation: inactiveWorktreeActivation,
  },
) {
  return loadAgentInboxLite({
    issuesSvc: mockIssueService as unknown as LoadInboxInput["issuesSvc"],
    recoveryActionsSvc: mockRecoveryActionService as unknown as LoadInboxInput["recoveryActionsSvc"],
    companyId: "company-1",
    agentId: "agent-1",
    callerRunId: "run-1",
    limit: 100,
    ...options,
  });
}

describe("agent inbox-lite status contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.list.mockResolvedValue([]);
    mockIssueService.listDependencyReadiness.mockResolvedValue(new Map());
    mockRecoveryActionService.listActiveForIssues.mockResolvedValue(new Map());
  });

  it("queries only todo, in_progress, and blocked for the calling agent", async () => {
    const items = await loadInbox();

    expect(items).toEqual([]);
    expect(mockIssueService.list).toHaveBeenCalledTimes(1);
    const [companyId, filters] = mockIssueService.list.mock.calls[0]!;
    expect(companyId).toBe("company-1");
    expect(filters.assigneeAgentId).toBe("agent-1");
    expect(filters.status).toBe(AGENT_INBOX_LITE_STATUS_FILTER);
    // The load-bearing assertion: in_review must not leak into the routine heartbeat inbox.
    expect(filters.status.split(",")).not.toContain("in_review");
  });

  it("returns an empty array — not an error — when the agent only has in_review work", async () => {
    // The service receives only the selected status set, so an empty result here means there is
    // no actionable work; callers must not treat it as a reason to sweep all assignments.
    mockIssueService.list.mockResolvedValue([]);

    await expect(loadInbox()).resolves.toEqual([]);
  });

  it("withholds work held by another live run while preserving dependency readiness on offered rows", async () => {
    mockIssueService.list.mockResolvedValue([
      {
        id: "issue-1",
        identifier: "BLO-1",
        title: "Owned by another run",
        status: "in_progress",
        priority: "high",
        projectId: null,
        goalId: null,
        parentId: null,
        createdAt: "2026-07-30T01:41:56.125Z",
        updatedAt: "2026-07-30T01:41:56.125Z",
        activeRun: { id: "run-other", status: "running" },
      },
      {
        id: "issue-2",
        identifier: "BLO-2",
        title: "Blocked but unheld",
        status: "blocked",
        priority: "high",
        projectId: null,
        goalId: null,
        parentId: null,
        createdAt: "2026-07-30T01:42:56.125Z",
        updatedAt: "2026-07-30T01:42:56.125Z",
        activeRun: null,
      },
    ]);
    mockIssueService.listDependencyReadiness.mockResolvedValue(
      new Map([
        ["issue-1", { isDependencyReady: true, unresolvedBlockerCount: 0, unresolvedBlockerIssueIds: [] }],
        ["issue-2", { isDependencyReady: false, unresolvedBlockerCount: 2, unresolvedBlockerIssueIds: ["b1", "b2"] }],
      ]),
    );

    const items = await loadInbox();

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: "issue-2",
      activeRun: null,
      dependencyReady: false,
      unresolvedBlockerCount: 2,
      unresolvedBlockerIssueIds: ["b1", "b2"],
    });
  });

  it("suppresses pre-activation work for a worktree runtime", async () => {
    mockIssueService.list.mockResolvedValue([
      {
        id: "before-cutoff",
        identifier: "BLO-3",
        title: "Old work",
        status: "todo",
        priority: "high",
        projectId: null,
        goalId: null,
        parentId: null,
        createdAt: "2026-07-30T01:41:56.125Z",
        updatedAt: "2026-07-30T01:41:56.125Z",
        activeRun: null,
      },
      {
        id: "after-cutoff",
        identifier: "BLO-4",
        title: "New work",
        status: "todo",
        priority: "high",
        projectId: null,
        goalId: null,
        parentId: null,
        createdAt: "2026-07-30T01:43:56.125Z",
        updatedAt: "2026-07-30T01:43:56.125Z",
        activeRun: null,
      },
    ]);

    const items = await loadInbox({
      isWorktreeRuntime: true,
      worktreeActivation: {
        armed: true,
        cutoff: "2026-07-30T01:42:56.125Z",
        activationInstanceId: "worktree-1",
        reason: null,
      },
    });

    expect(items.map((issue) => issue.id)).toEqual(["after-cutoff"]);
  });
});
