import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { COVER_ORIGIN, escalationDeadlineMs, recordSourceResolvedAndCloseCovers, runAlertEscalationSweep } from "../escalation.js";
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

/**
 * In-memory model of the plugin's own `alert_escalation_covers` /
 * `alert_escalation_cover_members` tables (see migrations/001) plus the
 * board-cover issues they reference. Every branch below is synchronous JS
 * with no internal `await`, so — same reasoning as a real Postgres
 * single-statement UPDATE — the check-and-act pairs (claim eligibility,
 * insert-on-conflict) stay atomic across interleaved concurrent callers
 * driven through `Promise.all`, not just sequential calls.
 */
function buildFakeAlertmanagerStore() {
  const coverIssuesById = new Map<string, { id: string; status: string; originId?: string; identifier?: string }>();
  const openCoverIdByFingerprint = new Map<string, string>();
  const covers = new Map<string, { cover_issue_id: string; company_id: string; dedup_fingerprint: string; closing_claimed_at: string | null; resolution_comment_posted_at: string | null; cancelled_at: string | null }>();
  const members = new Map<string, { id: string; cover_issue_id: string; alert_issue_id: string; resolved_at: string | null }>();
  let seq = 0;

  async function issuesList(input: { originKind?: string; originFingerprint?: string; originId?: string }) {
    if (input.originKind !== COVER_ORIGIN) return [];
    if (input.originFingerprint) {
      const id = openCoverIdByFingerprint.get(input.originFingerprint);
      const issue = id ? coverIssuesById.get(id) : undefined;
      return issue ? [issue] : [];
    }
    return [];
  }

  async function issuesCreate(params: { originFingerprint?: string | null; originId?: string; identifier?: string; [k: string]: unknown }) {
    seq += 1;
    const id = `cover-${seq}`;
    if (params.originFingerprint) {
      if (openCoverIdByFingerprint.has(params.originFingerprint)) {
        throw new Error("Alert escalation cover conflict"); // no await above — atomic check-and-claim
      }
      const issue = { id, status: "todo", ...params };
      coverIssuesById.set(id, issue);
      openCoverIdByFingerprint.set(params.originFingerprint, id);
      return issue;
    }
    const issue = { id, status: "todo", ...params };
    coverIssuesById.set(id, issue);
    return issue;
  }

  function openMemberCount(coverIssueId: string): number {
    let count = 0;
    for (const m of members.values()) if (m.cover_issue_id === coverIssueId && m.resolved_at === null) count += 1;
    return count;
  }

  const db = {
    namespace: "ns",
    async execute(sql: string, params: unknown[] = []) {
      const text = sql.replace(/\s+/g, " ").trim();
      if (text.includes("ON CONFLICT (cover_issue_id, alert_issue_id)")) {
        const [id, coverIssueId, alertIssueId] = params as [string, string, string];
        const key = `${coverIssueId}:${alertIssueId}`;
        const existing = members.get(key);
        if (!existing) {
          members.set(key, { id, cover_issue_id: coverIssueId, alert_issue_id: alertIssueId, resolved_at: null });
          return { rowCount: 1 };
        }
        if (existing.resolved_at !== null) {
          existing.resolved_at = null;
          return { rowCount: 1 };
        }
        return { rowCount: 0 };
      }
      if (text.includes("ON CONFLICT (cover_issue_id) DO NOTHING")) {
        const [coverIssueId, companyId, fingerprint] = params as [string, string, string];
        if (covers.has(coverIssueId)) return { rowCount: 0 };
        covers.set(coverIssueId, { cover_issue_id: coverIssueId, company_id: companyId, dedup_fingerprint: fingerprint, closing_claimed_at: null, resolution_comment_posted_at: null, cancelled_at: null });
        return { rowCount: 1 };
      }
      if (text.includes("NOT EXISTS")) {
        const [coverIssueId] = params as [string];
        const cover = covers.get(coverIssueId);
        if (!cover || cover.closing_claimed_at !== null || cover.cancelled_at !== null) return { rowCount: 0 };
        if (openMemberCount(coverIssueId) > 0) return { rowCount: 0 };
        cover.closing_claimed_at = new Date().toISOString();
        return { rowCount: 1 };
      }
      if (text.includes("SET resolution_comment_posted_at = now()")) {
        const [coverIssueId] = params as [string];
        const cover = covers.get(coverIssueId);
        if (!cover || cover.resolution_comment_posted_at !== null) return { rowCount: 0 };
        cover.resolution_comment_posted_at = new Date().toISOString();
        return { rowCount: 1 };
      }
      if (text.includes("c.cancelled_at IS NULL") && text.startsWith("UPDATE")) {
        // "already an open member" reopen check in createCover.
        const [alertIssueId] = params as [string];
        let count = 0;
        for (const m of members.values()) {
          if (m.alert_issue_id !== alertIssueId) continue;
          const cover = covers.get(m.cover_issue_id);
          if (!cover || cover.cancelled_at !== null || cover.closing_claimed_at !== null) continue;
          m.resolved_at = null;
          count += 1;
        }
        return { rowCount: count };
      }
      if (text.includes("COALESCE(resolved_at, now())")) {
        const [alertIssueId] = params as [string];
        let count = 0;
        for (const m of members.values()) {
          if (m.alert_issue_id !== alertIssueId) continue;
          if (m.resolved_at === null) m.resolved_at = new Date().toISOString();
          count += 1;
        }
        return { rowCount: count };
      }
      if (text.includes("SET cancelled_at = now()")) {
        const [coverIssueId] = params as [string];
        const cover = covers.get(coverIssueId);
        if (!cover || cover.cancelled_at !== null) return { rowCount: 0 };
        cover.cancelled_at = new Date().toISOString();
        return { rowCount: 1 };
      }
      throw new Error(`fake db: unrecognized execute statement: ${text}`);
    },
    async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      const text = sql.replace(/\s+/g, " ").trim();
      if (text.startsWith("SELECT DISTINCT cover_issue_id")) {
        const [alertIssueId] = params as [string];
        const ids = new Set<string>();
        for (const m of members.values()) if (m.alert_issue_id === alertIssueId) ids.add(m.cover_issue_id);
        return [...ids].map((cover_issue_id) => ({ cover_issue_id })) as T[];
      }
      if (text.startsWith("SELECT closing_claimed_at, resolution_comment_posted_at, cancelled_at")) {
        const [coverIssueId] = params as [string];
        const cover = covers.get(coverIssueId);
        return cover ? [{ closing_claimed_at: cover.closing_claimed_at, resolution_comment_posted_at: cover.resolution_comment_posted_at, cancelled_at: cover.cancelled_at }] as T[] : [];
      }
      if (text.includes("closing_claimed_at IS NOT NULL AND cancelled_at IS NULL")) {
        const [companyId] = params as [string];
        return [...covers.values()]
          .filter((c) => c.company_id === companyId && c.closing_claimed_at !== null && c.cancelled_at === null)
          .map((c) => ({ cover_issue_id: c.cover_issue_id })) as T[];
      }
      throw new Error(`fake db: unrecognized query statement: ${text}`);
    },
  };

  return { issuesList, issuesCreate, db, coverIssuesById, covers, members, openMemberCount };
}

