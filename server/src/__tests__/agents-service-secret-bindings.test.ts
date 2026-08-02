import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  agents,
  approvals,
  companies,
  companySecretBindings,
  companySecretProviderConfigs,
  companySecretVersions,
  companySecrets,
  createDb,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.ts";
import { approvalService } from "../services/approvals.ts";
import { secretService } from "../services/secrets.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent secret binding tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("agent service secret binding sync", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-agent-secret-bindings-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("agent-secret-bindings");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 120_000);

  afterEach(async () => {
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(companySecretProviderConfigs);
    await db.delete(approvals);
    await db.delete(agents);
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

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgentRow(
    companyId: string,
    overrides: Partial<typeof agents.$inferInsert>,
  ) {
    const id = randomUUID();
    await db.insert(agents).values({
      id,
      companyId,
      name: `Agent ${id.slice(0, 8)}`,
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
      ...overrides,
    });
    return id;
  }

  it("enforces external-lifecycle concurrency at the persistence boundary", async () => {
    const companyId = await seedCompany();
    const agents = agentService(db);
    const base = {
      role: "engineer" as const,
      status: "idle" as const,
      adapterConfig: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    };

    const external = await agents.create(companyId, {
      ...base,
      name: "External Default",
      adapterType: "opencode_k8s",
      runtimeConfig: {},
    });
    expect(external.runtimeConfig).toMatchObject({
      heartbeat: { maxConcurrentRuns: 16 },
    });

    const local = await agents.create(companyId, {
      ...base,
      name: "Local High Concurrency",
      adapterType: "codex_local",
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 50 } },
    });
    expect(local.runtimeConfig).toMatchObject({
      heartbeat: { maxConcurrentRuns: 50 },
    });

    await expect(agents.create(companyId, {
      ...base,
      name: "External Over Cap",
      adapterType: "opencode_k8s",
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 17 } },
    })).rejects.toMatchObject({ status: 422 });
    await expect(agents.update(external.id, {
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 17 } },
    })).rejects.toMatchObject({ status: 422 });
    await expect(agents.update(local.id, {
      adapterType: "opencode_k8s",
    })).rejects.toMatchObject({ status: 422 });

    const pending = await agents.create(companyId, {
      ...base,
      name: "Pending External",
      status: "pending_approval",
      adapterType: "opencode_k8s",
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 15 } },
    });
    await expect(agents.activatePendingApproval(pending.id, {
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 17 } },
    })).rejects.toMatchObject({ status: 422 });

    const switched = await agents.update(local.id, {
      adapterType: "opencode_k8s",
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 15 } },
    });
    expect(switched).toMatchObject({
      adapterType: "opencode_k8s",
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 15 } },
    });
  });

  it("normalizes missing external-lifecycle concurrency on service update and activation", async () => {
    const companyId = await seedCompany();
    const service = agentService(db);

    const externalId = await seedAgentRow(companyId, {
      name: "Legacy External",
      adapterType: "opencode_k8s",
      runtimeConfig: {},
    });
    const updated = await service.update(externalId, { runtimeConfig: {} });
    expect(updated).toMatchObject({
      adapterType: "opencode_k8s",
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 16 } },
    });

    const switchId = await seedAgentRow(companyId, {
      name: "Legacy Local",
      adapterType: "codex_local",
      runtimeConfig: {},
    });
    const switched = await service.update(switchId, { adapterType: "opencode_k8s" });
    expect(switched).toMatchObject({
      adapterType: "opencode_k8s",
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 16 } },
    });

    const pendingId = await seedAgentRow(companyId, {
      name: "Pending External",
      status: "pending_approval",
      adapterType: "opencode_k8s",
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 15 } },
    });
    const activated = await service.activatePendingApproval(pendingId, { runtimeConfig: {} });
    expect(activated).toMatchObject({
      activated: true,
      agent: {
        adapterType: "opencode_k8s",
        runtimeConfig: { heartbeat: { maxConcurrentRuns: 16 } },
      },
    });
  });

  it("validates external-lifecycle concurrency against the locked row after concurrent updates", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgentRow(companyId, {
      name: "Concurrent Local",
      adapterType: "codex_local",
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 15 } },
    });

    let pendingUpdate!: Promise<{ status: "resolved"; value: unknown } | { status: "rejected"; error: unknown }>;
    await db.transaction(async (tx) => {
      await tx.execute(sql`select ${agents.id} from ${agents} where ${agents.id} = ${agentId} for update`);
      pendingUpdate = agentService(db)
        .update(agentId, { adapterType: "opencode_k8s" })
        .then(
          (value) => ({ status: "resolved" as const, value }),
          (error) => ({ status: "rejected" as const, error }),
        );
      await new Promise((resolve) => setTimeout(resolve, 100));
      await tx
        .update(agents)
        .set({
          runtimeConfig: { heartbeat: { maxConcurrentRuns: 50 } },
          updatedAt: new Date(),
        })
        .where(eq(agents.id, agentId));
    });

    const result = await pendingUpdate;
    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") return;
    expect(result.error).toMatchObject({ status: 422 });

    const row = await db
      .select({ adapterType: agents.adapterType, runtimeConfig: agents.runtimeConfig })
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0]);
    expect(row).toMatchObject({
      adapterType: "codex_local",
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 50 } },
    });
  });

  it("merges partial runtime patches against the locked row", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgentRow(companyId, {
      name: "Concurrent Partial Runtime Update",
      adapterType: "opencode_k8s",
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 15, wakeOnDemand: false } },
    });
    const service = agentService(db);

    let pendingUpdate!: ReturnType<typeof service.update>;
    await db.transaction(async (tx) => {
      await tx.execute(sql`select ${agents.id} from ${agents} where ${agents.id} = ${agentId} for update`);
      pendingUpdate = service.update(agentId, {
        runtimeConfig: { heartbeat: { wakeOnDemand: true } },
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      await tx.update(agents).set({
        runtimeConfig: { heartbeat: { maxConcurrentRuns: 12, wakeOnDemand: false } },
      }).where(eq(agents.id, agentId));
    });

    await expect(pendingUpdate).resolves.toMatchObject({
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 12, wakeOnDemand: true } },
    });
  });

  it("does not reject from an invalid runtime snapshot repaired before locking", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgentRow(companyId, {
      name: "Legacy Invalid External Runtime",
      adapterType: "opencode_k8s",
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 17 } },
    });
    const service = agentService(db);

    let pendingUpdate!: ReturnType<typeof service.update>;
    let settled = false;
    await db.transaction(async (tx) => {
      await tx.execute(sql`select ${agents.id} from ${agents} where ${agents.id} = ${agentId} for update`);
      pendingUpdate = service.update(agentId, { adapterType: "opencode_k8s" });
      void pendingUpdate.finally(() => {
        settled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(settled).toBe(false);
      await tx.update(agents).set({
        runtimeConfig: { heartbeat: { maxConcurrentRuns: 15 } },
      }).where(eq(agents.id, agentId));
    });

    await expect(pendingUpdate).resolves.toMatchObject({
      adapterType: "opencode_k8s",
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 15 } },
    });
  });

  it("activates from the locked pending-agent runtime without losing a concurrent update", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgentRow(companyId, {
      name: "Concurrent Pending Activation",
      status: "pending_approval",
      adapterType: "opencode_k8s",
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 15, wakeOnDemand: false } },
    });
    const service = agentService(db);

    let pendingActivation!: ReturnType<typeof service.activatePendingApproval>;
    let settled = false;
    await db.transaction(async (tx) => {
      await tx.execute(sql`select ${agents.id} from ${agents} where ${agents.id} = ${agentId} for update`);
      pendingActivation = service.activatePendingApproval(agentId, { role: "reviewer" });
      void pendingActivation.finally(() => {
        settled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(settled).toBe(false);
      await tx.update(agents).set({
        runtimeConfig: { heartbeat: { maxConcurrentRuns: 12, wakeOnDemand: true } },
      }).where(eq(agents.id, agentId));
    });

    await expect(pendingActivation).resolves.toMatchObject({
      activated: true,
      agent: {
        status: "idle",
        role: "reviewer",
        runtimeConfig: { heartbeat: { maxConcurrentRuns: 12, wakeOnDemand: true } },
      },
    });
  });

  it("preserves concurrent runtime changes through the production hire approval path", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgentRow(companyId, {
      name: "Production Approval Race",
      status: "pending_approval",
      adapterType: "opencode_k8s",
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 15, wakeOnDemand: false } },
    });
    const requestedRuntimeConfig = {
      heartbeat: { maxConcurrentRuns: 15, wakeOnDemand: false },
    };
    const approvalId = randomUUID();
    await db.insert(approvals).values({
      id: approvalId,
      companyId,
      type: "hire_agent",
      status: "pending",
      requestedByUserId: "requester",
      payload: {
        agentId,
        name: "Production Approval Race",
        role: "engineer",
        adapterType: "opencode_k8s",
        adapterConfig: {},
        runtimeConfig: requestedRuntimeConfig,
        budgetMonthlyCents: 0,
        requestedConfigurationSnapshot: {
          adapterType: "opencode_k8s",
          adapterConfig: {},
          runtimeConfig: requestedRuntimeConfig,
        },
      },
      updatedAt: new Date(),
    });

    let pendingApproval!: ReturnType<ReturnType<typeof approvalService>["approve"]>;
    let settled = false;
    await db.transaction(async (tx) => {
      await tx.execute(sql`select ${agents.id} from ${agents} where ${agents.id} = ${agentId} for update`);
      pendingApproval = approvalService(db).approve(approvalId, "board-user", "Approved");
      void pendingApproval.finally(() => {
        settled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(settled).toBe(false);
      await tx.update(agents).set({
        runtimeConfig: { heartbeat: { maxConcurrentRuns: 12, wakeOnDemand: true } },
      }).where(eq(agents.id, agentId));
    });

    await expect(pendingApproval).resolves.toMatchObject({ applied: true });
    await expect(agentService(db).getById(agentId)).resolves.toMatchObject({
      status: "idle",
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 12, wakeOnDemand: true } },
    });
  });

  it("creates agent secret bindings when a new agent persists secret_ref env", async () => {
    const companyId = await seedCompany();
    const secrets = secretService(db);
    const secret = await secrets.create(companyId, {
      name: `anthropic-${randomUUID()}`,
      provider: "local_encrypted",
      value: "sk-ant-123",
    });

    const created = await agentService(db).create(companyId, {
      name: "Claude Novita",
      role: "engineer",
      status: "pending_approval",
      adapterType: "claude_local",
      adapterConfig: {
        env: {
          ANTHROPIC_API_KEY: { type: "secret_ref", secretId: secret.id, version: "latest" },
        },
      },
      runtimeConfig: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });

    const bindings = await db
      .select()
      .from(companySecretBindings)
      .where(and(
        eq(companySecretBindings.companyId, companyId),
        eq(companySecretBindings.targetType, "agent"),
        eq(companySecretBindings.targetId, created.id),
      ));

    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      secretId: secret.id,
      configPath: "env.ANTHROPIC_API_KEY",
      versionSelector: "latest",
      required: true,
    });
  });

  it("stores approved class-3 env lease metadata on agent secret bindings", async () => {
    const companyId = await seedCompany();
    const secrets = secretService(db);
    const secret = await secrets.create(companyId, {
      name: `slack-${randomUUID()}`,
      provider: "local_encrypted",
      value: "slack-test-token",
    });

    const created = await agentService(db).create(companyId, {
      name: "Slack Briefing",
      role: "briefing",
      adapterType: "codex_local",
      adapterConfig: {
        env: {
          SLACK_BOT_TOKEN: {
            type: "secret_ref",
            secretId: secret.id,
            version: "latest",
            projectionClass: "class_3_static_lease",
            projectionAllowlistKey: "slack.bot_token",
          },
        },
      },
      runtimeConfig: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });

    const bindings = await db
      .select()
      .from(companySecretBindings)
      .where(and(
        eq(companySecretBindings.companyId, companyId),
        eq(companySecretBindings.targetType, "agent"),
        eq(companySecretBindings.targetId, created.id),
      ));

    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      secretId: secret.id,
      configPath: "env.SLACK_BOT_TOKEN",
      projectionClass: "class_3_static_lease",
      projectionAllowlistKey: "slack.bot_token",
    });
  });

  it("rejects class-3 env lease bindings outside the enumerated allowlist", async () => {
    const companyId = await seedCompany();
    const secrets = secretService(db);
    const secret = await secrets.create(companyId, {
      name: `github-${randomUUID()}`,
      provider: "local_encrypted",
      value: "github-test-token",
    });

    await expect(
      agentService(db).create(companyId, {
        name: "Unlisted Static Lease",
        role: "engineer",
        adapterType: "codex_local",
        adapterConfig: {
          env: {
            GITHUB_TOKEN: {
              type: "secret_ref",
              secretId: secret.id,
              version: "latest",
              projectionClass: "class_3_static_lease",
              projectionAllowlistKey: "github.token",
            },
          },
        },
        runtimeConfig: {},
        spentMonthlyCents: 0,
        lastHeartbeatAt: null,
      }),
    ).rejects.toMatchObject({
      status: 422,
      details: { code: "class_3_static_lease_not_allowed" },
    });

    const persistedAgents = await db
      .select()
      .from(agents)
      .where(eq(agents.companyId, companyId));
    expect(persistedAgents).toHaveLength(0);
  });

  it("converts Hermes gateway apiKey strings into persisted secret refs", async () => {
    const companyId = await seedCompany();
    const literalApiKey = `hermes-key-${randomUUID()}`;

    const created = await agentService(db).create(companyId, {
      name: "Hermes Gateway",
      role: "engineer",
      status: "idle",
      adapterType: "hermes_gateway",
      adapterConfig: {
        apiBaseUrl: "https://hermes.example",
        apiKey: literalApiKey,
      },
      runtimeConfig: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });

    const persistedRows = await db
      .select()
      .from(agents)
      .where(eq(agents.id, created.id));
    const persistedConfig = persistedRows[0]?.adapterConfig as Record<string, unknown>;
    expect(JSON.stringify(persistedConfig)).not.toContain(literalApiKey);
    expect(persistedConfig.apiKey).toMatchObject({
      type: "secret_ref",
      version: "latest",
    });

    const secretId = (persistedConfig.apiKey as { secretId: string }).secretId;
    const bindings = await db
      .select()
      .from(companySecretBindings)
      .where(and(
        eq(companySecretBindings.companyId, companyId),
        eq(companySecretBindings.targetType, "agent"),
        eq(companySecretBindings.targetId, created.id),
      ));
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      secretId,
      configPath: "apiKey",
      versionSelector: "latest",
      required: true,
    });

    const resolved = await secretService(db).resolveAdapterConfigForRuntime(
      companyId,
      persistedConfig,
      {
        consumerType: "agent",
        consumerId: created.id,
      },
      { adapterType: "hermes_gateway" },
    );
    expect(resolved.config.apiKey).toBe(literalApiKey);
    expect(JSON.stringify(persistedConfig)).not.toContain(literalApiKey);
  });

  it("replaces agent secret bindings when adapterConfig env changes", async () => {
    const companyId = await seedCompany();
    const secrets = secretService(db);
    const oldSecret = await secrets.create(companyId, {
      name: `old-${randomUUID()}`,
      provider: "local_encrypted",
      value: "old-value",
    });
    const nextSecret = await secrets.create(companyId, {
      name: `next-${randomUUID()}`,
      provider: "local_encrypted",
      value: "next-value",
    });

    const created = await agentService(db).create(companyId, {
      name: "Binding Swapper",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {
        env: {
          OLD_KEY: { type: "secret_ref", secretId: oldSecret.id, version: "latest" },
        },
      },
      runtimeConfig: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });

    await agentService(db).update(created.id, {
      adapterConfig: {
        env: {
          NEW_KEY: { type: "secret_ref", secretId: nextSecret.id, version: "latest" },
        },
      },
    });

    const bindings = await db
      .select()
      .from(companySecretBindings)
      .where(and(
        eq(companySecretBindings.companyId, companyId),
        eq(companySecretBindings.targetType, "agent"),
        eq(companySecretBindings.targetId, created.id),
      ));

    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      secretId: nextSecret.id,
      configPath: "env.NEW_KEY",
    });
  });

  it("backfills missing secret bindings when a legacy pending agent is approved", async () => {
    const companyId = await seedCompany();
    const secrets = secretService(db);
    const secret = await secrets.create(companyId, {
      name: `legacy-${randomUUID()}`,
      provider: "local_encrypted",
      value: "legacy-value",
    });
    const agentId = randomUUID();

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Legacy Pending Agent",
      role: "engineer",
      status: "pending_approval",
      adapterType: "claude_local",
      adapterConfig: {
        env: {
          ANTHROPIC_API_KEY: { type: "secret_ref", secretId: secret.id, version: "latest" },
        },
      },
      runtimeConfig: {},
      permissions: {},
    });

    const beforeBindings = await db
      .select()
      .from(companySecretBindings)
      .where(eq(companySecretBindings.targetId, agentId));
    expect(beforeBindings).toHaveLength(0);

    const approved = await agentService(db).activatePendingApproval(agentId);

    expect(approved).toMatchObject({
      activated: true,
      agent: {
        id: agentId,
        status: "idle",
      },
    });

    const afterBindings = await db
      .select()
      .from(companySecretBindings)
      .where(and(
        eq(companySecretBindings.companyId, companyId),
        eq(companySecretBindings.targetType, "agent"),
        eq(companySecretBindings.targetId, agentId),
      ));

    expect(afterBindings).toHaveLength(1);
    expect(afterBindings[0]).toMatchObject({
      secretId: secret.id,
      configPath: "env.ANTHROPIC_API_KEY",
    });
  });

  it("rolls back create when binding sync fails", async () => {
    const companyId = await seedCompany();
    const missingSecretId = randomUUID();

    await expect(
      agentService(db).create(companyId, {
        name: "Broken Create",
        role: "engineer",
        adapterType: "claude_local",
        adapterConfig: {
          env: {
            ANTHROPIC_API_KEY: { type: "secret_ref", secretId: missingSecretId, version: "latest" },
          },
        },
        runtimeConfig: {},
        spentMonthlyCents: 0,
        lastHeartbeatAt: null,
      }),
    ).rejects.toBeTruthy();

    const persistedAgents = await db
      .select()
      .from(agents)
      .where(eq(agents.companyId, companyId));
    expect(persistedAgents).toHaveLength(0);
  });

  it("rolls back adapterConfig updates when binding sync fails", async () => {
    const companyId = await seedCompany();
    const secrets = secretService(db);
    const validSecret = await secrets.create(companyId, {
      name: `valid-${randomUUID()}`,
      provider: "local_encrypted",
      value: "valid-value",
    });
    const created = await agentService(db).create(companyId, {
      name: "Transactional Update",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {
        env: {
          API_KEY: { type: "secret_ref", secretId: validSecret.id, version: "latest" },
        },
      },
      runtimeConfig: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });

    await expect(
      agentService(db).update(created.id, {
        adapterConfig: {
          env: {
            API_KEY: { type: "secret_ref", secretId: randomUUID(), version: "latest" },
          },
        },
      }),
    ).rejects.toBeTruthy();

    const reloaded = await agentService(db).getById(created.id);
    expect(reloaded?.adapterConfig).toMatchObject({
      env: {
        API_KEY: { type: "secret_ref", secretId: validSecret.id, version: "latest" },
      },
    });

    const bindings = await db
      .select()
      .from(companySecretBindings)
      .where(and(
        eq(companySecretBindings.companyId, companyId),
        eq(companySecretBindings.targetType, "agent"),
        eq(companySecretBindings.targetId, created.id),
      ));
    expect(bindings).toHaveLength(1);
    expect(bindings[0]?.secretId).toBe(validSecret.id);
  });

  it("keeps pending approval status when activation binding sync fails", async () => {
    const companyId = await seedCompany();
    const agentId = randomUUID();

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Broken Pending Agent",
      role: "engineer",
      status: "pending_approval",
      adapterType: "claude_local",
      adapterConfig: {
        env: {
          ANTHROPIC_API_KEY: { type: "secret_ref", secretId: randomUUID(), version: "latest" },
        },
      },
      runtimeConfig: {},
      permissions: {},
    });

    await expect(agentService(db).activatePendingApproval(agentId)).rejects.toBeTruthy();

    const reloaded = await agentService(db).getById(agentId);
    expect(reloaded?.status).toBe("pending_approval");
  });
});
