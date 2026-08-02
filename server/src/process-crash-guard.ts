/**
 * Process-level crash guard (BLO-19722).
 *
 * Node kills the process on an unhandled `uncaughtException`, and — since
 * Node 15 — on an unhandled promise rejection too. Until this module landed
 * there was no `process.on("uncaughtException")` anywhere in `server/src`, so
 * a single throw from a callback we do not own took down the worker with a
 * bare stack and no context.
 *
 * That is not hypothetical. On 2026-07-31 `paperclip-0` died `exitCode: 1`
 * with:
 *
 *     TypeError: Cannot read properties of null (reading 'write')
 *         at Immediate.nextWrite (…/postgres@3.4.9/src/connection.js:255:22)
 *         at process.processImmediate (node:internal/timers:504:21)
 *
 * `postgres.js` schedules `nextWrite` via `setImmediate` (connection.js:250)
 * and dereferences `socket` when it fires (:255), while `closed()` nulls
 * `socket` (:448). A teardown landing between the two throws from a macrotask
 * with no JS frame of ours on the stack, so no `try`/`catch` in application
 * code can intercept it — the process-level handler is the only reachable
 * containment. Upstream has it open and unfixed as porsager/postgres#1154 and
 * #1066, and 3.4.9 is the latest published release, so there is no version to
 * upgrade to. See `patches/postgres@3.4.9.patch` for the driver-side guard;
 * this module is the backstop for everything we have not predicted.
 *
 * Two properties matter more than they look:
 *
 * 1. **The first write bypasses pino and is flushed under a deadline.**
 *    BLO-4137 established that pino's async transport races `process.exit` and
 *    silently drops queued lines. Raw `writeSync`, however, can wedge forever
 *    on a full blocking pipe. The breadcrumb therefore uses Node's non-blocking
 *    stderr stream and races its callback against a timer. See
 *    {@link ./shutdown-log.ts} for the transport details.
 *
 * 2. **Exit is guaranteed, on a timer we control.** `onCrash` touches the
 *    database, and the most likely reason we are here is that the database
 *    driver just died. It is therefore assumed to hang; it races a timeout and
 *    the process exits either way. A crash guard that can wedge the process
 *    turns a fast crash-and-restart into a silent hang, which kubelet only
 *    catches at the liveness probe — strictly worse than the bug it replaces.
 */

import { writeShutdownBreadcrumb, writeShutdownBreadcrumbsBounded } from "./shutdown-log.js";

/** Exit code used when the guard terminates the process deliberately. */
export const CRASH_GUARD_EXIT_CODE = 1;

/** How long `onCrash` gets before we stop waiting and exit anyway. */
export const DEFAULT_CRASH_GUARD_TIMEOUT_MS = 5_000;

export type CrashKind = "uncaughtException" | "unhandledRejection";

export interface CrashGuardContext {
  kind: CrashKind;
  error: unknown;
  /** Flattened `Error.cause` chain, outermost first. */
  causeChain: SerializedError[];
}

export interface SerializedError {
  name: string;
  message: string;
  stack?: string;
  /** Present for non-Error throwables (`throw "boom"`, rejected strings, …). */
  raw?: string;
}

interface CrashGuardLogger {
  error: (obj: Record<string, unknown>, msg: string) => void;
  flush?: () => void;
}

export interface InstallCrashGuardOptions {
  logger: CrashGuardLogger;
  /**
   * Best-effort crash-time bookkeeping — marking this worker's in-flight runs
   * so they carry a reason naming the crash instead of being rediscovered
   * minutes later as `job_missing`. Must not throw; may hang (it is raced).
   */
  onCrash?: (context: CrashGuardContext) => Promise<void> | void;
  timeoutMs?: number;
  /** Seams for tests; default to the real process. */
  exit?: (code: number) => void;
  setExitCode?: (code: number) => void;
  processRef?: Pick<NodeJS.Process, "on" | "off" | "exitCode">;
}

const MAX_CAUSE_DEPTH = 10;

/**
 * Reads one error field without letting a throwing getter escape.
 *
 * `name`/`message`/`stack`/`cause` are plain properties on a normal Error but
 * getters on subclasses and proxies, and this whole module runs *before* the
 * synchronous breadcrumb the header calls load-bearing. Installing a handler
 * also suppresses Node's default printer, so a throw in here would cost us the
 * breadcrumb and the stack Node would otherwise have printed for free.
 */
