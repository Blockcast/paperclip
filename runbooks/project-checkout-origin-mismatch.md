# Project checkout origin mismatch (PEN-4188)

Covers `PaperclipProjectCheckoutOriginMismatch`,
`PaperclipProjectCheckoutOriginReconcileBlind` and
`PaperclipProjectCheckoutOriginReconcileMetricsRefreshFailed`.

Sibling of [workspace-reuse-refusal.md](./workspace-reuse-refusal.md). Read that
one too if both are firing — they are two views of the same fault at different
times, and this page explains which is which.

## What fired

A project workspace's on-disk checkout has a git origin that is not the
repository the workspace expects. The reconciler compares
`git config --get remote.origin.url` against `project_workspaces.repo_url`
every 5 minutes and publishes one series per disagreeing checkout.

**This is the PEN-3628 fault, caught before a run is dispatched into it.** In
that incident one `url` line in one `.git/config` repointed a shared checkout at
a different repository; 33 runs were refused over 8.6 h, each refusal naming the
run and none naming the checkout, and a human found it by manual board sweep
~3 h in.

**One broken checkout, not N broken issues.** Every issue bound to the project
workspace resolves to the same directory — 565 of 570 in the originating
incident, fanning out across ~86 execution workspaces that all pointed at one
`cwd`. Worktrees do not escape it: a worktree's `.git` is a *file* pointing into
the parent clone, so `git config` reads the parent's config. Repair the
checkout; do not triage, reassign or cancel the issues.

## ⚠️ Do not diagnose this with `git remote -v`

`/paperclip/.gitconfig` (shared, home-level) carries

```
url.git@github.com:Blockcast/.insteadOf = https://github.com/Blockcast/
```

so `git remote -v` prints the **SSH** form while `.git/config` stores **HTTPS**.
Measured across the production PVC on 2026-10-16: of 665 on-disk checkouts, the
two disagree on **485**. `remote -v` will mislead you in both directions — it
shows a difference on healthy checkouts, and it hides the stored value you
actually need to change.

Read what the reconciler reads:

```sh
git -C <cwd> config --get remote.origin.url
```

## Triage

1. **Get the facts from the log, not from the alert annotation.** The reconciler
   logs both URLs in full beside the `cwd`:

   ```sh
   kubectl -n paperclip logs deploy/paperclip-api \
     | grep 'project checkout origin does not match'
   ```

   The alert carries ids; the log carries the URLs. Do not guess from the ids.

2. **Decide which side is wrong.** Either the checkout was repointed (repair the
   checkout) or the workspace's `repo_url` was changed under a correct checkout
   (repair the row). The log line gives you both values; the project's own
   history tells you which one moved.

3. **If the checkout is wrong**, repoint it in place:

   ```sh
   git -C <cwd> remote set-url origin <expected repo_url>
   git -C <cwd> config --get remote.origin.url   # read it back
   ```

   Re-cloning also works and is safer if the tree is otherwise suspect, but note
   that other runs may be mid-edit in a shared checkout.

4. **If `repo_url` is wrong**, fix the `project_workspaces` row rather than the
   disk.

The gauge is reset and recomputed on every pass, so the series disappears within
one 5-minute sweep once the two agree. There is nothing to acknowledge.

## What this alert does NOT cover

Exactly one of the two measured PEN-3633 episodes. They are different branches
of the same function:

| | episode 1 (2026-09-29) | episode 2 (2026-10-05) |
|---|---|---|
| condition | origin identity ≠ expected | `isGitCheckout(cwd)` returned false |
| origin URL at the time | wrong | **correct** |
| does this alert fire? | yes | **no** |

Episode 2's checkout had the right origin, so no origin comparison can see it.
It is covered from the run side by `PaperclipWorkspaceReuseRefusalEpisode`'s
`not_a_checkout` / `probe_indeterminate` classes. **If that alert is firing and
this one is not, do not conclude the checkout is fine** — read the refusal
runbook instead.

## `PaperclipProjectCheckoutOriginReconcileBlind`

The pass completed and read an origin from **no** checkout at all, so the
mismatch alert is gated off and a repointed checkout would not page.

This is the positive control for the whole detector, and it exists because an
empty mismatch set means "every checkout agrees" *only* if something was
compared. A pass that compared nothing produces the identical empty set.

Check, in order:

- the project data volume is mounted at `PAPERCLIP_HOME` in the control-plane
  pods (the reconciler probes `<instance root>/projects/<company>/<project>/<repo>`);
- `git` is on `PATH` in the image;
- `select count(*) from project_workspaces where repo_url is not null` is
  non-zero — a fleet with genuinely no git-backed project workspaces reads 0
  here legitimately.

Note the distinction from the refresh-failure alert below: that one fires when
the pass **threw**; this one fires when the pass **succeeded and saw nothing**,
which is the half that looks healthy on every other surface.

## `PaperclipProjectCheckoutOriginReconcileMetricsRefreshFailed`

The pass is throwing. A failed pass deliberately leaves the previous snapshot in
place rather than zeroing it — zeroing would read as "every checkout is correct
now", the one conclusion a failed pass cannot support — so the freshness gate
drops the stale series out of both alerts above and this one pages the pass.

The gauge is initialised to `0` at process start, so a replica that has never
completed a pass fires this too. Check the reconciler is running at all before
assuming a database fault.

## Tuning

- `PROJECT_CHECKOUT_ORIGIN_RECONCILE_INTERVAL_MS` (5 min) and
  `PROJECT_CHECKOUT_ORIGIN_PROBE_TIMEOUT_MS` (5 s) in
  `server/src/services/project-checkout-origin-reconciler.ts`.
- `prometheusRule.projectCheckoutOriginMismatchFor` (10 m, two sweeps) —
  flap tolerance only. There is deliberately **no count threshold**: this gauge
  is a direct observation of the checkout, not a rate of run failures, so one
  disagreeing checkout is one fault.

Cost of a pass, measured on the production PVC 2026-10-16: 2,515 managed
directories, 665 of which hold a `.git`; one `git config` probe is ~6.8 ms, so a
full pass is ~4.5 s even strictly serial, and a `stat` precedes every spawn so
the ~1,850 directories with no checkout cost no process at all.

## Why the comparison cannot drift from the dispatch gate

`validateProjectPrimaryRepoOrigin` (the refusal at dispatch) and
`reconcileProjectCheckoutOrigins` (this alert) call the *same*
`compareProjectCheckoutOrigin` and the *same* `normalizeRepoIdentity`, in
`server/src/services/project-checkout-origin.ts`, over the *same*
`readGitOriginUrl` read. There is no second normaliser. A detector that
disagreed with the gate would be worse than none — it would page on checkouts
the gate is happy with, or stay silent on ones it refuses.
