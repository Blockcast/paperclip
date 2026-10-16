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
 *
 * The deploy pipeline is now one of those callers: the `online-index
 * precreation` step in `.github/workflows/docker.yml` runs this as a Job on
 * the candidate image, ahead of the read-only pending-migration pre-flight
 * (PEN-4179).
 */

/**
 * Override for the serializing advisory lock wait only, in milliseconds.
 *
 * ⚠️ Deliberately the ONLY timeout exposed here. The lock wait elapses before
 * any DDL begins, so giving up on it cannot leave anything half-built -- the
 * caller simply learns another builder holds the lock. The statement and DDL
 * lock timeouts are NOT exposed, because shortening either can interrupt a
 * `CREATE INDEX CONCURRENTLY` and leave an INVALID index, whose remediation is
 * strictly worse than the absent index it replaced. A caller that needs a
 * shorter wall clock must reduce how many indexes it attempts, not how long a
 * build is allowed to take.
 *
 * Unset, unparseable, or non-positive values fall through to the guard's
 * `DEFAULT_LOCK_WAIT_TIMEOUT_MS`, so a typo in the environment degrades to the
 * documented default rather than to zero patience.
 */
function lockWaitTimeoutOverrideMs(): number | undefined {
  const raw = process.env.PAPERCLIP_PRECREATE_LOCK_WAIT_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === "") return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(
      `[precreate-online-indexes] ignoring PAPERCLIP_PRECREATE_LOCK_WAIT_TIMEOUT_MS=${JSON.stringify(raw)} ` +
        "(not a positive number); using the default lock wait",
    );
    return undefined;
  }
  return Math.trunc(parsed);
}

async function main(): Promise<void> {
  const resolved = await resolveMigrationConnection();
  console.log(`Precreating online index prerequisites via ${resolved.source}`);
  const lockWaitTimeoutMs = lockWaitTimeoutOverrideMs();
  if (lockWaitTimeoutMs !== undefined) {
    console.log(`[precreate-online-indexes] serializing lock wait bounded at ${lockWaitTimeoutMs}ms`);
  }
  try {
    const results = await ensureOnlineIndexPrerequisites(resolved.connectionString, {
      log: (message) => console.log(`[precreate-online-indexes] ${message}`),
      ...(lockWaitTimeoutMs === undefined ? {} : { lockWaitTimeoutMs }),
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
