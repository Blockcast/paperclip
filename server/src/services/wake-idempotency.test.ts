import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agentWakeupRequests, agents, companies, createDb } from "@paperclipai/db";
import { findWakeIdempotencyReceipt } from "./wake-idempotency.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping wake idempotency receipt tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("wake idempotency receipts", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;
  let agentId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-wake-idempotency-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    companyId = randomUUID();
    agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Wake Co",
      issuePrefix: `W${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({ id: agentId, companyId, name: "Waker" });
  }

  async function insertWake(status: string, idempotencyKey: string) {
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      reason: "issue_commented",
      status,
      idempotencyKey,
    });
  }

  it.each([
    "queued",
    "deferred_issue_execution",
    "claimed",
    "coalesced",
    "completed",
    "dispatch_recovered",
  ])(
    "treats an accepted wake in state %s as a receipt",
    async (status) => {
      await seed();
      // Membership is decided by "was this delivery accepted?", not "did it
      // finish?". Every state here is reached only after the wake was honoured,
      // so a reclaimed comment effect that re-checked the key must find a
      // receipt and skip its non-idempotent wake sink.
      //
      // `claimed` (accepted, executing) and `coalesced` (accepted, merged into
      // a live run) are the two that were missing. `coalesced` is written with
      // this key AND the surviving runId, so the wake demonstrably happened —
      // it is a receipt, not a failure, and an earlier revision of this suite
      // wrongly asserted the opposite alongside `failed`.
      //
      // `dispatch_recovered` is the same class: the inline dispatch failed and
      // reconciliation re-delivered it, so a run exists for this key.
      await insertWake(status, `issue_comment:${status}:assignee:a1`);

      const receipt = await findWakeIdempotencyReceipt(db as never, {
        companyId,
        idempotencyKey: `issue_comment:${status}:assignee:a1`,
      });
      expect(receipt).not.toBeNull();
      expect(receipt!.status).toBe(status);
    },
    60_000,
  );

  it("treats a COMPLETED wake as a receipt, not just a pending one", async () => {
    await seed();
    // This is the property the comment-effect wake sink depends on. Live
    // coalescing stops matching once the run finishes, so a crash-recovery retry
    // that only asked "is a wake pending?" would wake a second time. The receipt
    // has to outlive the run it created.
    await insertWake("completed", "issue_comment:c1:assignee:a1");

    const receipt = await findWakeIdempotencyReceipt(db as never, {
      companyId,
      idempotencyKey: "issue_comment:c1:assignee:a1",
    });
    expect(receipt).not.toBeNull();
    expect(receipt!.status).toBe("completed");
  }, 60_000);

  it("does not treat an undelivered wake as a receipt", async () => {
    await seed();
    // A wake that never took effect must NOT suppress a retry, otherwise the
    // guard would convert a lost wake into a permanently missing one — a worse
    // failure than a duplicate. This is the boundary that keeps the receipt list
    // from being widened into a silent wake-suppressor.
    await insertWake("failed", "issue_comment:c2:assignee:a1");
    await insertWake("dispatch_failed", "issue_comment:c2b:assignee:a1");
    await insertWake("dispatch_failed_exhausted", "issue_comment:c2c:assignee:a1");

    for (const key of [
      "issue_comment:c2:assignee:a1",
      "issue_comment:c2b:assignee:a1",
      "issue_comment:c2c:assignee:a1",
    ]) {
      expect(await findWakeIdempotencyReceipt(db as never, {
        companyId,
        idempotencyKey: key,
      })).toBeNull();
    }
  }, 60_000);

  it("scopes receipts to the company and the exact key", async () => {
    await seed();
    await insertWake("queued", "issue_comment:c4:mention:a1");

    expect(await findWakeIdempotencyReceipt(db as never, {
      companyId,
      idempotencyKey: "issue_comment:c4:mention:a2",
    })).toBeNull();
    expect(await findWakeIdempotencyReceipt(db as never, {
      companyId: randomUUID(),
      idempotencyKey: "issue_comment:c4:mention:a1",
    })).toBeNull();
    expect(await findWakeIdempotencyReceipt(db as never, {
      companyId,
      idempotencyKey: "issue_comment:c4:mention:a1",
    })).not.toBeNull();
  }, 60_000);
});
