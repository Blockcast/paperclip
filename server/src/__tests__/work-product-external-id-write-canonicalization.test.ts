import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  issues,
  issueWorkProducts,
} from "@paperclipai/db";
import { canonicalizeWorkProductExternalIdForWrite } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

/**
 * PEN-6119. `work-products/by-external-id` normalises the key it is ASKED for
 * and refuses anything that is not `owner/repo#123`. Nothing normalised the key
 * that was WRITTEN, so a run registering its own pull request with the value it
 * had to hand -- the URL it had just printed -- stored a row no lookup could
 * reach: `owners: []`, `withheldForAuthorizationCount: 0`, which reads exactly
 * like "this pull request is unowned".
 *
 * The acceptance test is therefore end-to-end rather than a parse assertion:
 * write by URL, then read back through the lookup the caller would actually use.
 */

vi.hoisted(() => {
  process.env.PAPERCLIP_HOME = "/tmp/paperclip-test-home";
  process.env.PAPERCLIP_INSTANCE_ID = "vitest";
  process.env.PAPERCLIP_LOG_DIR = "/tmp/paperclip-test-home/logs";
  process.env.PAPERCLIP_IN_WORKTREE = "false";
});

vi.mock("../services/issue-assignment-wakeup.js", () => ({
  queueIssueAssignmentWakeup: vi.fn(),
}));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

const PR_URL = "https://github.com/Blockcast/paperclip/pull/3205";
const PR_CANONICAL = "Blockcast/paperclip#3205";

/**
 * The pure arm. It runs with or without embedded Postgres, and it is where the
 * `undefined` / `null` branches live -- an absent key and a deliberately empty
 * external identity are both outside migration 0216's partial unique index, so
 * neither is in the key space this guards and neither may be rewritten.
 */
describe("canonicalizeWorkProductExternalIdForWrite", () => {
  it("normalises a GitHub pull-request URL on a github pull_request", () => {
    expect(
      canonicalizeWorkProductExternalIdForWrite({
        type: "pull_request",
        provider: "github",
        externalId: PR_URL,
      }),
    ).toEqual({ ok: true, externalId: PR_CANONICAL });
  });

  it("refuses a value with no canonical reading, naming the canonical form", () => {
    const decision = canonicalizeWorkProductExternalIdForWrite({
      type: "pull_request",
      provider: "github",
      externalId: "2124",
    });
    expect(decision.ok).toBe(false);
    // A bare number is the one non-canonical shape measured in the live
    // population (one row, 2026-09-26). It names a different pull request in
    // every repository, so there is nothing to normalise it TO -- which is why
    // the guard refuses rather than guessing.
    if (!decision.ok) {
      expect(decision.message).toContain("owner/repo#123");
      expect(decision.message).toContain("2124");
    }
  });

  it("passes an absent key through as absent, and an explicit null through as null", () => {
    expect(
      canonicalizeWorkProductExternalIdForWrite({
        type: "pull_request",
        provider: "github",
        externalId: undefined,
      }),
    ).toEqual({ ok: true, externalId: undefined });
    expect(
      canonicalizeWorkProductExternalIdForWrite({
        type: "pull_request",
        provider: "github",
        externalId: null,
      }),
    ).toEqual({ ok: true, externalId: null });
  });

  // Scope, stated as two separate assertions because a single case that varies
  // both type and provider passes against a guard that only checks one.
  it("is scoped by type: a non-pull_request key is never rewritten or refused", () => {
    expect(
      canonicalizeWorkProductExternalIdForWrite({
        type: "artifact",
        provider: "github",
        externalId: PR_URL,
      }),
    ).toEqual({ ok: true, externalId: PR_URL });
  });

  it("is scoped by provider: a non-github pull_request key is never rewritten or refused", () => {
    expect(
      canonicalizeWorkProductExternalIdForWrite({
        type: "pull_request",
        provider: "gitlab",
        externalId: "group/project!7",
      }),
    ).toEqual({ ok: true, externalId: "group/project!7" });
  });
});

function agentActor(companyId: string, agentId: string): Express.Request["actor"] {
  return { type: "agent", agentId, companyId, runId: undefined, source: "agent_jwt" };
}

async function createApp(db: Db, actor: Express.Request["actor"]) {
  process.env.PAPERCLIP_LOG_DIR = "/tmp/paperclip-test-home/logs";
  process.env.PAPERCLIP_IN_WORKTREE = "false";
  const { issueRoutes } = await import("../routes/issues.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", issueRoutes(db, {} as any));
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.status ?? 500).json({ error: err.message ?? "Internal server error" });
  });
  return app;
}

