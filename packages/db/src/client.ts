import { createHash } from "node:crypto";
import { drizzle as drizzlePg } from "drizzle-orm/postgres-js";
import { migrate as migratePg } from "drizzle-orm/postgres-js/migrator";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import postgres, { type Sql } from "postgres";
import * as schema from "./schema/index.js";
import { registerTrackedClient } from "./embedded-test-client-registry.js";
import {
  acquireSerializingLock,
  DEFAULT_LOCK_WAIT_TIMEOUT_MS,
  DEFAULT_STATEMENT_TIMEOUT_MS,
  ensureConcurrentIndexesForMigration,
} from "./concurrent-index-guard.js";

const MIGRATIONS_FOLDER = fileURLToPath(new URL("./migrations", import.meta.url));
const DRIZZLE_MIGRATIONS_TABLE = "__drizzle_migrations";
const MIGRATIONS_JOURNAL_JSON = fileURLToPath(new URL("./migrations/meta/_journal.json", import.meta.url));

/**
 * `lock_timeout` for transactional migration DDL (BLO-42005).
 *
 * The role this deployment connects as carries `lock_timeout = 15s` and
 * `statement_timeout = 30s` — transcribed in
 * {@link POSTGRES_ROLE_IDLE_IN_TRANSACTION_TIMEOUT_MS}'s doc block, which is
 * the single place those values are recorded. 15s is the bound the rev-795
 * rollout lost, and neither value is the right one for a migration: the first
 * is too long to fail fast and the second too short to finish an index build.
 *
 * SHORT ON PURPOSE, and raising it makes things worse rather than better. A
 * pending ACCESS EXCLUSIVE request — what `ALTER TABLE cost_events ADD COLUMN`
 * and `DROP INDEX`/`CREATE UNIQUE INDEX` need — queues every later lock request
 * on that table behind it, so a patient DDL statement converts a lock conflict
 * into a live outage of the table. Fail fast and retry instead: during a
 * rolling deploy the old pods' traffic releases its AccessShareLocks in gaps,
 * and an attempt landing in a gap wins immediately.
 *
 * This is deliberately shorter than `concurrent-index-guard`'s 2 minutes:
 * `CREATE INDEX CONCURRENTLY` takes only ShareUpdateExclusive, which blocks
 * neither readers nor writers, so patience there is free. Here it is not.
 */
const MIGRATION_DDL_LOCK_TIMEOUT_MS = 3_000;
/**
 * Attempts per migration file before a lock race is reported as a failure.
 *
 * 12 attempts against a 3s lock_timeout and a 1s..8s backoff is a ceiling of
 * roughly 100s per file — bounded, and well under the 2-minute single wait
 * `concurrent-index-guard` already tolerates on the same startup path, so this
 * adds no new worst case to pod startup.
 */
const MIGRATION_LOCK_RETRY_ATTEMPTS = 12;
const MIGRATION_LOCK_RETRY_BASE_DELAY_MS = 1_000;
const MIGRATION_LOCK_RETRY_MAX_DELAY_MS = 8_000;

/**
 * SQLSTATEs worth replaying a whole migration file for.
 *
 * `55P03` (lock_not_available) is `MIGRATION_DDL_LOCK_TIMEOUT_MS` firing while
 * waiting for the lock, and `40P01` (deadlock_detected) is two sessions
 * crossing. Both abort before the statement touches a row, and
 * `runInTransaction` has already rolled the file back, so a replay cannot
 * observe a partial write.
 *
 * `57014` (statement_timeout) is deliberately NOT here. With a 10-minute
 * statement_timeout it means the work itself ran that long, so replaying would
 * double an outage rather than dodge a race.
 */
const MIGRATION_LOCK_RETRY_SQLSTATES = new Set(["55P03", "40P01"]);

function isMigrationLockContention(error: unknown): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" && MIGRATION_LOCK_RETRY_SQLSTATES.has(code);
}

