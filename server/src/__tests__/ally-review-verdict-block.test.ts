import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  extractAllyPriorFindingDispositions,
  extractAllyReportedFindingRefs,
  extractAllyReviewedHeadSha,
  allyClaimedReviewHead,
  hasActionablePrReviewFeedback,
  hasAllyConsolidatedReviewHeading,
  parseAllyVerdictBlock,
} from "../services/ally-review-detection.js";
import { evaluateCommentReviewGate, commentReviewGateCheckTitle } from "../services/pr-comment-review-gate.js";

/**
 * The verbatim body of Ally's 2026-09-07T15:41:42Z review of paperclip#1675
 * (review id 5133687436, `commit_id` 583085ded…), fetched from GitHub and
 * stored byte-for-byte rather than retyped.
 *
 * It is stored as a fixture file instead of a template literal on purpose: the
 * body contains four fenced code blocks and many inline backticks, and the
 * whole point of these cases is that the *exact* punctuation is what broke the
 * parsers. Escaping it into TypeScript would put a transcription step between
 * the assertion and the thing it asserts about.
 */
const PR1675_HEAD = "583085ded80ad1ba6420744000a94fc8671c418b";
const PR1675_CLEAN_REVIEW_BODY = readFileSync(
  fileURLToPath(new URL("./fixtures/ally-review-pr1675-2026-09-07T154142Z.md", import.meta.url)),
  "utf8",
);

/**
 * Blockcast/blockcast.github.io#126, review 5193254543, APPROVED at this head.
 * Counts 0/0/0, one prior finding dispositioned `fixed`, and no verdict block —
 * it predates the emitter. Kept verbatim because the defect is in the exact
 * wording of the template's third line.
 */
const PR126_HEAD = "1a1d9c1e8976e4359e6ba18bf8d7e3d09cc5749b";
const PR126_CLEAN_REVIEW_BODY = readFileSync(
  fileURLToPath(new URL("./fixtures/ally-review-blockcast-gh-io-pr126-2026-09-14T020111Z.md", import.meta.url)),
  "utf8",
);

const ALLY_BOT_LOGIN = "allyblockcast[bot]";

function allyComment(body: string, createdAt: string) {
  return { authorLogin: ALLY_BOT_LOGIN, body, createdAt };
}

/** The two ledger bullets, taken from the fixture rather than restated. */
function ledgerBullets(): string[] {
  return PR1675_CLEAN_REVIEW_BODY.split("\n").filter((line) =>
    /^\s*-\s*\*\*\s*prior:/.test(line),
  );
}

function verdictBlock(payload: unknown, version = 1): string {
  return `<!-- ally-verdict:${version}\n${JSON.stringify(payload, null, 2)}\n-->`;
}

/** The structured verdict Ally *would* emit for the fixture's own review. */
const PR1675_VERDICT = {
  head: PR1675_HEAD,
  findings: { critical: 0, important: 0 },
  dispositions: [
    { head: "583085ded", severity: "important", index: 1, verb: "fixed" },
    { head: "583085ded", severity: "recommended-action", index: 4, verb: "withdrawn" },
  ],
};

/**
 * BLO-32695's measurement, pinned so it cannot silently stop being true.
 *
 * These four assertions are negative controls, not aspirations: they document
 * that one clean review — 0 Critical, 0 Important, two findings explicitly
 * retired — defeated four independent prose patterns for four unrelated
 * reasons. They are what makes the structured block a replacement rather than
 * a fifth widening. If a future prose fix makes one of them parse, that is
 * fine and the case should be updated to say so; what must not happen is the
 * set quietly shrinking because nobody noticed the shapes changed.
 */
describe("BLO-32695 — the #1675 clean review against prose parsing", () => {
  it("is recognised as an Ally review, so nothing here is an author-identity miss", () => {
    expect(hasAllyConsolidatedReviewHeading(PR1675_CLEAN_REVIEW_BODY)).toBe(true);
  });

  it("attests no head: the parenthetical after the SHA closes the attestation pattern", () => {
    expect(PR1675_CLEAN_REVIEW_BODY).toContain(
      `Reviewed head: ${PR1675_HEAD} (unchanged since my last pass`,
    );
    expect(extractAllyReviewedHeadSha(PR1675_CLEAN_REVIEW_BODY)).toBeNull();

    // The control that isolates the parenthetical as the sole cause: drop it
    // and the very same body attests cleanly.
    const withoutParenthetical = PR1675_CLEAN_REVIEW_BODY.replace(
      new RegExp(`(Reviewed head: ${PR1675_HEAD}) \\(.*?\\)`),
      "$1",
    );
    expect(extractAllyReviewedHeadSha(withoutParenthetical)).toBe(PR1675_HEAD);
  });

  it("dispositions nothing: both ledger bullets are dropped whole", () => {
    expect(ledgerBullets()).toHaveLength(2);
    expect(extractAllyPriorFindingDispositions(PR1675_CLEAN_REVIEW_BODY)).toEqual([]);
  });

  it("drops bullet 1 for a bolded verb AND a missing second dash, not either alone", () => {
    const [bullet] = ledgerBullets();
    expect(bullet).toContain("— **fixed, and my finding was stale when I filed it.**");

    // Progressive repair. Un-bolding alone still yields nothing — the pattern
    // also requires a second dash after the verb, and Ally wrote a comma then
    // prose. This is the step that separates BLO-32695 from BLO-31947: that
    // row's repair addresses the bold, and the bullet still does not parse.
    const unbolded = bullet!.replace(/— \*\*fixed,.*$/, "— fixed, and my finding was stale.");
    expect(extractAllyPriorFindingDispositions(unbolded)).toEqual([]);

    const unboldedWithDash = bullet!.replace(/— \*\*fixed,.*$/, "— fixed — my finding was stale.");
    expect(extractAllyPriorFindingDispositions(unboldedWithDash)).toHaveLength(1);
  });

  it("drops bullet 2 for a hyphenated severity the pattern cannot express", () => {
    const [, bullet] = ledgerBullets();
    expect(bullet).toContain("prior:583085ded recommended-action 4");

    // `recommended-action` cannot match the pattern's `([a-z]+)` severity, so
    // even the fully-repaired punctuation still yields nothing.
    const fullyRepunctuated =
      "- **prior:583085ded recommended-action 4** — withdrawn — I was wrong.";
    expect(extractAllyPriorFindingDispositions(fullyRepunctuated)).toEqual([]);

    // Same bullet with a single-word severity parses, isolating the hyphen.
    const singleWordSeverity = "- **prior:583085ded important 4** — fixed — I was wrong.";
    expect(extractAllyPriorFindingDispositions(singleWordSeverity)).toHaveLength(1);
  });

  it("is itself clean, so the red came from a stale review of the same head", () => {
    // The body carries no blocking feedback at all. That matters for the
    // diagnosis: `blocking_finding` was not manufactured out of this review's
    // prose — this review was simply *invisible*, so an older review of the
    // same head stayed authoritative and its finding was published instead.
    expect(hasActionablePrReviewFeedback(PR1675_CLEAN_REVIEW_BODY)).toBe(false);
    // Both buckets are present and both read (0), so the findings *are*
    // enumerable — they just enumerate to nothing. That is a different state
    // from `null` ("no bucket at all"), and the difference decides whether a
    // head can ever be fully dispositioned.
    expect(extractAllyReportedFindingRefs(PR1675_CLEAN_REVIEW_BODY)).toEqual([]);
  });

  it("reproduces the incident end to end: the superseded verdict is the one published", () => {
    // The earlier review is synthesised rather than stored verbatim: the four
    // pinned failures all live in the 15:41:42Z body, and what this case needs
    // from the 03:46:19Z one is only that it attested the same head and
    // reported a finding, which is exactly what it did.
    const earlierSameHead = [
      "## Ally — Consolidated PR Review",
      `Reviewed head: ${PR1675_HEAD}`,
      "### Critical Issues (0)",
      "### Important Issues (1)",
      "- The PR title still reads `docs(agents):`.",
    ].join("\n");

    const verdict = evaluateCommentReviewGate({
      headSha: PR1675_HEAD,
      reviewerBotLogin: ALLY_BOT_LOGIN,
      comments: [
        allyComment(earlierSameHead, "2026-09-07T03:46:19Z"),
        allyComment(PR1675_CLEAN_REVIEW_BODY, "2026-09-07T15:41:42Z"),
      ],
    });

    expect(verdict).toMatchObject({ state: "failure", outcome: "blocking_finding" });
  });
});

