import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activityLog, companies, createDb, pluginEventOutbox } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { logActivity, setPluginEventOutboxDb } from "../services/activity-log.js";
import { subscribeCompanyLiveEvents } from "../services/live-events.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres activity-log transactional publish tests: ${
      embeddedPostgresSupport.reason ?? "unsupported"
    }`,
  );
}

/**
 * `approval.created` is a real member of PLUGIN_EVENT_TYPES, so logging it takes
 * the plugin-outbox path. That is the leg that matters here: a rolled-back
 * transaction must not leave the worker-tier poller an event to emit for an
 * entity that never committed.
 */
const PLUGIN_MAPPED_ACTION = "approval.created";

describeEmbeddedPostgres("logActivity publication vs. an enclosing transaction", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const companyId = randomUUID();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-activity-tx-publish-");
    db = createDb(tempDb.connectionString);
    // Mirrors app boot: the outbox handle used whenever a caller does not supply one.
    setPluginEventOutboxDb(db);
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
  });

  afterEach(async () => {
    await db.delete(pluginEventOutbox);
    await db.delete(activityLog);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function activityInput(entityId: string) {
    return {
      companyId,
      actorType: "system" as const,
      actorId: "test",
      action: PLUGIN_MAPPED_ACTION,
      entityType: "approval",
      entityId,
      details: { hello: "world" },
    };
  }

  function captureLiveEvents() {
    const seen: string[] = [];
    const unsubscribe = subscribeCompanyLiveEvents(companyId, (event) => {
      seen.push(event.type);
    });
    return { seen, unsubscribe };
  }

  it("enqueues no plugin event when the enclosing transaction rolls back", async () => {
    const entityId = randomUUID();
    const live = captureLiveEvents();

    await expect(
      db.transaction(async (tx) => {
        await logActivity(tx as unknown as Db, activityInput(entityId));
        throw new Error("caller rolled back after logging activity");
      }),
    ).rejects.toThrow("caller rolled back after logging activity");

    live.unsubscribe();

    // Give any escaped fire-and-forget write a chance to land before asserting.
    await new Promise((resolve) => setTimeout(resolve, 250));

    const outboxRows = await db.select().from(pluginEventOutbox);
    const activityRows = await db.select().from(activityLog);

    // The activity row rolled back, so the event describing it must have too.
    expect(activityRows).toHaveLength(0);
    expect(outboxRows).toHaveLength(0);
  });

  it("enqueues the plugin event when the enclosing transaction commits", async () => {
    const entityId = randomUUID();

    await db.transaction(async (tx) => {
      await logActivity(tx as unknown as Db, activityInput(entityId));
    });

    const outboxRows = await db.select().from(pluginEventOutbox);
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0]?.eventType).toBe(PLUGIN_MAPPED_ACTION);
    expect(await db.select().from(activityLog)).toHaveLength(1);
  });

  it("deferPublish withholds both the live event and the outbox row until after commit", async () => {
    const entityId = randomUUID();
    const live = captureLiveEvents();

    const publish = await db.transaction(async (tx) => {
      const deferred = await logActivity(tx as unknown as Db, activityInput(entityId), {
        deferPublish: true,
      });
      // Still inside the transaction: nothing may have escaped yet.
      expect(live.seen).toHaveLength(0);
      expect(await db.select().from(pluginEventOutbox)).toHaveLength(0);
      return deferred;
    });

    publish();
    // The deferred publish runs post-commit on the global handle, so poll for it.
    const deadline = Date.now() + 2_000;
    let outboxRows: Awaited<ReturnType<typeof db.select>> = [];
    while (Date.now() < deadline) {
      outboxRows = await db.select().from(pluginEventOutbox);
      if (outboxRows.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    live.unsubscribe();

    expect(outboxRows).toHaveLength(1);
    expect(live.seen).toContain("activity.logged");
  });

  it("still publishes inline for a caller outside any transaction", async () => {
    const entityId = randomUUID();
    const live = captureLiveEvents();

    await logActivity(db, activityInput(entityId));

    live.unsubscribe();
    expect(await db.select().from(pluginEventOutbox)).toHaveLength(1);
    expect(live.seen).toContain("activity.logged");
  });
});
