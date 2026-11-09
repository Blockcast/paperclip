import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, approvals } from "@paperclipai/db";
import type { ApprovalGateKind } from "@paperclipai/shared";
import {
  setApprovalQueueMetricsRefreshSuccess,
  setApprovalQueuePendingMetrics,
} from "./metrics.js";

/**
 * Statuses that count as the BOARD having served the queue (BLO-29850).
 *
 * `withdrawn` and `cancelled` are deliberately excluded, and that exclusion is
 * the whole discriminator this gauge family exists to provide. Both are
 * requester-side actions -- an agent retiring its own moot card -- so a burst
 * of them drains the pending count without the board having decided anything.
 * The issue measured exactly that: the 8 most recent transitions before filing
 * were all `withdrawn`, which a depth-only metric scores as progress. Because
 * the last-decision timestamp below ignores them, a withdrawal-driven drain
 * leaves the staleness alert firing, which is the correct reading.
 *
 * That reasoning is exactly right for `withdrawn` and it OVER-REACHED on
 * `cancelled` (PEN-5885). `cancelled` is not one event: the approval-gate
 * reconciler writes it both when the gated pull request MERGED -- the board
 * acting on the ask, through GitHub instead of through the card -- and when the
 * pull request was closed unmerged and the ask simply died. Only the second is
 * requester-side cleanup. {@link MERGE_GATE_DECISION} below admits the first
 * and keeps the second out; `withdrawn` stays excluded in full.
 */
const BOARD_DECISION_STATUSES = ["approved", "rejected", "revision_requested"] as const;

/**
 * The gate kind whose satisfaction is somebody serving the ask (PEN-5885).
 *
 * Typed against `ApprovalGateKind` rather than written as a bare string so that
 * renaming the kind breaks this file at compile time instead of silently
 * matching nothing -- a predicate that quietly stops matching restores the exact
 * under-reporting this constant exists to remove, and nothing would report it.
 */
const MERGE_GATE_KIND: ApprovalGateKind = "github_pr_merged";

/**
 * The board serving an ask by MERGING the pull request it asked about (PEN-5885).
 *
 * A `payload.gate` card says "I need a human to merge this PR"; when that
 * happens the reconciler closes the card `cancelled` with no `decided_by_user_id`,
 * because no one touched the card UI. Reading that as requester-side cleanup --
 * which {@link BOARD_DECISION_STATUSES} did, by excluding the whole status --
 * made the service invisible: 20 asks were served this way inside one 72h window
 * that the gauge reported as a dead channel, and 7 more inside a disjoint 60h
 * window in which the decide verb was not used once. The alert that fired on
 * that reading accused a board that was working the entire time.
 *
 * And it was getting worse, not drifting: `payload.gate` is the pattern that
 * stops a satisfied card sitting pending forever, so the fleet is being told to
 * adopt it -- and every adoption moved one more ask out of the population that
 * could advance this gauge. Alert health and correct agent behaviour were
 * anti-correlated, which is why this is fixed at the platform rather than in
 * guidance.
 *
 * ⛔ THE KIND FILTER IS LOAD-BEARING AND IS NOT A REFINEMENT. `gate_satisfied`
 * is true for BOTH live gate kinds, and for `github_actions_run` it means only
 * "the run this card named ended green" -- `approval-gate-reconciler.ts` says so
 * on `SUCCESS_CONCLUSION` itself ("a property of the RUN, never of the card's
 * ask"), and PEN-5103 exists to stop downstream code reading it as the ask being
 * met. Admitting that kind here would let a green CI run that no human touched
 * push this gauge to now, which silences `PaperclipApprovalQueueNotServicing`
 * for a full window while the board is idle -- the same false recovery the
 * `withdrawn` exclusion was written to prevent, re-entering through the gate
 * door. The base rate does not soften it: this is a LAST-timestamp gauge, not a
 * counter, so one wrongly admitted row is a full window of silence regardless of
 * how rare it is. Measured on company b1d3f3d3 at 2026-11-07T14:10Z, the 35
 * cancellations split 29 satisfied `github_pr_merged` / 2 satisfied + 4 died
 * `github_actions_run`, the most recent satisfied run 8 days old -- live, not
 * legacy.
 *
 * ⚠️ What a merged gate establishes is that SOMEONE merged the pull request the
 * card asked about, which serves the ask. It does not by itself establish that a
 * human did: this repo requires no review and lands through a merge queue, so an
 * agent or an auto-merge could in principle be the merger. Dated state, not an
 * invariant: at 2026-11-07 the 8 most recent gate-satisfied pull requests across
 * all three repos were merged by the same human account, because agent seats are
 * barred from enqueuing agent-authored pull requests. If that bar lifts, this
 * predicate stops implying a human and wants re-measuring -- it will not
 * self-correct, and nothing here will report the change. Admitting it anyway is
 * still right, because unlike a green run a merge does discharge the ask.
 *
 * `gate_satisfied IS TRUE`, never `IS NOT FALSE`: the three-valued column reads
 * null on every row no gate adjudicated, and null here must behave as "not a
 * board decision". The gate-DIED-unsatisfied half (`false`) stays excluded on
 * purpose -- the PR was closed unmerged, nobody served anything, and admitting
 * it would let an abandoned branch read as recovery in exactly the way a
 * withdrawal burst must not.
 */
