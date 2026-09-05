/**
 * Shared parsing for Ally's consolidated PR-review output.
 *
 * The webhook uses these predicates to route actionable review feedback, and
 * the comment-review gate uses the same parsing to publish a merge-visible
 * status. Keeping the detection in one dependency-free module avoids subtle
 * differences in which comments wake an author versus block a PR.
 *
 * The distinction between *emitted* review structure and *quoted* text is
 * load-bearing because the only identity check upstream is the author login,
 * and every agent in the fleet comments as that same App
 * (`allyblockcast[bot]`). So an agent quoting a review it is replying to was
 * previously indistinguishable from Ally emitting that review: the quote set
 * the merge-visible status, in either direction.
 *
 * The invariant is *not* that every predicate ignores quoted text, and it is
 * not unconditional. It is directional, and it holds only *once a review has
 * been recognised*:
 *
 *   Quoted text may never *reduce* what the gate blocks on; only emitted text
 *   may retire a finding.
 *
 * That asymmetry decides which side each predicate reads, and the three groups
 * are not interchangeable:
 *
 *   - Retiring (extractAllyPriorFindingDispositions) reads only emitted text.
 *     A quote that reached it would clear a live finding.
 *   - Detecting and enumerating findings (hasActionablePrReviewFeedback,
 *     extractAllyReportedFindingRefs) read emitted *and* raw text and keep
 *     whichever blocks more. Ignoring quotes there would fail open, because an
 *     unbalanced fence blanks the rest of the body and would drop the findings
 *     after it.
 *   - Deciding whether a review exists at all (hasAllyConsolidatedReviewHeading,
 *     extractAllyReviewedHeadSha) reads only emitted text — and here blanking
 *     fails *open*, not closed. A review whose heading or attestation is
 *     swallowed attests no head, so it is never an attesting comment and its
 *     findings are never tracked: the gate reaches not_evaluated instead of
 *     blocking, even though the body still reads as actionable.
 *
 * So for the first two groups quoted text costs at most a false red, which is
 * visible and recoverable. For the third it can cost a false green. That
 * direction is accepted rather than closed, for two reasons: Ally's template
 * puts the heading and `Reviewed head:` in the opening lines with nothing
 * fenceable above them, so reaching it needs Ally to emit a malformed body;
 * and the resulting state is the already-known fail-open that
 * commentReviewGateVerdictIsMisreadable (pr-comment-review-gate.ts) reports
 * under BLO-29711, not a novel silent green. A discriminator does exist — an
 * emitted heading with no emitted attestation but exactly one raw attestation
 * separates a malformed genuine review from a fenced paste, which blanks both
 * lines together — but it is subtle enough to become its own footgun, so it is
 * deliberately not used.
 *
 * The rule for a predicate added later: emitted-only is the safe default for
 * anything that retires or dispositions, and the *wrong* default for anything
 * that decides whether a review is recognised at all.
 */

// A fenced span is quoted content, not emitted structure. Blank the lines
// rather than deleting them so line geometry is preserved exactly: every
// pattern below is line-anchored, and hasNonNegatedMatch's lookback walks
// back to the previous newline, so collapsing lines here would silently
// re-point those anchors at unrelated text.
const FENCE_DELIMITER_PATTERN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE_PATTERN = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

function withoutFencedCodeBlocks(body: string): string {
  if (!body.includes("```") && !body.includes("~~~")) return body;
  const lines = body.split("\n");
  let open: { char: string; length: number } | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (open) {
      const close = FENCE_CLOSE_PATTERN.exec(line);
      const closes = close && close[1]![0] === open.char && close[1]!.length >= open.length;
      lines[i] = "";
      if (closes) open = null;
      continue;
    }
    const fence = FENCE_DELIMITER_PATTERN.exec(line);
    // Per CommonMark a backtick fence's info string may not itself contain a
    // backtick. Honoring that keeps an inline span from opening a phantom
    // fence that would blank the rest of a genuine review.
    if (fence && !(fence[1]![0] === "`" && fence[2]!.includes("`"))) {
      open = { char: fence[1]![0]!, length: fence[1]!.length };
      lines[i] = "";
    }
  }
  // An unclosed fence blanks to end of body, matching how GitHub renders it.
  return lines.join("\n");
}

