#!/usr/bin/env node

/**
 * Before/after instrument for PEN-5346: a `cancelled` monitor-clear must hand
 * its obligation to a carrier that survives the cancel.
 *
 * `paperclip-plugin-alertmanager` cancels an alert row when its alert resolves
 * and reopens it when the alert re-fires, so an alert row is a RECYCLED row,
 * not a terminal one. Each cancel destroys the assignee's armed monitor
 * (`clearReason: "cancelled"`), and the loss consumes no attempt, so it raises
 * no budget signal. Measured 2026-11-03 across PEN-4365/PEN-4261: 14/14 clears
 * paired with a plugin cancel, 14/14 destroyed before their due time, 1 of 15
 * armed monitors ever fired.
 *
 * `reconcileCancelledIssueMonitorRecoveries` routes both shapes through
 * `performIssueMonitorRecovery` with `create_recovery_issue` FORCED, and stamps
 * `executionState.monitor.recoveryEmittedAt` only after the recovery commits.
 * This script measures the population before that pass runs and verifies the
 * post-condition after, from the same persisted state both times.
 *
 * WHY THIS READS EVERY STATUS IN ONE KEYSET WALK. The backfill population is
 * keyed on `executionState.monitor.clearReason`, which is a property of the
 * MONITOR, not of the row. A flapping alert row carries that state while sitting
 * in `todo` mid-cycle, so a scan restricted to `status=cancelled` undercounts by
 * exactly the rows that are flapping right now. Measured 2026-11-03: the
 * cancelled-only population read 17 at 13:3xZ and 10 at ~18:00Z on the same
 * company with no mutation in between — the difference is rows that flapped back
 * out of `cancelled`, not rows that were handled.
 *
 * Reading every status is necessary but NOT sufficient, and the insufficient
 * version of this scan shipped first. Walking one status at a time still loses a
 * row that moves from a not-yet-walked status into an already-walked one while
 * the walk is in flight — it is seen by neither pass — and the population
 * this file exists to count is defined by rows that change status mid-cycle, so
 * that is the common case here, not a corner. Offset paging compounds it: over
 * the mutable default order a row touched mid-walk is re-ranked across the page
 * boundary and skipped, and `done` alone exceeds one page. Both biases point the
 * same way, toward UNDERCOUNT, and neither leaves a trace in the output.
 *
 * So this walks the immutable id order once, with no status filter, exactly as
 * `walkIssueListPages` (`server/src/routes/issues.ts`) does for the same reason:
 * "offset paging over the mutable activity order re-ranks rows touched mid-walk,
 * which both double-counts and skips them". A status change mid-walk then cannot
 * hide a row, because status is not what is being paged on.
 *
 * WHY THIS IS ONE GET PER ISSUE. The list projection DROPS
 * `executionState.monitor` entirely — a scan of it over list rows reads 0 for
 * every row and looks like a clean population. `monitorNextCheckAt` does read
 * through the projection, which is what makes disjunct B (below) cheap and
 * disjunct A expensive. There is no bulk surface for the monitor state.
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const LIST_PAGE_LIMIT = 1000;
const WALK_MAX_PAGES = 1000;
const CARRIER_ORIGIN_KIND = "stranded_issue_recovery";
// Mirrors `ISSUE_EXECUTION_MONITOR_RECOVERY_DISPOSITIONS` in @paperclipai/shared.
// Duplicated as a literal because this script is a standalone .mjs that runs
// against a deployed API without the workspace build; if the shared value is
// renamed, this is the line that must move with it.
const AUTO_DISCHARGED_DISPOSITION = "auto_discharged_past_horizon";

/**
 * Disjunct A — the destroyed-monitor shape this row exists to fix.
 *
 * Keyed on the monitor's own clear reason rather than the row's status, for the
 * flapping reason in the file docblock.
 */
export function isCancelledClear(issue) {
  return (issue?.executionState?.monitor?.clearReason ?? null) === "cancelled";
}

/**
 * Disjunct B — PEN-3554's invariant violation: a cancelled row that still
 * advertises a live wake. Folded into this measurement on 2026-11-03 because
 * the same pass nulls the column AND emits the same recovery.
 *
 * This selects 0 rows as of 2026-11-03 (287 cancelled rows scanned, confirmed
 * on both the list projection and per-issue GETs). An empty population is the
 * cheapest possible moment to pin an invariant: the assertion is free today and
 * only ever gets more expensive.
 */
