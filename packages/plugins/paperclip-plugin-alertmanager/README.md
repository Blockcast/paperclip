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
- Drops firing `severity=info` alerts before issue or state mutation and honors
  `paperclip_issue: "false"` at every severity.
- Assigns the configured exact `fallbackAgentName` when owner and issue-route
  resolution find nobody. Missing or ambiguous fallback configuration fails
  closed instead of creating an ownerless issue.
- Deduplicates open issue creation by alertname and optional
  `paperclip_dedupe_domain`. A database unique index makes concurrent first
  deliveries attach to one winner.
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

## Recovering an interrupted aggregate delivery

The aggregate lifecycle fence intentionally fails closed: if the worker stops
after it claims a fence but before it finishes the delivery, later firings and
final resolution wait until an operator releases that exact fence.

Two phases hold a fence this way, and both are recoverable here:

| held phase | left behind by | token to release it |
| --- | --- | --- |
| `firing` | an interrupted firing delivery | `firing_token` |
| `cancelling` | an interrupted terminal transition | `resolution_token` |

Both are reported by the listing route as `phase`, with the token to use in
`firingToken` regardless of which column it came from. `active` and `finalizing`
never block a firing claim, so neither ever needs recovery.

### Recognising the wedge

A firing claim refused by a live holder is **not** a wedge, and is no longer
reported as a failure. Contention is routine: the fence is keyed on the creation
identity, so every alert sharing an alertname contends for one fence by design.
A refused claim is retried in-process with jittered backoff for a few seconds
(PEN-3013), and the common case is absorbed silently. A delivery that had to
wait says so, at info:

```
Alertmanager aggregate <key> was held by a concurrent delivery; claimed it
after <n> attempt(s) over <ms>ms instead of failing the delivery.
```

Only once that budget is spent does the delivery fail, with:

```
Alertmanager aggregate <key> is held in phase '<firing|cancelling>' by a
delivery in progress; retrying firing delivery. A fence abandoned by a dead
process is released automatically by its slot's next worker; if this persists,
the holder is either live or in another slot, and an operator can release it via
the plugin's recover-aggregate-firing route.
```

The failure is per-alert, but one held aggregate fails the whole delivery batch
so Alertmanager retries it — which is why a single wedged key can stall all
webhook alert delivery. The wait budget is spent at most once per aggregate key
per delivery, not once per alert: the first alert to exhaust it marks that key,
and the rest of the batch fails fast rather than each waiting in turn. So a
wedged fence delays a delivery by roughly one budget, not by one per alert — a
batch of 10 costs seconds, not tens of seconds. A fence abandoned by a dead
process now self-clears via its slot's next worker (BLO-31036), so a *sustained*
failure means the holder is live or in another slot.

**Do not diagnose this from
`alertmanager_notifications_failed_total{integration="webhook"}`.** It undercounts
and cannot witness the fault: Alertmanager increments it only when a
notification's retry budget is *exhausted*, not per failed request, so a request
that fails and is later retried successfully leaves no trace at all. Measured on
PEN-2988, 14 HTTP 502s inside 40 seconds produced **zero** counter movement — a
flat counter is fully compatible with a continuously-failing handler. Diagnose at
the HTTP layer (502s at the webhook route) and from the handler logs above. Note
that `paperclip_plugin_error` also stays `0` throughout: the plugin is running and
healthy at the lifecycle level, and is failing per alert.

The fence listing
(`GET /api/plugins/$PLUGIN_ID/api/aggregate-firing-fences?companyId=...`) is
`board-or-agent` and company-scoped. Recovery
(`POST /api/plugins/$PLUGIN_ID/api/aggregate-firing-fences/recover`) stays
board-only. The board examples below use a Paperclip board token in
`PAPERCLIP_BOARD_TOKEN` (a browser session cookie can be used instead). Keep that
token in the environment, never in the command itself.

