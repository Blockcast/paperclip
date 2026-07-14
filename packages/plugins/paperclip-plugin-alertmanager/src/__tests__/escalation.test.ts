import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { COVER_ORIGIN, escalationDeadlineMs, runAlertEscalationSweep } from "../escalation.js";
import { handleFiring, handleResolved } from "../webhook-handler.js";
import { DEFAULT_ISSUE_ROUTE_MAP } from "../constants.js";
import { ORIGIN_KIND } from "../types.js";
import type { AlertmanagerAlert, AlertmanagerPluginConfig, AlertStateRecord } from "../types.js";

const alert = (severity = "critical"): AlertmanagerAlert => ({
  status: "firing",
  labels: { alertname: "SyntheticAlert", severity },
  annotations: {},
  startsAt: "2026-07-11T00:00:00Z",
  endsAt: "0001-01-01T00:00:00Z",
  fingerprint: "fp-1",
});

const config = (overrides: Partial<AlertmanagerPluginConfig> = {}): AlertmanagerPluginConfig => ({
  defaultCompanyId: "company-1",
  autoCloseOnResolve: true,
  ...overrides,
});

function sweepContext(state: AlertStateRecord, reportsTo: string | null = "cto") {
  const issue = {
    id: "issue-1", identifier: "BLO-1", title: "Alert", status: "todo", priority: "critical",
    originId: "fp-1", assigneeAgentId: "engineer", projectId: null, goalId: null,
  };
  const mocks = {
    state: { get: vi.fn(async () => state), set: vi.fn(async () => undefined) },
    issues: {
      list: vi.fn(async (input: { originKind?: string }) => input.originKind?.endsWith(":escalation") ? [] : [issue]),
      listComments: vi.fn(async () => []),
      createComment: vi.fn(async () => ({})),
      requestWakeup: vi.fn(async () => ({})),
      update: vi.fn(async () => issue),
      create: vi.fn(async () => ({ id: "cover-1" })),
    },
    agents: {
      get: vi.fn(async (id: string) => id === "engineer"
        ? { id, name: "Engineer", reportsTo }
        : { id, name: "CTO", reportsTo: null }),
    },
    access: { members: { list: vi.fn(async () => [{ principalType: "user", principalId: "board-1", status: "active", membershipRole: "owner" }]) } },
    logger: { info: vi.fn(), warn: vi.fn() },
  };
  return { ctx: mocks as unknown as PluginContext, mocks };
}

