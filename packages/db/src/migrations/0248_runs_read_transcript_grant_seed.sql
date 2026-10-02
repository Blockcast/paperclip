-- PEN-3142: seed the `runs:read_transcript` grant so the transcript reads that
-- are demonstrably load-bearing keep working the moment the narrowing lands.
--
-- WHY THESE PRINCIPALS. The `heartbeat.run_log_accessed` audit was counted over
-- a trailing window before this change (the sizing the PEN-3140 decision asked
-- for). Every agent transcript read in the sample came from the CTO agent, and
-- ALL of them were out-of-chain: the CTO was root-causing a `claude_local`
-- failure class against two built-in agents (Reflection Coach, Summarizer) that
-- report to the CEO, not to the CTO. Manager chain is the wrong shape for
-- incident root-cause, which follows a failure class rather than a reporting
-- line — so without a seeded grant this change would have broken the one
-- workflow the audit shows actually exists.
--
-- Scoped to `ceo` / `cto` role agents, matching how 0171 seeded the `tools:*`
-- keys. It is not a re-opening: a CEO already reaches its whole subtree through
-- the manager chain, and every other agent role gets own-run plus its own
-- reports and nothing more. Deliberately NOT seeded to `pending_approval` /
-- `terminated` agents or to any non-executive agent role.
--
-- AGENTS ONLY, DELIBERATELY. An earlier revision of this file also seeded human
-- members with `membership_role IN ('owner','admin')`. Those rows were
-- unreachable (Ally review 5375217878): `req.actor.type` is only
-- `none` / `agent` / `board`, so a human never reaches the grant fallback that
-- would read them, and the human set is decided directly by
-- `TRANSCRIPT_OPERATOR_MEMBERSHIP_ROLES` in `server/src/routes/authz.ts`. Two
-- places naming the human operator set — and naming it differently — is how the
-- next reader ends up fixing one and not the other. The gate is now the single
-- place; this migration stays silent about humans.
--
-- A `viewer` or `member` human who genuinely needs transcript read is granted
-- `runs:read_transcript` explicitly: the gate falls through to the decider for
-- any board actor outside the operator roles, so a grant admits them.
--
-- POINT IN TIME. This is a one-shot seed with no role-based fallback at
-- decision time, so an agent promoted to `ceo` / `cto` AFTER this migration
-- runs gets no grant and falls back to own-run plus manager chain. For a CEO
-- that is nearly equivalent (the subtree is already reachable); for a later CTO
-- it is materially narrower. Re-seeding is manual — grant
-- `runs:read_transcript` to the new principal.
INSERT INTO "principal_permission_grants" (
  "company_id",
  "principal_type",
  "principal_id",
  "permission_key",
  "scope",
  "granted_by_user_id",
  "created_at",
  "updated_at"
)
SELECT
  agents."company_id",
  'agent',
  agents."id",
  'runs:read_transcript',
  NULL,
  NULL,
  now(),
  now()
FROM "agents"
WHERE agents."role" IN ('ceo', 'cto')
  AND agents."status" NOT IN ('pending_approval', 'terminated')
ON CONFLICT ("company_id", "principal_type", "principal_id", "permission_key") DO NOTHING;
