-- PEN-6486 — the COMMENT ON COLUMN written by `012` overstates what the new
-- attendance term measures, so that comment is false and `012` is frozen.
--
-- WHAT IS WRONG. `012_attendance_park_disposition.sql` ends its
-- `COMMENT ON COLUMN ...disposition` with a claim that attended_park is
-- written IF AND ONLY IF the ladder would otherwise have ADVANCED A RUNG, and
-- that its count is therefore a direct before/after measure RATHER THAN A
-- RESHUFFLE BETWEEN BUCKETS.
--
-- The ordering half is true and is the half the tests pin: the park term is
-- evaluated behind both older mechanisms, so it can never absorb
-- attended_monitor or attended_blocker. The if-and-only-if and the
-- not-a-reshuffle are false. The park deferral returns AHEAD of the
-- Alertmanager liveness read — `hasLivePark` is consulted in
-- `advanceIssueLadder` before `readLiveness` runs — so a park-only row whose
-- alert has silently cleared now records attended_park where it previously
-- recorded held_alert_clear. That is a reshuffle between buckets, in the one
-- dimension the retired sentence denies.
--
-- THE LADDER BEHAVIOUR IS THE SAME; ONE THREAD-VISIBLE SIDE EFFECT IS NOT.
-- Both arms CAS the same `nextEscalationAt` one rung interval out and neither
-- reassigns or closes the row. They are not otherwise identical.
-- `holdLadderForClearedAlert` does two further things that the park arm, which
-- returns AHEAD of `readLiveness`, therefore skips: it posts the one-time
-- `NOT_FIRING_MARKER` notice to the issue, and it records
-- `alertLiveness: not_firing` where the park arm records `not_read`. So while a
-- park holds, a park-only row whose alert has silently cleared is NOT told so on
-- its own thread.
--
-- That notice is DEFERRED, not dropped: the marker dedups against the issue
-- comments, so the first pass taken after the park term goes false posts it if
-- the alert is still clear. The park term is bounded by `parkedUntil` and by
-- MAX_PARK_DEFERRAL_RUNGS intervals from `parkedAt`, whichever lapses first.
--
-- An earlier draft of this file said NOTHING OBSERVABLE MOVED. That is the
-- branch-enumeration miss the section below warns against, committed in the
-- file that warns against it: the comment post is a branch of the very arm
-- being absorbed, and it was not enumerated. Whether suppressing the notice for
-- the life of a park is the RIGHT behaviour is a live question and is NOT
-- settled here. Moving the park check behind `readLiveness` would restore the
-- notice at the cost of an Alertmanager read on park-only rows; that is a
-- behaviour change and belongs to PEN-6486, not to a comment-accuracy fix.
--
-- It still matters for measurement, which is what this file is for: the count
-- of attended_park is what PEN-6486 is to be re-measured on, and read against
-- unattended_rung alone it over-reports by however much it absorbed.
--
-- WHY A WHOLE MIGRATION FOR A COMMENT, FOR THE THIRD TIME. `012` is
-- checksum-frozen the moment it applies — the host hashes every plugin
-- migration file on startup and throws `Plugin migration checksum mismatch`
-- for every company that already applied it — so the file cannot be edited.
-- `COMMENT ON` is the sanctioned successor channel and the only one that
-- reaches a reader of the TABLE (`\d+`, `col_description()`) rather than only a
-- reader of this repo: `validatePluginMigrationStatement` admits `comment`
-- beside `create` and `alter`, with carve-outs in the qualified-reference
-- checks. This changes no schema, no data and no behaviour.
--
-- ⚠️ AUTHORING CONSTRAINT, MEASURED HERE AND NOT OBVIOUS FROM ANY OTHER FILE
-- IN THIS DIRECTORY: do not put an APOSTROPHE in a `--` header comment.
-- `stripSqlForKeywordScan` in `server/src/services/plugin-database.ts` strips
-- single-quoted STRING LITERALS before it strips `--` COMMENTS, so an
-- apostrophe in a header is parsed as a SQL quote. An ODD number of them
-- across the header shifts the quote parity, swallows the real statement, and
-- `normaliseSql` returns the empty string — at which point the
-- `^(create|alter|comment)` test fails and the host throws at worker startup
-- for every company. The first draft of this file had three and was refused.
-- Every applied migration in this directory happens to carry an even count, so
-- the landmine has never gone off and nothing in the repo warns of it.
--
-- ⚠️ THE PATTERN IS NOW THE POINT, AND `012` SAID SO ONE GENERATION EARLY.
-- `007` was corrected by `008`, `008` by `012`, and `012` by this file. Every
-- one of the four was a falsifiable claim about BEHAVIOUR written into a
-- carrier with no successor. `012` drew the right conclusion — put falsifiable
-- claims in `COMMENT ON`, which has a successor channel — and then wrote a
-- fresh one into a `COMMENT ON` it had no reason to expect to need correcting.
-- The channel being correctable is what makes this cheap; it is not what makes
-- the claim true. A claim about what a determination MEASURES is a claim about
-- every branch that can reach it, so enumerate the branches before writing it
-- down: here the branch that falsifies it is the `return` a few lines above the
-- one being described.
--
-- `008` and `012` remain readable and stale in this directory; README.md names
-- them as known-stale carriers for a reader who opens the raw `.sql`.
--
-- The COMMENT ON TABLE written by `012` is NOT superseded. It is accurate, and
-- it is deliberately left alone so that `obj_description()` keeps the
-- supersession chain for `007` and `008` that `012` established.

COMMENT ON COLUMN plugin_alertmanager_184163d1ba.alert_attendance_observations.disposition IS
  'The ladder determination, in the ladder vocabulary. attended_monitor (PEN-4337), '
  'attended_blocker (BLO-40673), attended_park (PEN-6486), unattended_rung, unattended_cover, '
  'held_alert_clear (BLO-40739). Deliberately unconstrained text so a later ladder branch can '
  'record a determination no migration anticipated -- migration 007 says so and attended_park is '
  'the first use of that allowance. '
  'attended_park is evaluated LAST, behind both older mechanisms, so it never absorbs a '
  'determination that would previously have read attended_monitor or attended_blocker. It DOES '
  'absorb some held_alert_clear: the deferral returns before the Alertmanager liveness read, so a '
  'park-only row whose alert has silently cleared now records attended_park instead. Ladder '
  'behaviour is the same -- both re-arm the same rung one interval out and neither reassigns -- '
  'but the two arms are NOT identical: held_alert_clear also posts the one-time not-firing notice '
  'to the issue and records alertLiveness not_read rather than not_firing, so while the park holds '
  'the cleared alert is not announced on the thread. The notice is deferred rather than dropped, '
  'because the first pass taken after the park term lapses posts it if the alert is still clear. '
  'Read the before/after as attended_park against unattended_rung PLUS held_alert_clear, never '
  'against unattended_rung alone. '
  'This SUPERSEDES the COMMENT ON COLUMN written by migration 012, which stated that attended_park '
  'is written if and only if the ladder would otherwise have ADVANCED A RUNG and that its count is '
  'therefore not a reshuffle between buckets; 012 is checksum-frozen once applied and cannot be '
  'edited.';
