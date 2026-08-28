import { resolveMigrationConnection } from "./migration-runtime.js";
import { ensureOnlineIndexPrerequisites } from "./precreate-online-indexes.js";

/**
 * Standalone entrypoint (`pnpm run db:precreate-online-indexes`) so an
 * operator can satisfy every pending migration's online-index prerequisite
 * as its own step, ahead of a maintenance window or before `db:migrate` runs
 * in a deploy pipeline that wants the two as separately observable steps.
 * `migrate.ts` also calls `ensureOnlineIndexPrerequisites` itself, so running
 * this first is an optimization/observability aid, not a requirement --
 * `db:migrate` is safe on its own either way.
 */
async function main(): Promise<void> {
  const resolved = await resolveMigrationConnection();
  console.log(`Precreating online index prerequisites via ${resolved.source}`);
  try {
    const results = await ensureOnlineIndexPrerequisites(resolved.connectionString, {
      log: (message) => console.log(`[precreate-online-indexes] ${message}`),
    });
    if (results.length === 0) {
      console.log("No pending migration requires online index precreation");
      return;
    }
    for (const result of results) {
      console.log(`[precreate-online-indexes] ${result.migration}: ${result.indexName} -> ${result.action}`);
    }
  } finally {
    await resolved.stop();
  }
}

await main();