const MERGE_GATE_DECISION = sql`${approvals.status} = 'cancelled' and ${approvals.gateSatisfied} is true and ${approvals.payload}->'gate'->>'kind' = ${MERGE_GATE_KIND}`;

/**
 * Whether a pending card can retire itself, as a gauge label (PEN-5885/PEN-5719).
 *
 * The pending population is two channels with different owners wearing one
 * label. A card carrying `payload.gate` retires when its pull request merges; a
 * card without one can leave only by an `approved`/`rejected`/`revision_requested`
 * verb that no agent can use. Measured over this control plane's entire history
 * (80 days, 982 retired cards): NO card carrying a gate has ever stayed pending
 * beyond 2.35 days, while 80 ungated cards passed 7 days and the oldest reached
 * 65.4. The ungated half is the whole tail, and the alerts fire on the tail.
 *
 * `type` cannot separate them -- every card in the measured backlog was
 * `request_board_approval` -- so `{gated="false"}` is the first expression that
 * states board-owned depth without a `payload` query. Four seats re-derived that
 * split by hand on four separate days because nothing exported it; this is the
 * one field the aggregate already has to read.
 *
 * Keyed on gate PRESENCE, not on gate validity. A card advertising a gate kind
 * the reconciler does not handle is still `gated="true"` here, which is the
 * honest reading: the label reports what the card claims about itself. A gate
 * that is never reconciled is a different defect, and `listCandidateApprovals`
 * derives its predicate from `APPROVAL_GATE_KINDS` precisely so it cannot occur.
 */
const IS_GATED = sql<boolean>`${approvals.payload}->'gate'->>'kind' is not null`;

/**
 * The one board decision whose ROW cannot be trusted to remember it.
 *
 * `approved` and `rejected` are terminal, so their `decided_at` is permanent. A
 * `revision_requested` card is not: the requester is expected to clean it up,
 * and both exits erase the board's timestamp from the row. `resubmit` nulls
 * `decided_at` and puts the card back to `pending`; `withdraw` moves it to
 * `withdrawn` (excluded above), and when the board left no note it also
 * overwrites `decided_at` with the withdrawal time. "Board sends a batch back,
 * agents clean up within hours" is the common path, so a row-only MAX jumps back
 * to an older decision and pages on a board that did act.
 *
 * The activity log is append-only, and `requestRevision`'s only caller
 * (`resolveApprovalWithSideEffects`) writes this event for every revision, so it
 * survives both exits. Approve/reject stay on the row because one approve path
 * (`routes/agents.ts`, hire approval) logs `agent.approved`, not this family.
 */
const REVISION_REQUESTED_ACTIVITY = "approval.revision_requested";

/**
 * `revision_requested` is NOT counted as pending, even though the server treats
 * it as undecided for idempotency purposes (`APPROVAL_UNDECIDED_STATUSES`).
 *
 * The question this gauge answers is "is the board failing to serve?", and a
 * `revision_requested` card is back in the REQUESTER's court -- it is theirs to
 * resubmit or withdraw. Counting it here would hold the alert open on a queue
 * the board has already answered, and would misattribute a requester backlog to
 * board unresponsiveness. Requester-side rot is a real problem (118 such cards
 * were once left unattended) but it is a different alert with a different owner,
 * so it does not belong in this series.
 */
const PENDING_STATUS = "pending";

