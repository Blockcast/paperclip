-- PEN-6486 — the ladder now has a THIRD attendance term, so the caveat `008`
-- attached to this table is false.
--
-- WHY A WHOLE MIGRATION FOR A COMMENT, AGAIN. `008_attendance_read_path_note.sql`
-- ends its `COMMENT ON TABLE` with:
--
--   'CAVEAT: the ladder tests attendance as an armed monitor or a live
--    blockedBy edge ONLY -- parkedUntil is not consulted -- so a deliberately
--    parked row is recorded unattended_*.'
--
-- True when it was written, false from 2026-11-11. `008` is itself
-- checksum-frozen once applied (the host throws `Plugin migration checksum
-- mismatch` at worker startup if the file changes), so it is the same
-- no-adjacent-correction carrier `008` was written to repair in `007`, one
-- generation on. `COMMENT ON` is the sanctioned channel for exactly this —
-- `validatePluginMigrationStatement` admits `comment` beside `create` and
-- `alter`, with carve-outs in the qualified-reference checks — and it puts the
-- correction where a reader of the TABLE lands (`\d+`, `obj_description()`)
-- rather than only where a reader of this repo lands. It changes no schema, no
-- data and no behaviour.
--
-- WHAT CHANGED, AND WHY IT WAS NOT ALREADY COVERED. The `parkedUntil` blindness
-- was documented — in `src/attendance-read.ts` twice, and in `008` above — and
-- every one of those sites described it as a REPORTING caveat on the READ path.
-- None asked what the LADDER does with the same predicate. It escalated: it
-- climbed rungs and minted a founder-assigned `[user-cover]` over rows that were
-- deliberately parked and attended. Measured on PEN-6294, parked
-- 2026-11-10T16:18:51Z to 2026-11-16T10:00Z with rung 2 answered and recorded in
-- its own park reason; cover PEN-6464 was minted 7h53m inside that park and sat
-- `todo` with zero comments.
--
-- ⚠️ A reader who opens `007` or `008` alone still sees a stale sentence. Both
-- are frozen; README.md names them as known-stale carriers. This is the third
-- such correction on one table, and the pattern is the point: a `--` comment in
-- an applied plugin migration is write-once, so put falsifiable claims in
-- `COMMENT ON`, which has a successor channel, and not in the header, which has
-- none.

COMMENT ON TABLE plugin_alertmanager_184163d1ba.alert_attendance_observations IS
  'PEN-2918: one row per escalation-ladder attendance determination. '
  'Appended per determination over an already-open alert row -- NOT per alert row created. '
  'Read-only HTTP routes expose it as of 2026-11-07 (PEN-2918 (D)): GET attendance-observations/summary '
  'and GET attendance-observations/undelivered, both board-or-agent and company-scoped. '
  'This SUPERSEDES the header of migration 007, which states that no route or SDK read exists, '
  'and the CAVEAT in migration 008, which states that parkedUntil is not consulted; '
  'both files are checksum-frozen once applied and cannot be edited. '
  'Nothing polls these routes and nothing alerts on them: the record is readable, not binding. '
  'ATTENDANCE TEST, from 2026-11-11 (PEN-6486): an armed monitor, a live blockedBy edge, '
  'or a live deliberate park. The park term is BOUNDED -- a park holds a rung for a fixed '
  'number of escalation intervals from parkedAt, after which the ladder proceeds over a live '
  'park and the row is recorded unattended_* again. '
  'Rows are append-only and never rewritten, so a window reaching before 2026-11-11 also contains '
  'unattended_* rows written by the earlier two-term test, which could not see a park at all; '
  'the earliest attended_park row dates that boundary from the table itself.';

COMMENT ON COLUMN plugin_alertmanager_184163d1ba.alert_attendance_observations.disposition IS
  'The ladder determination, in the ladder vocabulary. attended_monitor (PEN-4337), '
  'attended_blocker (BLO-40673), attended_park (PEN-6486), unattended_rung, unattended_cover, '
  'held_alert_clear (BLO-40739). Deliberately unconstrained text so a later ladder branch can '
  'record a determination no migration anticipated -- migration 007 says so and this is the first '
  'use of that allowance. '
  'attended_park is evaluated LAST, behind both older mechanisms, so it never absorbs a '
  'determination that would previously have read attended_monitor or attended_blocker. It DOES '
  'absorb some held_alert_clear: the deferral returns before the Alertmanager liveness read, so a '
  'park-only row whose alert has silently cleared now records attended_park instead. Behaviour is '
  'identical -- both re-arm the same rung one interval out and neither reassigns -- but read the '
  'before/after as attended_park against unattended_rung PLUS held_alert_clear, never against '
  'unattended_rung alone.';
