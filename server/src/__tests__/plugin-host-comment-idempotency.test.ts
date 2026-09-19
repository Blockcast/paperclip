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

describeEmbeddedPostgres("plugin host comment idempotency", () => {
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

  // -----------------------------------------------------------------------
  // BLO-31634: updateComment — the key is the authorization, not just the
  // lookup.
  //
  // These live here rather than in the Linear plugin suite on purpose. The
  // plugin test harness stores the *raw* caller key and does not model the
  // `plugin:${pluginId}:` namespace at all (it says so in `testing.ts`), so
  // every property below is invisible to it: against the fake, a cross-plugin
  // edit would appear to work. Only the real host + real partial unique
  // indexes can show that it does not.
  // -----------------------------------------------------------------------

  it("rewrites the body of a comment created under the same raw key", async () => {
    const { companyId, issueId } = await seedIssue();
    const idempotencyKey = `linear-comment:${randomUUID()}`;

    const { created, updated } = await withServices(async (services) => ({
      created: await services.issues.createComment({ issueId, companyId, body: "Original text", idempotencyKey }),
      updated: await services.issues.updateComment({ issueId, companyId, body: "Edited text", idempotencyKey }),
    }));

    // Same row rewritten in place — the edit must not insert a second copy.
    expect(updated?.id).toBe(created.id);
    expect(updated?.body).toBe("Edited text");
    const rows = await commentRows(issueId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.body).toBe("Edited text");
  });

  // The `issue_comments` activity trigger (0076) is AFTER INSERT only, so an
  // in-place edit bumps nothing on its own and the thread would keep the
  // pre-edit recency. The service compensates by touching `issues.updated_at`,
  // which the BEFORE UPDATE trigger mirrors into `last_activity_at`. Drop that
  // touch and this goes red.
  it("advances the issue's last_activity_at on an edit", async () => {
    const { companyId, issueId } = await seedIssue();
    const idempotencyKey = `linear-comment:${randomUUID()}`;

    const before = await withServices(async (services) => {
      await services.issues.createComment({ issueId, companyId, body: "Original text", idempotencyKey });
      const [row] = await db.select().from(issues).where(eq(issues.id, issueId));
      return row!.lastActivityAt!;
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    await withServices((services) =>
      services.issues.updateComment({ issueId, companyId, body: "Edited text", idempotencyKey }),
    );

    const [after] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(after!.lastActivityAt!.getTime()).toBeGreaterThan(before.getTime());
  });

  // THE security test for this path. There is no update-by-comment-id call, so
  // the only way to address a comment is to reproduce the key it was written
  // with — and the host namespaces that per installation. Two plugins sharing
  // a natural raw key (`comment:42`) must not be able to rewrite each other's
  // comment. Delete the `plugin:${pluginId}:` prefix in the update path of
  // `plugin-host-services.ts` and this turns red: the GitHub plugin silently
  // overwrites the Linear plugin's body.
  it("scopes an edit per plugin: one plugin cannot rewrite another's comment sharing a raw key", async () => {
    const { companyId, issueId } = await seedIssue();
    const idempotencyKey = "comment:42";

    const mine = await withServices((services) =>
      services.issues.createComment({ issueId, companyId, body: "[Linear] mine", idempotencyKey }),
    );
    const theirs = await withOtherPluginServices((services) =>
      services.issues.createComment({ issueId, companyId, body: "[GitHub] theirs", idempotencyKey }),
    );

    // The GitHub installation edits *its own* key. It must reach its own
    // comment and leave the Linear one untouched.
    const updated = await withOtherPluginServices((services) =>
      services.issues.updateComment({ issueId, companyId, body: "[GitHub] edited", idempotencyKey }),
    );

    expect(updated?.id).toBe(theirs.id);
    const rows = await commentRows(issueId);
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === mine.id)!.body).toBe("[Linear] mine");
    expect(rows.find((row) => row.id === theirs.id)!.body).toBe("[GitHub] edited");
  });

  // Sharper than the cross-plugin case above, and the one that fails in the
  // *dangerous* direction. Non-plugin callers write `idempotency_key` raw —
  // only the plugin host namespaces — so a server-internal comment sits in the
  // key space a plugin would occupy if its prefix were dropped. A plugin
  // asking to edit its own `comment:42` must not be handed that row. Strip the
  // `plugin:${pluginId}:` prefix from the update path and this does not merely
  // miss: it rewrites a comment the plugin never authored.
  it("cannot reach a non-plugin comment stored under the same key un-namespaced", async () => {
    const { companyId, issueId } = await seedIssue();
    const idempotencyKey = "comment:42";

    // Written the way a server-internal caller writes it: key stored raw.
    const internal = await db
      .insert(issueComments)
      .values({ companyId, issueId, body: "[internal] not the plugin's", authorType: "system", idempotencyKey })
      .returning()
      .then((rows) => rows[0]!);

    const missed = await withServices((services) =>
      services.issues.updateComment({ issueId, companyId, body: "[Linear] hijacked", idempotencyKey }),
    );

    expect(missed).toBeNull();
    const [row] = await db.select().from(issueComments).where(eq(issueComments.id, internal.id));
    expect(row!.body).toBe("[internal] not the plugin's");
  });

  // Same uniqueness scope as create — `(issue, author, key)`. A system-authored
  // comment must not be reachable by passing an agent author, or a plugin could
  // walk the author axis to reach a row it did not write.
  it("scopes an edit per author: an agent author does not match a system-authored comment", async () => {
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

    const missed = await withServices(async (services) => {
      await services.issues.createComment({ issueId, companyId, body: "system", idempotencyKey });
      return services.issues.updateComment({
        issueId,
        companyId,
        body: "agent edit",
        idempotencyKey,
        authorAgentId: agent.id,
      });
    });

    expect(missed).toBeNull();
    expect((await commentRows(issueId))[0]!.body).toBe("system");
  });

  // Mirror of the create-side empty-key test, and a sharper hazard here. A
  // plugin deriving `event.id ?? ""` on the update path must not be handed a
  // *match*: keyless rows are stored as NULL and an un-normalized "" that fell
  // through to the WHERE clause would be a body-rewrite aimed at whatever it
  // collided with. Reject at the boundary instead.
  it("rejects empty and whitespace-only keys rather than matching a keyless comment", async () => {
    const { companyId, issueId } = await seedIssue();

    await withServices(async (services) => {
      await services.issues.createComment({ issueId, companyId, body: "keyless" });
      await expect(
        services.issues.updateComment({ issueId, companyId, body: "hijacked", idempotencyKey: "" }),
      ).rejects.toThrow(/non-empty idempotencyKey/);
      await expect(
        services.issues.updateComment({ issueId, companyId, body: "hijacked", idempotencyKey: "   " }),
      ).rejects.toThrow(/non-empty idempotencyKey/);
    });

    expect((await commentRows(issueId))[0]!.body).toBe("keyless");
  });

  // Returning null rather than throwing is load-bearing for the Linear worker:
  // a miss is the ordinary "no mirror of mine to edit" answer and its fallback
  // is to create instead, so routing it through a catch would cost a
  // round-trip on the normal path.
  it("resolves null when no comment carries the key", async () => {
    const { companyId, issueId } = await seedIssue();

    const missed = await withServices((services) =>
      services.issues.updateComment({ issueId, companyId, body: "edit", idempotencyKey: "never-written" }),
    );

    expect(missed).toBeNull();
    expect(await commentRows(issueId)).toHaveLength(0);
  });

  // A soft-deleted mirror must read as "nothing of mine to edit", matching the
  // partial unique indexes (all `WHERE ... deleted_at IS NULL`). This is what
  // lets the worker fall through and re-bridge the comment, and what stops an
  // edit resurrecting a body into a deleted row.
  it("does not reach a soft-deleted comment", async () => {
    const { companyId, issueId } = await seedIssue();
    const idempotencyKey = `linear-comment:${randomUUID()}`;

    const created = await withServices((services) =>
      services.issues.createComment({ issueId, companyId, body: "Original text", idempotencyKey }),
    );
    await db
      .update(issueComments)
      .set({ deletedAt: new Date() })
      .where(eq(issueComments.id, created.id));

    const missed = await withServices((services) =>
      services.issues.updateComment({ issueId, companyId, body: "Edited text", idempotencyKey }),
    );

    expect(missed).toBeNull();
    const [row] = await db.select().from(issueComments).where(eq(issueComments.id, created.id));
    expect(row!.body).toBe("Original text");
  });

  // The AC's concurrency guarantee, at the layer that actually provides it.
  // `updateComment` is a single `UPDATE ... WHERE key = ...` and inserts
  // nothing, so concurrent deliveries of one edit converge instead of racing
  // into a second row — the same property BLO-31657 bought for `create`, and
  // for the same reason: it is the database, not a process-local claim.
  it("keeps one comment when concurrent edits carry the same key", async () => {
    const { companyId, issueId } = await seedIssue();
    const idempotencyKey = `linear-comment:${randomUUID()}`;

    await withServices(async (services) => {
      await services.issues.createComment({ issueId, companyId, body: "Original text", idempotencyKey });
      await Promise.all([
        services.issues.updateComment({ issueId, companyId, body: "Edited text", idempotencyKey }),
        services.issues.updateComment({ issueId, companyId, body: "Edited text", idempotencyKey }),
      ]);
    });

    const rows = await commentRows(issueId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.body).toBe("Edited text");
  });
});
