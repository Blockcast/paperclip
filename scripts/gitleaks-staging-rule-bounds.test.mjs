/**
 * gitleaks-staging-rule-bounds.test.mjs — PEN-6280.
 *
 * The `opaque-high-entropy-token` staging rule is bounded `{32,120}`, and its
 * regex requires a non-token boundary on BOTH sides, so every character of a
 * token run must fall inside the match: a run LONGER than 120 cannot match at
 * any offset. That upper bound is a real coverage hole and it skews the wrong
 * way — a 128-byte key base64s to 172 characters, so the shapes the rule
 * misses are LARGER than the ones it catches.
 *
 * WHY THIS TEST EXISTS, which is not the same as why the bound exists.
 * `.gitleaks-staging.toml` carries an ACCEPTED RESIDUAL RISK paragraph that
 * PEN-6170 ruling (b) makes mandatory, and that paragraph is a three-clause
 * enumeration ending "a value failing ANY ONE of those three is covered by ...
 * the entropy lane under (A)". Clause (3) is defined by ENTROPY ALONE, so a
 * >120-character opaque token satisfies (1) and (2), fails (3), and is
 * therefore asserted by the header to be covered — by a rule that cannot match
 * it. That is an overstatement in the PERMISSIVE direction, found at
 * `5ec6f84f` and amended the same day.
 *
 * So the defect this guards is DRIFT BETWEEN THE PROSE AND THE PATTERN, and
 * the two halves are pinned TOGETHER and keyed to the SAME parsed number: edit
 * `{32,120}` without editing the header and the prose assertions red, because
 * they look for the bound the regex actually has rather than a hardcoded 120.
 *
 * FOUR MECHANISMS, FOUR ASSERTIONS, DELIBERATELY NOT COLLAPSED — a single
 * assertion covering several mechanisms is a guard no mutation can red.
 *
 * ⚠️ ON THE INSTRUMENT. These boundary cases are asserted here with the JS
 * regex engine, which is a PROXY for gitleaks' Go RE2. The construct carries
 * no lookaround and no backreference, so the two agree on it — and that is not
 * assumed: the same points were measured first-party 2026-11-09 against the
 * PINNED gitleaks 8.28.0 binary itself, on this exact config, and the pinned
 * expectations below are that binary's output (HIT 32/40/43/119/120, NO HIT
 * 31/121/122/150/200). If this test and the binary ever disagree, the BINARY
 * is right and this file is the thing that is wrong.
 *
 * ⚠️ SCOPE: this pins the rule's LENGTH reach, which is the regex's business.
 * The entropy floor is a SECOND, independent filter applied to the same match,
 * so a string passing these assertions is not thereby a finding. The two
 * mechanisms buy different things and neither is redundant (see the config's
 * own note on the exclusion list).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const STAGING_TOML = join(REPO_ROOT, ".gitleaks-staging.toml");
const PR_WORKFLOW = join(REPO_ROOT, ".github/workflows/pr.yml");

const toml = readFileSync(STAGING_TOML, "utf8");
const workflow = readFileSync(PR_WORKFLOW, "utf8");

const RULE_ID = "opaque-high-entropy-token";

/** The rule's regex, read from the shipped config rather than restated here. */
function readRuleRegex() {
  const rule = toml.split("[[rules]]").find(b => b.includes(`id = "${RULE_ID}"`));
  assert.ok(rule, `no [[rules]] block with id = "${RULE_ID}"`);
  const m = rule.match(/regex\s*=\s*'''([\s\S]*?)'''/);
  assert.ok(m, `rule ${RULE_ID} has no ''' quoted regex`);
  return m[1];
}

/** The {min,max} the regex actually declares — the number the prose must cite. */
function readDeclaredBounds(regex) {
  const m = regex.match(/\{(\d+),(\d+)\}/);
  assert.ok(m, "rule regex declares no {min,max} length quantifier");
  return { min: Number(m[1]), max: Number(m[2]) };
}

/** A mixed-alphabet token of length n — the shape the rule is aimed at. */
function token(n) {
  const al = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let s = "";
  for (let i = 0; i < n; i += 1) s += al[(i * 7 + 3) % al.length];
  return s;
}

const RULE_REGEX = readRuleRegex();
const BOUNDS = readDeclaredBounds(RULE_REGEX);

function matchesBare(n) {
  return new RegExp(RULE_REGEX).test(`PLACEHOLDER ${token(n)}\n`);
}

