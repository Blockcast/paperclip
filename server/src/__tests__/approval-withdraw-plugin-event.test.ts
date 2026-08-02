import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { activityLog, companies, createDb, pluginEventOutbox } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { logActivity, setPluginEventOutboxDb } from "../services/activity-log.js";

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
});
