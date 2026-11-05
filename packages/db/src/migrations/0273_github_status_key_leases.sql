-- BLO-52499: a lease per GitHub status key (`lower(repo)#sha`), so an
-- evaluation of a head can hold exclusivity across its GitHub calls without
-- holding a pooled connection open in a transaction.
--
-- A LEASE, not a session advisory lock, for the reason BLO-32095 AC-4 recorded
-- for scheduler_leases: a lock held by a session is freed the instant that
-- session dies, even while its holder still has a write in flight. A lease row
-- survives the session, so a holder that checked it before a write can finish
-- that write before anyone else can take the key.
--
-- The token is per EVALUATION, not per process, so two evaluations of one head
-- in one process exclude each other. Mutual exclusion is the primary key plus
-- the WHERE on the upsert's DO UPDATE: only an expired row can be taken over.
--
-- Every timestamp comes from the database clock (`clock_timestamp()`), so the
-- takeover test needs no agreement between replicas. Rows are deleted on
-- release, and a crashed holder's row is swept after it expires, so the table
-- holds at most the heads being evaluated right now.
CREATE TABLE IF NOT EXISTS "github_status_key_leases" (
  "key" text PRIMARY KEY NOT NULL,
  "token" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL
);
