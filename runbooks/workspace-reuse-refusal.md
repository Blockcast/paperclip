# Workspace reuse refusal (PEN-3633)

Covers `PaperclipWorkspaceReuseRefusalEpisode` and
`PaperclipWorkspaceReuseRefusalMetricsRefreshFailed`.

## What fired

A project's managed checkout is refusing to host runs. The alert is labelled
with the `project_workspace_id` and a `failure_class` derived from the refusal
message body.

**Read the alert as one broken checkout, not as N broken issues.** Every issue
bound to a project workspace resolves to the same on-disk `cwd` — in the
originating incident, 565 of 570 issues in one project shared a single
`project_workspace_id` and fanned out across ~86 execution workspaces that all
pointed at one directory. Worktrees do not escape this: a worktree's `.git` is a
file pointing into the parent clone, and `git config` reads the parent's config.

Do **not** triage the issues individually, reassign them, or cancel their runs.
Repair the checkout and they all recover together.

## Triage by `failure_class`

The class names the condition that was actually tested, which is the thing the
pre-PEN-3633 message got wrong — it named `repoUrl` on a branch that never read
`repoUrl`, and two unrelated episodes were both read as repo-identity faults.

| `failure_class` | What was tested | Where to look |
|---|---|---|
| `origin_mismatch` | `git config --get remote.origin.url` disagreed with the issue's expected repo | The checkout is a real repository pointed at the wrong remote. Repoint or re-clone it. See [project-checkout-origin-mismatch.md](./project-checkout-origin-mismatch.md), which catches this class on a timer BEFORE any run is refused. |
| `not_a_checkout` | `git rev-parse --git-dir` ran and found no repository | The directory was replaced, emptied, or never provisioned. |
| `probe_indeterminate` | `git rev-parse --git-dir` itself failed to reach a verdict | **Check the API pod before the disk.** See below. |
| `cause_unreported` | The reuse wrapper fired with no cause attached | A defect in its own right — file it. |

An inherited-reuse failure that DID report a cause which is not one of the three checkout conditions above — an archived execution workspace, a failed restore, a provision timeout — is deliberately absent from this metric. Those are issue-level faults: they belong to the one issue whose workspace binding is broken, not to the project checkout every issue in the project shares, so counting them here would page an operator to fix a checkout that is fine. Find them on the issue itself.

### `probe_indeterminate` is the one that is not necessarily on disk

An indeterminate probe means the probe failed, not that the directory is bad. It
covers dubious ownership, lock contention under a concurrent worktree
operation, a momentarily inconsistent `.git`, and anything **process-local to
the `paperclip-api` pod** — fd or PID exhaustion, a wedged subprocess path, a
spawn failure. No checkout-side inspection will ever see that second family.

The refusal message carries git's own stderr verbatim, which is what tells them
apart. Read it before touching the disk:

```
kubectl -n paperclip logs deploy/paperclip-api | grep 'could not verify a checkout'
```

A `fatal:` from git is disk-side. An `ENOENT`/`EAGAIN` on the spawn, or no
diagnostic at all, is pod-side.

> This diagnosis exists only because PEN-3633 item 1 stopped `isGitCheckout`
> discarding it with `.catch(() => null)`. The 2026-10-05 episode is
> unattributable for exactly that reason — the record was dropped at the call
> site and nothing downstream could recover it.

## Resolving

The gauge is recomputed from the database on every collector tick, not
accumulated. Once refusals stop, the series disappears on the next sweep and the
alert resolves on its own. There is nothing to reset or acknowledge.

If the alert stays up after you believe the checkout is repaired, a run is still
refusing — re-read the newest refusal message rather than assuming lag.

## `PaperclipWorkspaceReuseRefusalMetricsRefreshFailed`

The sweep is failing, so the episode alert is **gated off** and a broken
checkout would not page. A failed sweep deliberately leaves the previous
snapshot in place rather than zeroing it, because zeroing would read as "this
project stopped refusing" — the one conclusion a failed sweep cannot support.

The gauge is initialised to `0` at process start, so a replica that has never
completed a sweep fires this too. Check that the collector tick is running at
all before assuming a query fault.

## Tuning

- `prometheusRule.workspaceReuseRefusalCount` (default `3`) — refusals against
  one project workspace needed to call it an episode.
- `WORKSPACE_REUSE_REFUSAL_WINDOW_MS` in
  `server/src/services/workspace-reuse-refusal-metrics.ts` (2h) — the window
  those refusals are counted over.

Sized against the 2026-10-05 episode: 33 refusals over 8.6h is ~3.8/h, so it
presents ~7.7 in a 2h window and clears a threshold of 3 with margin, while the
common benign case — one agent, one bad cwd, self-healing — presents 1 and never
fires.

**Raise the count, not the window,** if a project legitimately churns checkouts.
Widening the window slows the alert's recovery without making it quieter.

## Why the classes cannot drift

The matcher does not keep its own copy of the refusal text. The markers in
`server/src/services/workspace-reuse-refusal-class.ts` are what the producers in
`workspace-runtime.ts` and `heartbeat.ts` build their messages *from*, and
`workspace-reuse-refusal-class.test.ts` round-trips every producer back through
the classifier and pins that the producers still call it. A reword that drops a
marker fails a test instead of silently emptying this alert.
