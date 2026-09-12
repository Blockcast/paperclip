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

// The prose attestation, when the body states exactly one. Ambiguity — none,
// or several — is not an answer, because this decides which tree a required
// check is set against.
function soleProseAttestedHead(text: string): string | null {
  const attestations = Array.from(
    text.matchAll(REVIEWED_HEAD_ATTESTATION_PATTERN),
    (match) => match[1]!.toLowerCase(),
  );
  return attestations.length === 1 ? attestations[0]! : null;
}

export function extractAllyReviewedHeadSha(body: string | null | undefined): string | null {
  // The structured block wins outright when present: it says which tree was
  // examined as a field, so no amount of prose around it can move the answer.
  const block = parseAllyVerdictBlock(body);
  if (block.kind === "ok") return block.verdict.head;
  // An unreadable block attests nothing. Returning null here is safe *only*
  // because evaluateCommentReviewGate detects the same unreadable block and
  // reports it as its own failure outcome — without that, null would fall
  // through to "nothing attests this head", which is a green.
  if (block.kind === "unreadable") return null;
  const text = emittedReviewText(body);
  if (text === null) return null;
  return soleProseAttestedHead(text);
}

/**
 * Ally's structured verdict block — the primary source, with the prose parsers
 * below retained only as the fallback for a body that carries no block.
 *
 * Why a block at all (BLO-32695). Every prose pattern in this file was widened
 * in response to a real review it could not read, each widening was correct,
 * and the family still grew: BLO-29711, BLO-31730, BLO-31947, BLO-31446. The
 * measurement that ended it was a single clean review — paperclip#1675 at
 * 2026-09-07T15:41:42Z, 0 Critical / 0 Important — failing *four* independent
 * patterns at once, for four unrelated reasons: a parenthetical after the
 * attested SHA, a bolded ledger verb, a comma where a dash was required, and a
 * hyphenated severity. Two separate clearing paths existed and prose
 * formatting closed both, so the gate reported a finding Ally had already
 * withdrawn. The space of English an author might write is unbounded; the
 * space this file can enumerate is not.
 *
 * An HTML comment rather than a fenced block, deliberately. A fenced
 * ```ally-verdict payload would be blanked by withoutFencedCodeBlocks before
 * any parser saw it — the block would be invisible to exactly the predicates
 * it exists to serve. The marker is read from *emitted* text for the same
 * reason the retiring predicates are: a review quoted inside a fence must
 * never retire a live finding, and fencing is how a body gets quoted.
 *
 * `ally-verdict:` is not a new token. The bundled github-pr-workflow skill
 * already reserves it to the reviewer service and forbids ordinary agents from
 * posting one (SKILL.md), so the marker namespace this reads was spoken for
 * before it was parsed.
 *
 * ⚠ THE BLOCK MUST BE ADDITIVE, NOT A REPLACEMENT. Four independent readers
 * parse the `Reviewed head:` attestation and only this one understands the
 * block:
 *
 *   1. this module
 *   2. `consolidatedReviewHead` in server/src/services/github-app-auth.ts
 *   3. `ATTESTED_HEAD_RE` in scripts/check-ally-review-consistency.mjs
 *   4. `HEAD_ATTESTATION_RE` in .github/scripts/sweep-stalled-ally-reviews.py
 *
 * A review carrying a block *and* the prose line reads identically to all
 * four, so adding the block breaks nothing. A review carrying only a block
 * would attest nothing to readers 2-4 — reader 2 would raise
 * `pr_review_output_missing` and post a false "reviewer never finished". So
 * whoever changes Ally's emitting side must keep the prose attestation until
 * all four read the block; BLO-31730 was already one instance of two of these
 * parsers disagreeing, and this is the same hazard with more copies.
 *
 * Line-anchored and guarded like every prose pattern in this file, and for a
 * sharper reason than they have. Fencing is not the only way to quote: an
 * indented example, an inline-code mention, and a blockquoted prior review all
 * survive withoutFencedCodeBlocks, and an unanchored opener reads each of them
 * as a *second* block — which is the fail-closed two-blocks red. So the
 * quoting forms this pattern must reject are the ones a reviewer reaches for
 * when discussing the block format itself, on a parser whose own reviews are
 * the likeliest place that discussion happens. Left unanchored, a review of
 * this file wedges its own gate.
 *
 * Recoverable rather than a wedge — it fails closed and the unreadable check
 * is scoped to the newest review, so one more readable review clears it — but
 * the round trip would be a confusing one to debug, and the anchor is free.
 *
 * ⚠ A payload may not contain `-->`: the capture is non-greedy, so an
 * embedded terminator truncates the JSON and the block reads `unreadable`. No
 * current field can carry one; a future free-text field (a `reason`, a `file`
 * holding a diff hunk or a regex) could, and would have to encode it.
 */
