import postgres from "postgres";
import { inspectMigrations } from "./client.js";

/**
 * Several migrations in this directory refuse to run on a populated database
 * and instead require an operator to precreate their index with
 * `CREATE INDEX CONCURRENTLY` first: Drizzle wraps each migration in a
 * transaction, and `CONCURRENTLY` cannot run inside one. The refusal is
 * correct — an in-transaction `CREATE INDEX` would take an ACCESS EXCLUSIVE
 * lock on a large live table.
 *
 * The problem is *where* the refusal surfaces. It is raised during server
 * startup, so the observable symptom is a worker that exits, crashloops, and
 * takes `helm upgrade --wait` down with it thirty minutes later reporting only
 * `context deadline exceeded`. `--atomic` then spends a second timeout failing
 * to roll back, because a pod stuck in CrashLoopBackOff cannot be evicted.
 * A one-line prerequisite costs an hour of deploy and a worker outage.
 *
 * `concurrent-index-guard.ts` states the assumption this falsifies:
 *
 *   > 0205, 0208, and 0209 are deliberately NOT listed here: each of those
 *   > migrations already RAISEs and stalls the migration itself when its index
 *   > is missing on a populated table [...] so deploy-time absence already
 *   > fails the migration step visibly without this module's help.
 *
 * It fails, but not visibly. This module moves that detection ahead of
 * `helm upgrade`, where it costs a second and prints the exact remediation.
 *
 * Scope, stated honestly: this checks that each guarded pending migration's
 * index **exists and is fully built**. It does not re-verify the index's
 * structure (columns, predicate, access method). A same-named index with a
 * different definition is caught by each migration's own structural check and
 * still surfaces the slow way. Absence is the case that has actually bitten a
 * production deploy, and it is the case this closes.
 *
 * Second scope limit, and it is why `decidePreflightBlocker` exists: the
 * guards refuse **only on a populated table**. Every migration in this family
 * has the same two-branch shape — if the index is absent it raises when
 * `EXISTS (SELECT 1 FROM <table> LIMIT 1)`, then builds the index inline.
 * On an empty table it raises nothing and needs no operator at all. Reporting
 * such a migration as a blocker is a false block, and on a fresh bootstrap
 * database — no journal, every migration pending, every index absent, every
 * table empty or not yet created — it is a false block on *every* registered
 * entry, which fails a deploy that would have succeeded unaided (BLO-31746).
 *
 * The exemption is deliberately narrow. It applies to an **absent** index
 * only. A half-built index takes the migration's *other* branch, which
 * requires `indisvalid` and raises with no emptiness test whatever — so an
 * empty table does not rescue it, and exempting that case would re-open the
 * outage this module exists to prevent.
 *
 * The emptiness probe is advisory, and that is acceptable rather than
 * engineered around: the table can gain its first row between this check and
 * the migration. The migration re-checks under `LOCK TABLE ... IN SHARE MODE`
 * and fails loudly if it happens, exactly as it does today. Racing to a false
 * *negative* leaves behaviour no worse than before this module existed;
 * today's false *positive* blocks every new environment unconditionally.
 */
export type PrecreateRequiredIndex = {
  /** Migration filename, exactly as it appears in `migrations/`. */
  readonly migration: string;
  /** Index the migration requires to already exist on a populated database. */
  readonly name: string;
  readonly table: string;
  /**
   * The migration's own remediation, copied verbatim from its `HINT`. Pinned
   * to the source by a test so the copy cannot drift into being wrong.
   */
  readonly createStatement: string;
};

/**
 * Every migration whose guard raises "requires online index precreation".
 *
 * A test asserts this list is exactly the set of migration files containing
 * that raise — add a guarded migration without registering it here and the
 * suite fails, because an unregistered migration is invisible to this
 * pre-flight and reproduces the outage it exists to prevent.
 */
