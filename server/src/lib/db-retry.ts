/**
 * Bounded retry for transient PostgreSQL write failures (BLO-16998).
 *
 * A run-finalize write — `setRunStatus` / `setRunStatusIfRunning` in the
 * heartbeat service — is a single `UPDATE heartbeat_runs ... RETURNING`. Under
 * table bloat or write contention that UPDATE can lose a deadlock (40P01), get
 * cancelled by the role `statement_timeout` (57014), or time out waiting on a
 * row lock (55P03). Today any of those throws and the run is left in `running`
 * forever, so the agent never dispatches its next work and "jobs don't finish".
 *
 * These SQLSTATEs are transient: the same statement, replayed after a short
 * jittered backoff, almost always wins. This mirrors the existing retry idiom
 * in `services/recovery/service.ts` (40P01 + jittered backoff) and the 55P03
 * check in `middleware/auth.ts`, generalized so both the normal completion
 * finalize AND the BLO-16850 reaper's `process_lost` finalize (which share
 * `setRunStatus`) become resilient.
 *
 * IMPORTANT — why replay is safe here: every SQLSTATE in the retry set is
 * rollback-guaranteed for a single autocommit `UPDATE`, so a retried statement
 * can never observe its own prior write. 40P01/40001 are Class 40 (Transaction
 * Rollback); 55P03 (lock_timeout) aborts *while acquiring the lock*, before the
 * row is touched; 57014 (statement_timeout / cancel) discards the statement's
 * changes. That rollback guarantee — not idempotency alone — is what makes a
 * 0-attempts-visible replay safe. Idempotency (a status set-by-id) is the
 * belt-and-suspenders second guarantee. Only ever add a SQLSTATE that is
 * rollback-guaranteed AND only wrap idempotent writes; a relative mutation
 * (e.g. `count = count + 1`) must never be wrapped.
 */

/**
 * Transient PostgreSQL SQLSTATEs worth replaying. Deadlock, serialization
 * failure, lock-not-available (lock_timeout), and query-canceled
 * (statement_timeout). Non-transient errors (unique violation 23505, etc.)
 * are never retried.
 */
export const TRANSIENT_DB_SQLSTATES = new Set([
  "40P01", // deadlock_detected
  "40001", // serialization_failure
  "55P03", // lock_not_available (lock_timeout)
  "57014", // query_canceled (statement_timeout)
]);

/** True when `error` carries a transient PostgreSQL SQLSTATE `code`. */
export function isTransientDbError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" && TRANSIENT_DB_SQLSTATES.has(code);
}

export interface TransientDbRetryOptions {
  /** Total attempts including the first. Defaults to 4. */
  maxAttempts?: number;
  /** Backoff base; delay grows as `baseDelayMs * attempt`. Defaults to 25ms. */
  baseDelayMs?: number;
  /** Random jitter ceiling added to each backoff. Defaults to 50ms. */
  jitterMs?: number;
  /** Observability hook fired before each retry (not on the final failure). */
  onRetry?: (info: { attempt: number; error: unknown }) => void;
  /** Injectable for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable for deterministic tests. */
  random?: () => number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `fn`, retrying it on transient PostgreSQL failures with jittered backoff.
 * Non-transient errors are rethrown immediately; a transient error on the final
 * attempt is rethrown as-is. `fn` MUST be idempotent (see file header).
 */
export async function runWithTransientDbRetry<T>(
  fn: () => Promise<T>,
  options: TransientDbRetryOptions = {},
): Promise<T> {
  // Clamp so a maxAttempts < 1 misconfig still runs once rather than falling
  // through to the post-loop throw.
  const maxAttempts = Math.max(1, options.maxAttempts ?? 4);
  const baseDelayMs = options.baseDelayMs ?? 25;
  const jitterMs = options.jitterMs ?? 50;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (!isTransientDbError(error) || attempt === maxAttempts) throw error;
      options.onRetry?.({ attempt, error });
      // Jittered backoff so concurrent retriers don't re-collide on the same
      // lock-acquisition order (matches services/recovery/service.ts).
      await sleep(baseDelayMs * attempt + random() * jitterMs);
    }
  }

  // Unreachable: the loop either returns or throws on every path.
  throw new Error("runWithTransientDbRetry: exhausted without returning");
}
