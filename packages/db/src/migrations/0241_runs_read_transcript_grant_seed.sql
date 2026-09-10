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
-- Scoped to `ceo` / `cto` role agents and to owner/admin human members, matching
-- how 0171 seeded the `tools:*` keys. It is not a re-opening: a CEO already
-- reaches its whole subtree through the manager chain, and every other agent
-- role gets own-run plus its own reports and nothing more.
--
-- Deliberately NOT seeded to `viewer` members, to `pending_approval` /
-- `terminated` agents, or to any non-executive agent role. Operators who need
-- to widen this should grant `runs:read_transcript` explicitly.
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
  memberships."company_id",
  memberships."principal_type",
  memberships."principal_id",
  'runs:read_transcript',
  NULL,
  NULL,
  now(),
  now()
FROM "company_memberships" memberships
WHERE memberships."principal_type" = 'user'
  AND memberships."status" = 'active'
  AND memberships."membership_role" IN ('owner', 'admin')
ON CONFLICT ("company_id", "principal_type", "principal_id", "permission_key") DO NOTHING;--> statement-breakpoint

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
