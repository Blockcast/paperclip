import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, companyMemberships, createDb, heartbeatRuns, issues, principalPermissionGrants } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { __clearIssueListResponseCacheForTests, issueRoutes } from "../routes/issues.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";

/**
 * BLO-28843. An issue is *attended* by exactly one of three paths: a live run,
 * an armed monitor, or a scheduled retry. The issue-list projection carried the
 * first two and omitted the third, so a list-based liveness audit read
 * `undefined` for retry state on every row and computed zero retry-attended
 * issues — a plausible number, not an error.
 *
 * The regression guard that matters is case (b): a row with no scheduled retry
 * must carry the keys *present* and `null`. Asserting only falsiness would pass
 * against the exact defect being fixed, because an absent key is falsy too.
 */
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres scheduled-retry projection tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue list scheduled-retry projection", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-list-retry-");
    db = createDb(tempDb.connectionString);
  }, 120_000);

  afterEach(async () => {
    __clearIssueListResponseCacheForTests();
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(companyId: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const userId = "cloud-user-1";
      (req as any).actor = {
        type: "board",
        userId,
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "owner", status: "active", principalId: userId }],
        source: "cloud_tenant",
        isInstanceAdmin: false,
      };
      next();
    });
    app.use("/api", issueRoutes(db, {} as any, {}));
    app.use(errorHandler);
    return app;
  }

  async function seedFixture() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const parkedIssueId = randomUUID();
    const plainIssueId = randomUUID();
    const parkedRunId = randomUUID();
    const scheduledRetryAt = new Date("2026-08-19T05:23:41.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `P${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "cloud-user-1",
      status: "active",
      membershipRole: "owner",
      updatedAt: new Date(),
    });
    await ensureHumanRoleDefaultGrants(db, {
      companyId,
      principalId: "cloud-user-1",
      membershipRole: "owner",
      grantedByUserId: null,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Parked agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values([
      {
        id: parkedIssueId,
        companyId,
        title: "Attended by a scheduled retry",
        status: "in_progress",
        priority: "high",
        assigneeAgentId: agentId,
      },
      {
        id: plainIssueId,
        companyId,
        title: "No scheduled retry at all",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
      },
    ]);
    await db.insert(heartbeatRuns).values({
      id: parkedRunId,
      companyId,
      agentId,
      status: "scheduled_retry",
      invocationSource: "automation",
      triggerDetail: "system",
      scheduledRetryAt,
      scheduledRetryAttempt: 3,
      scheduledRetryReason: "transient_failure",
      contextSnapshot: { issueId: parkedIssueId },
    });

    return { companyId, parkedIssueId, plainIssueId, parkedRunId, scheduledRetryAt };
  }

  it("projects scheduledRetryAt/Reason/Attempt on a row whose latest run is parked", async () => {
    const { companyId, parkedIssueId, scheduledRetryAt } = await seedFixture();

    const res = await request(createApp(companyId)).get(`/api/companies/${companyId}/issues`).query({ limit: "20" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const parkedRow = res.body.find((issue: { id: string }) => issue.id === parkedIssueId);
    expect(parkedRow).toBeTruthy();
    expect(new Date(parkedRow.scheduledRetryAt).toISOString()).toBe(scheduledRetryAt.toISOString());
    expect(parkedRow.scheduledRetryReason).toBe("transient_failure");
    expect(parkedRow.scheduledRetryAttempt).toBe(3);
  });

  it("keeps all three keys PRESENT and null on a row with no scheduled retry", async () => {
    const { companyId, plainIssueId } = await seedFixture();

    const res = await request(createApp(companyId)).get(`/api/companies/${companyId}/issues`).query({ limit: "20" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const plainRow = res.body.find((issue: { id: string }) => issue.id === plainIssueId);
    expect(plainRow).toBeTruthy();
    // Presence, not falsiness: an absent key is falsy too, which is exactly the
    // silent-blindness mode this guards.
    expect(Object.keys(plainRow)).toContain("scheduledRetryAt");
    expect(Object.keys(plainRow)).toContain("scheduledRetryReason");
    expect(Object.keys(plainRow)).toContain("scheduledRetryAttempt");
    expect(plainRow.scheduledRetryAt).toBeNull();
    expect(plainRow.scheduledRetryReason).toBeNull();
    expect(plainRow.scheduledRetryAttempt).toBeNull();
  });

  it("agrees with the single-issue read for the same issue", async () => {
    const { companyId, parkedIssueId, parkedRunId } = await seedFixture();
    const app = createApp(companyId);

    const listRes = await request(app).get(`/api/companies/${companyId}/issues`).query({ limit: "20" });
    const detailRes = await request(app).get(`/api/issues/${parkedIssueId}`);

    expect(listRes.status, JSON.stringify(listRes.body)).toBe(200);
    expect(detailRes.status, JSON.stringify(detailRes.body)).toBe(200);
    const listRow = listRes.body.find((issue: { id: string }) => issue.id === parkedIssueId);
    const detailRetry = detailRes.body.scheduledRetry;

    expect(detailRetry).toBeTruthy();
    expect(detailRetry.runId).toBe(parkedRunId);
    expect(new Date(listRow.scheduledRetryAt).toISOString()).toBe(new Date(detailRetry.scheduledRetryAt).toISOString());
    expect(listRow.scheduledRetryReason).toBe(detailRetry.scheduledRetryReason);
    expect(listRow.scheduledRetryAttempt).toBe(detailRetry.scheduledRetryAttempt);
  });

  it("selects the same row the single-issue read would when an issue has several parked runs", async () => {
    const { companyId, parkedIssueId, parkedRunId } = await seedFixture();
    const agentRow = await db.select({ id: agents.id }).from(agents).then((rows) => rows[0]!);

    // A later-due park on the same issue must not win: both reads tie-break on
    // earliest scheduledRetryAt, then createdAt, then id.
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId: agentRow.id,
      status: "scheduled_retry",
      invocationSource: "automation",
      triggerDetail: "system",
      scheduledRetryAt: new Date("2026-08-19T09:00:00.000Z"),
      scheduledRetryAttempt: 9,
      scheduledRetryReason: "ccrotate_capacity",
      contextSnapshot: { issueId: parkedIssueId },
    });

    const app = createApp(companyId);
    const listRes = await request(app).get(`/api/companies/${companyId}/issues`).query({ limit: "20" });
    const detailRes = await request(app).get(`/api/issues/${parkedIssueId}`);

    const listRow = listRes.body.find((issue: { id: string }) => issue.id === parkedIssueId);
    expect(detailRes.body.scheduledRetry.runId).toBe(parkedRunId);
    expect(listRow.scheduledRetryReason).toBe("transient_failure");
    expect(listRow.scheduledRetryAttempt).toBe(3);
    expect(new Date(listRow.scheduledRetryAt).toISOString()).toBe(
      new Date(detailRes.body.scheduledRetry.scheduledRetryAt).toISOString(),
    );
  });

  it("does not leak a parked run across company boundaries", async () => {
    const { companyId: otherCompanyId, parkedIssueId: otherParkedIssueId } = await seedFixture();
    const { companyId, plainIssueId } = await seedFixture();
    expect(otherCompanyId).not.toBe(companyId);
    expect(otherParkedIssueId).not.toBe(plainIssueId);

    const res = await request(createApp(companyId)).get(`/api/companies/${companyId}/issues`).query({ limit: "20" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.every((issue: { companyId: string }) => issue.companyId === companyId)).toBe(true);
    const plainRow = res.body.find((issue: { id: string }) => issue.id === plainIssueId);
    expect(plainRow.scheduledRetryAt).toBeNull();
  });
});
