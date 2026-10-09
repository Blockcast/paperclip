import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  ENVIRONMENT_DUMP_MIN_RUN,
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

    it("refuses two long word-shaped segments: the aggregate bound", () => {
      // Each segment is within the per-segment cap, but two ~75-bit segments
      // are ~150 bits — a usable secret, and the per-segment cap alone admits
      // any number of them. Derived, not embedded, like the tail above.
      const token = ["Qwrtypsdfghjklzx", "mnbvcxzlkjhgfdsa"].join("-");
      const result = scrubGitHubEgressText(`sessionkey=${token}`);
      expect(result.classes).toContain("high-entropy-assignment");
      expect(result.text).not.toContain(token);
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
