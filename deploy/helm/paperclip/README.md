# paperclip

Self-hosted Paperclip AI — company orchestration platform with a single-replica StatefulSet, embedded Postgres, and PVC-backed state.

**Homepage:** <https://github.com/paperclipai/paperclip>

## TL;DR

```bash
helm install paperclip ./deploy/helm/paperclip \
  --namespace paperclip --create-namespace
```

Default install creates a single-replica StatefulSet with a 20Gi `local-path` PVC, a ClusterIP Service on port 3100, and auto-generates the `agentJwtSecret`. No Ingress is created unless you opt in.

## Quickstart

1. **Install the chart** into a dedicated namespace (`paperclip` by convention):
   ```bash
   helm install paperclip ./deploy/helm/paperclip \
     --namespace paperclip --create-namespace
   ```
2. **Wait for the pod to become Ready**:
   ```bash
   kubectl -n paperclip rollout status sts/paperclip --timeout=5m
   ```
3. **Run the first-run bootstrap** — see below.
4. **Expose the UI** via port-forward, Ingress, or cloudflared — see "Exposure".

## Bootstrap auth

Paperclip's auth is always on. After the first pod becomes Ready, create the initial admin (CEO) account by generating a one-time invite URL:

```bash
kubectl -n paperclip exec -it paperclip-0 -- \
  npx paperclipai auth bootstrap-ceo \
    --base-url https://paperclip.example.com
```

The command prints an invite link that embeds a short-lived token. Open it in a browser to complete sign-up and set an admin password. Replace `--base-url` with whatever host users will browse to — the URL printed must be reachable, or the invite link will be unusable.

Extra flags:

- `--force` — re-issue the invite even if an admin already exists (use when the previous invite expired before it was redeemed).
- `--expires-hours N` — override the invite TTL.

To log the CLI in separately (for `paperclipai` admin commands from your workstation):

```bash
paperclipai auth login --api-base https://paperclip.example.com
```

## Exposure

The chart does **not** create an Ingress by default. Pick one:

- **Ingress** (cluster-internal or LAN-only): set `ingress.enabled=true`, `ingress.className=nginx`, and configure `ingress.hosts[]`.
- **Cloudflare Tunnel** (external, via `cloudflared` running in-cluster): leave `ingress.enabled=false` and add a route in your tunnel config pointing at `http://paperclip.paperclip.svc.cluster.local:3100`. Paperclip's built-in auth gates the UI.
- **Port-forward** (ad-hoc):
  ```bash
  kubectl -n paperclip port-forward svc/paperclip 3100:3100
  ```

## Upgrading

The image is selected via `image.tag` in `values.yaml`. Set `image.digest` to pin the deployed manifest immutably; when present, it takes precedence over the tag. Two common paths:

- **Follow upstream**: every upstream master push and stable tag publishes an image (`sha-<short>` and `vYYYY.MMM.P` respectively). Point `image.tag` at whichever channel you want to track.
- **Manual**:
  ```bash
  helm upgrade paperclip ./deploy/helm/paperclip \
    --namespace paperclip \
    --set image.tag=v2026.XXX.Y
  ```

Roll back by reverting the bump commit, or:

```bash
helm rollback paperclip <REVISION>
```

The PVC is untouched on rollback — data persists across image versions.

## Backup & restore

### Hourly pg_dump (built-in)

Paperclip writes hourly SQL dumps to `/paperclip/instances/<instanceId>/data/backups/` with 30-day retention. No configuration needed.

### On-demand dump

```bash
kubectl -n paperclip exec paperclip-0 -- npx paperclipai db:backup
```

### Full instance tar

```bash
kubectl -n paperclip exec paperclip-0 -- \
  tar czf - --exclude=data/backups -C /paperclip instances/default \
  > paperclip-instance.tgz
```

### Restore onto a fresh PVC

1. Install the chart with an empty PVC.
2. Scale the StatefulSet to 0:
   ```bash
   kubectl -n paperclip scale sts paperclip --replicas=0
   ```
