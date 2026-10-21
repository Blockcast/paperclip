---
title: Retire the orphaned PVC GitHub-wrapper generation
summary: Operator removal of the seven stale wrapper files left on paperclip-data by the retired seed initContainer (PEN-3840)
---

# Scope

PEN-3713 moved the five GitHub egress wrappers into the agent image at
`/usr/local/libexec/paperclip/bin/` and put that directory first on PATH. The
agent-writable PVC generation was deliberately left behind it so that neither
rollout order had a window. #2749 then deleted the seed install from the chart
and PEN-4357 backfilled the tooling directories behind the lead in the adapter.

What remains is **file removal only**: seven orphaned paths on the
`paperclip-data` PVC that nothing regenerates and nothing needs.

```text
/paperclip/.local/bin/gh
/paperclip/.local/bin/git
/paperclip/.local/bin/github-mcp-server
/paperclip/.local/bin/github-token-credential-helper
/paperclip/.local/bin/paperclip-github-token-env
/paperclip/bin/gh                  -> symlink to ../.local/bin/gh
/paperclip/bin/git                 -> symlink to ../.local/bin/git
```

This runbook exists because **no agent can perform this step**, and because the
severity that originally motivated it has since been measured and is narrower
than recorded. Both facts are below; read them before scheduling the work.

## Why an agent cannot do this

Agent Job pods mount the PVC **read-only** at `/paperclip`. Measured from a
live agent pod on 2026-10-20:

```console
$ awk '$5=="/paperclip"{print $6}' /proc/self/mountinfo
ro,relatime

$ touch /paperclip/.local/bin/.writetest
touch: cannot touch '/paperclip/.local/bin/.writetest': Read-only file system
```

The control in the same pod — `touch "$HOME/.writetest"` — succeeds, so the
refusal is the mount, not the pod's uid.

This is the BLO-32734 narrowing in
`vendor/paperclip-adapter-claude-k8s/src/server/job-manifest.ts`. The data
volume is mounted `readOnly: true` with a small set of `subPath` re-mounts for
the directories a run legitimately writes, gated on:

```ts
const narrowWritableSurface =
  isolation.enabled && dataClaimName !== "" && dataClaimName === selfPod.pvcClaimName;
```

None of those conjuncts depends on the isolation *mode*, so `run`, `shared` and
`workspace` Jobs are all narrowed alike. When the gate does fall through the
Job is annotated `paperclip.io/data-mount-scope: broad:<reason>` and the server
logs `claude_k8s.data_mount_broad_rw` — see "Before you start" for how to use
that as the precondition rather than assuming it.

Run the removal from a context that holds the PVC read-write: the
`paperclip` StatefulSet pod, or a one-shot Job mounting `paperclip-data`
without the narrowing.

## ⚠️ Correction: these files are not agent-writable

PEN-3840 recorded the severity as *"the executing wrappers are uid-1000-writable
on a PVC shared across companies."* **That is wrong for agent pods**, and the
reasoning that produced it is worth naming so it is not repeated.

The read-only mount is not a new discovery — BLO-32734 landed it deliberately,
and `job-manifest.ts` says so in as many words: *"The read-only `data` mount
closes cross-tenant WRITE but still grants READ of everything on the volume."*
What is new is only that PEN-3840's severity claim was never reconciled against
it, and went on being re-measured and re-quoted for weeks after the control
that refutes it was already live.

The mode bits do say owner-writable:

```console
$ ls -l /paperclip/.local/bin/gh
-rwxr-xr-x 1 node node 405 Oct 19 00:29 /paperclip/.local/bin/gh
```

`node` is uid 1000 and the agent runs as uid 1000, so `ls -l` alone reads as
"the agent can overwrite this". It cannot — the mount is read-only, and the
attempted write above is refused. **Ownership plus mode is not a writability
measurement when a read-only mount is in play; only an attempted write is.**

