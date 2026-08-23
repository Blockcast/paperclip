import assert from "node:assert/strict";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";

import {
  ALLY_APP_REVIEWER_ID,
  ALLY_APP_REVIEWER_LOGIN,
  ALLY_USER_REVIEWER_ID,
  ALLY_USER_REVIEWER_LOGIN,
  allyReviewLane,
  assertHeadSha,
  assertPrListComplete,
  attestedHead,
  duplicateBodyAcrossIdentities,
  findPrViolations,
  findViolations,
  hasBlockingFindings,
  hasStillPresentDisposition,
  isAllyAppLogin,
  isAllyAppReviewer,
  isAllyLogin,
  isAllySeatLogin,
  isAllySeatReviewer,
  isMainModule,
  isRequiredApprovalPair,
  operativeAllyReviews,
} from "./check-ally-review-consistency.mjs";

const HEAD = "ff1c72dbfd18014c838cf1373b1640dd17378f3e";
const OTHER = "b3a240ec8c0108eab7e60c36a5a328c00b3a984d";

function review(overrides = {}) {
  return {
    id: 1,
    state: "APPROVED",
    commit_id: HEAD,
    user: { login: "allyblockcast[bot]", id: ALLY_APP_REVIEWER_ID, type: "Bot" },
    body: canonicalBody(),
    ...overrides,
  };
}

function canonicalBody(head = HEAD, extra = "") {
  return `## Ally — Consolidated PR Review\nReviewed head: ${head}\n${extra}`;
}

function appReview(overrides = {}) {
  return review({ user: { login: "allyblockcast[bot]", id: ALLY_APP_REVIEWER_ID, type: "Bot" }, ...overrides });
}

function seatReview(overrides = {}) {
  return review({ user: { login: "allyblockcast", id: ALLY_USER_REVIEWER_ID, type: "User" }, ...overrides });
}

describe("isAllyLogin", () => {
  for (const login of ["allyblockcast", "allyblockcast[bot]", "app/allyblockcast"]) {
    it(`recognises ${login}`, () => assert.equal(isAllyLogin(login), true));
  }

  for (const login of [
    "kkroo",
    "dependabot[bot]",
    "blockcast-ally",
    "ally-bot[bot]",
    "blockcast-ci-packages",
    "",
    undefined,
    "notallyblockcast",
  ]) {
    it(`rejects ${String(login)}`, () => assert.equal(isAllyLogin(login), false));
  }
});

