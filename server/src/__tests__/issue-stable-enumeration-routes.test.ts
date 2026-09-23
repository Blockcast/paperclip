import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, companyMemberships, createDb, issues, principalPermissionGrants } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { ISSUE_LIST_MAX_LIMIT } from "../services/index.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres stable enumeration tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue list stable enumeration and exact counts", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-stable-enumeration-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(companyId: string, actor?: Record<string, unknown>) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor ?? {
        type: "board",
        userId: "cloud-user-1",
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "owner", status: "active" }],
        source: "cloud_tenant",
        isInstanceAdmin: false,
      };
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  function uniqueIssuePrefix() {
    return `P${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`;
  }

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: uniqueIssuePrefix(),
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
    return companyId;
  }

  /**
   * Seeds `count` todo issues with strictly decreasing updatedAt, so the default
   * activity-ordered listing has a well-defined, reproducible order.
   */
  async function seedIssues(companyId: string, count: number) {
    const base = Date.UTC(2026, 0, 1, 0, 0, 0);
    const rows = Array.from({ length: count }, (_, index) => ({
      id: randomUUID(),
      companyId,
      title: `Issue ${index}`,
      status: "todo" as const,
      priority: "medium" as const,
      updatedAt: new Date(base - index * 60_000),
    }));
    await db.insert(issues).values(rows);
    return rows.map((row) => row.id);
  }

  /** Bumps an issue to the newest activity, moving it to the front of the default order. */
  async function touchIssue(issueId: string) {
    await db.update(issues).set({ updatedAt: new Date(Date.UTC(2030, 0, 1)) }).where(eq(issues.id, issueId));
  }

  it("visits every row exactly once under sortField=id while rows are touched mid-walk", async () => {
    const companyId = await seedCompany();
    const seeded = await seedIssues(companyId, 6);
    const app = createApp(companyId);

    const seen: string[] = [];
    let afterId: string | undefined;
    let page = 0;
    while (true) {
      const res = await request(app)
        .get(`/api/companies/${companyId}/issues`)
        .query({ status: "todo", limit: "2", sortField: "id", ...(afterId ? { afterId } : {}) });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const ids = res.body.map((issue: { id: string }) => issue.id);
      seen.push(...ids);
      if (ids.length < 2) break;
      afterId = ids[ids.length - 1];
      // Concurrent fleet activity: touching a row must not move it between pages.
      await touchIssue(seeded[seeded.length - 1 - page]!);
      page += 1;
    }

    expect(new Set(seen).size).toBe(6);
    expect([...seen].sort()).toEqual([...seeded].sort());
  });

  it("loses rows under offset paging when activity changes mid-walk", async () => {
    // Canary for the test above: proves the same mutation genuinely perturbs the
    // default activity order, so the stable-order assertion is not vacuous.
    const companyId = await seedCompany();
    const seeded = await seedIssues(companyId, 6);
    const app = createApp(companyId);

    const seen: string[] = [];
    let offset = 0;
    let page = 0;
    while (offset < 12) {
      const res = await request(app)
        .get(`/api/companies/${companyId}/issues`)
        .query({ status: "todo", limit: "2", offset: String(offset) });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const ids = res.body.map((issue: { id: string }) => issue.id);
      seen.push(...ids);
      if (ids.length < 2) break;
      offset += ids.length;
      await touchIssue(seeded[seeded.length - 1 - page]!);
      page += 1;
    }

    expect(new Set(seen).size).toBeLessThan(6);
  });

  it("rejects afterId without sortField=id", async () => {
    const companyId = await seedCompany();
    const res = await request(createApp(companyId))
      .get(`/api/companies/${companyId}/issues`)
      .query({ status: "todo", afterId: randomUUID() });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "afterId requires sortField=id" });
  });

  it("rejects afterId combined with offset", async () => {
    const companyId = await seedCompany();
    const res = await request(createApp(companyId))
      .get(`/api/companies/${companyId}/issues`)
      .query({ status: "todo", sortField: "id", afterId: randomUUID(), offset: "2" });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "afterId cannot be combined with offset" });
  });

  it("rejects a malformed afterId", async () => {
    const companyId = await seedCompany();
    const res = await request(createApp(companyId))
      .get(`/api/companies/${companyId}/issues`)
      .query({ status: "todo", sortField: "id", afterId: "not-a-uuid" });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "afterId must be an issue UUID" });
  });

  it("returns an exact open count without attention=blocked", async () => {
    const companyId = await seedCompany();
    const assigneeAgentId = randomUUID();
    await db.insert(agents).values({
      id: assigneeAgentId,
      companyId,
      name: "Assignee",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values([
      { companyId, title: "Open todo", status: "todo", priority: "medium", assigneeAgentId },
      { companyId, title: "Open in progress", status: "in_progress", priority: "high", assigneeAgentId },
      { companyId, title: "Closed", status: "done", priority: "low", assigneeAgentId },
      { companyId, title: "Someone else", status: "todo", priority: "low" },
    ]);

    const res = await request(createApp(companyId))
      .get(`/api/companies/${companyId}/issues/count`)
      .query({ status: "backlog,todo,in_progress,in_review,blocked", assigneeAgentId });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.count).toBe(2);
  });

  it("resolves assigneeUserId=me to the board user for the exact open count", async () => {
    const companyId = await seedCompany();
    await db.insert(issues).values([
      { companyId, title: "Mine todo", status: "todo", priority: "medium", assigneeUserId: "cloud-user-1" },
      { companyId, title: "Mine todo 2", status: "todo", priority: "low", assigneeUserId: "cloud-user-1" },
      { companyId, title: "Someone else", status: "todo", priority: "low", assigneeUserId: randomUUID() },
      { companyId, title: "Mine done", status: "done", priority: "low", assigneeUserId: "cloud-user-1" },
    ]);

    const res = await request(createApp(companyId))
      .get(`/api/companies/${companyId}/issues/count`)
      .query({ status: "backlog,todo,in_progress,in_review,blocked", assigneeUserId: "me" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.count).toBe(2);
  });

  it("walks every keyset page of the restricted-actor count", async () => {
    const companyId = await seedCompany();
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Skill tester",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    // One row past a full page forces a second keyset page. The only issue the
    // restricted actor can read is the highest id, which sortField=id places on page 2.
    const ids = await seedIssues(companyId, ISSUE_LIST_MAX_LIMIT + 1);
    const scopedIssueId = [...ids].sort().at(-1)!;
    // A skill-test key is denied company_scope:read, so the route takes the walk
    // instead of the single COUNT(*), and may read only its own issue.
    const skillTestActor = {
      type: "agent",
      agentId,
      companyId,
      source: "agent_key",
      keyScope: { kind: "skill_test", issueId: scopedIssueId },
    };

    const res = await request(createApp(companyId, skillTestActor))
      .get(`/api/companies/${companyId}/issues/count`)
      .query({ status: "todo" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.count).toBe(1);

    const boardRes = await request(createApp(companyId))
      .get(`/api/companies/${companyId}/issues/count`)
      .query({ status: "todo" });
    expect(boardRes.status, JSON.stringify(boardRes.body)).toBe(200);
    expect(boardRes.body.count).toBe(ISSUE_LIST_MAX_LIMIT + 1);
  }, 120_000);

  it("rejects filters the general count cannot honor rather than counting a wider set", async () => {
    const companyId = await seedCompany();
    const res = await request(createApp(companyId))
      .get(`/api/companies/${companyId}/issues/count`)
      .query({ status: "todo", q: "anything" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("q");
  });

  it("still rejects a non-blocked attention value", async () => {
    const companyId = await seedCompany();
    const res = await request(createApp(companyId))
      .get(`/api/companies/${companyId}/issues/count`)
      .query({ attention: "whatever" });

    expect(res.status).toBe(400);
  });
});