export function isLiveMonitorOnCancelledRow(issue) {
  return issue?.status === "cancelled" && Boolean(issue?.monitorNextCheckAt);
}

/**
 * The obligation is discharged only once the carrier exists. `recoveryEmittedAt`
 * is stamped after the recovery commits, so ABSENT and `null` both mean "still
 * owed" — absent is what every row reads before the field ships, and treating it
 * as anything else scores the entire pre-deploy population as already handled.
 */
export function hasRecoveryEmitted(issue) {
  const stamped = issue?.executionState?.monitor?.recoveryEmittedAt;
  return stamped !== undefined && stamped !== null;
}

/**
 * Ally's important finding on #3352: a carrier inherits `assigneeAgentId` from
 * its source, so a source with no agent assignee produces an ownerless `todo` —
 * the same strand this row exists to remove, one layer up.
 *
 * `handoffOwed` requires neither `status='cancelled'` nor an assignee, so a
 * flapping row reopened to `todo` and a cancelled row whose canceller unassigned
 * it both reach the carrier with `assigneeAgentId: null`. This reports the count
 * so the finding is sized against the real population rather than argued from
 * the type signature.
 */
export function isOwnerlessSource(issue) {
  return !issue?.assigneeAgentId;
}

/**
 * A row the horizon wrote off: stamped `recoveryEmittedAt` with NO carrier, on
 * purpose. `hasRecoveryEmitted` cannot tell this apart from a carrier that was
 * meant to exist and does not, so without this predicate every horizon-drained
 * row reads as the one failure that falsifies #3352 — and the backfill is
 * precisely the population the horizon exists to drain, so the instrument would
 * report hundreds of LOST rows and exit non-zero the moment the fix worked.
 *
 * Read off `recoveryDisposition` rather than inferred from "stamped and no
 * carrier", which is the very reading being disambiguated.
 */
export function isAutoDischarged(issue) {
  return issue?.executionState?.monitor?.recoveryDisposition === AUTO_DISCHARGED_DISPOSITION;
}

export function classifyRow(issue) {
  const disjunctA = isCancelledClear(issue);
  const disjunctB = isLiveMonitorOnCancelledRow(issue);
  return {
    identifier: issue?.identifier ?? null,
    status: issue?.status ?? null,
    originKind: issue?.originKind ?? null,
    disjunctA,
    disjunctB,
    inPopulation: disjunctA || disjunctB,
    emitted: hasRecoveryEmitted(issue),
    ownerless: isOwnerlessSource(issue),
    recoveryPolicy: issue?.executionState?.monitor?.recoveryPolicy ?? null,
  };
}

export function summarize(issues) {
  const rows = (issues ?? []).map(classifyRow).filter((row) => row.inPopulation);
  const owed = rows.filter((row) => !row.emitted);
  return {
    scanned: (issues ?? []).length,
    population: rows.length,
    disjunctA: rows.filter((row) => row.disjunctA).length,
    disjunctB: rows.filter((row) => row.disjunctB).length,
    owed: owed.length,
    emitted: rows.filter((row) => row.emitted).length,
    ownerlessOwed: owed.filter((row) => row.ownerless).length,
    rows,
  };
}

/**
 * Carriers grouped by the SOURCE ROW they were emitted for.
 *
 * `originId` identifies the row, NOT the obligation, which is the whole reason
 * the duplicate reading below needs a second key. Exported so `main` can decide
 * which feeds to read using the same grouping the classifier uses, rather than
 * a second copy of it that can drift.
 */
export function carriersBySource(recoveryRows) {
  const bySource = new Map();
  for (const row of recoveryRows ?? []) {
    const list = bySource.get(row.originId) ?? [];
    list.push(row);
    bySource.set(row.originId, list);
  }
  return bySource;
}

