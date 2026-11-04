# Stale `.git/index.lock` in an agent working tree

**Trigger.** Any git write in an agent working tree fails with:

```
fatal: Unable to create '<path>/.git/index.lock': File exists.
```

…and the lock is still there after the run that might have created it has ended.

**Scope.** This runbook covers working trees an *agent* created and works in —
the managed project checkout, a provisioned execution workspace, and an ad-hoc
clone such as `/paperclip/wt/<issue>/repo`. It does **not** cover the ArgoCD
repo-server, which wedges the same way for a different reason and has its own
blast radius; see [PEN-5149](https://paperclip.blockcast.net/PEN/issues/PEN-5149).

Motivated by [PEN-5352](https://paperclip.blockcast.net/PEN/issues/PEN-5352),
after three separate rows tripped over orphaned index locks and each improvised
a different removal.

---

## Why you cannot just delete it

Git creates `index.lock` with `O_CREAT|O_EXCL` at **0 bytes**, then does every
expensive step — blob hashing, tree walk, object writes — *while holding it*,
and serialises the index into it only in the last moment before the rename.

Measured against a live `git add` stalled in a clean filter: **size stayed 0 and
mtime stayed frozen at creation for the whole run.**

⚠️ So "empty and old" is what a **slow live writer** looks like, not what a dead
one leaves behind. Neither size nor mtime is evidence of abandonment. A removal
argued from either one can destroy a live writer's index mid-write.

The platform already encodes this: `ensureGitIndexIsUnlocked` in
`server/src/services/workspace-runtime.ts` breaks a lock only on a **positive
determination that nothing holds it**, and it *renames* rather than deletes.
This runbook is the manual form of that same verdict, for trees the automated
path does not reach — it is reached only from the dirty-quarantine repair path
on a provisioned worktree, so an agent standing in an ad-hoc clone has no
automated reaper at all.

---

## The safe-removal path

Run every step. **Any step that cannot answer is a refusal, not a pass.**

### 1. Resolve the lock that belongs to *this* worktree

`--git-path` answers relative for a normal repo and absolute for a linked
worktree, so resolve it against the worktree, never against your shell's cwd:

```sh
cd <worktree>
RAW=$(git rev-parse --git-path index.lock)
case "$RAW" in /*) LOCK="$RAW" ;; *) LOCK="$PWD/$RAW" ;; esac
echo "$LOCK"
```

### 2. Refuse outright if it holds serialised index state

```sh
stat -c '%s %y' "$LOCK"
```

**Size > 0 ⇒ STOP.** A partially-written index is genuinely indistinguishable
from a complete one. There is no verdict to reach here; removing it can corrupt
the index. Park the row and escalate.

### 3. Look for a live holder

Git holds the lock open from creation to rename, so an open descriptor is a
**positive liveness signal**:

```sh
for p in /proc/[0-9]*; do
  for fd in "$p"/fd/*; do
    [ "$(readlink -f "$fd" 2>/dev/null)" = "$(readlink -f "$LOCK")" ] && echo "HOLDER: $p"
  done
done 2>/dev/null
```

- **Any holder printed ⇒ STOP.** It is live. Wait for it.
- **`/proc` unreadable, or not Linux ⇒ STOP.** "I could not look" is not a
  determination. Do not fall back to the age floor — the floor is a mitigation
  for the scan's residue, deliberately *not* the safety argument.

⚠️ The scan is bounded by the PID namespace it runs in. A holder under another
uid, in another pod sharing the volume, or in a sandbox Job pod that does not
share this namespace is **invisible to it**. Treat a clean scan as authoritative
only for the namespace you can actually read.

### 4. Rule out a sibling run of your own seat

This is the step that is most often skipped, and the one PEN-5352 is about.

A clean `/proc` scan in **your** pod says nothing about a sibling run of your own
seat in **another** pod — and `ListAgents` cannot see those either; it reports
subagents, teammates and local sessions, so an empty result means *that tool
cannot answer the question*, never *nobody else is here*.

The claim lives in the checkout's **git dir**, not in the working tree, so that
`git add -A` cannot commit it and `git clean -fdx` cannot delete it. A directory
that is not itself a checkout keeps the claim at its root instead, so read both:

```sh
cat "$(git -C <worktree> rev-parse --git-dir)/paperclip-dir-claim.json" 2>/dev/null
cat <worktree>/.paperclip-dir-claim.json 2>/dev/null
```

- **A claim naming a live run ⇒ STOP.** That run is probably the holder. If it
  is your own seat, the issue thread is where you coordinate: read the comments
  before touching anything on disk.
- **No claim file** does not mean unowned — ad-hoc trees created before
  `workspace-dir-claim.ts` carry none. Fall through, but keep the residual doubt.

### 5. Only now, and only by rename

Both must hold: a positive clean holder scan (step 3) **and** no live claim
(step 4). The lock must also be older than the staleness floor —
`GIT_INDEX_LOCK_STALE_MS`, **15 minutes** — which is a mitigation for the
namespace residue, not the reason you are allowed to proceed.

```sh
mv "$LOCK" "$LOCK.stale-$(date -u +%Y%m%dT%H%M%SZ)"
```

**Rename, never `rm`.** A rename releases the mutex exactly as an unlink does and
costs one inode to keep the evidence if the verdict was wrong. This is the only
irreversible act on the path, and the verdict behind it is evidential, not
certain.

A future mtime yields a negative age: **refuse**. A lock stamped by a clock you
do not share is not one to break on an age argument.

### 6. Record it

Post on the issue: the lock path, its size and mtime, the holder-scan result,
the claim file contents (or its absence), and the renamed path. Three rows have
now hit this; an unrecorded removal is why each one started from scratch.

---

## Related

- `server/src/services/workspace-runtime.ts` — `ensureGitIndexIsUnlocked`,
  `GIT_INDEX_LOCK_STALE_MS`, `lockHolderPids`. The automated form of this
  verdict, and the authoritative implementation.
- `server/src/services/workspace-dir-claim.ts` — the directory claim read in
  step 4.
- [PEN-5352](https://paperclip.blockcast.net/PEN/issues/PEN-5352) — the seat
  colliding with itself in a per-issue tree.
- [PEN-5149](https://paperclip.blockcast.net/PEN/issues/PEN-5149) — ArgoCD
  repo-server wedged on the same primitive, different blast radius.
