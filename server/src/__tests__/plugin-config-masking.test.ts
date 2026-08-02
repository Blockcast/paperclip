import { describe, expect, it } from "vitest";
import {
  PLUGIN_CONFIG_SECRET_MASK,
  collectSecretBearingPaths,
  maskPluginConfigJson,
  mergeMaskedPluginConfig,
} from "../services/plugin-config-masking.js";

const SECRET = "super-secret-bearer-value";
const SECRET_ID = "77777777-7777-4777-8777-777777777777";

describe("collectSecretBearingPaths", () => {
  it("collects every declaration marker and records explicit exemptions", () => {
    const { secret, exempt } = collectSecretBearingPaths({
      type: "object",
      properties: {
        refField: { type: "string", format: "secret-ref" },
        writeOnlyField: { type: "string", writeOnly: true },
        markedField: { type: "string", "x-paperclip-secret": true },
        exemptField: { type: "string", "x-paperclip-secret": false },
        plainField: { type: "string" },
      },
    });

    expect([...secret].sort()).toEqual(["markedField", "refField", "writeOnlyField"]);
    expect([...exempt]).toEqual(["exemptField"]);
  });

  it("walks nested properties and composition keywords", () => {
    const { secret } = collectSecretBearingPaths({
      type: "object",
      properties: {
        auth: {
          type: "object",
          properties: { password: { type: "string", writeOnly: true } },
        },
      },
      allOf: [
        {
          properties: { extraToken: { type: "string", "x-paperclip-secret": true } },
        },
      ],
    });

    expect([...secret].sort()).toEqual(["auth.password", "extraToken"]);
  });

  it("returns empty sets for a missing or non-object schema", () => {
    expect(collectSecretBearingPaths(undefined).secret.size).toBe(0);
    expect(collectSecretBearingPaths(null).exempt.size).toBe(0);
  });
});

