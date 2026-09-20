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

// Emphasis and whitespace interleave freely around the SHA, so they are matched
// as one bounded run rather than as an emphasis run that may be followed by
// spaces. Allowing only the latter still dropped the form that closes the label
// and wraps the SHA separately — `**Reviewed head:** \`<sha>\`` — because the
// single permitted run was consumed by `**` and could not then cross the space
// to reach the backtick. That is the same failure mode as BLO-31730 (a real
// review made invisible by its own delimiters), one delimiter combination
// further out, so the run is widened here instead of being enumerated.
//
// The run is length-bounded and the line is anchored at both ends, which is
// what keeps this from reading a prose mention: widening the wrapper cannot
// admit trailing text after the SHA, and the exactly-one rule below — not the
// wrapper's tightness — is what stops a required check being set on a guess.
const ATTESTATION_WRAPPER_RUN = "[*_`\\t ]{0,6}";

// Indentation is bounded to agree with the heading pattern above — see
// NOT_INDENTED_CODE.
//
// The unbounded `[ \t]*` on either side of the bounded wrapper run is
// load-bearing, not redundant with it. Bounding the wrapper is what lets
// emphasis and whitespace interleave; leaving the plain-whitespace runs
// unbounded is what stops that bound from truncating a long run of ordinary
// spaces. Without them, seven or more spaces after the colon — or nine after
// the SHA — overflow `{0,6}` and the attestation stops parsing, which this
// module's header explains is a fail-OPEN: an unattested review is never
// recognised, so the gate reaches not_evaluated rather than blocking. That is
// the BLO-31730 bug class the widening exists to close, so a widening must not
// reintroduce it one delimiter out. Regression cases for all three forms are
// pinned in ally-review-detection.test.ts.
const REVIEWED_HEAD_ATTESTATION_PATTERN = new RegExp(
  `(?:^|\\n)${NOT_INDENTED_CODE} {0,3}${MARKDOWN_EMPHASIS_RUN}[ \\t]{0,3}reviewed head:[ \\t]*` +
    `${ATTESTATION_WRAPPER_RUN}([0-9a-f]{40})${ATTESTATION_WRAPPER_RUN}[ \\t]*(?=\\n|$)`,
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
  // An unreadable block attests nothing, and unlike its two sibling readers
  // this one does *not* fall through to prose. Attesting is how a review
  // retires a prior head's finding, so reading prose here would let a body we
  // failed to parse dispose of a live finding — the one direction that loses
  // information. Carrying is the opposite trade and falls through; see
  // hasActionablePrReviewFeedback.
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
 *   2. `commentAttestsHead` in server/src/services/github-app-auth.ts
 *   3. `ATTESTED_HEAD_RE` in scripts/check-ally-review-consistency.mjs
 *   4. `REVIEWED_HEAD_PATTERN` in .github/scripts/sweep-stalled-ally-reviews.py
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
  String.raw`^${NOT_INDENTED_CODE}(?![ \t]*>) {0,3}<!--[ \t]*ally-verdict:[ \t]*(\d+)([\s\S]*?)-->`,
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
//
// So the opener is deliberately laxer than the block: everything after
// `ally-verdict` is dropped, including the version and its colon. The block
// pattern is the strict reader, and every way of garbling the prefix that the
// opener still recognizes — `ally-verdict:v1`, a version-less
// `ally-verdict {…}` — lands on `openers > blocks` and fails closed, rather
// than missing both patterns and vanishing into `absent`. That matters because
// the emitter is a model transcribing a template out of a fenced example, so
// prefix drift is the likeliest drift there is; the two patterns previously
// shared the `:(\d+)` prefix, which meant any drift in it moved them together
// and the guard could not fire.
//
// Still anchored to the line start, and that bound is kept: an inline
// `… prose. <!-- ally-verdict:1 … -->` reads `absent`. Un-anchoring would let
// a review *of this file* mint a phantom opener out of a quoted marker and
// wedge its own gate, which is the worse failure.
const ALLY_VERDICT_OPENER_PATTERN = new RegExp(
  String.raw`^${NOT_INDENTED_CODE}(?![ \t]*>) {0,3}<!--[ \t]*ally-verdict\b`,
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
 * would clear a head. The same reason makes the blocking keys mandatory *within*
 * a present object — see the loop at the end. The asymmetry is the contract's —
 * `findings` is mandatory, `dispositions` is genuinely absent on a review that
 * retires nothing.
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
    //
    // Checked before the ceiling below, though both fail closed, because only
    // one of the two reasons is actionable: `{"critcal": 5000}` is a typo, and
    // the gate description is the only place Ally sees which key we rejected.
    // Reporting `exceeds 1000` for it names the wrong defect.
    if (!VERDICT_SEVERITIES.has(key)) {
      // Named, not quoted: `key` is model-authored and this reason reaches the
      // same unscrubbed boundary as the ledger verb (PEN-3157) — see
      // asPublishableToken.
      return `ally-verdict findings name unsupported severity \`${asPublishableToken(key)}\``;
    }
    // `Number.isInteger(1e100)` is true, and the ref loops in
    // extractAllyReportedFindingRefs enumerate 1..count. Without a ceiling a
    // single malformed block hangs the gate worker instead of failing it.
    if (value > MAX_VERDICT_FINDING_COUNT) {
      return `ally-verdict findings count \`${key}\` exceeds ${MAX_VERDICT_FINDING_COUNT}`;
    }
    counts.set(key, value);
  }
  // Absent counts are not zero counts — the same rule the caller applies to a
  // missing `findings` object, applied one level down. `{}` and
  // `{"suggestions": 0}` are both a block that never stated what it found, and
  // both read as 0 Critical / 0 Important to the blocking loop, so a partial
  // payload would clear a head it made no claim about. Only the blocking keys
  // are required: `suggestions` cannot fail open, so demanding it would reject
  // honest verdicts for nothing.
  for (const severity of BLOCKING_SEVERITIES) {
    if (!counts.has(severity)) {
      return `ally-verdict findings omit the \`${severity}\` count`;
    }
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
 *   - A missing `findings` object, or one that omits a blocking count. Absent
 *     counts are not zero counts: zero is a clean verdict, so defaulting would
 *     let a partial payload clear a head it never made a claim about. `{}` and
 *     `{"suggestions": 0}` are both omissions by that rule — only an explicit
 *     `critical` and `important` state what was found.
 *   - A prose `Reviewed head:` line that reads cleanly and names a *different*
 *     head. The block would win here and the three prose-only readers would
 *     not, so the same review would attest two different trees depending on
 *     who asked. Only disagreement is fatal; prose that is absent or that this
 *     file cannot parse is the #1675 case the block exists to survive.
 *   - A counted prose bucket naming a *positive* number of a blocking severity
 *     the block states zero of. Same rule, same reason, applied to the field
 *     that decides `blocking_finding` — see proseCountContradicting.
 *   - An opener with no readable version, or no `-->` terminator. A payload
 *     Ally failed to serialize is not the same fact as a review that predates
 *     the block — and only the latter may use the prose path.
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
  // Openers without a matching complete block mean Ally tried to state a
  // verdict and the payload did not survive — a missing `-->`, or a version
  // the strict pattern rejects (`:v1`, or none at all). Not an older review.
  // Checked before the `absent` return so a broken block can never fall
  // through to the prose parser it exists to replace.
  const openers = [...text.matchAll(ALLY_VERDICT_OPENER_PATTERN)];
  if (openers.length > blocks.length) {
    return {
      kind: "unreadable",
      reason: `${openers.length - blocks.length} ally-verdict opener(s) state no readable version or have no \`-->\` terminator`,
    };
  }
  if (blocks.length === 0) return { kind: "absent" };
  if (blocks.length > 1) {
    return { kind: "unreadable", reason: `${blocks.length} ally-verdict blocks; expected exactly one` };
  }

  const [, rawVersion, rawPayload] = blocks[0]!;
  if (Number(rawVersion) !== SUPPORTED_ALLY_VERDICT_VERSION) {
    // Digits only, so it cannot carry a credential — but it is unbounded in
    // length and lands in the uncapped check-run summary with everything else.
    return {
      kind: "unreadable",
      reason: `unsupported ally-verdict version ${rawVersion!.slice(0, PUBLISHABLE_TOKEN_BUDGET)}`,
    };
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
  // which tree was examined. Fail closed instead of silently picking one.
  //
  // Asymmetric on purpose: only a *disagreement* is fatal. An unreadable or
  // absent prose line is not, because that is the #1675 case this block exists
  // to survive — requiring the prose to parse would put the retired regex back
  // on the critical path and undo the whole change. The measurement is in this
  // repo: `extractAllyReviewedHeadSha` on the verbatim #1675 body is `null`
  // (ally-review-verdict-block.test.ts), so under a stricter rule here a review
  // carrying a block *and* a #1675-shaped prose line would read `unreadable` —
  // the exact false red this row retires, reintroduced one layer down.
  //
  // This rule is no longer this module's alone. All four readers of an Ally
  // body now apply it, so none of them can attest a tree the others do not:
  // `commentAttestsHead` in github-app-auth.ts delegates here outright,
  // and `attestedHead`/`canonicalReviewHead` in
  // scripts/check-ally-review-consistency.mjs plus `parse_reviewed_head` in
  // .github/scripts/sweep-stalled-ally-reviews.py mirror it in their own
  // languages, pinned by tests alongside each. Block additivity stays a
  // producer invariant ("the verdict block is additive, never a replacement
  // for the prose line", scripts/ally-agent-idempotency-contract.test.mjs),
  // but the readers no longer *depend* on the producer honouring it — which
  // matters, because the producer is a model following a prompt rather than a
  // serializer, and #1675 is the existence proof that its prose drifts.
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

  const countDisagreement = proseCountContradicting(text, counts);
  if (countDisagreement !== null) return { kind: "unreadable", reason: countDisagreement };

  return {
    kind: "ok",
    verdict: { head: attestedHead, findings: counts, dispositions: ledger },
  };
}

/**
 * Best-effort: the head a body *claims* to have examined, even when its
 * verdict block is unreadable.
 *
 * Deliberately not `extractAllyReviewedHeadSha`, which returns null for an
 * unreadable block and must keep doing so — an unreadable verdict attests
 * nothing, and letting one attest a head would let a broken block clear or
 * carry findings. This answers a different, weaker question: *which tree was
 * this review looking at*, for the sole purpose of deciding whether an
 * unreadable verdict is relevant to the head being evaluated.
 *
 * Weaker on purpose, so the two cannot be confused at a call site: the result
 * is never used as an attestation, only to establish that a review is about
 * some *other* tree. A null answer therefore means "cannot tell", and the
 * caller must fail closed on it.
 *
 * Reads every head claim the body makes — each block's `head` field, plus the
 * prose line — and answers only when they agree. Unanimity rather than
 * first-wins because two of the `unreadable` reasons above literally *are*
 * "this body makes more than one head claim" (a block disagreeing with the
 * prose line, and two blocks), and picking a winner among claims the parse
 * deliberately declined to pick among invents an answer the body never gave.
 * When the invented answer is some other head, the caller stands down and a
 * review carrying a structured Critical goes invisible at the head it
 * concerns — #1675 again, in the fail-open direction.
 *
 * A disagreeing body therefore reds every head, including ones it has nothing
 * to do with. That is the same rule already applied to a body that claims no
 * head at all, and for the same reason: a review that will not say which tree
 * it examined might have examined this one.
 */
export function allyClaimedReviewHead(body: string | null | undefined): string | null {
  const text = emittedReviewText(body);
  if (text === null) return null;
  const claims = new Set<string>();
  for (const [, , rawPayload] of text.matchAll(ALLY_VERDICT_BLOCK_PATTERN)) {
    try {
      const parsed: unknown = JSON.parse(rawPayload!.trim());
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        const { head } = parsed as Record<string, unknown>;
        if (typeof head === "string" && /^[0-9a-f]{40}$/i.test(head.trim())) {
          claims.add(head.trim().toLowerCase());
        }
      }
    } catch {
      // A payload that does not parse states no head. The claims it does not
      // make cannot disagree with anything; the rest of the body still decides.
    }
  }
  const proseHead = soleProseAttestedHead(text);
  if (proseHead !== null) claims.add(proseHead);
  return claims.size === 1 ? claims.values().next().value! : null;
}

/**
 * The head rule above, applied to the field that actually decides
 * `blocking_finding`.
 *
 * The counts outrank every prose clause in `hasActionablePrReviewFeedback` —
 * that is the point of the block — so without this a body whose block states
 * zero while its own prose enumerates `### Critical Issues (2)` resolves
 * `clean`/`success`. That is the BLO-29711 direction arriving through the
 * structured path, and it arrives silently: a green, not a red.
 *
 * The premise is the same one the head rule rests on. The producer is a model
 * following a prompt rather than a serializer, so a prompt edit that renumbers
 * or renames a count field lands before the parser that understands it does
 * (the prompt is `.planning/ally-agent/AGENTS.md`, which takes effect on
 * merge; this file ships on the server's own rollout). Disagreement between
 * the two things the same review says is the only signal available in that
 * window.
 *
 * Asymmetric exactly like the head rule, and for the same reason: only a
 * *positive* prose count against a stated zero is fatal. An absent or
 * unparseable bucket is the #1675 case the block exists to survive, and a
 * block reporting more than the prose does cannot fail open. The #1675 body
 * reads `Critical Issues (0)` / `Important Issues (0)`, so this never fires on
 * it — the fixture is the control.
 *
 * Reads the emitted text, so a quoted or fenced bucket cannot fail a block
 * closed. Unlike `hasActionablePrReviewFeedback`, which reads the raw body
 * too, the fail-open direction here is already covered: the block itself is
 * the claim, and this only cross-checks it.
 */
function proseCountContradicting(text: string, counts: Map<string, number>): string | null {
  for (const [, severity, count] of text.matchAll(EMITTED_COUNTED_FINDINGS_BUCKET_PATTERN)) {
    const key = severity!.toLowerCase();
    if (!BLOCKING_SEVERITIES.has(key)) continue;
    if (Number(count) > 0 && counts.get(key) === 0) {
      return `ally-verdict states 0 \`${key}\` but the review enumerates ${count}`;
    }
  }
  return null;
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

// The alphabet a prose ledger entry may spell its verb in, and — because it is
// the same question — the alphabet any model-authored token may be quoted in
// when the gate names it publicly. Shared as source text with the verb group of
// PRIOR_FINDING_DISPOSITION_PATTERN below so the parser's alphabet and the
// publisher's cannot drift; "the publisher's alphabet is the parser's alphabet"
// in pr-comment-review-gate.test.ts drives both and pins that they agree.
//
// The structured block deliberately does NOT enforce it. An unknown verb
// already fails closed as `unrecognized`, so rejecting the whole block over a
// cosmetic one (`fixed (partially)`) would only manufacture a red, and it would
// put the gate out of step with the two peer readers that type `verb` as any
// non-empty string (`dispositions_ok` in sweep-stalled-ally-reviews.py,
// `stillPresentIn` in check-ally-review-consistency.mjs) — gate red, peers
// silent.
//
// What the alphabet is needed for is publication: see asPublishableToken.
const PUBLISHABLE_TOKEN_ALPHABET = String.raw`[a-z][a-z-]*`;
const PUBLISHABLE_TOKEN_PATTERN = new RegExp(`^${PUBLISHABLE_TOKEN_ALPHABET}$`);

// Characters of a single model-authored token the gate will quote. The
// alphabet already rules out a credential; this only keeps one token from
// crowding out the phrase that makes the red actionable, in the check-run
// summary that — unlike the commit status — has no cap of its own.
const PUBLISHABLE_TOKEN_BUDGET = 48;

// Stands in for a token that must not be published verbatim. It is not a value
// the alphabet admits — `<` is outside it — so it cannot be mistaken for one,
// and it keeps the drift visible while withholding its text.
export const NON_CONFORMING_TOKEN = "<non-conforming>";

/**
 * May this model-authored token be quoted into a public commit-status
 * description?
 *
 * The gate names an unrecognized ledger verb, and an unsupported severity key,
 * verbatim so a reader can tell drift from a genuinely open finding. That
 * description is POSTed by githubPostCommitStatusDetailed, which
 * github-egress-outbound-coverage.test.ts classifies `unscrubbed` under
 * PEN-3157 — so the text it carries is bounded only by whatever produced it.
 * Prose was bounded by the pattern above; the same token arriving as a JSON
 * field or object key is bounded by nothing, so it was published where the
 * identical token in prose was refused. Callers name the drift, not its payload.
 */
export function isPublishableToken(token: string): boolean {
  return PUBLISHABLE_TOKEN_PATTERN.test(token);
}

/** The token itself when that is safe, otherwise a stand-in naming the drift. */
export function asPublishableToken(token: string): string {
  return isPublishableToken(token)
    ? token.slice(0, PUBLISHABLE_TOKEN_BUDGET)
    : NON_CONFORMING_TOKEN;
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
//
// The verb group is PUBLISHABLE_TOKEN_ALPHABET, shared with the publisher
// guard above so the two cannot drift.
const PRIOR_FINDING_DISPOSITION_PATTERN = new RegExp(
  String.raw`^${NOT_INDENTED_CODE} {0,3}-[ \t]*\*\*[ \t]*prior:([0-9a-f]{7,40})[ \t]+([a-z]+)[ \t]+(\d+)[ \t]*\*\*[ \t]*(?:—|–|-)[ \t]*(${PUBLISHABLE_TOKEN_ALPHABET})[ \t]*(?:—|–|-)`,
  "gim",
);

// The severities Ally tallies in a counted bucket. Single source for both the
// pattern below and the "declared clean" test in
// hasActionablePrReviewFeedback, which are 140 lines apart and were otherwise
// silently coupled: adding a third bucket to the alternation without widening
// that test would keep precedence applying on a two-of-three declaration.
// Lowercase because the test compares lowercased captures; the pattern is
// case-insensitive, so the alternation is unaffected.
//
// Deliberately NOT covered: UNCOUNTED_FINDINGS_HEADING_REGEX spells the same
// alternation out literally. It is declared above this constant, so referencing
// it there would read a temporal-dead-zone binding at module load. Adding a
// severity here therefore widens the counted-bucket pattern and the clean
// declaration test but leaves the uncounted-heading detector blind to it —
// update that regex in the same change.
const COUNTED_SEVERITIES = ["critical", "important"] as const;

// The counted finding buckets a review reports, e.g. `### Important Issues (2)`.
// Ally numbers findings within a bucket from 1, and its ledger entries name
// that same (severity, index) pair, so these counts enumerate exactly which
// finding identities a head raised.
const COUNTED_FINDINGS_BUCKET_PATTERN = new RegExp(
  String.raw`\b(${COUNTED_SEVERITIES.join("|")})\s+Issues\b[*_]*\s*\((\d+)\)`,
  "gi",
);

// The same buckets, but only where the review *emits* one as a heading of its
// own — the form that states what this review found, as opposed to a sentence
// mentioning what some earlier pass found.
//
// proseCountContradicting must not share the unanchored pattern above.
// `extractAllyReportedFindingRefs` wants a superset and over-matching there
// only carries extra findings forward; here over-matching fails a *clean*
// review closed, which is the false red this row exists to retire. A sentence
// such as "the previous pass reported Critical Issues (2)" reads as a
// contradiction of a block stating zero, and so does a blockquoted or
// inline-code bucket — which is why every sibling pattern in this file carries
// its own `(?![ \t]*>)` and indentation bound, and this one now does too.
//
// Strict because the emitted form measured strict: across six recent PRs'
// Ally bodies, all 64 genuinely emitted buckets are `### <Severity> Issues
// (N)` — heading, line-anchored, bucket ending the line — and every match that
// was not one of those was prose, a fenced example, a blockquote, or inline
// code. Emphasis is allowed around the heading because Ally has chosen it
// elsewhere. If the emitted form ever grows decoration this does not cover,
// the rule stops firing and the block is trusted as it was before this
// cross-check existed; that degrades to the prior behaviour rather than
// opening something new, whereas a loose pattern reds clean reviews.
const EMITTED_COUNTED_FINDINGS_BUCKET_PATTERN = new RegExp(
  String.raw`^${NOT_INDENTED_CODE}(?![ \t]*>) {0,3}(?:#{1,6}[ \t]*)?[*_]{0,3}` +
    String.raw`(Critical|Important)[ \t]+Issues[ \t]*[*_]{0,3}[ \t]*\((\d+)\)[*_]{0,3}[ \t]*$`,
  "gim",
);

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

// A finding count is a review's tally of one bucket, not an arbitrary integer.
// Both ref loops in extractAllyReportedFindingRefs enumerate 1..count, so an
// unbounded count is a hang: `1e100` from a structured block, `(99999999999)`
// from a prose bucket heading. The structured path rejects anything past this
// (fail closed, the producer is ours); the prose path clamps, because there the
// refs are already a deliberate superset and a review with 1000 open findings
// in one bucket is not a shape worth reddening a PR over.
const MAX_VERDICT_FINDING_COUNT = 1000;

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
  // `unreadable` deliberately falls through to the prose enumeration below, for
  // the reason spelled out in hasActionablePrReviewFeedback: a block we cannot
  // read must not reduce what the gate blocks on. These two have to move
  // together — the carried-finding path asks *both* whether a review blocks and
  // which identities it raised, so a body that blocks here while enumerating
  // `null` there would carry a head no ledger entry could ever retire.
  if (typeof body !== "string") return null;

  // Highest count seen per severity, across both readings. Findings are
  // identified by (severity, index), so a bucket of N contributes indices
  // 1..N; taking the maximum yields a superset of either reading alone.
  const highestCount = new Map<string, number>();
  for (const text of [body, withoutFencedCodeBlocks(body)]) {
    for (const [, severity, count] of text.matchAll(COUNTED_FINDINGS_BUCKET_PATTERN)) {
      const key = severity!.toLowerCase();
      highestCount.set(
        key,
        Math.min(Math.max(highestCount.get(key) ?? 0, Number(count)), MAX_VERDICT_FINDING_COUNT),
      );
    }
  }
  if (highestCount.size === 0) return null;

  const refs: AllyFindingRef[] = [];
  for (const [severity, count] of highestCount) {
    for (let index = 1; index <= count; index += 1) refs.push({ severity, index });
  }
  return refs;
}

export interface ActionableFeedbackOptions {
  /**
   * Whether a `still-present` ledger entry counts as blocking feedback.
   *
   * Defaults to true, which is the question every live caller asks: "does this
   * review say a finding is unresolved right now?" — and an assertion that a
   * prior finding still stands says exactly that.
   *
   * The carry-forward enumeration asks a narrower question, "which findings did
   * *this head* raise?", and passes false. A ledger entry names a finding from
   * an earlier head, and that head is enumerated on its own account, so
   * counting it here would attribute the block to a review whose own buckets
   * are empty. That misattribution is not merely cosmetic: a 0/0 body yields no
   * finding identities, so `isFullyDispositioned` is permanently false for it
   * and no later ledger entry could ever retire the head this named — the
   * unretirable carry-forward BLO-31446 exists to remove.
   */
  readonly countInheritedLedgerAssertion?: boolean;
}

function carriesBlockingFeedback(text: string, options?: ActionableFeedbackOptions): boolean {
  // Shares COUNTED_FINDINGS_BUCKET_PATTERN with extractAllyReportedFindingRefs
  // so the two cannot drift: a body this function reads as "no findings" is
  // exactly one that yields no finding identities there.
  const zeroedSeverities = new Set<string>();
  for (const [, severity, count] of text.matchAll(COUNTED_FINDINGS_BUCKET_PATTERN)) {
    if (Number(count) > 0) return true;
    zeroedSeverities.add(severity!.toLowerCase());
  }
  const declaresNoFindings = COUNTED_SEVERITIES.every((severity) => zeroedSeverities.has(severity));

  if (UNCOUNTED_FINDINGS_HEADING_REGEX.test(text)) return true;
  if (/^[ \t]*decision[ \t]*:[ \t]*changes_requested[ \t]*$/im.test(text)) return true;
  if (hasNonNegatedMatch(text, /\bchanges\s+requested\b/i)) return true;
  if (hasNonNegatedMatch(text, /\brequest(?:ed|s)?\s+changes\b/i)) return true;
  // A `still-present` ledger entry positively asserts that a prior finding
  // stands, which is a statement about this head exactly as a non-zero bucket
  // is — so it belongs here among the hard signals rather than as a carve-out
  // in `declaresNoFindings`. As a carve-out it only ever suppressed the
  // `return false` below, leaving the prose fallback to decide; on any body
  // whose prose lacks the fallback's trigger tokens the assertion was silently
  // ignored. Measured against the three shapes: `still-present` alongside the
  // usual "No Critical issues to fix before merge." boilerplate blocked, but
  // the same entry under a `Recommended Action` reading "Nothing to address."
  // — or under no `Recommended Action` at all, or in a body declaring no
  // counted bucket — read clean. Only `blocks` is consulted, so an
  // unrecognized verb still clears here (see RESOLVED_PRIOR_DISPOSITIONS for
  // why that asymmetry with the carry-forward path is deliberate).
  //
  // The contract says a still-standing finding is mirrored into the current
  // buckets, which would make a count non-zero and return true above; this is
  // the defence for when that mirroring is omitted. It matters because
  // evaluateCommentReviewGate short-circuits on a current-head attestation
  // before consulting the carry-forward, so nothing else re-examines the entry.
  //
  // Matched against the `text` passed in rather than delegated to
  // extractAllyPriorFindingDispositions, which re-applies emittedReviewText
  // internally. Delegating made both passes of hasActionablePrReviewFeedback
  // read stripped text, so the raw pass bought nothing here while the bucket
  // signal beside it genuinely read raw — and an unbalanced fence anywhere
  // above the ledger blanks it to end of body, dropping the entry and letting
  // the raw pass's intact 0/0 clear the gate. This clause is a *blocking*
  // predicate, so it belongs to the detecting group (emitted and raw), not the
  // retiring group (emitted only); see the header at :26-32. The cost is that
  // a fenced paste of a ledger now blocks, which is the false red :486-492
  // already accepts and which the bucket clause already pays.
  if (
    options?.countInheritedLedgerAssertion !== false &&
    Array.from(text.matchAll(PRIOR_FINDING_DISPOSITION_PATTERN)).some(
      (match) => classifyPriorDisposition(match[4]!) === "blocks",
    )
  ) {
    return true;
  }

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
  // Measured twice against the Ally consolidated reviews on the 25 most recent
  // Blockcast/paperclip pull requests. The window slides, so the counts are
  // dated rather than fixed: 7 of 68 flipped when the clause was written, 5 of
  // 62 on re-measurement. Every flip in both runs was true -> false and yielded
  // zero finding identities; none flipped the other way, and every review
  // carrying a counted finding still blocked.
  //
  // The durable form of that result, which does not slide: over the whole
  // corpus this function's verdict is exactly "the body declares at least one
  // counted finding" -- no review is actionable without one, and none carrying
  // one clears. See BLO-31446.
  if (declaresNoFindings) return false;

  return /\bRecommended\s+Action\b[\s\S]{0,400}\bfix\b[\s\S]{0,400}\bbefore\s+merg(?:e|es|ed|ing)\b/i.test(text);
}

/** Return whether a formal or comment-shaped review contains blocking feedback. */
export function hasActionablePrReviewFeedback(
  body: string | null | undefined,
  state?: string | null,
  options?: ActionableFeedbackOptions,
): boolean {
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
  // An unreadable block falls through to prose rather than answering "no
  // finding". Returning false here was a fail-open regression against master,
  // found in peer review of #1721 at 97b4ddd1: `evaluateCommentReviewGate`
  // catches an unreadable block under its own outcome, but that branch is
  // head-scoped, so a review of an *earlier* head became invisible and the
  // finding it carried was not carried. Same body, same prose, same finding,
  // with only the block varying:
  //
  //     prose only (master)        -> failure/carried_finding
  //     prose + well-formed block  -> failure/carried_finding
  //     prose + malformed block    -> success/not_evaluated   <- the hole
  //
  // The trigger is the upgrade path this file documents, not contrived damage:
  // a version bump makes every body unreadable until the rollout catches up,
  // and then one push past the reviewed head turns the red green with the
  // Critical still open — BLO-29711's direction, in the direction the author
  // benefits from. So this is the module's own rule ("quoted text may never
  // reduce what the gate blocks on") one layer out: an unreadable block may not
  // reduce it either. Falling through costs at most a false red, which is
  // visible and recoverable, and it is what master already does with the same
  // prose.
  //
  // Asymmetric with extractAllyReviewedHeadSha, which still returns null here,
  // and the asymmetry is the point: an unreadable verdict may still *carry* a
  // finding, but it may never *retire* one. Attesting is how a review disposes
  // of a prior head, so a body we could not parse must not be able to.
  //
  // AC-3 is intact. It forbids reaching `blocking_finding` from a failure to
  // parse *prose* — a clean body the regex could not read. This path is the
  // opposite: prose that positively states a count, on a body whose structured
  // block is the part that failed. At the head under evaluation the
  // unreadable_verdict branch still runs first and still wins.
  const text = body.trim();
  if (!text) return false;

  // Deliberately the one predicate that reads the raw body as well as the
  // fence-stripped one, and blocks if *either* says so. Everywhere else,
  // ignoring quoted text fails safe; here it would fail open — an unbalanced
  // fence blanks the rest of the body, and a dropped finding silently clears a
  // PR. A quoted finding costs a false red, which is visible and recoverable;
  // a missed one is neither. Same asymmetry that keeps an unrecognized ledger
  // verb from retiring a finding.
  return (
    carriesBlockingFeedback(text, options) ||
    carriesBlockingFeedback(withoutFencedCodeBlocks(text), options)
  );
}
