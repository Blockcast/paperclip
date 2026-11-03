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
 * The one reading that falsifies the design, named by its author: a row stamped
 * `recoveryEmittedAt` with no recovery row carrying that `originId`. That is the
 * emit-then-stamp ordering having failed, and it is the only way the pass loses
 * an obligation rather than merely duplicating one.
 *
 * The DUAL failure — two carriers for one obligation — is a separate reading and
 * is NOT a falsification of the handoff: a duplicate carrier still carries the
 * obligation. It is reported, not thrown, because the wake idempotency key means
 * only one of the two ever gets woken, so the second is a silent `todo`.
 */
export function findHandoffFailures(issues, recoveryRows) {
  const byOrigin = new Map();
  for (const row of recoveryRows ?? []) {
    const list = byOrigin.get(row.originId) ?? [];
    list.push(row);
    byOrigin.set(row.originId, list);
  }

  const lost = [];
  const duplicated = [];
  for (const issue of issues ?? []) {
    if (!hasRecoveryEmitted(issue)) continue;
    const carriers = byOrigin.get(issue.id) ?? [];
    if (carriers.length === 0) {
      lost.push({ identifier: issue.identifier, detail: "stamped recoveryEmittedAt, no carrier" });
    } else if (carriers.length > 1) {
      duplicated.push({
        identifier: issue.identifier,
        detail: `${carriers.length} carriers for one obligation`,
      });
    }
  }
  return { lost, duplicated };
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

async function api(path) {
  const base = (process.env.PAPERCLIP_API_URL ?? "").replace(/\/$/, "");
  const key = process.env.PAPERCLIP_API_KEY;
  if (!base || !key) throw new Error("PAPERCLIP_API_URL and PAPERCLIP_API_KEY are required");
  const res = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${path}`);
  return res.json();
}

/**
 * Keyset cursor step. Pure so the termination rule is testable without a server.
 *
 * Stops on a SHORT PAGE, never on the absence of a `truncated` flag: a bare array
 * exactly as long as the limit is not proof of completeness on a server predating
 * the truncation envelope. A full page whose last id equals the cursor we sent
 * means `afterId` never reached the query, so the walk would re-serve that page
 * forever; that is an error rather than a silent partial scan.
 */
export function nextCursor(rows, pageSize, afterId) {
  if (rows.length < pageSize) return { done: true, afterId: null };
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
    const res = await api(
      `/api/companies/${companyId}/issues?sortField=id&limit=${LIST_PAGE_LIMIT}${extraQuery}${cursor}`,
    );
    const rows = Array.isArray(res) ? res : (res.issues ?? []);
    out.push(...rows);
    const step = nextCursor(rows, LIST_PAGE_LIMIT, afterId);
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
  const { lost, duplicated } = findHandoffFailures(issues, carriers);
  for (const row of lost) console.error(`LOST: ${row.identifier} ${row.detail}`);
  for (const row of duplicated) console.error(`DUPLICATED: ${row.identifier} ${row.detail}`);

  console.log(
    `\ncompany=${companyId} walked=${ids.length} read=${issues.length} ` +
      `population=${summary.population} (A=${summary.disjunctA} B=${summary.disjunctB}) ` +
      `owed=${summary.owed} emitted=${summary.emitted} ownerless-owed=${summary.ownerlessOwed}`,
  );
  console.log(
    `carriers=${carriers.length} lost=${lost.length} duplicated=${duplicated.length} ` +
      `cancelled-clear-events-on-owed=${clears} carrying-due-time=${withDueTime} ` +
      `unreadable-feeds=${feedFailures.length}`,
  );

  if (failures.length > 0 || feedFailures.length > 0) {
    console.error(
      `\nINCOMPLETE: ${failures.length} of ${ids.length} rows and ` +
        `${feedFailures.length} of ${owedIssues.length} activity feeds could not be read.`,
    );
    console.error(
      [...failures, ...feedFailures]
        .slice(0, 5)
        .map((row) => `  ${row.item?.identifier ?? row.item}: ${row.error}`)
        .join("\n"),
    );
    process.exit(1);
  }
  // A lost obligation is the one reading that falsifies #3352's design.
  if (lost.length > 0) process.exit(1);
}

export function isMainModule(argvPath = process.argv[1], moduleUrl = import.meta.url) {
  return Boolean(argvPath) && resolve(argvPath) === fileURLToPath(moduleUrl);
}

if (isMainModule()) await main();
