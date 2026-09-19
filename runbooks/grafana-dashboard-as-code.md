# Adding or changing a Grafana panel without UI access

**Trigger.** A `paperclip_*` metric exists and is scraped, but nothing charts
it — or a chart needs changing — and you have no Grafana write credential.
Also read this before filing "someone with Grafana UI access needs to…": for
Paperclip dashboards, that request is usually unnecessary.

**Owning lane.** Platform / SRE.

---

## The short version

Paperclip dashboards are **already dashboard-as-code**. Add a panel by opening
a PR against `deploy/helm/paperclip/dashboards/*.json`. No Grafana UI access is
required at any point, and no agent needs a Grafana credential.

This is not aspirational — the mechanism has been live since 2026-08-08
([BLO-20171](https://paperclip.blockcast.net/BLO/issues/BLO-20171)) and is
carrying `paperclip-grafana-dashboard-review-request-funnel` in production
today.

## How it actually reaches Grafana

```
deploy/helm/paperclip/dashboards/<name>.json          (you edit this)
  -> templates/grafana-dashboard*.yaml                (Helm renders a ConfigMap,
                                                       substituting the datasource uid)
  -> ConfigMap in ns/paperclip, label grafana_dashboard="1"
  -> kiwigrid/k8s-sidecar `grafana-sc-dashboard`      (NAMESPACE=ALL, METHOD=WATCH)
  -> orc8r-user-grafana, ns/production-orc8r          (the Paperclip runtime Grafana)
```

Verified against the live cluster on 2026-09-02:

| fact | how to re-check |
|---|---|
| Sidecar watches **every** namespace | `kubectl -n production-orc8r get deploy orc8r-user-grafana -o json \| jq '.spec.template.spec.containers[]\|select(.name=="grafana-sc-dashboard").env'` → `NAMESPACE=ALL` |
| It keys on `grafana_dashboard="1"` | same command → `LABEL=grafana_dashboard`, `LABEL_VALUE=1`, `RESOURCE=configmap` |
| `orc8r-user-grafana` is the Paperclip runtime Grafana | `kubectl -n paperclip get deploy mcp-grafana -o jsonpath='{...GRAFANA_URL...}'` → `http://orc8r-user-grafana.production-orc8r.svc.cluster.local:3000` |

`NAMESPACE=ALL` is the load-bearing part: a ConfigMap rendered into the
`paperclip` release namespace is adopted with **no change to the orc8r chart**.

## Adding a panel to an existing dashboard

1. Edit the JSON in `deploy/helm/paperclip/dashboards/`.
2. Point every panel target at `"uid": "__PAPERCLIP_DS_UID__"`. It is
   substituted at render time. **Do not hard-code a datasource uid** — see the
   trap below.
3. Add or extend an assertion in `deploy/helm/paperclip/tests/`.
4. `node --test deploy/helm/paperclip/tests/grafana-dashboard*.test.mjs`
5. Open the PR.

## Adding a whole new dashboard

Same, plus copy `templates/grafana-dashboard-runtime.yaml` to a new file and
change three things: the ConfigMap name suffix, the `.Files.Get` path, and the
new dashboard's top-level `"uid"` in the JSON. **Changing the first two and not
the third is the trap** — see below. The templates are deliberately
one-file-per-dashboard rather than a glob — see the comment at the top of that
file for why.

## Traps that produce a silently-empty dashboard

These all deploy cleanly and render a dashboard that is simply wrong or blank.
None of them fail loudly.

- **Duplicate dashboard `uid`.** Grafana keys dashboards by the JSON's
  top-level `uid`, not by filename or ConfigMap name. Copying an existing
  dashboard as a starting point and forgetting to change its `uid` ships two
  dashboards claiming the same one; both ConfigMaps apply, both show up in
  `kubectl get cm`, and in Grafana one silently replaces or fails to provision
  the other. Pinned by the duplicate-`uid` test in
  `deploy/helm/paperclip/tests/grafana-dashboard-runtime.test.mjs`, which
  renders every `dashboards/*.json` through the chart and fails on a repeat.
- **Wrong datasource.** Only the `cluster` datasource
  (`http://prometheus.monitoring.svc:9090`) scrapes the Paperclip control
  plane. `thanos` is the Grafana default and `prometheus-monitoring` is the
  orc8r one; a panel on either renders "No data" while looking healthy in
  review.
- **Missing sidecar label.** Without `grafana_dashboard: "1"` the ConfigMap
  deploys fine and no dashboard ever appears.
- **`sum()` over a per-replica gauge.** The runtime gauges are emitted by every
  control-plane replica with identical values — measured 2026-09-02: 3 pods
  across `service=paperclip` (2) and `service=paperclip-workers` (1). `sum()`
  reports N× the true value and still looks plausible. Use
  `max by (agent_id)`.
- **A CRD-backed kind.** `paperclip-ci-deploy` holds `ClusterRole/admin` in the
  `paperclip` namespace, which covers ConfigMaps but **not**
  `monitoring.coreos.com`. A `GrafanaDashboard` CRD here 403s the entire
  `helm upgrade`, not just that resource — the same trap that keeps
  `templates/prometheusrule.yaml` disabled.
- **A frozen gauge.** If a metric's refresh loop dies, the gauge serves its
  last value forever and is pixel-identical to a healthy one. Chart the
  matching `*_refresh_success` gauge with `min()` across replicas.

## The deploy gate — this is NOT Argo

The alert half of the fleet syncs through the `monitoring-rules` Argo app.
**Dashboards in this chart do not.** They ship with the paperclip chart via the
`paperclip-api` deploy pipeline, which is a **manual, human-dispatched
deploy** — that is ratified policy, not a bug
([BLO-22032](https://paperclip.blockcast.net/BLO/issues/BLO-22032)).

Consequence: a merged dashboard PR is **not** live until the next
`paperclip-api` production deploy. That pipeline has repeatedly run hundreds of
commits behind ([BLO-25414](https://paperclip.blockcast.net/BLO/issues/BLO-25414),
[BLO-29194](https://paperclip.blockcast.net/BLO/issues/BLO-29194)), so treat
"merged" and "live" as different states and verify with the step below.

## Verifying it actually landed

Every step below is executable and answers a *different* question. Step 1 can
pass while 2 and 3 fail — that is the whole point of running all three.

```bash
CM=paperclip-grafana-dashboard-runtime-run-queue-health   # ConfigMap name
KEY=runtime-run-queue-health.json                 # key inside .data
SRC=deploy/helm/paperclip/dashboards/$KEY         # the file in this repo

# 1. EXISTS + LABELLED: the sidecar only adopts ConfigMaps carrying this label.
kubectl -n paperclip get cm -l grafana_dashboard=1

# 2. CURRENT: is the live copy the revision you just merged?
#    Diff the live JSON against the tree. `jq -r 'keys'` does NOT answer this --
#    it returns the filename, which is identical in every revision, so a
#    ConfigMap hundreds of commits stale looks exactly like a fresh one.
diff <(kubectl -n paperclip get cm "$CM" -o jsonpath="{.data.$KEY}" | jq -S .) \
     <(jq -S . "$SRC") && echo "LIVE == TREE" || echo "STALE -- deploy has not run"

# 3. RESOLVES: the panel can render only if its series exist. Query the
#    `cluster` Prometheus directly -- thanos is the Grafana default and will
#    not see these.
kubectl -n monitoring port-forward svc/prometheus 9090:9090 >/dev/null 2>&1 &
sleep 2
for m in paperclip_queued_run_oldest_age_seconds \
         paperclip_overdue_scheduled_retry_oldest_age_seconds \
         paperclip_overdue_scheduled_retry_age_metrics_refresh_success; do
  printf '%s -> %s series\n' "$m" \
    "$(curl -sG http://localhost:9090/api/v1/query --data-urlencode "query=$m" \
        | jq '.data.result | length')"
done
kill %1
```

Step 3 returning `0 series` for a metric is a **fault, not an empty result** —
the panel will render "NO DATA" on red by design (see the `-1` sentinel on
*Worst queued-run age*), because a dead exporter and an idle queue are
indistinguishable to Grafana and only one of them is healthy.

"The ConfigMap exists" is **not** sufficient — confirm the panel renders and
resolves non-empty series. A gauge whose healthy steady state is `0` (such as
`paperclip_overdue_scheduled_retry_oldest_age_seconds`) reads as all-zero by
design; that is healthy, not missing data. Distinguish the two by checking the
series *count*, not the values.

## Do not confuse this with `Blockcast/onprem-k8s`

`onprem-k8s` contains ~13 Grafana dashboard JSON files under `monitoring/`.
**None of them are deployed.** No file in that repo references
`grafana_dashboard`, and `argocd/apps/monitoring.yaml` says so explicitly:

> `monitoring/dashboards` currently contains raw Grafana dashboard JSON, not
> Kubernetes manifests, so it is intentionally excluded until wrapped.

Editing a JSON file there changes nothing in Grafana. It is a known, documented
gap, not a live reconciliation loop. For Paperclip dashboards, use this chart.

## Sources

- [BLO-20171](https://paperclip.blockcast.net/BLO/issues/BLO-20171) — built the mechanism
- [BLO-29904](https://paperclip.blockcast.net/BLO/issues/BLO-29904) — established it already existed; this runbook
- [BLO-23450](https://paperclip.blockcast.net/BLO/issues/BLO-23450) — first panel shipped through it
- [BLO-22094](https://paperclip.blockcast.net/BLO/issues/BLO-22094) — the overdue-retry gauge