describe("Ally review lanes", () => {
  it("keeps the App and User seat identities distinct", () => {
    assert.equal(isAllyAppLogin("allyblockcast[bot]"), true);
    assert.equal(isAllyAppLogin("app/allyblockcast"), true);
    assert.equal(isAllyAppLogin("allyblockcast"), false);
    assert.equal(isAllySeatLogin("allyblockcast"), true);
    assert.equal(isAllySeatLogin("allyblockcast[bot]"), false);
    assert.equal(isAllyAppReviewer({ login: "allyblockcast[bot]", id: ALLY_APP_REVIEWER_ID, type: "Bot" }), true);
    assert.equal(isAllySeatReviewer({ login: "allyblockcast", id: ALLY_USER_REVIEWER_ID, type: "User" }), true);
    assert.equal(allyReviewLane({ login: "allyblockcast[bot]", id: ALLY_APP_REVIEWER_ID, type: "Bot" }), "app");
    assert.equal(allyReviewLane({ login: "allyblockcast", id: ALLY_USER_REVIEWER_ID, type: "User" }), "seat");
  });

  it("rejects opposite GitHub account types even when the login matches", () => {
    assert.equal(isAllyAppReviewer({ login: "allyblockcast[bot]", id: ALLY_APP_REVIEWER_ID, type: "User" }), false);
    assert.equal(isAllySeatReviewer({ login: "allyblockcast", id: ALLY_USER_REVIEWER_ID, type: "Bot" }), false);
    assert.equal(allyReviewLane({ login: "allyblockcast[bot]", id: ALLY_APP_REVIEWER_ID, type: "User" }), null);
    assert.equal(allyReviewLane({ login: "allyblockcast", id: ALLY_USER_REVIEWER_ID, type: "Bot" }), null);
    assert.equal(allyReviewLane({ login: "allyblockcast[bot]" }), null);
  });

  it("requires the immutable REST ID for each canonical reviewer", () => {
    assert.equal(isAllyAppReviewer({ login: "allyblockcast[bot]", id: 42, type: "Bot" }), false);
    assert.equal(isAllySeatReviewer({ login: "allyblockcast", id: 42, type: "User" }), false);
    assert.equal(allyReviewLane({ login: "allyblockcast[bot]", id: 42, type: "Bot" }), null);
    assert.equal(allyReviewLane({ login: "allyblockcast", id: 42, type: "User" }), null);
  });
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

  it("filters independent App and User-seat lanes", () => {
    const reviews = [appReview({ id: 1 }), seatReview({ id: 2 })];
    assert.deepEqual(operativeAllyReviews(reviews, HEAD, "app").map((r) => r.id), [1]);
    assert.deepEqual(operativeAllyReviews(reviews, HEAD, "seat").map((r) => r.id), [2]);
  });

  it("does not count matching logins with the opposite GitHub account type", () => {
    const reviews = [
      appReview({ id: 1, user: { login: "allyblockcast[bot]", type: "User" } }),
      seatReview({ id: 2, user: { login: "allyblockcast", type: "Bot" } }),
    ];
    assert.deepEqual(operativeAllyReviews(reviews, HEAD), []);
  });
});

