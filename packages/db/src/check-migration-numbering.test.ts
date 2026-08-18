import { describe, expect, it } from "vitest";
import {
  analyzeMigrationNumbering,
  readMigrationNumberingInput,
  GRANDFATHERED_UNJOURNALED_MIGRATIONS,
  GRANDFATHERED_DUPLICATE_FILE_NUMBERS,
  type MigrationNumberingInput,
} from "./check-migration-numbering.js";

/**
 * Pre-fix checker: the assertions that existed before BLO-27927. Used as the
 * negative control — every new test below must pass against this and fail
 * against the real checker, otherwise the guard is not actually guarding.
 */
function analyzeWithPreFixChecker(input: MigrationNumberingInput): void {
  const { migrationFiles, journalTags } = input;

  const seen = new Map<string, string>();
  for (const tag of journalTags) {
    const number = tag.match(/^(\d{4})_/)?.[1];
    if (!number) throw new Error(`journal entry lacks a number: ${tag}`);
    if (seen.has(number)) throw new Error(`Duplicate migration number ${number}`);
    seen.set(number, tag);
  }

  const sorted = [...journalTags].sort();
  for (let i = 0; i < journalTags.length; i += 1) {
    if (journalTags[i] !== sorted[i]) throw new Error(`journal out of order at ${i}`);
  }

  for (const tag of journalTags) {
    if (!migrationFiles.includes(`${tag}.sql`)) {
      throw new Error(`Migration journal references ${tag}.sql but the file does not exist`);
    }
  }
}

const EMPTY_ALLOWLISTS = {
  unjournaledAllowlist: [] as readonly string[],
  duplicateFileNumberAllowlist: [] as readonly (readonly string[])[],
};

describe("analyzeMigrationNumbering", () => {
  it("accepts a tree where every file is journaled and numbers are unique", () => {
    const input: MigrationNumberingInput = {
      migrationFiles: ["0001_alpha.sql", "0002_beta.sql"],
      journalTags: ["0001_alpha", "0002_beta"],
    };
    expect(() => analyzeMigrationNumbering(input, EMPTY_ALLOWLISTS)).not.toThrow();
  });

  describe("file -> journal direction (new in BLO-27927)", () => {
    const input: MigrationNumberingInput = {
      migrationFiles: ["0001_alpha.sql", "0002_orphan.sql"],
      journalTags: ["0001_alpha"],
    };

    it("fails on a .sql file with no journal entry", () => {
      expect(() => analyzeMigrationNumbering(input, EMPTY_ALLOWLISTS)).toThrow(
        /0002_orphan\.sql/,
      );
    });

    it("negative control: the pre-fix checker passed this tree", () => {
      expect(() => analyzeWithPreFixChecker(input)).not.toThrow();
    });

    it("does not tell the reader to delete the file", () => {
      let message = "";
      try {
        analyzeMigrationNumbering(input, EMPTY_ALLOWLISTS);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/do not\s+delete the file/i);
    });

    it("exempts an allowlisted file", () => {
      expect(() =>
        analyzeMigrationNumbering(input, {
          ...EMPTY_ALLOWLISTS,
          unjournaledAllowlist: ["0002_orphan.sql"],
        }),
      ).not.toThrow();
    });
  });

  describe("duplicate file numbers (new in BLO-27927)", () => {
    // Mirrors the real shape on master (e.g. 0046): one member of the colliding
    // pair is journaled, the other is not. The journal itself stays clean so
    // only the file-level collision is under test.
    const input: MigrationNumberingInput = {
      migrationFiles: ["0001_alpha.sql", "0001_beta.sql"],
      journalTags: ["0001_alpha"],
    };
    const unjournaledExempt = { unjournaledAllowlist: ["0001_beta.sql"] };

    it("negative control: the pre-fix checker passed duplicate file numbers", () => {
      expect(() => analyzeWithPreFixChecker(input)).not.toThrow();
    });

    it("fails on two .sql files sharing a 4-digit prefix", () => {
      expect(() =>
        analyzeMigrationNumbering(input, { ...EMPTY_ALLOWLISTS, ...unjournaledExempt }),
      ).toThrow(/Duplicate migration number 0001 among migration files/);
    });

    it("exempts an exactly-matching allowlisted group", () => {
      expect(() =>
        analyzeMigrationNumbering(input, {
          ...unjournaledExempt,
          duplicateFileNumberAllowlist: [["0001_alpha.sql", "0001_beta.sql"]],
        }),
      ).not.toThrow();
    });

    it("still fails when a third file joins an allowlisted group", () => {
      expect(() =>
        analyzeMigrationNumbering(
          {
            migrationFiles: ["0001_alpha.sql", "0001_beta.sql", "0001_gamma.sql"],
            journalTags: ["0001_alpha"],
          },
          {
            unjournaledAllowlist: ["0001_beta.sql", "0001_gamma.sql"],
            duplicateFileNumberAllowlist: [["0001_alpha.sql", "0001_beta.sql"]],
          },
        ),
      ).toThrow(/Duplicate migration number 0001/);
    });
  });

  it("still fails when the journal references a missing file", () => {
    expect(() =>
      analyzeMigrationNumbering(
        { migrationFiles: ["0001_alpha.sql"], journalTags: ["0001_alpha", "0002_ghost"] },
        EMPTY_ALLOWLISTS,
      ),
    ).toThrow(/0002_ghost\.sql but the file does not exist/);
  });
});

describe("the real packages/db/src/migrations tree", () => {
  it("passes the checker with the shipped allowlists", async () => {
    const input = await readMigrationNumberingInput();
    expect(input.migrationFiles.length).toBeGreaterThan(200);
    expect(() => analyzeMigrationNumbering(input)).not.toThrow();
  });

  it("would fail without the allowlists — the grandfathered population is real", async () => {
    const input = await readMigrationNumberingInput();
    expect(() => analyzeMigrationNumbering(input, EMPTY_ALLOWLISTS)).toThrow();
  });

  it("allowlists contain no stale entries", async () => {
    const { migrationFiles, journalTags } = await readMigrationNumberingInput();
    const files = new Set(migrationFiles);
    const journaled = new Set(journalTags.map((tag) => `${tag}.sql`));

    for (const entry of GRANDFATHERED_UNJOURNALED_MIGRATIONS) {
      expect(files.has(entry), `${entry} is allowlisted but absent from disk`).toBe(true);
      expect(journaled.has(entry), `${entry} is allowlisted but is now journaled`).toBe(false);
    }

    for (const group of GRANDFATHERED_DUPLICATE_FILE_NUMBERS) {
      for (const entry of group) {
        expect(files.has(entry), `${entry} is allowlisted but absent from disk`).toBe(true);
      }
    }
  });
});
