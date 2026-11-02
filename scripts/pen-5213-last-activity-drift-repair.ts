/**
 * PEN-5213 — run the one-shot `issues.last_activity_at` drift repair.
 *
 * This is the repair that migration 0270 used to run inside the same
 * transaction as the `activity_log` trigger DDL, which caused the 2026-11-02
 * 02:41–03:16Z outage (every `insert into activity_log` blocked on `55P03`).
 * It is a CLI, not a migration, so it never runs at pod startup and therefore
 * cannot interact with the startup probe.
 *
 * Run it AFTER `0271_issues_last_activity_at_activity_log_trigger.sql` has been
 * applied — arming first is the only order that cannot lose a row, because a
 * row repaired while the arm was still missing could drift straight back out.
 *
 * Safe to run against live traffic: each batch is its own transaction with a 3s
 * `lock_timeout`, so it yields to writers rather than queueing them behind it.
 * Safe to interrupt and re-run: the `<` guard makes every finished batch
 * correct and every re-run idempotent.
 *
 * Usage:
 *   DATABASE_URL=... npx tsx scripts/pen-5213-last-activity-drift-repair.ts
 *
 *   --batch-size N   issues scanned per batch (default 2000)
 *   --dry-run        report how many rows WOULD be repaired, change nothing
 *   --quiet          suppress per-batch progress
 */
import {
  DEFAULT_DRIFT_REPAIR_BATCH_SIZE,
  runIssuesLastActivityDriftRepair,
} from "../packages/db/src/index.js";

function flagValue(name: string): string | null {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  if (index !== -1 && index + 1 < process.argv.length) {
    const next = process.argv[index + 1]!;
    if (!next.startsWith("--")) return next;
  }
  return null;
}

const hasFlag = (name: string): boolean => process.argv.includes(`--${name}`);

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");

  const rawBatchSize = flagValue("batch-size");
  const batchSize = rawBatchSize === null ? DEFAULT_DRIFT_REPAIR_BATCH_SIZE : Number(rawBatchSize);
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new Error(`--batch-size must be a positive integer, got ${rawBatchSize}`);
  }

  const quiet = hasFlag("quiet");
  const startedAt = Date.now();

  const result = await runIssuesLastActivityDriftRepair(url, {
    batchSize,
    dryRun: hasFlag("dry-run"),
    log: (message) => console.warn(message),
    onProgress: quiet
      ? undefined
      : ({ batches, scanned, repaired }) => {
          if (batches % 10 === 0) {
            console.log(`  ${batches} batches, ${scanned} scanned, ${repaired} repaired`);
          }
        },
  });

  if ("dryRunDrifted" in result) {
    console.log(`dry-run: ${result.dryRunDrifted} issue(s) would be repaired`);
    return;
  }

  console.log(
    `repaired ${result.repaired} of ${result.scanned} issue(s) in ${result.batches} batch(es), `
    + `${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
  );
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