/**
 * PEN-5838 — the per-OBLIGATION key, recovered from the source row's own feed.
 *
 * An alert row is recycled, so it incurs a NEW obligation on every flap: two
 * carriers for one `originId` is the normal outcome, and keying the duplicate
 * reading on `originId` alone reported `PEN-4917` — 9 cancelled clears, 2
 * recoveries, 2 carriers — as a fault. Re-flap is the common case in the only
 * corpus this instrument is ever pointed at, so that false positive accrues
 * monotonically and retires the count as a signal.
 *
 * The key is `issue.monitor_recovery_issue_created.details.nextCheckAt`. Mind
 * the name: on THIS action it is `performIssueMonitorRecovery`'s
 * `scheduledAtIso`, which the cancelled-monitor pass calls with
 * `monitorState.clearedAt` — so it holds the CLEAR THIS RECOVERY DISCHARGED,
 * one value per obligation. On the sibling `issue.monitor_cleared_undeliverable`
 * the identically-named field holds the destroyed DUE time instead. The two are
 * not equal and must not be joined on: measured on PEN-4917, the clear logged
 * `nextCheckAt=2026-11-05T06:30:00Z` at `createdAt=01:30:35.317Z` while its
 * recovery keyed `01:30:34.554Z` — the clearedAt, 763 ms before the clear's own
 * activity row landed. Recoveries are therefore keyed against EACH OTHER, never
 * against the clear feed.
 *
 * Re-drives collapse by construction: a crash between emit and stamp re-enters
 * the pass, `findOpenIssueMonitorRecoveryIssue` reuses the carrier, and the
 * second log line repeats the same `clearedAt` — one key, one carrier.
 *
 * Preferred over the carrier's own `- Cleared at:` description line, which is
 * the cheaper-looking discriminator and the wrong one: that body is free text an
 * assignee may rewrite, the list projection clips descriptions at 1200
 * characters, and only the `cancelled` branch of `monitorRecoveryComment` emits
 * the line at all — an `external_service` carrier on the same row has no such
 * field. `originFingerprint` is no better: it is `issue_monitor:<clearReason>`,
 * constant across every flap of the same reason.
 */
export function recoveryObligationKeys(activityEvents) {
  const keys = new Set();
  let events = 0;
  let unkeyed = 0;
  for (const event of activityEvents ?? []) {
    if (event?.action !== "issue.monitor_recovery_issue_created") continue;
    events += 1;
    const key = event?.details?.nextCheckAt ?? null;
    if (key === null) unkeyed += 1;
    else keys.add(key);
  }
  return { events, distinct: keys.size, unkeyed };
}

/**
 * Decides the multi-carrier reading for ONE source row, given its feed.
 *
 * Returns `duplicated` only when the feed can actually carry the claim, because
 * the count exists to catch an emerging double-emit and a flag that also fires
 * on correct behaviour is one people learn to ignore. Three things can make the
 * obligation count unestablished, and all three resolve to `unresolved` rather
 * than to either verdict:
 *
 *  - no feed was read for the row (unreadable, or not requested);
 *  - a recovery event carries no `nextCheckAt`, so it cannot be attributed;
 *  - FEWER events than carriers. Every carrier is created inside the block that
 *    logs the event, but that `logActivity` is deliberately best-effort — the
 *    server swallows its rejection to keep the committed carrier discoverable by
 *    `originId`. So a lost log line is a real, designed-for state, and under it
 *    "two carriers, one event" is indistinguishable from "one obligation emitted
 *    twice". Asserting the latter would reintroduce exactly the false positive
 *    this function exists to remove.
 *
 * With events ≥ carriers and every event keyed, `distinct < carriers` means at
 * least one obligation has more than one carrier. That is established, and only
 * then is it reported.
 */
export function classifyMultiCarrier(carrierCount, feed) {
  if (!feed) {
    return {
      verdict: "unresolved",
      detail: `${carrierCount} carriers, obligations not established (no recovery-event feed read)`,
    };
  }
  const { events, distinct, unkeyed } = recoveryObligationKeys(feed);
  if (unkeyed > 0) {
    return {
      verdict: "unresolved",
      detail:
        `${carrierCount} carriers, obligations not established ` +
        `(${unkeyed} of ${events} recovery events carry no clear key)`,
    };
  }
  if (events < carrierCount) {
    return {
      verdict: "unresolved",
      detail:
        `${carrierCount} carriers but only ${events} recovery events ` +
        `(the creation log is best-effort, so a lost line is not a duplicate)`,
    };
  }
  if (distinct < carrierCount) {
    return {
      verdict: "duplicated",
      detail: `${carrierCount} carriers across ${distinct} distinct obligation${distinct === 1 ? "" : "s"}`,
    };
  }
  return {
    verdict: "ok",
    detail: `${carrierCount} carriers across ${distinct} distinct obligations (recycled row)`,
  };
}

