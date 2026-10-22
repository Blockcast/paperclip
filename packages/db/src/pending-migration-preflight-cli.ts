import {
  checkPendingMigrationPreflight,
  formatPreflightFailure,
} from "./pending-migration-preflight.js";
import { dryRunPendingMigrations } from "./client.js";
import { resolveMigrationConnection } from "./migration-runtime.js";

/**
 * Deploy gate, run against the target database *before* `helm upgrade` using
 * the candidate image so the pending set reflects the migrations about to be
 * applied rather than the ones already running. Two checks, in order:
 *
 *  1. Read-only: a pending migration needs an index precreated online. Fails
 *     with the exact `CREATE INDEX CONCURRENTLY` remediation.
 *  2. BLO-48353: execute the pending set in one transaction and ROLL BACK, so a
 *     data-dependent RAISE or constraint violation fails the deploy here
 *     instead of crash-looping the worker. A timeout is INCONCLUSIVE and does
 *     not block: it says nothing about whether the migration is correct.
 */
async function main(): Promise<void> {
  const resolved = await resolveMigrationConnection();
  try {
    const result = await checkPendingMigrationPreflight(resolved.connectionString);

    if (result.pendingMigrations.length === 0) {
      console.log("pending-migration pre-flight: no pending migrations");
      return;
    }

    console.log(
      `pending-migration pre-flight: ${result.pendingMigrations.length} pending ` +
        `(${result.guardedPending.length} require online index precreation)`,
    );

    if (result.blockers.length > 0) {
      console.error(formatPreflightFailure(result.blockers));
      console.error("migration dry-run: not attempted — the missing index above would fail it the same way");
      process.exitCode = 1;
      return;
    }
    console.log("pending-migration pre-flight: OK — no migration is waiting on a missing index");

    const dryRun = await dryRunPendingMigrations(resolved.connectionString);
    for (const skipped of dryRun.skippedStatements) {
      console.log(`migration dry-run: SKIPPED non-transactional statement in ${skipped.migration}: ${skipped.statement}`);
    }
    switch (dryRun.verdict) {
      case "pass":
      case "nothing-pending":
        console.log(
          `migration dry-run: PASS — executed ${dryRun.executed.length} pending migration(s) ` +
            `[${dryRun.executed.join(", ")}] and rolled back; nothing recorded`,
        );
        return;
      case "inconclusive":
        console.log(
          `migration dry-run: INCONCLUSIVE${dryRun.migration ? ` at ${dryRun.migration}` : ""} — ${dryRun.detail}. ` +
            "Rolled back; NOT blocking the deploy (a timeout is not a migration verdict).",
        );
        return;
      case "fail":
        console.error(
          `migration dry-run: FAIL — ${dryRun.migration} errored against the target database and was rolled back. ` +
            `Deploying would crash-loop the worker on this same error:\n  ${dryRun.detail}`,
        );
        process.exitCode = 1;
        return;
    }
  } finally {
    await resolved.stop();
  }
}

await main();
