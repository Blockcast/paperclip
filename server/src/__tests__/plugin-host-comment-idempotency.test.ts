import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  createDb,
  instanceSettings,
  issueComments,
  issues,
} from "@paperclipai/db";
import { buildHostServices } from "../services/plugin-host-services.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping plugin host comment idempotency tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const pluginId = "plugin-record-id";

function createEventBusStub() {
  return {
    forPlugin() {
      return { emit: vi.fn(), subscribe: vi.fn(), clear: vi.fn() };
    },
  } as any;
}

describeEmbeddedPostgres("plugin host createComment idempotency", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-comment-idem-");
    db = createDb(tempDb.connectionString);
  }, 120_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(instanceSettings);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedIssue() {
    const company = await db
      .insert(companies)
      .values({
        name: `Paperclip ${randomUUID()}`,
        issuePrefix: `P${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      })
      .returning()
      .then((rows) => rows[0]!);
    const issue = await db
      .insert(issues)
      .values({
        companyId: company.id,
        title: "Bridged from Linear",
        status: "todo",
        priority: "medium",
      })
      .returning()
      .then((rows) => rows[0]!);
    return { companyId: company.id, issueId: issue.id };
  }

  async function commentRows(issueId: string) {
    return db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
  }

  function withServices<T>(fn: (services: ReturnType<typeof buildHostServices>) => Promise<T>) {
    const services = buildHostServices(db, pluginId, "paperclip.linear", createEventBusStub());
    return fn(services).finally(() => services.dispose());
  }

  it("collapses concurrent creates sharing an idempotencyKey into one comment", async () => {
    const { companyId, issueId } = await seedIssue();
    const idempotencyKey = `linear-comment:${randomUUID()}`;

    const [first, second] = await withServices((services) =>
      Promise.all([
        services.issues.createComment({ issueId, companyId, body: "[Linear] delivery A", idempotencyKey }),
        services.issues.createComment({ issueId, companyId, body: "[Linear] delivery B", idempotencyKey }),
      ]),
    );

    // Both callers get a comment back — one insert, one return-existing. Neither
    // errors, so a duplicate delivery is a no-op rather than something the
    // plugin has to catch.
    expect(first.id).toBe(second.id);
    expect(await commentRows(issueId)).toHaveLength(1);

    // Exactly one of the two took the dedup path.
    expect([("deduplicated" in first), ("deduplicated" in second)].filter(Boolean)).toHaveLength(1);
  });

  it("logs issue.comment.created once, not once per duplicate delivery", async () => {
    const { companyId, issueId } = await seedIssue();
    const idempotencyKey = `linear-comment:${randomUUID()}`;

    await withServices((services) =>
      Promise.all([
        services.issues.createComment({ issueId, companyId, body: "[Linear] delivery A", idempotencyKey }),
        services.issues.createComment({ issueId, companyId, body: "[Linear] delivery B", idempotencyKey }),
      ]),
    );

    const created = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "issue.comment.created"));
    expect(created).toHaveLength(1);
  });

  it("scopes the key per author: the same key under an agent author is a distinct comment", async () => {
    const { companyId, issueId } = await seedIssue();
    const agent = await db
      .insert(agents)
      .values({
        companyId,
        name: "Linear bridge",
        role: "engineer",
        adapterType: "process",
        adapterConfig: {},
        permissions: {},
      })
      .returning()
      .then((rows) => rows[0]!);
    const idempotencyKey = `linear-comment:${randomUUID()}`;

    await withServices(async (services) => {
      // System-authored (no authorAgentId) and agent-authored writes land in
      // different partial unique indexes, so the same key does not collide
      // across them.
      await services.issues.createComment({ issueId, companyId, body: "system", idempotencyKey });
      await services.issues.createComment({
        issueId,
        companyId,
        body: "agent",
        idempotencyKey,
        authorAgentId: agent.id,
      });
      // ...but a repeat within the agent scope still dedups.
      await services.issues.createComment({
        issueId,
        companyId,
        body: "agent again",
        idempotencyKey,
        authorAgentId: agent.id,
      });
    });

    expect(await commentRows(issueId)).toHaveLength(2);
  });

  // Negative control. Without this the suite above would still pass if
  // `idempotencyKey` were silently dropped somewhere in the plumbing and
  // *nothing* ever deduped — because a single-insert path also yields one row
  // when the second write is what's missing. Two identical bodies with no key
  // must produce two rows, proving the dedup above came from the key.
  it("does not dedup when no idempotencyKey is supplied", async () => {
    const { companyId, issueId } = await seedIssue();

    const [first, second] = await withServices((services) =>
      Promise.all([
        services.issues.createComment({ issueId, companyId, body: "[Linear] same body" }),
        services.issues.createComment({ issueId, companyId, body: "[Linear] same body" }),
      ]),
    );

    expect(first.id).not.toBe(second.id);
    expect(await commentRows(issueId)).toHaveLength(2);
  });
});