describe("alert escalation", () => {
  it("computes default, configured, and route-specific severity deadlines", () => {
    expect(escalationDeadlineMs(alert("critical"), config())).toBe(30 * 60_000);
    expect(escalationDeadlineMs(alert("warning"), config())).toBe(240 * 60_000);
    expect(escalationDeadlineMs(alert("critical"), config({ escalationDeadlineMinutes: { critical: 5 } }))).toBe(5 * 60_000);
    expect(escalationDeadlineMs({ ...alert(), labels: { ...alert().labels, class: "fast" } }, config({ issueRouteMap: { class: { fast: { escalationDeadlineMinutes: 2 } } } }))).toBe(2 * 60_000);
  });

  it("wakes the current owner first, then advances to reportsTo", async () => {
    const due = { paperclipIssueId: "issue-1", paperclipCompanyId: "company-1", assigneeUserId: null, assigneeAgentId: "engineer", alertname: "SyntheticAlert", severity: "critical", firstSeenAt: "x", lastFiredAt: "x", resolvedAt: null, nextEscalationAt: "2026-07-11T00:00:00Z", escalationAttempt: 0 };
    const first = sweepContext(due);
    await runAlertEscalationSweep(first.ctx, config(), new Date("2026-07-11T01:00:00Z"));
    expect(first.mocks.issues.requestWakeup).toHaveBeenCalledTimes(1);
    const second = sweepContext({ ...due, escalationAttempt: 1 });
    await runAlertEscalationSweep(second.ctx, config(), new Date("2026-07-11T01:00:00Z"));
    expect(second.mocks.issues.update).toHaveBeenCalledWith("issue-1", { assigneeAgentId: "cto", assigneeUserId: null }, "company-1");
  });

  it("re-arms each rung a full deadline interval out, not one sweep tick", async () => {
    const due = { paperclipIssueId: "issue-1", paperclipCompanyId: "company-1", assigneeUserId: null, assigneeAgentId: "engineer", alertname: "SyntheticAlert", severity: "critical", firstSeenAt: "x", lastFiredAt: "x", resolvedAt: null, nextEscalationAt: "2026-07-11T00:00:00Z", escalationAttempt: 0 };
    const { ctx, mocks } = sweepContext(due);
    await runAlertEscalationSweep(ctx, config(), new Date("2026-07-11T01:00:00Z"));
    // critical default = 30m: next rung fires at 01:30, so the chain climbs one
    // level per deadline period rather than one level per minute-sweep.
    expect(mocks.state.set).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ escalationAttempt: 1, nextEscalationAt: "2026-07-11T01:30:00.000Z" }));
    const stored = sweepContext({ ...due, escalationAttempt: 1, escalationIntervalMs: 5 * 60_000 });
    await runAlertEscalationSweep(stored.ctx, config(), new Date("2026-07-11T01:00:00Z"));
    // an interval captured at firing time (e.g. route override) wins over severity config
    expect(stored.mocks.state.set).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ escalationAttempt: 2, nextEscalationAt: "2026-07-11T01:05:00.000Z" }));
  });

  it("creates one board-owned user-cover issue at the top of chain", async () => {
    const state = { paperclipIssueId: "issue-1", paperclipCompanyId: "company-1", assigneeUserId: null, assigneeAgentId: "engineer", alertname: "SyntheticAlert", severity: "critical", firstSeenAt: "x", lastFiredAt: "x", resolvedAt: null, nextEscalationAt: "2026-07-11T00:00:00Z", escalationAttempt: 1 };
    const { ctx, mocks } = sweepContext(state, null);
    await runAlertEscalationSweep(ctx, config(), new Date("2026-07-11T01:00:00Z"));
    expect(mocks.issues.create).toHaveBeenCalledWith(expect.objectContaining({ title: expect.stringContaining("[user-cover]"), assigneeUserId: "board-1", originId: "issue-1" }));
    expect(mocks.state.set).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ escalationComplete: true, nextEscalationAt: null }));
  });

  it("creates a fresh cover after a prior owned cover was cancelled on resolution", async () => {
    const state = { paperclipIssueId: "issue-1", paperclipCompanyId: "company-1", assigneeUserId: null, assigneeAgentId: "engineer", alertname: "SyntheticAlert", severity: "critical", firstSeenAt: "x", lastFiredAt: "x", resolvedAt: null, nextEscalationAt: "2026-07-11T00:00:00Z", escalationAttempt: 1 };
    const { ctx, mocks } = sweepContext(state, null);
    const alertIssue = {
      id: "issue-1", identifier: "BLO-1", title: "Alert", status: "todo", priority: "critical",
      originId: "fp-1", assigneeAgentId: "engineer", projectId: null, goalId: null,
    };
    mocks.issues.list = vi.fn(async (input: { originKind?: string }) =>
      input.originKind === COVER_ORIGIN
        ? [{ id: "old-cover", status: "cancelled" }]
        : [alertIssue]);

    await runAlertEscalationSweep(ctx, config(), new Date("2026-07-11T01:00:00Z"));

    expect(mocks.issues.create).toHaveBeenCalledTimes(1);
    expect(mocks.issues.create).toHaveBeenCalledWith(expect.objectContaining({ originId: "issue-1" }));
  });

  it("does not create another cover when a terminal cover sorts ahead of an active cover", async () => {
    const state = { paperclipIssueId: "issue-1", paperclipCompanyId: "company-1", assigneeUserId: null, assigneeAgentId: "engineer", alertname: "SyntheticAlert", severity: "critical", firstSeenAt: "x", lastFiredAt: "x", resolvedAt: null, nextEscalationAt: "2026-07-11T00:00:00Z", escalationAttempt: 1 };
    const { ctx, mocks } = sweepContext(state, null);
    const alertIssue = {
      id: "issue-1", identifier: "BLO-1", title: "Alert", status: "todo", priority: "critical",
      originId: "fp-1", assigneeAgentId: "engineer", projectId: null, goalId: null,
    };
    const covers = [
      { id: "recently-commented-terminal-cover", status: "cancelled" },
      { id: "current-active-cover", status: "todo" },
    ];
    mocks.issues.list = vi.fn(async (input: { originKind?: string; limit?: number; offset?: number }) => {
      if (input.originKind !== COVER_ORIGIN) return [alertIssue];
      const offset = input.offset ?? 0;
      return covers.slice(offset, offset + (input.limit ?? covers.length));
    });

    await runAlertEscalationSweep(ctx, config(), new Date("2026-07-11T01:00:00Z"));

    expect(mocks.issues.create).not.toHaveBeenCalled();
    expect(mocks.issues.list).toHaveBeenCalledWith(expect.objectContaining({
      originKind: COVER_ORIGIN,
      originId: "issue-1",
      limit: 50,
      offset: 0,
    }));
  });

  it("checks every page of owned cover history for an active cover", async () => {
    const state = { paperclipIssueId: "issue-1", paperclipCompanyId: "company-1", assigneeUserId: null, assigneeAgentId: "engineer", alertname: "SyntheticAlert", severity: "critical", firstSeenAt: "x", lastFiredAt: "x", resolvedAt: null, nextEscalationAt: "2026-07-11T00:00:00Z", escalationAttempt: 1 };
    const { ctx, mocks } = sweepContext(state, null);
    const alertIssue = {
      id: "issue-1", identifier: "BLO-1", title: "Alert", status: "todo", priority: "critical",
      originId: "fp-1", assigneeAgentId: "engineer", projectId: null, goalId: null,
    };
    const covers = [
      ...Array.from({ length: 50 }, (_, index) => ({ id: `terminal-cover-${index}`, status: "cancelled" })),
      { id: "active-cover-on-second-page", status: "in_progress" },
    ];
    mocks.issues.list = vi.fn(async (input: { originKind?: string; limit?: number; offset?: number }) => {
      if (input.originKind !== COVER_ORIGIN) return [alertIssue];
      const offset = input.offset ?? 0;
      return covers.slice(offset, offset + (input.limit ?? covers.length));
    });

    await runAlertEscalationSweep(ctx, config(), new Date("2026-07-11T01:00:00Z"));

    expect(mocks.issues.create).not.toHaveBeenCalled();
    expect(mocks.issues.list).toHaveBeenCalledWith(expect.objectContaining({ offset: 50 }));
  });

  it("clears the escalation schedule when an alert resolves", async () => {
    const state = { paperclipIssueId: "issue-1", paperclipCompanyId: "company-1", assigneeUserId: null, assigneeAgentId: "engineer", alertname: "SyntheticAlert", severity: "critical", firstSeenAt: "x", lastFiredAt: "x", resolvedAt: null, nextEscalationAt: "2026-07-11T01:00:00Z", escalationAttempt: 1 };
    const mocks = { state: { get: vi.fn(async () => state), set: vi.fn(async () => undefined) }, issues: { get: vi.fn(async () => ({ id: "issue-1", status: "todo" })), update: vi.fn(async () => ({})), createComment: vi.fn() }, events: { emit: vi.fn() }, metrics: { write: vi.fn() }, logger: { info: vi.fn(), warn: vi.fn() } };
    await handleResolved(mocks as unknown as PluginContext, config(), { ...alert(), status: "resolved", endsAt: "2026-07-11T02:00:00Z" });
    expect(mocks.state.set).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ escalationComplete: true, nextEscalationAt: null }));
  });

  it("advances the ladder and posts exactly one comment even when the wake is refused", async () => {
    const due = { paperclipIssueId: "issue-1", paperclipCompanyId: "company-1", assigneeUserId: null, assigneeAgentId: "engineer", alertname: "SyntheticAlert", severity: "critical", firstSeenAt: "x", lastFiredAt: "x", resolvedAt: null, nextEscalationAt: "2026-07-11T00:00:00Z", escalationAttempt: 0 };
    const { ctx, mocks } = sweepContext(due);
    mocks.issues.requestWakeup = vi.fn(async () => { throw new Error("Issue is not wakeable in status: backlog"); });
    await expect(runAlertEscalationSweep(ctx, config(), new Date("2026-07-11T01:00:00Z"))).resolves.toBeUndefined();
    // live incident 2026-07-11: the throw used to abort before the state
    // write, repeating rung 1 (comment + wake) every minute-sweep forever
    expect(mocks.state.set).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ escalationAttempt: 1 }));
    expect(mocks.issues.createComment).toHaveBeenCalledTimes(1);
    expect(mocks.logger.warn).toHaveBeenCalled();
  });

  it("wakes the new owner after a reassign rung", async () => {
    const due = { paperclipIssueId: "issue-1", paperclipCompanyId: "company-1", assigneeUserId: null, assigneeAgentId: "engineer", alertname: "SyntheticAlert", severity: "critical", firstSeenAt: "x", lastFiredAt: "x", resolvedAt: null, nextEscalationAt: "2026-07-11T00:00:00Z", escalationAttempt: 1 };
    const { ctx, mocks } = sweepContext(due);
    await runAlertEscalationSweep(ctx, config(), new Date("2026-07-11T01:00:00Z"));
    expect(mocks.issues.update).toHaveBeenCalledWith("issue-1", { assigneeAgentId: "cto", assigneeUserId: null }, "company-1");
    expect(mocks.issues.requestWakeup).toHaveBeenCalledTimes(1);
  });

  it("continues the sweep past an issue whose processing throws", async () => {
    const due = { paperclipIssueId: "issue-1", paperclipCompanyId: "company-1", assigneeUserId: null, assigneeAgentId: "engineer", alertname: "SyntheticAlert", severity: "critical", firstSeenAt: "x", lastFiredAt: "x", resolvedAt: null, nextEscalationAt: "2026-07-11T00:00:00Z", escalationAttempt: 0 };
    const { ctx, mocks } = sweepContext(due);
    const issueA = { id: "issue-broken", identifier: "BLO-0", title: "Alert", status: "todo", priority: "critical", originId: "fp-broken", assigneeAgentId: "engineer", projectId: null, goalId: null };
    const issueB = { id: "issue-1", identifier: "BLO-1", title: "Alert", status: "todo", priority: "critical", originId: "fp-1", assigneeAgentId: "engineer", projectId: null, goalId: null };
    mocks.issues.list = vi.fn(async (input: { originKind?: string }) => input.originKind?.endsWith(":escalation") ? [] : [issueA, issueB]);
    mocks.issues.listComments = vi.fn(async (issueId: string) => {
      if (issueId === "issue-broken") throw new Error("boom");
      return [];
    });
    await expect(runAlertEscalationSweep(ctx, config(), new Date("2026-07-11T01:00:00Z"))).resolves.toBeUndefined();
    // the healthy issue behind the broken one still advanced
    expect(mocks.state.set).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ escalationAttempt: 1 }));
    expect(mocks.logger.warn).toHaveBeenCalledWith(expect.stringContaining("BLO-0"));
  });

  it("does not reset the ladder on repeat firing deliveries", async () => {
    const state = { paperclipIssueId: "issue-1", paperclipCompanyId: "company-1", assigneeUserId: null, assigneeAgentId: "engineer", alertname: "SyntheticAlert", severity: "critical", firstSeenAt: "x", lastFiredAt: "x", resolvedAt: null, nextEscalationAt: "2026-07-11T01:00:00Z", escalationAttempt: 2 };
    const mocks = { state: { get: vi.fn(async () => state), set: vi.fn(async () => undefined) }, issues: { get: vi.fn(async () => ({ id: "issue-1", status: "todo" })), update: vi.fn(async () => ({})) }, events: { emit: vi.fn() }, metrics: { write: vi.fn() }, logger: { warn: vi.fn() } };
    await handleFiring(mocks as unknown as PluginContext, config(), alert());
    expect(mocks.state.set).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ escalationAttempt: 2, nextEscalationAt: "2026-07-11T01:00:00Z" }));
  });
});

