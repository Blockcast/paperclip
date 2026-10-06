-- BLO-22922 follow-up: migration 0214 was a silent no-op in production.
--
-- 0214 gated the repair on a live join to mutable current agent state:
--
--   FROM "agents" AS "agent"
--   WHERE "agent"."id" = "run"."agent_id"
--     AND "agent"."adapter_type" = 'opencode_k8s'
--
-- The only affected agent (Ally) was moved off opencode_k8s to claude_k8s on
-- 2026-08-12, six days before 0214 finally shipped on 2026-08-18. By the time
-- the statement ran, no agent row still read 'opencode_k8s', so it matched zero
-- rows, reported success, and left every mislabelled run untouched. Verified
-- post-deploy: sampled exit-zero timeout rows from 2026-08-06..08 still read
-- status='timed_out' and carry no outcomeCorrection stamp.
--
-- A historical data repair must not depend on present-day agent configuration.
-- The row-level predicate below is self-identifying and is retained verbatim
-- from 0214: exit_code = 0 alongside status='timed_out' AND error_code='timeout'
-- is contradictory on its face -- a process that exited 0 did not hit its
-- deadline -- and the payload guard still leaves any row carrying a real
-- adapter or publication error as 'failed'/'timed_out' for an operator.
--
-- Idempotent: rows repaired by 0214 are already status='succeeded' and no longer
-- match, so re-running is a no-op.
-- paperclip:migration-safety-ignore full-table-mutation-large-table: repaired_runs yields only affected wake IDs, and the update joins by primary key (~689 production rows measured).
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
			?| ARRAY[
				'error', 'errors', 'errorMessage', 'errorCode',
				'message', 'result', 'summary',
				'is_error', 'isError', 'success', 'ok',
				'type', 'subtype', 'status', 'outcome', 'stop_reason'
			]
		)
	RETURNING "run"."wakeup_request_id"
)
UPDATE "agent_wakeup_requests" AS "wake"
SET
	"status" = 'completed',
	"error" = NULL
FROM "repaired_runs"
WHERE "wake"."id" = "repaired_runs"."wakeup_request_id"
	AND "wake"."status" = 'timed_out';
