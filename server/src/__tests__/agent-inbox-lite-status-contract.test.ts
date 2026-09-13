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
  options: Partial<
    Pick<LoadInboxInput, "isWorktreeRuntime" | "worktreeActivation" | "callerRunId" | "nowMs">
  > = {},
) {
  return loadAgentInboxLite({
    issuesSvc: mockIssueService as unknown as LoadInboxInput["issuesSvc"],
    recoveryActionsSvc: mockRecoveryActionService as unknown as LoadInboxInput["recoveryActionsSvc"],
    companyId: "company-1",
    agentId: "agent-1",
    callerRunId: "run-1",
    limit: 100,
    isWorktreeRuntime: false,
    worktreeActivation: inactiveWorktreeActivation,
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

// BLO-29965: two concurrent runs of ONE agent both reached "open a PR" on the
// same issue, twice, measured. The self-selection guard only withheld rows whose
// `activeRun.status === "running"`, but the sibling that already owned the work
// was parked in `scheduled_retry` — a status that HOLDS the issue execution lock
// (checkout() 409s naming it) and that is absent from `activeRun` entirely,
// because that projection is hydrated from `issues.executionRunId` and an
// autonomous retry chain never sets it. So the row read as unattended and was
// handed to a second run.
//
// Reproduces the 2026-09-03 timeline on BLO-31354 / paperclip#1612 exactly:
// run A parked 01:52Z with scheduledRetryAt 02:22:54Z; run B woke 02:18Z, was
// offered the row, did the same fix, and had its push rejected
// non-fast-forward when A's retry pushed at 02:33Z.
describe("agent inbox-lite concurrent-claim guard (BLO-29965)", () => {
  const RETRY_AT = "2026-09-03T02:22:54.000Z";
  const RUN_B_WOKE = Date.parse("2026-09-03T02:18:00.000Z");

  function parkedRetryRow(overrides: Record<string, unknown> = {}) {
    return {
      id: "issue-1",
      identifier: "BLO-31354",
      title: "Flaky merge-queue gate",
      status: "in_progress",
      priority: "high",
      projectId: null,
      goalId: null,
      parentId: null,
      createdAt: "2026-09-02T22:32:10.675Z",
      updatedAt: "2026-09-03T01:52:00.000Z",
      // The reading that looked like "nobody is on this".
      activeRun: null,
      scheduledRetryAt: RETRY_AT,
      scheduledRetryReason: "ccrotate_capacity",
      scheduledRetryAttempt: 1,
      scheduledRetryRunId: "run-a",
      // run-a belongs to the SAME agent as the caller: the sibling case.
      scheduledRetryAgentId: "agent-1",
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.listDependencyReadiness.mockResolvedValue(new Map());
    mockRecoveryActionService.listActiveForIssues.mockResolvedValue(new Map());
  });

  it("withholds a row a sibling run is parked on via scheduled retry", async () => {
    mockIssueService.list.mockResolvedValue([parkedRetryRow()]);
    const onWithheldForeignScheduledRetry = vi.fn();

    const items = await loadAgentInboxLite({
      issuesSvc: mockIssueService as unknown as LoadInboxInput["issuesSvc"],
      recoveryActionsSvc:
        mockRecoveryActionService as unknown as LoadInboxInput["recoveryActionsSvc"],
      companyId: "company-1",
      agentId: "agent-1",
      callerRunId: "run-b",
      limit: 100,
      isWorktreeRuntime: false,
      worktreeActivation: inactiveWorktreeActivation,
      nowMs: RUN_B_WOKE,
      onWithheldForeignScheduledRetry,
    });

    // Exactly one run reaches the side-effect path; this one gets nothing.
    expect(items).toEqual([]);
    // And the withholding is distinguishable from the running-run case, so a
    // lost claim is auditable rather than looking like an empty inbox.
    expect(onWithheldForeignScheduledRetry).toHaveBeenCalledTimes(1);
    expect(onWithheldForeignScheduledRetry.mock.calls[0]![0]).toMatchObject({
      id: "issue-1",
      scheduledRetryRunId: "run-a",
    });
  });

  it("still offers the row to the run that OWNS the parked retry", async () => {
    // The mirror failure: deferring to your own retry hides your work from your
    // own inbox, which reads as "no work" and exits — a silent strand.
    mockIssueService.list.mockResolvedValue([parkedRetryRow()]);

    const items = await loadInbox({ callerRunId: "run-a", nowMs: RUN_B_WOKE });

    expect(items.map((issue) => issue.id)).toEqual(["issue-1"]);
  });

  it("offers the row again once the retry has lapsed well past its horizon", async () => {
    // A retry that never fires must not make the row permanently unpickable.
    mockIssueService.list.mockResolvedValue([parkedRetryRow()]);

    const items = await loadInbox({
      callerRunId: "run-b",
      nowMs: Date.parse(RETRY_AT) + 3 * 60 * 60 * 1000,
    });

    expect(items.map((issue) => issue.id)).toEqual(["issue-1"]);
  });

  it("offers rows with no armed retry — the ordinary case is untouched", async () => {
    mockIssueService.list.mockResolvedValue([
      parkedRetryRow({
        scheduledRetryAt: null,
        scheduledRetryReason: null,
        scheduledRetryAttempt: null,
        scheduledRetryRunId: null,
        scheduledRetryAgentId: null,
      }),
    ]);

    const items = await loadInbox({ callerRunId: "run-b", nowMs: RUN_B_WOKE });

    expect(items.map((issue) => issue.id)).toEqual(["issue-1"]);
  });

  // BLO-29965 review round 3. Reassigning an issue leaves the previous
  // assignee's `scheduled_retry` row alive — `issues.update` nulls only the
  // issue-side lock columns and never writes `heartbeat_runs`. The new assignee
  // then saw a retry run id that was simply not its own and hid its own row.
  //
  // Self-sustaining, which is what made it worth fixing rather than tolerating:
  // the sweep that clears the stale retry runs from `enqueueWakeup`, and an
  // agent whose inbox reads empty exits without enqueuing anything.
  it("offers a reassigned row whose stale retry belongs to the PREVIOUS assignee", async () => {
    mockIssueService.list.mockResolvedValue([
      parkedRetryRow({ scheduledRetryAgentId: "agent-previous" }),
    ]);
    const onWithheldForeignScheduledRetry = vi.fn();

    const items = await loadAgentInboxLite({
      issuesSvc: mockIssueService as unknown as LoadInboxInput["issuesSvc"],
      recoveryActionsSvc:
        mockRecoveryActionService as unknown as LoadInboxInput["recoveryActionsSvc"],
      companyId: "company-1",
      agentId: "agent-1",
      callerRunId: "run-b",
      limit: 100,
      isWorktreeRuntime: false,
      worktreeActivation: inactiveWorktreeActivation,
      nowMs: RUN_B_WOKE,
      onWithheldForeignScheduledRetry,
    });

    expect(items.map((issue) => issue.id)).toEqual(["issue-1"]);
    expect(onWithheldForeignScheduledRetry).not.toHaveBeenCalled();
  });
});
