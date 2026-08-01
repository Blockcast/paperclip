import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  attestedHead,
  findPrViolations,
  findViolations,
  hasBlockingFindings,
  isAllyLogin,
  operativeAllyReviews,
} from "./check-ally-review-consistency.mjs";

const HEAD = "ff1c72dbfd18014c838cf1373b1640dd17378f3e";
const OTHER = "b3a240ec8c0108eab7e60c36a5a328c00b3a984d";

function review(overrides = {}) {
  return {
    id: 1,
    state: "COMMENTED",
    commit_id: HEAD,
    user: { login: "allyblockcast[bot]" },
    body: `## Ally — Consolidated PR Review\nReviewed head: ${HEAD}\n`,
    ...overrides,
  };
}

describe("isAllyLogin", () => {
  for (const login of [
    "allyblockcast",
    "allyblockcast[bot]",
    "blockcast-ally",
    "ally-bot[bot]",
    "blockcast-ci-packages",
  ]) {
    it(`recognises ${login}`, () => assert.equal(isAllyLogin(login), true));
  }

  for (const login of ["kkroo", "dependabot[bot]", "", undefined, "notallyblockcast"]) {
    it(`rejects ${String(login)}`, () => assert.equal(isAllyLogin(login), false));
  }
});

describe("hasBlockingFindings", () => {
  it("fires on a non-zero Important section", () => {
    assert.equal(hasBlockingFindings("### Important Issues (1)"), true);
  });

  it("fires on a non-zero Critical section", () => {
    assert.equal(hasBlockingFindings("### Critical Issues (3)"), true);
  });

  it("fires on a two-digit count", () => {
    assert.equal(hasBlockingFindings("### Important Issues (10)"), true);
  });

  it("does NOT fire on an explicitly empty section", () => {
    assert.equal(
      hasBlockingFindings("### Critical Issues (0)\n### Important Issues (0)"),
      false,
    );
  });

  it("fires when only one of the two sections is non-empty", () => {
    assert.equal(
      hasBlockingFindings("### Critical Issues (0)\n### Important Issues (1)"),
      true,
    );
  });

  it("does NOT fire on Suggestions, however many", () => {
    assert.equal(hasBlockingFindings("### Suggestions (4)"), false);
  });

  it("does NOT fire on the word 'important' in prose", () => {
    assert.equal(
      hasBlockingFindings("This is an important consideration (0) worth noting"),
      false,
    );
  });
});

describe("attestedHead", () => {
  it("extracts the standalone attestation line", () => {
    assert.equal(attestedHead(`Reviewed head: ${HEAD}`), HEAD);
  });

  it("tolerates backticks and emphasis", () => {
    assert.equal(attestedHead(`_Reviewed head: \`${HEAD}\`_`), HEAD);
  });

  it("returns null when no attestation is present", () => {
    assert.equal(attestedHead("## Ally — Consolidated PR Review"), null);
  });

  it("ignores a SHA mentioned mid-sentence", () => {
    assert.equal(attestedHead(`I reviewed head: ${HEAD} earlier today`), null);
  });
});

describe("operativeAllyReviews", () => {
  it("excludes DISMISSED — a dismissed review is disposed, not standing", () => {
    const reviews = [review({ id: 1, state: "DISMISSED" }), review({ id: 2 })];
    assert.deepEqual(
      operativeAllyReviews(reviews, HEAD).map((r) => r.id),
      [2],
    );
  });

  it("excludes reviews attached to a different commit", () => {
    const reviews = [review({ id: 1, commit_id: OTHER }), review({ id: 2 })];
    assert.deepEqual(
      operativeAllyReviews(reviews, HEAD).map((r) => r.id),
      [2],
    );
  });

  it("excludes non-Ally reviewers", () => {
    const reviews = [review({ id: 1, user: { login: "kkroo" } }), review({ id: 2 })];
    assert.deepEqual(
      operativeAllyReviews(reviews, HEAD).map((r) => r.id),
      [2],
    );
  });
});

