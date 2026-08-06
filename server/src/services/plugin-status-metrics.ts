/**
 * @fileoverview Plugin status collector (BLO-21092).
 *
 * Closes the observability gap BLO-20410 exposed: a plugin stuck in
 * `status='error'` was invisible to Prometheus entirely, detectable only by
 * someone calling `/api/plugins` or reading the DB row by hand.
 * `lucitra.plugin-secrets` sat dead for 9+ hours with the pod `1/1 Running`,
 * `restarts=0`, and nothing alerting.
 *
 * Worker-tier only, same gate as plugin lifecycle itself
 * (`paperclipNodeRole !== "api"` — see `app.ts`): on the API tier the worker
 * manager is a stub that throws on every call, so plugin status there is
 * meaningless noise, not signal.
 */

import type { Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { pluginRegistryService } from "./plugin-registry.js";
import {
  setPluginErrorStatus,
  setPluginStatusCollectorLastSuccessSeconds,
  type PluginErrorStatusEntry,
} from "./metrics.js";

// Alert grace period is 10m (paperclip-runtime-alerts group); polling well
// under that gives several scrapes of margin before the `for:` window could
// even start counting, without hammering the plugins table (a handful of
// rows, read with a plain unfiltered select).
const DEFAULT_INTERVAL_MS = 30_000;

export interface PluginStatusRow {
  id: string;
  pluginKey: string;
  status: string;
}

/** Pure mapping from plugin rows to gauge entries — kept separate from I/O so it unit-tests without a DB. */
export function pluginErrorEntriesFromRows(
  rows: ReadonlyArray<PluginStatusRow>,
): PluginErrorStatusEntry[] {
  return rows.map((row) => ({
    id: row.id,
    pluginKey: row.pluginKey,
    isError: row.status === "error",
  }));
}

export interface PluginStatusCollectorOptions {
  intervalMs?: number;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  listInstalled?: () => Promise<ReadonlyArray<PluginStatusRow>>;
  /** Injectable clock (unix ms), matching this codebase's `now?: () => number` convention. Default: `Date.now`. */
  now?: () => number;
}

/**
 * Start the plugin-status collector. Returns a stop function, matching the
 * shape of the other worker-tier pollers wired in `app.ts`
 * (`startPluginEventOutbox`, `startGitHubCommitStatusDeliveryOutbox`).
 */
export function startPluginStatusCollector(
  db: Db,
  options: PluginStatusCollectorOptions = {},
): () => void {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const scheduleInterval = options.setInterval ?? setInterval;
  const clearIntervalFn = options.clearInterval ?? clearInterval;
  const listInstalled = options.listInstalled ?? (() => pluginRegistryService(db).listInstalled());
  const now = options.now ?? Date.now;

  let ticking = false;
  let stopped = false;

  async function tick(): Promise<void> {
    if (ticking || stopped) return;
    ticking = true;
    try {
      const rows = await listInstalled();
      setPluginErrorStatus(pluginErrorEntriesFromRows(rows));
      // Success timestamp only advances here — a rejected listInstalled()
      // (first tick or any later one) leaves it where it was, so a
      // `time() - this` alert grows monotonically while the collector is
      // stuck instead of silently reporting the same snapshot forever.
      setPluginStatusCollectorLastSuccessSeconds(Math.floor(now() / 1000));
    } catch (err) {
      logger.warn({ err }, "plugin-status-metrics: collector tick failed");
    } finally {
      ticking = false;
    }
  }


  void tick();
  const timer = scheduleInterval(() => {
    void tick();
  }, intervalMs);
  timer.unref?.();

  logger.info({ intervalMs }, "plugin-status-metrics collector started");

  return () => {
    stopped = true;
    clearIntervalFn(timer);
  };
}
