/**
 * Paperclip issue-identifier extraction from GitHub PR text.
 *
 * Centralized so the webhook receiver (forward capture) and the
 * issue↔PR linkage service (storage + backfill reconciler) share ONE
 * extractor. The operator hard-guard (2026-06-05) is that PR→issue
 * attribution keys on the `BLO-####` ref in branch/title/body — NEVER on
 * the PR author login — because agent merged-PRs span ≥2 GitHub identities
 * (kkroo, app/allyblockcast, app/blockcast-ci-packages) and an author filter
 * silently drops whole identity buckets (the BLO-9103 floor bug). Keeping the
 * extractor in one place means that guarantee can't drift between the two paths.
 *
 * Logic is verbatim from the original webhook implementation (BLO-3182).
 */

// Conservative pattern: 2-10 uppercase letters/digits, dash, 1-6 digits.
// Anchored against word boundaries so mid-word `xBLO-3182y` doesn't match,
// but `(BLO-3182)`, `BLO-3182:`, or `feat/BLO-3182-thing` all do.
// Compact lists such as `BLO-3763/3764` are expanded to both identifiers.
export const PAPERCLIP_IDENTIFIER_PATTERN = /\b([A-Z][A-Z0-9]{1,9}-\d{1,6}(?:\/\d{1,6})*)\b/g;
export const PAPERCLIP_COMPACT_IDENTIFIER_PATTERN = /^([A-Z][A-Z0-9]{1,9})-(\d{1,6})((?:\/\d{1,6})*)$/;

export function expandPaperclipIdentifierToken(token: string): string[] {
  const match = token.match(PAPERCLIP_COMPACT_IDENTIFIER_PATTERN);
  if (!match) return [token];
  const prefix = match[1]!;
  const firstNumber = match[2]!;
  const tailNumbers = (match[3] ?? "").split("/").filter(Boolean);
  return [firstNumber, ...tailNumbers].map((number) => `${prefix}-${number}`);
}

export function extractPaperclipIdentifiers(...sources: Array<string | null | undefined>): string[] {
  const found = new Set<string>();
  for (const source of sources) {
    if (!source) continue;
    const matches = source.matchAll(PAPERCLIP_IDENTIFIER_PATTERN);
    for (const match of matches) {
      if (match[1]) {
        for (const identifier of expandPaperclipIdentifierToken(match[1])) {
          found.add(identifier);
        }
      }
    }
  }
  return Array.from(found);
}

/** How an issue↔PR link was established. Author is deliberately NOT a source. */
export type PullRequestLinkSource = "branch_ref" | "title_ref" | "body_ref" | "reconciler" | "manual";

/**
 * Resolve which PR field carried a given target identifier, preferring the
 * branch (option (A): the branchTemplate injects the issue ref into the branch
 * name, so a branch match is the strongest, process-enforced signal), then
 * title, then body. Returns null if none of the fields carry it.
 */
export function resolveLinkSourceForIdentifier(
  identifier: string,
  fields: { branch?: string | null; title?: string | null; body?: string | null },
): PullRequestLinkSource | null {
  if (extractPaperclipIdentifiers(fields.branch).includes(identifier)) return "branch_ref";
  if (extractPaperclipIdentifiers(fields.title).includes(identifier)) return "title_ref";
  if (extractPaperclipIdentifiers(fields.body).includes(identifier)) return "body_ref";
  return null;
}

// BLO-20886: a PR body commonly carries BOTH an owning reference (`Refs:`,
// `Fixes:`, `Closes:`, `Resolves:`) and a `Related:` list of informational
// backlinks with no ownership relationship to the PR at all. Every one of
// those identifiers is an equally-weighted match under
// extractPaperclipIdentifiers — nothing there distinguishes "the issue this
// PR closes" from "an issue this PR happens to mention" — so a caller that
// picks one to treat as the PR's owner (e.g. to address an author-directed
// wake) must not just grab an arbitrary entry. Only a line that opens with
// one of GitHub's own closing keywords or this repo's `Refs:` convention
// counts as an ownership claim; a bare mention (including under `Related:`)
// never does. The colon is optional -- existing PR bodies in this repo use
// both "Closes: BLO-1" and the natural-language "Closes BLO-1 and BLO-2".
//
// A leading markdown list marker is also optional, and that is load-bearing
// rather than cosmetic: .github/PULL_REQUEST_TEMPLATE.md renders its
// "## Linked Issues or Issue Description" section as a bullet list, so the
// repo's own house style for an owning reference is `- Refs: BLO-1`, not a
// bare `Refs: BLO-1` line. PR #953 -- the live misroute this rule exists to
// fix -- writes exactly `- Refs: [BLO-19132](...)`. Without the marker the
// body tier silently matches nothing on the majority of real PR bodies and
// every such PR fails closed to `no_owning_reference`, dropping an author
// wake that should have been delivered to its owner.
const OWNING_REFERENCE_LABEL_PATTERN =
  /^[ \t]*(?:[-*+]|\d{1,3}[.)])?[ \t]*(?:fix(?:e[sd])?|clos(?:e[sd]?)|resolv(?:e[sd]?)|refs?)[ \t]*:?[ \t]+(.+)$/gim;

