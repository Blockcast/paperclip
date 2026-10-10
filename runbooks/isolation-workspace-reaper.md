# Isolation-workspace reaper stopped

Fires on `PaperclipIsolationWorkspaceReaperStopped` — `paperclip_isolation_workspace_reaper_last_sweep_timestamp_seconds` has not advanced for over 2× the sweep interval (default 48h against a daily sweep).

> **Deploy status (2026-09-27): this alert is NOT live yet.** The chart copy in `deploy/helm/paperclip/templates/prometheusrule.yaml` does not deploy on Blockcast (`prometheusRule.enabled: false`). The copy that fires lives in `Blockcast/onprem-k8s` and is proposed in [onprem-k8s#4050](https://github.com/Blockcast/onprem-k8s/pull/4050), still open; the `monitoring-rules` Argo app also syncs manually ([BLO-19095](https://paperclip.blockcast.net/BLO/issues/BLO-19095)), so merging it is not deploying it. Until both happen, treat this page as a document rather than a signal — and note the reaper itself is opt-in and off by default ([BLO-36735](https://paperclip.blockcast.net/BLO/issues/BLO-36735)), so the series it reads may be absent for that reason too.

The reaper ([BLO-31222](https://paperclip.blockcast.net/BLO/issues/BLO-31222)) is a **daily irreversible-delete** pass over `/paperclip/instances/default/data/k8s-isolation/workspaces/`. Nothing else reclaims that tree; it grew 0 → 406.7 GiB in ~2 months without it, on the CephFS `ssd-fast` pool that produced BLO-31222's write-block incident.

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

## Two findings signals worth reading while you are here

Neither is part of this alert; both are non-routine when non-zero.

- `paperclip_isolation_workspace_reaper_retained_resurrected_total` — a workspace used again between the sweep's opening snapshot and its unlink, i.e. one that came within a single query of being deleted underneath a live run. Any non-zero value is the exposure window the pre-unlink re-read exists to close, actually occurring.
- `paperclip_isolation_workspace_reaper_skipped_layout_total` — directories skipped *unexamined* because their top level was not exactly `{home, session}`. Baseline measured **1** at `maxAgeDays=30` ([BLO-36735](https://paperclip.blockcast.net/BLO/issues/BLO-36735): a stray `wt-blo-19094` git worktree). A rise means the tree is more heterogeneous than the allowlist was validated against — investigate before widening the allowlist.
  A directory whose top level *did* match but which holds a nested git checkout or worktree state is **not** counted here — it was examined, so it is `paperclip_isolation_workspace_reaper_entries_total{outcome="retained_nested_checkout"}` (routine; ~13 per sweep at the 2026-10-09 measurement).

## Check the mode before acting on `deleted`

`paperclip_isolation_workspace_reaper_deleted_total` counts **real unlinks only** and is always 0 under `dry_run="true"`. A dry run's would-have-removed count is `paperclip_isolation_workspace_reaper_entries_total{outcome="eligible", dry_run="true"}`. Reading reclaimed space off a dry-run tick is the easy mistake here.

## Why there is no absence rule

The companion `absent_over_time()` pattern used by `PaperclipPluginStatusCollectorAbsent` is deliberately **not** applied to this series. That collector starts unconditionally on every worker, so an absent series there can only mean breakage. This reaper is opt-in, so an absent series is its ordinary disabled state — an absence rule would page continuously on any deployment that has not turned it on.

The gap that leaves is a worker pod dying before `time() - gauge` can cross a ~2-day threshold. That is already covered, critically, by `PaperclipPluginStatusCollectorAbsent`.

**If the reaper was disabled on purpose, this alert resolves on its own once the series ages out. It does not need silencing.**
