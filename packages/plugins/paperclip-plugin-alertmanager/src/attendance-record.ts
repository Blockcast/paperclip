import { randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";

/**
 * PEN-2918 — a durable, queryable record of the attendance determination the
 * escalation ladder already makes on every pass.
 *
 * ## What this is for
 *
 * The founding measurement on PEN-2918 is a `severity: page` alert that fired
 * for ~96h, was delivered to Slack ~4,900 times with zero delivery failures and
 * complete annotations, and changed nothing. Delivery was never the constraint.
 * What the estate could not do was answer, for any escalation, which of three
 * things happened: it was **delivered**, it was **acknowledged**, or it was
 * **executed**. Those were three words for one unreadable state.
 *
 * The ladder in `escalation.ts` already decides the middle one. Every pass it
 * asks whether the row is attended — by an armed monitor (PEN-4337) or an
 * unresolved `blockedBy` edge (BLO-40673) — and then discards the answer.
 * `escalation.ts` says so in its own words, about the deferral branch:
 *
 * > A deferral writes only `nextEscalationAt` into plugin state, which has no
 * > read API, emits no metric, and posts no comment; its sole external trace
 * > was the ABSENCE of a cover row.
 *
 * An absence is not a record. Nothing can be counted from it, and "the guard
 * held the rung" cannot be distinguished from "the guard never ran". This
 * module stops the determination being thrown away. It computes nothing new.
 *
 * ## ⛔ What this does NOT do — read this before citing it
 *
 * 1. **It does not oblige anybody.** It makes non-acknowledgement visible and
 *    queryable; it does not make non-acknowledgement create a duty on a named
 *    person. PEN-2918's third criterion is untouched by this module and is not
 *    closed by it. A query over this table is not an on-call rota, and there is
 *    no on-call owner for this estate **by board decision** (card `b94c4d7d`,
 *    Option B) rather than by omission.
 * 2. **It does not record `executed`.** It records what the ladder observed
 *    about attendance. Whether the resulting work was actually done is a
 *    different question with a different source, and nothing here answers it.
 * 3. **It is not a second obligation surface.** The record lives in this
 *    plugin's own namespace and is read through Paperclip's own API — no new
 *    channel, no new notification, no new place to look. That distinction is
 *    load-bearing: the 2026-10-03 ruling on PEN-3315 refused a GitHub-issue
 *    audit trail *beside* Paperclip. This removes a place where a computed fact
 *    was discarded; it does not add a place to look.
 * 4. **It changes no ladder behaviour.** Rung timing, climb order, who is woken,
 *    auto-cancel withholding and the PEN-4337 monitor deferral are all exactly
 *    as they were. Every write here is an INSERT into a new table, and every
 *    one is fail-safe — see `recordAttendanceObservation`.
 *
 * ## `delivered` is MEASURED here, never assumed
 *
 * `wakeOutcome` exists because a three-state `delivered | acknowledged |
 * executed` model has no cell for the state this estate has actually spent days
 * in: **an ask that was never delivered at all, while every surface its author
 * could read said it was.**
 *
 * The ladder posts `"waking current owner <name>"` as an issue comment and
 * *then* calls `issues.requestWakeup`, whose failure it swallows by design (a
 * refused wake must not repeat the rung). So a paused agent, a budget block or
 * an unresolved blocker produces a thread that asserts a wake, a plugin log
 * line nobody reads, and no other trace. `wake_outcome: "refused"` is that
 * missing cell.
 *
 * Note what `enqueued` does and does not claim: the host **accepted** the wake.
 * It is not evidence that a run started, and certainly not that anyone read
 * anything. Acknowledgement is recorded only from an **observation of
 * attendance** — the `attended_*` dispositions — and never from a dispatch
 * having succeeded. Deriving acknowledgement from successful delivery would
 * reproduce the exact defect PEN-2918 measured, with a schema on it.
 */

/** Table name in the plugin namespace; see `migrations/007_attendance_observations.sql`. */
export const ATTENDANCE_TABLE = "alert_attendance_observations";

/**
 * The ladder's determination for one pass, in the ladder's own vocabulary.
 *
 * `attended_*` are the two mechanisms this platform treats as attendance.
 * Neither is a promise that the work happens — only that a wake exists — which
 * is why the ladder defers rather than stops, and why a long run of
 * `attended_monitor` rows on one issue is a finding rather than a reassurance.
 */
export type AttendanceDisposition =
  | "attended_monitor"
  | "attended_blocker"
  | "unattended_rung"
  | "unattended_cover"
  | "held_alert_clear";

/** See the `wake_outcome` column comment in the migration. */
export type WakeOutcome = "enqueued" | "refused" | "not_attempted";

/** What Alertmanager said on this pass. `not_read` is a real answer, not a gap. */
export type ObservedAlertLiveness = "firing" | "not_firing" | "unknown" | "not_read";

export interface AttendanceObservation {
  companyId: string;
  alertIssueId: string;
  alertname: string;
  disposition: AttendanceDisposition;
  alertLiveness: ObservedAlertLiveness;
  wakeOutcome: WakeOutcome;
  /** Fixed sentence only — never raw error text. See the migration's column comment. */
  wakeDetail?: string | null;
  escalationAttempt?: number | null;
  notifiedAgentId?: string | null;
}

/**
 * Appends one observation. **Never throws.**
 *
 * The fail-safe is the whole reason this is a separate function rather than an
 * inline INSERT. This record is an audit of the ladder, so it must not be able
 * to break the ladder: an unmigrated namespace, a lost connection or a
 * constraint surprise has to cost the row and nothing else. Failing the other
 * way would let a bookkeeping write suppress a real escalation — strictly worse
 * than the gap this module exists to close.
 *
 * Same discipline, and the same reasoning, as `requestWakeupBestEffort` in
 * `escalation.ts`.
 */
export async function recordAttendanceObservation(
  ctx: PluginContext,
  observation: AttendanceObservation,
): Promise<void> {
  try {
    await ctx.db.execute(
      `INSERT INTO ${ctx.db.namespace}.${ATTENDANCE_TABLE}
         (id, company_id, alert_issue_id, alertname, disposition, escalation_attempt,
          notified_agent_id, wake_outcome, wake_detail, alert_liveness)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        randomUUID(),
        observation.companyId,
        observation.alertIssueId,
        observation.alertname,
        observation.disposition,
        observation.escalationAttempt ?? null,
        observation.notifiedAgentId ?? null,
        observation.wakeOutcome,
        observation.wakeDetail ?? null,
        observation.alertLiveness,
      ],
    );
  } catch (err) {
    ctx.logger.warn(
      `alert-escalation: attendance observation for issue ${observation.alertIssueId} (${observation.disposition}) was not recorded: ${String(err)}`,
    );
  }
}
