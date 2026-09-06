import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { agents, companies, createDb, issues } from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  clampIssueListLimit,
  ISSUE_LIST_MAX_LIMIT,
  issueService,
  OPEN_ASSIGNMENT_CENSUS_MAX_AGENT_GROUPS,
  OPEN_ISSUE_STATUSES,
} from "../services/issues.ts";

/**
 * BLO-22785 — the agent-health routine aborted two live windows because it
 * could not obtain a provably complete open-assignment population. The company
 * issue-list route silently clamps `limit` to ISSUE_LIST_MAX_LIMIT and returns
 * a bare array with no total and no cursor, so a caller cannot distinguish a
 * complete page from a truncated prefix, and offset paging over a mutating
 * collection double-counts and drops rows.
 *
 * These tests seed past the 1,000-row cap deliberately: below it the broken
 * path and the fixed one agree, so a smaller fixture would pass against the
 * defect.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const PRIORITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const rankOf = (priority: string) => PRIORITY_RANK[priority] ?? 4;

/**
 * Independent oracle. Deliberately does NOT reuse the census SQL: it pulls
 * every open row and groups in JS, so an error in the aggregate cannot cancel
 * itself out. (This is how the `sum()`-vs-`count()` defect in the first draft
 * of the census was caught — `count(*)` over a status-grouped subquery returns
 * the number of distinct statuses, not the number of issues.)
 */
async function oracle(db: ReturnType<typeof createDb>, companyId: string) {
  const rows = await db
    .select({
      id: issues.id,
      identifier: issues.identifier,
      status: issues.status,
      priority: issues.priority,
      assigneeAgentId: issues.assigneeAgentId,
      assigneeUserId: issues.assigneeUserId,
      createdAt: issues.createdAt,
      originKind: issues.originKind,
      hiddenAt: issues.hiddenAt,
    })
    .from(issues)
    .where(and(
      eq(issues.companyId, companyId),
      inArray(issues.status, [...OPEN_ISSUE_STATUSES]),
    ));

  const open = rows.filter((row) =>
    row.hiddenAt === null
    && row.originKind !== "routine_execution"
    && !/^plugin:.*:operation(:|$)/.test(row.originKind ?? ""));

  const byAgent = new Map<string, typeof open>();
  for (const row of open) {
    if (!row.assigneeAgentId) continue;
    const bucket = byAgent.get(row.assigneeAgentId) ?? [];
    bucket.push(row);
    byAgent.set(row.assigneeAgentId, bucket);
  }

  const topFor = (agentId: string) =>
    [...(byAgent.get(agentId) ?? [])].sort((a, b) =>
      rankOf(a.priority) - rankOf(b.priority)
      || a.createdAt.getTime() - b.createdAt.getTime()
      || a.id.localeCompare(b.id))[0];

  return {
    open,
    byAgent,
    topFor,
    totals: {
      open: open.length,
      openAssignedToAgents: open.filter((row) => row.assigneeAgentId).length,
      openAssignedToUsers: open.filter((row) => !row.assigneeAgentId && row.assigneeUserId).length,
      openUnassigned: open.filter((row) => !row.assigneeAgentId && !row.assigneeUserId).length,
      agentsWithOpenWork: byAgent.size,
    },
  };
}

