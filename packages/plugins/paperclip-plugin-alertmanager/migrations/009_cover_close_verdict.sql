-- PEN-6236 — two defects in the `[user-cover]` artifact, one table change.
--
-- ## Defect A: the cover is cancelled while its source alert is mid-`for:`
--
-- `DEFAULT_COVER_CLOSE_HOLD_MINUTES` is 15, and the hold's own design note
-- says "a re-fire inside the hold reopens membership". A re-fire cannot
-- arrive before `for:` has re-accumulated: when a rule group is replaced at a
-- Prometheus config reload `activeAt` is discarded, the alert re-enters
-- `pending`, and the earliest permitted re-fire is `activeAt + for`. So the
-- reopen branch is reachable only when `resolve_delivery_lag + hold > for`.
-- Measured live 2026-11-09 over 1199 loaded alerting rules: median `for:` is
-- 900 s — exactly the hold — and 347 (28.9 %) exceed it, to a maximum of 72 h,
-- with `keep_firing_for > 0` on only 24 of them. All six alertnames that have
-- actually minted a cover carry `keep_firing_for: 0`, and three of the six
-- (1800 s, 3600 s, 3600 s) sit past the hold outright.
--
-- Lengthening the hold is NOT the fix and is excluded by measurement: it would
-- have to exceed the longest source `for:`, which is unbounded at 72 h on this
-- estate, and a 72-hour hold re-creates BLO-42259's precursor defect in the
-- opposite direction — a genuinely resolved cover that never closes.
--
-- `alertname` is what lets the close path ask Prometheus the one question
-- Alertmanager cannot answer. Alertmanager has no representation of `pending`;
-- Prometheus does, and its `ALERTS` series carries both `pending` and
-- `firing`, so presence in either state means the condition has not cleared.
-- Every liveness path in this plugin reads `/api/v2/alerts` and nothing else,
-- so the close was blind to exactly the state that makes it wrong.
--
-- The column is carried on the cover rather than parsed out of
-- `dedup_fingerprint` at read time. Every member of a cover shares one
-- alertname by construction (the fingerprint IS `cover:<alertname>:<bucket>`,
-- and joining requires a fingerprint match), so the value is well defined —
-- but re-deriving it by string surgery on every close would make a format
-- change to the fingerprint silently break the guard, in the fail-open
-- direction.
--
-- ## Defect B: a closed cover's record cannot say WHY it closed
--
-- Today every close emits the identical sentence, so "the condition genuinely
-- cleared" and "alert state was discarded while the condition held" are the
-- same row. The 9 covers closed up to 2026-11-09 cannot be partitioned and
-- defect A is invisible in the record that would show it.
--
-- `attendance_observations` (PEN-2918, migration 007) was considered first and
-- is the wrong home: it is keyed on `alert_issue_id` and its disposition
-- vocabulary records what the LADDER observed about an ALERT row. A close
-- verdict is a fact about a COVER row, and this table is the cover lifecycle
-- table — already carrying `closing_claimed_at`,
-- `resolution_comment_posted_at` and `cancelled_at`. Three columns here add no
-- store; a parallel row in 007 would add a second one.
--
-- Plugin migrations may not contain destructive statements, so this is
-- additive only.

ALTER TABLE plugin_alertmanager_184163d1ba.alert_escalation_covers
  ADD COLUMN alertname text,
  ADD COLUMN close_verdict text,
  ADD COLUMN close_verdict_detail text,
  ADD COLUMN close_deferral_count integer NOT NULL DEFAULT 0,
  ADD COLUMN last_close_deferral_at timestamptz;

-- Backfill from the dedup fingerprint, whose format is `cover:<alertname>:<n>`
-- where `<n>` is the window bucket. The `.*` is greedy and the `[0-9]+$` is
-- anchored, so an alertname containing a colon still resolves correctly; a
-- fingerprint in any other shape is left NULL rather than guessed, and a NULL
-- alertname is handled by the close path as "no pending check is possible",
-- which is a named verdict rather than a silent pass.
UPDATE plugin_alertmanager_184163d1ba.alert_escalation_covers
  SET alertname = substring(dedup_fingerprint from '^cover:(.*):[0-9]+$')
  WHERE alertname IS NULL AND dedup_fingerprint ~ '^cover:.*:[0-9]+$';

-- Defect B's successor lookup: "the most recent closed cover for this
-- alertname", run once per cover mint. Ordered by `cancelled_at DESC` so the
-- index serves the ORDER BY as well as the filter.
CREATE INDEX alert_escalation_covers_alertname_closed_idx
  ON plugin_alertmanager_184163d1ba.alert_escalation_covers (company_id, alertname, cancelled_at DESC)
  WHERE alertname IS NOT NULL AND cancelled_at IS NOT NULL;