/** Run `apply`, replaying it with backoff while it keeps losing a lock race. */
async function withMigrationLockRetry(
  migrationFile: string,
  apply: () => Promise<void>,
  log?: (message: string) => void,
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await apply();
      return;
    } catch (error) {
      if (attempt >= MIGRATION_LOCK_RETRY_ATTEMPTS || !isMigrationLockContention(error)) throw error;
      const delayMs = Math.min(
        MIGRATION_LOCK_RETRY_BASE_DELAY_MS * attempt,
        MIGRATION_LOCK_RETRY_MAX_DELAY_MS,
      );
      log?.(
        `${migrationFile}: lost the lock race on attempt ${attempt}/${MIGRATION_LOCK_RETRY_ATTEMPTS} `
        + `(${(error as { code?: string }).code}); retrying in ${delayMs}ms`,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

/**
 * Put this session into migration posture: owner of the cross-process
 * serializing lock, with the sequence's statement and DDL lock timeouts.
 *
 * Idempotent, and called again at the start of every attempt on purpose.
 * postgres.js reconnects transparently, and a reconnect drops both the `SET`s
 * and the session-scoped advisory lock with no error — leaving a retry running
 * under the role's own 15s `lock_timeout` with no serialization at all, which
 * is precisely the state BLO-42005 is about. `pg_try_advisory_lock` on a
 * session that already holds the key just increments its nesting count, so
 * re-asserting costs three round-trips on a path that runs a handful of times
 * per deploy.
 */
async function prepareMigrationSession(sql: ReturnType<typeof createUtilitySql>): Promise<void> {
  await acquireSerializingLock(sql, DEFAULT_LOCK_WAIT_TIMEOUT_MS);
  await sql.unsafe(`SET statement_timeout = '${DEFAULT_STATEMENT_TIMEOUT_MS}ms'`);
  await sql.unsafe(`SET lock_timeout = '${MIGRATION_DDL_LOCK_TIMEOUT_MS}ms'`);
}

function createUtilitySql(url: string) {
  return postgres(url, { max: 1, onnotice: () => {} });
}

function isSafeIdentifier(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function quoteIdentifier(value: string): string {
  if (!isSafeIdentifier(value)) throw new Error(`Unsafe SQL identifier: ${value}`);
  return `"${value.replaceAll("\"", "\"\"")}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function splitMigrationStatements(content: string): string[] {
  return content
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

export type MigrationState =
  | { status: "upToDate"; tableCount: number; availableMigrations: string[]; appliedMigrations: string[] }
  | {
      status: "needsMigrations";
      tableCount: number;
      availableMigrations: string[];
      appliedMigrations: string[];
      pendingMigrations: string[];
      reason: "no-migration-journal-empty-db" | "no-migration-journal-non-empty-db" | "pending-migrations";
    };

export type ApplyPendingMigrationsOptions = {
  /**
   * Prepare guarded `CREATE INDEX CONCURRENTLY` prerequisites immediately
   * before each migration file. This is opt-in so migration tests and callers
   * that intentionally exercise a migration's raw failure remain unchanged.
   */
  readonly prepareOnlineIndexes?: boolean;
  readonly log?: (message: string) => void;
};

/**
 * Connection-pool ceiling for the application client.
 *
 * This was previously postgres.js's implicit default of 10, which meant
 * callers that must reason about pool capacity had no value to read and could
 * only restate the number in prose. Declaring it here makes it a single source
 * of truth: `PR_REVIEWER_WAKE_MAX_CONCURRENCY` in `routes/github-webhook.ts`
 * derives its bound from this constant so a change here cannot silently
 * reintroduce the connection deadlock that bound exists to prevent (BLO-21995).
 *
 * Passing it explicitly also makes it authoritative: postgres.js resolves
 * `max` as `explicit option > URL query param > PGMAX env > default`, so a
 * `?max=` in the connection string can no longer shrink the pool out from
 * under a caller that derived a bound from it.
 *
 * ---
 *
 * BLO-35946 AC3 asked for this value to be reconciled against its consumers,
 * and BLO-37330 then sized it. The server-side ceiling it has to fit inside is
 * written down in `doc/DATABASE-CONNECTION-BUDGET.md` — read that before
 * changing this number, and re-derive it there rather than here.
 *
 * In short (measured 2026-09-28): `max_connections` 100 −
 * `superuser_reserved_connections` 3 = 97 on a single `paperclip-pg` instance;
 * ~17 of those go to the postgres-exporter, overlapping `psql` cronjob
 * one-shots, transient `createUtilitySql` pools and operator headroom; the
 * remaining 80, less an explicit 8-connection estimation margin, divides
 * across a peak of **4** application processes (3 `paperclip-api` pods
 * mid-rollout at `maxSurge: 1`, plus the 1 worker), which is what puts this at
 * 18. The margin is a line in that document's arithmetic rather than a
 * rounding habit: its inputs are declared configuration, not observed
 * backends, so sizing to the exact ceiling would spend the entire server
 * budget on estimates the document itself declines to vouch for. Raising this
 * further needs `max_connections` raised on the server in the same change, or
 * Postgres starts refusing connections instead of the client queueing — the
 * worse failure.
 *
 * 10 was never deliberate: it was postgres.js's inherited default, and it sat
 * below steady-state demand. Measured against a single process on 2026-09-24:
 *
 * | source                                              | connections |
 * |-----------------------------------------------------|-------------|
 * | PR-reviewer wakes: 4 slots x depth 2 (the bound at the then-current pool of 10) | 8 |
 * | scheduler tick: ~11 unlatched concurrent chains      | ~11         |
 * | `plugin-job-scheduler.ts` `DEFAULT_MAX_CONCURRENT_JOBS` | 10       |
 * | one `getDeleteBlastRadius` precheck (`services/environments.ts`) | 8    |
 * | agent run executions                                 | unbounded  |
 *
 * These are not mutually exclusive — they share one pool in one process — so a
 * conservative floor is ~19 concurrent demands with zero API traffic. 18 does
 * not clear that worst case, and deliberately so: the 19th caller *queues*
 * (postgres.js waits rather than throwing), whereas a pool one over the
 * server's ceiling makes Postgres *refuse*. Buying the last unit of the worst
 * case would cost the margin that protects against the outage, so the
 * remaining contention is left as latency on purpose.
 *
 * There is no second application pool in production: `server/src/index.ts`
 * creates one only in the `config.databaseMigrationUrl` branch, and that
 * resolves solely from `DATABASE_MIGRATION_URL`, which is unset on both
 * workloads.
 *
 * {@link POSTGRES_POOL_MAX} has exactly one derived consumer,
 * `derivePrReviewerWakeMaxConcurrency` (`routes/github-webhook.ts`), which
 * yields `floor(n/2) - 1` = 8 here. Be precise about what that leaves, because
 * the obvious reading is wrong: each wake holds **2** connections, so the PR
 * path reserves `2 * (floor(n/2) - 1) = n - 2` and the headroom for everything
 * else under PR saturation is a *constant 2* at every even pool size — 2 at
 * n=10, 2 at n=18, 2 at n=40. Scaling the pool does not widen it. The name
 * reads like "half the pool"; because depth is 2 it means "all but two
 * connections".
 *
 * That is stated rather than fixed, and this row does not address it. Capping
 * the bound to reserve more would convert a queue into a throttle on the one
 * path that is already the most dispatch-starved in the fleet, to buy headroom
 * against a saturation that costs latency rather than errors — the pool blocks,
 * it does not refuse. Changing it is a scheduling-policy decision that wants
 * its own measurement of observed contention, which the "Known gap" section of
 * the budget document explains we currently cannot take.
 *
 * Exactly one live nested acquire remains (`withPrReviewerTaskLock` in
 * `routes/github-webhook.ts` takes a transaction-scoped advisory lock, then
 * `heartbeat.wakeup()` inside it opens its own claim transaction). Every other
 * nesting path — recovery, issues, environment leases, both outboxes — was
 * converted to thread `tx` through rather than take a second pooled connection,
 * which is why the two prior incidents at this number (the stranded-reconcile
 * chain latch in `server/src/index.ts`, and `issueService`'s instance-settings
 * read in `services/issues.ts`) were each fixed by removing a nest rather than
 * by sizing the pool. That last one is kept
 * deliberately; the reason is recorded at its call site.
 */
export const POSTGRES_POOL_MAX = 18;

/**
 * The `idle_in_transaction_session_timeout` this deployment's Postgres role
 * already imposes, recorded here so {@link POSTGRES_IDLE_IN_TRANSACTION_TIMEOUT_MS}
 * can be asserted against it rather than drifting past it unnoticed.
 *
 * Applied by hand on 2026-05-13 and documented in `Blockcast/onprem-k8s` at
 * `memory/paperclip-pg-stuck-transactions.md`:
 *
 * ```sql
 * ALTER ROLE paperclip SET idle_in_transaction_session_timeout = '60000';  -- 60s
 * ALTER ROLE paperclip SET statement_timeout = '30000';                    -- 30s
 * ALTER ROLE paperclip SET lock_timeout = '15000';                         -- 15s
 * ```
 *
 * It is a *transcription of prose*, not a reading — no manifest, migration or
 * IaC re-creates these, and nothing but the startup probe asserts them, so they
 * would vanish silently on a role rebuild (PEN-3598). Treat it as the bound we
 * believe is in force and must not quietly exceed, and take
 * {@link readInheritedTimeoutSettings} as the measurement.
 */
export const POSTGRES_ROLE_IDLE_IN_TRANSACTION_TIMEOUT_MS = 60_000;

/**
 * How long a pooled application connection may sit inside an open transaction
 * with no statement running before Postgres terminates it.
 *
 * This matches {@link POSTGRES_ROLE_IDLE_IN_TRANSACTION_TIMEOUT_MS}, so the
 * pool ships the bound the role already imposes rather than a second opinion
 * about it. The point of setting it client-side at all is that the role-level
 * value is hand-applied prose (see above): if the role is ever rebuilt without
 * it, the pool still carries a bound.
 *
 * ⚠ Setting this *can loosen* an existing bound, and did. Postgres resolves
 * GUCs as `postgresql.conf` < `ALTER DATABASE SET` < `ALTER ROLE SET` <
 * startup-packet parameters < session `SET`, and this setting has context
 * `user`, so a startup-packet value **overrides** the role's rather than
 * stacking with it. #1921 (`41439c5c`, merged 2026-09-19) introduced this
 * constant at `120_000`, which raised the role's live 60 s to 120 s fleet-wide
 * — a change made *for* PEN-3365 that loosened the exact protection PEN-3365
 * exists to provide, and went unnoticed for seven days. The rationale it
 * shipped under — *"no healthy workload wants an idle-open transaction, so
 * there is no bound worth preserving"* — is false: it reasons about whether
 * the workload is healthy, when the question is whether a bound already
 * exists. One did.
 *
 * The 120 s was borrowed from `DELIVERY_LOCK_HOLD_TIMEOUT_MS`
 * (`server/src/services/github-status-delivery-outbox.ts:44`) — the one caller
 * that never needed the pool to supply it. Both long-hold critical sections
 * set their own value transaction-locally via `set_config(..., true)`, which is
 * `SET LOCAL` and outranks the startup packet:
 *
 * | site | value |
 * |---|---|
 * | `github-status-delivery-outbox.ts:66` | 120 s |
 * | `pr-issue-backlink-lock.ts:82` | 30 s (`BACKLINK_LOCK_HOLD_TIMEOUT_MS`) |
 *
 * That precedence is demonstrated by a passing test, not inferred from the
 * chain above: `server/src/__tests__/pr-issue-backlink-lock.test.ts` reads
 * `idle: "23456ms"` inside the transaction on a `createDb` pool connection
 * whose startup packet says otherwise, with a negative control on the pooled
 * handle. So lowering this cannot shorten either section's hold — the outbox
 * raises itself to 120 s when it needs to, and did so before #1921 and
 * independently of it.
 *
 * `statement_timeout` is deliberately still left unset, for the same
 * precedence reason applied in the other direction: the role imposes 30 s, and
 * any value here would replace it rather than tighten it.
 *
 * Spelled as its own literal rather than as an alias of the role constant, so
 * that `pool-timeout-bounds.test.ts` can assert the `<=` relation between them
 * and actually fail when someone raises this one. An alias would make that
 * assertion tautological.
 *
 * A `?idle_in_transaction_session_timeout=` in the connection URL still wins
 * over this, because postgres.js lets URL query parameters override
 * `options.connection`. That is the intended escape hatch for an operator.
 */
export const POSTGRES_IDLE_IN_TRANSACTION_TIMEOUT_MS = 60_000;

/**
 * How long a retiring connection waits for an in-flight query before the
 * driver terminates it instead (BLO-35946, patched into postgres.js as the
 * `close_timeout` option; see `closeTimedOut()` in `patches/postgres@3.4.9.patch`).
 *
 * This bound only ever applies *after* `Connection.end()` has been called —
 * by {@link POSTGRES_MAX_LIFETIME_MIN_SECONDS} below, or by `sql.end()`. At
 * that point the connection has already been moved to the pool's terminal
 * `ended` queue and can never be handed out again, so the choice is not "kill
 * the query or let it finish": it is "kill the query or leak the slot
 * permanently". Waiting was the unbounded half of the 2026-09-24 outage.
 *
 * 30s matches the driver's sibling `connect_timeout` and the `statement_timeout`
 * this repo asserts at role level — so any query a healthy environment would
 * already have cancelled is dead well before this fires. A query that outlives
 * it is rejected with `CONNECTION_DESTROYED`, which is loud and retriable;
 * that is the deliberate trade against a silent permanent leak.
 */
export const POSTGRES_CLOSE_TIMEOUT_SECONDS = 30;

/**
 * Bounds on how long a pooled connection lives before the driver retires and
 * reopens it. Previously left at the postgres.js default, which is the same
 * 30–60 minute randomised range — this states it so the value is readable
 * rather than having to be recovered from the library (BLO-35946 AC4).
 *
 * The randomisation is load-bearing and is why this is a function rather than
 * a constant: `timer()` resolves it **once per `Connection`**, so passing a
 * plain number would give all {@link POSTGRES_POOL_MAX} connections — which
 * are all opened at process start — the same expiry instant, retiring the
 * whole pool simultaneously. Spreading them is the point.
 */
export const POSTGRES_MAX_LIFETIME_MIN_SECONDS = 30 * 60;
export const POSTGRES_MAX_LIFETIME_MAX_SECONDS = 60 * 60;

export function postgresMaxLifetimeSeconds(): number {
  return (
    POSTGRES_MAX_LIFETIME_MIN_SECONDS +
    Math.random() * (POSTGRES_MAX_LIFETIME_MAX_SECONDS - POSTGRES_MAX_LIFETIME_MIN_SECONDS)
  );
}

/**
 * Two options are absent or wrong in postgres.js's shipped typings, and both
 * are real at runtime: `close_timeout` is this repo's patch, and `max_lifetime`
 * is typed `number | null` even though the library's own default for it is a
 * function (`src/index.js:515`) that `timer()` calls (`src/connection.js:1043`).
 *
 * Declared as a narrow widening rather than casting the whole object, so a
 * top-level field like `max` keeps its excess-property and type checking —
 * `BaseOptions` has no index signature, so a typo there is a compile error,
 * where a blanket cast would let it land silently. Nested `connection` keys are
 * NOT protected this way: `ConnectionParameters` carries
 * `[name: string]: string | number | boolean` (`types/index.d.ts:343`) for
 * arbitrary startup parameters, so a misspelled
 * `idle_in_transaction_session_timeout` type-checks and fails at first connect
 * instead, with Postgres `FATAL: unrecognized configuration parameter`. The
 * final `as unknown as` is unavoidable — TS rejects
 * the direct conversion (`max_lifetime: () => number` is not comparable to the
 * shipped `number`) — but it now applies to an already-checked literal rather
 * than instead of checking it.
 */
type PatchedPostgresOptions = Omit<
  NonNullable<Parameters<typeof postgres>[1]>,
  "max_lifetime"
> & {
  close_timeout?: number;
  max_lifetime?: number | (() => number) | null;
};

export function createDb(url: string) {
  const sql = postgres(url, ({
    max: POSTGRES_POOL_MAX,
    max_lifetime: postgresMaxLifetimeSeconds,
    close_timeout: POSTGRES_CLOSE_TIMEOUT_SECONDS,
    // Sent in the startup packet, so it applies to every connection this pool
    // opens — including ones created later to refill the pool. postgres.js
    // filters falsy startup parameters out entirely, so a `0` here would ship
    // no bound at all rather than the "disabled" it reads as; the value must
    // stay positive for this to mean anything.
    connection: {
      idle_in_transaction_session_timeout: POSTGRES_IDLE_IN_TRANSACTION_TIMEOUT_MS,
    },
  } satisfies PatchedPostgresOptions) as unknown as Parameters<typeof postgres>[1]);
  // Inert in production; only embedded test databases register their URL so
  // their pools can be closed before the server stops (see registry module).
  registerTrackedClient(url, sql);
  return createDbFromPostgresClient(sql);
}

/**
 * The three timeouts that decide whether a query can hang forever, as they are
 * inherited from the server environment (`postgresql.conf`, `ALTER DATABASE
 * SET`, `ALTER ROLE SET`) — *before* any client-side override.
 *
 * `valueMs` is `null` when the setting is disabled (Postgres reports `0`),
 * which is the unbounded case and the one worth alerting on.
 */
export type InheritedTimeoutSetting = {
  readonly name: string;
  readonly valueMs: number | null;
  readonly source: string;
};

export type InheritedTimeoutSettings = {
  readonly statementTimeout: InheritedTimeoutSetting;
  readonly idleInTransactionSessionTimeout: InheritedTimeoutSetting;
  readonly lockTimeout: InheritedTimeoutSetting;
};

const TIMEOUT_SETTING_NAMES = [
  "statement_timeout",
  "idle_in_transaction_session_timeout",
  "lock_timeout",
] as const;

/**
 * Read the effective timeout environment on a connection that carries none of
 * this module's own client-side overrides.
 *
 * It deliberately uses {@link createUtilitySql}, not the application pool. The
 * pool sets `idle_in_transaction_session_timeout` in its startup packet, so
 * reading these values there would report our own override back to us and
 * destroy the one piece of evidence this probe exists to collect: whether the
 * *server* already bounds these. `statement_timeout` and `lock_timeout` are not
 * set by the pool, so the values reported here are what the pool inherits too.
 *
 * The repo asserts a role-level 30s `statement_timeout` in two places
 * (`routes/plugins.ts`, migration `0098`) and `lib/db-retry.ts` retries `57014`
 * on that basis, but no `ALTER ROLE` exists in either `Blockcast/paperclip` or
 * `Blockcast/onprem-k8s` — so the assertion is unverified. This answers it from
 * whatever database the process is actually pointed at, with no cluster access.
 */
export async function readInheritedTimeoutSettings(
  url: string,
): Promise<InheritedTimeoutSettings> {
  const sql = createUtilitySql(url);
  try {
    const rows = await sql<{ name: string; setting: string; source: string }[]>`
      SELECT name, setting, source
      FROM pg_settings
      WHERE name IN ${sql(TIMEOUT_SETTING_NAMES)}
    `;
    const byName = new Map(rows.map((row) => [row.name, row]));
    const read = (name: string): InheritedTimeoutSetting => {
      const row = byName.get(name);
      // pg_settings reports these three in milliseconds, and 0 means disabled.
      const parsed = Number(row?.setting ?? Number.NaN);
      const valueMs = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
      return { name, valueMs, source: row?.source ?? "unknown" };
    };
    return {
      statementTimeout: read("statement_timeout"),
      idleInTransactionSessionTimeout: read("idle_in_transaction_session_timeout"),
      lockTimeout: read("lock_timeout"),
    };
  } finally {
    await sql.end();
  }
}

/**
 * Whether the pool's own `idle_in_transaction_session_timeout` is *looser* than
 * the one the server would otherwise impose — i.e. whether shipping it makes
 * the deployment less bounded than leaving it alone would.
 *
 * This is the runtime half of the never-loosening guard; the static half is the
 * `POOL <= ROLE` assertion in `pool-timeout-bounds.test.ts`. The two catch
 * different things. CI catches someone raising
 * {@link POSTGRES_IDLE_IN_TRANSACTION_TIMEOUT_MS} past the value this repo
 * believes the role carries. This catches the case CI provably cannot see: the
 * role bound being *tightened* below our constant by a hand-applied `ALTER
 * ROLE` that lives only as prose in another repository (PEN-3598), where the
 * value in this file is a transcription and the server is the only authority.
 *
 * `null` (Postgres' `0`, disabled) is not a loosening — there is no bound to
 * loosen, and shipping one is strictly an improvement. That is the case the
 * pool's startup parameter exists for.
 *
 * Out of scope: the `?idle_in_transaction_session_timeout=` URL escape hatch
 * documented on {@link POSTGRES_IDLE_IN_TRANSACTION_TIMEOUT_MS}. This compares
 * the *constant*, not the pool's effective value, so an operator override in
 * the connection URL is invisible here — and doubly so, because
 * {@link readInheritedTimeoutSettings} builds its probe from that same URL and
 * would report the override back as the inherited value, comparing it against
 * itself. That hatch is deliberate and operator-initiated; this guard is aimed
 * at the role bound moving underneath a constant nobody re-read.
 */
export function poolIdleInTransactionTimeoutLoosens(
  settings: InheritedTimeoutSettings,
): boolean {
  const inherited = settings.idleInTransactionSessionTimeout.valueMs;
  return inherited !== null && POSTGRES_IDLE_IN_TRANSACTION_TIMEOUT_MS > inherited;
}

/**
 * One-line, log-friendly rendering of {@link readInheritedTimeoutSettings}.
 *
 * Appends an explicit marker when {@link poolIdleInTransactionTimeoutLoosens}
 * holds, rather than leaving the two numbers side by side for a reader to
 * compare. Both figures were already present at this call site on the day the
 * loosening shipped, and nobody subtracted them — so printing them is
 * demonstrably not enough, and the verdict has to be stated.
 */
export function formatInheritedTimeoutSettings(settings: InheritedTimeoutSettings): string {
  const rendered = [
    settings.statementTimeout,
    settings.idleInTransactionSessionTimeout,
    settings.lockTimeout,
  ]
    .map(({ name, valueMs, source }) =>
      `${name}=${valueMs === null ? "disabled" : `${valueMs}ms`} (source=${source})`,
    )
    .join(", ");

  if (!poolIdleInTransactionTimeoutLoosens(settings)) return rendered;

  return (
    `${rendered} — LOOSENED: the pool ships ` +
    `idle_in_transaction_session_timeout=${POSTGRES_IDLE_IN_TRANSACTION_TIMEOUT_MS}ms, which ` +
    `overrides the tighter ${settings.idleInTransactionSessionTimeout.valueMs}ms this server ` +
    `imposes (startup-packet parameters outrank ALTER ROLE / ALTER DATABASE). Lower ` +
    `POSTGRES_IDLE_IN_TRANSACTION_TIMEOUT_MS to at most the inherited value (PEN-3365)`
  );
}

/**
 * The log level {@link formatInheritedTimeoutSettings} should be emitted at.
 *
 * Lives here, next to the verdict it reflects, rather than at the call site.
 * Severity and wording were split across packages for one release, and the
 * result was that the `LOOSENED:` marker — added precisely because printing the
 * two numbers had not been enough — was itself emitted at `info`, because the
 * caller keyed the level solely on `statement_timeout`. A verdict announced at
 * the same severity as the healthy line is greppable-but-unread, which is the
 * failure mode the marker exists to close. Keeping both on one function makes
 * them unable to diverge again.
 *
 * Two independent conditions warrant `warn`, and neither implies the other:
 *
 * - `statement_timeout` disabled — nothing server-side bounds a blocked query,
 *   so a recovery pass can hang indefinitely (PEN-3365).
 * - {@link poolIdleInTransactionTimeoutLoosens} — we are actively *raising* the
 *   server's own bound. Latent today (pool 60s vs role 60s is equal, not
 *   looser), and latent on exactly the path the guard exists for: a role
 *   tightened below our constant, which CI provably cannot see.
 */
export function inheritedTimeoutLogLevel(
  settings: InheritedTimeoutSettings,
): "warn" | "info" {
  const statementTimeoutDisabled = settings.statementTimeout.valueMs === null;
  return statementTimeoutDisabled || poolIdleInTransactionTimeoutLoosens(settings)
    ? "warn"
    : "info";
}

export function createDbFromPostgresClient(sql: Sql) {
  return drizzlePg(sql, { schema });
}

export async function getPostgresDataDirectory(url: string): Promise<string | null> {
  const sql = createUtilitySql(url);
  try {
    const rows = await sql<{ data_directory: string | null }[]>`
      SELECT current_setting('data_directory', true) AS data_directory
    `;
    const actual = rows[0]?.data_directory;
    return typeof actual === "string" && actual.length > 0 ? actual : null;
  } catch {
    return null;
  } finally {
    await sql.end();
  }
}

async function listMigrationFiles(): Promise<string[]> {
  const entries = await readdir(MIGRATIONS_FOLDER, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

type MigrationJournalFile = {
  entries?: Array<{ idx?: number; tag?: string; when?: number }>;
};

type JournalMigrationEntry = {
  fileName: string;
  folderMillis: number;
  order: number;
};

async function listJournalMigrationEntries(): Promise<JournalMigrationEntry[]> {
  try {
    const raw = await readFile(MIGRATIONS_JOURNAL_JSON, "utf8");
    const parsed = JSON.parse(raw) as MigrationJournalFile;
    if (!Array.isArray(parsed.entries)) return [];
    return parsed.entries
      .map((entry, entryIndex) => {
        if (typeof entry?.tag !== "string") return null;
        if (typeof entry?.when !== "number" || !Number.isFinite(entry.when)) return null;
        const order = Number.isInteger(entry.idx) ? Number(entry.idx) : entryIndex;
        return { fileName: `${entry.tag}.sql`, folderMillis: entry.when, order };
      })
      .filter((entry): entry is JournalMigrationEntry => entry !== null);
  } catch {
    return [];
  }
}

async function listJournalMigrationFiles(): Promise<string[]> {
  const entries = await listJournalMigrationEntries();
  return entries.map((entry) => entry.fileName);
}

async function readMigrationFileContent(migrationFile: string): Promise<string> {
  return readFile(new URL(`./migrations/${migrationFile}`, import.meta.url), "utf8");
}

async function orderMigrationsByJournal(migrationFiles: string[]): Promise<string[]> {
  const journalEntries = await listJournalMigrationEntries();
  const orderByFileName = new Map(journalEntries.map((entry) => [entry.fileName, entry.order]));
  return [...migrationFiles].sort((left, right) => {
    const leftOrder = orderByFileName.get(left);
    const rightOrder = orderByFileName.get(right);
    if (leftOrder === undefined && rightOrder === undefined) return left.localeCompare(right);
    if (leftOrder === undefined) return 1;
    if (rightOrder === undefined) return -1;
    if (leftOrder === rightOrder) return left.localeCompare(right);
    return leftOrder - rightOrder;
  });
}

type SqlExecutor = Pick<ReturnType<typeof postgres>, "unsafe">;

async function runInTransaction(sql: SqlExecutor, action: () => Promise<void>): Promise<void> {
  await sql.unsafe("BEGIN");
  try {
    await action();
    await sql.unsafe("COMMIT");
  } catch (error) {
    try {
      await sql.unsafe("ROLLBACK");
    } catch {
      // Ignore rollback failures and surface the original error.
    }
    throw error;
  }
}

async function latestMigrationCreatedAt(
  sql: SqlExecutor,
  qualifiedTable: string,
): Promise<number | null> {
  const rows = await sql.unsafe<{ created_at: string | number | null }[]>(
    `SELECT created_at FROM ${qualifiedTable} ORDER BY created_at DESC NULLS LAST LIMIT 1`,
  );
  const value = Number(rows[0]?.created_at ?? Number.NaN);
  return Number.isFinite(value) ? value : null;
}

function normalizeFolderMillis(value: number | null | undefined): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.trunc(value);
  }
  return Date.now();
}

async function ensureMigrationJournalTable(
  sql: ReturnType<typeof postgres>,
): Promise<{ migrationTableSchema: string; columnNames: Set<string> }> {
  let migrationTableSchema = await discoverMigrationTableSchema(sql);
  if (!migrationTableSchema) {
    const drizzleSchema = quoteIdentifier("drizzle");
    const migrationTable = quoteIdentifier(DRIZZLE_MIGRATIONS_TABLE);
    await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${drizzleSchema}`);
    await sql.unsafe(
      `CREATE TABLE IF NOT EXISTS ${drizzleSchema}.${migrationTable} (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`,
    );
    migrationTableSchema = (await discoverMigrationTableSchema(sql)) ?? "drizzle";
  }

  const columnNames = await getMigrationTableColumnNames(sql, migrationTableSchema);
  return { migrationTableSchema, columnNames };
}

async function migrationHistoryEntryExists(
  sql: SqlExecutor,
  qualifiedTable: string,
  columnNames: Set<string>,
  migrationFile: string,
  hash: string,
): Promise<boolean> {
  const predicates: string[] = [];
  if (columnNames.has("hash")) predicates.push(`hash = ${quoteLiteral(hash)}`);
  if (columnNames.has("name")) predicates.push(`name = ${quoteLiteral(migrationFile)}`);
  if (predicates.length === 0) return false;

  const rows = await sql.unsafe<{ one: number }[]>(
    `SELECT 1 AS one FROM ${qualifiedTable} WHERE ${predicates.join(" OR ")} LIMIT 1`,
  );
  return rows.length > 0;
}

async function recordMigrationHistoryEntry(
  sql: SqlExecutor,
  qualifiedTable: string,
  columnNames: Set<string>,
  migrationFile: string,
  hash: string,
  folderMillis: number,
): Promise<void> {
  const insertColumns: string[] = [];
  const insertValues: string[] = [];

  if (columnNames.has("hash")) {
    insertColumns.push(quoteIdentifier("hash"));
    insertValues.push(quoteLiteral(hash));
  }
  if (columnNames.has("name")) {
    insertColumns.push(quoteIdentifier("name"));
    insertValues.push(quoteLiteral(migrationFile));
  }
  if (columnNames.has("created_at")) {
    const latestCreatedAt = await latestMigrationCreatedAt(sql, qualifiedTable);
    const createdAt = latestCreatedAt === null
      ? normalizeFolderMillis(folderMillis)
      : Math.max(latestCreatedAt + 1, normalizeFolderMillis(folderMillis));
    insertColumns.push(quoteIdentifier("created_at"));
    insertValues.push(quoteLiteral(String(createdAt)));
  }

  if (insertColumns.length === 0) return;

  await sql.unsafe(
    `INSERT INTO ${qualifiedTable} (${insertColumns.join(", ")}) VALUES (${insertValues.join(", ")})`,
  );
}

async function applyPendingMigrationsManually(
  url: string,
  pendingMigrations: string[],
  options: ApplyPendingMigrationsOptions = {},
): Promise<void> {
  if (pendingMigrations.length === 0) return;

  const orderedPendingMigrations = await orderMigrationsByJournal(pendingMigrations);
  const journalEntries = await listJournalMigrationEntries();
  const folderMillisByFileName = new Map(
    journalEntries.map((entry) => [entry.fileName, normalizeFolderMillis(entry.folderMillis)]),
  );

  const sql = createUtilitySql(url);
  try {
    // Serialise the whole sequence across processes, then bound every statement
    // in it (BLO-42005). Without this a rolling deploy's two new pods raced
    // each other and the old pods' live traffic for the same ACCESS EXCLUSIVE
    // locks, lost the role's 15s lock_timeout, and crash-looped the pod —
    // taking the single-replica worker StatefulSet out for ~10 minutes.
    //
    // The lock is session-scoped, so `sql.end()` below releases it on every
    // path including a killed pod; an explicit unlock here could throw and
    // mask the migration error that matters (see BLO-34039 in
    // concurrent-index-guard.ts).
    await prepareMigrationSession(sql);

    const { migrationTableSchema, columnNames } = await ensureMigrationJournalTable(sql);
    const qualifiedTable = `${quoteIdentifier(migrationTableSchema)}.${quoteIdentifier(DRIZZLE_MIGRATIONS_TABLE)}`;

    for (const migrationFile of orderedPendingMigrations) {
      const migrationContent = await readMigrationFileContent(migrationFile);
      const hash = createHash("sha256").update(migrationContent).digest("hex");
      const existingEntry = await migrationHistoryEntryExists(
        sql,
        qualifiedTable,
        columnNames,
        migrationFile,
        hash,
      );
      if (existingEntry) continue;

      await withMigrationLockRetry(migrationFile, async () => {
        await prepareMigrationSession(sql);

        // Inside the retry because `CREATE INDEX CONCURRENTLY` can lose a lock
        // race too, and every outcome it has is idempotent (already-valid /
        // created / rebuilt, all `IF NOT EXISTS`-guarded). A wrong-definition
        // or missing-prerequisite failure throws a plain Error with no
        // SQLSTATE, so it still fails on the first attempt.
        if (options.prepareOnlineIndexes) {
          await ensureConcurrentIndexesForMigration(url, migrationFile, {
            log: options.log,
            callerHoldsSerializingLock: true,
          });
        }

        await runInTransaction(sql, async () => {
          for (const statement of splitMigrationStatements(migrationContent)) {
            // Use savepoints so a single "already exists" error doesn't abort the transaction.
            const savepointName = `sp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            await sql.unsafe(`SAVEPOINT ${savepointName}`);
            try {
              await sql.unsafe(statement);
              await sql.unsafe(`RELEASE SAVEPOINT ${savepointName}`);
            } catch (error: unknown) {
              const pgError = error as { code?: string };
              // PostgreSQL error codes for "already applied" scenarios:
              // 42P07 = duplicate_table, 42701 = duplicate_column, 42710 = duplicate_object,
              // 42703 = undefined_column (DROP COLUMN on already-dropped column),
              // 42P01 = undefined_table (operations on already-dropped table)
              if (pgError.code === "42P07" || pgError.code === "42701" || pgError.code === "42710" || pgError.code === "42703" || pgError.code === "42P01") {
                await sql.unsafe(`ROLLBACK TO SAVEPOINT ${savepointName}`);
                await sql.unsafe(`RELEASE SAVEPOINT ${savepointName}`);
                continue;
              }
              throw error;
            }
          }

          await recordMigrationHistoryEntry(
            sql,
            qualifiedTable,
            columnNames,
            migrationFile,
            hash,
            folderMillisByFileName.get(migrationFile) ?? Date.now(),
          );
        });
      }, options.log);
    }
  } finally {
    await sql.end();
  }
}

async function mapHashesToMigrationFiles(migrationFiles: string[]): Promise<Map<string, string>> {
  const mapped = new Map<string, string>();

  await Promise.all(
    migrationFiles.map(async (migrationFile) => {
      const content = await readMigrationFileContent(migrationFile);
      const hash = createHash("sha256").update(content).digest("hex");
      mapped.set(hash, migrationFile);
    }),
  );

  return mapped;
}

async function getMigrationTableColumnNames(
  sql: ReturnType<typeof postgres>,
  migrationTableSchema: string,
): Promise<Set<string>> {
  const columns = await sql.unsafe<{ column_name: string }[]>(
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = ${quoteLiteral(migrationTableSchema)}
        AND table_name = ${quoteLiteral(DRIZZLE_MIGRATIONS_TABLE)}
    `,
  );
  return new Set(columns.map((column) => column.column_name));
}

async function tableExists(
  sql: ReturnType<typeof postgres>,
  tableName: string,
): Promise<boolean> {
  const rows = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = ${tableName}
    ) AS exists
  `;
  return rows[0]?.exists ?? false;
}

async function columnExists(
  sql: ReturnType<typeof postgres>,
  tableName: string,
  columnName: string,
): Promise<boolean> {
  const rows = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = ${tableName}
        AND column_name = ${columnName}
    ) AS exists
  `;
  return rows[0]?.exists ?? false;
}

async function indexExists(
  sql: ReturnType<typeof postgres>,
  indexName: string,
): Promise<boolean> {
  const rows = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind = 'i'
        AND c.relname = ${indexName}
    ) AS exists
  `;
  return rows[0]?.exists ?? false;
}

async function constraintExists(
  sql: ReturnType<typeof postgres>,
  constraintName: string,
): Promise<boolean> {
  const rows = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM pg_constraint c
      JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE n.nspname = 'public'
        AND c.conname = ${constraintName}
    ) AS exists
  `;
  return rows[0]?.exists ?? false;
}

async function migrationStatementAlreadyApplied(
  sql: ReturnType<typeof postgres>,
  statement: string,
): Promise<boolean> {
  const normalized = statement.replace(/\s+/g, " ").trim();

  const createTableMatch = normalized.match(/^CREATE TABLE(?: IF NOT EXISTS)? "([^"]+)"/i);
  if (createTableMatch) {
    return tableExists(sql, createTableMatch[1]);
  }

  const addColumnMatch = normalized.match(
    /^ALTER TABLE "([^"]+)" ADD COLUMN(?: IF NOT EXISTS)? "([^"]+)"/i,
  );
  if (addColumnMatch) {
    return columnExists(sql, addColumnMatch[1], addColumnMatch[2]);
  }

  const createIndexMatch = normalized.match(/^CREATE (?:UNIQUE )?INDEX(?: IF NOT EXISTS)? "([^"]+)"/i);
  if (createIndexMatch) {
    return indexExists(sql, createIndexMatch[1]);
  }

  const addConstraintMatch = normalized.match(/^ALTER TABLE "([^"]+)" ADD CONSTRAINT "([^"]+)"/i);
  if (addConstraintMatch) {
    return constraintExists(sql, addConstraintMatch[2]);
  }

  // ALTER TABLE ... ALTER COLUMN (SET DEFAULT, SET NOT NULL, DROP NOT NULL, SET DATA TYPE, DROP DEFAULT)
  const alterColumnMatch = normalized.match(/^ALTER TABLE "([^"]+)" ALTER COLUMN "([^"]+)"/i);
  if (alterColumnMatch) {
    return columnExists(sql, alterColumnMatch[1], alterColumnMatch[2]);
  }

  // ALTER TABLE ... DROP COLUMN
  const dropColumnMatch = normalized.match(/^ALTER TABLE "([^"]+)" DROP COLUMN(?: IF EXISTS)? "([^"]+)"/i);
  if (dropColumnMatch) {
    // If the column doesn't exist, the drop was already applied
    const exists = await columnExists(sql, dropColumnMatch[1], dropColumnMatch[2]);
    return !exists;
  }

  // DROP INDEX
  const dropIndexMatch = normalized.match(/^DROP INDEX(?: IF EXISTS)? "([^"]+)"/i);
  if (dropIndexMatch) {
    // If the index doesn't exist, the drop was already applied (or never needed)
    const exists = await indexExists(sql, dropIndexMatch[1]);
    return !exists;
  }

  // If we cannot reason about a statement safely, require manual migration.
  return false;
}

async function migrationContentAlreadyApplied(
  sql: ReturnType<typeof postgres>,
  migrationContent: string,
): Promise<boolean> {
  const statements = splitMigrationStatements(migrationContent);
  if (statements.length === 0) return false;

  for (const statement of statements) {
    const applied = await migrationStatementAlreadyApplied(sql, statement);
    if (!applied) return false;
  }

  return true;
}

async function loadAppliedMigrations(
  sql: ReturnType<typeof postgres>,
  migrationTableSchema: string,
  availableMigrations: string[],
): Promise<string[]> {
  const quotedSchema = quoteIdentifier(migrationTableSchema);
  const qualifiedTable = `${quotedSchema}.${quoteIdentifier(DRIZZLE_MIGRATIONS_TABLE)}`;
  const columnNames = await getMigrationTableColumnNames(sql, migrationTableSchema);

  if (columnNames.has("name")) {
    const rows = await sql.unsafe<{ name: string }[]>(`SELECT name FROM ${qualifiedTable} ORDER BY id`);
    return rows.map((row) => row.name).filter((name): name is string => Boolean(name));
  }

  if (columnNames.has("hash")) {
    const rows = await sql.unsafe<{ hash: string }[]>(`SELECT hash FROM ${qualifiedTable} ORDER BY id`);
    const hashesToMigrationFiles = await mapHashesToMigrationFiles(availableMigrations);
    const appliedFromHashes = rows
      .map((row) => hashesToMigrationFiles.get(row.hash))
      .filter((name): name is string => Boolean(name));

    if (appliedFromHashes.length > 0) {
      // Best-effort: when all hashes resolve, this is authoritative.
      if (appliedFromHashes.length === rows.length) return appliedFromHashes;

      // Partial hash resolution can happen when files have changed; return what we can trust.
      return appliedFromHashes;
    }

    // Fallback only when hashes are unavailable/unresolved.
    if (columnNames.has("created_at")) {
      const journalEntries = await listJournalMigrationEntries();
      if (journalEntries.length > 0) {
        const lastDbRows = await sql.unsafe<{ created_at: string | number | null }[]>(
          `SELECT created_at FROM ${qualifiedTable} ORDER BY created_at DESC LIMIT 1`,
        );
        const lastCreatedAt = Number(lastDbRows[0]?.created_at ?? -1);
        if (Number.isFinite(lastCreatedAt) && lastCreatedAt >= 0) {
          return journalEntries
            .filter((entry) => availableMigrations.includes(entry.fileName))
            .filter((entry) => entry.folderMillis <= lastCreatedAt)
            .map((entry) => entry.fileName)
            .slice(0, rows.length);
        }
      }
    }
  }

  const rows = await sql.unsafe<{ id: number }[]>(`SELECT id FROM ${qualifiedTable} ORDER BY id`);
  const journalMigrationFiles = await listJournalMigrationFiles();
  const appliedFromIds = rows
    .map((row) => journalMigrationFiles[row.id - 1])
    .filter((name): name is string => Boolean(name));
  if (appliedFromIds.length > 0) return appliedFromIds;

  return availableMigrations.slice(0, Math.max(0, rows.length));
}

export type MigrationHistoryReconcileResult = {
  repairedMigrations: string[];
  remainingMigrations: string[];
};

export async function reconcilePendingMigrationHistory(
  url: string,
): Promise<MigrationHistoryReconcileResult> {
  const state = await inspectMigrations(url);
  if (state.status !== "needsMigrations" || state.reason !== "pending-migrations") {
    return { repairedMigrations: [], remainingMigrations: [] };
  }

  const sql = createUtilitySql(url);
  const repairedMigrations: string[] = [];

  try {
    const journalEntries = await listJournalMigrationEntries();
    const folderMillisByFile = new Map(journalEntries.map((entry) => [entry.fileName, entry.folderMillis]));
    const migrationTableSchema = await discoverMigrationTableSchema(sql);
    if (!migrationTableSchema) {
      return { repairedMigrations, remainingMigrations: state.pendingMigrations };
    }

    const columnNames = await getMigrationTableColumnNames(sql, migrationTableSchema);
    const qualifiedTable = `${quoteIdentifier(migrationTableSchema)}.${quoteIdentifier(DRIZZLE_MIGRATIONS_TABLE)}`;

    for (const migrationFile of state.pendingMigrations) {
      const migrationContent = await readMigrationFileContent(migrationFile);
      const alreadyApplied = await migrationContentAlreadyApplied(sql, migrationContent);
      if (!alreadyApplied) break;

      const hash = createHash("sha256").update(migrationContent).digest("hex");
      const folderMillis = folderMillisByFile.get(migrationFile) ?? Date.now();
      const existingByHash = columnNames.has("hash")
        ? await sql.unsafe<{ created_at: string | number | null }[]>(
            `SELECT created_at FROM ${qualifiedTable} WHERE hash = ${quoteLiteral(hash)} ORDER BY created_at DESC LIMIT 1`,
          )
        : [];
      const existingByName = columnNames.has("name")
        ? await sql.unsafe<{ created_at: string | number | null }[]>(
            `SELECT created_at FROM ${qualifiedTable} WHERE name = ${quoteLiteral(migrationFile)} ORDER BY created_at DESC LIMIT 1`,
          )
        : [];
      if (existingByHash.length > 0 || existingByName.length > 0) {
        if (columnNames.has("created_at")) {
          const existingHashCreatedAt = Number(existingByHash[0]?.created_at ?? -1);
          if (existingByHash.length > 0 && Number.isFinite(existingHashCreatedAt) && existingHashCreatedAt < folderMillis) {
            await sql.unsafe(
              `UPDATE ${qualifiedTable} SET created_at = ${quoteLiteral(String(folderMillis))} WHERE hash = ${quoteLiteral(hash)} AND created_at < ${quoteLiteral(String(folderMillis))}`,
            );
          }

          const existingNameCreatedAt = Number(existingByName[0]?.created_at ?? -1);
          if (existingByName.length > 0 && Number.isFinite(existingNameCreatedAt) && existingNameCreatedAt < folderMillis) {
            await sql.unsafe(
              `UPDATE ${qualifiedTable} SET created_at = ${quoteLiteral(String(folderMillis))} WHERE name = ${quoteLiteral(migrationFile)} AND created_at < ${quoteLiteral(String(folderMillis))}`,
            );
          }
        }

        repairedMigrations.push(migrationFile);
        continue;
      }

      const insertColumns: string[] = [];
      const insertValues: string[] = [];

      if (columnNames.has("hash")) {
        insertColumns.push(quoteIdentifier("hash"));
        insertValues.push(quoteLiteral(hash));
      }
      if (columnNames.has("name")) {
        insertColumns.push(quoteIdentifier("name"));
        insertValues.push(quoteLiteral(migrationFile));
      }
      if (columnNames.has("created_at")) {
        insertColumns.push(quoteIdentifier("created_at"));
        insertValues.push(quoteLiteral(String(folderMillis)));
      }

      if (insertColumns.length === 0) break;

      await sql.unsafe(
        `INSERT INTO ${qualifiedTable} (${insertColumns.join(", ")}) VALUES (${insertValues.join(", ")})`,
      );
      repairedMigrations.push(migrationFile);
    }
  } finally {
    await sql.end();
  }

  const refreshed = await inspectMigrations(url);
  return {
    repairedMigrations,
    remainingMigrations:
      refreshed.status === "needsMigrations" ? refreshed.pendingMigrations : [],
  };
}

async function discoverMigrationTableSchema(sql: ReturnType<typeof postgres>): Promise<string | null> {
  const rows = await sql<{ schemaName: string }[]>`
    SELECT n.nspname AS "schemaName"
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = ${DRIZZLE_MIGRATIONS_TABLE} AND c.relkind = 'r'
  `;

  if (rows.length === 0) return null;

  const drizzleSchema = rows.find(({ schemaName }) => schemaName === "drizzle");
  if (drizzleSchema) return drizzleSchema.schemaName;

  const publicSchema = rows.find(({ schemaName }) => schemaName === "public");
  if (publicSchema) return publicSchema.schemaName;

  return rows[0]?.schemaName ?? null;
}

export async function inspectMigrations(url: string): Promise<MigrationState> {
  const sql = createUtilitySql(url);

  try {
    const availableMigrations = await listMigrationFiles();
    const tableCountResult = await sql<{ count: number }[]>`
      select count(*)::int as count
      from information_schema.tables
      where table_schema = 'public'
        and table_type = 'BASE TABLE'
    `;
    const tableCount = tableCountResult[0]?.count ?? 0;

    const migrationTableSchema = await discoverMigrationTableSchema(sql);
    if (!migrationTableSchema) {
      if (tableCount > 0) {
        return {
          status: "needsMigrations",
          tableCount,
          availableMigrations,
          appliedMigrations: [],
          pendingMigrations: availableMigrations,
          reason: "no-migration-journal-non-empty-db",
        };
      }

      return {
        status: "needsMigrations",
        tableCount,
        availableMigrations,
        appliedMigrations: [],
        pendingMigrations: availableMigrations,
        reason: "no-migration-journal-empty-db",
      };
    }

    const appliedMigrations = await loadAppliedMigrations(sql, migrationTableSchema, availableMigrations);
    const pendingMigrations = availableMigrations.filter((name) => !appliedMigrations.includes(name));
    if (pendingMigrations.length === 0) {
      return {
        status: "upToDate",
        tableCount,
        availableMigrations,
        appliedMigrations,
      };
    }

    return {
      status: "needsMigrations",
      tableCount,
      availableMigrations,
      appliedMigrations,
      pendingMigrations,
      reason: "pending-migrations",
    };
  } finally {
    await sql.end();
  }
}

export async function applyPendingMigrations(
  url: string,
  options: ApplyPendingMigrationsOptions = {},
): Promise<void> {
  const initialState = await inspectMigrations(url);
  if (initialState.status === "upToDate") return;

  if (initialState.reason === "no-migration-journal-empty-db") {
    const sql = createUtilitySql(url);
    try {
      const db = drizzlePg(sql);
      await migratePg(db, { migrationsFolder: MIGRATIONS_FOLDER });
    } finally {
      await sql.end();
    }

    let bootstrappedState = await inspectMigrations(url);
    if (bootstrappedState.status === "upToDate") return;
    if (bootstrappedState.reason === "pending-migrations") {
      const repair = await reconcilePendingMigrationHistory(url);
      if (repair.repairedMigrations.length > 0) {
        bootstrappedState = await inspectMigrations(url);
      }
      if (bootstrappedState.status === "needsMigrations" && bootstrappedState.reason === "pending-migrations") {
        await applyPendingMigrationsManually(url, bootstrappedState.pendingMigrations, options);
        bootstrappedState = await inspectMigrations(url);
      }
    }
    if (bootstrappedState.status === "upToDate") return;
    throw new Error(
      `Failed to bootstrap migrations: ${bootstrappedState.pendingMigrations.join(", ")}`,
    );
  }

  if (initialState.reason === "no-migration-journal-non-empty-db") {
    // Create the migration journal table so reconciliation and migration can proceed.
    const bootstrapSql = createUtilitySql(url);
    try {
      await ensureMigrationJournalTable(bootstrapSql);
    } finally {
      await bootstrapSql.end();
    }
  }

  let state = await inspectMigrations(url);
  if (state.status === "upToDate") return;

  const repair = await reconcilePendingMigrationHistory(url);
  if (repair.repairedMigrations.length > 0) {
    state = await inspectMigrations(url);
    if (state.status === "upToDate") return;
  }

  if (state.status !== "needsMigrations" || state.reason !== "pending-migrations") {
    throw new Error("Migrations are still pending after migration-history reconciliation; run inspectMigrations for details.");
  }

  await applyPendingMigrationsManually(url, state.pendingMigrations, options);

  const finalState = await inspectMigrations(url);
  if (finalState.status !== "upToDate") {
    throw new Error(
      `Failed to apply pending migrations: ${finalState.pendingMigrations.join(", ")}`,
    );
  }
}

export type MigrationBootstrapResult =
  | { migrated: true; reason: "migrated-empty-db"; tableCount: 0 }
  | { migrated: false; reason: "already-migrated"; tableCount: number }
  | { migrated: false; reason: "not-empty-no-migration-journal"; tableCount: number };

export async function migratePostgresIfEmpty(url: string): Promise<MigrationBootstrapResult> {
  const sql = createUtilitySql(url);

  try {
    const migrationTableSchema = await discoverMigrationTableSchema(sql);

    const tableCountResult = await sql<{ count: number }[]>`
      select count(*)::int as count
      from information_schema.tables
      where table_schema = 'public'
        and table_type = 'BASE TABLE'
    `;

    const tableCount = tableCountResult[0]?.count ?? 0;

    if (migrationTableSchema) {
      return { migrated: false, reason: "already-migrated", tableCount };
    }

    if (tableCount > 0) {
      return { migrated: false, reason: "not-empty-no-migration-journal", tableCount };
    }

    const db = drizzlePg(sql);
    await migratePg(db, { migrationsFolder: MIGRATIONS_FOLDER });

    return { migrated: true, reason: "migrated-empty-db", tableCount: 0 };
  } finally {
    await sql.end();
  }
}

export async function ensurePostgresDatabase(
  url: string,
  databaseName: string,
): Promise<"created" | "exists"> {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(databaseName)) {
    throw new Error(`Unsafe database name: ${databaseName}`);
  }

  const sql = createUtilitySql(url);
  try {
    const existing = await sql<{ one: number }[]>`
      select 1 as one from pg_database where datname = ${databaseName} limit 1
    `;
    if (existing.length > 0) return "exists";

    await sql.unsafe(`create database "${databaseName}" encoding 'UTF8' lc_collate 'C' lc_ctype 'C' template template0`);
    return "created";
  } finally {
    await sql.end();
  }
}

export async function resetPostgresDatabase(
  url: string,
  databaseName: string,
): Promise<"reset"> {
  const quotedDatabaseName = quoteIdentifier(databaseName);
  const sql = createUtilitySql(url);
  try {
    await sql`
      select pg_terminate_backend(pid)
      from pg_stat_activity
      where datname = ${databaseName}
        and pid <> pg_backend_pid()
    `;
    await sql.unsafe(`drop database if exists ${quotedDatabaseName}`);
    await sql.unsafe(`create database ${quotedDatabaseName} encoding 'UTF8' lc_collate 'C' lc_ctype 'C' template template0`);
    return "reset";
  } finally {
    await sql.end();
  }
}

export type Db = ReturnType<typeof createDb>;

/**
 * The open transaction handle drizzle hands to a `db.transaction(...)` callback.
 * Split across two aliases so the one-line nested-`Parameters` incantation this
 * type replaces appears nowhere in the tree (BLO-34656).
 */
type DbTransactionCallback = Parameters<Db["transaction"]>[0];
export type DbTransaction = Parameters<DbTransactionCallback>[0];
