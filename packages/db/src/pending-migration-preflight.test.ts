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
  collectPreflightBlockers,
  decidePreflightBlocker,
  formatPreflightFailure,
  selectGuardedPendingIndexes,
  type IndexProbe,
  type PrecreateRequiredIndex,
  type PreflightBlocker,
  type PreflightProbes,
  type TablePopulation,
} from "./pending-migration-preflight.js";

const migrationsDir = fileURLToPath(new URL("./migrations", import.meta.url));

/**
 * The message every migration in this family raises when its index is absent.
 *
 * Deliberately a pattern rather than a fixed substring. Migrations are free to
 * name *which* index they mean — 0217 raises "requires online queued-age index
 * precreation" — and an exact-substring marker silently drops those, which is
 * the defect this file exists to close (BLO-31626). The alternative, editing
 * 0217 to match one canonical phrase, is not available: this repo derives
 * applied-migration state from a migration's content hash, so rewording an
 * applied migration reports it pending everywhere and re-runs it on deploy.
 * The wording is the migration's to choose; matching it is this test's job.
 */
const PRECREATE_RAISE_MARKER = /requires online (?:\w+[- ])*index precreation/;

/**
 * A remediation that builds the index online *because it is absent*. This is
 * what separates the precreation family from 0226/0227, whose raises fire for
 * a *mismatched* index and remediate with `DROP ... IF EXISTS` first. An
 * absent index there is a documented no-op, so they are correctly unregistered.
 */
const ONLINE_PRECREATE_REMEDIATION = /CREATE (?:UNIQUE )?INDEX CONCURRENTLY IF NOT EXISTS/i;

/** One slice per `RAISE EXCEPTION`, each ending where the next one begins. */
function raiseBlocks(sql: string): string[] {
  const starts: number[] = [];
  const pattern = /RAISE\s+EXCEPTION\b/gi;
  for (let match = pattern.exec(sql); match; match = pattern.exec(sql)) starts.push(match.index);
  return starts.map((start, index) => sql.slice(start, starts[index + 1] ?? sql.length));
}

/**
 * That raise's own `HINT`, with SQL's doubled-quote escaping undone.
 *
 * Known hole: only single-quoted literals are recognised. A dollar-quoted hint
 * (`HINT = $q$CREATE INDEX CONCURRENTLY IF NOT EXISTS ...$q$`) returns `null`
 * and evades the shape detector below. Latent — nothing in the corpus uses
 * dollar quoting — and left open deliberately rather than closed with an
 * untested second branch. If a migration ever needs it, widen to
 * `/HINT\s*=\s*(?:'((?:[^']|'')*)'|\$(\w*)\$([\s\S]*?)\$\2\$)/i` and add a
 * fixture; do not assume the shape detector covered it in the meantime.
 */
function hintOf(block: string): string | null {
  const match = /HINT\s*=\s*'((?:[^']|'')*)'/i.exec(block);
  return match ? match[1].replace(/''/g, "'") : null;
}

/**
 * The guard identified structurally rather than by wording: a `RAISE EXCEPTION`
 * whose own `HINT` tells the operator to build the index online because it is
 * absent. `PRECREATE_RAISE_MARKER` is how we spell that contract; this is the
 * contract itself.
 *
 * Both detectors are needed. The drift test below compares a hand-maintained
 * registry against a scan of the same files, so a migration that phrases its
 * raise differently is dropped from the scan — and the author who chose that
 * wording is exactly the author who also missed the registry. Both sides of
 * `toEqual` then lose it and the assertion passes while proving nothing. That
 * is how 0217 stayed invisible to the pre-flight (BLO-31626). A detector whose
 * miss removes an item from the expected *and* the actual set can never fail,
 * so the check has to key on something the wording cannot silence.
 *
 * Attribution is per-raise on purpose. Scanning the whole file for a
 * `RAISE ... HINT` pair inside a fixed character window makes the verdict
 * depend on how far apart two unrelated branches happen to sit: 0217's
 * mismatch raise and the *next* branch's `HINT` are ~600 characters apart, so
 * such a window decides the right answer for the wrong reason and flips if
 * anyone reflows the SQL. Slicing at each raise pairs every raise with its own
 * `HINT` and needs no magic number.
 */
