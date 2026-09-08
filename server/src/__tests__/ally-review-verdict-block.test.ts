import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  extractAllyPriorFindingDispositions,
  extractAllyReportedFindingRefs,
  extractAllyReviewedHeadSha,
  hasActionablePrReviewFeedback,
  hasAllyConsolidatedReviewHeading,
  parseAllyVerdictBlock,
} from "../services/ally-review-detection.js";
import { evaluateCommentReviewGate } from "../services/pr-comment-review-gate.js";

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
      name: "a disposition missing its index",
      body: `${verdictBlock({
        head: PR1675_HEAD,
        findings: {},
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