3. Mount the PVC from a debug pod and extract the tar into `/paperclip/`:
   ```bash
   kubectl -n paperclip run seed --rm -i --tty --image=alpine \
     --overrides='{"spec":{"containers":[{"name":"seed","image":"alpine","stdin":true,"tty":true,"volumeMounts":[{"name":"data","mountPath":"/paperclip"}]}],"volumes":[{"name":"data","persistentVolumeClaim":{"claimName":"data-paperclip-0"}}]}}'
   # Inside: apk add --no-cache tar; tar xzf /path/to/paperclip-instance.tgz -C /paperclip
   # Then: chown -R 1000:1000 /paperclip; chmod 0600 /paperclip/instances/default/secrets/master.key
   ```
4. Scale back to 1. Paperclip detects existing data and skips DB init.

## Maintainers

| Name | Email | Url |
| ---- | ------ | --- |
| Nuno Ferro | <mail@nunoferro.com> |  |

## Source Code

* <https://github.com/paperclipai/paperclip>

## Values

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| affinity | object | `{}` | Affinity rules. |
| api | object | `{"enabled":false,"maxSurge":1,"maxUnavailable":0,"replicas":2,"spreadAcrossNodes":true}` | HA API tier — splits the single-pod StatefulSet into a multi-replica HTTP API Deployment plus a singleton worker StatefulSet. When enabled, the workers tier owns the heartbeat scheduler + plugin workers + Linear tunnel + database backup; the API tier serves HTTP traffic only with `PAPERCLIP_NODE_ROLE=api` (so plugin operations 503 cleanly on it). See server/src/services/plugin-worker-manager-stub.ts. |
| api.enabled | bool | `false` | Enable the API/worker split. When `false` (default) the chart behaves like the single-replica StatefulSet that ships with upstream paperclip — no migration impact for existing deploys. |
| api.maxSurge | int | `1` | Rolling update budget for the API Deployment. `maxSurge: 1` + `maxUnavailable: 0` gives zero-downtime rolls for HTTP traffic. |
| api.replicas | int | `2` | Number of API tier replicas. 2+ is the point of the split. Each replica runs `PAPERCLIP_NODE_ROLE=api`, no plugin workers, no scheduler. |
| api.spreadAcrossNodes | bool | `true` | Spread API replicas across nodes: a hard `topologySpreadConstraints` (maxSkew 1, minDomains 2, whenUnsatisfiable DoNotSchedule) plus a soft podAntiAffinity preference. The hard constraint requires at least 2 Ready nodes matching `nodeSelector`; with only one, a second replica sits `Pending` rather than co-locating with the first (BLO-20901 — a `false` setting here, or a `nodeSelector`/`nodeAffinity` narrowed to fewer than 2 eligible nodes, reintroduces the single-node-outage blast radius this exists to prevent). |
| env | object | `{"extra":[],"host":"0.0.0.0","instanceId":"default","port":3100,"serveUi":true}` | Paperclip runtime environment. |
| env.extra | list | `[]` | Extra environment variables merged verbatim into the container spec. Example: `[{name: NODE_OPTIONS, value: --max-old-space-size=3072}]`. |
| env.host | string | `"0.0.0.0"` | Bind address. |
| env.instanceId | string | `"default"` | Paperclip instance identifier. Directory under `/paperclip/instances/` is named after this. |
| env.port | int | `3100` | HTTP port inside the container (must match `service.port`). |
| env.serveUi | bool | `true` | Serve the bundled web UI alongside the API. |
| extraVolumeMounts | list | `[]` | Additional volumeMounts for the main `paperclip` container. Pair with `extraVolumes`; each entry must reference a name declared there. Example:   extraVolumeMounts:     - name: plugin-service-key       mountPath: /var/run/plugin-service-keys       readOnly: true |
| extraVolumes | list | `[]` | Additional pod-level volumes. Used to mount Secrets/ConfigMaps that plugins or runtime helpers read from disk (for example Authbot service keys). Example:   extraVolumes:     - name: plugin-service-key       secret:         secretName: plugin-service-keys         defaultMode: 0444 |
| fullnameOverride | string | `""` | Override the full name used as the prefix for every resource. |
| githubApp | object | `{"appIdKey":"app_id","enabled":false,"installationIdKey":"installation_id","privateKeyKey":"private_key.pem","reviewerBotLogin":"","secretName":"paperclip-github-app-creds"}` | GitHub App creds for server-side installation-token minting. Lets the API authoritatively verify (via the GitHub API) that a PR-review run actually left a review/comment before completing it (BLO-10448). Deployments that run the PR reviewer must enable this; missing credentials fail review completion closed. Disabled by default for deployments that do not use the reviewer workflow. |
| githubApp.appIdKey | string | `"app_id"` | Secret keys (override only if your secret uses different key names). |
| githubApp.enabled | bool | `false` | Mount the GitHub App creds into the API env and enable GitHub-verified PR-review evidence. |
| githubApp.reviewerBotLogin | string | `""` | GitHub App login used to filter reviews/comments. Must be `<slug>[bot]` or `app/<slug>`; bare user logins are rejected. Empty -> server default ("allyblockcast[bot]"). |
| githubApp.secretName | string | `"paperclip-github-app-creds"` | Name of the pre-existing Secret holding the App creds. |
| image | object | `{"digest":"","pullPolicy":"IfNotPresent","repository":"ghcr.io/paperclipai/paperclip","tag":"latest"}` | Container image settings. |
| image.digest | string | `""` | Image manifest digest. When set, this takes precedence over `tag` and pins the deployed artifact immutably. |
| image.pullPolicy | string | `"IfNotPresent"` | Image pull policy. |
| image.repository | string | `"ghcr.io/paperclipai/paperclip"` | Image repository. Upstream publishes to `ghcr.io/paperclipai/paperclip` on every master push and stable tag. |
| image.tag | string | `"latest"` | Image tag. Override to a specific stable release (e.g. `v2026.416.0`) or pin to a `sha-<commit>` tag. |
| imagePullSecrets | list | `[]` | Image pull secrets. Only needed if the GHCR package is private. Example: `[{name: ghcr-pull}]`. |
| ingress | object | `{"annotations":{},"className":"nginx","enabled":false,"hosts":[{"host":"paperclip.example.com","paths":[{"path":"/","pathType":"Prefix"}]}],"tls":[]}` | Optional Ingress. Leave disabled if fronting via cloudflared only. |
| ingress.annotations | object | `{}` | Annotations on the Ingress (e.g. cert-manager, rate limits). |
| ingress.className | string | `"nginx"` | Ingress class name. `nginx` matches the cluster's ingress-nginx install. |
| ingress.enabled | bool | `false` | Enable an Ingress resource. |
| ingress.hosts | list | single host at `paperclip.example.com` serving `/`. | Hosts and paths served by the Ingress. |
| ingress.tls | list | `[]` | TLS configuration. Leave empty to serve HTTP only. Example: `[{hosts: [paperclip.example.com], secretName: paperclip-tls}]`. |
| nameOverride | string | `""` | Override the chart name used in resource names. |
| networkPolicy | object | `{"allowFromNamespaces":[{"namespaceSelector":{"matchLabels":{"kubernetes.io/metadata.name":"ingress-nginx"}}},{"namespaceSelector":{"matchLabels":{"kubernetes.io/metadata.name":"cloudflare"}}}],"enabled":true}` | Ingress NetworkPolicy restricting which namespaces may reach the pod. |
| networkPolicy.allowFromNamespaces | list | `ingress-nginx` and `cloudflare` namespaces. | Namespaces whose pods may reach the Paperclip service port. Add an entry for the release namespace if you need same-namespace traffic (e.g. Prometheus scrape, debug pods). |
| networkPolicy.enabled | bool | `true` | Create a NetworkPolicy. Defaults to allowing from `ingress-nginx` and `cloudflare` namespaces only — **same-namespace pods (sidecars, scrapers, `kubectl debug` pods) are also blocked**, so extend `allowFromNamespaces` or disable the policy for any in-cluster tooling that needs to reach the service. |
| nodeSelector | object | `{}` | Node selector. |
| pdb | object | `{"enabled":true,"maxUnavailable":1}` | PodDisruptionBudget. Uses `maxUnavailable` rather than `minAvailable` so node drains and cluster upgrades remain possible on the single-replica StatefulSet (a `minAvailable: 1` budget would block every voluntary eviction). |
| pdb.enabled | bool | `true` | Create a PodDisruptionBudget. |
| pdb.maxUnavailable | int | `1` | Maximum number of pods that may be unavailable during voluntary disruptions. `1` lets a single-replica StatefulSet be drained. |
| persistence | object | `{"accessMode":"ReadWriteOnce","enabled":true,"existingClaim":"","mountPath":"/paperclip","size":"20Gi","storageClassName":"local-path"}` | Persistent volume settings for `/paperclip`. |
| persistence.accessMode | string | `"ReadWriteOnce"` | Access mode for the PVC. ReadWriteOnce is correct for the single-replica StatefulSet. |
| persistence.enabled | bool | `true` | Whether to create a PVC for `/paperclip`. Required for any real use — disabling loses all state on pod restart. |
| persistence.existingClaim | string | `""` | Use a pre-created PVC by name instead of `volumeClaimTemplates`. Required for ReadWriteMany migrations where the StatefulSet's immutable volumeClaimTemplates lock-in must be avoided. When set, `storageClassName`, `accessMode`, and `size` are ignored — the PVC must already exist in the release namespace. |
| persistence.mountPath | string | `"/paperclip"` | Mount path inside the container. Paperclip's `PAPERCLIP_HOME` defaults to `/paperclip`; keep these aligned. |
| persistence.size | string | `"20Gi"` | PVC size. Sized for live state + ~30 days of hourly pg_dumps. |
| persistence.storageClassName | string | `"local-path"` | StorageClass for the PVC. `local-path` on the Talos cluster; set to empty string to use the cluster default. |
| pod | object | `{"annotations":{},"containerSecurityContext":{"runAsGroup":1000,"runAsNonRoot":true,"runAsUser":1000},"labels":{},"securityContext":{"fsGroup":1000,"fsGroupChangePolicy":"OnRootMismatch"},"shareProcessNamespace":true,"terminationGracePeriodSeconds":120}` | Pod spec knobs. |
| pod.annotations | object | `{}` | Extra annotations on the pod template. |
| pod.containerSecurityContext | object | `{runAsUser: 1000, runAsGroup: 1000, runAsNonRoot: true}`. | Container-level security context. |
| pod.labels | object | `{}` | Extra labels on the pod template. |
| pod.securityContext | object | `{fsGroup: 1000, fsGroupChangePolicy: OnRootMismatch}`. | Pod-level security context. |
| pod.shareProcessNamespace | bool | `true` | Share the process namespace so tini (pid 1) reaps orphaned child processes spawned by Claude agents. |
| pod.terminationGracePeriodSeconds | int | `120` | Seconds the kubelet waits between SIGTERM and SIGKILL. Must cover the preStop sleep (5s) plus the server's full graceful-drain sequence: SSE drain (bounded 25s), server.close, telemetry/OTel flushes, and Linear tunnel teardown. The k8s default of 30s truncated that drain on every rollout (BLO-12563). |
| priorityClassName | string | `""` | Priority class name. |
| probes | object | `{"liveness":{"failureThreshold":3,"httpGet":{"httpHeaders":[{"name":"Host","value":"127.0.0.1:3100"}],"path":"/healthz","port":"http"},"initialDelaySeconds":60,"periodSeconds":30,"timeoutSeconds":5},"readiness":{"failureThreshold":3,"httpGet":{"httpHeaders":[{"name":"Host","value":"127.0.0.1:3100"}],"path":"/healthz","port":"http"},"initialDelaySeconds":15,"periodSeconds":10,"timeoutSeconds":5},"startup":{"failureThreshold":30,"httpGet":{"httpHeaders":[{"name":"Host","value":"127.0.0.1:3100"}],"path":"/healthz","port":"http"},"periodSeconds":10}}` | Health probe configuration. `httpGet` to `/healthz` with an explicit `Host: 127.0.0.1:3100` header — Paperclip's hostname allowlist always accepts loopback (see server/src/middleware/private-hostname-guard.ts), while the pod-IP Host header kubelet would otherwise send is rejected. |
| probes.liveness | object | `{"failureThreshold":3,"httpGet":{"httpHeaders":[{"name":"Host","value":"127.0.0.1:3100"}],"path":"/healthz","port":"http"},"initialDelaySeconds":60,"periodSeconds":30,"timeoutSeconds":5}` | Liveness probe. Paperclip serves HTTP on the configured port once the embedded Postgres is up. timeoutSeconds=5 (k8s default is 1) — under load /healthz can spike past 1s when the event loop is briefly busy (e.g. during a fs-write batch under contention with ccrotate-auth-bot's pool sweep). Observed 2026-05-09 ~04:55Z: kubelet flagged "Killing — failed liveness probe" but the process recovered before the kill landed. 5s is a generous ceiling that absorbs those spikes without hiding a real wedge. |
| probes.readiness | object | `{"failureThreshold":3,"httpGet":{"httpHeaders":[{"name":"Host","value":"127.0.0.1:3100"}],"path":"/healthz","port":"http"},"initialDelaySeconds":15,"periodSeconds":10,"timeoutSeconds":5}` | Readiness probe. Shorter cadence pulls the pod out of rotation quickly on transient failures. |
| probes.startup | object | `{"failureThreshold":30,"httpGet":{"httpHeaders":[{"name":"Host","value":"127.0.0.1:3100"}],"path":"/healthz","port":"http"},"periodSeconds":10}` | Startup probe. Long timeout tolerates first-run DB init + 45 migrations. |
| prometheusRule | object | `{"additionalGroups":[],"agentJobNameRegex":"ac-.*","backoffLimitExceededFor":"2m","backoffLimitExceededWindow":"5m","enabled":false,"labels":{},"namespace":"","processLostElevatedFor":"10m","processLostLivenessNullWindowCount":5,"processLostPageFor":"2h","processLostPagePerDay":40,"processLostSignalBlindFor":"15m","processLostWarnPerDay":20,"unschedulableFor":"15m","unschedulablePodThreshold":0,"zeroTokenFor":"2m","zeroTokenStreakThreshold":3}` | Prometheus Operator rules for Paperclip runtime health. Requires the `monitoring.coreos.com/v1` CRDs and the ServiceMonitor scrape above. Disabled by default so the chart still installs on clusters without the operator. |
| prometheusRule.additionalGroups | list | `[]` | Additional PrometheusRule groups appended verbatim. |
| prometheusRule.agentJobNameRegex | string | `"ac-.*"` | Regex for Kubernetes Job names owned by Paperclip agents. |
| prometheusRule.backoffLimitExceededFor | string | `"2m"` | How long the BackoffLimitExceeded rate condition must persist before firing. |
| prometheusRule.backoffLimitExceededWindow | string | `"5m"` | Rate window for BackoffLimitExceeded Job failures. |
| prometheusRule.enabled | bool | `false` | Create a PrometheusRule with Paperclip runtime alerts. |
| prometheusRule.labels | object | `{}` | Extra labels so a Prometheus `ruleSelector` can adopt it (e.g. `{release: kube-prometheus-stack}`). |
| prometheusRule.namespace | string | `""` | Namespace for the PrometheusRule. Empty renders it into the release namespace. |
| prometheusRule.processLostElevatedFor | string | `"10m"` | How long the elevated process_lost daily count must persist before warning. |
| prometheusRule.processLostLivenessNullWindowCount | int | `5` | Warn when the reaper gets more than this many null kube Job-status lists in 15m (blind-to-kube denominator guard: a low process_lost count is untrustworthy while this fires). |
| prometheusRule.processLostPageFor | string | `"2h"` | How long the high process_lost daily count must be sustained before paging. |
| prometheusRule.processLostPagePerDay | int | `40` | Page when process_lost reaps exceed this many per rolling 24h. |
| prometheusRule.processLostSignalBlindFor | string | `"15m"` | How long the reaper-blind-to-kube condition must persist before warning. |
| prometheusRule.processLostWarnPerDay | int | `20` | Warn when process_lost reaps exceed this many per rolling 24h (BLO-16184 numerator). |
| prometheusRule.unschedulableFor | string | `"15m"` | How long agent pods must stay Unschedulable before warning (transient blips self-resolve; this catches sustained starvation). |
| prometheusRule.unschedulablePodThreshold | int | `0` | Warn when more than this many ac-* agent pods are Unschedulable for unschedulableFor (node-pool scheduling starvation, BLO-16224). Reuses agentJobNameRegex to match agent pods. |
| prometheusRule.zeroTokenFor | string | `"2m"` | How long the zero-token streak condition must persist before firing. |
| prometheusRule.zeroTokenStreakThreshold | int | `3` | Alert when an agent has at least this many consecutive terminal runs with zero token usage. |
| rbac | object | `{"create":false}` | Namespace-scoped RBAC for the k8s-Job adapters. When `rbac.create: true`, the chart renders a Role + RoleBinding granting the SA permission to manage Jobs/Pods/Secrets/PVCs in this namespace, plus a ClusterRole + ClusterRoleBinding for SelfSubjectAccessReview (used by both adapters' install-time self-test). Only enable in tandem with `serviceAccount.automountToken: true`. |
| rbac.create | bool | `false` | Render Role/RoleBinding/ClusterRole/ClusterRoleBinding for the k8s-Job adapters. |
| resources | object | requests `500m/1Gi`, limits `2/4Gi`. | Container resource requests/limits. |
| runtimeCache | object | `{"enabled":true,"mountPath":"/runtime-cache","sizeLimit":"20Gi"}` | Pod-local cache storage for regenerable build/package/browser downloads. Keep durable identity/config state on `persistence.mountPath`; this emptyDir is safe to discard on pod restart. Rollback: set `enabled: false`, run a Helm upgrade, and restart affected Paperclip pods/jobs so they fall back to image/default cache paths. |
| runtimeCache.enabled | bool | `true` | Mount an emptyDir cache volume and point common cache env vars at it. |
| runtimeCache.mountPath | string | `"/runtime-cache"` | Mount path for the cache emptyDir. |
| runtimeCache.sizeLimit | string | `"20Gi"` | Optional emptyDir size limit. Set to empty string for no explicit limit. |
| runtimeConfig | object | `{"enabled":true,"mountPath":"/runtime-config","sizeLimit":"10Gi"}` | Pod-local XDG config storage for browser profile/config directories such as `google-chrome*`. Durable Paperclip identity/config remains on `persistence.mountPath`; this volume is intentionally ephemeral now that browser session source-of-truth is owned by authbot. Rollback: set `enabled: false`, run a Helm upgrade, and restart affected Paperclip pods/jobs so XDG_CONFIG_HOME falls back to the process default. |
| runtimeConfig.enabled | bool | `true` | Mount an emptyDir config volume and point XDG_CONFIG_HOME at it. |
| runtimeConfig.mountPath | string | `"/runtime-config"` | Mount path for the config emptyDir. |
| runtimeConfig.sizeLimit | string | `"10Gi"` | Optional emptyDir size limit. Set to empty string for no explicit limit. |
| secret | object | `{"agentJwtSecret":"","existingSecret":"","masterKey":""}` | Secret containing `agentJwtSecret` and optional `masterKey` seed. |
| secret.agentJwtSecret | string | `""` | JWT secret for the Paperclip agent. Only used when `existingSecret` is empty — avoid under GitOps (non-deterministic render). |
| secret.masterKey | string | `""` | Base64-encoded master key to seed `/paperclip/instances/<instanceId>/secrets/master.key` on first boot. Ignored if the file already exists on the PVC. Only used when `existingSecret` is empty. Leave empty to let Paperclip generate its own on first run. |
| service | object | `{"port":3100,"type":"ClusterIP"}` | Kubernetes Service exposing the HTTP UI/API. |
| service.port | int | `3100` | Service port. Must match `env.port`. |
| service.type | string | `"ClusterIP"` | Service type. Keep `ClusterIP`; cloudflared or Ingress handle external exposure. |
| serviceAccount | object | `{"annotations":{},"automountToken":false,"create":true,"name":""}` | Dedicated ServiceAccount for the pod. |
| serviceAccount.annotations | object | `{}` | Annotations on the ServiceAccount. |
| serviceAccount.automountToken | bool | `false` | Mount the SA token into the pod. Required when `rbac.create` is true so the k8s-Job adapters (paperclip-adapter-claude-k8s / -opencode-k8s) can authenticate to the K8s API. Default false to preserve the legacy posture. |
| serviceAccount.create | bool | `true` | Create a dedicated ServiceAccount. |
| serviceAccount.name | string | `""` | Name override. Defaults to the full release name when empty. |
| serviceMonitor | object | `{"enabled":false,"interval":"30s","labels":{},"namespace":"","path":"/metrics","scrapeAllowFromNamespaces":[],"scrapeTimeout":"10s"}` | Prometheus Operator ServiceMonitor for scraping the control-plane `/metrics` endpoint (BLO-8328). Requires the `monitoring.coreos.com/v1` CRDs (Prometheus Operator / kube-prometheus-stack). Disabled by default so the chart still installs on clusters without the operator. Enabling this also opens the NetworkPolicy scrape path when `scrapeAllowFromNamespaces` is set. |
| serviceMonitor.enabled | bool | `false` | Create a ServiceMonitor. Leave false on clusters without the Prometheus Operator CRDs. |
| serviceMonitor.interval | string | `"30s"` | Scrape interval. |
| serviceMonitor.labels | object | `{}` | Extra labels so a Prometheus `serviceMonitorSelector` can adopt it (e.g. `{release: kube-prometheus-stack}`). |
| serviceMonitor.namespace | string | `""` | Namespace for the ServiceMonitor. Empty renders it into the release namespace. |
| serviceMonitor.path | string | `"/metrics"` | Scrape path. Matches the control-plane `/metrics` route. |
| serviceMonitor.scrapeAllowFromNamespaces | list | `[]` | Namespaces of the Prometheus pods that scrape this Service. Appended to the NetworkPolicy ingress `from` (when `networkPolicy.enabled`) so scrapes are not blocked. Same shape as `networkPolicy.allowFromNamespaces`. Example: `[{namespaceSelector: {matchLabels: {kubernetes.io/metadata.name: monitoring}}}]`. |
| serviceMonitor.scrapeTimeout | string | `"10s"` | Per-scrape timeout. Must be `<=` `interval`. |
| tolerations | list | `[]` | Tolerations. |
| workerProbes | object | `{"liveness":{"failureThreshold":3,"httpGet":{"httpHeaders":[{"name":"Host","value":"127.0.0.1:3100"}],"path":"/healthz","port":"http"},"initialDelaySeconds":30,"periodSeconds":30,"timeoutSeconds":5},"readiness":{"failureThreshold":3,"httpGet":{"httpHeaders":[{"name":"Host","value":"127.0.0.1:3100"}],"path":"/healthz","port":"http"},"initialDelaySeconds":5,"periodSeconds":10,"timeoutSeconds":5},"startup":{"failureThreshold":30,"httpGet":{"httpHeaders":[{"name":"Host","value":"127.0.0.1:3100"}],"path":"/healthz","port":"http"},"periodSeconds":10,"timeoutSeconds":5}}` | Worker StatefulSet probe configuration. The worker serves the same `/healthz` endpoint as the API tier; probing HTTP prevents Kubernetes from routing API-to-worker requests before the worker is actually listening. |
| workerProbes.liveness | object | `{"failureThreshold":3,"httpGet":{"httpHeaders":[{"name":"Host","value":"127.0.0.1:3100"}],"path":"/healthz","port":"http"},"initialDelaySeconds":30,"periodSeconds":30,"timeoutSeconds":5}` | Worker liveness probe. |
| workerProbes.readiness | object | `{"failureThreshold":3,"httpGet":{"httpHeaders":[{"name":"Host","value":"127.0.0.1:3100"}],"path":"/healthz","port":"http"},"initialDelaySeconds":5,"periodSeconds":10,"timeoutSeconds":5}` | Worker readiness probe. |
| workerProbes.startup | object | `{"failureThreshold":30,"httpGet":{"httpHeaders":[{"name":"Host","value":"127.0.0.1:3100"}],"path":"/healthz","port":"http"},"periodSeconds":10,"timeoutSeconds":5}}` | Worker startup probe. |