1. List the currently held fences. The response is sensitive and is
   marked `Cache-Control: no-store`; only an authenticated board user or agent
   of the requested company can read it. A board caller gets each fence with
   `aggregateKey`, `phase`, `updatedAt`, `ownerInstanceId`, `ownerSlot` and
   `firingToken`. An agent caller gets the same fields, but the handler omits
   `firingToken`, so an agent can diagnose a fence but cannot recover it.

   ```sh
   curl --fail --silent --show-error \
     -H "Authorization: Bearer $PAPERCLIP_BOARD_TOKEN" \
     "$PAPERCLIP_URL/api/plugins/$PLUGIN_ID/api/aggregate-firing-fences?companyId=$COMPANY_ID"
   ```

   An agent reads the same route with its own run credentials:

   ```sh
   curl --fail --silent --show-error \
     -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
     "$PAPERCLIP_API_URL/api/plugins/$PLUGIN_ID/api/aggregate-firing-fences?companyId=$PAPERCLIP_COMPANY_ID"
   ```

   An agent that finds a wedged fence escalates to a board operator for step 2,
   because it never receives `firingToken`.

   Board only: copy the `aggregateKey` and its matching `firingToken` from the
   response. The token is bearer-equivalent; do not put it in tickets, chat,
   shell history, or logs.

2. Release that exact token through the board-only recovery route.
   The response contains only whether the compare-and-set matched; it never
   returns the token.

   Keep the token out of shell history by reading it without echo and piping a
   generated JSON body to curl:

   ```sh
   read -r -s FIRING_TOKEN
   printf '\n'
   jq -n \
     --arg companyId "$COMPANY_ID" \
     --arg aggregateKey "$AGGREGATE_KEY" \
     --arg firingToken "$FIRING_TOKEN" \
     '{companyId: $companyId, aggregateKey: $aggregateKey, firingToken: $firingToken}' \
   | curl --fail --silent --show-error \
     -H "Authorization: Bearer $PAPERCLIP_BOARD_TOKEN" \
     -H 'Content-Type: application/json' \
     -X POST \
     "$PAPERCLIP_URL/api/plugins/$PLUGIN_ID/api/aggregate-firing-fences/recover" \
     --data-binary @-
   unset FIRING_TOKEN
   ```

   A result of `{"recovered":true}` means the exact fence was released.
   `{"recovered":false}` means the token was stale, already recovered, or
   replaced by a later firing; obtain a fresh listing before retrying. Recovery
   activity records the company, aggregate key, and result, but never the
   token.

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
| `fallbackAgentName`  | string  | conditionally | Exact agent name used when no mapped owner or issue route resolves. Ownerless creation is refused if this is missing or ambiguous. |
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
fallbackAgentName: Alert Triage
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

1. `alert.labels.paperclip_assignee_email`
2. `ownerMap[<label>][<value>]` matched against `alert.labels`
3. `alert.annotations.paperclip_assignee_email`
4. the exact configured `fallbackAgentName`

If no mapped user, issue-route assignee, or unique fallback agent resolves, the
delivery emits `alertmanager.owner.fallback_failed` and creates no issue.

Resolved emails are looked up against `ctx.users.findByEmail` and cached
per email in plugin state (`owner-by-email:<email>`). Negative results are
cached too (empty string) so a missing user doesn't cause repeated lookups.

#### Retrofitting an owner onto an alertname that is already firing (BLO-40764)

**An open issue with no agent can be re-routed without closing it.** Add the
annotation (or the `ownerMap` entry) and the next delivery applies it. An open
issue that already holds an agent cannot — and that includes every row the
plugin itself assigned from `fallbackAgentName` (or an `issueRouteMap` agent)
at creation, which is most rows created since ownerless creation was refused.
Reassign those in Paperclip.

Until BLO-40764 the chain above ran on the **creation** path only. One alertname
owns one aggregate issue for as long as that issue is open — and "open" includes
`backlog`, so a row parked for alert fatigue counts — which meant a correct,
deployed `paperclip_assignee_email` was silently inert for the life of that row.
Nothing surfaced it from either side: the rule read as configured, and the row
read as merely stale. `RelayAtsProbeBRed`/`CRed` spent 6 days that way.

