import { applyPendingMigrations, inspectMigrations } from "./client.js";
import { ensurePendingConcurrentIndexes } from "./concurrent-index-guard.js";
import { resolveMigrationConnection } from "./migration-runtime.js";

async function main(): Promise<void> {
  const resolved = await resolveMigrationConnection();

  console.log(`Migrating database via ${resolved.source}`);

  try {
    const before = await inspectMigrations(resolved.connectionString);
    if (before.status !== "upToDate") {
      console.log(`Applying ${before.pendingMigrations.length} pending migration(s)...`);
      await applyPendingMigrations(resolved.connectionString);

      const after = await inspectMigrations(resolved.connectionString);
      if (after.status !== "upToDate") {
        throw new Error(`Migrations incomplete: ${after.pendingMigrations.join(", ")}`);
      }
      console.log("Migrations complete");
    } else {
      console.log("No pending migrations");
    }

    // Runs every time, not only when migrations were just applied: a
    // migration that already recorded complete on a past deploy (BLO-21526 —
    // migration 0212 records complete on a populated database without
    // building its index) would otherwise never get this checked again.
    const indexResults = await ensurePendingConcurrentIndexes(resolved.connectionString);
    for (const result of indexResults) {
      if (result.action !== "already-valid") {
        console.log(`Built deferred index ${result.name} on ${result.table} (${result.action})`);
      }
    }
  } finally {
    await resolved.stop();
  }
}

await main();
