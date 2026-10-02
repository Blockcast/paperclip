#!/usr/bin/env node
/**
 * check-migration-journal-base.mjs
 *
 * The ONE migration check that cannot be made from a single tree: does this
 * branch reuse a migration number that landed on the base after the branch
 * was cut?
 *
 * `packages/db/src/check-migration-numbering.ts` (BLO-27927, #1402) already
 * covers everything visible in one tree, and this guard deliberately does NOT
 * duplicate any of it:
 *
 *   - duplicate journal numbers          -> `ensureNoDuplicates`
 *   - duplicate .sql file numbers        -> `ensureNoDuplicateFileNumbers`
 *   - journal entry with no .sql         -> `ensureJournalMatchesFiles`
 *   - .sql with no journal entry         -> `ensureFilesAreJournaled`
 *
 * BLO-39490 is the gap those leave: three open PRs each appended `idx: 248`
 * and all three were green, because EACH TREE IS INDIVIDUALLY CONSISTENT.
 * `check:migrations` cannot see a collision that does not exist yet. It
 * materialises only when the second branch meets the first, and then it
 * arrives as a git conflict at the merge-queue front -- which ejects the PR
 * and costs it its whole queue position (BLO-26675, ~60h at the measured
 * drain) -- rather than as a check failure the author can act on.
 *
 * So this compares against PR_BASE_SHA, which is the only thing the existing
 * checker structurally cannot do. Two arms, both base-relative:
 *
 *   1. a journal entry whose `idx` or `tag` is already taken on the base
 *   2. a .sql whose 4-digit number is already taken by a DIFFERENT file on
 *      the base -- this is the one that predicts the merge conflict, since
 *      the post-merge tree is what trips `ensureNoDuplicateFileNumbers`
 *
 * KNOWN CEILING: base, not siblings. Three PRs can still each pick the same
 * free number and all pass. The moment one lands the others fail -- `pr.yml`
 * runs on `merge_group` too, so the second is rejected at the queue front
 * with a message naming the next free number, instead of ejecting on a
 * conflict. Catching concurrent claimants would mean querying every open PR
 * from inside a required check; this is deterministic and free.
 */

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const MIGRATIONS_DIR = "packages/db/src/migrations";
export const JOURNAL_PATH = `${MIGRATIONS_DIR}/meta/_journal.json`;

const numberOf = (name) => name.match(/^(\d{4})_/)?.[1] ?? null;

/**
 * @param {object} args
 * @param {{entries?: Array<{idx: number, tag: string}>}} args.journal head journal
 * @param {{entries?: Array<{idx: number, tag: string}>}} args.baseJournal base journal
 * @param {string[]} args.sqlFiles head `.sql` file names, with suffix
 * @param {string[]} args.baseSqlFiles base `.sql` file names, with suffix
 * @param {string} [args.baseLabel]
 * @returns {string[]} one message per problem; empty means no base collision
 */