describeEmbeddedPostgres("issueService.openAssignmentCensus", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-open-assignment-census-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, 60_000);

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(name: string, prefix: string) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name,
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(companyId: string, name: string) {
    const agentId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId, name, role: "engineer" });
    return agentId;
  }

  /**
   * Seeds well past ISSUE_LIST_MAX_LIMIT so the census is exercised on a
   * population the list route physically cannot return in one page.
   */
  async function seedLargePopulation(companyId: string, agentIds: string[]) {
    const priorities = ["critical", "high", "medium", "low"];
    const openStatuses = [...OPEN_ISSUE_STATUSES];
    const rows: Array<typeof issues.$inferInsert> = [];
    const base = Date.UTC(2026, 0, 1);

    // 1,300 open agent-assigned issues, unevenly distributed across agents.
    let seq = 0;
    for (const [agentIndex, agentId] of agentIds.entries()) {
      const count = 200 + agentIndex * 150; // 200, 350, 500, 650 -> 1700 total
      for (let i = 0; i < count; i += 1) {
        seq += 1;
        rows.push({
          companyId,
          assigneeAgentId: agentId,
          title: `open ${seq}`,
          identifier: `SEED-${seq}`,
          // Every agent gets at least one 'critical' so highest-priority is
          // never trivially the only row.
          priority: i === 0 ? "critical" : priorities[(i + agentIndex) % priorities.length]!,
          status: openStatuses[i % openStatuses.length]!,
          createdAt: new Date(base + seq * 1000),
        });
      }
    }

    // Rows that must NOT appear in the census.
    rows.push({ companyId, assigneeAgentId: agentIds[0], title: "done", status: "done", priority: "critical" });
    rows.push({ companyId, assigneeAgentId: agentIds[0], title: "cancelled", status: "cancelled", priority: "critical" });
    rows.push({ companyId, assigneeAgentId: agentIds[0], title: "hidden", status: "todo", priority: "critical", hiddenAt: new Date() });
    rows.push({ companyId, assigneeAgentId: agentIds[0], title: "routine", status: "todo", priority: "critical", originKind: "routine_execution" });
    rows.push({ companyId, assigneeAgentId: agentIds[0], title: "plugin op", status: "todo", priority: "critical", originKind: "plugin:linear:operation" });

    // Non-agent open rows, so the totals split is exercised.
    rows.push({ companyId, assigneeUserId: "human-1", title: "human owned", status: "todo", priority: "high" });
    rows.push({ companyId, assigneeUserId: "human-2", title: "human owned 2", status: "blocked", priority: "low" });
    rows.push({ companyId, title: "unassigned", status: "backlog", priority: "medium" });

    for (let i = 0; i < rows.length; i += 500) {
      await db.insert(issues).values(rows.slice(i, i + 500));
    }
    return rows.length;
  }

  it("returns exact per-agent counts and highest-priority identity matching a direct database oracle, past the list cap", async () => {
    const companyId = await seedCompany("Paperclip", "BLO");
    const agentIds = [
      await seedAgent(companyId, "alpha"),
      await seedAgent(companyId, "beta"),
      await seedAgent(companyId, "gamma"),
      await seedAgent(companyId, "delta"),
    ];
    await seedLargePopulation(companyId, agentIds);

    const expected = await oracle(db, companyId);
    // Guard the fixture itself: below the cap this test would pass against the
    // very defect it exists to catch.
    expect(expected.totals.open).toBeGreaterThan(ISSUE_LIST_MAX_LIMIT);

    const census = await svc.openAssignmentCensus(companyId);

    expect(census.complete).toBe(true);
    expect(census.truncated).toBe(false);
    expect(census.companyId).toBe(companyId);
    expect(census.openStatuses).toEqual([...OPEN_ISSUE_STATUSES]);
    expect(census.totals).toEqual(expected.totals);
    expect(census.agentGroupCount).toBe(expected.byAgent.size);
    expect(census.agents).toHaveLength(expected.byAgent.size);

    // The census is self-checkable: the per-agent counts must reconstruct the
    // total. A torn read breaks this even when each half looks plausible.
    const summed = census.agents.reduce((total, row) => total + row.openCount, 0);
    expect(summed).toBe(census.totals.openAssignedToAgents);

    for (const row of census.agents) {
      const mine = expected.byAgent.get(row.assigneeAgentId) ?? [];
      const top = expected.topFor(row.assigneeAgentId)!;
      expect(row.openCount).toBe(mine.length);
      expect(row.highestPriority).toBe(top.priority);
      expect(row.highestPriorityIssue.id).toBe(top.id);
      expect(row.highestPriorityIssue.identifier).toBe(top.identifier);
      expect(Object.values(row.countsByStatus).reduce((a, b) => a + b, 0)).toBe(row.openCount);
      expect(Object.values(row.countsByPriority).reduce((a, b) => a + b, 0)).toBe(row.openCount);
    }

    // Agents are ordered by open count descending so a consumer can take the
    // busiest without re-sorting.
    const counts = census.agents.map((row) => row.openCount);
    expect([...counts].sort((a, b) => b - a)).toEqual(counts);
  }, 120_000);

  it("is complete where the list route silently truncates", async () => {
    const companyId = await seedCompany("Paperclip", "BLO");
    const agentIds = [
      await seedAgent(companyId, "alpha"),
      await seedAgent(companyId, "beta"),
      await seedAgent(companyId, "gamma"),
      await seedAgent(companyId, "delta"),
    ];
    await seedLargePopulation(companyId, agentIds);

    // The defect, reproduced. The route clamps an oversized limit rather than
    // rejecting it...
    expect(clampIssueListLimit(10_000)).toBe(ISSUE_LIST_MAX_LIMIT);
    // ...and the clamped page is a bare array: 1,000 rows out of a larger
    // population, carrying no total and no cursor with which a caller could
    // detect that it was truncated.
    const page = await svc.list(companyId, {
      status: [...OPEN_ISSUE_STATUSES],
      limit: clampIssueListLimit(10_000),
    });
    expect(page).toHaveLength(ISSUE_LIST_MAX_LIMIT);
    expect(Array.isArray(page)).toBe(true);

    const census = await svc.openAssignmentCensus(companyId);
    expect(census.totals.open).toBeGreaterThan(page.length);
    // The census answers the question the page cannot: is this everything?
    expect(census.complete).toBe(true);
  }, 120_000);

  /**
   * Pushes the agent grouping past OPEN_ASSIGNMENT_CENSUS_MAX_AGENT_GROUPS so
   * the truncation branch is exercised for real. One open issue per agent, so
   * `openCount` is 1 everywhere and the arithmetic below is unambiguous.
   */
  async function seedAgentsPastGroupBound(companyId: string, agentCount: number) {
    const agentRows: Array<typeof agents.$inferInsert> = [];
    const issueRows: Array<typeof issues.$inferInsert> = [];
    for (let i = 0; i < agentCount; i += 1) {
      const agentId = randomUUID();
      agentRows.push({ id: agentId, companyId, name: `agent-${i}`, role: "engineer" });
      issueRows.push({
        companyId,
        assigneeAgentId: agentId,
        title: `open ${i}`,
        identifier: `BOUND-${i}`,
        priority: "medium",
        status: "todo",
      });
    }
    for (let i = 0; i < agentRows.length; i += 500) {
      await db.insert(agents).values(agentRows.slice(i, i + 500));
    }
    for (let i = 0; i < issueRows.length; i += 500) {
      await db.insert(issues).values(issueRows.slice(i, i + 500));
    }
  }

  /**
   * BLO-22785 review follow-up. The documented reconstruction invariant
   * (`sum(agents[].openCount) === totals.openAssignedToAgents`) is false on
   * the endpoint's own advertised truncation path, because `totals` is
   * company-wide while `agents` is bounded. The contract now scopes that
   * invariant to `complete: true`; this pins the truncated shape so the
   * unconditional wording cannot come back.
   */
  it("keeps totals company-wide when the agent grouping is truncated, and says so", async () => {
    const companyId = await seedCompany("Paperclip", "BLO");
    const agentCount = OPEN_ASSIGNMENT_CENSUS_MAX_AGENT_GROUPS + 25;
    await seedAgentsPastGroupBound(companyId, agentCount);

    const census = await svc.openAssignmentCensus(companyId);

    // The completion signal is explicit rather than a silent short array.
    expect(census.complete).toBe(false);
    expect(census.truncated).toBe(true);

    // Exactly the bound is returned — never the +1 probe row used to detect
    // that there was more.
    expect(census.agents).toHaveLength(OPEN_ASSIGNMENT_CENSUS_MAX_AGENT_GROUPS);
    // ...and the true group count is still reported, so a consumer can tell
    // precisely how many groups it is missing.
    expect(census.agentGroupCount).toBe(agentCount);
    expect(census.agentGroupCount - census.agents.length).toBe(25);

    // Totals are company-wide and exact despite truncation.
    expect(census.totals.openAssignedToAgents).toBe(agentCount);
    expect(census.totals.open).toBe(agentCount);
    expect(census.totals.agentsWithOpenWork).toBe(agentCount);

    // The invariant the contract used to claim unconditionally: it does NOT
    // hold here, and the sum is a strict lower bound. A consumer asserting it
    // without gating on `complete` would fail against a correct response.
    const summed = census.agents.reduce((total, row) => total + row.openCount, 0);
    expect(summed).toBe(OPEN_ASSIGNMENT_CENSUS_MAX_AGENT_GROUPS);
    expect(summed).toBeLessThan(census.totals.openAssignedToAgents);

    // The split-total invariant is unconditional — it is computed over the
    // whole open scope, not the returned groups, so truncation cannot break it.
    expect(
      census.totals.openAssignedToAgents
      + census.totals.openAssignedToUsers
      + census.totals.openUnassigned,
    ).toBe(census.totals.open);

    // No duplicate groups in the truncated prefix.
    expect(new Set(census.agents.map((row) => row.assigneeAgentId)).size)
      .toBe(census.agents.length);
  }, 180_000);

  it("cannot double-count or drop issues while the collection is mutating", async () => {
    const companyId = await seedCompany("Paperclip", "BLO");
    const agentIds = [
      await seedAgent(companyId, "alpha"),
      await seedAgent(companyId, "beta"),
      await seedAgent(companyId, "gamma"),
      await seedAgent(companyId, "delta"),
    ];
    await seedLargePopulation(companyId, agentIds);

    // Hammer the collection while censuses run. Under a torn multi-round-trip
    // read the internal-consistency invariants below fail; under one statement
    // (one MVCC snapshot) they cannot, whatever the interleaving.
    let stop = false;
    const churn = (async () => {
      let n = 0;
      while (!stop) {
        n += 1;
        await db.insert(issues).values({
          companyId,
          assigneeAgentId: agentIds[n % agentIds.length],
          title: `churn ${n}`,
          status: "todo",
          priority: "critical",
        });
        await db
          .update(issues)
          .set({ status: "done" })
          .where(and(eq(issues.companyId, companyId), eq(issues.title, `churn ${n}`)));
        await db
          .update(issues)
          .set({ assigneeAgentId: agentIds[(n + 1) % agentIds.length] })
          .where(and(eq(issues.companyId, companyId), eq(issues.identifier, `SEED-${n}`)));
      }
    })();

    try {
      for (let attempt = 0; attempt < 12; attempt += 1) {
        const census = await svc.openAssignmentCensus(companyId);
        const summed = census.agents.reduce((total, row) => total + row.openCount, 0);
        expect(summed).toBe(census.totals.openAssignedToAgents);
        expect(census.agents).toHaveLength(census.agentGroupCount);
        expect(census.totals.openAssignedToAgents
          + census.totals.openAssignedToUsers
          + census.totals.openUnassigned).toBe(census.totals.open);
        for (const row of census.agents) {
          expect(Object.values(row.countsByStatus).reduce((a, b) => a + b, 0)).toBe(row.openCount);
          expect(Object.values(row.countsByPriority).reduce((a, b) => a + b, 0)).toBe(row.openCount);
        }
      }
    } finally {
      stop = true;
      await churn;
    }
  }, 120_000);

  it("breaks highest-priority ties by oldest createdAt then lowest id", async () => {
    const companyId = await seedCompany("Paperclip", "BLO");
    const agentId = await seedAgent(companyId, "alpha");
    const older = new Date(Date.UTC(2026, 0, 1));
    const newer = new Date(Date.UTC(2026, 0, 2));
    const tieA = "00000000-0000-4000-8000-00000000000a";
    const tieB = "00000000-0000-4000-8000-00000000000b";

    await db.insert(issues).values([
      { id: randomUUID(), companyId, assigneeAgentId: agentId, title: "newer critical", identifier: "T-3", status: "todo", priority: "critical", createdAt: newer },
      { id: tieB, companyId, assigneeAgentId: agentId, title: "tie b", identifier: "T-2", status: "todo", priority: "critical", createdAt: older },
      { id: tieA, companyId, assigneeAgentId: agentId, title: "tie a", identifier: "T-1", status: "todo", priority: "critical", createdAt: older },
      { id: randomUUID(), companyId, assigneeAgentId: agentId, title: "high", identifier: "T-4", status: "todo", priority: "high", createdAt: older },
    ]);

    const census = await svc.openAssignmentCensus(companyId);
    expect(census.agents).toHaveLength(1);
    expect(census.agents[0]!.highestPriority).toBe("critical");
    // Oldest wins over the newer critical; lowest id wins the remaining tie.
    expect(census.agents[0]!.highestPriorityIssue.id).toBe(tieA);
  }, 60_000);

  it("includes routine-execution rows only when asked", async () => {
    const companyId = await seedCompany("Paperclip", "BLO");
    const agentId = await seedAgent(companyId, "alpha");
    await db.insert(issues).values([
      { companyId, assigneeAgentId: agentId, title: "manual", status: "todo", priority: "high" },
      { companyId, assigneeAgentId: agentId, title: "routine", status: "todo", priority: "critical", originKind: "routine_execution" },
    ]);

    const byDefault = await svc.openAssignmentCensus(companyId);
    expect(byDefault.agents[0]!.openCount).toBe(1);
    expect(byDefault.agents[0]!.highestPriority).toBe("high");

    const withRoutines = await svc.openAssignmentCensus(companyId, { includeRoutineExecutions: true });
    expect(withRoutines.agents[0]!.openCount).toBe(2);
    expect(withRoutines.agents[0]!.highestPriority).toBe("critical");
  }, 60_000);

  it("narrows to a requested status subset and echoes it back", async () => {
    const companyId = await seedCompany("Paperclip", "BLO");
    const agentId = await seedAgent(companyId, "alpha");
    await db.insert(issues).values([
      { companyId, assigneeAgentId: agentId, title: "a", status: "todo", priority: "high" },
      { companyId, assigneeAgentId: agentId, title: "b", status: "in_progress", priority: "critical" },
      { companyId, assigneeAgentId: agentId, title: "c", status: "backlog", priority: "critical" },
    ]);

    const census = await svc.openAssignmentCensus(companyId, { status: ["todo", "in_progress"] });
    expect(census.openStatuses).toEqual(["todo", "in_progress"]);
    expect(census.totals.open).toBe(2);
    expect(census.agents[0]!.openCount).toBe(2);
    expect(census.agents[0]!.countsByStatus).toEqual({ todo: 1, in_progress: 1 });
  }, 60_000);

  it("never leaks another company's issues", async () => {
    const companyA = await seedCompany("Alpha Co", "AAA");
    const companyB = await seedCompany("Beta Co", "BBB");
    const agentA = await seedAgent(companyA, "alpha");
    const agentB = await seedAgent(companyB, "beta");
    await db.insert(issues).values([
      { companyId: companyA, assigneeAgentId: agentA, title: "a", status: "todo", priority: "high" },
      { companyId: companyB, assigneeAgentId: agentB, title: "b", status: "todo", priority: "critical" },
      { companyId: companyB, assigneeAgentId: agentB, title: "c", status: "todo", priority: "critical" },
    ]);

    const census = await svc.openAssignmentCensus(companyA);
    expect(census.totals.open).toBe(1);
    expect(census.agents.map((row) => row.assigneeAgentId)).toEqual([agentA]);
  }, 60_000);

  it("returns an empty census rather than failing when a company has no open work", async () => {
    const companyId = await seedCompany("Paperclip", "BLO");
    const agentId = await seedAgent(companyId, "alpha");
    await db.insert(issues).values({
      companyId, assigneeAgentId: agentId, title: "done", status: "done", priority: "critical",
    });

    const census = await svc.openAssignmentCensus(companyId);
    expect(census.agents).toEqual([]);
    expect(census.agentGroupCount).toBe(0);
    expect(census.complete).toBe(true);
    expect(census.totals).toEqual({
      open: 0,
      openAssignedToAgents: 0,
      openAssignedToUsers: 0,
      openUnassigned: 0,
      agentsWithOpenWork: 0,
    });
  }, 60_000);

  it("computes the whole census in a single statement, so it cannot be read torn", async () => {
    const companyId = await seedCompany("Paperclip", "BLO");
    const agentId = await seedAgent(companyId, "alpha");
    await db.insert(issues).values({
      companyId, assigneeAgentId: agentId, title: "a", status: "todo", priority: "high",
    });

    // The completeness guarantee is that ONE statement means one MVCC
    // snapshot. Splitting the totals from the per-agent grouping would
    // reintroduce the tearing this endpoint exists to remove, so pin the
    // round-trip count rather than trusting a comment.
    const executed: unknown[] = [];
    const originalExecute = db.execute.bind(db);
    (db as unknown as { execute: typeof db.execute }).execute = ((query: never) => {
      executed.push(query);
      return originalExecute(query);
    }) as typeof db.execute;
    try {
      await svc.openAssignmentCensus(companyId);
    } finally {
      (db as unknown as { execute: typeof db.execute }).execute = originalExecute;
    }
    expect(executed).toHaveLength(1);
  }, 60_000);
});