/**
 * The one reading that falsifies the design, named by its author: a row stamped
 * `recoveryEmittedAt` with no recovery row carrying that `originId`. That is the
 * emit-then-stamp ordering having failed, and it is the only way the pass loses
 * an obligation rather than merely duplicating one.
 *
 * A row the HORIZON wrote off is excluded from that reading entirely and
 * reported in its own bucket — see `isAutoDischarged`. It is stamped with no
 * carrier deliberately, so scoring it as lost would make the instrument report
 * the drain it was built to confirm as the failure it was built to catch.
 *
 * The DUAL failure — two carriers for ONE obligation — is a separate reading and
 * is NOT a falsification of the handoff: a duplicate carrier still carries the
 * obligation. It is reported, not thrown, because the wake idempotency key means
 * only one of the two ever gets woken, so the second is a silent `todo`.
 *
 * PEN-5838: "one obligation" is the load-bearing word there, and `originId`
 * cannot establish it — see {@link classifyMultiCarrier}. A multi-carrier row is
 * now split three ways: `duplicated` when the feed establishes fewer obligations
 * than carriers, `unresolved` when it cannot establish the count at all, and
 * silence when each carrier discharges its own clear (a recycled row, which on
 * the alert corpus is the common case). `lost` is unaffected: "stamped with no
 * carrier at all" is well defined under an `originId` key, and it stays the
 * decisive reading and the only one that exits non-zero.
 *
 * @param recoveryEventsBySourceId Map of source issue id → that row's activity
 *   feed. Only multi-carrier rows need an entry; everything else is decided
 *   without a feed, and a missing entry is reported as unestablished rather than
 *   assumed either way.
 */
export function findHandoffFailures(issues, recoveryRows, recoveryEventsBySourceId) {
  const bySource = carriersBySource(recoveryRows);
  const feeds = recoveryEventsBySourceId ?? new Map();

  const lost = [];
  const duplicated = [];
  const unresolved = [];
  const autoDischarged = [];
  for (const issue of issues ?? []) {
    if (!hasRecoveryEmitted(issue)) continue;
    const carriers = bySource.get(issue.id) ?? [];
    if (isAutoDischarged(issue)) {
      // Discharged WITHOUT a carrier by construction, so "no carrier" is the
      // expected shape here and not a loss. Reported in its own bucket, never
      // in `lost`, because `lost` is the exit-1 path.
      //
      // The carrier count is still carried: a horizon discharge that somehow
      // DID produce a carrier is an anomaly worth seeing, and asserting zero
      // here rather than checking it would be assuming the thing under test.
      autoDischarged.push({
        id: issue.id,
        identifier: issue.identifier,
        carriers: carriers.length,
        detail:
          carriers.length === 0
            ? "auto-discharged past horizon, no carrier (by construction)"
            : `auto-discharged past horizon, but ${carriers.length} carrier(s) exist`,
      });
      continue;
    }
    if (carriers.length === 0) {
      lost.push({
        id: issue.id,
        identifier: issue.identifier,
        detail: "stamped recoveryEmittedAt, no carrier",
      });
    } else if (carriers.length > 1) {
      const { verdict, detail } = classifyMultiCarrier(carriers.length, feeds.get(issue.id));
      const finding = { id: issue.id, identifier: issue.identifier, detail };
      if (verdict === "duplicated") duplicated.push(finding);
      else if (verdict === "unresolved") unresolved.push(finding);
    }
  }
  return { lost, duplicated, unresolved, autoDischarged };
}

