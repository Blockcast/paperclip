# paperclip-plugin-alertmanager

Receives Alertmanager v2 webhook deliveries and turns firing alerts into
Paperclip issues with the right assignee, priority, and observability
drill-in links. Resolves issues when the alert clears.

Designed to ride the existing Slack DM-on-assign chain: the plugin populates
`assigneeUserId` on `ctx.issues.create`, the Slack plugin's existing
`issue.created` listener picks it up and DMs the assignee. No coupling
between Slack and AM in code.

See `docs/specs/2026-04-29-alertmanager-plugin-spec.md` for the full design.

## What it does

- Verifies the `Authorization: Bearer <token>` header on every webhook
  delivery (constant-time compare).
- Parses the AM v2 envelope, drops malformed / unsupported-version payloads
  with a 200 (so AM doesn't retry-storm).
- Deduplicates by `alert.fingerprint` per spec §5.3 — re-fires bump the
  state row and refresh the issue body, they don't create a second issue.
- Re-opens issues the plugin auto-cancelled on resolve when the same
  fingerprint re-fires (§8.3 option A). An issue closed by an *operator* while
  its alert was still firing suppresses re-opens instead — but only for
  `operatorSuppressionHours` (default 24h), after which a still-firing alert
  re-opens it with an explanatory comment. See "Operator suppression" below.
- Resolves issues per `autoCloseOnResolve`: either close the issue (status
  → cancelled) or post an `Alert resolved at <ts>` comment.
- Renders observability drill-in links (Grafana / Tempo / Pyroscope / Hubble
  / runbooks / Prometheus) from a fixed annotation-key allowlist, so a bad
  `PrometheusRule` can't smuggle hostile URLs into the issue body.
- Emits `plugin.alertmanager.alert.firing` and
  `plugin.alertmanager.alert.resolved` so sibling plugins (status pages,
  paging integrations) can subscribe.

## Configuration

Unresolved alert issues are checked once per minute and escalate through the
assigned agent's `reportsTo` chain, one rung per deadline interval. The first
deadline wakes the current owner; each subsequent full interval reassigns one
level up the chain, and an exhausted chain creates a board-owned
`[user-cover]` issue. Critical alerts default to 30 minutes and warnings to 240
minutes. Override these globally with `escalationDeadlineMinutes` or per route
with `issueRouteMap.<label>.<value>.escalationDeadlineMinutes`. Repeat firing
deliveries preserve ladder state; resolving an alert clears its schedule.

This uses a plugin job rather than core `executionPolicy.monitor`: the plugin SDK
does not expose monitor policy writes or a callback that can perform `reportsTo`
reassignment and user-cover creation.

Configured per-instance via the host's plugin settings UI. Schema lives in
`src/manifest.ts` (`instanceConfigSchema`).

| Key                  | Type    | Required | Notes |
|----------------------|---------|----------|-------|
| `defaultCompanyId`   | string  | no       | Company that receives alerts when no routing label is set. Defaults to the delivering company; must match it when set. |
| `webhookToken`       | string  | no       | Inline static bearer token for development. AM sends `Authorization: Bearer <token>`. |
| `webhookTokenRef`    | secret-ref | for production deliveries | Preferred production credential. The host verifies it without returning the value to the worker or consuming secret-resolution quota. Must point at a secret Paperclip wrote itself — see Security below. |
| `acceptOnlyLabels`   | object  | no       | Accept-only label filter, e.g. `{ paperclip: "true" }`. |
| `severityToPriority` | object  | no       | Override the default severity map. |
| `autoCloseOnResolve` | boolean | no       | Defaults to true (status → cancelled). Set false for comment-only. |
| `operatorSuppressionHours` | number | no  | How long an operator-closed issue mutes re-fires before the plugin re-opens it anyway. Defaults to 24, clamped to a 720h (30-day) ceiling. `0` = suppress indefinitely (pre-BLO-24234 behaviour). |
| `ownerMap`           | object  | no       | `{ <labelKey>: { <labelValue>: <email> } }`. |
| `fallbackAgentName`  | string  | effectively yes | Exact agent **name** assigned when nothing else resolves an owner. Missing, unmatched, or ambiguous config **fails closed**: the alert creates no issue and the delivery is retried. |
| `issueRouteMap`      | object  | no       | `{ <labelKey>: { <labelValue>: { projectId, goalId, assigneeAgentId, status } } }`. |

### Example `AlertmanagerConfig` YAML

```yaml
# Alertmanager-side — points AM at this plugin's webhook endpoint.
receivers:
  - name: paperclip
    webhook_configs:
      - url: https://paperclip.example.com/api/plugins/<instance>/webhooks/alertmanager
        send_resolved: true
        http_config:
          authorization:
            type: Bearer
            credentials_file: /etc/alertmanager/secrets/paperclip-token
route:
  receiver: paperclip
  group_by: [alertname, severity]
  repeat_interval: 4h
```

### Example plugin-side instance config (UI form values)

```yaml
defaultCompanyId: 11111111-1111-1111-1111-111111111111
webhookTokenRef: "<secret reference for the bearer token Alertmanager sends>"
acceptOnlyLabels:
  paperclip: "true"
severityToPriority:
  critical: critical
  warning:  high
  info:     medium
autoCloseOnResolve: true
ownerMap:
  class:
    paperclip_claude_k8s: support@blockcast.net
    paperclip_data_volume: support@blockcast.net
    physical_infra_proxmox: support@blockcast.net
    physical_infra_ceph: support@blockcast.net
    physical_infra_bmc: support@blockcast.net
    physical_infra_disk: support@blockcast.net
  team:
    platform:   alice@blockcast.net
    networking: ned@blockcast.net
issueRouteMap:
  class:
    physical_infra_proxmox:
      projectId: 9a6f627e-0f16-4b46-acc1-811acd1f548e
      goalId: 94c9f942-7067-4fde-a313-b3ee30d72f70
      assigneeAgentId: d2ade02d-112c-4da2-b61f-2301254a154c
      status: todo
    physical_infra_ceph:
      projectId: 9a6f627e-0f16-4b46-acc1-811acd1f548e
      goalId: 94c9f942-7067-4fde-a313-b3ee30d72f70
      assigneeAgentId: d2ade02d-112c-4da2-b61f-2301254a154c
      status: todo
    physical_infra_bmc:
      projectId: 9a6f627e-0f16-4b46-acc1-811acd1f548e
      goalId: 94c9f942-7067-4fde-a313-b3ee30d72f70
      assigneeAgentId: d2ade02d-112c-4da2-b61f-2301254a154c
      status: todo
    physical_infra_disk:
      projectId: 9a6f627e-0f16-4b46-acc1-811acd1f548e
      goalId: 94c9f942-7067-4fde-a313-b3ee30d72f70
      assigneeAgentId: d2ade02d-112c-4da2-b61f-2301254a154c
      status: todo
```

The bundled Blockcast plugin ships these `class` routes as defaults so fresh
deploys and plugin reinstalls keep alerts owned instead of unassigned. The
physical infrastructure routes were added for BLO-12202:

| Class | Default owner | Escalation policy |
|-------|---------------|-------------------|
| `paperclip_claude_k8s` | `support@blockcast.net` | Paperclip platform incident support queue. |
| `paperclip_data_volume` | `support@blockcast.net` | Paperclip shared storage support queue. |
| `physical_infra_proxmox` | `support@blockcast.net` | Physical infrastructure operations support queue for Proxmox node/API/cluster alerts. |
| `physical_infra_ceph` | `support@blockcast.net` | Physical infrastructure operations support queue for Ceph health/quorum/OSD alerts. |
| `physical_infra_bmc` | `support@blockcast.net` | Physical infrastructure operations support queue for iDRAC/BMC sensor and reachability alerts. |
| `physical_infra_disk` | `support@blockcast.net` | Physical infrastructure operations support queue for SMART/NVMe/RAID/disk-wear alerts. |

Alert rules must set `labels.class` to one of these exact values for the
shipped map to match. Instance config is merged on top, so operators can
override any shipped route or add more routes in the settings UI without
losing the default map for other classes. Use that override path when a site
has a narrower physical-infra owner than the broad support queue.

The plugin also ships default `issueRouteMap` entries for the four
`physical_infra_*` classes. Those entries create issues in the Blockcast
Physical Infrastructure Telemetry & Alerting project, link the CDN+ goal,
assign the Staff Engineer agent queue, and set the initial status to `todo`.
Owner-map email routes still exist for notification ownership, but the issue
route decides the project/goal queue when both maps match. A label
`paperclip_assignee_email` override still wins for one-off assignment
overrides; annotation overrides follow the existing owner-resolution chain
below.

### Owner resolution chain (§7.7)

First hit wins:

1. `alert.labels.paperclip_assignee_email` (explicit override)
2. `alert.annotations.paperclip_assignee_email` (explicit override)
3. `issueRouteMap[<label>][<value>].assigneeAgentId` / `.assigneeUserId`
4. `ownerMap[<label>][<value>]` matched against `alert.labels`
5. `fallbackAgentName` — the configured named agent
6. **fail closed** — no issue is created

Explicit label/annotation overrides outrank the route; the `ownerMap` does
not — a matching route wins over it.

Step 6 is deliberate. An ownerless alert issue is never routed to anyone, is
not woken on, and auto-cancels unattended (BLO-27435 / BLO-27436 / BLO-27438
all landed `assigneeAgentId: null` on 2026-08-17 and died that way), so the
plugin refuses to create one. Because that is a *configuration* fault rather
than a property of the alert, the delivery fails rather than being
acknowledged: Alertmanager keeps retrying and the alert survives until an
operator fixes `fallbackAgentName`. Watch `alertmanager.owner.fallback_failed`.

`fallbackAgentName` matches on the agent's name, case-insensitively after
trimming, and must match **exactly one** agent in the company. Zero matches
(wrong name) and more than one match (ambiguous) both fail closed.

Resolved emails are looked up against `ctx.users.findByEmail` and cached
per email in plugin state (`owner-by-email:<email>`). Negative results are
cached too (empty string) so a missing user doesn't cause repeated lookups.

### Issue creation floor and rule-level opt-out

Two gates keep low-value alerts from becoming issues:

- **`severity: info` creates no issue.** The gate is *creation-only* and runs
  after the re-fire branch, so an `info` issue that already exists (filed
  before this floor) still gets refreshed and still closes on resolve.
  Emits `alertmanager.webhook.below_issue_floor`.
- **`paperclip_issue: "false"`** — as a label *or* an annotation — suppresses
  the alert at **any** severity, before any issue or state side effect,
  on both the firing and resolved paths. Emits
  `alertmanager.webhook.issue_opt_out`.

Both are permanent policy decisions, so a failure to write their telemetry is
logged but does not fail the delivery — otherwise Alertmanager would redeliver
an alert that will be dropped identically every time. A non-string
`paperclip_issue` is refused rather than coerced
(`alertmanager.alert.malformed`).

### Severity → priority defaults

| Severity | Priority |
|----------|----------|
| critical | critical |
| warning  | high     |
| info     | medium   |
| (other)  | medium   |

### Observability drill-in links

The plugin renders these annotation keys (and the alert's `generatorURL`)
as a `### Drill in` markdown section in the issue body. Anything else
ending in `_url` is ignored.

| Annotation key   | Renders as |
|------------------|------------|
| `dashboard_url`  | Dashboard |
| `trace_url`      | Tempo trace |
| `profile_url`    | Pyroscope flamegraph |
| `logs_url`       | Loki / journal logs |
| `flow_query_url` | Hubble flow query |
| `runbook_url`    | Runbook |
| (alert.generatorURL) | Source query in Prometheus |

### Operator suppression, and what a re-fire does (BLO-24234)

Every re-fire of a known fingerprint takes exactly one of four branches. The
branch is decided by `decideRefire()` in `webhook-handler.ts` and each one emits
a distinct metric, so "the alert delivered but I see no issue" is answerable
from telemetry rather than by reading the issue body's `Started:` timestamp.

| Issue status at re-fire | `resolvedAt` in state | Outcome | Metric |
|---|---|---|---|
| open (any non-terminal) | — | refresh description | `alertmanager.firing.deduped` |
| `done` / `cancelled` | set (plugin closed it on resolve) | re-open → `todo` | `alertmanager.firing.reopened` |
| `done` / `cancelled` | null (**operator** closed it) — inside window | stay closed, stay quiet | `alertmanager.firing.suppressed` |
| `done` / `cancelled` | null — window expired | re-open → `todo` + comment | `alertmanager.firing.suppression_expired` |
| issue unreadable / deleted | — | leave state intact | `alertmanager.firing.issue_missing` |

`alertmanager.firing.deduped` is still emitted on **every** re-fire, so existing
dashboards keep working; the metrics above narrate what the re-fire actually did.

**Why the window exists.** Closing an alert issue by hand means "stop nagging
me", and the plugin honours that. But an unbounded mute is a footgun: a
fingerprint is `hash(sorted(labels))`, so a provider-agnostic alert such as
`LLMProxyHighErrorRate` re-uses **one** fingerprint across every future root
cause. Before this change, one operator closing a noisy issue muted that alert
permanently — the webhook kept delivering 200s, the state row kept updating, and
nothing was visible in any open-status view. That is the failure mode behind the
2026-08-08 investigation in BLO-23405/BLO-24234.

Suppression is anchored on the **first re-fire observed against the closed
issue**, not on the close itself (the plugin never sees the close), and the
anchor is not refreshed by later re-fires — otherwise the window would slide
forever and never expire. Closing the issue again after a re-open starts a fresh
window. Set `operatorSuppressionHours: 0` to restore the old unbounded mute.

Any other value is clamped to `MAX_OPERATOR_SUPPRESSION_HOURS` (720h / 30 days)
before it is converted to milliseconds. Rejecting only non-finite input is not
enough: the conversion multiplies by 3.6e6, so anything above ~5e301 overflows
to `Infinity` and `now - anchor >= Infinity` is never true — and a merely large
finite value (1e15 hours is ~1e11 years) never expires either. Both re-create
the unbounded mute this section exists to prevent, reachable through a config
typo rather than a code path. `0` stays the one explicit, documented way to ask
for indefinite suppression on purpose.

**Known asymmetry, deliberate:** if the state row is lost *and* the issue is
terminal, `recoverStateFromIssue()` declines to adopt it and a fresh issue is
filed instead. After a state loss the plugin cannot tell whether the close was
its own or an operator's, and for a paging system a visible duplicate is a safer
failure than an inherited mute.

## Security

- **Always set `webhookTokenRef` in production** (or `webhookToken` for local
  development). Without a token the
  webhook endpoint rejects every request — there is no "open" mode.
- **`webhookTokenRef` must point at a secret Paperclip wrote itself.**
  Authentication compares digests host-side, so it needs a digest of the secret
  VALUE. Paperclip stores one for secrets it created (`local_encrypted`, and
  provider-managed versions). A secret IMPORTED as an external provider
  reference — for example an existing AWS Secrets Manager ARN registered by
  reference — stores a fingerprint of the *reference* instead, and cannot be
  verified. Configure one of those and every delivery fails permanently:
  `onHealth()` reports `degraded` naming the company, and the worker logs
  `points at an external provider reference, which cannot be verified
  host-side`. Create the token as a Paperclip secret rather than importing it.
- **Anonymous floods are free, wrong-token floods are cheap.** A request with no
  `Authorization: Bearer` header is rejected before any host call, and
  verification is metered on its own budget rather than the secret-resolution
  budget — so neither can starve genuine deliveries of the resolution quota they
  need (BLO-20706, BLO-20738).
- **IP allowlist at ingress** as defense in depth. Alertmanager pods reschedule on
  restart and their pod IP changes; allowlist the namespace's pod CIDR
  rather than per-pod IPs.
- **mTLS is the V2 upgrade path** for stronger mutual auth (spec §11 Q4).
  Static bearer is V1 because it's the lowest-friction way to get rolling.
- The bearer credential config is read for the delivering company **per
  delivery** and is never written to plugin state or logs. Secret-ref values
  remain in the host process; the worker receives only the comparison result.
  A config update takes effect on the next request, and a restart can never leave
  the worker holding a stale (or absent) token.

### Config is resolved per delivery, per company

Plugin config is company-scoped, and `setup()` has no company context — so the
host hands every worker an **empty** bootstrap config, on single- and
multi-company instances alike (`plugin-loader.ts`: "Workers receive an empty
bootstrap config and must use `ctx.config.get(companyId)` at runtime"). On a
multi-company instance you will also see:

```
plugin-loader: multiple company configs; legacy bootstrap scope disabled  {configuredCompanyCount: 3}
```

`ctx.config.get()` with no argument therefore returns `{}`. Webhook deliveries
carry the host-selected `companyId`, and this plugin resolves both config and
bearer token from it per request (`src/config-scope.ts`).

There is deliberately **no fallback** to the `setup()` snapshot. The module
globals are only ever populated by `onConfigChanged`, which the host fires per
company without telling the worker which company it was — so they hold
"whichever company saved config last". Serving that to a different company's
delivery would check the request against the wrong tenant's bearer token and
then file the resulting issues under the wrong tenant's `defaultCompanyId`.

A company whose config cannot be read, or which has none stored, gets its
delivery **failed** (502), not dropped. Returning normally would make the host
record the delivery `success` and answer 200, which tells Alertmanager the alert
was accepted and stops it retrying — so a transient config-RPC blip would
destroy the alert rather than delay it. The one case that is still dropped is a
delivery carrying no `companyId` at all, because no retry can supply one.

The delivering company is also **authoritative over `defaultCompanyId`**. The
host chose that tenant by matching the endpoint key, so it is an authenticated
fact; the stored `defaultCompanyId` is an operator-typed string inside that
tenant's own row. When the row omits it, it is filled in from the delivering
company. When it names a *different* company, the delivery is failed rather
than honoured — otherwise the issue calls target a tenant outside this
invocation's scope, the host denies them, and `handleWebhook`'s per-alert catch
swallows the denial, producing a 200 with no issue filed anywhere.

### Alert state is scoped per company

The per-fingerprint dedup row lives in **company** scope
(`{scopeKind: "company", scopeId, stateKey: "alert:<fingerprint>"}` — see
`alertStateRef` in `src/constants.ts`), keyed on the company the tracked issue is
filed into.

It used to live in `instance` scope, shared by every tenant. Alertmanager
fingerprints are derived from alert labels, so two tenants running the same alert
rules routinely produce the *same* fingerprint: company B's firing delivery would
find company A's row and update/re-open A's issue instead of creating B's, and a
B resolution would close A's issue.

Rows written by an older build are read through and migrated into their owning
company's scope on first sight, gated on the row's own `paperclipCompanyId` — so
a row is only ever adopted by the company whose issue it actually tracks.

**If you are writing another plugin, do not resolve credentials in `setup()`.**
Doing so fails in a way that hides itself: saving config fires
`onConfigChanged` and re-hydrates the cached value, so the fault disappears the
moment you touch config and returns at the next worker restart with no config
change to blame. Diagnosed in BLO-20049, where it rejected 100% of alert
deliveries with `502 unauthorized` while the stored config was perfectly valid;
it then recurred twice more (BLO-20467) for a combined ~3h15m of dead alerting.

Known limitation: the `check-alert-escalations` sweep still reads those module
globals, so it sweeps exactly one company — whichever saved config last — and
stays idle after a restart until an `onConfigChanged` supplies a scope. Both are
logged when they happen rather than failing silently. Fixing it properly needs a
host API to enumerate a plugin's configured companies, which `PluginConfigClient`
does not expose today (BLO-20595). Delivery is unaffected.


### Bearer rotation in a Kubernetes deployment

In a typical onprem-k8s deployment the bearer value lives in three places
that all have to move together. Skipping any one of them strands a stale
copy that either fails auth or drifts silently. Use this order to avoid a
gap where Alertmanager presents the new value but the plugin still verifies
the old one (or vice versa):

1. Generate the new bearer (`openssl rand -base64 32`).
2. Patch the K8s `Secret` Alertmanager mounts as `credentials_file`. In
   the Blockcast/onprem-k8s layout this is
   `monitoring/alertmanager-receivers` key `bearer-token`. AM picks up the
   change automatically on its next config reload (`POST /-/reload` if
   you want to force it).
3. Update the plugin instance config `webhookToken` to the same new value.
   The worker reads company config on each webhook delivery, so no worker
   restart is required.
4. (Defense in depth) Patch the second K8s `Secret`
   `paperclip/paperclip-alertmanager-webhook-token` so the env-driven
   `autoConfigureAlertmanagerFromEnv` bootstrap helper can re-seed a
   fresh deploy. Holds the same value as step 2; keep them in lockstep.
5. Verify with a synthetic AM webhook delivery:
   ```sh
   kubectl -n paperclip exec paperclip-0 -- wget -qS -O- \
     --header="Authorization: Bearer $NEW_TOKEN" \
     --header="Content-Type: application/json" \
     --post-data='{"version":"4","status":"firing","alerts":[{"status":"firing","labels":{"alertname":"BearerRotationProbe","severity":"info"},"annotations":{},"startsAt":"...","endsAt":"0001-01-01T00:00:00Z","fingerprint":"rotation-probe-1"}]}' \
     http://127.0.0.1:3100/api/plugins/paperclip-plugin-alertmanager/webhooks/alertmanager
   ```
   Expect `HTTP 200` with `{"status":"success"}`.

## Build and test

```sh
pnpm --filter paperclip-plugin-alertmanager typecheck
pnpm --filter paperclip-plugin-alertmanager test
pnpm --filter paperclip-plugin-alertmanager build
```