describe("maskPluginConfigJson", () => {
  it("masks a declared secret and leaves non-secret fields intact", () => {
    const masked = maskPluginConfigJson(
      { webhookToken: SECRET, endpoint: "https://alerts.example.com", timeoutMs: 5000, enabled: true },
      {
        type: "object",
        properties: {
          webhookToken: { type: "string", writeOnly: true },
          endpoint: { type: "string" },
          timeoutMs: { type: "number" },
          enabled: { type: "boolean" },
        },
      },
    );

    expect(masked).toEqual({
      webhookToken: PLUGIN_CONFIG_SECRET_MASK,
      endpoint: "https://alerts.example.com",
      timeoutMs: 5000,
      enabled: true,
    });
  });

  it("masks a raw value sitting at a secret-ref path", () => {
    // The live shape from BLO-20219: the secret-ref path is unusable, so the
    // field holds the credential inline.
    const masked = maskPluginConfigJson(
      { webhookTokenRef: SECRET },
      { type: "object", properties: { webhookTokenRef: { type: "string", format: "secret-ref" } } },
    );

    expect(masked).toEqual({ webhookTokenRef: PLUGIN_CONFIG_SECRET_MASK });
  });

  it("preserves a secret_ref pointer but strips resolved plaintext riding along", () => {
    const masked = maskPluginConfigJson(
      {
        apiKeyRef: { type: "secret_ref", secretId: SECRET_ID, version: "latest", value: SECRET },
      },
      { type: "object", properties: { apiKeyRef: { type: "string", format: "secret-ref" } } },
    );

    expect(masked).toEqual({
      apiKeyRef: { type: "secret_ref", secretId: SECRET_ID, version: "latest" },
    });
    expect(JSON.stringify(masked)).not.toContain(SECRET);
  });

  it("preserves a legacy bare-UUID binding at a secret-ref path", () => {
    const masked = maskPluginConfigJson(
      { apiKeyRef: SECRET_ID },
      { type: "object", properties: { apiKeyRef: { type: "string", format: "secret-ref" } } },
    );

    expect(masked).toEqual({ apiKeyRef: SECRET_ID });
  });

  it("masks a credential-named string the manifest never declared", () => {
    // The BLO-20794 case: `webhookToken` is `type: "string"` with no marker, and
    // undeclared keys can appear in config_json at all.
    const masked = maskPluginConfigJson(
      { webhookToken: SECRET, clientSecret: SECRET, baseUrl: "https://example.com" },
      { type: "object", properties: { baseUrl: { type: "string" } } },
    );

    expect(masked).toEqual({
      webhookToken: PLUGIN_CONFIG_SECRET_MASK,
      clientSecret: PLUGIN_CONFIG_SECRET_MASK,
      baseUrl: "https://example.com",
    });
  });

  it("honours an explicit x-paperclip-secret:false opt-out of the name heuristic", () => {
    const masked = maskPluginConfigJson(
      { tokenStrategy: "oauth" },
      { type: "object", properties: { tokenStrategy: { type: "string", "x-paperclip-secret": false } } },
    );

    expect(masked).toEqual({ tokenStrategy: "oauth" });
  });

  it("does not mask non-credential field names or non-string values", () => {
    const masked = maskPluginConfigJson(
      { baseUrl: "https://example.com", maxTokens: 4096, region: "us-east-1" },
      undefined,
    );

    expect(masked).toEqual({ baseUrl: "https://example.com", maxTokens: 4096, region: "us-east-1" });
  });

  it("masks nested declared secrets", () => {
    const masked = maskPluginConfigJson(
      { auth: { username: "svc", password: SECRET } },
      {
        type: "object",
        properties: {
          auth: {
            type: "object",
            properties: { username: { type: "string" }, password: { type: "string", writeOnly: true } },
          },
        },
      },
    );

    expect(masked).toEqual({ auth: { username: "svc", password: PLUGIN_CONFIG_SECRET_MASK } });
  });

  it("masks a declared secret whatever its shape, so an odd value cannot slip through", () => {
    const masked = maskPluginConfigJson(
      { creds: { nested: SECRET } },
      { type: "object", properties: { creds: { writeOnly: true } } },
    );

    expect(masked).toEqual({ creds: PLUGIN_CONFIG_SECRET_MASK });
    expect(JSON.stringify(masked)).not.toContain(SECRET);
  });

  it("leaves null and undefined declared secrets alone", () => {
    const schema = { type: "object", properties: { token: { type: "string", writeOnly: true } } };
    expect(maskPluginConfigJson({ token: null }, schema)).toEqual({ token: null });
  });

  it("returns non-object input unchanged", () => {
    expect(maskPluginConfigJson(null)).toBeNull();
    expect(maskPluginConfigJson("nope")).toBe("nope");
  });
});