function sweepContext(state: AlertStateRecord, reportsTo: string | null = "cto", store = buildFakeAlertmanagerStore()) {
  const issue = {
    id: "issue-1", identifier: "BLO-1", title: "Alert", status: "todo", priority: "critical",
    originId: "fp-1", assigneeAgentId: "engineer", projectId: null, goalId: null,
  };
  const mocks = {
    state: { get: vi.fn(async () => state), set: vi.fn(async () => undefined) },
    issues: {
      list: vi.fn(async (input: { originKind?: string }) => input.originKind?.endsWith(":escalation") ? store.issuesList(input as any) : [issue]),
      listComments: vi.fn(async () => []),
      createComment: vi.fn(async () => ({})),
      requestWakeup: vi.fn(async () => ({})),
      update: vi.fn(async () => issue),
      create: vi.fn(store.issuesCreate as any),
      get: vi.fn(async () => issue),
    },
    db: store.db,
    agents: {
      get: vi.fn(async (id: string) => id === "engineer"
        ? { id, name: "Engineer", reportsTo }
        : { id, name: "CTO", reportsTo: null }),
    },
    access: { members: { list: vi.fn(async () => [{ principalType: "user", principalId: "board-1", status: "active", membershipRole: "owner" }]) } },
    logger: { info: vi.fn(), warn: vi.fn() },
  };
  return { ctx: mocks as unknown as PluginContext, mocks, store };
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

  it("creates one board-owned user-cover issue at the top of chain, with durable membership", async () => {
    const state = { paperclipIssueId: "issue-1", paperclipCompanyId: "company-1", assigneeUserId: null, assigneeAgentId: "engineer", alertname: "SyntheticAlert", severity: "critical", firstSeenAt: "x", lastFiredAt: "x", resolvedAt: null, nextEscalationAt: "2026-07-11T00:00:00Z", escalationAttempt: 1 };
    const { ctx, mocks, store } = sweepContext(state, null);
    await runAlertEscalationSweep(ctx, config(), new Date("2026-07-11T01:00:00Z"));
    expect(mocks.issues.create).toHaveBeenCalledWith(expect.objectContaining({ title: expect.stringContaining("[user-cover]"), assigneeUserId: "board-1", originId: "issue-1" }));
    expect(mocks.state.set).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ escalationComplete: true, nextEscalationAt: null }));
    expect(store.covers.size).toBe(1);
    const [coverRow] = [...store.covers.values()];
    expect(store.members.get(`${coverRow.cover_issue_id}:issue-1`)?.resolved_at).toBeNull();
  });

  it("creates a fresh cover once the prior cover for this alert is cancelled", async () => {
    const state = { paperclipIssueId: "issue-1", paperclipCompanyId: "company-1", assigneeUserId: null, assigneeAgentId: "engineer", alertname: "SyntheticAlert", severity: "critical", firstSeenAt: "x", lastFiredAt: "x", resolvedAt: null, nextEscalationAt: "2026-07-11T00:00:00Z", escalationAttempt: 1 };
    const store = buildFakeAlertmanagerStore();
    store.covers.set("old-cover", { cover_issue_id: "old-cover", company_id: "company-1", dedup_fingerprint: "cover:SyntheticAlert:stale", closing_claimed_at: "2026-07-10T00:00:00Z", resolution_comment_posted_at: "2026-07-10T00:00:00Z", cancelled_at: "2026-07-10T00:00:00Z" });
    store.members.set("old-cover:issue-1", { id: randomUUID(), cover_issue_id: "old-cover", alert_issue_id: "issue-1", resolved_at: "2026-07-10T00:00:00Z" });
    const { ctx, mocks } = sweepContext(state, null, store);

    await runAlertEscalationSweep(ctx, config(), new Date("2026-07-11T01:00:00Z"));

    expect(mocks.issues.create).toHaveBeenCalledTimes(1);
    expect(mocks.issues.create).toHaveBeenCalledWith(expect.objectContaining({ originId: "issue-1" }));
  });

  it("does not create a duplicate cover when this alert is already an open member of a non-cancelled cover", async () => {
    const state = { paperclipIssueId: "issue-1", paperclipCompanyId: "company-1", assigneeUserId: null, assigneeAgentId: "engineer", alertname: "SyntheticAlert", severity: "critical", firstSeenAt: "x", lastFiredAt: "x", resolvedAt: null, nextEscalationAt: "2026-07-11T00:00:00Z", escalationAttempt: 1 };
    const store = buildFakeAlertmanagerStore();
    store.coverIssuesById.set("cover-existing", { id: "cover-existing", status: "todo" });
    store.covers.set("cover-existing", { cover_issue_id: "cover-existing", company_id: "company-1", dedup_fingerprint: "cover:SyntheticAlert:current", closing_claimed_at: null, resolution_comment_posted_at: null, cancelled_at: null });
    store.members.set("cover-existing:issue-1", { id: randomUUID(), cover_issue_id: "cover-existing", alert_issue_id: "issue-1", resolved_at: "2026-07-10T00:00:00Z" });
    const { ctx, mocks } = sweepContext(state, null, store);

    await runAlertEscalationSweep(ctx, config(), new Date("2026-07-11T01:00:00Z"));

    expect(mocks.issues.create).not.toHaveBeenCalled();
    // the reopen path un-resolves the existing membership since the alert is firing again
    expect(store.members.get("cover-existing:issue-1")?.resolved_at).toBeNull();
  });

  it("does not reopen membership on a cover that has already claimed to close (BLO-16120 PR #662 review) — falls through to a fresh cover instead of racing the finalize", async () => {
    const state = { paperclipIssueId: "issue-1", paperclipCompanyId: "company-1", assigneeUserId: null, assigneeAgentId: "engineer", alertname: "SyntheticAlert", severity: "critical", firstSeenAt: "x", lastFiredAt: "x", resolvedAt: null, nextEscalationAt: "2026-07-11T00:00:00Z", escalationAttempt: 1 };
    const store = buildFakeAlertmanagerStore();
    store.coverIssuesById.set("cover-closing", { id: "cover-closing", status: "todo" });
    // Cover already won the closing claim (mid `closeCoverIfEligible` /
    // `finalizeCoverCancellation`, or sitting in the stuck-reconcile window)
    // but hasn't cancelled yet; this alert's own membership on it already
    // resolved, then it re-fired — racing the finalize.
    store.covers.set("cover-closing", { cover_issue_id: "cover-closing", company_id: "company-1", dedup_fingerprint: "cover:SyntheticAlert:stale-claim", closing_claimed_at: "2026-07-11T00:55:00Z", resolution_comment_posted_at: null, cancelled_at: null });
    store.members.set("cover-closing:issue-1", { id: randomUUID(), cover_issue_id: "cover-closing", alert_issue_id: "issue-1", resolved_at: "2026-07-10T00:00:00Z" });
    const { ctx, mocks } = sweepContext(state, null, store);

    await runAlertEscalationSweep(ctx, config(), new Date("2026-07-11T01:00:00Z"));

    // must NOT silently reopen membership on the closing cover —
    // `finalizeCoverCancellation` never re-checks membership before
    // cancelling, so a reopen here would let the cover close anyway and
    // orphan this re-fire from any cover. Instead membership stays resolved,
    // so the old cover is free to finalize on its own (via this same sweep's
    // reconcile pass, since it has no other unresolved members) —
    // legitimately, since the re-fired alert is no longer tracked there.
    expect(store.members.get("cover-closing:issue-1")?.resolved_at).not.toBeNull();
    expect(store.covers.get("cover-closing")?.cancelled_at).not.toBeNull();
    // instead the re-fire falls through to createCover's normal create-or-join path
    expect(mocks.issues.create).toHaveBeenCalledTimes(1);
    expect(mocks.issues.create).toHaveBeenCalledWith(expect.objectContaining({ originId: "issue-1" }));
    const [newCoverRow] = [...store.covers.values()].filter((c) => c.cover_issue_id !== "cover-closing");
    expect(newCoverRow).toBeDefined();
    expect(store.members.get(`${newCoverRow!.cover_issue_id}:issue-1`)?.resolved_at).toBeNull();
  });

  it("clears the escalation schedule when an alert resolves", async () => {
    const state = { paperclipIssueId: "issue-1", paperclipCompanyId: "company-1", assigneeUserId: null, assigneeAgentId: "engineer", alertname: "SyntheticAlert", severity: "critical", firstSeenAt: "x", lastFiredAt: "x", resolvedAt: null, nextEscalationAt: "2026-07-11T01:00:00Z", escalationAttempt: 1 };
    const mocks = {
      state: { get: vi.fn(async () => state), set: vi.fn(async () => undefined) },
      issues: {
        get: vi.fn(async () => ({ id: "issue-1", status: "todo" })),
        update: vi.fn(async () => ({})),
        createComment: vi.fn(),
      },
      db: {
        namespace: "alertmanager",
        execute: vi.fn(async () => ({ rowCount: 0 })),
        query: vi.fn(async () => []),
      },
      events: { emit: vi.fn() },
      metrics: { write: vi.fn() },
      logger: { info: vi.fn(), warn: vi.fn() },
    };
    await handleResolved(mocks as unknown as PluginContext, config(), { ...alert(), status: "resolved", endsAt: "2026-07-11T02:00:00Z" });
    expect(mocks.state.set).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ escalationComplete: true, nextEscalationAt: null }));
    expect(mocks.db.execute).toHaveBeenCalled();
    expect(mocks.logger.warn).not.toHaveBeenCalled();
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

