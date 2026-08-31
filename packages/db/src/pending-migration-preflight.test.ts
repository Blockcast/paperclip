/**
 * Several migrations in this directory deliberately refuse to run on a
 * populated database and instead demand that an operator precreate their index
 * with `CREATE INDEX CONCURRENTLY` first — Drizzle wraps each migration in a
 * transaction, and `CONCURRENTLY` cannot run inside one.
 *
 * That refusal is correct, but it is raised from inside server startup, which
 * is the worst possible place to learn about it: the worker exits, crashloops,
 * and `helm upgrade --wait` reports nothing but `context deadline exceeded`
 * thirty minutes later. `concurrent-index-guard.ts` documents the assumption
 * this behaviour violates -- that a raising migration "already fails the
 * migration step visibly".
 *
 * These tests cover the pre-flight that moves that detection ahead of
 * `helm upgrade`, and — more importantly — the registry-drift checks that keep
 * it honest as new guarded migrations are added.
 */
import { describe, expect, it } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  PRECREATE_REQUIRED_INDEXES,
  formatPreflightFailure,
  selectGuardedPendingIndexes,
  type PreflightBlocker,
} from "./pending-migration-preflight.js";

const migrationsDir = fileURLToPath(new URL("./migrations", import.meta.url));

/** The message every migration in this family raises when its index is absent. */
const PRECREATE_RAISE_MARKER = "requires online index precreation";

async function migrationFilesRequiringPrecreation(): Promise<string[]> {
  const entries = await readdir(migrationsDir);
  const sqlFiles = entries.filter((entry) => entry.endsWith(".sql")).sort();
  const matches: string[] = [];
  for (const file of sqlFiles) {
    const contents = await readFile(`${migrationsDir}/${file}`, "utf8");
    if (contents.includes(PRECREATE_RAISE_MARKER)) matches.push(file);
  }
  return matches;
}

describe("PRECREATE_REQUIRED_INDEXES registry", () => {
  it("covers every migration that raises for online index precreation", async () => {
    const onDisk = await migrationFilesRequiringPrecreation();
    const registered = PRECREATE_REQUIRED_INDEXES.map((spec) => spec.migration).sort();
    // A guarded migration missing from the registry is invisible to the
    // pre-flight, which reproduces the exact outage this module prevents.
    expect(registered).toEqual(onDisk);
  });

  it("registers no migration that does not actually exist on disk", async () => {
    const entries = await readdir(migrationsDir);
    for (const spec of PRECREATE_REQUIRED_INDEXES) {
      expect(entries).toContain(spec.migration);
    }
  });

  it("gives every entry a CONCURRENTLY remediation naming its own index", () => {
    for (const spec of PRECREATE_REQUIRED_INDEXES) {
      expect(spec.createStatement).toContain("CONCURRENTLY");
      expect(spec.createStatement).toContain(spec.name);
      expect(spec.createStatement).toContain(spec.table);
    }
  });

  it("keeps each remediation identical to the migration's own HINT", async () => {
    // The registry duplicates SQL that already lives in the migration file.
    // Duplication is only safe while something pins the copy to the original:
    // without this, an edited HINT leaves the pre-flight printing remediation
    // that no longer works, which is worse than printing nothing.
    for (const spec of PRECREATE_REQUIRED_INDEXES) {
      const contents = await readFile(`${migrationsDir}/${spec.migration}`, "utf8");
      // Migration files escape single quotes for the SQL string literal.
      const unescaped = contents.replace(/''/g, "'");
      expect(unescaped).toContain(spec.createStatement);
    }
  });

  it("uses a unique index name per entry", () => {
    const names = PRECREATE_REQUIRED_INDEXES.map((spec) => spec.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("selectGuardedPendingIndexes", () => {
  const specs = [
    {
      migration: "0100_alpha.sql",
      name: "alpha_idx",
      table: "alpha",
      accessMethod: "btree",
      keyColumns: ["a"],
      predicate: "",
      createStatement: "CREATE UNIQUE INDEX CONCURRENTLY alpha_idx ON alpha USING btree (a)",
    },
    {
      migration: "0101_beta.sql",
      name: "beta_idx",
      table: "beta",
      accessMethod: "btree",
      keyColumns: ["b"],
      predicate: "",
      createStatement: "CREATE UNIQUE INDEX CONCURRENTLY beta_idx ON beta USING btree (b)",
    },
  ] as const;

  it("selects only specs whose migration is pending", () => {
    const selected = selectGuardedPendingIndexes(["0101_beta.sql"], specs);
    expect(selected.map((spec) => spec.name)).toEqual(["beta_idx"]);
  });

  it("returns nothing when no guarded migration is pending", () => {
    expect(selectGuardedPendingIndexes(["0102_gamma.sql"], specs)).toEqual([]);
  });

  it("returns nothing when there are no pending migrations at all", () => {
    expect(selectGuardedPendingIndexes([], specs)).toEqual([]);
  });

  it("ignores an already-applied guarded migration", () => {
    // The whole point: 0236 applied is not a blocker, even though it is in the
    // registry. Only *pending* guarded migrations can stall a deploy.
    expect(selectGuardedPendingIndexes(["0999_unrelated.sql"], specs)).toEqual([]);
  });
});

describe("formatPreflightFailure", () => {
  const blockers: PreflightBlocker[] = [
    {
      migration: "0236_active_pr_review_dedup.sql",
      index: "issues_active_pr_review_uq",
      state: "absent",
      remediation: "CREATE UNIQUE INDEX CONCURRENTLY issues_active_pr_review_uq ON issues USING btree (company_id)",
    },
  ];

  it("names the migration, the index, and the exact remediation SQL", () => {
    const message = formatPreflightFailure(blockers);
    expect(message).toContain("0236_active_pr_review_dedup.sql");
    expect(message).toContain("issues_active_pr_review_uq");
    expect(message).toContain("CREATE UNIQUE INDEX CONCURRENTLY");
  });

  it("explains why the deploy was stopped rather than just listing SQL", () => {
    const message = formatPreflightFailure(blockers);
    expect(message.toLowerCase()).toContain("before");
    expect(message).toMatch(/helm|deploy/i);
  });

  it("reports every blocker, not just the first", () => {
    const message = formatPreflightFailure([
      ...blockers,
      { ...blockers[0], migration: "0233_alertmanager_aggregate_creation_dedupe.sql", index: "second_idx" },
    ]);
    expect(message).toContain("issues_active_pr_review_uq");
    expect(message).toContain("second_idx");
  });
});
