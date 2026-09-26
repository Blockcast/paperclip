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
        scheduledRetryParkedRuns: [],
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
        scheduledRetryParkedRuns: [],
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
        scheduledRetryParkedRuns: [],
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
        scheduledRetryParkedRuns: [],
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

// BLO-34421: the WIP doctrine's attendance predicate is
// `activeRun != null` OR a future `monitorNextCheckAt` OR `scheduledRetryAt != null`.
// inbox-lite's projection hydrated only the first, so the other two arms read as
// absent keys and the predicate collapsed to `attended = 0` across a whole lane —
// which is the input to a demotion pass. These assertions are on KEY PRESENCE, not
// truthiness: a value-only test passes on the broken payload, because every value it
// would read is legitimately null on most rows.
describe("agent inbox-lite wake-path projection", () => {
  const WAKE_PATH_KEYS = [
    "monitorNextCheckAt",
    "scheduledRetryAt",
    "scheduledRetryReason",
    "scheduledRetryAttempt",
  ] as const;

  const NOW = new Date("2026-09-17T11:14:00.000Z");

  function baseRow(id: string, overrides: Record<string, unknown>) {
    return {
      id,
      identifier: `BLO-${id}`,
      title: id,
      status: "in_progress",
      priority: "high",
      projectId: null,
      goalId: null,
      parentId: null,
      createdAt: "2026-07-30T01:41:56.125Z",
      updatedAt: "2026-07-30T01:41:56.125Z",
      activeRun: null,
      monitorNextCheckAt: null,
      scheduledRetryAt: null,
      scheduledRetryReason: null,
      scheduledRetryAttempt: null,
      scheduledRetryParkedRuns: [],
      ...overrides,
    };
  }

  // The doctrine's own predicate, applied to whatever shape it is handed.
  function attendedCount(rows: Array<Record<string, unknown>>) {
    return rows.filter((row) => {
      const monitorAt = row.monitorNextCheckAt as Date | string | null | undefined;
      return (
        row.activeRun != null ||
        row.scheduledRetryAt != null ||
        (monitorAt != null && new Date(monitorAt as string).getTime() > NOW.getTime())
      );
    }).length;
  }

  const sourceRows = [
    baseRow("live-monitor", { monitorNextCheckAt: new Date("2026-09-17T12:00:00.000Z") }),
    baseRow("parked-retry", {
      scheduledRetryAt: new Date("2026-09-17T11:20:00.000Z"),
      scheduledRetryReason: "ccrotate_capacity",
      scheduledRetryAttempt: 2,
    }),
    // Overdue monitor is NOT a wake path — a scheduled time in the past is by
    // definition a wake that did not happen.
    baseRow("overdue-monitor", { monitorNextCheckAt: new Date("2026-09-17T10:00:00.000Z") }),
    baseRow("genuinely-idle", {}),
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.list.mockResolvedValue(sourceRows);
    mockIssueService.listDependencyReadiness.mockResolvedValue(new Map());
    mockRecoveryActionService.listActiveForIssues.mockResolvedValue(new Map());
  });

  it("emits every wake-path key on every row, present-and-null rather than absent", async () => {
    const items = await loadInbox();

    expect(items).toHaveLength(sourceRows.length);
    for (const item of items) {
      for (const key of WAKE_PATH_KEYS) {
        // `in`, not a value check: absent and always-null are both failures here,
        // and only `in` can tell them apart.
        expect(Object.keys(item)).toContain(key);
      }
    }

    const idle = items.find((item) => item.id === "genuinely-idle")!;
    expect(idle.monitorNextCheckAt).toBeNull();
    expect(idle.scheduledRetryAt).toBeNull();
    expect(idle.scheduledRetryReason).toBeNull();
    expect(idle.scheduledRetryAttempt).toBeNull();
  });

  it("agrees with the source rows on the attendance count", async () => {
    const items = await loadInbox();

    // live-monitor + parked-retry. Before the fix this read 0.
    expect(attendedCount(sourceRows)).toBe(2);
    expect(attendedCount(items as unknown as Array<Record<string, unknown>>)).toBe(
      attendedCount(sourceRows),
    );
  });

  it("carries the retry reason and attempt, not just the timestamp", async () => {
    const items = await loadInbox();
    const parked = items.find((item) => item.id === "parked-retry")!;

    expect(parked.scheduledRetryReason).toBe("ccrotate_capacity");
    expect(parked.scheduledRetryAttempt).toBe(2);
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
    const row = {
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
    // By default the parked set is just the displayed row, as the projection
    // builds it for an issue with one parked run.
    return {
      scheduledRetryParkedRuns: row.scheduledRetryRunId
        ? [
            {
              runId: row.scheduledRetryRunId,
              agentId: row.scheduledRetryAgentId,
              scheduledRetryAt: row.scheduledRetryAt,
              scheduledRetryReason: row.scheduledRetryReason,
            },
          ]
        : [],
      ...row,
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
    expect(onWithheldForeignScheduledRetry.mock.calls[0]![1]).toMatchObject({ runId: "run-a" });
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

  // BLO-29965 review round 4. The row displays ONE retry, the earliest-due, and
  // the previous assignee's stale retry is older, so it is the one displayed.
  // Reading only that row failed open on "another agent's retry" and offered the
  // issue to a second run while this agent's own sibling was parked on it.
  it("withholds the row when the earliest-due retry is stale but a sibling is parked behind it", async () => {
    const staleRetry = {
      runId: "run-previous",
      agentId: "agent-previous",
      scheduledRetryAt: "2026-09-03T01:00:00.000Z",
      scheduledRetryReason: "transient_failure",
    };
    const siblingRetry = {
      runId: "run-a",
      agentId: "agent-1",
      scheduledRetryAt: RETRY_AT,
      scheduledRetryReason: "ccrotate_capacity",
    };
    mockIssueService.list.mockResolvedValue([
      parkedRetryRow({
        scheduledRetryAt: staleRetry.scheduledRetryAt,
        scheduledRetryReason: staleRetry.scheduledRetryReason,
        scheduledRetryRunId: staleRetry.runId,
        scheduledRetryAgentId: staleRetry.agentId,
        scheduledRetryParkedRuns: [staleRetry, siblingRetry],
      }),
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

    expect(items).toEqual([]);
    expect(onWithheldForeignScheduledRetry).toHaveBeenCalledTimes(1);
    // The audit names the run that actually holds it, not the displayed row.
    expect(onWithheldForeignScheduledRetry.mock.calls[0]![1]).toEqual(siblingRetry);
  });
});