function raisesForPrecreation(sql: string): boolean {
  return raiseBlocks(sql).some((block) => {
    const hint = hintOf(block);
    return hint !== null && ONLINE_PRECREATE_REMEDIATION.test(hint);
  });
}

let migrationSqlFilesPromise: Promise<readonly { readonly file: string; readonly contents: string }[]> | null = null;

/** Read once per suite: the corpus is ~240 files and four callers want it. */
async function readMigrationSqlFiles(): Promise<readonly { readonly file: string; readonly contents: string }[]> {
  migrationSqlFilesPromise ??= (async () => {
    const entries = await readdir(migrationsDir);
    const sqlFiles = entries.filter((entry) => entry.endsWith(".sql")).sort();
    return Promise.all(
      sqlFiles.map(async (file) => ({ file, contents: await readFile(`${migrationsDir}/${file}`, "utf8") })),
    );
  })();
  return migrationSqlFilesPromise;
}

async function migrationFilesRequiringPrecreation(): Promise<string[]> {
  const files = await readMigrationSqlFiles();
  return files.filter(({ contents }) => PRECREATE_RAISE_MARKER.test(contents)).map(({ file }) => file);
}

describe("PRECREATE_REQUIRED_INDEXES registry", () => {
  it("covers every migration that raises for online index precreation", async () => {
    const onDisk = await migrationFilesRequiringPrecreation();
    const registered = PRECREATE_REQUIRED_INDEXES.map((spec) => spec.migration).sort();
    // A guarded migration missing from the registry is invisible to the
    // pre-flight, which reproduces the exact outage this module prevents.
    expect(registered).toEqual(onDisk);
  });

  it("catches a guarded migration whose raise wording escapes the marker", async () => {
    const files = await readMigrationSqlFiles();
    const guardShaped = files.filter(({ contents }) => raisesForPrecreation(contents)).map(({ file }) => file);
    const markerMatched = await migrationFilesRequiringPrecreation();

    // Non-vacuity, pinned to a named file rather than a count. The assertion
    // below is containment, so a *shrinking* `guardShaped` makes it easier to
    // satisfy — a bare `length > 0` floor would tolerate the shape detector
    // degrading to near-inert (a `HINT` form `hintOf` cannot parse, a refactor
    // of the slicing) while staying green, which is this file's own thesis one
    // level up.
    //
    // 0217 is the right pin: it is the file whose wording escaped the old
    // marker, so its detection lapsing is never a wording preference and
    // always a real regression. It also cannot go stale — this repo derives
    // applied-migration state from a migration's content hash, so 0217's text
    // is immutable, and the same constraint that caused this bug is what makes
    // the pin permanent. A `>= 8` floor would also work but decays into a
    // weaker and weaker bound as the corpus grows; set equality against the
    // marker is the reverse direction rejected below.
    expect(guardShaped).toContain("0217_heartbeat_runs_queued_age_idx.sql");
    // The shape is ground truth; the marker is only the wording. A migration
    // in the first set but not the second is invisible to the drift test on
    // *both* sides, so it never reaches the pre-flight.
    //
    // One-way containment on purpose. Set equality would also catch the
    // reverse — marker-matched but shape-unmatched — but that direction fails
    // the moment a legitimately-registered migration phrases its `HINT`
    // differently, turning an unrelated PR red for a wording choice that
    // breaks nothing. The asymmetry is deliberate: a missed guard is an
    // outage, an unrecognised HINT is a style difference.
    expect(guardShaped.filter((file) => !markerMatched.includes(file))).toEqual([]);
  });

  it("does not mistake a drop-and-rebuild remediation for precreation", async () => {
    // The discriminator that keeps the shape detector narrow. 0226/0227 raise
    // for a *mismatched* index and remediate by dropping it first; an absent
    // index there is a documented no-op, so they must stay out of the registry.
    // Widening the shape to match them would fail unrelated PRs, so pin it.
    const files = await readMigrationSqlFiles();
    const dropRemediated = files.filter(
      ({ file }) => file.startsWith("0226_") || file.startsWith("0227_"),
    );
    expect(dropRemediated.length).toBe(2);
    for (const { file, contents } of dropRemediated) {
      expect(raiseBlocks(contents).length).toBeGreaterThan(0);
      expect({ file, guarded: raisesForPrecreation(contents) }).toEqual({ file, guarded: false });
      expect(PRECREATE_REQUIRED_INDEXES.map((spec) => spec.migration)).not.toContain(file);
    }
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
    const files = await readMigrationSqlFiles();
    const contentsByFile = new Map(files.map(({ file, contents }) => [file, contents]));
    for (const spec of PRECREATE_REQUIRED_INDEXES) {
      const contents = contentsByFile.get(spec.migration);
      // A registered file absent from the corpus would otherwise read as
      // `undefined` and fail on the wrong assertion.
      expect(contents, `${spec.migration} is registered but not on disk`).toBeDefined();
      // Migration files escape single quotes for the SQL string literal.
      const unescaped = contents!.replace(/''/g, "'");
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

describe("decidePreflightBlocker", () => {
  // A genuinely registered migration. The function is pure and never reads the
  // file, but this suite is about a registry hole, so a fixture naming an
  // unregistered migration would invite exactly the misreading it warns about.
  const spec: PrecreateRequiredIndex = {
    migration: "0209_heartbeat_runs_recovery_dispatch_index.sql",
    name: "heartbeat_runs_recovery_dispatch_idx",
    table: "heartbeat_runs",
    createStatement:
      "CREATE INDEX CONCURRENTLY IF NOT EXISTS heartbeat_runs_recovery_dispatch_idx " +
      "ON heartbeat_runs USING btree (agent_id, created_at, id)",
  };

  const absent = { exists: false, usable: false } as const;
  const halfBuilt = { exists: true, usable: false } as const;
  const usable = { exists: true, usable: true } as const;

  // The case this function exists for. A fresh bootstrap has every migration
  // pending, every index absent, and every table empty or not yet created —
  // and every one of those migrations builds its own index inline and
  // succeeds. Reporting them failed a deploy that needed no operator at all.
  it.each<TablePopulation>(["empty", "absent"])(
    "does not block an absent index when the table is %s",
    (population) => {
      expect(decidePreflightBlocker(spec, absent, population)).toBeNull();
    },
  );

  // The load-bearing direction: this is the outage BLO-30895 built the
  // pre-flight for. A fix that merely stopped reporting blockers would satisfy
  // the empty-table cases above while re-opening this one.
  it("still blocks an absent index when the table is populated", () => {
    expect(decidePreflightBlocker(spec, absent, "populated")).toEqual({
      migration: spec.migration,
      index: spec.name,
      state: "absent",
      remediation: spec.createStatement,
    });
  });

  // A half-built index takes the migration's *structural* branch, which
  // demands `indisvalid` and raises with no emptiness test at all. Emptiness
  // must not exempt it, or the pre-flight waves through a migration that then
  // fails the slow way from inside server startup.
  it.each<TablePopulation>(["empty", "absent", "populated"])(
    "blocks a half-built index regardless of the table being %s",
    (population) => {
      expect(decidePreflightBlocker(spec, halfBuilt, population)?.state).toBe("build-incomplete");
    },
  );

  it("never blocks when the index is already valid and ready", () => {
    for (const population of ["empty", "absent", "populated"] as const) {
      expect(decidePreflightBlocker(spec, usable, population)).toBeNull();
    }
  });

  it("reports the spec's own remediation verbatim", () => {
    const blocker = decidePreflightBlocker(spec, absent, "populated");
    expect(blocker?.remediation).toBe(spec.createStatement);
  });

  it("applies uniformly to every registered entry, with no special-casing", () => {
    // The behaviour is a property of the shared decision function, so a newly
    // added registry entry inherits it without extra work. Asserted over the
    // real registry so that stays true as entries are added.
    for (const registered of PRECREATE_REQUIRED_INDEXES) {
      expect(decidePreflightBlocker(registered, absent, "empty")).toBeNull();
      expect(decidePreflightBlocker(registered, absent, "populated")?.state).toBe("absent");
      expect(decidePreflightBlocker(registered, halfBuilt, "empty")?.state).toBe("build-incomplete");
    }
  });
});

describe("collectPreflightBlockers", () => {
  const heartbeatSpecs = PRECREATE_REQUIRED_INDEXES.filter((spec) => spec.table === "heartbeat_runs");
  const issuesSpecs = PRECREATE_REQUIRED_INDEXES.filter((spec) => spec.table === "issues");

  // Both probes are reads with no effects, so their *verdict* is covered by
  // `decidePreflightBlocker` above and what is left to pin is how many times
  // each one is issued. That is invisible in the output by construction: a
  // regression here changes no blocker, only round trips.
  function recordingProbes(
    indexFor: (name: string) => IndexProbe,
    populationFor: (table: string) => TablePopulation = () => "populated",
  ) {
    const indexCalls: string[] = [];
    const populationCalls: string[] = [];
    return {
      indexCalls,
      populationCalls,
      probes: {
        index: async (name: string) => {
          indexCalls.push(name);
          return indexFor(name);
        },
        population: async (table: string) => {
          populationCalls.push(table);
          return populationFor(table);
        },
      },
    };
  }

  it("skips the population probe entirely when every index is usable", async () => {
    const { probes, indexCalls, populationCalls } = recordingProbes(() => ({ exists: true, usable: true }));

    const blockers = await collectPreflightBlockers(PRECREATE_REQUIRED_INDEXES, probes);

    expect(blockers).toEqual([]);
    // Every index still probed — the short-circuit is per-spec, not a bail-out.
    expect(indexCalls).toHaveLength(PRECREATE_REQUIRED_INDEXES.length);
    // The point of the short-circuit: a fully-indexed database costs zero
    // population round trips, not one per distinct table.
    expect(populationCalls).toEqual([]);
  });

  it("still resolves population when an index is absent", async () => {
    // The other direction. A short-circuit that skipped too eagerly would
    // leave the absent-index path unable to tell an empty table from a
    // populated one, which is the whole BLO-31746 exemption.
    const { probes, populationCalls } = recordingProbes(
      () => ({ exists: false, usable: false }),
      () => "populated",
    );

    const blockers = await collectPreflightBlockers(heartbeatSpecs, probes);

    expect(populationCalls).toEqual(["heartbeat_runs"]);
    expect(blockers.map((blocker) => blocker.state)).toEqual(heartbeatSpecs.map(() => "absent"));
  });

  it("probes each distinct table once across specs that share it", async () => {
    const { probes, populationCalls } = recordingProbes(() => ({ exists: false, usable: false }));

    await collectPreflightBlockers(PRECREATE_REQUIRED_INDEXES, probes);

    // Seven heartbeat_runs entries and two issues entries collapse to two
    // probes. Asserted as a set-with-count so adding a registry entry on an
    // existing table does not move this number.
    expect(populationCalls.sort()).toEqual(["heartbeat_runs", "issues"]);
    expect(heartbeatSpecs.length + issuesSpecs.length).toBe(PRECREATE_REQUIRED_INDEXES.length);
  });

  it("memoizes an empty table rather than re-probing it per spec", async () => {
    // The exempting direction has to be memoized too, or the saving vanishes
    // exactly on the fresh bootstrap this all exists for.
    const { probes, populationCalls } = recordingProbes(
      () => ({ exists: false, usable: false }),
      () => "empty",
    );

    expect(await collectPreflightBlockers(heartbeatSpecs, probes)).toEqual([]);
    expect(populationCalls).toEqual(["heartbeat_runs"]);
  });

  it("keeps a half-built index a blocker on every registered entry", async () => {
    // A half-built index must not be short-circuited: it is not `usable`, so
    // it falls through to the same decision path and still blocks.
    //
    // Deliberately asserts the verdict and *not* the probe counts. A half-built
    // index reaches `decidePreflightBlocker` with `index.exists` true, which
    // returns before reading `table` — so eliding its population probe too
    // would be a legitimate further optimisation, and pinning the current count
    // here would cement an incidental round trip as required behaviour. The
    // equivalence test below is what protects this path.
    const { probes } = recordingProbes(
      () => ({ exists: true, usable: false }),
      () => "empty",
    );

    const blockers = await collectPreflightBlockers(PRECREATE_REQUIRED_INDEXES, probes);

    expect(blockers).toHaveLength(PRECREATE_REQUIRED_INDEXES.length);
    for (const blocker of blockers) expect(blocker.state).toBe("build-incomplete");
  });

  it("mixes usable and absent indexes without cross-contaminating verdicts", async () => {
    const [first, ...rest] = heartbeatSpecs;
    const { probes, populationCalls } = recordingProbes(
      (name) => ({ exists: name !== first.name, usable: name !== first.name }),
      () => "populated",
    );

    const blockers = await collectPreflightBlockers(heartbeatSpecs, probes);

    expect(blockers.map((blocker) => blocker.migration)).toEqual([first.migration]);
    expect(rest.length).toBeGreaterThan(0);
    expect(populationCalls).toEqual(["heartbeat_runs"]);
  });

  /**
   * Probes unconditionally, exactly as the scan did before the short-circuit
   * and the per-table memo were introduced. Kept deliberately naive: it is the
   * oracle, so it must not share the optimisations it is checking.
   */
  async function referenceCollect(
    guarded: readonly PrecreateRequiredIndex[],
    probes: PreflightProbes,
  ): Promise<readonly PreflightBlocker[]> {
    const blockers: PreflightBlocker[] = [];
    for (const spec of guarded) {
      const index = await probes.index(spec.name);
      const population = await probes.population(spec.table);
      const blocker = decidePreflightBlocker(spec, index, population);
      if (blocker) blockers.push(blocker);
    }
    return blockers;
  }

  it("agrees with an unconditionally-probing reference across the whole state space", async () => {
    // The call-count tests above pin the *optimisation*; this pins the
    // *equivalence*, which is the property that actually matters and the one a
    // future refactor is most likely to break. They would all still pass if the
    // short-circuit moved somewhere subtler than a `continue` and started
    // eliding a probe whose value changed the verdict — this would not.
    //
    // `{ exists: false, usable: true }` is omitted on purpose: `probeIndex`
    // cannot produce it (a row absent from `pg_index` yields both false), so
    // asserting over it would pin behaviour for a state the system never has.
    const indexStates: readonly IndexProbe[] = [
      { exists: false, usable: false },
      { exists: true, usable: false },
      { exists: true, usable: true },
    ];
    const populations: readonly TablePopulation[] = ["absent", "empty", "populated"];

    // Guards the guard, as at the per-spec test below. Over a *uniform* index
    // state most cells are legitimately empty on both sides, so a reference
    // that returned `[]` unconditionally would pass five of the nine. Only
    // these four carry signal: absent×populated, and all three half-built rows
    // (`decidePreflightBlocker` returns build-incomplete before reading
    // `table`). Counting them makes the sweep fail loudly if a registry or
    // decision-function change silently moves which cells assert anything.
    let cellsWithSignal = 0;

    for (const index of indexStates) {
      for (const population of populations) {
        const actual = await collectPreflightBlockers(
          PRECREATE_REQUIRED_INDEXES,
          recordingProbes(
            () => index,
            () => population,
          ).probes,
        );
        const expected = await referenceCollect(
          PRECREATE_REQUIRED_INDEXES,
          recordingProbes(
            () => index,
            () => population,
          ).probes,
        );

        expect(actual, `index=${JSON.stringify(index)} population=${population}`).toEqual(expected);
        if (actual.length > 0) cellsWithSignal += 1;
      }
    }

    expect(cellsWithSignal).toBe(4);
  });

  it("agrees with the reference when index state and population both vary per spec", async () => {
    // The uniform sweep above cannot catch cross-contamination between specs,
    // which is the failure mode a memo or a misplaced `continue` actually
    // produces. Deterministic per-spec variation, so a failure is reproducible.
    const indexStates: readonly IndexProbe[] = [
      { exists: false, usable: false },
      { exists: true, usable: false },
      { exists: true, usable: true },
    ];
    const orderedNames = PRECREATE_REQUIRED_INDEXES.map((spec) => spec.name);
    const indexFor = (name: string) => indexStates[orderedNames.indexOf(name) % indexStates.length];
    const populationFor = (table: string): TablePopulation => (table === "issues" ? "empty" : "populated");

    const actual = await collectPreflightBlockers(
      PRECREATE_REQUIRED_INDEXES,
      recordingProbes(indexFor, populationFor).probes,
    );
    const expected = await referenceCollect(
      PRECREATE_REQUIRED_INDEXES,
      recordingProbes(indexFor, populationFor).probes,
    );

    expect(actual).toEqual(expected);
    // Guards the guard: a sweep that produced no blockers at all would agree
    // with any reference, so this test has to be shown to be exercising both.
    expect(actual.length).toBeGreaterThan(0);
    expect(actual.length).toBeLessThan(PRECREATE_REQUIRED_INDEXES.length);
  });
});

describe("guarded migrations gate their raise on table population", () => {
  it("gates only the absent-index path on emptiness, never the structural one", async () => {
    // `decidePreflightBlocker` exempts an empty table for an *absent* index and
    // deliberately does not for a half-built one. That asymmetry is only
    // correct while the migrations keep this shape, so pin the shape here.
    //
    // Keyed on the two remediations rather than on branch syntax: the family
    // spells the same logic as both `IF/ELSE` (0209) and `IF/ELSIF` (0205) —
    // four registered files use `ELSIF`, four use `ELSE`, and 0236 uses
    // neither — so an `ELSE`-matching detector silently passes on five of the
    // nine (the four `ELSIF` files plus 0236). The mismatch raise is
    // identifiable by its `DROP INDEX CONCURRENTLY` hint.
    //
    // Comments are stripped before searching, and the hint is asserted unique.
    // Both matter: 0237 mentions `DROP INDEX CONCURRENTLY` in prose 61 lines
    // ahead of its real HINT, so searching the raw text anchors on the comment
    // and leaves 0237's whole structural branch inside the guard window. The
    // uniqueness assertion means any future second occurrence fails loudly
    // here rather than silently shifting that window again.
    for (const spec of PRECREATE_REQUIRED_INDEXES) {
      const contents = await readFile(`${migrationsDir}/${spec.migration}`, "utf8");
      // Offsets below are all into `sql`, never into `contents`.
      const sql = contents
        .split("\n")
        .filter((line) => !/^\s*--/.test(line))
        .join("\n");

      const hints = [...sql.matchAll(/DROP INDEX CONCURRENTLY/g)];
      expect(
        hints.length,
        `${spec.migration} has no unique mismatch remediation to anchor on`,
      ).toBe(1);
      const structuralHint = hints[0].index;

      // Deliberately looser than the single-line form the files use today, so
      // an emptiness gate reformatted across lines or written `SELECT *` is
      // still seen rather than silently dropping out of the guard window.
      //
      // Anchored on the spec's own table, which is what makes the looseness
      // safe: every one of these files opens with a multiline
      // `EXISTS (\n SELECT 1\n FROM pg_index ...)` structural probe, and a
      // pattern ending at a bare `FROM` matches that too — it sits ahead of
      // the hint and would fail the ordering assertion on every registered
      // file. An emptiness check is by definition a check on the guarded
      // table.
      const emptinessChecks = [
        ...sql.matchAll(
          new RegExp(`EXISTS\\s*\\(\\s*SELECT\\s+\\S+\\s+FROM\\s+"?${spec.table}"?`, "g"),
        ),
      ].map((match) => match.index);
      expect(
        emptinessChecks.length,
        `${spec.migration} lost its empty-table guard; the pre-flight exemption assumes one`,
      ).toBeGreaterThan(0);

      // Every emptiness check sits after the structural raise, so no emptiness
      // test can gate it. A half-built index therefore raises on an empty
      // table too — which is why the exemption must not cover it.
      for (const at of emptinessChecks) {
        expect(
          at,
          `${spec.migration} gained an emptiness check that could gate its structural raise`,
        ).toBeGreaterThan(structuralHint);
      }

      // And the absent-index path really does build the index itself, inline
      // and without CONCURRENTLY — which is what makes an empty table need no
      // operator at all. Checked against `sql` so a commented-out example
      // cannot satisfy it; the required quote already rules out the unquoted
      // `CREATE INDEX CONCURRENTLY` inside the hint text.
      expect(sql, `${spec.migration} no longer builds its index inline`).toMatch(
        /CREATE (?:UNIQUE )?INDEX "/,
      );
    }
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
