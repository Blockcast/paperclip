import assert from "node:assert/strict";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";

import {
  ALLY_APP_REVIEWER_ID,
  ALLY_APP_REVIEWER_LOGIN,
  ALLY_USER_REVIEWER_ID,
  ALLY_USER_REVIEWER_LOGIN,
  assertHeadSha,
  assertPrListComplete,
  attestedHead,
  findPrViolations,
  findViolations,
  hasBlockingFindings,
  hasStillPresentDisposition,
  isAllyLogin,
  isMainModule,
  isRequiredApprovalPair,
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
    assert.match(violations[0], /^I1 PR #876 @ff1c72db: 2 operative Ally reviews/);
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

/** The mandated two-principal protected-merge shape. */
function requiredApprovalPair(app = {}, user = {}) {
  return [
    {
      ...review({
        id: 11,
        state: "APPROVED",
        body: `## Ally — Consolidated PR Review\nReviewed head: ${HEAD}\n\nApp artifact.`,
      }),
      user: { login: ALLY_APP_REVIEWER_LOGIN, id: ALLY_APP_REVIEWER_ID },
      ...app,
    },
    {
      ...review({
        id: 12,
        state: "APPROVED",
        body: `## Ally — Consolidated PR Review\nReviewed head: ${HEAD}\n\nUser-seat approval.`,
      }),
      user: { login: ALLY_USER_REVIEWER_LOGIN, id: ALLY_USER_REVIEWER_ID },
      ...user,
    },
  ];
}

describe("I1 accepts only the protected-merge approval pair", () => {
  it("accepts exactly one independently attested App/User approval pair", () => {
    const reviews = requiredApprovalPair();
    const violations = findPrViolations({ number: 1129, headSha: HEAD, reviews });

    assert.equal(isRequiredApprovalPair(reviews, HEAD), true);
    assert.deepEqual(violations.filter((v) => v.startsWith("I1")), []);
  });

  it("does not require the two independent reviews to have byte-identical prose", () => {
    const reviews = requiredApprovalPair(
      { body: `Reviewed head: ${HEAD}\n\nApp reviewed the implementation.` },
      { body: `Reviewed head: ${HEAD}\n\nUser seat independently approved the change.` },
    );

    assert.equal(isRequiredApprovalPair(reviews, HEAD), true);
    assert.deepEqual(findPrViolations({ number: 1130, headSha: HEAD, reviews }), []);
  });

  it("rejects an extra operative retry instead of collapsing it", () => {
    const [app, user] = requiredApprovalPair();
    const reviews = [app, user, { ...user, id: 13 }];
    const violations = findPrViolations({ number: 1193, headSha: HEAD, reviews });

    assert.equal(isRequiredApprovalPair(reviews, HEAD), false);
    assert.match(
      violations.find((v) => v.startsWith("I1")) ?? "",
      /^I1 PR #1193 @ff1c72db: 3 operative Ally reviews/,
    );
  });

  it("rejects a lookalike identity even when it carries the User-seat ID", () => {
    const [app, user] = requiredApprovalPair();
    const reviews = [app, { ...user, user: { login: "blockcast-ally", id: ALLY_USER_REVIEWER_ID } }];
    const violations = findPrViolations({ number: 1194, headSha: HEAD, reviews });

    assert.equal(isRequiredApprovalPair(reviews, HEAD), false);
    assert.equal(violations.filter((v) => v.startsWith("I1")).length, 1);
  });

  it("rejects a canonical login with an unexpected immutable ID", () => {
    const [app, user] = requiredApprovalPair();
    const reviews = [app, { ...user, user: { login: ALLY_USER_REVIEWER_LOGIN, id: 42 } }];
    const violations = findPrViolations({ number: 1195, headSha: HEAD, reviews });

    assert.equal(isRequiredApprovalPair(reviews, HEAD), false);
    assert.equal(violations.filter((v) => v.startsWith("I1")).length, 1);
  });

  it("requires both required identities to submit APPROVED reviews", () => {
    const [app, user] = requiredApprovalPair({}, { state: "COMMENTED" });
    const reviews = [app, user];
    const violations = findPrViolations({ number: 1196, headSha: HEAD, reviews });

    assert.equal(isRequiredApprovalPair(reviews, HEAD), false);
    assert.equal(violations.filter((v) => v.startsWith("I1")).length, 1);
  });

  it("fails closed when either required approval omits its exact-head attestation", () => {
    const [app, user] = requiredApprovalPair({ body: "Approved without an attestation." });
    const reviews = [app, user];
    const violations = findPrViolations({ number: 1197, headSha: HEAD, reviews });

    assert.equal(isRequiredApprovalPair(reviews, HEAD), false);
    assert.equal(violations.filter((v) => v.startsWith("I1")).length, 1);
    assert.equal(violations.filter((v) => v.startsWith("I2d")).length, 1);
  });

  it("fails closed when either required approval attests a stale head", () => {
    const [app, user] = requiredApprovalPair({ body: `Reviewed head: ${OTHER}` });
    const reviews = [app, user];
    const violations = findPrViolations({ number: 1198, headSha: HEAD, reviews });

    assert.equal(isRequiredApprovalPair(reviews, HEAD), false);
    assert.equal(violations.filter((v) => v.startsWith("I1")).length, 1);
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