describe("BLO-32695 — the structured verdict block as the primary source", () => {
  const withBlock = `${verdictBlock(PR1675_VERDICT)}\n${PR1675_CLEAN_REVIEW_BODY}`;

  it("attests the head as a field, unmoved by the prose that defeated the pattern", () => {
    expect(extractAllyReviewedHeadSha(withBlock)).toBe(PR1675_HEAD);
  });

  it("carries both dispositions, including the hyphenated severity", () => {
    expect(extractAllyPriorFindingDispositions(withBlock)).toEqual([
      {
        shortSha: "583085ded",
        severity: "important",
        index: 1,
        disposition: "fixed",
        kind: "retires",
      },
      {
        shortSha: "583085ded",
        severity: "recommended-action",
        index: 4,
        disposition: "withdrawn",
        // Unchanged vocabulary: `withdrawn` is not in the retiring set, so it
        // still fails closed. Widening the verb list is a separate decision
        // about what Ally *decides*, which BLO-32695 puts out of scope; the
        // point here is that the verb now arrives intact instead of the whole
        // bullet being dropped.
        kind: "unrecognized",
      },
    ]);
  });

  it("resolves the same body to clean/success", () => {
    const verdict = evaluateCommentReviewGate({
      headSha: PR1675_HEAD,
      reviewerBotLogin: ALLY_BOT_LOGIN,
      comments: [allyComment(withBlock, "2026-09-07T15:41:42Z")],
    });
    expect(verdict).toMatchObject({ state: "success", outcome: "clean" });
  });

  it("still publishes a real counted finding as blocking_finding", () => {
    const blocking = `${verdictBlock({
      head: PR1675_HEAD,
      findings: { critical: 0, important: 2 },
    })}\n## Ally — Consolidated PR Review\nNo prose buckets at all.`;

    expect(extractAllyReportedFindingRefs(blocking)).toEqual([
      { severity: "important", index: 1 },
      { severity: "important", index: 2 },
    ]);
    expect(
      evaluateCommentReviewGate({
        headSha: PR1675_HEAD,
        reviewerBotLogin: ALLY_BOT_LOGIN,
        comments: [allyComment(blocking, "2026-09-07T15:41:42Z")],
      }),
    ).toMatchObject({ state: "failure", outcome: "blocking_finding" });
  });

  it("reads an explicitly zeroed findings object as a stated zero", () => {
    // The boundary of the missing-count tightening below, pinned from the
    // permissive side so the fix cannot quietly grow into rejecting a review
    // that legitimately found nothing. Stating both blocking counts as `0` is
    // Ally saying "I counted, the answer was nothing"; omitting either — or
    // the whole object — is Ally saying nothing at all. Only the second may
    // clear no head.
    const emptyCounts = `${verdictBlock({ head: PR1675_HEAD, findings: { critical: 0, important: 0 } })}\n## Ally — Consolidated PR Review`;
    const parsed = parseAllyVerdictBlock(emptyCounts);
    expect(parsed.kind).toBe("ok");
    expect(hasActionablePrReviewFeedback(emptyCounts)).toBe(false);
    expect(
      evaluateCommentReviewGate({
        headSha: PR1675_HEAD,
        reviewerBotLogin: ALLY_BOT_LOGIN,
        comments: [allyComment(emptyCounts, "2026-09-07T15:41:42Z")],
      }),
    ).toMatchObject({ state: "success", outcome: "clean" });
  });

  it("ignores a block inside a fence, so a quoted verdict cannot clear a head", () => {
    const quoted = [
      "## Ally — Consolidated PR Review",
      "Quoting the review I am replying to:",
      "```",
      verdictBlock(PR1675_VERDICT),
      "```",
    ].join("\n");
    expect(parseAllyVerdictBlock(quoted)).toEqual({ kind: "absent" });
  });
});

/**
 * Cross-reader agreement about which tree was examined.
 *
 * Four readers parse `Reviewed head:` and only this module understands the
 * block — consolidatedReviewHead (github-app-auth.ts), ATTESTED_HEAD_RE
 * (check-ally-review-consistency.mjs) and HEAD_ATTESTATION_RE
 * (sweep-stalled-ally-reviews.py) are the other three. So a body whose block
 * and prose name different heads would set the merge gate against one tree
 * while the retry sweep reasoned about another.
 *
 * The asymmetry is the whole design and is easy to get backwards. Requiring a
 * *matching* prose attestation before the block may be trusted would have been
 * the obvious reading of the finding, and it would have reverted BLO-32695
 * outright: the #1675 body's prose attestation is exactly the one the retired
 * regex cannot read, so the block would have been unusable on the very review
 * that motivated it. Only a readable *disagreement* is fatal.
 */
describe("BLO-32695 — the block and the prose line must not name different heads", () => {
  const OTHER_HEAD = "1111111111111111111111111111111111111111";

  it("fails closed when a clean prose attestation contradicts the block", () => {
    const conflicting = [
      verdictBlock(PR1675_VERDICT),
      "## Ally — Consolidated PR Review",
      `Reviewed head: ${OTHER_HEAD}`,
    ].join("\n");

    expect(parseAllyVerdictBlock(conflicting)).toMatchObject({ kind: "unreadable" });
    expect(extractAllyReviewedHeadSha(conflicting)).toBeNull();
  });

  it("does not resolve a contradicting body to success", () => {
    const conflicting = [
      verdictBlock(PR1675_VERDICT),
      "## Ally — Consolidated PR Review",
      `Reviewed head: ${OTHER_HEAD}`,
    ].join("\n");

    const verdict = evaluateCommentReviewGate({
      headSha: PR1675_HEAD,
      reviewerBotLogin: ALLY_BOT_LOGIN,
      comments: [allyComment(conflicting, "2026-09-07T15:41:42Z")],
    });
    expect(verdict.state).not.toBe("success");
  });

  it("still trusts the block when the prose agrees", () => {
    const agreeing = [
      verdictBlock(PR1675_VERDICT),
      "## Ally — Consolidated PR Review",
      `Reviewed head: ${PR1675_HEAD}`,
    ].join("\n");

    expect(extractAllyReviewedHeadSha(agreeing)).toBe(PR1675_HEAD);
  });

  it("still trusts the block when the prose attestation is the unreadable #1675 shape", () => {
    // The regression guard for the obvious-but-wrong fix. This body's prose
    // line carries the trailing parenthetical that yields zero matches, so a
    // rule demanding a matching prose attestation would null it out — the
    // exact false red BLO-32695 was filed to end.
    const withBlock = `${verdictBlock(PR1675_VERDICT)}\n${PR1675_CLEAN_REVIEW_BODY}`;
    // Control: without the block that same prose attests nothing at all.
    expect(extractAllyReviewedHeadSha(PR1675_CLEAN_REVIEW_BODY)).toBeNull();
    expect(extractAllyReviewedHeadSha(withBlock)).toBe(PR1675_HEAD);
  });

  it("still trusts the block when the prose is ambiguous rather than contradicting", () => {
    // Two attestations are not a competing claim, they are noise — precisely
    // what the block exists to speak over. Failing closed here would let any
    // review that *quotes* a head defeat its own verdict.
    const ambiguous = [
      verdictBlock(PR1675_VERDICT),
      "## Ally — Consolidated PR Review",
      `Reviewed head: ${PR1675_HEAD}`,
      `Reviewed head: ${OTHER_HEAD}`,
    ].join("\n");

    expect(extractAllyReviewedHeadSha(ambiguous)).toBe(PR1675_HEAD);
  });
});

