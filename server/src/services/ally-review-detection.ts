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

// A "Prior Findings Dispositioned" ledger entry, e.g.
//   - **prior:731ced5 critical 1** — fixed — the terminator is gone.
// Anchored to the bold list-item form Ally emits, matching the shape
// scripts/check-ally-review-consistency.mjs already parses. The mirrored
// `[prior:...]` references inside a Critical/Important bucket use bracket
// syntax and deliberately do not match: those are open findings, not
// dispositions.
const PRIOR_FINDING_DISPOSITION_PATTERN =
  /^[ \t]*-[ \t]*\*\*[ \t]*prior:([0-9a-f]{7,40})[ \t]+([a-z]+)[ \t]+(\d+)[ \t]*\*\*[ \t]*(?:—|–|-)[ \t]*([a-z][a-z-]*)[ \t]*(?:—|–|-)/gim;

// The counted finding buckets a review reports, e.g. `### Important Issues (2)`.
// Ally numbers findings within a bucket from 1, and its ledger entries name
// that same (severity, index) pair, so these counts enumerate exactly which
// finding identities a head raised.
const COUNTED_FINDINGS_BUCKET_PATTERN =
  /\b(Critical|Important)\s+Issues\b[*_]*\s*\((\d+)\)/gi;

// Ally's disposition vocabulary is three words: `fixed` and
// `no-longer-applicable` retire a prior finding, `still-present` asserts it
// stands. That matches scripts/check-ally-review-consistency.mjs, which treats
// `still-present` alone as a blocking verdict (I2c). `no-longer-applicable`
// means the finding does not apply to this code — often that it was incorrect
// as filed — so it retires without implying anything changed.
//
// An unrecognized verb deliberately does NOT retire. The failure modes are
// asymmetric: failing closed on a new verb leaves a PR visibly red until
// someone updates this set, while failing open would silently clear a live
// finding, which is the outcome this gate exists to prevent. The omission of
// `no-longer-applicable` here was itself caught that way — as a red gate,
// rather than as a merged regression.
const RESOLVED_PRIOR_DISPOSITIONS = new Set(["fixed", "no-longer-applicable"]);

/** One finding, identified the way Ally's ledger identifies it. */
export interface AllyFindingRef {
  severity: string;
  /** 1-based position within its severity bucket. */
  index: number;
}

export interface AllyDispositionedPriorFinding extends AllyFindingRef {
  /** As written by Ally — abbreviated, so callers must compare by prefix. */
  shortSha: string;
}

/**
 * Prior findings this review explicitly reports as resolved.
 *
 * Ally re-states each earlier finding it has re-examined under a "Prior
 * Findings Dispositioned" heading, naming the head the finding was raised
 * against plus its severity and index. That is a direct assertion about a
 * specific earlier finding, which is why it can disposition one that a merely
 * clean review of an unrelated head cannot.
 *
 * Severity and index are carried because a head can raise several findings and
 * a ledger may retire only some of them.
 */
export function extractAllyDispositionedPriorFindings(
  body: string | null | undefined,
): AllyDispositionedPriorFinding[] {
  if (typeof body !== "string") return [];
  const resolved: AllyDispositionedPriorFinding[] = [];
  for (const [, shortSha, severity, index, disposition] of body.matchAll(
    PRIOR_FINDING_DISPOSITION_PATTERN,
  )) {
    if (!RESOLVED_PRIOR_DISPOSITIONS.has(disposition!.toLowerCase())) continue;
    resolved.push({
      shortSha: shortSha!.toLowerCase(),
      severity: severity!.toLowerCase(),
      index: Number(index),
    });
  }
  return resolved;
}

/**
 * The findings a review reports, as the identities Ally's ledger would use, or
 * `null` when they cannot be enumerated.
 *
 * `null` is returned when the body carries no counted bucket at all — its
 * blocking feedback came from an uncounted heading or from prose such as
 * `changes requested`, neither of which yields identities a ledger could name.
 * A caller deciding whether every finding has been retired must treat that as
 * "unknown", not as "none".
 */
export function extractAllyReportedFindingRefs(
  body: string | null | undefined,
): AllyFindingRef[] | null {
  if (typeof body !== "string") return null;
  const refs: AllyFindingRef[] = [];
  let sawBucket = false;
  for (const [, severity, count] of body.matchAll(COUNTED_FINDINGS_BUCKET_PATTERN)) {
    sawBucket = true;
    for (let index = 1; index <= Number(count); index += 1) {
      refs.push({ severity: severity!.toLowerCase(), index });
    }
  }
  return sawBucket ? refs : null;
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
