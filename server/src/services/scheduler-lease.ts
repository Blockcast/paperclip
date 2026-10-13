import { randomUUID } from "node:crypto";
import os from "node:os";

import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";

import { logger } from "../middleware/logger.js";
import { recordSchedulerLeaseState } from "./metrics.js";

/**
 * Time-based leader election for process-wide singleton loops (BLO-43292).
 *
 * ## What this is for
 *
 * `paperclip-0` runs the heartbeat timer loop that enqueues every agent run,
 * at `replicas: 1`. On 2026-10-05 that process stopped dispatching for ~30
 * minutes while staying `Ready` with `restartCount=0` — fleet-wide dispatch
 * dark, ended only by a human noticing. A second replica is the remedy, and a
 * second replica is only safe if exactly one of them runs the loop.
 *
 * This does not fix the stall (that is BLO-32064). It makes the stall
 * survivable: a holder that stops renewing loses the lease on a clock, and a
 * survivor picks the loop up within a bounded, stated interval.
 *
 * ## Why a lease and not `pg_advisory_lock`
 *
 * The disposition recorded by BLO-32095 AC-4, and the reason is the measured
 * failure above. An advisory lock is held by a *session*: the stalled holder
 * kept its connection, so it would have kept the lock indefinitely and no
 * second replica could ever have taken over — the one scenario this exists
 * for. A lease has to be actively re-asserted, so a holder that has stopped
 * doing work also stops holding the lease, whether or not it can tell.
 *
 * ## The numbers (BLO-43292 AC-2, BLO-32064 AC-3)
 *
 * - renew every {@link SCHEDULER_LEASE_RENEW_INTERVAL_MS} (15 s)
 * - lease TTL {@link SCHEDULER_LEASE_TTL_MS} (45 s) — three renew intervals,
 *   so two consecutive failed renewals do not cause a spurious handover
 * - followers attempt acquisition on the same 15 s cadence
 *
 * So: **a holder that stops renewing loses the lease within 45 s, and a
 * survivor resumes enqueuing within 60 s** (45 s expiry + up to one 15 s
 * follower poll). A *graceful* shutdown releases the lease outright, so a
 * rolling restart hands over in roughly one follower poll rather than waiting
 * out the TTL.
 *
 * ## Clock handling
 *
 * Every timestamp in the table is written by the DATABASE (`now()`), so the
 * takeover test compares two values from the same clock and needs no agreement
 * between replicas.
 *
 * The holder's own "do I still hold it" test is local, and deliberately
 * conservative: the local deadline is computed from the wall clock read
 * *before* the renewal query is sent, so query and network latency are charged
 * against the holder. The holder therefore always believes its lease expires
 * at or before the moment the database would let someone else take it, which
 * is the safe direction — a holder can falsely demote itself (costing one
 * tick) but cannot falsely believe it still holds a lease another process has
 * already taken.
 */

/** Lease name for the heartbeat scheduler's periodic timer loop. */
export const HEARTBEAT_TIMER_LEASE = "heartbeat-timer";

/** See the numbers section above. */
export const SCHEDULER_LEASE_TTL_MS = 45_000;
/** See the numbers section above. */
export const SCHEDULER_LEASE_RENEW_INTERVAL_MS = 15_000;

export type SchedulerLeaseHold = {
  holderId: string;
  acquiredAt: Date;
  renewedAt: Date;
  expiresAt: Date;
};

type LeaseDb = Pick<Db, "execute">;

function firstRow(result: unknown): Record<string, unknown> | null {
  const rows = Array.isArray(result) ? result : (result as { rows?: unknown[] })?.rows;
  const row = Array.isArray(rows) ? rows[0] : null;
  return row && typeof row === "object" ? (row as Record<string, unknown>) : null;
}

/**
 * Take or renew `name` for `holderId`, in one atomic statement.
 *
 * Returns the hold when this caller owns the lease afterwards, and `null` when
 * a *different* process holds a lease that has not yet expired.
 *
 * The exclusion is the `WHERE` on the `DO UPDATE`, not anything in this
 * process: the row's primary key serializes concurrent upserts, and the update
 * is permitted only for the incumbent holder (renewal) or against an expired
 * lease (takeover). A loser gets zero rows back. There is no read-then-write
 * window for two callers to interleave in, which is what makes the
 * double-enqueue property hold by construction rather than by timing.
 *
 * `acquired_at` is preserved across renewals and reset on takeover, so it
 * answers "since when has this holder had it" rather than "when was it last
 * touched".
 */