describe("BLO-16120 aggregate-aware cover cleanup on resolve", () => {
  /** Seeds a cover with N unresolved members and returns a resolve-ready ctx. */
  function coverContext(memberAlertIssueIds: string[]) {
    const store = buildFakeAlertmanagerStore();
    const coverId = "cover-1";
    store.covers.set(coverId, { cover_issue_id: coverId, company_id: "company-1", dedup_fingerprint: "cover:SyntheticAlert:1", closing_claimed_at: null, resolution_comment_posted_at: null, cancelled_at: null });
    for (const alertIssueId of memberAlertIssueIds) {
      store.members.set(`${coverId}:${alertIssueId}`, { id: randomUUID(), cover_issue_id: coverId, alert_issue_id: alertIssueId, resolved_at: null });
    }
    const mocks = {
      issues: {
        get: vi.fn(async () => ({ id: coverId, status: "todo" })),
        update: vi.fn(async () => ({})),
        createComment: vi.fn(async () => ({})),
        list: vi.fn(async () => []),
        listComments: vi.fn(async () => []),
      },
      db: store.db,
      logger: { info: vi.fn(), warn: vi.fn() },
    };
    return { ctx: mocks as unknown as PluginContext, mocks, store, coverId };
  }

  it("cover stays open while a sibling is still firing — resolving the winner first does not cancel or hide it", async () => {
    const { ctx, mocks, store, coverId } = coverContext(["alert-A", "alert-B"]);
    await recordSourceResolvedAndCloseCovers(ctx, "company-1", "alert-A");
    expect(mocks.issues.createComment).not.toHaveBeenCalled();
    expect(mocks.issues.update).not.toHaveBeenCalled();
    expect(store.covers.get(coverId)?.cancelled_at).toBeNull();
    expect(store.members.get(`${coverId}:alert-A`)?.resolved_at).not.toBeNull();
    expect(store.members.get(`${coverId}:alert-B`)?.resolved_at).toBeNull();
  });

  it("closes with exactly one resolution comment once the last member resolves", async () => {
    const { ctx, mocks, store, coverId } = coverContext(["alert-A", "alert-B"]);
    await recordSourceResolvedAndCloseCovers(ctx, "company-1", "alert-A");
    await recordSourceResolvedAndCloseCovers(ctx, "company-1", "alert-B");
    expect(mocks.issues.createComment).toHaveBeenCalledTimes(1);
    expect(mocks.issues.createComment).toHaveBeenCalledWith(coverId, expect.stringContaining("resolved"), "company-1");
    expect(mocks.issues.update).toHaveBeenCalledTimes(1);
    expect(mocks.issues.update).toHaveBeenCalledWith(coverId, { status: "cancelled" }, "company-1");
    expect(store.covers.get(coverId)?.cancelled_at).not.toBeNull();
  });

  it("a retried resolve delivery is idempotent — no duplicate comment or cancel", async () => {
    const { ctx, mocks, coverId } = coverContext(["alert-A"]);
    await recordSourceResolvedAndCloseCovers(ctx, "company-1", "alert-A");
    expect(mocks.issues.createComment).toHaveBeenCalledTimes(1);
    expect(mocks.issues.update).toHaveBeenCalledTimes(1);
    // retried delivery of the same resolved webhook
    await recordSourceResolvedAndCloseCovers(ctx, "company-1", "alert-A");
    expect(mocks.issues.createComment).toHaveBeenCalledTimes(1);
    expect(mocks.issues.update).toHaveBeenCalledTimes(1);
    expect(mocks.issues.update).toHaveBeenCalledWith(coverId, { status: "cancelled" }, "company-1");
  });

  it("an alert that never joined a cover resolves without touching any cover", async () => {
    const { ctx, mocks } = coverContext(["alert-A"]);
    await recordSourceResolvedAndCloseCovers(ctx, "company-1", "some-other-alert");
    expect(mocks.issues.createComment).not.toHaveBeenCalled();
    expect(mocks.issues.update).not.toHaveBeenCalled();
  });

  it("failure-injection: status update fails after the resolution comment is committed — retry converges without duplicating either", async () => {
    const { ctx, mocks, store, coverId } = coverContext(["alert-A"]);
    mocks.issues.update = vi.fn(async () => { throw new Error("transient: paperclip API 503"); });

    await expect(recordSourceResolvedAndCloseCovers(ctx, "company-1", "alert-A")).rejects.toThrow("transient");
    expect(mocks.issues.createComment).toHaveBeenCalledTimes(1);
    expect(store.covers.get(coverId)?.resolution_comment_posted_at).not.toBeNull();
    expect(store.covers.get(coverId)?.cancelled_at).toBeNull();

    // durable retry path: the sweep's reconciliation pass (or another resolve
    // delivery) resumes — must NOT re-post the comment, only finish the cancel.
    mocks.issues.update = vi.fn(async () => ({}));
    await runAlertEscalationSweep(ctx as any, config(), new Date("2026-07-11T01:00:00Z"));

    expect(mocks.issues.createComment).toHaveBeenCalledTimes(1);
    expect(mocks.issues.update).toHaveBeenCalledTimes(1);
    expect(mocks.issues.update).toHaveBeenCalledWith(coverId, { status: "cancelled" }, "company-1");
    expect(store.covers.get(coverId)?.cancelled_at).not.toBeNull();
  });

  it("failure-injection (BLO-16120 PR #662 review): createComment itself fails during close — the claim is won but the comment stays unposted, so reconciliation retries it instead of silently finalizing", async () => {
    const { ctx, mocks, store, coverId } = coverContext(["alert-A"]);
    mocks.issues.createComment = vi.fn(async () => { throw new Error("transient: paperclip API 503"); });

    await expect(recordSourceResolvedAndCloseCovers(ctx, "company-1", "alert-A")).rejects.toThrow("transient");
    // the claim was won (exactly one closer) but the comment never durably landed
    expect(store.covers.get(coverId)?.closing_claimed_at).not.toBeNull();
    expect(store.covers.get(coverId)?.resolution_comment_posted_at).toBeNull();
    expect(store.covers.get(coverId)?.cancelled_at).toBeNull();
    expect(mocks.issues.update).not.toHaveBeenCalled();

    // reconciliation must retry the comment (not skip straight to cancelling
    // with no audit trail) and only then finish the terminal transition
    mocks.issues.createComment = vi.fn(async () => ({}));
    mocks.issues.update = vi.fn(async () => ({}));
    await runAlertEscalationSweep(ctx as any, config(), new Date("2026-07-11T01:00:00Z"));

    expect(mocks.issues.createComment).toHaveBeenCalledTimes(1);
    expect(mocks.issues.update).toHaveBeenCalledWith(coverId, { status: "cancelled" }, "company-1");
    expect(store.covers.get(coverId)?.resolution_comment_posted_at).not.toBeNull();
    expect(store.covers.get(coverId)?.cancelled_at).not.toBeNull();
  });

  it("concurrency: two siblings resolving at once yield exactly one comment and one terminal transition", async () => {
    const { ctx, mocks, store, coverId } = coverContext(["alert-A", "alert-B"]);
    await Promise.all([
      recordSourceResolvedAndCloseCovers(ctx, "company-1", "alert-A"),
      recordSourceResolvedAndCloseCovers(ctx, "company-1", "alert-B"),
    ]);
    expect(mocks.issues.createComment).toHaveBeenCalledTimes(1);
    expect(mocks.issues.update).toHaveBeenCalledTimes(1);
    expect(store.covers.get(coverId)?.cancelled_at).not.toBeNull();
  });

  it("concurrency: duplicate resolve deliveries for the same single-member cover yield exactly one comment and cancel", async () => {
    const { ctx, mocks, store, coverId } = coverContext(["alert-A"]);
    await Promise.all([
      recordSourceResolvedAndCloseCovers(ctx, "company-1", "alert-A"),
      recordSourceResolvedAndCloseCovers(ctx, "company-1", "alert-A"),
    ]);
    expect(mocks.issues.createComment).toHaveBeenCalledTimes(1);
    expect(mocks.issues.update).toHaveBeenCalledTimes(1);
    expect(store.covers.get(coverId)?.cancelled_at).not.toBeNull();
  });
});