/**
 * A truncated block must not fall through to the prose parser.
 *
 * The fail-closed branch had a hole shaped like its own entry condition. An
 * unterminated `<!-- ally-verdict:1` matches no complete block, so the block
 * pattern counted zero and returned `absent` — the one branch that is
 * *permitted* to trust prose, because every review posted before this shipped
 * is such a body. A body carrying a broken block plus prose that happens to
 * read clean would therefore clear the gate on exactly the prose the block
 * exists to stop trusting.
 *
 * The two facts an author must not conflate: "Ally predates the block" and
 * "Ally tried to state a verdict and the payload is broken". Only the first
 * may use the prose path.
 */
describe("BLO-32695 — an unterminated block opener is unreadable, not absent", () => {
  // The clean prose from the fall-back suite below, verbatim: on its own it
  // resolves to success, which is what makes it the right control here.
  const cleanProse = [
    "## Ally — Consolidated PR Review",
    `Reviewed head: ${PR1675_HEAD}`,
    "### Critical Issues (0)",
    "### Important Issues (0)",
  ].join("\n");

  const truncated = [
    `<!-- ally-verdict:1`,
    JSON.stringify(PR1675_VERDICT, null, 2),
    "",
    cleanProse,
  ].join("\n");

  it("control: that prose alone takes the absent branch and clears", () => {
    expect(parseAllyVerdictBlock(cleanProse)).toEqual({ kind: "absent" });
    expect(
      evaluateCommentReviewGate({
        headSha: PR1675_HEAD,
        reviewerBotLogin: ALLY_BOT_LOGIN,
        comments: [allyComment(cleanProse, "2026-09-07T15:41:42Z")],
      }),
    ).toMatchObject({ state: "success" });
  });

  it("reports the missing terminator rather than falling back", () => {
    expect(parseAllyVerdictBlock(truncated)).toMatchObject({
      kind: "unreadable",
      reason: expect.stringContaining("terminator"),
    });
  });

  it("does not clear the gate on the clean prose behind the broken block", () => {
    const verdict = evaluateCommentReviewGate({
      headSha: PR1675_HEAD,
      reviewerBotLogin: ALLY_BOT_LOGIN,
      comments: [allyComment(truncated, "2026-09-07T15:41:42Z")],
    });
    expect(verdict.state).not.toBe("success");
  });

  it("attests no head, so a truncated block cannot borrow the prose attestation", () => {
    expect(extractAllyReviewedHeadSha(truncated)).toBeNull();
  });

  it("ignores a quoted or indented opener, exactly as the block pattern does", () => {
    // Same anchoring as ALLY_VERDICT_BLOCK_PATTERN, and for the same reason: a
    // review *discussing* this format is the likeliest place an opener appears
    // in prose, and on this file that discussion happens in its own reviews. An
    // unanchored opener count would let a review of this parser wedge its own
    // gate — the failure the block anchoring was added to prevent, re-entering
    // through the counter.
    for (const quoted of [
      `> <!-- ally-verdict:1`,
      `    <!-- ally-verdict:1`,
      `see <!-- ally-verdict:1 mid-line`,
    ]) {
      expect(parseAllyVerdictBlock(`${quoted}\n${cleanProse}`)).toEqual({ kind: "absent" });
    }
  });

  it("still reads a well-formed block that merely sits alongside a quoted opener", () => {
    const body = [
      verdictBlock(PR1675_VERDICT),
      "> <!-- ally-verdict:1  (quoting the format in prose)",
      cleanProse,
    ].join("\n");
    expect(parseAllyVerdictBlock(body)).toMatchObject({ kind: "ok" });
  });
});

/**
 * The block path must block on the same two severities the prose path does.
 *
 * The prose readers get that bound for free from COUNTED_FINDINGS_BUCKET_PATTERN,
 * whose alternation enumerates Critical and Important and nothing else. The
 * block reader has no such pattern to inherit it from, so a reader written as
 * "any positive count blocks" diverges — and diverges on the *most common*
 * review shape rather than an edge case, because Ally's own template mandates a
 * third count, `suggestions`. The first clean-with-suggestions review posted
 * under the new format would have gone red.
 *
 * All three consequences ride on the same payload, so one case pins them:
 * the merge gate, the author wake (github-webhook routes on the same
 * predicate), and the carry ledger — where a `suggestions` ref is *unretirable*,
 * since the disposition vocabulary only ever names Critical/Important, so
 * isFullyDispositioned could never clear the head. That last one is the
 * BLO-31446/BLO-31947 trap this row exists to close, and inheriting it through
 * the new path would have made the replacement worse than the prose parsing it
 * retires.
 */
describe("BLO-32695 — the block path blocks on the prose path's severities", () => {
  const cleanWithSuggestions = `${verdictBlock({
    head: PR1675_HEAD,
    findings: { critical: 0, important: 0, suggestions: 2 },
    dispositions: [],
  })}\n## Ally — Consolidated PR Review\nReviewed head: ${PR1675_HEAD}`;

  it("does not treat a non-blocking severity as actionable feedback", () => {
    expect(hasActionablePrReviewFeedback(cleanWithSuggestions)).toBe(false);
  });

  it("mints no finding refs for it, so the head cannot carry unretirably", () => {
    expect(extractAllyReportedFindingRefs(cleanWithSuggestions)).toEqual([]);
  });

  it("resolves it to clean/success rather than a false blocking_finding", () => {
    expect(
      evaluateCommentReviewGate({
        headSha: PR1675_HEAD,
        reviewerBotLogin: ALLY_BOT_LOGIN,
        comments: [allyComment(cleanWithSuggestions, "2026-09-07T15:41:42Z")],
      }),
    ).toMatchObject({ state: "success", outcome: "clean" });
  });

  it("still blocks when a blocking severity is positive alongside suggestions", () => {
    const blocking = `${verdictBlock({
      head: PR1675_HEAD,
      findings: { critical: 0, important: 1, suggestions: 3 },
      dispositions: [],
    })}\n## Ally — Consolidated PR Review\nReviewed head: ${PR1675_HEAD}`;

    expect(hasActionablePrReviewFeedback(blocking)).toBe(true);
    // Only the blocking severity contributes an identity to retire.
    expect(extractAllyReportedFindingRefs(blocking)).toEqual([
      { severity: "important", index: 1 },
    ]);
  });
});

/**
 * A severity key outside the vocabulary must make the block unreadable, not be
 * dropped — the one fail-open the structured path could still reintroduce.
 *
 * Every blocking check consults BLOCKING_SEVERITIES, so a key outside it is
 * never read by anything. Accept-then-ignore therefore makes `{"critcal": 1}`
 * parse as a readable verdict that is *byte-indistinguishable from a clean
 * one*: a verdict stating it found a Critical clears the head. Measured before
 * the fix, on a body whose prose also said `### Critical Issues (1)`:
 *
 *     typo'd blocking key    parse=ok | actionable=false | refs=[]
 *     control: clean         parse=ok | actionable=false | refs=[]
 *
 * Identical. And worse than the prose parser it replaces, which would have
 * blocked on that heading — the block short-circuits it. That is BLO-29711's
 * fail-open direction arriving through the new path, so it fails closed.
 *
 * Schema drift, not just typos: the vocabulary is a contract between a producer
 * and a consumer that ship separately, so a renamed bucket has to be loud.
 */
