import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * BLO-43292: time-based leases for process-wide singleton loops.
 *
 * One row per named loop (`name` is the primary key, so the table is bounded by
 * the number of loops, not by the number of replicas or acquisitions).
 *
 * Deliberately a lease and NOT `pg_advisory_lock`, which is the disposition
 * BLO-32095 AC-4 recorded. An advisory lock is held by a *session*: a holder
 * whose event loop has stopped — the measured 2026-10-05 failure, where
 * `paperclip-0` stayed `Ready` with `restartCount=0` and simply stopped
 * dispatching for ~30 minutes — keeps its connection and therefore keeps the
 * lock forever. A lease has to be actively re-asserted, so the same stalled
 * holder loses it on a clock whether or not it notices.
 *
 * Every timestamp here is written from the DATABASE clock (`now()`), never from
 * a caller. That is what makes the takeover decision (`expires_at <= now()`)
 * sound across replicas without assuming their clocks agree.
 */
export const schedulerLeases = pgTable("scheduler_leases", {
  /** Loop name, e.g. `heartbeat-timer`. One lease per name, estate-wide. */
  name: text("name").primaryKey(),
  /**
   * Opaque identity of the holding PROCESS, not of the pod: it carries a
   * per-process nonce, so a restarted pod with the same hostname is a different
   * holder and cannot renew the dead process's lease by accident.
   */
  holderId: text("holder_id").notNull(),
  /** When the CURRENT holder took the lease (not bumped by renewals). */
  acquiredAt: timestamp("acquired_at", { withTimezone: true }).notNull().defaultNow(),
  /** Last successful renewal. Read this to see how stale a live lease is. */
  renewedAt: timestamp("renewed_at", { withTimezone: true }).notNull().defaultNow(),
  /** Past this, any process may take the lease. Database clock. */
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});