const ALLY_VERDICT_BLOCK_PATTERN = new RegExp(
  String.raw`^${NOT_INDENTED_CODE}(?![ \t]*>) {0,3}<!--[ \t]*ally-verdict:(\d+)([\s\S]*?)-->`,
  "gm",
);

// The opener alone, anchored identically to the block above so the two agree
// on what they are looking at. Counting openers is what distinguishes "Ally
// tried to state a verdict and the payload is broken" from "this review
// predates the block" — the pattern above cannot tell them apart, because an
// unterminated marker simply fails to match and reads as `absent`.
//
// It matters because `absent` falls through to the prose parser. A body whose
// block is truncated but whose prose happens to read clean would clear the
// gate on the strength of the very prose the block exists to stop trusting,
// which is a fail-open path through the fail-closed branch.
const ALLY_VERDICT_OPENER_PATTERN = new RegExp(
  String.raw`^${NOT_INDENTED_CODE}(?![ \t]*>) {0,3}<!--[ \t]*ally-verdict:(?:\d+)`,
  "gm",
);

/** The block schema this parser understands. A future shape must bump this. */
const SUPPORTED_ALLY_VERDICT_VERSION = 1;

export interface AllyStructuredDisposition extends AllyFindingRef {
  /** As written by Ally — abbreviated, so callers compare by prefix. */
  head: string;
  /** The verb as a discrete field, not a token cut out of a sentence. */
  verb: string;
}

export interface AllyStructuredVerdict {
  /** The full 40-hex head this review examined. */
  head: string;
  /** Per-severity finding counts, lowercased keys. */
  findings: Map<string, number>;
  dispositions: AllyStructuredDisposition[];
}

/**
 * The outcome of looking for a structured block.
 *
 * `unreadable` is the fail-closed branch and is kept distinct from `absent`
 * because the two must not be treated alike: `absent` means "no block, use the
 * prose fallback", while `unreadable` means "Ally tried to tell us something
 * machine-readable and we could not read it". Collapsing them would make a
 * malformed block silently indistinguishable from a body that never carried
 * one, which is the "no review exists" confusion BLO-32695 asks to end.
 */
export type AllyVerdictBlockParse =
  | { kind: "absent" }
  | { kind: "ok"; verdict: AllyStructuredVerdict }
  | { kind: "unreadable"; reason: string };

/**
 * Note there is deliberately no `undefined` branch here, unlike
 * `asDispositions`. A missing `findings` is rejected by the caller rather than
 * defaulted to an empty map: defaulting is a fail-open path, because zero
 * counts read as a clean verdict, so a block that never stated its counts
 * would clear a head. The asymmetry is the contract's — `findings` is
 * mandatory, `dispositions` is genuinely absent on a review that retires
 * nothing.
 *
 * Returns the counts, or the reason they could not be read — the caller turns
 * that string into `unreadable`. A reason rather than a bare `null` because an
 * unsupported severity key is worth naming: it is almost always a typo, and
 * the gate description is the only place Ally will see which key we rejected.
 */
