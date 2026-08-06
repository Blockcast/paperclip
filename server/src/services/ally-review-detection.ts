/**
 * Ally consolidated-review comment detection — shared between the webhook
 * route (which decides whether a comment should wake a Paperclip issue) and
 * the comment-review gate service (BLO-21907, which decides whether the same
 * comment should fail a GitHub required check). Split out so neither call
 * site duplicates these regexes: each one carries a one-off bug history
 * (BLO-19067, BLO-15942, BLO-18865, #973, #937, #952) that a second copy
 * would be one edit away from silently diverging from.
 */

// Ally's own output has this heading on its own line, as a Markdown heading
// or bold run — optionally indented up to 3 spaces (still a paragraph, not a
// code block). Anchored so a mid-line prose reference ("your Ally —
// Consolidated PR Review flagged X") or a quoted/indented copy (`>` or 4+
// leading spaces) does not match; see hasAllyConsolidatedReviewHeading's
// call site in github-webhook.ts for why that distinction is load-bearing.
const ALLY_CONSOLIDATED_REVIEW_HEADING_PATTERN =
  /^[ \t]{0,3}(?:#{1,6}[ \t]+|\*\*[ \t]*)?Ally[ \t]*(?:—|–|-|:)[ \t]*Consolidated[ \t]+PR[ \t]+Review\b/im;

export function hasAllyConsolidatedReviewHeading(body: string | null | undefined): boolean {
  return typeof body === "string" && ALLY_CONSOLIDATED_REVIEW_HEADING_PATTERN.test(body);
}

// Ally's consolidated-review body carries an immutable attestation of which
// head commit it reviewed, e.g. "Reviewed head: 8f8dcda264aa...". Binding a
// verdict to this (rather than approximating "posted after the last push"
// from the head commit's contributor-controlled committer date — a value a
// pushed `GIT_COMMITTER_DATE` can set to anything) is what lets a gate key on
// an exact reviewed tree instead of a spoofable timestamp. Requires exactly
// one full 40-hex-char match: zero means the comment predates this
// attestation convention (or is malformed), and more than one is ambiguous —
// both return null rather than guessing which one binds.
const REVIEWED_HEAD_ATTESTATION_PATTERN = /(?:^|\n)\s*_?\s*reviewed head:\s*([0-9a-f]{40})\s*_?\s*(?=\n|$)/gi;

export function extractAllyReviewedHeadSha(body: string | null | undefined): string | null {
  if (typeof body !== "string") return null;
  const attestations = Array.from(
    body.matchAll(REVIEWED_HEAD_ATTESTATION_PATTERN),
    (match) => match[1]!.toLowerCase(),
  );
  return attestations.length === 1 ? attestations[0]! : null;
}

// Negation cues that flip an otherwise-actionable bare phrase into a confirmation
// that nothing is required — e.g. Ally's COMMENTED, zero-finding review 4682219268
// on TC PR #1115 said "Clean. No changes requested from this lens", which the bare
// `changes\s+requested` phrase match flagged as actionable and bounced a fully
// approved PR back to the implementer (BLO-15942). Scanned in the text immediately
// preceding a match, bounded to NEGATION_LOOKBACK_WORDS words and stopping at
// sentence punctuation, so a genuine, later occurrence of the phrase elsewhere in
// the body still counts, and an unrelated earlier negation in the same long
// sentence (e.g. "The docs aren't complete, changes requested for section 3.")
// doesn't suppress it.
const NEGATION_CUE_REGEX =
  /\b(?:no|not|zero|none|never|without|isn't|aren't|doesn't|didn't|won't|cannot)\b/i;
const NEGATION_LOOKBACK_WORDS = 8;

// An uncounted "Critical Issues" / "Important Issues" findings section, matched
// only where it starts a line — optionally behind markdown heading (`###`),
// blockquote, bullet/ordered-list, or emphasis (`**`) decoration. See the call
// site in hasActionablePrReviewFeedback for why the anchor is load-bearing.
const UNCOUNTED_FINDINGS_HEADING_REGEX =
  /^[ \t]*(?:[#>]+[ \t]*)?(?:(?:[-*+]|\d+[.)])[ \t]+)?[*_]*(?:Critical|Important)[ \t]+Issues\b(?![*_]*[ \t]*\()/im;

// Returns true if `pattern` matches `text` at least once outside a negated context
// (see NEGATION_CUE_REGEX). Used for bare-phrase heuristics ("changes requested")
// that read very differently as "no changes requested" vs "please make the changes
// requested".
function hasNonNegatedMatch(text: string, pattern: RegExp): boolean {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const regex = new RegExp(pattern.source, flags);
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const preceding = text.slice(0, match.index);
    const sentenceStart = Math.max(preceding.lastIndexOf("."), preceding.lastIndexOf("\n")) + 1;
    const sentenceLocal = preceding.slice(sentenceStart);
    const lookback = sentenceLocal.trim().split(/\s+/).slice(-NEGATION_LOOKBACK_WORDS).join(" ");
    if (!NEGATION_CUE_REGEX.test(lookback)) return true;
    if (regex.lastIndex === match.index) regex.lastIndex += 1;
  }
  return false;
}

export function hasActionablePrReviewFeedback(body: string | null | undefined, state?: string | null): boolean {
  const normalizedState = state?.trim().toLowerCase();
  if (normalizedState === "changes_requested" || normalizedState === "changes-requested") return true;
  if (typeof body !== "string") return false;
  const text = body.trim();
  if (!text) return false;

  // Ally's consolidated review buckets blocking findings under a severity
  // heading with a count, e.g. "### Critical Issues (1)" or "### Important
  // Issues (2)". Any bucket with a non-zero count is actionable. `matchAll`
  // (not `match`) so a zero-count bucket ("Critical Issues (0)") appearing
  // before a non-zero one doesn't mask it. NOTE: keep this list in sync with
  // the reviewer's severity taxonomy — a review that flags "Critical Issues"
  // must not slip through as non-actionable (the BLO-12541/#973 stall).
  for (const bucket of text.matchAll(/\b(?:Critical|Important)\s+Issues\b[*_]*\s*\((\d+)\)/gi)) {
    if (Number(bucket[1]) > 0) return true;
  }
  // Same headings without an explicit count still signal findings. Match the
  // uncounted heading itself so any zero-count bucket, even for the same label,
  // cannot mask a later uncounted findings section.
  //
  // Anchored to the start of a line (allowing markdown heading/list/emphasis
  // decoration) because an unanchored match also fires on ordinary prose that
  // says the opposite: Ally's APPROVED review on Network-Operator-Portal#591
  // read "Looks good. No Critical or Important issues found.", whose trailing
  // "Important issues" matched here and bounced a clean, approved PR back to
  // its author (BLO-19067). A real findings section is always its own heading
  // or list item, never mid-sentence.
  if (UNCOUNTED_FINDINGS_HEADING_REGEX.test(text)) return true;
  if (/^[ \t]*decision[ \t]*:[ \t]*changes_requested[ \t]*$/im.test(text)) return true;
  if (hasNonNegatedMatch(text, /\bchanges\s+requested\b/i)) return true;
  if (hasNonNegatedMatch(text, /\brequest(?:ed|s)?\s+changes\b/i)) return true;
  // Match "before merge" and its inflections ("before merging/merged/merges").
  // The bare `\bmerge\b` form silently missed "before merging" (#973).
  if (/\bRecommended\s+Action\b[\s\S]{0,400}\bfix\b[\s\S]{0,400}\bbefore\s+merg(?:e|es|ed|ing)\b/i.test(text)) return true;
  return false;
}
