import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { applyPendingMigrations, inspectMigrations } from "./client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const MIGRATION_FILE = "0265_repair_merge_queue_demoted_pull_request_work_products.sql";
const WEBHOOK_SOURCE = "github_pull_request_webhook";
const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function migrationHash(): Promise<string> {
  const content = await fs.promises.readFile(
    new URL(`./migrations/${MIGRATION_FILE}`, import.meta.url),
    "utf8",
  );
  return createHash("sha256").update(content).digest("hex");
}

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
}, 60_000);

/** `postgres`'s own JSON parameter type, so `sql.json` accepts these objects. */
type JsonObject = Record<string, postgres.JSONValue>;

type StoredRow = {
  id: string;
  status: string;
  metadata: Record<string, unknown>;
};

describeEmbeddedPostgres("merge-queue demoted PR work-product repair (PEN-4553)", () => {
  // The exact production shape, from the four rows verified 2026-10-23: a
  // merge delivered as `dequeued` mapped to `ready_for_review` / 10 / 46 while
  // carrying its own populated `mergedAt`. Controls that merged via `closed`
  // read `merged` / 30 / 50, which is the target shape.
  const DEMOTED_METADATA = {
    draft: false,
    branch: "cto/pen-4518-job-pod-hook-preflight",
    merged: false,
    source: WEBHOOK_SOURCE,
    headSha: "4bc3e56947f18a361b8b162025bca07f04548b8e",
    mergedAt: "2026-10-22T14:41:33Z",
    prNumber: 2931,
    repoFullName: "Blockcast/paperclip",
    lastEventAction: "dequeued",
    mergeQueueState: "dequeued",
    sourceEventOrder: 10,
    owningIdentifiers: ["PEN-4518"],
    sourceEventTimestamp: "2026-10-22T14:41:35.000Z",
    sourceEventActionOrder: 46,
    sourceEventTimestampMs: 1792680095000,
  } satisfies JsonObject;

  async function seed() {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-mq-demoted-repair-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    cleanups.push(async () => sql.end());

    const companyId = randomUUID();
    const issueId = randomUUID();
    await sql`
      DELETE FROM "drizzle"."__drizzle_migrations" WHERE "hash" = ${await migrationHash()}
    `;
    await sql`
      INSERT INTO "companies" ("id", "name", "issue_prefix")
      VALUES (${companyId}, 'Merge queue demotion co', 'PEN')
    `;
    await sql`
      INSERT INTO "issues" ("id", "company_id", "title", "identifier")
      VALUES (${issueId}, ${companyId}, 'Backfill demoted work products', 'PEN-4553')
    `;
    return { database, sql, companyId, issueId };
  }

  async function insertRow(
    sql: postgres.Sql,
    companyId: string,
    issueId: string,
    externalId: string,
    status: string,
    metadata: JsonObject,
  ): Promise<string> {
    const id = randomUUID();
    await sql`
      INSERT INTO "issue_work_products" (
        "id", "company_id", "issue_id", "type", "provider",
        "external_id", "title", "url", "status", "metadata"
      )
      VALUES (
        ${id}, ${companyId}, ${issueId}, 'pull_request', 'github',
        ${externalId}, ${externalId}, ${`https://github.com/${externalId}`},
        ${status}, ${sql.json(metadata)}
      )
    `;
    return id;
  }

  async function readRows(sql: postgres.Sql, ids: string[]): Promise<Map<string, StoredRow>> {
    const rows = await sql<StoredRow[]>`
      SELECT "id", "status", "metadata" FROM "issue_work_products" WHERE "id" IN ${sql(ids)}
    `;
    return new Map(rows.map((row) => [row.id, row]));
  }

  it("promotes a demoted row to the rank-50 merged shape and leaves every other row alone", async () => {
    const { database, sql, companyId, issueId } = await seed();

    // Repaired: the defect's output. Self-disproving — populated `mergedAt`
    // beside `merged: false`.
    const demotedId = await insertRow(
      sql, companyId, issueId, "Blockcast/paperclip#2931", "ready_for_review", { ...DEMOTED_METADATA },
    );

    // NOT repaired: a genuine queue EJECTION. Same `dequeued` action and the
    // same demoted ranks, but `mergedAt` is null because the PR did not merge.
    // This is the case that makes `mergedAt` — not `lastEventAction` — the
    // right witness, and the one a looser predicate would corrupt.
    const ejectedId = await insertRow(
      sql, companyId, issueId, "Blockcast/paperclip#2940", "ready_for_review",
      { ...DEMOTED_METADATA, prNumber: 2940, mergedAt: null },
    );

    // NOT repaired: closed without merging.
    const closedId = await insertRow(
      sql, companyId, issueId, "Blockcast/paperclip#2951", "closed",
      { ...DEMOTED_METADATA, prNumber: 2951, mergedAt: null, lastEventAction: "closed",
        mergeQueueState: null, sourceEventOrder: 20, sourceEventActionOrder: 30 },
    );

    // NOT repaired: an open draft.
    const draftId = await insertRow(
      sql, companyId, issueId, "Blockcast/paperclip#2697", "draft",
      { ...DEMOTED_METADATA, prNumber: 2697, mergedAt: null, draft: true,
        lastEventAction: "converted_to_draft", mergeQueueState: null, sourceEventActionOrder: 20 },
    );

    // NOT repaired: an agent-registered row. It carries the contradictory pair
    // but this webhook did not write it, so its metadata is not this
    // statement's to interpret.
    const agentRowId = await insertRow(
      sql, companyId, issueId, "Blockcast/paperclip#2900", "ready_for_review",
      { merged: false, mergedAt: "2026-10-20T10:00:00Z", source: "agent" },
    );

    // NOT repaired, and must gain no stamp: already correct via the `closed`
    // path. This row is where the target shape comes from.
    const controlId = await insertRow(
      sql, companyId, issueId, "Blockcast/paperclip#2930", "merged",
      { ...DEMOTED_METADATA, prNumber: 2930, merged: true, mergedAt: "2026-10-22T13:31:23Z",
        lastEventAction: "closed", mergeQueueState: null, sourceEventOrder: 30,
        sourceEventActionOrder: 50 },
    );

    expect(await inspectMigrations(database.connectionString)).toMatchObject({
      status: "needsMigrations",
      pendingMigrations: [MIGRATION_FILE],
    });
    await applyPendingMigrations(database.connectionString);

    const rows = await readRows(sql, [
      demotedId, ejectedId, closedId, draftId, agentRowId, controlId,
    ]);

    const repaired = rows.get(demotedId);
    expect(repaired?.status).toBe("merged");
    expect(repaired?.metadata).toMatchObject({
      merged: true,
      sourceEventOrder: 30,
      sourceEventActionOrder: 50,
    });
    // The repaired row is byte-identical in these fields to what the fixed
    // producer (PEN-4550) now writes for the same `dequeued` event.
    const control = rows.get(controlId);
    expect(repaired?.status).toBe(control?.status);
    for (const field of ["merged", "sourceEventOrder", "sourceEventActionOrder"] as const) {
      expect(repaired?.metadata[field]).toEqual(control?.metadata[field]);
    }

    // The event record is evidence, not a derived field: untouched, so the row
    // still shows it was delivered as a dequeue and repaired afterwards.
    expect(repaired?.metadata).toMatchObject({
      lastEventAction: "dequeued",
      mergeQueueState: "dequeued",
      mergedAt: DEMOTED_METADATA.mergedAt,
      headSha: DEMOTED_METADATA.headSha,
      sourceEventTimestampMs: DEMOTED_METADATA.sourceEventTimestampMs,
      branch: DEMOTED_METADATA.branch,
      owningIdentifiers: DEMOTED_METADATA.owningIdentifiers,
    });

    // The stamp is the only census this class has — there is no work-products
    // listing endpoint, so the set cannot be counted before the repair runs.
    expect(repaired?.metadata.statusCorrection).toEqual({
      issue: "PEN-4553",
      reason: "merge_queue_dequeued_demotion",
      fromStatus: "ready_for_review",
      fromMerged: false,
      fromSourceEventOrder: 10,
      fromSourceEventActionOrder: 46,
      fromLastEventAction: "dequeued",
    });

    for (const [label, id, status] of [
      ["genuine queue ejection", ejectedId, "ready_for_review"],
      ["closed unmerged", closedId, "closed"],
      ["open draft", draftId, "draft"],
      ["agent-registered row", agentRowId, "ready_for_review"],
      ["already-correct control", controlId, "merged"],
    ] as const) {
      const row = rows.get(id);
      expect(row?.status, label).toBe(status);
      expect(row?.metadata.statusCorrection, label).toBeUndefined();
    }
  }, 180_000);

  it("is a no-op on a second pass", async () => {
    const { database, sql, companyId, issueId } = await seed();
    const demotedId = await insertRow(
      sql, companyId, issueId, "Blockcast/paperclip#2946", "ready_for_review",
      { ...DEMOTED_METADATA, prNumber: 2946 },
    );

    await applyPendingMigrations(database.connectionString);
    const first = (await readRows(sql, [demotedId])).get(demotedId);

    await sql`DELETE FROM "drizzle"."__drizzle_migrations" WHERE "hash" = ${await migrationHash()}`;
    await applyPendingMigrations(database.connectionString);
    const second = (await readRows(sql, [demotedId])).get(demotedId);

    // If the second pass matched, `fromStatus` would have been overwritten with
    // `merged` and the original demoted status would be lost.
    expect(second).toEqual(first);
    expect(
      (second?.metadata.statusCorrection as Record<string, unknown> | undefined)?.fromStatus,
    ).toBe("ready_for_review");
  }, 180_000);
});