export async function acquireSchedulerLease(
  db: LeaseDb,
  { name, holderId, ttlMs }: { name: string; holderId: string; ttlMs: number },
): Promise<SchedulerLeaseHold | null> {
  const ttl = sql.raw(`interval '${Math.max(1, Math.round(ttlMs))} milliseconds'`);
  const result = await db.execute(sql`
    insert into scheduler_leases (name, holder_id, acquired_at, renewed_at, expires_at)
    values (${name}, ${holderId}, now(), now(), now() + ${ttl})
    on conflict (name) do update
      set holder_id = excluded.holder_id,
          renewed_at = now(),
          expires_at = now() + ${ttl},
          acquired_at = case
            when scheduler_leases.holder_id = excluded.holder_id
              then scheduler_leases.acquired_at
            else now()
          end
      where scheduler_leases.holder_id = excluded.holder_id
         or scheduler_leases.expires_at <= now()
    returning holder_id, acquired_at, renewed_at, expires_at
  `);
  const row = firstRow(result);
  if (!row) return null;
  return {
    holderId: String(row.holder_id),
    acquiredAt: new Date(row.acquired_at as string),
    renewedAt: new Date(row.renewed_at as string),
    expiresAt: new Date(row.expires_at as string),
  };
}

/**
 * Give up `name` if (and only if) this process still holds it.
 *
 * Load-bearing rather than tidy-up: without it every deploy would cost up to
 * one full TTL of dispatch silence, because the restarted process is a new
 * holder (new nonce) and would have to wait out the dead one's lease.
 */
export async function releaseSchedulerLease(
  db: LeaseDb,
  { name, holderId }: { name: string; holderId: string },
): Promise<boolean> {
  const result = await db.execute(sql`
    delete from scheduler_leases
    where name = ${name} and holder_id = ${holderId}
    returning name
  `);
  return firstRow(result) !== null;
}

/**
 * Identity of THIS process.
 *
 * Hostname for legibility (`paperclip-0`), plus a per-process nonce so a
 * restarted pod cannot renew the lease its own dead predecessor held. The pod
 * part alone is exported separately as the metric label, so series cardinality
 * is bounded by pod count rather than by restart count.
 */
export function schedulerLeaseIdentity() {
  const pod = process.env.HOSTNAME?.trim() || os.hostname() || "unknown";
  return { pod, holderId: `${pod}#${randomUUID().slice(0, 8)}` };
}

export type SchedulerLeaseHolder = ReturnType<typeof schedulerLeaseHolder>;

/**
 * A renew loop plus the cached "am I the leader right now" predicate the
 * timer loop reads.
 *
 * `isLeader()` is a pure in-memory comparison and never touches the database:
 * it is read on every scheduler tick, and a tick-time query would put the
 * leadership check downstream of the very pool exhaustion that makes a worker
 * stop ticking in the first place.
 *
 * The cached verdict is a DEADLINE, not a boolean, and that is the whole
 * safety property. A renew loop that wedges leaves `heldUntilMs` in the past,
 * so the stalled holder demotes itself rather than holding a leadership flag
 * forever — which is precisely the `pg_advisory_lock` failure mode this
 * mechanism was chosen over.
 */
