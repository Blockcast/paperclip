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

  /** A second, unrelated plugin installation — same host, same database. */
  function withOtherPluginServices<T>(fn: (services: ReturnType<typeof buildHostServices>) => Promise<T>) {
    const services = buildHostServices(db, "other-plugin-record-id", "paperclip.github", createEventBusStub());
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
    const [surviving] = await commentRows(issueId);
    expect(await commentRows(issueId)).toHaveLength(1);

    // Whose body survived is *not* specified — the loser's body is discarded and
    // its caller is handed the winner's row. A plugin passing a key must accept
    // that it may get back content it did not send, so pin only that the
    // survivor is one of the two and that both callers agree on it.
    expect(["[Linear] delivery A", "[Linear] delivery B"]).toContain(surviving!.body);
    expect(first.body).toBe(surviving!.body);
    expect(second.body).toBe(surviving!.body);

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

  // The load-bearing test for the key *namespace*, as distinct from the dedup
  // mechanism. The system-author uniqueness scope is `(issue_id,
  // idempotency_key)` alone — it carries no plugin discriminator — so if the
  // host forwarded the caller's key raw, two plugins using the same natural key
  // (a delivery id, `comment:<id>`, `sync:1`) on one issue would collide: the
  // second insert is discarded and that caller is handed the *first plugin's
  // comment*, a different body, with `deduplicated: true` and no error. Deleting
  // the `plugin:${pluginId}:` prefix in `plugin-host-services.ts` must turn this
  // red.
  it("scopes the key per plugin: two plugins sharing a raw key do not collide", async () => {
    const { companyId, issueId } = await seedIssue();
    const idempotencyKey = "comment:42";

    const mine = await withServices((services) =>
      services.issues.createComment({ issueId, companyId, body: "[Linear] mine", idempotencyKey }),
    );
    const theirs = await withOtherPluginServices((services) =>
      services.issues.createComment({ issueId, companyId, body: "[GitHub] theirs", idempotencyKey }),
    );

    expect(theirs.id).not.toBe(mine.id);
    expect(theirs.body).toBe("[GitHub] theirs");
    expect("deduplicated" in theirs).toBe(false);
    expect(await commentRows(issueId)).toHaveLength(2);

    // ...while a repeat within one plugin still dedups, so the isolation above
    // is namespacing rather than dedup having been switched off.
    const again = await withServices((services) =>
      services.issues.createComment({ issueId, companyId, body: "[Linear] repeat", idempotencyKey }),
    );
    expect(again.id).toBe(mine.id);
    expect(await commentRows(issueId)).toHaveLength(2);
  });

  // `??` only catches null/undefined, and the partial unique indexes exclude
  // only NULL — so an un-normalized `""` is a *live* key. A plugin deriving one
  // from an optional upstream field (`event.id ?? ""`, an empty template
  // render) would silently collapse every subsequent system comment on the
  // issue into the first, with no error. Whitespace-only keys are the same
  // hazard wearing a different hat.
  it("treats empty and whitespace-only keys as omitted rather than as a live key", async () => {
    const { companyId, issueId } = await seedIssue();

    await withServices(async (services) => {
      await services.issues.createComment({ issueId, companyId, body: "first", idempotencyKey: "" });
      await services.issues.createComment({ issueId, companyId, body: "second", idempotencyKey: "" });
      await services.issues.createComment({ issueId, companyId, body: "third", idempotencyKey: "   " });
    });

    const rows = await commentRows(issueId);
    expect(rows).toHaveLength(3);
    // Stored as NULL, so they sit outside the partial unique index entirely.
    expect(rows.every((row) => row.idempotencyKey === null)).toBe(true);
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
