/**
 * Offline duplicate-cluster report for a historical issue window (BLO-18799).
 *
 * Runs the exact matcher the create path uses over a trailing window and prints
 * cluster counts plus the largest clusters, so precision can be spot-checked
 * against real data before the create-time refusal is switched on.
 *
 *   pnpm tsx scripts/issue-duplicate-backfill.ts --company <uuid> --project <uuid> --days 30
 *
 * Flags:
 *   --company <uuid>      restrict to one company (default: all)
 *   --project <uuid>      restrict to one project
 *   --days <n>            trailing window in days (default 30)
 *   --origin <kind>       restrict to one originKind (e.g. `manual`); repeatable
 *                         via comma separation. Templated machine-filed issues
 *                         (alerts, "Unblock liveness incident for X", "Review
 *                         productivity for X") are near-identical by
 *                         construction and swamp the report otherwise.
 *   --score <float>       override the score threshold
 *   --distinctive <n>     override the shared-distinctive-feature floor
 *   --show <n>            how many of the largest clusters to print (default 10)
 *   --dump-corpus <path>  write the fetched window to JSON (test-fixture capture)
 */
import { writeFileSync } from "node:fs";
import { and, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { createDb, issues } from "@paperclipai/db";
import { loadConfig } from "../src/config.js";
import {
  ISSUE_DUPLICATE_MATCHER_DEFAULTS,
  clusterIssueDuplicates,
  type IssueDuplicateDocument,
} from "@paperclipai/shared/issue-duplicate-matcher";

function parseFlag(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

function parseNumberFlag(name: string, fallback: number): number {
  const raw = parseFlag(name);
  if (raw === null) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a number, got ${raw}`);
  return parsed;
}

async function main() {
  const config = loadConfig();
  const dbUrl =
    process.env.DATABASE_URL?.trim()
    || config.databaseUrl
    || `postgres://paperclip:paperclip@127.0.0.1:${config.embeddedPostgresPort}/paperclip`;
  const db = createDb(dbUrl);

  const companyId = parseFlag("--company");
  const projectId = parseFlag("--project");
  const days = parseNumberFlag("--days", 30);
  const show = parseNumberFlag("--show", 10);
  const dumpCorpus = parseFlag("--dump-corpus");
  const originKinds = parseFlag("--origin")?.split(",").map((kind) => kind.trim()).filter(Boolean) ?? null;
  const options = {
    scoreThreshold: parseNumberFlag("--score", ISSUE_DUPLICATE_MATCHER_DEFAULTS.scoreThreshold),
    minSharedDistinctiveFeatures: parseNumberFlag(
      "--distinctive",
      ISSUE_DUPLICATE_MATCHER_DEFAULTS.minSharedDistinctiveFeatures,
    ),
  };

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const rows = await db
    .select({
      id: issues.id,
      identifier: issues.identifier,
      title: issues.title,
      description: issues.description,
      status: issues.status,
      originKind: issues.originKind,
      createdAt: issues.createdAt,
    })
    .from(issues)
    .where(and(
      isNull(issues.hiddenAt),
      gte(issues.createdAt, since),
      ...(companyId ? [eq(issues.companyId, companyId)] : []),
      ...(projectId ? [eq(issues.projectId, projectId)] : []),
      ...(originKinds ? [inArray(issues.originKind, originKinds)] : []),
      sql`coalesce(btrim(${issues.description}), '') <> ''`,
    ))
    .orderBy(desc(issues.createdAt));

  console.log(
    `window: ${days}d since ${since.toISOString()} — ${rows.length} issues with a description`
    + `${originKinds ? ` (originKind in ${originKinds.join(",")})` : ""}`,
  );
  console.log(
    `thresholds: score >= ${options.scoreThreshold}, shared distinctive features >= ${options.minSharedDistinctiveFeatures}`,
  );

  if (dumpCorpus) {
    writeFileSync(
      dumpCorpus,
      `${JSON.stringify(
        rows.map((row) => ({
          identifier: row.identifier,
          title: row.title,
          description: row.description,
          status: row.status,
          originKind: row.originKind,
          createdAt: row.createdAt.toISOString(),
        })),
        null,
        2,
      )}\n`,
    );
    console.log(`wrote corpus of ${rows.length} issues to ${dumpCorpus}`);
  }

  const documents: IssueDuplicateDocument[] = rows.map((row) => ({
    id: row.id,
    identifier: row.identifier,
    title: row.title,
    description: row.description,
  }));
  const byId = new Map(rows.map((row) => [row.id, row]));

  const started = Date.now();
  const clusters = clusterIssueDuplicates(documents, options);
  const elapsedMs = Date.now() - started;

  const clustered = clusters.reduce((total, cluster) => total + cluster.ids.length, 0);
  console.log(
    `\n${clusters.length} clusters covering ${clustered} issues `
    + `(${((clustered / Math.max(rows.length, 1)) * 100).toFixed(1)}% of the window) in ${elapsedMs}ms`,
  );

  const histogram = new Map<number, number>();
  for (const cluster of clusters) {
    histogram.set(cluster.ids.length, (histogram.get(cluster.ids.length) ?? 0) + 1);
  }
  console.log("cluster size histogram (size: count):");
  for (const size of Array.from(histogram.keys()).sort((a, b) => a - b)) {
    console.log(`  ${size}: ${histogram.get(size)}`);
  }

  const largest = [...clusters].sort((a, b) => b.ids.length - a.ids.length).slice(0, show);
  console.log(`\n${largest.length} largest clusters for precision spot-check:`);
  for (const [index, cluster] of largest.entries()) {
    console.log(`\n#${index + 1} — ${cluster.ids.length} members`);
    for (const id of cluster.ids) {
      const row = byId.get(id);
      if (!row) continue;
      console.log(
        `  ${row.identifier ?? id} [${row.status}] ${row.createdAt.toISOString().slice(0, 10)} ${row.title}`,
      );
    }
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
