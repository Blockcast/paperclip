#!/usr/bin/env node

/**
 * Guards the integrity of Ally's GitHub review attestations.
 *
 * Ally composes a consolidated review body and posts it with `gh pr review`.
 * Nothing server-side enforces one verdict per head, and several independent
 * wake sources (marker comment, ready_for_review toggle, and review-request
 * issue assignment) can each launch a run for the same PR. Review evidence
 * comes from one lane only: the Ally App's formal review. The `allyblockcast`
 * User seat is a second hat on the same agent, so R4 (BLO-24056) retired it as
 * evidence entirely — see I6. Reviews still arrive on both lanes, so both are
 * parsed; only the App lane can carry a verdict.
 *
 * Observed on Blockcast/paperclip#876 (BLO-19778): two runs dispatched 43 ms
 * apart both submitted at head ff1c72db, 34 s apart, with opposite verdicts.
 *
 *   I1  At most one operative review per lane per (PR, head SHA), EXCEPT where
 *       the App lane's duplicates all carry distinct bodies — see below. A
 *       same-lane duplicate reports whether the bodies are identical or differ
 *       (`sameLaneBodyRelation`), because that — not the gap between
 *       submissions — is what says whether the missing control is submit
 *       idempotency or reviewer exclusion.
 *
 *       On the App-lane `recompute` exemption (BLO-25764). Ally may re-review
 *       an unchanged head: a finding whose remedy is not a code change (a
 *       wrong PR description, a rebase that moved nothing) is addressed
 *       without moving the head, so the re-review lands at the same SHA and
 *       supersedes its predecessor. That is correct behaviour, and it is
 *       observationally identical to the concurrent-run race in the paragraph
 *       above: both yield N canonical App verdicts at one head with differing
 *       bodies and possibly differing dispositions. Measured over every
 *       same-head App duplicate pair on the open PRs (2026-09-23, n=15), the
 *       gap between submissions runs 3 s → 33.6 h with no separation, so no
 *       time threshold distinguishes them either. Asserting `at most 1` over
 *       that shape is therefore unsatisfiable while re-review is permitted —
 *       which is why this guard failed 99/99 scheduled runs from 2026-08-07.
 *       Differing App bodies at one head are reported as a notice
 *       (`findPrNotices`) and the latest submission is the standing verdict;
 *       I2/I3/I4 still evaluate EVERY operative review, so a superseded review
 *       that approves over a blocker is still fatal. Identical bodies keep
 *       failing: one verdict submitted twice has no legitimate explanation.
 *       The exclusion control this gave up belongs at dispatch, where the
 *       concurrency is visible — see BLO-20074.
 *
 *       Three arms here can only fire when an operative seat review exists —
 *       I1 over the seat lane, I1 for one body submitted under two
 *       credentials, and I2b — so I6 already fires wherever they do. They are
 *       retained as subsumed diagnostics that add detail to a seat violation,
 *       not as independent policy: do not read them as evidence that the seat
 *       lane still carries a permitted shape.
 *   I2  No operative APPROVED review whose own body reports a Critical or
 *       Important finding, no User-seat APPROVED review coexisting with a
 *       blocking App review, no App APPROVED coexisting with a different
 *       blocking App review at one head unless it follows every such blocker
 *       and retires, by name, a finding raised against that head (I2e), and no
 *       App approval without a `Reviewed head:` attestation.
 *   I3  An operative App review has exactly one canonical body and its
 *       body-attested `Reviewed head:` matches the commit GitHub recorded it
 *       against.
 *   I4  A clean App verdict is a formal `APPROVED` review. The sole exception
 *       is an App-authored PR: GitHub prevents the App from approving its own
 *       PR, so its clean canonical self-review is necessarily `COMMENTED`. A
 *       clean App `COMMENTED` review cannot satisfy the App lane for any
 *       independently authored PR.
 *   I5  A review using an Ally canonical login and account type must also
 *       carry the immutable REST ID for that principal. A lookalike identity
 *       must never become valid evidence merely by copying the login string.
 *   I6  No operative User-seat review at all. R4 (BLO-24056, ratified on
 *       BLO-29559) made the seat a flat prohibition: it shares a login with
 *       the authoring App, so a seat verdict is self-approval wearing a second
 *       hat. An earlier revision of this file treated the seat as a second
 *       lane of "human evidence" that "may use plain exact-head prose" and so
 *       need not attest a head — which is exactly why BLO-22916 Defect 2, five
 *       content-free seat APPROVEDs carrying no `Reviewed head:` line, was
 *       invisible to every check here.
 *
 * On I3's mechanism. An earlier revision of this file said `gh pr review`
 * binds a review to the head at submit time, so a mid-review push "certifies a
 * tree that was never read". Submit-time binding is real but it is not what
 * produces most I3 hits, and the difference matters because the old wording
 * blamed the reviewer for a value the reviewer never set. Measured on #1104
 * (2026-08-07), a force-push re-anchored an existing review's `commit_id` to a
 * commit created after submission. The body's attestation is therefore the
 * record of which tree was examined; I3 remains fatal when it disagrees with
 * the current head.
 *
 * "Operative" excludes DISMISSED and PENDING: a dismissed review is disposed,
 * not a standing attestation.
 *
 * Do not replace this with the obvious shell one-liner that groups reviews by
 * commit_id and flags a group when its states differ. That formulation misses
 * two of the three invariants: identical duplicate verdicts (two APPROVEDs at
 * one head) have one unique state and slip through, and it has no notion of I3
 * at all. It also counts DISMISSED as a live divergent state, so it fires on
 * PRs that were correctly dispositioned. On the run that motivated this file it
 * found 1 instance where this script found 4.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// GitHub exposes this App as either its bot login or `app/<slug>` depending on
// the API surface. The bare `allyblockcast` login is the distinct User seat.
// A login alone is not review evidence: the REST review object must also carry
// the expected GitHub account type, so a lookalike/incorrectly typed identity
// cannot satisfy either protected-review lane.
const ALLY_APP_LOGIN_RE = /^(?:allyblockcast\[bot\]|app\/allyblockcast)$/;
const ALLY_APP_REVIEW_LOGIN_RE = /^allyblockcast\[bot\]$/;
const ALLY_SEAT_LOGIN_RE = /^allyblockcast$/;
const CANONICAL_REVIEW_HEADING_RE = /(?:^|\n)## Ally — Consolidated PR Review[ \t]*(?=\n|$)/gi;

/** A heading like `### Important Issues (2)` — but not `(0)`. */
const BLOCKING_SECTION_RE =
  /(?:^|\n)#+[ \t]*(critical|important)[^\n]*\((?!0\))\d+\)/i;

/**
 * Leading whitespace that CommonMark would render as an indented code block,
 * i.e. quoted text rather than emitted structure. Four spaces reach column
 * four, and so does a tab however few spaces precede it.
 *
 * Must stay equivalent to NOT_INDENTED_CODE in
 * server/src/services/ally-review-detection.ts. BLO-31730 is a bug about two
 * parsers disagreeing on this exact line, so the auditor and the merge gate
 * must not disagree about which indentation counts.
 *
 * Byte-identical to the module's, and each use site appends its own ` {0,3}`
 * exactly as the module's do. It used to fold that quantifier in, which left
 * the two block patterns below carrying two ` {0,3}` runs where the gate has
 * one — harmless, because the leading `(?! {4})` caps the run at three either
 * way, but a same-named mirror constant holding different content is the drift
 * vector this file exists to close (Ally review of #1721 at bbe6d640).
 *
 * The attestation is matched over fence-stripped text, as the gate matches it
 * (attestedHeadFrom), so a *fenced* paste is not an attestation here either.
 */
// Line anchors here are spelled `(?:^|\n)` and `(?=\n|$)`, no pattern in this
// file carries the `m` flag, and no pattern uses a wildcard `.`. U+2028/U+2029
// reach a pattern through either: JS's `m` stops at `\r`, U+2028 and U+2029,
// and JS's `.` excludes the same three, while Python's re.MULTILINE and `.` --
// and CommonMark -- recognise only `\n`. `\r` is normalised away at entry by
// `reviewText`. Either one is therefore a silent divergence from the sweep, and
// the loop it opens is the one this row exists to close: the gate counts a
// bucket the sweep cannot see and reds the head, while the sweep reads the head
// as attested and suppresses the re-request that would clear the red (Ally,
// #1721 at 1bc85198 and 068806d6, Important 1 both times -- the second arrived
// through the character class after the flag axis was closed).
//
// Pinned for patterns added later by "no reader pattern may treat U+2028/U+2029
// as a line break" in scripts/check-ally-review-consistency.test.mjs, which
// scans both axes and states its own reach.
const NOT_INDENTED_CODE = String.raw`(?! *\t)(?! {4})`;

/**
/**
 * A prior-finding ledger entry. Composed character-for-character with
 * PRIOR_FINDING_DISPOSITION_PATTERN in server/src/services/ally-review-detection.ts
 * (mirrored verbatim in .github/scripts/sweep-stalled-ally-reviews.py).
 */
const PRIOR_FINDING_DISPOSITION_RE = new RegExp(
  String.raw`(?:^|\n)${NOT_INDENTED_CODE} {0,3}-[ \t]*\*\*[ \t]*prior:([0-9a-f]{7,40})[ \t]+([a-z]+)[ \t]+(\d+)[ \t]*\*\*[ \t]*(?:—|–|-)[ \t]*([a-z][a-z-]*)[ \t]*(?:—|–|-)`,
  "gi",
);

/** Every counted bucket, including `(0)`, used for finding coverage. */
const COUNTED_SECTION_GLOBAL_RE = new RegExp(
  String.raw`^${NOT_INDENTED_CODE}(?:[#>][ \t]*)*(?:(?:[-*+]|\d+[.)])[ \t]+)?[*_]*(critical|important)[ \t]+Issues\b[*_]*[ \t]*\((\d+)\)`,
  "gim",
);

/** A prior-finding disposition that says the blocker is still present. */
const STILL_PRESENT_DISPOSITION_RE = new RegExp(
  String.raw`^${NOT_INDENTED_CODE}-[ \t]*\*\*prior:[^\n]*\*\*[ \t]*(?:—|-)[ \t]*still-present[ \t]*(?:—|-)`,
  "im",
);
);