describe("mergeMaskedPluginConfig", () => {
  it("restores the stored secret when the mask is posted back unchanged", () => {
    const merged = mergeMaskedPluginConfig(
      { webhookToken: PLUGIN_CONFIG_SECRET_MASK, endpoint: "https://new.example.com" },
      { webhookToken: SECRET, endpoint: "https://old.example.com" },
    );

    expect(merged).toEqual({ webhookToken: SECRET, endpoint: "https://new.example.com" });
  });

  it("accepts a genuinely new secret value", () => {
    const merged = mergeMaskedPluginConfig({ webhookToken: "rotated" }, { webhookToken: SECRET });

    expect(merged).toEqual({ webhookToken: "rotated" });
  });

  it("drops the sentinel rather than persisting it when nothing is stored", () => {
    const merged = mergeMaskedPluginConfig({ webhookToken: PLUGIN_CONFIG_SECRET_MASK }, {});

    expect(merged).toEqual({});
    expect(JSON.stringify(merged)).not.toContain(PLUGIN_CONFIG_SECRET_MASK);
  });

  it("never persists the sentinel when storage is missing entirely", () => {
    expect(mergeMaskedPluginConfig({ token: PLUGIN_CONFIG_SECRET_MASK }, null)).toEqual({});
  });

  it("restores nested secrets", () => {
    const merged = mergeMaskedPluginConfig(
      { auth: { username: "svc", password: PLUGIN_CONFIG_SECRET_MASK } },
      { auth: { username: "svc", password: SECRET } },
    );

    expect(merged).toEqual({ auth: { username: "svc", password: SECRET } });
  });

  it("restores secrets inside arrays and drops unrestorable sentinels", () => {
    const merged = mergeMaskedPluginConfig(
      { targets: [{ token: PLUGIN_CONFIG_SECRET_MASK }, { token: "explicit" }], keys: [PLUGIN_CONFIG_SECRET_MASK] },
      { targets: [{ token: SECRET }, { token: "old" }], keys: [] },
    );

    expect(merged).toEqual({ targets: [{ token: SECRET }, { token: "explicit" }], keys: [] });
  });

  it("does not resurrect a key the caller deliberately removed", () => {
    const merged = mergeMaskedPluginConfig({ endpoint: "https://example.com" }, { endpoint: "https://example.com", staleToken: SECRET });

    expect(merged).toEqual({ endpoint: "https://example.com" });
  });

  it("round-trips a masked read losslessly", () => {
    const schema = {
      type: "object",
      properties: {
        webhookToken: { type: "string", writeOnly: true },
        apiKeyRef: { type: "string", format: "secret-ref" },
        endpoint: { type: "string" },
      },
    };
    const stored = {
      webhookToken: SECRET,
      apiKeyRef: { type: "secret_ref", secretId: SECRET_ID, version: "latest" },
      endpoint: "https://alerts.example.com",
    };

    const masked = maskPluginConfigJson(stored, schema) as Record<string, unknown>;
    expect(JSON.stringify(masked)).not.toContain(SECRET);

    // The client posts the masked payload straight back, unmodified.
    const merged = mergeMaskedPluginConfig(JSON.parse(JSON.stringify(masked)), stored);

    expect(merged).toEqual(stored);
  });
});

describe("maskPluginConfigJson — credential-shaped containers", () => {
  it("masks string leaves inside a credential-named object while keeping its shape", () => {
    const masked = maskPluginConfigJson({ credentials: { user: "svc", pass: SECRET, port: 8443 } });

    expect(masked).toEqual({
      credentials: { user: PLUGIN_CONFIG_SECRET_MASK, pass: PLUGIN_CONFIG_SECRET_MASK, port: 8443 },
    });
    expect(JSON.stringify(masked)).not.toContain(SECRET);
  });

  it("masks strings in a credential-named array", () => {
    const masked = maskPluginConfigJson({ tokens: [SECRET, "second"] });

    expect(masked).toEqual({ tokens: [PLUGIN_CONFIG_SECRET_MASK, PLUGIN_CONFIG_SECRET_MASK] });
  });

  it("does not let suspicion leak into unrelated sibling subtrees", () => {
    const masked = maskPluginConfigJson({
      credentials: { pass: SECRET },
      transport: { endpoint: "https://example.com" },
    });

    expect(masked).toEqual({
      credentials: { pass: PLUGIN_CONFIG_SECRET_MASK },
      transport: { endpoint: "https://example.com" },
    });
  });

  it("lets an explicit exemption override a suspicious ancestor", () => {
    const masked = maskPluginConfigJson(
      { credentials: { scheme: "basic", pass: SECRET } },
      {
        type: "object",
        properties: {
          credentials: {
            type: "object",
            properties: { scheme: { type: "string", "x-paperclip-secret": false } },
          },
        },
      },
    );

    expect(masked).toEqual({
      credentials: { scheme: "basic", pass: PLUGIN_CONFIG_SECRET_MASK },
    });
  });

  it("round-trips a credential container losslessly", () => {
    const stored = { credentials: { user: "svc", pass: SECRET }, endpoint: "https://example.com" };
    const masked = maskPluginConfigJson(stored) as Record<string, unknown>;

    expect(JSON.stringify(masked)).not.toContain(SECRET);
    expect(mergeMaskedPluginConfig(JSON.parse(JSON.stringify(masked)), stored)).toEqual(stored);
  });
});
