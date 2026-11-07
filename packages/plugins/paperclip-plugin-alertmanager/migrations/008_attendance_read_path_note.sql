-- PEN-2918 (D) — correct, at the table itself, a claim `007` can no longer make.
--
-- WHY A WHOLE MIGRATION FOR A COMMENT. `007_attendance_observations.sql` says
-- in its header: "There is deliberately no route or SDK read for it —
-- 'queryable in the plugin namespace' is the whole claim." Two read-only routes
-- now expose it (`src/attendance-read.ts`), so that sentence is false.
--
-- It cannot be edited. The host sha256-checksums every applied plugin migration
-- and throws `Plugin migration checksum mismatch` at worker startup if the file
-- changes, so `007` is frozen for every company that has already applied it —
-- and the text that is wrong is a `--` comment, which no later statement can
-- rewrite. That makes `007`'s header a carrier that admits NO adjacent
-- correction: one slot, no successor, no edit, no thread.
--
-- `COMMENT ON` is the exception, and it is sanctioned rather than smuggled: the
-- host's migration validator admits `comment` alongside `create` and `alter`,
-- with two explicit carve-outs for it in the fully-qualified-reference checks
-- (`validatePluginMigrationStatement`). So this is the one channel that puts
-- the correction where a reader of the TABLE lands — `\d+`, `obj_description()`
-- — rather than only where a reader of this repo lands. It changes no schema,
-- no data and no behaviour.
--
-- ⚠️ A reader who opens `007` alone still sees the stale sentence. That is
-- recorded in README.md as a known-stale carrier rather than papered over;
-- there is no way to repair it in place, and pretending otherwise would be
-- worse than naming it.

COMMENT ON TABLE plugin_alertmanager_184163d1ba.alert_attendance_observations IS
  'PEN-2918: one row per escalation-ladder attendance determination. '
  'Appended per determination over an already-open alert row -- NOT per alert row created. '
  'Read-only HTTP routes expose it as of 2026-11-07 (PEN-2918 (D)): GET attendance-observations/summary '
  'and GET attendance-observations/undelivered, both board-or-agent and company-scoped. '
  'This SUPERSEDES the header of migration 007, which states that no route or SDK read exists; '
  'that file is checksum-frozen once applied and cannot be edited. '
  'Nothing polls these routes and nothing alerts on them: the record is readable, not binding. '
  'CAVEAT: the ladder tests attendance as an armed monitor or a live blockedBy edge ONLY -- '
  'parkedUntil is not consulted -- so a deliberately parked row is recorded unattended_*.';

COMMENT ON COLUMN plugin_alertmanager_184163d1ba.alert_attendance_observations.subject_agent_id IS
  'The agent the determination was ABOUT, not in general an agent who was notified. '
  'On attended_* it is the attendee, who was deliberately NOT woken; on unattended_cover the board '
  'was notified and this agent was not. Read wake_outcome to tell the cases apart.';

COMMENT ON COLUMN plugin_alertmanager_184163d1ba.alert_attendance_observations.wake_outcome IS
  'enqueued = the host ACCEPTED the wake, and nothing more -- not that a run started, never acknowledgement. '
  'refused = requestWakeup threw. declined = it resolved queued:false, the larger and quieter half. '
  'not_attempted = this branch raises no wake. Query refused AND declined together for undelivered wakes.';
