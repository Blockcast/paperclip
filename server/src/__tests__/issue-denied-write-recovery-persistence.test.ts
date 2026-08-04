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
import { subscribeCompanyLiveEvents } from "../services/live-events.js";

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

  // Subscribes to `activity.logged` for the denial action and, at the moment
  // each event fires, kicks off a read on a pooled connection outside the
  // recording transaction. That read is what distinguishes "published after
  // commit" from "published from inside the transaction": only the former can
  // see the row.
  function captureDeniedWriteEvents(companyId: string) {
    const seen: { rowsVisibleAtPublish: Promise<number> }[] = [];
    const unsubscribe = subscribeCompanyLiveEvents(companyId, (event) => {
      if (event.type !== "activity.logged") return;
      const payload = event.payload as Record<string, unknown>;
      if (payload.action !== "issue_write_denied") return;
      seen.push({
        rowsVisibleAtPublish: deniedWriteRows(companyId).then((rows) => rows.length),
      });
    });
    return { seen, stop: unsubscribe };
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

  // Ally structural review of d543156c6, finding 2. The exact-repeat probe ran
  // before the advisory lock, so identical concurrent attempts all missed it,
  // then serialized behind the lock and each inserted. One repeated denial
  // could therefore consume the entire aggregate budget and suppress the later,
  // genuinely distinct recovery evidence AC3 exists to preserve.
  it("collapses parallel identical denials to one row and leaves capacity for distinct evidence", async () => {
    const { companyId, outsiderAgentId, outsiderRunId, issueId } =
      await seedDeniedActorAgainstForeignIssue();
    const app = createApp(agentActor(companyId, outsiderAgentId, outsiderRunId));

    // Byte-identical bodies from one actor/run: a single piece of evidence
    // retried, not five. Fired together so they interleave on separate pooled
    // connections and all miss the unlocked probe.
    const repeats = 8;
    const repeatedBody = "identical denied diagnosis";
    const repeatResponses = await Promise.all(
      Array.from({ length: repeats }, () =>
        request(app)
          .post(`/api/issues/${issueId}/comments`)
          .send({ body: repeatedBody }),
      ),
    );
    for (const res of repeatResponses) {
      expect(res.status, JSON.stringify(res.body)).toBe(403);
    }

    expect(
      (await deniedWriteRows(companyId)).length,
      "an exact repeat is one piece of evidence and must record exactly one row",
    ).toBe(1);

    // The point of collapsing the burst: the remaining budget still admits new
    // evidence. Against the pre-fix shape the repeats had already filled all
    // five slots, so every one of these was silently dropped.
    const distinct = DENIED_WRITE_AGGREGATE_MAX_RECORDS - 1;
    for (let index = 0; index < distinct; index += 1) {
      const res = await request(app)
        .post(`/api/issues/${issueId}/comments`)
        .send({ body: `distinct denied diagnosis ${index}` });
      expect(res.status, JSON.stringify(res.body)).toBe(403);
    }

    const rows = await deniedWriteRows(companyId);
    expect(
      rows.length,
      `distinct evidence after an identical burst must still record; got ${rows.length}`,
    ).toBe(DENIED_WRITE_AGGREGATE_MAX_RECORDS);
    for (const row of rows) {
      const details = row.details as Record<string, unknown>;
      expect(details.attemptedAction).toBe("issue:comment");
      expect(details.quarantined).toBe(true);
    }
  });

  // Ally structural review of d543156c6, finding 1. `logActivity` published
  // `activity.logged` immediately after its insert, and the insert now runs
  // inside the advisory-lock transaction — so publication happened before
  // commit. A consumer could read the event before the row was visible, and a
  // rolled-back transaction emitted an event for a record that never existed.
  it("emits no activity event when the denial transaction fails to commit", async () => {
    const { companyId, outsiderAgentId, outsiderRunId, issueId } =
      await seedDeniedActorAgainstForeignIssue();

    // Runs the real transaction — lock, dedupe, count, insert all succeed — then
    // aborts it, standing in for a commit-time failure.
    const rollbackDb = new Proxy(db, {
      get(target, property, receiver) {
        if (property === "transaction") {
          return (callback: (tx: unknown) => Promise<unknown>, ...rest: unknown[]) =>
            (target.transaction as unknown as (
              cb: (tx: unknown) => Promise<unknown>,
              ...args: unknown[]
            ) => Promise<unknown>)(async (tx) => {
              await callback(tx);
              throw new Error("simulated commit failure after insert");
            }, ...rest);
        }
        return Reflect.get(target, property, receiver);
      },
    }) as typeof db;

    const events = captureDeniedWriteEvents(companyId);
    try {
      const res = await request(createApp(agentActor(companyId, outsiderAgentId, outsiderRunId), rollbackDb))
        .post(`/api/issues/${issueId}/comments`)
        .send({ body: "denied diagnosis lost to a rollback" });
      expect(res.status, JSON.stringify(res.body)).toBe(403);
    } finally {
      events.stop();
    }

    expect(await deniedWriteRows(companyId)).toHaveLength(0);
    expect(
      events.seen,
      "a rolled-back denial record must not publish a phantom activity event",
    ).toHaveLength(0);
  });

  it("publishes the activity event only once the recorded row is visible", async () => {
    const { companyId, outsiderAgentId, outsiderRunId, issueId } =
      await seedDeniedActorAgainstForeignIssue();

    const events = captureDeniedWriteEvents(companyId);
    try {
      const res = await request(createApp(agentActor(companyId, outsiderAgentId, outsiderRunId)))
        .post(`/api/issues/${issueId}/comments`)
        .send({ body: "denied diagnosis that must stay recoverable" });
      expect(res.status, JSON.stringify(res.body)).toBe(403);
    } finally {
      events.stop();
    }

    expect(events.seen).toHaveLength(1);
    expect(await deniedWriteRows(companyId)).toHaveLength(1);
    // Read taken from inside the event listener, on a connection outside the
    // recording transaction: the row is only visible there after commit, so a
    // pre-commit publication observes zero.
    expect(
      await events.seen[0]!.rowsVisibleAtPublish,
      "the row must already be visible to other connections when the event fires",
    ).toBe(1);
  });
});