/**
 * A prior-finding disposition that defers an accepted finding to a follow-up
 * issue (`tracked`, BLO-36903). Unlike STILL_PRESENT_DISPOSITION_RE this one
 * EXEMPTS (I4), so the loose `prior:[^\n]*` convention, fail-safe in a
 * trigger, would be fail-open here: it must not match a ledger entry the gate
 * would not count as a deferral. So the ref, severity and index use the gate's
 * own grammar (PRIOR_FINDING_DISPOSITION_PATTERN, ally-review-detection.ts), and
 * the verb must end at `tracked`: the gate captures `[a-z][a-z-]*` whole and
 * exact-matches it, so `tracked-elsewhere` is not a deferral there.
 *
 * `(?:^|\n)` with no `m` flag, matching PRIOR_FINDING_DISPOSITION_RE above and
 * the gate's PRIOR_FINDING_DISPOSITION_PATTERN -- which is what
 * countAllyDeferredPriorFindings actually reads deferrals through. Under `m`,
 * JS's `^` also starts a line after U+2028/U+2029 and the sweep's re.MULTILINE
 * does not, so a ledger entry opening after U+2028 exempted here while the gate
 * read it as still-blocking. That is the divergence this file exists to catch,
 * in the direction that silently clears a red.
 */
const TRACKED_DISPOSITION_RE = new RegExp(
  String.raw`(?:^|\n)${NOT_INDENTED_CODE}-[ \t]*\*\*[ \t]*prior:[0-9a-f]{7,40}[ \t]+[a-z]+[ \t]+\d+[ \t]*\*\*[ \t]*(?:\u2014|\u2013|-)[ \t]*tracked(?![a-z-])[ \t]*(?:\u2014|\u2013|-)`,
  "i",
);

/**
 * The single standalone attestation line Ally is required to emit.
 *
 * The emphasis runs mirror MARKDOWN_EMPHASIS_RUN / ATTESTATION_WRAPPER_RUN in
 * ally-review-detection.ts:166-167 and sweep-stalled-ally-reviews.py:92-104,
 * character for character. This reader was left on the narrow
 * `(?:[_*]+)?` / `` \`? `` form while the other two were widened, and the shape
 * it dropped is the one this repo's own comment names at
 * ally-review-detection.ts:138-143 — ``**Reviewed head:** `<sha>` `` — where the
 * single permitted run is consumed by `**` and cannot then cross the space to
 * reach the backtick. Measured on the same bodies before this change: gate 1,
 * python 1, mjs 0, for both that form and `_Reviewed head:_ <sha>`.
 *
 * Block-carrying bodies masked it, because attestedHeadFrom falls through to
 * block.head. The harm landed on the entire pre-block population, where
 * canonicalReviewHead returned null and operativeAllyReviews dropped a review
 * the gate reads fine — in a file whose stated purpose is reader parity.
 *
 * The inter-run bound is `[ \t]{0,3}` rather than `[ \t]*` deliberately: the
 * widening has a converse, and `*` here would accept a line the gate rejects,
 * which is the same divergence one delimiter out.
 */
const MARKDOWN_EMPHASIS_RUN = String.raw`[*_\`]{0,3}`;
const ATTESTATION_WRAPPER_RUN = String.raw`[*_\`\t ]{0,6}`;
// The gate's exact anchors, `(?:^|\n)` ... `(?=\n|$)` with no `m` flag, not
// `^`/`$` under `m`: JS's multiline `$` also stops before `\r`, `\u2028` and
// `\u2029`, so on a CRLF body this credited an attestation the gate cannot read
// -- the missed-red direction, inverting this auditor's safe one (Ally, #1721
// at 5f4d5302, Important 4).
const RETIRING_DISPOSITION_GLOBAL_RE = new RegExp(
  String.raw`^${NOT_INDENTED_CODE}-[ \t]*\*\*[ \t]*prior:([0-9a-f]{7,40})[ \t]+([a-z]+)[ \t]+(\d+)[ \t]*\*\*[ \t]*(?:—|–|-)[ \t]*(?:fixed|no-longer-applicable)[ \t]*(?:—|–|-)`,
  "gim",
);


/** The single standalone attestation line Ally is required to emit. */
const ATTESTED_HEAD_RE = new RegExp(
  String.raw`(?:^|\n)${NOT_INDENTED_CODE} {0,3}${MARKDOWN_EMPHASIS_RUN}[ \t]{0,3}reviewed head:[ \t]*` +
    String.raw`${ATTESTATION_WRAPPER_RUN}([0-9a-f]{40})${ATTESTATION_WRAPPER_RUN}[ \t]*(?=\n|$)`,
  "gi",
);

// Ally's structured verdict block — the primary source, mirroring
// server/src/services/ally-review-detection.ts so this reader and the gate
// cannot disagree about which tree was reviewed. The prose line above is the
// fallback for a body carrying no block.
const VERDICT_BLOCK_RE = new RegExp(
  String.raw`(?:^|\n)${NOT_INDENTED_CODE}(?![ \t]*>) {0,3}<!--[ \t]*ally-verdict:[ \t]*(\d+)([\s\S]*?)-->`,
  "g",
);
const VERDICT_OPENER_RE = new RegExp(
  String.raw`(?:^|\n)${NOT_INDENTED_CODE}(?![ \t]*>) {0,3}<!--[ \t]*ally-verdict\b`,
  "g",
);
const SUPPORTED_VERDICT_VERSION = 1;

// Mirrors the same-named constants in ally-review-detection.ts. The block is
// the authoritative statement of what a review found, so this auditor must read
// the same fields the gate reads: a body whose prose buckets carry no `(N)`
// counts is not evidence of a clean review once the block says otherwise.
const MAX_VERDICT_FINDING_COUNT = 1000;
const BLOCKING_SEVERITIES = ["critical", "important"];
const VERDICT_SEVERITIES = new Set([...BLOCKING_SEVERITIES, "suggestions"]);
const BLOCKING_PRIOR_DISPOSITIONS = new Set(["still-present"]);

/**
 * The pre-structured still-present line, for the *verdict* question only.
 *
 * Two different questions were being asked of one function. "Is this a ledger
 * entry?" must answer exactly what the gate and the sweep answer, or the
 * three readers disagree about a body and the gate-red/sweep-satisfied
 * deadlock opens — that is hasStillPresentDisposition, and it stays strict.
 * "Does this review carry a blocking verdict?" is a fail-closed safety test
 * with a different consumer (scripts/ally-review-de-dupe.mjs dismisses a
 * review it reads as non-blocking), and there an entry whose label Ally wrote
 * as prose rather than as the `prior:<sha> <severity> <index>` triple must
 * still block. Narrowing the verdict question to the ledger pattern made that
 * read clean (Ally, #1721 at 53ca8a92, Critical 1 — reproduced by
 * scripts/ally-review-de-dupe.test.mjs:129 and :220).
 *
 * This is the shape master shipped, widened only in directions that add
 * matches — leading indent up to 3, space after the `**`, en dash alongside em
 * dash and hyphen — so every body the old reader blocked on still blocks.
 * `(?:^|\n)` without `m`, per the U+2028/U+2029 rule the rest of this file and
 * its test scan enforce.
 */
const LOOSE_STILL_PRESENT_RE = new RegExp(
  String.raw`(?:^|\n)${NOT_INDENTED_CODE} {0,3}-[ \t]*\*\*[ \t]*prior:[^\n]*\*\*[ \t]*(?:—|–|-)[ \t]*still-present[ \t]*(?:—|–|-)`,
  "i",
);

/**
 * The block's per-severity counts, or `null` when the payload cannot be
 * trusted. Per-severity rather than a bare "does it block": the count rule
 * below needs to know which severity states zero, and a boolean cannot say.
 *
 * Absent counts are not zero counts, and an unknown severity key is not a key
 * to drop: both are fail-open routes by which a block claiming a finding reads
 * byte-identically to a clean one. See asSeverityCounts for the long form.
 */
function severityCountsIn(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const counts = new Map();
  for (const [severity, value] of Object.entries(raw)) {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return null;
    if (value > MAX_VERDICT_FINDING_COUNT) return null;
    const key = severity.trim().toLowerCase();
    if (!VERDICT_SEVERITIES.has(key)) return null;
    // Two keys normalizing to one severity: last-wins would let
    // `{"critical":1,"Critical":0}` read clean. Mirrors the guard in
    // ally-review-detection.ts and sweep-stalled-ally-reviews.py — all three
    // readers shared the bug identically, so none of them caught it.
    if (counts.has(key)) return null;
    counts.set(key, value);
  }
  if (!BLOCKING_SEVERITIES.every((severity) => counts.has(severity))) return null;
  return counts;
}

/**
 * A counted bucket the review *emits* that names a positive number of a
 * severity the block states zero of — mirroring proseCountContradicting in
 * ally-review-detection.ts.
 *
 * Here because the gate treats this as unreadable and this reader did not, so
 * the same body attested a head here while reading as a broken verdict there —
 * the cross-reader divergence BLO-31730 is about, on the field that decides
 * whether a merge is blocked.
 *
 * Anchored to the emitted heading form for the reason the module's copy is: an
 * unanchored bucket matches a sentence *referencing* an earlier pass's counts,
 * and over-matching fails a clean review closed.
 */
// The gate's anchors, as at PRIOR_FINDING_DISPOSITION_RE and ATTESTED_HEAD_RE.
const EMITTED_BUCKET_RE = new RegExp(
  String.raw`(?:^|\n)${NOT_INDENTED_CODE}(?![ \t]*>) {0,3}(?:#{1,6}[ \t]*)?[*_]{0,3}` +
    String.raw`(Critical|Important)[ \t]+Issues[ \t]*[*_]{0,3}[ \t]*\((\d+)\)[*_]{0,3}[ \t]*(?=\n|$)`,
  "gi",
);

/**
 * Fenced spans blanked, so a quoted bucket cannot fail a block closed.
 *
 * Mirrors withoutFencedCodeBlocks in the gate exactly — tilde fences, fence
 * length matching and the backtick info-string rule. A simpler toggle here is
 * not a scoping choice but a divergence: the two readers then disagree about
 * how many blocks a body contains, which is the BLO-31730 cross-reader failure
 * one layer down, and it fires first on a review that quotes the marker
 * template. Applied to this cross-check, to the block and opener counts in
 * structuredVerdict, and to the prose attestation in attestedHeadFrom.
 */
