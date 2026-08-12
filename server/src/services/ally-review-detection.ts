/**
 * Shared parsing for Ally's consolidated PR-review output.
 *
 * The webhook uses these predicates to route actionable review feedback, and
 * the comment-review gate uses the same parsing to publish a merge-visible
 * status. Keeping the detection in one dependency-free module avoids subtle
 * differences in which comments wake an author versus block a PR.
 */

// Ally's own output has this heading on its own line, as a Markdown heading
// or bold run — optionally indented up to three spaces (still a paragraph,
// rather than a code block). A prose mention or quoted heading must not count
// as the review itself.
const ALLY_CONSOLIDATED_REVIEW_HEADING_PATTERN =
  /^[ \t]{0,3}(?:#{1,6}[ \t]+|\*\*[ \t]*)?Ally[ \t]*(?:—|–|-|:)[ \t]*Consolidated[ \t]+PR[ \t]+Review\b/im;

export function hasAllyConsolidatedReviewHeading(body: string | null | undefined): boolean {
  return typeof body === "string" && ALLY_CONSOLIDATED_REVIEW_HEADING_PATTERN.test(body);
}

// A comment-shaped review attests to the exact head it examined. Require one
// complete standalone SHA: an absent or ambiguous attestation must not be
// guessed at when a required check is being set.
const REVIEWED_HEAD_ATTESTATION_PATTERN = /(?:^|\n)\s*_?\s*reviewed head:\s*([0-9a-f]{40})\s*_?\s*(?=\n|$)/gi;

export function extractAllyReviewedHeadSha(body: string | null | undefined): string | null {
  if (typeof body !== "string") return null;
  const attestations = Array.from(
    body.matchAll(REVIEWED_HEAD_ATTESTATION_PATTERN),
    (match) => match[1]!.toLowerCase(),
  );
  return attestations.length === 1 ? attestations[0]! : null;
}

// Negation cues flip an otherwise-actionable bare phrase into a confirmation
// that no follow-up is required. Limit the lookback to the local sentence so
// an unrelated earlier negation does not mask a real later finding.
const NEGATION_CUE_REGEX =
  /\b(?:no|not|zero|none|never|without|isn't|aren't|doesn't|didn't|won't|cannot)\b/i;
const NEGATION_LOOKBACK_WORDS = 8;

// Uncounted findings must begin a heading/list line. An unanchored pattern
// would incorrectly flag prose such as "No Critical or Important issues".
const UNCOUNTED_FINDINGS_HEADING_REGEX =
  /^[ \t]*(?:[#>]+[ \t]*)?(?:(?:[-*+]|\d+[.)])[ \t]+)?[*_]*(?:Critical|Important)[ \t]+Issues\b(?![*_]*[ \t]*\()/im;

function hasNonNegatedMatch(text: string, pattern: RegExp): boolean {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const regex = new RegExp(pattern.source, flags);
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const preceding = text.slice(0, match.index);
    const sentenceStart = Math.max(preceding.lastIndexOf("."), preceding.lastIndexOf("\n")) + 1;
    const lookback = preceding
      .slice(sentenceStart)
      .trim()
      .split(/\s+/)
      .slice(-NEGATION_LOOKBACK_WORDS)
      .join(" ");
    if (!NEGATION_CUE_REGEX.test(lookback)) return true;
    if (regex.lastIndex === match.index) regex.lastIndex += 1;
  }
  return false;
}

/** Return whether a formal or comment-shaped review contains blocking feedback. */
export function hasActionablePrReviewFeedback(body: string | null | undefined, state?: string | null): boolean {
  const normalizedState = state?.trim().toLowerCase();
  if (normalizedState === "changes_requested" || normalizedState === "changes-requested") return true;
  if (typeof body !== "string") return false;
  const text = body.trim();
  if (!text) return false;

  for (const bucket of text.matchAll(/\b(?:Critical|Important)\s+Issues\b[*_]*\s*\((\d+)\)/gi)) {
    if (Number(bucket[1]) > 0) return true;
  }
  if (UNCOUNTED_FINDINGS_HEADING_REGEX.test(text)) return true;
  if (/^[ \t]*decision[ \t]*:[ \t]*changes_requested[ \t]*$/im.test(text)) return true;
  if (hasNonNegatedMatch(text, /\bchanges\s+requested\b/i)) return true;
  if (hasNonNegatedMatch(text, /\brequest(?:ed|s)?\s+changes\b/i)) return true;
  return /\bRecommended\s+Action\b[\s\S]{0,400}\bfix\b[\s\S]{0,400}\bbefore\s+merg(?:e|es|ed|ing)\b/i.test(text);
}