describe("BLO-16120 sweep reconciliation backstop for stuck covers", () => {
  it("finalizes a cover whose comment claim succeeded but whose cancel never ran, without re-posting", async () => {
    const store = buildFakeAlertmanagerStore();
    store.covers.set("cover-stuck", { cover_issue_id: "cover-stuck", company_id: "company-1", dedup_fingerprint: "cover:X:1", closing_claimed_at: "2026-07-11T00:00:00Z", resolution_comment_posted_at: "2026-07-11T00:00:00Z", cancelled_at: null });
    const state = { paperclipIssueId: "issue-1", paperclipCompanyId: "company-1", assigneeUserId: null, assigneeAgentId: "engineer", alertname: "SyntheticAlert", severity: "critical", firstSeenAt: "x", lastFiredAt: "x", resolvedAt: "2026-07-10T00:00:00Z", escalationComplete: true, nextEscalationAt: null, escalationAttempt: 3 };
    const { ctx, mocks } = sweepContext(state, null, store);
    mocks.issues.get = vi.fn(async () => ({ id: "cover-stuck", status: "todo" }));

    await runAlertEscalationSweep(ctx, config(), new Date("2026-07-11T01:00:00Z"));

    expect(mocks.issues.createComment).not.toHaveBeenCalled();
    expect(mocks.issues.update).toHaveBeenCalledWith("cover-stuck", { status: "cancelled" }, "company-1");
    expect(store.covers.get("cover-stuck")?.cancelled_at).not.toBeNull();
  });

  it("leaves an eligible-but-unclaimed cover alone — reconciliation only resumes already-claimed covers", async () => {
    const store = buildFakeAlertmanagerStore();
    store.covers.set("cover-open", { cover_issue_id: "cover-open", company_id: "company-1", dedup_fingerprint: "cover:X:1", closing_claimed_at: null, resolution_comment_posted_at: null, cancelled_at: null });
    store.members.set("cover-open:alert-A", { id: randomUUID(), cover_issue_id: "cover-open", alert_issue_id: "alert-A", resolved_at: null });
    const state = { paperclipIssueId: "issue-1", paperclipCompanyId: "company-1", assigneeUserId: null, assigneeAgentId: "engineer", alertname: "SyntheticAlert", severity: "critical", firstSeenAt: "x", lastFiredAt: "x", resolvedAt: "2026-07-10T00:00:00Z", escalationComplete: true, nextEscalationAt: null, escalationAttempt: 3 };
    const { ctx, mocks } = sweepContext(state, null, store);

    await runAlertEscalationSweep(ctx, config(), new Date("2026-07-11T01:00:00Z"));

    expect(mocks.issues.createComment).not.toHaveBeenCalled();
    expect(mocks.issues.update).not.toHaveBeenCalled();
  });
});

