import {
  checkPendingMigrationPreflight,
  formatPreflightFailure,
} from "./pending-migration-preflight.js";
import { resolveMigrationConnection } from "./migration-runtime.js";

/**
 * Read-only deploy gate. Exits non-zero when a pending migration needs an
 * index precreated online, printing the exact `CREATE INDEX CONCURRENTLY`
 * remediation. Intended to run against the target database *before*
 * `helm upgrade`, using the candidate image so the pending set reflects the
 * migrations about to be applied rather than the ones already running.
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

    if (result.blockers.length === 0) {
      console.log("pending-migration pre-flight: OK — no migration is waiting on a missing index");
      return;
    }

    console.error(formatPreflightFailure(result.blockers));
    process.exitCode = 1;
  } finally {
    await resolved.stop();
  }
}

await main();
