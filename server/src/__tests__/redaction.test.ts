import { describe, expect, it } from "vitest";
import {
  REDACTED_EVENT_VALUE,
  redactAgentConfigPayload,
  redactApprovalPayloadByType,
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
          },
        },
      },
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
