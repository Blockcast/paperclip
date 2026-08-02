import { describe, expect, it } from "vitest";
import {
  REDACTED_EVENT_VALUE,
  redactAgentConfigPayload,
  redactApprovalPayloadByType,
  redactApprovalPayloadForDisplay,
  redactEventPayload,
  redactSensitiveText,
  sanitizeRecord,
} from "../redaction.js";

describe("redaction", () => {
  it("redacts sensitive keys and nested secret values", () => {
    const input = {
      apiKey: "abc123",
      nested: {
        AUTH_TOKEN: "token-value",
        safe: "ok",
      },
      env: {
        OPENAI_API_KEY: "sk-openai",
        OPENAI_API_KEY_REF: {
          type: "secret_ref",
          secretId: "11111111-1111-1111-1111-111111111111",
        },
        OPENAI_API_KEY_PLAIN: {
          type: "plain",
          value: "sk-plain",
        },
        PAPERCLIP_API_URL: "http://localhost:3100",
      },
    };

    const result = sanitizeRecord(input);

    expect(result.apiKey).toBe(REDACTED_EVENT_VALUE);
    expect(result.nested).toEqual({
      AUTH_TOKEN: REDACTED_EVENT_VALUE,
      safe: "ok",
    });
    expect(result.env).toEqual({
      OPENAI_API_KEY: REDACTED_EVENT_VALUE,
      OPENAI_API_KEY_REF: {
        type: "secret_ref",
        secretId: "11111111-1111-1111-1111-111111111111",
      },
      OPENAI_API_KEY_PLAIN: {
        type: "plain",
        value: REDACTED_EVENT_VALUE,
      },
      PAPERCLIP_API_URL: "http://localhost:3100",
    });
  });

  it("redacts jwt-looking values even when key name is not sensitive", () => {
    const input = {
      session: "aaa.bbb.ccc",
      normal: "plain",
    };

    const result = sanitizeRecord(input);

    expect(result.session).toBe(REDACTED_EVENT_VALUE);
    expect(result.normal).toBe("plain");
  });

  it("redacts payload objects while preserving null", () => {
    expect(redactEventPayload(null)).toBeNull();
    expect(redactEventPayload({ password: "hunter2", safe: "value" })).toEqual({
      password: REDACTED_EVENT_VALUE,
      safe: "value",
    });
  });

  it("redacts common secret shapes from unstructured text", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const githubToken = "ghp_1234567890abcdefghijklmnopqrstuvwxyz";
    const input = [
      "Authorization: Bearer live-bearer-token-value",
      `payload {"apiKey":"json-secret-value"}`,
      `paperclip {"PAPERCLIP_API_KEY":"paperclip-json-secret"}`,
      `escaped {\\"apiKey\\":\\"escaped-json-secret\\"}`,
      `export PAPERCLIP_API_KEY='paperclip-shell-secret'`,
      `GITHUB_TOKEN=${githubToken}`,
      `session=${jwt}`,
    ].join("\n");

    const result = redactSensitiveText(input);

    expect(result).toContain(REDACTED_EVENT_VALUE);
    expect(result).not.toContain("live-bearer-token-value");
    expect(result).not.toContain("json-secret-value");
    expect(result).not.toContain("paperclip-json-secret");
    expect(result).not.toContain("escaped-json-secret");
    expect(result).not.toContain("paperclip-shell-secret");
    expect(result).not.toContain(githubToken);
    expect(result).not.toContain(jwt);
  });

  it("redacts secret env values from declare/export and nul-delimited dumps", () => {
    const declareSecret = "fake-declare-secret-value";
    const exportSecret = "fake-export-secret-value";
    const procSecret = "fake-proc-secret-value";
    const input = [
      `declare -x PAPERCLIP_API_KEY="${declareSecret}"`,
      `export PAPERCLIP_ACCESS_TOKEN='${exportSecret}'`,
      `PATH=/usr/bin\0PAPERCLIP_PRIVATE_KEY=${procSecret}\0SAFE_ENV_NAME=visible`,
    ].join("\n");

    const result = redactSensitiveText(input);

    expect(result).toContain(`declare -x PAPERCLIP_API_KEY="${REDACTED_EVENT_VALUE}"`);
    expect(result).toContain(`export PAPERCLIP_ACCESS_TOKEN='${REDACTED_EVENT_VALUE}'`);
    expect(result).toContain(`PAPERCLIP_PRIVATE_KEY=${REDACTED_EVENT_VALUE}`);
    expect(result).not.toContain(declareSecret);
    expect(result).not.toContain(exportSecret);
    expect(result).not.toContain(procSecret);
    expect(result).toContain("SAFE_ENV_NAME=visible");
  });

  it("redacts inline secrets from command metadata without hiding safe command text", () => {
    const input = {
      command: "custom-acp --token ghp_example_secret env OPENAI_API_KEY=sk-live-example custom-acp",
      commandArgs: ["--safe", "ok", "--token", "ghp_arg_secret", "--api-key=sk-inline-example"],
      env: {
        PAPERCLIP_RESOLVED_COMMAND: "env OPENAI_API_KEY=sk-live-example custom-acp --token ghp_example_secret",
        SAFE_VALUE: "visible",
      },
    };

    const result = redactEventPayload(input);

    expect(result?.command).toBe(
      `custom-acp --token ${REDACTED_EVENT_VALUE} env OPENAI_API_KEY=${REDACTED_EVENT_VALUE} custom-acp`,
    );
    expect(result?.commandArgs).toEqual([
      "--safe",
      "ok",
      "--token",
      REDACTED_EVENT_VALUE,
      `--api-key=${REDACTED_EVENT_VALUE}`,
    ]);
    expect(result?.env).toEqual({
      PAPERCLIP_RESOLVED_COMMAND:
        `env OPENAI_API_KEY=${REDACTED_EVENT_VALUE} custom-acp --token ${REDACTED_EVENT_VALUE}`,
      SAFE_VALUE: "visible",
    });
  });

  it("redacts non-string command args after secret flags", () => {
    const result = redactEventPayload({
      commandArgs: ["--api-key", { nested: "secret-value" }, "safe-next"],
    });

    expect(result?.commandArgs).toEqual(["--api-key", REDACTED_EVENT_VALUE, "safe-next"]);
  });

  it("does not treat bare args payloads as command args", () => {
    const result = redactEventPayload({
      args: ["--api-key", "not-a-command-secret"],
      argv: ["--api-key", "command-secret"],
    });

    expect(result?.args).toEqual(["--api-key", "not-a-command-secret"]);
    expect(result?.argv).toEqual(["--api-key", REDACTED_EVENT_VALUE]);
  });
});