describe("BLO-32695 — an unknown severity key fails closed, not open", () => {
  const typod = (findings: unknown) =>
    `${verdictBlock({ head: PR1675_HEAD, findings })}\n## Ally — Consolidated PR Review\n` +
    `Reviewed head: ${PR1675_HEAD}\n\n### Critical Issues (1)\n- something is badly wrong`;

  // The same body with prose that agrees with a zeroed block. The controls
  // below need a block that is well-formed *and* uncontradicted: `typod`'s
  // body enumerates a Critical, so passing it honest zero counts is now its
  // own unreadable case (the count-disagreement rule), which would make the
  // control pass for the wrong reason.
  const agreeing = (findings: unknown) =>
    `${verdictBlock({ head: PR1675_HEAD, findings })}\n## Ally — Consolidated PR Review\n` +
    `Reviewed head: ${PR1675_HEAD}\n\n### Critical Issues (0)\n### Important Issues (0)`;

  it("reads a misspelled blocking severity as unreadable, naming the key", () => {
    expect(parseAllyVerdictBlock(typod({ critcal: 1, important: 0 }))).toMatchObject({
      kind: "unreadable",
      reason: /unsupported severity `critcal`/,
    });
  });

  it("resolves it to a failure, not the clean verdict it used to mimic", () => {
    expect(
      evaluateCommentReviewGate({
        headSha: PR1675_HEAD,
        reviewerBotLogin: ALLY_BOT_LOGIN,
        comments: [allyComment(typod({ critcal: 1, important: 0 }), "2026-09-07T15:41:42Z")],
      }),
    ).toMatchObject({ state: "failure", outcome: "unreadable_verdict" });
  });

  it("does not call the unreadable block a finding in the check-run title", () => {
    // The title is what a reader sees before opening the check, so it is the
    // line most likely to be read in isolation — and `unreadable_verdict` is
    // neither evidence of review nor evidence of a finding. Master's title
    // switch predates this outcome (BLO-33657); the case was added when the
    // two branches met. Asserting the wording, not just exhaustiveness,
    // because the compiler cannot tell a correct title from a misleading one.
    const verdict = evaluateCommentReviewGate({
      headSha: PR1675_HEAD,
      reviewerBotLogin: ALLY_BOT_LOGIN,
      comments: [allyComment(typod({ critcal: 1, important: 0 }), "2026-09-07T15:41:42Z")],
    });

    const title = commentReviewGateCheckTitle(verdict);
    expect(title).toMatch(/unreadable/i);
    expect(title).not.toMatch(/unresolved finding/i);
  });

  it("is now distinguishable from clean: null refs, not an empty list", () => {
    // `[]` is "reviewed, found nothing"; `null` is "we could not read it".
    // Collapsing the two is what let the typo pass as a clean review.
    expect(extractAllyReportedFindingRefs(typod({ critcal: 1, important: 0 }))).toBeNull();
    expect(extractAllyReportedFindingRefs(agreeing({ critical: 0, important: 0 }))).toEqual([]);
  });

  // Controls against over-tightening in either direction.
  it("still reads every supported key, including non-blocking suggestions", () => {
    expect(
      parseAllyVerdictBlock(agreeing({ critical: 0, important: 0, suggestions: 2 })),
    ).toMatchObject({ kind: "ok" });
  });

  it("does not constrain disposition severities, which are open by design", () => {
    // #1675's ledger retires `prior:583085ded recommended-action 4` — failure #4
    // of this row. The findings vocabulary is closed because a typo there clears
    // a head; a disposition severity only ever names a finding to retire, so
    // closing it would re-open the false red this row exists to fix.
    expect(parseAllyVerdictBlock(verdictBlock(PR1675_VERDICT))).toMatchObject({
      kind: "ok",
      verdict: {
        dispositions: [
          { severity: "important", index: 1, verb: "fixed" },
          { severity: "recommended-action", index: 4, verb: "withdrawn" },
        ],
      },
    });
  });
});

/**
 * The opener is line-anchored, so only a *real* block counts.
 *
 * Fencing is not the only way to quote, and withoutFencedCodeBlocks strips only
 * fenced spans. An unanchored opener reads an indented example, an inline-code
 * mention, or a blockquoted predecessor as a second block — and two blocks is
 * the fail-closed `unreadable_verdict` red. The trigger is self-referential:
 * the reviews most likely to quote this marker are reviews *of this parser*, so
 * unanchored, a review of this file wedges its own gate.
 *
 * A ≤3-space indent is deliberately still a match. That is a paragraph in
 * Markdown, not a code block, so the comment really is live HTML — the same
 * ` {0,3}` bound every other line-anchored pattern here uses.
 */
describe("BLO-32695 — quoted mentions do not mint a phantom second block", () => {
  const real = verdictBlock(PR1675_VERDICT);
  const body = (quoted: string) =>
    `${real}\n\n## Ally — Consolidated PR Review\nReviewed head: ${PR1675_HEAD}\n\n${quoted}`;

  const cases: Array<[string, string]> = [
    ["a 4-space-indented documentation example", `    ${real}`],
    ["an inline-code mention", `The marker is \`${real}\` in full.`],
    ["a blockquoted prior review", `> ${real}`],
    ["a mid-line mention", `As emitted, ${real} sits at the top.`],
  ];

  for (const [name, quoted] of cases) {
    it(`reads past ${name} and still parses the one real block`, () => {
      const parsed = parseAllyVerdictBlock(body(quoted));
      expect(parsed.kind).toBe("ok");
      expect(parsed.kind === "ok" && parsed.verdict.head).toBe(PR1675_HEAD);
    });
  }

  it("keeps a second genuine block unreadable, so the fail-closed path survives", () => {
    const parsed = parseAllyVerdictBlock(body(real));
    expect(parsed.kind).toBe("unreadable");
  });
});

/**
 * AC-5. Every one of these is a *tightening*: the block is unreadable, so the
 * verdict must not be `success`. None of them can affect a PR today, because
 * no review in the corpus carries a block at all — a body without one takes
 * the `absent` branch and the prose fallback behaves exactly as before.
 */
