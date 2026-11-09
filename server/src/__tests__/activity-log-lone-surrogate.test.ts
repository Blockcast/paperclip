import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { activityLog, companies, createDb, pluginEventOutbox } from "@paperclipai/db";
import { logActivity } from "../services/activity-log.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("logActivity lone surrogates", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-activity-lone-surrogate-");
    db = createDb(tempDb.connectionString);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  // The 120-unit `bodySnippet` slice cut a comment between the two halves of an emoji.
  // Postgres rejected the lone `\ud83d` as invalid json, so the comment's effects
  // failed and retried every sweep. The comment effect logs with an enlisted outbox
  // write and the full body as event extra, so both jsonb inserts are covered here.
  it("stores a snippet that cut a surrogate pair in half", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const bodySnippet = `${"x".repeat(119)}\u{1F534} tail`.slice(0, 120);
    expect(bodySnippet.endsWith("\uD83D")).toBe(true);

    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: "user-1",
      action: "issue.comment_added",
      entityType: "issue",
      entityId: randomUUID(),
      details: {
        bodySnippet,
        loneLow: "\uDC00 after",
        nested: [{ ["note\uD83D"]: "\u{1F534} intact" }],
      },
      pluginEventPayloadExtra: { body: `${"x".repeat(119)}\u{1F534} tail`, cut: "y\uD83D" },
    }, { enlistPluginOutbox: true });

    const row = await db
      .select({ details: activityLog.details })
      .from(activityLog)
      .where(eq(activityLog.companyId, companyId))
      .then((rows) => rows[0]);

    expect(row?.details).toEqual({
      bodySnippet: `${"x".repeat(119)}\uFFFD`,
      loneLow: "\uFFFD after",
      nested: [{ "note\uFFFD": "\u{1F534} intact" }],
    });

    const outbox = await db
      .select({ payload: pluginEventOutbox.payload })
      .from(pluginEventOutbox)
      .where(eq(pluginEventOutbox.companyId, companyId))
      .then((rows) => rows[0]);
    expect(outbox?.payload.payload).toMatchObject({
      bodySnippet: `${"x".repeat(119)}\uFFFD`,
      body: `${"x".repeat(119)}\u{1F534} tail`,
      cut: "y\uFFFD",
    });
  });
});
