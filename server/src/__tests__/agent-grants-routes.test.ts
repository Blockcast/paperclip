import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  createDb,
  principalPermissionGrants,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

vi.hoisted(() => {
  process.env.PAPERCLIP_HOME = "/tmp/paperclip-test-home";
  process.env.PAPERCLIP_INSTANCE_ID = "vitest";
  process.env.PAPERCLIP_LOG_DIR = "/tmp/paperclip-test-home/logs";
  process.env.PAPERCLIP_IN_WORKTREE = "false";
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

async function createApp(db: Db, companyId: string, userId: string) {
  const { accessRoutes } = await import("../routes/access.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = {
      type: "board",
      userId,
      source: "session",
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "owner", status: "active" }],
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", accessRoutes(db, {
    deploymentMode: "authenticated",
    deploymentExposure: "private",
    bindHost: "127.0.0.1",
    allowedHostnames: [],
  }));
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.status ?? 500).json({ error: err.message ?? "Internal server error" });
  });
  return app;
}

async function seedCompanyOwnerAndAgent(db: Db) {
  const company = await db
    .insert(companies)
    .values({
      name: `Agent Grants ${randomUUID()}`,
      issuePrefix: `AG${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    })
    .returning()
    .then((rows) => rows[0]!);
  const ownerId = `owner-${randomUUID()}`;
  await db.insert(companyMemberships).values({
    companyId: company.id,
    principalType: "user",
    principalId: ownerId,
    status: "active",
    membershipRole: "owner",
  });
  await db.insert(principalPermissionGrants).values({
    companyId: company.id,
    principalType: "user",
    principalId: ownerId,
    permissionKey: "users:manage_permissions",
    grantedByUserId: ownerId,
  });
  const agent = await db
    .insert(agents)
    .values({
      companyId: company.id,
      name: `Agent ${randomUUID()}`,
      role: "engineer",
      status: "active",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    })
    .returning()
    .then((rows) => rows[0]!);
  const membership = await db
    .insert(companyMemberships)
    .values({
      companyId: company.id,
      principalType: "agent",
      principalId: agent.id,
      status: "active",
      membershipRole: "member",
    })
    .returning()
    .then((rows) => rows[0]!);
  return { company, ownerId, agent, membership };
}

describeEmbeddedPostgres("additive agent grant route", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-grants-routes-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("adds and removes one grant idempotently without replacing or reattributing unrelated grants", async () => {
    const { company, ownerId, agent, membership } = await seedCompanyOwnerAndAgent(db);
    await db.insert(principalPermissionGrants).values({
      companyId: company.id,
      principalType: "agent",
      principalId: agent.id,
      permissionKey: "tasks:assign",
      grantedByUserId: "original-grantor",
    });
    const app = await createApp(db, company.id, ownerId);
    const path = `/api/companies/${company.id}/agents/${agent.id}/grants`;

    const added = await request(app).patch(path).send({
      operation: "add",
      permissionKey: "agents:configure",
      scope: { environmentIds: ["environment-1"] },
    });

    expect(added.status, JSON.stringify(added.body)).toBe(200);
    expect(added.body.membership).toMatchObject({ id: membership.id, principalId: agent.id });
    expect(added.body.grants).toEqual(expect.arrayContaining([
      expect.objectContaining({
        permissionKey: "agents:configure",
        scope: { environmentIds: ["environment-1"] },
        grantedByUserId: ownerId,
      }),
      expect.objectContaining({
        permissionKey: "tasks:assign",
        grantedByUserId: "original-grantor",
      }),
    ]));

    const firstGrant = await db
      .select()
      .from(principalPermissionGrants)
      .where(and(
        eq(principalPermissionGrants.companyId, company.id),
        eq(principalPermissionGrants.principalType, "agent"),
        eq(principalPermissionGrants.principalId, agent.id),
        eq(principalPermissionGrants.permissionKey, "agents:configure"),
      ))
      .then((rows) => rows[0]!);

    const replayed = await request(app).patch(path).send({
      operation: "add",
      permissionKey: "agents:configure",
      scope: { environmentIds: ["different-replay-scope"] },
    });
    expect(replayed.status, JSON.stringify(replayed.body)).toBe(200);

    const afterReplay = await db
      .select()
      .from(principalPermissionGrants)
      .where(and(
        eq(principalPermissionGrants.companyId, company.id),
        eq(principalPermissionGrants.principalType, "agent"),
        eq(principalPermissionGrants.principalId, agent.id),
        eq(principalPermissionGrants.permissionKey, "agents:configure"),
      ));
    expect(afterReplay).toHaveLength(1);
    expect(afterReplay[0]).toMatchObject({
      id: firstGrant.id,
      scope: { environmentIds: ["environment-1"] },
      grantedByUserId: ownerId,
      createdAt: firstGrant.createdAt,
    });

    const removed = await request(app).patch(path).send({
      operation: "remove",
      permissionKey: "agents:configure",
    });
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect(removed.body.grants).toEqual([
      expect.objectContaining({ permissionKey: "tasks:assign", grantedByUserId: "original-grantor" }),
    ]);

    const auditRows = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.companyId, company.id), eq(activityLog.entityId, agent.id)));
    expect(auditRows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        actorType: "user",
        actorId: ownerId,
        action: "agent.permission_grant_added",
        details: expect.objectContaining({ permissionKey: "agents:configure", changed: true }),
      }),
      expect.objectContaining({
        actorId: ownerId,
        action: "agent.permission_grant_added",
        details: expect.objectContaining({ permissionKey: "agents:configure", changed: false }),
      }),
      expect.objectContaining({
        actorId: ownerId,
        action: "agent.permission_grant_removed",
        details: expect.objectContaining({ permissionKey: "agents:configure", changed: true }),
      }),
    ]));
  }, 120_000);

  it("rejects callers without permission and agents from another company", async () => {
    const authorized = await seedCompanyOwnerAndAgent(db);
    const foreign = await seedCompanyOwnerAndAgent(db);
    const unprivilegedUserId = `member-${randomUUID()}`;
    await db.insert(companyMemberships).values({
      companyId: authorized.company.id,
      principalType: "user",
      principalId: unprivilegedUserId,
      status: "active",
      membershipRole: "operator",
    });

    const denied = await request(await createApp(db, authorized.company.id, unprivilegedUserId))
      .patch(`/api/companies/${authorized.company.id}/agents/${authorized.agent.id}/grants`)
      .send({ operation: "add", permissionKey: "agents:configure" });
    expect(denied.status, JSON.stringify(denied.body)).toBe(403);

    const crossCompany = await request(await createApp(db, authorized.company.id, authorized.ownerId))
      .patch(`/api/companies/${authorized.company.id}/agents/${foreign.agent.id}/grants`)
      .send({ operation: "add", permissionKey: "agents:configure" });
    expect(crossCompany.status, JSON.stringify(crossCompany.body)).toBe(404);

    const foreignGrant = await db
      .select()
      .from(principalPermissionGrants)
      .where(and(
        eq(principalPermissionGrants.companyId, foreign.company.id),
        eq(principalPermissionGrants.principalType, "agent"),
        eq(principalPermissionGrants.principalId, foreign.agent.id),
        eq(principalPermissionGrants.permissionKey, "agents:configure"),
      ));
    expect(foreignGrant).toHaveLength(0);
  });

  it("leaves the human-member permission replacement route unchanged", async () => {
    const { company, ownerId } = await seedCompanyOwnerAndAgent(db);
    const member = await db
      .insert(companyMemberships)
      .values({
        companyId: company.id,
        principalType: "user",
        principalId: `member-${randomUUID()}`,
        status: "active",
        membershipRole: "operator",
      })
      .returning()
      .then((rows) => rows[0]!);

    const response = await request(await createApp(db, company.id, ownerId))
      .patch(`/api/companies/${company.id}/members/${member.id}/permissions`)
      .send({ grants: [{ permissionKey: "tasks:assign" }] });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toMatchObject({ id: member.id, principalType: "user" });
    expect(response.body.grants).toEqual([
      expect.objectContaining({ permissionKey: "tasks:assign", grantedByUserId: ownerId }),
    ]);
  });
});
