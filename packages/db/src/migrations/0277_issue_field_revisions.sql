-- PEN-5876: a compare-and-set and an audit trail for the scalar text fields of
-- an issue.
--
-- `paperclipUpsertIssueDocument` has had `baseRevisionId` (optimistic
-- concurrency) and `document_revisions` (history) since the beginning. The
-- issue `description` -- which is where `Done when` checklists live, i.e. the
-- single field two runs of one seat are most likely to edit concurrently -- had
-- neither. Two runs therefore overwrote each other silently, and the sharper
-- half is that a lost update was UNOBSERVABLE AFTER THE FACT: with no history
-- there was nothing to adjudicate whether a run's claimed edit had been
-- clobbered or had simply never been written.
--
-- The gap sits in `updateIssueSchema`, one level ABOVE any individual field, so
-- `title` races identically. This records the whole field set rather than
-- `description` alone; a description-only history would force a second shape
-- the moment anyone noticed.
--
-- `created_by_run_id` is not decoration. The second measured instance was a
-- write that landed and announced itself on no row at all, where "did I lose?"
-- was never the open question and "whose text is this?" was. Attribution
-- survived there only because the author happened to self-attribute in prose
-- and `execution_run_id` happened not to have been released yet -- both luck,
-- neither a record. Mirrors `document_revisions`, which already carries exactly
-- this triple.
CREATE TABLE IF NOT EXISTS "issue_field_revisions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "issue_id" uuid NOT NULL REFERENCES "issues"("id") ON DELETE CASCADE,
  "revision_number" integer NOT NULL,
  "title" text,
  "description" text,
  "change_summary" text,
  "created_by_agent_id" uuid REFERENCES "agents"("id") ON DELETE SET NULL,
  "created_by_user_id" text,
  "created_by_run_id" uuid REFERENCES "heartbeat_runs"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- Both indexes are created on a table this migration just created empty, so
-- neither needs CONCURRENTLY.
CREATE UNIQUE INDEX IF NOT EXISTS "issue_field_revisions_issue_revision_uq"
  ON "issue_field_revisions" ("issue_id", "revision_number");

CREATE INDEX IF NOT EXISTS "issue_field_revisions_company_issue_created_idx"
  ON "issue_field_revisions" ("company_id", "issue_id", "created_at");

-- The pointer that makes the precondition a real compare-and-set: the equality
-- is repeated in the UPDATE's WHERE clause, so it is re-evaluated against the
-- latest row version when the statement blocks on a concurrent transaction.
-- Comparing only against the row the route read would leave exactly the window
-- this migration exists to close.
--
-- Deliberately no FK to `issue_field_revisions`, matching
-- `documents.latest_revision_id`, so the two tables carry no circular
-- reference.
--
-- `issues` is a large table, so both adds are metadata-only: a nullable column
-- with no default, and a NOT NULL column whose DEFAULT is stored in the catalog
-- rather than rewritten into every row (Postgres 11+). 0 means "never revised";
-- the first guarded field write seeds a baseline revision from the pre-write
-- text, so the oldest recoverable state is not lost on rows that predate this.
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "latest_field_revision_id" uuid;
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "latest_field_revision_number" integer DEFAULT 0 NOT NULL;
