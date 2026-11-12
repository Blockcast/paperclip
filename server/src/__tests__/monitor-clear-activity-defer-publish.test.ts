import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PEN-6577 — `logIssueMonitorClearedUndeliverable` must be able to withhold its
 * live event until its caller's transaction commits.
 *
 * `logActivity`'s own contract says it in as many words: "Publishing inline
 * from inside a transaction lets consumers race the row's visibility, and turns
 * a later commit failure into a phantom event for an activity that never
 * happened." The helper introduced by PEN-6571 called `logActivity` with
 * neither option and returned `Promise<void>`, discarding the `ActivityPublish`
 * — while every one of its five call sites passes a handle that is, or can be,
 * a transaction.
 *
 * The live emitter is in-memory, so this is pure: a stub `Db` plus a spy on
 * `publishLiveEvent` is the whole apparatus, and nothing here needs Postgres.
 */

const publishLiveEvent = vi.fn();

vi.mock("../services/live-events.js", () => ({
  publishLiveEvent: (...args: unknown[]) => publishLiveEvent(...args),
  subscribeCompanyLiveEvents: () => () => {},
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => ({
    getGeneral: async () => ({ censorUsernameInLogs: false }),
  }),
}));

const { logIssueMonitorClearedUndeliverable } = await import("../services/activity-log.js");
const { buildIssueMonitorClear } = await import("../services/issue-execution-policy.js");

const companyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const issueId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

/**
 * Minimal chainable stand-in for the Drizzle handle `logActivity` uses: a
 * `select(...).from(...).where(...)` chain that resolves empty, and an
 * `insert(...).values(...)` that records the row. Deliberately NOT a
 * transaction object — the point under test is that the HELPER defers when
 * asked, not that anything sniffs the handle's runtime type.
 */
function stubDb() {
  const inserted: unknown[] = [];
  const emptyChain = {
    from: () => emptyChain,
    where: () => emptyChain,
    then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve([]).then(resolve),
  };
  const db = {
    select: () => emptyChain,
    insert: () => ({ values: async (row: unknown) => { inserted.push(row); } }),
  };
  return { db: db as never, inserted };
}

function clearAudit() {
  return buildIssueMonitorClear({
    issue: {
      status: "in_progress",
      assigneeAgentId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      assigneeUserId: null,
      monitorNextCheckAt: new Date("2026-11-12T17:00:00.000Z"),
      monitorNotes: "waiting on CI",
      executionPolicy: {
        monitor: { nextCheckAt: "2026-11-12T17:00:00.000Z", scheduledBy: "assignee", notes: "waiting on CI" },
      },
    },
    policy: null,
    clearReason: "invalid_status",
  }).audit;
}

function helperInput() {
  return {
    companyId,
    issueId,
    identifier: "PEN-1",
    status: "todo",
    audit: clearAudit(),
    source: "test",
  };
}

describe("logIssueMonitorClearedUndeliverable publication timing", () => {
  beforeEach(() => {
    publishLiveEvent.mockClear();
  });

  it("withholds the live event until the returned publish runs", async () => {
    const { db, inserted } = stubDb();

    const publish = await logIssueMonitorClearedUndeliverable(db, helperInput(), {
      deferPublish: true,
    });

    // The durable row is written on the caller's handle, so it is inside the
    // transaction and rolls back with it...
    expect(inserted).toHaveLength(1);
    // ...and the in-memory event, which cannot be rolled back, has NOT escaped.
    expect(publishLiveEvent).not.toHaveBeenCalled();

    await publish();

    expect(publishLiveEvent).toHaveBeenCalledTimes(1);
    expect(publishLiveEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId,
        type: "activity.logged",
        payload: expect.objectContaining({
          action: "issue.monitor_cleared_undeliverable",
          entityId: issueId,
        }),
      }),
    );
  });

  it("drops the event when the caller never publishes, as a rollback would", async () => {
    const { db } = stubDb();

    await logIssueMonitorClearedUndeliverable(db, helperInput(), { deferPublish: true });

    // A caller whose transaction throws never reaches its drain, so the event
    // is simply never emitted. That is the behaviour being bought.
    expect(publishLiveEvent).not.toHaveBeenCalled();
  });

  it("still publishes inline when no option is passed", async () => {
    const { db } = stubDb();

    // The previous behaviour, which is correct on a non-transactional handle
    // and is what keeps this change additive for callers that do not opt in.
    const publish = await logIssueMonitorClearedUndeliverable(db, helperInput());

    expect(publishLiveEvent).toHaveBeenCalledTimes(1);

    // The returned callback is a no-op in that mode, so a caller that drains
    // unconditionally cannot double-publish.
    await publish();
    expect(publishLiveEvent).toHaveBeenCalledTimes(1);
  });
});