So the tamperability this card was opened to remove is already neutralised for
agent pods by BLO-32734. The removal below is correctness and hygiene — seven
dead files that will mislead the next reader — not an active exposure. Schedule
it accordingly, and do not let the original severity wording justify a rushed
fleet-wide delete.

What is *not* cleared by this correction: any context that mounts the PVC
read-write (the server pod, a broad-mount Job) can still write these paths.
That is the surface PEN-4367 covers for the shell dotfiles, and the same
argument applies here.

## Before you start

All four must be true. Measure them; do not assume.

1. **The chart no longer seeds the wrappers.** The five files must carry an
   mtime *older than* the current `paperclip-0` start time — that is what
   proves the live pod did not rewrite them and they will not come back.

   Stat **all five**, not just `gh`. The seed wrote them as one block, but a
   partial re-seed is exactly the state this precondition exists to catch, and
   checking one file cannot distinguish it. The *newest* of the five is the one
   that has to predate the pod.

   Compare **epoch seconds**, not printed timestamps. `stat -c '%y'` renders in
   the shell's local timezone with a numeric offset, while `.status.startTime`
   is UTC `Z`. On a bastion that is not UTC those are unlike strings, and
   eyeballing them can invert the comparison — which here would read a
   still-seeding file as an orphan. The first column below is epoch, so the
   check is mechanical.

   ```console
   $ TZ=UTC stat -c '%Y  %y  %n' /paperclip/.local/bin/{gh,git,github-mcp-server,github-token-credential-helper,paperclip-github-token-env}
   $ date -u -d "$(kubectl -n paperclip get pod paperclip-0 -o jsonpath='{.status.startTime}')" +'%s  %Y-%m-%d %H:%M:%S UTC'
   ```

   Every file's epoch must be **less than** the pod's.

   Measured 2026-10-19 and re-measured 2026-10-20 from a live agent pod: all
   five at epoch `1792369789` (`2026-10-19 00:29:49Z`), identical to the second
   — consistent with a single seed write — against a `paperclip-0` start of
   ~08:22Z. The two `/paperclip/bin` symlinks carry the same timestamp.

