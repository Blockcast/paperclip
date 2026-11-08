import { and, inArray, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { agentWakeupRequests } from "@paperclipai/db";

/**
 * PEN-6104: "does this wake target issue X" — MEMBERSHIP, as opposed to the
 * `coalesce(...)` attribution expressions in `issues.ts` and
 * `successful-run-handoff-state.ts` ("which single issue does this wake belong
 * to"). The two are deliberately different questions and are NOT
 * interchangeable: a wake whose `_paperclipWakeContext.issueId` names a
 * different issue from its top-level `issueId` is a member of both and
 * attributed only to the first. That divergence is measured, not asserted —
 * `packages/db/src/agent-wakeup-payload-target-semantics.test.ts`.
 *
 * ⭐ EVERY ARM CARRIES ITS OWN `?` GUARD, AND THE GUARD IS THE WHOLE POINT.
 * `payload ->> 'issueId' = $1` is logically equivalent to
 * `payload ? 'issueId' and payload ->> 'issueId' = $1` — a non-NULL `->>`
 * implies the key exists — but only the second form can REACH the partial
 * indexes migration 0278 creates. A partial index is usable only where the
 * planner can PROVE the query implies its predicate, and `->> = $1` does not
 * imply `? 'issueId'`. Measured at 2M rows
 * (`packages/db/src/agent-wakeup-payload-index-shape.bench.ts`): without the
 * guards the four indexes are built, are 124 MB, and the planner never touches
 * them — 253.8 ms, the unindexed plan unchanged. With them the same probe is
 * 0.2 ms.
 *
 * ⛔ So do NOT "simplify" an arm by dropping its `?` test. It reads as
 * redundant because it IS redundant semantically; it is load-bearing for the
 * plan, and removing it silently restores a full walk of the company's window
 * on the largest table in the schema.
 *
 * The four arms and migration 0278's four indexes are in one-to-one
 * correspondence; keep them that way.
 */
export function wakeRequestTargetsIssueCondition(issueId: string): SQL {
  return sql`(
    (${agentWakeupRequests.payload} ? 'issueId' and ${agentWakeupRequests.payload} ->> 'issueId' = ${issueId})
    or (${agentWakeupRequests.payload} ? 'taskId' and ${agentWakeupRequests.payload} ->> 'taskId' = ${issueId})
    or (
      ${agentWakeupRequests.payload} -> '_paperclipWakeContext' ? 'issueId'
      and ${agentWakeupRequests.payload} -> '_paperclipWakeContext' ->> 'issueId' = ${issueId}
    )
    or (
      ${agentWakeupRequests.payload} -> '_paperclipWakeContext' ? 'taskId'
      and ${agentWakeupRequests.payload} -> '_paperclipWakeContext' ->> 'taskId' = ${issueId}
    )
  )`;
}

/**
 * Set-valued sibling of {@link wakeRequestTargetsIssueCondition}, for the
 * watchdog's subtree scan. Same guards, same reason — an `IN (...)` arm cannot
 * reach a partial index either.
 */
export function wakeRequestTargetsAnyIssueCondition(issueIds: readonly string[]): SQL {
  const ids = [...issueIds];
  return or(
    and(sql`${agentWakeupRequests.payload} ? 'issueId'`, inArray(sql`${agentWakeupRequests.payload} ->> 'issueId'`, ids)),
    and(sql`${agentWakeupRequests.payload} ? 'taskId'`, inArray(sql`${agentWakeupRequests.payload} ->> 'taskId'`, ids)),
    and(
      sql`${agentWakeupRequests.payload} -> '_paperclipWakeContext' ? 'issueId'`,
      inArray(sql`${agentWakeupRequests.payload} -> '_paperclipWakeContext' ->> 'issueId'`, ids),
    ),
    and(
      sql`${agentWakeupRequests.payload} -> '_paperclipWakeContext' ? 'taskId'`,
      inArray(sql`${agentWakeupRequests.payload} -> '_paperclipWakeContext' ->> 'taskId'`, ids),
    ),
  ) as SQL;
}
