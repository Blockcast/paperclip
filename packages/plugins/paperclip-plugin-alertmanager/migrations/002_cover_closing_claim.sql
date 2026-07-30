-- BLO-16120 PR #662 review fix: `resolution_comment_posted_at` was doing two
-- jobs at once — "won the atomic claim to close this cover" (set BEFORE the
-- audit comment is attempted, to serialize concurrent closers) and "the
-- audit comment durably landed" (the fact its own name claims). If
-- `ctx.issues.createComment` threw after the claim UPDATE committed, the row
-- still read as "comment posted" and the sweep's stuck-cover reconciliation
-- pass finalized the cover (cancelled it) with zero audit comment ever
-- posted, and never retried the comment. Split the two into separate columns
-- so the claim can be won before the side effect it gates completes.
--
-- Plugin migrations may not contain destructive statements (no DROP/TRUNCATE),
-- so the now-superseded `alert_escalation_covers_pending_finalize_idx` index
-- (keyed on resolution_comment_posted_at) is left in place rather than
-- dropped; it simply goes unused going forward.

ALTER TABLE plugin_alertmanager_184163d1ba.alert_escalation_covers
  ADD COLUMN closing_claimed_at timestamptz;

-- Backfill: every cover that already has resolution_comment_posted_at set
-- was, under the pre-migration code, claimed at that same instant (the two
-- were the same UPDATE).
UPDATE plugin_alertmanager_184163d1ba.alert_escalation_covers
  SET closing_claimed_at = resolution_comment_posted_at
  WHERE resolution_comment_posted_at IS NOT NULL AND closing_claimed_at IS NULL;

-- Backstop index for the sweep's reconciliation pass, now keyed on the claim
-- (not the comment): a cover that won the claim but never finished — whether
-- because the comment never landed or the terminal transition never ran —
-- is durable retry work.
CREATE INDEX alert_escalation_covers_pending_claim_idx
  ON plugin_alertmanager_184163d1ba.alert_escalation_covers (cover_issue_id)
  WHERE closing_claimed_at IS NOT NULL AND cancelled_at IS NULL;