async function seedCompany(db: Db, label: string) {
  return db
    .insert(companies)
    .values({
      name: `Work Product Write ${label}`,
      issuePrefix: `WW${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    })
    .returning()
    .then((rows) => rows[0]!);
}

async function seedAgent(db: Db, companyId: string) {
  return db
    .insert(agents)
    .values({
      companyId,
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
}

async function seedIssue(db: Db, company: { id: string; issuePrefix: string }, n: number) {
  return db
    .insert(issues)
    .values({
      companyId: company.id,
      identifier: `${company.issuePrefix}-${n}`,
      title: `Owning row ${n}`,
      status: "in_progress",
      priority: "medium",
    })
    .returning()
    .then((rows) => rows[0]!);
}

describeEmbeddedPostgres("work-product external-id write canonicalization", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-work-product-write-");
    db = createDb(tempDb.connectionString);
    await import("../routes/issues.js");
  }, 180_000);

  afterEach(async () => {
    // The write routes log activity, which the lookup-only sibling suite never
    // does -- so this FK has to be cleared before the agents it references.
    await db.delete(activityLog);
    await db.delete(issueWorkProducts);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  // The acceptance criterion, end to end: registered by URL, found by the
  // lookup. Before this change the POST succeeded, the lookup returned
  // `owners: []`, and nothing in either response said why.
  it("a pull request registered by URL is afterwards reachable from by-external-id", async () => {
    const company = await seedCompany(db, "Reachable");
    const agent = await seedAgent(db, company.id);
    const issue = await seedIssue(db, company, 1);
    const app = await createApp(db, agentActor(company.id, agent.id));

    const created = await request(app)
      .post(`/api/issues/${issue.id}/work-products`)
      .send({
        type: "pull_request",
        provider: "github",
        externalId: PR_URL,
        title: "PR #3205",
        url: PR_URL,
      });

    expect(created.status).toBe(201);
    expect(created.body.externalId).toBe(PR_CANONICAL);

    const lookup = await request(app)
      .get(`/api/companies/${company.id}/work-products/by-external-id`)
      .query({ externalId: PR_CANONICAL });

    expect(lookup.status).toBe(200);
    expect(lookup.body.owners).toHaveLength(1);
    expect(lookup.body.owners[0].issueId).toBe(issue.id);
    // An agent-asserted row, which is the only kind this defect could reach:
    // the webhook composes `owner/repo#n` itself and was never affected.
    expect(lookup.body.owners[0].provenance).toBe("asserted");
  }, 120_000);

  it("refuses a pull-request key that has no canonical reading, and writes nothing", async () => {
    const company = await seedCompany(db, "Refused");
    const agent = await seedAgent(db, company.id);
    const issue = await seedIssue(db, company, 1);
    const app = await createApp(db, agentActor(company.id, agent.id));

    const res = await request(app)
      .post(`/api/issues/${issue.id}/work-products`)
      .send({
        type: "pull_request",
        provider: "github",
        externalId: "2124",
        title: "PR 2124",
        url: "https://github.com/Blockcast/penstock-llm-proxy-core/pull/2124",
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("work_product_external_id_not_canonical");
    expect(res.body.error).toContain("owner/repo#123");
    // A refusal that still wrote the row would be the worst of both.
    expect(await db.select().from(issueWorkProducts)).toHaveLength(0);
  }, 120_000);

  // THE ACROSS-THE-BOARD CONTROL. This case is a GitHub pull-request URL
  // verbatim, on a type that is not `pull_request`. It fails the moment the
  // transform stops being scoped by type -- which is the mistake the issue
  // named, and the one a reader of the guard is most likely to "simplify" into.
  it("leaves a non-pull_request external id byte-identical, even one shaped like a PR URL", async () => {
    const company = await seedCompany(db, "Scoped");
    const agent = await seedAgent(db, company.id);
    const issue = await seedIssue(db, company, 1);
    const app = await createApp(db, agentActor(company.id, agent.id));

    const res = await request(app)
      .post(`/api/issues/${issue.id}/work-products`)
      .send({
        type: "artifact",
        provider: "github",
        externalId: PR_URL,
        title: "An artifact that merely looks like a PR",
      });

    expect(res.status).toBe(201);
    expect(res.body.externalId).toBe(PR_URL);
  }, 120_000);

  // The two external-id shapes other types actually carry in this company,
  // measured 2026-11-08: an attachment uuid on `document`, and a
  // repo-relative path at a commit on `artifact`. Both are non-canonical and
  // both are correct; a guard applied across the board would 400 them.
  it("leaves the external-id shapes other work-product types really use alone", async () => {
    const company = await seedCompany(db, "OtherTypes");
    const agent = await seedAgent(db, company.id);
    const issue = await seedIssue(db, company, 1);
    const app = await createApp(db, agentActor(company.id, agent.id));

    const documentId = randomUUID();
    const asDocument = await request(app)
      .post(`/api/issues/${issue.id}/work-products`)
      .send({ type: "document", provider: "paperclip", externalId: documentId, title: "A document" });
    expect(asDocument.status).toBe(201);
    expect(asDocument.body.externalId).toBe(documentId);

    const artifactKey = "Blockcast/penstock-llm-proxy-core:docs/design/pen-3861@bbdf2f96";
    const asArtifact = await request(app)
      .post(`/api/issues/${issue.id}/work-products`)
      .send({ type: "artifact", provider: "github", externalId: artifactKey, title: "Design doc" });
    expect(asArtifact.status).toBe(201);
    expect(asArtifact.body.externalId).toBe(artifactKey);
  }, 120_000);

  it("leaves a non-github pull_request key alone", async () => {
    const company = await seedCompany(db, "OtherProvider");
    const agent = await seedAgent(db, company.id);
    const issue = await seedIssue(db, company, 1);
    const app = await createApp(db, agentActor(company.id, agent.id));

    const res = await request(app)
      .post(`/api/issues/${issue.id}/work-products`)
      .send({
        type: "pull_request",
        provider: "gitlab",
        externalId: "group/project!7",
        title: "A GitLab merge request",
      });

    expect(res.status).toBe(201);
    expect(res.body.externalId).toBe("group/project!7");
  }, 120_000);

  it("normalises a URL written by PATCH, and refuses one with no canonical reading", async () => {
    const company = await seedCompany(db, "Patch");
    const agent = await seedAgent(db, company.id);
    const issue = await seedIssue(db, company, 1);
    const app = await createApp(db, agentActor(company.id, agent.id));

    const created = await request(app)
      .post(`/api/issues/${issue.id}/work-products`)
      .send({ type: "pull_request", provider: "github", externalId: "Blockcast/paperclip#1", title: "PR #1" });
    expect(created.status).toBe(201);

    // The PATCH body carries neither `type` nor `provider` -- the route resolves
    // both from the stored row, which is why this guard cannot live in the
    // schema the PATCH is validated against.
    const patched = await request(app)
      .patch(`/api/work-products/${created.body.id}`)
      .send({ externalId: PR_URL });
    expect(patched.status).toBe(200);
    expect(patched.body.externalId).toBe(PR_CANONICAL);

    const lookup = await request(app)
      .get(`/api/companies/${company.id}/work-products/by-external-id`)
      .query({ externalId: PR_CANONICAL });
    expect(lookup.body.owners).toHaveLength(1);

    const refused = await request(app)
      .patch(`/api/work-products/${created.body.id}`)
      .send({ externalId: "2124" });
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe("work_product_external_id_not_canonical");
  }, 120_000);

  // The guard judges the value a request WRITES, not the row it lands on.
  // Judging the row would make every legacy non-canonical row uneditable --
  // a title fix refused because of a field the request never mentioned.
  it("does not refuse an unrelated edit to a row whose stored key is already non-canonical", async () => {
    const company = await seedCompany(db, "Legacy");
    const agent = await seedAgent(db, company.id);
    const issue = await seedIssue(db, company, 1);
    const [legacy] = await db
      .insert(issueWorkProducts)
      .values({
        companyId: company.id,
        issueId: issue.id,
        type: "pull_request",
        provider: "github",
        externalId: "2124",
        title: "Written before this guard existed",
        status: "active",
      })
      .returning();
    const app = await createApp(db, agentActor(company.id, agent.id));

    const res = await request(app)
      .patch(`/api/work-products/${legacy!.id}`)
      .send({ title: "Retitled" });

    expect(res.status).toBe(200);
    expect(res.body.title).toBe("Retitled");
    expect(res.body.externalId).toBe("2124");
  }, 120_000);

  // The guard fires on the scope CHANGING, not on the body naming `type`. A
  // request that re-sends the type a legacy row already has moves nothing, and
  // refusing it would make the row uneditable for the reason the test above
  // rules out -- just with one more key in the body.
  it("does not refuse an edit that re-sends the type a non-canonical row already has", async () => {
    const company = await seedCompany(db, "ScopeNoop");
    const agent = await seedAgent(db, company.id);
    const issue = await seedIssue(db, company, 1);
    const [legacy] = await db
      .insert(issueWorkProducts)
      .values({
        companyId: company.id,
        issueId: issue.id,
        type: "pull_request",
        provider: "github",
        externalId: "2124",
        title: "Written before this guard existed",
        status: "active",
      })
      .returning();
    const app = await createApp(db, agentActor(company.id, agent.id));

    const res = await request(app)
      .patch(`/api/work-products/${legacy!.id}`)
      .send({ title: "Retitled", type: "pull_request" });

    expect(res.status).toBe(200);
    expect(res.body.title).toBe("Retitled");
    expect(res.body.externalId).toBe("2124");
  }, 120_000);

  // `type` and `provider` are patchable on their own, so a PATCH that names
  // NEITHER `externalId` nor anything else about the key can still move a row
  // INTO the guarded `(github, pull_request)` space -- landing a stored key the
  // lookup can never ask for, which is this PR's own defect one field over.
  it("refuses a type-only PATCH that moves a non-canonical key into the pull_request space", async () => {
    const company = await seedCompany(db, "ScopeType");
    const agent = await seedAgent(db, company.id);
    const issue = await seedIssue(db, company, 1);
    const app = await createApp(db, agentActor(company.id, agent.id));

    // A real `artifact` external-id shape, which is legitimate for an artifact
    // and meaningless as a pull-request key.
    const created = await request(app)
      .post(`/api/issues/${issue.id}/work-products`)
      .send({
        type: "artifact",
        provider: "github",
        externalId: "Blockcast/paperclip:server/src/routes/issues.ts@e51da62",
        title: "A file at a commit",
      });
    expect(created.status).toBe(201);

    const moved = await request(app)
      .patch(`/api/work-products/${created.body.id}`)
      .send({ type: "pull_request" });

    expect(moved.status).toBe(400);
    expect(moved.body.code).toBe("work_product_external_id_not_canonical");
    const [row] = await db.select().from(issueWorkProducts);
    expect(row!.type).toBe("artifact");
    expect(row!.externalId).toBe("Blockcast/paperclip:server/src/routes/issues.ts@e51da62");
  }, 120_000);

  it("refuses a provider-only PATCH that moves a non-github pull_request key into the github space", async () => {
    const company = await seedCompany(db, "ScopeProvider");
    const agent = await seedAgent(db, company.id);
    const issue = await seedIssue(db, company, 1);
    const app = await createApp(db, agentActor(company.id, agent.id));

    const created = await request(app)
      .post(`/api/issues/${issue.id}/work-products`)
      .send({ type: "pull_request", provider: "gitlab", externalId: "group/project!7", title: "MR !7" });
    expect(created.status).toBe(201);
    expect(created.body.externalId).toBe("group/project!7");

    const moved = await request(app)
      .patch(`/api/work-products/${created.body.id}`)
      .send({ provider: "github" });

    expect(moved.status).toBe(400);
    expect(moved.body.code).toBe("work_product_external_id_not_canonical");
    const [row] = await db.select().from(issueWorkProducts);
    expect(row!.provider).toBe("gitlab");
  }, 120_000);

  // The same scope move, with a key that DOES have a canonical reading: the row
  // arrives in the guarded space reachable, rather than being refused.
  it("canonicalises the stored key on a type-only PATCH when that key has a canonical reading", async () => {
    const company = await seedCompany(db, "ScopeRepair");
    const agent = await seedAgent(db, company.id);
    const issue = await seedIssue(db, company, 1);
    const app = await createApp(db, agentActor(company.id, agent.id));

    const created = await request(app)
      .post(`/api/issues/${issue.id}/work-products`)
      .send({ type: "artifact", provider: "github", externalId: PR_URL, title: "Filed as an artifact" });
    expect(created.status).toBe(201);
    expect(created.body.externalId).toBe(PR_URL);

    const moved = await request(app)
      .patch(`/api/work-products/${created.body.id}`)
      .send({ type: "pull_request" });

    expect(moved.status).toBe(200);
    expect(moved.body.externalId).toBe(PR_CANONICAL);

    const lookup = await request(app)
      .get(`/api/companies/${company.id}/work-products/by-external-id`)
      .query({ externalId: PR_CANONICAL });
    expect(lookup.body.owners).toHaveLength(1);
  }, 120_000);

  // The must-not-fire control for the two refusals above: a scope PATCH moving
  // a row OUT of the guarded space is neither refused nor rewritten, and the
  // guard must not write a column the request never mentioned.
  it("leaves a scope PATCH that moves a row out of the pull_request space alone", async () => {
    const company = await seedCompany(db, "ScopeExit");
    const agent = await seedAgent(db, company.id);
    const issue = await seedIssue(db, company, 1);
    const app = await createApp(db, agentActor(company.id, agent.id));

    const created = await request(app)
      .post(`/api/issues/${issue.id}/work-products`)
      .send({ type: "pull_request", provider: "github", externalId: "Blockcast/paperclip#1", title: "PR #1" });
    expect(created.status).toBe(201);

    const moved = await request(app)
      .patch(`/api/work-products/${created.body.id}`)
      .send({ type: "artifact" });

    expect(moved.status).toBe(200);
    expect(moved.body.type).toBe("artifact");
    expect(moved.body.externalId).toBe("Blockcast/paperclip#1");
  }, 120_000);

  // A scope-only PATCH can now reach migration 0216's unique index too, and the
  // 409 it raises must name the key that actually collided. That key lives on
  // the stored row, not in the body -- reading the patch alone reports
  // `externalId undefined` on the one message whose job is to name it.
  it("names the colliding key in the 409 raised by a scope-only PATCH", async () => {
    const company = await seedCompany(db, "ScopeConflict");
    const agent = await seedAgent(db, company.id);
    const issue = await seedIssue(db, company, 1);
    const app = await createApp(db, agentActor(company.id, agent.id));

    const incumbent = await request(app)
      .post(`/api/issues/${issue.id}/work-products`)
      .send({ type: "pull_request", provider: "github", externalId: PR_CANONICAL, title: "PR #3205" });
    expect(incumbent.status).toBe(201);

    const sameKeyOtherType = await request(app)
      .post(`/api/issues/${issue.id}/work-products`)
      .send({ type: "artifact", provider: "github", externalId: PR_CANONICAL, title: "Same key, other type" });
    expect(sameKeyOtherType.status).toBe(201);

    const collided = await request(app)
      .patch(`/api/work-products/${sameKeyOtherType.body.id}`)
      .send({ type: "pull_request" });

    expect(collided.status).toBe(409);
    expect(collided.body.code).toBe("work_product_external_identity_conflict");
    expect(collided.body.error).toContain(PR_CANONICAL);
    expect(collided.body.error).not.toContain("undefined");
    expect(await db.select().from(issueWorkProducts)).toHaveLength(2);
  }, 120_000);

  // Canonicalising on write MERGES two previously-distinct key spaces, so a URL
  // and the canonical key for one pull request can now collide on migration
  // 0216's unique index where they could not before. `createForIssue` is a plain
  // INSERT, so that surfaces as 23505 -- which the error handler reports as a
  // bare 500, on a request whose remedy is "patch the row you already have".
  it("reports a second row for one pull request on one issue as 409, not 500", async () => {
    const company = await seedCompany(db, "Conflict");
    const agent = await seedAgent(db, company.id);
    const issue = await seedIssue(db, company, 1);
    const app = await createApp(db, agentActor(company.id, agent.id));

    const first = await request(app)
      .post(`/api/issues/${issue.id}/work-products`)
      .send({ type: "pull_request", provider: "github", externalId: PR_CANONICAL, title: "PR #3205" });
    expect(first.status).toBe(201);

    const second = await request(app)
      .post(`/api/issues/${issue.id}/work-products`)
      .send({ type: "pull_request", provider: "github", externalId: PR_URL, title: "PR #3205 again" });

    expect(second.status).toBe(409);
    expect(second.body.code).toBe("work_product_external_identity_conflict");
    expect(await db.select().from(issueWorkProducts)).toHaveLength(1);
  }, 120_000);

  // 0216's index is partial on `external_id IS NOT NULL`, so rows with no
  // external identity are outside it entirely and several may coexist. Seventeen
  // live `pull_request` rows are in exactly this state; the guard must not start
  // inventing keys for them.
  it("leaves a pull_request row with no external id alone", async () => {
    const company = await seedCompany(db, "NoKey");
    const agent = await seedAgent(db, company.id);
    const issue = await seedIssue(db, company, 1);
    const app = await createApp(db, agentActor(company.id, agent.id));

    const res = await request(app)
      .post(`/api/issues/${issue.id}/work-products`)
      .send({ type: "pull_request", provider: "github", title: "PR #3205", url: PR_URL });

    expect(res.status).toBe(201);
    expect(res.body.externalId).toBeNull();
  }, 120_000);
});
