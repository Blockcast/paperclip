-- BLO-22922: opencode_k8s armed its 30-second log-exit grace timer at Job
-- start whenever timeoutSec was non-zero. Healthy Jobs later returned exit 0,
-- but the expired grace flag made Paperclip persist them as timed_out.
--
-- Scope the repair to timeout-shaped records without result/error payloads. An
-- exit-zero row carrying some other adapter or publication error is ambiguous
-- and must remain failed for an operator to inspect.
-- paperclip:migration-safety-ignore full-table-mutation-large-table: repaired_runs yields only affected wake IDs, and the update joins by primary key (691 production rows measured).
WITH "repaired_runs" AS (
	UPDATE "heartbeat_runs" AS "run"
	SET
		"status" = 'succeeded',
		"error" = NULL,
		"error_code" = NULL,
		"liveness_state" = NULL,
		"liveness_reason" = NULL,
		"result_json" = (
			COALESCE("result_json", '{}'::jsonb)
			- 'stopReason'
			- 'timeoutFired'
			- 'timeoutSource'
		) || '{"outcomeCorrection":{"issue":"BLO-22922","from":"timed_out","reason":"exit_code_0"}}'::jsonb
	WHERE "run"."status" = 'timed_out'
		AND "run"."exit_code" = 0
		AND "run"."error_code" = 'timeout'
		AND ("run"."error" IS NULL OR "run"."error" ~ '^Timed out after [0-9]+s$')
		AND NOT (
			COALESCE("run"."result_json", '{}'::jsonb)
			?| ARRAY['error', 'message', 'result', 'summary']
		)
	RETURNING "run"."wakeup_request_id"
)
UPDATE "agent_wakeup_requests" AS "wake"
SET
	"status" = 'completed',
	"error" = NULL,
	"updated_at" = NOW()
FROM "repaired_runs"
WHERE "wake"."id" = "repaired_runs"."wakeup_request_id"
	AND "wake"."status" = 'timed_out';
