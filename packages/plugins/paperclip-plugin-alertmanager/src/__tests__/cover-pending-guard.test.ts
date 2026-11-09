import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  COVER_ORIGIN,
  buildCoverCloseGuard,
  recordSourceResolvedAndCloseCovers,
  reopenOpenCoverMembership,
  runAlertEscalationSweep,
  type CoverCloseGuard,
} from "../escalation.js";
import {
  createSweepPendingReader,
  hasPrometheusEndpoint,
  resolvePrometheusApiUrl,
  type PrometheusPendingState,
} from "../prometheus-pending.js";
import type { AlertmanagerPluginConfig, AlertStateRecord } from "../types.js";

/**
 * PEN-6236.
 *
 * Two defects in the `[user-cover]` artifact, and the fixtures below are
 * deliberately built on the SOURCE ALERTS THAT HAVE ACTUALLY MINTED COVERS
 * rather than on round numbers, because the row's own acceptance criterion
 * says so: *"Demonstrated on a source whose `for:` exceeds the configured
 * hold. A test that only exercises `for: < hold` does not discharge this."*
 *
 * `PaperclipApprovalStarved` carries `for: 3600s` against a 15-minute hold, so
 * every scenario here has the member resolved well past the hold while the
 * rule is still re-accumulating — the exact state in which today's code
 * cancels the cover and the reopen branch cannot save it.
 */

const ALERTNAME = "PaperclipApprovalStarved";
/** `for:` on the live rule, 2026-11-09. 4× the default close hold. */
const SOURCE_FOR_SECONDS = 3_600;
const HOLD_MINUTES = 15;

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
  vi.restoreAllMocks();
});

async function startServer(handler: (req: unknown, res: any) => void): Promise<string> {
  const server = createServer(handler as never);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() });

// ---------------------------------------------------------------------------
// Store: the real columns, including the five PEN-6236 adds.
// ---------------------------------------------------------------------------

interface CoverRow {
  cover_issue_id: string;
  company_id: string;
  dedup_fingerprint: string;
  alertname: string | null;
  closing_claimed_at: string | null;
  resolution_comment_posted_at: string | null;
  cancelled_at: string | null;
  close_verdict: string | null;
  close_verdict_detail: string | null;
  pending_deferral_count: number;
  last_pending_deferral_at: string | null;
}

