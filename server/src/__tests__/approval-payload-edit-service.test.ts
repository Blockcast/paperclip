/**
 * PEN-5766 — the queue-position guarantee, witnessed against a real database.
 *
 * The route tests next door pin the refusals. They cannot pin the property the
 * whole row is about, because a mocked service has no `created_at` and no row
 * order: it will happily report that an edit preserved a position that was never
 * computed.
 *
 * ## The requirement, and why `createdAt` alone does not establish it
 *
 * The row's stated requirement is "`createdAt` is NOT touched". An `UPDATE`
 * satisfies that trivially — which is exactly why asserting only it is not enough.
 * What the requirement is FOR is "the edit must not change queue position in either
 * direction", and `createdAt` is a proxy for that.
 *
 * ⚠️ The proxy was broken when this landed. `approvalService.list()` — the default
 * `full` view the board reads — carried NO `ORDER BY` at all, so Postgres returned
 * rows in heap order, and an `UPDATE` writes a new tuple version that relocates the
 * row within the heap. An edit therefore moved the card in the only listing a
 * reader actually sees, while `created_at` sat there unchanged and "proved" it had
 * not. So this file asserts the ORDERING, not just the column; `createdAt` is
 * checked too, but it is the weaker of the two.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { approvalPayloadRevisions, approvals, companies, createDb } from "@paperclipai/db";
import { approvalService } from "../services/approvals.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockAgentService = vi.hoisted(() => ({
  activatePendingApproval: vi.fn(),
  create: vi.fn(),
  terminate: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/agents.js", () => ({ agentService: vi.fn(() => mockAgentService) }));
vi.mock("../services/hire-hook.js", () => ({ notifyHireApproved: vi.fn() }));
vi.mock("../services/activity-log.js", () => ({ logActivity: mockLogActivity }));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

describeEmbeddedPostgres("approvalService.updatePayload", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-approval-payload-edit-");
    db = createDb(tempDb.connectionString);
  }, 120_000);

  beforeEach(() => {
    vi.clearAllMocks();
    mockLogActivity.mockResolvedValue(undefined);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const id = randomUUID();
    await db.insert(companies).values({
      id,
      name: `payload-edit-${id.slice(0, 8)}`,
      issuePrefix: `T${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    return id;
  }

  async function seedApproval(companyId: string, createdAt: Date, title: string) {
    const id = randomUUID();
    await db.insert(approvals).values({
      id,
      companyId,
      type: "request_board_approval",
      status: "pending",
      payload: { title },
      createdAt,
      updatedAt: createdAt,
    });
    return id;
  }

  const editor = { agentId: null, userId: null };

  it("preserves createdAt across an edit", async () => {
    const companyId = await seedCompany();
    const filedAt = new Date("2026-11-04T09:36:00.000Z");
    const id = await seedApproval(companyId, filedAt, "Fully green, open 6 days");

    const updated = await approvalService(db).updatePayload(
      id,
      { title: "5 red checks are the legacy refused arm; open 8 days" },
      editor,
    );

    expect(updated.createdAt.toISOString()).toBe(filedAt.toISOString());
    const [row] = await db.select().from(approvals).where(eq(approvals.id, id));
    expect(row.createdAt.toISOString()).toBe(filedAt.toISOString());
  }, 60_000);

  it("⭐ leaves the card's POSITION in the board queue unchanged", async () => {
    // The property the row actually argues for. Three cards, filed in order; the
    // MIDDLE one is edited. If an edit could move a card, this is where it shows:
    // under heap-order listing the edited row jumps to the end.
    const companyId = await seedCompany();
    const oldest = await seedApproval(companyId, new Date("2026-11-01T00:00:00.000Z"), "oldest");
    const middle = await seedApproval(companyId, new Date("2026-11-02T00:00:00.000Z"), "middle");
    const newest = await seedApproval(companyId, new Date("2026-11-03T00:00:00.000Z"), "newest");

    const svc = approvalService(db);
    const before = (await svc.list(companyId)).map((row) => row.id);
    expect(before).toEqual([oldest, middle, newest]);

    await svc.updatePayload(middle, { title: "middle, corrected" }, editor);

    const after = (await svc.list(companyId)).map((row) => row.id);
    expect(after).toEqual([oldest, middle, newest]);

    // And on the cheap view the duplicate-check path uses.
    const summary = (await svc.listSummary(companyId, {})).map((row) => row.id);
    expect(summary).toEqual([oldest, middle, newest]);
  }, 60_000);

  it("⭐ does NOT promote the edited card over cards that have waited longer", async () => {
    // The failure this row prices, stated as its own assertion: withdraw-and-refile
    // moved the corrected card to the head of a recency-skewed queue, taking
    // position from specific older cards. An edit must leave the older card first.
    const companyId = await seedCompany();
    const theirsOlder = await seedApproval(companyId, new Date("2026-10-28T00:00:00.000Z"), "someone else, waiting longer");
    const mineNewer = await seedApproval(companyId, new Date("2026-11-04T09:36:00.000Z"), "mine, stale evidence");

    const svc = approvalService(db);
    await svc.updatePayload(mineNewer, { title: "mine, corrected" }, editor);

    const order = (await svc.list(companyId)).map((row) => row.id);
    expect(order).toEqual([theirsOlder, mineNewer]);
  }, 60_000);

  it("archives the prior payload and stamps the edit marker", async () => {
    const companyId = await seedCompany();
    const id = await seedApproval(companyId, new Date("2026-11-04T09:36:00.000Z"), "Fully green");

    const svc = approvalService(db);
    const first = await svc.updatePayload(id, { title: "actually red" }, editor);
    expect(first.payloadRevision).toBe(1);
    expect(first.payloadEditedAt).not.toBeNull();
    expect(first.payload).toEqual({ title: "actually red" });

    const second = await svc.updatePayload(id, { title: "red, but the red is the refused legacy arm" }, editor);
    expect(second.payloadRevision).toBe(2);

    const revisions = await svc.listPayloadRevisions(id);
    expect(revisions.map((r) => r.revision)).toEqual([0, 1]);
    // Each archived row holds the payload as it stood BEFORE the edit that
    // superseded it — never a second copy of the live one.
    expect(revisions[0].payload).toEqual({ title: "Fully green" });
    expect(revisions[1].payload).toEqual({ title: "actually red" });
  }, 60_000);

  it("refuses to edit a card that is no longer pending, and writes no revision row", async () => {
    const companyId = await seedCompany();
    const id = await seedApproval(companyId, new Date("2026-11-04T09:36:00.000Z"), "filed");
    await db.update(approvals).set({ status: "approved" }).where(eq(approvals.id, id));

    await expect(
      approvalService(db).updatePayload(id, { title: "too late" }, editor),
    ).rejects.toMatchObject({ status: 409 });

    // The archive is written before the guarded UPDATE, so a refusal that rolled
    // back correctly leaves no orphan revision claiming an edit that never happened.
    const revisions = await db
      .select()
      .from(approvalPayloadRevisions)
      .where(eq(approvalPayloadRevisions.approvalId, id));
    expect(revisions).toHaveLength(0);
  }, 60_000);

  it("leaves status, requester and decision fields untouched by an edit", async () => {
    const companyId = await seedCompany();
    const id = await seedApproval(companyId, new Date("2026-11-04T09:36:00.000Z"), "filed");

    const updated = await approvalService(db).updatePayload(id, { title: "corrected" }, editor);

    expect(updated.status).toBe("pending");
    expect(updated.decidedAt).toBeNull();
    expect(updated.decidedByUserId).toBeNull();
    expect(updated.decisionNote).toBeNull();
  }, 60_000);
});