/**
 * The destroyed due time, read from the clear event that destroyed it.
 *
 * This answers the #3311 sequencing question on PEN-5346 with persisted state
 * rather than with a field that does not exist yet. `clearedNextCheckAt` lifts
 * this value onto the monitor object; it is a convenience, NOT the difference
 * between recoverable and unrecoverable. Measured 2026-11-03 across the
 * disjunct-A population: 11 of 11 `clearReason: "cancelled"` clear events carry
 * `details.nextCheckAt`.
 *
 * Note the sign. On alert rows the due time is in the FUTURE at clear (0.09h to
 * 10.81h early, so the wake was destroyed before it could fire). On the two
 * `stale_active_run_evaluation` rows it is ~27 days in the PAST, because those
 * monitors were already lapsed when the row was cancelled. A carrier that
 * re-armed blindly to a recovered due time would re-arm those two into a time
 * that has already gone, so the due time is context for a human reader, not a
 * value to schedule from.
 */
export function destroyedDueTimes(activityEvents) {
  return (activityEvents ?? [])
    .filter(
      (event) =>
        event?.action === "issue.monitor_cleared_undeliverable" &&
        event?.details?.clearReason === "cancelled",
    )
    .map((event) => ({
      clearedAt: event.createdAt,
      dueAt: event.details?.nextCheckAt ?? null,
      notes: event.details?.notes ?? null,
      attemptCount: event.details?.attemptCount ?? null,
    }));
}

