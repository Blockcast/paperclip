import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  approvals,
  activityLog,
  budgetPolicies,
  companies,
  createDb,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.ts";
import { approvalService } from "../services/approvals.ts";
import { REDACTED_EVENT_VALUE, redactEventPayload } from "../redaction.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function issuePrefix(id: string) {
  return `T${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres pending approval agent tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("pending approval agent config integrity", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-pending-agent-config-");
    db = createDb(tempDb.connectionString);
  });

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(budgetPolicies);
    await db.delete(approvals);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: issuePrefix(companyId),
      requireBoardApprovalForNewAgents: true,
    });
    return companyId;
  }

  it("freezes generic pending hire config and reapplies the approval snapshot on activation", async () => {
    const companyId = await seedCompany();
    const agentSvc = agentService(db);
    const approvalSvc = approvalService(db);
    const pending = await agentSvc.create(companyId, {
      name: "Pending Coder",
      role: "engineer",
      title: "Software Engineer",
      icon: "code",
      capabilities: "Writes code",
      adapterType: "process",
      adapterConfig: { command: "echo safe" },
      runtimeConfig: { maxConcurrentRuns: 1 },
      budgetMonthlyCents: 1234,
      metadata: { source: "hire-form" },
      status: "pending_approval",
      spentMonthlyCents: 0,
      permissions: {},
      lastHeartbeatAt: null,
    });
    const approval = await approvalSvc.create(companyId, {
      type: "hire_agent",
      requestedByAgentId: null,
      requestedByUserId: "board-user",
      status: "pending",
      payload: {
        name: "Pending Coder",
        role: "engineer",
        title: "Software Engineer",
        icon: "code",
        reportsTo: null,
        capabilities: "Writes code",
        adapterType: "process",
        adapterConfig: { command: "echo safe" },
        runtimeConfig: { maxConcurrentRuns: 1 },
        budgetMonthlyCents: 1234,
        metadata: { source: "hire-form" },
        agentId: pending.id,
      },
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      updatedAt: new Date(),
    });

    await expect(agentSvc.update(pending.id, {
      name: "Tampered Coder",
      adapterConfig: { command: "echo malicious" },
      runtimeConfig: { maxConcurrentRuns: 99 },
    })).rejects.toMatchObject({
      status: 409,
      details: {
        code: "pending_approval_agent_config_frozen",
        agentId: pending.id,
        fields: ["name", "adapterConfig", "runtimeConfig"],
      },
    });
    await expect(agentSvc.updatePermissions(pending.id, {
      canCreateAgents: true,
    })).rejects.toMatchObject({
      status: 409,
      details: {
        code: "pending_approval_agent_config_frozen",
        agentId: pending.id,
        fields: ["permissions"],
      },
    });

    await db
      .update(agents)
      .set({
        name: "Tampered Coder",
        adapterConfig: { command: "echo malicious" },
        runtimeConfig: { maxConcurrentRuns: 99 },
        metadata: { source: "tampered" },
      })
      .where(eq(agents.id, pending.id));

    await approvalSvc.approve(approval.id, "board-user", "Approved generic hire");

    await expect(agentSvc.getById(pending.id)).resolves.toMatchObject({
      status: "idle",
      name: "Pending Coder",
      role: "engineer",
      title: "Software Engineer",
      icon: "code",
      capabilities: "Writes code",
      adapterType: "process",
      adapterConfig: { command: "echo safe" },
      runtimeConfig: { maxConcurrentRuns: 1 },
      budgetMonthlyCents: 1234,
      metadata: { source: "hire-form" },
    });
  });

  /**
   * PEN-3757. The hire route snapshots `metadata` through `redactEventPayload`,
   * which masks on KEY NAME with no value gate — so a hire carrying a value
   * under a Tier-1 key (`token`, `apiKey`, …) stores the REAL value on the
   * `pending_approval` row and a MASKED copy in the approval payload. Replaying
   * that snapshot verbatim persisted `***REDACTED***` over the real value.
   *
   * These build the approval payload with the production redactor rather than a
   * hand-written sentinel, and assert the sentinel is genuinely present before
   * approving — a fixture that never round-tripped one would make the whole
   * assertion vacuous.
   */
  function hireMetadataFixture() {
    const stored = {
      source: "hire-form",
      integration: {
        // Object binding under a Tier-1 key: masks to {type:"plain",value:SENTINEL}.
        token: { type: "plain", value: "hire-integration-token-5f1c93" },
        endpoint: "https://integrations.example.test/hooks",
      },
      // Bare string under a Tier-1 key: masks to the bare sentinel.
      apiKey: "hire-api-key-0b7d2e",
    };
    const snapshot = redactEventPayload(stored) ?? {};
    return { stored, snapshot };
  }

  it("restores a masked metadata credential from the stored row instead of replaying the sentinel", async () => {
    const companyId = await seedCompany();
    const agentSvc = agentService(db);
    const approvalSvc = approvalService(db);
    const { stored, snapshot } = hireMetadataFixture();

    // Positive control: the snapshot must actually carry the sentinel, in both
    // shapes, or this test proves nothing about the restore.
    expect(JSON.stringify(snapshot)).toContain(REDACTED_EVENT_VALUE);
    expect(snapshot).toMatchObject({
      integration: { token: { type: "plain", value: REDACTED_EVENT_VALUE } },
      apiKey: REDACTED_EVENT_VALUE,
    });

    const pending = await agentSvc.create(companyId, {
      name: "Pending Integrator",
      role: "engineer",
      adapterType: "process",
      adapterConfig: { command: "echo safe" },
      runtimeConfig: {},
      budgetMonthlyCents: 1234,
      metadata: stored,
      status: "pending_approval",
      spentMonthlyCents: 0,
      permissions: {},
      lastHeartbeatAt: null,
    });
    // The hire route's `:3127` scrub leaves a genuine credential alone (no
    // sentinel to short-circuit on), so the real value is what is persisted —
    // which is what makes the replay destructive rather than a no-op.
    expect(pending.metadata).toEqual(stored);

    const approval = await approvalSvc.create(companyId, {
      type: "hire_agent",
      requestedByAgentId: null,
      requestedByUserId: "board-user",
      status: "pending",
      payload: {
        name: "Pending Integrator",
        role: "engineer",
        adapterType: "process",
        adapterConfig: { command: "echo safe" },
        runtimeConfig: {},
        budgetMonthlyCents: 1234,
        metadata: snapshot,
        agentId: pending.id,
      },
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      updatedAt: new Date(),
    });

    await approvalSvc.approve(approval.id, "board-user", "Approved integrator hire");

    const activated = await agentSvc.getById(pending.id);
    expect(activated?.status).toBe("idle");
    expect(activated?.metadata).toEqual(stored);
    expect(JSON.stringify(activated?.metadata)).not.toContain(REDACTED_EVENT_VALUE);
  });

  it("still replays the board-visible metadata fields when the snapshot also carries a masked one", async () => {
    const companyId = await seedCompany();
    const agentSvc = agentService(db);
    const approvalSvc = approvalService(db);
    const { stored, snapshot } = hireMetadataFixture();

    const pending = await agentSvc.create(companyId, {
      name: "Pending Integrator",
      role: "engineer",
      adapterType: "process",
      adapterConfig: { command: "echo safe" },
      runtimeConfig: {},
      budgetMonthlyCents: 1234,
      metadata: stored,
      status: "pending_approval",
      spentMonthlyCents: 0,
      permissions: {},
      lastHeartbeatAt: null,
    });

    const approval = await approvalSvc.create(companyId, {
      type: "hire_agent",
      requestedByAgentId: null,
      requestedByUserId: "board-user",
      status: "pending",
      payload: {
        name: "Pending Integrator",
        role: "engineer",
        adapterType: "process",
        adapterConfig: { command: "echo safe" },
        runtimeConfig: {},
        budgetMonthlyCents: 1234,
        metadata: snapshot,
        agentId: pending.id,
      },
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      updatedAt: new Date(),
    });

    // Direct SQL, deliberately: the service path refuses this (see the freeze
    // test below). The point is that even if the row IS moved, the restore must
    // take only the leaves the board could not read — not the whole object.
    await db
      .update(agents)
      .set({
        metadata: {
          source: "tampered",
          integration: {
            token: { type: "plain", value: "hire-integration-token-5f1c93" },
            endpoint: "https://attacker.example.test/hooks",
          },
          apiKey: "hire-api-key-0b7d2e",
        },
      })
      .where(eq(agents.id, pending.id));

    await approvalSvc.approve(approval.id, "board-user", "Approved integrator hire");

    const activated = await agentSvc.getById(pending.id);
    // Unmasked in the card, so the board saw them: snapshot wins, tamper loses.
    expect(activated?.metadata).toMatchObject({
      source: "hire-form",
      integration: { endpoint: "https://integrations.example.test/hooks" },
    });
    // Masked in the card, so the board could not have read them: restored.
    expect(activated?.metadata).toEqual(stored);
  });

  it("freezes `metadata` on a pending hire, so the restore source cannot be moved before approval", async () => {
    const companyId = await seedCompany();
    const agentSvc = agentService(db);
    const { stored } = hireMetadataFixture();

    const pending = await agentSvc.create(companyId, {
      name: "Pending Integrator",
      role: "engineer",
      adapterType: "process",
      adapterConfig: { command: "echo safe" },
      runtimeConfig: {},
      budgetMonthlyCents: 1234,
      metadata: stored,
      status: "pending_approval",
      spentMonthlyCents: 0,
      permissions: {},
      lastHeartbeatAt: null,
    });

    // `metadata` is in CONFIG_REVISION_FIELDS, so the pending-approval freeze
    // covers it. This is what bounds the residual on restoring from `existing`:
    // the leaves taken from the row are ones a pending agent cannot have moved.
    await expect(agentSvc.update(pending.id, {
      metadata: { source: "hire-form", apiKey: "attacker-supplied" },
    })).rejects.toMatchObject({
      status: 409,
      details: {
        code: "pending_approval_agent_config_frozen",
        agentId: pending.id,
        fields: ["metadata"],
      },
    });
    await expect(agentSvc.getById(pending.id)).resolves.toMatchObject({ metadata: stored });
  });
});
