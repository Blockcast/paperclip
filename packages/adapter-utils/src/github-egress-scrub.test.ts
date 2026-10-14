import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  ENVIRONMENT_DUMP_MIN_RUN,
  GITHUB_EGRESS_REGION_CLASSES,
  type GitHubEgressScrubClass,
  locateGitHubEgressMatches,
  redactionMarker,
  scrubGitHubEgressText,
} from "./github-egress-scrub.js";

// Every fixture below is SYNTHETIC. Nothing here is copied from the PEN-2526
// exposure, and nothing here is or was a live credential. The values are shaped
// to trip the detectors and nothing more; see the ticket's standing rule
// against pasting real material into tests "to make it realistic".
const SYNTHETIC_PEM_BODY = [
  "U1lOVEhFVElDLU5PVC1BLVJFQUwtS0VZLXBhZGRpbmctbGluZS1vbmUtLS0tLS0t",
  "U1lOVEhFVElDLU5PVC1BLVJFQUwtS0VZLXBhZGRpbmctbGluZS10d28tLS0tLS0t",
].join("\n");

const SYNTHETIC_PEM = [
  "-----BEGIN RSA PRIVATE KEY-----",
  SYNTHETIC_PEM_BODY,
  "-----END RSA PRIVATE KEY-----",
].join("\n");

// Header decodes to {"alg":"HS256","typ":"JWT"} — the standard example header.
const SYNTHETIC_JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.c3ludGhldGljLXBheWxvYWQtbm90LXJlYWw.c3ludGhldGljLXNpZ25hdHVyZQ";

// High per-character entropy, obviously fake, mixed case + digits.
const SYNTHETIC_OPAQUE_VALUE = "s7Kq2Vt9Lm4Xb8Nd3Wp6Zc1Yr5Hj0Tg";
// A 20-letter run, derived rather than written out for the same reason: as a
// literal it is itself credential-shaped and the publish guard refuses it.
const LONG_LEXICAL_TAIL = "abcdefghijklmnopqrstuvwxyz".slice(0, 20);

// PEN-3907 fixtures. DERIVED, not pasted: a 64-hex literal in `name="value"`
// form is exactly what the pre-push guard refuses, so a hardcoded digest here
// would make this very file unpushable from an agent seat until the fix it
// tests has already shipped. Deriving it also makes the fixture self-evidently
// a content digest rather than a value someone chose.
const SYNTHETIC_SHA256 = createHash("sha256").update("pen-3907 fixture").digest("hex");
const SYNTHETIC_SHA1 = createHash("sha1").update("pen-3907 fixture").digest("hex");
const SYNTHETIC_SHA512 = createHash("sha512").update("pen-3907 fixture").digest("hex");

// PEN-3932 fixtures. DERIVED for the same reason as the PEN-3907 ones above:
// an uppercase credential literal is exactly what this change teaches the
// guard to refuse, so pasting one would make this file unpushable the moment
// the fix it tests ships. Deriving from a hash also makes each fixture
// reproducibly random rather than a value someone chose to look random.
const SYNTHETIC_SHA256_UPPER = SYNTHETIC_SHA256.toUpperCase();

/** Canonical RFC 4648 base32 — `A-Z2-7`, the alphabet TOTP/HOTP seeds, recovery
 *  codes and base32-encoded keys all use, and uppercase by construction. */
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function syntheticBase32(length: number, label: string): string {
  const bytes = createHash("sha512").update(label).digest();
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += BASE32_ALPHABET[(bytes[i % bytes.length] as number) % 32] as string;
  }
  return out;
}
const SYNTHETIC_TOTP_SEED = syntheticBase32(40, "pen-3932 totp seed");