async function request(path) {
  const base = (process.env.PAPERCLIP_API_URL ?? "").replace(/\/$/, "");
  const key = process.env.PAPERCLIP_API_KEY;
  if (!base || !key) throw new Error("PAPERCLIP_API_URL and PAPERCLIP_API_KEY are required");
  const res = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${path}`);
  return { body: await res.json(), truncated: res.headers.get("x-result-truncated") === "true" };
}

async function api(path) {
  return (await request(path)).body;
}

async function apiList(path) {
  const { body, truncated } = await request(path);
  return { rows: Array.isArray(body) ? body : (body.issues ?? []), truncated };
}

/**
 * Keyset cursor step. Pure so the termination rule is testable without a server.
 *
 * A SHORT PAGE alone does not end the walk, and the version that thought it did
 * was unsound for exactly the actor most likely to run this. The route applies
 * its ACL filter AFTER taking the raw window, so for a key without company-scope
 * read a page can come back short while readable rows remain beyond it -- the
 * walk stops early and the undercount leaves no trace, which is the failure this
 * whole file is written against. The route reports that case in
 * `X-Result-Truncated`, so the stop condition is a short page AND no truncation
 * flag. The flag's absence is still never treated as proof of completeness on
 * its own, which is why the short-page test remains.
 *
 * A full page whose last id equals the cursor we sent means `afterId` never
 * reached the query, so the walk would re-serve that page forever; that is an
 * error rather than a silent partial scan. A page that is BOTH empty and
 * truncated is the same class of problem -- more rows exist and nothing can
 * advance past them -- so it throws rather than returning a short count.
 *
 * THAT THROW IS NOT A SERVER BUG, and it is reachable rather than theoretical.
 * For an actor without company-scope read, a window in which every row is
 * unreadable comes back empty while the header correctly reports readable rows
 * further on; there is no cursor to carry, because the ids that would supply one
 * are the rows this actor may not see. The walk refuses instead of undercounting,
 * which is the safe direction, but it does mean this instrument is UNUSABLE for
 * that actor class rather than merely imprecise. Run it with a company-scope key;
 * nothing short of a raw-window cursor from the server fixes the restricted case.
 */
export function nextCursor(rows, pageSize, afterId, truncated = false) {
  if (rows.length < pageSize && !truncated) return { done: true, afterId: null };
  if (rows.length === 0) {
    throw new Error("list reported more rows beyond an empty page, so the walk cannot advance");
  }
  const last = rows[rows.length - 1].id;
  if (last === afterId) {
    throw new Error("keyset cursor did not advance, so afterId is not reaching the list query");
  }
  return { done: false, afterId: last };
}

async function walkList(companyId, extraQuery) {
  const out = [];
  let afterId;
  for (let page = 0; ; page += 1) {
    if (page >= WALK_MAX_PAGES) {
      throw new Error(`exceeded ${WALK_MAX_PAGES} pages, so the walk is not terminating`);
    }
    const cursor = afterId ? `&afterId=${afterId}` : "";
    const { rows, truncated } = await apiList(
      `/api/companies/${companyId}/issues?sortField=id&limit=${LIST_PAGE_LIMIT}${extraQuery}${cursor}`,
    );
    out.push(...rows);
    const step = nextCursor(rows, LIST_PAGE_LIMIT, afterId, truncated);
    if (step.done) return out;
    afterId = step.afterId;
  }
}

/**
 * Resolves per item instead of rejecting the batch. One failed GET out of
 * thousands must not discard a scan that takes tens of minutes, and -- more
 * importantly -- a scan that lost rows must not be reportable as a clean one:
 * failures are counted and the summary says INCOMPLETE, which is a different
 * claim from "population=N".
 */
async function mapSettled(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        try {
          out[index] = { ok: true, value: await fn(items[index]) };
        } catch (error) {
          out[index] = { ok: false, item: items[index], error: String(error) };
        }
      }
    }),
  );
  return out;
}

async function main() {
  // Not defaulted. The before and after reads are only comparable if they cover
  // the same company, and a default silently makes "I ran the same script" look
  // like evidence of that when it is not.
  const companyId = process.env.MEASURE_COMPANY_ID;
  if (!companyId) throw new Error("MEASURE_COMPANY_ID is required");
  const concurrency = Number(process.env.MEASURE_CONCURRENCY || 16);

  const listed = await walkList(companyId, "");
  const ids = [...new Set(listed.map((row) => row.id))];
  console.error(`walked ${ids.length} rows in id order (the list projection drops the monitor)`);

  const settled = await mapSettled(ids, concurrency, (id) => api(`/api/issues/${id}`));
  const issues = settled.filter((row) => row.ok).map((row) => row.value);
  const failures = settled.filter((row) => !row.ok);
  const summary = summarize(issues);

  for (const row of summary.rows) {
    const state = row.emitted ? "EMITTED" : "OWED";
    const owner = row.ownerless ? " OWNERLESS-SOURCE" : "";
    const which = [row.disjunctA ? "A" : null, row.disjunctB ? "B" : null].filter(Boolean).join("+");
    console.log(`${state} [${which}] ${row.identifier} ${row.status} ${row.originKind}${owner}`);
  }

  // Second phase, owed rows only: recover each destroyed due time from the clear
  // event itself. One activity GET per owed row, affordable only because the owed
  // set is small -- deliberately NOT run over the full scan.
  const owedIssues = issues.filter(
    (issue) =>
      (isCancelledClear(issue) || isLiveMonitorOnCancelledRow(issue)) && !hasRecoveryEmitted(issue),
  );
  const feeds = await mapSettled(owedIssues, concurrency, async (issue) => ({
    identifier: issue.identifier,
    clears: destroyedDueTimes(await api(`/api/issues/${issue.id}/activity`)),
  }));

  let clears = 0;
  let withDueTime = 0;
  // Counted, not skipped: a feed we could not read lowers `clears` without
  // lowering the confidence anyone reads off it, which is the same dishonest
  // output as a silently short scan.
  const feedFailures = feeds.filter((feed) => !feed.ok);
  for (const feed of feeds) {
    if (!feed.ok) continue;
    for (const clear of feed.value.clears) {
      clears += 1;
      if (clear.dueAt) withDueTime += 1;
      console.log(
        `DUE ${feed.value.identifier} cleared=${clear.clearedAt} due=${clear.dueAt ?? "MISSING"}`,
      );
    }
  }

  // The post-condition check. Without this the "after" run reports `emitted=N`
  // from the stamp alone, i.e. it trusts the very stamp whose correctness is the
  // thing under test, and a stamp-without-carrier reads as a clean pass.
  const carriers = await walkList(companyId, `&originKind=${CARRIER_ORIGIN_KIND}`);

  // PEN-5838: the multi-carrier reading needs a per-OBLIGATION key, and that key
  // lives in the source row's own activity feed. Read a feed only for rows that
  // actually have more than one carrier -- on the alert corpus that is a handful,
  // and reading every stamped row's feed would cost one GET per row across the
  // whole scan to answer a question all but a few of them cannot even raise.
  const bySource = carriersBySource(carriers);
  const contested = issues.filter(
    (issue) => hasRecoveryEmitted(issue) && (bySource.get(issue.id) ?? []).length > 1,
  );
  const contestedFeeds = await mapSettled(contested, concurrency, async (issue) => ({
    id: issue.id,
    events: await api(`/api/issues/${issue.id}/activity`),
  }));
  // A feed we could not read is simply absent from this map, which
  // `classifyMultiCarrier` reports as unestablished rather than as either verdict
  // -- the same honesty the scan already applies to an unreadable row.
  const recoveryEventsBySourceId = new Map(
    contestedFeeds.filter((row) => row.ok).map((row) => [row.value.id, row.value.events]),
  );
  const contestedFeedFailures = contestedFeeds.filter((row) => !row.ok);
  const { lost, duplicated, unresolved, autoDischarged } = findHandoffFailures(
    issues,
    carriers,
    recoveryEventsBySourceId,
  );

  // `lost` is the decisive reading, so it is re-checked against a targeted query
  // before it is allowed to exit non-zero. A walk artifact must not be reportable
  // as a lost obligation: that is a false falsification of #3352, and it is the
  // most expensive mistake this script can make.
  //
  // RESIDUAL, stated rather than silently carried: the list applies
  // `visibleIssueCondition()`, so a carrier HIDDEN since it was emitted is
  // invisible to both the walk and this re-check, and still reads as LOST. The
  // re-check narrows the window to that one case. It is not closed here because
  // nothing available to this script can see a hidden row -- confirm by hand
  // before acting on a LOST line.
  const confirmedLost = [];
  for (const row of lost) {
    const { rows: direct } = await apiList(
      `/api/companies/${companyId}/issues?originKind=${CARRIER_ORIGIN_KIND}&originId=${row.id}` +
        `&sortField=id&limit=${LIST_PAGE_LIMIT}`,
    );
    if (direct.length === 0) confirmedLost.push(row);
    else console.error(`RECHECK: ${row.identifier} carrier found by targeted query, not by walk`);
  }

  for (const row of confirmedLost) console.error(`LOST: ${row.identifier} ${row.detail}`);
  for (const row of duplicated) console.error(`DUPLICATED: ${row.identifier} ${row.detail}`);
  for (const row of unresolved) console.error(`UNRESOLVED: ${row.identifier} ${row.detail}`);
  // Non-fatal and expected to be empty: a horizon discharge builds no carrier,
  // so one existing means something else emitted against the same source.
  for (const row of autoDischarged.filter((entry) => entry.carriers > 0)) {
    console.error(`ANOMALY: ${row.identifier} ${row.detail}`);
  }

  console.log(
    `\ncompany=${companyId} walked=${ids.length} read=${issues.length} ` +
      `population=${summary.population} (A=${summary.disjunctA} B=${summary.disjunctB}) ` +
      `owed=${summary.owed} emitted=${summary.emitted} ownerless-owed=${summary.ownerlessOwed}`,
  );
  console.log(
    `carriers=${carriers.length} lost=${confirmedLost.length} duplicated=${duplicated.length} ` +
      `unresolved-multi-carrier=${unresolved.length} ` +
      `auto-discharged=${autoDischarged.length} ` +
      `cancelled-clear-events-on-owed=${clears} carrying-due-time=${withDueTime} ` +
      `unreadable-feeds=${feedFailures.length}`,
  );

  if (failures.length > 0 || feedFailures.length > 0 || contestedFeedFailures.length > 0) {
    console.error(
      `\nINCOMPLETE: ${failures.length} of ${ids.length} rows, ` +
        `${feedFailures.length} of ${owedIssues.length} owed-row activity feeds and ` +
        `${contestedFeedFailures.length} of ${contested.length} multi-carrier feeds could not be read.`,
    );
    console.error(
      [...failures, ...feedFailures, ...contestedFeedFailures]
        .slice(0, 5)
        .map((row) => `  ${row.item?.identifier ?? row.item}: ${row.error}`)
        .join("\n"),
    );
    process.exit(1);
  }
  // A lost obligation is the one reading that falsifies #3352's design.
  if (confirmedLost.length > 0) process.exit(1);
}

export function isMainModule(argvPath = process.argv[1], moduleUrl = import.meta.url) {
  return Boolean(argvPath) && resolve(argvPath) === fileURLToPath(moduleUrl);
}

if (isMainModule()) await main();
