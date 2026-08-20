import { and, asc, desc, eq, gt, lt, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueComments, issues, routineRuns, routines } from "@paperclipai/db";

import {
  AGENT_HEALTH_RECEIPT_KEY_LIKE_PATTERN,
  buildSchedulerFailureHeartbeatKey,
  parseAgentHealthReceiptWindowKey,
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
 * BLO-28871: the lower bound of the window this run owns, exclusive.
 *
 * A runbook keys its receipt to *its own* window convention, which the platform
 * does not own and must not hard-code: the live agent-health routine floors
 * `triggeredAt` to the UTC 6-hour slot, so its receipt is keyed `:00:00` while
 * the run triggered at `:07:xx`. Matching the raw timestamp matched nothing.
 * Rather than parse the cron, bound the window with what the scheduler already
 * knows -- the routine's own adjacent runs. Any receipt keyed in
 * `(previousRun.triggeredAt, thisRun.triggeredAt]` belongs to this window and
 * no other, for any convention that stamps a key inside the window it describes.
 *
 * Exclusive at the lower end on purpose: a convention that keys the *raw*
 * trigger time would otherwise let the previous window's receipt suppress this
 * one.
 *
 * With no earlier run, fall back to the spacing implied by the *next* run, so a
 * routine's first window is still bounded. With neither neighbour the routine
 * has exactly one run ever, so every `agent-health:` receipt keyed at or before
 * it necessarily belongs to this window and `null` (unbounded below) is right.
 *
 * Stated limit: if two runs of the same routine trigger close enough together
 * to share one runbook slot (a catch-up burst), the later run's interval is too
 * narrow to see the slot's receipt and it can still draw a false receipt. That
 * is bounded to burst runs rather than every window, and the duplicate-dispatch
 * path that produces most of them is already suppressed upstream (BLO-19954).
 * Widening the interval past the adjacent run is the worse trade: it would let
 * one window's receipt vouch for another, which converts a false alarm into
 * silence on a genuinely dark window.
 */
async function resolveWindowStartExclusive(db: Db, input: {
  companyId: string;
  routineId: string;
  windowAt: Date;
}) {
  const scope = and(
    eq(routineRuns.companyId, input.companyId),
    eq(routineRuns.routineId, input.routineId),
  );
  const previousRunAt = await db
    .select({ triggeredAt: routineRuns.triggeredAt })
    .from(routineRuns)
    .where(and(scope, lt(routineRuns.triggeredAt, input.windowAt)))
    .orderBy(desc(routineRuns.triggeredAt))
    .limit(1)
    .then((rows) => rows[0]?.triggeredAt ?? null);
  if (previousRunAt) return previousRunAt;

  const nextRunAt = await db
    .select({ triggeredAt: routineRuns.triggeredAt })
    .from(routineRuns)
    .where(and(scope, gt(routineRuns.triggeredAt, input.windowAt)))
    .orderBy(asc(routineRuns.triggeredAt))
    .limit(1)
    .then((rows) => rows[0]?.triggeredAt ?? null);
  if (!nextRunAt) return null;
  return new Date(input.windowAt.getTime() - (nextRunAt.getTime() - input.windowAt.getTime()));
}

function isWithinWindow(keyedAt: Date | null, window: {
  windowAt: Date;
  windowStartExclusive: Date | null;
}) {
  if (!keyedAt) return false;
  if (keyedAt.getTime() > window.windowAt.getTime()) return false;
  return !window.windowStartExclusive || keyedAt.getTime() > window.windowStartExclusive.getTime();
}

// The receipt states which interval it searched, not just which window it is
// about. A reader who sees `carried no agent-health:<rawTriggeredAt>:*` cannot
// tell whether the guard looked for the runbook's actual key -- BLO-28871 is
// what that ambiguity cost.
function describeSearchedWindow(windowKey: string, windowStartExclusive: Date | null) {
  return windowStartExclusive
    ? `after \`${windowStartExclusive.toISOString()}\` and at or before \`${windowKey}\``
    : `at or before \`${windowKey}\``;
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
 * already carries the runbook's own `agent-health:` receipt on the alert surface
 * got a normal emission and needs no scheduler receipt; this is the only thing
 * that suppresses emission here.
 *
 * BLO-28871: that suppression was dead code in production for its first three
 * weeks. It compared the *raw* `triggeredAt` against keys the runbook stamps at
 * the floored UTC slot, two strings that can never be equal, so every window --
 * including ones the runbook had already reported -- was eligible for a receipt
 * asserting the opposite. Window membership is now decided from the parsed key
 * against the interval bounded by the routine's adjacent runs; see
 * `resolveWindowStartExclusive`. The receipt's *own* key still uses the raw
 * `triggeredAt`: it is stable per (routine, run), and the CTO namespace ruling
 * on BLO-21395 deliberately keeps scheduler receipts out of the runbook's
 * `windowCoverage7d`. Only the lookup was wrong.
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
    const windowAt = run?.triggeredAt ?? issue.createdAt;
    const windowKey = windowAt.toISOString();
    const windowStartExclusive = await resolveWindowStartExclusive(db, {
      companyId: issue.companyId,
      routineId: routine.id,
      windowAt,
    });

    const hasNormalEmission = await db
      .select({ idempotencyKey: issueComments.idempotencyKey })
      .from(issueComments)
      .where(and(
        eq(issueComments.issueId, routine.parentIssueId),
        sql`${issueComments.idempotencyKey} LIKE ${AGENT_HEALTH_RECEIPT_KEY_LIKE_PATTERN}`,
      ))
      .then((rows) =>
        rows.some((row) =>
          isWithinWindow(parseAgentHealthReceiptWindowKey(row.idempotencyKey), {
            windowAt,
            windowStartExclusive,
          })
        )
      );
    if (hasNormalEmission) return;

    const idempotencyKey = buildSchedulerFailureHeartbeatKey({ routineId: routine.id, windowKey });
    const observedAt = new Date().toISOString();

    await addComment(
      routine.parentIssueId,
      [
        `**Scheduler-side failure heartbeat.** As of \`${observedAt}\`, window \`${windowKey}\` of routine ` +
          `\`${routine.title}\` (\`${routine.id}\`) carried no \`agent-health:*\` receipt keyed ` +
          `${describeSearchedWindow(windowKey, windowStartExclusive)} on this issue; ` +
          `${dispositionClause(disposition, issueUiLink(issue, prefix))}`,
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