function buildStore() {
  const covers = new Map<string, CoverRow>();
  const members = new Map<string, { id: string; cover_issue_id: string; alert_issue_id: string; resolved_at: string | null }>();
  const coverIssuesById = new Map<string, Record<string, unknown>>();
  const openByFingerprint = new Map<string, string>();
  let seq = 0;

  const openMemberCount = (coverIssueId: string) =>
    [...members.values()].filter((m) => m.cover_issue_id === coverIssueId && m.resolved_at === null).length;

  /** All members resolved, and every one of them past `holdMinutes`. */
  const eligible = (coverIssueId: string, holdMinutes: number) => {
    if (openMemberCount(coverIssueId) > 0) return false;
    const cutoff = Date.now() - holdMinutes * 60_000;
    return [...members.values()]
      .filter((m) => m.cover_issue_id === coverIssueId)
      .every((m) => Date.parse(m.resolved_at!) <= cutoff);
  };
  const withinRecheck = (coverIssueId: string, minutes: number) => {
    const cutoff = Date.now() - minutes * 60_000;
    return [...members.values()].some((m) => m.cover_issue_id === coverIssueId && m.resolved_at !== null && Date.parse(m.resolved_at) > cutoff);
  };

  const db = {
    namespace: "ns",
    async execute(sql: string, params: unknown[] = []) {
      const text = sql.replace(/\s+/g, " ").trim();
      if (text.includes("pending_deferral_count = pending_deferral_count + 1")) {
        const [coverIssueId] = params as [string];
        const c = covers.get(coverIssueId);
        if (!c || c.closing_claimed_at !== null || c.cancelled_at !== null) return { rowCount: 0 };
        c.pending_deferral_count += 1;
        c.last_pending_deferral_at = new Date().toISOString();
        return { rowCount: 1 };
      }
      if (text.includes("ON CONFLICT (cover_issue_id, alert_issue_id)")) {
        const [id, coverIssueId, alertIssueId] = params as [string, string, string];
        const key = `${coverIssueId}:${alertIssueId}`;
        const existing = members.get(key);
        if (!existing) {
          members.set(key, { id, cover_issue_id: coverIssueId, alert_issue_id: alertIssueId, resolved_at: null });
          return { rowCount: 1 };
        }
        if (existing.resolved_at !== null) { existing.resolved_at = null; return { rowCount: 1 }; }
        return { rowCount: 0 };
      }
      if (text.includes("ON CONFLICT (cover_issue_id) DO NOTHING")) {
        const [coverIssueId, companyId, fingerprint, alertname] = params as [string, string, string, string | null];
        if (covers.has(coverIssueId)) return { rowCount: 0 };
        covers.set(coverIssueId, {
          cover_issue_id: coverIssueId, company_id: companyId, dedup_fingerprint: fingerprint,
          alertname: alertname ?? null, closing_claimed_at: null, resolution_comment_posted_at: null,
          cancelled_at: null, close_verdict: null, close_verdict_detail: null,
          pending_deferral_count: 0, last_pending_deferral_at: null,
        });
        return { rowCount: 1 };
      }
      if (text.includes("SET closing_claimed_at = now()")) {
        const [coverIssueId, holdMinutes, verdict, detail] = params as [string, number, string, string | null];
        const c = covers.get(coverIssueId);
        if (!c || c.closing_claimed_at !== null || c.cancelled_at !== null) return { rowCount: 0 };
        if (!eligible(coverIssueId, holdMinutes)) return { rowCount: 0 };
        c.closing_claimed_at = new Date().toISOString();
        c.close_verdict = verdict;
        c.close_verdict_detail = detail;
        return { rowCount: 1 };
      }
      if (text.includes("SET resolution_comment_posted_at = now()")) {
        const [coverIssueId] = params as [string];
        const c = covers.get(coverIssueId);
        if (!c || c.resolution_comment_posted_at !== null) return { rowCount: 0 };
        c.resolution_comment_posted_at = new Date().toISOString();
        return { rowCount: 1 };
      }
      if (text.includes("c.cancelled_at IS NULL") && text.startsWith("UPDATE")) {
        const [alertIssueId] = params as [string];
        let count = 0;
        for (const m of members.values()) {
          if (m.alert_issue_id !== alertIssueId) continue;
          const c = covers.get(m.cover_issue_id);
          if (!c || c.cancelled_at !== null || c.closing_claimed_at !== null) continue;
          m.resolved_at = null; count += 1;
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
        const c = covers.get(coverIssueId);
        if (!c || c.cancelled_at !== null) return { rowCount: 0 };
        c.cancelled_at = new Date().toISOString();
        return { rowCount: 1 };
      }
      if (text.includes("alert_attendance_observations") || text.includes("alertmanager_aggregate")) return { rowCount: 1 };
      throw new Error(`fake db: unrecognized execute statement: ${text}`);
    },
    async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      const text = sql.replace(/\s+/g, " ").trim();
      if (text.startsWith("SELECT c.alertname")) {
        const [coverIssueId, holdMinutes, recheckMinutes] = params as [string, number, number];
        const c = covers.get(coverIssueId);
        if (!c || c.closing_claimed_at !== null || c.cancelled_at !== null) return [];
        return [{
          alertname: c.alertname,
          eligible: eligible(coverIssueId, holdMinutes),
          within_recheck: withinRecheck(coverIssueId, recheckMinutes),
        }] as T[];
      }
      if (text.startsWith("SELECT cover_issue_id, close_verdict")) {
        const [companyId, alertname] = params as [string, string];
        const match = [...covers.values()]
          .filter((c) => c.company_id === companyId && c.alertname === alertname && c.cancelled_at !== null)
          .sort((a, b) => (a.cancelled_at! < b.cancelled_at! ? 1 : -1))[0];
        return (match ? [{ cover_issue_id: match.cover_issue_id, close_verdict: match.close_verdict }] : []) as T[];
      }
      if (text.startsWith("SELECT closing_claimed_at")) {
        const [coverIssueId] = params as [string];
        const c = covers.get(coverIssueId);
        return (c ? [c] : []) as T[];
      }
      if (text.startsWith("SELECT DISTINCT cover_issue_id")) {
        const [alertIssueId] = params as [string];
        const ids = new Set<string>();
        for (const m of members.values()) if (m.alert_issue_id === alertIssueId) ids.add(m.cover_issue_id);
        return [...ids].map((cover_issue_id) => ({ cover_issue_id })) as T[];
      }
      if (text.includes("c.closing_claimed_at IS NULL AND c.cancelled_at IS NULL")) {
        const [companyId] = params as [string];
        return [...covers.values()]
          .filter((c) => c.company_id === companyId && c.closing_claimed_at === null && c.cancelled_at === null && openMemberCount(c.cover_issue_id) === 0)
          .map((c) => ({ cover_issue_id: c.cover_issue_id })) as T[];
      }
      if (text.includes("closing_claimed_at IS NOT NULL AND cancelled_at IS NULL")) {
        const [companyId] = params as [string];
        return [...covers.values()]
          .filter((c) => c.company_id === companyId && c.closing_claimed_at !== null && c.cancelled_at === null)
          .map((c) => ({ cover_issue_id: c.cover_issue_id })) as T[];
      }
      if (text.includes("alertmanager_aggregate")) return [];
      throw new Error(`fake db: unrecognized query statement: ${text}`);
    },
  };

  function issuesCreate(params: Record<string, unknown>) {
    seq += 1;
    const id = `cover-${seq}`;
    const fp = params.originFingerprint as string | undefined;
    if (fp) {
      if (openByFingerprint.has(fp)) throw new Error("Alert escalation cover conflict");
      openByFingerprint.set(fp, id);
    }
    const issue = { id, identifier: `PEN-${9000 + seq}`, status: "todo", ...params };
    coverIssuesById.set(id, issue);
    return issue;
  }

  return { db, covers, members, coverIssuesById, openByFingerprint, issuesCreate, openMemberCount };
}

