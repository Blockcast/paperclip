import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { companies, companyMemberships, createDb, issueRelations, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres blocked-by update route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue PATCH blockedByIssueIds persistence", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-blocked-by-routes-");
    db = createDb(tempDb.connectionString);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(companyId: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        userId: "cloud-user-1",
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "owner", status: "active" }],
        source: "cloud_tenant",
        isInstanceAdmin: true,
      };
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  let prefixCounter = 0;

  async function seedCompany() {
    const companyId = randomUUID();
    prefixCounter += 1;
    const prefix = `BB${prefixCounter}`;
    await db.insert(companies).values({
      id: companyId,
      name: `Blocked-by tenant ${prefixCounter}`,
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "cloud-user-1",
      membershipRole: "owner",
      status: "active",
    });
    return { companyId, prefix };
  }

  async function seedIssue(
    companyId: string,
    prefix: string,
    issueNumber: number,
    title: string,
    opts: { status?: string; assigneeAgentId?: string | null } = {},
  ) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      issueNumber,
      identifier: `${prefix}-${issueNumber}`,
      title,
      status: opts.status ?? "todo",
      priority: "medium",
      createdByUserId: "cloud-user-1",
      assigneeAgentId: opts.assigneeAgentId ?? null,
    });
    return issueId;
  }

  async function statusOf(issueId: string) {
    const row = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    return row?.status ?? null;
  }

  // The PATCH route runs its eager recompute inside a fire-and-forget
  // `void (async () => …)()` block, so a request that is *supposed* to leave an
  // issue `blocked` gives the test nothing to await. Sleeping a fixed 250ms and
  // then asserting is two separate bets: that the pass finished, and that the
  // wiring was live enough to have flipped the row had it been eligible. A
  // green test could mean either "correctly left blocked" or "recompute never
  // ran at all".
  //
  // So drive a control through the same machinery instead: close an unrelated
  // blocker whose dependent IS eligible and wait for that flip. The wait is a
  // positive signal, so it settles both bets — it proves the recompute path is
  // armed and working, and because the control request is issued strictly after
  // the request under test, its completion is a real happens-after barrier
  // rather than a guess at a safe duration.
  async function expectStillBlockedAfterLiveRecompute(
    app: express.Express,
    companyId: string,
    prefix: string,
    controlIssueNumber: number,
    issueId: string,
  ) {
    const controlBlocker = await seedIssue(companyId, prefix, controlIssueNumber, "Control blocker");
    const controlDependent = await seedIssue(
      companyId,
      prefix,
      controlIssueNumber + 1,
      "Control dependent",
      { status: "blocked" },
    );
    await db
      .insert(issueRelations)
      .values({ companyId, issueId: controlBlocker, relatedIssueId: controlDependent, type: "blocks" });

    const closed = await request(app).patch(`/api/issues/${controlBlocker}`).send({ status: "done" });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    await vi.waitFor(async () => {
      expect(await statusOf(controlDependent)).toBe("todo");
    });

    expect(await statusOf(issueId)).toBe("blocked");
  }

  it("persists blockedByIssueIds set via PATCH and surfaces both sides", async () => {
    const { companyId, prefix } = await seedCompany();
    const blockedId = await seedIssue(companyId, prefix, 1, "Blocked issue");
    const blockerId = await seedIssue(companyId, prefix, 2, "Blocker issue");
    const app = createApp(companyId);

    const res = await request(app)
      .patch(`/api/issues/${blockedId}`)
      .send({ blockedByIssueIds: [blockerId] });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.blockedBy?.map((r: { id: string }) => r.id)).toEqual([blockerId]);

    // The edge must exist in the DB.
    const rows = await db
      .select({ issueId: issueRelations.issueId, relatedIssueId: issueRelations.relatedIssueId })
      .from(issueRelations)
      .where(and(eq(issueRelations.companyId, companyId), eq(issueRelations.type, "blocks")));
    expect(rows).toEqual([{ issueId: blockerId, relatedIssueId: blockedId }]);

    // The other side's `blocks[]` must reflect it on read.
    const blockerRead = await request(app).get(`/api/issues/${blockerId}`);
    expect(blockerRead.status, JSON.stringify(blockerRead.body)).toBe(200);
    expect(blockerRead.body.blocks?.map((r: { id: string }) => r.id)).toEqual([blockedId]);

    const blockedRead = await request(app).get(`/api/issues/${blockedId}`);
    expect(blockedRead.body.blockedBy?.map((r: { id: string }) => r.id)).toEqual([blockerId]);
  });

  it("replacing blockedByIssueIds with a new array removes stale edges", async () => {
    const { companyId, prefix } = await seedCompany();
    const blockedId = await seedIssue(companyId, prefix, 10, "Blocked issue");
    const blockerA = await seedIssue(companyId, prefix, 11, "Blocker A");
    const blockerB = await seedIssue(companyId, prefix, 12, "Blocker B");
    const app = createApp(companyId);

    const first = await request(app)
      .patch(`/api/issues/${blockedId}`)
      .send({ blockedByIssueIds: [blockerA] });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.blockedBy?.map((r: { id: string }) => r.id)).toEqual([blockerA]);

    const second = await request(app)
      .patch(`/api/issues/${blockedId}`)
      .send({ blockedByIssueIds: [blockerB] });
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body.blockedBy?.map((r: { id: string }) => r.id)).toEqual([blockerB]);

    const rows = await db
      .select({ issueId: issueRelations.issueId })
      .from(issueRelations)
      .where(and(eq(issueRelations.companyId, companyId), eq(issueRelations.relatedIssueId, blockedId), eq(issueRelations.type, "blocks")));
    expect(rows.map((r) => r.issueId).sort()).toEqual([blockerB].sort());
  });

  it("clearing blockedByIssueIds with an empty array removes all edges", async () => {
    const { companyId, prefix } = await seedCompany();
    const blockedId = await seedIssue(companyId, prefix, 20, "Blocked issue");
    const blockerA = await seedIssue(companyId, prefix, 21, "Blocker A");
    const app = createApp(companyId);

    await request(app).patch(`/api/issues/${blockedId}`).send({ blockedByIssueIds: [blockerA] });
    const cleared = await request(app)
      .patch(`/api/issues/${blockedId}`)
      .send({ blockedByIssueIds: [] });
    expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
    expect(cleared.body.blockedBy).toEqual([]);

    const rows = await db
      .select({ issueId: issueRelations.issueId })
      .from(issueRelations)
      .where(and(eq(issueRelations.companyId, companyId), eq(issueRelations.relatedIssueId, blockedId), eq(issueRelations.type, "blocks")));
    expect(rows).toEqual([]);
  });

  it("rejects dependency cycles with 422", async () => {
    const { companyId, prefix } = await seedCompany();
    const issueA = await seedIssue(companyId, prefix, 30, "Issue A");
    const issueB = await seedIssue(companyId, prefix, 31, "Issue B");
    const app = createApp(companyId);

    const first = await request(app)
      .patch(`/api/issues/${issueA}`)
      .send({ blockedByIssueIds: [issueB] });
    expect(first.status, JSON.stringify(first.body)).toBe(200);

    const cycle = await request(app)
      .patch(`/api/issues/${issueB}`)
      .send({ blockedByIssueIds: [issueA] });
    expect(cycle.status, JSON.stringify(cycle.body)).toBe(422);
    expect(String(cycle.body.error ?? "")).toContain("Blocking relations cannot contain cycles");
  });

  // BLO-21523 phase 2: clearing an issue's last blocker must recompute
  // `status` eagerly, not just the relation edges. These three tests cover
  // each clearing path named in the issue's acceptance criteria.

  it("removing the last blockedByIssueIds edge flips a blocked issue to todo", async () => {
    const { companyId, prefix } = await seedCompany();
    const blockerA = await seedIssue(companyId, prefix, 40, "Blocker A");
    const blockedId = await seedIssue(companyId, prefix, 41, "Blocked issue", { status: "blocked" });
    const app = createApp(companyId);

    await db
      .insert(issueRelations)
      .values({ companyId, issueId: blockerA, relatedIssueId: blockedId, type: "blocks" });

    const cleared = await request(app)
      .patch(`/api/issues/${blockedId}`)
      .send({ blockedByIssueIds: [] });
    expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
    expect(cleared.body.blockedBy).toEqual([]);

    await vi.waitFor(async () => {
      expect(await statusOf(blockedId)).toBe("todo");
    });
  });

  it("a blocker closing done flips its dependent from blocked to todo", async () => {
    const { companyId, prefix } = await seedCompany();
    const blockerA = await seedIssue(companyId, prefix, 50, "Blocker A");
    const dependentId = await seedIssue(companyId, prefix, 51, "Dependent issue", { status: "blocked" });
    const app = createApp(companyId);

    await db
      .insert(issueRelations)
      .values({ companyId, issueId: blockerA, relatedIssueId: dependentId, type: "blocks" });

    const closed = await request(app).patch(`/api/issues/${blockerA}`).send({ status: "done" });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);

    await vi.waitFor(async () => {
      expect(await statusOf(dependentId)).toBe("todo");
    });
    const dependentRead = await request(app).get(`/api/issues/${dependentId}`);
    expect(dependentRead.body.blockedBy?.map((r: { id: string }) => r.id)).toEqual([blockerA]);
  });

  it("a blocker being cancelled leaves the dependent blocked (cancelled is not resolved)", async () => {
    const { companyId, prefix } = await seedCompany();
    const blockerA = await seedIssue(companyId, prefix, 60, "Blocker A");
    const dependentId = await seedIssue(companyId, prefix, 61, "Dependent issue", { status: "blocked" });
    const app = createApp(companyId);

    await db
      .insert(issueRelations)
      .values({ companyId, issueId: blockerA, relatedIssueId: dependentId, type: "blocks" });

    const cancelled = await request(app).patch(`/api/issues/${blockerA}`).send({ status: "cancelled" });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);

    // `becameDone` is false for a cancel, so no recompute is scheduled for this
    // dependent at all — the control is what proves that silence is the gate
    // holding rather than the machinery being dead.
    await expectStillBlockedAfterLiveRecompute(app, companyId, prefix, 62, dependentId);
  });

  // BLO-21523 phase 2 regression guard. The eager recompute must fire only on
  // a real blocker-edge write. An issue with no blocker edges is always
  // dependency-ready, so gating the recompute on the broader *wake* condition
  // (which also fires on a transition *into* blocked, and on reassignment)
  // would flip these rows straight back to `todo` — making `blocked`
  // unsettable via this route and contradicting the 200 the caller just got.
  // This is the dominant legitimate pattern: "blocked on a human / external
  // gate" carries no issue-to-issue edge by construction.

  it("setting status blocked on an issue with no blocker edges leaves it blocked", async () => {
    const { companyId, prefix } = await seedCompany();
    const issueId = await seedIssue(companyId, prefix, 70, "Blocked on a human gate");
    const app = createApp(companyId);

    const blocked = await request(app).patch(`/api/issues/${issueId}`).send({ status: "blocked" });
    expect(blocked.status, JSON.stringify(blocked.body)).toBe(200);
    expect(blocked.body.status).toBe("blocked");

    await expectStillBlockedAfterLiveRecompute(app, companyId, prefix, 71, issueId);
  });

  it("reassigning a blocked issue that has an unresolved blocker leaves it blocked", async () => {
    const { companyId, prefix } = await seedCompany();
    const blockerA = await seedIssue(companyId, prefix, 80, "Blocker A");
    const dependentId = await seedIssue(companyId, prefix, 81, "Dependent issue", { status: "blocked" });
    const app = createApp(companyId);

    await db
      .insert(issueRelations)
      .values({ companyId, issueId: blockerA, relatedIssueId: dependentId, type: "blocks" });

    const reassigned = await request(app)
      .patch(`/api/issues/${dependentId}`)
      .send({ assigneeAgentId: null });
    expect(reassigned.status, JSON.stringify(reassigned.body)).toBe(200);

    await expectStillBlockedAfterLiveRecompute(app, companyId, prefix, 82, dependentId);
  });

  // BLO-21523 phase 2. PATCH is not the only route that closes a blocker: an
  // approval-shaped comment on a pending execution-policy review stage moves
  // the issue to `done` through POST /issues/:id/comments, which carries its
  // own becameDone fan-out. Covering it end-to-end here — real db, real
  // recompute, no stubs — is what proves the dependent actually becomes
  // dispatchable rather than merely that the fan-out was called.
  it("a blocker closed by an approval comment flips its dependent from blocked to todo", async () => {
    const { companyId, prefix } = await seedCompany();
    const stageId = randomUUID();
    const participant = { type: "user" as const, userId: "cloud-user-1", agentId: null };
    const blockerId = randomUUID();
    await db.insert(issues).values({
      id: blockerId,
      companyId,
      issueNumber: 90,
      identifier: `${prefix}-90`,
      title: "Blocker awaiting approval",
      status: "in_review",
      priority: "medium",
      createdByUserId: "cloud-user-1",
      assigneeUserId: "cloud-user-1",
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [
          {
            id: stageId,
            type: "approval",
            approvalsNeeded: 1,
            participants: [{ id: randomUUID(), ...participant }],
          },
        ],
      },
      executionState: {
        status: "pending",
        currentStageId: stageId,
        currentStageIndex: 0,
        currentStageType: "approval",
        currentParticipant: participant,
        returnAssignee: participant,
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
        monitor: null,
      },
    });
    // Unassigned on purpose: no wake can reach this row, so only the status
    // recompute can make it dispatchable again.
    const dependentId = await seedIssue(companyId, prefix, 91, "Dependent issue", {
      status: "blocked",
      assigneeAgentId: null,
    });
    const app = createApp(companyId);

    await db
      .insert(issueRelations)
      .values({ companyId, issueId: blockerId, relatedIssueId: dependentId, type: "blocks" });

    const approved = await request(app)
      .post(`/api/issues/${blockerId}/comments`)
      .send({ body: "## Review: APPROVED\n\nShip it." });
    expect(approved.status, JSON.stringify(approved.body)).toBe(201);
    expect(await statusOf(blockerId)).toBe("done");

    await vi.waitFor(async () => {
      expect(await statusOf(dependentId)).toBe("todo");
    });
  });
});

