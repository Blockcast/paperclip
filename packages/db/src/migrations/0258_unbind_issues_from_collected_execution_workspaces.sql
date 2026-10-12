-- BLO-42036: drop the dangling execution-workspace pointer left on an issue
-- whose worktree the collector already reclaimed.
--
-- `isClosedIsolatedExecutionWorkspace` refuses comments, agent patches and
-- checkout on any issue whose linked isolated workspace is closed, and the 409
-- tells the caller to "move it to an open workspace". The only route that can
-- do that is the issue PATCH, which the same guard refused for an agent — so a
-- collected workspace made its source issue permanently unwritable by its own
-- assignee, with no agent-reachable remedy. A `critical` alert row was born
-- unwritable 53 minutes after its worktree was collected and carried no record
-- of the incident it fired for.
--
-- The route and collector fixes shipped alongside this migration stop new rows
-- entering the state, but the collector never revisits an archived row, so the
-- existing population would stay stranded forever. Measured on the Blockcast
-- instance before this shipped: 137 issues bound to a closed isolated
-- workspace, 17 of them still open (1 `critical`, 10 `high`), all 137 against a
-- `collected` workspace.
--
-- Scoped to `cleanup_reason = 'collected'` and nothing else. That reason is
-- written at exactly one site, after `inspectWorktreeReclaimSafety` has PROVEN
-- the tree held no uncommitted change and no unpushed commit and that it is
-- gone from disk — so the pointer references nothing recoverable. Rows closed
-- by the operator archive or left `cleanup_failed` keep their binding, and keep
-- the guard, because there the directory may still hold work.
-- `execution_workspaces.source_issue_id` is the durable reverse link, so
-- history survives the unbind.
--
-- Idempotent: a repaired row no longer matches the join.
-- paperclip:migration-safety-ignore full-table-mutation-large-table: the join restricts this to issues pointing at an already-collected workspace (137 production rows measured 2026-10-10), and `issues_company_execution_workspace_idx` serves the predicate.
UPDATE "issues" AS "issue"
SET
	"execution_workspace_id" = NULL,
	"updated_at" = now()
FROM "execution_workspaces" AS "workspace"
WHERE "workspace"."id" = "issue"."execution_workspace_id"
	AND "workspace"."cleanup_reason" = 'collected';
