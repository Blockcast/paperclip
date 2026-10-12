-- BLO-43292: time-based leases for process-wide singleton loops, so the
-- heartbeat timer loop can run on exactly one of several replicas.
--
-- `paperclip-0` is `replicas: 1` and hosts the loop that enqueues every agent
-- run. On 2026-10-05 it stopped dispatching for ~30 minutes while staying
-- `Ready` with `restartCount=0`: fleet-wide dispatch dark, ended by a human
-- noticing. A second replica is the remedy, and a second replica is only safe
-- once exactly one of them runs the loop.
--
-- A LEASE, deliberately, not `pg_advisory_lock` — the disposition recorded by
-- BLO-32095 AC-4. An advisory lock is held by a session: the stalled holder
-- above kept its connection, so it would have kept the lock indefinitely and
-- no second replica could ever have taken over, which is the one case this
-- exists for. A lease has to be re-asserted, so a holder that has stopped
-- working also stops holding it.
--
-- Mutual exclusion is the primary key plus the `WHERE` on the upsert's
-- `DO UPDATE` (see `acquireSchedulerLease`): the update is permitted only for
-- the incumbent holder or against an expired row, so a loser gets zero rows
-- back and there is no read-then-write window to interleave in.
--
-- Every timestamp is written from the DATABASE clock, never from a caller, so
-- the takeover test compares two values from one clock and needs no agreement
-- between replicas.
--
-- Bounded by the number of named loops (one row per `name`), so this table
-- does not grow with replicas, restarts or acquisitions.
CREATE TABLE IF NOT EXISTS "scheduler_leases" (
  "name" text PRIMARY KEY NOT NULL,
  -- Identity of the holding PROCESS, not of the pod: it carries a per-process
  -- nonce so a restarted pod with the same hostname is a different holder and
  -- cannot renew its dead predecessor's lease.
  "holder_id" text NOT NULL,
  -- When the current holder took it. Preserved across renewals, reset on
  -- takeover, so it answers "since when has this holder had it".
  "acquired_at" timestamp with time zone DEFAULT now() NOT NULL,
  "renewed_at" timestamp with time zone DEFAULT now() NOT NULL,
  -- Past this, any process may take the lease.
  "expires_at" timestamp with time zone NOT NULL
);