export const PRECREATE_REQUIRED_INDEXES: readonly PrecreateRequiredIndex[] = [
  {
    migration: "0205_heartbeat_runs_company_finished_at_index.sql",
    name: "heartbeat_runs_company_finished_at_desc_idx",
    table: "heartbeat_runs",
    createStatement:
      "CREATE INDEX CONCURRENTLY IF NOT EXISTS heartbeat_runs_company_finished_at_desc_idx " +
      "ON heartbeat_runs USING btree (company_id, finished_at DESC, id DESC) WHERE finished_at IS NOT NULL",
  },
  {
    migration: "0208_heartbeat_runs_agent_dispatch_index.sql",
    name: "heartbeat_runs_agent_dispatch_idx",
    table: "heartbeat_runs",
    createStatement:
      "CREATE INDEX CONCURRENTLY IF NOT EXISTS heartbeat_runs_agent_dispatch_idx " +
      "ON heartbeat_runs USING btree (agent_id, status, created_at, id) " +
      "WHERE status IN ('queued', 'scheduled_retry')",
  },
  {
    migration: "0209_heartbeat_runs_recovery_dispatch_index.sql",
    name: "heartbeat_runs_recovery_dispatch_idx",
    table: "heartbeat_runs",
    createStatement:
      "CREATE INDEX CONCURRENTLY IF NOT EXISTS heartbeat_runs_recovery_dispatch_idx " +
      "ON heartbeat_runs USING btree (agent_id, created_at, id) " +
      "WHERE status = 'queued' AND (context_snapshot ->> 'source') = 'issue_recovery_action' " +
      "AND (context_snapshot ->> 'recoveryActionId') IS NOT NULL",
  },
  {
    migration: "0217_heartbeat_runs_queued_age_idx.sql",
    name: "heartbeat_runs_queued_age_idx",
    table: "heartbeat_runs",
    createStatement:
      "CREATE INDEX CONCURRENTLY IF NOT EXISTS heartbeat_runs_queued_age_idx " +
      "ON heartbeat_runs USING btree (agent_id, (coalesce(queued_at, created_at))) WHERE status = 'queued'",
  },
  {
    migration: "0224_heartbeat_runs_overdue_scheduled_retry_index.sql",
    name: "heartbeat_runs_overdue_scheduled_retry_idx",
    table: "heartbeat_runs",
    createStatement:
      "CREATE INDEX CONCURRENTLY IF NOT EXISTS heartbeat_runs_overdue_scheduled_retry_idx " +
      "ON heartbeat_runs USING btree (agent_id, scheduled_retry_at) WHERE status = 'scheduled_retry'",
  },
  {
    migration: "0230_heartbeat_runs_retry_successor_index.sql",
    name: "heartbeat_runs_retry_successor_idx",
    table: "heartbeat_runs",
    createStatement:
      "CREATE INDEX CONCURRENTLY IF NOT EXISTS heartbeat_runs_retry_successor_idx " +
      "ON heartbeat_runs USING btree (retry_of_run_id, created_at) WHERE retry_of_run_id IS NOT NULL",
  },
  {
    migration: "0233_alertmanager_aggregate_creation_dedupe.sql",
    name: "issues_active_alertmanager_aggregate_creation_uq",
    table: "issues",
    createStatement:
      "CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS issues_active_alertmanager_aggregate_creation_uq " +
      "ON issues USING btree (company_id, origin_kind, origin_fingerprint) " +
      "WHERE origin_kind = 'plugin:paperclip-plugin-alertmanager' AND origin_fingerprint <> 'default' " +
      "AND hidden_at IS NULL AND status NOT IN ('done', 'cancelled')",
  },
  {
    migration: "0236_active_pr_review_dedup.sql",
    name: "issues_active_pr_review_uq",
    table: "issues",
    createStatement:
      "CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS issues_active_pr_review_uq " +
      "ON issues USING btree (company_id, origin_kind, origin_fingerprint) " +
      "WHERE origin_kind = 'pr_review' AND origin_fingerprint <> 'default' " +
      "AND hidden_at IS NULL AND status NOT IN ('done', 'cancelled')",
  },
  {
    migration: "0237_heartbeat_runs_agent_queued_dispatch_index.sql",
    name: "heartbeat_runs_agent_queued_dispatch_idx",
    table: "heartbeat_runs",
    createStatement:
      "CREATE INDEX CONCURRENTLY IF NOT EXISTS heartbeat_runs_agent_queued_dispatch_idx " +
      "ON heartbeat_runs USING btree (agent_id, created_at, id) WHERE status = 'queued'",
  },
];

export type PreflightBlocker = {
  readonly migration: string;
  readonly index: string;
  readonly state: "absent" | "build-incomplete";
  readonly remediation: string;
};

/** What `pg_index` says about the prerequisite index right now. */
export type IndexProbe = { readonly exists: boolean; readonly usable: boolean };

/**
 * Whether the guard's own `EXISTS (SELECT 1 FROM <table>)` would fire.
 *
 * `absent` is the fresh-bootstrap case: the table has not been created yet
 * because the migration that creates it is itself still pending. It cannot
 * hold a row by the time the guard runs, so it is treated exactly like
 * `empty`.
 */
export type TablePopulation = "absent" | "empty" | "populated";

/**
 * Whether a guarded pending migration will actually stall, given what the
 * database looks like now. Pure, so both directions are testable without a
 * live database — the load-bearing one being that a populated table with a
 * missing index is still a blocker.
 */
export function decidePreflightBlocker(
  spec: PrecreateRequiredIndex,
  index: IndexProbe,
  table: TablePopulation,
): PreflightBlocker | null {
  if (index.usable) return null;

  if (index.exists) {
    // Takes the migration's structural branch, which demands `indisvalid` and
    // raises with no emptiness test. Emptiness is irrelevant here; reporting
    // it is the whole point of the module.
    return {
      migration: spec.migration,
      index: spec.name,
      state: "build-incomplete",
      remediation: spec.createStatement,
    };
  }

  // Index absent: the guard raises only if the table already has a row.
  // Otherwise the migration builds the index inline and needs no operator.
  if (table !== "populated") return null;

  return {
    migration: spec.migration,
    index: spec.name,
    state: "absent",
    remediation: spec.createStatement,
  };
}