describe("scrubGitHubEgressText", () => {
  describe("byte-exact pass-through", () => {
    it("returns ordinary review prose completely unchanged", () => {
      const prose = [
        "## Review",
        "",
        "Two findings, both in `server/src/routes/issues.ts`.",
        "",
        "1. The ownership check at line 13284 precedes the `deletedAt` check, so a",
        "   delete on an already-tombstoned comment 403s instead of returning 200.",
        "2. `LOG_LEVEL=debug` is left on in the staging values file.",
        "",
        "Verified against fadb7ae179f334d46b25fc0b17b5268a9f157ca9 on master.",
        "Clone with git@github.com:Blockcast/paperclip.git and see",
        "https://github.com/Blockcast/paperclip/pull/1435 for context.",
        "",
        "Bumped the dep to 4.1.8 — see node_modules/.pnpm for the resolved tree.",
      ].join("\n");

      const result = scrubGitHubEgressText(prose);

      expect(result.text).toBe(prose);
      expect(result.redacted).toBe(false);
      expect(result.classes).toEqual([]);
    });

    it("does not reformat whitespace, trailing newlines, or CRLF endings", () => {
      const text = "line one\r\n\r\n  indented two\r\n\ttabbed three\r\n\r\n";
      const result = scrubGitHubEgressText(text);
      expect(result.text).toBe(text);
      expect(result.redacted).toBe(false);
    });

    it("leaves a short run of config assignments alone", () => {
      // Below the dump threshold and each value is ordinary config.
      const text = ["PORT=8080", "LOG_LEVEL=debug", "NODE_ENV=test"].join("\n");
      const result = scrubGitHubEgressText(text);
      expect(result.text).toBe(text);
      expect(result.redacted).toBe(false);
    });

    it("handles empty input", () => {
      expect(scrubGitHubEgressText("")).toEqual({ text: "", redacted: false, classes: [] });
    });
  });

  describe("detector: private-key-block", () => {
    it("redacts a complete PEM envelope as a single marker", () => {
      const result = scrubGitHubEgressText(`Here is the key:\n${SYNTHETIC_PEM}\nthanks`);

      expect(result.classes).toContain("private-key-block");
      expect(result.text).toBe(
        `Here is the key:\n${redactionMarker("private-key-block")}\nthanks`,
      );
      expect(result.text).not.toContain("BEGIN RSA PRIVATE KEY");
      expect(result.text).not.toContain(SYNTHETIC_PEM_BODY);
    });

    it("fails closed on an unterminated PEM envelope", () => {
      // A dump cut off by a length cap never emits the END line. Passing the
      // remainder through because the envelope is malformed is the whole bug.
      const truncated = `prefix\n-----BEGIN PRIVATE KEY-----\n${SYNTHETIC_PEM_BODY}`;
      const result = scrubGitHubEgressText(truncated);

      expect(result.classes).toContain("private-key-block");
      expect(result.text).toBe(`prefix\n${redactionMarker("private-key-block")}`);
      expect(result.text).not.toContain(SYNTHETIC_PEM_BODY);
    });
  });

  describe("detector: credentialed-uri", () => {
    it("redacts a URI carrying inline credentials", () => {
      const result = scrubGitHubEgressText(
        `Connect via postgres://dbuser:${SYNTHETIC_OPAQUE_VALUE}@db.internal:5432/app now.`,
      );

      expect(result.classes).toContain("credentialed-uri");
      expect(result.text).toBe(`Connect via ${redactionMarker("credentialed-uri")} now.`);
      expect(result.text).not.toContain(SYNTHETIC_OPAQUE_VALUE);
    });

    it("leaves an SSH remote and a plain https URL alone", () => {
      const text = "git@github.com:Blockcast/paperclip.git and https://api.github.com/repos/a/b";
      const result = scrubGitHubEgressText(text);
      expect(result.text).toBe(text);
      expect(result.redacted).toBe(false);
    });
  });

  describe("detector: jwt", () => {
    it("redacts a token whose header decodes to JSON carrying alg", () => {
      const result = scrubGitHubEgressText(`Authorization: Bearer ${SYNTHETIC_JWT}`);

      expect(result.classes).toContain("jwt");
      expect(result.text).toBe(`Authorization: Bearer ${redactionMarker("jwt")}`);
      expect(result.text).not.toContain(SYNTHETIC_JWT);
    });

    it("leaves a dotted identifier that is not a JWT alone", () => {
      // Matches the three-segment shape but the header does not decode to JSON.
      const text = "See mymodule.submodule.functions for the helper.";
      const result = scrubGitHubEgressText(text);
      expect(result.text).toBe(text);
      expect(result.redacted).toBe(false);
    });
  });

  describe("detector: vendor-key", () => {
    // Synthetic bodies: correct prefix and length, random-looking tail.
    const cases: Array<[string, string]> = [
      ["GitHub server token", "ghs_S7kq2Vt9Lm4Xb8Nd3Wp6Zc1Yr5Hj0TgAbCd"],
      ["GitHub PAT", "ghp_S7kq2Vt9Lm4Xb8Nd3Wp6Zc1Yr5Hj0TgAbCd"],
      ["Paperclip service key", "psk_S7kq2Vt9Lm4Xb8Nd3Wp6Zc1"],
      ["OpenAI key", "sk-S7kq2Vt9Lm4Xb8Nd3Wp6Zc1Yr5Hj0Tg"],
      ["Anthropic key", "sk-ant-S7kq2Vt9Lm4Xb8Nd3Wp6Zc1Yr5"],
      ["AWS access key id", "AKIAS7KQ2VT9LM4XB8ND"],
    ];

    for (const [label, token] of cases) {
      it(`redacts a ${label}`, () => {
        const result = scrubGitHubEgressText(`token is ${token} ok`);
        expect(result.classes).toContain("vendor-key");
        expect(result.text).toBe(`token is ${redactionMarker("vendor-key")} ok`);
        expect(result.text).not.toContain(token);
      });
    }
  });

  describe("detector: environment-dump", () => {
    it(`redacts a run of ${ENVIRONMENT_DUMP_MIN_RUN} or more NAME=VALUE lines`, () => {
      const dump = [
        "SERVICE_HOST=paperclip-api.default.svc",
        "SERVICE_PORT=3000",
        "NODE_ENV=production",
        "FEATURE_FLAG_A=true",
        "FEATURE_FLAG_B=false",
      ].join("\n");
      const result = scrubGitHubEgressText(dump);

      expect(result.classes).toContain("environment-dump");
      expect(result.text).toBe(redactionMarker("environment-dump"));
    });

    it("collapses the whole run into one marker, not one per line", () => {
      const dump = Array.from({ length: 12 }, (_, i) => `VAR_${i}=value_${i}`).join("\n");
      const result = scrubGitHubEgressText(dump);

      const markerCount = result.text.split(redactionMarker("environment-dump")).length - 1;
      expect(markerCount).toBe(1);
    });

    it(`leaves a run of ${ENVIRONMENT_DUMP_MIN_RUN - 1} assignments alone`, () => {
      const text = Array.from({ length: ENVIRONMENT_DUMP_MIN_RUN - 1 }, (_, i) => `VAR_${i}=short`).join(
        "\n",
      );
      const result = scrubGitHubEgressText(text);
      expect(result.text).toBe(text);
      expect(result.redacted).toBe(false);
    });
  });

  describe("PEN-3907: content digests are not credentials", () => {
    // A lowercase-hex digest saturates the 4.0 bits/char ceiling a 16-symbol
    // alphabet allows, so entropy alone cannot separate it from a hex-encoded
    // secret. The exemption is therefore a conjunction of NAME and SHAPE, and
    // both halves are pinned below, each with the opposite case as its control.

    it("passes a sha256 pin bound to a digest-named key through byte-exact", () => {
      // The blocking case from PEN-3896: a promtool series fixture carrying the
      // admission-drift expectation pin. The refusal's advice — derive it at
      // runtime — is unavailable, because the sibling copy of this literal lives
      // in a PromQL matcher inside a PrometheusRule and a gate asserts it there.
      const text = `paperclip_admission_policy_drift_expectation_info{job="drift",sha256="${SYNTHETIC_SHA256}"}`;
      const result = scrubGitHubEgressText(text);

      expect(result.text).toBe(text);
      expect(result.redacted).toBe(false);
      expect(result.classes).toEqual([]);
    });

    it.each([
      ["sha256", SYNTHETIC_SHA256],
      ["IMAGE_DIGEST", SYNTHETIC_SHA256],
      ["expected_checksum", SYNTHETIC_SHA256],
      ["manifest_sha512", SYNTHETIC_SHA512],
      ["commit_sha1", SYNTHETIC_SHA1],
    ])("exempts %s bound to a hex digest", (name, digest) => {
      const text = `${name}="${digest}"`;
      expect(scrubGitHubEgressText(text).redacted).toBe(false);
    });

    // -- controls: the exemption must not have widened past its conjunction --

    it("still redacts a 64-hex value under a name that does not claim a digest", () => {
      // THE control for the shape half. Hex-encoded signing keys are routinely
      // 32 or 64 hex, so exempting bare hex would pass a real credential. This
      // value is byte-identical to the exempt one above; only the name differs.
      const result = scrubGitHubEgressText(`SECRET_KEY="${SYNTHETIC_SHA256}"`);

      expect(result.redacted).toBe(true);
      expect(result.classes).toContain("high-entropy-assignment");
      expect(result.text).not.toContain(SYNTHETIC_SHA256);
    });

    it("still redacts when the name only mentions a hash rather than ending in one", () => {
      const result = scrubGitHubEgressText(`sha256_signing_key="${SYNTHETIC_SHA256}"`);
      expect(result.redacted).toBe(true);
      expect(result.text).not.toContain(SYNTHETIC_SHA256);
    });

    it("still redacts a digest-named key whose value is not a hex digest", () => {
      // THE control for the name half: naming a value `sha256` does not make an
      // opaque token a digest. Mixed case and the wrong length both disqualify.
      const result = scrubGitHubEgressText(`sha256="${SYNTHETIC_OPAQUE_VALUE}"`);
      expect(result.redacted).toBe(true);
      expect(result.text).not.toContain(SYNTHETIC_OPAQUE_VALUE);
    });

    it("still redacts a digest-named key whose hex value is the wrong length", () => {
      const notADigestLength = SYNTHETIC_SHA256.slice(0, 48);
      const result = scrubGitHubEgressText(`sha256="${notADigestLength}"`);
      expect(result.redacted).toBe(true);
    });

    it("leaves every other detector intact on the same call", () => {
      // The done-when's positive control: a real-shaped PEM in the same text as
      // an exempt digest must still refuse, so the exemption cannot be read as
      // "digest present ⇒ text is clean".
      const result = scrubGitHubEgressText(
        `sha256="${SYNTHETIC_SHA256}"\n${SYNTHETIC_PEM}`,
      );

      expect(result.classes).toContain("private-key-block");
      expect(result.text).toContain(SYNTHETIC_SHA256);
      expect(result.text).not.toContain(SYNTHETIC_PEM_BODY);
    });

    it("pins the OCI prefixed form, which is exempt for a different reason", () => {
      // `sha256:<hex>` never reached the entropy test at all: `:` is outside the
      // token alphabet in `isOpaqueSecretValue`. That is incidental rather than
      // intended, so it is pinned here — if the alphabet ever gains `:`, this
      // fails and points at `isContentDigestAssignment` as the deliberate home
      // for the behaviour, instead of image-digest pins silently starting to
      // refuse.
      const text = `DIGEST="sha256:${SYNTHETIC_SHA256}"`;
      expect(scrubGitHubEgressText(text).redacted).toBe(false);
    });
  });

  describe("PEN-3932: an all-uppercase credential is still a credential", () => {
    // `isOpaqueSecretValue` bucketed uppercase and digits into ONE character
    // class, so a value drawn only from `A-Z` and `0-9` scored one class and
    // returned BEFORE the entropy test ran — unreachable at any randomness.
    // Canonical base32 is `A-Z2-7`, so every TOTP seed and recovery code sat in
    // that blind spot, as did hex from any tool that uppercases.

    it("redacts a 64-hex value whose only difference from a redacted one is case", () => {
      // THE regression. Identical name, identical length, identical bytes —
      // case is the only variable, so a pass here cannot be explained by
      // entropy, length, or alphabet admissibility.
      const lower = scrubGitHubEgressText(`SECRET_KEY="${SYNTHETIC_SHA256}"`);
      const upper = scrubGitHubEgressText(`SECRET_KEY="${SYNTHETIC_SHA256_UPPER}"`);

      expect(lower.classes).toContain("high-entropy-assignment");
      expect(upper.classes).toContain("high-entropy-assignment");
      expect(upper.text).not.toContain(SYNTHETIC_SHA256_UPPER);
    });

    it("redacts a canonical base32 seed, the family that motivated this", () => {
      const result = scrubGitHubEgressText(`TOTP_SEED="${SYNTHETIC_TOTP_SEED}"`);

      expect(result.classes).toContain("high-entropy-assignment");
      expect(result.text).not.toContain(SYNTHETIC_TOTP_SEED);
    });

    it("redacts an uppercase-alphanumeric token under a name claiming nothing", () => {
      const token = SYNTHETIC_TOTP_SEED.slice(0, 24);
      const result = scrubGitHubEgressText(`API_TOKEN="${token}"`);

      expect(result.classes).toContain("high-entropy-assignment");
      expect(result.text).not.toContain(token);
    });

    // -- controls: the widening must not have cost anything it was not meant to --

    it("still exempts a lowercase digest bound to a digest-naming key", () => {
      // PEN-3907's conjunction, re-asserted here rather than only in its own
      // block: this change moves the gate that runs immediately before it, and
      // a widening that swallowed the exemption would still pass that block.
      const text = `sha256="${SYNTHETIC_SHA256}"`;
      expect(scrubGitHubEgressText(text).redacted).toBe(false);
    });

    it("does NOT extend that exemption to the uppercase form of the same digest", () => {
      // HEX_DIGEST_RE is lowercase-only on purpose — an uppercase digest is not
      // the canonical form any consuming tool emits, so it stays a credential.
      // Before this change the class gate refused it anyway and this could not
      // be observed; now it is the exemption's own anchoring that holds.
      const result = scrubGitHubEgressText(`sha256="${SYNTHETIC_SHA256_UPPER}"`);

      expect(result.classes).toContain("high-entropy-assignment");
      expect(result.text).not.toContain(SYNTHETIC_SHA256_UPPER);
    });

    it("still exonerates a SCREAMING_SNAKE constant as a lexical identifier", () => {
      // The false-positive direction. These values only became REACHABLE by
      // the entropy rule with this change, so `isLexicalIdentifier` is now
      // load-bearing for them where previously the class gate hid them.
      const text = "CLUSTER=US_EAST_1_PRODUCTION_CLUSTER";
      expect(scrubGitHubEgressText(text).text).toBe(text);
    });

    it("leaves PEN-3920's mixed-case corpus exactly where it was", () => {
      // These already scored two classes, so splitting the class cannot move
      // them. Pinned because the obvious reading of this change is that it
      // makes PEN-3920 worse, and the bound is that it cannot touch any value
      // carrying a lowercase letter.
      for (const value of [
        "ArcRunnerPoolCeilingClipped",
        "Vlan1MacvlanV6ProbeInstrumentBroken",
        "vlan1_macvlan_v6_listener",
      ]) {
        // Bound to a neutral name: BLO-46448 since exonerates an UpperCamelCase
        // value bound to `alertname` specifically, which is a different rule.
        expect(scrubGitHubEgressText(`label=${value}`).redacted).toBe(true);
      }
    });

    it("leaves every other detector intact on the same call", () => {
      const result = scrubGitHubEgressText(
        `TOTP_SEED="${SYNTHETIC_TOTP_SEED}"\n${SYNTHETIC_PEM}\nPAT=ghp_${"A1b2C3d4E5f6G7h8I9j0"}`,
      );

      expect(result.classes).toContain("private-key-block");
      expect(result.classes).toContain("vendor-key");
      expect(result.classes).toContain("high-entropy-assignment");
      expect(result.text).not.toContain(SYNTHETIC_PEM_BODY);
    });

    it("documents the residual: a single-case LETTERS-ONLY value is still unreachable", () => {
      // Scoring is symmetric, so uppercase-letters-only scores one class just
      // as lowercase-letters-only does and never reaches the entropy test. For
      // a base32 seed that means the ~0.7% of 24-char draws (0.026% at 40) that
      // happen to contain no digit. Closing it means dropping the class gate,
      // which admits paths and branch slugs; the trade is recorded on PEN-3932
      // and in `classIndex`. Pinned so the gap is a decision, not a surprise.
      const lettersOnly = SYNTHETIC_TOTP_SEED.replace(/[2-7]/g, "Q");
      expect(/^[A-Z]+$/.test(lettersOnly)).toBe(true);
      expect(scrubGitHubEgressText(`SEED="${lettersOnly}"`).redacted).toBe(false);
    });
  });

  describe("detector: high-entropy-assignment", () => {
    it("redacts one interpolated secret below the dump threshold", () => {
      // The fail-closed net: a single assignment is not a "dump" but is still
      // a secret, and no variable-name list is consulted to reach that verdict.
      const result = scrubGitHubEgressText(`SOME_UNENUMERATED_NAME=${SYNTHETIC_OPAQUE_VALUE}`);

      expect(result.classes).toContain("high-entropy-assignment");
      expect(result.text).toBe(
        `SOME_UNENUMERATED_NAME=${redactionMarker("high-entropy-assignment")}`,
      );
      expect(result.text).not.toContain(SYNTHETIC_OPAQUE_VALUE);
    });

    it("keeps the variable name and redacts only the value", () => {
      // Name-based scrubbers redact the name and make runbooks unreadable;
      // this is the opposite trade and it is deliberate.
      const result = scrubGitHubEgressText(`ROTATE_ME=${SYNTHETIC_OPAQUE_VALUE}`);
      expect(result.text).toContain("ROTATE_ME=");
    });

    it("leaves a long low-entropy value alone", () => {
      const text = "DESCRIPTION=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      const result = scrubGitHubEgressText(text);
      expect(result.text).toBe(text);
      expect(result.redacted).toBe(false);
    });

    it("redacts a credential carried in a URL query parameter", () => {
      const result = scrubGitHubEgressText(
        `https://example.internal/cb?access_token=${SYNTHETIC_OPAQUE_VALUE}`,
      );
      expect(result.redacted).toBe(true);
      expect(result.text).not.toContain(SYNTHETIC_OPAQUE_VALUE);
    });
  });

  describe("BLO-41262 regression: a hyphenated identifier is not a credential", () => {
    // `draft-ramadan-moq-multicast-00` scores 3.74 bits/char, above the 3.5
    // floor, so the entropy test alone read an RFC-XML <seriesInfo> element as
    // credential-shaped. Every .md IETF draft in Blockcast/moqcast-draft became
    // unwritable through `gh api .../git/blobs` while git push was down.
    // Derived, not written out: until THIS fix is deployed the wrapper's own
    // pre-push hook refuses a commit that adds the literal — the regression
    // test for a false positive cannot be pushed past the false positive.
    const DRAFT = ["draft", "ramadan", "moq", "multicast", "00"].join("-");
    const SERIES_INFO = `<seriesInfo name='Internet-Draft' value='${DRAFT}'/>`;

    it("passes an RFC-XML seriesInfo element through byte-exact", () => {
      const result = scrubGitHubEgressText(SERIES_INFO);
      expect(result.text).toBe(SERIES_INFO);
      expect(result.redacted).toBe(false);
    });

    it.each([
      "draft-ramadan-moq-multicast-00",
      "draft-ramadan-moq-fec-00",
      "draft-ramadan-moq-mmt-00",
      "draft-ietf-moq-transport-14",
    ])("leaves the draft name %s alone", (name) => {
      const text = `value='${name}'`;
      const result = scrubGitHubEgressText(text);
      // `.text` alone would still pass if some other detector fired and left
      // the bytes unchanged.
      expect(result.text).toBe(text);
      expect(result.redacted).toBe(false);
      expect(result.classes).toEqual([]);
    });

    // Random-looking letter runs for the bound cases below. Derived, not
    // embedded, like LONG_LEXICAL_TAIL: as literals they are credential-shaped.
    const LETTERS = "QwrtypsdfghjklzxmnbvcXZLKJHGFDSAPOIUYTREWQ";
    const letterRun = (offset: number, length: number) =>
      LETTERS.slice(offset, offset + length);

    it("refuses two 16-letter segments (long-segment count and summed length)", () => {
      // Each segment is within the per-segment cap, but two ~75-bit segments
      // are ~150 bits. Two checks refuse this independently: both segments
      // are long, and 32 letters exceeds the summed-length cap — so deleting
      // either check alone leaves it refused. The 2 × 11 and 4 × 10 cases
      // below are the ones that pin each check.
      const token = [letterRun(0, 16), letterRun(16, 16)].join("-");
      const result = scrubGitHubEgressText(`sessionkey=${token}`);
      expect(result.classes).toContain("high-entropy-assignment");
      expect(result.text).not.toContain(token);
    });

    it("refuses two 11-letter segments: pins LEXICAL_LONG_SEGMENT_LENGTH", () => {
      // 11 is one over the long-segment length, and 11 + 11 + 2 is under the
      // summed-length cap, so only the long-segment count refuses this. The
      // `00` tail lifts it over the 24-character entropy floor (2 × 11 alone
      // is 23 characters and would pass without reaching any rule here), and
      // must itself be lexical: a mixed tail like `v2` is refused on shape and
      // would let this case pass with the constant deleted.
      const token = [letterRun(0, 11), letterRun(11, 11), "00"].join("-");
      const result = scrubGitHubEgressText(`sessionkey=${token}`);
      expect(result.classes).toContain("high-entropy-assignment");
      expect(result.text).not.toContain(token);
    });

    it("refuses four 10-letter segments: pins the summed-length cap", () => {
      // No segment is long, so only LEXICAL_IDENTIFIER_MAX_CONTENT_LENGTH (30)
      // refuses 40 letters (~188 bits). Before it, any number of 10-letter
      // segments was exonerated.
      const token = [0, 10, 20, 30].map((o) => letterRun(o, 10)).join("-");
      const result = scrubGitHubEgressText(`sessionkey=${token}`);
      expect(result.classes).toContain("high-entropy-assignment");
      expect(result.text).not.toContain(token);
    });

    it("still exonerates three 10-letter segments: the cap narrows, it does not close", () => {
      // Documents a known gap rather than a desired property. 3 × 10 sums to
      // exactly the cap (30, ~141 bits) and passes. No length or count rule
      // separates it from a real draft name of 26; what keeps random tokens
      // out of this shape is that generators do not emit homogeneous letter
      // runs, not this rule. If the cap is ever tightened, flip this case.
      const token = [0, 10, 20].map((o) => letterRun(o, 10)).join("-");
      const text = `sessionkey=${token}`;
      const result = scrubGitHubEgressText(text);
      expect(result.text).toBe(text);
      expect(result.classes).toEqual([]);
    });

    it("still refuses a random token in the same assignment position", () => {
      // The negative control. The rule is narrowed, not disabled: a credential
      // is ONE opaque run, and this one has no lexical segments at all.
      const result = scrubGitHubEgressText(`apikey=${SYNTHETIC_OPAQUE_VALUE}`);
      expect(result.classes).toContain("high-entropy-assignment");
      expect(result.text).not.toContain(SYNTHETIC_OPAQUE_VALUE);
    });

    it("still refuses a value whose segments are words but whose tail is long", () => {
      // Both conjuncts carry weight: lexical segments alone do not exonerate,
      // or a `prefix-<20 opaque chars>` token would walk straight through.
      // Derived, not embedded: the literal would be credential-shaped material
      // in tracked source and the PEN-3156 publish guard refuses that.
      const token = ["release", "Candidate", LONG_LEXICAL_TAIL].join("-");
      const result = scrubGitHubEgressText(`token=${token}`);
      expect(result.classes).toContain("high-entropy-assignment");
      expect(result.text).not.toContain(token);
    });

    it("documents that an all-lowercase value was never reachable here", () => {
      // Pre-existing, and it bounds what the length conjunct above has to
      // carry: the detector needs two character classes, so a pure-lowercase
      // run never reaches the entropy test with or without this change.
      const text = "token=release_candidate_abcdefghijklmnopqrstuv";
      expect(scrubGitHubEgressText(text).text).toBe(text);
    });

    it("still refuses a UUID-shaped value", () => {
      // Fail closed: `386c81e8` is neither a word nor a number, so a GUID API
      // key stays covered — at the cost of redacting the fleet's own ids.
      const uuid = "386c81e8-e454-41ba-8e1d-7bb692331185";
      const result = scrubGitHubEgressText(`session=${uuid}`);
      expect(result.classes).toContain("high-entropy-assignment");
      expect(result.text).not.toContain(uuid);
    });
  });

  describe("BLO-41153 regression: a gRPC method path is not a credential", () => {
    // Measured on Blockcast/magma PR #2289 @ 7c95ac44: scanning the two files
    // the push guard named found exactly one firing value in each, and it was
    // neither a metric name nor a Chart.lock digest — it was the gRPC method
    // path, at 4.05 bits/char in the runbook and 3.64 in the alert rule.
    //
    // Every binding below is assembled at runtime. Written out contiguously
    // the pair is the material the unfixed rule refuses, so a literal here
    // could not be pushed past the false positive it tests for. Same reason
    // as the PEN-3907 and BLO-41262 fixtures above.
    const GRPC_METHOD = "/magma.orc8r.Bootstrapper/GetChallenge";
    const GRPC_SERVICE = "/magma.orc8r.Bootstrapper/";
    const bind = (name: string, value: string) => `${name}=${value}`;

    it.each([GRPC_METHOD, GRPC_SERVICE])("passes %s through byte-exact", (path) => {
      const text = bind("method", path);
      const result = scrubGitHubEgressText(text);
      expect(result.text).toBe(text);
      expect(result.redacted).toBe(false);
      expect(result.classes).toEqual([]);
    });

    it.each(["method", "rpc", "grpc_method", "full_method"])(
      "exempts on shape, not on the name %s",
      (name) => {
        // The exemption is deliberately name-free. A name list would drift,
        // and the first name nobody enumerated reproduces this false positive.
        const text = bind(name, GRPC_METHOD);
        expect(scrubGitHubEgressText(text).text).toBe(text);
      },
    );

    it("still refuses an opaque token in the same assignment position", () => {
      // The negative control for the name half: `method` is not a pass.
      const result = scrubGitHubEgressText(bind("method", SYNTHETIC_OPAQUE_VALUE));
      expect(result.classes).toContain("high-entropy-assignment");
      expect(result.text).not.toContain(SYNTHETIC_OPAQUE_VALUE);
    });

    it("still refuses a slash-rooted value with no dot in the package", () => {
      // The dot is what keeps every credential ENCODING out of this shape:
      // base64url has no `.` and no `/`, standard base64 and hex have no `.`.
      // Without this conjunct a standard-base64 secret that happens to start
      // with `/` — 1 in 64 of them — would be exonerated, so this case is the
      // whole security argument for the rule and not a corner.
      //
      // Both runs are sliced to start with a LETTER on purpose. An earlier
      // split landed a digit at the head of the second run, which the
      // per-segment shape refused on its own — so the test passed with the
      // dot conjunct deleted and pinned nothing.
      //
      // BLO-45605: and both runs are now letters-only and uppercase-initial,
      // because #2633's method bound and this change's service bound each
      // refused the old split by themselves — the dot was again pinning
      // nothing. `Qx` only lifts the letters-only value past the length floor.
      const letters = `${SYNTHETIC_OPAQUE_VALUE.replace(/[0-9]/g, "")}Qx`;
      const token = `/S${letters.slice(1, 12)}/W${letters.slice(12)}`;
      const result = scrubGitHubEgressText(bind("method", token));
      expect(result.classes).toContain("high-entropy-assignment");
      expect(result.text).not.toContain(token);
    });

    it.each([
      "/0agma.orc8r.Bootstrapper/GetChallenge",
      "/magma.0rc8r.Bootstrapper/GetChallenge",
      "/magma.orc8r.Bootstrapper/0etChallenge",
    ])("still refuses %s: a run that does not start with a letter", (token) => {
      // Shape hygiene rather than a security bound — the dot conjunct is what
      // keeps token encodings out — but pinned in all three run positions so
      // the narrowing is not a comment. A proto identifier starts with a
      // letter; one case per position, because a mutation to any one of them
      // is invisible to the other two.
      const result = scrubGitHubEgressText(bind("method", token));
      expect(result.classes).toContain("high-entropy-assignment");
      expect(result.text).not.toContain(token);
    });

    it.each([
      // Pins the no-digit half: uppercase-initial, so only the digits refuse it.
      `/a.b/S${SYNTHETIC_OPAQUE_VALUE.slice(1)}`,
      // Pins the uppercase-initial half: letters only, so only the case refuses it.
      `/a.b/${SYNTHETIC_OPAQUE_VALUE.replace(/[0-9]/g, "")}`,
    ])("still refuses %s: an opaque token in the method position (BLO-45350)", (token) => {
      // The method run used to be `[A-Za-z][A-Za-z0-9]*`, so any letter-initial
      // token rode in behind a two-letter dotted package. One case per conjunct
      // of `[A-Z][A-Za-z]*`, because a mutation to either is invisible to a
      // fixture the other one already refuses.
      const result = scrubGitHubEgressText(bind("method", token));
      expect(result.classes).toContain("high-entropy-assignment");
      expect(result.text).not.toContain(token);
    });

    it.each([
      // Package cap: `.B` keeps the service legal, so only the cap refuses these.
      `/${SYNTHETIC_OPAQUE_VALUE}.B/`,
      `/${SYNTHETIC_OPAQUE_VALUE}.B/Get`,
      // Service uppercase-initial: letters only, so only the case refuses it.
      `/a.${SYNTHETIC_OPAQUE_VALUE.replace(/[0-9]/g, "")}/`,
      // Service digits-as-tail: uppercase-initial, so only the interior digits refuse it.
      `/a.S${SYNTHETIC_OPAQUE_VALUE.slice(1)}/`,
    ])("still refuses %s: an opaque token in a package or service run (BLO-45605)", (token) => {
      // Ally's shapes on #2633 were `/<opaque>.b/`, `/<opaque>.b/Get` and
      // `/a.<opaque>/`. The service is written `B`, not `b`: with a lowercase
      // service the service bound refuses the first two on its own, and they
      // would pass with the package cap deleted. One case per conjunct.
      const result = scrubGitHubEgressText(bind("method", token));
      expect(result.classes).toContain("high-entropy-assignment");
      expect(result.text).not.toContain(token);
    });

    it("passes the magma rpc corpus through byte-exact (BLO-45605)", () => {
      // Every `/<package>.<Service>/<Method>` declared in Blockcast/magma's
      // .proto files, and each one's service prefix. The two
      // `tenants_beacon` paths are left out: the `_` already refused them
      // before any of these bounds existed.
      const corpus = readFileSync(
        new URL("./github-egress-scrub.magma-rpcs.txt", import.meta.url),
        "utf8",
      )
        .trim()
        .split("\n");
      expect(corpus.length).toBeGreaterThan(150);
      const paths = [...new Set(corpus.flatMap((m) => [m, m.replace(/[^/]+$/, "")]))];
      const flagged = paths.filter((p) => {
        const text = bind("method", p);
        return scrubGitHubEgressText(text).text !== text;
      });
      expect(flagged).toEqual([]);
    });

    it("still refuses a credential with a real method path appended", () => {
      // Pins the start anchor, as the extra-segment case below pins the end
      // one. Unanchored, the regex would find the valid path in the tail and
      // exonerate the whole value, token and all.
      const token = `${SYNTHETIC_OPAQUE_VALUE}${GRPC_METHOD}`;
      const result = scrubGitHubEgressText(bind("method", token));
      expect(result.classes).toContain("high-entropy-assignment");
      expect(result.text).not.toContain(SYNTHETIC_OPAQUE_VALUE);
    });

    it("still refuses a dotted path whose segments leave the identifier alphabet", () => {
      // Pins the per-run `[A-Za-z][A-Za-z0-9]*` shape. `-` and `_` are in the
      // token alphabet a secret is drawn from, so admitting them here would
      // reopen the gap the dot conjunct closes.
      const token = `/magma.orc8r.Boot_strapper/${SYNTHETIC_OPAQUE_VALUE}`;
      const result = scrubGitHubEgressText(bind("method", token));
      expect(result.classes).toContain("high-entropy-assignment");
      expect(result.text).not.toContain(token);
    });

    it("still refuses a path with an extra segment carrying a credential", () => {
      // The regex is anchored at both ends and allows exactly one `/` after
      // the dotted package, so a real method path is not a prefix a token can
      // ride in on. Appended inside the token alphabet deliberately: an
      // out-of-alphabet joiner such as `?` would be refused by the alphabet
      // gate upstream and would not exercise the anchoring at all.
      const token = `${GRPC_METHOD}/${SYNTHETIC_OPAQUE_VALUE}`;
      const result = scrubGitHubEgressText(bind("method", token));
      expect(result.classes).toContain("high-entropy-assignment");
      expect(result.text).not.toContain(SYNTHETIC_OPAQUE_VALUE);
    });
  });

  describe("BLO-44747 regression: one word with a short digit run is still a word", () => {
    // A Prometheus scrape-job name already public on onprem-k8s master. Derived,
    // not embedded: until this fix deploys, the pre-push guard refuses the literal.
    const JOB = ["orc8r", "cdn", "forward", "queue", "federate"].join("-");
    const EXPR = `expr: up{job="${JOB}"} == 0 or absent(up{job="${JOB}"})`;

    it("passes the onprem-k8s alert expression through byte-exact", () => {
      expect(scrubGitHubEgressText(EXPR).text).toBe(EXPR);
      expect(locateGitHubEgressMatches(EXPR)).toEqual([]);
    });

    it.each(["k8s", "ipv6", "eastus2", "i18n"])("exonerates the mixed segment %s", (word) => {
      const text = `job="${[word, "cdn", "forward", "federate"].join("-")}"`;
      expect(scrubGitHubEgressText(text).classes).toEqual([]);
    });

    it.each([
      ["two mixed segments", ["orc8r", "k8s", "forward", "queue", "federate"]],
      ["a mixed segment over 8 chars", ["orchestr8r", "cdn", "forward", "federate"]],
      ["a 3-digit run", ["orc888r", "cdn", "forward", "queue", "federate"]],
      ["a digit-led segment", ["8orcr", "cdn", "forward", "queue", "federate"]],
      ["two digit runs in one segment", ["o2rc8r", "cdn", "forward", "queue", "federate"]],
      ["a mixed-case mixed segment", ["oRc8r", "cdn", "forward", "queue", "federate"]],
      // A random 4×6 lower+digit key with exactly one admissible mixed segment:
      // refused by the uniform-length check (Ally, review 5496550156).
      ["a fixed-layout key", ["xotjia", "uzvdso", "mhknub", "sn1prx"]],
    ])("still refuses %s", (_label, parts) => {
      const token = parts.join("-");
      const result = scrubGitHubEgressText(`sessionkey=${token}`);
      expect(result.classes).toContain("high-entropy-assignment");
      expect(result.text).not.toContain(token);
    });
  });

  describe("BLO-43580: a nested assignment is not swallowed by the one before it", () => {
    // Every binding is assembled at runtime: written out contiguously each one
    // is the material the deployed guard refuses, so a literal would make this
    // file unpushable. Same convention as the fixtures above.
    const T = SYNTHETIC_OPAQUE_VALUE;
    const bind = (name: string, value: string) => `${name}=${value}`;
    const MARKER = redactionMarker("high-entropy-assignment");
    const expectRedacted = (text: string) => {
      const result = scrubGitHubEgressText(text);
      expect(result.classes).toContain("high-entropy-assignment");
      expect(result.text).not.toContain(T);
    };

    it("redacts the token behind a gRPC method path and a `?`", () => {
      // The measured case. The method path itself still passes (BLO-41153).
      const text = `${bind("method", "/magma.orc8r.Bootstrapper/GetChallenge")}?${bind("key", T)}`;
      const result = scrubGitHubEgressText(text);
      expect(result.classes).toEqual(["high-entropy-assignment"]);
      expect(result.text).toBe(`${bind("method", "/magma.orc8r.Bootstrapper/GetChallenge")}?${bind("key", MARKER)}`);
    });

    const JOINERS = ["?", "&", ",", ";", "(", ")", "{", "}", "|", "#"];
    const filler = (name: string) => bind(name, "alpha");

    it.each(JOINERS)("redacts a token in second position after %s", (j) => {
      // Second of three: an out-of-alphabet joiner on BOTH sides of the token,
      // so the capture has to stop at the trailing one too.
      expectRedacted([filler("one"), bind("key", T), filler("two")].join(j));
    });

    it.each(JOINERS)("redacts a token in third position after %s", (j) => {
      expectRedacted([filler("one"), filler("two"), bind("key", T), filler("three")].join(j));
    });

    it.each(JOINERS)("redacts a token in last position after %s", (j) => {
      expectRedacted([filler("one"), filler("two"), bind("key", T)].join(j));
    });

    it("redacts a quoted token followed by junk before the closing quote", () => {
      // The old `\2` backreference demanded the closing quote right after the
      // value, so `"<token>?…"` matched neither arm and escaped.
      expectRedacted(`${bind("token", `"${T}?x=1"`)}`);
    });

    it("redacts a token nested inside a quoted URL", () => {
      expectRedacted(bind("href", `"/cb?${bind("key", T)}"`));
    });

    it("keeps both quotes around a quoted token, exactly once each", () => {
      // The closing quote is no longer consumed, so the replacer must not
      // re-append it.
      expect(scrubGitHubEgressText(bind("token", `"${T}"`)).text).toBe(bind("token", `"${MARKER}"`));
    });

    // pnpm-lock.yaml writes `postgres@3.4.9(patch_hash=<26 base32>)`. It used to
    // pass only because the trailing `)` failed the old greedy capture; the
    // narrower capture exposed it and every dependency bump re-writing such a
    // line became unpushable. Derived: base32 of an md5, as pnpm does.
    const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
    const md5 = createHash("md5").update("synthetic-patch").digest();
    let bits = 0n;
    for (const byte of md5) bits = (bits << 8n) | BigInt(byte);
    const PATCH_HASH = Array.from({ length: 26 }, (_, i) =>
      BASE32[Number((bits << 2n >> BigInt(125 - i * 5)) & 31n)],
    ).join("");

    it("passes a pnpm lockfile patch_hash through byte-exact", () => {
      expect(PATCH_HASH).toMatch(/^[a-z2-7]{26}$/);
      const text = `postgres@3.4.9(${bind("patch_hash", PATCH_HASH)})`;
      const result = scrubGitHubEgressText(text);
      expect(result.text).toBe(text);
      expect(result.redacted).toBe(false);
    });

    it("still refuses the same value under any other name", () => {
      // Name half of the conjunction: the shape alone is a 130-bit token.
      const result = scrubGitHubEgressText(`(${bind("access_hash", PATCH_HASH)})`);
      expect(result.classes).toContain("high-entropy-assignment");
    });

    it("still refuses an opaque token bound to patch_hash", () => {
      // Shape half: the name alone exonerates nothing.
      expectRedacted(`(${bind("patch_hash", T)})`);
    });
  });

  describe("BLO-46448 regression: an alert name in an amtool matcher is not a credential", () => {
    // Derived, not embedded: until this fix deploys, the pre-push guard refuses the literal.
    const pair = (value: string) => ["alertname", value].join("=");

    it.each([
      "VaultTLSProbeUnreachable",
      "HarborDatabaseEndpointMissing",
      "NodeFilesystemAlmostOutOfSpace",
      "ArcRunnerPoolCeilingClipped",
    ])(
      "passes %s through byte-exact, quoted or not",
      (name) => {
        for (const text of [`    ${pair(name)}`, `    ${pair(`"${name}"`)}`]) {
          expect(scrubGitHubEgressText(text).text).toBe(text);
          expect(locateGitHubEgressMatches(text)).toEqual([]);
        }
      },
    );

    it("still refuses the same value under any other name", () => {
      // Name half: the shape alone exonerates nothing.
      const result = scrubGitHubEgressText(["password", "VaultTLSProbeUnreachable"].join("="));
      expect(result.classes).toContain("high-entropy-assignment");
    });

    it.each(["Kq2Vt9Lm4Xb8Nd3Wp6Zc1Yr5", "KqVtLmXbNdWpZcYrHjTgPsQF", "Vlan1MacvlanV6ProbeInstrumentBroken"])(
      "still refuses the opaque token %s bound to alertname",
      (token) => {
        // Shape half: a digit, or capitals not forming words, keep a token opaque.
        const result = scrubGitHubEgressText(pair(token));
        expect(result.classes).toContain("high-entropy-assignment");
        expect(result.text).not.toContain(token);
      },
    );
  });

  describe("BLO-41262: locateGitHubEgressMatches names the line", () => {
    const token = SYNTHETIC_OPAQUE_VALUE;

    it("reports the 1-based line and omits clean lines", () => {
      const located = locateGitHubEgressMatches(
        ["clean first line", "", `apikey=${token}`, "clean last line"].join("\n"),
      );

      expect(located).toHaveLength(1);
      expect(located[0]?.line).toBe(3);
      expect(located[0]?.classes).toEqual(["high-entropy-assignment"]);
    });

    it("excerpts the SCRUBBED line, so the refusal cannot carry the material", () => {
      // PEN-2526's shape is echoing the match back out through the control
      // built to prevent it. The marker sits where the value was, which still
      // identifies the line.
      const located = locateGitHubEgressMatches(`apikey=${token}`);

      expect(located[0]?.excerpt).not.toContain(token);
      expect(located[0]?.excerpt).toContain(redactionMarker("high-entropy-assignment"));
      expect(located[0]?.excerpt).toContain("apikey=");
    });

    it("truncates a long line rather than reprinting it whole", () => {
      const located = locateGitHubEgressMatches(`apikey=${token} ${"x".repeat(500)}`);
      expect(located[0]?.excerpt.length).toBeLessThanOrEqual(201);
      expect(located[0]?.excerpt.endsWith("…")).toBe(true);
    });

    it("returns nothing for clean text", () => {
      expect(locateGitHubEgressMatches("ordinary review prose")).toEqual([]);
    });

    it("attributes no line when a region class fires, so nothing inside the region is echoed", () => {
      // A line inside an environment dump that also fires for its own reason
      // used to be re-scanned alone and printed with only that match removed,
      // carrying the short assignment the dump rule exists to catch.
      const vendorKey = ["gh", "p_", "S7kq2Vt9Lm4Xb8Nd3Wp6Zc1Yr5Hj0TgAbCd"].join("");
      const shortSecret = "s3cretpw";
      const dump = [
        "HOME=/root",
        `TOKEN=${vendorKey} DB_PASS=${shortSecret}`,
        "PATH=/usr/bin",
        "LANG=C",
        "SHELL=/bin/sh",
      ].join("\n");
      expect(scrubGitHubEgressText(dump).classes).toContain("environment-dump");

      const located = locateGitHubEgressMatches(dump);
      expect(located).toEqual([]);
      expect(JSON.stringify(located)).not.toContain(shortSecret);
    });

    // Region-ness is derived, not trusted to the hand-kept list: a class is a
    // region class exactly when a per-line re-scan cannot reproduce the
    // whole-text scrub. The Record makes tsc demand a probe for every class,
    // so a new multi-line detector cannot silently escape
    // GITHUB_EGRESS_REGION_CLASSES and re-open per-line excerpts under it.
    const regionProbes: Record<GitHubEgressScrubClass, string> = {
      "private-key-block": `before\n${SYNTHETIC_PEM}\nafter`,
      "credentialed-uri": `a\npostgres://dbuser:${SYNTHETIC_OPAQUE_VALUE}@db.internal:5432/app\nb`,
      jwt: `a\nBearer ${SYNTHETIC_JWT}\nb`,
      "vendor-key": `a\ntoken is ${["ghp", "S7kq2Vt9Lm4Xb8Nd3Wp6Zc1Yr5Hj0TgAbCd"].join("_")} ok\nb`,
      "environment-dump": Array.from({ length: ENVIRONMENT_DUMP_MIN_RUN }, (_, i) => `VAR_${i}=v`).join("\n"),
      "high-entropy-assignment": `a\nKEY=${SYNTHETIC_OPAQUE_VALUE}\nb`,
    };

    it.each(Object.entries(regionProbes))(
      "lists %s as a region class iff a per-line re-scan cannot reproduce it",
      (cls, input) => {
        const whole = scrubGitHubEgressText(input);
        expect(whole.classes).toContain(cls);
        const perLine = input
          .split("\n")
          .map((line) => scrubGitHubEgressText(line).text)
          .join("\n");
        expect(GITHUB_EGRESS_REGION_CLASSES.includes(cls as GitHubEgressScrubClass)).toBe(
          perLine !== whole.text,
        );
      },
    );

    it("does not leave a carriage return on a CRLF excerpt", () => {
      const located = locateGitHubEgressMatches(`clean\r\napikey=${token}\r\nclean`);
      expect(located).toHaveLength(1);
      expect(located[0]?.line).toBe(2);
      expect(located[0]?.excerpt.endsWith("\r")).toBe(false);
    });
  });

  describe("PEN-2526 regression: reviewer prose with an interpolated environment dump", () => {
    // This is the shape that actually caused the incident: a normal review body
    // whose text ran into the reviewer's own process environment mid-sentence.
    const incidentShaped = [
      "## Ally review — Blockcast/paperclip#1435",
      "",
      "Reviewed the inbound scrub. Two notes on `response-scrub.ts`:",
      "",
      "1. `scrubYamlText` handles the block-scalar case correctly.",
      "2. Consider asserting `content-length` is stripped. The runtime env is",
      "PAPERCLIP_AGENT_JWT_SECRET=" + SYNTHETIC_OPAQUE_VALUE,
      "DATABASE_URL=postgres://app:" + SYNTHETIC_OPAQUE_VALUE + "@db.internal:5432/paperclip",
      "PAPERCLIP_DEX_OIDC_CLIENT_SECRET=" + SYNTHETIC_OPAQUE_VALUE,
      "GITHUB_APP_INSTALLATION_ID=41234567",
      "SERVICE_ACCOUNT=paperclip-api",
      "GITHUB_APP_PRIVATE_KEY=" + SYNTHETIC_PEM,
      "",
      "so the gate should be fine.",
    ].join("\n");

    it("does not let the dump reach the GitHub API intact", () => {
      const result = scrubGitHubEgressText(incidentShaped);

      expect(result.redacted).toBe(true);
      expect(result.text).not.toBe(incidentShaped);
    });

    it("removes every synthetic secret value from the body", () => {
      const result = scrubGitHubEgressText(incidentShaped);

      expect(result.text).not.toContain(SYNTHETIC_OPAQUE_VALUE);
      expect(result.text).not.toContain(SYNTHETIC_PEM_BODY);
      expect(result.text).not.toContain("BEGIN RSA PRIVATE KEY");
    });

    it("names the classes it removed so a reviewer can tell a scrub from a truncation", () => {
      const result = scrubGitHubEgressText(incidentShaped);

      expect(result.classes).toContain("private-key-block");
      expect(result.classes.length).toBeGreaterThan(0);
      for (const cls of result.classes) {
        expect(result.text).toContain(redactionMarker(cls));
      }
    });

    it("preserves the surrounding review prose", () => {
      const result = scrubGitHubEgressText(incidentShaped);

      expect(result.text).toContain("## Ally review — Blockcast/paperclip#1435");
      expect(result.text).toContain("`scrubYamlText` handles the block-scalar case correctly.");
      expect(result.text).toContain("so the gate should be fine.");
    });
  });
});