/** A cover whose single member resolved `resolvedMinutesAgo` ago — past the hold. */
function seedResolvedCover(store: ReturnType<typeof buildStore>, resolvedMinutesAgo: number, alertname: string | null = ALERTNAME) {
  store.covers.set("cover-1", {
    cover_issue_id: "cover-1", company_id: "company-1", dedup_fingerprint: `cover:${ALERTNAME}:1`,
    alertname, closing_claimed_at: null, resolution_comment_posted_at: null, cancelled_at: null,
    close_verdict: null, close_verdict_detail: null, pending_deferral_count: 0, last_pending_deferral_at: null,
  });
  store.members.set("cover-1:alert-A", {
    id: randomUUID(), cover_issue_id: "cover-1", alert_issue_id: "alert-A",
    resolved_at: new Date(Date.now() - resolvedMinutesAgo * 60_000).toISOString(),
  });
}

function coverCtx(store: ReturnType<typeof buildStore>, comments: unknown[] = []) {
  const mocks = {
    issues: {
      // An OPEN cover row: `finalizeCoverCancellation` skips its
      // `issues.update` when the issue already reads terminal, so a fallback
      // of "cancelled" here would make the close look like a no-op and assert
      // nothing.
      get: vi.fn(async (id: string) => store.coverIssuesById.get(id) ?? { id, identifier: "PEN-6224", status: "todo" }),
      update: vi.fn(async () => ({})),
      createComment: vi.fn(async () => ({})),
      list: vi.fn(async () => []),
      listComments: vi.fn(async () => comments),
    },
    db: store.db,
    logger: logger(),
  };
  return { ctx: mocks as unknown as PluginContext, mocks };
}

/** A guard whose Prometheus answer is fixed, so the close decision is the only variable. */
const stubGuard = (answer: PrometheusPendingState, recheckLimitMinutes = 240): CoverCloseGuard => ({
  readPending: async () => answer,
  recheckLimitMinutes,
  configured: true,
});

const PENDING: PrometheusPendingState = { state: "pending", readAt: "2026-11-09T06:00:00.000Z", detail: "1 series pending" };
const NOT_PENDING: PrometheusPendingState = { state: "not-pending", readAt: "2026-11-09T06:00:00.000Z" };
const UNKNOWN: PrometheusPendingState = { state: "unknown", reason: "the Prometheus request failed; the error is in the plugin log", unreachable: true };

// ---------------------------------------------------------------------------
// Defect A
// ---------------------------------------------------------------------------

