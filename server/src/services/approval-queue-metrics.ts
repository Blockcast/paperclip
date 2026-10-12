import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, approvals } from "@paperclipai/db";
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
 */
const BOARD_DECISION_STATUSES = ["approved", "rejected", "revision_requested"] as const;

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
 * Deliberately UNLABELLED BY COMPANY. These feed a single "is the escalation path
 * serving?" alert for the installation, matching the other control-plane queue
 * gauges; a per-company split is a different question and would need its own
 * cardinality argument.
 */
export async function refreshApprovalQueueMetrics(db: Db, now = new Date()): Promise<void> {
  try {
    const [pendingByType, lastDecision, lastRevisionRequest] = await Promise.all([
      db
        .select({
          type: approvals.type,
          pending: sql<number | string>`count(*)`,
          oldestCreatedAt: sql<Date | string | null>`min(${approvals.createdAt})`,
        })
        .from(approvals)
        .where(eq(approvals.status, PENDING_STATUS))
        .groupBy(approvals.type),
      db
        .select({
          decidedAt: sql<Date | string | null>`max(${approvals.decidedAt})`,
        })
        .from(approvals)
        .where(
          and(
            inArray(approvals.status, [...BOARD_DECISION_STATUSES]),
            // A decided row with a null `decided_at` carries no timing
            // information, so it must not collapse the MAX. Filtering here
            // rather than coalescing to epoch keeps "never decided" distinct
            // from "decided in 1970".
            isNotNull(approvals.decidedAt),
          ),
        ),
      // ponytail: no index matches either filter shape. This one can narrow to
      // approval rows through activity_log_entity_type_id_idx's leading column;
      // the two approvals aggregates above filter on status alone, so they
      // seq-scan the table (~1k rows) every tick. Add a status-leading approvals
      // index, or an (entity_type, action, created_at) activity_log index, if
      // either aggregate shows up in collector latency.
      db
        .select({
          createdAt: sql<Date | string | null>`max(${activityLog.createdAt})`,
        })
        .from(activityLog)
        .where(
          and(
            eq(activityLog.entityType, "approval"),
            eq(activityLog.action, REVISION_REQUESTED_ACTIVITY),
          ),
        ),
    ]);

    const entries = pendingByType.map((row) => ({
      type: row.type,
      pending: Number(row.pending),
      oldestAgeSeconds: row.oldestCreatedAt
        ? Math.max(0, (now.getTime() - new Date(row.oldestCreatedAt).getTime()) / 1000)
        : 0,
    }));

    const decidedAtMs = Math.max(
      ...[lastDecision[0]?.decidedAt, lastRevisionRequest[0]?.createdAt]
        .filter((at): at is Date | string => at != null)
        .map((at) => new Date(at).getTime()),
    );

    setApprovalQueuePendingMetrics({
      entries,
      // Seconds, not ms: `time() - <gauge>` in the alert expression only type-checks
      // against a Unix-seconds series.
      // Math.max() of nothing is -Infinity: no decision from either source.
      lastDecisionTimestampSeconds: Number.isFinite(decidedAtMs) ? decidedAtMs / 1000 : null,
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