describe("BLO-15982 cascade cover cleanup on resolve", () => {
  const resolvedState: AlertStateRecord = {
    paperclipIssueId: "issue-1", paperclipCompanyId: "company-1", assigneeUserId: null,
    assigneeAgentId: "engineer", alertname: "SyntheticAlert", severity: "critical",
    firstSeenAt: "x", lastFiredAt: "x", resolvedAt: null, nextEscalationAt: "2026-07-11T01:00:00Z",
    escalationAttempt: 3, escalationComplete: true,
  };

  function resolveMocks(covers: Array<{ id: string; status: string }>) {
    return {
      state: { get: vi.fn(async () => resolvedState), set: vi.fn(async () => undefined) },
      issues: {
        // Alert issue already terminal (a prior sweep/resolve closed it) so
        // these tests isolate cascade cover cleanup from the pre-existing
        // autoCloseOnResolve side effect on the alert issue itself.
        get: vi.fn(async () => ({ id: "issue-1", status: "done" })),
        update: vi.fn(async (id: string, patch: Record<string, unknown>) => {
          const cover = covers.find((c) => c.id === id);
          if (cover) cover.status = patch.status as string;
          return { id, ...patch };
        }),
        createComment: vi.fn(async () => ({})),
        list: vi.fn(async (input: { originKind?: string; originId?: string }) =>
          input.originKind === COVER_ORIGIN && input.originId === "issue-1" ? covers : []),
      },
      events: { emit: vi.fn() },
      metrics: { write: vi.fn() },
      logger: { info: vi.fn(), warn: vi.fn() },
    };
  }

  it("finds every open cover for the resolved alert issue, comments, and cancels each", async () => {
    const covers = [{ id: "cover-1", status: "todo" }, { id: "cover-2", status: "in_progress" }];
    const mocks = resolveMocks(covers);
    await handleResolved(mocks as unknown as PluginContext, config(), { ...alert(), status: "resolved", endsAt: "2026-07-11T02:00:00Z" });
    expect(mocks.issues.list).toHaveBeenCalledWith(expect.objectContaining({ originKind: COVER_ORIGIN, originId: "issue-1" }));
    expect(mocks.issues.createComment).toHaveBeenCalledTimes(2);
    expect(mocks.issues.createComment).toHaveBeenCalledWith("cover-1", expect.stringContaining("Source alert resolved"), "company-1");
    expect(mocks.issues.update).toHaveBeenCalledWith("cover-1", { status: "cancelled" }, "company-1");
    expect(mocks.issues.update).toHaveBeenCalledWith("cover-2", { status: "cancelled" }, "company-1");
    expect(covers.every((c) => c.status === "cancelled")).toBe(true);
  });

  it("skips a cover already in a terminal state — no duplicate comment or update", async () => {
    const covers = [{ id: "cover-1", status: "cancelled" }, { id: "cover-2", status: "done" }];
    const mocks = resolveMocks(covers);
    await handleResolved(mocks as unknown as PluginContext, config(), { ...alert(), status: "resolved", endsAt: "2026-07-11T02:00:00Z" });
    expect(mocks.issues.createComment).not.toHaveBeenCalled();
    expect(mocks.issues.update).not.toHaveBeenCalled();
  });

  it("a retried resolve is idempotent — second call is a no-op once covers are cancelled", async () => {
    const covers = [{ id: "cover-1", status: "todo" }];
    const mocks = resolveMocks(covers);
    await handleResolved(mocks as unknown as PluginContext, config(), { ...alert(), status: "resolved", endsAt: "2026-07-11T02:00:00Z" });
    expect(mocks.issues.createComment).toHaveBeenCalledTimes(1);
    expect(mocks.issues.update).toHaveBeenCalledTimes(1);
    // second, retried delivery of the same resolved webhook
    await handleResolved(mocks as unknown as PluginContext, config(), { ...alert(), status: "resolved", endsAt: "2026-07-11T02:00:00Z" });
    expect(mocks.issues.createComment).toHaveBeenCalledTimes(1);
    expect(mocks.issues.update).toHaveBeenCalledTimes(1);
  });
});

