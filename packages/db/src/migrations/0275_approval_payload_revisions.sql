-- PEN-5766: let a requester correct a PENDING card's payload in place, instead of
-- the withdraw-and-refile that was previously its only move.
--
-- Why this is a correctness fix and not ergonomics: a re-file mints a new row with
-- a new `created_at`, and board service is measurably recency-skewed (PEN-3918 cmt
-- `d00b4081` §4 — the 11-03 burst decided 17 cards, 16 of which were created later
-- than the oldest card it left pending). So "correct my stale evidence" and "jump
-- ahead of cards that have waited longer" were the same keystroke, and a filer who
-- was scrupulous about accuracy paid for it out of other filers' queue position.
-- An in-place edit touches neither `created_at` nor row identity.
--
-- The edit marker is two columns rather than a derived count, so a reader of the
-- card does not have to join to learn that what they are looking at is not what was
-- filed. `payload_revision = 0` is exactly "never edited", which is what every
-- existing row is and why the default backfills correctly.
ALTER TABLE "approvals"
  ADD COLUMN IF NOT EXISTS "payload_revision" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "payload_edited_at" timestamp with time zone;

-- Superseded payloads. `payload` is the PRIOR value and `revision` is the number
-- that value held, so the first edit archives revision 0 and leaves the card at 1.
-- The live payload stays solely on `approvals` — keeping a second copy of the
-- current value here is how the two come to disagree.
CREATE TABLE IF NOT EXISTS "approval_payload_revisions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "approval_id" uuid NOT NULL REFERENCES "approvals"("id") ON DELETE CASCADE,
  "revision" integer NOT NULL,
  "payload" jsonb NOT NULL,
  "edited_by_agent_id" uuid REFERENCES "agents"("id") ON DELETE SET NULL,
  "edited_by_user_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "approval_payload_revisions_approval_revision_idx"
  ON "approval_payload_revisions" ("approval_id", "revision");

CREATE INDEX IF NOT EXISTS "approval_payload_revisions_company_idx"
  ON "approval_payload_revisions" ("company_id");

-- Backstop for two concurrent edits of one card. The UPDATE that applies an edit
-- carries a `payload_revision` guard in the same transaction, so the race is
-- already decided there; this turns any path that slipped past it into a refusal
-- rather than a forked history.
CREATE UNIQUE INDEX IF NOT EXISTS "approval_payload_revisions_approval_revision_unique_idx"
  ON "approval_payload_revisions" ("approval_id", "revision");
