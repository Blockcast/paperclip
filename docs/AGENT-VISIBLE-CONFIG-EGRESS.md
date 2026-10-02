# Agent-visible egress of structured config/env data

**PEN-3701.** Carved out of PEN-2370 ask 3: *"fix the invariant, not the instance."*

PEN-2370's instance — the Kubernetes read path returning `spec.containers[].env[].value` in the
clear — is closed and verified. This document answers the open question behind it: **is every
agent-visible surface that can return structured config/env data covered, or only the one that was
reported?**

Measured against `master` @ `103b7f5` (2026-09-29), enumerated 2026-10-02.

---

## Scope, stated precisely

**"Agent-visible"** means reachable by an *agent seat* — an actor with `req.actor.type === "agent"`,
or an MCP tool seeded into a running agent's `.mcp.json`. This is the load-bearing filter and it
does most of the work:

- `assertBoard` / `assertBoardOrgAccess` / `assertCanAccessInstanceEnvironments` all reject an agent
  outright (`server/src/routes/authz.ts:31` — `if (req.actor.type !== "board") throw forbidden`).
  Routes behind them are **out of scope here**, however much config they return.
- `assertCompanyAccess` (`authz.ts`) explicitly admits agents for their own company. Routes behind
  it **are** in scope.
- `assertCompanyPermission` (`routes/access.ts`) admits an agent **conditionally**, if it holds the
  named permission key. In scope, with the condition stated.

A surface being out of scope here is not a statement that it is well-designed — only that it is not
*this* row's question. Several are flagged below anyway, because a reader of this table will
otherwise assume they were checked and found clean.

**"Structured config/env data"** means `agents.adapterConfig`, `agents.runtimeConfig`,
`agents.metadata`, `projects.env`, `routines.env`, environment/custom-image config, adapter plugin
config, tool-connection config, or any env binding (`{type:"plain",value}` / `secret_ref` /
`user_secret_ref`).

---

## 1. Kubernetes MCP read path — the PEN-2370 instance

Scrubber: `packages/mcp-gateway/src/response-scrub.ts`, single enforced exit at
`packages/mcp-gateway/src/server.ts:664` (`writeResponse` → `scrubResponseBody`).

Coverage is **structural on the response body**, dispatched on shape (JSON-RPC or SSE), not on tool
name or Kubernetes verb — so it applies to every kind carrying the probe shapes, including the pod
templates inside Deployment / StatefulSet / Job / CronJob, and to `SecretList` items.

| tool | returns | verdict |
|---|---|---|
| `pods_get`, `pods_list`, `pods_list_in_namespace` | pod spec `env[].value`, `command`, `args`, `last-applied-configuration` | **covered** |
| `resources_get`, `resources_list` | any kind, incl. `Secret` `data`/`stringData` | **covered, except ConfigMap** |
| `pods_log` | container stdout | **not covered** — plain text, trips no probe |
| `nodes_log` | kubelet / `/var/log/*` | **not covered** — same |
| `events_list` | event messages | **not covered** — same |
| `nodes_top`, `pods_top`, `nodes_stats_summary`, `namespaces_list` | metrics only | n/a |

The ConfigMap exemption is **deliberate and already documented at the source**
(`response-scrub.ts:91-97`): *"Residual risk accepted, explicitly: a ConfigMap used to carry a
credential is still returned in the clear."* Not re-litigated here.

The three log/event gaps are unstructured-text surfaces, a different control class from this row's
subject (structured config). Recorded, not filed — a text scrubber on `pods_log` is a separate
design question with its own false-positive cost.

> **Scope boundary that no static audit can close.** An agent's effective MCP set is
> `{...sharedSeedBaseline, ...adapterConfig.mcpServers}` (`vendor/paperclip-adapter-claude-k8s/src/server/job-manifest.ts:1404`).
> The override half lives in the **database**, and the documented use is swapping `k8s-ro` for a
> higher-privileged `ns-rw`/`k8s-admin` upstream dialled **directly, with no gateway hop**
> (`server/src/__tests__/mcp-seed-scrub-coverage.test.ts:39-45`). A row edit can therefore add an
> unscrubbed Kubernetes upstream while every test in this repo stays green.

## 2. Other seeded MCP upstreams — already enumerated and filed

`server/src/__tests__/mcp-seed-scrub-coverage.test.ts` is an existing, authoritative,
test-enforced classification of all 7 seeded upstreams. **This row does not duplicate it.** Of the
7: `k8s-ro` is gateway-scrubbed; `paperclip` and `github` are stdio (not proxied); and four are
classified `unscrubbed` with a ticket each — `prometheus` (PEN-2735), `tempo` (PEN-2737), `linear`
(PEN-2736), `gbrain` (PEN-2428).

PEN-2735 is worth calling out as **the same material as PEN-2370 by a different route**: Prometheus
`activeTargets[].discoveredLabels` is pre-relabel, so it carries
`__meta_kubernetes_*_annotation_kubectl_kubernetes_io_last_applied_configuration` — the annotation
whose whole content is inline env values, and which the k8s gateway masks by name. Already filed;
not re-filed here.

## 3. Paperclip HTTP API — agent-reachable routes

The canonical redactors are `server/src/redaction.ts` (`redactAgentConfigPayload`,
`redactEventPayload`, `maskWorkspaceRuntimeForRead`, `maskWorkspaceRuntimeTextForRead`,
`sanitizeRecord`, `redactRunResultJson`, `redactSensitiveText`) plus
`routes/project-env-response.ts` (`maskProjectEnv`/`maskEnvBindings`) and
`services/plugin-config-masking.ts`.