describe("BLO-32695 — fail-closed on an unreadable block", () => {
  const cases: { name: string; body: string; reason: RegExp }[] = [
    {
      name: "two conflicting blocks",
      body: [
        verdictBlock({ head: PR1675_HEAD, findings: { important: 0 } }),
        verdictBlock({ head: PR1675_HEAD, findings: { important: 3 } }),
        "## Ally — Consolidated PR Review",
      ].join("\n"),
      reason: /2 ally-verdict blocks/,
    },
    {
      name: "a block attesting no head",
      body: `${verdictBlock({ findings: { important: 0 } })}\n## Ally — Consolidated PR Review`,
      reason: /attests no complete head/,
    },
    {
      name: "a block whose head is abbreviated",
      body: `${verdictBlock({ head: "583085d", findings: {} })}\n## Ally — Consolidated PR Review`,
      reason: /attests no complete head/,
    },
    {
      name: "malformed JSON",
      body: `<!-- ally-verdict:1 {"head": -->\n## Ally — Consolidated PR Review`,
      reason: /not valid JSON/,
    },
    {
      name: "an unsupported version",
      body: `${verdictBlock({ head: PR1675_HEAD, findings: {} }, 2)}\n## Ally — Consolidated PR Review`,
      reason: /unsupported ally-verdict version 2/,
    },
    {
      name: "non-integer finding counts",
      body: `${verdictBlock({ head: PR1675_HEAD, findings: { important: "two" } })}\n## Ally — Consolidated PR Review`,
      reason: /not severity counts/,
    },
    {
      // The dangerous shape, and the reason it needs its own case: every other
      // entry here is malformed in a way that is obvious on sight. This one is
      // a *valid* block — good head, good version, parseable JSON — that simply
      // never states what it found. Defaulting the absent counts to an empty
      // map made it read as 0 Critical / 0 Important, i.e. a clean verdict, so
      // a payload making no claim could clear a head. That is the fail-open
      // direction BLO-29711 closed and AC-5 forbids re-opening.
      name: "a valid head with no findings counts at all",
      body: `${verdictBlock({ head: PR1675_HEAD })}\n## Ally — Consolidated PR Review`,
      reason: /states no findings counts/,
    },
    {
      // Same fail-open one level down, and strictly harder to spot: the object
      // is present, well-typed and internally consistent, it simply never
      // states the two counts that decide the gate. The blocking loop reads
      // the absent keys as zero, so this cleared a head while claiming only
      // that it found no suggestions.
      name: "a findings object that omits the blocking counts",
      body: `${verdictBlock({ head: PR1675_HEAD, findings: { suggestions: 0 } })}\n## Ally — Consolidated PR Review`,
      reason: /omit the `critical` count/,
    },
    {
      name: "a findings object that omits only one blocking count",
      body: `${verdictBlock({ head: PR1675_HEAD, findings: { critical: 0 } })}\n## Ally — Consolidated PR Review`,
      reason: /omit the `important` count/,
    },
    {
      // `Number.isInteger(1e100)` is true, so this passed every type check and
      // then hung extractAllyReportedFindingRefs, which enumerates 1..count.
      // A malformed block must fail the gate, never stall the worker that
      // evaluates it.
      name: "a finding count past the tracking ceiling",
      body: `${verdictBlock({ head: PR1675_HEAD, findings: { critical: 1e100, important: 0 } })}\n## Ally — Consolidated PR Review`,
      reason: /exceeds 1000/,
    },
    {
      name: "a disposition missing its index",
      body: `${verdictBlock({
        head: PR1675_HEAD,
        findings: { critical: 0, important: 0 },
        dispositions: [{ head: "583085d", severity: "important", verb: "fixed" }],
      })}\n## Ally — Consolidated PR Review`,
      reason: /dispositions are malformed/,
    },
  ];

  for (const { name, body, reason } of cases) {
    it(`reports ${name} as unreadable rather than resolving to success`, () => {
      const parsed = parseAllyVerdictBlock(body);
      expect(parsed.kind).toBe("unreadable");
      expect(parsed.kind === "unreadable" && parsed.reason).toMatch(reason);

      const verdict = evaluateCommentReviewGate({
        headSha: PR1675_HEAD,
        reviewerBotLogin: ALLY_BOT_LOGIN,
        comments: [allyComment(body, "2026-09-07T15:41:42Z")],
      });
      expect(verdict.state).toBe("failure");
      expect(verdict.outcome).toBe("unreadable_verdict");
    });
  }

  it("does not report an unreadable block as carrying a finding", () => {
    // AC-3. The distinction is the whole point: "I could not read this" and
    // "this carries an unresolved finding" are different claims, and the gate
    // may only make the second one when a finding was actually counted.
    const body = `<!-- ally-verdict:1 not json -->\n## Ally — Consolidated PR Review`;
    expect(hasActionablePrReviewFeedback(body)).toBe(false);
    expect(extractAllyReportedFindingRefs(body)).toBeNull();
    expect(
      evaluateCommentReviewGate({
        headSha: PR1675_HEAD,
        reviewerBotLogin: ALLY_BOT_LOGIN,
        comments: [allyComment(body, "2026-09-07T15:41:42Z")],
      }),
    ).toMatchObject({ outcome: "unreadable_verdict" });
  });

  it("clears once Ally posts a readable review, so the red is never a dead end", () => {
    // Bounded to the newest review on purpose. An unreadable block anywhere in
    // history would be unretirable — the trap BLO-31446 and BLO-31947 both
    // describe — so the escape route has to be one more review.
    const unreadable = `<!-- ally-verdict:1 broken -->\n## Ally — Consolidated PR Review`;
    const readable = `${verdictBlock(PR1675_VERDICT)}\n## Ally — Consolidated PR Review`;

    expect(
      evaluateCommentReviewGate({
        headSha: PR1675_HEAD,
        reviewerBotLogin: ALLY_BOT_LOGIN,
        comments: [
          allyComment(unreadable, "2026-09-07T15:41:42Z"),
          allyComment(readable, "2026-09-08T00:39:55Z"),
        ],
      }),
    ).toMatchObject({ state: "success", outcome: "clean" });
  });
});

/**
 * The block is additive. A body without one must behave exactly as it did
 * before, because every review already posted is such a body — if `absent`
 * changed behaviour at all, this change would red-wedge the whole open-PR
 * population the moment it shipped.
 */
describe("BLO-32695 — block-less bodies keep the prose fallback", () => {
  const prose = [
    "## Ally — Consolidated PR Review",
    `Reviewed head: ${PR1675_HEAD}`,
    "### Prior Findings Dispositioned (1)",
    "- **prior:abc1234 important 1** — fixed — re-checked at this head.",
    "### Critical Issues (0)",
    "### Important Issues (0)",
  ].join("\n");

  it("takes the absent branch", () => {
    expect(parseAllyVerdictBlock(prose)).toEqual({ kind: "absent" });
  });

  it("still parses the attestation, the ledger and the buckets from prose", () => {
    expect(extractAllyReviewedHeadSha(prose)).toBe(PR1675_HEAD);
    expect(extractAllyPriorFindingDispositions(prose)).toHaveLength(1);
    expect(extractAllyReportedFindingRefs(prose)).toEqual([]);
    expect(hasActionablePrReviewFeedback(prose)).toBe(false);
  });

  it("still resolves to clean/success", () => {
    expect(
      evaluateCommentReviewGate({
        headSha: PR1675_HEAD,
        reviewerBotLogin: ALLY_BOT_LOGIN,
        comments: [allyComment(prose, "2026-09-07T15:41:42Z")],
      }),
    ).toMatchObject({ state: "success", outcome: "clean" });
  });
});

/**
 * BLO-33818's instance, and the reason it is a precedence rule and not a guard.
 *
 * This body carries explicit `Critical Issues (0)` / `Important Issues (0)` and
 * an APPROVED state, yet the live gate reported "carries an unresolved
 * finding". The trip is the `Recommended Action` template heuristic, whose
 * matched span here is:
 *
 *     "Recommended Action\n1. No Critical issues to fix before merge"
 *
 * Ally negated the boilerplate and it matched anyway — `fix` and `before merge`
 * both survive the negation. The negation also sits *inside* the matched span,
 * and `hasNonNegatedMatch` only inspects text *preceding* a match, so wrapping
 * this clause would not have helped. That is the whole argument for keying on
 * the count instead: the template is emitted unconditionally, so no rewording
 * of it is separable from a real finding by pattern alone.
 */
