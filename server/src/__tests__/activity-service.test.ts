import { randomUUID } from "node:crypto";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  documentRevisions,
  documents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issues,
} from "@paperclipai/db";
import { ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { activityService } from "../services/activity.js";
import {
  DEFAULT_ISSUE_RUNS_LIMIT,
  MAX_ISSUE_RUNS_LIMIT,
  normalizeIssueRunsLimit,
  runBelongsToIssue,
} from "../services/activity.js";

const SHAPE_COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const SHAPE_ISSUE_ID = "22222222-2222-4222-8222-222222222222";

/**
 * PEN-6670. Deliberately NOT gated on embedded Postgres — this renders SQL and
 * needs no database, so it keeps guarding the shape on hosts where the suites
 * below skip.
 */
describe("issue-run membership predicate shape (PEN-6670)", () => {
  const rendered = () =>
    new PgDialect().sqlToQuery(runBelongsToIssue(SHAPE_COMPANY_ID, SHAPE_ISSUE_ID));

  it("unions two standalone id sets rather than ORing them", () => {
    const normalized = rendered().sql.replace(/\s+/g, " ").toLowerCase();

    // Two arms => exactly one UNION. Plain UNION, not UNION ALL: the arms
    // overlap heavily (a run usually both names the issue in its context
    // snapshot and writes activity rows against it) and the outer IN wants
    // distinct ids.
    expect(normalized.match(/\bunion\b/g) ?? []).toHaveLength(1);
    expect(normalized).not.toContain("union all");
    expect(normalized).not.toMatch(/\bor\b/);
  });

  it("keeps the activity_log arm out of a correlated semi-join", () => {
    const { sql: text } = rendered();
    // ⛔ THE REGRESSION THIS GUARDS. A semi-join cannot take part in a
    // BitmapOr, so ORing `exists (... and activity_log.run_id =
    // heartbeat_runs.id)` against the context-snapshot predicate left a per-row
    // FILTER on a company-wide index scan as the only plan, and put
    // heartbeat_runs_company_issueid_idx (0077) out of reach. Measured on a
    // 905,300-run seed: 904,794 rows read and discarded, 48,522 buffers,
    // 1,369.8ms; 2,603 buffers and 16.3ms once the arms are unioned.
    expect(text.toLowerCase()).not.toContain("exists");
    expect(text).toContain('"activity_log"."run_id"');
    expect(text).toContain('"heartbeat_runs"."context_snapshot"');
  });

  it("gives each arm the predicates its index needs, and parameterises both", () => {
    const { sql: text, params } = rendered();
    const normalized = text.replace(/\s+/g, " ").toLowerCase();

    // Arm 1 drives heartbeat_runs_company_issueid_idx (0077): (company_id,
    // (context_snapshot->>'issueId')) WHERE that expression IS NOT NULL. Arm 2
    // drives activity_log_entity_type_id_idx (0003): (entity_type, entity_id),
    // with company_id applied as a filter. Both were measured as the planner's
    // actual choices. Dropping either company_id predicate widens the arm past
    // the tenant; dropping the issue predicate un-drives the index entirely.
    expect(normalized).toContain(`"heartbeat_runs"."company_id" = $1`);
    expect(normalized).toContain(`"activity_log"."company_id" = $3`);
    expect(normalized).toContain(`"activity_log"."entity_type" = 'issue'`);
    // `run_id` is nullable and most activity rows carry none, so this keeps the
    // arm from emitting NULLs the outer IN can do nothing with.
    expect(normalized).toContain(`"activity_log"."run_id" is not null`);

    expect(params).toEqual([SHAPE_COMPANY_ID, SHAPE_ISSUE_ID, SHAPE_COMPANY_ID, SHAPE_ISSUE_ID]);
    expect(text).not.toContain(SHAPE_COMPANY_ID);
    expect(text).not.toContain(SHAPE_ISSUE_ID);
  });
});

describe("issue runs limit helper (PEN-6670)", () => {
  it("clamps an untrusted limit to the server bounds", () => {
    expect(normalizeIssueRunsLimit(undefined)).toBe(DEFAULT_ISSUE_RUNS_LIMIT);
    expect(normalizeIssueRunsLimit(Number.NaN)).toBe(DEFAULT_ISSUE_RUNS_LIMIT);
    expect(normalizeIssueRunsLimit(0)).toBe(1);
    expect(normalizeIssueRunsLimit(-5)).toBe(1);
    expect(normalizeIssueRunsLimit(25.9)).toBe(25);
    expect(normalizeIssueRunsLimit(MAX_ISSUE_RUNS_LIMIT + 10)).toBe(MAX_ISSUE_RUNS_LIMIT);
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
type ActivityService = ReturnType<typeof activityService>;
type IssueRun = Awaited<ReturnType<ActivityService["runsForIssue"]>>[number];

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres activity service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function waitForIssueRun(
  service: ActivityService,
  companyId: string,
  issueId: string,
  predicate: (run: IssueRun) => boolean,
) {
  const deadline = Date.now() + 2_000;
  let latestRuns: IssueRun[] = [];
  while (Date.now() < deadline) {
    latestRuns = await service.runsForIssue(companyId, issueId);
    const run = latestRuns.find(predicate);
    if (run) return { run, runs: latestRuns };
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for issue run. Latest run count: ${latestRuns.length}`);
}

describeEmbeddedPostgres("activity service", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-activity-service-");
    db = createDb(tempDb.connectionString);
  });

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(issueDocuments);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("limits company activity lists", async () => {
    const companyId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(activityLog).values([
      {
        companyId,
        actorType: "system",
        actorId: "system",
        action: "test.oldest",
        entityType: "company",
        entityId: companyId,
        createdAt: new Date("2026-04-21T10:00:00.000Z"),
      },
      {
        companyId,
        actorType: "system",
        actorId: "system",
        action: "test.middle",
        entityType: "company",
        entityId: companyId,
        createdAt: new Date("2026-04-21T11:00:00.000Z"),
      },
      {
        companyId,
        actorType: "system",
        actorId: "system",
        action: "test.newest",
        entityType: "company",
        entityId: companyId,
        createdAt: new Date("2026-04-21T12:00:00.000Z"),
      },
    ]);

    const result = await activityService(db).list({ companyId, limit: 2 });

    expect(result.map((event) => event.action)).toEqual(["test.newest", "test.middle"]);
  });

  it("filters company activity lists by action", async () => {
    const companyId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(activityLog).values([
      {
        companyId,
        actorType: "system",
        actorId: "system",
        action: "issue_write_denied",
        entityType: "issue",
        entityId: randomUUID(),
        createdAt: new Date("2026-04-21T10:00:00.000Z"),
      },
      {
        companyId,
        actorType: "system",
        actorId: "system",
        action: "issue.updated",
        entityType: "issue",
        entityId: randomUUID(),
        createdAt: new Date("2026-04-21T11:00:00.000Z"),
      },
    ]);

    const result = await activityService(db).list({ companyId, action: "issue_write_denied" });

    expect(result).toHaveLength(1);
    expect(result[0]?.action).toBe("issue_write_denied");

    const bogusResult = await activityService(db).list({ companyId, action: "no_such_action" });
    expect(bogusResult).toEqual([]);

    const emptyActionResult = await activityService(db).list({ companyId, action: "" });
    expect(emptyActionResult).toEqual([]);
  });

  it("leaves excluded actions off the page while an action filter still reaches them", async () => {
    const companyId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(activityLog).values([
      {
        companyId,
        actorType: "system",
        actorId: "system",
        action: "issue.updated",
        entityType: "issue",
        entityId: randomUUID(),
        createdAt: new Date("2026-04-21T10:00:00.000Z"),
      },
      {
        companyId,
        actorType: "agent",
        actorId: randomUUID(),
        action: "heartbeat.run_events_streamed",
        entityType: "agent",
        entityId: randomUUID(),
        createdAt: new Date("2026-04-21T11:00:00.000Z"),
      },
    ]);

    const page = await activityService(db).list({
      companyId,
      excludeActions: ["heartbeat.run_events_streamed"],
    });
    expect(page.map((event) => event.action)).toEqual(["issue.updated"]);

    const asked = await activityService(db).list({
      companyId,
      action: "heartbeat.run_events_streamed",
      excludeActions: [],
    });
    expect(asked.map((event) => event.action)).toEqual(["heartbeat.run_events_streamed"]);
  });

  it("returns compact usage and result summaries for issue runs", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "succeeded",
      contextSnapshot: { issueId },
      usageJson: {
        inputTokens: 11,
        output_tokens: 7,
        cache_read_input_tokens: 3,
        billingType: "metered",
        costUsd: 0.42,
        enormousBlob: "x".repeat(256_000),
      },
      resultJson: {
        billing_type: "metered",
        total_cost_usd: 0.42,
        stopReason: "timeout",
        effectiveTimeoutSec: 30,
        timeoutFired: true,
        summary: "done",
        nestedHuge: { payload: "y".repeat(256_000) },
      },
      livenessState: "advanced",
      livenessReason: "Run produced concrete action evidence: 1 issue comment(s)",
      continuationAttempt: 2,
      lastUsefulActionAt: new Date("2026-04-18T19:59:00.000Z"),
      nextAction: "Review the completed output.",
    });

    const runs = await activityService(db).runsForIssue(companyId, issueId);

    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      runId,
      agentId,
      invocationSource: "assignment",
    });
    expect(runs[0]?.usageJson).toEqual({
      inputTokens: 11,
      input_tokens: 11,
      outputTokens: 7,
      output_tokens: 7,
      cachedInputTokens: 3,
      cached_input_tokens: 3,
      cache_read_input_tokens: 3,
      billingType: "metered",
      billing_type: "metered",
      costUsd: 0.42,
      cost_usd: 0.42,
      total_cost_usd: 0.42,
    });
    expect(runs[0]?.resultJson).toEqual({
      billingType: "metered",
      billing_type: "metered",
      costUsd: 0.42,
      cost_usd: 0.42,
      total_cost_usd: 0.42,
      stopReason: "timeout",
      effectiveTimeoutSec: 30,
      timeoutFired: true,
    });
    expect(runs[0]).toMatchObject({
      livenessState: "advanced",
      livenessReason: "Run produced concrete action evidence: 1 issue comment(s)",
      continuationAttempt: 2,
      lastUsefulActionAt: new Date("2026-04-18T19:59:00.000Z"),
      nextAction: "Review the completed output.",
    });
    expect(runs[0]).not.toHaveProperty("contextSnapshot");
  });

  it("backfills missing liveness for completed issue runs before returning the ledger", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const completedAt = new Date("2026-04-18T20:04:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Fix run ledger",
      description: "Make the run ledger answer whether a run advanced.",
      status: "done",
      priority: "medium",
      assigneeAgentId: agentId,
      completedAt,
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "succeeded",
      startedAt: new Date("2026-04-18T20:00:00.000Z"),
      finishedAt: completedAt,
      contextSnapshot: { issueId },
      resultJson: {
        summary: "Finished the implementation.",
      },
      livenessState: null,
      livenessReason: null,
      lastUsefulActionAt: null,
      nextAction: null,
    });

    await db.insert(issueComments).values({
      companyId,
      issueId,
      authorAgentId: agentId,
      createdByRunId: runId,
      body: "Done",
      createdAt: completedAt,
    });

    const service = activityService(db);
    const { run, runs } = await waitForIssueRun(
      service,
      companyId,
      issueId,
      (entry) => entry.runId === runId && entry.livenessState === "completed",
    );

    expect(runs).toHaveLength(1);
    expect(run).toMatchObject({
      runId,
      livenessState: "completed",
      livenessReason: "Issue is done",
      continuationAttempt: 0,
      lastUsefulActionAt: completedAt,
    });

    const [persisted] = await db.select().from(heartbeatRuns);
    expect(persisted).toMatchObject({
      id: runId,
      livenessState: "completed",
      livenessReason: "Issue is done",
      continuationAttempt: 0,
      lastUsefulActionAt: completedAt,
    });
  });

  it("does not backfill document evidence from a different run", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const otherRunId = randomUUID();
    const documentId = randomUUID();
    const revisionId = randomUUID();
    const createdAt = new Date("2026-04-18T20:08:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Fix run ledger",
      description: "Make the run ledger answer whether a run advanced.",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });

    await db.insert(heartbeatRuns).values([
      {
        id: runId,
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "succeeded",
        startedAt: new Date("2026-04-18T20:00:00.000Z"),
        finishedAt: new Date("2026-04-18T20:02:00.000Z"),
        contextSnapshot: { issueId },
        resultJson: {
          summary: "Next steps:\n- inspect files",
        },
        livenessState: null,
        livenessReason: null,
      },
      {
        id: otherRunId,
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "succeeded",
        startedAt: new Date("2026-04-18T20:05:00.000Z"),
        finishedAt: createdAt,
        contextSnapshot: { issueId },
        resultJson: {
          summary: "Updated the plan document.",
        },
        livenessState: "advanced",
        livenessReason: "Run produced concrete action evidence: 1 document revision(s)",
      },
    ]);

    await db.insert(documents).values({
      id: documentId,
      companyId,
      title: "Plan",
      format: "markdown",
      latestBody: "# Plan\n\n- Inspect files",
      latestRevisionId: revisionId,
      latestRevisionNumber: 1,
      createdByAgentId: agentId,
      updatedByAgentId: agentId,
      createdAt,
      updatedAt: createdAt,
    });

    await db.insert(documentRevisions).values({
      id: revisionId,
      companyId,
      documentId,
      revisionNumber: 1,
      title: "Plan",
      format: "markdown",
      body: "# Plan\n\n- Inspect files",
      createdByAgentId: agentId,
      createdByRunId: otherRunId,
      createdAt,
    });

    await db.insert(issueDocuments).values({
      companyId,
      issueId,
      documentId,
      key: "plan",
      createdAt,
      updatedAt: createdAt,
    });

    const service = activityService(db);
    const { run: backfilledRun } = await waitForIssueRun(
      service,
      companyId,
      issueId,
      (entry) => entry.runId === runId && entry.livenessState === "plan_only",
    );

    expect(backfilledRun).toMatchObject({
      runId,
      livenessState: "plan_only",
      livenessReason: "Run described runnable future work without concrete action evidence",
      lastUsefulActionAt: null,
    });
  });

  it("does not treat continuation summary revisions as concrete backfill evidence", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const documentId = randomUUID();
    const revisionId = randomUUID();
    const createdAt = new Date("2026-04-18T20:12:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Fix run ledger",
      description: "Make the run ledger answer whether a run advanced.",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "succeeded",
      startedAt: new Date("2026-04-18T20:10:00.000Z"),
      finishedAt: createdAt,
      contextSnapshot: { issueId },
      resultJson: {
        summary: "Next steps:\n- inspect files",
      },
      livenessState: null,
      livenessReason: null,
    });

    await db.insert(documents).values({
      id: documentId,
      companyId,
      title: "Continuation Summary",
      format: "markdown",
      latestBody: "# Continuation Summary",
      latestRevisionId: revisionId,
      latestRevisionNumber: 1,
      createdByAgentId: agentId,
      updatedByAgentId: agentId,
      createdAt,
      updatedAt: createdAt,
    });

    await db.insert(documentRevisions).values({
      id: revisionId,
      companyId,
      documentId,
      revisionNumber: 1,
      title: "Continuation Summary",
      format: "markdown",
      body: "# Continuation Summary",
      createdByAgentId: agentId,
      createdByRunId: runId,
      createdAt,
    });

    await db.insert(issueDocuments).values({
      companyId,
      issueId,
      documentId,
      key: ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY,
      createdAt,
      updatedAt: createdAt,
    });

    const service = activityService(db);
    const { run: backfilledRun } = await waitForIssueRun(
      service,
      companyId,
      issueId,
      (entry) => entry.runId === runId && entry.livenessState === "plan_only",
    );

    expect(backfilledRun).toMatchObject({
      runId,
      livenessState: "plan_only",
      livenessReason: "Run described runnable future work without concrete action evidence",
      lastUsefulActionAt: null,
    });
  });

  it("still finds runs reachable only through activity_log, and honours the bound (PEN-6670)", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const contextRunId = randomUUID();
    const activityOnlyRunId = randomUUID();
    const unrelatedRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Engineer",
      role: "engineer",
      status: "running",
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values([
      {
        // Arm 1: named in the run's own context snapshot.
        id: contextRunId,
        companyId,
        agentId,
        status: "succeeded",
        contextSnapshot: { issueId },
        livenessState: "advanced",
        createdAt: new Date("2026-04-18T10:00:00.000Z"),
      },
      {
        // Arm 2: the run worked a DIFFERENT issue in its snapshot and only
        // touched this one through activity_log. Before PEN-6670 this was the
        // correlated EXISTS; it must still be found.
        id: activityOnlyRunId,
        companyId,
        agentId,
        status: "succeeded",
        contextSnapshot: { issueId: randomUUID() },
        livenessState: "advanced",
        createdAt: new Date("2026-04-18T11:00:00.000Z"),
      },
      {
        // Neither arm. Must not come back.
        id: unrelatedRunId,
        companyId,
        agentId,
        status: "succeeded",
        contextSnapshot: { issueId: randomUUID() },
        livenessState: "advanced",
        createdAt: new Date("2026-04-18T12:00:00.000Z"),
      },
    ]);

    await db.insert(activityLog).values([
      {
        companyId,
        actorType: "agent",
        actorId: agentId,
        action: "issue.comment_added",
        entityType: "issue",
        entityId: issueId,
        runId: activityOnlyRunId,
      },
      {
        // Same run id, but against another entity type — must not pull the run in.
        companyId,
        actorType: "agent",
        actorId: agentId,
        action: "agent.updated",
        entityType: "agent",
        entityId: agentId,
        runId: unrelatedRunId,
      },
    ]);

    const service = activityService(db);
    const runs = await service.runsForIssue(companyId, issueId);

    // Newest first, both arms, and nothing else.
    expect(runs.map((run) => run.runId)).toEqual([activityOnlyRunId, contextRunId]);

    // The union de-duplicates: a run matching BOTH arms appears once.
    await db.insert(activityLog).values({
      companyId,
      actorType: "agent",
      actorId: agentId,
      action: "issue.updated",
      entityType: "issue",
      entityId: issueId,
      runId: contextRunId,
    });
    const deduped = await service.runsForIssue(companyId, issueId);
    expect(deduped.map((run) => run.runId)).toEqual([activityOnlyRunId, contextRunId]);

    // The bound applies to the ordered page, so a capped read keeps the newest.
    const capped = await service.runsForIssue(companyId, issueId, { limit: 1 });
    expect(capped.map((run) => run.runId)).toEqual([activityOnlyRunId]);
  });
});