/**
 * Why the oldest-pending age is dated from `GREATEST(created_at, updated_at)`
 * rather than `created_at` (PEN-5719).
 *
 * `resubmit` is the one write that returns a row to `pending`, and it keeps the
 * original `created_at`. Dating the age from that column therefore bills the
 * board for two spans it does not own: the stretch the card sat in
 * `revision_requested` -- the REQUESTER's court, which {@link PENDING_STATUS}
 * above is at pains to exclude from the depth gauge for exactly this reason --
 * and the pre-revision stretch the board already discharged by ruling on it.
 * The two gauges in this family then disagree about who owns revision time,
 * and the starvation alert is the one that misattributes it.
 *
 * Not hypothetical: PEN-5719 fired on a card the board HAD served. Filed
 * 10-30T03:11Z, `revision_requested` 11-03T01:26Z, resubmitted 11-04T09:33Z.
 * At the 11-06T04:11Z firing its true pending age was 1.8d against a 7d
 * threshold, but the gauge read 7.2d and the oldest-pending anchor jumped
 * BACKWARDS 5h at the moment of resubmission -- visible in the range query as a
 * +29039s step where every neighbour steps +10800s.
 *
 * `updated_at` is read here for the same reason, and was justified under the
 * same proof, that `hasPendingBoardApprovalWakePath` in `recovery/service.ts`
 * reads it: this query is scoped to `pending`, and the column has no
 * `$onUpdate` and no trigger, so it moves solely where a write sets it.
 *
 * ⚠ THAT PROOF NO LONGER HOLDS, and the re-runnable survey it was stated as is
 * what caught it (PEN-5818). The survey -- `grep -rn 'update(approvals)'
 * server/src --include='*.ts' | grep -v __tests__` -- returned eleven sites
 * when this constant was written, of which exactly one left a row `pending`
 * while touching `updated_at`: `resubmit`. It now returns TWELVE, and TWO
 * qualify. The new one is the in-place payload correction in
 * `services/approvals.ts` (`updatePayload`, the route behind
 * `PATCH /approvals/{id}`), which sets `payloadEditedAt` AND
 * `updatedAt` under a `where ... status = 'pending'` guard -- so it leaves the
 * row pending by construction. `services/agents.ts` is still the nearest miss
 * and is still harmless for the stated reason: it edits `payload` on pending
 * rows without setting `updated_at`.
 *
 * So on a pending row `updated_at` no longer carries exactly one signal. It
 * carries "resubmitted" OR "payload corrected in place", and this expression
 * cannot tell them apart. The second is the opposite of what the gauge wants:
 * an in-place correction exists precisely so a filer can fix stale evidence
 * WITHOUT moving the card in the queue (see the route's own contract), and it
 * re-dates the age as though the card were freshly filed. The failure is in
 * the flattering direction -- the queue reads healthier every time a filer does
 * the diligent thing -- and three in-place amendments on the current band were
 * measured to be enough to clear a live `PaperclipApprovalStarved` page with
 * zero board decisions.
 *
 * The discriminator already exists on the row and this expression does not yet
 * consult it: `payload_edited_at` equals `updated_at` exactly when the bump was
 * an in-place edit, which was clean on 7/7 of the pending band over 7d on
 * 2026-11-08. Fixing that is a query change and is tracked separately; this
 * comment and the gauge's HELP text are deliberately the only thing PEN-5818
 * moved, so the correction is not mistaken for a silent semantics change.
 *
 * Note what did NOT catch this: no test does. `approval-queue-metrics.test.ts`
 * drives the revision->resubmit chain, but it sets `updatedAt` directly, so it
 * cannot distinguish which writer moved it. Re-running the survey above is
 * still the only control. Re-run it rather than trusting the count in this
 * paragraph, which is itself a measurement with a date on it.
 *
 * GREATEST, not a bare `updated_at`, because `updated_at >= created_at` is a
 * convention and rows that violate it already exist: pending approval
 * `e1b6747a` carries an `updated_at` 1 ms BEFORE its `created_at`. On a bare
 * `updated_at` such a row anchors EARLIER than it was filed and so reports an
 * age LARGER than its true one -- reintroducing, by a different route, the
 * very overstatement this constant exists to remove. GREATEST clamps the
 * anchor so it can never precede the filing.
 *
 * Note it is `Math.max(0, ...)` at the call site, NOT this GREATEST, that
 * keeps the age non-negative: a negative age needs an anchor in the FUTURE,
 * and against that GREATEST is actively unhelpful, since it would prefer the
 * future timestamp. The two guards cover opposite ends and are both load-bearing.
 */
const PENDING_SINCE = sql`greatest(${approvals.createdAt}, ${approvals.updatedAt})`;

/**
 * Refresh the board-approval-queue depth/staleness gauges (BLO-29850).
 *
 * Follows the `refreshExternalRuntimeReservationStrandMetrics` shape (BLO-28865)
 * exactly: recomputed from the database on every collector tick, reset-then-set,
 * with a companion freshness gauge so a failed refresh cannot be read as "the
 * queue is empty and recently served".
 *
 * WHY THIS LIVES IN THE APP rather than in a sidecar exporter. The original plan
 * was a standalone pod reading `GET /companies/{id}/approvals`, which needs an
 * API credential a human has to mint by hand; that gate sat unserved for 29 days
 * while the queue stayed unmeasured. The control plane is already scraped as the
 * `paperclip-control-plane` job and already holds a database handle, so computing
 * these three aggregates here needs no new credential, no new workload, and no
 * new scrape target. Same reasoning, and the same collector, as every other
 * DB-derived queue gauge in `scrape-metrics-collector.ts`.
 *
 * Labelled by company_id + requester (BLO-48410). PEN-3652 forbids reading the
 * cross-company aggregate: a decision in company B must never mask starvation in
 * company A, so the rules join `on(company_id)`. `requester` is "agent" when the
 * card has a requesting agent, else "board". The depth gauges carry `gated` as
 * well (PEN-5885, see {@link IS_GATED}), so cardinality is
 * companies x 2 requesters x types x 2. Every existing rule collapses the
 * vector with `max by (company_id[, requester])`, which absorbs the new label
 * without a rule change -- verified against the live rule file, where all five
 * expressions do so.
 */
