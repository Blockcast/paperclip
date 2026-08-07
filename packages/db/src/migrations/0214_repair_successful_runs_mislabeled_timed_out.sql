-- BLO-22922: opencode_k8s armed its 30-second log-exit grace timer at Job
-- start whenever timeoutSec was non-zero. Healthy Jobs later returned exit 0,
-- but the expired grace flag made Paperclip persist them as timed_out.
--
-- exit_code=0 and status=timed_out is contradictory under the repaired adapter
-- and the server-side invariant. Repair every historical occurrence, not just
-- Ally's latest regression window, so aggregate failure-rate metrics recover.
UPDATE "heartbeat_runs"
SET
	"status" = 'succeeded',
	"error" = NULL,
	"error_code" = NULL,
	"liveness_state" = NULL,
	"liveness_reason" = NULL,
	"result_json" = (
		COALESCE("result_json", '{}'::jsonb)
		- 'error'
		- 'message'
		- 'stopReason'
		- 'timeoutFired'
		- 'timeoutSource'
	) || '{"outcomeCorrection":{"issue":"BLO-22922","from":"timed_out","reason":"exit_code_0"}}'::jsonb
WHERE "status" = 'timed_out'
	AND "exit_code" = 0;
