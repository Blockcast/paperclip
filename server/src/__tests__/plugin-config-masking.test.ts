import { describe, expect, it } from "vitest";
import {
  PLUGIN_CONFIG_SECRET_MASK,
  maskPluginConfigJson,
  mergeMaskedPluginConfig,
} from "../services/plugin-config-masking.js";

const SECRET = "super-secret-bearer-value";
const SECRET_ID = "77777777-7777-4777-8777-777777777777";

/** The merge contract is "resolved config + paths that could not be resolved". */
function merge(incoming: Record<string, unknown>, stored: unknown) {
  return mergeMaskedPluginConfig(incoming, stored);
}

/** Most assertions only care about the resolved config. */
function mergeConfig(incoming: Record<string, unknown>, stored: unknown) {
  return mergeMaskedPluginConfig(incoming, stored).configJson;
}

describe("maskPluginConfigJson — declaration markers", () => {
  it("honours every declaration marker and the explicit exemption", () => {
    const masked = maskPluginConfigJson(
      {
        refField: SECRET,
        writeOnlyField: SECRET,
        markedField: SECRET,
        exemptToken: "not-a-secret",
        plainField: "visible",
      },
      {
        type: "object",
        properties: {
          refField: { type: "string", format: "secret-ref" },
          writeOnlyField: { type: "string", writeOnly: true },
          markedField: { type: "string", "x-paperclip-secret": true },
          exemptToken: { type: "string", "x-paperclip-secret": false },
          plainField: { type: "string" },
        },
      },
    );

    expect(masked).toEqual({
      refField: PLUGIN_CONFIG_SECRET_MASK,
      writeOnlyField: PLUGIN_CONFIG_SECRET_MASK,
      markedField: PLUGIN_CONFIG_SECRET_MASK,
      exemptToken: "not-a-secret",
      plainField: "visible",
    });
  });

  it("honours a declaration reached only through a composition keyword", () => {
    const masked = maskPluginConfigJson(
      { auth: { password: SECRET }, extraToken: SECRET },
      {
        type: "object",
        properties: {
          auth: { type: "object", properties: { password: { type: "string", writeOnly: true } } },
        },
        allOf: [{ properties: { extraToken: { type: "string", "x-paperclip-secret": true } } }],
      },
    );

    expect(masked).toEqual({
      auth: { password: PLUGIN_CONFIG_SECRET_MASK },
      extraToken: PLUGIN_CONFIG_SECRET_MASK,
    });
  });

  it("masks a field whose oneOf branch node itself carries the marker", () => {
    // The marker sits on the branch, not on a `properties` entry beneath it —
    // fail-closed: secret in any branch means secret.
    const masked = maskPluginConfigJson(
      { credential: SECRET },
      {
        type: "object",
        properties: {
          credential: {
            oneOf: [{ type: "string", writeOnly: true }, { type: "null" }],
          },
        },
      },
    );

    expect(masked).toEqual({ credential: PLUGIN_CONFIG_SECRET_MASK });
    expect(JSON.stringify(masked)).not.toContain(SECRET);
  });

  it("ignores a missing or non-object schema", () => {
    expect(maskPluginConfigJson({ plain: "value" }, undefined)).toEqual({ plain: "value" });
    expect(maskPluginConfigJson({ plain: "value" }, null)).toEqual({ plain: "value" });
  });
});

