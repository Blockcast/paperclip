import { logger } from "./middleware/logger.js";
import {
  installProcessCrashGuard,
  type CrashGuardContext,
  type ProcessCrashGuardHandle,
} from "./process-crash-guard.js";

/** The heartbeat-service capability bound after the worker has initialized. */
export type CrashTimeRunMarker = (reason: string) => Promise<{ markedRunIds: string[] }>;

let crashTimeRunMarker: CrashTimeRunMarker | null = null;

export function registerCrashTimeRunMarker(marker: CrashTimeRunMarker): () => void {
  const previous = crashTimeRunMarker;
  crashTimeRunMarker = marker;
  return () => {
    crashTimeRunMarker = previous;
  };
}

/** Test seam that prevents marker state leaking between crash-guard cases. */
export function resetCrashTimeRunMarkerForTest(): void {
  crashTimeRunMarker = null;
}

export async function markInFlightRunsForWorkerCrash(
  context: Pick<CrashGuardContext, "kind" | "error">,
): Promise<void> {
  const marker = crashTimeRunMarker;
  if (!marker) return;
  const detail = context.error instanceof Error ? context.error.message : String(context.error);
  const { markedRunIds } = await marker(`${context.kind}: ${detail}`);
  if (markedRunIds.length > 0) {
    logger.error(
      { crashKind: context.kind, markedRunCount: markedRunIds.length, markedRunIds },
      "marked in-flight runs as interrupted by worker process crash",
    );
  }
}

/** Installs the entrypoint guard with late-bound heartbeat crash marking. */
export function installWorkerCrashGuard(): ProcessCrashGuardHandle {
  return installProcessCrashGuard({ logger, onCrash: markInFlightRunsForWorkerCrash });
}
