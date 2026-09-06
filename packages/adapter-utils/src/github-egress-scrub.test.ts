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
