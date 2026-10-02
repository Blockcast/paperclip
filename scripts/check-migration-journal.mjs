#!/usr/bin/env node
/**
 * check-migration-journal.mjs
 *
 * PR-time guard for drizzle's migration journal
 * (`packages/db/src/migrations/meta/_journal.json`).
 *
 * BLO-39490: three open PRs each appended an entry claiming `idx: 248` with a
 * byte-identical hand-copied `when`, and all three were green. Every required
 * check passed because each PR is individually consistent -- the defect only
 * exists in the combination, which no single-PR check was looking at. The
 * existing `check-pending-migration-preflight` is a DEPLOY-time phase gate
 * (BLO-30895) and runs far too late to stop any of this.
 *
 * Two distinct failures, hence two arms:
 *
 *   1. COLLISION. A PR that reuses an `idx` or `tag` already on the base
 *      branch. Caught against `PR_BASE_SHA`, because a branch cut before the
 *      colliding entry landed looks perfectly fine on its own.
 *
 *   2. CORRESPONDENCE. Drizzle applies migrations BY JOURNAL ENTRY, loading
 *      `<tag>.sql` for each one. A `.sql` file nothing references is skipped
 *      in silence, forever. This is exactly what the obvious resolution of a
 *      journal conflict produces: because the colliding entries differ only
 *      in `tag`, the conflict hunk is a single line, and picking one side
 *      leaves one journal entry and two `.sql` files. The dropped migration's
 *      column is simply absent in production and nothing says so.
 *
 * Both arms are offline and read only the working tree (plus one `git show`
 * for the base journal), so this is cheap enough to sit in the `policy` job
 * alongside the other `scripts/check-*` guards.
 *
 * KNOWN CEILING: this compares a PR against its BASE, not against sibling open
 * PRs. Three PRs can still each pick the same free idx and all go green -- that
 * is the measured BLO-39490 state and it stays reachable. What changes is that
 * the moment one of them lands, the others fail: `pr.yml` also runs on
 * `merge_group`, so the second one is rejected at the queue front instead of
 * landing a conflict or a dropped migration. Catching it earlier would mean
 * querying every open PR's journal from CI, which is a network dependency in a
 * required check; the merge_group arm is deterministic and free.
 */

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const MIGRATIONS_DIR = "packages/db/src/migrations";
export const JOURNAL_PATH = `${MIGRATIONS_DIR}/meta/_journal.json`;

/**
 * `.sql` files that exist on master with NO journal entry, and therefore have
 * never been applied by drizzle and never will be. These nine pre-date this
 * guard -- they are the accumulated casualties of the very bug it exists to
 * stop, found while writing it (BLO-39490). Their DDL is nonetheless live in
 * the production schema (`milestones`, `issues.last_evidence_verdict_evaluated_at`
 * and friends all exist), so re-journalling them would re-run DDL that is
 * already applied, which is why they are baselined here rather than fixed in
 * passing. Disposition is tracked separately; this list only holds the count
 * at nine.
 *
 * This is a RATCHET, not an allowlist to grow. Adding an entry means you are
 * shipping a migration that will never run -- do not do it. The guard also
 * fails if an entry here stops being orphaned, so the list cannot rot.
 */
export const KNOWN_UNJOURNALED = Object.freeze([
  "0046_smooth_sentinels",
  "0102_server_side_sweep_preflight",
  "0103_activity_log_issue_lookup_indexes",
  "0104_heartbeat_run_issue_scope_indexes",
  "0105_plugin_event_outbox",
  "0106_issue_pull_requests",
  "0114_issue_evidence_verdict_evaluated_at",
  "0115_milestones",
  "0116_evidence_verdict_idx_partial",
]);

/**
 * @param {object} args
 * @param {{entries?: Array<{idx: number, tag: string}>}} args.journal parsed head journal
 * @param {string[]} args.sqlTags basenames (no `.sql`) of every migration file
 * @param {{entries?: Array<{idx: number, tag: string}>}|null} [args.baseJournal]
 *        parsed base-branch journal, or null to skip the collision arm
 * @param {readonly string[]} [args.knownUnjournaled]
 * @param {string} [args.baseLabel] what to call the base in messages
 * @returns {string[]} one message per problem; empty means clean
 */
