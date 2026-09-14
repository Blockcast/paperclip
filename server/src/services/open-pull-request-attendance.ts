import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueWorkProducts } from "@paperclipai/db";
import {
  OPEN_PULL_REQUEST_WORK_PRODUCT_STATUSES,
  PULL_REQUEST_WORK_PRODUCT_METADATA_SOURCE,
  PULL_REQUEST_WORK_PRODUCT_SOURCE_TRUST_ACTOR_ID,
} from "./pull-request-work-products.js";

/**
 * Whether an open GitHub PR recorded against an issue still constitutes an automatic
 * path back to life.
 *
 * PEN-2791. Before this, the strandedness sweep counted five attendance paths -- a live
 * run, a deferred execution wake, a pending wake interaction, an active monitor, and an
 * unresolved blocker -- and **none of them was an external event wake**. That omission
 * was not neutral: it put the convergence guard and the strandedness predicate in direct
 * contradiction. The guard's whole job, on a gate it cannot move, is to stop re-arming
 * and clear `monitorNextCheckAt` (`clearReason: trigger_stalled`); for an issue with no
 * blockers that column WAS the only durable path, so the guard firing correctly is
 * precisely what made the row eligible for seizure. An assignee reasoning correctly
 * about when not to poll was the assignee most likely to lose its issue.
 *
 * Reported on PEN-2370 (2026-09-01): a `stranded_assigned_issue` action moved a
 * `critical` security row from `in_progress` to `blocked` and unassigned its owner, with
 * an evidence block naming no fault at all -- `latestRunStatus: succeeded`,
 * `latestRunErrorCode: null`, `infraClassCause: false` -- i.e. it fired on the ABSENCE of
 * a counted path rather than on anything going wrong. The owner heartbeated ~2.5 minutes
 * later. At that instant the row carried two `ready_for_review` PR work products
 * (`Blockcast/paperclip#1583`, `#1581`), written by the same webhook that had already
 * woken that owner from those PRs earlier the same day, and its monitor was cleared
 * (`monitorNextCheckAt: null`, `monitorAttemptCount: 8`). The evidence of attendance was
 * on the row, in an indexed table, and nothing read it.
 *
 * ## Why this is a shared module rather than a private helper (PEN-2853 Finding 1)
 *
 * This predicate has a second caller: the write-side `in_review` disposition validator in
 * `routes/issues.ts`. PEN-2853's whole complaint is that two independently-written
 * predicates drifted about the same path -- so a copy in the validator would have
 * reproduced that divergence on a third predicate. This is the same remedy PEN-2853
 * Finding 2 applied to the monitor: **delegate rather than restate.** A restated rule is
 * only ever as good as the test that notices it drifting; one definition makes the drift
 * unrepresentable.
 *
 * The invariant both callers exist to preserve:
 *
 * > **Everything the validator admits, the sweep counts.**
 *
 * That asymmetry is safe in one direction only. The sweep may be *more* lenient than the
 * validator (its bounded lapsed-trigger window already is), never less. If the validator
 * admitted a PR the sweep discounts, the row would pass the write-side gate and be
 * simultaneously seizable by the read-side sweep -- which is PEN-2853 Finding 2's defect
 * verbatim, merely relocated to a new column.
 *
 * Not placed in `pull-request-work-products.ts` despite owning the constants this reads:
 * that module documents itself as free of DB and network access so the webhook mapping
 * stays unit-testable without Postgres, and a query there would silently retract that
 * promise.
 *
 * ## The two filters, both load-bearing rather than defensive
 *
 * - **Status.** Only `draft`/`ready_for_review` count. A merged or closed PR emits no
 *   further webhook, so a terminal row is not evidence of attendance.
 * - **Provenance.** Scoped to webhook-written rows by metadata source and system
 *   source-trust, mirroring the reverse lookup in `routes/github-webhook.ts`. Only a row
 *   the webhook itself wrote is evidence that the webhook will fire again. A hand-created
 *   PR work product (which the partial unique index explicitly allows) says someone typed
 *   a URL, which predicts no wake at all.
 *
 * Bounded on `updatedAt` because an open PR proves a wake arrives when the PR next
 * MOVES, not that one arrives on a schedule. Unbounded, this would hold an abandoned
 * PR's issue attended forever -- PEN-2791's own failure entered from the other side. See
 * `openPullRequestAttendanceGraceMs` for why the bound is days rather than the monitor's
 * hours, and why it must exist.
 *
 * `nowMs` is injectable so both callers can be tested against the same instant; the
 * agreement test in `issue-execution-policy-routes.test.ts` relies on it to compare the
 * two callers' verdicts about one PR without racing the clock between them.
 */
/**
 * The row-qualifying conditions on their own, without the per-issue scoping.
 *
 * Exported because a third consumer is already in flight: PR #1834 (PEN-3198) extends the
 * same ruling to the issue-graph liveness classifier, which needs these conditions to
 * SELECT a whole attendance set in one pass rather than to ask about one issue. It
 * currently defines an identically-named local function inside `recovery/service.ts`,
 * which routes cannot import. Naming matches so the convergence is an import, not a
 * judgement call — and so this row does not end up having created a second "single
 * definition" of the very predicate it was filed about.
 */
export function openPullRequestWakePathConditions(freshSinceIso: string) {
  return [
    eq(issueWorkProducts.provider, "github"),
    eq(issueWorkProducts.type, "pull_request"),
    inArray(issueWorkProducts.status, [...OPEN_PULL_REQUEST_WORK_PRODUCT_STATUSES]),
    sql`${issueWorkProducts.metadata}->>'source' = ${PULL_REQUEST_WORK_PRODUCT_METADATA_SOURCE}`,
    sql`${issueWorkProducts.sourceTrust}->>'promotedByActorType' = 'system'`,
    sql`${issueWorkProducts.sourceTrust}->>'promotedByActorId' = ${PULL_REQUEST_WORK_PRODUCT_SOURCE_TRUST_ACTOR_ID}`,
    // Bound as an ISO string with an explicit cast: postgres.js cannot serialize a Date
    // interpolated into a raw `sql` fragment and throws ERR_INVALID_ARG_TYPE at bind
    // time. Same hazard as `hasPositiveRunEvidence` and the work-product upsert, both of
    // which were bitten by it.
    sql`${issueWorkProducts.updatedAt} > ${freshSinceIso}::timestamptz`,
  ];
}

export async function hasOpenPullRequestWakePath(
  db: Db,
  issue: { id: string; companyId: string },
  graceMs: number,
  nowMs: number = Date.now(),
): Promise<boolean> {
  const freshSinceIso = new Date(nowMs - graceMs).toISOString();
  const rows = await db
    .select({ id: issueWorkProducts.id })
    .from(issueWorkProducts)
    .where(
      and(
        eq(issueWorkProducts.companyId, issue.companyId),
        eq(issueWorkProducts.issueId, issue.id),
        ...openPullRequestWakePathConditions(freshSinceIso),
      ),
    )
    .limit(1);
  return Boolean(rows[0]);
}