describe("findPrViolations", () => {
  it("allows a canonical App review and a plain exact-head User-seat approval", () => {
    const pr = {
      number: 1,
      headSha: HEAD,
      reviews: [appReview({ id: 1 }), seatReview({ id: 2, body: "Approved after reviewing this change." })],
    };
    assert.deepEqual(findPrViolations(pr), []);
  });

  it("rejects duplicate operative reviews independently in the App and User-seat lanes", () => {
    const pr = {
      number: 876,
      headSha: HEAD,
      reviews: [
        appReview({ id: 1 }),
        appReview({ id: 2 }),
        seatReview({ id: 3 }),
        seatReview({ id: 4 }),
      ],
    };
    const violations = findPrViolations(pr);
    assert.equal(violations.length, 2);
    assert.match(violations[0], /^I1 PR #876 @ff1c72db: 2 operative Ally App reviews/);
    assert.match(violations[1], /^I1 PR #876 @ff1c72db: 2 operative Ally User seat reviews/);
  });

  it("I2a: catches an APPROVED whose own body reports an Important finding", () => {
    const pr = {
      number: 2,
      headSha: HEAD,
      reviews: [
        appReview({
          id: 7,
          state: "APPROVED",
          body: canonicalBody(HEAD, "\n### Important Issues (2)"),
        }),
      ],
    };
    const violations = findPrViolations(pr);
    assert.equal(violations.length, 1);
    assert.match(violations[0], /^I2a PR #2 @ff1c72db: Ally App review 7 is APPROVED/);
  });

  it("I2c: catches an APPROVED whose prior finding disposition is still-present", () => {
    const pr = {
      number: 5,
      headSha: HEAD,
      reviews: [
        appReview({
          id: 12,
          state: "APPROVED",
          body: canonicalBody(
            HEAD,
            "\n### Prior Findings Dispositioned (1)\n- **prior:354d5b9 important 1** — still-present — not mirrored below",
          ),
        }),
      ],
    };
    const violations = findPrViolations(pr);
    assert.equal(violations.length, 1);
    assert.match(violations[0], /^I2c PR #5 @ff1c72db: Ally App review 12 is APPROVED/);
  });

  it("I3: validates the App attestation while GitHub's exact review commit establishes the User-seat head", () => {
    const pr = {
      number: 870,
      headSha: HEAD,
      reviews: [
        appReview({
          id: 4830097206,
          body: canonicalBody(OTHER),
        }),
        seatReview({
          id: 4830097207,
          body: `Approved at exact head ${OTHER}.`,
        }),
      ],
    };
    const violations = findPrViolations(pr);
    assert.equal(violations.length, 1);
    assert.match(
      violations[0],
      /^I3 PR #870 @ff1c72db: Ally App review 4830097206 attests head b3a240ec/,
    );
  });

  it("rejects a clean App COMMENTED pass for an independently authored PR", () => {
    const pr = {
      number: 1146,
      headSha: HEAD,
      reviews: [
        appReview({
          id: 4888334884,
          state: "COMMENTED",
          body: canonicalBody(HEAD, "\nally-verdict: pass"),
        }),
        seatReview({
          id: 4888299747,
          state: "APPROVED",
          body: "Approved after an independent review.",
        }),
      ],
    };
    const violations = findPrViolations(pr);
    assert.deepEqual(violations, [
      "I4 PR #1146 @ff1c72db: Ally App review 4888334884 is COMMENTED but clean App evidence must be APPROVED",
    ]);
  });

  it("allows a clean canonical App COMMENTED self-review for an App-authored PR", () => {
    const pr = {
      number: 984,
      author: { login: "app/allyblockcast", is_bot: true },
      headSha: HEAD,
      reviews: [
        appReview({
          id: 9841,
          state: "COMMENTED",
          body: canonicalBody(HEAD),
        }),
        seatReview({ id: 9842, body: "Approved after an independent review." }),
      ],
    };
    assert.deepEqual(findPrViolations(pr), []);
  });

  it("requires the User-seat lane itself to be a formal approval", () => {
    const pr = {
      number: 1147,
      headSha: HEAD,
      reviews: [
        appReview({ id: 1 }),
        seatReview({
          id: 2,
          state: "COMMENTED",
          body: canonicalBody(HEAD, "\n### Important Issues (1)"),
        }),
      ],
    };
    assert.deepEqual(findPrViolations(pr), [
      "I4 PR #1147 @ff1c72db: Ally User seat review 2 is COMMENTED but User-seat evidence must be APPROVED",
    ]);
  });

  it("does not let a User-seat approval mask a blocking App review", () => {
    const pr = {
      number: 876,
      headSha: HEAD,
      reviews: [
        appReview({
          id: 4829074303,
          state: "COMMENTED",
          body: canonicalBody(HEAD, "\n### Important Issues (1)\n\nClose before merge."),
        }),
        seatReview({ id: 4829069732, body: "Approved after a separate review." }),
      ],
    };
    const violations = findPrViolations(pr);
    assert.deepEqual(violations, [
      "I2b PR #876 @ff1c72db: User-seat APPROVED (4829069732) coexists with a blocking Ally App review (4829074303) — the User seat cannot mask the App blocker",
    ]);
  });

  it("excludes dismissed stale reviews from both lanes", () => {
    const pr = {
      number: 876,
      headSha: HEAD,
      reviews: [
        appReview({ id: 1, state: "DISMISSED", body: canonicalBody(OTHER) }),
        seatReview({ id: 2, state: "DISMISSED", body: canonicalBody(OTHER) }),
        appReview({ id: 3 }),
        seatReview({ id: 4, body: "Approved after an independent review." }),
      ],
    };
    assert.deepEqual(findPrViolations(pr), []);
  });

  it("keeps an App blocker without a User-seat approval as a non-passing review state", () => {
    const pr = {
      number: 3,
      headSha: HEAD,
      reviews: [
        appReview({
          id: 9,
          state: "COMMENTED",
          body: canonicalBody(HEAD, "\n### Important Issues (1)"),
        }),
      ],
    };
    assert.deepEqual(findPrViolations(pr), []);
  });

  it("does not treat an unrelated human approval as Ally evidence", () => {
    const pr = {
      number: 4,
      headSha: HEAD,
      reviews: [
        review({ id: 10, user: { login: "kkroo" } }),
        appReview({ id: 11, state: "COMMENTED", body: canonicalBody(HEAD, "\n### Important Issues (1)") }),
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
        seatReview({ id: 2 }),
        appReview({ id: 3, state: "COMMENTED", body: canonicalBody(HEAD, "\n### Critical Issues (1)") }),
      ],
    };
    assert.deepEqual(findViolations([sound]), []);
    assert.equal(findViolations([sound, broken]).length, 1);
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

/** The mandated two-principal protected-merge shape. */
function requiredApprovalPair(app = {}, user = {}) {
  return [
    {
      ...review({
        id: 11,
        state: "APPROVED",
        body: `## Ally — Consolidated PR Review\nReviewed head: ${HEAD}\n\nApp artifact.`,
      }),
      user: { login: ALLY_APP_REVIEWER_LOGIN, id: ALLY_APP_REVIEWER_ID, type: "Bot" },
      ...app,
    },
    {
      ...review({
        id: 12,
        state: "APPROVED",
        body: `## Ally — Consolidated PR Review\nReviewed head: ${HEAD}\n\nUser-seat approval.`,
      }),
      user: { login: ALLY_USER_REVIEWER_LOGIN, id: ALLY_USER_REVIEWER_ID, type: "User" },
      ...user,
    },
  ];
}

describe("duplicateBodyAcrossIdentities", () => {
  const at = (id, uid, body) => ({ id, user: { id: uid }, body });

  it("fires on one body under two user IDs", () => {
    assert.equal(
      duplicateBodyAcrossIdentities([at(1, 290875700, "same"), at(2, 296676656, "same")]),
      true,
    );
  });

  it("fires when the two bodies differ only in surrounding whitespace", () => {
    const body = `## Ally — Consolidated PR Review\nReviewed head: ${"a".repeat(40)}`;
    for (const variant of [`${body}\n`, `${body}  `, `\n${body}`, `\n  ${body}\n\n`]) {
      assert.equal(
        duplicateBodyAcrossIdentities([at(1, 290875700, body), at(2, 296676656, variant)]),
        true,
        `expected a duplicate-submission finding for variant ${JSON.stringify(variant)}`,
      );
    }
  });

  it("does not fire when the bodies differ in substance", () => {
    assert.equal(
      duplicateBodyAcrossIdentities([at(1, 290875700, "app"), at(2, 296676656, "user")]),
      false,
    );
  });

  it("does not fire when the same identity repeats a body", () => {
    assert.equal(
      duplicateBodyAcrossIdentities([at(1, 290875700, "same"), at(2, 290875700, "same")]),
      false,
    );
  });

  it("tolerates empty and single-element sets", () => {
    assert.equal(duplicateBodyAcrossIdentities([]), false);
    assert.equal(duplicateBodyAcrossIdentities(undefined), false);
    assert.equal(duplicateBodyAcrossIdentities([at(1, 290875700, "solo")]), false);
  });

  it("does not classify bodiless reviews as a duplicate verdict", () => {
    for (const empty of [null, "", undefined, "   ", "\n\n", "\t "]) {
      assert.equal(
        duplicateBodyAcrossIdentities([
          at(1, 290875700, empty),
          at(2, 296676656, empty),
        ]),
        false,
        `expected no duplicate-submission finding for body ${JSON.stringify(empty)}`,
      );
    }
  });
});

describe("I1 accepts only the protected-merge approval pair", () => {
  it("accepts exactly one independently attested App/User approval pair", () => {
    const reviews = requiredApprovalPair();
    const violations = findPrViolations({ number: 1129, headSha: HEAD, reviews });

    assert.equal(isRequiredApprovalPair(reviews, HEAD), true);
    assert.deepEqual(violations.filter((v) => v.startsWith("I1")), []);
  });

  it("accepts a clean canonical COMMENTED App self-review only for an App-authored PR", () => {
    const reviews = requiredApprovalPair({ state: "COMMENTED" });
    const appAuthoredPr = {
      number: 1129,
      author: { login: "app/allyblockcast", is_bot: true },
      headSha: HEAD,
      reviews,
    };

    assert.equal(isRequiredApprovalPair(reviews, HEAD, appAuthoredPr), true);
    assert.deepEqual(findPrViolations(appAuthoredPr), []);
    assert.equal(
      isRequiredApprovalPair(reviews, HEAD, { author: { login: "kkroo", is_bot: false } }),
      false,
    );

    const wrongAppIdentity = requiredApprovalPair({
      state: "COMMENTED",
      user: { login: ALLY_APP_REVIEWER_LOGIN, id: 42, type: "Bot" },
    });
    assert.equal(isRequiredApprovalPair(wrongAppIdentity, HEAD, appAuthoredPr), false);
  });

  it("does not require the two independent reviews to have byte-identical prose", () => {
    const reviews = requiredApprovalPair(
      { body: `## Ally — Consolidated PR Review\nReviewed head: ${HEAD}\n\nApp reviewed the implementation.` },
      { body: `Reviewed head: ${HEAD}\n\nUser seat independently approved the change.` },
    );

    assert.equal(isRequiredApprovalPair(reviews, HEAD), true);
    assert.deepEqual(findPrViolations({ number: 1130, headSha: HEAD, reviews }), []);
  });

  it("rejects a byte-identical body submitted under both credentials", () => {
    const body = `## Ally — Consolidated PR Review\nReviewed head: ${HEAD}\n\n### Critical Issues (0)\n### Important Issues (0)\n`;
    const reviews = requiredApprovalPair({ body }, { body });
    const violations = findPrViolations({ number: 1176, headSha: HEAD, reviews });

    assert.equal(reviews[0].body, reviews[1].body);
    assert.notEqual(reviews[0].user.id, reviews[1].user.id);
    assert.equal(isRequiredApprovalPair(reviews, HEAD), false);
    assert.match(
      violations.find((v) => v.startsWith("I1")) ?? "",
      /the same body submitted under two credentials/,
    );
  });

  it("rejects bodies differing only in surrounding whitespace under both credentials", () => {
    const body = `## Ally — Consolidated PR Review\nReviewed head: ${HEAD}\n\n### Critical Issues (0)\n### Important Issues (0)\n`;

    for (const variant of [`${body}\n`, `${body}  `, `\n${body}`, `\n  ${body}\n\n`]) {
      const reviews = requiredApprovalPair({ body }, { body: variant });
      const context = `variant ${JSON.stringify(variant)}`;

      assert.notEqual(reviews[0].body, reviews[1].body, `${context} must not be byte-identical`);
      assert.equal(isRequiredApprovalPair(reviews, HEAD), false, context);
      assert.match(
        findPrViolations({ number: 1176, headSha: HEAD, reviews }).find((v) =>
          v.startsWith("I1"),
        ) ?? "",
        /one verdict, posted twice/,
        context,
      );
    }
  });

  it("keeps genuinely different App/User write-ups valid", () => {
    const reviews = requiredApprovalPair(
      {
        body:
          `## Ally — Consolidated PR Review\nReviewed head: ${HEAD}\n\n` +
          `App reviewed the implementation.  `,
      },
      { body: `\nReviewed head: ${HEAD}\n\nUser seat approval; see the App review above.\n` },
    );

    assert.equal(isRequiredApprovalPair(reviews, HEAD), true);
    assert.deepEqual(findPrViolations({ number: 1177, headSha: HEAD, reviews }), []);
  });

  it("does not require an App-style attestation in the User-seat body", () => {
    const reviews = requiredApprovalPair({}, { body: "Approved after reviewing this change." });

    assert.equal(isRequiredApprovalPair(reviews, HEAD), true);
    assert.deepEqual(findPrViolations({ number: 1131, headSha: HEAD, reviews }), []);
  });

  it("rejects an extra operative retry instead of collapsing it", () => {
    const [app, user] = requiredApprovalPair();
    const reviews = [app, user, { ...user, id: 13 }];
    const violations = findPrViolations({ number: 1193, headSha: HEAD, reviews });

    assert.equal(isRequiredApprovalPair(reviews, HEAD), false);
    assert.match(
      violations.find((v) => v.startsWith("I1")) ?? "",
      /^I1 PR #1193 @ff1c72db: 2 operative Ally User seat reviews/,
    );
  });

  it("rejects a lookalike identity even when it carries the User-seat ID", () => {
    const [app, user] = requiredApprovalPair();
    const reviews = [app, { ...user, user: { login: "blockcast-ally", id: ALLY_USER_REVIEWER_ID } }];
    const violations = findPrViolations({ number: 1194, headSha: HEAD, reviews });

    assert.equal(isRequiredApprovalPair(reviews, HEAD), false);
    assert.deepEqual(operativeAllyReviews(reviews, HEAD, "seat"), []);
    assert.equal(violations.filter((v) => v.startsWith("I1")).length, 0);
  });

  it("rejects a canonical login with an unexpected immutable ID", () => {
    const [app, user] = requiredApprovalPair();
    const reviews = [
      app,
      { ...user, user: { login: ALLY_USER_REVIEWER_LOGIN, id: 42, type: "User" } },
    ];
    const violations = findPrViolations({ number: 1195, headSha: HEAD, reviews });

    assert.equal(isRequiredApprovalPair(reviews, HEAD), false);
    assert.equal(violations.filter((v) => v.startsWith("I1")).length, 0);
    assert.equal(violations.filter((v) => v.startsWith("I5")).length, 1);
  });

  it("reports an unexpected immutable App ID at the runtime guard", () => {
    const [app, user] = requiredApprovalPair();
    const reviews = [
      { ...app, user: { login: ALLY_APP_REVIEWER_LOGIN, id: 42, type: "Bot" } },
      user,
    ];
    const violations = findPrViolations({ number: 1199, headSha: HEAD, reviews });

    assert.equal(violations.filter((v) => v.startsWith("I5")).length, 1);
    assert.match(violations.find((v) => v.startsWith("I5")) ?? "", /Ally App review 11 uses the canonical login\/type/);
  });

  it("reports an unexpected immutable User-seat ID at the runtime guard", () => {
    const [app, user] = requiredApprovalPair();
    const reviews = [
      app,
      { ...user, user: { login: ALLY_USER_REVIEWER_LOGIN, id: 42, type: "User" } },
    ];
    const violations = findPrViolations({ number: 1200, headSha: HEAD, reviews });

    assert.equal(violations.filter((v) => v.startsWith("I5")).length, 1);
    assert.match(violations.find((v) => v.startsWith("I5")) ?? "", /Ally User seat review 12 uses the canonical login\/type/);
  });

  it("requires both required identities to submit APPROVED reviews", () => {
    const [app, user] = requiredApprovalPair({}, { state: "COMMENTED" });
    const reviews = [app, user];
    const violations = findPrViolations({ number: 1196, headSha: HEAD, reviews });

    assert.equal(isRequiredApprovalPair(reviews, HEAD), false);
    assert.deepEqual(violations, [
      "I4 PR #1196 @ff1c72db: Ally User seat review 12 is COMMENTED but User-seat evidence must be APPROVED",
    ]);
  });

  it("fails closed when either required approval omits its exact-head attestation", () => {
    const [app, user] = requiredApprovalPair({ body: "Approved without an attestation." });
    const reviews = [app, user];
    const violations = findPrViolations({ number: 1197, headSha: HEAD, reviews });

    assert.equal(isRequiredApprovalPair(reviews, HEAD), false);
    assert.equal(violations.filter((v) => v.startsWith("I1")).length, 0);
    assert.equal(violations.filter((v) => v.startsWith("I2d")).length, 1);
    assert.equal(violations.filter((v) => v.startsWith("I3")).length, 1);
  });

  it("fails closed when either required approval attests a stale head", () => {
    const [app, user] = requiredApprovalPair({ body: `## Ally — Consolidated PR Review\nReviewed head: ${OTHER}` });
    const reviews = [app, user];
    const violations = findPrViolations({ number: 1198, headSha: HEAD, reviews });

    assert.equal(isRequiredApprovalPair(reviews, HEAD), false);
    assert.equal(violations.filter((v) => v.startsWith("I1")).length, 0);
    assert.equal(violations.filter((v) => v.startsWith("I3")).length, 1);
  });

  it("does not accept a review recorded against an old commit as current-head evidence", () => {
    const [app, user] = requiredApprovalPair({}, { commit_id: OTHER });

    assert.equal(isRequiredApprovalPair([app, user], HEAD), false);
  });
});

describe("I2d — APPROVED with no attestation line", () => {
  it("fires on the #1114 shape: a short APPROVED that attests nothing", () => {
    const reviews = [
      review({
        id: 4879433972,
        state: "APPROVED",
        body: "Approved the current CI head. The implementation is unchanged; this head only retriggers checks.",
      }),
    ];
    const violations = findPrViolations({ number: 1114, headSha: HEAD, reviews });
    assert.equal(violations.filter((v) => v.startsWith("I2d")).length, 1);
  });

  it("does not fire on an APPROVED that does attest the head", () => {
    const reviews = [review({ id: 1, state: "APPROVED" })];
    assert.deepEqual(
      findPrViolations({ number: 1, headSha: HEAD, reviews }).filter((v) => v.startsWith("I2d")),
      [],
    );
  });

  it("does not fire on a COMMENTED review with no attestation — only an approval claims soundness", () => {
    const reviews = [review({ id: 1, state: "COMMENTED", body: "no attestation here" })];
    assert.deepEqual(
      findPrViolations({ number: 1, headSha: HEAD, reviews }).filter((v) => v.startsWith("I2d")),
      [],
    );
  });
});

describe("assertHeadSha", () => {
  it("passes a well-formed 40-hex head", () => {
    const row = { number: 1, headRefOid: HEAD };
    assert.equal(assertHeadSha(row, "o/r"), row);
  });

  for (const bad of [undefined, null, "", "not-a-sha", HEAD.slice(0, 39), HEAD.toUpperCase()]) {
    it(`throws on ${JSON.stringify(bad)} rather than asserting nothing`, () => {
      assert.throws(() => assertHeadSha({ number: 7, headRefOid: bad }, "o/r"), /no usable headRefOid/);
    });
  }

  it("names the PR so the failure is actionable", () => {
    assert.throws(() => assertHeadSha({ number: 42, headRefOid: null }, "o/r"), /o\/r#42/);
  });
});

describe("a falsy head would otherwise silently pass a maximal violation", () => {
  it("finds every invariant broken at the real head", () => {
    const reviews = [
      review({ id: 1, state: "APPROVED", body: `Reviewed head: ${OTHER}\n### Critical Issues (3)\n- boom` }),
      review({ id: 2, state: "COMMENTED", body: `Reviewed head: ${HEAD}\n### Important Issues (1)\n- boom` }),
    ];
    assert.ok(findPrViolations({ number: 9, headSha: HEAD, reviews }).length >= 4);
  });

  it("finds nothing at all when the head is falsy — which is why assertHeadSha exists", () => {
    const reviews = [
      review({ id: 1, state: "APPROVED", body: `Reviewed head: ${OTHER}\n### Critical Issues (3)\n- boom` }),
      review({ id: 2, state: "COMMENTED", body: `Reviewed head: ${HEAD}\n### Important Issues (1)\n- boom` }),
    ];
    for (const head of [undefined, null, ""]) {
      assert.deepEqual(findPrViolations({ number: 9, headSha: head, reviews }), []);
    }
  });
});
