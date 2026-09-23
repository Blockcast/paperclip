import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  companies,
  companySecretBindings,
  companySecretProviderConfigs,
  companySecrets,
  companySecretVersions,
  createDb,
  plugins,
  secretAccessEvents,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import {
  createPluginSecretsHandler,
  extractSecretRefBindingsFromConfig,
} from "../services/plugin-secrets-handler.js";
import { secretService } from "../services/secrets.js";

const pluginId = "11111111-1111-4111-8111-111111111111";
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping plugin secret handler integration tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describe("extractSecretRefBindingsFromConfig", () => {
  it("ignores UUID strings outside schema-declared secret fields", () => {
    const externalProjectId = "77777777-7777-4777-8777-777777777777";

    expect(extractSecretRefBindingsFromConfig(
      { externalProjectId },
      { type: "object", properties: { externalProjectId: { type: "string" } } },
    )).toEqual([]);
  });

  it("coerces legacy UUID strings at schema-declared secret fields", () => {
    const secretId = "77777777-7777-4777-8777-777777777777";

    expect(extractSecretRefBindingsFromConfig(
      { token: secretId },
      { type: "object", properties: { token: { format: "secret-ref" } } },
    )).toEqual([
      {
        secretId,
        configPath: "token",
        versionSelector: "latest",
        required: true,
        label: "token",
        projectionClass: undefined,
        projectionAllowlistKey: null,
      },
    ]);
  });

  it("ignores non-UUID strings at schema-declared secret fields", () => {
    expect(extractSecretRefBindingsFromConfig(
      { token: "not-a-uuid" },
      { type: "object", properties: { token: { format: "secret-ref" } } },
    )).toEqual([]);
  });
});

