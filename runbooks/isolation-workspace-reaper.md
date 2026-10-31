# Isolation-workspace reaper stopped

Fires on `PaperclipIsolationWorkspaceReaperStopped` — `paperclip_isolation_workspace_reaper_last_sweep_timestamp_seconds` has not advanced for over 2× the sweep interval (default 48h; the sweep runs every 12h here, and at every worker boot).

> **Deploy status (2026-09-27): this alert is NOT live yet.** The chart copy in `deploy/helm/paperclip/templates/prometheusrule.yaml` does not deploy on Blockcast (`prometheusRule.enabled: false`). The copy that fires lives in `Blockcast/onprem-k8s` and is proposed in [onprem-k8s#4050](https://github.com/Blockcast/onprem-k8s/pull/4050), still open; the `monitoring-rules` Argo app also syncs manually ([BLO-19095](https://paperclip.blockcast.net/BLO/issues/BLO-19095)), so merging it is not deploying it. Until both happen, treat this page as a document rather than a signal — and note the reaper itself is opt-in and off by default ([BLO-36735](https://paperclip.blockcast.net/BLO/issues/BLO-36735)), so the series it reads may be absent for that reason too.

The reaper ([BLO-31222](https://paperclip.blockcast.net/BLO/issues/BLO-31222)) is a **12-hourly irreversible-delete** pass (plus one at every worker boot) over `/paperclip/instances/default/data/k8s-isolation/workspaces/`. Nothing else reclaims that tree; it grew 0 → 406.7 GiB in ~2 months without it, on the CephFS `ssd-fast` pool that produced BLO-31222's write-block incident.

## Read this first

The gauge advances at the **end of every sweep, including one that deletes nothing.** So a stall means the sweep is not running. It does **not** mean the tree is clean — those two states look identical on every counter, because both add zero. That is the whole reason this gauge exists ([BLO-36814](https://paperclip.blockcast.net/BLO/issues/BLO-36814)).

## Triage

```promql
# Which mode was last seen ticking, and how long ago.
time() - max by (dry_run) (paperclip_isolation_workspace_reaper_last_sweep_timestamp_seconds)

# Did the last sweeps do anything, and did they finish?
increase(paperclip_isolation_workspace_reaper_scanned_total[7d])
sum by (stop_reason) (increase(paperclip_isolation_workspace_reaper_sweeps_total[7d]))
```

1. **Is it still enabled?** `PAPERCLIP_ISOLATION_WORKSPACE_REAPER_ENABLED=true` must be on the **worker** StatefulSet — the reaper is gated to `paperclipNodeRole !== "api"`. It is opt-in and defaults off, so a values change or a rollback silently stops it.
2. **Is it pointed at a root that exists?** `stop_reason="root_absent"` means the sweep ran and found no tree at all. On a non-k8s-isolation deployment that is correct and expected. On **this** cluster it is a misconfiguration: the reaper is enabled, ticking, and reporting success over a path that is not the tree — while the real tree grows unreclaimed. That is the BLO-31222 shape, and it is why this stop reason is not folded into `complete` ([BLO-36814](https://paperclip.blockcast.net/BLO/issues/BLO-36814)). Confirm the worker's `PAPERCLIP_ISOLATION_WORKSPACE_ROOT` (or the `DEFAULT_ISOLATION_WORKSPACE_ROOT` fallback) against the live mount.
3. **Is the worker up and scraped?** A dead worker drops the series entirely rather than freezing it, which this alert cannot see (see "Why there is no absence rule"). `PaperclipPluginStatusCollectorAbsent` covers that case.
4. **Is it failing per-tick?** `grep 'isolation-workspace reaper sweep failed'` in worker logs. A throwing sweep never reaches the gauge, so repeated failures present exactly as a stall.
5. **Is it wedged mid-sweep?** Ticks are serialized — a sweep that outruns its interval against a slow MDS blocks the next one. `stop_reason="lookup_faulted"` means the pre-unlink re-read faulted and the remaining directories were never assessed at all.

## ⛔ Before reading anything below: check what the sweep could reach

```promql
max by (dry_run) (paperclip_isolation_workspace_reaper_unreachable_agents)
```

**`!= 0` means every other series on this page describes a subset of the population.** The reaper
walks one volume — the claim this process mounts — and an agent whose Job mounts a different one
(a `workspaceVolumeClaim`, or [PEN-4932](https://paperclip.blockcast.net/PEN/issues/PEN-4932)
stage 4b's per-agent claim) materializes its trees where no amount of walking this root will find
them. ([PEN-5125](https://paperclip.blockcast.net/PEN/issues/PEN-5125).)

⚠ `workspaceVolumeClaim` has **two** sources and the second is easy to miss: a k8s-driver
environment's config is merged over the agent's and **wins**, so an agent can be on a foreign volume
with nothing in its own `adapter_config` to say so. When any k8s environment names a claim the gauge
reports `-1` rather than a count, because which agents that moves is not derivable server-side.

Read the two values differently:

- **`> 0`** — that many agents' trees are outside this sweep's reach, and **nothing reclaims them**.
  They grow at the rate this reaper exists to contain (≈10 GiB/agent/month measured over the
  July → 2026-09-02 fill). This is a capacity finding, not an outage: `allowVolumeExpansion` is
  `true`, so it surfaces as an operator resizing a PVC rather than a run losing data.
- **`-1`** — the probe was absent, threw, **or** found a k8s environment supplying a
  `workspaceVolumeClaim`, which makes the agent-level count untrustworthy. Either way this sweep
  cannot describe its own coverage.
  Operationally the same state as a known-partial sweep, which is why the alert expression is `!= 0`
  and not `> 0`.

### What you can actually do about it today

**Nothing in this repo reclaims a foreign claim yet**, so the remedies below are the whole list.
[PEN-5151](https://paperclip.blockcast.net/PEN/issues/PEN-5151) owns the reclaimer; its server half
(`buildIsolationReclaimPlan`) is in the tree but has no caller, so do not go looking for a sweep that
might have run.

- **Opt the agent back out.** Clearing `enablePerAgentWorkspaceVolume` (or the agent's
  `workspaceVolumeClaim`) returns its next run to the shared claim, where this reaper reaches its
  trees unchanged. ⚠ The run also moves to a **different volume**: the per-agent claim's checkout,
  worktrees and pnpm store are left behind, so the next run is a cold start and anything uncommitted
  under them is unreachable until the agent is opted back in. The bytes are not deleted by opting
  out — they stay on the claim, unreclaimed, which is the finding you started from.
- **Expand the claim.** `cephfs` sets `allowVolumeExpansion: true`, so a claim that outgrows its
  request can be grown in place. This is the terminal state the ≈3.7-month ceiling was accepted
  against, not a workaround.

Neither is urgent on the first alert. The useful question is *how many* agents are in this state and
for how long: one agent a month into its own claim has used roughly a quarter of its headroom, and
the gauge is deliberately loud from the first opt-in so that this is a scheduling decision rather
than a capacity incident.

**Do not reach for `stop_reason` to rule this out.** An unreachable workspace is never enumerated,
so it lands in no outcome bucket, the `scanned` identity still holds exactly, and the pass reports
`stop_reason="complete"`. `root_absent` does not catch it either — that fires on `ENOENT` of the
root, and the root stays present and populated by every agent still on the shared claim. A
`complete` sweep means *"finished sweeping the tree it could see"*, never *"swept the population"*.

## Two findings signals worth reading while you are here

Neither is part of this alert; both are non-routine when non-zero.

- `paperclip_isolation_workspace_reaper_retained_resurrected_total` — a workspace used again between the sweep's opening snapshot and its unlink, i.e. one that came within a single query of being deleted underneath a live run. Any non-zero value is the exposure window the pre-unlink re-read exists to close, actually occurring.
- `paperclip_isolation_workspace_reaper_skipped_layout_total` — directories skipped *unexamined* because their top level was not exactly `{home, session}`. **It sums two populations with opposite meanings and carries no label to tell them apart, so split it before reading it.** Measured over the whole live tree at `maxAgeDays=30` on 2026-10-11 ([BLO-36735](https://paperclip.blockcast.net/BLO/issues/BLO-36735)): 50 skips = **42 single-sided or empty** (`{home}` or `{session}` alone — a half-materialized workspace, carrying no heterogeneity at all) + **8 genuine supersets** (`scratch`×2, `blo16208`, `blo32457-logs`, `wt-29038`, `wt-31323`, `wt-blo-19094`, `wt-blo-30976`, `wt-blo-31507`). Only the supersets are the signal: a rise *there* means the tree is more heterogeneous than the allowlist was validated against — investigate before widening the allowlist. That subset was identical on 2026-10-10 and 2026-10-11, so treat **8** as the current baseline and a change in its membership, not the total, as the thing to look at.
  ⚠ This line previously gave the baseline as **1** — the superset count when BLO-36735 first measured it, before the single-sided population existed at scale. Read against a live total of 50 that is a 50× apparent rise with a benign cause, i.e. a signal that fires permanently and so cannot be acted on. Split it by hand until the counter carries a `reason` label:

  ```bash
  cd /paperclip/instances/default/data/k8s-isolation/workspaces
  CUT=$(( $(date +%s) - 30*86400 ))   # match PAPERCLIP_ISOLATION_WORKSPACE_REAPER_MAX_AGE_DAYS
  for d in */; do d=${d%/}; m=$(stat -c %Y "$d") || continue
    [ "$m" -gt "$CUT" ] && continue   # layout is only checked on aged candidates
    case "$(ls -A "$d" | sort | tr '\n' ',')" in
      "home,session,") ;;
      "home,"|"session,"|"") echo "single-sided  $d" ;;
      *) echo "SUPERSET      $d" ;;
    esac
  done | sort | uniq -c -w12
  ```

  Note this walks the whole tree, while the counter only covers the directories a sweep actually reached — a `stop_reason="capped"` sweep reports a fraction of both populations (23 of the 50 above, on the 2026-10-11 tick).
  A directory whose top level *did* match but which holds a nested git checkout or worktree state is **not** counted here — it was examined, so it is `paperclip_isolation_workspace_reaper_entries_total{outcome="retained_nested_checkout"}` (routine). Read that series with these three properties in mind:
  - **One increment per such directory the sweep reaches, on every sweep.** Only a directory that already passed the age gate (root `mtime`, and the owning row's `lastUsedAt` when it has one) and the `{home, session}` allowlist is probed; each hit also logs `retained a layout-compliant directory holding a nested git checkout` with its path. A retained directory is counted again by the next sweep, so divide `increase()` over a window by the sweeps in it — `sum(increase(paperclip_isolation_workspace_reaper_sweeps_total[…]))` — rather than reading it as new arrivals.
  - **A capped sweep undercounts it.** The probe runs before the per-tick cap, so a retention spends no unlink budget, but the sweep stops at the first directory that would take `eligible` past `PAPERCLIP_ISOLATION_WORKSPACE_REAPER_MAX_DELETES_PER_TICK` (100 here, 200 by default) and never reaches anything after it. A sweep that ends `stop_reason="capped"` (or `stop_reason="lookup_faulted"`) therefore reports only the nested checkouts it reached; only a `stop_reason="complete"` sweep covers the whole set. Under `dry_run="true"` nothing is unlinked, so while the eligible backlog exceeds the cap **every** dry-run sweep ends capped and this count stays partial.
  - **The 2026-10-09 figure is a floor for a complete sweep, not a per-sweep value.** BLO-36735 found 13 of the 503-directory match set by measuring the live tree directly, not from a sweep's counter, and with an earlier probe; the current one also checks `<side>/.git` and the `.paperclip/worktrees` parent, which can only retain more. A capped sweep should report roughly 13/490 of its `eligible` — about 3 at the 100 cap, if those directories are spread evenly through directory order — so a low count on a capped sweep is not evidence the guard stopped firing. On a `complete` sweep, fewer than 13 is worth checking against the tree: a directory reused since is counted `retained_in_use` instead, and one cleaned up by hand is simply gone.

## Check the mode before acting on `deleted`

`paperclip_isolation_workspace_reaper_deleted_total` counts **real unlinks only** and is always 0 under `dry_run="true"`. A dry run's would-have-removed count is `paperclip_isolation_workspace_reaper_entries_total{outcome="eligible", dry_run="true"}`. Reading reclaimed space off a dry-run tick is the easy mistake here.

## Why there is no absence rule

The companion `absent_over_time()` pattern used by `PaperclipPluginStatusCollectorAbsent` is deliberately **not** applied to this series. That collector starts unconditionally on every worker, so an absent series there can only mean breakage. This reaper is opt-in, so an absent series is its ordinary disabled state — an absence rule would page continuously on any deployment that has not turned it on.

The gap that leaves is a worker pod dying before `time() - gauge` can cross a ~2-day threshold. That is already covered, critically, by `PaperclipPluginStatusCollectorAbsent`.

**If the reaper was disabled on purpose, this alert resolves on its own once the series ages out. It does not need silencing.**