export async function refreshApprovalQueueMetrics(db: Db, now = new Date()): Promise<void> {
  try {
    const requester = sql<string>`case when ${approvals.requestedByAgentId} is not null then 'agent' else 'board' end`;
    const [pendingRows, channelRows, revisionRows] = await Promise.all([
      db
        .select({
          companyId: approvals.companyId,
          requester,
          type: approvals.type,
          gated: IS_GATED,
          pending: sql<number | string>`count(*)`,
          oldestPendingSince: sql<Date | string | null>`min(${PENDING_SINCE})`,
        })
        .from(approvals)
        .where(eq(approvals.status, PENDING_STATUS))
        .groupBy(approvals.companyId, requester, approvals.type, IS_GATED),
      // One row per (company, requester) with ANY history, so a channel that was
      // never decided still gets a series (at 0) -- the rule contract (BLO-48410).
      // A decided row with a null `decided_at` carries no timing information and
      // must not collapse the MAX; the FILTER keeps "never decided" as null.
      db
        .select({
          companyId: approvals.companyId,
          requester,
          decidedAt: sql<Date | string | null>`max(${approvals.decidedAt}) filter (where (${inArray(approvals.status, [...BOARD_DECISION_STATUSES])} or (${MERGE_GATE_DECISION})) and ${approvals.decidedAt} is not null)`,
        })
        .from(approvals)
        .groupBy(approvals.companyId, requester),
      // ponytail: no index matches either filter shape; the approvals aggregates
      // seq-scan (~1k rows) every tick. Add a status-leading approvals index, or an
      // (entity_type, action, created_at) activity_log index, if collector latency shows it.
      db
        .select({
          companyId: approvals.companyId,
          requester,
          createdAt: sql<Date | string | null>`max(${activityLog.createdAt})`,
        })
        .from(activityLog)
        // Cast the approvals side on purpose: `entity_id::uuid` throws on non-UUID ids
        // before the entity_type filter applies.
        .innerJoin(approvals, eq(activityLog.entityId, sql`${approvals.id}::text`))
        .where(
          and(
            eq(activityLog.entityType, "approval"),
            eq(activityLog.action, REVISION_REQUESTED_ACTIVITY),
          ),
        )
        .groupBy(approvals.companyId, requester),
    ]);

    const key = (companyId: string, req: string) => `${companyId}:${req}`;
    const revisionAt = new Map(
      revisionRows.map((row) => [key(row.companyId, row.requester), row.createdAt]),
    );
    const channels = channelRows.map((row) => {
      const decidedAtMs = Math.max(
        ...[row.decidedAt, revisionAt.get(key(row.companyId, row.requester))]
          .filter((at): at is Date | string => at != null)
          .map((at) => new Date(at).getTime()),
      );
      return {
        companyId: row.companyId,
        requester: row.requester,
        // Seconds, not ms: `time() - <gauge>` only type-checks against Unix seconds.
        // Math.max() of nothing is -Infinity: never decided, published as 0.
        lastDecisionTimestampSeconds: Number.isFinite(decidedAtMs) ? decidedAtMs / 1000 : null,
      };
    });

    setApprovalQueuePendingMetrics({
      channels,
      entries: pendingRows.map((row) => ({
        companyId: row.companyId,
        requester: row.requester,
        type: row.type,
        gated: Boolean(row.gated),
        pending: Number(row.pending),
        oldestAgeSeconds: row.oldestPendingSince
          ? Math.max(0, (now.getTime() - new Date(row.oldestPendingSince).getTime()) / 1000)
          : 0,
      })),
    });
    setApprovalQueueMetricsRefreshSuccess(true);
  } catch (error) {
    // Same contract as every other refresh here: do NOT overwrite the last
    // snapshot with synthetic zeros. A zeroed pending count plus a zeroed age
    // reads as a healthy empty queue, which is the one wrong answer this issue
    // exists to prevent. The freshness gauge makes the stale sample ineligible
    // and pages its own failure instead.
    setApprovalQueueMetricsRefreshSuccess(false);
    throw error;
  }
}
