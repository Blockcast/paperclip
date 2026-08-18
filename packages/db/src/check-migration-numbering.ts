import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const migrationsDir = fileURLToPath(new URL("./migrations", import.meta.url));
const journalPath = fileURLToPath(new URL("./migrations/meta/_journal.json", import.meta.url));

type JournalFile = {
  entries?: Array<{
    idx?: number;
    tag?: string;
  }>;
};

export type MigrationNumberingInput = {
  /** Migration file names including the `.sql` suffix, e.g. `0115_milestones.sql`. */
  migrationFiles: string[];
  /** Journal tags without a suffix, e.g. `0115_milestones`. */
  journalTags: string[];
};

/**
 * Migration files that are present on disk without a `meta/_journal.json` entry.
 *
 * These are NOT inert. `inspectMigrations()` builds its candidate list from
 * `readdir()` over the migrations folder (`client.ts` `listMigrationFiles`), not
 * from the journal, so an un-journaled `.sql` is still applied and still recorded
 * in `drizzle.__drizzle_migrations`. Verified on a freshly migrated database:
 * 222 `.sql` files produce 222 applied rows, and every object these nine files
 * create is present. Do NOT "clean up" this list by deleting the files — that
 * would silently drop live schema (`milestones`, `plugin_event_outbox`,
 * `issue_pull_requests`, `companies.feature_flags`, ...) from every future
 * bootstrap while leaving already-migrated databases looking healthy.
 *
 * The defect an un-journaled file actually carries is ORDERING.
 * `orderMigrationsByJournal()` sorts entries with no journal record to the end,
 * so a file numbered 0046 applies after 0220 instead of in its numbered slot.
 * Today's population happens to be order-insensitive (each is `IF NOT EXISTS`
 * or additive), which is why nothing has broken. New occurrences are blocked
 * because that property does not generalize.
 *
 * Entries here are grandfathered, not endorsed. The fix for any of them is to
 * add the missing journal entry, never to delete the file.
 */
export const GRANDFATHERED_UNJOURNALED_MIGRATIONS: readonly string[] = [
  // Journal entry lost to a rebase; column adds are `IF NOT EXISTS` + COALESCE backfill.
  "0046_smooth_sentinels.sql",
  // Hand-authored tail migrations. Their own headers state the journal is
  // deliberately stale at 0102 and that `drizzle-kit generate` must not be run.
  "0102_server_side_sweep_preflight.sql",
  "0103_activity_log_issue_lookup_indexes.sql",
  "0104_heartbeat_run_issue_scope_indexes.sql",
  "0105_plugin_event_outbox.sql",
  "0106_issue_pull_requests.sql",
  // Tail migrations added after the journal drifted; applied via the directory scan.
  "0114_issue_evidence_verdict_evaluated_at.sql",
  "0115_milestones.sql",
  "0116_evidence_verdict_idx_partial.sql",
];

/**
 * File-name groups permitted to share a 4-digit migration number.
 *
 * Both members of each pair are applied; the number no longer determines their
 * relative order, so the pairing is an ordering ambiguity rather than a dropped
 * migration. Each group is matched exactly, so introducing a *third* file on one
 * of these numbers still fails.
 */
export const GRANDFATHERED_DUPLICATE_FILE_NUMBERS: readonly (readonly string[])[] = [
  ["0046_smart_garia.sql", "0046_smooth_sentinels.sql"],
  ["0102_early_toad_men.sql", "0102_server_side_sweep_preflight.sql"],
  ["0106_ccrotate_capacity_exhaustion_dedupe.sql", "0106_issue_pull_requests.sql"],
];

function migrationNumber(value: string): string | null {
  const match = value.match(/^(\d{4})_/);
  return match ? match[1] : null;
}

function ensureNoDuplicates(values: string[], label: string) {
  const seen = new Map<string, string>();

  for (const value of values) {
    const number = migrationNumber(value);
    if (!number) {
      throw new Error(`${label} entry does not start with a 4-digit migration number: ${value}`);
    }
    const existing = seen.get(number);
    if (existing) {
      throw new Error(`Duplicate migration number ${number} in ${label}: ${existing}, ${value}`);
    }
    seen.set(number, value);
  }
}

function ensureStrictlyOrdered(values: string[], label: string) {
  const sorted = [...values].sort();
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] !== sorted[index]) {
      throw new Error(
        `${label} are out of order at position ${index}: expected ${sorted[index]}, found ${values[index]}`,
      );
    }
  }
}