| surface | route(s) | redactor | verdict |
|---|---|---|---|
| agent list / detail / me | `routes/agents.ts:895, 2738, 2741` | `redactAgentSecrets`, `redactForRestrictedAgentView` | covered |
| agent configuration + config revisions | `agents.ts:2843, 3018, 3031, 3047` | `redactAgentConfiguration`, `redactRevisionSnapshot` | covered |
| agent mutations (create/patch/pause/…) | `agents.ts:3476, 4134, 4160…4347` | `redactAgentSecrets` | covered |
| project list / detail / patch / delete | `routes/projects.ts:145, 153, 229, 295, 726` | `publicProject` → `maskProjectEnv` (`workspace-response.ts:728`) | covered |
| workspace runtime + operations | `routes/workspace-response.ts`, `execution-workspaces.ts` | `maskWorkspaceRuntime{,Text}ForRead` | covered |
| issue detail / heartbeat context | `routes/issues.ts:8011-8230` | `maskWorkspaceRuntime*`, `compactIssueExecutionWorkspace` | covered |
| run logs / events / run results | `agents.ts:5207, 5338`, `issues.ts:5002` | `redactEventPayload`, `redactSensitiveText`, write-time `sanitizeRunLogChunkForStorage` | covered (write-time; see note) |
| approvals | `routes/approvals.ts:561…958` | `redactApprovalPayloadForDisplay`, `withholdAgentConfigFromApprovalPayload` | covered |
| plugin config | `routes/plugins.ts:2687, 2866` | `maskPluginConfigJson` | covered |
| activity | `routes/activity.ts:163` | `sanitizeRecord` | covered |
| **company export bundle — agent `adapterConfig`** | `routes/companies.ts:256, 319, 330` | `redactPortableAgentRecord` → `redactAgentConfigPayload` | covered |
| **company export bundle — `inputs.env.*.default`** | same | shared `isSensitiveEnvKey` + `isPlausiblySensitiveEnvValue` | **covered as of PEN-3701** (was a local substring denylist) |
| **routine list / detail / revisions** | `routes/routines.ts:155, 202, 212, 458, 502, 630` | `maskProjectEnv` on `detail.project` **only** | **NOT COVERED** → PEN-3707 |
| **pipeline stage automation env** | `routes/pipelines.ts:1057, 1290` | none on `automation.env` | **NOT COVERED** → PEN-3707 |
| invite / join-request adapter defaults | `routes/access.ts:4377, 4391, 4539, 4587` | none | **NOT COVERED**, conditional on an agent holding `users:invite` / `joins:approve` → PEN-3707 |

### Run-log note

`sanitizeRunLogChunkForStorage` (`services/log-chunk-sanitizer.ts:32`) runs on the **write** path;
the read route applies no second pass. Bytes written before that sanitizer shipped, or by a path
bypassing it, are returned as stored. Stated for completeness — this is the known design, not a new
finding.

## 4. Out of scope — board-gated, verified gate by gate

Each of these returns structured config and has **no redactor**, and each is unreachable from an
agent seat. Verified individually, not assumed:

| surface | gate |
|---|---|
| `PATCH /agents/:agentId/budgets` → full agent row (`routes/costs.ts:446`) | `assertBoard` |
| secret-provider configs ×6 (`routes/secrets.ts`) | `assertBoard` |
| tool connections ×5 (`routes/tool-access.ts`) | `assertBoard` + `tools:admin` |
| MCP gateway auth/header policy ×3 (`routes/tool-gateway.ts`) | `assertBoard` + `tools:admin` |
| instance settings `general`/`experimental` (`routes/instance-settings.ts`) | `assertBoardOrgAccess` |
| environment create/patch/delete, leases, custom-image sessions (`routes/environments.ts`) | `assertCanAccessInstanceEnvironments` |

`routes/costs.ts:446` deserves a line of its own even though it is out of scope. It returns the full
`agents` row with `adapterConfig` and no redactor, which is a direct deviation from the invariant
`redactAgentSecrets`'s own docblock states (`routes/agents.ts:2298`): *"Every response that
serializes an agent MUST go through here… Adding an agent-serializing route without one of them
reopens this hole."* The hole that docblock describes as fixed was, historically, **a budget-only
PATCH**. It is board-gated, so it is not an agent-visible egress — but it is the same shape as the
bug it cites, one file over. Filed on PEN-3707 as a lower-severity item.

## 5. Known blind spot

`agents.metadata` is a `jsonb` column outside every agent redactor: `redactAgentSecrets`
(`agents.ts:2301`) and `redactForRestrictedAgentView` (`agents.ts:2241`) both begin `{...agent}` and
rewrite only `adapterConfig`/`runtimeConfig`, so metadata crosses verbatim on ~13 agent exits. Note
the asymmetry — `redactAgentConfiguration` and `redactRevisionSnapshot` *do* handle it, so this is
specific to the two spread-based helpers.

Whether `agents.metadata` is credential-bearing in practice was **not** determined. It is recorded
here as an unresolved question rather than a finding, on PEN-3707.

---

## What this enumeration does not claim

- It covers the **repository**. Four seeded MCP upstreams are third-party services whose own
  responses this repo cannot scrub; they are filed separately (§2).
- The per-agent `adapterConfig.mcpServers` override axis is database-resident and cannot be
  enumerated from a checkout (§1).
- Surfaces listed as covered were verified by reading the redactor to its call site. Surfaces listed
  as not covered were verified by reading the handler to its response. Where a verdict could not be
  reached, it says so rather than guessing.
