import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { escalationDeadlineMs, runAlertEscalationSweep } from "../escalation.js";
import { handleFiring, handleResolved } from "../webhook-handler.js";
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
