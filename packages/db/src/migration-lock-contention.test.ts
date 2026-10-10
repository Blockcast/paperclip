/**
 * Rolling-deploy lock behaviour of the transactional migration runner (BLO-42005).
 *
 * Helm rev 795 rolled out `0248_cost_events_cache_creation_tokens.sql`
 * (`ALTER TABLE cost_events ADD COLUMN`, which needs ACCESS EXCLUSIVE) and
 * `0251_budget_incidents_open_only_unique.sql`. The new `paperclip-0` and
 * `paperclip-api` pods ran migrations on startup with no lock between them, so
 * they raced each other *and* the old pods' live traffic, lost the `paperclip`
 * role's 15s `lock_timeout`, and threw out of server startup. Each pod restarted
 * six times over ~10 minutes; because the worker is a single-replica StatefulSet,
 * dispatch had no worker for that whole window.
 *
 * Both tests use migration 0248 itself, and both fail if the
 * `prepareMigrationSession` / `withMigrationLockRetry` hunk in `client.ts` is
 * reverted on its own:
 *
 * - without the advisory lock, a second migrator does not wait its turn;
 * - without the session `lock_timeout` + retry, a conflicting lock held for
 *   longer than the role default aborts startup instead of being waited out.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import {
  applyPendingMigrations,
  MIGRATION_DDL_LOCK_TIMEOUT_MS,
  MIGRATION_LOCK_RETRY_ATTEMPTS,
  MIGRATION_LOCK_RETRY_BUDGET_MS,
  withMigrationLockRetry,
} from "./client.js";
import {
  DEFAULT_DDL_LOCK_TIMEOUT_MS,
  DEFAULT_LOCK_WAIT_TIMEOUT_MS,
  SERIALIZING_LOCK_KEY,
} from "./concurrent-index-guard.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const MIGRATION = "0248_cost_events_cache_creation_tokens.sql";
const TABLE = "cost_events";
const COLUMN = "cache_creation_input_tokens";

/**
 * Role `lock_timeout` the migration session must override. Production's is 15s;
 * 250ms is the same fault an order of magnitude faster, so the "reverted" run
 * fails in well under a second rather than making the suite wait out the real
 * value.
 */
const ROLE_LOCK_TIMEOUT = "250ms";
/**
 * Role `statement_timeout` the migration session must override. Production's is
 * 30s — comfortably long for 0248 but not for 0251's index build on a populated
 * table, which is the other half of the rev-795 rollout. Set high enough that
 * the runner's own non-DDL reads cannot trip it, low enough to kill a statement
 * that sits waiting for a lock.
 */
const ROLE_STATEMENT_TIMEOUT = "800ms";
/**
 * How long the conflicting ACCESS EXCLUSIVE lock is held in the retry test.
 *
 * Sits inside both margins of the runner's 3s `lock_timeout` + 1s first
 * backoff: attempt 1 must time out *before* the release (3s < 4.5s) and attempt
 * 2, starting at ~4s, must acquire before its own timeout at ~7s.
 */
const CONFLICTING_LOCK_HOLD_MS = 4_500;
/**
 * Hold for the session-timeout test: longer than `ROLE_STATEMENT_TIMEOUT` so an
 * un-overridden session is killed waiting, and shorter than the runner's 3s
 * `lock_timeout` so the fix wins on its *first* attempt — which is what keeps
 * this test a probe of the `SET`s rather than of the retry.
 */
const STATEMENT_TIMEOUT_LOCK_HOLD_MS = 2_500;

const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function client(connectionString: string): postgres.Sql {
  const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
  cleanups.push(() => sql.end({ timeout: 5 }).catch(() => {}));
  return sql;
}

async function createTempDatabase(): Promise<string> {
  const db = await startEmbeddedPostgresTestDatabase("paperclip-migration-lock-contention-");
  cleanups.push(db.cleanup);
  return db.connectionString;
}