export type PendingMigrationPreflightResult = {
  readonly pendingMigrations: readonly string[];
  /** Pending migrations that require a precreated index. */
  readonly guardedPending: readonly string[];
  /** Guarded pending migrations whose index is not usable yet. */
  readonly blockers: readonly PreflightBlocker[];
};

/**
 * Guarded specs whose migration has not been applied yet. An applied guarded
 * migration cannot stall anything, so it is not a blocker no matter what its
 * index looks like now.
 */
export function selectGuardedPendingIndexes(
  pendingMigrations: readonly string[],
  specs: readonly PrecreateRequiredIndex[] = PRECREATE_REQUIRED_INDEXES,
): readonly PrecreateRequiredIndex[] {
  const pending = new Set(pendingMigrations);
  return specs.filter((spec) => pending.has(spec.migration));
}

/** Operator-facing failure text: what stopped, why, and the exact fix. */
export function formatPreflightFailure(blockers: readonly PreflightBlocker[]): string {
  const lines = [
    `Deploy stopped before helm upgrade: ${blockers.length} pending migration(s) require an index that must be ` +
      `built online first. Drizzle runs migrations in a transaction, so these cannot build the index themselves; ` +
      `starting the rollout now would crashloop the worker and stall helm until its timeout expires.`,
    "",
    "Run each statement below against the target database, then re-run this deploy:",
    "",
  ];
  for (const blocker of blockers) {
    const reason =
      blocker.state === "absent"
        ? "index is absent"
        : "index exists but its online build never completed (not valid/ready); drop it first";
    lines.push(`  ${blocker.migration}`);
    lines.push(`    ${blocker.index}: ${reason}`);
    lines.push(`    ${blocker.remediation};`);
    lines.push("");
  }
  return lines.join("\n");
}

async function probeIndex(sql: ReturnType<typeof postgres>, name: string): Promise<IndexProbe> {
  const rows = await sql<{ indisvalid: boolean; indisready: boolean }[]>`
    select index_metadata.indisvalid, index_metadata.indisready
    from pg_index as index_metadata
    where index_metadata.indexrelid = to_regclass(${`public.${name}`})
  `;
  if (rows.length === 0) return { exists: false, usable: false };
  const [{ indisvalid, indisready }] = rows;
  return { exists: true, usable: indisvalid && indisready };
}

/**
 * Mirrors the guard's own `EXISTS (SELECT 1 FROM <table> LIMIT 1)`.
 *
 * The `to_regclass` hop is not optional. On a fresh bootstrap the table does
 * not exist yet, and selecting from it would raise `undefined_table` and abort
 * the pre-flight — turning the false block this fixes into a hard crash.
 * `to_regclass` returns NULL for a missing relation instead of erroring.
 */
async function probeTablePopulation(
  sql: ReturnType<typeof postgres>,
  table: string,
): Promise<TablePopulation> {
  const [present] = await sql<{ exists: boolean }[]>`
    select to_regclass(${`public.${table}`}) is not null as exists
  `;
  if (!present?.exists) return "absent";

  // `reltuples` is not usable here: it is an estimate, and -1 on a table that
  // has never been analyzed — which is every table on a fresh bootstrap.
  const rows = await sql`select 1 from ${sql(table)} limit 1`;
  return rows.length > 0 ? "populated" : "empty";
}

/**
 * Read-only. Reports which pending migrations cannot proceed because their
 * prerequisite index is missing or half-built. Safe to run against production
 * before a rollout: it opens one connection, issues catalog reads, and writes
 * nothing.
 */
export async function checkPendingMigrationPreflight(
  connectionString: string,
  options: { readonly specs?: readonly PrecreateRequiredIndex[] } = {},
): Promise<PendingMigrationPreflightResult> {
  const state = await inspectMigrations(connectionString);
  const pendingMigrations = state.status === "needsMigrations" ? state.pendingMigrations : [];
  const guarded = selectGuardedPendingIndexes(pendingMigrations, options.specs ?? PRECREATE_REQUIRED_INDEXES);

  if (guarded.length === 0) {
    return { pendingMigrations, guardedPending: [], blockers: [] };
  }

  const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
  const blockers: PreflightBlocker[] = [];
  // Several specs share a table (six of them are `heartbeat_runs`); probe each
  // distinct table once so a pre-flight stays a handful of round trips.
  const populationByTable = new Map<string, TablePopulation>();
  try {
    for (const spec of guarded) {
      const index = await probeIndex(sql, spec.name);
      let population = populationByTable.get(spec.table);
      if (population === undefined) {
        population = await probeTablePopulation(sql, spec.table);
        populationByTable.set(spec.table, population);
      }
      const blocker = decidePreflightBlocker(spec, index, population);
      if (blocker) blockers.push(blocker);
    }
  } finally {
    await sql.end();
  }

  return {
    pendingMigrations,
    guardedPending: guarded.map((spec) => spec.migration),
    blockers,
  };
}