describe("maskPluginConfigJson — schema shapes beyond `properties`", () => {
  it("masks a declared secret inside array `items`", () => {
    const masked = maskPluginConfigJson(
      { targets: [{ url: "https://a.example.com", value: SECRET }] },
      {
        type: "object",
        properties: {
          targets: {
            type: "array",
            items: {
              type: "object",
              properties: {
                url: { type: "string" },
                value: { type: "string", writeOnly: true },
              },
            },
          },
        },
      },
    );

    expect(masked).toEqual({
      targets: [{ url: "https://a.example.com", value: PLUGIN_CONFIG_SECRET_MASK }],
    });
    expect(JSON.stringify(masked)).not.toContain(SECRET);
  });

  it("masks a declared secret inside 2020-12 `prefixItems`", () => {
    const masked = maskPluginConfigJson(
      { pair: [SECRET, "public"] },
      {
        type: "object",
        properties: {
          pair: {
            type: "array",
            prefixItems: [{ type: "string", writeOnly: true }, { type: "string" }],
          },
        },
      },
    );

    expect(masked).toEqual({ pair: [PLUGIN_CONFIG_SECRET_MASK, "public"] });
  });

  it("masks a declared secret inside the draft-07 tuple form of `items`", () => {
    const masked = maskPluginConfigJson(
      { pair: ["public", SECRET] },
      {
        type: "object",
        properties: {
          pair: {
            type: "array",
            items: [{ type: "string" }, { type: "string", writeOnly: true }],
          },
        },
      },
    );

    expect(masked).toEqual({ pair: ["public", PLUGIN_CONFIG_SECRET_MASK] });
  });

  it("masks a declared secret reached through `additionalProperties`", () => {
    const masked = maskPluginConfigJson(
      { headers: { "x-plain": "keep", "x-auth": { value: SECRET } } },
      {
        type: "object",
        properties: {
          headers: {
            type: "object",
            additionalProperties: {
              type: "object",
              properties: { value: { type: "string", writeOnly: true } },
            },
          },
        },
      },
    );

    expect(masked).toEqual({
      headers: { "x-plain": "keep", "x-auth": { value: PLUGIN_CONFIG_SECRET_MASK } },
    });
    expect(JSON.stringify(masked)).not.toContain(SECRET);
  });

  it("masks a declared secret reached through `patternProperties`", () => {
    const masked = maskPluginConfigJson(
      { envSecret: SECRET, envPlain: "keep" },
      {
        type: "object",
        patternProperties: {
          "^envSecret$": { type: "string", writeOnly: true },
          "^envPlain$": { type: "string" },
        },
      },
    );

    expect(masked).toEqual({ envSecret: PLUGIN_CONFIG_SECRET_MASK, envPlain: "keep" });
  });

  it("does not apply `additionalProperties` to a key `properties` already claims", () => {
    const masked = maskPluginConfigJson(
      { declared: "visible", other: SECRET },
      {
        type: "object",
        properties: { declared: { type: "string" } },
        additionalProperties: { type: "string", writeOnly: true },
      },
    );

    expect(masked).toEqual({ declared: "visible", other: PLUGIN_CONFIG_SECRET_MASK });
  });

  it("survives an invalid patternProperties regex rather than throwing", () => {
    const masked = maskPluginConfigJson(
      { webhookToken: SECRET },
      { type: "object", patternProperties: { "([unclosed": { type: "string" } } },
    );

    // Falls through to the name heuristic, which still covers the field.
    expect(masked).toEqual({ webhookToken: PLUGIN_CONFIG_SECRET_MASK });
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

  it("masks a UUID-shaped credential in a `writeOnly` field", () => {
    // The BLO-20871 review finding: the legacy-binding passthrough used to fire
    // for any declared secret, so a provider that issues UUID-shaped API keys
    // had them returned verbatim. Only `format: "secret-ref"` is a pointer.
    const masked = maskPluginConfigJson(
      { apiKey: SECRET_ID },
      { type: "object", properties: { apiKey: { type: "string", writeOnly: true } } },
    );

    expect(masked).toEqual({ apiKey: PLUGIN_CONFIG_SECRET_MASK });
    expect(JSON.stringify(masked)).not.toContain(SECRET_ID);
  });

  it("masks a UUID-shaped credential in an `x-paperclip-secret` field", () => {
    const masked = maskPluginConfigJson(
      { apiKey: SECRET_ID },
      {
        type: "object",
        properties: { apiKey: { type: "string", "x-paperclip-secret": true } },
      },
    );

    expect(masked).toEqual({ apiKey: PLUGIN_CONFIG_SECRET_MASK });
    expect(JSON.stringify(masked)).not.toContain(SECRET_ID);
  });

  it("masks a UUID-shaped credential reached through array items", () => {
    // Same finding, but at a path only the lockstep schema walk can reach.
    const masked = maskPluginConfigJson(
      { targets: [{ value: SECRET_ID }] },
      {
        type: "object",
        properties: {
          targets: {
            type: "array",
            items: {
              type: "object",
              properties: { value: { type: "string", writeOnly: true } },
            },
          },
        },
      },
    );

    expect(JSON.stringify(masked)).not.toContain(SECRET_ID);
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
    const merged = mergeConfig(
      { webhookToken: PLUGIN_CONFIG_SECRET_MASK, endpoint: "https://new.example.com" },
      { webhookToken: SECRET, endpoint: "https://old.example.com" },
    );

    expect(merged).toEqual({ webhookToken: SECRET, endpoint: "https://new.example.com" });
  });

  it("accepts a genuinely new secret value", () => {
    const merged = mergeConfig({ webhookToken: "rotated" }, { webhookToken: SECRET });

    expect(merged).toEqual({ webhookToken: "rotated" });
  });

  it("drops the sentinel rather than persisting it when nothing is stored", () => {
    const merged = mergeConfig({ webhookToken: PLUGIN_CONFIG_SECRET_MASK }, {});

    expect(merged).toEqual({});
    expect(JSON.stringify(merged)).not.toContain(PLUGIN_CONFIG_SECRET_MASK);
  });

  it("never persists the sentinel when storage is missing entirely", () => {
    expect(mergeConfig({ token: PLUGIN_CONFIG_SECRET_MASK }, null)).toEqual({});
  });

  it("restores nested secrets", () => {
    const merged = mergeConfig(
      { auth: { username: "svc", password: PLUGIN_CONFIG_SECRET_MASK } },
      { auth: { username: "svc", password: SECRET } },
    );

    expect(merged).toEqual({ auth: { username: "svc", password: SECRET } });
  });

  it("does not resurrect a key the caller deliberately removed", () => {
    const merged = mergeConfig(
      { endpoint: "https://example.com" },
      { endpoint: "https://example.com", staleToken: SECRET },
    );

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
    const result = merge(JSON.parse(JSON.stringify(masked)), stored);

    expect(result.configJson).toEqual(stored);
    expect(result.unresolvedMaskPaths).toEqual([]);
  });
});

describe("mergeMaskedPluginConfig — array entry identity", () => {
  const STORED_TARGETS = {
    targets: [
      { name: "alpha", url: "https://a.example.com", token: "token-alpha" },
      { name: "beta", url: "https://b.example.com", token: "token-beta" },
    ],
  };

  it("restores each entry's own secret on an unmodified round-trip", () => {
    const masked = maskPluginConfigJson(STORED_TARGETS) as Record<string, unknown>;
    const result = merge(JSON.parse(JSON.stringify(masked)), STORED_TARGETS);

    expect(result.unresolvedMaskPaths).toEqual([]);
    expect(result.configJson).toEqual(STORED_TARGETS);
  });

  it("follows the entry, not the index, when entries are reordered", () => {
    const result = merge(
      {
        targets: [
          { name: "beta", url: "https://b.example.com", token: PLUGIN_CONFIG_SECRET_MASK },
          { name: "alpha", url: "https://a.example.com", token: PLUGIN_CONFIG_SECRET_MASK },
        ],
      },
      STORED_TARGETS,
    );

    expect(result.unresolvedMaskPaths).toEqual([]);
    expect(result.configJson).toEqual({
      targets: [
        { name: "beta", url: "https://b.example.com", token: "token-beta" },
        { name: "alpha", url: "https://a.example.com", token: "token-alpha" },
      ],
    });
  });

  it("does not re-home a credential when an earlier entry is deleted", () => {
    // The BLO-20871 review finding: positional restore would hand `token-alpha`
    // to beta's endpoint.
    const result = merge(
      { targets: [{ name: "beta", url: "https://b.example.com", token: PLUGIN_CONFIG_SECRET_MASK }] },
      STORED_TARGETS,
    );

    expect(result.unresolvedMaskPaths).toEqual([]);
    expect(result.configJson).toEqual({
      targets: [{ name: "beta", url: "https://b.example.com", token: "token-beta" }],
    });
    expect(JSON.stringify(result.configJson)).not.toContain("token-alpha");
  });

  it("reports the sentinel as unresolved when no identity survives a deletion", () => {
    // No stable identity key: entries carry only the masked secret, so a
    // deletion cannot be reconciled and must be re-entered.
    const result = merge(
      { targets: [{ token: PLUGIN_CONFIG_SECRET_MASK }] },
      { targets: [{ token: "token-alpha" }, { token: "token-beta" }] },
    );

    expect(result.unresolvedMaskPaths).toEqual(["targets.0"]);
    expect(result.configJson).toEqual({ targets: [{}] });
    expect(JSON.stringify(result.configJson)).not.toContain("token-");
    expect(JSON.stringify(result.configJson)).not.toContain(PLUGIN_CONFIG_SECRET_MASK);
  });

  it("reports the sentinel as unresolved when an identity-less entry is replaced", () => {
    const result = merge(
      { targets: [{ url: "https://moved.example.com", token: PLUGIN_CONFIG_SECRET_MASK }] },
      { targets: [{ url: "https://a.example.com", token: "token-alpha" }] },
    );

    expect(result.unresolvedMaskPaths).toEqual(["targets.0"]);
    expect(JSON.stringify(result.configJson)).not.toContain("token-alpha");
  });

  it("restores scalar array entries positionally only when the length is unchanged", () => {
    const kept = merge(
      { keys: [PLUGIN_CONFIG_SECRET_MASK, PLUGIN_CONFIG_SECRET_MASK] },
      { keys: ["key-one", "key-two"] },
    );
    expect(kept.unresolvedMaskPaths).toEqual([]);
    expect(kept.configJson).toEqual({ keys: ["key-one", "key-two"] });

    const shortened = merge({ keys: [PLUGIN_CONFIG_SECRET_MASK] }, { keys: ["key-one", "key-two"] });
    expect(shortened.unresolvedMaskPaths).toEqual(["keys.0"]);
    expect(shortened.configJson).toEqual({ keys: [] });
  });

  it("leaves entries that carry no sentinel untouched by a structural change", () => {
    const result = merge(
      { targets: [{ token: "explicit" }], keys: [PLUGIN_CONFIG_SECRET_MASK] },
      { targets: [{ token: SECRET }, { token: "old" }], keys: [] },
    );

    expect(result.configJson.targets).toEqual([{ token: "explicit" }]);
    expect(result.unresolvedMaskPaths).toEqual(["keys.0"]);
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

  it("masks strings inside a nested credential array at arbitrary depth", () => {
    // The BLO-20871 review finding: array entries that are themselves arrays
    // were returned unchanged, so `tokens` leaked one level down.
    const masked = maskPluginConfigJson({ tokens: [[SECRET], [["deeper", SECRET]]] });

    expect(masked).toEqual({
      tokens: [
        [PLUGIN_CONFIG_SECRET_MASK],
        [[PLUGIN_CONFIG_SECRET_MASK, PLUGIN_CONFIG_SECRET_MASK]],
      ],
    });
    expect(JSON.stringify(masked)).not.toContain(SECRET);
  });

  it("masks a credential string nested under records inside arrays", () => {
    const masked = maskPluginConfigJson({
      credentials: [{ entries: [{ pass: SECRET }] }],
    });

    expect(JSON.stringify(masked)).not.toContain(SECRET);
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
    expect(mergeConfig(JSON.parse(JSON.stringify(masked)), stored)).toEqual(stored);
  });
});