/** Review text with quoted (fenced) spans removed, or null for a non-string. */
function emittedReviewText(body: string | null | undefined): string | null {
  return typeof body === "string" ? withoutFencedCodeBlocks(body) : null;
}

// CommonMark starts an indented code block at four columns, and a tab always
// advances to the next multiple of four — so a tab anywhere in the leading run
// reaches column four regardless of how few spaces precede it. Both shapes are
// rejected by one lookahead, shared by every line-anchored pattern below,
// because two of them disagreeing about what counts as code is exactly how a
// 4-space paste attested a head while not registering as a review at all. The
// bound is a lookahead rather than a counted run because the emphasis and
// spacing that follow would otherwise absorb the fourth space and re-open the
// hole.
const NOT_INDENTED_CODE = String.raw`(?! *\t)(?! {4})`;

// Ally's own output has this heading on its own line, as a Markdown heading
// or bold run — optionally indented up to three spaces (still a paragraph,
// rather than a code block). A prose mention or quoted heading must not count
// as the review itself.
const ALLY_CONSOLIDATED_REVIEW_HEADING_PATTERN = new RegExp(
  String.raw`^${NOT_INDENTED_CODE} {0,3}(?:#{1,6}[ \t]+|\*\*[ \t]*)?Ally[ \t]*(?:—|–|-|:)[ \t]*Consolidated[ \t]+PR[ \t]+Review\b`,
  "im",
);

export function hasAllyConsolidatedReviewHeading(body: string | null | undefined): boolean {
  const text = emittedReviewText(body);
  return text !== null && ALLY_CONSOLIDATED_REVIEW_HEADING_PATTERN.test(text);
}

// A comment-shaped review attests to the exact head it examined. Require one
// complete standalone SHA: an absent or ambiguous attestation must not be
// guessed at when a required check is being set.
//
// Ally wraps this line's SHA in whatever emphasis it happens to choose, and a
// strict bare-SHA match made an entire real review invisible when it chose
// backticks (BLO-31730) — the review that *resolved* a finding, so the finding
// carried forward against a head that no longer existed and could never be
// re-reviewed. Delimiters are matched as an unbalanced run rather than as
// pairs: what protects a required check from being set on a guess is the
// exactly-one rule below, not delimiter symmetry, and demanding symmetry only
// reintroduces the brittleness this is widening away from.
const MARKDOWN_EMPHASIS_RUN = "[*_`]{0,3}";

// Indentation is bounded to agree with the heading pattern above — see
// NOT_INDENTED_CODE.
const REVIEWED_HEAD_ATTESTATION_PATTERN = new RegExp(
  `(?:^|\\n)${NOT_INDENTED_CODE} {0,3}${MARKDOWN_EMPHASIS_RUN}[ \\t]{0,3}reviewed head:[ \\t]*` +
    `${MARKDOWN_EMPHASIS_RUN}([0-9a-f]{40})${MARKDOWN_EMPHASIS_RUN}[ \\t]*` +
    `${MARKDOWN_EMPHASIS_RUN}[ \\t]*(?=\\n|$)`,
  "gi",
);

