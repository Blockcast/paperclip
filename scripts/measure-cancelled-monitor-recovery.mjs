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
 * WHY THIS READS EVERY STATUS, NOT JUST `cancelled`. The backfill population is
 * keyed on `executionState.monitor.clearReason`, which is a property of the
 * MONITOR, not of the row. A flapping alert row carries that state while sitting
 * in `todo` mid-cycle, so a scan restricted to `status=cancelled` undercounts by
 * exactly the rows that are flapping right now. Measured 2026-11-03: the
 * cancelled-only population read 17 at 13:3xZ and 10 at ~18:00Z on the same
 * company with no mutation in between — the difference is rows that flapped back
 * out of `cancelled`, not rows that were handled.
 *
 * WHY THIS IS ONE GET PER ISSUE. The list projection DROPS
 * `executionState.monitor` entirely — a scan of it over list rows reads 0 for
 * every row and looks like a clean population. `monitorNextCheckAt` does read
 * through the projection, which is what makes disjunct B (below) cheap and
 * disjunct A expensive. There is no bulk surface for the monitor state.
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_COMPANY = "b1d3f3d3-adc9-48af-beb1-013a18368d84";
const LIST_PAGE_LIMIT = 1000;
const STATUSES = ["backlog", "todo", "in_progress", "in_review", "done", "blocked", "cancelled"];

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
 * Pages by the APPLIED limit and stops on a short page. A bare array exactly as
 * long as the limit is NOT proof of completeness on a server predating the
 * truncation envelope, so the stop condition is the short page, never the
 * absence of a `truncated` flag.
 */
async function listByStatus(companyId, status) {
  const out = [];
  for (let offset = 0; ; offset += LIST_PAGE_LIMIT) {
    const res = await api(
      `/api/companies/${companyId}/issues?status=${status}&limit=${LIST_PAGE_LIMIT}&offset=${offset}`,
    );
    const batch = Array.isArray(res) ? res : (res.issues ?? []);
    out.push(...batch);
    if (batch.length < LIST_PAGE_LIMIT) return out;
  }
}

async function mapWithConcurrency(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        out[index] = await fn(items[index]);
      }
    }),
  );
  return out;
}

async function main() {
  const companyId = process.env.MEASURE_COMPANY_ID || DEFAULT_COMPANY;
  const concurrency = Number(process.env.MEASURE_CONCURRENCY || 16);

  const seen = new Map();
  for (const status of STATUSES) {
    for (const row of await listByStatus(companyId, status)) seen.set(row.id, row);
  }
  const ids = [...seen.keys()];
  console.error(`scanning ${ids.length} rows (one GET each; the list projection drops the monitor)`);

  const issues = await mapWithConcurrency(ids, concurrency, (id) => api(`/api/issues/${id}`));
  const summary = summarize(issues);

  for (const row of summary.rows) {
    const state = row.emitted ? "EMITTED" : "OWED";
    const owner = row.ownerless ? " OWNERLESS-SOURCE" : "";
    const which = [row.disjunctA ? "A" : null, row.disjunctB ? "B" : null].filter(Boolean).join("+");
    console.log(`${state} [${which}] ${row.identifier} ${row.status} ${row.originKind}${owner}`);
  }

  // Second phase, owed rows only: recover each destroyed due time from the clear
  // event itself. This is one activity GET per owed row, which is affordable
  // only because the owed set is small (21 as of 2026-11-03) -- it is
  // deliberately NOT run over the full scan.
  const owedIssues = issues.filter(
    (issue) => (isCancelledClear(issue) || isLiveMonitorOnCancelledRow(issue)) && !hasRecoveryEmitted(issue),
  );
  const feeds = await mapWithConcurrency(owedIssues, concurrency, async (issue) => ({
    identifier: issue.identifier,
    clears: destroyedDueTimes(await api(`/api/issues/${issue.id}/activity`)),
  }));

  let clears = 0;
  let withDueTime = 0;
  for (const feed of feeds) {
    for (const clear of feed.clears) {
      clears += 1;
      if (clear.dueAt) withDueTime += 1;
      console.log(`DUE ${feed.identifier} cleared=${clear.clearedAt} due=${clear.dueAt ?? "MISSING"}`);
    }
  }

  console.log(
    `\nscanned=${summary.scanned} population=${summary.population} ` +
      `(A=${summary.disjunctA} B=${summary.disjunctB}) owed=${summary.owed} ` +
      `emitted=${summary.emitted} ownerless-owed=${summary.ownerlessOwed}`,
  );
  console.log(
    `cancelled-clear events on owed rows=${clears} carrying the destroyed due time=${withDueTime}`,
  );
}

export function isMainModule(argvPath = process.argv[1], moduleUrl = import.meta.url) {
  return Boolean(argvPath) && resolve(argvPath) === fileURLToPath(moduleUrl);
}

if (isMainModule()) await main();
