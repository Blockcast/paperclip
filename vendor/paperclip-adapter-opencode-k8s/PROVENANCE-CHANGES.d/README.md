# Per-change provenance entries

**One file per change.** Every PR that touches vendored source under
`vendor/paperclip-adapter-opencode-k8s/` adds exactly one new file here:

```
vendor/paperclip-adapter-opencode-k8s/PROVENANCE-CHANGES.d/<issue-or-pr>.md
```

Name it after the thing that motivated the change — `pen-3732.md`, `pr-2402.md`,
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
  not a record, and is rejected.

## Why a directory and not a table

Two PRs adding two distinct files never conflict, under any merge
implementation. That is the whole design.

This directory starts where its `claude_k8s` sibling ended up, rather than
repeating the two intermediate designs that failed there. For the measurements
behind that — why a single append-only table marked `merge=union` does **not**
work (GitHub's server-side merge ignores `.gitattributes` merge drivers, and it
is what computes both `mergeable` and the merge-queue rebase), and what it cost
in ejected PRs — see
[the claude sibling's README](../../paperclip-adapter-claude-k8s/PROVENANCE-CHANGES.d/README.md).

There is deliberately **no `PROVENANCE-CHANGES.md`** here. The claude tree keeps
one only because it is frozen history that cannot be rewritten without
conflicting with every in-flight PR. Nothing here has to carry that.

## Do not put a single-valued field in an entry

A version, a 64-hex integrity hash, or anything else with exactly one correct
value conflicts on every concurrent PR wherever it lives. Per-change files fix
*collisions*, not single-valuedness. See
[Integrity](../PROVENANCE.md#integrity) — this tree never stored such a hash,
and `scripts/__tests__/provenance-union-merge.test.mjs` is what keeps one from
being introduced.