export function extractAllyReviewedHeadSha(body: string | null | undefined): string | null {
  const text = emittedReviewText(body);
  if (text === null) return null;
  const attestations = Array.from(
    text.matchAll(REVIEWED_HEAD_ATTESTATION_PATTERN),
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
//
// Indentation is bounded like the heading and attestation patterns. Stripping
// fenced spans alone left this predicate reading a 4-space-indented paste as
// emitted structure, so quoting an earlier ledger retired a live finding —
// fail-open, and the one direction this module must not fail in. All 90
// ledger entries across the 40 most recent PRs' Ally reviews are unindented,
// so the bound excludes no observed real entry; and an entry it did exclude
// would leave a visible red rather than a silent green.
const PRIOR_FINDING_DISPOSITION_PATTERN = new RegExp(
  String.raw`^${NOT_INDENTED_CODE} {0,3}-[ \t]*\*\*[ \t]*prior:([0-9a-f]{7,40})[ \t]+([a-z]+)[ \t]+(\d+)[ \t]*\*\*[ \t]*(?:—|–|-)[ \t]*([a-z][a-z-]*)[ \t]*(?:—|–|-)`,
  "gim",
);

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

// The verb that asserts a prior finding still stands. Kept separate from the
// unrecognized case so callers can tell them apart: a head held red by
// `still-present` is self-explanatory, whereas one held red by a verb nobody
// taught this parser is a mystery worth naming.
const BLOCKING_PRIOR_DISPOSITIONS = new Set(["still-present"]);

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
 * What a ledger verb does to the finding it names.
 *
 * `unrecognized` is not an error state — it is the fail-closed branch. It
 * exists as its own kind purely so a gate can say *why* a finding was not
 * retired instead of leaving a silently unexplained red.
 */
export type PriorDispositionKind = "retires" | "blocks" | "unrecognized";

export interface AllyPriorFindingDisposition extends AllyDispositionedPriorFinding {
  /** The verb exactly as written, lowercased. */
  disposition: string;
  kind: PriorDispositionKind;
}

export function classifyPriorDisposition(disposition: string): PriorDispositionKind {
  const verb = disposition.trim().toLowerCase();
  if (RESOLVED_PRIOR_DISPOSITIONS.has(verb)) return "retires";
  if (BLOCKING_PRIOR_DISPOSITIONS.has(verb)) return "blocks";
  return "unrecognized";
}

/**
 * Every prior-finding ledger entry in this review, classified.
 *
 * The single parse point for the ledger. Callers filter by `kind` rather than
 * calling separate extractors, so the retiring and non-retiring views cannot
 * drift on what counts as an entry.
 *
 * Ally re-states each earlier finding it has re-examined under a "Prior
 * Findings Dispositioned" heading, naming the head the finding was raised
 * against plus its severity and index. That is a direct assertion about a
 * specific earlier finding, which is why a `retires` entry can disposition one
 * that a merely clean review of an unrelated head cannot. Severity and index
 * are carried because a head can raise several findings and a ledger may
 * retire only some of them.
 */
export function extractAllyPriorFindingDispositions(
  body: string | null | undefined,
): AllyPriorFindingDisposition[] {
  const text = emittedReviewText(body);
  if (text === null) return [];
  const entries: AllyPriorFindingDisposition[] = [];
  for (const [, shortSha, severity, index, disposition] of text.matchAll(
    PRIOR_FINDING_DISPOSITION_PATTERN,
  )) {
    const verb = disposition!.toLowerCase();
    entries.push({
      shortSha: shortSha!.toLowerCase(),
      severity: severity!.toLowerCase(),
      index: Number(index),
      disposition: verb,
      kind: classifyPriorDisposition(verb),
    });
  }
  return entries;
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
 *
 * Reads the raw body as well as the fence-stripped one and keeps whichever
 * bucket is larger, for the same reason hasActionablePrReviewFeedback does.
 * Enumerating from stripped text alone fails open: an unbalanced fence blanks
 * everything after it, so a bucket *following* one disappears, and
 * isFullyDispositioned then retires the whole head once the surviving subset is
 * retired — silently clearing the findings the fence swallowed.
 *
 * Neither source subsumes the other, so both are read rather than just the raw
 * one. Blanking a line can only remove a bucket, but the pattern's `\s+` spans
 * newlines, so blanking an interposed line can also *join* two lines into a
 * bucket that the raw text does not contain:
 *
 *     Critical
 *     ```ts        <- blanked, along with its closing fence
 *     x
 *     ```
 *     Issues (2)
 *
 * Raw finds no bucket there; stripped finds `Critical Issues (2)`. The fence
 * has to be *closed* for this: left open it swallows `Issues (2)` as well and
 * both readings find nothing, which is why the open-fence version of this
 * example does not demonstrate the join it was meant to.
 */
export function extractAllyReportedFindingRefs(
  body: string | null | undefined,
): AllyFindingRef[] | null {
  if (typeof body !== "string") return null;

  // Highest count seen per severity, across both readings. Findings are
  // identified by (severity, index), so a bucket of N contributes indices
  // 1..N; taking the maximum yields a superset of either reading alone.
  const highestCount = new Map<string, number>();
  for (const text of [body, withoutFencedCodeBlocks(body)]) {
    for (const [, severity, count] of text.matchAll(COUNTED_FINDINGS_BUCKET_PATTERN)) {
      const key = severity!.toLowerCase();
      highestCount.set(key, Math.max(highestCount.get(key) ?? 0, Number(count)));
    }
  }
  if (highestCount.size === 0) return null;

  const refs: AllyFindingRef[] = [];
  for (const [severity, count] of highestCount) {
    for (let index = 1; index <= count; index += 1) refs.push({ severity, index });
  }
  return refs;
}

function carriesBlockingFeedback(text: string): boolean {
  // Shares COUNTED_FINDINGS_BUCKET_PATTERN with extractAllyReportedFindingRefs
  // so the two cannot drift: a body this function reads as "no findings" is
  // exactly one that yields no finding identities there.
  const zeroedSeverities = new Set<string>();
  for (const [, severity, count] of text.matchAll(COUNTED_FINDINGS_BUCKET_PATTERN)) {
    if (Number(count) > 0) return true;
    zeroedSeverities.add(severity!.toLowerCase());
  }
  const declaresNoFindings = zeroedSeverities.has("critical") && zeroedSeverities.has("important");

  if (UNCOUNTED_FINDINGS_HEADING_REGEX.test(text)) return true;
  if (/^[ \t]*decision[ \t]*:[ \t]*changes_requested[ \t]*$/im.test(text)) return true;
  if (hasNonNegatedMatch(text, /\bchanges\s+requested\b/i)) return true;
  if (hasNonNegatedMatch(text, /\brequest(?:ed|s)?\s+changes\b/i)) return true;

  // The prose fallback below is a heuristic for reviews that carry no counted
  // bucket at all. Ally's own clean-review boilerplate supplies its exact
  // trigger tokens, so running it against a review that has already declared
  // both buckets zero misreads an approval as a blocking finding -- observed on
  // five real bodies across two repos, each phrasing the negation differently:
  //
  //   "1. No Critical issues to fix before merge."                    paperclip#1618
  //   "1. No Critical or Important issues -- nothing to fix before merge."
  //                                                                   multicast#589
  //   "1. Fix Critical issues before merge. _(None.)_"                paperclip#1605
  //
  // Two candidate narrowings were considered and both fail on a real body.
  // A negation guard cannot fix this: hasNonNegatedMatch only inspects the
  // preceding words within a sentence, so the paperclip#1605 body's trailing
  // "(None.)" is invisible to it however the cue list is tuned. Confining the
  // [\s\S]{0,400} spans to one paragraph fails on paperclip#1651, where the
  // three tokens are three unrelated list items -- the heading, then "fix" as a
  // noun naming the PR, then a "before merging" belonging to a rebase
  // instruction. Every token there is used in good faith, so no lexical rule
  // can separate them.
  //
  // Precedence is the fix: an explicit 0/0 is a definitive statement by the
  // reviewer and outranks a guess made from prose. Every signal above stays
  // live, so a review that explicitly requests changes still blocks at 0/0.
  //
  // Measured over the 68 Ally consolidated reviews on the 25 most recent
  // Blockcast/paperclip pull requests, this clause flips exactly 7 reviews,
  // all true -> false, all yielding zero finding identities; no review flips
  // the other way and all 40 carrying real findings still block. See BLO-31446.
  if (declaresNoFindings) return false;

  return /\bRecommended\s+Action\b[\s\S]{0,400}\bfix\b[\s\S]{0,400}\bbefore\s+merg(?:e|es|ed|ing)\b/i.test(text);
}

/** Return whether a formal or comment-shaped review contains blocking feedback. */
export function hasActionablePrReviewFeedback(body: string | null | undefined, state?: string | null): boolean {
  const normalizedState = state?.trim().toLowerCase();
  if (normalizedState === "changes_requested" || normalizedState === "changes-requested") return true;
  if (typeof body !== "string") return false;
  const text = body.trim();
  if (!text) return false;

  // Deliberately the one predicate that reads the raw body as well as the
  // fence-stripped one, and blocks if *either* says so. Everywhere else,
  // ignoring quoted text fails safe; here it would fail open — an unbalanced
  // fence blanks the rest of the body, and a dropped finding silently clears a
  // PR. A quoted finding costs a false red, which is visible and recoverable;
  // a missed one is neither. Same asymmetry that keeps an unrecognized ledger
  // verb from retiring a finding.
  return carriesBlockingFeedback(text) || carriesBlockingFeedback(withoutFencedCodeBlocks(text));
}
