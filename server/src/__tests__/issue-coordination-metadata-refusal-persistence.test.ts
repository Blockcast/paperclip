import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueRelations,
  issues,
} from "@paperclipai/db";
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
    `Skipping embedded Postgres coordination-refusal tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

// BLO-19912, Ally review of be5cd310d finding 1. Refusal admission was an
// unlocked check-then-insert, which bounds nothing under concurrency: every
// racing request misses the probe and every one inserts. That shape passes any
// sequential harness while remaining a plain race in production, so — exactly
// as BLO-18614 concluded for `issue_write_denied` — the bound has to be proven
// against a real database with requests genuinely in flight together.
//
// Ally's review of 5d985942b then showed the lock alone is not enough: `runId`
// is part of the signature and is actor-churnable, so sequential distinct
// signatures needed an aggregate cap too. Keep this mirrored with
// COORDINATION_METADATA_REFUSAL_AGGREGATE_MAX_RECORDS in the route.
const COORDINATION_REFUSAL_AGGREGATE_MAX_RECORDS = 5;

describeEmbeddedPostgres("coordination-metadata refusal records (persistence path)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-coordination-refusal-");
    db = createDb(tempDb.connectionString);
  });

  afterEach(async () => {
    await db.delete(issueRelations);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(actor: Express.Request["actor"]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  function agentActor(companyId: string, agentId: string, runId: string): Express.Request["actor"] {
    return { type: "agent", agentId, companyId, runId, source: "agent_jwt" };
  }

  async function refusalRows(companyId: string) {
    return db
      .select({ id: activityLog.id, details: activityLog.details })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.action, "issue.coordination_metadata_refused"),
      ));
  }

  // An agent holding no `tasks:assign` grant, against an issue assigned to
  // someone else: the coordination gate is reached and refuses with
  // `authorization_denied`, which is the refusal an unprivileged actor can
  // drive on demand and therefore the one whose row count must be bounded.
  async function seedCoordinatorRefusedOnForeignIssue() {
    const companyId = randomUUID();
    const assigneeAgentId = randomUUID();
    const coordinatorAgentId = randomUUID();
    const coordinatorRunId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: assigneeAgentId,
        companyId,
        name: "Assignee",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: coordinatorAgentId,
        companyId,
        name: "Coordinator",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(heartbeatRuns).values({
      id: coordinatorRunId,
      companyId,
      agentId: coordinatorAgentId,
      status: "running",
      invocationSource: "manual",
      startedAt: new Date(),
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Owned by someone else",
      status: "todo",
      priority: "high",
      assigneeAgentId,
    });

    return { companyId, assigneeAgentId, coordinatorAgentId, coordinatorRunId, issueId };
  }

  it("collapses parallel identical refusals to one row", async () => {
    const { companyId, coordinatorAgentId, coordinatorRunId, issueId } =
      await seedCoordinatorRefusedOnForeignIssue();
    const app = createApp(agentActor(companyId, coordinatorAgentId, coordinatorRunId));

    // One refusal retried, not eight. Fired together so they interleave on
    // separate pooled connections and all miss any unlocked probe — the
    // condition under which the pre-fix shape wrote eight rows.
    const repeats = 8;
    const responses = await Promise.all(
      Array.from({ length: repeats }, () =>
        request(app)
          .patch(`/api/issues/${issueId}`)
          .send({ priority: "low" }),
      ),
    );
    for (const res of responses) {
      expect(res.status, JSON.stringify(res.body)).toBe(403);
    }

    const rows = await refusalRows(companyId);
    expect(
      rows.length,
      `an identical refusal retried is one piece of evidence; got ${rows.length} rows`,
    ).toBe(1);
    const details = rows[0]?.details as Record<string, unknown>;
    expect(details.path).toBe("coordination_metadata_allowlist");
    expect(details.outcome).toBe("refused");
    expect(details.refusalReason).toBe("authorization_denied");
    expect(details.fields).toEqual(["priority"]);
  });

  // Ally review of be5cd310d finding 2: the first signature was
  // (reason, fields) only, so materially different refusals collapsed into each
  // other. Distinct attempted field sets are distinct evidence and must each
  // survive the window.
  it("keeps refusals with different attempted fields distinct", async () => {
    const { companyId, coordinatorAgentId, coordinatorRunId, issueId } =
      await seedCoordinatorRefusedOnForeignIssue();
    const app = createApp(agentActor(companyId, coordinatorAgentId, coordinatorRunId));

    const bodies = [
      { priority: "low" },
      { priority: "low", parentId: null },
      { milestoneId: null },
    ];
    for (const body of bodies) {
      const res = await request(app).patch(`/api/issues/${issueId}`).send(body);
      expect(res.status, JSON.stringify(res.body)).toBe(403);
    }

    const signatures = new Set(
      (await refusalRows(companyId)).map((row) => (row.details as Record<string, unknown>).refusalSignature),
    );
    expect(
      signatures.size,
      "each distinct attempted field set is separate evidence and must record its own row",
    ).toBe(bodies.length);
  });

  // The record is optional telemetry on a decision already made, so a database
  // fault must cost the record and nothing else: the refusal itself still has
  // to be reported to the caller.
  it("still refuses the patch when the refusal record cannot be written", async () => {
    const { companyId, coordinatorAgentId, coordinatorRunId, issueId } =
      await seedCoordinatorRefusedOnForeignIssue();
    await db.execute("alter table activity_log rename to activity_log_hidden");
    try {
      const res = await request(createApp(agentActor(companyId, coordinatorAgentId, coordinatorRunId)))
        .patch(`/api/issues/${issueId}`)
        .send({ priority: "low" });

      expect(res.status, JSON.stringify(res.body)).toBe(403);
    } finally {
      await db.execute("alter table activity_log_hidden rename to activity_log");
    }

    expect(await refusalRows(companyId)).toHaveLength(0);
  });

  // Ally review of 5d985942b finding 1. `runId` is part of the signature and is
  // actor-churnable: under agent-API-key auth the run header is validated only
  // as *a* run belonging to that agent, so cycling historical run ids mints a
  // fresh signature per request. The advisory lock bounds concurrent
  // duplicates and does nothing about that, so the aggregate cap has to.
  it("bounds an actor churning historical run ids to mint fresh signatures", async () => {
    const { companyId, coordinatorAgentId, coordinatorRunId, issueId } =
      await seedCoordinatorRefusedOnForeignIssue();

    // Every one of these is a real run owned by this agent, so every one would
    // pass the header's ownership check and produce a distinct signature.
    const churnedRunIds = [coordinatorRunId];
    for (let index = 0; index < 11; index += 1) {
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId: coordinatorAgentId,
        status: "completed",
        invocationSource: "manual",
        startedAt: new Date(),
      });
      churnedRunIds.push(runId);
    }

    for (const runId of churnedRunIds) {
      const res = await request(createApp(agentActor(companyId, coordinatorAgentId, runId)))
        .patch(`/api/issues/${issueId}`)
        .send({ priority: "low" });
      expect(res.status, JSON.stringify(res.body)).toBe(403);
    }

    const rows = await refusalRows(companyId);
    expect(
      rows.length,
      `run-id churn must not amplify writes past the cap; got ${rows.length} rows from ${churnedRunIds.length} attempts`,
    ).toBe(COORDINATION_REFUSAL_AGGREGATE_MAX_RECORDS);
  });

  // Ally review of 5d985942b finding 2. The coordination decision is
  // assignment-sensitive, so an otherwise identical denial after a reassignment
  // is new evidence: suppressing it leaves the trail asserting ownership that
  // has already changed.
  it("keeps a repeated refusal that follows a reassignment", async () => {
    const { companyId, coordinatorAgentId, coordinatorRunId, issueId } =
      await seedCoordinatorRefusedOnForeignIssue();
    const app = createApp(agentActor(companyId, coordinatorAgentId, coordinatorRunId));
    const nextAssigneeAgentId = randomUUID();
    await db.insert(agents).values({
      id: nextAssigneeAgentId,
      companyId,
      name: "Next assignee",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const before = await request(app).patch(`/api/issues/${issueId}`).send({ priority: "low" });
    expect(before.status, JSON.stringify(before.body)).toBe(403);

    await db.update(issues).set({ assigneeAgentId: nextAssigneeAgentId }).where(eq(issues.id, issueId));

    const after = await request(app).patch(`/api/issues/${issueId}`).send({ priority: "low" });
    expect(after.status, JSON.stringify(after.body)).toBe(403);

    const assignees = (await refusalRows(companyId))
      .map((row) => (row.details as Record<string, unknown>).assigneeAgentId);
    expect(
      assignees.length,
      "a refusal after reassignment is new evidence and must not collapse onto the previous owner's row",
    ).toBe(2);
    expect(new Set(assignees).size).toBe(2);
  });

  // Ally review of cd1ecd253 finding 1. The reassignment test above only proves
  // a transition survives while the bucket has room. The cap is the harder
  // case: five cheap authorization denials — which an unprivileged actor can
  // drive on demand by churning run ids — must not be able to exhaust the
  // budget and then swallow the execution-lock refusal, which is the
  // highest-value record this whole gate exists to emit. Scoping the cap per
  // (assignee, holding run) epoch is what keeps that transition observable.
  it("records the execution-lock transition after denials saturate the bucket", async () => {
    const { companyId, assigneeAgentId, coordinatorAgentId, coordinatorRunId, issueId } =
      await seedCoordinatorRefusedOnForeignIssue();

    // Saturate the lock-free epoch with distinct signatures, exactly as the
    // churn test does, so the pre-fix single bucket is genuinely full.
    const churnedRunIds = [coordinatorRunId];
    for (let index = 0; index < 11; index += 1) {
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId: coordinatorAgentId,
        status: "completed",
        invocationSource: "manual",
        startedAt: new Date(),
      });
      churnedRunIds.push(runId);
    }
    for (const runId of churnedRunIds) {
      const res = await request(createApp(agentActor(companyId, coordinatorAgentId, runId)))
        .patch(`/api/issues/${issueId}`)
        .send({ priority: "low" });
      expect(res.status, JSON.stringify(res.body)).toBe(403);
    }
    const saturated = await refusalRows(companyId);
    expect(
      saturated.length,
      "precondition: the lock-free epoch must be at the cap before the transition",
    ).toBe(COORDINATION_REFUSAL_AGGREGATE_MAX_RECORDS);
    expect(saturated.every((row) =>
      (row.details as Record<string, unknown>).refusalReason === "authorization_denied"
    )).toBe(true);

    // The assignee's run takes the execution lock: a new epoch, and the point
    // at which a coordination rebind starts being able to strand a live run.
    const holdingRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: holdingRunId,
      companyId,
      agentId: assigneeAgentId,
      status: "running",
      invocationSource: "manual",
      startedAt: new Date(),
    });
    await db.update(issues).set({ executionRunId: holdingRunId }).where(eq(issues.id, issueId));

    // `parentId` is execution-sensitive, so this is the refusal kind that says
    // someone tried to rebind execution context out from under a running agent.
    const rebind = await request(createApp(agentActor(companyId, coordinatorAgentId, coordinatorRunId)))
      .patch(`/api/issues/${issueId}`)
      .send({ parentId: null });
    expect(rebind.status, JSON.stringify(rebind.body)).toBe(403);

    const lockRows = (await refusalRows(companyId)).filter((row) =>
      (row.details as Record<string, unknown>).refusalReason === "execution_lock"
    );
    expect(
      lockRows.length,
      "a saturated denial bucket must not swallow the first execution-lock refusal",
    ).toBe(1);
    const details = lockRows[0]?.details as Record<string, unknown>;
    expect(details.executionRunId).toBe(holdingRunId);
    expect(details.blockedFields).toEqual(["parentId"]);
    expect(
      details.refusalEpoch,
      "the transition is recorded because the holding run opens a fresh epoch",
    ).toBe(`assignee=${assigneeAgentId}|lock=${holdingRunId}`);
  });

  // Ally review of cd1ecd253 finding 2. `logActivity` runs details through
  // `sanitizeRecord`, whose secret-key matcher treats any key *containing*
  // "authorization" as credential material, so the original
  // `authorizationReason` key persisted as `***REDACTED***` — the row kept
  // every field except the one saying why the refusal happened. Asserting the
  // exact persisted value is the only thing that catches this: the write
  // succeeds, the key is present, and only its value is destroyed.
  it("persists the boundary denial reason rather than redacting it", async () => {
    const { companyId, coordinatorAgentId, coordinatorRunId, issueId } =
      await seedCoordinatorRefusedOnForeignIssue();

    const res = await request(createApp(agentActor(companyId, coordinatorAgentId, coordinatorRunId)))
      .patch(`/api/issues/${issueId}`)
      .send({ priority: "low" });
    expect(res.status, JSON.stringify(res.body)).toBe(403);

    const rows = await refusalRows(companyId);
    expect(rows).toHaveLength(1);
    const details = rows[0]?.details as Record<string, unknown>;
    expect(details.refusalReason).toBe("authorization_denied");
    // `deny_scope`, not `deny_missing_grant`: this coordinator holds no
    // `tasks:assign` grant at all, so the real service turns it away on the
    // scope check before grant evaluation. The mocked unit test stubs the
    // decision and so cannot observe which reason the route actually records —
    // another thing only the real-Postgres path can pin.
    expect(
      details.boundaryReason,
      "the denial enum is not a secret and must survive activity-log sanitization intact",
    ).toBe("deny_scope");
    expect(details.boundaryReason).not.toBe("***REDACTED***");
    // The redacting key must be gone, not merely shadowed by the new one.
    expect(details).not.toHaveProperty("authorizationReason");
  });
});