/** Identifiers that appear on a labeled owning-reference line in `body` (see above). */
export function extractOwningLabeledIdentifiers(body: string | null | undefined): string[] {
  if (!body) return [];
  const found = new Set<string>();
  OWNING_REFERENCE_LABEL_PATTERN.lastIndex = 0;
  for (const match of body.matchAll(OWNING_REFERENCE_LABEL_PATTERN)) {
    const rest = match[1];
    if (!rest) continue;
    for (const identifier of extractPaperclipIdentifiers(rest)) found.add(identifier);
  }
  return Array.from(found);
}

export interface OwningIdentifierResolution {
  // The PR's authoritative issue identifier(s) -- empty when none was found.
  owning: string[];
}

/**
 * Resolve the identifier(s) that OWN a PR, as opposed to ones the PR body
 * merely mentions. Priority, most authoritative first:
 *
 *   1. title ref
 *   2. body line(s) explicitly labeled Fixes:/Closes:/Resolves:/Refs:
 *   3. branch ref, case-insensitively -- LAST resort, see below.
 *
 * A bare mention anywhere else in the body -- including under a `Related:`
 * label -- is never owning. Only the first non-empty tier is consulted, and
 * EVERY identifier in that tier is owning: a PR legitimately closing two
 * issues ("Closes BLO-1 and BLO-2") owns both, so multiplicity within the
 * winning tier is not ambiguity, just multiple owners. Empty means no owning
 * reference was found at all -- the caller's cue to fall back to a
 * non-assignee target (e.g. the reviewer) or drop with a logged reason,
 * never to widen the search to a lower-priority tier or an unlabeled mention
 * (BLO-20886: doing so routed an author-directed "push a follow-up commit"
 * wake to the assignee of an unrelated issue named only under `Related:`).
 *
 * On the branch tier being LAST and case-insensitive, both of which are
 * measured rather than assumed. resolveLinkSourceForIdentifier above ranks
 * the branch FIRST on the theory that branchTemplate injects the ref, making
 * it process-enforced. Two things falsify that here:
 *
 *   - PAPERCLIP_IDENTIFIER_PATTERN is uppercase-only and real branches are
 *     lowercase (`sre/blo-20886-...`), so an uppercase branch tier is inert:
 *     across 175 PRs active in the trailing 7 days it fired for 1. That
 *     silence is what made 24 of those PRs resolve to no owner at all and
 *     fail closed, losing an author wake they should have received. Matching
 *     case-insensitively recovers 21 of the 24; the remaining 3 carry no ref
 *     in the branch either and correctly stay unresolved.
 *   - Branches get repurposed, so a branch ref goes stale while the title
 *     stays current. Over the same 175 PRs a case-insensitive branch tier
 *     agrees with the title/labeled-body answer 142 times and disagrees 8 --
 *     and in the disagreements the branch is the wrong one (#909's branch
 *     says `blo-20049` while both its title and its body name BLO-20467, the
 *     issue it actually fixes). Ranking a stale-prone signal above a curated
 *     one would reintroduce this ticket's own defect, misrouting an
 *     author-directed wake in ~5% of cases.
 *
 * So the branch is consulted only when nothing curated resolved, where its
 * choices are 21 recovered wakes against 0 overridden answers.
 */
export function resolveOwningPaperclipIdentifiers(fields: {
  branch?: string | null;
  title?: string | null;
  body?: string | null;
}): OwningIdentifierResolution {
  const tiers = [
    extractPaperclipIdentifiers(fields.title),
    extractOwningLabeledIdentifiers(fields.body),
    // Uppercased so a conventional lowercase branch (`sre/blo-20886-fix`)
    // matches the uppercase-only identifier pattern. Safe to normalize here
    // because a branch ref carries no prose that case could disambiguate.
    extractPaperclipIdentifiers(fields.branch?.toUpperCase()),
  ];
  for (const tier of tiers) {
    if (tier.length > 0) return { owning: tier };
  }
  return { owning: [] };
}
