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
// LOG is deliberately NOT listed, and after BLO-41101 that is load-bearing
// rather than merely harmless: a change touching LOG is rejected outright
// before `changed` is ever computed, so listing it here would exempt the one
// file the frozen check exists to reject. The test pins the list exactly.
export const NOT_SOURCE = [`${VENDOR_DIR}/LICENSE`, `${VENDOR_DIR}/PROVENANCE.md`];

/** An entry file under LOG_DIR. README.md documents the directory, it is not an entry. */
export function isEntryPath(path) {
  return isEntryPathIn(LOG_DIR, path);
}

/** The same predicate, for an arbitrary tree's log directory. */
function isEntryPathIn(logDir, path) {
  return path.startsWith(`${logDir}/`) && path.endsWith(".md") && !path.endsWith("/README.md");
}

/**
 * PEN-3916. There are now TWO vendored adapter trees, and the property this
 * script enforces -- vendored source does not change without the change being
 * recorded -- has to hold for both. Previously the whole file was hard-coded to
 * the claude tree, so a change to the (then non-existent) opencode tree would
 * have been unrecorded and silently fine.
 *
 * The exports above still name the claude tree. That is deliberate rather than
 * leftover: `scripts/__tests__/provenance-union-merge.test.mjs` pins VENDOR_DIR,
 * LOG, LOG_DIR and NOT_SOURCE exactly, and those pins are about the claude tree
 * specifically (its frozen PROVENANCE-CHANGES.md, and the stale-exclusion check
 * that reads its working tree). Re-pointing them at a list would have deleted
 * that coverage to add this.
 *
 * `frozenLog` is null for the opencode tree and that is a real asymmetry, not an
 * omission: BLO-41101's frozen-file rule exists because the claude tree carries
 * a single-table predecessor that cannot be rewritten without conflicting with
 * every in-flight PR. The opencode tree started with the per-change directory,
 * so it has no such file and nothing to freeze.
 */
export const VENDOR_TREES = [
  {
    vendorDir: VENDOR_DIR,
    frozenLog: LOG,
    logDir: LOG_DIR,
    notSource: NOT_SOURCE,
  },
  {
    vendorDir: "vendor/paperclip-adapter-opencode-k8s",
    frozenLog: null,
    logDir: "vendor/paperclip-adapter-opencode-k8s/PROVENANCE-CHANGES.d",
    notSource: [
      "vendor/paperclip-adapter-opencode-k8s/LICENSE",
      "vendor/paperclip-adapter-opencode-k8s/PROVENANCE.md",
    ],
  },
];

/**
 * @returns {{ok: true} | {ok: false, reason: string, detail: string[]}}
 */