2. **Every live agent image carries the image wrapper directory.** The delete is
   only safe because `gh` falls through to `/usr/local/libexec/paperclip/bin`.
   An image predating `bb62073a` has no such directory and would fall through to
   the unscrubbed `/usr/bin/gh` — a silent PEN-2527 regression.

   ```console
   $ kubectl -n paperclip get jobs -l app.kubernetes.io/component=agent-job \
       -o jsonpath='{range .items[*]}{.spec.template.spec.containers[0].image}{"\n"}{end}' | sort -u
   ```

   Every tag must be at or after `bb62073a`. Treat a reference you cannot
   place in history as **unverified**, not as a pass. Two kinds occur:

   - a `@sha256:` digest pin, which names no commit at all; and
   - a `sha-<short>` tag that does not resolve — `gh api
     repos/Blockcast/paperclip/commits/<short>` answers `422 No commit found`.
     Measured 2026-10-20: the entire live agent fleet ran
     `sha-d529842-k8s-vendored`, and `d529842` is not a reachable commit in
     this repository. A tag whose commit was rewritten or whose branch was
     deleted is as unplaceable as a digest, so ancestry **cannot** clear it.

   When a reference will not resolve, do not stall and do not wave it through.
   Ask the image the question directly — this is the authoritative check in
   every case, because it tests the directory the fall-through actually needs
   rather than a proxy for it:

   ```console
   $ kubectl -n paperclip exec <a pod running that reference> -c claude -- \
       ls -l /usr/local/libexec/paperclip/bin/{gh,git,github-mcp-server,github-token-credential-helper,paperclip-github-token-env}
   ```

   Run it **once per distinct unverified reference** the census returned, not
   once overall. The census is `sort -u`, so it can hand you several, and the
   answer is a property of the image — one pod's result says nothing about a
   pod on a different reference. All five paths must exist and be `root:root`;
   a missing one fails the precondition for that reference.

   The pod must be **Running** — `kubectl exec` refuses a completed container,
   and agent Job pods reach `Completed` and are then TTL-reaped. Pods carry no
   field selector for image, so narrow by phase and match the reference
   yourself:

   ```console
   $ kubectl -n paperclip get pods -l app.kubernetes.io/component=agent-job \
       --field-selector=status.phase=Running \
       -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.containers[0].image}{"\n"}{end}' \
     | awk -F'\t' '$2 == "<reference>"'
   ```

   Match the image field **exactly**, as above. A substring match (`grep -F`)
   also hits a longer tag that contains the one you are checking — `sha-d529842`
   matches `sha-d529842-k8s-vendored` — which would send you into a pod on a
   *different* reference and clear the wrong image. Today's tags are not
   prefixes of one another, so this is latent rather than live; it is written
   exactly so that stays true.

   If no pod on that reference is still running, you cannot answer the question
   this way, and that is **not** a pass — never record an unexec'able reference
   as cleared. Note the census reads Jobs, not pods, so a finished Job keeps its
   reference listed until its TTL reaps it: seeing it still listed is expected
   and is not a dead end. Wait for the TTL, or for a Running pod on that
   reference, then re-check.

   Measured 2026-10-20 on `sha-d529842-k8s-vendored`, the single reference the
   fleet was then running: five files, `root root 755`, `test -w` false for
   each — so that unresolvable tag is cleared on evidence, not on inference.

   > **Census trap.** Do not scope this by `image=~".*paperclip-agent.*"`. That
   > pulls in the `paperclip-agent-image-cache` DaemonSet and
   > `agent-schedulability-*`, which pin `9f478e2` (2026-07-16, genuinely
   > pre-cutover) forever and never run `gh`. Counting them makes this
   > precondition unsatisfiable by construction. Scope to agent Jobs, as above.

   > **Since PEN-4446 this precondition has a standing answer; prefer it.**
   > Every agent Job now runs the filesystem check above on itself, at startup,
   > and writes one verdict line to its pod log:
   >
   > ```text
   > [paperclip] github-egress-wrappers ok dir=/usr/local/libexec/paperclip/bin
   > [paperclip] github-egress-wrappers MISSING dir=... absent:...
   > [paperclip] github-egress-wrappers NOT-ON-PATH dir=... resolved:...
   > ```
   >
   > That is the same question this precondition asks, asked by the pod rather
   > than by an operator, so it covers forks, `@sha256:` digest pins and tags
   > whose commits were rewritten — every reference the ancestry check cannot
   > place. It also removes the race that made the manual form fail: `exec`
   > needs a **Running** pod on the reference, and the reference you most want
   > to check is typically the one whose pods have already been reaped.
   > Measured 2026-10-21 — `sha-3ec50bd` ran 150 samples, resolved to no commit
   > in `Blockcast/paperclip`, and by the time it was investigated had no
   > Running pod left, so it is now **permanently unclassifiable** by either
   > route that existed before.
   >
   > A `MISSING` verdict is the live PEN-2527 regression this precondition
   > exists to prevent. The preflight reports it and does not refuse — see the
   > `buildImageWrapperPreflightShell` docblock in both adapters'
   > `runtime-pin.ts` for why, and for what evidence would justify escalating
   > to fail-closed.

3. **No agent Job is on a broad read-write data mount.** A broad-mount Job is
   one that *could* be relying on these files being writable:

   ```console
   $ kubectl -n paperclip get jobs -l app.kubernetes.io/component=agent-job \
       -o jsonpath='{range .items[*]}{.metadata.annotations.paperclip\.io/data-mount-scope}{"\n"}{end}' | sort | uniq -c
   ```

   Expect `scoped` for every row. Any `broad:*` row names a Job to wait out.

   > **This is a point-in-time read.** It only sees Jobs that exist now —
   > completed Jobs are TTL-reaped out of it, and a new Job can be admitted a
   > second after it returns. That is the right population for *"is anything
   > running broad right now"*, which is the question that matters, but it means
   > the check has to be taken **immediately before the `rm`**, not hours earlier
   > as part of a planning pass. Re-run it if you step away.