describe(`PEN-6236 defect A — the close is refused while the source rule re-accumulates for: (${ALERTNAME}, for: ${SOURCE_FOR_SECONDS}s vs hold ${HOLD_MINUTES}m)`, () => {
  it("refuses the close while Prometheus reports the source pending, PAST the hold — the case the reopen branch cannot reach", async () => {
    const store = buildStore();
    // 20 minutes resolved: the hold has fully elapsed, so today's code cancels
    // here. The rule's `for:` is 3600s, so no re-fire can arrive for another
    // 40 minutes and `reopenOpenCoverMembership` is structurally unreachable.
    seedResolvedCover(store, 20);
    expect(20 * 60).toBeGreaterThan(HOLD_MINUTES * 60);
    expect(SOURCE_FOR_SECONDS).toBeGreaterThan(HOLD_MINUTES * 60);
    const { ctx, mocks } = coverCtx(store);

    await recordSourceResolvedAndCloseCovers(ctx, "company-1", "alert-A", HOLD_MINUTES, stubGuard(PENDING));

    const cover = store.covers.get("cover-1")!;
    expect(cover.closing_claimed_at).toBeNull();
    expect(cover.cancelled_at).toBeNull();
    expect(mocks.issues.update).not.toHaveBeenCalled();
    expect(mocks.issues.createComment).not.toHaveBeenCalled();
    // the deferral is recorded, not merely logged — an absence is not a record
    expect(cover.pending_deferral_count).toBe(1);
    expect(cover.last_pending_deferral_at).not.toBeNull();
    expect(mocks.logger.info).toHaveBeenCalledWith(expect.stringContaining("is pending in Prometheus"));
  });

  it("the cover survives to the re-fire: membership reopens and the cover is still open to receive it", async () => {
    const store = buildStore();
    seedResolvedCover(store, 20);
    const { ctx } = coverCtx(store);
    await recordSourceResolvedAndCloseCovers(ctx, "company-1", "alert-A", HOLD_MINUTES, stubGuard(PENDING));
    // 40 minutes later the rule finishes re-accumulating and fires again.
    expect(await reopenOpenCoverMembership(ctx, "alert-A")).toBe(1);
    expect(store.members.get("cover-1:alert-A")!.resolved_at).toBeNull();
    expect(store.covers.get("cover-1")!.cancelled_at).toBeNull();
  });

  it("closes, and records source_cleared, when Prometheus reports the source NOT pending", async () => {
    const store = buildStore();
    seedResolvedCover(store, 20);
    const { ctx, mocks } = coverCtx(store);

    await recordSourceResolvedAndCloseCovers(ctx, "company-1", "alert-A", HOLD_MINUTES, stubGuard(NOT_PENDING));

    const cover = store.covers.get("cover-1")!;
    expect(cover.cancelled_at).not.toBeNull();
    expect(cover.close_verdict).toBe("source_cleared");
    expect(cover.pending_deferral_count).toBe(0);
    expect(mocks.issues.update).toHaveBeenCalledWith("cover-1", { status: "cancelled" }, "company-1");
    expect(mocks.issues.createComment).toHaveBeenCalledWith("cover-1", expect.stringContaining("`source_cleared`"), "company-1");
  });

  it("an inconclusive read defers too — `unknown` is never folded into `not-pending`", async () => {
    const store = buildStore();
    seedResolvedCover(store, 20);
    const { ctx, mocks } = coverCtx(store);

    await recordSourceResolvedAndCloseCovers(ctx, "company-1", "alert-A", HOLD_MINUTES, stubGuard(UNKNOWN));

    expect(store.covers.get("cover-1")!.cancelled_at).toBeNull();
    expect(store.covers.get("cover-1")!.pending_deferral_count).toBe(1);
    expect(mocks.logger.info).toHaveBeenCalledWith(expect.stringContaining("inconclusive"));
  });

  it("the deferral is BOUNDED: past the recheck window a still-pending source closes as pending_recheck_expired", async () => {
    const store = buildStore();
    // resolved 5 hours ago, recheck limit 240m — hold + limit = 255m < 300m.
    seedResolvedCover(store, 300);
    const { ctx, mocks } = coverCtx(store);

    await recordSourceResolvedAndCloseCovers(ctx, "company-1", "alert-A", HOLD_MINUTES, stubGuard(PENDING, 240));

    const cover = store.covers.get("cover-1")!;
    expect(cover.cancelled_at).not.toBeNull();
    expect(cover.close_verdict).toBe("pending_recheck_expired");
    expect(cover.pending_deferral_count).toBe(0);
    expect(mocks.issues.createComment).toHaveBeenCalledWith("cover-1", expect.stringContaining("BOUNDED rather than evidenced"), "company-1");
  });

  it("past the window an unreadable Prometheus closes as pending_check_unavailable, not as a clear", async () => {
    const store = buildStore();
    seedResolvedCover(store, 300);
    const { ctx } = coverCtx(store);
    await recordSourceResolvedAndCloseCovers(ctx, "company-1", "alert-A", HOLD_MINUTES, stubGuard(UNKNOWN, 240));
    expect(store.covers.get("cover-1")!.close_verdict).toBe("pending_check_unavailable");
  });

  it("a cover with no alertname (pre-migration, unparseable fingerprint) closes as alertname_unknown rather than guessing", async () => {
    const store = buildStore();
    seedResolvedCover(store, 20, null);
    const { ctx } = coverCtx(store);
    const guard = { ...stubGuard(PENDING), readPending: vi.fn(async () => PENDING) };
    await recordSourceResolvedAndCloseCovers(ctx, "company-1", "alert-A", HOLD_MINUTES, guard);
    expect(store.covers.get("cover-1")!.close_verdict).toBe("alertname_unknown");
    // and it never addressed a read to nothing
    expect(guard.readPending).not.toHaveBeenCalled();
  });

  it("an UNCONFIGURED instance is behaviour-neutral: it closes as before, issues no extra query, and says so in the record", async () => {
    const store = buildStore();
    seedResolvedCover(store, 20);
    const { ctx, mocks } = coverCtx(store);
    const readPending = vi.fn(async () => NOT_PENDING);
    const querySpy = vi.spyOn(store.db, "query");

    await recordSourceResolvedAndCloseCovers(ctx, "company-1", "alert-A", HOLD_MINUTES, { readPending, recheckLimitMinutes: 240, configured: false });

    expect(store.covers.get("cover-1")!.cancelled_at).not.toBeNull();
    expect(store.covers.get("cover-1")!.close_verdict).toBe("pending_check_unconfigured");
    expect(readPending).not.toHaveBeenCalled();
    // the decision SELECT is never issued on an unconfigured instance
    expect(querySpy.mock.calls.filter(([sql]) => sql.includes("within_recheck"))).toHaveLength(0);
    expect(mocks.issues.createComment).toHaveBeenCalledWith("cover-1", expect.stringContaining("`pending_check_unconfigured`"), "company-1");
  });

  it("a cover still inside the hold is not read at all — the guard costs no HTTP call on an ineligible cover", async () => {
    const store = buildStore();
    seedResolvedCover(store, 2); // well inside the 15m hold
    const { ctx } = coverCtx(store);
    const readPending = vi.fn(async () => NOT_PENDING);
    await recordSourceResolvedAndCloseCovers(ctx, "company-1", "alert-A", HOLD_MINUTES, { readPending, recheckLimitMinutes: 240, configured: true });
    expect(readPending).not.toHaveBeenCalled();
    expect(store.covers.get("cover-1")!.cancelled_at).toBeNull();
  });

  it("the resumed finalize posts the verdict the ORIGINAL claim decided, not a freshly derived one", async () => {
    const store = buildStore();
    seedResolvedCover(store, 300);
    const { ctx, mocks } = coverCtx(store);
    // First attempt wins the claim, stamps the verdict, then the comment throws.
    mocks.issues.createComment.mockRejectedValueOnce(new Error("transient"));
    await expect(recordSourceResolvedAndCloseCovers(ctx, "company-1", "alert-A", HOLD_MINUTES, stubGuard(PENDING, 240))).rejects.toThrow("transient");
    expect(store.covers.get("cover-1")!.close_verdict).toBe("pending_recheck_expired");
    // The sweep's reconcile pass resumes it. Prometheus has since gone clear —
    // the resumption must NOT relabel the close as source_cleared.
    await runAlertEscalationSweep(ctx, { defaultCompanyId: "company-1", autoCloseOnResolve: true } as AlertmanagerPluginConfig, new Date());
    expect(store.covers.get("cover-1")!.close_verdict).toBe("pending_recheck_expired");
    expect(mocks.issues.createComment).toHaveBeenLastCalledWith("cover-1", expect.stringContaining("`pending_recheck_expired`"), "company-1");
  });
});

