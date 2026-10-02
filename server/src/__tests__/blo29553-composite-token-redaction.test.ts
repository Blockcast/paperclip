/**
 * BLO-29553: `gh auth status` printed a GitHub App installation token into a
 * persisted run transcript even though value-shaped matchers for both `ghs_`
 * and JWT had existed since 2026-04-30 and the transcript write path already
 * runs every chunk through them.
 *
 * The matchers were not absent -- they were mutually destructive. The token
 * `gh` emits is a COMPOSITE, `ghs_<seg>.<b64url>.<b64url>`. Applying the
 * prefix rule first replaced only the `ghs_` head with `***REDACTED***`, and
 * because `*` is outside `[A-Za-z0-9_-]` that replacement destroyed the
 * three-segment structure the JWT rule matches on. The payload and signature
 * were then persisted verbatim: 2 of 3 segments surviving.
 *
 * These cases pin the ordering invariant (widest value shape first) and the
 * `github_pat_` gap found alongside it. A rule that redacts a PREFIX of
 * another rule's match must never run before it.
 *
 * Every credential-shaped value in this file is synthetic and has never been
 * live. Do not paste real values into fixtures.
 */
import { describe, expect, it } from "vitest";
import { redactCommandText } from "@paperclipai/adapter-utils";
import { redactSensitiveText } from "../redaction.js";
import { compactRunLogChunk } from "../services/heartbeat.js";

const HEAD = "ghs_NOTAREALTOKEN0123456789abcdef";
const PAYLOAD = "eyJOT1RBUkVBTFBBWUxPQUQiOjF9";
const SIGNATURE = "NOTAREALSIGNATURE0123456789abcdefXYZ";
/** The real emitted shape: a `ghs_` head with JWT-like dotted segments. */
const COMPOSITE = `${HEAD}.${PAYLOAD}.${SIGNATURE}`;
const PLAIN_GHS = "ghs_NOTAREALPLAINTOKEN0123456789abcd";
/** Synthetic, never live. Used only to pin the OpenAI-last ordering invariant. */
const OPENAI_KEY = "sk-NOTAREALOPENAIKEY0123456789";
const FINE_GRAINED_PAT =
  "github_pat_11NOTAREAL0abcdefghijklmn_NOTAREALSECRETPART0123456789abcdefghij";

/** `gh auth status` output, as the harness actually renders it. */
const GH_AUTH_STATUS = [
  "github.com",
  "  ✓ Logged in to github.com account allyblockcast[bot] (GH_TOKEN)",
  "  - Active account: true",
  "  - Git operations protocol: https",
  `  - Token: ${COMPOSITE}`,
  "  - Token scopes: 'repo', 'workflow'",
].join("\n");