describe("BLO-15982 storm batching: concurrent same-alertname ladders", () => {
  /**
   * Models the host's `issues_active_alert_escalation_cover_uq` partial
   * unique index: `create()` for an `originFingerprint` already claimed by
   * an open row rejects atomically. Critically, the check-and-claim has no
   * `await` between them, so it stays atomic across interleaved concurrent
   * callers the same way a real DB unique-index insert would — this is what
   * makes the test below prove something a sequential-only mock could not.
   */
  function buildAtomicCoverStore() {
    const issuesById = new Map<string, { id: string; status: string; originFingerprint?: string | null }>();
    const openCoverIdByFingerprint = new Map<string, string>();
    let seq = 0;

    async function list(input: { originKind?: string; originFingerprint?: string; originId?: string }) {
      if (input.originKind !== COVER_ORIGIN) return [];
      if (input.originFingerprint) {
        const id = openCoverIdByFingerprint.get(input.originFingerprint);
        const issue = id ? issuesById.get(id) : undefined;
        return issue && !["done", "cancelled"].includes(issue.status) ? [issue] : [];
      }
      if (input.originId) {
        return [...issuesById.values()].filter((issue) => (issue as any).originId === input.originId);
      }
      return [];
    }

    async function create(params: { originFingerprint?: string | null; originId?: string; [k: string]: unknown }) {
      seq += 1;
      const id = `cover-${seq}`;
      if (params.originFingerprint) {
        if (openCoverIdByFingerprint.has(params.originFingerprint)) {
          throw new Error("Alert escalation cover conflict"); // no await above this line — atomic check
        }
        const issue = { id, status: "todo", ...params };
        issuesById.set(id, issue);
        openCoverIdByFingerprint.set(params.originFingerprint, id); // claim happens synchronously with the check
        return issue;
      }
      const issue = { id, status: "todo", ...params };
      issuesById.set(id, issue);
      return issue;
    }

    return { list, create, issuesById, openCoverIdByFingerprint };
  }

  it("N concurrent ladder advances for one alertname yield exactly one open cover, siblings durably referenced", async () => {
    const N = 6;
    const alertname = "PodPendingCritical";
    const store = buildAtomicCoverStore();
    const commentsByCoverId = new Map<string, string[]>();

    const alertIssues = Array.from({ length: N }, (_, i) => ({
      id: `alert-issue-${i}`, identifier: `BLO-${200 + i}`, title: "Alert", status: "todo",
      priority: "critical", originId: `fp-${i}`, assigneeAgentId: null, projectId: null, goalId: null,
    }));

    // Each worker independently owns exactly one alert issue reaching the
    // cover rung (chain exhausted: no assignee, attempt beyond MAX_ATTEMPTS)
    // and races the others to claim the shared alertname dedup slot.
    const runWorker = (issue: (typeof alertIssues)[number]) => {
      const state: AlertStateRecord = {
        paperclipIssueId: issue.id, paperclipCompanyId: "company-1", assigneeUserId: null,
        assigneeAgentId: null, alertname, severity: "critical", firstSeenAt: "x", lastFiredAt: "x",
        resolvedAt: null, nextEscalationAt: "2026-07-11T00:00:00Z", escalationAttempt: 3,
      };
      const ctx = {
        state: { get: vi.fn(async () => state), set: vi.fn(async () => undefined) },
        issues: {
          list: vi.fn(async (input: { originKind?: string }) =>
            input.originKind === ORIGIN_KIND ? [issue] : store.list(input as any)),
          listComments: vi.fn(async (coverId: string) =>
            (commentsByCoverId.get(coverId) ?? []).map((body) => ({ body }))),
          createComment: vi.fn(async (coverId: string, body: string) => {
            const existing = commentsByCoverId.get(coverId) ?? [];
            commentsByCoverId.set(coverId, [...existing, body]);
            return { id: `comment-${coverId}-${existing.length}`, body };
          }),
          update: vi.fn(async () => ({})),
          create: vi.fn(store.create as any),
        },
        agents: { get: vi.fn(async () => null) },
        access: { members: { list: vi.fn(async () => [{ principalType: "user", principalId: "board-1", status: "active", membershipRole: "owner" }]) } },
        logger: { info: vi.fn(), warn: vi.fn() },
      };
      return runAlertEscalationSweep(ctx as unknown as PluginContext, config(), new Date("2026-07-11T01:00:00Z"));
    };

    await Promise.all(alertIssues.map(runWorker));

    const openCovers = [...store.issuesById.values()].filter((c) => !["done", "cancelled"].includes(c.status));
    expect(openCovers).toHaveLength(1);

    const winnerId = openCovers[0].id;
    const siblingComments = commentsByCoverId.get(winnerId) ?? [];
    // Every non-winning alert issue is durably referenced on the retained
    // cover via a distinct sibling marker — none silently dropped.
    for (const issue of alertIssues) {
      const wasWinner = (openCovers[0] as any).originId === issue.id;
      if (wasWinner) continue;
      expect(siblingComments.some((body) => body.includes(`sibling:${issue.id}`))).toBe(true);
    }
    // No duplicate sibling comments even though every loser hit the same
    // conflict independently.
    expect(new Set(siblingComments).size).toBe(siblingComments.length);
  });
});