describe("findPrViolations", () => {
  it("passes a sound PR: exactly one operative verdict attesting its own head", () => {
    const pr = { number: 1, headSha: HEAD, reviews: [review({ id: 1, state: "APPROVED" })] };
    assert.deepEqual(findPrViolations(pr), []);
  });

  // The exact shape of Blockcast/paperclip#876 at 13:53:24Z (BLO-19778).
  it("I1+I2b: catches a same-SHA APPROVED masking a blocking COMMENTED review", () => {
    const pr = {
      number: 876,
      headSha: HEAD,
      reviews: [
        review({
          id: 4829069732,
          state: "APPROVED",
          user: { login: "allyblockcast" },
          body: `## Ally — Consolidated PR Review\nReviewed head: ${HEAD}\n\n### Suggestions (4)\n\nNo blockers. Approving.`,
        }),
        review({
          id: 4829074303,
          state: "COMMENTED",
          body: `## Ally — Consolidated PR Review\nReviewed head: ${HEAD}\n\n### Important Issues (1)\n\nClose before merge.`,
        }),
      ],
    };
    const violations = findPrViolations(pr);
    assert.equal(violations.length, 2);
    assert.match(violations[0], /^I1 PR #876 @ff1c72db: 2 operative Ally verdicts/);
    assert.match(violations[1], /^I2b PR #876 @ff1c72db: standing APPROVED \(4829069732\)/);
  });

  it("I2a: catches an APPROVED whose own body reports an Important finding", () => {
    const pr = {
      number: 2,
      headSha: HEAD,
      reviews: [
        review({
          id: 7,
          state: "APPROVED",
          body: `Reviewed head: ${HEAD}\n### Important Issues (2)`,
        }),
      ],
    };
    const violations = findPrViolations(pr);
    assert.equal(violations.length, 1);
    assert.match(violations[0], /^I2a PR #2 @ff1c72db: review 7 is APPROVED/);
  });

  // The exact shape of Blockcast/paperclip#870 review 4830097206.
  it("I3: catches a review whose attested head differs from its recorded commit", () => {
    const pr = {
      number: 870,
      headSha: HEAD,
      reviews: [
        review({
          id: 4830097206,
          state: "APPROVED",
          body: `## Ally — Consolidated PR Review\nReviewed head: ${OTHER}\n`,
        }),
      ],
    };
    const violations = findPrViolations(pr);
    assert.equal(violations.length, 1);
    assert.match(
      violations[0],
      /^I3 PR #870 @ff1c72db: review 4830097206 attests head b3a240ec/,
    );
  });

  it("dismissing the stale approval clears the #876 violation", () => {
    const pr = {
      number: 876,
      headSha: HEAD,
      reviews: [
        review({ id: 4829069732, state: "DISMISSED", user: { login: "allyblockcast" } }),
        review({
          id: 4829074303,
          state: "COMMENTED",
          body: `Reviewed head: ${HEAD}\n### Important Issues (1)`,
        }),
      ],
    };
    assert.deepEqual(findPrViolations(pr), []);
  });

  it("a blocking review alone is not a violation", () => {
    const pr = {
      number: 3,
      headSha: HEAD,
      reviews: [
        review({ id: 9, body: `Reviewed head: ${HEAD}\n### Important Issues (1)` }),
      ],
    };
    assert.deepEqual(findPrViolations(pr), []);
  });

  it("a human APPROVED alongside a blocking Ally review is not an Ally violation", () => {
    const pr = {
      number: 4,
      headSha: HEAD,
      reviews: [
        review({ id: 10, state: "APPROVED", user: { login: "kkroo" } }),
        review({ id: 11, body: `Reviewed head: ${HEAD}\n### Important Issues (1)` }),
      ],
    };
    assert.deepEqual(findPrViolations(pr), []);
  });
});

describe("findViolations", () => {
  it("aggregates across PRs and returns empty for a sound fleet", () => {
    const sound = { number: 1, headSha: HEAD, reviews: [review({ id: 1, state: "APPROVED" })] };
    const broken = {
      number: 2,
      headSha: HEAD,
      reviews: [
        review({ id: 2, state: "APPROVED", user: { login: "allyblockcast" } }),
        review({ id: 3, body: `Reviewed head: ${HEAD}\n### Critical Issues (1)` }),
      ],
    };
    assert.deepEqual(findViolations([sound]), []);
    assert.equal(findViolations([sound, broken]).length, 2);
  });

  it("tolerates an empty PR list", () => {
    assert.deepEqual(findViolations([]), []);
  });
});