export function checkVendoredProvenanceLog({ base, head = "HEAD", cwd, tree = VENDOR_TREES[0] }) {
  // Shadow the module-level claude constants with this tree's. Every check
  // below is written against these names and is otherwise unchanged.
  const { vendorDir: VENDOR_DIR, frozenLog: LOG, logDir: LOG_DIR, notSource: NOT_SOURCE } = tree;
  const isEntryPath = (path) => isEntryPathIn(LOG_DIR, path);
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

  // BLO-41101. LOG is frozen, and this is the check that makes "frozen" mean
  // something. It replaces three narrower LOG rules -- an append-only rule, a
  // binary-blob rule, and a warn-but-pass legacy-row path -- all of which read
  // only the NET diff and so shared one blind spot.
  //
  // The merge queue is REBASE: it replays this branch's commits one at a time,
  // and GitHub's server-side replay ignores .gitattributes merge drivers. So a
  // commit that edits LOG conflicts against any row master gained since the
  // branch point, and the net diff cannot see that -- a later commit in the
  // same branch can move the row back out and leave the final tree identical.
  // Measured on #1797: the net diff for LOG was empty, the guard said ok,
  // `merge=union` made every local rebase return clean, and the queue ejected
  // it six times in 24 days with zero merge_group runs to point at. #1699 was
  // ejected three times on the same shape, and BLO-38488/BLO-38489 are the
  // hand-rebases that paid for it.
  //
  // Both halves of that collision are closed here by one rule. A branch may not
  // carry a LOG-touching commit, and -- because the legacy row path is the same
  // rule seen from the other side -- master stops gaining rows to collide with.
  // That path was already documented as known-broken ("accepted, but concurrent
  // appends to that one file conflict on GitHub and get ejected from the merge
  // queue"); it landed two more rows on 2026-10-01, which is what the in-flight
  // branches were being ejected against.
  //
  // `numstat !== ""` rather than parsed counts: it is total. A binary blob
  // emits `-\t-`, which parses to NaN and makes every numeric comparison false
  // -- the old fail-open this file carried an explicit Number.isFinite guard
  // for. Testing for the presence of a diff line cannot have that shape at all,
  // so do not reintroduce the counts.
  //
  // This is the MESSAGE discriminator only, deliberately not a second rejection
  // arm: a non-empty net diff for LOG implies some commit in `base..head`
  // changed LOG, so `logCommits` already covers every case it would catch.
  // Measured -- ORing it into the condition below has no failing mutation. It
  // is not a shallow-clone backstop either: on a shallow clone BOTH commands
  // exit non-zero and throw, which is the safe direction and not something a
  // second arm improves on.
  // PEN-3916: a tree with no frozen predecessor has nothing to freeze, so both
  // probes are skipped rather than run against a path that does not exist
  // (`git rev-list -- <missing>` would return empty and read as "clean", which
  // is the right answer by accident; this says so on purpose).
  const netTouchesLog = LOG ? git("diff", "--numstat", range, "--", LOG).trim() !== "" : false;

  // Two dots, not the three-dot `range`: `base..head` is exactly the set
  // `git rebase base` replays. For rev-list, three dots is a SYMMETRIC
  // DIFFERENCE -- measured, it pulls in master's own commits and blames this
  // branch for rows it did not write.
  //
  // --full-history because the default history simplification walks one parent
  // of a merge and can drop a LOG-touching commit on the other side entirely:
  // measured 0 commits without it against 1 with, on a branch that merged a
  // LOG change and then discarded it. --no-merges because a rebase replays
  // non-merge commits only, so naming a merge commit sends the author to a
  // commit that is not the problem: measured 2 listed without it against 1.
  const logCommits = LOG
    ? git("rev-list", "--no-merges", "--full-history", `${base}..${head}`, "--", LOG)
        .split("\n")
        .filter(Boolean)
    : [];

  if (logCommits.length > 0) {
    // Two different repairs, and conflating them is what sent three previous
    // authors to the wrong one. A wrong net diff needs the row relocated; a
    // clean net diff over a dirty history needs the history rewritten. A branch
    // that has both needs both, in that order.
    //
    // Pin to the blob at the MERGE BASE, never at `base`. Exercised verbatim on
    // #1797: pinning to master's tip left 1 offending commit of 6 and the
    // driver-disabled rebase still conflicted on LOG, because the first
    // rewritten commit's parent is the merge base -- so rewriting LOG to
    // master's blob is itself a modification. With the merge-base blob: 0
    // offending, all 10 commits kept, and LOG drops out of the conflict set
    // (3 conflicting paths before, 2 after, neither of them LOG).
    const historyRepair = [
      "Rewrite the branch so no commit touches it, keeping every commit:",
      `  MB=$(git merge-base ${base} HEAD)`,
      `  FILTER_BRANCH_SQUELCH_WARNING=1 git filter-branch -f --index-filter \\`,
      `    "git update-index --cacheinfo 100644,$(git rev-parse $MB:${LOG}),${LOG}" \\`,
      `    -- $MB..HEAD`,
      `Offending commit(s) in ${base}..${head}:`,
      ...logCommits.slice(0, 20).map((sha) => `  ${sha}`),
      ...(logCommits.length > 20 ? [`  ... and ${logCommits.length - 20} more`] : []),
    ];

    return {
      ok: false,
      reason: netTouchesLog
        ? `${LOG} is frozen, and this change modifies it.`
        : `${LOG} is frozen. Your net diff leaves it alone, but ${logCommits.length} commit(s) in this branch modify it.`,
      detail: netTouchesLog
        ? [
            `Record the change as a new file, '${LOG_DIR}/<issue-or-pr>.md', and drop`,
            `the ${LOG} edit. Two distinct new files never conflict; concurrent`,
            "appends to that one file do, under every merge implementation GitHub",
            `uses. See ${LOG_DIR}/README.md.`,
            "",
            "Dropping it from the working tree is not enough on its own -- the merge",
            "queue rebases, so it replays each commit separately.",
            ...historyRepair,
          ]
        : [
            "Your tree is already correct; your history is not. The merge queue is",
            "REBASE, so it replays each commit onto master in turn, and GitHub's",
            "replay ignores the `merge=union` attribute that makes your local rebase",
            "resolve. The result is an eviction with no failing check and no",
            "merge_group run -- which is why this is caught here instead.",
            ...historyRepair,
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

  // Moving vendored source into LOG_DIR/ deletes it from the tree. The
  // --no-renames below makes `changed` name the source again, which is what
  // rejects a destination like `moved.txt` -- but a destination that is a valid
  // entry path then satisfies `substantiveEntries` using the moved source code
  // as its own body, and the guard passes on a file that has left the tree. So
  // --no-renames is necessary and not sufficient; this is the other half.
  //
  // Rename detection is deliberately ON here, uniquely in this file: everywhere
  // else the pairing hides the mutation, and here the pairing IS the signal.
  const relocatedIntoLog = git("diff", "--name-status", "-M", range, "--", VENDOR_DIR)
    .split("\n")
    .map((line) => line.split("\t"))
    // A draft promoted inside the directory (`notes.txt` -> `blo-2.md`) is the
    // blessed move-in, not laundering. Only a source that was never under
    // LOG_DIR/ is leaving the vendored tree, so the `from` test is load-bearing
    // rather than defensive -- without it this rejects that blessed case.
    .filter(([status, from, to]) =>
      status?.startsWith("R") && to?.startsWith(`${LOG_DIR}/`) && !from.startsWith(`${LOG_DIR}/`));

  if (relocatedIntoLog.length > 0) {
    return {
      ok: false,
      reason: `This change moves ${relocatedIntoLog.length} vendored source file(s) into ${LOG_DIR}/.`,
      detail: [
        "An entry records why the vendored tree changed; it is not somewhere to",
        "put the tree. Moving source in deletes it from the vendored tree while",
        "looking like a new entry, so the change goes unrecorded. Move it back",
        "and add a separate entry describing the removal. Relocated:",
        ...relocatedIntoLog.map(([, from, to]) => `  ${from} -> ${to}`),
      ],
    };
  }

  // --no-renames for the same reason as the checks above: without it, a moved
  // file is reported only at its destination, and a destination under LOG_DIR/
  // is filtered out one line below -- so `changed` comes back empty and the
  // guard returns ok on a change that removed vendored source.
  const changed = git("diff", "--name-only", "--no-renames", range, "--", VENDOR_DIR)
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

  // BLO-41101. This used to also accept an added *row* in LOG, and to warn
  // rather than fail when a change recorded itself that way. Both are gone, and
  // they are gone by subsumption rather than by choice: the frozen-file check
  // above rejects any change that touches LOG at all, so nothing can reach this
  // point having appended a row. Leaving the row path in would have been a
  // branch no input can take -- a comment wearing a guard's clothes. The
  // `/^\+\s*\|/` row-shape filter it used is preserved in spirit by
  // `substantiveEntries` above, which rejects the same whitespace-only
  // satisfier for an entry file.
  if (substantiveEntries.length < 1) {
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
            // Not "empty": a symlinked entry reaches this branch too, and
            // telling its author the file is empty sends them to look at a file
            // that has a target in it. `reason` above is already generic.
            "changed in the vendored tree and why. Entries that record nothing:",
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
  // PEN-3916: check EVERY vendored tree, and report every failure rather than
  // the first. Exiting on the first would hide a second tree's missing entry
  // behind the first's, so an author fixing one would be sent back for the
  // other on the next run.
  const head = arg("--head") ?? "HEAD";
  let failed = false;
  for (const tree of VENDOR_TREES) {
    const result = checkVendoredProvenanceLog({ base, head, tree });
    if (!result.ok) {
      failed = true;
      console.error(`::error::${result.reason}`);
      for (const line of result.detail) console.error(line);
    } else {
      console.log(`${tree.logDir}: ok`);
    }
  }
  if (failed) process.exit(1);
}