describe("BLO-15982 pod_pending route: 240-minute escalation deadline end-to-end", () => {
  it("resolves 240 minutes from DEFAULT_ISSUE_ROUTE_MAP, not the critical default", () => {
    const podPendingAlert: AlertmanagerAlert = {
      ...alert("critical"),
      labels: { alertname: "PodPendingCritical", severity: "critical", class: "pod_pending" },
    };
    expect(DEFAULT_ISSUE_ROUTE_MAP.class?.pod_pending?.escalationDeadlineMinutes).toBe(240);
    expect(escalationDeadlineMs(podPendingAlert, config({ issueRouteMap: DEFAULT_ISSUE_ROUTE_MAP }))).toBe(240 * 60_000);
  });

  it("schedules the next ladder rung 240 minutes out end-to-end through the sweep", async () => {
    const podPendingAlert: AlertmanagerAlert = {
      ...alert("critical"),
      labels: { alertname: "PodPendingCritical", severity: "critical", class: "pod_pending" },
    };
    const firingMocks = {
      state: { get: vi.fn(async () => null), set: vi.fn(async () => undefined) },
      issues: { create: vi.fn(async () => ({ id: "issue-1" })) },
      events: { emit: vi.fn() },
      activity: { log: vi.fn() },
      metrics: { write: vi.fn() },
      logger: { debug: vi.fn(), warn: vi.fn() },
    };
    const beforeFiring = Date.now();
    await handleFiring(firingMocks as unknown as PluginContext, config({ issueRouteMap: DEFAULT_ISSUE_ROUTE_MAP }), podPendingAlert);
    // handleFiring stamps nextEscalationAt off the real clock (no `now`
    // override), so assert the captured interval directly and the resulting
    // timestamp within a tolerance window rather than an exact value.
    expect(firingMocks.state.set).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ escalationIntervalMs: 240 * 60_000 }),
    );
    const storedState = (firingMocks.state.set as ReturnType<typeof vi.fn>).mock.calls[0][1] as AlertStateRecord;
    const nextEscalationAtMs = Date.parse(storedState.nextEscalationAt!);
    expect(nextEscalationAtMs).toBeGreaterThanOrEqual(beforeFiring + 240 * 60_000 - 5_000);
    expect(nextEscalationAtMs).toBeLessThanOrEqual(Date.now() + 240 * 60_000 + 5_000);

    // The rung interval captured at firing time (route-resolved) — not the
    // 30-minute critical default — drives the next sweep-scheduled rung.
    const dueState: AlertStateRecord = {
      paperclipIssueId: "issue-1", paperclipCompanyId: "company-1", assigneeUserId: null,
      assigneeAgentId: "engineer", alertname: "PodPendingCritical", severity: "critical",
      firstSeenAt: "x", lastFiredAt: "x", resolvedAt: null,
      nextEscalationAt: "2026-07-11T00:00:00Z", escalationAttempt: 0, escalationIntervalMs: 240 * 60_000,
    };
    const { ctx, mocks } = sweepContext(dueState);
    await runAlertEscalationSweep(ctx, config(), new Date("2026-07-11T01:00:00Z"));
    expect(mocks.state.set).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ escalationAttempt: 1, nextEscalationAt: "2026-07-11T05:00:00.000Z" }),
    );
  });
});