describe("createPluginSecretsHandler fail-closed guards", () => {
  it("requires company context before touching the database", async () => {
    const db = { select: vi.fn(() => { throw new Error("db should not be touched"); }) };
    const handler = createPluginSecretsHandler({ db: db as never, pluginId });

    await expect(
      handler.resolve({ secretRef: { type: "secret_ref", secretId: randomUUID() } }),
    ).rejects.toThrow(/companyId is required/i);
    expect(db.select).not.toHaveBeenCalled();
  });

  it("rejects non-UUID string refs before provider resolution", async () => {
    const db = { select: vi.fn(() => { throw new Error("db should not be touched"); }) };
    const handler = createPluginSecretsHandler({ db: db as never, pluginId });

    await expect(
      handler.resolve({ companyId: randomUUID(), secretRef: "not-a-secret-id" }),
    ).rejects.toThrow(/use \{ type: "secret_ref"/i);
    expect(db.select).not.toHaveBeenCalled();
  });

  it("rejects oversized verification candidates before touching the database", async () => {
    const db = { select: vi.fn(() => { throw new Error("db should not be touched"); }) };
    const handler = createPluginSecretsHandler({ db: db as never, pluginId });

    await expect(handler.verify({
      companyId: randomUUID(),
      secretRef: { type: "secret_ref", secretId: randomUUID() },
      presented: "x".repeat(4_097),
    })).rejects.toMatchObject({
      details: { code: "presented_secret_invalid" },
    });
    expect(db.select).not.toHaveBeenCalled();
  });

  it("meters verification before authorization, at 600 per window", async () => {
    const db = { select: vi.fn(() => { throw new Error("db should not be touched"); }) };
    const handler = createPluginSecretsHandler({ db: db as never, pluginId });
    const params = {
      companyId: randomUUID(),
      secretRef: { type: "secret_ref" as const, secretId: randomUUID() },
      presented: "a-junk-bearer",
    };

    // Each of these clears the rate gate and then dies at the first read inside
    // `authorizeBoundSecret`. That failure is the instrument, not an accident:
    // these calls can only have spent budget if the gate ran BEFORE the lookup.
    for (let i = 0; i < 600; i += 1) {
      await expect(handler.verify(params)).rejects.toThrow(/db should not be touched/);
    }
    expect(db.select).toHaveBeenCalledTimes(600);

    // Hoisting the gate back below `authorizeBoundSecret` — the round-3
    // regression this ordering exists to prevent — makes call 601 throw the db
    // error like every call before it, because the limiter would never have
    // been reached to count them. Asserting the limiter answers here is
    // therefore what pins the ordering; the count alone would not.
    await expect(handler.verify(params)).rejects.toMatchObject({
      name: "RateLimitExceededError",
    });
    expect(db.select).toHaveBeenCalledTimes(600);
  });

  it("scopes the verification budget per company and keeps it out of resolve's", async () => {
    const db = { select: vi.fn(() => { throw new Error("db should not be touched"); }) };
    const handler = createPluginSecretsHandler({ db: db as never, pluginId });
    const secretRef = { type: "secret_ref" as const, secretId: randomUUID() };
    const floodedCompany = randomUUID();

    for (let i = 0; i < 600; i += 1) {
      await expect(
        handler.verify({ companyId: floodedCompany, secretRef, presented: "a-junk-bearer" }),
      ).rejects.toThrow(/db should not be touched/);
    }
    await expect(
      handler.verify({ companyId: floodedCompany, secretRef, presented: "a-junk-bearer" }),
    ).rejects.toMatchObject({ name: "RateLimitExceededError" });

    // A neighbouring tenant is untouched: the bucket is keyed per
    // (companyId, pluginId), so one company's public endpoint cannot be used to
    // lock another's out.
    await expect(
      handler.verify({ companyId: randomUUID(), secretRef, presented: "a-junk-bearer" }),
    ).rejects.toThrow(/db should not be touched/);

    // And the flooded company's own plaintext-resolution budget survives, which
    // is BLO-20738 AC 2 at the unit level: `verify` and `resolve` meter into
    // separate buckets, so a junk-bearer flood cannot starve the resolutions a
    // legitimate delivery depends on.
    await expect(
      handler.resolve({ companyId: floodedCompany, secretRef }),
    ).rejects.toThrow(/db should not be touched/);
  });
});

describeEmbeddedPostgres("createPluginSecretsHandler shared vault integration", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-plugin-secrets-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("plugin-secrets-handler");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  });

  afterEach(async () => {
    await db.delete(secretAccessEvents);
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(companySecretProviderConfigs);
    await db.delete(plugins);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
    if (previousKeyFile === undefined) {
      delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    } else {
      process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    }
    rmSync(secretsTmpDir, { recursive: true, force: true });
  });

  async function seedCompany(name: string) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name,
      issuePrefix: `P${companyId.slice(0, 7)}`.toUpperCase(),
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return companyId;
  }

  async function seedPlugin() {
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "paperclip.plugin-secrets-test",
      packageName: "@paperclipai/plugin-secrets-test",
      version: "0.0.1",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: {
        id: "paperclip.plugin-secrets-test",
        apiVersion: 1,
        version: "0.0.1",
        displayName: "Plugin Secrets Test",
        description: "Test plugin",
        author: "Paperclip",
        categories: ["automation"],
        capabilities: [],
        entrypoints: { worker: "./dist/worker.js" },
      },
      status: "ready",
      installOrder: 1,
    });
  }

  it("resolves bound plugin refs through secretService and emits plugin_worker access events", async () => {
    await seedPlugin();
    const companyId = await seedCompany("Plugin Co");
    const svc = secretService(db);
    const secret = await svc.create(companyId, {
      name: `plugin-api-key-${randomUUID()}`,
      provider: "local_encrypted",
      value: "resolved-plugin-secret",
    });
    await svc.syncSecretRefsForTarget(companyId, { targetType: "plugin", targetId: pluginId }, [
      { secretId: secret.id, configPath: "apiKey" },
    ], { replaceAll: true });

    const handler = createPluginSecretsHandler({ db, pluginId });
    await expect(
      handler.resolve({
        companyId,
        secretRef: { type: "secret_ref", secretId: secret.id, version: "latest" },
      }),
    ).resolves.toBe("resolved-plugin-secret");

    const events = await db
      .select()
      .from(secretAccessEvents)
      .where(eq(secretAccessEvents.secretId, secret.id));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      companyId,
      secretId: secret.id,
      consumerType: "plugin_worker",
      consumerId: pluginId,
      configPath: "apiKey",
      pluginId,
      outcome: "success",
      errorCode: null,
    });
  });

  it("keeps failed verification traffic off the secret-resolution budget", async () => {
    await seedPlugin();
    const companyId = await seedCompany("Verification Budget Co");
    const svc = secretService(db);
    const secret = await svc.create(companyId, {
      name: `webhook-token-${randomUUID()}`,
      provider: "local_encrypted",
      value: "valid-webhook-token",
    });
    await svc.syncSecretRefsForTarget(companyId, { targetType: "plugin", targetId: pluginId }, [
      { secretId: secret.id, configPath: "webhookTokenRef" },
    ], { replaceAll: true });

    const handler = createPluginSecretsHandler({ db, pluginId });
    const secretRef = { type: "secret_ref" as const, secretId: secret.id };
    for (let attempt = 0; attempt < 31; attempt += 1) {
      await expect(handler.verify({
        companyId,
        secretRef,
        configPath: "webhookTokenRef",
        presented: `invalid-${attempt}`,
      })).resolves.toBe(false);
    }

    const eventsAfterFailures = await db
      .select()
      .from(secretAccessEvents)
      .where(eq(secretAccessEvents.secretId, secret.id));
    expect(eventsAfterFailures).toHaveLength(0);

    const [secretAfterFailures] = await db
      .select({ lastResolvedAt: companySecrets.lastResolvedAt })
      .from(companySecrets)
      .where(eq(companySecrets.id, secret.id));
    expect(secretAfterFailures?.lastResolvedAt).toBeNull();

    await expect(handler.verify({
      companyId,
      secretRef,
      configPath: "webhookTokenRef",
      presented: "valid-webhook-token",
    })).resolves.toBe(true);

    const eventsAfterValidVerification = await db
      .select()
      .from(secretAccessEvents)
      .where(eq(secretAccessEvents.secretId, secret.id));
    expect(eventsAfterValidVerification).toHaveLength(0);

    await expect(handler.resolve({
      companyId,
      secretRef,
      configPath: "webhookTokenRef",
    })).resolves.toBe("valid-webhook-token");

    const eventsAfterResolution = await db
      .select()
      .from(secretAccessEvents)
      .where(eq(secretAccessEvents.secretId, secret.id));
    expect(eventsAfterResolution).toHaveLength(1);
  });

  /**
   * Rewrite the stored version material in place so a case can exercise a
   * provider shape without standing up that provider. `material` is what the
   * handler discriminates on, and `value_sha256` is the column whose meaning
   * changes with it — the pair is exactly the production state under test.
   */
  async function rewriteVersionMaterial(
    secretId: string,
    material: Record<string, unknown>,
    valueSha256?: string,
  ) {
    await db
      .update(companySecretVersions)
      .set({ material, ...(valueSha256 ? { valueSha256 } : {}) })
      .where(eq(companySecretVersions.secretId, secretId));
  }

  async function seedVerifiableSecret(companyName: string, value: string) {
    await seedPlugin();
    const companyId = await seedCompany(companyName);
    const svc = secretService(db);
    const secret = await svc.create(companyId, {
      name: `webhook-token-${randomUUID()}`,
      provider: "local_encrypted",
      value,
    });
    await svc.syncSecretRefsForTarget(companyId, { targetType: "plugin", targetId: pluginId }, [
      { secretId: secret.id, configPath: "webhookTokenRef" },
    ], { replaceAll: true });
    return {
      companyId,
      secret,
      handler: createPluginSecretsHandler({ db, pluginId }),
      secretRef: { type: "secret_ref" as const, secretId: secret.id },
    };
  }

  it("refuses to verify an external provider reference instead of rejecting the real credential", async () => {
    // The regression this pins (BLO-20738, Ally round-5): `value_sha256` holds
    // a digest of the VALUE only for versions Paperclip wrote itself. For an
    // imported AWS reference it holds
    // `sha256("aws_secrets_manager_v1:<ref>:<version>")` instead — a
    // fingerprint of the POINTER. Comparing a presented bearer against that can
    // never match, so before this fix a correctly-configured production webhook
    // was rejected on every delivery, and `verify` reported it as `false` —
    // indistinguishable from an attacker guessing wrong.
    //
    // Asserting `rejects` rather than `resolves.toBe(false)` is the whole point:
    // a confident `false` here is a lie.
    const { companyId, secret, handler, secretRef } = await seedVerifiableSecret(
      "External Reference Co",
      "valid-webhook-token",
    );

    const externalRef = "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/webhook-AbCdEf";
    await rewriteVersionMaterial(
      secret.id,
      {
        scheme: "aws_secrets_manager_v1",
        secretId: externalRef,
        versionId: null,
        source: "external_reference",
      },
      // Exactly what `createExternalReferenceMaterial` stores.
      createHash("sha256").update(`aws_secrets_manager_v1:${externalRef}:`).digest("hex"),
    );

    await expect(handler.verify({
      companyId,
      secretRef,
      configPath: "webhookTokenRef",
      presented: "valid-webhook-token",
    })).rejects.toMatchObject({ details: { code: "secret_verifier_unsupported" } });

    // A wrong guess must fail the same way. If the two differed, the error
    // channel would leak whether a guess was correct for a secret the host
    // cannot actually verify.
    await expect(handler.verify({
      companyId,
      secretRef,
      configPath: "webhookTokenRef",
      presented: "wrong-token",
    })).rejects.toMatchObject({ details: { code: "secret_verifier_unsupported" } });

    // Refusing must stay free of audit noise, exactly like a failed compare.
    const events = await db
      .select()
      .from(secretAccessEvents)
      .where(eq(secretAccessEvents.secretId, secret.id));
    expect(events).toHaveLength(0);
  });

  it("verifies a provider-managed version, where value_sha256 really is the value digest", async () => {
    // The other half of the discriminator: an AWS version Paperclip wrote
    // itself (`createSecret`/`createVersion`, both `source: "managed"`) does
    // store `sha256(value)`, so it must verify normally. Without this case the
    // fix above could be "reject everything non-local" and still look green.
    const { companyId, secret, handler, secretRef } = await seedVerifiableSecret(
      "Managed Provider Co",
      "valid-webhook-token",
    );

    await rewriteVersionMaterial(secret.id, {
      scheme: "aws_secrets_manager_v1",
      secretId: "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/webhook-AbCdEf",
      versionId: "11111111-2222-3333-4444-555555555555",
      source: "managed",
    });

    await expect(handler.verify({
      companyId,
      secretRef,
      configPath: "webhookTokenRef",
      presented: "valid-webhook-token",
    })).resolves.toBe(true);
    await expect(handler.verify({
      companyId,
      secretRef,
      configPath: "webhookTokenRef",
      presented: "wrong-token",
    })).resolves.toBe(false);
  });

  it("refuses an unrecognized provider scheme rather than trusting its digest", async () => {
    // Fail closed. A scheme this build has never seen may or may not store a
    // value digest; guessing "it does" silently rejects every real credential
    // for that provider, which is the failure this whole module exists to stop.
    const { companyId, secret, handler, secretRef } = await seedVerifiableSecret(
      "Future Provider Co",
      "valid-webhook-token",
    );

    await rewriteVersionMaterial(secret.id, {
      scheme: "some_future_provider_v1",
      source: "managed",
    });

    await expect(handler.verify({
      companyId,
      secretRef,
      configPath: "webhookTokenRef",
      presented: "valid-webhook-token",
    })).rejects.toMatchObject({ details: { code: "secret_verifier_unsupported" } });
  });

  it("resolves a stored config written under the previous bare-string ref format", async () => {
    // BLO-20219: configs written before the object-ref contract hold a bare
    // UUID string, and their plugin manifests still declare the field as
    // `type: "string", format: "secret-ref"`. Both the binding sync and the
    // worker resolve must accept that spelling or the config is unusable.
    await seedPlugin();
    const companyId = await seedCompany("Legacy Ref Co");
    const svc = secretService(db);
    const secret = await svc.create(companyId, {
      name: `legacy-plugin-token-${randomUUID()}`,
      provider: "local_encrypted",
      value: "legacy-resolved-secret",
    });

    // The config as a pre-contract-change plugin stored it.
    const legacyConfig = { webhookTokenRef: secret.id };
    const schema = {
      type: "object",
      properties: {
        webhookTokenRef: { type: "string", format: "secret-ref" },
      },
    };

    const refs = extractSecretRefBindingsFromConfig(legacyConfig, schema);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ secretId: secret.id, configPath: "webhookTokenRef" });

    await svc.syncSecretRefsForTarget(
      companyId,
      { targetType: "plugin", targetId: pluginId },
      refs,
      { replaceAll: true },
    );

    const handler = createPluginSecretsHandler({ db, pluginId });
    await expect(
      handler.resolve({ companyId, secretRef: legacyConfig.webhookTokenRef }),
    ).resolves.toBe("legacy-resolved-secret");
  });

  it("still refuses a legacy string ref for a secret not bound to this plugin", async () => {
    // Coercion must not become an authorization bypass: the binding row, not
    // the ref spelling, is the gate.
    await seedPlugin();
    const companyId = await seedCompany("Unbound Ref Co");
    const svc = secretService(db);
    const unboundSecret = await svc.create(companyId, {
      name: `unbound-plugin-secret-${randomUUID()}`,
      provider: "local_encrypted",
      value: "should-not-be-readable",
    });

    const handler = createPluginSecretsHandler({ db, pluginId });
    await expect(
      handler.resolve({ companyId, secretRef: unboundSecret.id }),
    ).rejects.toThrow(/not bound/i);

    const events = await db
      .select()
      .from(secretAccessEvents)
      .where(eq(secretAccessEvents.secretId, unboundSecret.id));
    expect(events).toHaveLength(0);
  });

  it("fails closed for cross-company resolve before secret provider access", async () => {
    await seedPlugin();
    const companyA = await seedCompany("A");
    const companyB = await seedCompany("B");
    const svc = secretService(db);
    const foreignSecret = await svc.create(companyB, {
      name: `foreign-plugin-secret-${randomUUID()}`,
      provider: "local_encrypted",
      value: "foreign-value",
    });
    await svc.syncSecretRefsForTarget(companyB, { targetType: "plugin", targetId: pluginId }, [
      { secretId: foreignSecret.id, configPath: "apiKey" },
    ], { replaceAll: true });

    const handler = createPluginSecretsHandler({ db, pluginId });
    await expect(
      handler.resolve({
        companyId: companyA,
        secretRef: { type: "secret_ref", secretId: foreignSecret.id, version: "latest" },
      }),
    ).rejects.toThrow(/not bound/i);

    const events = await db
      .select()
      .from(secretAccessEvents)
      .where(eq(secretAccessEvents.secretId, foreignSecret.id));
    expect(events).toHaveLength(0);
  });
});