/**
 * The body with every line ending normalized to `\n` -- the single entry point
 * for every reader below, mirroring reviewBody in ally-review-detection.ts and
 * review_text in sweep-stalled-ally-reviews.py. JS `.` excludes `\r` and
 * Python's matches it, so on a CRLF body fence-stripping was a no-op here and
 * the three readers returned three verdicts (Ally, #1721 at 5f4d5302,
 * Critical 3).
 */
function reviewText(body) {
  return String(body ?? "").replace(/\r\n?/g, "\n");
}

// The info string is `[^\n]*`, never `.` -- see FENCE_DELIMITER_PATTERN in
// ally-review-detection.ts. JS's `.` excludes `\r`, U+2028 and U+2029 as well as
// `\n`; Python's FENCE_OPEN_PATTERN and CommonMark exclude only `\n`. A bare `.`
// here opens no fence on an info string carrying U+2028 while the sweep opens
// one, which is the gate-red/sweep-satisfied deadlock through the character
// class instead of the `m` flag.
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})([^\n]*)$/;
const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

// `keepUnterminated` mirrors the gate's: a fence that never closes is left as
// emitted text, for the fail-closed count and ledger cross-checks only.
function withoutFencedSpans(text, keepUnterminated = false) {
  if (!text.includes("```") && !text.includes("~~~")) return text;
  let open = null;
  let openedAt = -1;
  const lines = text
    .split("\n")
    .map((line, i) => {
      if (open) {
        const close = FENCE_CLOSE_RE.exec(line);
        if (close && close[1][0] === open.char && close[1].length >= open.length) open = null;
        return "";
      }
      const fence = FENCE_OPEN_RE.exec(line);
      // Per CommonMark a backtick fence's info string may not itself contain a
      // backtick, so an inline span cannot open a phantom fence that would
      // blank the rest of a genuine review.
      if (fence && !(fence[1][0] === "`" && fence[2].includes("`"))) {
        open = { char: fence[1][0], length: fence[1].length };
        openedAt = i;
        return "";
      }
      return line;
    });
  if (open && keepUnterminated) {
    return [...lines.slice(0, openedAt), ...text.split("\n").slice(openedAt)].join("\n");
  }
  return lines.join("\n");
}

// Any emitted count above the block's, not only against a stated zero --
// mirroring the gate (Ally, #1721 at 5f4d5302, Important 2). The caller passes
// the cross-check reading (an unterminated fence kept, Important 1).
function proseCountContradicts(text, counts) {
  for (const [, severity, count] of text.matchAll(EMITTED_BUCKET_RE)) {
    const key = severity.toLowerCase();
    if (!BLOCKING_SEVERITIES.includes(key)) continue;
    if (Number(count) > counts.get(key)) return true;
  }
  return false;
}

/** `true`/`false` per the ledger, `null` when an entry is malformed. */
function stillPresentIn(raw) {
  if (raw === undefined) return false;
  if (!Array.isArray(raw)) return null;
  let stillPresent = false;
  for (const item of raw) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return null;
    const { head, severity, index, verb } = item;
    if (typeof head !== "string" || !/^[0-9a-f]{7,40}$/i.test(head.trim())) return null;
    if (typeof severity !== "string" || !severity.trim()) return null;
    if (typeof verb !== "string" || !verb.trim()) return null;
    if (typeof index !== "number" || !Number.isInteger(index) || index < 1) return null;
    if (BLOCKING_PRIOR_DISPOSITIONS.has(verb.trim().toLowerCase())) stillPresent = true;
  }
  return stillPresent;
}

/**
 * `{ kind: "absent" }` when no block is present (fall back to prose),
 * `{ kind: "unreadable" }` when one is present but cannot be trusted (fail
 * closed — never fall back), or
 * `{ kind: "ok", head, blockingFindings, stillPresent }`.
 *
 * Counted over fence-stripped text, because the gate counts over fence-stripped
 * text: `parseAllyVerdictBlock` reads `emittedReviewText(body)`. Reading the raw
 * body here made a fenced ```` ```markdown ```` example of the marker a *second*
 * block — gate `blocks=1, openers=1` → ok, this reader `blocks=2, openers=2` →
 * unreadable, on one body. The divergence matters in the direction the sweep
 * runs: `ally_has_reviewed_head` goes false, so it re-requests a review of a
 * head Ally already reviewed, and each duplicate is a `COMMENTED` review that
 * cannot be dismissed — the BLO-22892/BLO-28203 loop, reintroduced through the
 * new path. It fires first on a review quoting the template, which is the
 * likeliest shape for a review *of this feature* (found in peer review of
 * #1721 at 97b4ddd1).
 *
 * The count and ledger cross-checks keep an unterminated fence as emitted
 * text, as the gate's do: blanked, it would hide the bucket that contradicts
 * the block.
 */
function structuredVerdict(rawText) {
  const text = withoutFencedSpans(rawText);
  const blocks = Array.from(text.matchAll(VERDICT_BLOCK_RE));
  const openers = Array.from(text.matchAll(VERDICT_OPENER_RE));
  // A truncated payload is a broken block, not an older review, so it must not
  // fall through to the prose parser the block exists to replace.
  if (openers.length > blocks.length) return { kind: "unreadable" };
  if (blocks.length === 0) return { kind: "absent" };
  if (blocks.length > 1) return { kind: "unreadable" };
  if (Number(blocks[0][1]) !== SUPPORTED_VERDICT_VERSION) return { kind: "unreadable" };
  let parsed;
  try {
    parsed = JSON.parse(blocks[0][2].trim());
  } catch {
    return { kind: "unreadable" };
  }
  const head = parsed?.head;
  if (typeof head !== "string" || !/^[0-9a-f]{40}$/i.test(head.trim())) {
    return { kind: "unreadable" };
  }
  const counts = severityCountsIn(parsed?.findings);
  const stillPresent = stillPresentIn(parsed?.dispositions);
  if (counts === null || stillPresent === null) return { kind: "unreadable" };
  const crossCheckText = withoutFencedSpans(rawText, true);
  if (proseCountContradicts(crossCheckText, counts)) return { kind: "unreadable" };
  // The same rule on the other field, mirroring proseDispositionContradicting
  // in ally-review-detection.ts. `structuredBlocking(body, "stillPresent") ??
  // hasStillPresentDisposition(body)` in reportsStillPresent gives the block
  // precedence, so a block stating no standing prior finding suppressed the
  // prose ledger entirely — this reader carried the identical fail-open the
  // gate did.
  //
  // Asymmetric like the count rule: only a *blocking* prose entry against a
  // block that retires everything is fatal, so `stillPresent` true short-
  // circuits and a `fixed` prose entry the block omits still reads clean.
  if (!stillPresent && hasStillPresentDisposition(crossCheckText)) return { kind: "unreadable" };
  return {
    kind: "ok",
    head: head.trim().toLowerCase(),
    blockingFindings: BLOCKING_SEVERITIES.some((severity) => counts.get(severity) > 0),
    stillPresent,
  };
}

/**
 * The head this body attests, from the structured block when it carries one and
 * the prose line otherwise. Null on any ambiguity, which every caller reads as
 * "not a signal for this head".
 *
 * Asymmetric on purpose, matching `extractAllyReviewedHeadSha`: only a prose
 * line *disagreeing* with the block is fatal. An absent or unparseable prose
 * line is not — that is the #1675 body (an attested SHA trailed by a
 * parenthetical), and requiring the prose to parse would put the retired regex
 * back on the critical path.
 */
function attestedHeadFrom(text) {
  const block = structuredVerdict(text);
  if (block.kind === "unreadable") return null;
  // Over the fence-stripped text, as the gate reads it. The raw body let one
  // fenced copy of the attestation make the prose ambiguous here while the
  // gate read the emitted line and failed the block on disagreement, so the
  // two returned opposite verdicts (Ally, #1721 at 5f4d5302, Important 3).
  const attestations = Array.from(withoutFencedSpans(text).matchAll(ATTESTED_HEAD_RE));
  const proseHead = attestations.length === 1 ? attestations[0][1].toLowerCase() : null;
  if (block.kind === "absent") return proseHead;
  return proseHead !== null && proseHead !== block.head ? null : block.head;
}

const ALLY_REVIEW_LANES = ["app", "seat"];

function normalizedLogin(login) {
  return String(login ?? "").trim().toLowerCase();
}

function normalizedAccountType(user) {
  return String(user?.type ?? "").trim().toLowerCase();
}

function laneLabel(lane) {
  return lane === "app" ? "Ally App" : "Ally User seat";
}

function reviewState(review) {
  return String(review?.state ?? "UNKNOWN").toUpperCase();
}

function isDismissedOrPending(review) {
  const state = reviewState(review);
  return state === "DISMISSED" || state === "PENDING";
}

function isApproved(review) {
  return reviewState(review) === "APPROVED";
}

/**
 * One fact from the structured block: `true`/`false` when the block states it,
 * `null` when there is no block and the prose fallback should answer instead.
 *
 * The block is authoritative when present. Its `findings` counts are the
 * producer's own tally, and a review may head its buckets `### 🚨 Critical`
 * with no `(N)` -- the form the template prescribed until #1721 corrected it to
 * the counted one -- so the prose readers see a blocking review as clean. That
 * gap is the whole reason this reader exists, and historical bodies keep it
 * live whatever the template now says.
 *
 * An unreadable block answers `false` to every *field* query and is reported
 * once by I2e instead. It previously answered `true` to all of them, so a
 * single unreadable verdict surfaced under both I2a and I2c with two mutually
 * exclusive and factually false causes -- the body cannot both report an open
 * finding and mark a prior one still-present when nothing in it was read at
 * all (Ally, #1721 at 5f4d5302, Suggestion 1). Nothing is masked: `I2e` states
 * the true cause, and `hasBlockingVerdict` keeps counting unreadable as
 * blocking, so every fail-closed consumer is unchanged.
 *
 * `false`, not `null`: `null` would hand the question to the prose fallback,
 * and a block Ally tried and failed to state is not the same fact as a review
 * that predates the block. The gate refuses that same fallback for that same
 * reason (`parseAllyVerdictBlock`, ally-review-detection.ts).
 */
function structuredBlocking(body, field) {
  const block = structuredVerdict(reviewText(body));
  if (block.kind === "unreadable") return false;
  if (block.kind === "absent") return null;
  return block[field];
}

/** I2e's fact: the body carries a block, and none of it could be read. */
function structuredUnreadable(body) {
  return structuredVerdict(reviewText(body)).kind === "unreadable";
}