describe("BLO-29553: composite token redaction", () => {
  it("leaves no segment of a composite gh token in redacted text", () => {
    const out = redactSensitiveText(`  - Token: ${COMPOSITE}`);
    // The pre-fix behaviour redacted the head and kept these two.
    for (const [label, segment] of [
      ["head", HEAD],
      ["payload", PAYLOAD],
      ["signature", SIGNATURE],
    ] as const) {
      expect(out, `${label} segment must not survive redaction`).not.toContain(segment);
    }
    expect(out).not.toContain(COMPOSITE);
  });

  it("redacts the composite token in full gh auth status output", () => {
    const out = redactSensitiveText(GH_AUTH_STATUS);
    expect(out).not.toContain(PAYLOAD);
    expect(out).not.toContain(SIGNATURE);
    // Surrounding diagnostic structure is preserved -- this is a value-shaped
    // rule, not a line-blanking one.
    expect(out).toContain("Logged in to github.com account");
    expect(out).toContain("Token scopes");
  });

  it("redacts the composite token on the persisted transcript write path", () => {
    // compactRunLogChunk is the function every stdout/stderr chunk passes
    // through before runLogStore.append(), so this is the end-to-end guarantee
    // rather than a unit assertion about a regex.
    const out = compactRunLogChunk(GH_AUTH_STATUS);
    expect(out).not.toContain(PAYLOAD);
    expect(out).not.toContain(SIGNATURE);
    expect(out).not.toContain(HEAD);
  });

  it("still redacts a plain non-composite gh token (no reorder regression)", () => {
    const out = redactSensitiveText(`  - Token: ${PLAIN_GHS}`);
    expect(out).not.toContain(PLAIN_GHS);
    expect(out).toContain("***REDACTED***");
  });

  it("redacts a bare fine-grained PAT with no hint word and no dot", () => {
    // The prefilter short-circuits on text carrying no hint, no `://` and no
    // `.`, so this case needs both the hint entry and the rule.
    const out = redactSensitiveText(FINE_GRAINED_PAT);
    expect(out).not.toContain(FINE_GRAINED_PAT);
  });

  it("does not redact benign text that merely resembles a secret", () => {
    for (const benign of [
      "#!/usr/bin/env bash\necho hi",
      "see https://example.com:8080/path for detail",
      "git rev-parse HEAD^{tree}",
    ]) {
      expect(redactSensitiveText(benign), `must not alter: ${benign}`).toBe(benign);
    }
  });

  // `git rev-parse HEAD^{tree}` above carries no hint word, no `://` and no `.`,
  // so `maybeContainsSecretText` short-circuits and no value-shape rule ever
  // runs on it -- it is a prefilter control, not an over-redaction control.
  // These carry a `.`, so they reach the rules the fixes touched.
  it("does not redact benign dotted text that reaches the value-shape rules", () => {
    for (const benign of [
      // Every rule below is exercised; none may match.
      "service.platform.retries.maxAttempts",
      "example.com",
      "packages/adapter-utils/src/command-redaction.ts",
      "reconciled 4 rows in 0.42s across api.internal.svc.cluster.local",
    ]) {
      expect(redactSensitiveText(benign), `must not alter: ${benign}`).toBe(benign);
    }
  });

  // The benign list above tops out at four short labels, so it never reaches the
  // boundary the `?`->`*` widening on COMMAND_JWT_RE's tail actually moved. That
  // boundary is pinned here instead of left incidental: the tail is unbounded
  // now, so a benign dotted run of >=5 segments of >=8 chars is redacted WHOLE,
  // where under `?` everything past the 4th segment survived.
  //
  // This over-redaction is INTENDED, not a defect. For a redaction function,
  // losing a benign dotted string from a transcript is far cheaper than
  // stranding a segment of a live token, which is the exact failure BLO-29553
  // was filed for. Asserting it here makes that trade a decision on the record,
  // so a future reader meets it as a choice rather than as a surprise.
  it("over-redacts a long benign dotted run -- accepted cost of the unbounded JWT tail", () => {
    // 4 segments: redacted whole under BOTH `?` and `*`. Pre-existing on master,
    // untouched by this PR -- included so the 5-segment case below is read as a
    // boundary that MOVED, not as a cost this PR introduced from nothing.
    expect(redactSensitiveText("staging-blockcastd.staging-orc8r.staging-infra.rks-staging")).toBe(
      "***REDACTED***",
    );
    // 5 segments: redacted whole ONLY because the tail group is now `*`. This is
    // the case the widening changed; under `?` it kept `production-orc8r`.
    expect(
      redactSensitiveText(
        "staging-blockcastd.staging-orc8r.staging-infra.rks-staging.production-orc8r",
      ),
    ).toBe("***REDACTED***");
  });

  describe("AC1(a) composite shape family", () => {
    // Enumerated deliberately rather than stated as an unbounded absolute: "no
    // segment of any composite ever survives" is not provable over arbitrary
    // input. This is the family named in the acceptance criteria -- 2..6
    // dot-joined segments, a short (<8-char) middle segment, each embedded in a
    // dotted run with 0..2 context segments on either side.
    const contextSegment = (side: string, i: number) => `ctxsegment${side}${i}`;
    const tokenSegment = (i: number) => `SEG${i}NOTAREALSEGMENT${i}`;
    const SHORT_MIDDLE = "ab";

    const cases: {
      name: string;
      input: string;
      /** Segments that must not survive. The short middle is excluded: two
       *  characters cannot be asserted absent from arbitrary text. */
      mustNotSurvive: string[];
    }[] = [];

    for (const segmentCount of [2, 3, 4, 5, 6]) {
      for (const shortMiddle of [false, true]) {
        for (const leftContext of [0, 1, 2]) {
          for (const rightContext of [0, 1, 2]) {
            const tail: string[] = [];
            for (let i = 1; i < segmentCount; i += 1) {
              tail.push(shortMiddle && i === 1 ? SHORT_MIDDLE : tokenSegment(i));
            }
            const composite = [HEAD, ...tail].join(".");
            const run: string[] = [];
            for (let i = 0; i < leftContext; i += 1) run.push(contextSegment("L", i));
            run.push(composite);
            for (let i = 0; i < rightContext; i += 1) run.push(contextSegment("R", i));
            cases.push({
              name:
                `${segmentCount} segments`
                + `${shortMiddle ? ", short middle" : ""}`
                + `, ${leftContext} left / ${rightContext} right context`,
              input: `  - Token: ${run.join(".")}`,
              // SHORT_MIDDLE is excluded because it is only 2 chars: it recurs
              // constantly in ordinary prose, so asserting its absence would
              // fail on text that leaked nothing. Consequence worth stating —
              // at segmentCount 2 with shortMiddle the composite is
              // `HEAD.<short>`, so this list reduces to `[HEAD]` and the case
              // asserts strictly less than the others. It is retained because
              // HEAD is the part that identifies the credential, and the
              // dedicated `short middle segment` boundary case below pins the
              // stranded-tail shape with a full-length signature.
              mustNotSurvive: [HEAD, ...tail.filter((segment) => segment !== SHORT_MIDDLE)],
            });
          }
        }
      }
    }

    it.each(cases)("leaves no token segment for $name", ({ input, mustNotSurvive }) => {
      for (const path of [redactSensitiveText, compactRunLogChunk]) {
        const out = path(input);
        // Non-vacuity guard: an absent segment must mean "redacted", never
        // "truncated" or "blanked". compactRunLogChunk truncates long chunks.
        expect(out, "surrounding structure must survive").toContain("- Token: ");
        expect(out).not.toContain("paperclip truncated");
        expect(out).toContain("***REDACTED***");
        for (const segment of mustNotSurvive) {
          expect(out, `${segment} survived ${path.name}(${input})`).not.toContain(segment);
        }
      }
    });
  });

  // The two boundary cases Ally's review named. They are inside the family
  // above, but pinned separately so a future edit to the generator cannot drop
  // them silently -- each corresponds to one of the two fixes.
  it("boundary: a >4-segment dotted run leaves no token segment (JWT tail cap)", () => {
    // Historical: the tail repetition used to be `?`, capping JWT at four
    // segments, and in a longer run it consumed the leftmost four and stranded
    // the rest. NOTE this case no longer *proves* that guard -- see the
    // no-gh-prefix case below, which does. Kept because it pins the composite
    // family's upper boundary against the real chain.
    const segments = [
      "ctxsegmentL0",
      "ctxsegmentL1",
      HEAD,
      PAYLOAD,
      SIGNATURE,
      "ctxsegmentR0",
    ];
    const out = compactRunLogChunk(`  - Token: ${segments.join(".")}`);
    for (const segment of [HEAD, PAYLOAD, SIGNATURE]) {
      expect(out, `${segment} must not survive a >4-segment dotted run`).not.toContain(segment);
    }
  });

  it("boundary: a >4-segment dotted run with NO gh prefix (the only shape the JWT tail cap reaches)", () => {
    // The case above no longer exercises the `*`: COMMAND_GITHUB_TOKEN_RE is
    // self-sufficient now, so it consumes a `ghs_`-headed run whole before JWT
    // ever runs, and reverting the tail to `?` leaves that test green. Measured
    // 2026-10-02 -- the whole suite passed 104/104 against a `?` mutation.
    //
    // A credential that is only JWT-SHAPED has no prefix rule to own it, so JWT
    // is the sole rule that can match and its cap is load-bearing. With `?` the
    // fifth segment survives verbatim; with `*` the run goes whole. This is the
    // failing mutation for that guard.
    const jwtOnly = [
      "jwtheader0NOTREAL",
      "jwtpayload1NOTREAL",
      "jwtsignature2NOTREAL",
      "jwtextra3NOTREAL",
      "jwtextra4NOTREAL",
    ];
    const out = compactRunLogChunk(`  - Token: ${jwtOnly.join(".")}`);
    for (const segment of jwtOnly) {
      expect(out, `${segment} must not survive a >4-segment JWT-shaped run`).not.toContain(segment);
    }
  });

  it("boundary: OpenAI-last is load-bearing — a dotted sk- value must not strand its tail", () => {
    // The ordering comment claims COMMAND_OPENAI_KEY_RE stays last "precisely
    // because it is prefix-anchored and NOT self-sufficient: ahead of JWT it
    // would reintroduce the original bug on a dotted value". Measured
    // 2026-10-02, that claim was defended by prose alone -- moving the rule
    // ahead of JWT left the whole suite green at 105/105, because no case here
    // carried a dotted `sk-` value. This is the failing mutation for it.
    //
    // `sk-` keys are not dotted in the wild; the shape is chosen because it is
    // what makes the ordering observable, which is the thing being pinned.
    //
    // Residual, stated rather than asserted away: a TWO-segment `sk-x.y` still
    // strands `y` under either order, since JWT needs three segments and
    // COMMAND_OPENAI_KEY_RE carries no tail of its own. Not closed here -- a
    // `(?:\.…)*` tail on a 3-character prefix is a wider over-redaction trade
    // than the real (undotted) shape justifies.
    const dottedOpenAiKey = `${OPENAI_KEY}.${PAYLOAD}.${SIGNATURE}`;
    const out = compactRunLogChunk(`  - Key: ${dottedOpenAiKey}`);
    for (const segment of [OPENAI_KEY, PAYLOAD, SIGNATURE]) {
      expect(out, `${segment} must not survive a dotted sk- value`).not.toContain(segment);
    }
  });

  it("boundary: a 2-segment composite leaves no token segment (JWT cannot start)", () => {
    // JWT needs three segments, so this shape has no JWT match at all. Only a
    // self-sufficient GitHub rule covers it.
    const out = compactRunLogChunk(`  - Token: ${HEAD}.${PAYLOAD}`);
    expect(out).not.toContain(HEAD);
    expect(out).not.toContain(PAYLOAD);
  });

  it("boundary: a short middle segment leaves no token segment", () => {
    // JWT stops at `ab`, stranding the signature. Same fix as above.
    const out = compactRunLogChunk(`  - Token: ${HEAD}.ab.${SIGNATURE}`);
    expect(out).not.toContain(HEAD);
    expect(out).not.toContain(SIGNATURE);
  });

  it("redacts a composite fine-grained PAT in full", () => {
    const composite = `${FINE_GRAINED_PAT}.${PAYLOAD}.${SIGNATURE}`;
    const out = compactRunLogChunk(`  - Token: ${composite}`);
    for (const segment of [FINE_GRAINED_PAT, PAYLOAD, SIGNATURE]) {
      expect(out, `${segment} must not survive`).not.toContain(segment);
    }
  });

  /**
   * Suggestion 3 from Ally's at-head review: the rule ORDER and the two regex
   * shapes are load-bearing, but until now only a prose comment said so. A
   * comment cannot fail, so a future reorder would ship silently -- the family
   * cases above would still pass, because they only assert the CURRENT chain is
   * correct, never that a plausible alternative is wrong.
   *
   * These two cases execute the historical shapes and require them to LEAK.
   * That is the mutation check for the ordering: if someone "simplifies" the
   * self-sufficient tail away, or re-caps the JWT tail, the corresponding case
   * here stops leaking and fails.
   *
   * The mirrored chains below are validated against the real `redactCommandText`
   * first, so they cannot silently drift out of step with the source they model.
   */
  describe("ordering invariant is executable, not just documented", () => {
    // Historical shapes, reproduced exactly as they were before this fix.
    const GITHUB_PREFIX_ONLY_RE = /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g;
    const JWT_TAIL_CAPPED_RE =
      /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{8,})?\b/g;
    // Current shapes.
    const GITHUB_SELF_SUFFICIENT_RE = /\bgh[pousr]_[A-Za-z0-9_]{20,}(?:\.[A-Za-z0-9_-]+)*\b/g;
    const JWT_TAIL_UNBOUNDED_RE =
      /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{8,})*\b/g;
    const R = "***REDACTED***";

    const currentChain = (text: string) =>
      text.replace(GITHUB_SELF_SUFFICIENT_RE, R).replace(JWT_TAIL_UNBOUNDED_RE, R);

    it("the mirrored current chain reproduces redactCommandText (pins the mirror)", () => {
      // If this fails, the mirror has drifted from the source and the two leak
      // assertions below are no longer evidence about production behaviour.
      // Inputs deliberately carry no `-flag`/`name=` shape, so only the
      // value-shape rules the mirror models can fire; any divergence therefore
      // means the modelled rules themselves diverged.
      //
      // SCOPE, so "pins the mirror" is not trusted further than it reaches:
      // `currentChain` models TWO of the eight rules in redactCommandText -- the
      // two this fix touches. It is deliberately not a model of the whole chain,
      // and it cannot notice a divergence introduced in any of the other six
      // (AWS, Google, Slack, PEM, the fine-grained PAT rule, OpenAI). What this
      // test pins is that the two modelled rules still behave as the leak
      // assertions below assume -- nothing wider.
      for (const input of [
        COMPOSITE,
        `Token ${COMPOSITE}`,
        `${HEAD}.${PAYLOAD}`,
        `${HEAD}.ab.${SIGNATURE}`,
        `ctxsegmentL0.${COMPOSITE}.ctxsegmentR0`,
        PLAIN_GHS,
      ]) {
        expect(currentChain(input), `mirror diverged on ${input}`).toBe(redactCommandText(input));
      }
    });

    it("an untailed GitHub rule ahead of JWT strands payload and signature", () => {
      // The original BLO-29553 bug: the prefix match inserts `*`, which is
      // outside `[A-Za-z0-9_-]`, so JWT can no longer see three segments.
      const leaked = COMPOSITE.replace(GITHUB_PREFIX_ONLY_RE, R).replace(JWT_TAIL_UNBOUNDED_RE, R);
      expect(leaked, "payload must leak under the historical order").toContain(PAYLOAD);
      expect(leaked, "signature must leak under the historical order").toContain(SIGNATURE);
      // ...and the current chain must close exactly that case.
      expect(currentChain(COMPOSITE)).not.toContain(PAYLOAD);
      expect(currentChain(COMPOSITE)).not.toContain(SIGNATURE);
    });

    it("a 4-segment-capped JWT tail strands the segment past the cap", () => {
      // Second fix. With `?` the JWT rule takes the leftmost four segments of a
      // longer dotted run greedily and leaves the remainder in the clear.
      const run = ["ctxsegmentL0", "ctxsegmentL1", HEAD, PAYLOAD, SIGNATURE].join(".");
      const leaked = run.replace(JWT_TAIL_CAPPED_RE, R);
      expect(leaked, "a token segment must leak under the capped tail").toContain(SIGNATURE);
      expect(run.replace(JWT_TAIL_UNBOUNDED_RE, R)).not.toContain(SIGNATURE);
    });
  });
});
