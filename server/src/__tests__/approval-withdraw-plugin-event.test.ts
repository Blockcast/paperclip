import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { activityLog, approvals, companies, createDb, pluginEventOutbox } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { logActivity, setPluginEventOutboxDb } from "../services/activity-log.js";
import { approvalService } from "../services/approvals.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres approval plugin-event tests: ${embeddedPostgresSupport.reason ?? "unsupported"}`,
  );
}

// A withdrawal is a terminal transition out of `pending` exactly like approve /
// reject / request-revision. If it does not reach the plugin outbox, every
// plugin mirror keeps rendering the approval as open forever -- the approvals
// queue this whole feature exists to drain would look undrained downstream.
describeEmbeddedPostgres("approval lifecycle plugin events", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const companyId = randomUUID();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-approval-plugin-event-");
    db = createDb(tempDb.connectionString);
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    setPluginEventOutboxDb(db);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  beforeEach(async () => {
    await db.delete(pluginEventOutbox);
    await db.delete(activityLog);
    await db.delete(approvals);
  });

  // The enqueue inside logActivity is deliberately fire-and-forget so the
  // signature stays synchronous, so poll rather than assuming it has landed by
  // the time logActivity resolves.
  async function waitForOutboxRow(entityId: string) {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const rows = await db
        .select()
        .from(pluginEventOutbox)
        .where(eq(pluginEventOutbox.companyId, companyId));
      const row = rows.find((candidate) => {
        const payload = candidate.payload as { entityId?: string } | null;
        return payload?.entityId === entityId;
      });
      if (row) return row;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return null;
  }

  it.each([
    ["approval.withdrawn", "withdrawn"],
    ["approval.rejected", "rejected"],
    ["approval.approved", "approved"],
    ["approval.revision_requested", "revision requested"],
  ])("enqueues approval.decided for %s", async (action, reason) => {
    const approvalId = randomUUID();
    await logActivity(db, {
      companyId,
      actorType: "agent",
      actorId: "requester-1",
      action,
      entityType: "approval",
      entityId: approvalId,
      agentId: null,
      details: { type: "budget_override_required", reason },
    });

    const row = await waitForOutboxRow(approvalId);
    expect(row?.eventType).toBe("approval.decided");
  });

  // The enqueue above rides the module-global outbox connection, which is a
  // different connection from any caller transaction. Inside a transaction that
  // is a correctness hole: the event commits on its own, so a transaction that
  // subsequently fails leaves plugins told an approval was decided while the
  // approval is in fact untouched. `atomicPluginEvent` binds the write to the
  // caller's handle instead. Both rows must vanish together.
  it("retracts the outbox row with the transaction when atomicPluginEvent is set", async () => {
    const approvalId = randomUUID();

    await expect(
      db.transaction(async (tx) => {
        await logActivity(tx as unknown as Db, {
          companyId,
          actorType: "agent",
          actorId: "requester-1",
          action: "approval.withdrawn",
          entityType: "approval",
          entityId: approvalId,
          agentId: null,
          details: { type: "budget_override_required", reason: "superseded" },
          atomicPluginEvent: true,
        });
        throw new Error("commit boom");
      }),
    ).rejects.toThrow("commit boom");

    // Poll rather than assert once: a row leaking via the fire-and-forget path
    // would land asynchronously, so an immediate check could pass by racing it.
    expect(await waitForOutboxRow(approvalId)).toBeNull();
    await expect(
      db.select().from(activityLog).where(eq(activityLog.entityId, approvalId)),
    ).resolves.toHaveLength(0);
  });

  // Service-level equivalent of the above: drive the real withdraw() and fail
  // the surrounding transaction. withdraw() opens its own transaction on the
  // handle it was built with, so passing an outer transaction nests it as a
  // savepoint and rolling the outer back unwinds the whole withdrawal.
  it("leaves no approval transition, activity row, or outbox event when a withdrawal rolls back", async () => {
    const approvalId = randomUUID();
    await db.insert(approvals).values({
      id: approvalId,
      companyId,
      type: "budget_override_required",
      requestedByAgentId: null,
      requestedByUserId: null,
      status: "pending",
      payload: { requestedCap: 800000 },
    });

    await expect(
      db.transaction(async (tx) => {
        await approvalService(tx as unknown as Db).withdraw(approvalId, "superseded by a direct cap raise", {
          userId: "user-1",
          activity: { actorType: "user", actorId: "user-1", agentId: null },
        });
        throw new Error("commit boom");
      }),
    ).rejects.toThrow("commit boom");

    const [approval] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
    expect(approval.status).toBe("pending");
    expect(approval.decisionNote).toBeNull();
    expect(await waitForOutboxRow(approvalId)).toBeNull();
    await expect(
      db.select().from(activityLog).where(eq(activityLog.entityId, approvalId)),
    ).resolves.toHaveLength(0);
  });
});