/**
 * I2a's fact: the body reports an open Critical/Important finding.
 *
 * Kept separate from reportsStillPresent because I2a and I2c name different
 * defects, and a review must not be reported for the other one's cause.
 */
function reportsBlockingFindings(body) {
  return structuredBlocking(body, "blockingFindings") ?? hasBlockingFindings(body);
}

/** I2c's fact: the body marks a prior finding as still standing. */
function reportsStillPresent(body) {
  return structuredBlocking(body, "stillPresent") ?? proseStillPresent(body);
}

/**
 * The fail-closed roll-up. `structuredUnreadable` is a term in its own right
 * because the field queries above deliberately stopped answering for it: drop
 * it and an unreadable block would read as a clean verdict here, which is the
 * one direction that masks a finding.
 *
 * Exported for scripts/ally-review-de-dupe.mjs, which asks exactly this
 * question before dismissing a review. It used to compose its own from
 * `hasBlockingFindings || hasStillPresentDisposition`, which reaches neither
 * the verdict block nor an unreadable one — so a review whose only statement
 * of a finding was the block read as dismissable.
 */
export function hasBlockingVerdict(body) {
  return structuredUnreadable(body) || reportsBlockingFindings(body) || reportsStillPresent(body);
}

// submitted_at has 1 s resolution, so ties fall back to the monotonic id.
function bySubmission(a, b) {
  return (
    String(a?.submitted_at ?? "").localeCompare(String(b?.submitted_at ?? "")) ||
    Number(a?.id ?? 0) - Number(b?.id ?? 0)
  );
}

function reviewDetails(reviews) {
  return reviews.map((review) => `${reviewState(review)}/${review.id}`).join(", ");
}

export function canonicalReviewHead(body) {
  const text = reviewText(body);
  const headings = Array.from(text.matchAll(CANONICAL_REVIEW_HEADING_RE));
  if (headings.length !== 1) return null;
  return attestedHeadFrom(text);
}

// The two GitHub principals the guard must recognise. Recognising both is not
// endorsing both: only the App may carry a verdict, and every operative seat
// review is a violation (I6, R4/BLO-24056). Do not read this pair as a shape
// something requires.
//
// Only the IDs have production consumers — `allyReviewIdentityShape` pins the
// immutable REST ID per lane, so an impostor matching a login regex is caught
// by I5 rather than silently accepted. The login constants are retained as the
// canonical spelling and for the test fixtures that exercise that mismatch.
export const ALLY_APP_REVIEWER_ID = 290875700;
export const ALLY_APP_REVIEWER_LOGIN = "allyblockcast[bot]";
export const ALLY_USER_REVIEWER_ID = 296676656;
export const ALLY_USER_REVIEWER_LOGIN = "allyblockcast";

export function isAllyLogin(login) {
  return isAllySeatLogin(login) || isAllyAppLogin(login);
}

export function isAllyAppLogin(login) {
  return ALLY_APP_LOGIN_RE.test(normalizedLogin(login));
}

export function isAllySeatLogin(login) {
  return ALLY_SEAT_LOGIN_RE.test(normalizedLogin(login));
}

function allyReviewIdentityShape(user) {
  if (
    ALLY_APP_REVIEW_LOGIN_RE.test(normalizedLogin(user?.login)) &&
    normalizedAccountType(user) === "bot"
  ) {
    return { lane: "app", expectedId: ALLY_APP_REVIEWER_ID };
  }
  if (
    ALLY_SEAT_LOGIN_RE.test(normalizedLogin(user?.login)) &&
    normalizedAccountType(user) === "user"
  ) {
    return { lane: "seat", expectedId: ALLY_USER_REVIEWER_ID };
  }
  return null;
}

export function isAllyAppReviewer(user) {
  const identity = allyReviewIdentityShape(user);
  return identity?.lane === "app" && user?.id === identity.expectedId;
}

export function isAllySeatReviewer(user) {
  const identity = allyReviewIdentityShape(user);
  return identity?.lane === "seat" && user?.id === identity.expectedId;
}

export function allyReviewLane(user) {
  if (isAllySeatReviewer(user)) return "seat";
  if (isAllyAppReviewer(user)) return "app";
  return null;
}

export function hasBlockingFindings(body) {
  return BLOCKING_SECTION_RE.test(reviewText(body));
}

export function hasStillPresentDisposition(body) {
  for (const match of reviewText(body).matchAll(PRIOR_FINDING_DISPOSITION_RE)) {
    if (BLOCKING_PRIOR_DISPOSITIONS.has(match[4].toLowerCase())) return true;
  }
  return false;
}

/**
 * The prose arm of the verdict question: a ledger entry, or the older
 * free-label line the ledger pattern cannot express. Union, never a
 * replacement — see LOOSE_STILL_PRESENT_RE for why this is not
 * hasStillPresentDisposition.
 */
function proseStillPresent(body) {
  return hasStillPresentDisposition(body) || LOOSE_STILL_PRESENT_RE.test(reviewText(body));
}

export function hasDeferredDisposition(body) {
  return TRACKED_DISPOSITION_RE.test(String(body ?? ""));
}

/**
 * The findings a body declares in its own counted buckets, as `severity index`
 * keys. A bucket of N contributes indices 1..N, the same `(severity, index)`
 * identity the merge gate enumerates in extractAllyReportedFindingRefs. The
 * two agree on what a review raised only because COUNTED_SECTION_GLOBAL_RE
 * mirrors the gate's bucket pattern; see the note there.
 */
export function countedFindingKeys(body) {
  const keys = new Set();
  for (const [, severity, count] of String(body ?? "").matchAll(COUNTED_SECTION_GLOBAL_RE)) {
    for (let index = 1; index <= Number(count); index += 1) {
      keys.add(`${severity.toLowerCase()} ${index}`);
    }
  }
  return keys;
}

/** The findings a body retires by name against `head`, in the same key space. */
function retiredFindingKeys(body, head) {
  const normalizedHead = String(head ?? "").toLowerCase();
  const keys = new Set();
  for (const [, prefix, severity, index] of String(body ?? "").matchAll(
    RETIRING_DISPOSITION_GLOBAL_RE,
  )) {
    if (normalizedHead.startsWith(prefix.toLowerCase())) {
      keys.add(`${severity.toLowerCase()} ${Number(index)}`);
    }
  }
  return keys;
}

/**
 * True when `approval` retires, by name and against this head, EVERY finding
 * `blocker` counted.
 *
 * Coverage rather than presence: a blocker may raise several findings at one
 * head, and an approval retiring 1 of N would otherwise stand green over the
 * N-1 nobody dispositioned — I2e's own harm class, reached through its exemption.
 *
 * A blocker with no counted findings is never superseded. That is a blocker
 * blocking solely on a `still-present` entry, which asserts a finding raised at
 * an *earlier* head; it has no (severity, index) at this head for a ledger to
 * name, and it is enumerated on its own account at the head that raised it.
 * Fail closed.
 *
 * A blocker that MIRRORS that still-present finding into its counted bucket, as
 * the reviewer contract asks, keeping its original `prior:<earlier> ...` label,
 * is keyed here by position at THIS head all the same. That is deliberate, and
 * it is a known false red: an approval retiring the finding only under its
 * original name does not supersede the blocker. Keying the slot on the name it
 * carries would clear it, and would also clear the #876 / #1220 race, because an
 * earlier head's finding is exactly the name both racing runs can produce. It
 * proves nothing about having read the blocker. A this-head name does, so an
 * approval that also retires `prior:<this head> <severity> <index>` still
 * supersedes; otherwise a new head is the exit. Ally's audit at 37522699 found
 * the shape in none of 64 real bodies.
 */
function supersedesBlocker(approval, blocker, head) {
  const raised = countedFindingKeys(blocker?.body);
  if (raised.size === 0) return false;
  const retired = retiredFindingKeys(approval?.body, head);
  for (const key of raised) if (!retired.has(key)) return false;
  return true;
}

export function attestedHead(body) {
  return attestedHeadFrom(reviewText(body));
}

export function operativeAllyReviews(reviews, headSha, lane = null) {
  const normalizedHead = String(headSha ?? "").toLowerCase();
  return (reviews ?? []).filter(
    (review) => {
      const reviewLane = allyReviewLane(review?.user);
      return (
        reviewLane !== null &&
        (lane === null || reviewLane === lane) &&
        !isDismissedOrPending(review) &&
        String(review?.commit_id ?? "").toLowerCase() === normalizedHead
      );
    },
  );
}

function isCleanAppSelfReview(pr, review) {
  return (
    isAllyAppLogin(pr?.author?.login) &&
    pr?.author?.is_bot === true &&
    reviewState(review) === "COMMENTED" &&
    !hasBlockingVerdict(review.body)
  );
}

/**
 * A review body reduced to the form the equality rules below compare.
 *
 * Trimming is deliberately the only normalization. Passing one body file to
 * both review calls produces byte-identical bodies, but a stray trailing
 * newline is still one verdict posted twice. Two bodies that differ in
 * substance remain two independent write-ups.
 *
 * This helper is used by both the same-lane relation and the cross-credential
 * duplicate diagnostic. Keeping the normalization at both decision points stops
 * one of them exempting a body shape the other would have flagged.
 */
export function normalizedBody(review) {
  return String(review?.body ?? "").trim();
}

/**
 * True when two operative reviews carry the same substantive body under
 * different identities. Empty bodies are excluded because that is an
 * attestation defect, not evidence of one verdict submitted twice.
 */
export function duplicateBodyAcrossIdentities(operative) {
  const reviews = operative ?? [];
  const bodies = reviews.map(normalizedBody);
  return reviews.some((a, i) =>
    reviews.some(
      (b, j) =>
        j > i && bodies[i] !== "" && bodies[i] === bodies[j] && a?.user?.id !== b?.user?.id,
    ),
  );
}

