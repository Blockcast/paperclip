import assert from "node:assert/strict";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";

import {
  assertPrListComplete,
  attestedHead,
  distinctVerdicts,
  duplicateCredentialSubmissions,
  findAdvisories,
  findPrAdvisories,
  findPrViolations,
  findViolations,
  hasBlockingFindings,
  hasStillPresentDisposition,
  isAllyLogin,
  isMainModule,
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

const ALLY_APP_USER_ID = 290875700;
const ALLY_APPROVAL_SEAT_USER_ID = 296676656;

function dualCredentialPair(body) {
  return [
    review({
      id: 11,
      state: "APPROVED",
      body,
      user: { login: "allyblockcast[bot]", id: ALLY_APP_USER_ID },
    }),
    review({
      id: 12,
      state: "APPROVED",
      body,
      user: { login: "allyblockcast", id: ALLY_APPROVAL_SEAT_USER_ID },
    }),
  ];
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

describe("hasStillPresentDisposition", () => {
  it("fires on a prior finding marked still-present", () => {
    assert.equal(
      hasStillPresentDisposition(
        "- **prior:354d5b9 important 1** — still-present — the issue remains",
      ),
      true,
    );
  });

  it("does NOT fire on fixed prior findings or prose", () => {
    assert.equal(
      hasStillPresentDisposition(
        "- **prior:354d5b9 important 1** — fixed — the issue is closed\nstill-present in quoted prose",
      ),
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

  it("I2c: catches an APPROVED whose prior finding disposition is still-present", () => {
    const pr = {
      number: 5,
      headSha: HEAD,
      reviews: [
        review({
          id: 12,
          state: "APPROVED",
          body: `Reviewed head: ${HEAD}\n### Prior Findings Dispositioned (1)\n- **prior:354d5b9 important 1** — still-present — not mirrored below`,
        }),
      ],
    };
    const violations = findPrViolations(pr);
    assert.equal(violations.length, 1);
    assert.match(violations[0], /^I2c PR #5 @ff1c72db: review 12 is APPROVED/);
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

describe("dual-credential double-submit reconciliation", () => {
  const body = `## Ally — Consolidated PR Review\nReviewed head: ${HEAD}\n\nNo blockers.`;

  it("reports exactly the known same-attestation App/User-seat pair as an advisory", () => {
    const reviews = dualCredentialPair(body);
    const pr = { number: 1141, headSha: HEAD, reviews };

    assert.deepEqual(
      duplicateCredentialSubmissions(reviews, HEAD).map((group) =>
        group.map((review) => review.id),
      ),
      [[11, 12]],
    );
    assert.deepEqual(distinctVerdicts(reviews, HEAD).map((review) => review.id), [11]);
    assert.deepEqual(findPrViolations(pr), []);

    const advisories = findPrAdvisories(pr);
    assert.equal(advisories.length, 1);
    assert.match(advisories[0], /^A1 PR #1141 @ff1c72db: one attested verdict submitted twice/);
  });

  it("keeps an otherwise identical third submission visible to I1", () => {
    const reviews = [
      ...dualCredentialPair(body),
      review({
        id: 13,
        state: "APPROVED",
        body,
        user: { login: "allyblockcast", id: 999999999 },
      }),
    ];
    const violations = findPrViolations({ number: 1142, headSha: HEAD, reviews });

    assert.deepEqual(duplicateCredentialSubmissions(reviews, HEAD), []);
    assert.deepEqual(distinctVerdicts(reviews, HEAD).map((review) => review.id), [11, 12, 13]);
    assert.match(violations.find((violation) => violation.startsWith("I1")) ?? "", /3 operative Ally verdicts/);
  });

  it("keeps a missing credential identity visible to I1", () => {
    const [app, seat] = dualCredentialPair(body);
    const reviews = [app, { ...seat, user: { login: "allyblockcast" } }];
    const violations = findPrViolations({ number: 1143, headSha: HEAD, reviews });

    assert.deepEqual(duplicateCredentialSubmissions(reviews, HEAD), []);
    assert.match(violations.find((violation) => violation.startsWith("I1")) ?? "", /2 operative Ally verdicts/);
  });

  it("keeps an unexpected credential identity paired with the App visible to I1", () => {
    const [app, seat] = dualCredentialPair(body);
    const reviews = [
      app,
      { ...seat, user: { login: "allyblockcast", id: 999999999 } },
    ];
    const violations = findPrViolations({ number: 11435, headSha: HEAD, reviews });

    assert.deepEqual(duplicateCredentialSubmissions(reviews, HEAD), []);
    assert.match(violations.find((violation) => violation.startsWith("I1")) ?? "", /2 operative Ally verdicts/);
  });

  it("keeps a same-account retry visible to I1", () => {
    const [app, seat] = dualCredentialPair(body);
    const reviews = [app, { ...seat, user: app.user }];
    const violations = findPrViolations({ number: 11436, headSha: HEAD, reviews });

    assert.deepEqual(duplicateCredentialSubmissions(reviews, HEAD), []);
    assert.match(violations.find((violation) => violation.startsWith("I1")) ?? "", /2 operative Ally verdicts/);
  });

  it("keeps a cross-credential state conflict visible to I1", () => {
    const [app, seat] = dualCredentialPair(body);
    const reviews = [app, { ...seat, state: "COMMENTED" }];
    const violations = findPrViolations({ number: 1144, headSha: HEAD, reviews });

    assert.deepEqual(duplicateCredentialSubmissions(reviews, HEAD), []);
    assert.match(violations.find((violation) => violation.startsWith("I1")) ?? "", /2 operative Ally verdicts/);
  });

  it("keeps a same-body stale-attestation conflict fatal", () => {
    const staleBody = `## Ally — Consolidated PR Review\nReviewed head: ${OTHER}\n\nNo blockers.`;
    const reviews = dualCredentialPair(staleBody);
    const violations = findPrViolations({ number: 1145, headSha: HEAD, reviews });

    assert.deepEqual(duplicateCredentialSubmissions(reviews, HEAD), []);
    assert.match(violations.find((violation) => violation.startsWith("I1")) ?? "", /2 operative Ally verdicts/);
    assert.equal(violations.filter((violation) => violation.startsWith("I3")).length, 2);
  });

  it("keeps an ambiguous multi-attestation body visible to I1", () => {
    const ambiguousBody = `Reviewed head: ${HEAD}\nReviewed head: ${HEAD}`;
    const reviews = dualCredentialPair(ambiguousBody);
    const violations = findPrViolations({ number: 1146, headSha: HEAD, reviews });

    assert.deepEqual(duplicateCredentialSubmissions(reviews, HEAD), []);
    assert.match(violations.find((violation) => violation.startsWith("I1")) ?? "", /2 operative Ally verdicts/);
  });

  it("keeps distinct current-head attestation bodies visible to I1", () => {
    const [app, seat] = dualCredentialPair(body);
    const reviews = [app, { ...seat, body: `${body}\n### Suggestions (1)\n- another pass` }];
    const violations = findPrViolations({ number: 1147, headSha: HEAD, reviews });

    assert.deepEqual(duplicateCredentialSubmissions(reviews, HEAD), []);
    assert.match(violations.find((violation) => violation.startsWith("I1")) ?? "", /2 operative Ally verdicts/);
  });
});

describe("findAdvisories", () => {
  const body = `Reviewed head: ${HEAD}`;

  it("aggregates only verified dual-credential submissions across PRs", () => {
    const advisories = findAdvisories([
      { number: 1148, headSha: HEAD, reviews: dualCredentialPair(body) },
      { number: 1149, headSha: HEAD, reviews: dualCredentialPair(body) },
    ]);

    assert.equal(advisories.length, 2);
    assert.match(advisories[0], /PR #1148/);
    assert.match(advisories[1], /PR #1149/);
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

describe("isMainModule", () => {
  it("matches file URLs for paths containing spaces", () => {
    const scriptPath = resolve("/tmp/ally space/check-ally-review-consistency.mjs");
    assert.equal(isMainModule(scriptPath, pathToFileURL(scriptPath).href), true);
  });

  it("does not match a different argv path", () => {
    const scriptPath = resolve("/tmp/ally space/check-ally-review-consistency.mjs");
    assert.equal(isMainModule("/tmp/other-script.mjs", pathToFileURL(scriptPath).href), false);
  });
});

describe("assertPrListComplete", () => {
  it("passes a list comfortably under the limit", () => {
    const rows = [{ number: 1 }, { number: 2 }];
    assert.equal(assertPrListComplete(rows, "o/r", 10), rows);
  });

  it("throws when the returned count reaches the limit, rather than passing silently", () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ number: i }));
    assert.throws(() => assertPrListComplete(rows, "o/r", 10), /probably truncated/);
  });

  it("tolerates a nullish list", () => {
    assert.doesNotThrow(() => assertPrListComplete(undefined, "o/r", 10));
  });
});