// BLO-20810: `SECRET_PAYLOAD_KEY_RE` matches secret-ish *substrings* anywhere
// in a key name by design (so compound keys like `webhookAuthToken` still
// trigger), but that means "author" trips on "auth" and "no_secrets_in_payload"
// trips on "secret" even though neither value is a credential. The value must
// also look opaque/credential-shaped before it gets blanked.
describe("sanitizeRecord value-shape gate (BLO-20810)", () => {
  it("does not redact prose or evidence links under a key that merely contains a secret-ish substring", () => {
    const input = {
      ask_2_author_identity: "PR #1898 was authored by the app account, not a human.",
      no_secrets_in_payload: "No secret values are present in this payload.",
      "links.PR_1898_app_authored": "https://github.com/Blockcast/paperclip/pull/1898",
    };

    expect(redactEventPayload(structuredClone(input))).toEqual(input);
  });

  it("still redacts a real key/token-shaped value under the same kind of key", () => {
    const result = redactEventPayload({
      ask_2_author_identity: "ghp_1234567890abcdefghijklmnopqrstuvwxyz",
      requestedAuthorization: "sk-live-abc123def456",
    });

    expect(result?.ask_2_author_identity).toBe(REDACTED_EVENT_VALUE);
    expect(result?.requestedAuthorization).toBe(REDACTED_EVENT_VALUE);
  });

  it("still redacts an Authorization header value with a Bearer scheme prefix", () => {
    // Mirrors mcpServers.*.headers.Authorization, which must stay redacted —
    // a scheme prefix ("Bearer ") shouldn't be enough to read as prose.
    const result = redactEventPayload({ Authorization: "Bearer gbrain_at_secret_12345" });

    expect(result?.Authorization).toBe(REDACTED_EVENT_VALUE);
  });

  it("still redacts a multi-line PEM private key (whitespace must not exempt it)", () => {
    const pem =
      "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKB\n-----END PRIVATE KEY-----";

    const result = redactEventPayload({
      ORC8R_PRIVATE_KEY: pem,
      certifierPrivateKey: pem,
    });

    expect(result?.ORC8R_PRIVATE_KEY).toBe(REDACTED_EVENT_VALUE);
    expect(result?.certifierPrivateKey).toBe(REDACTED_EVENT_VALUE);
  });

  it("still redacts a connection string carrying an inline password (URL shape must not exempt it)", () => {
    const result = redactEventPayload({
      connectionString: "postgres://app_user:hunter2@db.internal:5432/prod",
    });

    expect(result?.connectionString).toBe(REDACTED_EVENT_VALUE);
  });

  it("redacts a PEM key via redactAgentConfigPayload too", () => {
    const pem = "-----BEGIN EC PRIVATE KEY-----\nMHcCAQEE...\n-----END EC PRIVATE KEY-----";

    const result = redactAgentConfigPayload({ certifierPrivateKey: pem });

    expect(result?.certifierPrivateKey).toBe(REDACTED_EVENT_VALUE);
  });

  it("still leaves a plain URL without embedded credentials readable under a secret-ish key", () => {
    const result = redactEventPayload({
      "links.PR_1898_app_authored": "https://github.com/Blockcast/paperclip/pull/1898",
    });

    expect(result?.["links.PR_1898_app_authored"]).toBe(
      "https://github.com/Blockcast/paperclip/pull/1898",
    );
  });

  it("recurses into non-string values under a secret-ish key instead of nuking the whole structure", () => {
    const result = redactEventPayload({
      authorInfo: {
        note: "Verified via GitHub App identity.",
        token: "ghp_abcdefghijklmnopqrstuvwxyz123456",
      },
      authoredPrLinks: ["https://github.com/x/y/pull/1", "sk-live-not-a-url-secret"],
    });

    expect(result?.authorInfo).toEqual({
      note: "Verified via GitHub App identity.",
      token: REDACTED_EVENT_VALUE,
    });
    expect(result?.authoredPrLinks).toEqual([
      "https://github.com/x/y/pull/1",
      REDACTED_EVENT_VALUE,
    ]);
  });

  // Important finding (#943 review): a single-word identity under an
  // ambiguous tier-2 key ("author" contains "auth") is not credential-shaped
  // — only whitespace was ever checked before, so short opaque-looking words
  // like "octocat" were redacted despite carrying no secret.
  it("does not redact a one-word identity value or an array of them under an ambiguous key", () => {
    const result = redactEventPayload({
      author: "octocat",
      authors: ["alice", "bob"],
    });

    expect(result?.author).toBe("octocat");
    expect(result?.authors).toEqual(["alice", "bob"]);
  });

  // Critical 2 (#943 review): the object branch of the old
  // `sanitizeSecretMatchedValue` delegated to `sanitizeRecord`, which re-tested
  // each child by its OWN key name and silently dropped the parent's
  // sensitivity — `{ authorization: { value: "ghp_...", current: "..." } }`
  // leaked both fields because neither child key ("value"/"current") is
  // itself secret-shaped. `authorization` is a Tier-1 stem, so every
  // descendant leaf must be redacted regardless of the child's own key name.
  it("inherits tier-1 sensitivity into object descendants regardless of the child's own key name", () => {
    const result = redactEventPayload({
      authorization: { value: "ghp_1234567890abcdefghijklmnopqrstuvwxyz", current: "some-other-detail" },
    });

    expect(result?.authorization).toEqual({
      value: REDACTED_EVENT_VALUE,
      current: REDACTED_EVENT_VALUE,
    });
  });

  // Critical 1 (#943 review): the old URL exemption treated ANY url-shaped
  // value without inline `user:pass@` userinfo as safe, so a presigned or
  // signed-query URL under a secret-ish key displayed in full. Tier-1 keys
  // close most of this by being unconditional (apiKey below never even
  // reaches the value-shape test); this also pins the narrow credential test
  // itself for a Tier-2 key carrying a signed URL.
  it("still redacts a presigned/signed-query URL under a secret-ish key", () => {
    const result = redactEventPayload({
      apiKey: "https://hooks.slack.test/services/T000/B000/signed-webhook-value",
      base_url: "https://example.test/callback?token=abc123def456",
    });

    expect(result?.apiKey).toBe(REDACTED_EVENT_VALUE);
    expect(result?.base_url).toBe(REDACTED_EVENT_VALUE);
  });

  // Ally review (#943): a spaced passphrase or cookie value was exempted by
  // the old whitespace check. Both key stems are Tier-1 now, so the value
  // shape never matters.
  it("still redacts a spaced passphrase and a spaced cookie value", () => {
    const result = redactEventPayload({
      password: "correct horse battery staple",
      sessionCookie: "session id=abc123; path=/; secure flag set",
    });

    expect(result?.password).toBe(REDACTED_EVENT_VALUE);
    expect(result?.sessionCookie).toBe(REDACTED_EVENT_VALUE);
  });

  it("still redacts a long opaque token under an ambiguous key even without a known prefix", () => {
    const result = redactEventPayload({
      userAuthContext: "a1B2c3D4e5F6g7H8i9J0k1L2m3N4",
    });

    expect(result?.userAuthContext).toBe(REDACTED_EVENT_VALUE);
  });
});

