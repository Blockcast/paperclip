# Plugin stuck in status='error'

Source: `server/src/services/plugin-status-metrics.ts` (collector), `server/src/services/metrics.ts` (`PLUGIN_ERROR_METRIC`)
Trigger: alert `PaperclipPluginCriticalErrored` or `PaperclipPluginErrored` — `paperclip_plugin_error{plugin_key=~/!~"<critical-key-regex>"} == 1` for 10m
Owner: Platform / SRE (gstack)

## What this alert means

An installed plugin (`plugins.status = 'error'` in the DB) has stayed in that
state for at least the grace period. `paperclip_plugin_error{plugin_id,
plugin_key}` is 1 for that plugin, 0 otherwise — one series per installed
plugin, re-derived from the `plugins` table by a worker-tier collector every
~30s (`startPluginStatusCollector`).

Two alerts fire off the same series, split by `plugin_key`:

| alert | selector | severity |
|---|---|---|
| `PaperclipPluginCriticalErrored` | `plugin_key` matches `pluginErrorCriticalKeyRegex` (default `lucitra\.plugin-secrets`) | critical |
| `PaperclipPluginErrored` | everything else | warning |

The split exists because a dead `lucitra.plugin-secrets` is not the same
incident as a dead example plugin: it is the secrets subsystem, and
[BLO-20410](https://github.com/Blockcast/paperclip/issues) found it dead for
**9+ hours** with the pod `1/1 Running`, `restarts=0`, node CPU 44%, and
nothing alerting — the exact gap this metric closes.

**`status='error'` is not `status='disabled'`.** An operator who deliberately
disabled a plugin never sets this gauge to 1 and never pages. If you are
seeing this alert, something *crashed* — a bad deploy, a broken manifest, an
expired credential in an `initialize` handler, or an activation timeout that
exhausted its retries (see BLO-978, which made *transient* timeouts retry
instead of latch — this alert covers what's left after that fix: terminal
failures and retry-exhaustion).

## What to do when paged

### Step 1 — find the plugin and its last error

```sql
select id, plugin_key, status, last_error, updated_at
from plugins
where plugin_key = '<plugin_key from the alert>';
```

`last_error` is the most recent activation failure message. `updated_at` is
when the row last transitioned — cross-check it against the alert's firing
time; a very old `updated_at` with a fresh page means the collector only just
started publishing (e.g. after a worker-tier rollout), not that the plugin
just failed.

### Step 2 — check whether it's an activation-timeout retry loop

If `last_error` mentions an `initialize` timeout, this may be the transient
case BLO-978 already retries. Check the worker pod logs for the plugin's
`pluginKey` around `updated_at`:

```bash
kubectl logs -n <namespace> -l app=paperclip,paperclip-node-role=worker --since=1h | grep '<plugin_key>'
```

- Retries visibly happening and eventually succeeding → the alert should
  self-resolve within a scrape or two of the next successful activation. If it
  doesn't clear within ~1m of a success log line, the collector or scrape
  path itself may be broken — check `/metrics` on the worker tier directly.
- Retries exhausted, or the error is not a timeout at all (bad manifest,
  expired credential, missing config) → this is the residual case the alert
  exists for. Proceed to Step 3.

### Step 3 — fix and re-enable

The fix depends entirely on `last_error`:

- **Expired/invalid credential** — rotate it via the plugin's config UI, or
  `GET /api/plugins/<id>/config` to fetch the current `configJson`, edit the
  field, and `POST` the **complete** object back to
  `/api/plugins/<id>/config` (this endpoint replaces the stored config
  wholesale — it is not a partial patch, so omitting existing keys deletes
  them), then re-enable.
- **Broken manifest / bad deploy** — roll back the plugin package, or fix and
  reinstall.
- **Unknown / needs investigation** — pull the worker pod logs for the full
  stack trace; `last_error` is truncated and the one explanatory log line can
  scroll out of retention (this happened during BLO-20410 — capture it early).

Re-enable with:

```
POST /api/plugins/<id>/enable
```

This call is **slow** (BLO-21092 notes: a 15s-timeout probe reports a client
timeout and looks like a hang, while a 100s budget returns `200`). Budget
generously — a probe that looks like a failure may just be the activation
still in flight.

### Step 4 — confirm resolution

```
paperclip_plugin_error{plugin_key="<plugin_key>"}
```

Should read `0` within one collector tick (~30s) of the plugin returning to
`status='ready'`. The alert itself clears once that holds for the evaluation
interval — no manual silence needed.

## Silencing

Do not silence this alert to "make it go away" while a plugin sits errored —
that is exactly the failure mode BLO-20410 exists to prevent. If a plugin is
being decommissioned, uninstall it (`status='uninstalled'`) rather than
leaving it errored: an uninstalled plugin drops out of the gauge's roster
entirely (the collector reads `listInstalled()`, which excludes
`uninstalled`), so there's nothing left to silence.

## Verifying the signal is live

```
count(paperclip_plugin_error)
```

Should equal the number of currently-installed (non-`uninstalled`) plugins —
11 at time of writing. If this reads "No data", the worker-tier `/metrics`
scrape is broken or the collector isn't running (it only runs when
`paperclipNodeRole !== "api"` — check that the worker-tier pod, not the API
tier, is the scrape target for this series).

### Where the rule actually runs

The chart copy at `deploy/helm/paperclip/templates/prometheusrule.yaml`
**does not deploy on Blockcast** (`prometheusRule.enabled: false` in
`values.blockcast.yaml` — see the file's header comment for why). The rule
that fires in production lives in `Blockcast/onprem-k8s`, in both
lockstep-enforced files: `monitoring/prometheus-configmap.yaml` (key
`paperclip-runtime-alerts.rules.yml`, authoritative) and
`paperclip/paperclip-runtime-alerts-prometheusrule.yaml` (CRD documentation
copy).

Merging that is **not** deploying it: the `monitoring-rules` Argo app syncs
manually (BLO-19095), a gate that once stranded 15 merged alerts for 8 days.
Confirm the rule is in the live ConfigMap and in Prometheus `/api/v1/rules`
before treating this alert as production observability:

```bash
gh api repos/Blockcast/onprem-k8s/contents/monitoring/prometheus-configmap.yaml \
  --jq '.content' | base64 -d | grep PaperclipPluginErrored
```

## References

- `runbooks/README.md` — index
- [BLO-21092](https://paperclip.blockcast.net/BLO/issues/BLO-21092) (this
  alert/metric), [BLO-20410](https://paperclip.blockcast.net/BLO/issues/BLO-20410)
  (the incident that found the gap), PR #978 (activation-timeout retry)
- BLO-19095 — the manual Argo sync gate that stands between merge and deploy