describe("BLO-15982 storm batching: concurrent same-alertname ladders", () => {
  it("N concurrent ladder advances for one alertname yield exactly one open cover, siblings durably tracked", async () => {
    const N = 6;
    const alertname = "PodPendingCritical";
    const store = buildFakeAlertmanagerStore();
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
            input.originKind === ORIGIN_KIND ? [issue] : store.issuesList(input as any)),
          listComments: vi.fn(async () => []),
          createComment: vi.fn(async (coverId: string, body: string) => {
            const existing = commentsByCoverId.get(coverId) ?? [];
            commentsByCoverId.set(coverId, [...existing, body]);
            return { id: `comment-${coverId}-${existing.length}`, body };
          }),
          update: vi.fn(async () => ({})),
          create: vi.fn(store.issuesCreate as any),
        },
        db: store.db,
        agents: { get: vi.fn(async () => null) },
        access: { members: { list: vi.fn(async () => [{ principalType: "user", principalId: "board-1", status: "active", membershipRole: "owner" }]) } },
        logger: { info: vi.fn(), warn: vi.fn() },
      };
      return runAlertEscalationSweep(ctx as unknown as PluginContext, config(), new Date("2026-07-11T01:00:00Z"));
    };

    await Promise.all(alertIssues.map(runWorker));

    const openCovers = [...store.coverIssuesById.values()].filter((c) => !["done", "cancelled"].includes(c.status));
    expect(openCovers).toHaveLength(1);
    const winnerCoverId = openCovers[0].id;

    // Every alert issue — winner and every losing sibling — is a durable,
    // open member of the single retained cover. Not a comment scan: a real
    // DB row per (cover, alert) pair.
    for (const issue of alertIssues) {
      const member = store.members.get(`${winnerCoverId}:${issue.id}`);
      expect(member, `missing durable membership for ${issue.id}`).toBeDefined();
      expect(member?.resolved_at).toBeNull();
    }

    const siblingComments = commentsByCoverId.get(winnerCoverId) ?? [];
    // Every losing sibling gets exactly one attach comment; the winner gets none.
    for (const issue of alertIssues) {
      const wasWinner = (openCovers[0] as any).originId === issue.id;
      const matching = siblingComments.filter((body) => body.includes(issue.identifier));
      expect(matching).toHaveLength(wasWinner ? 0 : 1);
    }
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
      issues: {
        create: vi.fn(async () => ({ id: "issue-1" })),
        // handleFiring reconciles against an existing issue on a state miss
        // (BLO-20467 retry idempotency); empty = "no prior attempt".
        list: vi.fn(async () => []),
      },
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

