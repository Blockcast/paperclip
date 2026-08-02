-- BLO-20396 (review follow-up): index the recovery dispatch lane.
--
-- Migration 0208 gave the dispatcher's main keyset scan an index. It did not
-- help priority lane B, which selects recovery-action wakes:
--
--   SELECT * FROM heartbeat_runs
--    WHERE agent_id = $1 AND status = 'queued' [AND created_at >= $cutoff]
--      AND context_snapshot ->> 'source' = 'issue_recovery_action'
--      AND context_snapshot ->> 'recoveryActionId' IS NOT NULL
--    ORDER BY created_at ASC, id ASC
--    LIMIT $scanLimit
--
-- Both JSON predicates are unindexed expressions, so 0208's index supplies the
-- agent's queued rows in dispatch order and the executor filters them one by
-- one. When the agent has NO recovery work — the overwhelmingly common case —
-- there is nothing for the LIMIT to stop early on, so PostgreSQL walks the
-- agent's entire queued set to return zero rows, and it does that while the
-- strict per-agent start lock is held. Ally reached 339 queued rows during the
-- incident this ticket came from; the cost is O(agent queue depth) on every
-- dispatch pass, which is the same defect shape as the company-wide issue scan
-- 0208's lane split removed, one level down.
--
-- A partial index on the lane's own predicate makes the zero-match case O(1):
-- the index contains only recovery rows, so "this agent has no recovery work"
-- is answered by an empty index range rather than by a filtered walk. It is
-- also very small — recovery wakes are a thin slice of a queue that is itself a
-- thin slice of the table (~850 dispatchable rows out of ~219k).
--
-- Only `queued` is included, unlike 0208's `('queued','scheduled_retry')`: this
-- lane never reads scheduled_retry, and a tighter predicate keeps the index
-- smaller. `status` is consequently NOT a key column — it is constant across
-- every entry — so the keys are exactly the columns the lane orders and seeks
-- on. `recoveryActionId IS NOT NULL` is deliberately left OUT of the index
-- predicate too: it stays a post-filter, but now over an already-tiny set of
-- recovery rows rather than over the whole queue, and omitting it keeps the
-- predicate simple enough for the planner to match reliably.
--
-- `context_snapshot` is jsonb, so `->>` is IMMUTABLE and legal in an index
-- predicate. (Were it json, `->>` would be merely STABLE and this would be
-- rejected. Migration 0079 relies on the same property for its generated
-- columns.) A generated stored column plus a plain index would be the other
-- option and is how 0079 handles hot keys, but adding one now would rewrite a
-- 1.8 GB hot table under AccessExclusive; a partial index can be built
-- concurrently instead, so it is the cheaper route to the same plan.
--
-- Drizzle migrations are transactional, so CONCURRENTLY is unavailable here and
-- a plain CREATE INDEX would hold a SHARE lock on that hot table for the whole
-- build. The guard below therefore makes online precreation a required and
-- verified prerequisite, exactly as 0208 does: a populated database fails with
-- the command to run, and a precreated index that does not match this
-- definition is rejected rather than silently accepted. Empty databases (tests,
-- bootstrap) build it inline, where there is nothing to block.
--
-- On the predicate check: the key-column list is compared exactly, and so is
-- the WHERE clause — but only after both sides are pushed through the SAME
-- canonicalization (delete every whitespace character, every `::cast`
-- annotation and every parenthesis). Comparing the raw rendering against one
-- hardcoded pretty-printed string would be brittle: PostgreSQL picks its own
-- parenthesization and cast annotations, and guessing them wrong fails the
-- migration for an operator who precreated the index CORRECTLY. Canonicalizing
-- removes exactly those degrees of freedom and nothing else, so an equivalent
-- rendering still passes while the comparison stays exact.
--
-- Case is deliberately NOT folded away. `=` on text is case-sensitive, so
-- `... = 'ISSUE_RECOVERY_ACTION'` is a predicate that matches no row at all and
-- would leave the lane reading a permanently empty index; lowercasing before
-- comparing would make that typo look identical to the real thing. Keeping case
-- costs nothing legitimate, because pg_get_expr renders keywords upper (AND)
-- and identifiers lower, which is exactly how the expected string is written.
--
-- This replaced a check that asserted three independent LIKE substring matches
-- (`status = 'queued'`, the `->> 'source'` extraction, the
-- 'issue_recovery_action' constant). That shape is fail-OPEN: it proves the
-- tokens are PRESENT, not that they are combined the way the lane needs. Both
-- of these satisfy all three substring checks and are wrong:
--
--   status = 'queued' OR (context_snapshot ->> 'source') = 'issue_recovery_action'
--     -- indexes every queued row, restoring the whole-queue walk 0209 removes
--   status = 'queued' AND (context_snapshot ->> 'source') <> 'issue_recovery_action'
--     -- indexes the complement: the lane's own rows are the ones left out
--
-- and so does the canonical predicate with any extra clause ANDed on, and so
-- does a wrong-CASE constant. Equality against the canonical form is
-- fail-CLOSED instead: the expected token stream contains `and`, two `=` and
-- the exact constant spellings, so an `OR`, a `<>`/`!=`, an added clause or a
-- miscased literal cannot reproduce it. Deleting parentheses is safe precisely
-- BECAUSE the expected form contains no OR — with a single AND there is no
-- operator precedence left for them to disambiguate, so they carry no meaning
-- to lose.
--
-- When the check does reject, the exception reports the canonicalized predicate
-- it found beside the one it wanted (and the raw rendering in DETAIL), so an
-- unanticipated rendering difference is diagnosable from the failure text
-- instead of being a blind wall — which was the original objection to matching
-- the predicate exactly.
--
-- For reference, `pg_get_expr(indpred, indrelid, TRUE)` was MEASURED on a real
-- PostgreSQL after this migration ran (not assumed) as:
--
--   status = 'queued'::text AND (context_snapshot ->> 'source'::text) = 'issue_recovery_action'::text
--
-- Note it parenthesizes the second operand but not the first, and annotates
-- both the operator's argument and its result with ::text — which is exactly
-- the kind of detail a hand-written expected string tends to get wrong, and
-- exactly what the canonicalization erases before comparing.
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: guarded below so non-empty databases must precreate the index concurrently.
DO $$
DECLARE
  raw_predicate text;
  canonical_predicate text;
  canonical_expected text;