function ensureJournalMatchesFiles(migrationFiles: string[], journalTags: string[]) {
  const journalFiles = journalTags.map((tag) => `${tag}.sql`);
  const journalFileSet = new Set(journalFiles);

  // Every journal entry must have a corresponding file
  for (const journalFile of journalFiles) {
    if (!migrationFiles.includes(journalFile)) {
      throw new Error(
        `Migration journal references ${journalFile} but the file does not exist`,
      );
    }
  }

  // Journal entries must appear in order among the files
  const journaledFiles = migrationFiles.filter((f) => journalFileSet.has(f));
  for (let index = 0; index < journaledFiles.length; index += 1) {
    if (journaledFiles[index] !== journalFiles[index]) {
      throw new Error(
        `Migration journal/file order mismatch at position ${index}: journal has ${journalFiles[index]}, files have ${journaledFiles[index]}`,
      );
    }
  }
}

/**
 * Every `.sql` on disk must have a journal entry, so that its apply order is the
 * one its number advertises. Files in
 * {@link GRANDFATHERED_UNJOURNALED_MIGRATIONS} are exempt.
 */
function ensureFilesAreJournaled(
  migrationFiles: string[],
  journalTags: string[],
  allowlist: readonly string[],
) {
  const journalFileSet = new Set(journalTags.map((tag) => `${tag}.sql`));
  const allowed = new Set(allowlist);

  const offenders = migrationFiles.filter(
    (file) => !journalFileSet.has(file) && !allowed.has(file),
  );

  if (offenders.length > 0) {
    throw new Error(
      `Migration file(s) have no meta/_journal.json entry: ${offenders.join(", ")}. ` +
        `An un-journaled migration still runs, but it is ordered after every journaled ` +
        `migration instead of at its numbered position. Add the journal entry (do not ` +
        `delete the file). If the ordering is genuinely intentional, add it to ` +
        `GRANDFATHERED_UNJOURNALED_MIGRATIONS with a reason.`,
    );
  }
}

/**
 * Two `.sql` files sharing a 4-digit number make the number stop determining
 * apply order. Groups in {@link GRANDFATHERED_DUPLICATE_FILE_NUMBERS} are
 * exempt, matched as an exact set so a further collision on the same number
 * still fails.
 */
function ensureNoDuplicateFileNumbers(
  migrationFiles: string[],
  allowlist: readonly (readonly string[])[],
) {
  const allowedGroups = new Set(allowlist.map((group) => [...group].sort().join("|")));

  const byNumber = new Map<string, string[]>();
  for (const file of migrationFiles) {
    const number = migrationNumber(file);
    if (!number) {
      throw new Error(`migration file does not start with a 4-digit migration number: ${file}`);
    }
    const bucket = byNumber.get(number);
    if (bucket) {
      bucket.push(file);
    } else {
      byNumber.set(number, [file]);
    }
  }

  for (const [number, files] of [...byNumber.entries()].sort()) {
    if (files.length < 2) continue;
    if (allowedGroups.has([...files].sort().join("|"))) continue;
    throw new Error(
      `Duplicate migration number ${number} among migration files: ${[...files].sort().join(", ")}. ` +
        `Renumber one of them so the 4-digit prefix still determines apply order.`,
    );
  }
}

/**
 * Pure form of the checker so the assertions can be tested against fixtures.
 * Throws on the first violation, matching the CLI behaviour.
 */
export function analyzeMigrationNumbering(
  input: MigrationNumberingInput,
  options: {
    unjournaledAllowlist?: readonly string[];
    duplicateFileNumberAllowlist?: readonly (readonly string[])[];
  } = {},
): void {
  const { migrationFiles, journalTags } = input;
  const unjournaledAllowlist = options.unjournaledAllowlist ?? GRANDFATHERED_UNJOURNALED_MIGRATIONS;
  const duplicateFileNumberAllowlist =
    options.duplicateFileNumberAllowlist ?? GRANDFATHERED_DUPLICATE_FILE_NUMBERS;

  ensureNoDuplicates(journalTags, "migration journal");
  ensureStrictlyOrdered(journalTags, "migration journal");
  ensureJournalMatchesFiles(migrationFiles, journalTags);
  ensureFilesAreJournaled(migrationFiles, journalTags, unjournaledAllowlist);
  ensureNoDuplicateFileNumbers(migrationFiles, duplicateFileNumberAllowlist);
}

export async function readMigrationNumberingInput(): Promise<MigrationNumberingInput> {
  const migrationFiles = (await readdir(migrationsDir))
    .filter((entry) => entry.endsWith(".sql"))
    .sort();

  const rawJournal = await readFile(journalPath, "utf8");
  const journal = JSON.parse(rawJournal) as JournalFile;
  const journalTags = (journal.entries ?? []).map((entry, index) => {
    if (typeof entry.tag !== "string" || entry.tag.length === 0) {
      throw new Error(`Migration journal entry ${index} is missing a tag`);
    }
    return entry.tag;
  });

  return { migrationFiles, journalTags };
}

async function main() {
  analyzeMigrationNumbering(await readMigrationNumberingInput());
}

const isDirectRun = process.argv[1] === fileURLToPath(import.meta.url);
if (isDirectRun) {
  await main();
}
