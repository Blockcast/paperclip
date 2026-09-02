/**
 * Pins the PostgreSQL behaviour `lockPrReviewIssueScopes` depends on: an
 * advisory *transaction* lock acquired inside a subtransaction is released when
 * that subtransaction is rolled back to its savepoint.
 *
 * That guard acquires its PR-scope locks all-or-nothing inside a SAVEPOINT so a
 * give-up releases everything it held. If this behaviour ever changed (a major
 * PostgreSQL upgrade, a pooler that rewrites savepoints), the guard would
 * silently strand locks and starve the reviewer webhook's all-or-nothing
 * acquisition for the life of every contended issue create — a failure that is
 * invisible from the application side. Hence a test on the database itself.
 */
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const LOCK_SQL = "select pg_try_advisory_xact_lock(hashtextextended('pr-scope-probe', 0)) as acquired";

describe.skipIf(!support.supported)("advisory xact lock savepoint semantics", () => {
  it("releases locks taken inside a savepoint when that savepoint is rolled back", async () => {
    const dbh = await startEmbeddedPostgresTestDatabase("advisory-lock-savepoint");
    const holder = postgres(dbh.connectionString, { max: 1 });
    const probe = postgres(dbh.connectionString, { max: 1 });
    try {
      let heldWhileAcquired: boolean | null = null;
      let freeAfterRollback: boolean | null = null;

      await holder.begin(async (tx) => {
        await tx.unsafe("savepoint pr_review_scope_locks");
        const [acquired] = await tx.unsafe(LOCK_SQL);
        expect(acquired.acquired).toBe(true);

        // CONTROL. Without this the test could pass against a build where the
        // lock never blocked anything, proving nothing about savepoints.
        const [contended] = await probe.unsafe(LOCK_SQL);
        heldWhileAcquired = contended.acquired === true;

        await tx.unsafe("rollback to savepoint pr_review_scope_locks");

        // The property under test: the OUTER transaction is still open, so a
        // lock that survived the rollback would still be held here.
        const [after] = await probe.unsafe(LOCK_SQL);
        freeAfterRollback = after.acquired === true;
      });

      expect(heldWhileAcquired).toBe(false);
      expect(freeAfterRollback).toBe(true);
    } finally {
      await holder.end();
      await probe.end();
      await dbh.cleanup();
    }
  }, 180_000);

  it("leaves the transaction WRITABLE after a failed statement inside the savepoint", async () => {
    // The evidence the reviewer asked for on #1604: not just "the lock is
    // released" but "issue creation remains usable". `lockPrReviewIssueScopes`
    // catches a failed lock statement and returns so the create can proceed
    // unserialized — but a failed statement aborts the whole transaction, so
    // catching it is only half of failing open. The other half is the rollback,
    // and this asserts the INSERT afterwards actually COMMITS.
    //
    // The transaction is driven by hand on a reserved connection rather than
    // through `sql.begin()`: postgres-js remembers the first statement error
    // and rethrows it at the transaction boundary even when the caller caught
    // it, which would abort this test at `commit` instead of letting it assert.
    const dbh = await startEmbeddedPostgresTestDatabase("advisory-lock-savepoint-write");
    const holder = postgres(dbh.connectionString, { max: 1 });
    const conn = await holder.reserve();
    try {
      await conn.unsafe("create table guard_probe(id int primary key)");
      await conn.unsafe("begin");
      await conn.unsafe("savepoint pr_review_scope_locks");
      const [acquired] = await conn.unsafe(LOCK_SQL);
      expect(acquired.acquired).toBe(true);

      // Stand in for the real failure modes (reset connection,
      // statement_timeout, lost EXECUTE on hashtextextended) with a
      // deterministic statement error at the same point in the sequence.
      await expect(conn.unsafe("select 1/0")).rejects.toThrow(/division by zero/);

      // CONTROL. Without this the test could pass against a server where the
      // failure never aborted anything, proving nothing about the rollback.
      await expect(conn.unsafe("insert into guard_probe values (1)")).rejects.toThrow(
        /current transaction is aborted/,
      );

      await conn.unsafe("rollback to savepoint pr_review_scope_locks");

      // The property under test: the transaction is writable again.
      await conn.unsafe("insert into guard_probe values (2)");
      await conn.unsafe("commit");

      // And it DURABLY committed — an insert that succeeds inside a
      // transaction that then rolls back would satisfy the line above while
      // still losing the issue.
      const rows = await conn.unsafe("select id from guard_probe order by id");
      expect(rows.map((r) => r.id)).toEqual([2]);
    } finally {
      await conn.release();
      await holder.end();
      await dbh.cleanup();
    }
  }, 180_000);
});
