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
 * @param {{entries?: Array<{idx: number, tag: string}>}} [args.mergeBaseJournal] journal at
 *   `git merge-base base head`. Omit to keep the strict pre-BLO-48352 behaviour, in which
 *   every base claimant counts -- that is the fail-closed direction, so a merge base this
 *   guard could not read costs a false red, never a false green.
 * @param {string[]} [args.mergeBaseSqlFiles] `.sql` file names at that same merge base
 * @param {string} [args.baseLabel]
 * @returns {string[]} one message per problem; empty means no base collision
 */
export function checkAgainstBase({
  journal,
  baseJournal,
  sqlFiles,
  baseSqlFiles,
  mergeBaseJournal,
  mergeBaseSqlFiles,
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
  const headFiles = new Set(sqlFiles);
  const baseTagByIdx = new Map(baseEntries.map((e) => [e.idx, e.tag]));
  const baseIdxByTag = new Map(baseEntries.map((e) => [e.tag, e.idx]));

  // --- rename-in-place is not a collision (BLO-48352) ----------------------
  // Both arms exist to predict a DUPLICATE in the post-merge tree. A branch
  // that REPLACES the base's migration at a number -- deletes its .sql and
  // retags its journal entry -- leaves exactly one claimant there, so there is
  // nothing for `ensureNoDuplicateFileNumbers` or the merge queue to trip on.
  //
  // "absent from the head" is NOT the test, and getting this wrong re-opens
  // the incident this guard was built for. In BLO-39490 PR_1741 branched
  // BEFORE PR_1864 landed, so PR_1864's claimant is absent from its head too --
  // byte-identical to a rename, and a real collision. The discriminator is the
  // MERGE BASE: a claimant the branch point already carried, and which the head
  // no longer has, was deliberately retired by this branch. One the merge base
  // never had was acquired by the base afterwards, and the head has simply not
  // seen it yet.
  //
  // It is also why this is keyed on the merge base rather than on the checked-
  // out tree being the merge commit. `pr.yml` does check out `refs/pull/N/merge`
  // today, but that ref goes stale the moment a PR stops being mergeable --
  // which is exactly when a second claimant appears -- so a rule resting on it
  // would fail in the one case it has to catch.
  //
  // No merge base supplied => every base claimant is genuine, i.e. the strict
  // pre-BLO-48352 behaviour. That is the fail-closed direction.
  const headTags = new Set(entries.map((e) => e?.tag).filter((t) => typeof t === "string"));
  const mergeBaseTags = Array.isArray(mergeBaseJournal?.entries)
    ? new Set(mergeBaseJournal.entries.map((e) => e?.tag).filter((t) => typeof t === "string"))
    : null;
  const mergeBaseFiles = Array.isArray(mergeBaseSqlFiles) ? new Set(mergeBaseSqlFiles) : null;

  /** @param {string} tag */
  const tagStillClaims = (tag) => headTags.has(tag) || mergeBaseTags === null || !mergeBaseTags.has(tag);
  /** @param {string} file */
  const fileStillClaims = (file) => headFiles.has(file) || mergeBaseFiles === null || !mergeBaseFiles.has(file);

  // The next number free on BOTH sides, so the suggestion survives the merge.
  // Non-integer `idx` is dropped BEFORE the max: this runs ahead of the
  // per-entry shape check below, so one entry that lost its `idx` in a
  // hand-merge would otherwise make this NaN and strip the renumber-to-N
  // suggestion out of every OTHER entry's message -- which is the one thing
  // this guard exists to deliver over a merge-queue conflict.
  const nextFreeIdx =
    Math.max(
      ...baseEntries.map((e) => e?.idx).filter(Number.isInteger),
      ...entries.map((e) => e?.idx).filter(Number.isInteger),
      -1,
    ) + 1;

  // --- arm 1: journal idx / tag already taken on the base -----------------
  for (const entry of entries) {
    if (!Number.isInteger(entry?.idx) || typeof entry?.tag !== "string") {
      problems.push(`${JOURNAL_PATH}: malformed entry ${JSON.stringify(entry)} (needs integer \`idx\` and string \`tag\`).`);
      continue;
    }
    // Carried over from the base unchanged: not a collision.
    if (baseTagByIdx.get(entry.idx) === entry.tag) continue;
    if (baseTagByIdx.has(entry.idx) && tagStillClaims(baseTagByIdx.get(entry.idx))) {
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
    const taken = (baseByNumber.get(number) ?? []).filter(fileStillClaims);
    if (taken.length > 0) {
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

/**
 * `git merge-base <baseRef> HEAD`, or null when it cannot be resolved.
 *
 * Unlike `readAtRef` this does NOT throw. A merge base is what lets the two
 * arms tell a rename-in-place from a second claimant; without one they fall
 * back to treating every base claimant as genuine, which is the strict,
 * fail-closed direction. So an unresolvable merge base costs a false red that
 * names the renumber, never a false green.
 */
export function readMergeBaseRef({ repoRoot, ref, head = "HEAD", exec = execFileSync }) {
  try {
    return exec("git", ["merge-base", ref, head], {
      encoding: "utf8",
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim() || null;
  } catch {
    return null;
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
    // This guard has no single-tree arm, so "no base" means it checked nothing
    // at all. Locally that is a convenience; in CI it is a required check
    // passing green having done nothing, while every sibling check still runs
    // -- exactly the silent no-op the header warns about. `pr.yml` populates
    // PR_BASE_SHA for both of its triggers today, so this is unreachable; the
    // throw is what keeps it unreachable when a third trigger is added.
    if (process.env.GITHUB_ACTIONS) {
      console.error("ERROR: no base ref (PR_BASE_SHA unset) in CI. This guard compares against the base only, so passing here would be a green check that verified nothing.");
      process.exit(1);
    }
    console.log("  –  No base ref (PR_BASE_SHA unset); this guard compares against the base only, so nothing was checked.");
    process.exit(0);
  }

  // A migration this branch RETIRED is only distinguishable from one the base
  // landed after the branch point by looking at the merge base (BLO-48352).
  // Degrades to the strict comparison rather than failing: see readMergeBaseRef.
  const mergeBaseRef = readMergeBaseRef({ repoRoot, ref: baseRef });
  let mergeBaseJournal;
  let mergeBaseSqlFiles;
  if (mergeBaseRef) {
    try {
      mergeBaseJournal = JSON.parse(readAtRef({ repoRoot, ref: mergeBaseRef, path: JOURNAL_PATH }));
      mergeBaseSqlFiles = readBaseSqlFiles({ repoRoot, ref: mergeBaseRef });
    } catch {
      mergeBaseJournal = undefined;
      mergeBaseSqlFiles = undefined;
    }
  }

  const problems = checkAgainstBase({
    journal: JSON.parse(readFileSync(join(repoRoot, JOURNAL_PATH), "utf8")),
    baseJournal: JSON.parse(readAtRef({ repoRoot, ref: baseRef, path: JOURNAL_PATH })),
    sqlFiles: readSqlFiles(repoRoot),
    baseSqlFiles: readBaseSqlFiles({ repoRoot, ref: baseRef }),
    mergeBaseJournal,
    mergeBaseSqlFiles,
    baseLabel: `the base branch (${baseRef.slice(0, 9)})`,
  });

  if (problems.length > 0) {
    console.error("ERROR: this branch reuses a migration number that is already taken on the base (BLO-39490)\n");
    for (const problem of problems) console.error(`  ${problem}`);
    process.exit(1);
  }
  console.log(`  ✓  No migration-number collision with ${baseRef.slice(0, 9)}.`);
}