export function checkAgainstBase({
  journal,
  baseJournal,
  sqlFiles,
  baseSqlFiles,
  baseLabel = "the base branch",
}) {
  const entries = journal?.entries;
  const baseEntries = baseJournal?.entries;
  // Fail closed. A journal this guard cannot read would satisfy both arms
  // vacuously, which is the silent pass this check exists to prevent.
  if (!Array.isArray(entries) || entries.length === 0) {
    return [`${JOURNAL_PATH}: no readable \`entries\`. Refusing to pass a journal this guard cannot read.`];
  }
  if (!Array.isArray(baseEntries) || baseEntries.length === 0) {
    return [`${JOURNAL_PATH} at ${baseLabel}: no readable \`entries\`. Refusing to pass a base this guard cannot read.`];
  }

  const problems = [];
  const baseTagByIdx = new Map(baseEntries.map((e) => [e.idx, e.tag]));
  const baseIdxByTag = new Map(baseEntries.map((e) => [e.tag, e.idx]));

  // The next number free on BOTH sides, so the suggestion survives the merge.
  const nextFreeIdx =
    Math.max(...baseEntries.map((e) => e.idx), ...entries.map((e) => e.idx), -1) + 1;

  // --- arm 1: journal idx / tag already taken on the base -----------------
  for (const entry of entries) {
    if (!Number.isInteger(entry?.idx) || typeof entry?.tag !== "string") {
      problems.push(`${JOURNAL_PATH}: malformed entry ${JSON.stringify(entry)} (needs integer \`idx\` and string \`tag\`).`);
      continue;
    }
    // Carried over from the base unchanged: not a collision.
    if (baseTagByIdx.get(entry.idx) === entry.tag) continue;
    if (baseTagByIdx.has(entry.idx)) {
      problems.push(`${JOURNAL_PATH}: adds idx ${entry.idx} ("${entry.tag}"), but ${baseLabel} already has idx ${entry.idx} ("${baseTagByIdx.get(entry.idx)}"). Renumber this migration -- journal entry AND .sql file -- to ${nextFreeIdx}.`);
    } else if (baseIdxByTag.has(entry.tag)) {
      problems.push(`${JOURNAL_PATH}: adds tag "${entry.tag}" at idx ${entry.idx}, but ${baseLabel} already has that tag at idx ${baseIdxByTag.get(entry.tag)}.`);
    }
  }

  // --- arm 2: .sql number already taken by a different file on the base ---
  // This is what the post-merge tree trips on, so catching it here is what
  // turns a merge-queue ejection into an actionable red on the PR.
  const baseByNumber = new Map();
  for (const file of baseSqlFiles) {
    const number = numberOf(file);
    if (number) baseByNumber.set(number, [...(baseByNumber.get(number) ?? []), file]);
  }
  const baseFiles = new Set(baseSqlFiles);
  const nextFreeFileNumber = String(nextFreeIdx).padStart(4, "0");

  for (const file of [...sqlFiles].sort()) {
    if (baseFiles.has(file)) continue; // unchanged file, already on the base
    const number = numberOf(file);
    if (!number) {
      problems.push(`${MIGRATIONS_DIR}/${file} does not start with a 4-digit migration number.`);
      continue;
    }
    const taken = baseByNumber.get(number);
    if (taken) {
      problems.push(`${MIGRATIONS_DIR}/${file} takes number ${number}, but ${baseLabel} already has ${taken.join(", ")} at that number. Renumber to ${nextFreeFileNumber}.`);
    }
  }

  return problems;
}

export function readSqlFiles(repoRoot) {
  return readdirSync(join(repoRoot, MIGRATIONS_DIR)).filter((n) => n.endsWith(".sql"));
}

/** Read a path at a git ref. Throws rather than letting an arm degrade to "clean". */
export function readAtRef({ repoRoot, ref, path, exec = execFileSync }) {
  try {
    return exec("git", ["show", `${ref}:${path}`], {
      encoding: "utf8",
      cwd: repoRoot,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    throw new Error(`cannot read ${path} at ${ref}: ${err.message}. This guard's only arm compares against the base, so a missing base is a failure, not a skip -- pr.yml uses fetch-depth: 0.`);
  }
}

export function readBaseSqlFiles({ repoRoot, ref, exec = execFileSync }) {
  return exec("git", ["ls-tree", "--name-only", `${ref}:${MIGRATIONS_DIR}`], {
    encoding: "utf8",
    cwd: repoRoot,
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\n")
    .filter((n) => n.endsWith(".sql"));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const baseRef = process.argv[2] || process.env.PR_BASE_SHA || "";
  if (!baseRef) {
    // Local runs have no base. Say so loudly: this guard has no single-tree
    // arm, so "no base" means it checked nothing at all.
    console.log("  –  No base ref (PR_BASE_SHA unset); this guard compares against the base only, so nothing was checked.");
    process.exit(0);
  }

  const problems = checkAgainstBase({
    journal: JSON.parse(readFileSync(join(repoRoot, JOURNAL_PATH), "utf8")),
    baseJournal: JSON.parse(readAtRef({ repoRoot, ref: baseRef, path: JOURNAL_PATH })),
    sqlFiles: readSqlFiles(repoRoot),
    baseSqlFiles: readBaseSqlFiles({ repoRoot, ref: baseRef }),
    baseLabel: `the base branch (${baseRef.slice(0, 9)})`,
  });

  if (problems.length > 0) {
    console.error("ERROR: this branch reuses a migration number that is already taken on the base (BLO-39490)\n");
    for (const problem of problems) console.error(`  ${problem}`);
    process.exit(1);
  }
  console.log(`  ✓  No migration-number collision with ${baseRef.slice(0, 9)}.`);
}
