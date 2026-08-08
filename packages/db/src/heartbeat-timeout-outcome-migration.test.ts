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
  it("repairs only confirmed exit-zero timeouts and their linked wake requests", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-timeout-repair-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    cleanups.push(async () => sql.end());

    const companyId = randomUUID();
    const affectedAgentId = randomUUID();
    const unrelatedAgentId = randomUUID();
    const correctedRunId = randomUUID();
    const genuineTimeoutRunId = randomUUID();
    const ambiguousRunId = randomUUID();
    const structuredFailureRunId = randomUUID();
    const unrelatedRunId = randomUUID();
    const existingSuccessRunId = randomUUID();
    const correctedWakeupId = randomUUID();
    const genuineTimeoutWakeupId = randomUUID();
    const ambiguousWakeupId = randomUUID();
    const structuredFailureWakeupId = randomUUID();

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
      VALUES
        (${affectedAgentId}, ${companyId}, 'Affected timeout agent', 'engineer', 'opencode_k8s', '{}'::jsonb),
        (${unrelatedAgentId}, ${companyId}, 'Unrelated timeout agent', 'engineer', 'claude_k8s', '{}'::jsonb)
    `;
    await sql`
      INSERT INTO "agent_wakeup_requests" (
        "id",
        "company_id",
        "agent_id",
        "source",
        "status",
        "error"
      )
      VALUES
        (${correctedWakeupId}, ${companyId}, ${affectedAgentId}, 'test', 'timed_out', 'Timed out after 300s'),
        (${genuineTimeoutWakeupId}, ${companyId}, ${affectedAgentId}, 'test', 'timed_out', 'Timed out after 300s'),
        (${ambiguousWakeupId}, ${companyId}, ${affectedAgentId}, 'test', 'timed_out', 'Result publication failed'),
        (${structuredFailureWakeupId}, ${companyId}, ${affectedAgentId}, 'test', 'timed_out', 'Timed out after 300s')
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
          ${correctedRunId},
          ${companyId},
          ${affectedAgentId},
          ${correctedWakeupId},
          'timed_out',
          'Timed out after 300s',
          'timeout',
          ${sql.json({
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
          ${affectedAgentId},
          ${genuineTimeoutWakeupId},
          'timed_out',
          'Timed out',
          'timeout',
          ${sql.json({ error: "real timeout" })},
          'stalled',
          'timeout',
          137
        ),
        (
          ${ambiguousRunId},
          ${companyId},
          ${affectedAgentId},
          ${ambiguousWakeupId},
          'timed_out',
          'Result publication failed',
          'timeout',
          ${sql.json({ error: "publish failed", message: "real result", kept: "yes" })},
          'stalled',
          'timeout',
          0
        ),
        (
          ${structuredFailureRunId},
          ${companyId},
          ${affectedAgentId},
          ${structuredFailureWakeupId},
          'timed_out',
          'Timed out after 300s',
          'timeout',
          ${sql.json({ is_error: true, subtype: "error_during_execution", kept: "yes" })},
          'stalled',
          'timeout',
          0
        ),
        (
          ${unrelatedRunId},
          ${companyId},
          ${unrelatedAgentId},
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
          ${existingSuccessRunId},
          ${companyId},
          ${affectedAgentId},
          NULL,
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
      result_json: Record<string, unknown> | null;
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
      WHERE "id" IN (
        ${correctedRunId},
        ${genuineTimeoutRunId},
        ${ambiguousRunId},
        ${structuredFailureRunId},
        ${unrelatedRunId},
        ${existingSuccessRunId}
      )
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
    expect(rowsById.get(ambiguousRunId)).toMatchObject({
      status: "timed_out",
      error: "Result publication failed",
      error_code: "timeout",
      result_json: { error: "publish failed", message: "real result", kept: "yes" },
      result_error: "publish failed",
      result_message: "real result",
      liveness_state: "stalled",
      liveness_reason: "timeout",
      exit_code: 0,
    });
    expect(rowsById.get(structuredFailureRunId)).toMatchObject({
      status: "timed_out",
      error: "Timed out after 300s",
      error_code: "timeout",
      result_json: { is_error: true, subtype: "error_during_execution", kept: "yes" },
      liveness_state: "stalled",
      liveness_reason: "timeout",
      exit_code: 0,
    });
    expect(rowsById.get(unrelatedRunId)).toMatchObject({
      status: "timed_out",
      error: null,
      error_code: "timeout",
      result_json: null,
      liveness_state: "stalled",
      liveness_reason: "timeout",
      exit_code: 0,
    });
    expect(rowsById.get(existingSuccessRunId)).toMatchObject({
      status: "succeeded",
      result_json: { message: "already good" },
      result_message: "already good",
      exit_code: 0,
    });

    const wakeups = await sql<{
      id: string;
      status: string;
      error: string | null;
    }[]>`
      SELECT "id", "status", "error"
      FROM "agent_wakeup_requests"
      WHERE "id" IN (
        ${correctedWakeupId},
        ${genuineTimeoutWakeupId},
        ${ambiguousWakeupId},
        ${structuredFailureWakeupId}
      )
    `;
    const wakeupsById = new Map(wakeups.map((wakeup) => [wakeup.id, wakeup]));
    expect(wakeupsById.get(correctedWakeupId)).toEqual({
      id: correctedWakeupId,
      status: "completed",
      error: null,
    });
    expect(wakeupsById.get(genuineTimeoutWakeupId)).toMatchObject({
      status: "timed_out",
      error: "Timed out after 300s",
    });
    expect(wakeupsById.get(ambiguousWakeupId)).toMatchObject({
      status: "timed_out",
      error: "Result publication failed",
    });
    expect(wakeupsById.get(structuredFailureWakeupId)).toMatchObject({
      status: "timed_out",
      error: "Timed out after 300s",
    });
    expect((await inspectMigrations(database.connectionString)).status).toBe("upToDate");
  }, 60_000);
});