describe("open issue statuses", () => {
  it("excludes terminal statuses", () => {
    expect(OPEN_ISSUE_STATUSES).not.toContain("done");
    expect(OPEN_ISSUE_STATUSES).not.toContain("cancelled");
  });

  it("is a stable ordered contract the census echoes back to callers", () => {
    expect([...OPEN_ISSUE_STATUSES]).toEqual([
      "backlog",
      "todo",
      "in_progress",
      "in_review",
      "blocked",
    ]);
  });
});

describeEmbeddedPostgres("GET /companies/:companyId/issues/open-assignment-census", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let agentId!: string;

  function appAs(actor: Express.Request["actor"]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", issueRoutes(db, {} as never));
    app.use(errorHandler);
    return app;
  }

  const boardActorFor = (companyIds: string[]): Express.Request["actor"] => ({
    type: "board",
    userId: "board-user",
    companyIds,
    memberships: companyIds.map((id) => ({
      companyId: id,
      membershipRole: "operator" as const,
      status: "active" as const,
    })),
    isInstanceAdmin: true,
    source: "local_implicit",
  }) as Express.Request["actor"];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-census-routes-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  beforeEach(async () => {
    companyId = randomUUID();
    agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "BLO",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({ id: agentId, companyId, name: "alpha", role: "engineer" });
    await db.insert(issues).values([
      { companyId, assigneeAgentId: agentId, title: "a", status: "todo", priority: "high" },
      { companyId, assigneeAgentId: agentId, title: "b", status: "in_progress", priority: "critical" },
      { companyId, title: "c", status: "backlog", priority: "low" },
      { companyId, assigneeAgentId: agentId, title: "d", status: "done", priority: "critical" },
    ]);
  });

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("returns the census with an explicit completion signal", async () => {
    const res = await request(appAs(boardActorFor([companyId])))
      .get(`/api/companies/${companyId}/issues/open-assignment-census`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.complete).toBe(true);
    expect(res.body.truncated).toBe(false);
    expect(res.body.companyId).toBe(companyId);
    expect(res.body.totals).toMatchObject({ open: 3, openAssignedToAgents: 2, openUnassigned: 1 });
    expect(res.body.agents).toHaveLength(1);
    expect(res.body.agents[0]).toMatchObject({
      assigneeAgentId: agentId,
      openCount: 2,
      highestPriority: "critical",
    });
    expect(res.body.agents[0].highestPriorityIssue.title).toBe("b");
  });

  it("narrows to a requested open status subset", async () => {
    const res = await request(appAs(boardActorFor([companyId])))
      .get(`/api/companies/${companyId}/issues/open-assignment-census`)
      .query({ status: "in_progress" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.openStatuses).toEqual(["in_progress"]);
    expect(res.body.totals.open).toBe(1);
  });

  it("rejects pagination parameters instead of silently ignoring them", async () => {
    for (const query of [{ limit: "10000" }, { offset: "1000" }]) {
      const res = await request(appAs(boardActorFor([companyId])))
        .get(`/api/companies/${companyId}/issues/open-assignment-census`)
        .query(query);
      expect(res.status, JSON.stringify(res.body)).toBe(400);
      expect(res.body.error).toMatch(/not paginated/);
    }
  });

  it("rejects a terminal status rather than reporting an empty census", async () => {
    const res = await request(appAs(boardActorFor([companyId])))
      .get(`/api/companies/${companyId}/issues/open-assignment-census`)
      .query({ status: "todo,done" });

    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error).toMatch(/status must be a subset/);
  });

  it("keeps company isolation: an agent key from another company is refused", async () => {
    // A `local_implicit` board actor is the trusted local-dev bypass and is
    // exempt from company scoping by design, so it would assert nothing here.
    // An agent key is the boundary that actually has to hold.
    const foreignAgent = {
      type: "agent",
      agentId: randomUUID(),
      companyId: randomUUID(),
      runId: randomUUID(),
      source: "agent_jwt",
    } as unknown as Express.Request["actor"];

    const res = await request(appAs(foreignAgent))
      .get(`/api/companies/${companyId}/issues/open-assignment-census`);

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.agents).toBeUndefined();
  });
});
