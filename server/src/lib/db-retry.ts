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
  let current: unknown = error;
  for (let depth = 0; depth < 6; depth += 1) {
    if (!current || typeof current !== "object") return false;
    const record = current as { code?: unknown; cause?: unknown };
    if (typeof record.code === "string" && TRANSIENT_DB_SQLSTATES.has(record.code)) {
      return true;
    }
    current = record.cause;
  }
  return false;
}

/**
 * Compact, diagnosable description of a failed database write (BLO-19085).
 *
 * Drizzle throws with `message` = `Failed query: <sql>\nparams: <every bind
 * param inlined>`, and the real PostgreSQL error — SQLSTATE, detail,
 * constraint — hangs off `.cause`. Callers that persisted `err.message`
 * therefore stored the *least* useful half of the error and inlined the
 * agent's entire stdout stream while doing it: two `heartbeat_runs.error`
 * values of 605,891 and 338,507 characters on 2026-07-30, neither naming the
 * SQLSTATE that caused them.
 *
 * This keeps the SQLSTATE and the statement shape, and drops the params.
 */

/** Max characters of SQL text kept when describing a failed query. */
const DB_ERROR_SQL_EXCERPT_CHARS = 240;
/** Max characters kept from a non-drizzle error message. */
const DB_ERROR_MESSAGE_CHARS = 400;

interface PgErrorFields {
  code: string;
  detail?: string;
  constraint?: string;
  table?: string;
  column?: string;
  message?: string;
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Walk the `.cause` chain for the first object carrying a PostgreSQL SQLSTATE.
 * Same traversal and depth bound as `isTransientDbError`.
 */
export function findPgError(error: unknown): PgErrorFields | null {
  let current: unknown = error;
  for (let depth = 0; depth < 6; depth += 1) {
    if (!current || typeof current !== "object") return null;
    const record = current as Record<string, unknown>;
    const code = record.code;
    // PostgreSQL SQLSTATEs are exactly five alphanumeric characters. Node's own
    // errors also use `code`, but as strings like "ECONNRESET" — the shape test
    // keeps those from being mistaken for a SQLSTATE.
    if (typeof code === "string" && /^[0-9A-Za-z]{5}$/.test(code)) {
      return {
        code,
        detail: readString(record, "detail"),
        constraint: readString(record, "constraint"),
        table: readString(record, "table"),
        column: readString(record, "column"),
        message: readString(record, "message"),
      };
    }
    current = record.cause;
  }
  return null;
}

/**
 * True when `error` looks like a database write failure worth routing through
 * `describeDbError` — either it carries a PostgreSQL SQLSTATE, or it is a
 * drizzle "Failed query" wrapper (which may hide its cause behind a driver that
 * did not attach one).
 */
export function isDbError(error: unknown): boolean {
  if (findPgError(error)) return true;
  const message = error instanceof Error ? error.message : "";
  return message.startsWith("Failed query:");
}

/**
 * Render `error` as a single compact line safe to persist in an error column.
 * Never throws, and never returns an empty string.
 */
export function describeDbError(error: unknown, context?: string): string {
  const prefix = context ? `${context}: ` : "";
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const pg = findPgError(error);

  const parts: string[] = [];
  if (pg) {
    parts.push(`SQLSTATE ${pg.code}`);
    if (pg.message) parts.push(pg.message);
    if (pg.detail) parts.push(`detail: ${pg.detail}`);
    if (pg.constraint) parts.push(`constraint: ${pg.constraint}`);
    const relation = [pg.table, pg.column].filter(Boolean).join(".");
    if (relation) parts.push(`relation: ${relation}`);
  }

  // Drizzle inlines every bind param after the SQL. Keep a short excerpt of the
  // statement so the failing write is identifiable, and drop the params — that
  // is the part that turns an error string into hundreds of kilobytes.
  const failedQuery = /^Failed query:\s*([\s\S]*?)(?:\n\s*params:|$)/.exec(raw);
  if (failedQuery) {
    const sql = failedQuery[1].replace(/\s+/g, " ").trim();
    const excerpt =
      sql.length > DB_ERROR_SQL_EXCERPT_CHARS ? `${sql.slice(0, DB_ERROR_SQL_EXCERPT_CHARS)}…` : sql;
    parts.push(`query: ${excerpt}`);
    parts.push("(bind params omitted)");
  } else if (!pg && raw) {
    parts.push(
      raw.length > DB_ERROR_MESSAGE_CHARS ? `${raw.slice(0, DB_ERROR_MESSAGE_CHARS)}…` : raw,
    );
  }

  return `${prefix}${parts.length ? parts.join(" | ") : "unknown database error"}`;
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