BEGIN
  IF to_regclass('public.heartbeat_runs_recovery_dispatch_idx') IS NOT NULL THEN
    SELECT coalesce(pg_get_expr(index_metadata.indpred, index_metadata.indrelid, TRUE), '')
      INTO raw_predicate
      FROM pg_index AS index_metadata
     WHERE index_metadata.indexrelid = to_regclass('public.heartbeat_runs_recovery_dispatch_idx');

    -- Run the found predicate and the definition this migration creates through
    -- one shared canonicalization so the comparison below can be an equality
    -- test: drop `::cast` annotations (optionally schema-qualified), drop
    -- parentheses, drop all whitespace. Every token that carries meaning — the
    -- operators, the AND, the column, the constants — survives, CASE INCLUDED.
    -- Case is deliberately NOT folded: `=` on text is case-sensitive in
    -- PostgreSQL, so an index predicated on 'ISSUE_RECOVERY_ACTION' matches
    -- zero rows and would hand the lane a permanently empty index. Folding case
    -- would make that typo indistinguishable from the real predicate. Nothing
    -- legitimate is lost by keeping case: pg_get_expr renders keywords upper
    -- (AND) and identifiers lower, which is how the expected string below is
    -- written, and the migration test asserts both halves of that empirically.
    SELECT
      max(canonical.predicate) FILTER (WHERE candidate.kind = 'found'),
      max(canonical.predicate) FILTER (WHERE candidate.kind = 'expected')
      INTO canonical_predicate, canonical_expected
      FROM (VALUES
              ('found', coalesce(raw_predicate, '')),
              ('expected',
               'status = ''queued'' AND (context_snapshot ->> ''source'') = ''issue_recovery_action''')
           ) AS candidate(kind, expression)
      CROSS JOIN LATERAL (
        SELECT regexp_replace(
                 regexp_replace(
                   translate(candidate.expression, '()', ''),
                   '::(?:[a-zA-Z_][a-zA-Z0-9_]*\.)?[a-zA-Z_][a-zA-Z0-9_]*', '', 'g'),
                 '\s+', '', 'g')
      ) AS canonical(predicate);

    IF NOT EXISTS (
      SELECT 1
      FROM pg_index AS index_metadata
      JOIN pg_class AS index_relation
        ON index_relation.oid = index_metadata.indexrelid
      JOIN pg_am AS access_method
        ON access_method.oid = index_relation.relam
      WHERE index_metadata.indexrelid = to_regclass('public.heartbeat_runs_recovery_dispatch_idx')
        AND index_metadata.indrelid = 'public.heartbeat_runs'::regclass
        AND index_metadata.indisvalid
        AND access_method.amname = 'btree'
        AND index_metadata.indnkeyatts = 3
        AND index_metadata.indnatts = 3
        AND ARRAY(
          SELECT pg_get_indexdef(index_metadata.indexrelid, key_position, TRUE)
          FROM generate_series(1, index_metadata.indnkeyatts) AS key_position
          ORDER BY key_position
        ) = ARRAY['agent_id', 'created_at', 'id']
        AND index_metadata.indoption = '0 0 0'::int2vector
        AND canonical_predicate = canonical_expected
    )
    THEN
      RAISE EXCEPTION USING
        MESSAGE = 'migration 0209 found an invalid or incorrectly defined prerequisite index',
        DETAIL = format('index predicate as rendered by PostgreSQL: %L', coalesce(raw_predicate, '')),
        HINT = format(
          'Run DROP INDEX CONCURRENTLY IF EXISTS heartbeat_runs_recovery_dispatch_idx; then CREATE INDEX CONCURRENTLY heartbeat_runs_recovery_dispatch_idx ON heartbeat_runs USING btree (agent_id, created_at, id) WHERE status = ''queued'' AND (context_snapshot ->> ''source'') = ''issue_recovery_action''; then retry migrations. Canonicalized predicate found: %L; expected: %L (canonicalization drops casts, parentheses and whitespace; case is significant).',
          coalesce(canonical_predicate, ''),
          coalesce(canonical_expected, ''));
    END IF;
  ELSE
    IF EXISTS (SELECT 1 FROM "heartbeat_runs" LIMIT 1) THEN
      RAISE EXCEPTION USING
        MESSAGE = 'migration 0209 requires online index precreation',
        HINT = 'Run CREATE INDEX CONCURRENTLY IF NOT EXISTS heartbeat_runs_recovery_dispatch_idx ON heartbeat_runs USING btree (agent_id, created_at, id) WHERE status = ''queued'' AND (context_snapshot ->> ''source'') = ''issue_recovery_action'', then retry migrations.';
    END IF;

    -- Close the gap between the empty-table check and CREATE INDEX without
    -- taking this lock on populated production tables.
    LOCK TABLE "heartbeat_runs" IN SHARE MODE;
    IF EXISTS (SELECT 1 FROM "heartbeat_runs" LIMIT 1) THEN
      RAISE EXCEPTION USING
        MESSAGE = 'migration 0209 requires online index precreation',
        HINT = 'Run CREATE INDEX CONCURRENTLY IF NOT EXISTS heartbeat_runs_recovery_dispatch_idx ON heartbeat_runs USING btree (agent_id, created_at, id) WHERE status = ''queued'' AND (context_snapshot ->> ''source'') = ''issue_recovery_action'', then retry migrations.';
    END IF;

    CREATE INDEX "heartbeat_runs_recovery_dispatch_idx"
      ON "heartbeat_runs" USING btree (
        "agent_id",
        "created_at",
        "id"
      )
      WHERE "status" = 'queued'
        AND ("context_snapshot" ->> 'source') = 'issue_recovery_action';
  END IF;
END
$$;
