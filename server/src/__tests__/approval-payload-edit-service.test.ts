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
import { approvalPayloadRevisions, approvals, companies, createDb, issueApprovals, issues } from "@paperclipai/db";
import { approvalService } from "../services/approvals.js";
import { issueApprovalService } from "../services/issue-approvals.js";
import { approvalGatesEquivalent } from "../services/approval-gate-reconciler.js";
import {
  asStoredGate,
  JSONB_GATE_KEY_ORDER,
  LIVE_GATE,
} from "./helpers/approval-gate-fixtures.js";
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

  /**
   * ⭐ PEN-6107 — the edit marker has to reach the CHEAP view, which is the one a
   * queue read is built from and the one the API's own tool description steers
   * callers toward.
   *
   * Disclosure is the ENTIRE safety case for an editable payload: prevention (an
   * `expectedPayloadRevision` interlock on the decision routes) was priced and
   * deliberately deferred, so there is nothing behind this. A marker absent from the
   * surface a decider scans is not a partial mitigation; on that surface it is none.
   *
   * ⚠️ This asserts KEY PRESENCE, not just the value, and that is the point. An
   * absent key and an unedited `0` are indistinguishable through `jq` and through JS
   * property access, so a projection that silently dropped the column again would
   * read to every caller as "this card was never edited" — the exact misread the
   * marker exists to remove, in the one direction that is unsafe.
   */
  it("⭐ reports the edit marker on the summary view, by key presence", async () => {
    const companyId = await seedCompany();
    const untouched = await seedApproval(companyId, new Date("2026-11-01T00:00:00.000Z"), "never edited");
    const edited = await seedApproval(companyId, new Date("2026-11-02T00:00:00.000Z"), "stale evidence");

    const svc = approvalService(db);
    await svc.updatePayload(edited, { title: "corrected in place" }, editor);

    const rows = await svc.listSummary(companyId, {});
    const editedRow = rows.find((row) => row.id === edited);
    const untouchedRow = rows.find((row) => row.id === untouched);

    // Present on BOTH rows. The unedited card has to carry the keys too, or a
    // caller cannot tell "this server reports edit state and this card is clean"
    // from "this server does not report edit state at all".
    expect(editedRow).toHaveProperty("payloadRevision");
    expect(editedRow).toHaveProperty("payloadEditedAt");
    expect(untouchedRow).toHaveProperty("payloadRevision");
    expect(untouchedRow).toHaveProperty("payloadEditedAt");

    expect(editedRow?.payloadRevision).toBe(1);
    expect(editedRow?.payloadEditedAt).not.toBeNull();
    expect(untouchedRow?.payloadRevision).toBe(0);
    expect(untouchedRow?.payloadEditedAt).toBeNull();

    // And the cheap view stays cheap — the marker is two scalar columns, not a
    // relaxation of the payload omission that is the whole reason `summary` exists.
    expect(editedRow).not.toHaveProperty("payload");
  }, 60_000);

  /**
   * ⭐ PEN-6107, the same invariant on the OTHER decision surface — the one the
   * summary test above cannot reach (Ally, PR 3550).
   *
   * `GET /issues/:id/approvals` is what `ApprovalCard` renders from on `IssueDetail`
   * and in `CommentThread`: the card that carries the working Approve and Reject
   * buttons, and the surface `paperclipListIssueApprovals` reads. It has its own
   * explicit column set in a different service, so fixing `listSummary` does nothing
   * for it, and nothing fails when it falls behind — `payloadRevision` is declared
   * non-optional on the shared type, so the compiler cannot see the omission, and an
   * absent key reads to the client exactly like an unedited `0`.
   *
   * ⚠️ The sibling suite structurally cannot hold this. `issue-approvals-service.test.ts`
   * mocks `db.select`, so it spreads whatever the fixture supplies and reports the
   * keys present however the projection is written. The defect lives in the column
   * set the mock bypasses, so this assertion only means anything through a real
   * database.
   */
  it("⭐ reports the edit marker on the issue-linked view, by key presence", async () => {
    const companyId = await seedCompany();
    const untouched = await seedApproval(companyId, new Date("2026-11-01T00:00:00.000Z"), "never edited");
    const edited = await seedApproval(companyId, new Date("2026-11-02T00:00:00.000Z"), "stale evidence");

    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Decide the card from the issue page",
      status: "in_progress",
      priority: "medium",
    });
    await db.insert(issueApprovals).values([
      { companyId, issueId, approvalId: untouched },
      { companyId, issueId, approvalId: edited },
    ]);

    await approvalService(db).updatePayload(edited, { title: "corrected in place" }, editor);

    const rows = await issueApprovalService(db).listApprovalsForIssue(issueId);
    const editedRow = rows.find((row) => row.id === edited);
    const untouchedRow = rows.find((row) => row.id === untouched);

    // Present on BOTH rows, for the same reason the summary test checks both: a
    // caller cannot tell "reported clean" from "not reported at all" by value.
    expect(editedRow).toHaveProperty("payloadRevision");
    expect(editedRow).toHaveProperty("payloadEditedAt");
    expect(untouchedRow).toHaveProperty("payloadRevision");
    expect(untouchedRow).toHaveProperty("payloadEditedAt");

    expect(editedRow?.payloadRevision).toBe(1);
    expect(editedRow?.payloadEditedAt).not.toBeNull();
    expect(untouchedRow?.payloadRevision).toBe(0);
    expect(untouchedRow?.payloadEditedAt).toBeNull();

    // Unlike `summary`, this view does carry the payload — and the redaction
    // projection it runs every row through still applies.
    expect(editedRow).toHaveProperty("payload");
    expect(editedRow?.payload).toEqual({ title: "corrected in place" });
  }, 60_000);
  /**
   * ⭐ The review finding this suite existed to be unable to catch (Ally, PR 3456).
   *
   * The gate-immutability guard in `routes/approvals.ts` used to compare the stored
   * gate with the submitted one using `JSON.stringify`, which is key-order
   * sensitive. `payload` is jsonb and Postgres does not keep key order in jsonb, so
   * the two sides come back in DIFFERENT orders and the strings never match: every
   * edit to a gated card was refused `approval_payload_gate_immutable`, and the
   * refusal printed a `storedGate` and a `submittedGate` with identical contents.
   * Gated cards are the merge and deploy asks the route exists to serve.
   *
   * The route suite could not see it — its service is mocked, so its stored gate
   * was a JS literal in shape order, which no stored card can ever be in. This is
   * the test that goes through the column.
   */
  it("⭐ a gate survives a jsonb round-trip REORDERED, and the guard still calls it unchanged", async () => {
    const companyId = await seedCompany();
    const id = randomUUID();
    await db.insert(approvals).values({
      id,
      companyId,
      type: "request_board_approval",
      status: "pending",
      payload: { title: "merge #2958", gate: LIVE_GATE },
      createdAt: new Date("2026-11-04T09:36:00.000Z"),
      updatedAt: new Date("2026-11-04T09:36:00.000Z"),
    });

    const stored = await approvalService(db).getById(id);
    const storedGate = (stored!.payload as Record<string, unknown>).gate as Record<string, unknown>;

    // 1. The mechanism, measured rather than assumed. If Postgres ever stops doing
    //    this, THIS is the assertion that should fail — and `JSONB_GATE_KEY_ORDER`
    //    is what the route suite's fixture is built from, so the two stay in step.
    expect(Object.keys(storedGate)).toEqual(JSONB_GATE_KEY_ORDER);
    expect(Object.keys(storedGate)).not.toEqual(Object.keys(LIVE_GATE));
    expect(asStoredGate(LIVE_GATE)).toEqual(storedGate);

    // 2. The defect, pinned exactly: the old textual comparison called a resent
    //    identical gate "changed".
    expect(JSON.stringify(storedGate)).not.toBe(JSON.stringify(LIVE_GATE));

    // 3. The fix: same data, so the guard must let it through — while still
    //    refusing a gate that genuinely names a different pull request.
    expect(approvalGatesEquivalent(LIVE_GATE, storedGate)).toBe(true);
    expect(approvalGatesEquivalent({ ...LIVE_GATE, prNumber: 9999 }, storedGate)).toBe(false);
    expect(approvalGatesEquivalent(null, storedGate)).toBe(false);

    // 4. And end to end: the edit the route would now forward actually lands,
    //    carrying the gate unchanged.
    const updated = await approvalService(db).updatePayload(
      id,
      { title: "merge #2958 — 5 red checks are the refused legacy arm", gate: LIVE_GATE },
      editor,
    );
    expect(updated.payloadRevision).toBe(1);
    expect((updated.payload as Record<string, unknown>).gate).toEqual(LIVE_GATE);
  }, 60_000);

  /**
   * The archive INSERT runs before the guarded UPDATE, so the LOSER of two
   * concurrent edits at the same revision never reaches that guard: it blocks on
   * `approval_payload_revisions_approval_revision_unique_idx` and fails `23505`.
   * `23505` is not a transient SQLSTATE, so unhandled it reached the caller as a
   * bare 500 — "the server is broken" instead of "re-read the card and retry"
   * (Ally, PR 3456).
   *
   * Simulated deterministically by pre-claiming the revision-0 archive row, which
   * is exactly the state the loser's stale read leaves it in. A timing-dependent
   * version of this cannot be made to fail reliably.
   */
  it("reports a lost archive race as a 409, not as a 500", async () => {
    const companyId = await seedCompany();
    const id = await seedApproval(companyId, new Date("2026-11-04T09:36:00.000Z"), "Fully green");

    await db.insert(approvalPayloadRevisions).values({
      companyId,
      approvalId: id,
      revision: 0,
      payload: { title: "claimed by the edit that won the race" },
      editedByAgentId: null,
      editedByUserId: null,
    });

    await expect(
      approvalService(db).updatePayload(id, { title: "corrected" }, editor),
    ).rejects.toMatchObject({ status: 409 });

    // The refusal rolled back: no second archive row, and the card is untouched.
    const revisions = await db
      .select()
      .from(approvalPayloadRevisions)
      .where(eq(approvalPayloadRevisions.approvalId, id));
    expect(revisions).toHaveLength(1);
    const [row] = await db.select().from(approvals).where(eq(approvals.id, id));
    expect(row.payloadRevision).toBe(0);
    expect(row.payload).toEqual({ title: "Fully green" });
  }, 60_000);

  it("never surfaces a raw unique-violation from two genuinely concurrent edits", async () => {
    // Both orderings are legitimate — if the second transaction reads after the
    // first commits it simply edits revision 1 — so this asserts the only thing
    // that is true either way: nothing escapes as an unmapped 5xx.
    const companyId = await seedCompany();
    const id = await seedApproval(companyId, new Date("2026-11-04T09:36:00.000Z"), "Fully green");

    const svc = approvalService(db);
    const results = await Promise.allSettled([
      svc.updatePayload(id, { title: "corrected by A" }, editor),
      svc.updatePayload(id, { title: "corrected by B" }, editor),
    ]);

    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
    for (const result of results) {
      if (result.status === "rejected") {
        expect(result.reason).toMatchObject({ status: 409 });
      }
    }
  }, 60_000);
});
