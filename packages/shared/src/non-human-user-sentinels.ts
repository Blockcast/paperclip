/**
 * User-table rows that are NOT people.
 *
 * `local-board` is materialized as a real row in the `user` table with an
 * owner/admin company membership — it is the implicit board admin that agents
 * act under. So every "is this a user?" test that keys on `principalType ===
 * "user"`, or on membership role, answers **yes** for it. That is the trap:
 * code looking for *a human to hand work to* picks the sentinel, assigns to it,
 * and reports success, because nothing in the row says "nobody reads this".
 *
 * This lives in `shared`, not `server/src/services/issues.ts` where the set was
 * first declared, because the second caller is a **plugin**
 * (`paperclip-plugin-alertmanager`), which cannot import from `server/src`. A
 * duplicated copy would not fail loudly — it would drift, and the failure mode
 * of the drift is silent mis-routing, which is exactly what BLO-19560 measured:
 * 19 `[user-cover]` escalation issues, every one of them addressed to
 * `local-board`, each carrying the text "Board direction is required", none
 * ever delivered to a board member.
 *
 * Adding an id here says "never hand work to this principal". It does not say
 * "ignore this principal" — agent attribution deliberately still derives
 * through these sentinels (`server/src/services/issues.ts`).
 */
export const NON_HUMAN_USER_SENTINEL_IDS: ReadonlySet<string> = new Set(["local-board"]);

/** True when `userId` is a user-table row that no person reads. */
export function isNonHumanUserSentinel(userId: string | null | undefined): boolean {
  return userId != null && NON_HUMAN_USER_SENTINEL_IDS.has(userId);
}
