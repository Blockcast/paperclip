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
    // No per-hook override: embedded Postgres takes ~40s to start on a contended runner,
    // so the 20s this file used to pin here timed the hook out and skipped the whole file
    // while reporting a failed suite. vitest.config.ts already sets hookTimeout to 120s
    // for exactly this reason; inherit it rather than re-pinning a tighter one.
  });

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

  function createApp(
    companyId: string,
    actor?: Record<string, unknown>,
    routeOpts?: Parameters<typeof issueRoutes>[2],
  ) {
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
    app.use("/api", issueRoutes(db, {} as any, routeOpts));
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
   * Seeds `count` issues with strictly decreasing updatedAt, so the default
   * activity-ordered listing has a well-defined, reproducible order.
   *
   * Ids are assigned in the REVERSE of that order — index 0 is newest but sorts last —
   * rather than left random. The keyset walk reads id order and the activity order is what
   * mutation perturbs, so with random ids the two orders correlate by luck and a test that
   * touches an "already-returned" row may touch one already at the front of the activity
   * order, where re-ranking moves nothing. Anti-correlating them makes every already-
   * returned row a late one in activity order, so offset paging demonstrably loses it.
   *
   * Ids are therefore a function of `count` and the index alone, not of the company: two
   * calls with the same `count` in one test collide on the primary key. Seed once per test.
   *
   * `status: "blocked"` additionally puts every row in the blocked inbox: a blocked row
   * with no blocker edge, no assigneeUserId and no monitor is a dead end, which is the
   * cheapest shape that earns a blockedInboxAttention entry (no companion rows needed).
   */
  async function seedIssues(companyId: string, count: number, status: "todo" | "blocked" = "todo") {
    const base = Date.UTC(2026, 0, 1, 0, 0, 0);
    const rows = Array.from({ length: count }, (_, index) => ({
      id: `${(count - 1 - index).toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`,
      companyId,
      title: `Issue ${index}`,
      status,
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

  it("rejects afterId combined with attention=blocked", async () => {
    // The blocked-inbox listing pages by offset only, so an accepted cursor would be
    // silently ignored and a cursor loop over it would never advance.
    const companyId = await seedCompany();
    const res = await request(createApp(companyId))
      .get(`/api/companies/${companyId}/issues`)
      .query({ attention: "blocked", sortField: "id", afterId: randomUUID() });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "afterId cannot be combined with attention=blocked" });
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

  /**
   * BLO-41592. The A/B from the ticket, against the real route: `A` is the control that
   * makes `B` meaningful. The count route implements no time bound and Express hands
   * unknown params through unread, so pre-fix `B === A` — a whole-corpus count returned
   * as a success. Worse than the BLO-40145 list case it mirrors: a list hands you rows
   * whose updatedAt you can eyeball (that is how BLO-40145 was caught), a count hands you
   * one integer with no tell. `A` doubles as the non-vacuity case: the guard must not
   * reject an ordinary count, and the two exact-count tests above are the wider control.
   */
  it("rejects a time-bound param instead of returning a whole-corpus count", async () => {
    const companyId = await seedCompany();
    await db.insert(issues).values([
      { companyId, title: "Row A", status: "todo", priority: "medium" },
      { companyId, title: "Row B", status: "todo", priority: "low" },
    ]);

    const unbounded = await request(createApp(companyId)).get(`/api/companies/${companyId}/issues/count`);
    expect(unbounded.status, JSON.stringify(unbounded.body)).toBe(200);
    expect(unbounded.body.count).toBe(2);

    // A floor no row can satisfy, so a honoured bound counts 0 and a dropped one counts 2.
    const bounded = await request(createApp(companyId))
      .get(`/api/companies/${companyId}/issues/count`)
      .query({ updated_after: "2099-01-01T00:00:00Z" });
    expect(bounded.status, JSON.stringify(bounded.body)).toBe(400);
    expect(bounded.body.count).toBeUndefined();
    expect(bounded.body.unsupportedParams).toEqual(["updated_after"]);
    // Names where a real time bound lives, as the list route's refusal does.
    expect(bounded.body.error).toMatch(/\/search with updatedAfter/);
  });

  // The COUNT_UNSUPPORTED_FILTERS guard one block below only runs when attention is
  // undefined, so a guard placed inside it would leave the blocked path counting the
  // corpus. This pins the time-bound refusal ahead of that branch.
  it("rejects a time-bound param on the attention=blocked count path too", async () => {
    const companyId = await seedCompany();
    const res = await request(createApp(companyId))
      .get(`/api/companies/${companyId}/issues/count`)
      .query({ attention: "blocked", createdSince: "2099-01-01T00:00:00Z" });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.unsupportedParams).toEqual(["createdSince"]);
  });

  /** A key scoped to a single issue: denied company_scope:read, so the count route walks. */
  function skillTestActor(companyId: string, agentId: string, issueId: string) {
    return { type: "agent", agentId, companyId, source: "agent_key", keyScope: { kind: "skill_test", issueId } };
  }

  async function seedAgent(companyId: string) {
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
    return agentId;
  }

  it("keeps the restricted-actor count exact while rows are touched between its pages", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    // Five rows over an injected page size of two: three pages, so the cursor is carried
    // twice. Shrinking the page rather than seeding ISSUE_LIST_MAX_LIMIT + 1 rows is what
    // lets this run at ordinary speed.
    const ids = await seedIssues(companyId, 5);
    const byId = [...ids].sort();
    // The one readable issue is the LOWEST id, i.e. the oldest by activity. Under the
    // keyset order the walk meets it on page one and counts it; under offset paging over
    // the activity order the touches below carry it to the front, behind the advancing
    // cursor, and it is never counted at all. That is the difference this asserts.
    const scopedIssueId = byId[0]!;

    // Bump an ALREADY-RETURNED row to the newest activity after each page. The walk reads
    // the immutable id order, so this must not move a row across the cursor. The offset
    // canary above proves the same mutation genuinely re-ranks the activity order, so a
    // pass here is stability under concurrent writes, not an inert assertion.
    let pages = 0;
    const onPage = async () => {
      await touchIssue(byId[pages]!);
      pages += 1;
    };

    const res = await request(
      createApp(companyId, skillTestActor(companyId, agentId, scopedIssueId), {
        issueCountWalk: { pageSize: 2, onPage },
      }),
    )
      .get(`/api/companies/${companyId}/issues/count`)
      .query({ status: "todo" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.count).toBe(1);
    // Guards the guard: a single-page walk would assert nothing about the cursor.
    expect(pages).toBeGreaterThan(1);

    const boardRes = await request(createApp(companyId))
      .get(`/api/companies/${companyId}/issues/count`)
      .query({ status: "todo" });
    expect(boardRes.status, JSON.stringify(boardRes.body)).toBe(200);
    expect(boardRes.body.count).toBe(5);
  });

  it("walks every offset page of the restricted-actor attention=blocked count", async () => {
    // The route computes the blocked flag from its own query and forwards `offset` to the
    // blocked listing; passing `blocked` to the walk by hand would exercise neither. If the
    // flag or the offset is wrong, the walk re-serves page one and now throws rather than
    // hanging, so this fails loudly either way.
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const ids = await seedIssues(companyId, 5, "blocked");
    // The blocked listing orders by activity descending and seedIssues ages each row
    // further, so the last-seeded row sorts last — reachable only after offset advances.
    const scopedIssueId = ids.at(-1)!;

    let pages = 0;
    const onPage = async () => {
      pages += 1;
    };

    const res = await request(
      createApp(companyId, skillTestActor(companyId, agentId, scopedIssueId), {
        issueCountWalk: { pageSize: 2, onPage },
      }),
    )
      .get(`/api/companies/${companyId}/issues/count`)
      .query({ attention: "blocked" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.count).toBe(1);
    // Guards the guard, as the keyset sibling above does: this whole test rests on the
    // page size seam being honored. If `pageSize` stops reaching list() all 5 rows arrive
    // on page one, the walk returns before advancing any offset, and every assertion above
    // still passes while the title stops being true.
    expect(pages).toBeGreaterThan(1);

    const boardRes = await request(createApp(companyId))
      .get(`/api/companies/${companyId}/issues/count`)
      .query({ attention: "blocked" });
    expect(boardRes.status, JSON.stringify(boardRes.body)).toBe(200);
    expect(boardRes.body.count).toBe(5);
  });

  it("counts through the walk's default page size when no test seam is injected", async () => {
    // Both walk tests above inject `issueCountWalk.pageSize`, and every other actor in this
    // file is a board actor that takes the single COUNT(*) without entering the walk. That
    // leaves the `?? ISSUE_LIST_MAX_LIMIT` fallback serving every real restricted-actor
    // request while being read by no test, so pass no routeOpts at all here.
    //
    // Two rows is enough, and deliberately fewer than one page: with the fallback they are a
    // short first page and the walk returns on it.
    //
    // Scope, so the next reader does not over-read this: it pins the fallback's PRESENCE, not
    // its value. Every `pageSize >= 1` passes here — the walk's `rows.length < opts.pageSize`
    // short-return fires BEFORE the keyset branch can dereference, on the first page at the
    // default size (2 < 1000, so no empty page is ever fetched) and on the empty page at
    // `pageSize <= 2` — so `?? 1` and `?? ISSUE_LIST_MAX_LIMIT` are indistinguishable to this
    // assertion. Pinning the value needs the ISSUE_LIST_MAX_LIMIT + 1 fixture this file
    // deliberately does not seed — that fixture is what forced the `120_000` timeout this PR
    // removed, so the trade is deliberate.
    //
    // Deleting the `??` outright is caught by the type checker rather than by this test:
    // walkIssueListPages takes `pageSize: number` while `opts.issueCountWalk?.pageSize` is
    // `number | undefined`, so the bare expression is a TS2322 under strict. Only a cast past
    // that reaches the runtime failure this asserts — `rows.length < undefined` is false, so
    // the walk never short-returns and the keyset branch dereferences
    // `rows[rows.length - 1]!.id` on the empty second page, a 500 on every restricted-actor
    // count. That cast is the mutation this test was checked against.
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const ids = await seedIssues(companyId, 2);
    const scopedIssueId = ids[0]!;

    const res = await request(createApp(companyId, skillTestActor(companyId, agentId, scopedIssueId)))
      .get(`/api/companies/${companyId}/issues/count`)
      .query({ status: "todo" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.count).toBe(1);
  });

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
