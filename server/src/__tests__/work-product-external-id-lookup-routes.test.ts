import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  issues,
  issueWorkProducts,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  PULL_REQUEST_WORK_PRODUCT_METADATA_SOURCE,
  PULL_REQUEST_WORK_PRODUCT_SOURCE_TRUST,
} from "../services/pull-request-work-products.js";

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

const PR = "Blockcast/paperclip#3205";

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
      name: `Work Product Lookup ${label}`,
      issuePrefix: `WP${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
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

async function seedIssue(db: Db, company: { id: string; issuePrefix: string }, n: number, title: string) {
  return db
    .insert(issues)
    .values({
      companyId: company.id,
      identifier: `${company.issuePrefix}-${n}`,
      title,
      status: "in_progress",
      priority: "medium",
    })
    .returning()
    .then((rows) => rows[0]!);
}

/** A row shaped exactly as the GitHub webhook writes it. */
async function seedWebhookPullRequest(
  db: Db,
  input: { companyId: string; issueId: string; externalId: string; owningIdentifiers: string[] },
) {
  await db.insert(issueWorkProducts).values({
    companyId: input.companyId,
    issueId: input.issueId,
    type: "pull_request",
    provider: "github",
    externalId: input.externalId,
    title: input.externalId,
    url: `https://github.com/${input.externalId.replace("#", "/pull/")}`,
    status: "ready_for_review",
    sourceTrust: PULL_REQUEST_WORK_PRODUCT_SOURCE_TRUST,
    metadata: {
      source: PULL_REQUEST_WORK_PRODUCT_METADATA_SOURCE,
      owningIdentifiers: input.owningIdentifiers,
      branch: "devops/pen-5181-broker-soak-queries",
      headSha: "eb2dc73765df23dd583890e7cf3ab7c6bfa4a733",
    },
  });
}