// ---------------------------------------------------------------------------
// The reader itself — gate polarity, with a control arm on every branch.
// ---------------------------------------------------------------------------

describe("PEN-6236 the Prometheus pending reader", () => {
  const cfg = (prometheusApiUrl?: string): AlertmanagerPluginConfig =>
    ({ defaultCompanyId: "company-1", autoCloseOnResolve: true, prometheusApiUrl }) as AlertmanagerPluginConfig;

  it("reports `pending` for a matching series, and `not-pending` for an empty vector — both arms, so the probe discriminates", async () => {
    const base = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "success", data: { resultType: "vector", result: [{ metric: { alertname: ALERTNAME, alertstate: "pending" }, value: [0, "1"] }] } }));
    });
    const read = createSweepPendingReader(cfg(base), new Date(), logger(), {});
    expect((await read(ALERTNAME)).state).toBe("pending");

    const empty = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "success", data: { resultType: "vector", result: [] } }));
    });
    expect((await createSweepPendingReader(cfg(empty), new Date(), logger(), {}))(ALERTNAME).then((r) => r.state)).resolves.toBe("not-pending");
  });

  it("re-applies both matchers locally, so a proxy that ignores the selector cannot freeze every close", async () => {
    const base = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "success", data: { result: [
        { metric: { alertname: "SomethingElse", alertstate: "pending" } },
        { metric: { alertname: ALERTNAME, alertstate: "firing" } },
      ] } }));
    });
    const read = createSweepPendingReader(cfg(base), new Date(), logger(), {});
    // neither row is "this alertname AND pending"
    expect((await read(ALERTNAME)).state).toBe("not-pending");
  });

  it.each([
    ["a 200 carrying status=error (a proxy swallowing the 400)", 200, JSON.stringify({ status: "error", errorType: "bad_data" })],
    ["a non-array result vector", 200, JSON.stringify({ status: "success", data: { result: { nope: true } } })],
    ["a body that is not JSON", 200, "<html>gateway</html>"],
    ["HTTP 500", 500, "boom"],
  ])("answers `unknown`, never `not-pending`, for %s", async (_label, status, body) => {
    const base = await startServer((_req, res) => { res.writeHead(status, { "content-type": "application/json" }); res.end(body); });
    const read = createSweepPendingReader(cfg(base), new Date(), logger(), {});
    const answer = await read(ALERTNAME);
    expect(answer.state).toBe("unknown");
  });

  it("refuses a non-http scheme, so a `data:` URL cannot supply its own empty vector", async () => {
    const read = createSweepPendingReader(cfg("data:application/json,%7B%22status%22%3A%22success%22%7D"), new Date(), logger(), {});
    expect((await read(ALERTNAME)).state).toBe("unknown");
    expect(hasPrometheusEndpoint(cfg("data:application/json,x"), {})).toBe(false);
  });

  it("an unset endpoint is `unknown`, and resolves config ahead of environment", async () => {
    expect((await createSweepPendingReader(cfg(), new Date(), logger(), {})(ALERTNAME)).state).toBe("unknown");
    expect(resolvePrometheusApiUrl(cfg("http://from-config:9090/"), { PAPERCLIP_PROMETHEUS_API_URL: "http://from-env:9090" })).toBe("http://from-config:9090");
    expect(resolvePrometheusApiUrl(cfg(), { PAPERCLIP_PROMETHEUS_API_URL: "http://from-env:9090/" })).toBe("http://from-env:9090");
    expect(hasPrometheusEndpoint(cfg(), {})).toBe(false);
    expect(hasPrometheusEndpoint(cfg("http://p:9090"), {})).toBe(true);
  });

  it("memoises by alertname and short-circuits the whole pass on a transport failure", async () => {
    let hits = 0;
    const base = await startServer((_req, res) => { hits += 1; res.socket?.destroy(); });
    const read = createSweepPendingReader(cfg(base), new Date(), logger(), {});
    await read("A"); await read("B"); await read("A");
    expect(hits).toBe(1);
  });

  it("escapes a quote in the alertname rather than letting it terminate the matcher", async () => {
    let seen = "";
    const base = await startServer((req: any, res: any) => {
      seen = req.url ?? "";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "success", data: { result: [] } }));
    });
    await createSweepPendingReader(cfg(base), new Date(), logger(), {})('Weird"Name');
    expect(decodeURIComponent(seen)).toContain('alertname="Weird\\"Name"');
  });

  it("buildCoverCloseGuard reports configured only when a usable endpoint exists", () => {
    expect(buildCoverCloseGuard(cfg(), new Date(), logger()).configured).toBe(false);
    const guard = buildCoverCloseGuard({ ...cfg("http://p:9090"), coverPendingRecheckLimitMinutes: 77 }, new Date(), logger());
    expect(guard.configured).toBe(true);
    expect(guard.recheckLimitMinutes).toBe(77);
    expect(buildCoverCloseGuard(cfg("http://p:9090"), new Date(), logger()).recheckLimitMinutes).toBe(240);
  });
});