describe("redactApprovalPayloadForDisplay (BLO-20810)", () => {
  it("names the scrubbed field instead of an ambiguous bare sentinel, and reports it", () => {
    const payload = {
      ask_2_author_identity: "PR #1898 was authored by the app account, not a human.",
      requestedAuthorization: "sk-live-abc123def456",
    };

    const { payload: displayed, redactedFields } = redactApprovalPayloadForDisplay(
      "request_board_approval",
      payload,
    );

    expect(displayed.ask_2_author_identity).toBe(payload.ask_2_author_identity);
    expect(displayed.requestedAuthorization).toBe(
      "[redacted by secret scanner: requestedAuthorization]",
    );
    expect(redactedFields).toEqual(["requestedAuthorization"]);
  });

  it("returns no redactedFields when nothing was actually scrubbed", () => {
    const { payload, redactedFields } = redactApprovalPayloadForDisplay("request_board_approval", {
      note: "everything here is plain prose",
    });

    expect(payload).toEqual({ note: "everything here is plain prose" });
    expect(redactedFields).toEqual([]);
  });

  it("leaves hire_agent's structural redaction as the bare sentinel (BLO-18969 contract)", () => {
    const { payload, redactedFields } = redactApprovalPayloadForDisplay("hire_agent", {
      adapterConfig: { env: { FOO: "value-under-a-key-no-regex-matches" } },
    });

    expect(payload).toEqual({ adapterConfig: { env: { FOO: REDACTED_EVENT_VALUE } } });
    expect(redactedFields).toEqual([]);
  });
});

