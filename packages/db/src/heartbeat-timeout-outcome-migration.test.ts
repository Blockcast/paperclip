import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { applyPendingMigrations, inspectMigrations } from "./client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const MIGRATION_FILE = "0212_repair_successful_runs_mislabeled_timed_out.sql";
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

describeEmbeddedPostgres("heartbeat timeout outcome repair migration", () => {
  it("repairs only exit-zero timeouts without writing generated result columns", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-timeout-repair-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    cleanups.push(async () => sql.end());

    const companyId = randomUUID();
    const agentId = randomUUID();
    const correctedRunId = randomUUID();
    const genuineTimeoutRunId = randomUUID();
    const existingSuccessRunId = randomUUID();

    await sql`
      DELETE FROM "drizzle"."__drizzle_migrations"
      WHERE "hash" = ${await migrationHash()}
    `;
    await sql`
      INSERT INTO "companies" ("id", "name", "issue_prefix")
      VALUES (${companyId}, 'Timeout migration company', 'TMO')
    `;
    await sql`
      INSERT INTO "agents" ("id", "company_id", "name", "role", "adapter_type", "adapter_config")
      VALUES (${agentId}, ${companyId}, 'Timeout migration agent', 'engineer', 'process', '{}'::jsonb)
    `;
    await sql`
      INSERT INTO "heartbeat_runs" (
        "id",
        "company_id",
        "agent_id",
        "status",
        "error",
        "error_code",
        "result_json",
        "liveness_state",
        "liveness_reason",
        "exit_code"
      )
      VALUES
        (
          ${correctedRunId},
          ${companyId},
          ${agentId},
          'timed_out',
          'Timed out',
          'timeout',
          ${sql.json({
            error: "old error",
            message: "old message",
            stopReason: "timeout",
            timeoutFired: true,
            timeoutSource: "adapter",
            kept: "yes",
          })},
          'stalled',
          'timeout',
          0
        ),
        (
          ${genuineTimeoutRunId},
          ${companyId},
          ${agentId},
          'timed_out',
          'Timed out',
          'timeout',
          ${sql.json({ error: "real timeout" })},
          'stalled',
          'timeout',
          137
        ),
        (
          ${existingSuccessRunId},
          ${companyId},
          ${agentId},
          'succeeded',
          NULL,
          NULL,
          ${sql.json({ message: "already good" })},
          NULL,
          NULL,
          0
        )
    `;

    expect(await inspectMigrations(database.connectionString)).toMatchObject({
      status: "needsMigrations",
      pendingMigrations: [MIGRATION_FILE],
    });
    await applyPendingMigrations(database.connectionString);

    const rows = await sql<{
      id: string;
      status: string;
      error: string | null;
      error_code: string | null;
      result_json: Record<string, unknown>;
      result_error: string | null;
      result_message: string | null;
      liveness_state: string | null;
      liveness_reason: string | null;
      exit_code: number;
    }[]>`
      SELECT
        "id",
        "status",
        "error",
        "error_code",
        "result_json",
        "result_error",
        "result_message",
        "liveness_state",
        "liveness_reason",
        "exit_code"
      FROM "heartbeat_runs"
      WHERE "id" IN (${correctedRunId}, ${genuineTimeoutRunId}, ${existingSuccessRunId})
    `;
    const rowsById = new Map(rows.map((row) => [row.id, row]));

    expect(rowsById.get(correctedRunId)).toEqual({
      id: correctedRunId,
      status: "succeeded",
      error: null,
      error_code: null,
      result_json: {
        kept: "yes",
        outcomeCorrection: {
          issue: "BLO-22922",
          from: "timed_out",
          reason: "exit_code_0",
        },
      },
      result_error: null,
      result_message: null,
      liveness_state: null,
      liveness_reason: null,
      exit_code: 0,
    });
    expect(rowsById.get(genuineTimeoutRunId)).toMatchObject({
      status: "timed_out",
      error: "Timed out",
      error_code: "timeout",
      result_json: { error: "real timeout" },
      result_error: "real timeout",
      liveness_state: "stalled",
      liveness_reason: "timeout",
      exit_code: 137,
    });
    expect(rowsById.get(existingSuccessRunId)).toMatchObject({
      status: "succeeded",
      result_json: { message: "already good" },
      result_message: "already good",
      exit_code: 0,
    });
    expect((await inspectMigrations(database.connectionString)).status).toBe("upToDate");
  }, 60_000);
});
