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
  duplicateBodyAcrossIdentities,
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

describe("duplicateBodyAcrossIdentities", () => {
  const at = (id, uid, body) => ({ id, user: { id: uid }, body });

  it("fires on one body under two user IDs", () => {
    assert.equal(
      duplicateBodyAcrossIdentities([at(1, 290875700, "same"), at(2, 296676656, "same")]),
      true,
    );
  });

  // One `--body-file` passed to both calls produces byte-identical bodies, but
  // a stray trailing newline is still one verdict posted twice. Exact equality
  // would audit these pairs as sound.
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

  it("does NOT fire when the bodies differ", () => {
    assert.equal(
      duplicateBodyAcrossIdentities([at(1, 290875700, "app"), at(2, 296676656, "user")]),
      false,
    );
  });

  // A repeat under ONE identity is a retry, not a dual-credential submission;
  // the operative-count check already reports it and the remedy differs.
  it("does NOT fire when the same identity repeats a body", () => {
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

  // Two bodiless approvals compare equal, but "one verdict, posted twice" is
  // the wrong diagnosis: there is no verdict. I2d reports the missing
  // attestation, and its remedy (post a comment) differs from this one's.
  // A whitespace-only body is bodiless in substance and must land here too.
  it("does NOT fire on bodiless reviews under two identities", () => {
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

  it("does not require the two independent reviews to have byte-identical prose", () => {
    const reviews = requiredApprovalPair(
      { body: `Reviewed head: ${HEAD}\n\nApp reviewed the implementation.` },
      { body: `Reviewed head: ${HEAD}\n\nUser seat independently approved the change.` },
    );

    assert.equal(isRequiredApprovalPair(reviews, HEAD), true);
    assert.deepEqual(findPrViolations({ number: 1130, headSha: HEAD, reviews }), []);
  });

  // BLO-22916 AC1. The exemption above exists for a gate that genuinely needs
  // both seats; it must not launder one verdict submitted twice. Before this
  // case the fleet's 17 byte-identical App+User pairs all read as SOUND, so the
  // guard certified as clean the exact defect it was pointed at.
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

  // The whitespace case has to be asserted HERE, through findPrViolations, and
  // not only against duplicateBodyAcrossIdentities. That predicate does not
  // gate anything — it picks the wording after I1 has already fired, and I1
  // fires only when isRequiredApprovalPair returns false. A first attempt at
  // this fix trimmed inside the predicate alone; every variant below still
  // audited as SOUND because the deciding branch compared raw bodies and
  // exempted the pair before the predicate was consulted. The whole suite
  // stayed green throughout, which is exactly why the end-to-end assertion is
  // the one that matters.
  it("rejects a body that differs only in surrounding whitespace under both credentials", () => {
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

  // The counterweight: trimming must not collapse two genuinely distinct
  // write-ups into a "duplicate", or the two-seat exemption stops working.
  it("still accepts a pair whose bodies differ in substance, not just whitespace", () => {
    const reviews = requiredApprovalPair(
      { body: `Reviewed head: ${HEAD}\n\nApp reviewed the implementation.  ` },
      { body: `\nReviewed head: ${HEAD}\n\nUser seat approval; see the App review above.\n` },
    );

    assert.equal(isRequiredApprovalPair(reviews, HEAD), true);
    assert.deepEqual(findPrViolations({ number: 1177, headSha: HEAD, reviews }), []);
  });

  it("names the duplicate shape rather than reporting a bare count", () => {
    const body = `Reviewed head: ${HEAD}\n\nSame text, two seats.`;
    const identical = requiredApprovalPair({ body }, { body });
    const [app, user] = requiredApprovalPair();
    const distinctButExtra = [app, user, { ...user, id: 13 }];

    assert.match(
      findPrViolations({ number: 1, headSha: HEAD, reviews: identical }).find((v) =>
        v.startsWith("I1"),
      ) ?? "",
      /one verdict, posted twice/,
    );
    // A three-review set is a different failure with a different remedy, and
    // must not borrow the duplicate-submission wording.
    assert.match(
      findPrViolations({ number: 2, headSha: HEAD, reviews: distinctButExtra }).find((v) =>
        v.startsWith("I1"),
      ) ?? "",
      /expected at most 1 or the exact App\/User APPROVED pair/,
    );
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