// BLO-18969: `redactEventPayload` masks by key *name*, which is the wrong test
// for an agent config — a plain binding is credential material by construction.
// These pin the two redactors apart; the agent-config one must be strictly
// stronger, and the generic one must not change for its many other callers.
describe("redactAgentConfigPayload", () => {
  const SECRET = "value-under-a-key-no-regex-matches";

  it("masks a plain binding under an ordinary key at any depth", () => {
    const result = redactAgentConfigPayload({
      modelProfiles: {
        cheap: { adapterConfig: { env: { SIGNING_MATERIAL: { type: "plain", value: SECRET } } } },
      },
    });

    expect(result).toEqual({
      modelProfiles: {
        cheap: {
          adapterConfig: { env: { SIGNING_MATERIAL: { type: "plain", value: REDACTED_EVENT_VALUE } } },
        },
      },
    });
  });

  it("masks a legacy bare-string env value under an ordinary key", () => {
    expect(redactAgentConfigPayload({ env: { FOO: SECRET } })).toEqual({
      env: { FOO: REDACTED_EVENT_VALUE },
    });
  });

  it("keeps non-credential config readable", () => {
    expect(redactAgentConfigPayload({ cwd: "/workspace", model: "openai/gpt-5.6-sol" })).toEqual({
      cwd: "/workspace",
      model: "openai/gpt-5.6-sol",
    });
  });

  it("keeps secret_ref readable as a pointer but drops a resolved value", () => {
    const result = redactAgentConfigPayload({
      env: {
        FOO: {
          type: "secret_ref",
          secretId: "44444444-4444-4444-8444-444444444444",
          projectionClass: "unclassified",
          extra: "not-schema-owned",
          value: SECRET,
        },
      },
    });

    expect(result).toEqual({
      env: {
        FOO: {
          type: "secret_ref",
          secretId: "44444444-4444-4444-8444-444444444444",
          projectionClass: "unclassified",
        },
      },
    });
  });

  it("masks malformed object-valued env entries wholesale", () => {
    expect(redactAgentConfigPayload({
      runtimeConfig: {
        custom: {
          env: {
            FOO: { legacyValue: SECRET },
            BAR: { type: "unknown", value: SECRET },
            PLAIN: { type: "plain", value: SECRET, label: "ignored" },
            USER: {
              type: "user_secret_ref",
              key: "github_token",
              version: "latest",
              required: false,
              allowMissingOverride: true,
              value: SECRET,
              extra: "ignored",
            },
            BAD_SECRET_REF: {
              type: "secret_ref",
              secretId: "not-a-uuid",
              version: { value: SECRET },
              projectionClass: "unclassified",
            },
            BAD_USER_SECRET_REF: {
              type: "user_secret_ref",
              key: "github_token",
              required: { value: SECRET },
              allowMissingOverride: "yes",
            },
          },
        },
      },
    })).toEqual({
      runtimeConfig: {
        custom: {
          env: {
            FOO: REDACTED_EVENT_VALUE,
            BAR: REDACTED_EVENT_VALUE,
            PLAIN: { type: "plain", value: REDACTED_EVENT_VALUE },
            USER: {
              type: "user_secret_ref",
              key: "github_token",
              version: "latest",
              required: false,
              allowMissingOverride: true,
            },
            BAD_SECRET_REF: REDACTED_EVENT_VALUE,
            BAD_USER_SECRET_REF: REDACTED_EVENT_VALUE,
          },
        },
      },
    });
  });

  it("masks malformed env containers wholesale in agent config mode", () => {
    expect(redactAgentConfigPayload({
      runtimeConfig: {
        scalar: { env: SECRET },
        array: { env: [SECRET] },
        missing: { env: null },
      },
    })).toEqual({
      runtimeConfig: {
        scalar: { env: REDACTED_EVENT_VALUE },
        array: { env: REDACTED_EVENT_VALUE },
        missing: { env: REDACTED_EVENT_VALUE },
      },
    });
  });

  it("propagates structural redaction through non-string command args", () => {
    expect(redactAgentConfigPayload({
      commandArgs: [
        "--safe",
        { type: "plain", value: SECRET },
        { nested: { type: "plain", value: SECRET } },
        { type: "secret_ref", version: { value: SECRET } },
      ],
      argv: [{ type: "plain", value: SECRET }],
    })).toEqual({
      commandArgs: [
        "--safe",
        { type: "plain", value: REDACTED_EVENT_VALUE },
        { nested: { type: "plain", value: REDACTED_EVENT_VALUE } },
        REDACTED_EVENT_VALUE,
      ],
      argv: [{ type: "plain", value: REDACTED_EVENT_VALUE }],
    });
  });

  it("uses structural redaction only for hire approval payloads", () => {
    const payload = {
      title: "Pick deployment target",
      env: { target: "production" },
      colorChoice: { type: "plain", value: "blue" },
    };

    expect(redactApprovalPayloadByType("request_board_approval", structuredClone(payload))).toEqual(payload);
    expect(redactApprovalPayloadByType("hire_agent", structuredClone(payload))).toEqual({
      title: "Pick deployment target",
      env: { target: REDACTED_EVENT_VALUE },
      colorChoice: { type: "plain", value: REDACTED_EVENT_VALUE },
    });
  });

  it("leaves redactEventPayload unchanged for the same input", () => {
    // The generic redactor is shared with events, heartbeats and tool guards;
    // widening it was explicitly not the fix.
    const input = { env: { FOO: { type: "plain", value: SECRET } } };

    expect(redactEventPayload(structuredClone(input))).toEqual(input);
    expect(redactAgentConfigPayload(structuredClone(input))).toEqual({
      env: { FOO: { type: "plain", value: REDACTED_EVENT_VALUE } },
    });
  });

  it("returns null for nullish payloads", () => {
    expect(redactAgentConfigPayload(null)).toBeNull();
    expect(redactAgentConfigPayload(undefined)).toBeNull();
  });
});
