import { describe, expect, it } from "vitest";
import {
  REDACTED_EVENT_VALUE,
  maskWorkspaceRuntimeForRead,
  redactAgentConfigPayload,
  redactApprovalPayloadByType,
  redactApprovalPayloadForDisplay,
  redactEventPayload,
  redactSensitiveText,
  sanitizeRecord,
  withholdAgentConfigFromApprovalPayload,
  withholdAgentConfigKeys,
  withholdRunTranscriptStateContent,
} from "../redaction.js";
import { projectApprovalPayloadForRead } from "../agent-redaction.js";

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
      backup_base_url: "https://example.test/callback?password=hunter2",
      auth_base_url: "https://example.test/callback?authentication=hunter2",
    });

    expect(result?.apiKey).toBe(REDACTED_EVENT_VALUE);
    expect(result?.base_url).toBe(REDACTED_EVENT_VALUE);
    expect(result?.backup_base_url).toBe(REDACTED_EVENT_VALUE);
    expect(result?.auth_base_url).toBe(REDACTED_EVENT_VALUE);
  });

  // Ally review (#1219, exact head 1a7fc6e3): the detector
  // `URL_CREDENTIAL_QUERY_RE` and its documented replacing sibling
  // `URL_CREDENTIAL_PARAM_VALUE_RE` are reached by *different* keys, and the
  // test above only covers the tiered one. A tiered key (`auth_base_url`)
  // redacts the whole value via the detector; an untiered key (`url`,
  // `endpoint`, `mcpServers.*.url`) instead takes the surgical in-place
  // masker, whose alternation lacked `authentication` — so `?authentication=`
  // round-tripped in cleartext on precisely the path PEN-2747 exists for,
  // while the same URL spelled `?auth=` or `?token=` was masked. Mutation
  // check: dropping `authentication` from the sibling alone leaves every
  // other test in this file passing and fails only these two assertions.
  it("masks an untiered key's URL credential in place, for query and fragment alike", () => {
    const result = redactEventPayload({
      url: "https://host.test/mcp?authentication=hunter2",
      endpoint: "https://host.test/cb#authentication=hunter2",
    });

    expect(result?.url).toBe(`https://host.test/mcp?authentication=${REDACTED_EVENT_VALUE}`);
    expect(result?.endpoint).toBe(`https://host.test/cb#authentication=${REDACTED_EVENT_VALUE}`);
  });

  // CTO finding (#943 review, post-tiering): the URL branch returned "safe"
  // for any URL without `user:pass@` userinfo or a `?token=`-style query, so
  // a capability URL that embeds its credential directly in the path (a
  // Slack incoming-webhook shape: no userinfo, no query string) displayed in
  // full under a Tier-2 key. `base_url` is Tier 2, so unlike the `apiKey`
  // case above (Tier 1, redacts unconditionally without ever reaching
  // `looksLikeCredentialValue`), this is the case that actually exercises
  // the URL branch's path-segment gate. Mutation check: reverting only the
  // `hasOpaqueUrlPathSegment` gate (i.e. the pre-fix URL branch) makes this
  // assertion fail while every other test in this file still passes.
  it("still redacts a Tier-2 key's URL that embeds its credential as a bare path segment", () => {
    const result = redactEventPayload({
      base_url: "https://hooks.slack.test/services/T000/B000/AbCdEfGhIjKlMnOpQrSt99",
    });

    expect(result?.base_url).toBe(REDACTED_EVENT_VALUE);
  });

  it("does not redact a Tier-2 key's URL whose path segments are all short", () => {
    const result = redactEventPayload({
      base_url: "https://github.com/Blockcast/paperclip/pull/1898",
    });

    expect(result?.base_url).toBe("https://github.com/Blockcast/paperclip/pull/1898");
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

  // Confirmed live on a currently-pending approval card during BLO-20810
  // verification (post-#943-merge census), not hypothetical: an
  // `authoritative_state` field — Tier 2, since "auth" is a substring of
  // "authoritative", the same collision class as "author" — carried a long
  // whitespace-free status-slug value and was blanked by the generic
  // opaque-token length backstop. The backstop must still catch a real
  // unbroken opaque token of the same length.
  it("does not redact a long whitespace-free status-slug value under an ambiguous key, but still redacts an equally long opaque token", () => {
    const result = redactEventPayload({
      authoritative_state: "pending_human_merge_review_required_for_pr_2132",
      userAuthContext: "a1B2c3D4e5F6g7H8i9J0k1L2m3N4",
    });

    expect(result?.authoritative_state).toBe(
      "pending_human_merge_review_required_for_pr_2132",
    );
    expect(result?.userAuthContext).toBe(REDACTED_EVENT_VALUE);
  });

  // Important finding (#1136 review, head b78bb2e9): the readable-slug
  // exemption keyed on arity + part length alone, so a delimiter-chunked
  // opaque token satisfied it (3 parts, each <=12) and escaped the generic
  // backstop that is supposed to fail closed on unrecognized long values.
  // The paired benign value is the one the exemption exists for, so this
  // cannot pass by simply deleting the exemption.
  it("redacts a delimiter-chunked opaque token under an ambiguous key while keeping a real word slug readable", () => {
    const result = redactEventPayload({
      author: "a1b2c3d4-e5f6g7h8-i9j0k1l2",
      authoritative_state: "pending_human_merge_review",
    });

    expect(result?.author).toBe(REDACTED_EVENT_VALUE);
    expect(result?.authoritative_state).toBe("pending_human_merge_review");
  });

  // Same exemption, all-numeric chunking: no part mixes letters and digits,
  // so a word/number lexical test alone would still admit it. At least two
  // word-shaped parts are required, which a bare number grouping never has.
  it("redacts an all-numeric chunked token under an ambiguous key", () => {
    const result = redactEventPayload({
      author_reference: "12345678-87654321-11223344",
    });

    expect(result?.author_reference).toBe(REDACTED_EVENT_VALUE);
  });

  // The same predicate gates URL path segments, so the tightening has to hold
  // on that branch too — and must not re-blank an issue-numbered branch slug,
  // which mixes word parts with a bare number.
  it("redacts a delimiter-chunked opaque URL path segment but keeps an issue-numbered branch slug readable", () => {
    const result = redactEventPayload({
      author_link: "https://example.test/evidence/blo-20810-redaction-followup-critical-findings",
      base_url: "https://hooks.slack.test/services/T000/x9y8z7w6-v5u4t3s2-r1q0p9o8",
    });

    expect(result?.author_link).toBe(
      "https://example.test/evidence/blo-20810-redaction-followup-critical-findings",
    );
    expect(result?.base_url).toBe(REDACTED_EVENT_VALUE);
  });

  // Residual finding (#943 review, post-tiering): `auth`/`secret` as a whole
  // token in a short key (<=2 tokens) is an ordinary credential field name,
  // not the "author"/"no_secrets_in_payload" collision Tier 2 exists for —
  // it must not fall through `looksLikeCredentialValue`'s length/shape gate
  // just because the value happens to be short.
  it("redacts a short value under a real auth/secret field name regardless of length or shape", () => {
    const result = redactEventPayload({
      secret: "hunter2",
      client_secret: "s3cr3t99",
      webhook_secret: "abc123XY",
      auth: "pw12345",
      authentication: "hunter2",
      clientAuthentication: "short-password",
      clientSecret: "another-short-one",
    });

    expect(result?.secret).toBe(REDACTED_EVENT_VALUE);
    expect(result?.client_secret).toBe(REDACTED_EVENT_VALUE);
    expect(result?.webhook_secret).toBe(REDACTED_EVENT_VALUE);
    expect(result?.auth).toBe(REDACTED_EVENT_VALUE);
    expect(result?.authentication).toBe(REDACTED_EVENT_VALUE);
    expect(result?.clientAuthentication).toBe(REDACTED_EVENT_VALUE);
    expect(result?.clientSecret).toBe(REDACTED_EVENT_VALUE);
  });

  it("does not promote base_url, or sentence-shaped/multi-token keys, to tier 1", () => {
    const input = {
      base_url: "short",
      author: "octocat",
      authors: ["alice", "bob"],
      ask_2_author_identity: "PR #1898 was authored by the app account, not a human.",
      no_secrets_in_payload: "No secret values are present in this payload.",
      secret_fields_must_stay_redacted: "This field intentionally left blank.",
      no_secret_values_in_this_report: "No secret values are present in this report.",
    };

    expect(redactEventPayload(structuredClone(input))).toEqual(input);
  });

  // Still-present finding (#943 review, head b7620dba): the original
  // "<=2 tokens" cap under-promoted real three-token-plus credential field
  // names, so `stripe_webhook_secret` stayed Tier 2 and a short value under
  // it fell through `looksLikeCredentialValue`'s shape gate. Promotion is now
  // keyed on the trigger word being the *trailing* token, which fixes these
  // while the sentence-shaped collisions above (trigger word mid-sentence)
  // are untouched.
  it("promotes multi-token credential field names ending in auth/secret to tier 1 regardless of token count", () => {
    const result = redactEventPayload({
      stripe_webhook_secret: "whsec123",
      database_client_secret: "s3cr3t99",
      my_webhook_secret: "hunter2",
      thirdPartyAuth: "pw12345",
    });

    expect(result?.stripe_webhook_secret).toBe(REDACTED_EVENT_VALUE);
    expect(result?.database_client_secret).toBe(REDACTED_EVENT_VALUE);
    expect(result?.my_webhook_secret).toBe(REDACTED_EVENT_VALUE);
    expect(result?.thirdPartyAuth).toBe(REDACTED_EVENT_VALUE);
  });

  // Still-present finding (#943 review, head b7620dba): the URL branch only
  // ever inspected `search`, so an OAuth2 implicit-flow fragment
  // (`#access_token=...`) crossed the approval display boundary in
  // plaintext under a Tier-2 key.
  it("still redacts a Tier-2 key's URL carrying a credential in the fragment", () => {
    const result = redactEventPayload({
      base_url: "https://client.example/callback#access_token=abc123def456&token_type=bearer",
    });

    expect(result?.base_url).toBe(REDACTED_EVENT_VALUE);
  });

  // Still-present finding (#943 review, head b7620dba): every whitespace-free
  // path segment >=20 chars was treated as opaque/credential-shaped, which
  // re-blanks exactly the kind of evidence link (commit SHA, UUID, slug)
  // this issue exists to stop over-redacting.
  it("does not redact benign long identifier-shaped path segments under a Tier-2 key", () => {
    const result = redactEventPayload({
      base_url: "https://github.com/Blockcast/paperclip/commit/76c13c6e9a883091335220be89cdcf12b2823ad9",
      links: {
        no_secrets_in_payload_uuid: "https://example.test/evidence/550e8400-e29b-41d4-a716-446655440000",
        author_link: "https://example.test/blo-20810-approval-redaction-key-name",
      },
    });

    expect(result?.base_url).toBe(
      "https://github.com/Blockcast/paperclip/commit/76c13c6e9a883091335220be89cdcf12b2823ad9",
    );
    expect(result?.links).toEqual({
      no_secrets_in_payload_uuid: "https://example.test/evidence/550e8400-e29b-41d4-a716-446655440000",
      author_link: "https://example.test/blo-20810-approval-redaction-key-name",
    });
  });

  it("still redacts a Slack-style opaque webhook secret path segment (mutation guard for the slug/hex exemptions)", () => {
    const result = redactEventPayload({
      base_url: "https://hooks.slack.test/services/T000/B000/AbCdEfGhIjKlMnOpQrSt99",
    });

    expect(result?.base_url).toBe(REDACTED_EVENT_VALUE);
  });

  // Critical (#943 review, post-tiering): a Tier-2 parent (`authorInfo`
  // contains "auth" but isn't a Tier-1 stem) used to suppress every child's
  // own classification, so `password`/`apiKey`/`token` — all Tier-1 stems —
  // leaked wholesale underneath it. A child's own tier must win when it's
  // stronger than the inherited one.
  it("redacts tier-1 child keys unconditionally even beneath an ambiguous tier-2 parent", () => {
    const result = redactEventPayload({
      authorInfo: {
        password: "hunter2",
        apiKey: "abc123",
        token: "short-token",
        note: "Verified via GitHub App identity.",
      },
    });

    expect(result?.authorInfo).toEqual({
      password: REDACTED_EVENT_VALUE,
      apiKey: REDACTED_EVENT_VALUE,
      token: REDACTED_EVENT_VALUE,
      note: "Verified via GitHub App identity.",
    });
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

  it("withholds every agent-config subtree from a hire payload, at any depth (PEN-2777)", () => {
    // The redactors above decide what is secret; this decides what an
    // ungranted caller is entitled to. The masked-but-diagnosable upstream is
    // exactly what survives them, so it is what has to be withheld here.
    const upstream = "https://svc-account@k8s-mcp-admin.internal:8443/mcp";
    const payload = {
      name: "Worker",
      adapterType: "claude_k8s",
      adapterConfig: { mcpServers: { k8s: { url: upstream } } },
      runtimeConfig: { modelProfiles: { cheap: { adapterConfig: { mcpServers: {} } } } },
      requestedConfigurationSnapshot: {
        adapterType: "claude_k8s",
        adapterConfig: { mcpServers: { k8s: { url: upstream } } },
      },
    };

    const { payload: withheld, withheldFields } = withholdAgentConfigFromApprovalPayload(
      "hire_agent",
      structuredClone(payload),
    );

    expect(JSON.stringify(withheld)).not.toContain("k8s-mcp-admin.internal");
    expect(withheld).toEqual({
      name: "Worker",
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: {},
      requestedConfigurationSnapshot: { adapterType: "claude_k8s", adapterConfig: {} },
    });
    expect(withheldFields).toEqual([
      "adapterConfig",
      "runtimeConfig",
      "requestedConfigurationSnapshot.adapterConfig",
    ]);
  });

  it("withholds non-object agent-config values, which the payload schema permits (PEN-2777)", () => {
    // `approvalPayloadSchema` is a `.catchall(z.unknown())` and
    // `normalizeHireApprovalPayloadForPersistence` only normalizes a record, so
    // `POST /companies/:companyId/approvals` can persist any shape under these
    // keys. An array of configs and a JSON-encoded string both carry the
    // upstream topology, so letting the shape decide entitlement would reopen
    // the hole through the generic create route.
    const upstream = "https://svc-account@k8s-mcp-admin.internal:8443/mcp";
    const { payload: withheld, withheldFields } = withholdAgentConfigFromApprovalPayload("hire_agent", {
      name: "Worker",
      adapterConfig: [{ mcpServers: { k8s: { url: upstream } } }],
      runtimeConfig: JSON.stringify({ mcpServers: { k8s: { url: upstream } } }),
      requestedConfigurationSnapshot: { adapterConfig: [{ mcpServers: { k8s: { url: upstream } } }] },
    });

    expect(JSON.stringify(withheld)).not.toContain("k8s-mcp-admin.internal");
    expect(withheld).toEqual({
      name: "Worker",
      adapterConfig: {},
      runtimeConfig: {},
      requestedConfigurationSnapshot: { adapterConfig: {} },
    });
    expect(withheldFields).toEqual([
      "adapterConfig",
      "runtimeConfig",
      "requestedConfigurationSnapshot.adapterConfig",
    ]);
  });

  it("keeps an absent agent config readable rather than reporting it withheld (PEN-2777)", () => {
    // `null` carries no topology, and blanking it would make the board queue
    // unable to tell "you may not see this" from "no config was requested".
    const { payload: withheld, withheldFields } = withholdAgentConfigFromApprovalPayload("hire_agent", {
      name: "Worker",
      adapterConfig: null,
      runtimeConfig: undefined,
    });

    expect(withheld).toEqual({ name: "Worker", adapterConfig: null, runtimeConfig: undefined });
    expect(withheldFields).toEqual([]);
  });

  it("leaves non-hire approval payloads untouched when withholding agent config", () => {
    const payload = { title: "Ship it", adapterConfig: { note: "not a hire card" } };
    const { payload: untouched, withheldFields } = withholdAgentConfigFromApprovalPayload(
      "request_board_approval",
      structuredClone(payload),
    );

    expect(untouched).toEqual(payload);
    expect(withheldFields).toEqual([]);
  });

  it("withholds the agent config pair from any read projection, not only hire cards (PEN-2839)", () => {
    // Door #10: the skill test-run `agentConfigSnapshot` reaches the same pair
    // under `company_scope:read`, the same weaker entitlement PEN-2777 closed
    // on the approval card. It shares this walk rather than copying it, so the
    // array/JSON-string bypass Ally caught in #1574 cannot be re-derived and
    // re-missed on the second path.
    const upstream = "https://svc-account@k8s-mcp-admin.internal:8443/mcp";
    const { payload: withheld, withheldFields } = withholdAgentConfigKeys({
      agentId: "agent-1",
      name: "Worker",
      adapterConfig: { env: { OPENAI_API_KEY: SECRET }, mcpServers: { k8s: { url: upstream } } },
      runtimeConfig: [{ mcpServers: { k8s: { url: upstream } } }],
    });

    expect(JSON.stringify(withheld)).not.toContain(SECRET);
    expect(JSON.stringify(withheld)).not.toContain("k8s-mcp-admin.internal");
    expect(withheld).toEqual({
      agentId: "agent-1",
      name: "Worker",
      adapterConfig: {},
      runtimeConfig: {},
    });
    expect(withheldFields).toEqual(["adapterConfig", "runtimeConfig"]);
  });

  it("keeps withholdAgentConfigFromApprovalPayload's hire-only precondition after the extraction (PEN-2839)", () => {
    // The extraction must not widen the approval filter. `withholdAgentConfigKeys`
    // has no type precondition by design; the approval wrapper must still refuse
    // to touch a non-hire card, or PEN-2777's scoping silently becomes global.
    const payload = { title: "Ship it", adapterConfig: { note: "not a hire card" } };

    expect(withholdAgentConfigFromApprovalPayload("request_board_approval", structuredClone(payload)))
      .toEqual({ payload, withheldFields: [] });
    expect(withholdAgentConfigKeys(structuredClone(payload))).toEqual({
      payload: { title: "Ship it", adapterConfig: {} },
      withheldFields: ["adapterConfig"],
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

// PEN-2846, door #12. `compactIssueExecutionWorkspace` is a withholding boundary
// (it enumerates ~24 fields and sets `metadata: null`) that `config.workspaceRuntime`
// crossed verbatim. That field is an open `Record<string, unknown>` an operator
// authors by hand, so its leaf key names are unknowable in advance and no denylist
// can cover them. The walk therefore defaults to masking and lets through only the
// few keys `listWorkspaceCommandDefinitions` reads into a typed field.
//
// The control these tests are written against is the *unfixed* behaviour — the
// projection returning `workspace.config.workspaceRuntime` unchanged — so each case
// below is stated as "this value must not survive an identity pass-through", except
// the two marked as over-reach guards, which exist to fail if the walk masks more
// than it should.
describe("maskWorkspaceRuntimeForRead (PEN-2846)", () => {
  const SECRET = "operator-authored-value-no-list-could-name";

  it("masks an operator-authored credential beside a service definition, keeping its name", () => {
    // The shape the finding turns on: the credential is a *direct sibling* of
    // `name`, not nested under an `env`/`headers` container anyone could enumerate,
    // because `buildWorkspaceCommandDefinition` keeps the whole entry
    // (`rawConfig: { ...entry }`) after reading only its six typed fields.
    const masked = maskWorkspaceRuntimeForRead({
      services: [{ name: "api", command: "pnpm dev", GRAFANA_API_TOKEN: SECRET }],
    }) as any;

    expect(JSON.stringify(masked)).not.toContain(SECRET);
    // Name of the variable survives; its value does not. PEN-2370 ask 1.
    expect(Object.keys(masked.services[0])).toEqual(["name", "command", "GRAFANA_API_TOKEN"]);
    expect(masked.services[0].GRAFANA_API_TOKEN).toBe(REDACTED_EVENT_VALUE);
  });

  it("masks a variable that merely happens to be named like an identity key", () => {
    // The hole a "honour `id`/`name` at any depth" implementation opens: an `env`
    // map's keys are arbitrary, so a variable literally called `name` would survive
    // on the strength of its spelling. Identity keys are honoured only on an entry
    // sitting directly inside a `commands`/`services`/`jobs` array.
    const masked = maskWorkspaceRuntimeForRead({
      services: [{ name: "api", env: { name: SECRET, id: SECRET } }],
    }) as any;

    expect(JSON.stringify(masked)).not.toContain(SECRET);
    expect(masked.services[0].name).toBe("api");
    expect(masked.services[0].env).toEqual({ name: REDACTED_EVENT_VALUE, id: REDACTED_EVENT_VALUE });
  });

  it("masks an ARRAY-shaped runtime config instead of recursing past it", () => {
    // The bypass class Ally caught in #1574: a walk that guards only plain objects
    // recurses into an array-shaped config and blanks nothing while reporting success.
    expect(JSON.stringify(maskWorkspaceRuntimeForRead([{ services: [{ TOKEN: SECRET }] }])))
      .not.toContain(SECRET);
  });

  it("masks a STRING-shaped runtime config instead of passing it through", () => {
    // `workspaceRuntime` is persisted as jsonb and typed `Record<string, unknown>`,
    // but the type is not a runtime guarantee; a JSON string carries the same
    // material and a walk handling only objects hands it back verbatim.
    expect(maskWorkspaceRuntimeForRead(`{"services":[{"TOKEN":"${SECRET}"}]}`))
      .toBe(REDACTED_EVENT_VALUE);
  });

  it("masks values under a top-level key the shared parser does not read", () => {
    // Default-deny: `commands`/`services`/`jobs` are the only keys
    // `listWorkspaceCommandDefinitions` reads. Anything else an operator adds is
    // masked without this file changing — the property a name list cannot have.
    const masked = maskWorkspaceRuntimeForRead({ compose: { secrets: { db: SECRET } } }) as any;

    expect(JSON.stringify(masked)).not.toContain(SECRET);
    expect(masked.compose.secrets.db).toBe(REDACTED_EVENT_VALUE);
  });

  it("masks a service entry's free-text command and cwd", () => {
    // Not identity keys, and nothing addresses an entry by them. A command line is
    // one of the likelier places for an inline credential.
    const masked = maskWorkspaceRuntimeForRead({
      services: [{ name: "db", command: `psql postgres://u:${SECRET}@h/db`, cwd: `/srv/${SECRET}` }],
    }) as any;

    expect(JSON.stringify(masked)).not.toContain(SECRET);
    expect(masked.services[0].command).toBe(REDACTED_EVENT_VALUE);
    expect(masked.services[0].cwd).toBe(REDACTED_EVENT_VALUE);
  });

  it("fails closed past the depth cap rather than recursing", () => {
    let nested: Record<string, unknown> = { leaf: SECRET };
    for (let i = 0; i < 40; i += 1) nested = { deeper: nested };

    expect(JSON.stringify(maskWorkspaceRuntimeForRead(nested))).not.toContain(SECRET);
  });

  // Over-reach guards. These are green against the unfixed pass-through by
  // construction — they are not fail-first evidence, and are here to fail if the
  // walk masks more than it should. Stated explicitly so the suite's red count is
  // not read as covering them.
  it("keeps the identity a control tool addresses a configured command by", () => {
    // `paperclipControlIssueWorkspaceServices` targets a command by the id
    // `buildWorkspaceCommandDefinition` derives from `id`/`name`/`label`/`title`;
    // `kind` and `lifecycle` are closed enums the same parser reads. Masking these
    // would leave the tool unable to name what it acts on.
    const masked = maskWorkspaceRuntimeForRead({
      services: [{ id: "svc-api", name: "api", label: "API", title: "API", kind: "service", lifecycle: "shared" }],
    }) as any;

    expect(masked.services[0]).toEqual({
      id: "svc-api",
      name: "api",
      label: "API",
      title: "API",
      kind: "service",
      lifecycle: "shared",
    });
  });

  it("masks a non-enum value under an enum key, and passes nullish through", () => {
    const masked = maskWorkspaceRuntimeForRead({
      services: [{ name: "api", kind: SECRET, lifecycle: SECRET }],
    }) as any;

    expect(JSON.stringify(masked)).not.toContain(SECRET);
    expect(masked.services[0].kind).toBe(REDACTED_EVENT_VALUE);
    // `null` carries nothing and is the honest "no runtime configured" every
    // caller already branches on, including the UI's `Boolean(...)` presence check.
    expect(maskWorkspaceRuntimeForRead(null)).toBeNull();
    expect(maskWorkspaceRuntimeForRead(undefined)).toBeUndefined();
  });
});

/**
 * PEN-3142 — the `resultJson` projection on the run-state route. The gate
 * decides WHETHER a reader sees transcript content; this decides what is left
 * of the blob when they do not.
 */
describe("withholdRunTranscriptStateContent resultJson arrays (PEN-3142)", () => {
  const SECRET = "SUPER-SECRET-TRANSCRIPT-CANARY-a1b2c3";

  it("nulls a withheld array element IN PLACE rather than compacting the array", () => {
    const projected = withholdRunTranscriptStateContent({
      resultJson: { errors: [SECRET, 42, true] },
    }) as any;

    // Splicing the prose out would shift every later element down, so a
    // consumer reading `errors[1]` positionally would silently get `errors[2]`
    // — a wrong answer where a null is a visibly missing one.
    expect(projected.resultJson.errors).toEqual([null, 42, true]);
    expect(JSON.stringify(projected)).not.toContain(SECRET);
    // Distinguishable from an element that was genuinely null.
    expect(projected.withheldFields).toContain("resultJson.errors[0]");
  });

  it("withholds the field entirely when every element was transcript", () => {
    const projected = withholdRunTranscriptStateContent({
      resultJson: { errors: [SECRET, `${SECRET}-2`] },
    }) as any;

    // An array of nulls would disclose how many prose elements there were.
    expect(projected.resultJson).not.toHaveProperty("errors");
    expect(JSON.stringify(projected)).not.toContain(SECRET);
  });

  it("keeps an array whose elements are all machine values untouched", () => {
    const projected = withholdRunTranscriptStateContent({
      resultJson: { permission_denials: [{ num_turns: 2, summary: SECRET }], counts: [1, 2, 3] },
    }) as any;

    expect(projected.resultJson.counts).toEqual([1, 2, 3]);
    // Elements inherit the array's key, so an object element still recurses.
    expect(projected.resultJson.permission_denials).toEqual([{ num_turns: 2 }]);
    expect(JSON.stringify(projected)).not.toContain(SECRET);
  });
});

/**
 * PEN-3142 (Ally review 5438353035): the read-side projection walks the SAME
 * `resultJson` column as `redactRunResultJsonValue`, which has been bounded at
 * `MAX_RUN_RESULT_JSON_REDACT_DEPTH` since PEN-3153 on the stated grounds that
 * "adapter output is attacker-influenced in SHAPE as well as content". The two
 * walks now agree on that cap.
 *
 * The cut fails CLOSED — the over-deep subtree is withheld, not emitted — so
 * the only way to be wrong here is to disclose less, never more.
 */
describe("withholdRunTranscriptStateContent resultJson depth bound (PEN-3142)", () => {
  const SECRET = "SUPER-SECRET-TRANSCRIPT-CANARY-a1b2c3";

  /** Wrap `leaf` in `depth` nested `{ child: … }` objects. */
  const nest = (depth: number, leaf: unknown): unknown => {
    let node: unknown = leaf;
    for (let index = 0; index < depth; index += 1) node = { child: node };
    return node;
  };

  it("still recurses to a machine value nested within the cap", () => {
    // Guards the opposite error: a cap set too shallow would silently start
    // withholding the ordinary nesting this projection exists to serve.
    const projected = withholdRunTranscriptStateContent({
      resultJson: { root: nest(10, { num_turns: 7, summary: SECRET }) },
    }) as any;

    let node = projected.resultJson.root;
    for (let index = 0; index < 10; index += 1) node = node.child;
    expect(node).toEqual({ num_turns: 7 });
    expect(JSON.stringify(projected)).not.toContain(SECRET);
  });

  it("withholds the subtree past the cap instead of walking it", () => {
    const projected = withholdRunTranscriptStateContent({
      resultJson: { root: nest(40, { num_turns: 7, summary: SECRET }) },
    }) as any;

    // The machine value is genuinely reachable — it is withheld because of
    // where it sits, not because of what it is. Failing closed is the point.
    expect(JSON.stringify(projected)).not.toContain("num_turns");
    expect(JSON.stringify(projected)).not.toContain(SECRET);
    // The cut is named rather than silent.
    expect(
      projected.withheldFields.some((field: string) => field.startsWith("resultJson.root")),
    ).toBe(true);
  });

  it("does not blow the stack on a pathologically deep tree", () => {
    // The unbounded walk would recurse once per level. An entitled reader
    // skips this projection entirely, so a RangeError here would 500 only
    // UNENTITLED readers — denial of the gate, by the party the gate exists
    // to stop.
    const projected = withholdRunTranscriptStateContent({
      resultJson: { root: nest(50_000, { summary: SECRET }) },
    }) as any;

    expect(JSON.stringify(projected)).not.toContain(SECRET);
  });
});


// PEN-5225 (2026-11-01), round 2. `maskAgentWorkspaceStrategyCommands` closed the agent-config
// admission gate, which shut `GET /api/agents/:id`. The `hire_agent` approval card carries the
// SAME BYTES one route over — `routes/agents.ts` writes `adapterConfig` into the payload twice
// (again under `requestedConfigurationSnapshot`) through `redactEventPayload` alone, which has
// never known about `workspaceStrategy` — and three read paths serialize it. Those paths gate on
// `agent_config:read`, which `agents:configure` / `agents:suggest-changes` CLEAR, so a peer
// holding either read `provisionCommand` in the clear while every other route withheld it. That
// is the two-exits-one-answer split (PEN-4775); `projectApprovalPayloadForRead` is the one
// projection all three now share.
describe("hire_agent approval payload workspace-command withholding (PEN-5225)", () => {
  const PROVISION = "FOO_TOKEN=prov_secret_13579 ./provision.sh";
  const TEARDOWN = "FOO_TOKEN=tear_secret_24680 ./teardown.sh";
  const PARENT_DIR = "/srv/operator/worktrees";

  const ENTITLED = { revealRuntimeConfig: true };
  const WITHHELD = { revealRuntimeConfig: false };

  function strategy() {
    return {
      type: "git_worktree",
      runScope: "per_issue",
      baseRef: "main",
      branchTemplate: "agent/{issue}",
      provisionCommand: PROVISION,
      teardownCommand: TEARDOWN,
      worktreeParentDir: PARENT_DIR,
    };
  }

  function hirePayload() {
    const adapterConfig = { image: "harbor.example.net/agent:sha-1234", workspaceStrategy: strategy() };
    return {
      name: "New Worker",
      adapterType: "claude_k8s",
      adapterConfig,
      runtimeConfig: {
        modelProfiles: { cheap: { adapterConfig: { workspaceStrategy: strategy() } } },
      },
      requestedConfigurationSnapshot: { adapterType: "claude_k8s", adapterConfig },
    };
  }

  /** Every place a host-executed string could surface, flattened. */
  function serialized(value: unknown) {
    return JSON.stringify(value);
  }

  it("withholds the commands from a reader that holds agent_config:read but not workspace_runtime:read", () => {
    // THE SHIPPED BUG. Both gates must be resolved independently: a fixture that answers one
    // boolean for both cannot see this case, because the disclosing reader is precisely the one
    // that passes gate 1 and fails gate 2.
    const { payload, withheldFields } = projectApprovalPayloadForRead("hire_agent", hirePayload(), {
      includeAgentConfig: true,
      workspaceCommandViewer: WITHHELD,
    });

    expect(serialized(payload)).not.toContain("prov_secret_13579");
    expect(serialized(payload)).not.toContain("tear_secret_24680");
    expect(serialized(payload)).not.toContain(PARENT_DIR);

    const adapter = payload.adapterConfig as any;
    expect(adapter.workspaceStrategy.provisionCommand).toBe(REDACTED_EVENT_VALUE);
    expect(adapter.workspaceStrategy.teardownCommand).toBe(REDACTED_EVENT_VALUE);
    expect(adapter.workspaceStrategy.worktreeParentDir).toBe(REDACTED_EVENT_VALUE);

    // The SECOND copy, which is what makes this a payload-shaped problem rather than a key-shaped
    // one: masking `adapterConfig` alone would leave the same bytes under the snapshot.
    const snapshot = (payload.requestedConfigurationSnapshot as any).adapterConfig;
    expect(snapshot.workspaceStrategy.provisionCommand).toBe(REDACTED_EVENT_VALUE);

    // And the nested model-profile carrier the write guard already refuses by name.
    const nested = (payload.runtimeConfig as any).modelProfiles.cheap.adapterConfig;
    expect(nested.workspaceStrategy.provisionCommand).toBe(REDACTED_EVENT_VALUE);

    // Gate 1 passed, so nothing is reported withheld by it — the two gates stay distinguishable.
    expect(withheldFields).toEqual([]);
    // Unrelated strategy keys ride through: this is a mask over an open column, not a projection
    // of a closed type, so deleting an unclassified sibling would be data loss.
    expect(adapter.workspaceStrategy.type).toBe("git_worktree");
    expect(adapter.workspaceStrategy.baseRef).toBe("main");
    expect(adapter.workspaceStrategy.branchTemplate).toBe("agent/{issue}");
    expect(adapter.image).toBe("harbor.example.net/agent:sha-1234");
    expect(payload.name).toBe("New Worker");
  });

  it("still discloses the commands to a reader that clears workspace_runtime:read", () => {
    // The other direction, and the reason this is a viewer gate rather than an unconditional mask:
    // an entitled human operator reads and edits these values unchanged.
    const { payload } = projectApprovalPayloadForRead("hire_agent", hirePayload(), {
      includeAgentConfig: true,
      workspaceCommandViewer: ENTITLED,
    });

    expect((payload.adapterConfig as any).workspaceStrategy.provisionCommand).toBe(PROVISION);
    expect((payload.adapterConfig as any).workspaceStrategy.teardownCommand).toBe(TEARDOWN);
    expect((payload.adapterConfig as any).workspaceStrategy.worktreeParentDir).toBe(PARENT_DIR);
  });

  it("withholds by default when a caller resolves no viewer at all", () => {
    // The polarity that makes a forgotten call site fail safe. `listApprovalsForIssue` has five
    // callers and two of them pass no options, so this default is load-bearing, not decorative.
    const { payload } = projectApprovalPayloadForRead("hire_agent", hirePayload(), {
      includeAgentConfig: true,
    });

    expect(serialized(payload)).not.toContain("prov_secret_13579");
    expect((payload.adapterConfig as any).workspaceStrategy.provisionCommand).toBe(REDACTED_EVENT_VALUE);
  });

  it("keeps both gates independent: failing agent_config:read still blanks the pair", () => {
    // PEN-2777's answer must survive the new gate rather than be replaced by it.
    const { payload, withheldFields } = projectApprovalPayloadForRead("hire_agent", hirePayload(), {
      includeAgentConfig: false,
      workspaceCommandViewer: WITHHELD,
    });

    expect(payload.adapterConfig).toEqual({});
    expect(payload.runtimeConfig).toEqual({});
    expect(withheldFields).toEqual([
      "adapterConfig",
      "runtimeConfig",
      "requestedConfigurationSnapshot.adapterConfig",
    ]);
    expect(serialized(payload)).not.toContain("prov_secret_13579");
  });

  it("preserves withheld-is-not-absent for each of the three keys", () => {
    const { payload } = projectApprovalPayloadForRead(
      "hire_agent",
      {
        adapterConfig: {
          workspaceStrategy: { type: "git_worktree", provisionCommand: null, teardownCommand: PROVISION },
        },
      },
      { includeAgentConfig: true, workspaceCommandViewer: WITHHELD },
    );

    const s = (payload.adapterConfig as any).workspaceStrategy;
    // null stays null ("not configured"), a value becomes the sentinel ("withheld"), and an
    // absent key stays absent. A reader that cannot tell those apart is the PEN-4775 failure.
    expect(s.provisionCommand).toBeNull();
    expect(s.teardownCommand).toBe(REDACTED_EVENT_VALUE);
    expect(Object.prototype.hasOwnProperty.call(s, "worktreeParentDir")).toBe(false);
  });

  it("masks a non-object workspaceStrategy whole rather than spreading it", () => {
    // The column has no shape guarantee at any layer, and `approvalPayloadSchema` is a
    // `.catchall(z.unknown())`. Spreading a string would emit its characters.
    const { payload } = projectApprovalPayloadForRead(
      "hire_agent",
      { adapterConfig: { workspaceStrategy: `provision: ${PROVISION}` } },
      { includeAgentConfig: true, workspaceCommandViewer: WITHHELD },
    );

    expect((payload.adapterConfig as any).workspaceStrategy).toBe(REDACTED_EVENT_VALUE);
    expect(serialized(payload)).not.toContain("prov_secret_13579");
  });

  it("leaves a non-hire card untouched, so the scoping does not become global", () => {
    // Another type's payload is filer-authored prose, not an agent config. An agent filing a card
    // ABOUT a provision command must not have its own text masked.
    const { payload, withheldFields } = projectApprovalPayloadForRead(
      "request_board_approval",
      { title: "Ship it", workspaceStrategy: { provisionCommand: PROVISION } },
      { includeAgentConfig: false, workspaceCommandViewer: WITHHELD },
    );

    expect(payload).toEqual({ title: "Ship it", workspaceStrategy: { provisionCommand: PROVISION } });
    expect(withheldFields).toEqual([]);
  });

  /**
   * Round 3 — the SHAPE half of gate 3, raised by Ally reviewing `68f772d`.
   *
   * The mask finds `workspaceStrategy` by descending plain objects and arrays. `POST
   * /companies/:companyId/approvals` persists whatever the filer sent (`.catchall(z.unknown())`),
   * so a JSON-ENCODED config carries the commands in bytes that walk cannot reach. The reader at
   * risk is the same one the whole row is about: entitled to the config, not to the commands.
   */
  describe("a config shape the command mask cannot walk into", () => {
    const encoded = () => JSON.stringify({ image: "harbor.example.net/agent:sha-1234", workspaceStrategy: strategy() });

    it("blanks a string-encoded adapterConfig instead of returning it in the clear", () => {
      const { payload } = projectApprovalPayloadForRead(
        "hire_agent",
        { name: "New Worker", adapterConfig: encoded() },
        { includeAgentConfig: true, workspaceCommandViewer: WITHHELD },
      );

      expect(payload.adapterConfig).toBe(REDACTED_EVENT_VALUE);
      expect(serialized(payload)).not.toContain("prov_secret_13579");
      expect(serialized(payload)).not.toContain("tear_secret_24680");
      expect(serialized(payload)).not.toContain(PARENT_DIR);
      // Withheld, not absent, and the rest of the card still reads.
      expect(payload.name).toBe("New Worker");
    });

    it("blanks an array-valued config too, which is the branch `!isPlainObject` is doing the work in", () => {
      // Raised by Ally reviewing `7024740`: every other case here is a string or `null`, so
      // narrowing the gate to `typeof entry === "string"` would leave this suite green while
      // re-opening the shape it was written to close. The walk DOES descend arrays, so this case
      // is not covered by the string reasoning — it is the deliberate fail-closed choice the
      // docblock records, and an element that is itself encoded is exactly why.
      const { payload } = projectApprovalPayloadForRead(
        "hire_agent",
        { name: "New Worker", adapterConfig: [encoded()] },
        { includeAgentConfig: true, workspaceCommandViewer: WITHHELD },
      );

      expect(payload.adapterConfig).toBe(REDACTED_EVENT_VALUE);
      expect(serialized(payload)).not.toContain("prov_secret_13579");
      expect(serialized(payload)).not.toContain("tear_secret_24680");
      expect(payload.name).toBe("New Worker");
    });

    it("reaches the snapshot depth and a string-encoded runtimeConfig too", () => {
      // The card carries the pair twice. A gate that only knew the top level would leave the
      // copy — which is how this class of hole has reopened before.
      const { payload } = projectApprovalPayloadForRead(
        "hire_agent",
        {
          runtimeConfig: encoded(),
          requestedConfigurationSnapshot: { adapterType: "claude_k8s", adapterConfig: encoded() },
        },
        { includeAgentConfig: true, workspaceCommandViewer: WITHHELD },
      );

      expect(payload.runtimeConfig).toBe(REDACTED_EVENT_VALUE);
      expect((payload.requestedConfigurationSnapshot as any).adapterConfig).toBe(REDACTED_EVENT_VALUE);
      expect((payload.requestedConfigurationSnapshot as any).adapterType).toBe("claude_k8s");
      expect(serialized(payload)).not.toContain("prov_secret_13579");
    });

    it("is a VIEWER gate, not an unconditional blank: an entitled reader still gets the string", () => {
      // The other direction. The board decides the hire and must see what it is approving, in
      // whatever shape the card was filed in.
      const { payload } = projectApprovalPayloadForRead(
        "hire_agent",
        { adapterConfig: encoded() },
        { includeAgentConfig: true, workspaceCommandViewer: ENTITLED },
      );

      expect(payload.adapterConfig).toBe(encoded());
    });

    it("keeps null and absent readable, which is the honest 'no config was requested'", () => {
      // Matches `withholdAgentConfigKeys`: these carry no commands, and turning them into a
      // sentinel would manufacture a withholding where the truth is that nothing was set.
      const { payload } = projectApprovalPayloadForRead(
        "hire_agent",
        { name: "New Worker", adapterConfig: null },
        { includeAgentConfig: true, workspaceCommandViewer: WITHHELD },
      );

      expect(payload.adapterConfig).toBeNull();
      expect(Object.prototype.hasOwnProperty.call(payload, "runtimeConfig")).toBe(false);
    });

    it("changes nothing for a reader that cannot clear agent_config:read either", () => {
      // Gate 2 has already blanked the pair to `{}` at ANY shape, so gate 3a must compose to a
      // no-op rather than overwrite that with a different sentinel — two gates, one answer.
      const { payload, withheldFields } = projectApprovalPayloadForRead(
        "hire_agent",
        { adapterConfig: encoded() },
        { includeAgentConfig: false, workspaceCommandViewer: WITHHELD },
      );

      expect(payload.adapterConfig).toEqual({});
      expect(withheldFields).toEqual(["adapterConfig"]);
    });
  });
});
