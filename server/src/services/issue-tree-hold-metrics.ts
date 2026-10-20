/**
 * @fileoverview Active subtree pause-hold census (BLO-32137).
 *
 * Hold 87558a2a outlived its `done` root by two months, stranding a `high`
 * row that the inbox advertised as ready while checkout 409'd it. Nothing
 * could see it: tree-hold reads are board-only by design. This gauge makes
 * "how many pause holds are stale?" answerable from Prometheus without
 * widening that read surface. It observes only — it never releases a hold,
 * because an operator stop must not be overturned by the system.
 *
 * Worker tier only, same gate as the plugin-status collector in `app.ts`.
 */

import { and, eq } from "drizzle-orm";
import { Gauge, type Registry } from "prom-client";
import { issues, issueTreeHolds, type Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { getMetricsRegistry } from "./metrics.js";

export const ISSUE_TREE_ACTIVE_PAUSE_HOLDS_METRIC = "paperclip_issue_tree_active_pause_holds";

const AGE_BUCKETS = ["<1d", "1-7d", ">7d"] as const;
type AgeBucket = (typeof AGE_BUCKETS)[number];
const DAY_MS = 86_400_000;
const DEFAULT_INTERVAL_MS = 60_000;

export interface ActivePauseHoldRow {
  createdAt: Date;
  rootStatus: string;
}

function ageBucket(createdAt: Date, nowMs: number): AgeBucket {
  const age = nowMs - createdAt.getTime();
  if (age < DAY_MS) return "<1d";
  if (age <= 7 * DAY_MS) return "1-7d";
  return ">7d";
}

/** Pure count of rows into every (age_bucket, root_terminal) cell, zeros included. */
export function countActivePauseHolds(
  rows: ReadonlyArray<ActivePauseHoldRow>,
  nowMs: number,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const bucket of AGE_BUCKETS) {
    for (const terminal of ["true", "false"]) counts.set(`${bucket}|${terminal}`, 0);
  }
  for (const row of rows) {
    const terminal = row.rootStatus === "done" || row.rootStatus === "cancelled" ? "true" : "false";
    const key = `${ageBucket(row.createdAt, nowMs)}|${terminal}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

// Registered lazily against the current shared registry, re-created if the
// registry is reset (tests), so metrics.ts needs no edit for one gauge.
let gauge: Gauge<"age_bucket" | "root_terminal"> | null = null;
let gaugeRegistry: Registry | null = null;
function activePauseHoldsGauge(): Gauge<"age_bucket" | "root_terminal"> {
  const registry = getMetricsRegistry();
  if (!gauge || gaugeRegistry !== registry) {
    gauge = new Gauge({
      name: ISSUE_TREE_ACTIVE_PAUSE_HOLDS_METRIC,
      help:
        "Active subtree pause holds (issue_tree_holds status='active' AND mode='pause'), by age "
        + "bucket and whether the hold's root issue is done/cancelled (BLO-32137). A hold here "
        + "keeps 409ing checkout for its whole subtree. Observational only; nothing auto-releases.",
      labelNames: ["age_bucket", "root_terminal"],
      registers: [registry],
    });
    gaugeRegistry = registry;
  }
  return gauge;
}

export function setActivePauseHolds(rows: ReadonlyArray<ActivePauseHoldRow>, nowMs: number): void {
  const g = activePauseHoldsGauge();
  for (const [key, value] of countActivePauseHolds(rows, nowMs)) {
    const [age_bucket, root_terminal] = key.split("|");
    g.set({ age_bucket, root_terminal }, value);
  }
}

export interface IssueTreeHoldCollectorOptions {
  intervalMs?: number;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  listActivePauseHolds?: () => Promise<ReadonlyArray<ActivePauseHoldRow>>;
  now?: () => number;
}

export function startIssueTreeHoldCollector(db: Db, options: IssueTreeHoldCollectorOptions = {}): () => void {
  const scheduleInterval = options.setInterval ?? setInterval;
  const clearIntervalFn = options.clearInterval ?? clearInterval;
  const now = options.now ?? Date.now;
  const listActivePauseHolds = options.listActivePauseHolds ?? (() =>
    db
      .select({ createdAt: issueTreeHolds.createdAt, rootStatus: issues.status })
      .from(issueTreeHolds)
      .innerJoin(issues, eq(issues.id, issueTreeHolds.rootIssueId))
      .where(and(eq(issueTreeHolds.status, "active"), eq(issueTreeHolds.mode, "pause"))));

  let ticking = false;
  async function tick(): Promise<void> {
    if (ticking) return;
    ticking = true;
    try {
      setActivePauseHolds(await listActivePauseHolds(), now());
    } catch (err) {
      // Leaves the last snapshot in place; a first-tick failure leaves no series,
      // which the alert's absent() companion is not needed for at this blast radius.
      logger.warn({ err }, "issue-tree-hold-metrics: collector tick failed");
    } finally {
      ticking = false;
    }
  }

  void tick();
  const timer = scheduleInterval(() => void tick(), options.intervalMs ?? DEFAULT_INTERVAL_MS);
  timer.unref?.();
  return () => clearIntervalFn(timer);
}
