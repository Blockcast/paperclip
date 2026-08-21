import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueComments, issues, routineRuns, routines } from "@paperclipai/db";

import {
  buildAgentHealthReceiptKeyLikePattern,
  buildSchedulerFailureHeartbeatKey,
} from "./origins.js";

// `issues.originKind` for a routine's scheduled execution issue. A bare string
// literal on the column rather than a member of RECOVERY_ORIGIN_KINDS -- those
// are origins this recovery service *creates*, and this one is created by the
// routine dispatcher.
export const ROUTINE_EXECUTION_ORIGIN_KIND = "routine_execution";

/**
 * Structural port over `issueService().addComment`. Injected rather than
 * imported so this module stays a leaf.
 *
 * BLO-27572: the dependency direction is `recovery/service.ts -> issues.ts ->
 * recovery/origins.ts`. Both `issues.ts` (the ordinary cancellation transition)
 * and `recovery/service.ts` (the strand-time sweep) need this heartbeat, so an
 * `import ... from "../issues.js"` here would close the cycle
 * `issues -> recovery/routine-scheduler-heartbeat -> issues`. Taking the one
 * function we need as a parameter keeps this module importable from either side.
 */
export type SchedulerHeartbeatAddComment = (
  issueId: string,
  body: string,
  actor: { agentId?: string; userId?: string; runId?: string | null },
  options?: { authorType?: "system"; idempotencyKey?: string | null },
  dbOrTx?: unknown,
) => Promise<unknown>;

export type RoutineSchedulerHeartbeatIssue = Pick<
  typeof issues.$inferSelect,
  "id" | "companyId" | "identifier" | "originKind" | "originId" | "originRunId" | "createdAt"
>;

/**
 * How this window stopped being live. Both dispositions produce the same
 * idempotency key, so a window that stranded and was *then* cancelled keeps
 * exactly one row -- the second write dedupes against the first rather than
 * doubling the alarm.
 */
export type RoutineSchedulerHeartbeatDisposition =
  | { kind: "stranded"; failureClass: string }
  | { kind: "cancelled"; previousStatus: string };

function issueUiLink(issue: { identifier: string | null; id: string }, prefix: string) {
  const label = issue.identifier ?? issue.id;
  return `[${label}](/${prefix}/issues/${label})`;
}

function dispositionClause(
  disposition: RoutineSchedulerHeartbeatDisposition,
  issueLink: string,
) {
  return disposition.kind === "stranded"
    ? `execution issue ${issueLink} stranded with class \`${disposition.failureClass}\`.`
    : `execution issue ${issueLink} was retired to \`cancelled\` from \`${disposition.previousStatus}\` ` +
      "with no emission for this window.";
}

/**
 * BLO-21395: cross-post a deduplicated failure receipt to the routine's alert
 * surface (`routines.parentIssueId`) when a scheduled window stops being live
 * without the runbook ever emitting for it. The in-run pre-flight heartbeat
 * lives inside the runbook itself and cannot fire for this class of failure --
 * capacity waits, stale-kills, and other pre-execution lifecycle failures never
 * hand control to user code at all -- so silence here is otherwise
 * indistinguishable from health on the routine's tracking issue. Scoped strictly
 * to `originKind === "routine_execution"`.
 *
 * BLO-24543: the predicate is receipt absence for THIS window on the alert
 * surface, not run status or an activity proxy. The prior `lastUsefulActionAt
 * IS NOT NULL` check was too permissive -- BLO-21235's run set that column 3s in
 * off a single checkout-shaped activity event, then succeeded without ever
 * reaching the runbook's own emission step, then stranded. That proxy suppressed
 * the receipt on the exact window this predicate exists to catch. A window that
 * already carries the runbook's own `agent-health:<windowKey>:*` receipt on the
 * alert surface got a normal emission and needs no scheduler receipt; this is
 * the only thing that suppresses emission here.
 *
 * BLO-27572: extracted out of the recovery service so the *cancellation*
 * transition can reach it too. A stranded window retired by an agent or a human
 * is a correct call, but it must still leave a receipt -- otherwise disposition
 * becomes a second way to manufacture silence, exactly the failure this alarm
 * exists to remove.
 *
 * The receipt is phrased as a timestamped observation ("as of <T>, this window
 * carried no receipt"), never a terminal claim ("this window will never run").
 * That sentence cannot be falsified by a later retry that succeeds and emits
 * normally -- the pair reads as "stranded, then recovered," not a contradiction
 * -- so this intentionally does not wait for the window to become unretriable
 * and does not retract/supersede a receipt once posted. Emitting the
 * correct-but-early receipt trades a possible harmless "stranded, then
 * recovered" pair for the latency that is the entire point of this alarm; a
 * queue-age or "never ran" threshold would be undecidable at emission time (a
 * run can sit `queued` for a very long time and then execute normally) and is
 * deliberately not added.
 */
export async function postRoutineSchedulerFailureHeartbeat(deps: {
  db: Db;
  addComment: SchedulerHeartbeatAddComment;
  logger: { warn: (obj: unknown, msg: string) => void };
}, input: {
  issue: RoutineSchedulerHeartbeatIssue;
  disposition: RoutineSchedulerHeartbeatDisposition;
  prefix: string;
}) {
  const { db, addComment, logger } = deps;
  const { issue, disposition, prefix } = input;
  if (issue.originKind !== ROUTINE_EXECUTION_ORIGIN_KIND || !issue.originId) return;

  try {
    const routine = await db
      .select({ id: routines.id, parentIssueId: routines.parentIssueId, title: routines.title })
      .from(routines)
      .where(and(eq(routines.companyId, issue.companyId), eq(routines.id, issue.originId)))
      .then((rows) => rows[0] ?? null);
    // No configured alert surface -- nothing to cross-post to. Not an error:
    // most routines don't parent their executions under a tracking issue.
    if (!routine || !routine.parentIssueId) return;

    const run = issue.originRunId
      ? await db
        .select({ triggeredAt: routineRuns.triggeredAt })
        .from(routineRuns)
        .where(eq(routineRuns.id, issue.originRunId))
        .then((rows) => rows[0] ?? null)
      : null;
    const windowKey = (run?.triggeredAt ?? issue.createdAt).toISOString();

    const hasNormalEmission = await db
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(and(
        eq(issueComments.issueId, routine.parentIssueId),
        sql`${issueComments.idempotencyKey} LIKE ${buildAgentHealthReceiptKeyLikePattern(windowKey)}`,
      ))
      .limit(1)
      .then((rows) => rows.length > 0);
    if (hasNormalEmission) return;

    const idempotencyKey = buildSchedulerFailureHeartbeatKey({ routineId: routine.id, windowKey });
    const observedAt = new Date().toISOString();

    await addComment(
      routine.parentIssueId,
      [
        `**Scheduler-side failure heartbeat.** As of \`${observedAt}\`, window \`${windowKey}\` of routine ` +
          `\`${routine.title}\` (\`${routine.id}\`) carried no \`agent-health:${windowKey}:*\` receipt on this ` +
          `issue; ${dispositionClause(disposition, issueUiLink(issue, prefix))}`,
        "",
        `- Routine run: \`${issue.originRunId ?? "unknown"}\``,
        `- Idempotency key: \`${idempotencyKey}\``,
      ].join("\n"),
      {},
      { authorType: "system", idempotencyKey },
    );
  } catch (err) {
    // Never let a missing/renamed alert surface or a transient DB error break
    // the escalation or the cancellation this heartbeat rides along with.
    logger.warn(
      { err, issueId: issue.id, routineId: issue.originId },
      "failed to post scheduler-side failure heartbeat",
    );
  }
}
