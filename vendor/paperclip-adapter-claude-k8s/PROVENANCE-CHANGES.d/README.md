# Per-change provenance entries

**One file per change.** Every PR that touches vendored source under
`vendor/paperclip-adapter-claude-k8s/` adds exactly one new file here:

```
vendor/paperclip-adapter-claude-k8s/PROVENANCE-CHANGES.d/<issue-or-pr>.md
```

Name it after the thing that motivated the change — `blo-34872.md`, `pr-2070.md`,
a short commit sha. Any `.md` filename works; the only hard rule is that it is a
**new** file nobody else is adding, so pick something specific to your change.
Content is free-form prose: what changed, which files, and why.
`scripts/check-vendored-provenance-log.mjs` (the `policy` job) fails any PR that
touches vendored source without one.

Two things the guard enforces beyond "a file exists":

- **The directory is append-only.** Never delete or rename an entry — each one
  records why the vendored tree changed in some earlier PR, and removing it
  erases that record. To correct an entry, add a new one that supersedes it.
  (A rename is a delete: git pairs a removed entry with a similar new one and
  reports neither, so the guard suppresses rename detection to see through it.)
- **An entry has to say something.** An empty or whitespace-only file is a path,
  not a record, and is rejected — the same rule the old row table had.

## Why a directory and not a table

Two PRs adding two distinct files never conflict, under any merge
implementation. That is the whole design, and it is a correction.

The previous attempt ([BLO-34872](https://paperclip.blockcast.net/BLO/issues/BLO-34872)
round 1) kept a single append-only table in
[PROVENANCE-CHANGES.md](../PROVENANCE-CHANGES.md) and marked it `merge=union` in
the repo-root `.gitattributes`. That works locally and **does nothing on
GitHub**: GitHub's server-side merge ignores `.gitattributes` merge drivers, and
it is what computes both a PR's `mergeable` state and the merge-queue rebase.

Measured 2026-09-30 against master `0bb33a1a7`, after
[#1898](https://github.com/Blockcast/paperclip/pull/1898) landed a row:

| PR | ejected from the queue | `git merge-tree` locally |
|---|---|---|
| [#2070](https://github.com/Blockcast/paperclip/pull/2070) | 17:04:28Z `merge_conflict` | clean — union applied |
| [#1459](https://github.com/Blockcast/paperclip/pull/1459) | 17:07:02Z `merge_conflict` | clean — union applied |

With `PROVENANCE-CHANGES.md merge=text` forced in `.git/info/attributes` — which
is what GitHub effectively does — both conflicted, in that file and nothing
else. [#1699](https://github.com/Blockcast/paperclip/pull/1699) was ejected three
times on it (09-23, 09-27, 09-30) *after* its author had deliberately moved its
row into the union-merged file. The attribute was not merely inert; it drew rows
into the one file that conflicts.

A PR ejected this way goes `DIRTY`, which forces a rebase and re-push, which
voids the at-head review attestation and costs a full review round — during
which master moves 30–60 commits and the PR re-conflicts. That loop is the cost
this directory removes.

## PROVENANCE-CHANGES.md is frozen

It is kept, not migrated: rewriting it would conflict with every in-flight PR
that has already appended to it — the exact failure being fixed. It remains
append-only and `merge=union` so that those PRs still merge locally, and the
guard still accepts a row there as a transitional allowance, with a CI warning.
Do not add new rows to it.

## Do not put a single-valued field in an entry

Unchanged from
[BLO-35109](https://paperclip.blockcast.net/BLO/issues/BLO-35109): a version, a
64-hex integrity hash, or anything else with exactly one correct value conflicts
on every concurrent PR wherever it lives. Per-change files fix *collisions*, not
single-valuedness. See [Integrity](../PROVENANCE.md#integrity).
