import { applyPendingMigrations, inspectMigrations } from "./client.js";
import { ensurePendingConcurrentIndexes } from "./concurrent-index-guard.js";
import { resolveMigrationConnection } from "./migration-runtime.js";
import { ensureOnlineIndexPrerequisites } from "./precreate-online-indexes.js";

async function main(): Promise<void> {
  const resolved = await resolveMigrationConnection();

  console.log(`Migrating database via ${resolved.source}`);

  try {
    const before = await inspectMigrations(resolved.connectionString);
    if (before.status === "upToDate") {
      console.log("No pending migrations");
    } else {
      const precreated = await ensureOnlineIndexPrerequisites(resolved.connectionString, {
        log: (message) => console.log(`[precreate-online-indexes] ${message}`),
      });
      for (const result of precreated) {
        console.log(`[precreate-online-indexes] ${result.migration}: ${result.indexName} -> ${result.action}`);
      }

      console.log(`Applying ${before.pendingMigrations.length} pending migration(s)...`);
      await applyPendingMigrations(resolved.connectionString, {
        prepareOnlineIndexes: true,
        log: (message) => console.log(`[precreate-online-indexes] ${message}`),
      });

      const after = await inspectMigrations(resolved.connectionString);
      if (after.status !== "upToDate") {
        throw new Error(`Migrations incomplete: ${after.pendingMigrations.join(", ")}`);
      }
      console.log("Migrations complete");
    }

    // Runs every time, not only when migrations were just applied: migration
    // 0226 can record complete on a populated database without building its
    // deferred index, so migration state alone is not sufficient evidence.
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
