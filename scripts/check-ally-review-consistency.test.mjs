import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";

import {
  ALLY_APP_REVIEWER_ID,
  ALLY_APP_REVIEWER_LOGIN,
  ALLY_USER_REVIEWER_ID,
  ALLY_USER_REVIEWER_LOGIN,
  allyReviewLane,
  applyBaseline,
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
  operativeAllyReviews,
  parseBaseline,
  sameLaneBodyRelation,
  violationFingerprint,
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

/**
 * A body in the shape the live producer actually emits: canonical heading, the
 * prose attestation, then the structured block. `findings` is passed verbatim
 * so a test can state a partial payload.
 */
function verdictBody(findings, extra = "", dispositions = [], head = HEAD) {
  const payload = JSON.stringify({ head, findings, dispositions }, null, 2);
  return `## Ally — Consolidated PR Review\nReviewed head: ${head}\n\n<!-- ally-verdict:1\n${payload}\n-->\n${extra}`;
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

  // The gate (ally-review-detection.ts) and the sweep (sweep-stalled-ally-reviews.py)
  // read the prose ledger with PRIOR_FINDING_DISPOSITION_PATTERN; this auditor
  // must accept exactly the entries they accept, or the gate goes red on
  // `unreadable_verdict` while the auditor reads a cleanly-attesting review.
  // Drive the same ledger strings through all three sources, taken from the
  // committed files rather than retyped.
  it("accepts exactly the ledger entries the gate and the sweep accept", () => {
    const notIndentedCode = String.raw`(?! *\t)(?! {4})`;
    const tsSource = readFileSync(
      new URL("../server/src/services/ally-review-detection.ts", import.meta.url),
      "utf8",
    );
    const tsRaw = tsSource.match(
      /PRIOR_FINDING_DISPOSITION_PATTERN = new RegExp\(\n\s*String\.raw`([^`]+)`,\n\s*"gim",/,
    );
    assert.ok(tsRaw, "ally-review-detection.ts still defines PRIOR_FINDING_DISPOSITION_PATTERN");
    const gatePattern = new RegExp(tsRaw[1].replace("${NOT_INDENTED_CODE}", notIndentedCode), "gim");

    const pySource = readFileSync(
      new URL("../.github/scripts/sweep-stalled-ally-reviews.py", import.meta.url),
      "utf8",
    );
    const pyRaw = pySource.match(
      /PRIOR_FINDING_DISPOSITION_PATTERN = re\.compile\(\n\s*r"([^"]+)"\n\s*r"([^"]+)",/,
    );
    assert.ok(pyRaw, "sweep-stalled-ally-reviews.py still defines PRIOR_FINDING_DISPOSITION_PATTERN");
    const sweepPattern = new RegExp(pyRaw[1] + pyRaw[2], "gim");

    const blocksUnder = (pattern, verbGroup, text) =>
      [...text.matchAll(pattern)].some((m) => m[verbGroup].toLowerCase() === "still-present");

    const corpus = [
      ["canonical", "- **prior:354d5b9 important 1** — still-present — not mirrored", true],
      ["en dash separator", "- **prior:354d5b9 important 1** – still-present – not mirrored", true],
      ["space after the emphasis", "- ** prior:354d5b9 important 1** — still-present — not mirrored", true],
      ["trailing parenthetical after the index", "- **prior:354d5b9 important 1 (see below)** — still-present — not mirrored", false],
      ["fixed verb", "- **prior:354d5b9 important 1** — fixed — closed", false],
      ["verb in prose only", "still-present in quoted prose\n- prior:354d5b9 important 1 still-present", false],
    ];
    for (const [name, text, expected] of corpus) {
      const gate = blocksUnder(gatePattern, 4, text);
      const sweep = blocksUnder(sweepPattern, 1, text);
      assert.equal(gate, expected, `gate reader: ${name}`);
      assert.equal(sweep, expected, `sweep reader: ${name}`);
      assert.equal(hasStillPresentDisposition(text), expected, `auditor: ${name}`);
    }
  });
});

describe("attestedHead", () => {
  it("extracts the standalone attestation line", () => {
    assert.equal(attestedHead(`Reviewed head: ${HEAD}`), HEAD);
  });

  it("tolerates backticks and emphasis", () => {
    assert.equal(attestedHead(`_Reviewed head: \`${HEAD}\`_`), HEAD);
  });

  // This reader was left on the narrow `(?:[_*]+)?` / `` \`? `` form while the
  // gate and the Python sweep were both widened, so the emphasis forms below
  // measured gate 1 / python 1 / mjs 0 on the same bodies. The first is named
  // verbatim in ally-review-detection.ts's own comment as the BLO-31730 shape
  // — the single permitted run is consumed by `**` and cannot then cross the
  // space to reach the backtick.
  //
  // Block-carrying bodies masked it, because attestedHead falls through to the
  // block's head. The harm landed on the whole pre-block population, where
  // operativeAllyReviews dropped a review the gate reads fine — in a script
  // whose stated purpose is reader parity. Found by Ally reviewing #1721 at
  // 8e6e84bd. No block in these fixtures, deliberately: with one they pass
  // whether or not the prose regex works.
  for (const [label, line] of [
    ["emphasis closing after the colon", `**Reviewed head:** \`${HEAD}\``],
    ["underscore emphasis closing after the colon", `_Reviewed head:_ ${HEAD}`],
    ["a bold wrapper around the whole line", `**Reviewed head: ${HEAD}**`],
    ["a backticked SHA with no emphasis", `Reviewed head: \`${HEAD}\``],
  ]) {
    it(`parses ${label}, as the gate and the Python sweep do`, () => {
      assert.equal(attestedHead(line), HEAD);
    });
  }

  it("does not widen past the gate's own indent bound", () => {
    // The converse check: the widening has a direction, and accepting a line
    // the gate rejects is the same divergence one delimiter out. The gate
    // bounds the run between emphasis and the label at `[ \t]{0,3}`, and
    // treats four leading spaces as indented code.
    assert.equal(attestedHead(`**    Reviewed head:** \`${HEAD}\``), null);
    assert.equal(attestedHead(`    Reviewed head: ${HEAD}`), null);
  });

  it("returns null when no attestation is present", () => {
    assert.equal(attestedHead("## Ally — Consolidated PR Review"), null);
  });

  it("ignores a SHA mentioned mid-sentence", () => {
    assert.equal(attestedHead(`I reviewed head: ${HEAD} earlier today`), null);
  });

  // The structured block is the primary source here exactly as it is in
  // server/src/services/ally-review-detection.ts. Before this, a body carrying
  // a block plus a #1675-shaped prose line read as "no attestation" to this
  // script while the merge gate read it as attesting — the readers disagreed
  // about which tree was reviewed, which is the BLO-32695 finding.
  const block = (head) =>
    `<!-- ally-verdict:1\n{"head":"${head}","findings":{"critical":0,"important":0,"suggestions":0}}\n-->`;

  it("reads the structured block when the prose line is unparseable (#1675)", () => {
    const body = `${block(HEAD)}\n\n## Ally — Consolidated PR Review\nReviewed head: ${HEAD} (unchanged since my last pass — no new commits)\n`;
    assert.equal(attestedHead(body), HEAD);
  });

  it("reads the structured block when no prose line is present", () => {
    assert.equal(attestedHead(block(HEAD)), HEAD);
  });

  it("fails closed when the block and the prose line name different heads", () => {
    const other = "a".repeat(40);
    assert.equal(attestedHead(`${block(HEAD)}\nReviewed head: ${other}`), null);
  });

  // Peer review of #1721 at 8e6e84bd -- shared identically by all three
  // readers, so none of them caught it. `JSON.parse` keeps "critical" and
  // "Critical" as distinct keys; they become one severity only at the
  // `toLowerCase` in severityCountsIn, where an unconditional `set` let the
  // last one win, so a block stating a Critical could read clean. Reachable
  // because the keys differ in CASE -- an exact duplicate is collapsed by the
  // parser first. Both orders, because last-wins made the verdict depend on
  // key order and a guard catching one order leaves the dangerous one live.
  for (const findings of [
    `{"critical":0,"Critical":1,"important":0}`,
    `{"Critical":1,"critical":0,"important":0}`,
  ]) {
    it(`fails closed on two keys normalizing to one severity: ${findings}`, () => {
      assert.equal(
        attestedHead(`<!-- ally-verdict:1\n{"head":"${HEAD}","findings":${findings}}\n-->`),
        null,
      );
    });
  }

  it("still accepts distinct severities", () => {
    // Control: without it the guard would reject every honest verdict.
    assert.equal(
      attestedHead(
        `<!-- ally-verdict:1\n{"head":"${HEAD}","findings":{"critical":0,"important":0,"suggestions":1}}\n-->`,
      ),
      HEAD,
    );
  });

  it("fails closed on two blocks rather than falling back to prose", () => {
    const body = `${block(HEAD)}\n${block(HEAD)}\nReviewed head: ${HEAD}`;
    assert.equal(attestedHead(body), null);
  });

  it("fails closed on an unterminated block rather than falling back to prose", () => {
    const body = `<!-- ally-verdict:1\n{"head":"${HEAD}"}\nReviewed head: ${HEAD}`;
    assert.equal(attestedHead(body), null);
  });

  it("fails closed on an unsupported block version", () => {
    assert.equal(attestedHead(`<!-- ally-verdict:2\n{"head":"${HEAD}"}\n-->`), null);
  });

  it("fails closed on a block whose head is not a complete SHA", () => {
    assert.equal(attestedHead(`<!-- ally-verdict:1\n{"head":"${HEAD.slice(0, 7)}"}\n-->`), null);
  });

  it("ignores a quoted block — that is a body discussing one, not emitting one", () => {
    const body = `> ${block(HEAD).split("\n").join("\n> ")}\nReviewed head: ${HEAD}`;
    assert.equal(attestedHead(body), HEAD);
  });

  // Peer review of #1721, Important 2 — the count rule landed in one reader of
  // three. The merge gate treats a block contradicted by its own emitted
  // buckets as unreadable; this script read the same body as a good
  // attestation, so the two disagreed about the field that decides whether a
  // merge is blocked.
  const counted = (findings, ...prose) =>
    [
      `<!-- ally-verdict:1\n{"head":"${HEAD}","findings":${findings}}\n-->`,
      "",
      "## Ally — Consolidated PR Review",
      ...prose,
    ].join("\n");

  it("fails closed when an emitted bucket contradicts the block's zero", () => {
    assert.equal(attestedHead(counted('{"critical":0,"important":0}', "### Critical Issues (2)")), null);
  });

  it("control: agreeing counts still attest", () => {
    assert.equal(
      attestedHead(counted('{"critical":0,"important":0}', "### Critical Issues (0)")),
      HEAD,
    );
  });

  it("does not fail closed on a referenced, quoted or fenced bucket", () => {
    // Over-matching here reds a clean review, which is the false red this row
    // retires — so the cross-check reads only the emitted heading form.
    for (const prose of [
      "Both Critical Issues (2) from the previous pass are fixed.",
      "> ### Critical Issues (2)",
      "```\n### Critical Issues (2)\n```",
    ]) {
      assert.equal(attestedHead(counted('{"critical":0,"important":0}', prose)), HEAD, prose);
    }
  });

  // Peer review of #1721, Important at 1d6f3785 — the same rule on the other
  // field. `structuredBlocking(body, "stillPresent") ?? hasStillPresentDisposition(body)`
  // gives the block precedence, so a block retiring everything suppressed a
  // prose ledger entry saying a prior finding stands. Identical fail-open to
  // the gate's, in the reader whose job is to notice the gate's.
  const ledgered = (dispositions, verb) =>
    [
      `<!-- ally-verdict:1\n{"head":"${HEAD}","findings":{"critical":0,"important":0}${dispositions}}\n-->`,
      "",
      "## Ally — Consolidated PR Review",
      "### Critical Issues (0)",
      `- **prior:abc1234 critical 1** — ${verb} — the guard is unchanged.`,
    ].join("\n");

  it("fails closed when a prose ledger still stands against a block retiring everything", () => {
    for (const dispositions of ["", ',"dispositions":[]']) {
      assert.equal(attestedHead(ledgered(dispositions, "still-present")), null, dispositions || "absent");
    }
  });

  it("control: a prose ledger that only retires still attests", () => {
    // Keeps this a fail-closed rule rather than a widening: a `fixed` entry
    // the block omits clears either way, so reddening it buys nothing.
    assert.equal(attestedHead(ledgered(',"dispositions":[]', "fixed")), HEAD);
  });

  it("control: a block that already carries the standing entry still attests", () => {
    // It blocks — but as a structured verdict, not as an unreadable one, or
    // every contract-compliant still-present review reads broken.
    const dispositions = ',"dispositions":[{"head":"abc1234","severity":"critical","index":1,"verb":"still-present"}]';
    assert.equal(attestedHead(ledgered(dispositions, "still-present")), HEAD);
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
  it("accepts a lone canonical App review as the only permitted shape", () => {
    const pr = { number: 1, headSha: HEAD, reviews: [appReview({ id: 1 })] };
    assert.deepEqual(findPrViolations(pr), []);
  });

  // BLO-22916 Defect 2. All five content-free approvals were seat submissions
  // (uid 296676656) carrying no `Reviewed head:` line; #1114's body is
  // reproduced verbatim. The App-only I2d check cannot see this shape, so
  // before I6 the guard returned zero violations for it.
  it("I6: rejects a User-seat APPROVED that makes no Reviewed head attestation", () => {
    const pr = {
      number: 1114,
      headSha: HEAD,
      reviews: [
        appReview({ id: 1 }),
        seatReview({
          id: 4879433972,
          state: "APPROVED",
          body: "Approved the current CI head. The Alertmanager aggregate lifecycle implementation is unchanged; this head only retriggers checks.",
        }),
      ],
    };
    assert.deepEqual(findPrViolations(pr), [
      "I6 PR #1114 @ff1c72db: Ally User seat review 4879433972 is APPROVED — the User seat (uid 296676656) never submits a verdict (R4, BLO-24056); only the App (uid 290875700) may carry one",
    ]);
  });

  it("I6: rejects a User-seat review even when it does attest the exact head", () => {
    const pr = {
      number: 1115,
      headSha: HEAD,
      reviews: [
        appReview({ id: 1 }),
        seatReview({ id: 2, body: `Reviewed head: ${HEAD}\n\nSeat approval, independently written.` }),
      ],
    };
    assert.deepEqual(findPrViolations(pr), [
      "I6 PR #1115 @ff1c72db: Ally User seat review 2 is APPROVED — the User seat (uid 296676656) never submits a verdict (R4, BLO-24056); only the App (uid 290875700) may carry one",
    ]);
  });

  it("rejects duplicate operative reviews in the App lane, and both seat reviews outright", () => {
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
    assert.equal(violations.length, 4);
    assert.match(violations[0], /^I1 PR #876 @ff1c72db: 2 operative Ally App reviews/);
    assert.match(violations[1], /^I1 PR #876 @ff1c72db: 2 operative Ally User seat reviews/);
    assert.match(violations[2], /^I6 PR #876 @ff1c72db: Ally User seat review 3 is APPROVED/);
    assert.match(violations[3], /^I6 PR #876 @ff1c72db: Ally User seat review 4 is APPROVED/);
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

  // The producer's own template heads its buckets `### 🚨 Critical` with no
  // `(N)`, so every prose reader here sees a blocking review as clean. The
  // structured counts are the only place the finding is actually stated.
  it("I2a: catches a structured blocking verdict whose prose carries no counted headings", () => {
    const pr = {
      number: 1721,
      headSha: HEAD,
      reviews: [
        appReview({
          id: 21,
          state: "APPROVED",
          body: verdictBody({ critical: 0, important: 1 }, "\n### ⚠️ Important\n- **[codex]** something real\n"),
        }),
      ],
    };
    const violations = findPrViolations(pr);
    assert.equal(violations.length, 1);
    assert.match(violations[0], /^I2a PR #1721 @ff1c72db: Ally App review 21 is APPROVED/);
  });

  it("I2c: catches a structured still-present disposition with no prose ledger line", () => {
    const pr = {
      number: 1722,
      headSha: HEAD,
      reviews: [
        appReview({
          id: 22,
          state: "APPROVED",
          body: verdictBody({ critical: 0, important: 0 }, "\n### ✅ Strengths\n- clean\n", [
            { head: "d40c450", severity: "important", index: 1, verb: "still-present" },
          ]),
        }),
      ],
    };
    const violations = findPrViolations(pr);
    assert.equal(violations.length, 1);
    assert.match(violations[0], /^I2c PR #1722 @ff1c72db: Ally App review 22 is APPROVED/);
  });

  // The control for the two above: the same uncounted prose with a verdict that
  // explicitly reports nothing must stay clean, or the fix is just a blanket red.
  it("allows an APPROVED whose structured verdict explicitly reports zero findings", () => {
    const pr = {
      number: 1723,
      headSha: HEAD,
      reviews: [
        appReview({
          id: 23,
          state: "APPROVED",
          body: verdictBody({ critical: 0, important: 0 }, "\n### 🚨 Critical\n### ⚠️ Important\n"),
        }),
      ],
    };
    assert.deepEqual(findPrViolations(pr), []);
  });

  // A block Ally tried and failed to state is not a review that predates the
  // block, so it must not reach the prose path the block exists to replace.
  it("I2a: fails closed on an APPROVED whose verdict block omits a blocking count", () => {
    const pr = {
      number: 1724,
      headSha: HEAD,
      reviews: [
        appReview({
          id: 24,
          state: "APPROVED",
          body: verdictBody({ suggestions: 0 }, "\n### ✅ Strengths\n- clean\n"),
        }),
      ],
    };
    const violations = findPrViolations(pr);
    assert.ok(violations.some((v) => /^I2a PR #1724 /.test(v)), violations.join("\n"));
  });

  it("I3: catches an App review whose body attests a head other than the recorded commit", () => {
    const pr = {
      number: 870,
      headSha: HEAD,
      reviews: [
        appReview({
          id: 4830097206,
          body: canonicalBody(OTHER),
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
      ],
    };
    assert.deepEqual(findPrViolations(pr), []);
  });

  it("I6: rejects a User-seat approval on an App-authored PR, which R4 removed as a fallback", () => {
    const pr = {
      number: 985,
      author: { login: "app/allyblockcast", is_bot: true },
      headSha: HEAD,
      reviews: [
        appReview({ id: 9851, state: "COMMENTED", body: canonicalBody(HEAD) }),
        seatReview({ id: 9852, body: "Approved after an independent review." }),
      ],
    };
    assert.deepEqual(findPrViolations(pr), [
      "I6 PR #985 @ff1c72db: Ally User seat review 9852 is APPROVED — the User seat (uid 296676656) never submits a verdict (R4, BLO-24056); only the App (uid 290875700) may carry one",
    ]);
  });

  it("I6: a User-seat review is prohibited whatever its state", () => {
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
      "I6 PR #1147 @ff1c72db: Ally User seat review 2 is COMMENTED — the User seat (uid 296676656) never submits a verdict (R4, BLO-24056); only the App (uid 290875700) may carry one",
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
      "I6 PR #876 @ff1c72db: Ally User seat review 4829069732 is APPROVED — the User seat (uid 296676656) never submits a verdict (R4, BLO-24056); only the App (uid 290875700) may carry one",
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
        appReview({ id: 3, state: "APPROVED", body: canonicalBody(HEAD, "\n### Critical Issues (1)") }),
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

/**
 * The App+seat two-review shape R4 (BLO-24056) retired. Named for what it
 * builds, not for a policy: nothing requires this pair any more.
 */
function appAndSeatReviews(app = {}, user = {}) {
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

describe("sameLaneBodyRelation", () => {
  const at = (id, body) => ({ id, user: { id: ALLY_APP_REVIEWER_ID }, body });

  it("reports resubmit when every body is identical", () => {
    assert.equal(sameLaneBodyRelation([at(1, "same"), at(2, "same")]), "resubmit");
  });

  it("treats whitespace-only differences as the same body", () => {
    const body = canonicalBody();
    for (const variant of [`${body}\n`, `${body}  `, `\n${body}`, `\n  ${body}\n\n`]) {
      assert.equal(
        sameLaneBodyRelation([at(1, body), at(2, variant)]),
        "resubmit",
        `expected resubmit for variant ${JSON.stringify(variant)}`,
      );
    }
  });

  it("reports recompute when the bodies differ in substance", () => {
    assert.equal(sameLaneBodyRelation([at(1, "first pass"), at(2, "second pass")]), "recompute");
  });

  it("reports mixed when three reviews carry two identical and one distinct body", () => {
    assert.equal(
      sameLaneBodyRelation([at(1, "same"), at(2, "same"), at(3, "other")]),
      "mixed",
    );
  });

  it("declines to classify when any body is empty", () => {
    // An empty body is an attestation defect (I3). Calling it a resubmit would
    // assert a mechanism the evidence does not carry.
    for (const empty of [null, "", undefined, "   ", "\n\n", "\t "]) {
      assert.equal(
        sameLaneBodyRelation([at(1, empty), at(2, empty)]),
        null,
        `expected no classification for body ${JSON.stringify(empty)}`,
      );
    }
    assert.equal(sameLaneBodyRelation([at(1, "present"), at(2, "")]), null);
  });

  it("declines to classify a non-duplicate set", () => {
    assert.equal(sameLaneBodyRelation([]), null);
    assert.equal(sameLaneBodyRelation(undefined), null);
    assert.equal(sameLaneBodyRelation([at(1, "solo")]), null);
  });
});

describe("I1 names the mechanism a same-lane duplicate implies", () => {
  // The real review IDs from paperclip#1220, so the fingerprint below carries a
  // populated ID list rather than an empty one.
  const DUPLICATE_IDS = [5124949902, 5124950225];

  function duplicatePr(bodies) {
    return {
      number: 1220,
      headSha: HEAD,
      reviews: bodies.map((body, i) => appReview({ id: DUPLICATE_IDS[i] ?? 5124950000 + i, body })),
    };
  }

  it("calls identical bodies a repeated submit", () => {
    const violation = findPrViolations(duplicatePr([canonicalBody(), canonicalBody()])).find((v) =>
      v.startsWith("I1"),
    );
    assert.match(violation, /bodies are identical/);
    assert.match(violation, /submit step is at-least-once/);
  });

  it("calls differing bodies a double-compute needing exclusion, not idempotency", () => {
    // paperclip#1220: two reviews 10 s apart carried different bodies, so a
    // timing threshold misfiles this case as a retry.
    const violation = findPrViolations(
      duplicatePr([canonicalBody(HEAD, "first pass"), canonicalBody(HEAD, "second pass")]),
    ).find((v) => v.startsWith("I1"));
    assert.match(violation, /bodies differ/);
    assert.match(violation, /exclusion, not submit idempotency/);
  });

  it("omits the clause rather than guessing when a body is empty", () => {
    const violation = findPrViolations(duplicatePr(["", ""])).find((v) => v.startsWith("I1"));
    assert.doesNotMatch(violation, /bodies are identical|bodies differ/);
  });

  it("does not perturb the I1 fingerprint the baseline suppresses on", () => {
    // violationFingerprint harvests every 6+ digit token out of the message, so
    // a count or account id in the classification clause would change an I1
    // fingerprint and silently void its baseline entry.
    const identical = findPrViolations(duplicatePr([canonicalBody(), canonicalBody()])).find((v) =>
      v.startsWith("I1"),
    );
    const differing = findPrViolations(
      duplicatePr([canonicalBody(HEAD, "a"), canonicalBody(HEAD, "b")]),
    ).find((v) => v.startsWith("I1"));
    const bodiless = findPrViolations(duplicatePr(["", ""])).find((v) => v.startsWith("I1"));

    assert.equal(violationFingerprint(identical), "I1:1220:ff1c72db:5124949902,5124950225");
    assert.equal(violationFingerprint(identical), violationFingerprint(differing));
    assert.equal(violationFingerprint(identical), violationFingerprint(bodiless));
  });
});

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

// The App+seat two-review shape R4 (BLO-24056) retired. Every test below
// builds from it, so every case here is a prohibited submission: the question
// each asks is only *which* violations the guard reports for it, and whether
// the App-lane checks still land when a seat review is also present.
//
// This block used to assert the pair as the required protected-merge shape,
// and its passing tests were titled as acceptance of it ("keeps genuinely
// different App/User write-ups valid"). Those titles were the readable
// statement of BLO-22916's root cause — they are what a future run would grep
// and re-derive "submit under both to be safe" from — so they are deleted
// rather than kept green behind a filter that hid the I6 the guard now emits.
describe("submissions carrying both an App review and a User seat review", () => {
  it("rejects a byte-identical body submitted under both credentials", () => {
    const body = `## Ally — Consolidated PR Review\nReviewed head: ${HEAD}\n\n### Critical Issues (0)\n### Important Issues (0)\n`;
    const reviews = appAndSeatReviews({ body }, { body });
    const violations = findPrViolations({ number: 1176, headSha: HEAD, reviews });

    assert.equal(reviews[0].body, reviews[1].body);
    assert.notEqual(reviews[0].user.id, reviews[1].user.id);
    assert.match(
      violations.find((v) => v.startsWith("I1")) ?? "",
      /the same body submitted under two credentials/,
    );
  });

  it("rejects bodies differing only in surrounding whitespace under both credentials", () => {
    const body = `## Ally — Consolidated PR Review\nReviewed head: ${HEAD}\n\n### Critical Issues (0)\n### Important Issues (0)\n`;

    for (const variant of [`${body}\n`, `${body}  `, `\n${body}`, `\n  ${body}\n\n`]) {
      const reviews = appAndSeatReviews({ body }, { body: variant });
      const context = `variant ${JSON.stringify(variant)}`;

      assert.notEqual(reviews[0].body, reviews[1].body, `${context} must not be byte-identical`);
      assert.match(
        findPrViolations({ number: 1176, headSha: HEAD, reviews }).find((v) =>
          v.startsWith("I1"),
        ) ?? "",
        /one verdict, posted twice/,
        context,
      );
    }
  });

  // Was "does not require an App-style attestation in the User-seat body",
  // asserting this exact shape produced no violation. That is BLO-22916
  // Defect 2 stated as a requirement, and it is why the five content-free
  // seat approvals passed the guard. R4 retired the seat verdict, so the
  // shape is now rejected outright.
  it("rejects a User-seat body carrying no attestation", () => {
    const reviews = appAndSeatReviews({}, { body: "Approved after reviewing this change." });

    assert.deepEqual(
      findPrViolations({ number: 1131, headSha: HEAD, reviews }).filter((v) => v.startsWith("I6")),
      [
        "I6 PR #1131 @ff1c72db: Ally User seat review 12 is APPROVED — the User seat (uid 296676656) never submits a verdict (R4, BLO-24056); only the App (uid 290875700) may carry one",
      ],
    );
  });

  it("rejects an extra operative retry instead of collapsing it", () => {
    const [app, user] = appAndSeatReviews();
    const reviews = [app, user, { ...user, id: 13 }];
    const violations = findPrViolations({ number: 1193, headSha: HEAD, reviews });

    assert.match(
      violations.find((v) => v.startsWith("I1")) ?? "",
      /^I1 PR #1193 @ff1c72db: 2 operative Ally User seat reviews/,
    );
  });

  it("rejects a lookalike identity even when it carries the User-seat ID", () => {
    const [app, user] = appAndSeatReviews();
    const reviews = [app, { ...user, user: { login: "blockcast-ally", id: ALLY_USER_REVIEWER_ID } }];
    const violations = findPrViolations({ number: 1194, headSha: HEAD, reviews });

    assert.deepEqual(operativeAllyReviews(reviews, HEAD, "seat"), []);
    assert.equal(violations.filter((v) => v.startsWith("I1")).length, 0);
  });

  it("rejects a canonical login with an unexpected immutable ID", () => {
    const [app, user] = appAndSeatReviews();
    const reviews = [
      app,
      { ...user, user: { login: ALLY_USER_REVIEWER_LOGIN, id: 42, type: "User" } },
    ];
    const violations = findPrViolations({ number: 1195, headSha: HEAD, reviews });

    assert.equal(violations.filter((v) => v.startsWith("I1")).length, 0);
    assert.equal(violations.filter((v) => v.startsWith("I5")).length, 1);
  });

  it("reports an unexpected immutable App ID at the runtime guard", () => {
    const [app, user] = appAndSeatReviews();
    const reviews = [
      { ...app, user: { login: ALLY_APP_REVIEWER_LOGIN, id: 42, type: "Bot" } },
      user,
    ];
    const violations = findPrViolations({ number: 1199, headSha: HEAD, reviews });

    assert.equal(violations.filter((v) => v.startsWith("I5")).length, 1);
    assert.match(violations.find((v) => v.startsWith("I5")) ?? "", /Ally App review 11 uses the canonical login\/type/);
  });

  it("reports an unexpected immutable User-seat ID at the runtime guard", () => {
    const [app, user] = appAndSeatReviews();
    const reviews = [
      app,
      { ...user, user: { login: ALLY_USER_REVIEWER_LOGIN, id: 42, type: "User" } },
    ];
    const violations = findPrViolations({ number: 1200, headSha: HEAD, reviews });

    assert.equal(violations.filter((v) => v.startsWith("I5")).length, 1);
    assert.match(violations.find((v) => v.startsWith("I5")) ?? "", /Ally User seat review 12 uses the canonical login\/type/);
  });

  it("rejects a seat submission regardless of the state it carries", () => {
    const [app, user] = appAndSeatReviews({}, { state: "COMMENTED" });
    const reviews = [app, user];
    const violations = findPrViolations({ number: 1196, headSha: HEAD, reviews });

    assert.deepEqual(violations, [
      "I6 PR #1196 @ff1c72db: Ally User seat review 12 is COMMENTED — the User seat (uid 296676656) never submits a verdict (R4, BLO-24056); only the App (uid 290875700) may carry one",
    ]);
  });

  it("still reports the App attestation defects when a seat review is present", () => {
    const [app, user] = appAndSeatReviews({ body: "Approved without an attestation." });
    const reviews = [app, user];
    const violations = findPrViolations({ number: 1197, headSha: HEAD, reviews });

    assert.equal(violations.filter((v) => v.startsWith("I1")).length, 0);
    assert.equal(violations.filter((v) => v.startsWith("I2d")).length, 1);
    assert.equal(violations.filter((v) => v.startsWith("I3")).length, 1);
  });

  it("still reports a stale App attestation when a seat review is present", () => {
    const [app, user] = appAndSeatReviews({ body: `## Ally — Consolidated PR Review\nReviewed head: ${OTHER}` });
    const reviews = [app, user];
    const violations = findPrViolations({ number: 1198, headSha: HEAD, reviews });

    assert.equal(violations.filter((v) => v.startsWith("I1")).length, 0);
    assert.equal(violations.filter((v) => v.startsWith("I3")).length, 1);
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

const REAL_I1_1525 =
  "I1 PR #1525 @05325ee7: 2 operative Ally App reviews (COMMENTED/5043498525, COMMENTED/5059936287) — expected at most 1 in the app lane";
const REAL_I3_1525 =
  "I3 PR #1525 @05325ee7: Ally App review 5059936287 is not canonical — expected one consolidated-review heading and one Reviewed head attestation";

function entry(overrides = {}) {
  return {
    fingerprint: "I1:1525:05325ee7:5043498525,5059936287",
    pr: 1525,
    issue: "PEN-2847",
    note: "known",
    ...overrides,
  };
}

describe("violationFingerprint", () => {
  it("pins code, PR, head and review IDs", () => {
    assert.equal(violationFingerprint(REAL_I1_1525), "I1:1525:05325ee7:5043498525,5059936287");
    assert.equal(violationFingerprint(REAL_I3_1525), "I3:1525:05325ee7:5059936287");
  });

  it("ignores the prose, so rewording a message does not move it out from under its baseline", () => {
    const reworded = REAL_I1_1525.replace(
      "— expected at most 1 in the app lane",
      "— only one operative review is permitted per lane, see BLO-19778",
    );
    assert.equal(violationFingerprint(reworded), violationFingerprint(REAL_I1_1525));
  });

  it("changes when the PR is pushed to, so a baselined PR coming back to life is re-audited", () => {
    const pushed = REAL_I1_1525.replace("@05325ee7", "@deadbeef");
    assert.notEqual(violationFingerprint(pushed), violationFingerprint(REAL_I1_1525));
  });

  it("changes when a third review joins the same head, so an escalation is not suppressed", () => {
    const escalated = REAL_I1_1525.replace(
      "2 operative Ally App reviews (COMMENTED/5043498525, COMMENTED/5059936287)",
      "3 operative Ally App reviews (COMMENTED/5043498525, COMMENTED/5059936287, COMMENTED/5099999999)",
    );
    assert.notEqual(violationFingerprint(escalated), violationFingerprint(REAL_I1_1525));
  });

  it("distinguishes invariants and PRs that otherwise share a head", () => {
    assert.notEqual(violationFingerprint(REAL_I1_1525), violationFingerprint(REAL_I3_1525));
    assert.notEqual(
      violationFingerprint(REAL_I1_1525),
      violationFingerprint(REAL_I1_1525.replace("PR #1525", "PR #1526")),
    );
  });

  it("is stable across the real violation shapes this guard emits", () => {
    const reviews = [
      appReview({ id: 4911401804, state: "COMMENTED", body: canonicalBody() }),
      appReview({ id: 4913256943, state: "COMMENTED", body: "no heading, no attestation" }),
    ];
    const fingerprints = findPrViolations({ number: 1316, headSha: HEAD, reviews }).map(
      violationFingerprint,
    );
    assert.equal(new Set(fingerprints).size, fingerprints.length, "every violation gets a distinct key");
    for (const fingerprint of fingerprints) {
      assert.match(fingerprint, /^I[0-9a-z]+:1316:[0-9a-f]{8}:[\d,]+$/);
    }
  });
});

describe("parseBaseline", () => {
  it("accepts a well-formed document", () => {
    assert.deepEqual(parseBaseline(JSON.stringify({ entries: [entry()] })), [entry()]);
  });

  it("accepts an empty baseline — the state this guard should converge to", () => {
    assert.deepEqual(parseBaseline({ entries: [] }), []);
  });

  it("rejects a document with no entries array rather than treating it as empty", () => {
    for (const doc of [{}, { entries: null }, { entries: {} }]) {
      assert.throws(() => parseBaseline(doc), /must contain an "entries" array/);
    }
  });

  it("rejects invalid JSON", () => {
    assert.throws(() => parseBaseline("{nope"), /is not valid JSON/);
  });

  for (const field of ["fingerprint", "note", "issue"]) {
    it(`requires a non-empty ${field} so every suppression is attributable`, () => {
      assert.throws(
        () => parseBaseline({ entries: [entry({ [field]: "  " })] }),
        new RegExp(`needs a non-empty "${field}"`),
      );
      assert.throws(
        () => parseBaseline({ entries: [entry({ [field]: undefined })] }),
        new RegExp(`needs a non-empty "${field}"`),
      );
    });
  }

  it("requires an integer pr", () => {
    assert.throws(() => parseBaseline({ entries: [entry({ pr: "1525" })] }), /needs an integer "pr"/);
  });

  it("rejects a malformed fingerprint instead of letting it match nothing forever", () => {
    for (const fingerprint of ["I1:1525", "nonsense", "I1:1525:zzzz:1", "I1::05325ee7:1"]) {
      assert.throws(
        () => parseBaseline({ entries: [entry({ fingerprint })] }),
        /malformed "fingerprint"/,
      );
    }
  });

  it("rejects an entry whose pr disagrees with its fingerprint", () => {
    assert.throws(
      () => parseBaseline({ entries: [entry({ pr: 1304 })] }),
      /fingerprint names PR #1525 but "pr" says 1304/,
    );
  });

  it("rejects duplicate fingerprints", () => {
    assert.throws(() => parseBaseline({ entries: [entry(), entry()] }), /repeats fingerprint/);
  });
});

describe("applyBaseline", () => {
  it("suppresses a baselined violation", () => {
    const { failing, suppressed } = applyBaseline([REAL_I1_1525], [entry()]);
    assert.deepEqual(failing, []);
    assert.equal(suppressed.length, 1);
    assert.equal(suppressed[0].entry.issue, "PEN-2847");
  });

  it("fails a violation that is not baselined — the whole point of the ratchet", () => {
    const { failing } = applyBaseline([REAL_I1_1525, REAL_I3_1525], [entry()]);
    assert.equal(failing.length, 1);
    assert.equal(failing[0].violation, REAL_I3_1525);
    assert.equal(failing[0].fingerprint, "I3:1525:05325ee7:5059936287");
  });

  it("does not let a baselined PR suppress a different violation on itself", () => {
    const newFinding =
      "I2a PR #1525 @05325ee7: Ally App review 5043498525 is APPROVED but its body reports a Critical/Important finding";
    assert.equal(applyBaseline([newFinding], [entry()]).failing.length, 1);
  });

  it("does not let a baselined PR suppress the same violation on another PR", () => {
    const elsewhere = REAL_I1_1525.replace("PR #1525", "PR #1600");
    assert.equal(applyBaseline([elsewhere], [entry()]).failing.length, 1);
  });

  it("re-fails a baselined violation once the PR is pushed to", () => {
    const pushed = REAL_I1_1525.replace("@05325ee7", "@0a1b2c3d");
    assert.equal(applyBaseline([pushed], [entry()]).failing.length, 1);
  });

  it("with an empty baseline every violation fails, exactly as before the ratchet", () => {
    const { failing } = applyBaseline([REAL_I1_1525, REAL_I3_1525], []);
    assert.equal(failing.length, 2);
  });

  it("reports an entry that matches nothing without failing the run", () => {
    const { failing, staleEntries } = applyBaseline([], [entry()]);
    assert.deepEqual(failing, []);
    assert.equal(staleEntries.length, 1);
    assert.equal(staleEntries[0].pr, 1525);
  });

  it("treats a clean repo with a clean baseline as a pass", () => {
    assert.deepEqual(applyBaseline([], []), { failing: [], suppressed: [], staleEntries: [] });
  });
});

describe("the committed baseline", () => {
  const raw = readFileSync(
    new URL("./ally-review-consistency-baseline.json", import.meta.url),
    "utf8",
  );

  it("parses under the same validation the guard applies at runtime", () => {
    assert.ok(parseBaseline(raw).length > 0);
  });

  it("suppresses exactly the violation set measured on 2026-09-01 and nothing else", () => {
    const measured = [
      REAL_I1_1525,
      REAL_I3_1525,
      "I1 PR #1360 @6a7e86b8: 2 operative Ally App reviews (COMMENTED/5002830694, COMMENTED/5003133252) — expected at most 1 in the app lane",
      "I1 PR #1316 @0110ccd1: 2 operative Ally App reviews (COMMENTED/4911401804, COMMENTED/4913256943) — expected at most 1 in the app lane",
      "I3 PR #1316 @0110ccd1: Ally App review 4913256943 is not canonical — expected one consolidated-review heading and one Reviewed head attestation",
      "I1 PR #1304 @61360b5a: 2 operative Ally App reviews (COMMENTED/5062643059, COMMENTED/5062648138) — expected at most 1 in the app lane",
    ];
    const { failing, suppressed, staleEntries } = applyBaseline(measured, parseBaseline(raw));
    assert.deepEqual(failing, [], "the run goes green on the state that pinned it red");
    assert.equal(suppressed.length, measured.length);
    assert.deepEqual(staleEntries, [], "no entry suppresses something that is not happening");
  });

  it("still fails on a new violation alongside the baselined set", () => {
    const withNewFinding = [
      REAL_I1_1525,
      "I1 PR #1601 @abcdef12: 2 operative Ally App reviews (COMMENTED/5111111111, COMMENTED/5222222222) — expected at most 1 in the app lane",
    ];
    const { failing } = applyBaseline(withNewFinding, parseBaseline(raw));
    assert.equal(failing.length, 1);
    assert.match(failing[0].violation, /PR #1601/);
  });
});

/**
 * Peer review of #1721 at 97b4ddd1 — this reader counted verdict blocks over
 * the raw body while the gate counts them over fence-stripped text.
 *
 * Same body, different verdict across two of the four readers the PR's central
 * invariant names. It fires first on a review that quotes the template inside a
 * fence, which is the likeliest shape for a review *of this feature* — the same
 * self-referential trigger the block's own line anchoring exists for.
 */
describe("BLO-32695 — a fenced example of the marker is not a second block", () => {
  const block = (head) =>
    `<!-- ally-verdict:1\n{"head":"${head}","findings":{"critical":0,"important":0}}\n-->`;
  const body = (...rest) =>
    [block(HEAD), "", "## Ally — Consolidated PR Review", `Reviewed head: ${HEAD}`, ...rest].join("\n");

  it("reads the head through a fenced quote of the marker", () => {
    assert.equal(attestedHead(body("As emitted:", "", "```markdown", block(HEAD), "```")), HEAD);
  });

  it("control: a real second block is still unreadable", () => {
    // Without this the test above passes for a reader that stopped counting.
    assert.equal(attestedHead(body("", block(HEAD))), null);
  });

  it("control: a fenced opener alone does not mint a truncated-payload red", () => {
    // openers > blocks is the fail-closed branch; stripping fences has to move
    // both counts together or it trades one divergence for another.
    assert.equal(attestedHead(body("```markdown", "<!-- ally-verdict:1 {", "```")), HEAD);
  });

  it("reads the head through a tilde fence and through a longer backtick run", () => {
    // The case above pinned ``` only, so every other CommonMark fence the gate
    // handles stayed a divergence: this reader saw blocks=2 where the gate saw
    // one quoted example.
    for (const [open, close] of [
      ["~~~", "~~~"],
      ["````markdown", "````"],
    ]) {
      assert.equal(attestedHead(body("As emitted:", "", open, block(HEAD), close)), HEAD, open);
    }
  });

  it("only a same-char run at least as long closes a fence", () => {
    // Fence-length and fence-char matching are the halves a delimiter widening
    // leaves behind: if ``` closed a ```` fence, or ~~~ closed a ``` one, the
    // quoted block after it would re-appear as a second block.
    for (const [open, inner, close] of [
      ["````markdown", "```", "````"],
      ["```markdown", "~~~", "```"],
    ]) {
      assert.equal(
        attestedHead(body("As emitted:", "", open, block(HEAD), inner, block(HEAD), close)),
        HEAD,
        open,
      );
    }
  });

  it("an inline backtick span does not open a phantom fence", () => {
    // CommonMark bars a backtick from a backtick fence's info string. Without
    // that rule this line opens a fence that never closes, blanking the rest of
    // the body — so the second block goes unseen and an unreadable body reads
    // `ok`. Same assertion as the real-second-block control because the harm is
    // masking exactly that.
    assert.equal(attestedHead(body("``` `example` is prose, not a fence opener", block(HEAD))), null);
  });
});
