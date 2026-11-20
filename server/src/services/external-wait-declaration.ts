/**
 * The `external owner:` / `external action:` declaration, and nothing else.
 *
 * Extracted from `issues.ts` for PEN-6587 so `issue-checkout-status.ts` can read the
 * same predicate without importing it. `issues.ts` already imports the checkout-status
 * module, so the reverse import would close a cycle; a leaf module keeps the predicate a
 * single definition with a single authority, which is the property every reader below
 * depends on. `issues.ts` re-exports it, so its existing importers are unchanged.
 */
import { sql, type SQL } from "drizzle-orm";
import { issues } from "@paperclipai/db";

/**
 * Parses the `external owner:` / `external action:` pair an agent writes into a
 * description to park an issue on a human gate. Exported so the liveness sweep can see
 * the same signal (BLO-24662) — a gate narrated in prose is still a gate, and without it
 * the `blocked_without_blockers` rule reads deliberate parking as a dead end.
 *
 * Whitespace is horizontal-only (`[ \t]`) throughout, because `\s` spans line
 * terminators and the documented contract is one declaration per line. With `\s*` a
 * blank key consumed the *next* line, so `external owner:\nexternal action: X` parsed
 * as `{ owner: "external action: X", action: "X" }` — a successful parse with a garbage
 * owner that then reached the redaction path (BLO-28618).
 */
export function externalWaitFromDescription(description: string | null): { owner: string; action: string } | null {
  if (!description) return null;
  const owner = description.match(/^[ \t]*external owner[ \t]*:[ \t]*(.+)$/im)?.[1]?.trim();
  const action = description.match(/^[ \t]*external action[ \t]*:[ \t]*(.+)$/im)?.[1]?.trim();
  if (!owner || !action) return null;
  return {
    owner: owner.slice(0, 120),
    action: action.slice(0, 240),
  };
}

/**
 * BLO-58502: `issues.description`, or NULL when it cannot possibly declare an external wait.
 *
 * Project this instead of the bare column wherever a scan only needs the description to
 * feed {@link externalWaitFromDescription}. Both literals must appear for the regex to
 * match, and ILIKE on these ASCII literals is a strict superset of the regex's `/i`, so the
 * TS predicate stays the single authority: this only stops shipping (and regex-scanning)
 * tens of KB of prose per row that cannot match. The recovery scan reads every live row
 * every 30 s, and that regex pass showed up at 200-536 ms self time in stall profiles.
 */
export const externalWaitDescriptionCandidate: SQL<string | null> = sql<string | null>`
  CASE
    WHEN ${issues.description} ILIKE '%external owner%'
     AND ${issues.description} ILIKE '%external action%'
      THEN ${issues.description}
  END
`;