export function schedulerLeaseHolder(
  db: LeaseDb,
  {
    name,
    ttlMs = SCHEDULER_LEASE_TTL_MS,
    renewIntervalMs = SCHEDULER_LEASE_RENEW_INTERVAL_MS,
    identity = schedulerLeaseIdentity(),
    now = () => Date.now(),
    onAcquire,
  }: {
    name: string;
    /**
     * Fired on every transition from not-holding to holding: the first
     * acquisition, every failover takeover, and this same process re-winning
     * after its own renewals lapsed past the TTL (or a fail-open process
     * first reaching the table) (BLO-45212). Synchronous and
     * fire-and-forget; a throw is logged and does not affect the lease.
     */
    onAcquire?: () => void;
    ttlMs?: number;
    renewIntervalMs?: number;
    identity?: { pod: string; holderId: string };
    now?: () => number;
  },
) {
  let heldUntilMs = 0;
  let lastRenewedAtMs = 0;
  /** Has this process ever actually reached the lease table and won a round? */
  let everAcquired = false;
  let neverAcquiredLogged = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;
  // Single-flight latch. Without it `setInterval` stacks a fresh query every
  // renew interval while the pool is exhausted — adding load during the exact
  // starvation this lease exists to survive — and `stop()` has nothing to wait
  // on, so a renewal still in flight could land AFTER the release and re-insert
  // the row, holding the lease for a full TTL past process exit.
  let inFlight: Promise<boolean> | null = null;

  const isLeader = () => now() < heldUntilMs;

  /**
   * Whether this process may run the gated loop. Exactly `isLeader()`.
   *
   * It used to also return true for a process that had NEVER reached the lease
   * table (every attempt threw), on the theory that "unknown" should not take
   * dispatch down at `replicas: 1`. At `replicas: 2` that is a double-enqueue:
   * a code-ahead-of-migration rollout, or a lease query that errors while other
   * writes succeed, puts BOTH pods on the loop (BLO-45763). So unknown now
   * means follower: the renew timer keeps retrying and this process takes the
   * loop within one {@link SCHEDULER_LEASE_RENEW_INTERVAL_MS} (15 s) of the
   * table becoming reachable.
   *
   * Stays a follower rather than exiting so the HTTP API keeps serving and no
   * CrashLoopBackOff (up to 5 min) is stacked on top of the outage. The
   * single-replica cost is bounded: dispatch is dark for exactly as long as
   * `scheduler_leases` is unreachable, plus at most 15 s. When the whole DB is
   * unreachable that cost is zero, since the loop cannot dispatch without it
   * anyway. `PAPERCLIP_SCHEDULER_LEASE_ENABLED=false` is the escape hatch: it
   * skips this holder entirely and restores the unleased loop.
   */
  const shouldRunLoop = () => isLeader();

  const publish = () => {
    recordSchedulerLeaseState({
      lease: name,
      holder: identity.pod,
      // `sum by (lease) (...) != 1` alerts on the thing that matters: zero
      // means dispatch is dark, two means double-enqueue.
      held: shouldRunLoop(),
      lastRenewedAtMs,
    });
  };

  /** One acquire/renew attempt. Returns whether this process runs the loop. */
  const tick = (): Promise<boolean> => {
    if (stopped) return Promise.resolve(false);
    if (!inFlight) {
      inFlight = attempt().finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  };

  const attempt = async () => {
    const wasLeader = isLeader();
    // Read BEFORE the query so latency is charged against our own validity
    // window — see the clock-handling note at the top of this file.
    const startedAtMs = now();
    try {
      const hold = await acquireSchedulerLease(db, {
        name,
        holderId: identity.holderId,
        ttlMs,
      });
      if (hold) {
        everAcquired = true;
        heldUntilMs = startedAtMs + ttlMs;
        lastRenewedAtMs = startedAtMs;
        if (!wasLeader) {
          logger.warn(
            { lease: name, holder: identity.holderId, ttlMs, renewIntervalMs },
            "scheduler lease acquired - this process now runs the heartbeat timer loop",
          );
          try {
            onAcquire?.();
          } catch (err) {
            logger.error({ err, lease: name }, "scheduler lease onAcquire callback failed");
          }
        }
      } else if (wasLeader) {
        // Another process took it while we still believed we held it. Only
        // reachable if our own renewals lapsed past the TTL, so demote now
        // rather than coasting to the cached deadline.
        heldUntilMs = 0;
        logger.warn(
          { lease: name, holder: identity.holderId },
          "scheduler lease lost to another holder - this process stopped running the heartbeat timer loop",
        );
      }
    } catch (err) {
      // Deliberately does NOT clear `heldUntilMs`. A transient database error
      // must not hand the loop over: the cached deadline already bounds how
      // long a failing renewer may keep believing it is the leader, and it is
      // the same bound the database would enforce. Clearing here would turn
      // one failed query into an immediate dispatch gap.
      logger.error(
        { err, lease: name, holder: identity.holderId },
        "scheduler lease renewal failed",
      );
      if (!everAcquired && !neverAcquiredLogged) {
        neverAcquiredLogged = true;
        logger.error(
          { lease: name, holder: identity.holderId, renewIntervalMs },
          "scheduler lease has never been acquired and every attempt has failed - NOT running the "
          + "heartbeat timer loop until it is; retrying every renew interval. "
          + "PAPERCLIP_SCHEDULER_LEASE_ENABLED=false restores the unleased loop (one replica only)",
        );
      }
    }
    publish();
    return shouldRunLoop();
  };

  return {
    identity,
    isLeader,
    shouldRunLoop,
    /** Exposed for the failover drill and for tests; the loop calls it itself. */
    tick,
    state: () => ({
      holderId: identity.holderId,
      leader: isLeader(),
      runsLoop: shouldRunLoop(),
      everAcquired,
      heldUntilMs,
      lastRenewedAtMs,
    }),
    /** Acquire once synchronously-ish, then renew on a timer. */
    start: async () => {
      if (stopped || timer) return shouldRunLoop();
      const leader = await tick();
      if (stopped) return leader;
      timer = setInterval(() => {
        void tick();
      }, renewIntervalMs);
      // Must not keep the process alive on its own — shutdown clears it, but a
      // lingering handle would also hold the event loop open for any path that
      // forgets to.
      timer.unref?.();
      return leader;
    },
    /**
     * Stop renewing. With `release: false` the row is left to expire on its own
     * (TTL), which is what shutdown wants when it could not wait for the
     * scheduler's in-flight work to drain: releasing early would let a
     * survivor run a tick while this process's last one is still writing.
     */
    stop: async ({ release = true }: { release?: boolean } = {}) => {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      // Let an in-flight renewal land BEFORE the release, never after it.
      if (inFlight) await inFlight.catch(() => undefined);
      const wasLeader = isLeader();
      heldUntilMs = 0;
      publish();
      if (!wasLeader || !release) return false;
      try {
        return await releaseSchedulerLease(db, { name, holderId: identity.holderId });
      } catch (err) {
        // The lease expires on its own; losing the fast handover is survivable.
        logger.warn({ err, lease: name }, "scheduler lease release failed");
        return false;
      }
    },
  };
}
