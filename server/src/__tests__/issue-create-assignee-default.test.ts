import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, companyMemberships, createDb, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";

/**
 * BLO-43103 — every inbox selects by assignee, never by status, so a
 * non-terminal issue with both assignee columns null is reachable by no routing
 * path at all: mutable by anyone, discoverable by nobody, and invisible to the
 * very sweeps that would otherwise bounce it. `POST /api/issues` used to permit
 * exactly that, and 74 live `todo` rows were sitting in it on 2026-10-10 with
 * zero wake paths between them.
 *
 * These assert on the PERSISTED row rather than on the helper's return value:
 * the defect was never the branch logic, it was that no branch existed on the
 * write path, so a test that cannot see the column cannot see the bug.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue create assignee-default tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issueService.create assignee default", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-create-assignee-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, 120_000);

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(defaultResponsibleUserId: string | null = null) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${Math.floor(Math.random() * 900 + 100)}`,
      requireBoardApprovalForNewAgents: false,
      ...(defaultResponsibleUserId ? { defaultResponsibleUserId } : {}),
    });
    return companyId;
  }

  async function seedAgent(companyId: string, name: string) {
    const agentId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId, name, role: "engineer" });
    return agentId;
  }

  async function seedUser(companyId: string, userId: string) {
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: "active",
    });
    return userId;
  }

  it("defaults an agent-filed ownerless create to the creating agent", async () => {
    const companyId = await seedCompany();
    const filerAgentId = await seedAgent(companyId, "filer");

    const issue = await svc.create(companyId, {
      title: "agent-filed, no assignee supplied",
      status: "todo",
      createdByAgentId: filerAgentId,
    });

    const [persisted] = await db.select().from(issues).where(eq(issues.id, issue.id));
    expect(persisted?.assigneeAgentId).toBe(filerAgentId);
    // Exactly one assignee column: the branch that sets the other one must not
    // also have run (BLO-42855 is that same field pair deadlocking one layer up).
    expect(persisted?.assigneeUserId).toBeNull();
  });

  it("defaults an operator-filed ownerless create to the responsible user", async () => {
    const companyId = await seedCompany();

    const issue = await svc.create(companyId, {
      title: "operator-filed, no creating agent",
      status: "todo",
      // The two rows that arrived ownerless on 2026-10-10 were both of this
      // shape: a human filer, so `createdByAgentId` is null and the
      // creating-agent branch cannot cover them.
      createdByUserId: "operator-1",
    });

    const [persisted] = await db.select().from(issues).where(eq(issues.id, issue.id));
    expect(persisted?.responsibleUserId).toBe("operator-1");
    expect(persisted?.assigneeUserId).toBe("operator-1");
    expect(persisted?.assigneeAgentId).toBeNull();
  });

  it("falls back to the company default responsible user when nothing else identifies an owner", async () => {
    const companyId = await seedCompany("operator-1");

    // The shape every alertmanager row has: no creating agent (0 of 7,564 live
    // rows carry one) and nothing that resolves a responsible user. 2,919 live
    // rows were created this way, so a throw here would refuse to record the
    // alert rather than record it with an owner.
    const issue = await svc.create(companyId, {
      title: "plugin-filed, no agent and no responsible user",
      status: "todo",
      originKind: "plugin:paperclip-plugin-alertmanager",
    });

    const [persisted] = await db.select().from(issues).where(eq(issues.id, issue.id));
    expect(persisted?.responsibleUserId).toBeNull();
    expect(persisted?.assigneeUserId).toBe("operator-1");
    expect(persisted?.assigneeAgentId).toBeNull();
  });

  it("rejects a create when the company has no default responsible user either", async () => {
    const companyId = await seedCompany();

    await expect(
      svc.create(companyId, { title: "nobody to own this", status: "todo" }),
    ).rejects.toMatchObject({ status: 422 });

    // The reject must not leave a half-created row behind.
    const rows = await db.select().from(issues);
    expect(rows).toHaveLength(0);
  });

  it("never overwrites an assignee the caller supplied", async () => {
    const companyId = await seedCompany();
    const filerAgentId = await seedAgent(companyId, "filer");
    const assigneeAgentId = await seedAgent(companyId, "assignee");
    const assigneeUserId = await seedUser(companyId, "operator-1");

    const agentAssigned = await svc.create(companyId, {
      title: "explicit agent assignee",
      status: "todo",
      assigneeAgentId,
      createdByAgentId: filerAgentId,
    });
    const [persistedAgentAssigned] = await db.select().from(issues).where(eq(issues.id, agentAssigned.id));
    expect(persistedAgentAssigned?.assigneeAgentId).toBe(assigneeAgentId);
    expect(persistedAgentAssigned?.assigneeUserId).toBeNull();

    // The user side matters independently: the creating-agent branch is checked
    // first, so an explicit user assignee is the case that would be clobbered
    // by a default applied in the wrong order.
    const userAssigned = await svc.create(companyId, {
      title: "explicit user assignee",
      status: "todo",
      assigneeUserId,
      createdByAgentId: filerAgentId,
    });
    const [persistedUserAssigned] = await db.select().from(issues).where(eq(issues.id, userAssigned.id));
    expect(persistedUserAssigned?.assigneeUserId).toBe(assigneeUserId);
    expect(persistedUserAssigned?.assigneeAgentId).toBeNull();
  });
});