async function migrationHash(): Promise<string> {
  const content = await fs.promises.readFile(
    new URL(`./migrations/${MIGRATION}`, import.meta.url),
    "utf8",
  );
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Rewind 0248 so the runner has real DDL to re-apply: drop its journal row and
 * drop the column, so `reconcilePendingMigrationHistory` cannot decide the
 * migration is already applied and repair it away without running any DDL.
 *
 * Deleting by `hash` alone is enough: drizzle's `__drizzle_migrations` carries
 * only `id`/`hash`/`created_at`, and `migrationHistoryEntryExists` only matches
 * `name` on schemas that have that column.
 */
async function makeMigrationPending(sql: postgres.Sql): Promise<void> {
  const hash = await migrationHash();
  await sql`DELETE FROM "drizzle"."__drizzle_migrations" WHERE "hash" = ${hash}`;
  await sql.unsafe(`ALTER TABLE "${TABLE}" DROP COLUMN IF EXISTS "${COLUMN}"`);
}

async function columnExists(sql: postgres.Sql): Promise<boolean> {
  const rows = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ${TABLE} AND column_name = ${COLUMN}
    ) AS exists
  `;
  return rows[0].exists;
}

/**
 * Stand in for an old pod's live traffic: hold ACCESS EXCLUSIVE on `cost_events`
 * for `holdMs`, starting before the returned promise resolves, then let go.
 * Resolves once the lock is actually held, so callers never race the setup.
 */
async function holdConflictingLock(
  connectionString: string,
  holdMs: number,
): Promise<() => Promise<void>> {
  const holder = client(connectionString);
  let release = (): void => {};
  const released = new Promise<void>((resolve) => { release = resolve; });
  let acquired = (): void => {};
  const lockHeld = new Promise<void>((resolve) => { acquired = resolve; });

  const holding = holder
    .begin(async (tx) => {
      await tx.unsafe(`LOCK TABLE "${TABLE}" IN ACCESS EXCLUSIVE MODE`);
      acquired();
      await released;
    })
    .catch(() => {});

  await lockHeld;
  const timer = setTimeout(release, holdMs);

  return async () => {
    clearTimeout(timer);
    release();
    await holding;
  };
}

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    await cleanup?.();
  }
}, 120_000);

if (!embeddedPostgresSupport.supported) {
  console.warn(
    "Skipping embedded Postgres migration lock-contention tests on this host: "
    + (embeddedPostgresSupport.reason ?? "unsupported environment"),
  );
}

describeEmbeddedPostgres("transactional migration lock contention", () => {
  it(
    "waits for another process's serializing lock instead of racing it",
    async () => {
      const connectionString = await createTempDatabase();
      const blocker = client(connectionString);
      const observer = client(connectionString);

      await makeMigrationPending(observer);
      expect(await columnExists(observer)).toBe(false);

      // Stand in for the other new pod: hold the migration lock and nothing else.
      await blocker`SELECT pg_advisory_lock(hashtextextended(${SERIALIZING_LOCK_KEY}, 0))`;

      let settled = false;
      const migrating = applyPendingMigrations(connectionString)
        .then(() => { settled = true; })
        .catch((error: unknown) => { settled = true; throw error; });
      // Swallow here only so a failed assertion below cannot surface as an
      // unhandled rejection; `migrating` is still awaited at the end.
      migrating.catch(() => {});

      try {
        await sleep(2_000);
        // Reverting the fix fails here: with no advisory lock the second
        // migrator applies the DDL immediately, concurrently with the first.
        expect(settled).toBe(false);
        expect(await columnExists(observer)).toBe(false);
      } finally {
        await blocker`SELECT pg_advisory_unlock(hashtextextended(${SERIALIZING_LOCK_KEY}, 0))`;
      }

      await migrating;
      expect(await columnExists(observer)).toBe(true);
    },
    180_000,
  );

  it(
    "retries DDL that loses a lock race instead of failing startup",
    async () => {
      const connectionString = await createTempDatabase();
      const setup = client(connectionString);
      await makeMigrationPending(setup);

      // The production fault: the role, not the session, decides lock_timeout.
      // Only connections opened after this inherit it, which is every
      // connection applyPendingMigrations makes.
      await setup.unsafe(`ALTER ROLE "paperclip" SET lock_timeout = '${ROLE_LOCK_TIMEOUT}'`);

      const stopHolding = await holdConflictingLock(connectionString, CONFLICTING_LOCK_HOLD_MS);
      try {
        // The hold outlasts the runner's own 3s lock_timeout, so the first
        // attempt loses the race whatever the session is set to: only the retry
        // can win this one. Reverting `withMigrationLockRetry` fails here.
        await expect(applyPendingMigrations(connectionString)).resolves.toBeUndefined();
        expect(await columnExists(setup)).toBe(true);
      } finally {
        await stopHolding();
      }
    },
    180_000,
  );

  it(
    "overrides the role's statement_timeout for the migration session",
    async () => {
      const connectionString = await createTempDatabase();
      const setup = client(connectionString);
      await makeMigrationPending(setup);

      // No lock_timeout here: with statement_timeout as the only bound, a
      // session that never raises it is killed 57014 while waiting. 57014 is
      // deliberately outside the retry set — a statement that ran out its full
      // budget is not a lock race — so the retry cannot rescue this one, which
      // is what makes it a probe of the SETs specifically.
      await setup.unsafe(`ALTER ROLE "paperclip" SET statement_timeout = '${ROLE_STATEMENT_TIMEOUT}'`);

      const stopHolding = await holdConflictingLock(
        connectionString,
        STATEMENT_TIMEOUT_LOCK_HOLD_MS,
      );
      try {
        // Reverting `prepareMigrationSession` fails here: the ALTER is
        // cancelled at 800ms having waited, not raced.
        await expect(applyPendingMigrations(connectionString)).resolves.toBeUndefined();
        expect(await columnExists(setup)).toBe(true);
      } finally {
        await stopHolding();
      }
    },
    180_000,
  );
});

/**
 * The retry budget's ceiling, as Ally's review of #2413 framed it: an attempt is
 * not uniformly `MIGRATION_DDL_LOCK_TIMEOUT_MS`, because it also runs
 * `ensureConcurrentIndexesForMigration` under the guard's own
 * `DEFAULT_DDL_LOCK_TIMEOUT_MS`. No database needed: each attempt advances a
 * fake clock by what it would really cost and then loses the race.
 */
describe("migration lock retry budget", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Retry `attemptCostMs`-long attempts, the first `losses` losing the race. */
  async function retryLosingAttempts(
    attemptCostMs: number,
    losses: number,
  ): Promise<{ attempts: number; elapsedMs: number; error: unknown }> {
    vi.useFakeTimers();
    const startedAt = Date.now();
    let attempts = 0;
    const settled = withMigrationLockRetry("0999_example.sql", async () => {
      attempts += 1;
      vi.setSystemTime(Date.now() + attemptCostMs);
      if (attempts <= losses) {
        throw Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" });
      }
    }).then(() => null, (error: unknown) => error);
    await vi.runAllTimersAsync();
    const error = await settled;
    return { attempts, elapsedMs: Date.now() - startedAt, error };
  }

  it("does not multiply an in-loop guard lock wait past a sibling's serializing-lock wait", async () => {
    // Every attempt spends the guard's full lock_timeout and loses. Counted in
    // attempts alone that is 12 x 2 min + backoff = 25 min, and the sibling pod
    // waiting on SERIALIZING_LOCK_KEY gives up at 20. Reverting the wall-clock
    // deadline in `withMigrationLockRetry` fails both assertions.
    const { attempts, elapsedMs, error } = await retryLosingAttempts(
      DEFAULT_DDL_LOCK_TIMEOUT_MS,
      Number.POSITIVE_INFINITY,
    );
    expect(error).toMatchObject({ code: "55P03" });
    expect(elapsedMs).toBeLessThan(DEFAULT_LOCK_WAIT_TIMEOUT_MS);
    expect(attempts).toBe(1);
    // The documented ceiling — budget plus one guard lock wait — itself fits.
    expect(MIGRATION_LOCK_RETRY_BUDGET_MS + DEFAULT_DDL_LOCK_TIMEOUT_MS)
      .toBeLessThan(DEFAULT_LOCK_WAIT_TIMEOUT_MS);
  });

  it("still spends every attempt on races lost at the migration's own lock_timeout", async () => {
    // The deadline is derived from these attempts, so it must not cut them
    // short: a budget sized too small fails here.
    const { attempts, error } = await retryLosingAttempts(
      MIGRATION_DDL_LOCK_TIMEOUT_MS,
      MIGRATION_LOCK_RETRY_ATTEMPTS - 1,
    );
    expect(error).toBeNull();
    expect(attempts).toBe(MIGRATION_LOCK_RETRY_ATTEMPTS);
  });
});
