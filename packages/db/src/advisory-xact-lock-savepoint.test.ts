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
});