function asSeverityCounts(raw: unknown): Map<string, number> | string {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return "ally-verdict findings are not severity counts";
  }
  const counts = new Map<string, number>();
  for (const [severity, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      return "ally-verdict findings are not severity counts";
    }
    const key = severity.trim().toLowerCase();
    // An unrecognized key must make the whole block unreadable, not be dropped.
    // Dropping it is a fail-open: no blocking check ever consults a severity
    // outside BLOCKING_SEVERITIES, so `{"critcal": 1}` parses as a readable
    // verdict that is byte-indistinguishable from a clean one — a verdict
    // stating it found a Critical would clear the head. That is the BLO-29711
    // direction arriving through the structured path, so it fails closed here.
    if (!VERDICT_SEVERITIES.has(key)) {
      return `ally-verdict findings name unsupported severity \`${key}\``;
    }
    counts.set(key, value);
  }
  return counts;
}

function asDispositions(raw: unknown): AllyStructuredDisposition[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return null;
  const entries: AllyStructuredDisposition[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return null;
    const { head, severity, index, verb } = item as Record<string, unknown>;
    if (typeof head !== "string" || !/^[0-9a-f]{7,40}$/i.test(head.trim())) return null;
    if (typeof severity !== "string" || !severity.trim()) return null;
    if (typeof verb !== "string" || !verb.trim()) return null;
    if (typeof index !== "number" || !Number.isInteger(index) || index < 1) return null;
    entries.push({
      head: head.trim().toLowerCase(),
      severity: severity.trim().toLowerCase(),
      index,
      verb: verb.trim().toLowerCase(),
    });
  }
  return entries;
}

/**
 * Ally's structured verdict for this body, if it carries one.
 *
 * Fails closed on every ambiguity AC-5 names, and for one reason each:
 *
 *   - Two or more blocks. Nothing picks a winner between conflicting verdicts,
 *     and choosing by position would let an appended block override the real
 *     one.
 *   - An unsupported version. A shape this parser does not know cannot be
 *     trusted field-by-field; reading it optimistically is how a schema change
 *     turns into a silent green.
 *   - Malformed JSON, or a missing/short `head`. A verdict that does not say
 *     which tree it examined attests nothing, so it must not be able to clear
 *     a head by default.
 *   - A missing `findings` object. Absent counts are not zero counts: zero is
 *     a clean verdict, so defaulting would let a partial payload clear a head
 *     it never made a claim about. An *empty* `findings` object still reads —
 *     that is Ally stating counts, not omitting them.
 *   - A prose `Reviewed head:` line that reads cleanly and names a *different*
 *     head. The block would win here and the three prose-only readers would
 *     not, so the same review would attest two different trees depending on
 *     who asked. Only disagreement is fatal; prose that is absent or that this
 *     file cannot parse is the #1675 case the block exists to survive.
 *   - An opener with no `-->` terminator. A truncated payload is Ally trying
 *     to state a verdict and failing, which is not the same fact as a review
 *     that predates the block — and only the latter may use the prose path.
 *
 * Note the asymmetry with the prose fallback: an unreadable *block* is red,
 * whereas an unreadable *body* with no block keeps the historical behavior.
 * That is intentional. Every review posted before this shipped carries no
 * block, so `absent` must stay non-blocking or the gate would red-wedge the
 * whole open-PR population on arrival.
 */
