import { describe, expect, it } from "vitest";
import postgres from "postgres";
import { applyPendingMigrations, inspectMigrations } from "./client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(`SKIP: ${embeddedPostgresSupport.reason ?? "unsupported"}`);
}

// The 9 un-journaled .sql files on master and the objects they create.
const UNJOURNALED_EXPECTATIONS = [
  { file: "0046_smooth_sentinels", column: ["document_revisions", "title"] },
  { file: "0046_smooth_sentinels", column: ["document_revisions", "format"] },
  { file: "0102_server_side_sweep_preflight", column: ["companies", "feature_flags"] },
  { file: "0103_activity_log_issue_lookup_indexes", index: "idx_activity_log_issue_company_entity_created" },
  { file: "0103_activity_log_issue_lookup_indexes", index: "idx_activity_log_issue_company_entity_action_created" },
  { file: "0104_heartbeat_run_issue_scope_indexes", index: "idx_heartbeat_runs_company_agent_context_issue_created" },
  { file: "0105_plugin_event_outbox", table: "plugin_event_outbox" },
  { file: "0106_issue_pull_requests", table: "issue_pull_requests" },
  { file: "0114_issue_evidence_verdict_evaluated_at", column: ["issues", "last_evidence_verdict_evaluated_at"] },
  { file: "0115_milestones", table: "milestones" },
  { file: "0115_milestones", column: ["issues", "milestone_id"] },
  { file: "0115_milestones", column: ["issues", "target_date"] },
  { file: "0116_evidence_verdict_idx_partial", index: "issues_company_evidence_verdict_evaluated_idx" },
];

describeEmbeddedPostgres("un-journaled migrations still apply (BLO-27927)", () => {
  it("applies un-journaled .sql files to a fresh database", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-blo27927-");
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    try {
      await applyPendingMigrations(database.connectionString);
      const state = await inspectMigrations(database.connectionString);
      console.log(`\n[STATE] status=${state.status} available=${state.availableMigrations.length}`);

      // Which migration files did the apply path record as applied?
      const applied = await sql<{ hash: string; created_at: string }[]>`
        select hash, created_at::text from drizzle.__drizzle_migrations order by created_at
      `;
      console.log(`[APPLIED ROWS] ${applied.length}`);

      const results: string[] = [];
      for (const exp of UNJOURNALED_EXPECTATIONS) {
        let present = false;
        let what = "";
        if (exp.table) {
          what = `table ${exp.table}`;
          const r = await sql<{ n: number }[]>`
            select count(*)::int as n from information_schema.tables
            where table_schema='public' and table_name=${exp.table}`;
          present = (r[0]?.n ?? 0) > 0;
        } else if (exp.column) {
          const [t, c] = exp.column;
          what = `column ${t}.${c}`;
          const r = await sql<{ n: number }[]>`
            select count(*)::int as n from information_schema.columns
            where table_schema='public' and table_name=${t} and column_name=${c}`;
          present = (r[0]?.n ?? 0) > 0;
        } else if (exp.index) {
          what = `index ${exp.index}`;
          const r = await sql<{ n: number }[]>`
            select count(*)::int as n from pg_indexes
            where schemaname='public' and indexname=${exp.index}`;
          present = (r[0]?.n ?? 0) > 0;
        }
        results.push(`${present ? "PRESENT" : "MISSING"}  ${exp.file}  ->  ${what}`);
      }
      console.log("\n===== UN-JOURNALED OBJECT PRESENCE ON FRESH DB =====");
      for (const line of results) console.log(line);
      console.log("====================================================\n");

      const missing = results.filter((r) => r.startsWith("MISSING"));
      expect(missing, `missing objects:\n${missing.join("\n")}`).toEqual([]);
    } finally {
      await sql.end();
      await database.cleanup();
    }
  }, 300_000);
});
