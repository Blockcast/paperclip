import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  applyPendingMigrations,
  inspectMigrations,
} from "./client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const EXTERNAL_IDENTITY_MIGRATION = "0208_issue_work_products_external_identity.sql";

const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function createTempDatabase(): Promise<string> {
  const db = await startEmbeddedPostgresTestDatabase("paperclip-work-products-external-id-");
  cleanups.push(db.cleanup);
  return db.connectionString;
}

async function migrationHash(migrationFile: string): Promise<string> {
  const content = await fs.promises.readFile(
    new URL(`./migrations/${migrationFile}`, import.meta.url),
    "utf8",
  );
  return createHash("sha256").update(content).digest("hex");
}

async function makeExternalIdentityMigrationPending(
  sql: ReturnType<typeof postgres>,
): Promise<void> {
  const hash = await migrationHash(EXTERNAL_IDENTITY_MIGRATION);
  await sql`
    DELETE FROM "drizzle"."__drizzle_migrations"
    WHERE "hash" = ${hash}
  `;
}

async function createSeedIssue(sql: ReturnType<typeof postgres>) {
  const companyId = randomUUID();
  const issueId = randomUUID();

  await sql`
    INSERT INTO "companies" ("id", "name", "issue_prefix")
    VALUES (${companyId}, 'External ID Migration Co', 'BLO')
  `;
  await sql`
    INSERT INTO "issues" ("id", "company_id", "title", "identifier")
    VALUES (${issueId}, ${companyId}, 'Deduplicate PR work products', 'BLO-19566')
  `;

  return { companyId, issueId };
}

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    await cleanup?.();
  }
}, 60_000);

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue work product external identity migration tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue work products external identity migration", () => {
  it(
    "clears older duplicate external identities before creating the unique index",
    async () => {
      const connectionString = await createTempDatabase();
      const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
      const olderId = randomUUID();
      const newerId = randomUUID();
      const externalId = "Blockcast/paperclip#920";

      try {
        await makeExternalIdentityMigrationPending(sql);
        await sql`DROP INDEX IF EXISTS "issue_work_products_issue_provider_type_external_id_uniq"`;
        const { companyId, issueId } = await createSeedIssue(sql);
        await sql`
          INSERT INTO "issue_work_products" (
            "id",
            "company_id",
            "issue_id",
            "type",
            "provider",
            "external_id",
            "title",
            "url",
            "status",
            "metadata",
            "created_at",
            "updated_at"
          )
          VALUES
            (
              ${olderId},
              ${companyId},
              ${issueId},
              'pull_request',
              'github',
              ${externalId},
              'older duplicate',
              'https://github.com/Blockcast/paperclip/pull/920',
              'ready_for_review',
              '{"source":"github_pull_request_webhook"}'::jsonb,
              '2026-04-29T10:00:00Z'::timestamptz,
              '2026-04-29T10:00:00Z'::timestamptz
            ),
            (
              ${newerId},
              ${companyId},
              ${issueId},
              'pull_request',
              'github',
              ${externalId},
              'newer duplicate',
              'https://github.com/Blockcast/paperclip/pull/920',
              'ready_for_review',
              '{"source":"github_pull_request_webhook"}'::jsonb,
              '2026-04-29T11:00:00Z'::timestamptz,
              '2026-04-29T11:00:00Z'::timestamptz
            )
        `;
      } finally {
        await sql.end();
      }

      const pendingState = await inspectMigrations(connectionString);
      expect(pendingState).toMatchObject({
        status: "needsMigrations",
        pendingMigrations: [EXTERNAL_IDENTITY_MIGRATION],
        reason: "pending-migrations",
      });

      await applyPendingMigrations(connectionString);

      const verifySql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        const rows = await verifySql<{
          id: string;
          external_id: string | null;
          metadata: Record<string, unknown> | null;
        }[]>`
          SELECT "id", "external_id", "metadata"
          FROM "issue_work_products"
          WHERE "id" IN (${olderId}, ${newerId})
          ORDER BY "title"
        `;

        expect(rows).toEqual([
          expect.objectContaining({
            id: newerId,
            external_id: externalId,
          }),
          expect.objectContaining({
            id: olderId,
            external_id: null,
            metadata: expect.objectContaining({
              dedupedExternalId: externalId,
              dedupedByMigration: EXTERNAL_IDENTITY_MIGRATION.replace(".sql", ""),
            }),
          }),
        ]);

        const indexes = await verifySql<{ indexname: string }[]>`
          SELECT "indexname"
          FROM "pg_indexes"
          WHERE "schemaname" = 'public'
            AND "indexname" = 'issue_work_products_issue_provider_type_external_id_uniq'
        `;
        expect(indexes).toEqual([{ indexname: "issue_work_products_issue_provider_type_external_id_uniq" }]);
      } finally {
        await verifySql.end();
      }

      const finalState = await inspectMigrations(connectionString);
      expect(finalState.status).toBe("upToDate");
    },
    60_000,
  );
});