export function parseAllyVerdictBlock(body: string | null | undefined): AllyVerdictBlockParse {
  const text = emittedReviewText(body);
  if (text === null) return { kind: "absent" };
  const blocks = [...text.matchAll(ALLY_VERDICT_BLOCK_PATTERN)];
  // Openers without a matching complete block mean a truncated payload, not an
  // older review. Checked before the `absent` return so a broken block can
  // never fall through to the prose parser it exists to replace.
  const openers = [...text.matchAll(ALLY_VERDICT_OPENER_PATTERN)];
  if (openers.length > blocks.length) {
    return {
      kind: "unreadable",
      reason: `${openers.length - blocks.length} ally-verdict opener(s) have no \`-->\` terminator`,
    };
  }
  if (blocks.length === 0) return { kind: "absent" };
  if (blocks.length > 1) {
    return { kind: "unreadable", reason: `${blocks.length} ally-verdict blocks; expected exactly one` };
  }

  const [, rawVersion, rawPayload] = blocks[0]!;
  if (Number(rawVersion) !== SUPPORTED_ALLY_VERDICT_VERSION) {
    return { kind: "unreadable", reason: `unsupported ally-verdict version ${rawVersion}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawPayload!.trim());
  } catch {
    return { kind: "unreadable", reason: "ally-verdict payload is not valid JSON" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "unreadable", reason: "ally-verdict payload is not a JSON object" };
  }

  const { head, findings, dispositions } = parsed as Record<string, unknown>;
  if (typeof head !== "string" || !/^[0-9a-f]{40}$/i.test(head.trim())) {
    return { kind: "unreadable", reason: "ally-verdict block attests no complete head SHA" };
  }
  if (findings === undefined) {
    return { kind: "unreadable", reason: "ally-verdict block states no findings counts" };
  }
  const counts = asSeverityCounts(findings);
  if (typeof counts === "string") return { kind: "unreadable", reason: counts };
  const ledger = asDispositions(dispositions);
  if (!ledger) return { kind: "unreadable", reason: "ally-verdict dispositions are malformed" };

  // A readable prose attestation naming a *different* head is two claims about
  // which tree was examined, and this module would silently pick the block
  // while the three prose-only readers picked the other one. Fail closed
  // instead — see the additive-block warning above.
  //
  // Asymmetric on purpose: only a *disagreement* is fatal. An unreadable or
  // absent prose line is not, because that is the #1675 case this block exists
  // to survive — requiring the prose to parse would put the retired regex back
  // on the critical path and undo the whole change.
  const attestedHead = head.trim().toLowerCase();
  const proseHead = soleProseAttestedHead(text);
  if (proseHead !== null && proseHead !== attestedHead) {
    return {
      kind: "unreadable",
      reason:
        `ally-verdict head ${attestedHead.slice(0, 7)} disagrees with the prose ` +
        `attestation ${proseHead.slice(0, 7)}`,
    };
  }

  return {
    kind: "ok",
    verdict: { head: attestedHead, findings: counts, dispositions: ledger },
  };
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

// The severities that block a merge, named once so the structured path and the
// prose path cannot disagree about the vocabulary. The prose readers get this
// bound for free from COUNTED_FINDINGS_BUCKET_PATTERN's alternation, which
// enumerates the two blocking buckets and no others; the block reader has no
// such pattern to inherit it from, so it consults this set explicitly.
//
// Naming it matters because the two paths acquire the bound by different
// means. Ally's template mandates a third count, `suggestions`, so a block
// reader that blocks on "any positive count" reds the *most common* review
// shape — clean, with suggestions — while the prose reader it replaces calls
// the same review clean. The divergence also reaches extractAllyReportedFindingRefs:
// a `suggestions` ref can never be retired, because the ledger vocabulary only
// ever dispositions Critical/Important, so the head would carry forever. That
// is the unretirable trap BLO-31446/BLO-31947 exist for, and reintroducing it
// through the new path would make this replacement worse than the prose
// parsing it retires.
//
// A severity added here must be one Ally's ledger can name in a disposition,
// or it re-opens the unretirable carry from the other direction.
const BLOCKING_SEVERITIES: ReadonlySet<string> = new Set(["critical", "important"]);

// The full vocabulary a structured `findings` object may name. Derived from
// BLOCKING_SEVERITIES so the subset relation cannot drift: adding a blocking
// severity above automatically makes it readable here, and the only extra is
// `suggestions`, which reads but never blocks.
//
// Anything outside this set makes the block `unreadable` — see asSeverityCounts
// for why dropping an unknown key is a fail-open rather than a nicety.
const VERDICT_SEVERITIES: ReadonlySet<string> = new Set([...BLOCKING_SEVERITIES, "suggestions"]);

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
  // Structured dispositions carry head/severity/index/verb as discrete fields,
  // so the four prose shapes that silently dropped whole ledger bullets
  // (bolded verb, comma instead of a dash, hyphenated severity, a trailing
  // parenthetical) cannot arise. The verb vocabulary is unchanged: a verb
  // arriving as a field is still classified by classifyPriorDisposition, so an
  // unknown one still fails closed rather than retiring anything.
  const block = parseAllyVerdictBlock(body);
  if (block.kind === "ok") {
    return block.verdict.dispositions.map((entry) => ({
      shortSha: entry.head,
      severity: entry.severity,
      index: entry.index,
      disposition: entry.verb,
      kind: classifyPriorDisposition(entry.verb),
    }));
  }
  if (block.kind === "unreadable") return [];
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
  // Counts as fields, so the raw/stripped max below — which exists purely to
  // stop a fence from swallowing a bucket — has nothing to guard against.
  const block = parseAllyVerdictBlock(body);
  if (block.kind === "ok") {
    const refs: AllyFindingRef[] = [];
    for (const [severity, count] of block.verdict.findings) {
      // Only the blocking severities have finding identities a ledger entry
      // can retire. Minting a ref for `suggestions` would carry the head
      // forever, since no disposition verb ever names one.
      if (!BLOCKING_SEVERITIES.has(severity)) continue;
      for (let index = 1; index <= count; index += 1) refs.push({ severity, index });
    }
    return refs;
  }
  if (block.kind === "unreadable") return null;
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
  for (const bucket of text.matchAll(/\b(?:Critical|Important)\s+Issues\b[*_]*\s*\((\d+)\)/gi)) {
    if (Number(bucket[1]) > 0) return true;
  }
  if (UNCOUNTED_FINDINGS_HEADING_REGEX.test(text)) return true;
  if (/^[ \t]*decision[ \t]*:[ \t]*changes_requested[ \t]*$/im.test(text)) return true;
  if (hasNonNegatedMatch(text, /\bchanges\s+requested\b/i)) return true;
  if (hasNonNegatedMatch(text, /\brequest(?:ed|s)?\s+changes\b/i)) return true;
  return /\bRecommended\s+Action\b[\s\S]{0,400}\bfix\b[\s\S]{0,400}\bbefore\s+merg(?:e|es|ed|ing)\b/i.test(text);
}

/** Return whether a formal or comment-shaped review contains blocking feedback. */
export function hasActionablePrReviewFeedback(body: string | null | undefined, state?: string | null): boolean {
  const normalizedState = state?.trim().toLowerCase();
  if (normalizedState === "changes_requested" || normalizedState === "changes-requested") return true;
  if (typeof body !== "string") return false;

  // With a structured block, the blocking-severity counts decide and nothing
  // else is consulted. This is the AC-3 half of BLO-32695: `blocking_finding`
  // becomes reachable only from a finding Ally actually counted, never from
  // prose that merely reads as actionable. The clauses below stay for
  // block-less bodies, where dropping them would fail open.
  const block = parseAllyVerdictBlock(body);
  if (block.kind === "ok") {
    for (const [severity, count] of block.verdict.findings) {
      if (BLOCKING_SEVERITIES.has(severity) && count > 0) return true;
    }
    return false;
  }
  // A block we cannot read is not evidence of a finding. Saying "carries an
  // unresolved finding" here would attribute a finding to a body whose verdict
  // we failed to parse — the specific misreport BLO-32695 exists to stop. The
  // gate reports the parse failure under its own outcome instead.
  if (block.kind === "unreadable") return false;

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
