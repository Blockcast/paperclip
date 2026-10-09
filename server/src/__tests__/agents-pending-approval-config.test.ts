import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  approvals,
  approvalComments,
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
import { REDACTED_EVENT_VALUE, redactAgentConfigPayload, redactEventPayload } from "../redaction.ts";

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
    // `resubmit` archives the board's decision note as an approval comment, so
    // this must go before `approvals` or the FK refuses the delete.
    await db.delete(approvalComments);
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
    //
    // PEN-3759: every tampered leaf is given a value DISTINCT from the fixture's.
    // An earlier version of this test wrote `token` and `apiKey` byte-identical
    // to `stored`, which pinned snapshot-wins (via the distinct `source` and
    // `endpoint`) but left row-wins incidental — the final `toEqual(stored)` held
    // no matter which side those masked leaves came from. Row-wins is the half
    // the freeze argument actually bounds, so it has to be asserted on values
    // that can only have come from the row.
    const tampered = {
      source: "tampered",
      integration: {
        token: { type: "plain", value: "tampered-integration-token-9a4e71" },
        endpoint: "https://attacker.example.test/hooks",
      },
      apiKey: "tampered-api-key-3c8f60",
    };
    await db
      .update(agents)
      .set({ metadata: tampered })
      .where(eq(agents.id, pending.id));

    await approvalSvc.approve(approval.id, "board-user", "Approved integrator hire");

    const activated = await agentSvc.getById(pending.id);
    // Unmasked in the card, so the board saw them: snapshot wins, tamper loses.
    expect(activated?.metadata).toMatchObject({
      source: "hire-form",
      integration: { endpoint: "https://integrations.example.test/hooks" },
    });
    // Masked in the card, so the board could not have read them: taken from the
    // ROW, which is the tampered value here — not the fixture's. This is the
    // assertion that makes row-wins non-incidental.
    expect(activated?.metadata).toEqual({
      source: "hire-form",
      integration: {
        token: tampered.integration.token,
        endpoint: "https://integrations.example.test/hooks",
      },
      apiKey: tampered.apiKey,
    });
    // And the sentinel never survives the replay, on either side.
    expect(JSON.stringify(activated?.metadata)).not.toContain(REDACTED_EVENT_VALUE);
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

  /**
   * PEN-3847, the `runtimeConfig` sibling of the three above.
   *
   * `mergeApprovedRuntimeConfig` keeps a mask from landing by starting from the
   * stored row and skipping `jsonEqual` keys — but it runs ONLY when
   * `requestedConfigurationSnapshot.runtimeConfig` is present, and otherwise the
   * approved copy was taken verbatim. That branch was believed unreachable
   * because `POST .../agent-hires` always sets the snapshot. `resubmit` is a
   * second producer: it REPLACES the stored payload wholesale, so a requester
   * doing read-modify-write against the redacted card supplies a masked leaf and
   * a missing snapshot together.
   *
   * These drive the real `requestRevision` → `resubmit` → `approve` sequence
   * rather than hand-building the post-resubmit payload, so the replacement
   * semantics are exercised and not assumed. The masked copy is produced by the
   * production approval redactor (`redactAgentConfigPayload`, what
   * `redactApprovalPayloadByType` applies to a `hire_agent` card), not written
   * by hand — a fixture that never round-tripped a sentinel would make the
   * assertions vacuous.
   */
  function hireRuntimeConfigFixture() {
    const stored = {
      heartbeat: { enabled: true, maxConcurrentRuns: 3 },
      modelProfiles: {
        cheap: {
          adapterConfig: {
            // An `env` map value: masked at any depth by the agent-config rule,
            // which is exactly the shape BLO-18969 added that rule for.
            env: { SIGNING_MATERIAL: { type: "plain", value: "runtime-signing-material-7c21ab" } },
          },
        },
      },
    };
    const masked = redactAgentConfigPayload(stored) ?? {};
    return { stored, masked };
  }

  async function seedPendingHireWithRuntimeConfig(
    companyId: string,
    agentSvc: ReturnType<typeof agentService>,
    approvalSvc: ReturnType<typeof approvalService>,
    storedRuntimeConfig: Record<string, unknown>,
  ) {
    const pending = await agentSvc.create(companyId, {
      name: "Pending Runtime",
      role: "engineer",
      adapterType: "process",
      adapterConfig: { command: "echo safe" },
      runtimeConfig: storedRuntimeConfig,
      budgetMonthlyCents: 1234,
      metadata: {},
      status: "pending_approval",
      spentMonthlyCents: 0,
      permissions: {},
      lastHeartbeatAt: null,
    });
    // The hire route stores the REAL value on the row; only the card is masked.
    expect(pending.runtimeConfig).toEqual(storedRuntimeConfig);

    const approval = await approvalSvc.create(companyId, {
      type: "hire_agent",
      requestedByAgentId: null,
      requestedByUserId: "board-user",
      status: "pending",
      payload: {
        name: "Pending Runtime",
        role: "engineer",
        adapterType: "process",
        adapterConfig: { command: "echo safe" },
        runtimeConfig: storedRuntimeConfig,
        budgetMonthlyCents: 1234,
        agentId: pending.id,
        requestedConfigurationSnapshot: { runtimeConfig: storedRuntimeConfig },
      },
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      updatedAt: new Date(),
    });

    await approvalSvc.requestRevision(approval.id, "board-user", "Tighten the concurrency");
    return { pending, approval };
  }

  it("restores a masked runtimeConfig leaf from the stored row on a snapshot-less resubmit", async () => {
    const companyId = await seedCompany();
    const agentSvc = agentService(db);
    const approvalSvc = approvalService(db);
    const { stored, masked } = hireRuntimeConfigFixture();

    // Positive control: the redacted card must actually carry the sentinel, or
    // this test proves nothing about the restore.
    expect(JSON.stringify(masked)).toContain(REDACTED_EVENT_VALUE);
    expect(masked).toMatchObject({
      modelProfiles: {
        cheap: { adapterConfig: { env: { SIGNING_MATERIAL: { type: "plain", value: REDACTED_EVENT_VALUE } } } },
      },
    });

    const { pending, approval } = await seedPendingHireWithRuntimeConfig(
      companyId,
      agentSvc,
      approvalSvc,
      stored,
    );

    // Read-modify-write against the redacted card, with no snapshot: exactly
    // what a client that GETs, edits and PUTs back produces.
    const resubmitted = await approvalSvc.resubmit(approval.id, {
      name: "Pending Runtime",
      role: "engineer",
      adapterType: "process",
      adapterConfig: { command: "echo safe" },
      runtimeConfig: masked,
      budgetMonthlyCents: 1234,
      agentId: pending.id,
    });
    // Second positive control: `resubmit` REPLACES rather than merges, so the
    // snapshot is genuinely gone and the masked copy is genuinely stored.
    expect(resubmitted.payload).not.toHaveProperty("requestedConfigurationSnapshot");
    expect(JSON.stringify(resubmitted.payload)).toContain(REDACTED_EVENT_VALUE);

    await approvalSvc.approve(approval.id, "board-user", "Approved after revision");

    const activated = await agentSvc.getById(pending.id);
    expect(activated?.status).toBe("idle");
    expect(JSON.stringify(activated?.runtimeConfig)).not.toContain(REDACTED_EVENT_VALUE);
    expect(activated?.runtimeConfig).toEqual(stored);
  });

  it("still applies a genuine runtimeConfig change made in that same snapshot-less resubmit", async () => {
    const companyId = await seedCompany();
    const agentSvc = agentService(db);
    const approvalSvc = approvalService(db);
    const { stored, masked } = hireRuntimeConfigFixture();

    const { pending, approval } = await seedPendingHireWithRuntimeConfig(
      companyId,
      agentSvc,
      approvalSvc,
      stored,
    );

    // The board asked for a lower concurrency. This is the half option (a) —
    // falling back to `existing.runtimeConfig` whenever the snapshot is absent —
    // would silently discard, which is why the fix is a leaf-wise restore.
    const editedRuntimeConfig = {
      ...masked,
      heartbeat: { enabled: true, maxConcurrentRuns: 1 },
    };
    expect(JSON.stringify(editedRuntimeConfig)).toContain(REDACTED_EVENT_VALUE);

    await approvalSvc.resubmit(approval.id, {
      name: "Pending Runtime",
      role: "engineer",
      adapterType: "process",
      adapterConfig: { command: "echo safe" },
      runtimeConfig: editedRuntimeConfig,
      budgetMonthlyCents: 1234,
      agentId: pending.id,
    });
    await approvalSvc.approve(approval.id, "board-user", "Approved after revision");

    const activated = await agentSvc.getById(pending.id);
    // Unmasked in the card, so the board saw and changed it: the edit wins.
    expect(activated?.runtimeConfig).toMatchObject({
      heartbeat: { enabled: true, maxConcurrentRuns: 1 },
    });
    // Masked in the card, so the board could not have read it: restored.
    expect(JSON.stringify(activated?.runtimeConfig)).not.toContain(REDACTED_EVENT_VALUE);
    expect(activated?.runtimeConfig).toMatchObject({
      modelProfiles: stored.modelProfiles,
    });
  });

  it("drops a masked runtimeConfig leaf with nothing stored to restore rather than persisting the sentinel", async () => {
    const companyId = await seedCompany();
    const agentSvc = agentService(db);
    const approvalSvc = approvalService(db);
    const stored = { heartbeat: { enabled: true, maxConcurrentRuns: 3 } };

    const { pending, approval } = await seedPendingHireWithRuntimeConfig(
      companyId,
      agentSvc,
      approvalSvc,
      stored,
    );

    // A leaf the stored row has never held. There is nothing to restore from, so
    // the fail-closed outcome is to omit it — never to write the placeholder.
    const masked = redactAgentConfigPayload({
      ...stored,
      webhook: { token: "runtime-webhook-token-91ae0d" },
    }) ?? {};
    expect(masked).toMatchObject({ webhook: { token: REDACTED_EVENT_VALUE } });

    await approvalSvc.resubmit(approval.id, {
      name: "Pending Runtime",
      role: "engineer",
      adapterType: "process",
      adapterConfig: { command: "echo safe" },
      runtimeConfig: masked,
      budgetMonthlyCents: 1234,
      agentId: pending.id,
    });
    await approvalSvc.approve(approval.id, "board-user", "Approved after revision");

    const activated = await agentSvc.getById(pending.id);
    expect(JSON.stringify(activated?.runtimeConfig)).not.toContain(REDACTED_EVENT_VALUE);
    expect(activated?.runtimeConfig).toMatchObject(stored);
    // Ceiling, pinned rather than papered over: the *leaf* is dropped, so no
    // sentinel is persisted — but the object that held it survives as an empty
    // shell, because `restoreRedactedAdapterValue` prunes keys and does not
    // prune now-empty containers. Inherited from the `metadata` restore and the
    // same on both columns. Harmless here (`runtimeConfig` readers key off
    // specific paths, and `{}` carries no value a reader can act on wrongly) but
    // worth knowing before anyone reads a dropped key as a dropped subtree.
    expect(activated?.runtimeConfig).toMatchObject({ webhook: {} });
  });

  it("restores a masked runtimeConfig leaf inside the merge branch too, when only the approved copy is masked", async () => {
    const companyId = await seedCompany();
    const agentSvc = agentService(db);
    const approvalSvc = approvalService(db);
    const { stored, masked } = hireRuntimeConfigFixture();

    const { pending, approval } = await seedPendingHireWithRuntimeConfig(
      companyId,
      agentSvc,
      approvalSvc,
      stored,
    );

    // Snapshot PRESENT, so `mergeApprovedRuntimeConfig` runs — but the snapshot
    // carries the real value while the approved copy carries the mask. They are
    // not `jsonEqual`, so the merge's `continue` never fires and the approved
    // copy would otherwise be taken as the change.
    await approvalSvc.resubmit(approval.id, {
      name: "Pending Runtime",
      role: "engineer",
      adapterType: "process",
      adapterConfig: { command: "echo safe" },
      runtimeConfig: masked,
      budgetMonthlyCents: 1234,
      agentId: pending.id,
      requestedConfigurationSnapshot: { runtimeConfig: stored },
    });
    await approvalSvc.approve(approval.id, "board-user", "Approved after revision");

    const activated = await agentSvc.getById(pending.id);
    expect(JSON.stringify(activated?.runtimeConfig)).not.toContain(REDACTED_EVENT_VALUE);
    expect(activated?.runtimeConfig).toEqual(stored);
  });
});
