/**
 * Terminal-run pod-log sweeper (BLO-48193, BLO-32734 AC2 residual).
 *
 * The claude_k8s adapter unlinks `<runId>.pod.ndjson` in exactly one place:
 * the `finally` of its own `execute()`. A run whose Job finishes while the
 * server process owning that `execute()` is dead (a `paperclip-0` deploy or
 * eviction) is finalized server-side from Job status instead, and nothing on
 * that path removes the file. OOM, eviction and `job_failed` deaths of the
 * owner leak the same way.
 *
 * Why a sweeper and not an unlink at server-side finalization: the adapter
 * TAILS this file while the run is live (`tailPodLogFile`, then a final
 * `readFile`), and `finalizeExternalLifecycleTerminalRun` itself reads it to
 * recover the run's verdict (`readOrphanedRunTerminalResult`). An unlink tied
 * to finalization would race both. A file that is DB-terminal AND untouched
 * for 48h races neither.
 *
 * Three gates, each load-bearing:
 * - the run is DB-terminal (an unknown run id is left alone);
 * - the file mtime is older than `retentionMs`;
 * - the file mtime is at or after `notBefore`. The pre-existing backlog is
 *   audit data whose mass deletion needs board authorization (BLO-32734), so
 *   this only ever reaps files written after the sweeper shipped.
 */
import { inArray } from "drizzle-orm";
import fs from "node:fs/promises";
import path from "node:path";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns } from "@paperclipai/db";
import { logger as defaultLogger } from "../middleware/logger.js";
import { TERMINAL_RUN_STATUSES } from "./agent-scorecards.js";
import { runLogBasePath } from "./orphaned-run-terminal-result.js";

export const POD_LOG_RETENTION_MS = 48 * 60 * 60 * 1000;
/** Backlog cutoff: files last written before this are never touched. */
export const POD_LOG_SWEEP_NOT_BEFORE = new Date("2026-10-22T00:00:00Z");
export const POD_LOG_MAX_DELETES_PER_TICK = 500;

const POD_LOG_NAME = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.pod\.ndjson$/;

/**
 * Same predicate as the adapter's `isReapablePodLogPath`
 * (vendor/paperclip-adapter-claude-k8s/src/server/execute.ts). Restated
 * because the server does not depend on the adapter package; every path this
 * module builds already satisfies it, so it is a backstop, not a filter.
 */
export function isReapablePodLogPath(podLogPath: string): boolean {
  return podLogPath.startsWith("/")
    && podLogPath.endsWith(".pod.ndjson")
    && !podLogPath.split("/").includes("..");
}

type Logger = Pick<typeof defaultLogger, "info" | "warn" | "error">;

export interface PodLogSweepOptions {
  root?: string;
  now?: Date;
  retentionMs?: number;
  notBefore?: Date;
  maxDeletes?: number;
  /** runId -> status for the ids that exist. */
  lookupRunStatuses: (runIds: string[]) => Promise<Map<string, string>>;
  logger?: Logger;
}

async function listDir(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

/** Every `<root>/<company>/<agent>[/isolated/<key>]` directory. */
async function podLogDirs(root: string): Promise<string[]> {
  const dirs: string[] = [];
  for (const company of await listDir(root)) {
    for (const agent of await listDir(path.join(root, company))) {
      const agentDir = path.join(root, company, agent);
      dirs.push(agentDir);
      for (const key of await listDir(path.join(agentDir, "isolated"))) {
        dirs.push(path.join(agentDir, "isolated", key));
      }
    }
  }
  return dirs;
}

export async function sweepTerminalRunPodLogs(options: PodLogSweepOptions) {
  const root = path.resolve(options.root ?? runLogBasePath());
  const now = (options.now ?? new Date()).getTime();
  const olderThan = now - (options.retentionMs ?? POD_LOG_RETENTION_MS);
  const notBefore = (options.notBefore ?? POD_LOG_SWEEP_NOT_BEFORE).getTime();
  const maxDeletes = options.maxDeletes ?? POD_LOG_MAX_DELETES_PER_TICK;
  const log = options.logger ?? defaultLogger;

  const candidates = new Map<string, string>(); // runId -> path
  for (const dir of await podLogDirs(root)) {
    for (const name of await listDir(dir)) {
      const runId = POD_LOG_NAME.exec(name)?.[1];
      if (!runId) continue;
      const file = path.join(dir, name);
      if (!isReapablePodLogPath(file)) continue;
      const stat = await fs.lstat(file).catch(() => null);
      if (!stat?.isFile()) continue;
      const mtime = stat.mtimeMs;
      if (mtime >= olderThan || mtime < notBefore) continue;
      candidates.set(runId, file);
    }
  }

  const terminal = new Set<string>(TERMINAL_RUN_STATUSES);
  let deleted = 0;
  let skippedNonTerminal = 0;
  const ids = [...candidates.keys()];
  for (let i = 0; i < ids.length && deleted < maxDeletes; i += 500) {
    const statuses = await options.lookupRunStatuses(ids.slice(i, i + 500));
    for (const runId of ids.slice(i, i + 500)) {
      if (deleted >= maxDeletes) break;
      const status = statuses.get(runId);
      if (!status || !terminal.has(status)) {
        skippedNonTerminal += 1;
        continue;
      }
      try {
        await fs.unlink(candidates.get(runId)!);
        deleted += 1;
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
          log.warn({ runId, err }, "pod-log sweeper: failed to unlink terminal run pod log");
        }
      }
    }
  }
  if (candidates.size > 0) {
    log.info({ candidates: candidates.size, deleted, skippedNonTerminal }, "pod-log sweeper pass complete");
  }
  return { candidates: candidates.size, deleted, skippedNonTerminal };
}

export function createDbRunStatusLookup(db: Db) {
  return async (runIds: string[]) => {
    const rows = await db
      .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(inArray(heartbeatRuns.id, runIds));
    return new Map(rows.map((r) => [r.id, r.status]));
  };
}

export function startPodLogSweeper(db: Db, intervalMs: number): () => void {
  const lookupRunStatuses = createDbRunStatusLookup(db);
  let inFlight = false;
  const runTick = () => {
    if (inFlight) return;
    inFlight = true;
    sweepTerminalRunPodLogs({ lookupRunStatuses })
      .catch((err) => defaultLogger.error({ err }, "pod-log sweeper pass failed"))
      .finally(() => {
        inFlight = false;
      });
  };
  runTick();
  const timer = setInterval(runTick, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