/**
 * Classifies a same-lane duplicate by comparing the bodies against each other.
 *
 * I1 says two reviews in one lane is a violation; it does not say which defect
 * produced them, and the two need different fixes. The bodies discriminate:
 *
 *   "resubmit"  Every body is identical. One computed verdict reached GitHub
 *               more than once, so the submit step is at-least-once. Ally holds
 *               the composed body in context, so a retried submit re-sends the
 *               same bytes; two independent runs cannot emit identical prose.
 *   "recompute" The bodies differ. Two full reviews were computed for one head
 *               and both were submitted, so the missing control is exclusion
 *               (one reviewer per head), not submit idempotency.
 *   "mixed"     Both shapes at once: >2 reviews, some identical, some distinct.
 *   null        Not a duplicate, or a body is empty — an empty body is an
 *               attestation defect (I3), and guessing a mode from it would
 *               assert a mechanism the evidence does not carry.
 *
 * Timing is NOT a substitute for this. PEN-2865 first split these modes by the
 * gap between submissions on the theory that seconds meant a retry and hours
 * meant a re-review. Measured on paperclip#1220, two reviews 10 s apart carried
 * different bodies (8513 vs 6564 bytes) — a genuine double-compute inside the
 * window the timing rule reserved for retries. Reporting the gap alone had
 * already produced one wrong recommendation, which is why the classification
 * lives here rather than in the reader's head.
 *
 * Keep the label free of any 6-digit-or-longer number. `violationFingerprint`
 * harvests every such token out of the message text, so a count or an account
 * id embedded here would change the fingerprint of an I1 finding and silently
 * void the matching baseline suppression.
 */
export function sameLaneBodyRelation(operative) {
  const reviews = operative ?? [];
  if (reviews.length < 2) return null;
  const bodies = reviews.map(normalizedBody);
  if (bodies.some((body) => body === "")) return null;
  const identical = bodies.every((body) => body === bodies[0]);
  if (identical) return "resubmit";
  const anyPairIdentical = bodies.some((body, i) =>
    bodies.some((other, j) => j > i && body === other),
  );
  return anyPairIdentical ? "mixed" : "recompute";
}

/**
 * True when a same-head App-lane duplicate is a re-review superseding its
 * predecessor rather than a defect.
 *
 * Scoped to the App lane deliberately: the User seat may not submit a verdict
 * at all (I6/R4), so a seat duplicate has no legitimate reading and keeps
 * failing. `recompute` — every body distinct — is the only exempt relation.
 * `resubmit` and `mixed` both contain a byte-identical pair, which is one
 * verdict delivered more than once and is always a submit-side defect, and a
 * `null` relation means an empty body, which is an attestation defect.
 *
 * This exempts the shape from I1 only. Every review in the set is still
 * carried through I2/I3/I4/I5, so a superseded review that approves over a
 * blocking finding remains fatal.
 */
export function isSupersedingAppRereview(lane, operative) {
  return lane === "app" && sameLaneBodyRelation(operative) === "recompute";
}

/**
 * Non-fatal observations. Supersession is legitimate but it is still two runs
 * doing one PR's work, so it is reported rather than dropped: silence here
 * would make a re-review storm indistinguishable from a quiet week.
 *
 * @returns {string[]}
 */
export function findPrNotices(pr) {
  const head = pr.headSha;
  const short = String(head ?? "").slice(0, 8);
  const reviews = operativeAllyReviews(pr.reviews, head, "app");
  if (!isSupersedingAppRereview("app", reviews)) return [];
  const latest = [...reviews].sort(bySubmission).at(-1);
  return [
    `PR #${pr.number} @${short}: ${reviews.length} operative Ally App reviews (${reviewDetails(reviews)}) with distinct bodies — ` +
      `treating the latest (${latest?.id}, ${latest?.submitted_at}) as the standing verdict. Legitimate for a re-review of an ` +
      `unchanged head; also the signature of two concurrent runs, which review data cannot distinguish (BLO-25764). ` +
      `Exclusion belongs at dispatch — see BLO-20074.`,
  ];
}

const SAME_LANE_RELATION_NOTES = {
  resubmit:
    "the bodies are identical — one verdict submitted more than once, so the submit step is at-least-once",
  recompute:
    "the bodies differ — two reviews were computed for this one head and both submitted, so the missing control is exclusion, not submit idempotency",
  mixed:
    "some bodies are identical and some differ — both a repeated submit and an independent recomputation are present",
};

/**
 * @param {{number: number, headSha: string, author?: {login?: string, is_bot?: boolean}, reviews: object[]}} pr
 * @returns {string[]} human-readable violations; empty when the PR is sound
 */
export function findPrViolations(pr) {
  const head = pr.headSha;
  const short = String(head ?? "").slice(0, 8);
  const violations = [];

  for (const review of pr.reviews ?? []) {
    if (isDismissedOrPending(review) || String(review?.commit_id ?? "").toLowerCase() !== String(head ?? "").toLowerCase()) {
      continue;
    }
    const identity = allyReviewIdentityShape(review?.user);
    if (identity && review?.user?.id !== identity.expectedId) {
      violations.push(
        `I5 PR #${pr.number} @${short}: ${laneLabel(identity.lane)} review ${review.id} uses the canonical login/type but REST id ${String(review?.user?.id ?? "<missing>")} (expected ${identity.expectedId}) — identity mismatch cannot satisfy the review lane`,
      );
    }
  }

  const reviewsByLane = new Map(
    ALLY_REVIEW_LANES.map((lane) => [lane, operativeAllyReviews(pr.reviews, head, lane)]),
  );

  for (const lane of ALLY_REVIEW_LANES) {
    const reviews = reviewsByLane.get(lane);
    const label = laneLabel(lane);

    if (reviews.length > 1 && !isSupersedingAppRereview(lane, reviews)) {
      const relation = SAME_LANE_RELATION_NOTES[sameLaneBodyRelation(reviews)];
      violations.push(
        `I1 PR #${pr.number} @${short}: ${reviews.length} operative ${label} reviews (${reviewDetails(reviews)}) — expected at most 1 in the ${lane} lane` +
          (relation ? `; ${relation}` : ""),
      );
    }

    for (const review of reviews) {
      const blocking = hasBlockingVerdict(review.body);

      // R4 (BLO-24056, ratified by the CEO ruling on BLO-29559): the User seat
      // shares a login with the authoring App, so a seat verdict is the same
      // head both writing a change and clearing it. It never submits a review,
      // an approval, or a REQUEST_CHANGES under any condition. Its only
      // sanctioned operation is dismissing a stale approval, and a DISMISSED
      // review is already excluded from the operative set above.
      //
      // This subsumes BLO-22916 Defect 2: the five content-free approvals that
      // carried no `Reviewed head:` line were all seat submissions, and the
      // App-only I2d check below could never see them.
      //
      // The `continue` skips I2a/I2c for this review. Detection is unchanged
      // and remains a strict superset — I6 is unconditional over the lane, so
      // a seat APPROVED carrying a Critical finding is still a violation; only
      // the diagnostic narrows, from "approved over a blocker" to "the seat
      // may not submit at all". I2b still reports the blocker-masking case.
      if (lane === "seat") {
        violations.push(
          `I6 PR #${pr.number} @${short}: ${label} review ${review.id} is ${reviewState(review)} — the User seat (uid ${ALLY_USER_REVIEWER_ID}) never submits a verdict (R4, BLO-24056); only the App (uid ${ALLY_APP_REVIEWER_ID}) may carry one`,
        );
        continue;
      }

      if (lane === "app") {
        const canonicalHead = canonicalReviewHead(review.body);
        const attested = attestedHead(review.body);
        if (!canonicalHead) {
          violations.push(
            `I3 PR #${pr.number} @${short}: ${label} review ${review.id} is not canonical — expected one consolidated-review heading and one Reviewed head attestation`,
          );
        }

        if (attested && attested !== String(head ?? "").toLowerCase()) {
          violations.push(
            `I3 PR #${pr.number} @${short}: ${label} review ${review.id} attests head ${attested.slice(0, 8)} but is now recorded against ${short} — a force-push re-anchored it, so it stands as an attestation of a tree its author never read`,
          );
        }

        if (isApproved(review) && attested === null) {
          violations.push(
            `I2d PR #${pr.number} @${short}: ${label} review ${review.id} is APPROVED but its body makes no "Reviewed head:" attestation — an approval with no review behind it`,
          );
        }
      }

      // A `tracked` review is neither blocking nor clean: it reports a real
      // finding the reviewer accepted onto a follow-up (BLO-36903). Whether
      // such a review is APPROVED or COMMENTED is the companion contract's
      // call, not this auditor's, so I4 admits it alongside `blocking` rather
      // than demanding an approval of a head that still carries a defect.
      // This is an exemption, so its predicate takes the gate's strict
      // `prior:` grammar, not the loose one the trigger predicates use.
      const deferred = hasDeferredDisposition(review.body);
      if (!isApproved(review) && !blocking && !deferred && !isCleanAppSelfReview(pr, review)) {
        violations.push(
          `I4 PR #${pr.number} @${short}: ${label} review ${review.id} is ${reviewState(review)} but clean App evidence must be APPROVED`,
        );
      }

      if (isApproved(review) && structuredUnreadable(review.body)) {
        violations.push(
          `I2e PR #${pr.number} @${short}: ${label} review ${review.id} is APPROVED but its ally-verdict block is unreadable — the approval rests on a verdict nothing could read`,
        );
      }
      if (isApproved(review) && reportsBlockingFindings(review.body)) {
        violations.push(
          `I2a PR #${pr.number} @${short}: ${label} review ${review.id} is APPROVED but its body reports a Critical/Important finding`,
        );
      }
      if (isApproved(review) && reportsStillPresent(review.body)) {
        violations.push(
          `I2c PR #${pr.number} @${short}: ${label} review ${review.id} is APPROVED but its body marks a prior finding still-present`,
        );
      }
    }
  }

  const appReviews = reviewsByLane.get("app");
  const seatReviews = reviewsByLane.get("seat");
  if (
    appReviews.length === 1 &&
    seatReviews.length === 1 &&
    duplicateBodyAcrossIdentities([...appReviews, ...seatReviews])
  ) {
    const detail = [...appReviews, ...seatReviews]
      .map((review) => `${reviewState(review)}/${review.id}`)
      .join(", ");
    violations.push(
      `I1 PR #${pr.number} @${short}: 2 operative Ally reviews (${detail}) — the same body submitted under two credentials — one verdict, posted twice (BLO-22916)`,
    );
  }
  const seatApprovals = reviewsByLane.get("seat").filter(isApproved);
  const appBlockers = appReviews.filter((review) => hasBlockingVerdict(review.body));
  if (seatApprovals.length > 0 && appBlockers.length > 0) {
    violations.push(
      `I2b PR #${pr.number} @${short}: User-seat APPROVED (${seatApprovals.map((review) => review.id).join(", ")}) coexists with a blocking Ally App review (${appBlockers.map((review) => review.id).join(", ")}) — the User seat cannot mask the App blocker`,
    );
  }
  // I2e: the I1 supersession exemption lets differing App bodies at one head
  // stand as a re-review, so I1 no longer catches the BLO-19778 shape: a clean
  // App APPROVED beside a DIFFERENT App review that blocks. I2a sees a blocker
  // only inside the approving body itself. An undismissed APPROVED counts
  // toward reviewDecision and a COMMENTED blocker does not, so the approval
  // would outrank it. A re-review that supersedes a blocker dismisses the stale
  // approval, which leaves it non-operative, so this does not fire there.
  //
  // The other order has no such exit: a COMMENTED blocker cannot be dismissed,
  // so a clean approval that supersedes it at an unchanged head would fail here
  // forever. That approval is exempt from a given blocker when it retires, by
  // name, every finding that blocker counted at this head, and lands after it.
  // Naming is the test: only a run that read the blocker can name its findings,
  // and a racing run never saw them. Merely carrying a ledger is not enough,
  // because both racing reviews on #876 (ff1c72db) and on #1220 (a9ee094a)
  // carried one, for findings raised at an earlier head. Naming the head once is
  // not enough either: a blocker may raise several findings at it, and retiring
  // 1 of N would leave the approval standing over the rest. Order alone is not
  // the test (a race can land its approval last); it only keeps a blocker that
  // follows the approval fatal, since dismissing the approval is the exit there.
  // Residual: two runs racing after a same-head predecessor can both name it, so
  // this cannot separate them; that exclusion belongs at dispatch (BLO-20074).
  const appApprovals = appReviews.filter(isApproved);
  const otherAppBlockers = appBlockers.filter((review) => !appApprovals.includes(review));
  const unsupersedingApprovals = appApprovals.filter((review) =>
    otherAppBlockers.some(
      (blocker) =>
        bySubmission(blocker, review) > 0 || !supersedesBlocker(review, blocker, head),
    ),
  );

  if (unsupersedingApprovals.length > 0 && otherAppBlockers.length > 0) {
    violations.push(
      `I2e PR #${pr.number} @${short}: Ally App APPROVED (${unsupersedingApprovals.map((review) => review.id).join(", ")}) coexists with a different blocking Ally App review (${otherAppBlockers.map((review) => review.id).join(", ")}) at one head; the standing approval outranks the blocker`,
    );
  }
  return violations;
}

