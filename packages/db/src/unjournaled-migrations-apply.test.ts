import { describe, expect, it } from "vitest";
import postgres from "postgres";
import { applyPendingMigrations, inspectMigrations } from "./client.js";
import { GRANDFATHERED_UNJOURNALED_MIGRATIONS } from "./check-migration-numbering.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

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

// Needs no database, so it still runs where embedded postgres is unavailable.
describe("un-journaled migration coverage (BLO-27927)", () => {
  it("covers exactly the files the checker grandfathers", () => {
    // The two lists describe the same population. Without this, adding an
    // allowlist entry leaves the new file untested by the regression guard below.
    expect(new Set(UNJOURNALED_EXPECTATIONS.map((expectation) => `${expectation.file}.sql`))).toEqual(
      new Set(GRANDFATHERED_UNJOURNALED_MIGRATIONS),
    );
  });
});

describeEmbeddedPostgres("un-journaled migrations still apply (BLO-27927)", () => {
  it("applies un-journaled .sql files to a fresh database", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-blo27927-");
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    try {
      await applyPendingMigrations(database.connectionString);
      const state = await inspectMigrations(database.connectionString);

      // The load-bearing fact of BLO-27927: the apply path is directory-driven,
      // not journal-driven, so EVERY .sql on disk is applied — not just the 213
      // journaled ones. Read the raw table rather than state.appliedMigrations,
      // which resolves hashes and can fall back to slicing by row count
      // (client.ts loadAppliedMigrations), making it circular for this assertion.
      const applied = await sql<{ hash: string; created_at: string }[]>`
        select hash, created_at::text from drizzle.__drizzle_migrations order by created_at
      `;
      expect(
        applied.length,
        `every .sql on disk should be applied: ${state.availableMigrations.length} files on disk, ` +
          `${applied.length} rows in drizzle.__drizzle_migrations`,
      ).toBe(state.availableMigrations.length);

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

      const missing = results.filter((r) => r.startsWith("MISSING"));
      expect(missing, `missing objects:\n${missing.join("\n")}`).toEqual([]);
    } finally {
      await sql.end();
      await database.cleanup();
    }
  }, 300_000);
});