function readErrorField(read: () => unknown): string | undefined {
  try {
    const value = read();
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

function serializeOne(value: unknown): SerializedError {
  if (value instanceof Error) {
    const name = readErrorField(() => value.name) ?? "Error";
    const message = readErrorField(() => value.message) ?? "<unreadable message>";
    const stack = readErrorField(() => value.stack);
    return { name, message, ...(stack ? { stack } : {}) };
  }
  // `throw "boom"` and `Promise.reject({code:…})` both reach here. Keep the
  // raw rendering rather than coercing to an Error: the shape of what was
  // thrown is itself a clue about which library threw it.
  let raw: string;
  try {
    raw = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
  } catch {
    raw = String(value);
  }
  return { name: typeof value, message: raw, raw };
}

/**
 * Flattens an `Error.cause` chain, outermost first.
 *
 * Errors reaching this guard are frequently wrapped several layers deep, and
 * the outermost message is usually the least specific one. Logging only the
 * top frame is how a "database error" hides the socket teardown underneath.
 * Depth-capped and cycle-guarded because `cause` is attacker/library-controlled
 * and a self-referential chain here would hang the crash path.
 */
export function serializeCauseChain(error: unknown): SerializedError[] {
  const chain: SerializedError[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (current !== undefined && current !== null && chain.length < MAX_CAUSE_DEPTH) {
    if (typeof current === "object" && seen.has(current)) break;
    if (typeof current === "object") seen.add(current);
    chain.push(serializeOne(current));
    current = current instanceof Error ? readCause(current) : undefined;
  }

  return chain;
}

/** `cause` is library-controlled and may be a throwing getter; see `readErrorField`. */
function readCause(error: Error): unknown {
  try {
    return (error as { cause?: unknown }).cause;
  } catch {
    return undefined;
  }
}

/** One-line stderr rendering; the structured record goes to pino separately. */
function renderBreadcrumb(kind: CrashKind, chain: SerializedError[]): string {
  const head = chain[0];
  const summary = head ? `${head.name}: ${head.message}` : "unknown error";
  const causes =
    chain.length > 1 ? ` (caused by: ${chain.slice(1).map((c) => `${c.name}: ${c.message}`).join(" <- ")})` : "";
  return `${kind}: ${summary}${causes}`;
}

/**
 * Installs the crash handlers. Returns an uninstall function so tests (and any
 * embedded use) can restore the previous state.
 */
export function installProcessCrashGuard(options: InstallCrashGuardOptions): () => void {
  const {
    logger,
    onCrash,
    timeoutMs = DEFAULT_CRASH_GUARD_TIMEOUT_MS,
    processRef = process,
    exit = (code: number) => process.exit(code),
    setExitCode = (code: number) => {
      processRef.exitCode = code;
    },
  } = options;

  // Re-entrancy is the failure mode that turns a crash into a hang: `onCrash`
  // touches the DB, and if that throws we are called again mid-handling. The
  // second crash must exit immediately rather than start another bounded wait.
  let handling = false;

  const handle = (kind: CrashKind, error: unknown): void => {
    if (handling) {
      try {
        writeShutdownBreadcrumb(`crash-guard re-entered during ${kind}; exiting immediately`);
      } catch {
        /* stderr is gone; nothing left to say */
      }
      exit(CRASH_GUARD_EXIT_CODE);
      return;
    }
    handling = true;
    try {
      setExitCode(CRASH_GUARD_EXIT_CODE);
    } catch {
      /* exit() below remains authoritative */
    }

    // Belt-and-braces over the hardening inside `serializeCauseChain`: this runs
    // before the breadcrumb, so an empty chain (which still renders a usable
    // line) beats a throw that would cost us the breadcrumb entirely.
    let causeChain: SerializedError[];
    try {
      causeChain = serializeCauseChain(error);
    } catch {
      causeChain = [];
    }

    // Start the pipe-safe write immediately. `finish` waits for either its
    // callback or the helper's deadline, so a stalled stderr reader can never
    // prevent the deliberate exit.
    const stack = causeChain[0]?.stack;
    const initialBreadcrumb = writeShutdownBreadcrumbsBounded([
      renderBreadcrumb(kind, causeChain),
      ...(stack ? [stack] : []),
    ]);

    try {
      logger.error({ kind, causeChain, err: error }, `Fatal ${kind} — worker exiting deliberately`);
    } catch {
      /* a broken logger must not preempt the exit */
    }

    const finalBreadcrumbs: string[] = [];
    const finish = () => {
      try {
        logger.flush?.();
      } catch {
        /* ignore */
      }
      void (async () => {
        try {
          await initialBreadcrumb;
          await writeShutdownBreadcrumbsBounded([
            ...finalBreadcrumbs,
            `exiting ${CRASH_GUARD_EXIT_CODE} after ${kind}`,
          ]);
        } finally {
          exit(CRASH_GUARD_EXIT_CODE);
        }
      })();
    };

    if (!onCrash) {
      finish();
      return;
    }

    let settled = false;
    const settleOnce = (note?: string) => {
      if (settled) return;
      settled = true;
      if (note) finalBreadcrumbs.push(note);
      finish();
    };

    const timer = setTimeout(() => settleOnce(`crash bookkeeping timed out after ${timeoutMs}ms`), timeoutMs);
    // Do not hold the loop open on our own account; if nothing else is
    // pending we should exit rather than wait out the full timeout.
    timer.unref?.();

    void (async () => {
      try {
        await onCrash({ kind, error, causeChain });
        clearTimeout(timer);
        settleOnce();
      } catch (bookkeepingError) {
        clearTimeout(timer);
        settleOnce(
          `crash bookkeeping failed: ${
            bookkeepingError instanceof Error ? bookkeepingError.message : String(bookkeepingError)
          }`,
        );
      }
    })();
  };

  let strictUnhandledRejection: unknown;
  let strictUnhandledRejectionPending = false;
  const onUncaught = (error: unknown, origin?: string) => {
    if (origin === "unhandledRejection") {
      // In strict mode Node emits this event before `unhandledRejection` for
      // the same reason. Handle it once so the second event cannot take the
      // crash guard's immediate re-entry path and truncate diagnostics.
      strictUnhandledRejection = error;
      strictUnhandledRejectionPending = true;
      handle("unhandledRejection", error);
      return;
    }
    handle("uncaughtException", error);
  };
  const onRejection = (reason: unknown) => {
    if (strictUnhandledRejectionPending && Object.is(reason, strictUnhandledRejection)) {
      strictUnhandledRejectionPending = false;
      strictUnhandledRejection = undefined;
      return;
    }
    handle("unhandledRejection", reason);
  };

  processRef.on("uncaughtException", onUncaught as NodeJS.UncaughtExceptionListener);
  processRef.on("unhandledRejection", onRejection as NodeJS.UnhandledRejectionListener);

  return () => {
    processRef.off("uncaughtException", onUncaught as NodeJS.UncaughtExceptionListener);
    processRef.off("unhandledRejection", onRejection as NodeJS.UnhandledRejectionListener);
  };
}
