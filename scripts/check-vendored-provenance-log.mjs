#!/usr/bin/env node
// BLO-35109. Replaces the stored 64-hex integrity manifest that used to live in
// vendor/paperclip-adapter-claude-k8s/PROVENANCE.md.
//
// That hash was single-valued by construction, so two concurrent PRs that each
// touched the vendored tree always produced two different values on one line and
// always conflicted -- and `merge=union` (BLO-34872) structurally cannot reach a
// single-valued field: a union would keep both hashes and CI's
// `grep -oE '^[0-9a-f]{64}$' | head -1` would then resolve the provenance verdict
// by sort order rather than by the tree.
//
// The hash never attested upstream-ness -- it was recomputed from our own tree,
// which has diverged. Its only real job was to force a PROVENANCE edit whenever
// vendored source changed. This checks that directly instead: a state invariant
// (a stored constant, which every PR must rewrite) becomes a transition
// invariant (a diff, which nothing stores and nothing can conflict on).
//
// It is also strictly less false-positive than the hash was. Two PRs editing
// different lines of the same vendored file merge correctly, and the combined
// tree's hash matched neither recorded value -- so the hash failed every
// combination, correct or not. It could not tell a bad merge from two good ones.
//
// Usage: node scripts/check-vendored-provenance-log.mjs --base <sha> [--head <sha>]
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const VENDOR_DIR = "vendor/paperclip-adapter-claude-k8s";
export const LOG = `${VENDOR_DIR}/PROVENANCE-CHANGES.md`;

// BLO-34872 round 2. `merge=union` on LOG fixes a *local* `git rebase` and does
// nothing on GitHub: GitHub's server-side merge ignores .gitattributes merge
// drivers, and it is what computes both `mergeable` and the merge-queue rebase.
// Measured 2026-09-30 against master `0bb33a1a7` -- #2070 and #1459 were both
// ejected from the queue with `merge_conflict` within 3 minutes of #1898
// landing, the conflict in LOG and nothing else, while `git merge-tree` with
// the repo's own attributes resolved both cleanly. The attribute was worse than
// inert: it drew rows into the one file that conflicts.
//
// So the unit of record is now one file per change. Two distinct new files
// never conflict under any merge implementation, GitHub's included -- no driver
// required. LOG is frozen, not migrated: rewriting it would itself conflict
// with every in-flight PR that has already appended to it.
export const LOG_DIR = `${VENDOR_DIR}/PROVENANCE-CHANGES.d`;

// Blockcast additions, not vendored source. Changing one of these alone is not a
// vendored change and needs no log row.
//
// The log file is deliberately NOT listed, and that is not an oversight: a
// change touching only the log is already satisfied by the row it appends, so
// an entry for it has no failing mutation -- i.e. it would be a comment wearing
// a guard's clothes. Measured: removing it leaves the suite green.
export const NOT_SOURCE = [`${VENDOR_DIR}/LICENSE`, `${VENDOR_DIR}/PROVENANCE.md`];

/** An entry file under LOG_DIR. README.md documents the directory, it is not an entry. */
export function isEntryPath(path) {
  return path.startsWith(`${LOG_DIR}/`) && path.endsWith(".md") && !path.endsWith("/README.md");
}

/**
 * @returns {{ok: true, warning?: string} | {ok: false, reason: string, detail: string[]}}
 */