export function checkJournal({
  journal,
  sqlTags,
  baseJournal = null,
  knownUnjournaled = KNOWN_UNJOURNALED,
  baseLabel = "the base branch",
}) {
  const entries = journal?.entries;
  // A journal this guard cannot read must fail, not read as clean: an empty
  // or malformed `entries` would otherwise satisfy every arm below vacuously.
  if (!Array.isArray(entries) || entries.length === 0) {
    return [`${JOURNAL_PATH}: no readable \`entries\` array. Refusing to pass a journal this guard cannot read.`];
  }

  const problems = [];

  // --- arm 1a: the journal must not collide with ITSELF -------------------
  // This is the "keep both sides" resolution of a journal conflict.
  const tagsByIdx = new Map();
  const idxsByTag = new Map();
  for (const entry of entries) {
    if (!Number.isInteger(entry?.idx) || typeof entry?.tag !== "string") {
      problems.push(`${JOURNAL_PATH}: malformed entry ${JSON.stringify(entry)} (needs integer \`idx\` and string \`tag\`).`);
      continue;
    }
    if (!tagsByIdx.has(entry.idx)) tagsByIdx.set(entry.idx, []);
    tagsByIdx.get(entry.idx).push(entry.tag);
    if (!idxsByTag.has(entry.tag)) idxsByTag.set(entry.tag, []);
    idxsByTag.get(entry.tag).push(entry.idx);
  }
  for (const [idx, tags] of tagsByIdx) {
    if (tags.length > 1) {
      problems.push(`${JOURNAL_PATH}: idx ${idx} is claimed by ${tags.length} entries (${tags.map((t) => `"${t}"`).join(", ")}). Each migration needs its own idx.`);
    }
  }
  for (const [tag, idxs] of idxsByTag) {
    if (idxs.length > 1) {
      problems.push(`${JOURNAL_PATH}: tag "${tag}" appears ${idxs.length} times (idx ${idxs.join(", ")}).`);
    }
  }

  // --- arm 1b: the journal must not collide with the BASE ------------------
  if (baseJournal) {
    const baseEntries = Array.isArray(baseJournal.entries) ? baseJournal.entries : [];
    const baseTagByIdx = new Map(baseEntries.map((e) => [e.idx, e.tag]));
    const baseIdxByTag = new Map(baseEntries.map((e) => [e.tag, e.idx]));
    const nextFree =
      Math.max(
        ...baseEntries.map((e) => e.idx),
        ...entries.map((e) => e.idx),
        -1,
      ) + 1;

    for (const entry of entries) {
      // An entry carried over from the base unchanged is not a collision.
      if (baseTagByIdx.get(entry.idx) === entry.tag) continue;
      if (baseTagByIdx.has(entry.idx)) {
        problems.push(`${JOURNAL_PATH}: adds idx ${entry.idx} ("${entry.tag}"), but ${baseLabel} already has idx ${entry.idx} ("${baseTagByIdx.get(entry.idx)}"). Renumber this migration -- and its .sql file -- to ${nextFree}.`);
      } else if (baseIdxByTag.has(entry.tag)) {
        problems.push(`${JOURNAL_PATH}: adds tag "${entry.tag}" at idx ${entry.idx}, but ${baseLabel} already has that tag at idx ${baseIdxByTag.get(entry.tag)}.`);
      }
    }
  }

  // --- arm 2: journal <-> .sql must correspond 1:1 -------------------------
  const journalled = new Set(entries.map((e) => e.tag));
  const onDisk = new Set(sqlTags);
  const baselined = new Set(knownUnjournaled);

  for (const entry of entries) {
    if (typeof entry?.tag === "string" && !onDisk.has(entry.tag)) {
      problems.push(`${JOURNAL_PATH}: entry idx ${entry.idx} references "${entry.tag}" but ${MIGRATIONS_DIR}/${entry.tag}.sql does not exist.`);
    }
  }
  for (const tag of [...onDisk].sort()) {
    if (journalled.has(tag) || baselined.has(tag)) continue;
    problems.push(`${MIGRATIONS_DIR}/${tag}.sql has no journal entry. Drizzle applies migrations from the journal, so this file would never run. (A journal conflict resolved by picking one side produces exactly this.)`);
  }
  // Keep the baseline honest in both directions, so it cannot quietly rot.
  for (const tag of knownUnjournaled) {
    if (!onDisk.has(tag)) {
      problems.push(`KNOWN_UNJOURNALED lists "${tag}" but ${MIGRATIONS_DIR}/${tag}.sql no longer exists. Drop it from the list in ${import.meta.url.split("/").pop()}.`);
    } else if (journalled.has(tag)) {
      problems.push(`KNOWN_UNJOURNALED lists "${tag}" but it now HAS a journal entry. Drop it from the list -- the baseline only covers files nothing references.`);
    }
  }

  return problems;
}

/** Basenames of every `.sql` directly under the migrations directory. */
export function readSqlTags(repoRoot) {
  return readdirSync(join(repoRoot, MIGRATIONS_DIR))
    .filter((name) => name.endsWith(".sql"))
    .map((name) => name.slice(0, -".sql".length));
}

/**
 * The base journal, or null when there is no base to compare against.
 * Throws when a base ref WAS supplied but is unreadable -- a silently skipped
 * collision arm is the failure this guard exists to prevent.
 */
export function readBaseJournal({ repoRoot, baseRef, exec = execFileSync }) {
  if (!baseRef) return null;
  let raw;
  try {
    raw = exec("git", ["show", `${baseRef}:${JOURNAL_PATH}`], {
      encoding: "utf8",
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    throw new Error(`cannot read ${JOURNAL_PATH} at base ref ${baseRef}: ${err.message}. The collision arm cannot run; fix the checkout (pr.yml uses fetch-depth: 0) rather than skipping it.`);
  }
  return JSON.parse(raw);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const baseRef = process.argv[2] ?? process.env.PR_BASE_SHA ?? "";
  const problems = checkJournal({
    journal: JSON.parse(readFileSync(join(repoRoot, JOURNAL_PATH), "utf8")),
    sqlTags: readSqlTags(repoRoot),
    baseJournal: readBaseJournal({ repoRoot, baseRef }),
    baseLabel: baseRef ? `the base branch (${baseRef.slice(0, 9)})` : "the base branch",
  });

  if (problems.length > 0) {
    console.error(`ERROR: migration journal is inconsistent (BLO-39490)\n`);
    for (const problem of problems) console.error(`  ${problem}`);
    process.exit(1);
  }
  console.log(
    baseRef
      ? `  ✓  Migration journal is consistent and does not collide with ${baseRef.slice(0, 9)}.`
      : `  ✓  Migration journal is self-consistent (no base ref given, collision arm skipped).`,
  );
}