export function findViolations(prs) {
  return (prs ?? []).flatMap((pr) => findPrViolations(pr));
}

/**
 * The ratchet.
 *
 * This guard audits every open PR forever, so a single abandoned PR carrying a
 * duplicate Ally review holds the run red permanently. Measured over the 40
 * scheduled runs before 2026-09-01: 39 failures, 1 success, with a byte-identical
 * six-violation set on every failing run, pinned by four PRs last touched between
 * 1 and 20 days earlier. A check whose output is a constant carries the same
 * information as no check: a seventh violation appearing on a live PR would move
 * the run from red to red and change nothing downstream. The invariants were still
 * computed correctly the whole time — what was lost was the ability to *signal*.
 * See PEN-2847.
 *
 * So known violations are recorded in a baseline and suppressed, and anything not
 * in the baseline fails the run. The load-bearing detail is what a baseline entry
 * is keyed on: the fingerprint pins the invariant code, the PR number, the head
 * SHA, *and* the exact set of review IDs named in the violation. That makes an
 * entry expire on its own the moment anything real changes —
 *
 *   - the PR is pushed to     → new head → no entry matches → red
 *   - a third review lands    → new ID set → no entry matches → red
 *   - a different invariant   → new code → no entry matches → red
 *   - any other PR regresses  → never baselined → red
 *
 * — which is a sharper liveness test than the obvious alternative of scoping the
 * audit to PRs updated within N days. That alternative was measured against this
 * repo before it was rejected: #1525 sits at `mergeable_state: behind`, inside any
 * plausible allow-list, and was updated 2 days before filing, inside any plausible
 * window. It would have stayed in scope and the run would have stayed red. A PR
 * that could actually merge on a bad attestation is one that is *moving*, and a
 * moving PR breaks its own baseline entry. Staleness is a proxy for that; the head
 * SHA measures it directly.
 *
 * That rejection stands, and `prDormancy` below does **not** reverse it — there is
 * still no calendar window here. What the ratchet alone does not cover is a PR that
 * carries a real violation and *cannot merge at all*, which the ratchet can only
 * dispose of by having a human write a baseline entry for every one of them. As of
 * 2026-09-20 exactly one unbaselined violation was outstanding repo-wide (#1220
 * @a9ee094a) and it is `DIRTY`; all six original baseline entries had self-expired.
 * So the run was red, un-actionably, over a PR GitHub itself refuses to merge.
 *
 * The two legs of "liveness" are not equally safe and only one is adopted:
 *
 *   - **Cannot-merge (adopted).** `DIRTY` and `draft` are states GitHub enforces at
 *     the merge button. Leaving one is a state transition this guard re-observes on
 *     its next hourly run, so deferring is bounded: the PR cannot reach `master`
 *     without first re-entering scope. For `DIRTY` the exposure is usually nil —
 *     resolving conflicts means pushing, which moves the head, which sheds the
 *     violation outright.
 *   - **Not-updated-in-N-days (only where GitHub reported no usable state).**
 *     Staleness is not a state GitHub enforces anything against. A `CLEAN` PR
 *     untouched for 30 days merges on a click, with no push, no transition, and
 *     no run in between, so a window applied to a REPORTED state would be
 *     unbounded fail-open on exactly the BLO-19778 incident (and #1525's
 *     two-day-old `BEHIND` measurement is why). The window therefore applies
 *     only when `mergeStateStatus` is unresolved; `CLEAN`, `BEHIND` and
 *     `UNSTABLE` stay live at any age. See `prDormancy()` for the three tiers
 *     and for the cross-run residual they do not close.
 *
 * Measured on the 121 open PRs of 2026-09-20: 71 live, 50 dormant. #1316
 * (`UNSTABLE`) and #1360 (`BEHIND`) — two of the four PRs that originally pinned
 * this guard — classify **live**, so this scoping grants them no amnesty; their
 * findings expired by head movement, as designed.
 *
 * A baseline entry is a suppression of a real finding, so each one must name the
 * PR and the issue that owns its disposition, and a malformed entry throws rather
 * than being skipped — a baseline that silently ignores its own bad rows is the
 * fail-open shape `assertPrListComplete` and `assertHeadSha` already guard against
 * one layer up.
 */
export const BASELINE_PATH = "scripts/ally-review-consistency-baseline.json";

/**
 * A violation reduced to the tokens that identify *which* violation it is,
 * discarding the prose.
 *
 * Every push site in `findPrViolations` emits the same structured prefix —
 * `${code} PR #${number} @${shortHead}: ` — and names the review IDs it is
 * complaining about in the tail. Those four things are the finding's identity;
 * the explanatory sentence after them is not, and rewording a message must not
 * silently move a violation out from under its baseline entry.
 *
 * Review IDs are 9-10 digits and PR numbers are 4, so the digit-run floor
 * separates them without needing to parse each message shape individually. The
 * floor is not exclusive to review IDs: I6 embeds both reviewer uids, which are
 * 9 digits and so join the scraped set. That is harmless — both uids are
 * constant across every I6, so they cannot merge two distinct findings, and the
 * real review ID is still in the set, so the expiry properties hold. If a
 * future message shape defeats this scraping the fingerprint changes and the run
 * goes red — the safe direction.
 */
export function violationFingerprint(violation) {
  const text = String(violation ?? "");
  const code = /^(\S+)\s/.exec(text)?.[1] ?? "?";
  const pr = /\bPR #(\d+)\b/.exec(text)?.[1] ?? "?";
  const head = /\B@([0-9a-f]{6,40})\b/.exec(text)?.[1]?.toLowerCase() ?? "?";
  const ids = [...new Set(Array.from(text.matchAll(/\b\d{6,}\b/g), (m) => m[0]))].sort();
  return `${code}:${pr}:${head}:${ids.join(",")}`;
}

/**
 * Validates the baseline document and returns its entries.
 *
 * Throws on anything malformed. An entry that cannot be understood is a
 * suppression nobody can audit, and silently dropping it would let a typo'd
 * fingerprint read as "this violation is known" when nothing is known at all.
 */
export function parseBaseline(raw, path = BASELINE_PATH) {
  let doc;
  try {
    doc = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${error.message}`);
  }
  const entries = doc?.entries;
  if (!Array.isArray(entries)) {
    throw new Error(`${path} must contain an "entries" array (got ${JSON.stringify(doc?.entries)}).`);
  }

  const seen = new Set();
  for (const [index, entry] of entries.entries()) {
    const where = `${path} entries[${index}]`;
    for (const field of ["fingerprint", "note", "issue"]) {
      if (typeof entry?.[field] !== "string" || entry[field].trim() === "") {
        throw new Error(`${where} needs a non-empty "${field}" — every suppression must be attributable.`);
      }
    }
    if (!Number.isInteger(entry.pr)) {
      throw new Error(`${where} needs an integer "pr" (got ${JSON.stringify(entry?.pr)}).`);
    }
    if (!/^[A-Za-z0-9]+:\d+:[0-9a-f]{6,40}:[\d,]*$/.test(entry.fingerprint)) {
      throw new Error(
        `${where} has a malformed "fingerprint" (${JSON.stringify(entry.fingerprint)}); ` +
          `expected code:pr:head:ids as produced by violationFingerprint().`,
      );
    }
    if (String(entry.fingerprint.split(":")[1]) !== String(entry.pr)) {
      throw new Error(
        `${where} fingerprint names PR #${entry.fingerprint.split(":")[1]} but "pr" says ${entry.pr}.`,
      );
    }
    if (seen.has(entry.fingerprint)) {
      throw new Error(`${where} repeats fingerprint ${entry.fingerprint}.`);
    }
    seen.add(entry.fingerprint);
  }
  return entries;
}

/**
 * Splits live violations into the ones that fail the run and the ones a baseline
 * entry accounts for, and reports entries that matched nothing.
 *
 * A stale entry is deliberately *not* fatal. Baselined PRs get merged, closed and
 * force-pushed as a matter of course, and making that turn the run red would
 * reintroduce exactly the permanently-red failure this ratchet exists to cure —
 * this time triggered by the guard's own bookkeeping. It is reported so the entry
 * can be pruned, and pruning it is a no-op for the verdict.
 */