describe("BLO-32695 — an explicit zero count outranks the Recommended Action template", () => {
  it("does not read the negated boilerplate as a finding", () => {
    expect(parseAllyVerdictBlock(PR126_CLEAN_REVIEW_BODY)).toEqual({ kind: "absent" });
    expect(hasActionablePrReviewFeedback(PR126_CLEAN_REVIEW_BODY, "APPROVED")).toBe(false);
  });

  it("still reads the attestation and retires the prior finding", () => {
    expect(extractAllyReviewedHeadSha(PR126_CLEAN_REVIEW_BODY)).toBe(PR126_HEAD);
    expect(extractAllyPriorFindingDispositions(PR126_CLEAN_REVIEW_BODY)).toEqual([
      { shortSha: "da2b878", severity: "important", index: 1, disposition: "fixed", kind: "retires" },
    ]);
    expect(extractAllyReportedFindingRefs(PR126_CLEAN_REVIEW_BODY)).toEqual([]);
  });

  it("resolves to clean/success end to end", () => {
    expect(
      evaluateCommentReviewGate({
        headSha: PR126_HEAD,
        reviewerBotLogin: ALLY_BOT_LOGIN,
        comments: [allyComment(PR126_CLEAN_REVIEW_BODY, "2026-09-14T02:01:11Z")],
      }),
    ).toMatchObject({ state: "success", outcome: "clean" });
  });

  /**
   * The fail-closed half. Skipping the template must cost nothing that
   * actually carries signal, so each of these still blocks with `(0)` buckets
   * present. Without them the change would be a fail-open regression of
   * BLO-29711 rather than a precedence rule.
   */
  it.each([
    ["a counted bucket above zero", "### Critical Issues (1)\n- boom"],
    ["an uncounted findings heading", "### Critical Issues (0)\n### Important Issues\n- boom"],
    ["a decision line", "### Critical Issues (0)\n### Important Issues (0)\ndecision: changes_requested"],
    ["a changes-requested assertion", "### Critical Issues (0)\n### Important Issues (0)\nChanges requested."],
  ])("still blocks on %s", (_label, tail) => {
    const body = `## Ally — Consolidated PR Review\nReviewed head: ${PR126_HEAD}\n\n${tail}\n\n### Recommended Action\n1. No Critical issues to fix before merge`;
    expect(hasActionablePrReviewFeedback(body)).toBe(true);
  });

  it("keeps the template as a last resort when no bucket is counted at all", () => {
    const body = `## Ally — Consolidated PR Review\nReviewed head: ${PR126_HEAD}\n\n### Recommended Action\n1. Fix Critical issues before merge`;
    expect(hasActionablePrReviewFeedback(body)).toBe(true);
  });

  /**
   * A quoted clean review must not disarm a real one. The fence-stripped pass
   * loses the quoted buckets, so the template is consulted there and the OR in
   * hasActionablePrReviewFeedback still blocks.
   */
  it("does not let a fenced quote of zero counts clear a real boilerplate finding", () => {
    const body = [
      "## Ally — Consolidated PR Review",
      `Reviewed head: ${PR126_HEAD}`,
      "",
      "```",
      "### Critical Issues (0)",
      "### Important Issues (0)",
      "```",
      "",
      "### Recommended Action",
      "1. Fix Critical issues before merge",
    ].join("\n");
    expect(hasActionablePrReviewFeedback(body)).toBe(true);
  });
});

/**
 * The producer/consumer heading contract.
 *
 * Every other reader in this file is gated behind `hasAllyConsolidatedReviewHeading`
 * — a body that fails it is not treated as a review at all, so a correct verdict
 * block inside it is never even looked for. That makes the heading the one field
 * where a producer/consumer mismatch is *silent on both sides*: the block parses
 * fine in isolation, and the gate simply never sees the comment.
 *
 * Asserted against the real exported function rather than a transcribed regex.
 * A copy here would be one more prose pattern drifting from its consumer, which
 * is the failure mode this whole row exists to retire.
 */
describe("BLO-32695 — the Step 4 template satisfies the heading the gate requires", () => {
  const agentsDoc = readFileSync(
    fileURLToPath(new URL("../../../.planning/ally-agent/AGENTS.md", import.meta.url)),
    "utf8",
  );

  /** The emitted template itself — the fenced block, not the prose around it. */
  function step4Template(): string {
    const start = agentsDoc.indexOf("### Step 4");
    expect(start).not.toBe(-1);
    const step4 = agentsDoc.slice(start, agentsDoc.indexOf("### Step 5", start));
    const fence = /```markdown\n([\s\S]*?)```/.exec(step4);
    expect(fence, "Step 4 must retain its markdown review template").not.toBeNull();
    return fence![1];
  }

  it("is recognised as an Ally consolidated review", () => {
    expect(hasAllyConsolidatedReviewHeading(step4Template())).toBe(true);
  });

  it("would catch a template that emits only a friendlier title", () => {
    // The regression control. `.planning/ally-agent/AGENTS.md` carried exactly
    // this heading and no canonical one, so a review produced from it would have
    // been invisible to the gate, to the carried-finding ledger and to same-head
    // idempotency. Without this case the assertion above could pass vacuously.
    expect(
      hasAllyConsolidatedReviewHeading("## 🔍 Automated Review — PR #1721 @ bd489d5"),
    ).toBe(false);
  });
});

/**
 * Peer review of #1721 at 11a52e9a, Critical 1 — the unreadable branch was not
 * head-scoped.
 *
 * `newestAllyConsolidatedReviewComment` has no head filter, so a malformed
 * block on a review of head A decided the gate for head B — while the same PR
 * carrying no comments at all resolved `not_evaluated`/success. A stale broken
 * block was strictly worse for an author than no review.
 *
 * The scoping added for it is asymmetric, and these cases pin both sides. Only
 * a review that *positively names some other tree* is exempt. "Cannot tell
 * which head this examined" is an ambiguity, not an exemption, so every case
 * in the fail-closed suite above — a sole review of this head whose verdict is
 * unreadable — stays red. Relaxing that instead would have satisfied the
 * Critical by re-opening AC-5.
 */