describe("mechanism 1: the rule's length reach is exactly its declared {min,max}", () => {
  // Pinned from the gitleaks 8.28.0 binary, 2026-11-09. Asserting the ENDS
  // and the characters either side of them is what makes this a boundary
  // test rather than a spot check: a quantifier widened in either direction
  // reds here before anything downstream notices.
  it("matches at the declared minimum and maximum", () => {
    assert.equal(matchesBare(BOUNDS.min), true, `expected a hit at L=${BOUNDS.min}`);
    assert.equal(matchesBare(BOUNDS.max), true, `expected a hit at L=${BOUNDS.max}`);
    assert.equal(matchesBare(BOUNDS.max - 1), true, `expected a hit at L=${BOUNDS.max - 1}`);
  });

  it("does NOT match one character outside either end", () => {
    assert.equal(matchesBare(BOUNDS.min - 1), false, `unexpected hit at L=${BOUNDS.min - 1}`);
    assert.equal(matchesBare(BOUNDS.max + 1), false, `unexpected hit at L=${BOUNDS.max + 1}`);
  });

  it("does NOT match far above the maximum — the hole is not a near-miss", () => {
    // A 128-byte key base64s to 172. These are the shapes that get missed.
    for (const n of [BOUNDS.max + 2, 150, 172, 200]) {
      assert.equal(matchesBare(n), false, `unexpected hit at L=${n}`);
    }
  });

  it("agrees with the pinned binary's measured verdicts", () => {
    const MEASURED_HIT = [32, 40, 43, 119, 120];
    const MEASURED_MISS = [31, 121, 122, 150, 200];
    for (const n of MEASURED_HIT) assert.equal(matchesBare(n), true, `binary saw a hit at L=${n}`);
    for (const n of MEASURED_MISS) assert.equal(matchesBare(n), false, `binary saw no hit at L=${n}`);
  });
});

describe("mechanism 2: the coverage gradient states the upper bound", () => {
  it("names the maximum the regex actually declares as out of scope", () => {
    const section = toml.split("ACCEPTED RESIDUAL RISK")[0];
    assert.match(
      section,
      new RegExp(`longer than ${BOUNDS.max} characters\\s+out of scope by construction`),
      `the coverage gradient must state that >${BOUNDS.max} characters is out of scope. ` +
        `If the regex bound moved, move this line with it — do not relax the test.`,
    );
  });
});

describe("mechanism 3: the accepted-residual paragraph is not a closed enumeration", () => {
  // The ruled text defines clause (3) by entropy alone. Read as closed, it
  // asserts the entropy lane covers a >max opaque token. It cannot match one.
  it("states that the entropy lane's reach is additionally bounded by length", () => {
    const section = toml.slice(toml.indexOf("ACCEPTED RESIDUAL RISK"));
    assert.ok(section.length > 0, "no ACCEPTED RESIDUAL RISK section");
    assert.match(
      section,
      new RegExp(`LONGER THAN ${BOUNDS.max} CHARACTERS`),
      `the residual paragraph must say that an opaque value longer than ` +
        `${BOUNDS.max} characters is reached by NONE of the three named controls.`,
    );
    assert.match(
      section,
      new RegExp(`between ${BOUNDS.min} and ${BOUNDS.max} characters`),
      "the residual paragraph must bound the entropy lane's reach explicitly",
    );
  });
});

describe("mechanism 4: no carrier makes the unqualified 'gates nothing' claim", () => {
  // `continue-on-error` is a STEP property. It does not cover the JOB's
  // timeout budget, and this job's capped steps sum to 28 against a budget of
  // 20 with two steps uncapped — so a staging finding blocks nothing, while
  // this step's RUNTIME can help cancel the job, which DOES fail `verify`.
  //
  // Conjunction form, deliberately: retiring text PRESENT *and* no retraction
  // marker on the SAME LINE. A bare substring search cannot tell a live claim
  // from a correctly re-quoted withdrawal of it, and this repo's convention is
  // to re-quote withdrawn wording in place.
  const RETIRED = /(THIS STEP GATES NOTHING|THIS FILE GATES NOTHING)/;

  for (const [label, text] of [[".gitleaks-staging.toml", toml], ["pr.yml", workflow]]) {
    it(`${label} carries no unqualified claim on an unmarked line`, () => {
      const live = text
        .split("\n")
        .map((line, i) => [i + 1, line])
        .filter(([, line]) => RETIRED.test(line) && !/WITHDRAWN|NARROWED/.test(line));
      assert.deepEqual(
        live,
        [],
        `unqualified "gates nothing" claim on ${label}: a reader who stops at that ` +
          `line concludes this step cannot affect the merge verdict, and the job-budget ` +
          `path means it can. Narrow the claim or mark the line as withdrawn.`,
      );
    });
  }
});
