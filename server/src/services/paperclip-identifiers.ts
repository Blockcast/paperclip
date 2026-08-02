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
const OWNING_REFERENCE_LABEL_PATTERN =
  /^[ \t]*(?:fix(?:e[sd])?|clos(?:e[sd]?)|resolv(?:e[sd]?)|refs?)[ \t]*:?[ \t]+(.+)$/gim;

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
 *   1. branch ref   -- the branchTemplate injects the issue ref into the
 *                      branch name, a process-enforced signal (see
 *                      resolveLinkSourceForIdentifier above).
 *   2. title ref
 *   3. body line(s) explicitly labeled Fixes:/Closes:/Resolves:/Refs:
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
 */
export function resolveOwningPaperclipIdentifiers(fields: {
  branch?: string | null;
  title?: string | null;
  body?: string | null;
}): OwningIdentifierResolution {
  const tiers = [
    extractPaperclipIdentifiers(fields.branch),
    extractPaperclipIdentifiers(fields.title),
    extractOwningLabeledIdentifiers(fields.body),
  ];
  for (const tier of tiers) {
    if (tier.length > 0) return { owning: tier };
  }
  return { owning: [] };
}