describe("BLO-32695 — an unreadable block reds only the head it concerns", () => {
  const HEAD_A = PR1675_HEAD;
  const HEAD_B = "a".repeat(40);

  /** Unreadable — truncated payload — but it still says which tree it read. */
  const brokenNamingHeadA = [
    `<!-- ally-verdict:1 {"head": "${HEAD_A}"`,
    "",
    "## Ally — Consolidated PR Review",
    `Reviewed head: ${HEAD_A}`,
  ].join("\n");

  /** Unreadable *and* silent about its head: the ambiguous case. */
  const brokenNamingNothing = [
    `<!-- ally-verdict:1 {"critical":`,
    "",
    "## Ally — Consolidated PR Review",
  ].join("\n");

  function gateAt(headSha: string, comments: ReturnType<typeof allyComment>[]) {
    return evaluateCommentReviewGate({ headSha, reviewerBotLogin: ALLY_BOT_LOGIN, comments });
  }

  it("positive control: both bodies really are unreadable", () => {
    expect(parseAllyVerdictBlock(brokenNamingHeadA).kind).toBe("unreadable");
    expect(parseAllyVerdictBlock(brokenNamingNothing).kind).toBe("unreadable");
  });

  it("reads the claimed head off a body whose verdict it cannot read", () => {
    // The prose line survives a truncated block, and the block's own `head`
    // field survives every failure that is not a JSON one. Neither is an
    // attestation — extractAllyReviewedHeadSha still refuses — which is the
    // distinction the two functions exist to keep.
    expect(allyClaimedReviewHead(brokenNamingHeadA)).toBe(HEAD_A);
    expect(extractAllyReviewedHeadSha(brokenNamingHeadA)).toBeNull();
    expect(allyClaimedReviewHead(brokenNamingNothing)).toBeNull();
  });

  it("does not red a head the broken review names another tree for", () => {
    // The finding itself. Before the fix this was `failure`/`unreadable_verdict`
    // while the control below was `success`.
    expect(gateAt(HEAD_B, [allyComment(brokenNamingHeadA, "2026-09-07T15:41:42Z")])).toMatchObject({
      state: "success",
      outcome: "not_evaluated",
    });
  });

  it("control: the no-comments case it must not be worse than", () => {
    expect(gateAt(HEAD_B, [])).toMatchObject({ state: "success", outcome: "not_evaluated" });
  });

  it("still reds the head that review does name", () => {
    expect(gateAt(HEAD_A, [allyComment(brokenNamingHeadA, "2026-09-07T15:41:42Z")])).toMatchObject({
      state: "failure",
      outcome: "unreadable_verdict",
    });
  });

  it("fails closed when the broken review names no head at all", () => {
    // AC-5. An unreadable verdict that will not say which tree it examined is
    // the ambiguity the gate must not resolve to success, and it is the shape
    // every case in the fail-closed suite takes.
    expect(gateAt(HEAD_B, [allyComment(brokenNamingNothing, "2026-09-07T15:41:42Z")])).toMatchObject({
      state: "failure",
      outcome: "unreadable_verdict",
    });
  });

  it("still supersedes an older clean review of the same head", () => {
    // The #1675 shape, and the reason the branch is checked first: without it
    // the older clean review stays authoritative and the newest — which may
    // have found something — is invisible.
    const olderClean = [
      "## Ally — Consolidated PR Review",
      `Reviewed head: ${HEAD_A}`,
      "### Critical Issues (0)",
      "### Important Issues (0)",
    ].join("\n");
    expect(
      gateAt(HEAD_A, [
        allyComment(olderClean, "2026-09-07T03:46:19Z"),
        allyComment(brokenNamingHeadA, "2026-09-07T15:41:42Z"),
      ]),
    ).toMatchObject({ state: "failure", outcome: "unreadable_verdict" });
  });

  it("leaves a finding carried from the head it names, rather than masking it", () => {
    // Evaluated at HEAD_B with the broken review naming HEAD_A: the unreadable
    // branch stands down, and the red comes from the carried finding — which
    // names the head an author can act on, where `unreadable_verdict` names
    // none.
    const olderBlocking = [
      "## Ally — Consolidated PR Review",
      `Reviewed head: ${HEAD_A}`,
      "### Important Issues (1)",
      "1. Something unresolved.",
    ].join("\n");
    expect(
      gateAt(HEAD_B, [
        allyComment(olderBlocking, "2026-09-07T03:46:19Z"),
        allyComment(brokenNamingHeadA, "2026-09-07T15:41:42Z"),
      ]),
    ).toMatchObject({ state: "failure", outcome: "carried_finding" });
  });

  it("does not let an OLDER broken block shadow a newer clean review", () => {
    const newerClean = [
      "## Ally — Consolidated PR Review",
      `Reviewed head: ${HEAD_A}`,
      "### Critical Issues (0)",
      "### Important Issues (0)",
    ].join("\n");
    expect(
      gateAt(HEAD_A, [
        allyComment(brokenNamingHeadA, "2026-09-07T03:46:19Z"),
        allyComment(newerClean, "2026-09-07T15:41:42Z"),
      ]),
    ).toMatchObject({ state: "success", outcome: "clean" });
  });
});

/**
 * Peer review of #1721, Important 1 — head disagreement was fatal and count
 * disagreement was not.
 *
 * The counts outrank every prose clause in `hasActionablePrReviewFeedback`, so
 * a block stating zero silently beat an emitted `### Critical Issues (2)` and
 * resolved clean/success: the BLO-29711 direction arriving through the
 * structured path, as a green rather than a red.
 */
describe("BLO-32695 — the block and the prose must not name different counts", () => {
  function body(payload: unknown, ...prose: string[]) {
    return [
      verdictBlock(payload),
      "",
      "## Ally — Consolidated PR Review",
      `Reviewed head: ${PR1675_HEAD}`,
      ...prose,
    ].join("\n");
  }

  const contradicting = body(
    { head: PR1675_HEAD, findings: { critical: 0, important: 0 } },
    "### Critical Issues (2)",
    "1. A real finding.",
  );

  it("fails closed when the block states zero and the prose enumerates a finding", () => {
    expect(parseAllyVerdictBlock(contradicting)).toMatchObject({
      kind: "unreadable",
      reason: expect.stringContaining("critical"),
    });
  });

  it("does not resolve that body to success", () => {
    expect(
      evaluateCommentReviewGate({
        headSha: PR1675_HEAD,
        reviewerBotLogin: ALLY_BOT_LOGIN,
        comments: [allyComment(contradicting, "2026-09-07T15:41:42Z")],
      }).state,
    ).not.toBe("success");
  });

  it("does not report it as a finding: the body's verdict was never read", () => {
    // AC-3. `blocking_finding` must stay reachable only from a counted
    // structured finding — an unreadable block is reported under its own
    // outcome, not attributed to the author as a finding.
    expect(hasActionablePrReviewFeedback(contradicting)).toBe(false);
  });

  it("is asymmetric like the head rule: agreeing zeroes stay readable", () => {
    // The #1675 control. Its own buckets read `(0)`, so this rule never fires
    // on the body the whole row exists for.
    expect(
      parseAllyVerdictBlock(
        body(
          { head: PR1675_HEAD, findings: { critical: 0, important: 0 } },
          "### Critical Issues (0)",
          "### Important Issues (0)",
        ),
      ).kind,
    ).toBe("ok");
  });

  it("is asymmetric like the head rule: absent buckets stay readable", () => {
    expect(
      parseAllyVerdictBlock(body({ head: PR1675_HEAD, findings: { critical: 0, important: 0 } })).kind,
    ).toBe("ok");
  });

  it("does not fire when the block states the finding the prose enumerates", () => {
    const agreeing = body(
      { head: PR1675_HEAD, findings: { critical: 2, important: 0 } },
      "### Critical Issues (2)",
    );
    expect(parseAllyVerdictBlock(agreeing).kind).toBe("ok");
    // And it blocks, through the counted path rather than the prose one.
    expect(hasActionablePrReviewFeedback(agreeing)).toBe(true);
  });

  it("does not fire on a suggestions bucket, which cannot fail open", () => {
    const suggestions = body(
      { head: PR1675_HEAD, findings: { critical: 0, important: 0, suggestions: 0 } },
      "### Suggestions (3)",
    );
    expect(parseAllyVerdictBlock(suggestions).kind).toBe("ok");
  });

  it("ignores a fenced bucket, so a quoted example cannot red a clean block", () => {
    const quoted = body(
      { head: PR1675_HEAD, findings: { critical: 0, important: 0 } },
      "```markdown",
      "### Critical Issues (2)",
      "```",
    );
    expect(parseAllyVerdictBlock(quoted).kind).toBe("ok");
  });

  /**
   * Peer review of #1721, Important 1 — the rule read the unanchored bucket
   * pattern `extractAllyReportedFindingRefs` uses, so a *reference* to some
   * other pass's counts failed a clean review closed. Over-matching here is
   * the false red this row exists to retire, so the cross-check now reads only
   * the emitted heading form.
   */
  it("does not fire on a sentence referencing a prior pass's counts", () => {
    const referencing = body(
      { head: PR1675_HEAD, findings: { critical: 0, important: 0 } },
      "### Critical Issues (0)",
      "### Important Issues (0)",
      "",
      "Both Critical Issues (2) from the previous pass at `abc1234` are fixed.",
    );
    expect(parseAllyVerdictBlock(referencing).kind).toBe("ok");
    // Control: the same body with that sentence replaced by an emitted bucket
    // still fails closed, so the rule was narrowed rather than disabled.
    expect(
      parseAllyVerdictBlock(
        body(
          { head: PR1675_HEAD, findings: { critical: 0, important: 0 } },
          "### Critical Issues (2)",
        ),
      ).kind,
    ).toBe("unreadable");
  });

  it("does not fire on a blockquoted or inline-code bucket", () => {
    // Every sibling pattern in the module carries its own `(?![ \t]*>)`;
    // fencing is not the only way to quote an earlier review.
    for (const quoted of ["> ### Critical Issues (2)", "`### Critical Issues (2)` is what it said"]) {
      expect(
        parseAllyVerdictBlock(
          body({ head: PR1675_HEAD, findings: { critical: 0, important: 0 } }, quoted),
        ).kind,
      ).toBe("ok");
    }
  });

  it("still reads the emphasis Ally wraps its own headings in", () => {
    for (const emitted of ["**Critical Issues (2)**", "### **Critical Issues (2)**"]) {
      expect(
        parseAllyVerdictBlock(
          body({ head: PR1675_HEAD, findings: { critical: 0, important: 0 } }, emitted),
        ).kind,
      ).toBe("unreadable");
    }
  });
});