export function applyBaseline(violations, entries) {
  const byFingerprint = new Map((entries ?? []).map((entry) => [entry.fingerprint, entry]));
  const matched = new Set();
  const failing = [];
  const suppressed = [];

  for (const violation of violations ?? []) {
    const fingerprint = violationFingerprint(violation);
    const entry = byFingerprint.get(fingerprint);
    if (entry) {
      matched.add(fingerprint);
      suppressed.push({ violation, entry });
    } else {
      failing.push({ violation, fingerprint });
    }
  }

  return {
    failing,
    suppressed,
    staleEntries: (entries ?? []).filter((entry) => !matched.has(entry.fingerprint)),
  };
}

/**
 * The merge states GitHub will not merge from, so a violation under one of them
 * cannot reach `master` without the PR first changing state.
 *
 * Deliberately a deny-list of two, not an allow-list of the mergeable states.
 * `mergeStateStatus` is lazily computed server-side and reports `UNKNOWN` until
 * GitHub finishes — 5 of 121 open PRs were `UNKNOWN` when this was written — and
 * GitHub adds values to this enum without notice. An allow-list would silently
 * drop every unrecognised and every not-yet-computed state out of the audit, which
 * is the fail-open shape this whole file exists to prevent. Anything not named
 * here is treated as live and can fail the run.
 */
export const DORMANT_MERGE_STATES = new Set(["DIRTY"]);

/**
 * The values that mean "GitHub has not told us", as opposed to a real state.
 *
 * `mergeStateStatus` is computed lazily server-side and is absent far more often
 * than the 5-of-121 measured when the deny-list above was written: 49 of 139 open
 * PRs (35%) read `UNKNOWN` on 2026-09-26. Every one of those 49 had been touched
 * within 7 days, so for a live PR "unresolved" is the normal reading and keeping
 * it in the audit is correct.
 */
export const UNRESOLVED_MERGE_STATES = new Set(["", "UNKNOWN"]);

/**
 * Days a PR may sit untouched before an *unresolved* merge state is read as
 * abandonment rather than as pending computation.
 *
 * 14d is outside the observed merge-latency distribution: over the 300 PRs merged
 * into this repo between 2026-09-04 and 2026-09-26, p99 create->merge was 14.9d
 * and only 4 (1.3%) lived longer than 14d at all. A PR's last touch is never
 * earlier than its creation, so this is the conservative side of that figure.
 */
export const MAX_IDLE_DAYS = parseMaxIdleDays(process.env.ALLY_REVIEW_MAX_IDLE_DAYS);

/**
 * Reads `ALLY_REVIEW_MAX_IDLE_DAYS`: unset means 14, anything else must be a
 * positive finite number or this throws. `""` is what an Actions `env:` bound to
 * an unset variable or input yields, and `Number("")` is 0, which would read
 * every unresolved PR touched more than 0 days ago as dormant -- green because
 * it stopped checking. A negative value fails open the same way.
 */
export function parseMaxIdleDays(raw) {
  if (raw === undefined) {
    return 14;
  }
  const days = Number(raw);
  if (String(raw).trim() === "" || !Number.isFinite(days) || days <= 0) {
    throw new Error(
      `ALLY_REVIEW_MAX_IDLE_DAYS must be a positive number of days, got ${JSON.stringify(raw)}`,
    );
  }
  return days;
}

/** Days since the PR was last touched, or `null` if that cannot be determined. */
export function idleDays(pr, now) {
  const at = Date.parse(String(pr?.updatedAt ?? ""));
  if (!Number.isFinite(at)) {
    return null;
  }
  return (now - at) / 86_400_000;
}

/**
 * Why a PR cannot merge right now, or `null` if it can.
 *
 * Three tiers, in order, and the order is the whole point:
 *
 * 1. GitHub reports a state it will not merge from (`DIRTY`, or a draft) -> defer.
 * 2. GitHub reports any *other* state -> live, whatever the PR's age. A state we
 *    were told is a state we trust, so nothing here can demote a PR GitHub would
 *    merge from *in the run that observed the state*. `BEHIND` and `UNSTABLE` PRs
 *    months old stay fatal. That guarantee is per-observation only — across runs
 *    the same PR can be read `UNKNOWN` instead, and then tier 3 applies. See the
 *    residual below.
 * 3. GitHub reports nothing usable -> fall back to the PR's own activity clock,
 *    which is always present and never oscillates.
 *
 * Tier 3 exists because tier 1 is not stable. `mergeStateStatus` flips between a
 * real value and `UNKNOWN` as GitHub's cache turns over, so the same untouched PR
 * changed verdict hour to hour: PR #1220, last touched 2026-09-06, alternated
 * between fatal and deferred across ten consecutive hourly runs on 2026-09-26
 * (16:31Z defer, 17:29Z fail, 18:34Z defer, 19:27Z fail, ...) with nothing about
 * the PR changing. A guard whose verdict is decided by which phase of a cache it
 * sampled cannot be acted on. Reading an unresolved state on a PR nobody has
 * touched in a fortnight as dormant makes both phases agree.
 *
 * Absence of evidence still keeps a finding fatal everywhere else: an unparseable
 * or missing `updatedAt`, and any idle PR inside the window, stay live.
 *
 * Residual, not closed here: tier 2's guarantee holds per observation, not across
 * observations, so a PR whose state flips against `UNKNOWN` still changes the
 * run's verdict between runs. Two cohorts, opposite directions:
 *
 *   - `DIRTY` <-> `UNKNOWN` INSIDE the window (tier 1 defers, tier 3 keeps it
 *     live). Costs signal, not safety: both readings describe a PR GitHub
 *     refuses to merge anyway. The measured `UNKNOWN` population was all touched
 *     within 7 days, so this is the common cohort, not a corner.
 *   - `CLEAN` <-> `UNKNOWN` PAST the window (tier 2 keeps it live, tier 3 defers
 *     it). This one fails OPEN: GitHub would merge from the `CLEAN` reading, and
 *     in the `UNKNOWN` phase the finding drops to a `::warning`, so a run with no
 *     other finding goes green — the BLO-19778 shape this guard exists to catch.
 *     Kept rather than removed because the cohort is small (only 1.3% of merges
 *     lived past 14d) and the warning still prints, but it is a real gap.
 *
 * One lever closes both: carry a PR's last reported state across runs and prefer
 * it over `UNKNOWN`, so `UNKNOWN` means "never observed" rather than "not
 * observed this hour". Tracked in PEN-3604.
 */
export function prDormancy(pr, now = Date.now()) {
  if (pr?.isDraft === true) {
    return "draft";
  }
  const state = String(pr?.mergeStateStatus ?? "").toUpperCase();
  if (DORMANT_MERGE_STATES.has(state)) {
    return `merge state ${state}`;
  }
  if (!UNRESOLVED_MERGE_STATES.has(state)) {
    return null;
  }
  const idle = idleDays(pr, now);
  if (idle !== null && idle > MAX_IDLE_DAYS) {
    return `untouched for ${Math.floor(idle)}d, merge state unresolved`;
  }
  return null;
}

/**
 * Refuses to run an audit that has scoped itself down to nothing.
 *
 * Deferring findings on unmergeable PRs is only sound while the live set is a
 * real population. If a `mergeStateStatus` schema change, a token losing a field,
 * or a bad edit here ever classified every PR dormant, every violation would
 * downgrade to a warning and the run would print a green pass having failed
 * nothing — "green because it stopped checking", which PEN-2847 names as worse
 * than the permanent red it replaced. Same reflex as `assertPrListComplete` and
 * `assertHeadSha`: throw rather than assert nothing.
 *
 * The throw carries the classification histogram. This is the one scenario the
 * scope summary was added to illuminate, and it is the one scenario the summary
 * never reaches — `main` asserts before it logs, because there is no point
 * reporting a run that is about to abort. Folding the counts into the message
 * means the operator still sees which clause swallowed the population.
 */
export function assertLiveScopeNonVacuous(prs, repo, now = Date.now()) {
  const rows = prs ?? [];
  const { live, reasons, states } = classifyScope(rows, now);
  if (rows.length > 0 && live === 0) {
    throw new Error(
      `every one of the ${rows.length} open PR(s) in ${repo} classified as unmergeable, ` +
        `so no finding could fail this run. That is a scoping bug, not a clean repo: ` +
        `check that gh pr list still returns isDraft/mergeStateStatus/updatedAt. ` +
        `dormant by [${formatCounts(reasons)}]; merge states [${formatCounts(states)}].`,
    );
  }
  return rows;
}

/**
 * Splits unbaselined findings into the ones that can still reach `master` and the
 * ones GitHub is currently refusing to merge.
 *
 * A finding is matched to its PR by the number already parsed into its
 * fingerprint. A finding whose PR cannot be resolved — unparseable number, or a PR
 * absent from the fetched set — stays in `failing`, because "I could not tell
 * whether this one matters" must not read as "this one does not matter".
 */
export function partitionByMergeEligibility(failing, prs, now = Date.now()) {
  const byNumber = new Map((prs ?? []).map((pr) => [String(pr?.number), pr]));
  const live = [];
  const deferred = [];

  for (const item of failing ?? []) {
    const number = String(item?.fingerprint ?? "").split(":")[1];
    const pr = byNumber.get(number);
    const reason = pr ? prDormancy(pr, now) : null;
    if (reason) {
      deferred.push({ ...item, reason });
    } else {
      live.push(item);
    }
  }

  return { failing: live, deferred };
}