/**
 * BLO-20467 — the sweep must read alert state through the same legacy
 * migration path the webhook uses.
 *
 * These use a Map keyed by the FULL scope ref (kind + scopeId + key), not a
 * stubbed `state.get` that returns one record for every ref: the whole point is
 * that a scoped read and a legacy instance read are different lookups, which a
 * single-record stub cannot express.
 */
describe("BLO-20467 sweep reads legacy instance state through the migration path", () => {
  const keyOf = (ref: { scopeKind: string; scopeId?: string; stateKey: string }) =>
    `${ref.scopeKind}/${ref.scopeId ?? "-"}/${ref.stateKey}`;

  const dueState = (companyId: string): AlertStateRecord => ({
    paperclipIssueId: "issue-1",
    paperclipCompanyId: companyId,
    assigneeUserId: null,
    assigneeAgentId: "engineer",
    alertname: "SyntheticAlert",
    severity: "critical",
    firstSeenAt: "x",
    lastFiredAt: "x",
    resolvedAt: null,
    nextEscalationAt: "2026-07-11T00:00:00Z",
    escalationAttempt: 0,
  });

  function mapBackedSweepContext(seed: Array<[string, AlertStateRecord]>) {
    const store = buildFakeAlertmanagerStore();
    const state = new Map<string, AlertStateRecord>(seed);
    const issue = {
      id: "issue-1", identifier: "BLO-1", title: "Alert", status: "todo", priority: "critical",
      originId: "fp-1", assigneeAgentId: "engineer", projectId: null, goalId: null,
    };
    const mocks = {
      state: {
        get: vi.fn(async (ref: any) => state.get(keyOf(ref)) ?? null),
        set: vi.fn(async (ref: any, value: AlertStateRecord) => { state.set(keyOf(ref), value); }),
        delete: vi.fn(async (ref: any) => { state.delete(keyOf(ref)); }),
      },
      issues: {
        list: vi.fn(async (input: { originKind?: string }) => input.originKind?.endsWith(":escalation") ? store.issuesList(input as any) : [issue]),
        listComments: vi.fn(async () => []),
        createComment: vi.fn(async () => ({})),
        requestWakeup: vi.fn(async () => ({})),
        update: vi.fn(async () => issue),
        create: vi.fn(store.issuesCreate as any),
        get: vi.fn(async () => issue),
      },
      db: store.db,
      agents: { get: vi.fn(async (id: string) => ({ id, name: "Engineer", reportsTo: "cto" })) },
      access: { members: { list: vi.fn(async () => []) } },
      logger: { info: vi.fn(), warn: vi.fn() },
    };
    return { ctx: mocks as unknown as PluginContext, mocks, state };
  }

  it("advances a due ladder whose row is still in the pre-upgrade instance scope", async () => {
    // The upgrade-window case: the alert was firing before this version shipped,
    // so its row is instance-scoped and no webhook has arrived to migrate it.
    // Reading only the company key would see `null` and skip the rung silently.
    const { ctx, mocks, state } = mapBackedSweepContext([
      ["instance/-/alert:fp-1", dueState("company-1")],
    ]);

    await runAlertEscalationSweep(ctx, config(), new Date("2026-07-11T01:00:00Z"));

    expect(mocks.issues.requestWakeup).toHaveBeenCalledTimes(1);
    // and the row was migrated into company scope as a side effect
    expect(state.get("company/company-1/alert:fp-1")).toEqual(
      expect.objectContaining({ escalationAttempt: 1 }),
    );
    expect(state.has("instance/-/alert:fp-1")).toBe(false);
  });

  it("adopts a legacy row only for its owning tenant, not for a same-fingerprint neighbour", async () => {
    // Both halves matter, and the pairing is what makes this test non-vacuous:
    // asserting only that company-1 does nothing would also pass on a sweep that
    // never reads legacy state at all. The company-2 half proves the row IS
    // reachable, so company-1's refusal is a real ownership decision.
    const owner = mapBackedSweepContext([["instance/-/alert:fp-1", dueState("company-2")]]);
    await runAlertEscalationSweep(owner.ctx, config({ defaultCompanyId: "company-2" }), new Date("2026-07-11T01:00:00Z"));
    expect(owner.mocks.issues.requestWakeup).toHaveBeenCalledTimes(1);
    expect(owner.state.get("company/company-2/alert:fp-1")).toEqual(
      expect.objectContaining({ escalationAttempt: 1 }),
    );

    const neighbour = mapBackedSweepContext([["instance/-/alert:fp-1", dueState("company-2")]]);
    await runAlertEscalationSweep(neighbour.ctx, config(), new Date("2026-07-11T01:00:00Z"));
    expect(neighbour.mocks.issues.requestWakeup).not.toHaveBeenCalled();
    expect(neighbour.mocks.issues.createComment).not.toHaveBeenCalled();
    // untouched and un-migrated — still available to its real owner
    expect(neighbour.state.get("instance/-/alert:fp-1")).toEqual(
      expect.objectContaining({ paperclipCompanyId: "company-2", escalationAttempt: 0 }),
    );
    expect(neighbour.state.has("company/company-1/alert:fp-1")).toBe(false);
  });

  it("prefers an existing company-scoped row over a stale legacy one", async () => {
    // Precedence pin: guards the inverse bug of letting a leftover legacy copy
    // shadow the migrated row, which would replay an already-advanced rung.
    const { ctx, mocks } = mapBackedSweepContext([
      ["company/company-1/alert:fp-1", { ...dueState("company-1"), escalationAttempt: 2 }],
      ["instance/-/alert:fp-1", dueState("company-1")],
    ]);

    await runAlertEscalationSweep(ctx, config(), new Date("2026-07-11T01:00:00Z"));

    expect(mocks.issues.update).toHaveBeenCalledWith(
      "issue-1", { assigneeAgentId: "cto", assigneeUserId: null }, "company-1",
    );
    expect(mocks.state.set).toHaveBeenCalledWith(
      expect.objectContaining({ scopeKind: "company", scopeId: "company-1" }),
      expect.objectContaining({ escalationAttempt: 3 }),
    );
  });

  /**
   * BLO-20467 round 5 — adoption must not be a write of its own.
   *
   * An earlier build copied the legacy row to the company key inside the READ.
   * That made adoption a second, independent write of a verbatim pre-migration
   * snapshot, which could land on top of a scoped row another caller had
   * already advanced or resolved. `ctx.state` has no CAS to guard it with, so
   * the write was removed rather than guarded: the row now moves scope as a
   * side effect of the caller's own update.
   *
   * The general last-write-wins of two concurrent read-modify-writes is NOT
   * fixed by this and is not claimed to be — it predates the tenancy work and
   * applies to every escalation write. Tracked in BLO-20650.
   */
  describe("legacy adoption performs no write of its own", () => {
    it("does not touch state at all when the sweep decides not to act", async () => {
      // The sharpest case: a sweep that reads a not-yet-due legacy row and
      // returns without acting. Under the old read-migrates build this STILL
      // wrote the snapshot to the company key — so merely looking at an alert
      // could clobber a resolution a webhook had just written. A caller that
      // changes nothing must write nothing.
      const notDue = { ...dueState("company-1"), nextEscalationAt: "2026-07-11T06:00:00Z" };
      const { ctx, mocks, state } = mapBackedSweepContext([
        ["instance/-/alert:fp-1", notDue],
      ]);

      await runAlertEscalationSweep(ctx, config(), new Date("2026-07-11T01:00:00Z"));

      expect(mocks.state.set).not.toHaveBeenCalled();
      expect(mocks.state.delete).not.toHaveBeenCalled();
      expect(state.has("company/company-1/alert:fp-1")).toBe(false);
      // still there for whoever does act on it next
      expect(state.get("instance/-/alert:fp-1")).toEqual(
        expect.objectContaining({ escalationAttempt: 0 }),
      );
    });

    it("migrates with exactly one write, carrying the advance rather than a snapshot", async () => {
      // Pins the write COUNT, not just the end state: the old build wrote twice
      // (verbatim snapshot, then the advance), and it is the first of those two
      // that was the clobber. One write means there is no moment at which the
      // company key holds a pre-migration copy.
      const { ctx, mocks, state } = mapBackedSweepContext([
        ["instance/-/alert:fp-1", dueState("company-1")],
      ]);

      await runAlertEscalationSweep(ctx, config(), new Date("2026-07-11T01:00:00Z"));

      const scopedWrites = mocks.state.set.mock.calls.filter(
        ([ref]: [any, AlertStateRecord]) => ref.scopeKind === "company" && ref.stateKey === "alert:fp-1",
      );
      expect(scopedWrites).toHaveLength(1);
      expect(scopedWrites[0][1]).toEqual(expect.objectContaining({ escalationAttempt: 1 }));
      expect(state.has("instance/-/alert:fp-1")).toBe(false);
    });

    it("keeps a resolution written mid-migration by an interleaved webhook", async () => {
      // The controlled interleaving from the review: sweep and webhook both see
      // an empty company scope and read the same legacy snapshot; the webhook
      // resolves; the sweep's write lands afterwards.
      //
      // The sweep here is the not-due case — the one where the two callers
      // genuinely do not conflict, and where the old build lost the resolution
      // anyway purely because of the adoption write.
      const notDue = { ...dueState("company-1"), nextEscalationAt: "2026-07-11T06:00:00Z" };
      const { ctx, state } = mapBackedSweepContext([
        ["instance/-/alert:fp-1", notDue],
      ]);

      // Interleave: the webhook resolves the alert part-way through the sweep,
      // between the sweep's read of the legacy row and anything it does after.
      const resolvedByWebhook = {
        ...notDue,
        resolvedAt: "2026-07-11T00:30:00Z",
        escalationComplete: true,
        nextEscalationAt: null,
      };
      const originalGet = ctx.state.get as unknown as (ref: any) => Promise<unknown>;
      let injected = false;
      (ctx.state as any).get = vi.fn(async (ref: any) => {
        const value = await originalGet(ref);
        if (!injected && ref.scopeKind === "instance") {
          injected = true;
          state.set("company/company-1/alert:fp-1", resolvedByWebhook as AlertStateRecord);
          state.delete("instance/-/alert:fp-1");
        }
        return value;
      });

      await runAlertEscalationSweep(ctx, config(), new Date("2026-07-11T01:00:00Z"));

      expect(state.get("company/company-1/alert:fp-1")).toEqual(
        expect.objectContaining({ resolvedAt: "2026-07-11T00:30:00Z", escalationComplete: true }),
      );
    });
  });
});
