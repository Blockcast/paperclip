/**
 * BLO-40673 — a resolve delivery that fails AFTER its cancel has landed must
 * not let the retry re-label that cancel as an operator close.
 *
 * The window is structural, not a race between two tenants:
 * `recordSourceResolvedAndCloseCovers` is deliberately placed ahead of the
 * commit-point `ctx.state.set` (see the comment at its call site), so a cover
 * cascade failure aborts the delivery with the issue already `cancelled` and
 * nothing recorded. Alertmanager retries; the retry's terminal guard skips the
 * update because the row is already `cancelled`, so `pluginCancelLanded` stays
 * false and the commit-point spread preserves the `null` the last FIRING write
 * planted — while writing `resolvedAt`. `closedByPlugin` then reads
 * `(cancelled, resolvedAt truthy, pluginClosedAt null)` as an operator close and
 * mutes the next re-fire for the whole BLO-24234 window.
 *
 * That tuple is also what a genuine operator close looks like by the time
 * anyone reads it, which is why the fix records authorship when the cancel
 * lands rather than trying to reconstruct it afterwards — and why the operator
 * case below is asserted as a control rather than assumed.
 *
 * Measured 2026-10-06: nine fingerprints active 10h+ with no open row, two of
 * them `critical`/`page`. Worker log "still suppressed by operator close of
 * issue <id>" against closes `issue.updated` attributes to `actorType: plugin`.
 */

import { describe, expect, it, vi } from "vitest";
import { decideRefire, handleResolved } from "../webhook-handler.js";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type {
  AlertStateRecord,
  AlertmanagerAlert,
  AlertmanagerPluginConfig,
} from "../types.js";

const RESOLVED_AT = "2026-10-05T23:11:53Z";
const NOW = Date.parse("2026-10-06T09:23:00Z");

const config = (): AlertmanagerPluginConfig => ({
  defaultCompanyId: "company-1",
  autoCloseOnResolve: true,
});

const resolvedAlert = (): AlertmanagerAlert => ({
  status: "resolved",
  labels: { alertname: "GatewayHelmReconcileFailing", severity: "warning" },
  annotations: {},
  startsAt: "2026-10-05T22:00:00Z",
  endsAt: RESOLVED_AT,
  fingerprint: "82b874db6f567e9b",
});

/**
 * State exactly as a firing delivery leaves it: `resolvedAt` cleared and
 * `pluginClosedAt` null, both written in the same record literal.
 */
const afterFiring = (): AlertStateRecord =>
  ({
    paperclipIssueId: "issue-1",
    paperclipCompanyId: "company-1",
    assigneeUserId: null,
    assigneeAgentId: "platform-sre",
    alertname: "GatewayHelmReconcileFailing",
    severity: "warning",
    firstSeenAt: "2026-10-05T18:00:00Z",
    lastFiredAt: "2026-10-05T23:06:00Z",
    resolvedAt: null,
    pluginClosedAt: null,
    nextEscalationAt: null,
    escalationAttempt: 0,
  }) as AlertStateRecord;

function store(initial: AlertStateRecord, failFirstSet = false) {
  let stored = initial;
  let sets = 0;
  return {
    get: vi.fn(async () => stored),
    set: vi.fn(async (_ref: unknown, value: AlertStateRecord) => {
      // The stamp is the first `set` of a delivery; the commit point is the
      // second. Failing only the first is how the swallow gets exercised
      // without also breaking the authoritative write.
      if (failFirstSet && ++sets === 1) throw new Error("state write failed");
      stored = value;
    }),
    read: () => stored,
  };
}

/**
 * `issueStatus` drives the terminal guard: "todo" is the first attempt (our
 * cancel lands), "cancelled" is the retry and the operator-close control.
 * `failAfterCancel` aborts the delivery at the first db call made once the
 * cancel has landed — the cover cascade's position, without reproducing its
 * internals.
 *
 * `aggregate` switches the fixture from the legacy `no-membership` branch to
 * `last-member-resolved`: this fingerprint has a real member row pointing at
 * the shared issue and is the last unresolved one, so the delivery claims the
 * finalization fence and runs `beginAggregateCancellation` /
 * `releaseAggregateFinalization`. The two branches reach the same stamp by
 * different routes, and only this one carries a real `cancellationToken`.
 */