4. **Resolution already prefers the image copy.** From a live agent pod, under
   `bash -c` specifically — the top-level tool shell is not the exposed one:

   ```console
   $ for b in gh git github-mcp-server; do bash -c "command -v $b"; done
   ```

   All three must print a `/usr/local/libexec/paperclip/bin/` path. If any
   prints a `/paperclip/` path, **stop** — PATH ordering is still wrong and
   deleting the files will mask the defect rather than fix it (see PEN-4357).

## The removal

From a pod holding `paperclip-data` read-write:

```console
$ ls -l /paperclip/.local/bin/{gh,git,github-mcp-server,github-token-credential-helper,paperclip-github-token-env} \
        /paperclip/bin/{gh,git}

$ rm -f /paperclip/.local/bin/gh \
        /paperclip/.local/bin/git \
        /paperclip/.local/bin/github-mcp-server \
        /paperclip/.local/bin/github-token-credential-helper \
        /paperclip/.local/bin/paperclip-github-token-env \
        /paperclip/bin/gh \
        /paperclip/bin/git
```

**Delete exactly these seven paths.** `/paperclip/bin` is shared fleet tooling —
`kubectl`, `helm`, `yq`, `kyverno`, `google-chrome` all live there and must
survive. Do not `rm -r` either directory.

## Verify

1. The seven paths are gone, and **nothing else under `/paperclip/bin` is**:

   ```console
   $ ls /paperclip/bin | head -40
   ```

   `kubectl`, `helm` and `yq` must still be listed.

2. From a **fresh** agent pod — one started after the removal, so it is not
   reading a cached resolution — all five wrappers resolve into the image
   directory and none is writable:

   ```console
   $ for b in gh git github-mcp-server github-token-credential-helper paperclip-github-token-env; do
       r=$(bash -c "command -v $b")
       printf '%s -> %s (%s)\n' "$b" "$r" "$([ -w "$r" ] && echo WRITABLE || echo not-writable)"
     done
   ```

   Every line must name `/usr/local/libexec/paperclip/bin/` and read
   `not-writable`.

3. Egress scrubbing is still on the traffic path — confirm by resolution, not by
   reading the chart. Each resolved wrapper must still chain its egress runtime:

   ```console
   $ cat "$(bash -c 'command -v gh')"
   $ cat "$(bash -c 'command -v git')"
   ```

   `gh` must `exec` into `github-cli-egress-runtime.js`, and `git` into
   `github-git-egress-runtime.js` via `paperclip-github-token-env`.

   > Do not try to verify this with `git config --get core.hooksPath`. The
   > PEN-3156 hook path is injected by `github-git-egress-runtime.js` as a `-c`
   > override at invocation; it is never written to any config file, so that
   > command prints nothing whether or not scrubbing is working.

## If it goes wrong

The files are regenerable from `docker/github-wrappers/` in this repository,
which is the source the image copies are built from. Restoring them is
therefore recovery from source, not from backup — but note that restoring them
re-creates the orphan, so prefer fixing the PATH ordering that made the
fallback necessary.

The failure mode to watch for is `gh` or `git` resolving to `/usr/bin/`. That
means some pod lost the image directory from PATH; it is a PEN-2527 regression
and should be treated as one.

## Related

- PEN-3713 — the image move (`/usr/local/libexec/paperclip/bin`, PR #2185).
- PEN-3840 — this card; the deferral PEN-3713 left behind.
- PEN-4357 — the adapter-side tooling-directory backfill that makes the PVC
  shell-dotfile stanza a no-op by construction.
- PEN-4367 — the agent-writable shell dotfiles, which this does not close.
- BLO-32734 — the read-only data mount plus `subPath` narrowing relied on above.
- PEN-4446 — the standing per-Job wrapper preflight that replaces precondition 2's
  hand-run census, and the carrier for the cross-company images this runbook
  cannot enumerate.
