/**
 * Crash-time run marking: the bridge between the process crash guard and the
 * heartbeat service (BLO-19722 AC 2/3).
 *
 * Why this is its own module rather than a few lines in `index.ts`.
 *
 * The crash guard is installed at the process entrypoint, *before*
 * `startServer()` has built the heartbeat service, so the marker cannot be
 * passed by value at install time — it has to be resolved when the crash
 * actually happens. That late binding is the whole content of this file.
 *
 * Keeping it out of `index.ts` also makes it testable. `index.ts` pulls in the
 * entire server module graph and its install site sits under `isMainModule`,
 * which no test executes; a hook defined there could only ever be verified by
 * inspection. That is precisely how `markRunsInterruptedByWorkerCrash` came to
 * sit with no production caller through three review rounds — the function was
 * tested, the wiring was not, and nothing failed.
 *
 * @see ./process-crash-guard.ts — deliberately holds no dependency edge on the
 *      heartbeat service, and receives this behaviour by injection instead.
 */

import { logger } from "./middleware/logger.js";
import {
  installProcessCrashGuard,
  type CrashGuardContext,
  type ProcessCrashGuardHandle,
} from "./process-crash-guard.js";

/** What crash-time marking needs from the heartbeat service. */
export type CrashTimeRunMarker = (reason: string) => Promise<{ markedRunIds: string[] }>;

/**
 * Stays null on a replica running with the heartbeat scheduler disabled: such a
 * worker supervises no runs, so a crash there has nothing to orphan.
 */
let crashTimeRunMarker: CrashTimeRunMarker | null = null;

/**
 * Registers the marker consulted by {@link markInFlightRunsForWorkerCrash}.
 *
 * Returns a disposer restoring the previous marker so a test can install a fake
 * without leaking it into the next case.
 */
export function registerCrashTimeRunMarker(marker: CrashTimeRunMarker): () => void {
  const previous = crashTimeRunMarker;
  crashTimeRunMarker = marker;
  return () => {
    crashTimeRunMarker = previous;
  };
}

/** Test seam: forget any registered marker. */
export function resetCrashTimeRunMarkerForTest(): void {
  crashTimeRunMarker = null;
}

/**
 * The crash guard's `onCrash` body: marks this worker's in-flight runs so their
 * terminal reason names the worker death, instead of the run being rediscovered
 * minutes later as `job_missing` once a reaper pass notices — and the agent
 * being latched to `error` with that misattributed reason.
 *
 * Failures are deliberately *not* swallowed. `installProcessCrashGuard` catches
 * them and appends a `crash bookkeeping failed: …` breadcrumb to the crash
 * record; catching here would make a failed mark indistinguishable from "there
 * was nothing to mark", which is the same class of silent gap this issue is
 * about.
 */
export async function markInFlightRunsForWorkerCrash(
  context: Pick<CrashGuardContext, "kind" | "error">,
): Promise<void> {
  const marker = crashTimeRunMarker;
  if (!marker) return;

  const detail = context.error instanceof Error ? context.error.message : String(context.error);
  const { markedRunIds } = await marker(`${context.kind}: ${detail}`);
  if (markedRunIds.length === 0) return;

  logger.error(
    {
      crashKind: context.kind,
      markedRunCount: markedRunIds.length,
      markedRunIds,
    },
    "marked in-flight runs as interrupted by worker process crash",
  );
}

/**
 * Installs the process crash guard with crash-time run marking attached.
 *
 * This exists as a named function, rather than an inline
 * `installProcessCrashGuard({ logger, onCrash })` at the entrypoint, so that the
 * `onCrash` wiring is reachable from a test. The entrypoint call site sits under
 * `isMainModule`, which no test executes — so an `onCrash` passed there could
 * only be verified by reading the file, and "verified by reading the file" is
 * how this hook stayed disconnected for three review rounds.
 *
 * `index.ts` keeps the `isMainModule` decision and the returned handle; this
 * owns what a worker's guard is wired to.
 */
export function installWorkerCrashGuard(): ProcessCrashGuardHandle {
  return installProcessCrashGuard({ logger, onCrash: markInFlightRunsForWorkerCrash });
}
