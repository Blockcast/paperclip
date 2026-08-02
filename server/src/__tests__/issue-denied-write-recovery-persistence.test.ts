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
  issueComments,
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
    `Skipping embedded Postgres denied-write recovery tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

// BLO-18614 AC3 keeps a denied write's payload recoverable, which means an
// unauthorized actor can cause a write it is not otherwise allowed to make. The
// aggregate cap is the only thing bounding that, so it has to hold against the
// real database rather than against a sequential in-process harness: the
// previous check-then-insert shape passed a sequential test while remaining a
// straightforward race in production.
const DENIED_WRITE_AGGREGATE_MAX_RECORDS = 5;

describeEmbeddedPostgres("denied issue write recovery records (persistence path)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-denied-write-recovery-");
    db = createDb(tempDb.connectionString);
  });

  afterEach(async () => {
    await db.delete(issueComments);
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

  function createApp(actor: Express.Request["actor"], routeDb: typeof db = db) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", issueRoutes(routeDb, {} as any));
    app.use(errorHandler);
    return app;
  }

  // An issue assigned to someone else, approached by an agent that neither owns
  // it nor created it: the plain `deny_missing_grant` boundary denial this
  // issue was filed about.
  async function seedDeniedActorAgainstForeignIssue() {
    const companyId = randomUUID();
    const assigneeAgentId = randomUUID();
    const outsiderAgentId = randomUUID();
    const outsiderRunId = randomUUID();
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
        id: outsiderAgentId,
        companyId,
        name: "Outsider",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(heartbeatRuns).values({
      id: outsiderRunId,
      companyId,
      agentId: outsiderAgentId,
      status: "running",
      invocationSource: "manual",
      startedAt: new Date(),
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Owned by someone else",
      status: "in_progress",
      priority: "high",
      assigneeAgentId,
    });

    return { companyId, assigneeAgentId, outsiderAgentId, outsiderRunId, issueId };
  }

  function agentActor(companyId: string, agentId: string, runId: string): Express.Request["actor"] {
    return { type: "agent", agentId, companyId, runId, source: "agent_jwt" };
  }

  async function deniedWriteRows(companyId: string) {
    return db
      .select({ id: activityLog.id, details: activityLog.details })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.action, "issue_write_denied"),
      ));
  }

  it("holds the aggregate cap when varied denials race in parallel", async () => {
    const { companyId, outsiderAgentId, outsiderRunId, issueId } =
      await seedDeniedActorAgainstForeignIssue();
    const app = createApp(agentActor(companyId, outsiderAgentId, outsiderRunId));

    // Distinct bodies so exact-repeat dedupe cannot be what bounds this — the
    // aggregate cap has to be the thing doing the work. Fired together so they
    // interleave on separate pooled connections, which is what the previous
    // sequential harness never did.
    const attempts = 12;
    const responses = await Promise.all(
      Array.from({ length: attempts }, (_, index) =>
        request(app)
          .post(`/api/issues/${issueId}/comments`)
          .send({ body: `parallel denied diagnosis ${index}` }),
      ),
    );
    for (const res of responses) {
      expect(res.status, JSON.stringify(res.body)).toBe(403);
    }

    const rows = await deniedWriteRows(companyId);
    expect(
      rows.length,
      `parallel denials must not exceed the aggregate cap; recorded ${rows.length} of ${attempts}`,
    ).toBeLessThanOrEqual(DENIED_WRITE_AGGREGATE_MAX_RECORDS);
    // Recording must still happen — a cap that holds by recording nothing would
    // satisfy the bound while defeating AC3.
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const details = row.details as Record<string, unknown>;
      expect(details.attemptedAction).toBe("issue:comment");
      expect(details.quarantined).toBe(true);
    }
  });

  it("records nothing when the aggregate bound cannot be enforced", async () => {
    const { companyId, outsiderAgentId, outsiderRunId, issueId } =
      await seedDeniedActorAgainstForeignIssue();

    // Fail the admission transaction the way an unhealthy database would. The
    // old shape caught this and inserted anyway, so a persistent lookup failure
    // removed the bound entirely; recovery telemetry is optional, so the
    // correct answer is to drop the record.
    const failingDb = new Proxy(db, {
      get(target, property, receiver) {
        if (property === "transaction") {
          return async () => {
            throw new Error("simulated aggregate bound lookup failure");
          };
        }
        return Reflect.get(target, property, receiver);
      },
    }) as typeof db;

    const res = await request(createApp(agentActor(companyId, outsiderAgentId, outsiderRunId), failingDb))
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "denied diagnosis while the bound is unavailable" });

    // The denial itself must still be reported; only the optional record drops.
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(await deniedWriteRows(companyId)).toHaveLength(0);
  });
});