Every delivery now re-reads the chain and applies the result, on **two** narrow
conditions:

- **Only an explicitly configured owner retrofits** — the label override, the
  `ownerMap`, and the annotation override. The `issueRouteMap` and the
  `fallbackAgentName` legs are deliberately *not* consulted on re-fire: those
  resolve for nearly every alert, so including them would mass-reassign every
  legacy ownerless row on its next delivery.
- **An existing `assigneeAgentId` is never overwritten**, and a resolved *user*
  is applied only to a row with no assignee at all. A row that is user-assigned
  but agent-null can still gain an agent — it has no wake path, which is the
  defect being fixed — but a deliberate reassignment, by a human or an agent, is
  left alone. To hand a row to a different agent, reassign it in Paperclip; the
  plugin will not fight you for it.

A row an operator closed is also left alone while its close is still suppressing
re-opens (see *Operator suppression* below) — assigning an owner there would be
the same resurrection by a side door.

Each applied retrofit logs (naming the agent or user it applied) and emits
`alertmanager.owner.retrofitted`, labelled by `alertname` only. If you add an
annotation and that counter never moves for its alertname, check, in order:

- the row already holds an agent — most often the `fallbackAgentName` agent the
  plugin stamped at creation — which a retrofit never overwrites (see above);
- an earlier link in the chain (a `paperclip_assignee_email` *label*, or an
  `ownerMap` entry matching one of the alert's labels) is shadowing your value.

### Issue creation floor and rule-level opt-out

Two gates keep low-value alerts from becoming issues at all:

- **`severity: info` creates no issue.** The gate is *creation-only* and runs
  after the re-fire branch, so an `info` issue that already exists (filed
  before this floor) still gets refreshed and still closes on resolve.
  Emits `alertmanager.webhook.below_issue_floor`.
- **`paperclip_issue: "false"`** — as a label *or* an annotation — suppresses
  the alert at **any** severity. Like the floor, the gate is *creation-only*: it
  suppresses the **firing** path entirely (no issue created, no existing one
  refreshed, no state written, no suppression anchor banked) but deliberately
  lets the **resolved** path through. Emits
  `alertmanager.webhook.issue_opt_out`.

A third gate suppresses *actionability* rather than creation:

- **`severity: none` is filed terminal and unowned.** This is the heartbeat
  band — Prometheus' `Watchdog` (`vector(1)`) is its only member and fires
  forever by design. The row is kept because it is the only live evidence the
  in-cluster delivery leg accepts POSTs, but an alert that can never resolve
  must not carry an owner: an assigned row that can never legitimately close
  recirculates through agent assignment and `stranded_assigned_issue` recovery
  forever. So the issue is created — and on every re-fire kept — `done` with no
  assignee, and owner-map / `issueRouteMap` resolution is skipped entirely. No
  escalation-ladder exemption is needed: `none` maps to no
  `escalationDeadlineMinutes`, so `nextEscalationAt` is already `null`.

  `done` rather than unowned-`todo` on purpose. Heartbeat selection is by
  assignee, so both are inert — but an ownerless `todo` row is
  indistinguishable from a stranded issue on every triage surface, and this one
  would be re-minted on every fire, forever. A terminal row is honestly
  terminal.

  Unlike the two gates above, this one is **not** creation-only: every re-fire
  re-clears the assignee on the issue, the state record, *and* the emitted
  firing event. A creation-only guard would leave rows filed before the policy
  — and any row something later assigns — stuck in the loop, which is the same
  one-shot patch as unassigning by hand. The re-fire also bypasses
  `decideRefire`: that helper reads any `done` row as an *operator* close
  (BLO-24234) and would mute the fingerprint for the suppression window, then
  re-open it as `todo` when the window expired — re-manufacturing exactly the
  actionable row this gate exists to prevent. A terminal close is the plugin's
  own doing, so there is no operator intent to honour.

  The terminal set is a constant (`TERMINAL_SEVERITIES`), deliberately not a
  config key: a configurable list is what would make a plugin-closed `done` row
  ambiguous with an operator close, and `none` has exactly one member here.

Letting resolve through is what keeps the opt-out from wedging the issues it was
added to silence. Gating it too would mean `handleResolved` never runs for an
opted-out rule, so `state.resolvedAt` would stay `null` and the issue would
never reach a terminal status — and `advanceIssueLadder` returns early only on
`resolvedAt`, `escalationComplete`, or a terminal issue status. The escalation
sweep would keep climbing the ladder, waking agents, and eventually file a
`[user-cover]` board escalation for a rule that was explicitly opted out and
whose alert had already resolved. That is the normal adoption path, not an edge
case: operators opt a rule out *because* it has already been filing noisy
issues, so a tracked issue usually exists at that moment.

This does not weaken the guarantee for a rule opted out from the start: with no
issue ever filed there is no state row, and a resolved delivery for an unknown
fingerprint is dropped without touching anything.

Both are permanent policy decisions, so a failure to write their telemetry is
logged but does not fail the delivery — otherwise Alertmanager would redeliver
an alert that will be dropped identically every time. A non-string
`paperclip_issue` is refused rather than coerced
(`alertmanager.alert.malformed` with `label: paperclip_issue`). The same metric
also counts an ignored `paperclip_priority` under `label: paperclip_priority`,
which drops nothing — filter on `label` before reading the series as lost
alerts.

### Severity → priority defaults

| Severity | Priority |
|----------|----------|
| critical | critical |
| page     | critical |
| warning  | medium   |
| info     | medium   |
| ticket   | low      |
| (other)  | medium   |

`info` remains explicit for compatibility, but the firing creation floor runs
first, so it creates no new issue. Accepted `critical`, `warning`, and custom
severities continue through this mapping.

`warning → medium` is deliberate and is the BLO-20576 change. `warning` is the
fleet's dominant severity — 698 of 993 post-ship issues — and 84.6% of its
aged cohort auto-cancelled when the alert cleared on its own, against 76.0%
for `critical`. A band that is mostly self-resolving and accounts for 70% of
volume cannot also be the second-highest priority without debasing the scale
for every other source: at the time BLO-20576 was filed this one plugin held
51 open `critical` and zero `medium`/`low`. `medium` keeps the issue
dispatchable and inbox-visible; `low` would not, because a `low` row falls off
the 500-row inbox page on a deep lane (BLO-39015).

Two overrides, in precedence order:

1. **`paperclip_priority` alert label or annotation** — per-rule escape
   hatch, read from the same surfaces as `paperclip_issue` and
   `paperclip_dedupe_domain` (the label wins when both are set). A rule whose
   warnings genuinely are not self-resolving declares that on itself, next to
   its own `severity`, instead of dragging the whole band up:

   ```yaml
   - alert: CephFsCapacityCritical
     labels:
       severity: warning
       paperclip_priority: high
   ```

   The value is validated against `critical`/`high`/`medium`/`low`
   (case-insensitive, trimmed). Anything else is ignored and the severity map
   applies — an unrecognised value must not reach `issues.create` and fail the
   whole delivery, and a `PrometheusRule` is not a trusted enough surface to
   pass straight through to the API. A non-string value (an unquoted YAML
   number or bool) is ignored on the same path rather than thrown on; the
   envelope type-guard deliberately does not validate label entries, so
   calling a string method on one would fail the whole batch and make
   Alertmanager redeliver into the same crash.

   An ignored value is **not silent**: it logs a `warn` naming the value and
   the resolved fallback, and counts `alertmanager.alert.malformed` with
   `label: paperclip_priority`. A typo
   like `paperclip_priority: hgih` would otherwise be indistinguishable from
   an absent label, on the one surface whose entire purpose is overriding a
   default. The alert is still filed — unlike a malformed `paperclip_issue`,
   which drops it, because that label decides whether an issue exists at all.

   The value prices a **newly created** issue only. An alert that joins an
   already-open aggregate issue for its alertname leaves that issue's priority
   alone — rewriting it would also overwrite an operator's manual
   re-prioritization. Adding the label to a rule that is firing right now
   therefore takes effect on the next issue filed for that alertname, once the
   open one closes; re-prioritize the open issue by hand if it cannot wait.

   An alert with **no** `severity` label resolves under the key `unknown`, so
   an operator's `severityToPriority: { unknown: … }` entry applies to it.
2. **`config.severityToPriority`** — operator-wide remap of a severity.

### Aggregate creation identity

The canonical creation key is
`alert-aggregate:v1:[<alertname>,<paperclip_dedupe_domain-or-null>]` and is
stored in `originFingerprint`. Without an explicit domain, distinct label sets
for one alertname converge on one open issue. Set `paperclip_dedupe_domain` as a
label or annotation when a rule intentionally needs separate resource domains.

The host enforces one open row per company and aggregate key with
`issues_active_alertmanager_aggregate_creation_uq`. The plugin also takes a
short-lived aggregate creation claim before calling issue creation so concurrent
losers re-check for the winner instead of reaching external identifier
allocation. Each attached fingerprint is tracked in
`alertmanager_aggregate_members`; resolving one member closes the shared issue
only after the last unresolved sibling clears. Same-fingerprint re-fires that
point at an older terminal issue rebind to the current active aggregate winner.

### Channel precision policy

**Cancellation rate is not the precision metric. Do not use it.** The resolve
path writes `status: "cancelled"` whenever `autoCloseOnResolve` is left at its
default `true` (`webhook-handler.ts`, `constants.ts`), so *every alert that
fires and then clears normally produces a cancelled issue*. "Cancellation
rate" is approximately "fraction of alerts that self-resolved", and no healthy
channel drives it below the 73.6% baseline BLO-20576 was filed against —
measured over the 14 days to 2026-10-08 it was **96.5% of terminal rows while
the channel demonstrably improved**. The threshold originally written here was
unfalsifiable; this replaces it.

**Intended precision, and the three measures that can actually move:**

1. **Ownership — target 100%, currently met.** Zero issues created with no
   agent and no user owner. Last ownerless row was 2026-09-11; the fail-closed
   fallback in `owner-resolver.ts` is what holds this. A regression here is a
   defect, not noise: an unassigned `todo` has no wake path at all.
2. **Priority distribution — target: `critical` + `high` below 50% of created
   rows.** Was 100% at filing, 90.1% in September. This is the measure the
   `warning → medium` change targets; on the September mix it moves ~70% of
   volume out of `high`. `critical` stays reserved for `severity: critical`
   and `severity: page`.
3. **Creation volume per continuously-firing series — target: flat.** An alert
   firing for a week should hold one issue, not seven. Dedupe by aggregate key
   and fingerprint is what holds this; a rise means dedupe is leaking, which
   is a plugin bug.

**What we do when precision is missed.** Each measure has a different owner
and a different remedy, and conflating them is what produced two years of
"the alerting is too noisy" with nothing actionable attached:

- Ownership regressions and volume-per-series regressions are **plugin bugs**.
  File against this package.
- A priority distribution that stays top-heavy after this change is an
  **alert-rule labelling problem**, not a plugin problem — the plugin files
  what the rule declares. The remedy is re-labelling the offending rules at
  source, or opting them out with `paperclip_issue: "false"`. The eight rules
  that produced 156 of the 302 cancelled `warning → high` rows in the
  2026-10-04 cohort (`AlloyWedgeHealerJobFailed`, `PodPodInitializingStuck`,
  `HeadscaleRouteStateDrift`, `HarborPinGuardJobFailed`,
  `PodContainerCreatingStuck`, `CephFsMountUnhealthy`,
  `PaperclipControlPlaneContainerRestarted`,
  `PaperclipApiOldestMissingCommitAge`) are self-healing conditions; a
  `*JobFailed` alert for a healer that retries and succeeds should not file an
  issue at all.
- **A self-resolving condition should auto-resolve and never become an
  issue.** BLO-20576 named this as "legitimate and probably better" and the
  data supports it for exactly that class. The mechanism already exists
  (`paperclip_issue: "false"` plus the `info` floor); what is missing is its
  application to those rules, which is rule config and lives with the owning
  team, not here.

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

| Issue status at re-fire | Closed by the plugin? | Outcome | Metric |
|---|---|---|---|
| open (any non-terminal) | — | refresh description | `alertmanager.firing.deduped` |
| `cancelled` | yes — `pluginClosedAt` set | re-open → `todo` | `alertmanager.firing.reopened` |
| `cancelled` with `pluginClosedAt` **absent** | unknown — legacy row, or an aggregate member whose close a sibling landed; falls back to `resolvedAt` | re-open → `todo` | `alertmanager.firing.reopened` |
| `done`, or `cancelled` with `pluginClosedAt: null` | no (**operator** closed it) — inside window | stay closed, stay quiet | `alertmanager.firing.suppressed` |
| as above — window expired | no | re-open → `todo` + comment | `alertmanager.firing.suppression_expired` |
| issue unreadable / deleted | — | leave state intact | `alertmanager.firing.issue_missing` |

**Authorship is recorded, not inferred (BLO-31736).** That middle column used to
read `resolvedAt in state`, and the code matched it. It was wrong: `resolvedAt`
says only *"the alert last cleared"*, which is also true when the resolve path's
terminal guard **declined** to close an issue an agent had already closed by
hand. So a deliberate `done` was read as "the plugin closed this", re-opened to
`todo` on the next re-fire, and cancelled by the resolve after it — once per
fire/clear cycle, indefinitely, ending in a plugin-authored `cancelled` that
looks like a normal auto-close on every triage surface. It also made the
suppression row above unreachable for any alert that had *ever* resolved, i.e.
every flapping alert — precisely the ones operators close by hand.

`pluginClosedAt` is now written only on the branch where the plugin's own
`cancelled` patch actually landed, and cleared by any firing delivery that
observed the issue's status. Two details worth knowing when reading the table:

- **`done` is never a close of ours.** The plugin's only status writes are
  `todo` and `cancelled`, so a `done` row was always dispositioned by someone
  else — true even for state rows written before this field existed.
- **An absent `pluginClosedAt` means authorship is unknown**, and falls back to
  `resolvedAt`. Two rows land there: one written before the field existed, and
  one belonging to an **aggregate** whose close this member deferred to a
  sibling. The second case is why the record cannot simply be `null` when our
  own cancel did not land here: `pluginClosedAt` is per-fingerprint, but the
  close it records happens to the aggregate's *shared* issue, and only the last
  member to resolve lands it. A non-last member that kept asserting `null` read
  its own aggregate's close as an operator close and muted the next genuine
  recurrence.
  The fallback is asymmetric on purpose: reading our close as an operator's
  would *mute a live recurring alert* for a whole window, while the reverse
  costs one unwanted re-open. Legacy rows drain on their first firing — even
  one whose issue read fails: that write records what the fallback would have
  concluded and still clears `resolvedAt`, which is also the escalation sweep's
  bail-out and must not stay set against a firing alert.

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


### Concurrent writers of one alert-state record (BLO-20650)

Two independent paths mutate the same `alert:<fingerprint>` row, and both are
read-modify-writes: the **inbound webhook** (firing, re-fire, resolve) and the
**`check-alert-escalations` sweep** (hold, rung advance, chain exhausted).

They are not symmetric, and the fix follows that asymmetry:

- The **webhook is authoritative.** It is reporting what Alertmanager says is
  true right now, so it writes unconditionally and always wins.
- The **sweep is speculative.** It reads the record, then spends several awaits
  — `listComments`, `agents.get`, and on the cover rung an entire issue
  creation — before writing `{ ...state, ... }` back. Every field it did not
  intend to change rides along stale.

The field that made this expensive is `resolvedAt`. A resolve landing inside
the sweep's window was silently reverted to `null`, so the ladder advanced a
rung on an alert that had already cleared — and *stayed* wrong, because nothing
re-derives a resolution once it has been overwritten. The observable cost is a
page, a reassignment, and eventually a `[user-cover]` row for an incident that
is over.

Every sweep-side write now passes `ifMatch` to `ctx.state.set`, a
compare-and-swap added to the plugin SDK for this
(`PluginStateClient.set(..., { ifMatch })`). The host applies the write only
while the stored value is still exactly the one the sweep read, and performs
the comparison and the write in **one** `UPDATE` statement — so unlike a
re-read immediately before the write, there is no window left for the webhook
to land in. `value_json` is `jsonb`, so the comparison is structural equality
on the normalized document and needed no schema change.

A refused swap is a **normal outcome, not an error**: the webhook won, and the
sweep abandons the rung and re-decides on the next tick against fresh state.
Rejection is raised with `code: "state_precondition_failed"` (distinct from
`fencing_generation_lost`, which answers "am I still the owner?" rather than
"is my read still current?"), and the sweep logs it at `info`. Crucially the
swap sits **ahead of** the rung's user-visible effects, so losing it aborts
before anyone is paged rather than after.

The chain-exhausted rung is the one exception to that ordering, and it is
compensated rather than reordered. Its cover issue is deliberately created
*before* the swap: claiming the state first would write
`escalationComplete: true`, which the guard at the top of every later sweep
short-circuits — so a `createCover` that then failed would leave the alert
never covered at all, silence exactly where a board escalation belongs. A
resolve winning the swap at that point would otherwise leave the cover open
with an unresolved member, since the resolve's own cascade ran before the cover
existed. The sweep therefore re-reads the winning record and, if it resolved
the alert, runs the cover cascade itself
(`recordSourceResolvedAndCloseCovers`). That is idempotent by construction and
only cancels a cover whose every member has resolved, so a storm-batched
sibling that is still firing keeps the cover open. The "chain exhausted"
comment sits behind the swap, so a **refused** swap posts no announcement for
an alert that has already cleared. A swap that **succeeds** in that same window
still can: the resolve is mid-delivery and has not stored `resolvedAt` yet, so
the rung reads the alert as firing and posts "while alert remains firing" on
the source issue. The cover is still closed by the resolve's post-commit
cascade below, so the announcement is the only residue.

That compensation only fires when the swap is **refused**, which left one more
interleaving open (BLO-33497). The webhook's cover cascade ran *before* it
stored `resolvedAt`, so a resolve could cascade while the cover did not yet
exist — nothing to mark — and then store `resolvedAt` only *after* the sweep's
swap had already succeeded. The swap succeeding means no compensation runs, and
no later resolve will ever cascade into that cover again: an open
`[user-cover]` with an unresolved member, for an alert that has cleared,
permanently.

The obvious repair — move the cascade behind the state write — is wrong, and
the existing tests say so. `ctx.state.set` is the delivery's **commit point**,
and every side effect is deliberately sequenced ahead of it so that a failure
leaves `resolvedAt` unwritten and the retry redoes the lot. Moving the cascade
past it swaps a concurrency orphan for a failure orphan: a cascade that throws
would leave a record asserting the alert is over with its cover uncleaned.

So `handleResolved` cascades **twice**, and the two calls answer different
failures:

- **ahead of the commit point** — makes cover cleanup a precondition of
  recording the resolution. A throwing cascade aborts the delivery with nothing
  recorded.
- **behind the commit point** — catches a cover that did not exist yet when the
  first call ran. A swap that *succeeds* means the sweep read, created its cover
  and claimed all before the commit, so by the time the second call runs the
  cover is there to be closed.

Between them there is no window: the sweep compensates the refused-swap half,
and the post-commit cascade covers the succeeded-swap half. The second call is
close to free — `recordSourceResolvedAndCloseCovers` early-returns when the
alert never joined a cover (the common case), re-marking is
`COALESCE(resolved_at, now())`, and the close is a single-UPDATE claim only one
caller can win. If it throws, the delivery still fails and the retry's
pre-commit cascade closes the cover, which by then exists.

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