describeEmbeddedPostgres("GET /api/companies/:companyId/work-products/by-external-id", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-work-product-lookup-");
    db = createDb(tempDb.connectionString);
    // Pay the route-module import cost here rather than inside whichever test
    // happens to run first, which otherwise eats most of that test's budget.
    await import("../routes/issues.js");
  }, 180_000);

  afterEach(async () => {
    await db.delete(issueWorkProducts);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  // The whole point of the endpoint: a caller holding ONLY the artifact can
  // name its owning row. Before PEN-5340 this required already knowing the row.
  it("resolves an artifact to its owning row and that row's recorded owners", async () => {
    const company = await seedCompany(db, "Forward");
    const agent = await seedAgent(db, company.id);
    const owner = await seedIssue(db, company, 1, "Broker soak queries");
    const unrelated = await seedIssue(db, company, 2, "Discusses the PR but owns nothing");
    await seedWebhookPullRequest(db, {
      companyId: company.id,
      issueId: owner.id,
      externalId: PR,
      owningIdentifiers: [`${company.issuePrefix}-1`],
    });

    const app = await createApp(db, agentActor(company.id, agent.id));
    const res = await request(app)
      .get(`/api/companies/${company.id}/work-products/by-external-id`)
      .query({ externalId: PR });

    expect(res.status).toBe(200);
    expect(res.body.externalId).toBe(PR);
    expect(res.body.owners).toHaveLength(1);
    expect(res.body.owners[0].issueId).toBe(owner.id);
    expect(res.body.owners[0].identifier).toBe(`${company.issuePrefix}-1`);
    expect(res.body.owners[0].provenance).toBe("webhook");
    expect(res.body.owners[0].owningIdentifiers).toEqual([`${company.issuePrefix}-1`]);
    expect(res.body.withheldForAuthorizationCount).toBe(0);
    // Every declared owner was returned, so the caller may act on the list.
    expect(res.body.unresolvedOwningIdentifiers).toEqual([]);
    expect(res.body.owningIdentifiersUnrecorded).toBe(false);
    expect(res.body.ownerListComplete).toBe(true);
    // A row that merely discusses the PR is not an owner.
    expect(res.body.owners.map((o: { issueId: string }) => o.issueId)).not.toContain(unrelated.id);
  }, 120_000);

  // Migration 0216 keys the unique index on (company, ISSUE, provider, type,
  // external_id) precisely so one PR can own several rows. A single-row answer
  // would report one arbitrary owner as "the" owner.
  it("returns every owning row, not just one", async () => {
    const company = await seedCompany(db, "Plural");
    const agent = await seedAgent(db, company.id);
    const first = await seedIssue(db, company, 1, "First owner");
    const second = await seedIssue(db, company, 2, "Second owner");
    const owningIdentifiers = [`${company.issuePrefix}-1`, `${company.issuePrefix}-2`];
    await seedWebhookPullRequest(db, { companyId: company.id, issueId: first.id, externalId: PR, owningIdentifiers });
    await seedWebhookPullRequest(db, { companyId: company.id, issueId: second.id, externalId: PR, owningIdentifiers });

    const app = await createApp(db, agentActor(company.id, agent.id));
    const res = await request(app)
      .get(`/api/companies/${company.id}/work-products/by-external-id`)
      .query({ externalId: PR });

    expect(res.status).toBe(200);
    expect(new Set(res.body.owners.map((o: { issueId: string }) => o.issueId))).toEqual(
      new Set([first.id, second.id]),
    );
  }, 120_000);

  // The value a run actually holds is the URL it just printed. A URL that
  // silently matched nothing would be indistinguishable from "no owner".
  it("accepts a GitHub pull-request URL and echoes the canonical key", async () => {
    const company = await seedCompany(db, "Url");
    const agent = await seedAgent(db, company.id);
    const owner = await seedIssue(db, company, 1, "Owner");
    await seedWebhookPullRequest(db, {
      companyId: company.id,
      issueId: owner.id,
      externalId: PR,
      owningIdentifiers: [`${company.issuePrefix}-1`],
    });

    const app = await createApp(db, agentActor(company.id, agent.id));
    const res = await request(app)
      .get(`/api/companies/${company.id}/work-products/by-external-id`)
      .query({ externalId: "https://github.com/Blockcast/paperclip/pull/3205" });

    expect(res.status).toBe(200);
    expect(res.body.externalId).toBe(PR);
    expect(res.body.owners).toHaveLength(1);
    expect(res.body.owners[0].issueId).toBe(owner.id);
  }, 120_000);

  // An unparseable key must NOT come back as an empty owner set: empty reads as
  // "this PR has no owning row", which is the false-absence this endpoint exists
  // to remove.
  it("rejects a malformed external id rather than answering with an empty set", async () => {
    const company = await seedCompany(db, "Malformed");
    const agent = await seedAgent(db, company.id);
    const app = await createApp(db, agentActor(company.id, agent.id));

    const res = await request(app)
      .get(`/api/companies/${company.id}/work-products/by-external-id`)
      .query({ externalId: "3205" });

    expect(res.status).toBe(400);
    expect(res.body.owners).toBeUndefined();
  }, 120_000);

  // Labelled, not filtered. The webhook's own private query drops asserted rows;
  // for a LOOKUP that would reintroduce a silent absence, so they are returned
  // and marked, authoritative first.
  it("labels provenance and sorts webhook-maintained rows ahead of asserted ones", async () => {
    const company = await seedCompany(db, "Provenance");
    const agent = await seedAgent(db, company.id);
    const asserted = await seedIssue(db, company, 1, "Self-asserted link");
    const webhook = await seedIssue(db, company, 2, "Webhook-maintained link");
    await db.insert(issueWorkProducts).values({
      companyId: company.id,
      issueId: asserted.id,
      type: "pull_request",
      provider: "github",
      externalId: PR,
      title: PR,
      status: "ready_for_review",
      // No system sourceTrust, no webhook metadata source: an agent said so.
      metadata: { owningIdentifiers: [`${company.issuePrefix}-1`] },
    });
    await seedWebhookPullRequest(db, {
      companyId: company.id,
      issueId: webhook.id,
      externalId: PR,
      owningIdentifiers: [`${company.issuePrefix}-2`],
    });

    const app = await createApp(db, agentActor(company.id, agent.id));
    const res = await request(app)
      .get(`/api/companies/${company.id}/work-products/by-external-id`)
      .query({ externalId: PR });

    expect(res.status).toBe(200);
    expect(res.body.owners).toHaveLength(2);
    expect(res.body.owners[0].provenance).toBe("webhook");
    expect(res.body.owners[0].issueId).toBe(webhook.id);
    expect(res.body.owners[1].provenance).toBe("asserted");
    expect(res.body.owners[1].issueId).toBe(asserted.id);
  }, 120_000);

  it("does not leak an owner from another company sharing the same external id", async () => {
    const mine = await seedCompany(db, "Mine");
    const theirs = await seedCompany(db, "Theirs");
    const agent = await seedAgent(db, mine.id);
    const myIssue = await seedIssue(db, mine, 1, "My owner");
    const theirIssue = await seedIssue(db, theirs, 1, "Their owner");
    await seedWebhookPullRequest(db, {
      companyId: mine.id,
      issueId: myIssue.id,
      externalId: PR,
      owningIdentifiers: [`${mine.issuePrefix}-1`],
    });
    await seedWebhookPullRequest(db, {
      companyId: theirs.id,
      issueId: theirIssue.id,
      externalId: PR,
      owningIdentifiers: [`${theirs.issuePrefix}-1`],
    });

    const app = await createApp(db, agentActor(mine.id, agent.id));
    const res = await request(app)
      .get(`/api/companies/${mine.id}/work-products/by-external-id`)
      .query({ externalId: PR });

    expect(res.status).toBe(200);
    expect(res.body.owners).toHaveLength(1);
    expect(res.body.owners[0].issueId).toBe(myIssue.id);
    // The other company's declared identifier must not reach this response by the
    // back door either: the unresolved set is derived from the READABLE rows, so a
    // row this seat may not see cannot leak its identifier through the new field.
    expect(res.body.unresolvedOwningIdentifiers).toEqual([]);
  }, 120_000);

  // PEN-5340 item 5, the measured regression. Blockcast/penstock-llm-proxy-core#3114
  // declares five owners, returns four, and reported `withheldForAuthorizationCount: 0`
  // -- identical on an admin and a non-admin seat, so nothing was withheld. The fifth
  // (`BLO-21096`) is another company's identifier: it matches no row here, so it is
  // filtered by nothing and counted by nothing. The response was indistinguishable from
  // a complete one, inside the control whose whole job is to stop a run concluding it
  // has seen every owner.
  it("reports a declared owner it could not return, which no authorization counter sees", async () => {
    const company = await seedCompany(db, "Unresolved");
    const agent = await seedAgent(db, company.id);
    const first = await seedIssue(db, company, 1, "First owner");
    const second = await seedIssue(db, company, 2, "Second owner");
    // Exactly the live shape: the webhook copies every declared owner off the PR,
    // including one belonging to an identifier space this company cannot resolve.
    const owningIdentifiers = [`${company.issuePrefix}-1`, `${company.issuePrefix}-2`, "BLO-21096"];
    await seedWebhookPullRequest(db, { companyId: company.id, issueId: first.id, externalId: PR, owningIdentifiers });
    await seedWebhookPullRequest(db, { companyId: company.id, issueId: second.id, externalId: PR, owningIdentifiers });

    const app = await createApp(db, agentActor(company.id, agent.id));
    const res = await request(app)
      .get(`/api/companies/${company.id}/work-products/by-external-id`)
      .query({ externalId: PR });

    expect(res.status).toBe(200);
    expect(res.body.owners).toHaveLength(2);
    // The counter is right and is not the point: nothing here is withheld.
    expect(res.body.withheldForAuthorizationCount).toBe(0);
    expect(res.body.unresolvedOwningIdentifiers).toEqual(["BLO-21096"]);
    // The single signal the directive names. Without it, 2 / 0 / 3 reads as complete.
    expect(res.body.ownerListComplete).toBe(false);
  }, 120_000);

  // The other direction of the same non-containment, and the reason completeness
  // cannot be derived from comparing the two fields' sizes. Measured on
  // Blockcast/paperclip#3114: three owning rows, each bound to its own issue, all
  // three declaring only ONE identifier between them. `owners` is not a join on
  // `owningIdentifiers` -- it is the set of rows carrying this external id -- so a
  // returned owner that is declared nowhere is ordinary and must not read as short.
  it("does not report an owner it DID return merely because the metadata omits it", async () => {
    const company = await seedCompany(db, "Undeclared");
    const agent = await seedAgent(db, company.id);
    const declared = await seedIssue(db, company, 1, "The declared owner");
    const undeclaredA = await seedIssue(db, company, 2, "Bound but undeclared");
    const undeclaredB = await seedIssue(db, company, 3, "Also bound but undeclared");
    const owningIdentifiers = [`${company.issuePrefix}-1`];
    for (const issue of [declared, undeclaredA, undeclaredB]) {
      await seedWebhookPullRequest(db, { companyId: company.id, issueId: issue.id, externalId: PR, owningIdentifiers });
    }

    const app = await createApp(db, agentActor(company.id, agent.id));
    const res = await request(app)
      .get(`/api/companies/${company.id}/work-products/by-external-id`)
      .query({ externalId: PR });

    expect(res.status).toBe(200);
    expect(res.body.owners).toHaveLength(3);
    expect(res.body.unresolvedOwningIdentifiers).toEqual([]);
    expect(res.body.ownerListComplete).toBe(true);
  }, 120_000);

  // THE COMMON SHAPE, and the reason `owningIdentifiersUnrecorded` cannot be keyed
  // per row. `metadata.owningIdentifiers` has one writer -- the GitHub webhook --
  // so a row an agent registered carries none, and `recordedPullRequestOwners`
  // maps that absence onto the same `null` as an unparseable value. The field's
  // own docblock calls agent-registered rows "the common case ... load-bearing
  // indefinitely". Keyed per row, `ownerListComplete` would read `false` on most
  // real lookups -- including this one, where a sibling webhook row states the
  // declaration in full -- and a signal that is false on the common shape is a
  // signal readers learn to skip. That is the same fail-open this endpoint exists
  // to remove, reached by over-alerting rather than under-alerting.
  it("stays complete when an agent-registered row carries no ownership metadata", async () => {
    const company = await seedCompany(db, "Mixed");
    const agent = await seedAgent(db, company.id);
    const asserted = await seedIssue(db, company, 1, "Registered by an agent");
    const webhook = await seedIssue(db, company, 2, "Webhook-maintained");
    await db.insert(issueWorkProducts).values({
      companyId: company.id,
      issueId: asserted.id,
      type: "pull_request",
      provider: "github",
      externalId: PR,
      title: PR,
      status: "ready_for_review",
      // Exactly what the Paperclip skill's create call writes: no ownership at all.
      metadata: {},
    });
    await seedWebhookPullRequest(db, {
      companyId: company.id,
      issueId: webhook.id,
      externalId: PR,
      owningIdentifiers: [`${company.issuePrefix}-1`, `${company.issuePrefix}-2`],
    });

    const app = await createApp(db, agentActor(company.id, agent.id));
    const res = await request(app)
      .get(`/api/companies/${company.id}/work-products/by-external-id`)
      .query({ externalId: PR });

    expect(res.status).toBe(200);
    expect(res.body.owners).toHaveLength(2);
    // The asserted row really does carry no recording -- the point is that one
    // readable authoritative recording is enough to answer the question.
    expect(res.body.owners.find((owner: { provenance: string }) => owner.provenance === "asserted").owningIdentifiers)
      .toBeNull();
    expect(res.body.owningIdentifiersUnrecorded).toBe(false);
    expect(res.body.unresolvedOwningIdentifiers).toEqual([]);
    expect(res.body.ownerListComplete).toBe(true);
  }, 120_000);

  // The declared set is read off `provenance: "webhook"` rows only. An asserted
  // row's metadata is whatever an agent chose to write, so taking the declaration
  // from it would let one stray agent write turn a safety signal `false` for every
  // caller of this artifact.
  it("does not let an agent-asserted row's stray metadata decide completeness", async () => {
    const company = await seedCompany(db, "Stray");
    const agent = await seedAgent(db, company.id);
    const asserted = await seedIssue(db, company, 1, "Asserted, with invented ownership");
    const webhook = await seedIssue(db, company, 2, "Webhook-maintained");
    await db.insert(issueWorkProducts).values({
      companyId: company.id,
      issueId: asserted.id,
      type: "pull_request",
      provider: "github",
      externalId: PR,
      title: PR,
      status: "ready_for_review",
      // No system sourceTrust: an agent said so, and named a row that owns nothing.
      metadata: { owningIdentifiers: ["BLO-99999"] },
    });
    await seedWebhookPullRequest(db, {
      companyId: company.id,
      issueId: webhook.id,
      externalId: PR,
      owningIdentifiers: [`${company.issuePrefix}-2`],
    });

    const app = await createApp(db, agentActor(company.id, agent.id));
    const res = await request(app)
      .get(`/api/companies/${company.id}/work-products/by-external-id`)
      .query({ externalId: PR });

    expect(res.status).toBe(200);
    // Still returned and still labelled -- it is dropped from the DECLARATION, not
    // from the answer.
    expect(res.body.owners).toHaveLength(2);
    expect(res.body.unresolvedOwningIdentifiers).toEqual([]);
    expect(res.body.ownerListComplete).toBe(true);
  }, 120_000);

  // The authoritative recording is what the artifact declared; with no webhook row
  // carrying one there is nothing to check the returned rows against. `false` here
  // is "unverifiable", which is why the directive stopped saying `false` means
  // owners are definitely missing.
  it("reports an answer with no authoritative recording as unverifiable", async () => {
    const company = await seedCompany(db, "NoWebhook");
    const agent = await seedAgent(db, company.id);
    const asserted = await seedIssue(db, company, 1, "Only an agent-registered row");
    await db.insert(issueWorkProducts).values({
      companyId: company.id,
      issueId: asserted.id,
      type: "pull_request",
      provider: "github",
      externalId: PR,
      title: PR,
      status: "ready_for_review",
      metadata: {},
    });

    const app = await createApp(db, agentActor(company.id, agent.id));
    const res = await request(app)
      .get(`/api/companies/${company.id}/work-products/by-external-id`)
      .query({ externalId: PR });

    expect(res.status).toBe(200);
    expect(res.body.owners).toHaveLength(1);
    expect(res.body.withheldForAuthorizationCount).toBe(0);
    expect(res.body.owningIdentifiersUnrecorded).toBe(true);
    expect(res.body.ownerListComplete).toBe(false);
  }, 120_000);

  // `recordedPullRequestOwners` returns `null` for a recording it could not parse,
  // and that is deliberately NOT the empty set. Read as "declares nothing" it would
  // let an unreadable recording answer `complete`, which is the one direction this
  // field must never fail in -- so it fails the other way.
  it("refuses to call the list complete when a recording could not be read", async () => {
    const company = await seedCompany(db, "Unrecorded");
    const agent = await seedAgent(db, company.id);
    const owner = await seedIssue(db, company, 1, "Owner with an unparseable recording");
    await db.insert(issueWorkProducts).values({
      companyId: company.id,
      issueId: owner.id,
      type: "pull_request",
      provider: "github",
      externalId: PR,
      title: PR,
      url: `https://github.com/${PR.replace("#", "/pull/")}`,
      status: "ready_for_review",
      sourceTrust: PULL_REQUEST_WORK_PRODUCT_SOURCE_TRUST,
      // Non-string entries: a recording that exists and cannot be read.
      metadata: { source: PULL_REQUEST_WORK_PRODUCT_METADATA_SOURCE, owningIdentifiers: [42] },
    });

    const app = await createApp(db, agentActor(company.id, agent.id));
    const res = await request(app)
      .get(`/api/companies/${company.id}/work-products/by-external-id`)
      .query({ externalId: PR });

    expect(res.status).toBe(200);
    expect(res.body.owners).toHaveLength(1);
    expect(res.body.owners[0].owningIdentifiers).toBeNull();
    expect(res.body.unresolvedOwningIdentifiers).toEqual([]);
    expect(res.body.owningIdentifiersUnrecorded).toBe(true);
    expect(res.body.ownerListComplete).toBe(false);
  }, 120_000);
});