// ---------------------------------------------------------------------------
// Defect B
// ---------------------------------------------------------------------------

describe("PEN-6236 defect B — a re-minted cover carries its predecessor's furnished content", () => {
  const state: AlertStateRecord = {
    paperclipIssueId: "issue-1", paperclipCompanyId: "company-1", assigneeUserId: null, assigneeAgentId: null,
    alertname: ALERTNAME, severity: "critical", firstSeenAt: "x", lastFiredAt: "2026-11-09T05:00:00Z",
    resolvedAt: null, nextEscalationAt: "2026-11-09T05:30:00Z", escalationAttempt: 1,
  } as AlertStateRecord;

  /** A sweep driven straight to the cover rung (no agent owner ⇒ chain exhausted). */
  function mintCtx(store: ReturnType<typeof buildStore>, priorComments: unknown[]) {
    const issue = {
      id: "issue-1", identifier: "PEN-5719", title: "Alert", status: "todo", priority: "high",
      originId: "fp-1", assigneeAgentId: null, projectId: null, goalId: null, monitorNextCheckAt: null,
    };
    const mocks = {
      state: { get: vi.fn(async () => state), set: vi.fn(async () => undefined) },
      issues: {
        list: vi.fn(async (input: { originKind?: string }) => (input.originKind === COVER_ORIGIN ? [] : [issue])),
        listComments: vi.fn(async (id: string) => (id === "issue-1" ? [] : priorComments)),
        createComment: vi.fn(async () => ({})),
        requestWakeup: vi.fn(async () => ({})),
        update: vi.fn(async () => issue),
        create: vi.fn((p: Record<string, unknown>) => Promise.resolve(store.issuesCreate(p))),
        get: vi.fn(async (id: string) => store.coverIssuesById.get(id) ?? { id, identifier: "PEN-5903", status: "cancelled" }),
        relations: { get: vi.fn(async () => ({ blockedBy: [], blocks: [] })) },
      },
      db: store.db,
      agents: { get: vi.fn(async () => null) },
      access: { members: { list: vi.fn(async () => [{ principalType: "user", principalId: "board-1", status: "active", membershipRole: "owner" }]) } },
      logger: logger(),
    };
    return { ctx: mocks as unknown as PluginContext, mocks };
  }

  /** A closed predecessor cover for the same alertname. */
  function seedPredecessor(store: ReturnType<typeof buildStore>) {
    store.covers.set("cover-prev", {
      cover_issue_id: "cover-prev", company_id: "company-1", dedup_fingerprint: `cover:${ALERTNAME}:0`,
      alertname: ALERTNAME, closing_claimed_at: "2026-11-08T14:38:00Z", resolution_comment_posted_at: "2026-11-08T14:38:00Z",
      cancelled_at: "2026-11-08T14:38:31Z", close_verdict: "pending_recheck_expired", close_verdict_detail: null,
      pending_deferral_count: 3, last_pending_deferral_at: "2026-11-08T14:20:00Z",
    });
    store.coverIssuesById.set("cover-prev", { id: "cover-prev", identifier: "PEN-5903", status: "cancelled" });
  }

  const furnished = [
    { body: "[alert-escalation] All source alerts represented by this cover have resolved; closing.", authorType: "agent", createdAt: new Date("2026-11-08T14:38:31Z"), deletedAt: null },
    { body: "Stop admitting new approval cards until the queue drains; the servicing loop is wedged on PEN-4835.", authorType: "agent", createdAt: new Date("2026-11-07T09:12:00Z"), deletedAt: null },
    { body: "Confirmed — restart is NOT the remedy here, it re-queues the same head.", authorType: "agent", createdAt: new Date("2026-11-07T10:02:00Z"), deletedAt: null },
    { body: "a system note", authorType: "system", createdAt: new Date("2026-11-07T10:03:00Z"), deletedAt: null },
    { body: "a deleted thought", authorType: "agent", createdAt: new Date("2026-11-07T10:04:00Z"), deletedAt: new Date("2026-11-07T10:05:00Z") },
  ];

  it("the successor's own description names the predecessor and quotes what it was told", async () => {
    const store = buildStore();
    seedPredecessor(store);
    const { ctx, mocks } = mintCtx(store, furnished);

    await runAlertEscalationSweep(ctx, { defaultCompanyId: "company-1", autoCloseOnResolve: true } as AlertmanagerPluginConfig, new Date("2026-11-09T06:00:00Z"));

    const created = mocks.issues.create.mock.calls[0]![0] as { description: string; title: string };
    expect(created.title).toContain("[user-cover]");
    expect(created.description).toContain("Previous cover for");
    expect(created.description).toContain("PEN-5903");
    expect(created.description).toContain("pending_recheck_expired");
    // the furnished dispositions travel
    expect(created.description).toContain("Stop admitting new approval cards");
    expect(created.description).toContain("restart is NOT the remedy");
    // the machine's own sentences, system notes and deleted comments do not
    expect(created.description).not.toContain("have resolved; closing");
    expect(created.description).not.toContain("a system note");
    expect(created.description).not.toContain("a deleted thought");
  });

  it("says so explicitly when the predecessor carried nothing, rather than implying it did", async () => {
    const store = buildStore();
    seedPredecessor(store);
    const { ctx, mocks } = mintCtx(store, [furnished[0]]); // plugin comment only
    await runAlertEscalationSweep(ctx, { defaultCompanyId: "company-1", autoCloseOnResolve: true } as AlertmanagerPluginConfig, new Date("2026-11-09T06:00:00Z"));
    const created = mocks.issues.create.mock.calls[0]![0] as { description: string };
    expect(created.description).toContain("PEN-5903");
    expect(created.description).toContain("carried no furnished comment of its own");
  });

  it("a FIRST cover for an alertname carries no section at all", async () => {
    const store = buildStore();
    const { ctx, mocks } = mintCtx(store, []);
    await runAlertEscalationSweep(ctx, { defaultCompanyId: "company-1", autoCloseOnResolve: true } as AlertmanagerPluginConfig, new Date("2026-11-09T06:00:00Z"));
    const created = mocks.issues.create.mock.calls[0]![0] as { description: string };
    expect(created.description).not.toContain("Previous cover for");
    expect(created.description).toContain("exhausted its agent chain");
  });

  it("a failing carry-over lookup degrades the section, never the cover", async () => {
    const store = buildStore();
    seedPredecessor(store);
    const { ctx, mocks } = mintCtx(store, furnished);
    mocks.issues.listComments.mockImplementation(async (id: string) => {
      if (id === "cover-prev") throw new Error("comment read exploded");
      return [];
    });
    await runAlertEscalationSweep(ctx, { defaultCompanyId: "company-1", autoCloseOnResolve: true } as AlertmanagerPluginConfig, new Date("2026-11-09T06:00:00Z"));
    expect(mocks.issues.create).toHaveBeenCalledTimes(1);
    const created = mocks.issues.create.mock.calls[0]![0] as { description: string };
    expect(created.description).toContain("exhausted its agent chain");
    expect(created.description).not.toContain("Previous cover for");
    expect(mocks.logger.warn).toHaveBeenCalledWith(expect.stringContaining("could not carry over"));
  });

  it("renders the ISO-string createdAt the worker boundary actually delivers, not [object Object]", async () => {
    const store = buildStore();
    seedPredecessor(store);
    const wire = [{ body: "disposition from the wire", authorType: "agent", createdAt: "2026-11-07T09:12:00.000Z", deletedAt: null }];
    const { ctx, mocks } = mintCtx(store, wire);
    await runAlertEscalationSweep(ctx, { defaultCompanyId: "company-1", autoCloseOnResolve: true } as AlertmanagerPluginConfig, new Date("2026-11-09T06:00:00Z"));
    const created = mocks.issues.create.mock.calls[0]![0] as { description: string };
    expect(created.description).toContain("2026-11-07T09:12:00.000Z");
    expect(created.description).not.toContain("[object Object]");
    expect(created.description).toContain("disposition from the wire");
  });

  it("the new cover row records its alertname, so its own successor can find it", async () => {
    const store = buildStore();
    const { ctx } = mintCtx(store, []);
    await runAlertEscalationSweep(ctx, { defaultCompanyId: "company-1", autoCloseOnResolve: true } as AlertmanagerPluginConfig, new Date("2026-11-09T06:00:00Z"));
    const [row] = [...store.covers.values()];
    expect(row!.alertname).toBe(ALERTNAME);
  });
});
