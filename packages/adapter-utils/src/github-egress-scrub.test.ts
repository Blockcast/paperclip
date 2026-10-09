import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  ENVIRONMENT_DUMP_MIN_RUN,
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

// PEN-3907 fixtures. DERIVED, not pasted: a 64-hex literal in `name="value"`
// form is exactly what the pre-push guard refuses, so a hardcoded digest here
// would make this very file unpushable from an agent seat until the fix it
// tests has already shipped. Deriving it also makes the fixture self-evidently
// a content digest rather than a value someone chose.
const SYNTHETIC_SHA256 = createHash("sha256").update("pen-3907 fixture").digest("hex");
const SYNTHETIC_SHA1 = createHash("sha1").update("pen-3907 fixture").digest("hex");
const SYNTHETIC_SHA512 = createHash("sha512").update("pen-3907 fixture").digest("hex");

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
