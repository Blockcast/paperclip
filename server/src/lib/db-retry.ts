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
 * `query_canceled`. PEN-3596: this is the one member of
 * {@link TRANSIENT_DB_SQLSTATES} that Postgres did not raise by naming a
 * contention state — the statement outran the role's `statement_timeout` and
 * was cancelled. It stays in the retry set (a cancellation under a transient
 * load spike can succeed on replay), but the API boundary reports it
 * separately so a 57014 is not read as a deadlock or a lock timeout.
 *
 * PEN-5244: "and nothing was waiting on a lock" used to close that first
 * sentence. It does not follow and is removed — this SQLSTATE reports that the
 * time bound was exceeded, not what the time was spent on, and a statement can
 * burn its whole budget blocked on a lock and then be cancelled here.
 */
export const STATEMENT_TIMEOUT_SQLSTATE = "57014";

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
  STATEMENT_TIMEOUT_SQLSTATE, // query_canceled (statement_timeout) — not contention
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
/** Max characters kept from individual PostgreSQL error fields. */
const DB_ERROR_FIELD_CHARS = 160;
/** Max characters kept from a non-drizzle error message. */
const DB_ERROR_MESSAGE_CHARS = 400;
/** Hard cap for the persisted database-error description. */
const DB_ERROR_DESCRIPTION_CHARS = 900;

const POSTGRES_SQLSTATE_CLASSES = new Set([
  "00",
  "01",
  "02",
  "03",
  "08",
  "09",
  "0A",
  "0B",
  "0F",
  "0L",
  "0P",
  "0Z",
  "20",
  "21",
  "22",
  "23",
  "24",
  "25",
  "26",
  "27",
  "28",
  "2B",
  "2D",
  "2F",
  "34",
  "38",
  "39",
  "3B",
  "3D",
  "3F",
  "40",
  "42",
  "44",
  "53",
  "54",
  "55",
  "57",
  "58",
  "72",
  "F0",
  "HV",
  "P0",
  "XX",
]);

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
  if (typeof value !== "string") return undefined;
  const normalized = compactErrorText(value, DB_ERROR_FIELD_CHARS);
  return normalized.length > 0 ? normalized : undefined;
}

function compactErrorText(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > maxChars ? `${normalized.slice(0, maxChars)}…` : normalized;
}

function isPostgresSqlState(code: string): boolean {
  const normalized = code.toUpperCase();
  return /^[0-9A-Z]{5}$/.test(normalized) && POSTGRES_SQLSTATE_CLASSES.has(normalized.slice(0, 2));
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
    // PostgreSQL SQLSTATEs are exactly five alphanumeric characters, but Node's
    // own syscall codes also use this field (`EPIPE`, `EPERM`). Require a
    // recognized PostgreSQL class prefix so adapter/process failures are not
    // relabeled as database writes.
    if (typeof code === "string" && isPostgresSqlState(code)) {
      return {
        code: code.toUpperCase(),
        detail: readString(record, "detail"),
        // `constraint` OR `constraint_name`: node-postgres spells it the first
        // way, the `postgres` (porsager) driver this server actually runs spells
        // it the second. Reading only `constraint` left this field permanently
        // empty in production — `describeDbError` below has therefore never once
        // printed a constraint name, and a caller keying on it (as the approval
        // payload-edit conflict translation does) silently never matched. Same
        // `constraint ?? constraint_name` fallback `issue-thread-interactions.ts`
        // already applies at its own call site.
        constraint: readString(record, "constraint") ?? readString(record, "constraint_name"),
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
    parts.push(`query: ${compactErrorText(failedQuery[1], DB_ERROR_SQL_EXCERPT_CHARS)}`);
    parts.push("(bind params omitted)");
  } else if (!pg && raw) {
    parts.push(compactErrorText(raw, DB_ERROR_MESSAGE_CHARS));
  }

  return compactErrorText(
    `${prefix}${parts.length ? parts.join(" | ") : "unknown database error"}`,
    DB_ERROR_DESCRIPTION_CHARS,
  );
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
  /**
   * Observability hook fired for EVERY caught error, including a non-transient
   * one that is about to be rethrown unretried and the transient one on the
   * final attempt (PEN-6581). `willRetry` says which of those it is.
   *
   * This is deliberately a different hook from {@link onRetry}, not a widening
   * of it. `onRetry` answers "how much replay is this write costing", so it
   * must stay silent on an error that is not replayed; a census of database
   * errors needs the opposite, because the events it exists to count are
   * precisely the ones that are NOT followed by a retry -- the final failure of
   * an exhausted sequence, and every non-transient error. Counting on `onRetry`
   * would undercount by exactly one event per failing operation and would miss
   * a single-attempt failure entirely.
   *
   * Fired BEFORE the rethrow and before the backoff sleep, so it observes every
   * error even when the caller discards the thrown value.
   *
   * ⛔ A throw from this hook is SWALLOWED, and that is not politeness. The
   * two call sites that motivated it are the `heartbeat_runs` finalize writes
   * this module exists to protect, where the file header records the cost of
   * an unhandled throw: "the run is left in `running` forever and the agent
   * never dispatches its next work". An observability hook must not be able to
   * re-create the outage it was added to measure, and must not replace the
   * database error the caller is entitled to see with a metrics fault. The
   * swallow is scoped to THIS hook -- `onRetry`'s behaviour is unchanged -- and
   * a hook that needs its failures visible must report them itself (the
   * `recordBackgroundDbError` recorder logs its own).
   */
  onError?: (info: { attempt: number; error: unknown; willRetry: boolean }) => void;
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
      const willRetry = isTransientDbError(error) && attempt < maxAttempts;
      try {
        options.onError?.({ attempt, error, willRetry });
      } catch {
        // See onError's contract: the database error must win. Deliberately
        // not logged here -- this module is a pure leaf with no imports, and a
        // hook that needs its failures visible reports them itself.
      }
      if (!willRetry) throw error;
      options.onRetry?.({ attempt, error });
      // Jittered backoff so concurrent retriers don't re-collide on the same
      // lock-acquisition order (matches services/recovery/service.ts).
      await sleep(baseDelayMs * attempt + random() * jitterMs);
    }
  }

  // Unreachable: the loop either returns or throws on every path.
  throw new Error("runWithTransientDbRetry: exhausted without returning");
}
