/**
 * BLO-21526: migration 0226 records complete on a populated `heartbeat_runs`
 * table without building `heartbeat_runs_crash_recovery_pending_idx` — it
 * only `RAISE NOTICE`s, and the production migration client suppresses
 * notices (`client.ts`'s `onnotice: () => {}`). Nothing else in the migration
 * runner ever closes that gap, so the deploy-time index build has to be an
 * explicit, verifiable step instead of a comment operators are expected to
 * notice. These tests exercise `ensurePendingConcurrentIndexes` standing in
 * for that step: given the exact "migration recorded complete, index absent"
 * state 0226 leaves behind, it must build the index and fail loudly — never
 * silently — if the build does not leave a valid index in place.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import { applyPendingMigrations } from "./client.js";
import {
  ensurePendingConcurrentIndexes,
  PENDING_CONCURRENT_INDEXES,
  SERIALIZING_LOCK_KEY,
  type ConcurrentIndexSpec,
} from "./concurrent-index-guard.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const INDEX_NAME = "heartbeat_runs_crash_recovery_pending_idx";
const INDEX_DEFINITION =
  "ON heartbeat_runs USING btree (finished_at, id) "
  + "WHERE error_code = 'worker_crashed' AND crash_recovery_completed_at IS NULL";
const CRASH_RECOVERY_SPEC = PENDING_CONCURRENT_INDEXES.find(
  (spec) => spec.migration === "0226_heartbeat_runs_crash_recovery_index.sql",
)!;
const TRIGRAM_INDEX_NAME = "issue_comments_company_body_search_idx";
const TRIGRAM_SPEC = PENDING_CONCURRENT_INDEXES.find(
  (spec) => spec.migration === "0269_issue_comments_company_scoped_trigram_search_index.sql",
)!;

const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
}, 60_000);

async function seedPopulatedDatabaseWithoutIndex() {
  const database = await startEmbeddedPostgresTestDatabase("paperclip-concurrent-index-guard-");
  cleanups.push(database.cleanup);
  // Applying migrations against an empty database builds 0226's index
  // inline (it is only deferred once the table is populated), so exercising
  // the "populated, index absent" state this guard exists for means
  // populating the table and dropping the index afterward — the same shape
  // migration 0226 itself leaves behind on a real populated deploy.
  await applyPendingMigrations(database.connectionString);

  const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
  cleanups.push(async () => sql.end());
  await sql.unsafe(`
    SET session_replication_role = replica;
    INSERT INTO heartbeat_runs (company_id, agent_id)
    VALUES ('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222');
    SET session_replication_role = origin;
    DROP INDEX ${INDEX_NAME};
  `);

  return { database, sql };
}

describeEmbeddedPostgres("ensurePendingConcurrentIndexes", () => {
  it("builds the deferred index migration 0226 leaves absent on a populated table", async () => {
    const { database, sql } = await seedPopulatedDatabaseWithoutIndex();

    const results = await ensurePendingConcurrentIndexes(database.connectionString, {
      specs: [CRASH_RECOVERY_SPEC],
    });

    expect(results).toEqual([
      {
        migration: CRASH_RECOVERY_SPEC.migration,
        name: INDEX_NAME,
        table: "heartbeat_runs",
        action: "created",
      },
    ]);
    const [{ indisvalid }] = await sql<{ indisvalid: boolean }[]>`
      select indisvalid from pg_index where indexrelid = to_regclass(${`public.${INDEX_NAME}`})
    `;
    expect(indisvalid).toBe(true);
  }, 60_000);

  it("is a no-op when the index is already present and valid", async () => {
    const { database, sql } = await seedPopulatedDatabaseWithoutIndex();
    await sql.unsafe(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${INDEX_NAME} ${INDEX_DEFINITION}`);

    const results = await ensurePendingConcurrentIndexes(database.connectionString, {
      specs: [CRASH_RECOVERY_SPEC],
    });

    expect(results).toEqual([
      {
        migration: CRASH_RECOVERY_SPEC.migration,
        name: INDEX_NAME,
        table: "heartbeat_runs",
        action: "already-valid",
      },
    ]);
  }, 60_000);

  it("drops and rebuilds an invalid leftover from a failed online build", async () => {
    const { database, sql } = await seedPopulatedDatabaseWithoutIndex();
    // `CREATE INDEX CONCURRENTLY` that fails partway leaves an invalid index
    // behind rather than rolling back — simulate that leftover directly
    // rather than trying to force a real build failure.
    await sql.unsafe(`CREATE INDEX CONCURRENTLY ${INDEX_NAME} ${INDEX_DEFINITION}`);
    await sql.unsafe(`UPDATE pg_index SET indisvalid = FALSE WHERE indexrelid = '${INDEX_NAME}'::regclass`);

    const results = await ensurePendingConcurrentIndexes(database.connectionString, {
      specs: [CRASH_RECOVERY_SPEC],
    });

    expect(results).toEqual([
      {
        migration: CRASH_RECOVERY_SPEC.migration,
        name: INDEX_NAME,
        table: "heartbeat_runs",
        action: "rebuilt",
      },
    ]);
    const [{ indisvalid }] = await sql<{ indisvalid: boolean }[]>`
      select indisvalid from pg_index where indexrelid = to_regclass(${`public.${INDEX_NAME}`})
    `;
    expect(indisvalid).toBe(true);
  }, 60_000);

  it("throws — rather than reporting success — when the online build does not leave a valid index", async () => {
    const { database } = await seedPopulatedDatabaseWithoutIndex();
    const brokenSpec: ConcurrentIndexSpec = {
      ...CRASH_RECOVERY_SPEC,
      // References a column that does not exist, so the build itself fails
      // and this must surface as a thrown error, not a silently-empty result.
      createStatement:
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${INDEX_NAME} `
        + "ON heartbeat_runs USING btree (finished_at, id) WHERE this_column_does_not_exist IS NULL",
      dropStatement: `DROP INDEX CONCURRENTLY IF EXISTS ${INDEX_NAME}`,
    };

    await expect(
      ensurePendingConcurrentIndexes(database.connectionString, { specs: [brokenSpec] }),
    ).rejects.toThrow();
  }, 60_000);

  it("throws instead of silently trusting a same-named index with a different definition (BLO-21526 review)", async () => {
    const { database, sql } = await seedPopulatedDatabaseWithoutIndex();
    // Same name, same predicate, but the key columns are reversed. Postgres
    // has no notion that this doesn't match what the guard expects -- it is
    // a perfectly valid, ready index -- so only the structural check catches
    // it, and it must not be silently dropped and rebuilt (it could be a
    // legitimate index this check simply doesn't recognize).
    await sql.unsafe(
      `CREATE INDEX CONCURRENTLY ${INDEX_NAME} ON heartbeat_runs USING btree (id, finished_at) ` +
        "WHERE error_code = 'worker_crashed' AND crash_recovery_completed_at IS NULL",
    );

    await expect(
      ensurePendingConcurrentIndexes(database.connectionString, { specs: [CRASH_RECOVERY_SPEC] }),
    ).rejects.toThrow(
      /does not match migration 0226_heartbeat_runs_crash_recovery_index\.sql's definition/,
    );

    const [{ indisvalid }] = await sql<{ indisvalid: boolean }[]>`
      select indisvalid from pg_index where indexrelid = to_regclass(${`public.${INDEX_NAME}`})
    `;
    expect(indisvalid).toBe(true);
    const [{ indexdef }] = await sql<{ indexdef: string }[]>`
      select indexdef from pg_indexes where indexname = ${INDEX_NAME}
    `;
    expect(indexdef).toContain("(id, finished_at)");
  }, 60_000);

  it("serializes concurrent callers with a session-scoped advisory lock (BLO-21526 review)", async () => {
    const { database } = await seedPopulatedDatabaseWithoutIndex();

    // Simulate a first caller already mid-build by holding the same
    // session-scoped advisory lock ensurePendingConcurrentIndexes takes
    // internally -- from a caller's point of view, a real first caller and
    // this holder connection are indistinguishable, so this exercises the
    // exact serialization the guard promises without depending on Postgres's
    // own CREATE INDEX CONCURRENTLY internals to create a race window (they
    // resolve too fast against this tiny test table to reliably straddle a
    // held-open blocking transaction).
    const holder = postgres(database.connectionString, { max: 1 });
    cleanups.push(async () => holder.end());
    await holder.unsafe(`select pg_advisory_lock(hashtextextended('${SERIALIZING_LOCK_KEY}', 0))`);

    const second = ensurePendingConcurrentIndexes(database.connectionString, {
      specs: [CRASH_RECOVERY_SPEC],
    });

    // While the holder keeps the lock, the second caller must not resolve --
    // race it against a short timer and confirm the timer wins.
    const stillWaiting = Symbol("still-waiting");
    const raceResult = await Promise.race([
      second.then(() => "resolved" as const),
      new Promise((resolve) => setTimeout(() => resolve(stillWaiting), 500)),
    ]);
    expect(raceResult).toBe(stillWaiting);

    await holder.unsafe(`select pg_advisory_unlock(hashtextextended('${SERIALIZING_LOCK_KEY}', 0))`);

    const results = await second;
    expect(results).toEqual([{
      migration: CRASH_RECOVERY_SPEC.migration,
      name: INDEX_NAME,
      table: "heartbeat_runs",
      action: "created",
    }]);
  }, 60_000);

  it("surfaces the build failure rather than a cleanup failure, and still closes the pool (BLO-34039)", async () => {
    const { database } = await seedPopulatedDatabaseWithoutIndex();
    // Leaving the session in an aborted transaction as the build fails is the
    // cheapest real reproduction of a broken-session cleanup: every later
    // statement on that connection -- the two timeout resets and the advisory
    // unlock in the `finally` -- then errors with "current transaction is
    // aborted", which used to replace the build error and skip `sql.end()`.
    const abortingSpec: ConcurrentIndexSpec = {
      ...CRASH_RECOVERY_SPEC,
      createStatement: "BEGIN; SELECT 1 / 0;",
    };
    // Deliberately passing no `log`: with one supplied, `log` (the no-op-by-
    // default progress channel) and `warn` (the cleanup channel) are the SAME
    // function object, so this assertion could not tell them apart and would
    // still pass if cleanup regressed onto `log`. Spying the `console.warn`
    // default discriminates that, and is also the only branch the two
    // production callers ever take -- neither passes options.
    //
    // The spy also throws once, on the first cleanup message: a reporter that
    // itself throws must not replace the build error nor skip the steps after
    // it, `sql.end()` included. That is the same masking defect one layer up,
    // so the three assertions below pin both guards at once.
    const warned: string[] = [];
    let reporterShouldThrow = true;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation((message: string) => {
      if (!message.startsWith("concurrent-index cleanup:")) return;
      warned.push(message);
      if (reporterShouldThrow) {
        reporterShouldThrow = false;
        throw new Error("cleanup reporter exploded");
      }
    });
    cleanups.push(async () => warnSpy.mockRestore());

    await expect(
      ensurePendingConcurrentIndexes(database.connectionString, {
        specs: [abortingSpec],
      }),
    ).rejects.toThrow(/division by zero/);

    // Three, not two: the reporter threw on the first one, and the two steps
    // after it still ran and still reported.
    expect(warned).toHaveLength(3);

    // The advisory lock is session-scoped, so Postgres only releases it when
    // the backend exits -- it is therefore gone if and only if `sql.end()`
    // ran despite the unlock throwing.
    const probe = postgres(database.connectionString, { max: 1 });
    cleanups.push(async () => probe.end());
    let locked = false;
    for (let attempt = 0; attempt < 20 && !locked; attempt += 1) {
      [{ locked }] = await probe.unsafe(
        `select pg_try_advisory_lock(hashtextextended('${SERIALIZING_LOCK_KEY}', 0)) as locked`,
      );
      if (!locked) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(locked).toBe(true);
  }, 60_000);

  // PEN-3596 / 0269: the first GIN entry in the registry needs `btree_gin`
  // before its create statement will even parse. Without `requiredExtensions`
  // that surfaced from the build as
  // `data type uuid has no default operator class for access method gin` --
  // a hard failure, where a missing prerequisite on a multi-version upgrade
  // is supposed to be skippable. These pin both branches.
  it("skips a spec whose required extension is absent when skipUnavailable is set", async () => {
    const { database, sql } = await seedPopulatedDatabaseWithoutIndex();
    const logged: string[] = [];
    const spec: ConcurrentIndexSpec = {
      ...CRASH_RECOVERY_SPEC,
      requiredExtensions: ["an_extension_that_does_not_exist"],
    };

    const results = await ensurePendingConcurrentIndexes(database.connectionString, {
      specs: [spec],
      skipUnavailable: true,
      log: (message) => logged.push(message),
    });

    expect(results).toEqual([]);
    expect(logged.join("\n")).toContain("required extensions are missing: an_extension_that_does_not_exist");
    // Skipped, not built: the index must still be absent afterwards.
    const [{ present }] = await sql<{ present: string | null }[]>`
      select to_regclass(${`public.${INDEX_NAME}`})::text as present
    `;
    expect(present).toBeNull();
  }, 60_000);

  it("throws on a missing required extension when skipUnavailable is not set", async () => {
    const { database } = await seedPopulatedDatabaseWithoutIndex();
    const spec: ConcurrentIndexSpec = {
      ...CRASH_RECOVERY_SPEC,
      requiredExtensions: ["an_extension_that_does_not_exist"],
    };

    // This is the migration-runner path, which runs after the extension's own
    // migration has committed -- so a miss there is a real defect, not a
    // version skew, and must fail the deploy rather than quietly skip.
    await expect(
      ensurePendingConcurrentIndexes(database.connectionString, { specs: [spec] }),
    ).rejects.toThrow(/required extensions are missing: an_extension_that_does_not_exist/);
  }, 60_000);

  it("builds normally when the required extensions are present", async () => {
    const { database } = await seedPopulatedDatabaseWithoutIndex();
    // btree_gin and pg_trgm are both created by migrations, so an up-to-date
    // database has them; this is 0269's real configuration.
    const spec: ConcurrentIndexSpec = {
      ...CRASH_RECOVERY_SPEC,
      requiredExtensions: ["btree_gin", "pg_trgm"],
    };

    const results = await ensurePendingConcurrentIndexes(database.connectionString, {
      specs: [spec],
    });

    expect(results.map((result) => result.action)).toEqual(["created"]);
  }, 60_000);
  // PEN-3596 / 0269 review: the operator class is the ONE axis on which a
  // plausible hand-typed mistake -- `gin (company_id, body)`, btree_gin's
  // default `text_ops`, instead of `gin (company_id, body gin_trgm_ops)` --
  // differs from the right index. Everything else the structural check looks
  // at is byte-identical between the two (verified in the first test below),
  // because pg_get_indexdef(oid, n, TRUE) prints the bare attribute with no
  // opclass and indoption is sort/NULL flags. A `text_ops` GIN index cannot
  // serve `ILIKE '%...%'` at all, and 0269 DROPs the single-column trigram
  // index immediately after this check passes -- so accepting one would leave
  // the largest table in the schema with no usable index for comment search
  // and no error anywhere.
  async function seedTrigramDatabaseWithoutIndex() {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-trigram-opclass-guard-");
    cleanups.push(database.cleanup);
    // An empty `issue_comments` lets 0269 build the index inline, so drop it
    // to reach the "populated deploy, index precreated by hand" state the
    // guard actually runs against.
    await applyPendingMigrations(database.connectionString);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    cleanups.push(async () => sql.end());
    await sql.unsafe(`DROP INDEX IF EXISTS ${TRIGRAM_INDEX_NAME}`);
    return { database, sql };
  }

  it("rejects a default-opclass precreate that every other structural check accepts (PEN-3596 review)", async () => {
    const { database, sql } = await seedTrigramDatabaseWithoutIndex();
    await sql.unsafe(
      `CREATE INDEX ${TRIGRAM_INDEX_NAME} ON issue_comments USING gin (company_id, body)`,
    );

    // The premise: this index is indistinguishable from the right one on every
    // axis the guard checked before `keyOpclasses` existed. If this assertion
    // ever fails, the opclass check has stopped being the thing standing
    // between a mistyped precreate and a silent loss of comment search.
    const [indistinguishable] = await sql.unsafe(`
      SELECT
        i.indnkeyatts, i.indnatts, i.indoption::text AS key_options,
        ARRAY(
          SELECT pg_get_indexdef(i.indexrelid, k, TRUE)
          FROM generate_series(1, i.indnkeyatts) AS k ORDER BY k
        ) AS key_columns,
        am.amname AS access_method
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      JOIN pg_am am ON am.oid = c.relam
      WHERE i.indexrelid = to_regclass('public.${TRIGRAM_INDEX_NAME}')
    `);
    expect(indistinguishable).toMatchObject({
      indnkeyatts: TRIGRAM_SPEC.keyColumns.length,
      indnatts: TRIGRAM_SPEC.keyColumns.length,
      key_options: TRIGRAM_SPEC.keyOptions.join(" "),
      key_columns: [...TRIGRAM_SPEC.keyColumns],
      access_method: TRIGRAM_SPEC.accessMethod,
    });

    await expect(
      ensurePendingConcurrentIndexes(database.connectionString, { specs: [TRIGRAM_SPEC] }),
    ).rejects.toThrow(
      /does not match migration 0269_issue_comments_company_scoped_trigram_search_index\.sql's definition/,
    );

    // Fail closed, not fix up: the wrong index is left exactly as found for an
    // operator to inspect, never silently dropped and rebuilt.
    const [{ indexdef }] = await sql<{ indexdef: string }[]>`
      select indexdef from pg_indexes where indexname = ${TRIGRAM_INDEX_NAME}
    `;
    expect(indexdef).toContain("gin (company_id, body)");
    expect(indexdef).not.toContain("gin_trgm_ops");
  }, 120_000);

  it("accepts a correctly-opclassed precreate as already-valid (PEN-3596 review)", async () => {
    const { database, sql } = await seedTrigramDatabaseWithoutIndex();
    await sql.unsafe(
      `CREATE INDEX ${TRIGRAM_INDEX_NAME} ON issue_comments USING gin (company_id, body gin_trgm_ops)`,
    );

    const results = await ensurePendingConcurrentIndexes(database.connectionString, {
      specs: [TRIGRAM_SPEC],
    });

    expect(results.map((result) => result.action)).toEqual(["already-valid"]);
  }, 120_000);
});