export function checkVendoredProvenanceLog({ base, head = "HEAD", cwd }) {
  // core.quotePath defaults on, so an entry with any non-ASCII character comes
  // back as `"vendor/.../caf\303\251.md"` -- surrounding quotes and all. That
  // fails isEntryPath AND the startsWith filter below, so the entry is counted
  // as unrecorded vendored source and named in `detail` as the offending file.
  // README.md promises "Any `.md` filename works"; this makes that true.
  // ponytail: two residual filename edges, both untested and so left documented
  // rather than half-fixed -- a path containing a literal newline or quote is
  // still quoted (`-z` would cover it, at the cost of changing every split
  // below), and a name containing pathspec glob characters would be matched as
  // a pattern by the per-entry diff further down (`--literal-pathspecs`).
  const git = (...args) =>
    execFileSync("git", ["-c", "core.quotePath=false", ...args], { encoding: "utf8", cwd });
  // Three-dot: diff against the merge base, so base-branch commits landed since
  // the branch point do not masquerade as changes made by this PR.
  const range = `${base}...${head}`;
  // A symlink's blob is its target path, which is never blank, so neither the
  // blank-content test nor the added-line scan below can tell a link from a
  // record: only the mode can. Both entry checks call this one predicate so
  // the changed-entry and added-entry paths cannot drift apart again.
  const isRegularFileAtHead = (p) => git("ls-tree", head, "--", p).split(/\s/)[0].startsWith("100");

  const numstat = git("diff", "--numstat", range, "--", LOG).trim();
  const [added, deleted] = numstat
    ? numstat.split("\t").slice(0, 2).map(Number)
    : [0, 0];

  // `git diff --numstat` emits `-\t-` for a blob it treats as binary, so both
  // counts parse to NaN and every comparison below is false: the guard would
  // pass on exactly the input it exists to reject -- including a destructively
  // rewritten log, which is the case the append-only rule is here for. Reject
  // non-finite rather than comparing against it.
  if (!Number.isFinite(added) || !Number.isFinite(deleted)) {
    return {
      ok: false,
      reason: `${LOG} is not a text file; provenance cannot be verified.`,
      detail: [
        "git reports it as binary, so added/removed rows cannot be counted and",
        "the append-only rule cannot be enforced. Check for a stray NUL byte or",
        "a non-UTF-8 encoding, and restore the file as UTF-8 text.",
      ],
    };
  }

  // Unconditional, because append-only is what makes `merge=union` on this file
  // safe at all: a union resolves by keeping both sides' added lines and cannot
  // reconcile an edit, so a rewritten row would be silently duplicated on the
  // next concurrent append. In a diff, an edit or a reorder is a deletion.
  if (deleted > 0) {
    return {
      ok: false,
      reason: `${LOG} is append-only, but this change removes ${deleted} line(s) from it.`,
      detail: [
        "Append new rows at the end; never edit or reorder existing ones.",
        "To correct an earlier row, append a row that supersedes it.",
      ],
    };
  }

  // The same rule for the directory, and it has to be here -- above the
  // `changed.length === 0` return below -- because entry paths are filtered out
  // of `changed`. Without this, a change that only deletes entries reaches that
  // return as ok: erasing the record was the one mutation nothing caught, which
  // is precisely the drift the reason string below exists to prevent.
  //
  // --no-renames, or the guard has a trivial bypass. Measured on git 2.47:
  // deleting an entry while adding a similar one pairs them as R087, and plain
  // --diff-filter=D then reports *nothing* -- the deletion hides behind the add.
  const deletedEntries = git(
    "diff", "--name-only", "--diff-filter=D", "--no-renames", range, "--", LOG_DIR,
  )
    .split("\n")
    .filter(isEntryPath);

  if (deletedEntries.length > 0) {
    return {
      ok: false,
      reason: `${LOG_DIR}/ is append-only, but this change removes ${deletedEntries.length} entry file(s).`,
      detail: [
        "Each entry records why the vendored tree changed in some earlier PR;",
        "removing one erases that record. To correct an entry, add a new one",
        "that supersedes it -- never delete or rename the old one. Removed:",
        ...deletedEntries.map((p) => `  ${p}`),
      ],
    };
  }

  // Deletion is not the only way to erase an entry: emptying one in place is an
  // `M`, and swapping it for a symlink is a `T`, so the D filter above passes
  // both. Reject erasure, not editing. LOG's `deleted > 0` does not transfer: it
  // exists for the union driver, distinct files never conflict, and a typo fix
  // in an earlier entry removes a line and must keep passing. So the rule is
  // that a changed entry is still a regular file that records something.
  const erasedEntries = git(
    "diff", "--name-only", "--diff-filter=MT", "--no-renames", range, "--", LOG_DIR,
  )
    .split("\n")
    .filter(isEntryPath)
    .filter((p) => !isRegularFileAtHead(p) || git("cat-file", "blob", `${head}:${p}`).trim() === "");

  if (erasedEntries.length > 0) {
    return {
      ok: false,
      reason: `${LOG_DIR}/ is append-only, but this change empties ${erasedEntries.length} existing entry file(s).`,
      detail: [
        "An existing entry may be edited (a typo fix), not erased: it must stay a",
        "regular file with content. To retract one, add a new entry that",
        "supersedes it. Emptied or replaced:",
        ...erasedEntries.map((p) => `  ${p}`),
      ],
    };
  }

  const changed = git("diff", "--name-only", range, "--", VENDOR_DIR)
    .split("\n")
    .filter(Boolean)
    .filter((p) => !NOT_SOURCE.includes(p) && !p.startsWith(`${LOG_DIR}/`));

  if (changed.length === 0) return { ok: true };

  // The current unit of record: a file this change ADDS under LOG_DIR. Added,
  // not modified, because that is the property that makes it conflict-free --
  // two PRs adding distinct paths merge cleanly everywhere, two PRs editing one
  // path do not. It also keeps README.md and any earlier entry from satisfying
  // the guard for a later change.
  // --no-renames for the same reason as the deletion check: without it a new
  // entry that git pairs with some other removed file is reported as a rename,
  // --diff-filter=A returns empty, and the guard rejects a change that *did*
  // record itself -- naming only the source file, never the entry sitting in
  // the diff. A rename is not an edit of the new path, so suppressing pairing
  // is what makes the filter mean what this comment says it means.
  const addedEntries = git(
    "diff", "--name-only", "--diff-filter=A", "--no-renames", range, "--", LOG_DIR,
  )
    .split("\n")
    .filter(isEntryPath);

  // Mirror the row rule below onto entries: a path is not a record. An empty or
  // whitespace-only entry satisfies `addedEntries` while recording nothing --
  // the same "add nothing" satisfier the row filter already rejects.
  //
  // `+++` must be excluded explicitly. The row filter gets this free because
  // the character after a header's leading `+` is neither space nor `|`, but a
  // bare `\S` test matches `+++ b/path` itself: measured, a whitespace-only
  // entry scores 1 without this and passes.
  //
  // And the mode, as for a changed entry: an added symlink's one added line is
  // its target, `+blo-1.md`, so the scan alone scores it 1 and passes.
  const substantiveEntries = addedEntries.filter((p) =>
    isRegularFileAtHead(p) &&
    git("diff", "--unified=0", range, "--", p)
      .split("\n")
      .some((line) => line.startsWith("+") && !line.startsWith("+++") && line.slice(1).trim() !== ""),
  );

  // Count added *rows*, not added lines: a bare `added > 0` is satisfied by a
  // blank line, so the cheapest way to silence the guard would be to add
  // nothing. Row quality is still left to human review -- this only rules out
  // the whitespace-only satisfier. The `+++ b/path` diff header cannot match,
  // since the character after its leading `+` is neither space nor `|`.
  const addedRows = git("diff", "--unified=0", range, "--", LOG)
    .split("\n")
    .filter((line) => /^\+\s*\|/.test(line));

  if (substantiveEntries.length < 1 && addedRows.length < 1) {
    // Distinguish "you added nothing" from "you added an empty file": the
    // second is the misleading case, where the entry the guard is asking for
    // is sitting right there in the diff.
    const emptyOnly = addedEntries.length > 0;
    return {
      ok: false,
      reason: emptyOnly
        ? `${LOG_DIR}/ gained an entry, but it records nothing.`
        : `Vendored source changed but ${LOG_DIR}/ gained no entry.`,
      detail: emptyOnly
        ? [
            "An entry file is the record; its path alone is not. Describe what",
            "changed in the vendored tree and why. Empty entries added:",
            ...addedEntries.map((p) => `  ${p}`),
          ]
        : [
            `Add one file, '${LOG_DIR}/<issue-or-pr>.md', describing the change, so`,
            "the recorded provenance does not silently drift from what is actually",
            `in the tree. See ${LOG_DIR}/README.md. Changed files:`,
            ...changed.map((p) => `  ${p}`),
          ],
    };
  }

  // A legacy row still satisfies the guard so that PRs already in the queue do
  // not all have to be rewritten -- but say so, because appending there is what
  // reproduces the conflict this directory exists to remove.
  //
  // Not when the log is the only thing that changed: there is no vendored
  // source being recorded, so there is nothing to redirect.
  const logOnly = changed.length === 1 && changed[0] === LOG;
  if (substantiveEntries.length < 1 && !logOnly) {
    return {
      ok: true,
      warning: `${LOG} is frozen: this change appends a row to it instead of adding ${LOG_DIR}/<issue-or-pr>.md. Accepted, but concurrent appends to that one file conflict on GitHub and get ejected from the merge queue.`,
    };
  }

  return { ok: true };
}

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
};

export function isMainModule(argvPath = process.argv[1], moduleUrl = import.meta.url) {
  return Boolean(argvPath) && resolve(argvPath) === fileURLToPath(moduleUrl);
}

if (isMainModule()) {
  const base = arg("--base");
  if (!base) {
    console.error("usage: --base <sha> [--head <sha>]");
    process.exit(2);
  }
  const result = checkVendoredProvenanceLog({ base, head: arg("--head") ?? "HEAD" });
  if (!result.ok) {
    console.error(`::error::${result.reason}`);
    for (const line of result.detail) console.error(line);
    process.exit(1);
  }
  if (result.warning) console.log(`::warning::${result.warning}`);
  // Name the surface that actually satisfied the guard. On the legacy path
  // `${LOG_DIR}: ok` names the one surface that did *not* gain an entry.
  console.log(result.warning ? `${LOG}: ok (legacy row)` : `${LOG_DIR}: ok`);
}
