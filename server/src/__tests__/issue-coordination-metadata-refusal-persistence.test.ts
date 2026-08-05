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
});
