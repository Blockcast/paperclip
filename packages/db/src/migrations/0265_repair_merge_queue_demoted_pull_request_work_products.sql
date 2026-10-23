-- PEN-4553: repair the PR work products already demoted by the merge-queue
-- `dequeued` defect. Backfill companion to PEN-4550 (#2952, 8633c02), which
-- fixes the webhook path only.
--
-- A merge queue merges a PR via a `dequeued` event, not `closed`.
-- `github-webhook.ts` populates `prMerged` only for `action === "closed"`, so
-- before #2952 the event CARRYING the merge reached
-- `pullRequestWorkProductStatus` with no merge flag and mapped to
-- `ready_for_review` / rank 46. `acceptIncoming` in `work-products.ts` compares
-- `sourceEventTimestampMs` FIRST and only reaches the terminal-state tie-break
-- on an exact tie; `updated_at` is second-granular and the dequeue lands 1-2s
-- after the merge, so the dequeue won outright and overwrote a correct `merged`
-- row.
--
-- #2952 cannot reach the rows already demoted. A merged PR emits no further
-- `pull_request` event, so those rows are wrong PERMANENTLY -- and both
-- consumers are load-bearing: the done-gate false-FAILs a legitimately complete
-- issue, and PEN-2791's stranded-assigned sweep reads
-- OPEN_PULL_REQUEST_WORK_PRODUCT_STATUSES as "this issue still has an external
-- event-wake path" on a row that can never produce another wake.
--
-- The predicate is self-evidencing, in the sense 0253 established for a
-- historical repair: a row carrying a populated `mergedAt` while its status is
-- not `merged` contradicts itself on its own face, whatever produced it. It
-- does not depend on present-day configuration, on `lastEventAction` still
-- reading `dequeued`, or on this defect being the only way to reach that state.
--
-- `mergedAt` is sound in the only direction this statement can move a row.
-- GitHub sets `merged_at` on a real merge, never clears it, and a merged PR
-- cannot be reopened, so this can only ever promote a row that genuinely
-- merged. A genuine queue EJECTION carries `merged_at: null` and is untouched.
-- The `source` guard keeps this to rows this webhook wrote; agent-registered
-- rows (the Paperclip skill tells agents to create work products) set their own
-- metadata and are none of this statement's business.
--
-- Verified demoted rows at authoring time, 2026-10-23 -- all four reading
-- `ready_for_review` / `merged:false` / `sourceEventOrder:10` /
-- `sourceEventActionOrder:46` / `lastEventAction:dequeued` beside their own
-- populated `mergedAt`, against surviving `closed`-path controls (#2930, #2907,
-- #2948) reading `merged` / 30 / 50:
--
--   #2931  merged 2026-10-22T14:41:33Z   work product dc730e3c  (PEN-4518)
--   #2933  merged 2026-10-22T17:23:32Z   work product 083f8d11  (PEN-4518)
--   #2946  merged 2026-10-23T03:57:49Z   work product 91c57239  (PEN-4539)
--   #2952  merged 2026-10-23T11:27:13Z   work product ff9ee9a2  (PEN-4550)
--
-- #2952 is the forward fix's OWN pull request, demoted by the defect it fixes
-- because it merged before its own code was deployed. That is also why this
-- file does not need the "deploy #2952 first" sequencing the issue called for:
-- it is a strictly later commit than 8633c02, so it can only ever run in a
-- release that already contains the fix, and it runs at startup of that
-- release. Rows demoted in the window between the two merges are repaired by
-- this statement in the same deploy that stops new ones being created.
--
-- The repair writes work-product state ONLY. It deliberately does not re-fire
-- merged-PR forward-capture (BLO-9117), the stacked-PR scan or PEN-3397
-- discharge: those consumers are once-only and these merges already happened.
--
-- Three fields are wrong on a demoted row, not the two the issue named.
-- `sourceEventOrder` derives from status and reads 10 on every demoted row
-- against 30 on every control, so it is repaired too; leaving it would make a
-- repaired row disagree with what the fixed producer now writes for the same
-- event, and it is consulted by the `tieBreak` ladder.
--
-- `lastEventAction`, `mergeQueueState`, `sourceEventTimestamp(Ms)` and
-- `headSha` are NOT touched. They are a factual record of the event that last
-- won, and rewriting them would destroy the evidence that this row was repaired
-- rather than delivered correctly.
--
-- Idempotent: a repaired row reads `status = 'merged'` and no longer matches,
-- so re-running is a no-op. `statusCorrection` makes the repaired set
-- self-identifying afterwards, which is the only census available -- there is
-- no work-products listing endpoint, so the class size cannot be counted from
-- an agent seat before this runs:
--
--   SELECT count(*) FROM issue_work_products
--   WHERE metadata->'statusCorrection'->>'issue' = 'PEN-4553';
UPDATE "issue_work_products"
SET
	"status" = 'merged',
	"metadata" = "metadata" || jsonb_build_object(
		'merged', true,
		'sourceEventOrder', 30,
		'sourceEventActionOrder', 50,
		'statusCorrection', jsonb_build_object(
			'issue', 'PEN-4553',
			'reason', 'merge_queue_dequeued_demotion',
			'fromStatus', "status",
			'fromMerged', "metadata"->'merged',
			'fromSourceEventOrder', "metadata"->'sourceEventOrder',
			'fromSourceEventActionOrder', "metadata"->'sourceEventActionOrder',
			'fromLastEventAction', "metadata"->'lastEventAction'
		)
	),
	"updated_at" = now()
WHERE "type" = 'pull_request'
	AND "provider" = 'github'
	AND "metadata"->>'source' = 'github_pull_request_webhook'
	AND "status" <> 'merged'
	AND nullif("metadata"->>'mergedAt', '') IS NOT NULL;