function ctxFor(
  state: ReturnType<typeof store>,
  issueStatus: string,
  failAfterCancel = false,
  aggregate = false,
) {
  let cancelled = false;
  return {
    state,
    issues: {
      get: vi.fn(async () => ({ id: "issue-1", status: issueStatus })),
      update: vi.fn(async () => {
        cancelled = true;
        return {};
      }),
      createComment: vi.fn(async () => ({})),
      listComments: vi.fn(async () => []),
    },
    db: {
      namespace: "alertmanager",
      execute: vi.fn(async (sql: string) => {
        // The fence statements are exempt from the failure hook. The release
        // runs in `handleResolved`'s `finally`, i.e. AFTER the cover cascade
        // has thrown — failing it too would replace the error under test with
        // one from the cleanup path. The fence is not the cascade.
        if (sql.includes("lifecycle_fences")) return { rowCount: aggregate ? 1 : 0 };
        if (failAfterCancel && cancelled) throw new Error("cover cascade failed");
        return { rowCount: 0 };
      }),
      query: vi.fn(async (sql: string) => {
        // The member lookup in `resolveAggregateMember`. Returning a row is
        // what moves the delivery off `no-membership`; the sibling probe
        // (`SELECT 1 AS one`) stays empty, so this member is the last one.
        if (aggregate && sql.includes("SELECT issue_id")) return [{ issue_id: "issue-1" }];
        return [];
      }),
    },
    events: { emit: vi.fn() },
    metrics: { write: vi.fn() },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as PluginContext;
}

describe("BLO-40673 close authorship survives a post-cancel delivery failure", () => {
  it("stamps pluginClosedAt even when the delivery aborts after the cancel lands", async () => {
    const s = store(afterFiring());

    await expect(
      handleResolved(ctxFor(s, "todo", true), config(), resolvedAlert()),
    ).rejects.toThrow();

    // The delivery failed, so the commit-point write never ran — but the cancel
    // DID land, and that fact is recorded. Without the stamp this is null and
    // the retry below has no way to recover it.
    expect(s.read().pluginClosedAt).toBe(RESOLVED_AT);
  });

  it("re-opens on the next re-fire after that failed delivery is retried", async () => {
    const s = store(afterFiring());
    await expect(
      handleResolved(ctxFor(s, "todo", true), config(), resolvedAlert()),
    ).rejects.toThrow();

    // Alertmanager retries. The row is already `cancelled`, so the terminal
    // guard skips the update and the commit-point spread preserves whatever is
    // recorded — which is now the stamp, not the firing path's null.
    await handleResolved(ctxFor(s, "cancelled"), config(), resolvedAlert());

    expect(s.read().resolvedAt).toBe(RESOLVED_AT);
    expect(
      decideRefire({ status: "cancelled" }, s.read(), config(), NOW),
    ).toEqual({ kind: "reopen", reason: "plugin_resolved" });
  });

  it("the stamp does not mark a legacy record aggregate-tracked", async () => {
    // The stamp records authorship and nothing else. Persisting the computed
    // aggregate key here would make the next delivery treat this legacy
    // per-fingerprint record as aggregate-tracked with no member row, and the
    // fail-closed path would refuse to cancel it — e.g. after an operator
    // re-opens the row before Alertmanager retries the failed delivery.
    const s = store(afterFiring());
    await expect(
      handleResolved(ctxFor(s, "todo", true), config(), resolvedAlert()),
    ).rejects.toThrow();
    expect(s.read().aggregateKey).toBeUndefined();
    // Pins the case to "narrow stamp", not "no stamp": the assertion above
    // also holds if the stamp is deleted outright.
    expect(s.read().pluginClosedAt).toBe(RESOLVED_AT);

    const retry = ctxFor(s, "todo");
    await handleResolved(retry, config(), resolvedAlert());
    expect(retry.issues.update).toHaveBeenCalledWith(
      "issue-1",
      expect.objectContaining({ status: "cancelled" }),
      "company-1",
    );
  });

  it("stamps on the aggregate branch too, and preserves the stored key", async () => {
    // The other cases all resolve to `no-membership` on the legacy branch.
    // This one is `last-member-resolved`: it holds a real `cancellationToken`
    // and runs `beginAggregateCancellation` before the cancel and
    // `releaseAggregateFinalization` in the `finally`. Same stamp, different
    // route in — and the only route where a stored `aggregateKey` exists to be
    // dropped, which is the half of the fix the narrow stamp must NOT break.
    const s = store({ ...afterFiring(), aggregateKey: "agg-1" } as AlertStateRecord);

    const first = ctxFor(s, "todo", true, true);
    await expect(handleResolved(first, config(), resolvedAlert())).rejects.toThrow(
      "cover cascade failed",
    );

    // Pin the branch, don't assume it. Without this the case passes just as
    // happily on `no-membership` — the legacy route the other four already
    // take — and would silently stop covering anything. `phase = 'cancelling'`
    // is written only by `beginAggregateCancellation`, which only the
    // `last-member-resolved` branch reaches.
    const fenceSql = vi.mocked(first.db.execute).mock.calls.map(([sql]) => sql);
    expect(fenceSql.some((sql) => sql.includes("'cancelling'"))).toBe(true);
    expect(fenceSql.some((sql) => sql.includes("'finalizing'"))).toBe(true);

    expect(s.read().pluginClosedAt).toBe(RESOLVED_AT);
    // Preserve what is stored, invent nothing: the spread must carry a real
    // member-backed key through, where the legacy case above has none to carry.
    expect(s.read().aggregateKey).toBe("agg-1");

    // And the retry still re-opens, exactly as on the legacy branch.
    await handleResolved(ctxFor(s, "cancelled", false, true), config(), resolvedAlert());
    expect(
      decideRefire({ status: "cancelled" }, s.read(), config(), NOW),
    ).toEqual({ kind: "reopen", reason: "plugin_resolved" });
  });

  it("a failed stamp is swallowed but counted", async () => {
    // The swallow is deliberate — failing the delivery over a best-effort
    // stamp trades a mute for a retry loop. But a stamp failing
    // *systematically* degrades straight back to the muting this fix removes,
    // and the swallow is what makes that invisible. The counter is the only
    // thing that makes it detectable, so it is asserted, not assumed.
    const s = store(afterFiring(), true);
    const ctx = ctxFor(s, "todo");

    await expect(handleResolved(ctx, config(), resolvedAlert())).resolves.toBeUndefined();

    expect(ctx.metrics.write).toHaveBeenCalledWith(
      "alertmanager.resolved.stamp_failed",
      1,
      { alertname: "GatewayHelmReconcileFailing", severity: "warning" },
    );
    // The commit point is still authoritative: it ran, and it recorded the
    // same authorship the stamp failed to.
    expect(s.read().pluginClosedAt).toBe(RESOLVED_AT);
  });

  it("CONTROL: an operator close is still suppressed — the stamp never fires", async () => {
    // The tuple this fix turns on is identical to a hand-cancel whose alert
    // later cleared, so BLO-24234's suppression has to be re-asserted here or
    // the fix is indistinguishable from deleting it. No cancel of ours lands
    // (the row is already terminal when we look), so nothing is stamped.
    const s = store(afterFiring());

    await handleResolved(ctxFor(s, "cancelled"), config(), resolvedAlert());

    expect(s.read().pluginClosedAt).toBeNull();
    expect(
      decideRefire({ status: "cancelled" }, s.read(), config(), NOW),
    ).toMatchObject({ kind: "suppressed" });
  });
});