function gh(args) {
  return execFileSync("gh", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * `gh pr list` caps at whatever `--limit` we pass and truncates silently. A
 * truncated list would let the guard print a pass over PRs it never fetched —
 * the same fail-open shape this script exists to catch — so hitting the cap is
 * a hard error, not a warning.
 */
const PR_LIST_LIMIT = 500;

export function assertPrListComplete(rows, repo, limit = PR_LIST_LIMIT) {
  if ((rows ?? []).length >= limit) {
    throw new Error(
      `gh pr list returned ${rows.length} open PR(s) for ${repo}, at the --limit of ` +
        `${limit}: the list is probably truncated and this guard cannot assert ` +
        `its invariant over PRs it never fetched. Raise PR_LIST_LIMIT.`,
    );
  }
  return rows;
}

/**
 * Every invariant here pivots on `headSha`: `operativeAllyReviews` filters
 * `commit_id === headSha`, so a falsy or malformed head matches no review, the
 * operative set is empty, and I1/I2/I3 all iterate nothing. The run then prints
 * a pass having asserted nothing across every PR at once — the same fail-open
 * shape as an unreachable `main()`, one layer up. Verified: with `headSha` set
 * to `undefined`, `null` or `""`, a deliberately maximal violation (an APPROVED
 * reporting `### Critical Issues (3)`, attesting a different SHA, coexisting
 * with a blocking COMMENTED) yields zero violations. Assert it for the same
 * reason `assertPrListComplete` throws rather than warns.
 */
export function assertHeadSha(row, repo) {
  if (!/^[0-9a-f]{40}$/.test(String(row?.headRefOid ?? ""))) {
    throw new Error(
      `gh pr list returned no usable headRefOid for ${repo}#${row?.number} ` +
        `(got ${JSON.stringify(row?.headRefOid)}). Every invariant in this guard ` +
        `filters reviews on commit_id === head, so continuing would assert ` +
        `nothing while reporting a pass.`,
    );
  }
  return row;
}

/**
 * `prDormancy` reads an unresolved `mergeStateStatus` on an idle PR as dormant,
 * and an absent key is indistinguishable from GitHub *reporting* `UNKNOWN` once
 * it reaches the classifier. That direction defers real findings, so a row that
 * lost the field entirely -- a `gh` or API shape change -- must stop the run here
 * rather than be read as "not computed yet". `""`, `null` and `UNKNOWN` are values
 * GitHub returns and stay in `UNRESOLVED_MERGE_STATES`; only a missing key throws.
 */
export function assertMergeStateFetched(row, repo) {
  if (!Object.hasOwn(row ?? {}, "mergeStateStatus")) {
    throw new Error(
      `gh pr list returned no mergeStateStatus key for ${repo}#${row?.number}. ` +
        `An absent state would classify an idle PR as dormant and demote its ` +
        `findings to warnings; check that PR_LIST_FIELDS is still honoured.`,
    );
  }
  return row;
}

/**
 * The `gh pr list` fields the audit depends on.
 *
 * Exported so a test can assert every field `prDormancy` reads is actually
 * fetched. Dropping one here does not fail anything loudly — it just feeds the
 * classifier `undefined`. For `updatedAt` that is fail-closed (the PR stays
 * live), so the staleness clause would go quietly inert; for `mergeStateStatus`
 * it is fail-OPEN (an idle PR reads as dormant), which is why a missing key is
 * refused at fetch by `assertMergeStateFetched`. Either way every unit test
 * would keep passing against hand-built PR objects.
 */
export const PR_LIST_FIELDS = "number,headRefOid,author,isDraft,mergeStateStatus,updatedAt";

function fetchOpenPrs(repo) {
  // number + headRefOid both come back from this one call; fetching the head
  // via `gh api repos/{repo}/pulls/{number}` instead would pull a ~22 KB
  // payload per PR to read one field.
  const rows = JSON.parse(
    gh([
      "pr",
      "list",
      "--repo",
      repo,
      "--state",
      "open",
      "--limit",
      String(PR_LIST_LIMIT),
      "--json",
      PR_LIST_FIELDS,
    ]),
  );

  assertPrListComplete(rows, repo);

  return rows.map((row) => ({
    number: assertMergeStateFetched(assertHeadSha(row, repo), repo).number,
    headSha: row.headRefOid,
    author: row.author,
    isDraft: row.isDraft,
    mergeStateStatus: row.mergeStateStatus,
    updatedAt: row.updatedAt,
    reviews: JSON.parse(
      gh(["api", `repos/${repo}/pulls/${row.number}/reviews`, "--paginate"]),
    ),
  }));
}

function loadBaseline() {
  const path = resolve(fileURLToPath(new URL(".", import.meta.url)), "ally-review-consistency-baseline.json");
  return parseBaseline(readFileSync(path, "utf8"), BASELINE_PATH);
}

/**
 * Classifies every PR exactly once: how many are live, why the rest are dormant,
 * and what `mergeStateStatus` values GitHub actually reported.
 *
 * One pass, shared by `scopeSummary` and `assertLiveScopeNonVacuous`, so the
 * histogram an operator reads is the same classification the run acted on rather
 * than a re-derivation that could drift from it.
 *
 * The state key uses `||`, not `??`: `""` is a value `UNRESOLVED_MERGE_STATES`
 * deliberately recognises, and `String("")` rendered a bare count with no label
 * (`merge states [ 1, CLEAN 1]`). Absent, `null` and `""` all mean "GitHub told
 * us nothing usable" and all belong under one `(ABSENT)` bucket, in the one line
 * whose job is telling "classified nothing" from "nothing to classify".
 */
function classifyScope(prs, now) {
  const rows = prs ?? [];
  const reasons = new Map();
  const states = new Map();
  let live = 0;
  for (const pr of rows) {
    const reason = prDormancy(pr, now);
    if (reason === null) {
      live += 1;
    } else {
      const key = reason.startsWith("untouched") ? "untouched, merge state unresolved" : reason;
      reasons.set(key, (reasons.get(key) ?? 0) + 1);
    }
    const state = String(pr?.mergeStateStatus || "(absent)").toUpperCase();
    states.set(state, (states.get(state) ?? 0) + 1);
  }
  return { total: rows.length, live, reasons, states };
}

/** Counts as `key n, key n`, commonest first, ties broken by name. */
function formatCounts(m) {
  return (
    [...m.entries()]
      .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
      .map(([k, v]) => `${k} ${v}`)
      .join(", ") || "none"
  );
}

/**
 * One line describing what the liveness scope actually did this run, plus the
 * live count the pass message reports.
 *
 * Printed unconditionally, on the failing path as well as the passing one.
 * Before this existed the classification counts reached stdout only inside the
 * pass message, and the deferred block only rendered when non-empty — so on a
 * red run, which is every run this guard has had, "deferred nothing because
 * nothing qualified" and "never classified anything" looked identical. That cost
 * a full review cycle on PEN-2847: a reader saw `deferred = 0` on two runs and
 * could not tell a working scope from a broken one without re-deriving the whole
 * population by hand.
 *
 * `live` is returned rather than recomputed by the caller so the summary and the
 * pass message cannot disagree about the same number.
 *
 * `assertLiveScopeNonVacuous` throws when *every* PR classifies dormant. There is
 * deliberately no counterpart throw for zero dormant — an all-live repo is
 * legitimate — so this line is the only thing that distinguishes it.
 */
export function scopeSummary(prs, deferred, now = Date.now()) {
  const { total, live, reasons, states } = classifyScope(prs, now);
  return {
    live,
    line:
      `Liveness scope: ${live} live / ${total} open PR(s); ` +
      `dormant by [${formatCounts(reasons)}]; merge states [${formatCounts(states)}]; ` +
      `${(deferred ?? []).length} finding(s) deferred.`,
  };
}

/**
 * Runs the audit and reports it.
 *
 * Every collaborator is injectable so the reporting itself can be tested. The
 * failing branch is the one this guard has taken on effectively every scheduled
 * run since it was written, and until PEN-2847 it was the only branch with no
 * test over its output at all — which is how `liveCount` came to be computed and
 * then printed exclusively on the branch that never runs.
 */
export function main({
  fetchPrs = fetchOpenPrs,
  baseline = loadBaseline,
  log = console.log,
  err = console.error,
  exit = process.exit,
  now = Date.now(),
  repo = process.env.ALLY_REVIEW_REPO || "Blockcast/paperclip",
} = {}) {
  const prs = fetchPrs(repo);
  assertLiveScopeNonVacuous(prs, repo, now);
  const violations = findViolations(prs);
  const baselined = applyBaseline(violations, baseline());
  const { suppressed, staleEntries } = baselined;
  const { failing, deferred } = partitionByMergeEligibility(baselined.failing, prs, now);
  const { line: scopeLine, live: liveCount } = scopeSummary(prs, deferred, now);

  log(scopeLine);
  log("");

  for (const pr of prs) {
    for (const notice of findPrNotices(pr)) {
      console.log(`::notice title=Superseded Ally review at one head::${notice}`);
    }
  }

  for (const entry of staleEntries) {
    log(
      `::warning title=Stale ally-review-consistency baseline entry::` +
        `${BASELINE_PATH} still suppresses ${entry.fingerprint} (PR #${entry.pr}, ${entry.issue}) but no ` +
        `current violation matches it — the finding is resolved or the PR moved. Remove the entry.`,
    );
  }

  if (suppressed.length > 0) {
    log(`Suppressed by ${BASELINE_PATH} (${suppressed.length} known violation(s)):\n`);
    for (const { violation, entry } of suppressed) {
      log(`  [${entry.issue}] ${violation}`);
    }
    log("");
  }

  if (deferred.length > 0) {
    log(
      `Deferred (${deferred.length}) — real, unbaselined findings on PR(s) GitHub will not ` +
        `merge from. Each returns to failing the moment its PR becomes mergeable:\n`,
    );
    for (const { violation, fingerprint, reason } of deferred) {
      log(
        `::warning title=Ally review-consistency finding on an unmergeable PR::` +
          `${violation} [${reason}]`,
      );
      log(`    fingerprint: ${fingerprint}`);
    }
    log("");
  }

  if (failing.length > 0) {
    err(
      `Ally review-consistency guard FAILED for ${repo} (${failing.length} unbaselined violation(s) on mergeable PR(s)):\n`,
    );
    for (const { violation, fingerprint } of failing) {
      err(`  ${violation}`);
      err(`    fingerprint: ${fingerprint}`);
    }
    err(
      "\nA violation means a PR may present as reviewed or approved without a single " +
        "operative attestation backing its current head. See BLO-19778.\n" +
        `Fix the PR, or — only if the finding is genuinely accepted — add its fingerprint to ` +
        `${BASELINE_PATH} with the PR number, the owning issue, and a note. A baseline entry is ` +
        `pinned to the head SHA and review IDs above, so it expires the moment the PR is touched.`,
    );
    exit(1);
    return;
  }

  log(
    `Ally review-consistency guard passed: no unbaselined attestation conflicts found across ` +
      `${liveCount} mergeable PR(s) of ${prs.length} open in ${repo}` +
      `${deferred.length > 0 ? `, ${deferred.length} finding(s) deferred on unmergeable PRs` : ""}.`,
  );
}

export function isMainModule(argvPath = process.argv[1], moduleUrl = import.meta.url) {
  return Boolean(argvPath) && resolve(argvPath) === fileURLToPath(moduleUrl);
}

if (isMainModule()) {
  main();
}
