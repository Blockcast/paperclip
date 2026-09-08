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
import { redactSensitiveText } from "../redaction.js";
import { compactRunLogChunk } from "../services/heartbeat.js";

const HEAD = "ghs_NOTAREALTOKEN0123456789abcdef";
const PAYLOAD = "eyJOT1RBUkVBTFBBWUxPQUQiOjF9";
const SIGNATURE = "NOTAREALSIGNATURE0123456789abcdefXYZ";
/** The real emitted shape: a `ghs_` head with JWT-like dotted segments. */
const COMPOSITE = `${HEAD}.${PAYLOAD}.${SIGNATURE}`;
const PLAIN_GHS = "ghs_NOTAREALPLAINTOKEN0123456789abcd";
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
    // The tail repetition used to be `?`, capping JWT at four segments. In a
    // longer run it consumed the leftmost four and stranded the rest.
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
});