/**
 * Peer review of #1721, Critical 1 — `allyClaimedReviewHead` answered with the
 * *first* head it found, but two of the parse's `unreadable` reasons are
 * literally "this body makes more than one head claim". First-wins invented an
 * answer the parse had declined to give, the head-scoping branch stood down at
 * the evaluated head, and an older clean review became authoritative over a
 * newer review carrying a structured Critical — #1675 in the fail-open
 * direction.
 */
describe("BLO-32695 — a body making two head claims claims neither", () => {
  const HEAD_A = PR1675_HEAD;
  const HEAD_B = "b".repeat(40);

  const olderCleanB = [
    "## Ally — Consolidated PR Review",
    `Reviewed head: ${HEAD_B}`,
    "### Critical Issues (0)",
    "### Important Issues (0)",
  ].join("\n");

  /** Block says HEAD_A and carries a Critical; the prose says HEAD_B. */
  const blockVsProse = [
    verdictBlock({ head: HEAD_A, findings: { critical: 1, important: 0 } }),
    "",
    "## Ally — Consolidated PR Review",
    `Reviewed head: ${HEAD_B}`,
  ].join("\n");

  /** AC-5's literal case: two blocks, two heads. */
  const twoBlocks = [
    verdictBlock({ head: HEAD_A, findings: { critical: 0, important: 0 } }),
    verdictBlock({ head: HEAD_B, findings: { critical: 1, important: 0 } }),
    "",
    "## Ally — Consolidated PR Review",
  ].join("\n");

  it("positive control: both bodies really are unreadable", () => {
    expect(parseAllyVerdictBlock(blockVsProse).kind).toBe("unreadable");
    expect(parseAllyVerdictBlock(twoBlocks).kind).toBe("unreadable");
  });

  it("claims no head at all", () => {
    expect(allyClaimedReviewHead(blockVsProse)).toBeNull();
    expect(allyClaimedReviewHead(twoBlocks)).toBeNull();
  });

  it("does not let an older clean review outrank it", () => {
    // The finding. Before the fix both of these resolved to success/clean off
    // the older review, while the newest review of that head states a Critical.
    for (const disagreeing of [blockVsProse, twoBlocks]) {
      expect(
        evaluateCommentReviewGate({
          headSha: HEAD_B,
          reviewerBotLogin: ALLY_BOT_LOGIN,
          comments: [
            allyComment(olderCleanB, "2026-09-07T03:46:19Z"),
            allyComment(disagreeing, "2026-09-07T15:41:42Z"),
          ],
        }),
      ).toMatchObject({ state: "failure", outcome: "unreadable_verdict" });
    }
  });

  it("reds the unrelated head too, which is the cost of the rule", () => {
    // Stated rather than buried: a body that will not say which tree it
    // examined might have examined this one, so it reds every head — the same
    // rule `brokenNamingNothing` already applies, and the trade this fix makes
    // against the head-scoping it narrows.
    expect(
      evaluateCommentReviewGate({
        headSha: "c".repeat(40),
        reviewerBotLogin: ALLY_BOT_LOGIN,
        comments: [allyComment(blockVsProse, "2026-09-07T15:41:42Z")],
      }),
    ).toMatchObject({ state: "failure", outcome: "unreadable_verdict" });
  });

  it("control: a body whose claims agree still names its head", () => {
    const agreeing = [
      verdictBlock({ head: HEAD_A, findings: { critical: 0 } }),
      "",
      "## Ally — Consolidated PR Review",
      `Reviewed head: ${HEAD_A}`,
    ].join("\n");
    expect(parseAllyVerdictBlock(agreeing).kind).toBe("unreadable");
    expect(allyClaimedReviewHead(agreeing)).toBe(HEAD_A);
  });
});

/**
 * Peer review of #1721, Important 2 — the opener guard only covered a missing
 * `-->`, so the four likeliest prefix drifts missed both patterns and read
 * `absent`, silently degrading to the prose path this row retires.
 *
 * The producer is a model transcribing a template out of a fenced markdown
 * example. Pretty-printing a space after the colon is the likeliest single
 * drift there is; `v1` is the second. The opener is now version-agnostic, so
 * the strict block pattern stays the only reader of the version and every way
 * of garbling it lands on `openers > blocks`.
 */
describe("BLO-32695 — prefix drift fails closed rather than vanishing", () => {
  const prose = [
    "",
    "## Ally — Consolidated PR Review",
    `Reviewed head: ${PR1675_HEAD}`,
    "### Critical Issues (0)",
    "### Important Issues (0)",
  ].join("\n");

  const payload = JSON.stringify(PR1675_VERDICT, null, 2);

  it("reads a space after the colon as the block it plainly is", () => {
    const spaced = `<!-- ally-verdict: 1\n${payload}\n-->${prose}`;
    expect(parseAllyVerdictBlock(spaced)).toMatchObject({ kind: "ok" });
    expect(extractAllyReviewedHeadSha(spaced)).toBe(PR1675_HEAD);
  });

  it.each([
    ["a `v`-prefixed version", `<!-- ally-verdict:v1\n${payload}\n-->`],
    ["no version at all", `<!-- ally-verdict {"head": "${PR1675_HEAD}"}\n-->`],
  ])("fails closed on %s rather than falling through to prose", (_label, opener) => {
    // Before the fix each of these matched neither pattern, read `absent`, and
    // cleared the gate off the very prose the block exists to stop trusting.
    expect(parseAllyVerdictBlock(`${opener}${prose}`).kind).toBe("unreadable");
    expect(
      evaluateCommentReviewGate({
        headSha: PR1675_HEAD,
        reviewerBotLogin: ALLY_BOT_LOGIN,
        comments: [
          allyComment(`${opener}${prose}`, "2026-09-07T15:41:42Z"),
          // Shadowed, so the unreadable branch is reachable at all — see the
          // head-scoping suite above.
          allyComment(`## Ally — Consolidated PR Review\nReviewed head: ${PR1675_HEAD}\n### Critical Issues (0)`, "2026-09-07T03:46:19Z"),
        ],
      }).state,
    ).not.toBe("success");
  });

  it("reads a zero-padded version, so the three readers cannot split on it", () => {
    // Suggestion 1 of the same review: the Python sweep compared the version
    // as a string while both JS readers use Number(), so `:01` was readable
    // here and unreadable there — and the sweep would then re-request a review
    // that had already happened. Pinned on both sides.
    const padded = `<!-- ally-verdict:01\n${payload}\n-->${prose}`;
    expect(parseAllyVerdictBlock(padded)).toMatchObject({ kind: "ok" });
  });

  it("keeps the line anchor: an inline marker is still absent, not an opener", () => {
    // Deliberate and unchanged. Un-anchoring would let a review *of this file*
    // mint a phantom opener out of a quoted marker and wedge its own gate,
    // which is the worse of the two failures.
    expect(parseAllyVerdictBlock(`see <!-- ally-verdict:1 mid-line${prose}`)).toEqual({
      kind: "absent",
    });
  });

  it("still counts the emitter's own exact form as one block, not two", () => {
    expect(parseAllyVerdictBlock(`${verdictBlock(PR1675_VERDICT)}${prose}`).kind).toBe("ok");
  });
});
