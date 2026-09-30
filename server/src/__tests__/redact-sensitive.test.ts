import { describe, expect, it } from "vitest";
import { redactSensitive } from "../middleware/redact-sensitive.js";

describe("redactSensitive", () => {
  it("redacts a plaintext password field on a sign-in body", () => {
    const body = { email: "user@example.com", password: "founding6gomez6croaking" };

    const out = redactSensitive(body) as Record<string, unknown>;

    expect(out.email).toBe("user@example.com");
    expect(out.password).toBe("[REDACTED]");
    expect((body as Record<string, unknown>).password).toBe("founding6gomez6croaking");
  });

  it("redacts password key regardless of casing", () => {
    expect((redactSensitive({ Password: "x" }) as Record<string, unknown>).Password).toBe("[REDACTED]");
    expect((redactSensitive({ PASSWORD: "x" }) as Record<string, unknown>).PASSWORD).toBe("[REDACTED]");
  });

  it("redacts known credential-shaped keys", () => {
    const out = redactSensitive({
      currentPassword: "a",
      newPassword: "b",
      access_token: "c",
      refresh_token: "d",
      api_key: "e",
      authorization: "Bearer f",
    }) as Record<string, string>;

    for (const value of Object.values(out)) {
      expect(value).toBe("[REDACTED]");
    }
  });

  it("does not redact a bare `token` field — pagination cursors and CSRF tokens are not credentials", () => {
    const out = redactSensitive({ token: "next-page-cursor", limit: 20 }) as Record<string, unknown>;

    expect(out.token).toBe("next-page-cursor");
    expect(out.limit).toBe(20);
  });

  it("strips secret-bearing query and fragment values from source URLs", () => {
    const out = redactSensitive({
      source: "https://github.com/acme/private-skill?token=secret#token=secret",
    }) as Record<string, unknown>;

    expect(out.source).toBe("https://github.com/acme/private-skill");
  });

  it("recurses into nested objects and arrays", () => {
    const out = redactSensitive({
      user: { email: "user@example.com", password: "secret-pass" },
      tokens: [{ access_token: "t1" }, { access_token: "t2" }],
    }) as Record<string, unknown>;

    expect((out.user as Record<string, unknown>).email).toBe("user@example.com");
    expect((out.user as Record<string, unknown>).password).toBe("[REDACTED]");
    const tokens = out.tokens as Array<Record<string, unknown>>;
    expect(tokens[0].access_token).toBe("[REDACTED]");
    expect(tokens[1].access_token).toBe("[REDACTED]");
  });

  it("leaves primitives and non-sensitive keys untouched", () => {
    const body = { email: "a@b.c", name: "Alice", count: 7, active: true, missing: null };

    expect(redactSensitive(body)).toEqual(body);
  });

  it("returns primitives unchanged", () => {
    expect(redactSensitive("hello")).toBe("hello");
    expect(redactSensitive(42)).toBe(42);
    expect(redactSensitive(null)).toBe(null);
    expect(redactSensitive(undefined)).toBe(undefined);
  });

  it("caps recursion depth so cycles do not pin the logger", () => {
    const cycle: Record<string, unknown> = { name: "root" };
    cycle.self = cycle;

    expect(() => redactSensitive(cycle)).not.toThrow();
  });

  // Credential-bearing containers (PEN-2370 series, door #11).
  //
  // `customProps` in logger.ts logs the whole request body on every 4xx/5xx.
  // `PATCH /agents/:id` and the `hire_agent` approval path both accept
  // `adapterConfig.env` in that body, and those values are credential material
  // by construction. The scalar denylist above cannot cover them: it matches
  // exact key names, and an agent's variable names (`OPENAI_API_KEY`,
  // `ANTHROPIC_BASE_URL`, …) are arbitrary and unknowable in advance.
  //
  // So these keys are treated as *containers*: every scalar leaf beneath them
  // is masked regardless of its name, while the names themselves survive so a
  // 4xx log still says which variables were set.
  describe("credential-bearing containers", () => {
    it("masks variable values beneath a config container but keeps their names", () => {
      const out = redactSensitive({
        agentId: "a-1",
        adapterConfig: { image: "harbor/agent:1", env: { OPENAI_API_KEY: "sk-live-abc123" } },
      }) as Record<string, any>;

      expect(out.agentId).toBe("a-1");
      // Name preserved (diagnostics), value gone (the leak).
      expect(Object.keys(out.adapterConfig.env)).toEqual(["OPENAI_API_KEY"]);
      expect(out.adapterConfig.env.OPENAI_API_KEY).toBe("[REDACTED]");
      expect(JSON.stringify(out)).not.toContain("sk-live-abc123");
    });

    it("masks values nested arbitrarily deep inside a container", () => {
      const out = redactSensitive({
        runtimeConfig: { modelProfiles: { cheap: { adapterConfig: { env: { TOK: "deep-secret" } } } } },
      });

      expect(JSON.stringify(out)).not.toContain("deep-secret");
    });

    it("masks an ARRAY-shaped container instead of recursing past it", () => {
      // The bypass class Ally caught in #1574: `isPlainObject` excludes arrays,
      // so a walk that only guards objects recurses *into* an array-shaped
      // config and blanks nothing while reporting success.
      const out = redactSensitive({ adapterConfig: [{ env: { K: "array-secret" } }] });

      expect(JSON.stringify(out)).not.toContain("array-secret");
    });

    it("masks a STRING-shaped container instead of passing it through", () => {
      // A container arriving as a JSON string is still credential material;
      // a walk that only handles objects hands the whole thing back verbatim.
      const out = redactSensitive({
        adapterConfig: '{"env":{"K":"string-secret"}}',
      }) as Record<string, unknown>;

      expect(out.adapterConfig).toBe("[REDACTED]");
      expect(JSON.stringify(out)).not.toContain("string-secret");
    });

    it("masks credential-bearing mcpServers and header values the scalar rules miss", () => {
      // Deliberately avoids `url` (already covered by the URL-part stripper)
      // and `authorization` (already in the scalar denylist), so this asserts
      // the container rule rather than being carried by an existing control:
      // a token in a path segment under a non-urlish key, and a bearer under a
      // vendor-specific header name nobody could have enumerated.
      const out = redactSensitive({
        mcpServers: { gbrain: { endpoint: "https://gbrain.example/mcp/url-secret" } },
        headers: { "X-Gbrain-Token": "header-secret" },
      });

      const json = JSON.stringify(out);
      expect(json).not.toContain("url-secret");
      expect(json).not.toContain("header-secret");
    });

    it("does not mask look-alike keys outside the container set", () => {
      // Guard against over-reach: these are not credential containers.
      const body = { environment: "production", configVersion: 3, envoy: "sidecar" };

      expect(redactSensitive(body)).toEqual(body);
    });
  });

  it("omits deeply-nested arrays at the depth cap instead of leaking null entries to JSON", () => {
    // Build an object whose array field is reached at MAX_DEPTH. Recursing
    // into the array elements would exceed the cap; without the array-level
    // guard, `value.map` would produce `[undefined, ...]` which JSON.stringify
    // renders as `[null, ...]`. Object properties at the same cap are
    // already absent from the JSON output (JSON.stringify skips undefined
    // values on objects), so this test pins the array path to the same
    // contract: silently absent, not visible as nulls.
    let payload: Record<string, unknown> = { values: [1, 2, 3] };
    for (let i = 0; i < 5; i++) payload = { nested: payload };

    const out = redactSensitive(payload);

    const json = JSON.stringify(out);
    expect(json).not.toContain("null");
    expect(json).not.toContain("[1,2,3]");
  });
});
