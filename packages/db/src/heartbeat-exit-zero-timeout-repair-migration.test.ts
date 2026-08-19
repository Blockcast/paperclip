import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { applyPendingMigrations, inspectMigrations } from "./client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const MIGRATION_FILE = "0221_repair_exit_zero_timeouts_after_adapter_migration.sql";
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

describeEmbeddedPostgres("exit-zero timeout repair after adapter migration", () => {
  // 0214 gated the same repair on `agents.adapter_type = 'opencode_k8s'`. The one
  // affected agent had already been moved to claude_k8s by the time it shipped, so
  // it matched nothing. This asserts the repair survives that adapter migration.
  it("repairs exit-zero timeouts whose agent has since moved off opencode_k8s", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-exit-zero-timeout-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    cleanups.push(async () => sql.end());

    const companyId = randomUUID();
    // The production shape: mislabelled while on opencode_k8s, since migrated.
    const migratedAgentId = randomUUID();
    const stillOpencodeAgentId = randomUUID();

    const migratedRunId = randomUUID();
    const nullErrorRunId = randomUUID();
    const stillOpencodeRunId = randomUUID();
    const genuineTimeoutRunId = randomUUID();
    const ambiguousRunId = randomUUID();

    const migratedWakeupId = randomUUID();
    const genuineTimeoutWakeupId = randomUUID();

    await sql`
      DELETE FROM "drizzle"."__drizzle_migrations"
      WHERE "hash" = ${await migrationHash()}
    `;
    await sql`
      INSERT INTO "companies" ("id", "name", "issue_prefix")
      VALUES (${companyId}, 'Exit zero timeout company', 'EZT')
    `;
    await sql`
      INSERT INTO "agents" ("id", "company_id", "name", "role", "adapter_type", "adapter_config")
      VALUES
        (${migratedAgentId}, ${companyId}, 'Migrated agent', 'engineer', 'claude_k8s', '{}'::jsonb),
        (${stillOpencodeAgentId}, ${companyId}, 'Still opencode agent', 'engineer', 'opencode_k8s', '{}'::jsonb)
    `;
    await sql`
      INSERT INTO "agent_wakeup_requests" (
        "id", "company_id", "agent_id", "source", "status", "error"
      )
      VALUES
        (${migratedWakeupId}, ${companyId}, ${migratedAgentId}, 'test', 'timed_out', 'Timed out after 3600s'),
        (${genuineTimeoutWakeupId}, ${companyId}, ${migratedAgentId}, 'test', 'timed_out', 'Timed out after 3600s')
    `;
    await sql`
      INSERT INTO "heartbeat_runs" (
        "id",
        "company_id",
        "agent_id",
        "wakeup_request_id",
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
          ${migratedRunId},
          ${companyId},
          ${migratedAgentId},
          ${migratedWakeupId},
          'timed_out',
          'Timed out after 3600s',
          'timeout',
          ${sql.json({
            stopReason: "timeout",
            timeoutFired: true,
            timeoutSource: "adapter",
            timeoutConfigured: true,
            effectiveTimeoutSec: 3600,
            kept: "yes",
          })},
          'stalled',
          'timeout',
          0
        ),
        (
          ${nullErrorRunId},
          ${companyId},
          ${migratedAgentId},
          NULL,
          'timed_out',
          NULL,
          'timeout',
          NULL,
          'stalled',
          'timeout',
          0
        ),
        (
          ${stillOpencodeRunId},
          ${companyId},
          ${stillOpencodeAgentId},
          NULL,
          'timed_out',
          'Timed out after 600s',
          'timeout',
          NULL,
          'stalled',
          'timeout',
          0
        ),
        (
          ${genuineTimeoutRunId},
          ${companyId},
          ${migratedAgentId},
          ${genuineTimeoutWakeupId},
          'timed_out',
          'Timed out after 3600s',
          'timeout',
          NULL,
          'stalled',
          'timeout',
          137
        ),
        (
          ${ambiguousRunId},
          ${companyId},
          ${migratedAgentId},
          NULL,
          'timed_out',
          'Timed out after 3600s',
          'timeout',
          ${sql.json({ is_error: true, subtype: "error_during_execution" })},
          'stalled',
          'timeout',
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
      result_json: Record<string, unknown> | null;
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
        "liveness_state",
        "liveness_reason",
        "exit_code"
      FROM "heartbeat_runs"
      WHERE "id" IN (
        ${migratedRunId},
        ${nullErrorRunId},
        ${stillOpencodeRunId},
        ${genuineTimeoutRunId},
        ${ambiguousRunId}
      )
    `;
    const rowsById = new Map(rows.map((row) => [row.id, row]));

    // The regression 0214 missed: current adapter_type is claude_k8s, repair still lands.
    expect(rowsById.get(migratedRunId)).toEqual({
      id: migratedRunId,
      status: "succeeded",
      error: null,
      error_code: null,
      result_json: {
        timeoutConfigured: true,
        effectiveTimeoutSec: 3600,
        kept: "yes",
        outcomeCorrection: {
          issue: "BLO-22922",
          from: "timed_out",
          reason: "exit_code_0",
        },
      },
      liveness_state: null,
      liveness_reason: null,
      exit_code: 0,
    });
    expect(rowsById.get(nullErrorRunId)).toMatchObject({
      status: "succeeded",
      error: null,
      error_code: null,
      exit_code: 0,
    });
    // Agents still on opencode_k8s are repaired by the same predicate.
    expect(rowsById.get(stillOpencodeRunId)).toMatchObject({
      status: "succeeded",
      error: null,
      error_code: null,
      exit_code: 0,
    });
    // A real over-deadline kill keeps its timeout outcome.
    expect(rowsById.get(genuineTimeoutRunId)).toMatchObject({
      status: "timed_out",
      error: "Timed out after 3600s",
      error_code: "timeout",
      liveness_state: "stalled",
      liveness_reason: "timeout",
      exit_code: 137,
    });
    // An exit-zero row carrying a structured adapter error stays for an operator.
    expect(rowsById.get(ambiguousRunId)).toMatchObject({
      status: "timed_out",
      error_code: "timeout",
      result_json: { is_error: true, subtype: "error_during_execution" },
      exit_code: 0,
    });

    const wakeups = await sql<{ id: string; status: string; error: string | null }[]>`
      SELECT "id", "status", "error"
      FROM "agent_wakeup_requests"
      WHERE "id" IN (${migratedWakeupId}, ${genuineTimeoutWakeupId})
    `;
    const wakeupsById = new Map(wakeups.map((wakeup) => [wakeup.id, wakeup]));
    expect(wakeupsById.get(migratedWakeupId)).toEqual({
      id: migratedWakeupId,
      status: "completed",
      error: null,
    });
    expect(wakeupsById.get(genuineTimeoutWakeupId)).toMatchObject({
      status: "timed_out",
      error: "Timed out after 3600s",
    });

    expect((await inspectMigrations(database.connectionString)).status).toBe("upToDate");
  }, 60_000);
});
