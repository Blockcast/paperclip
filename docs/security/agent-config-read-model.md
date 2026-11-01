# Agent configuration read model (`agent_config:read`)

Status: **descriptive**, with one ruling recorded as such. Every claim below was
read out of `server/src/services/authorization.ts` and
`server/src/routes/agents.ts` at the commit that added this file, and the two
live-seat readings in ["Measured confirmation"](#measured-confirmation) were
taken against the Penstock instance on 2026-10-26. The withheld-is-not-absent
signal and the `tools:manage_runtime` strike were re-read at source on
2026-11-01 (`PEN-5230`). Nothing here is aspirational.

Code is cited **by symbol name, never by line number**. The first draft of
this file carried line anchors and five of them did not point at what they
named, already at the commit that added the file — that same commit inserted
the explanatory comments above those symbols and pushed them down. Grep for
the symbol instead.

This document exists because `adapterConfig` and `runtimeConfig` have now been
the subject of four incidents in the `PEN-2370` door series — `PEN-2747`
(door #8), `PEN-2839` (door #10, the same two fields returned **unredacted**),
`PEN-3139` (door #16), and `PEN-4775` (this one, the same two fields returned
as `{}` for a viewer entitled to them) — and in each one the first hour went
to re-deriving which principal fact gates the read. It is written down once
here so the fifth reader does not have to.

## The short answer

> `agent_config:read` is a **virtual action, never a stored grant**. An agent
> reaches it on exactly two paths: the subject **is** the actor, or the actor
> holds `agents:configure` **or** `agents:suggest-changes` in the subject's
> company. Nothing else implies it — not `role`, not `reportsTo`, not
> `permissions.canCreateAgents`, not `permissions.canCreateSkills`.

## Why "never a stored grant" is the load-bearing part

`permissionForAction` (`services/authorization.ts`) maps an action to the
`permission_key` that the generic grant fallback at the bottom of `decideBase`
will look up. For `agent_config:read` it returns `null`:

```ts
if (action === "agent_config:read" || action === "agent_config:update" || action === "skill_config:update") {
  return null;
}
```

So there is no row anyone can be given that spells `agent_config:read`, and
searching a principal's grant list for that string will always come back empty
— for the CEO seat exactly as much as for a seat that is being denied. That
null result is not evidence of anything, and reading it as evidence is what
sent `PEN-4775` looking for an implication rule keyed on `role` or on org-root.

## The two allow-paths, in evaluation order

`decideBase` reaches them in this order for an **agent** actor:

| Order | Where | Condition | Result |
| --- | --- | --- | --- |
| 1 | `decideLowTrustAccess` | actor resolves to the low-trust review preset | **deny** `deny_low_trust_boundary`, unconditionally — preempts both paths below |
| 2 | `decideBase`, its `if (input.action === "agent_config:read")` branch | `resource.type === "agent"` **and** `resource.agentId === actorAgentId` | **allow** `allow_self` |
| 3 | `decideWithAgentConfigReadGrant`, called from that same branch | actor holds `agents:configure`, else `agents:suggest-changes` | **allow** `allow_explicit_grant` |

A **board** (human) actor takes a different door entirely — company membership
is sufficient, via `actorCanReadConfigurationsForCompany`
(`routes/agents.ts`) and its shared twin `actorCanReadAgentConfig`
(`routes/authz.ts`).

Path 3 is a read projection keyed on two *write* permissions. That reads as a
design smell and `PEN-4775` demoted it as a hypothesis for exactly that reason,
but it is deliberate and the suggest-tier half is tested: an agent preparing a
consented config diff must be able to read what it is diffing. The rule to
carry away is that **config read authority is implied by config change
authority**, in both the direct and the suggest tier.

## What does NOT imply it

`decideWithAgentConfigReadGrant` delegates to `decidePrincipalGrant`,
and that function consults exactly two things: an **active
membership** row, and a stored **grant** row for the named `permission_key`
(plus a scope check). It never loads `role`, `reportsTo`, or `permissions`.
Therefore none of the following gates this action, and a difference in them
between two seats is a coincidence rather than a cause:

- `role: "ceo"` vs any other role
- `reportsTo: null` (org root) vs reporting to someone
- `permissions.canCreateAgents`
- `permissions.canCreateSkills` / the `skills:create` grant — that grant is
  consulted for `skill_config:update`, never for this action

The one place in the file where `role === "ceo"` **does** confer authority
without a grant is `canCreateAgentsLegacy`, and its reach is three
actions — `agents:create`, `tasks:manage_active_checkouts`,
`tasks:override_execution_stage`. It sits *below* the
`agent_config:read` branch in `decideBase`, so that branch has already
returned before control could reach it. A CEO seat that can read peer config
does so because it holds `agents:configure`, not because it is the CEO.

### Measured confirmation

Penstock, 2026-10-26, read from `GET /api/agents/:id` → `access.grants`:

| Seat | `agents:configure` | `agents:suggest-changes` | peer config read |
| --- | --- | --- | --- |
| `Ceo` (9 grants) | **held** (granted 2026-07-19) | not held | populated |
| `Cto` (7 grants) | not held | not held | `{}` |

The two seats also differ in `role`, `reportsTo`, `permissions.canCreateAgents`
and the `skills:create` grant. Per the section above, those four differences
are not causal; the `agents:configure` row is.

## The route matrix

`adapterConfig` / `runtimeConfig` as returned to an **agent actor that does not
hold the implication**, with the subject in the same company:

| Route | Subject | Before `PEN-4775` | After |
| --- | --- | --- | --- |
| `GET /api/agents/me` | self | populated, secrets masked | unchanged |
| `GET /api/agents/:id` | self | populated, secrets masked | unchanged |
| `GET /api/agents/:id` | peer | `{}` | unchanged |
| `GET /api/companies/:id/agents` | self | **`{}`** | **populated, secrets masked** |
| `GET /api/companies/:id/agents` | peer | `{}` | unchanged |

### The withheld-is-not-absent signal (`PEN-5230`)

`{}` is a legal **stored** value for both columns, so every `{}` in the table
above was ambiguous: a reader could not tell "this agent has no runtime config"
from "you are not entitled to see it". That ambiguity was misread at least
twice, once by the `Ceo` seat, and cost each reader an own-id positive control
to resolve.

The restricted projection now labels itself. Every response that reaches
`redactForRestrictedAgentView` — i.e. every `{}` row in the peer lines above,
on **both** routes — carries:

| Field | Value | Is a fact about |
| --- | --- | --- |
| `withheldFields` | `["adapterConfig", "runtimeConfig"]`, always both | the projection |
| `withheldByAction` | `"agent_config:read"` | the **reader**'s missing entitlement |

Both are module constants (`WITHHELD_AGENT_CONFIG_FIELDS` /
`WITHHELD_AGENT_CONFIG_ACTION`, `routes/agents.ts`), never computed from the
stored value. `withheldFields` names both columns unconditionally rather than
only the populated ones, so the pair discloses **zero bits** about the subject
— which is what makes the signal disclosure-neutral rather than a one-bit
widening. Do not "improve" it into a `hasAdapterConfig` / `hasRuntimeConfig`
presence bit: the list route returns one row per seat, so a per-subject bit
there is a company-wide map of which seats carry a heartbeat override.

The markers appear on the restricted arm **only**. Their absence beside a `{}`
is therefore itself the signal that the `{}` is real, so a client reads
`{}`-with-no-marker as genuinely empty. Declared optional on the shared `Agent`
interface (`packages/shared/src/types/agent.ts`), which both `AgentDetail` and
the list row extend.

This matches the idiom the codebase already applies to strictly more sensitive
material: `hasWorkspaceRuntimeConfig` beside the withheld blob for
`workspace_runtime:read` (`PEN-3206` §2), and `withheldFields` on the approval
card from `withholdAgentConfigKeys`. The agents route had been the
weaker-signalling projection guarding the lesser secret.

The axis is **(viewer × subject × route)**, not any one of the three. The
detail route asks the per-subject question (`canReadSensitiveDetail = isSelf ?
true : ...` in `routes/agents.ts`); the list route asked the company-wide
question once and applied the answer to every row, including the viewer's own.

**Masked is not the same as dropped, and only one of them is at issue here.**
On an allowed read the secrets are present-and-masked — `env` values as `***`,
an MCP `Authorization` header as `***REDACTED***` — by `redactAgentSecrets`
(`agent-redaction.ts`). The restricted projection
(`redactForRestrictedAgentView`, `routes/agents.ts`) does not redact; it
replaces both objects wholesale. `PEN-2839` was a failure of the first
mechanism, `PEN-4775` of the second, and a fix to either is not a fix to the
other.

Note also that the strip is **narrow**: `budgetMonthlyCents` and
`spentMonthlyCents` pass through the restricted projection untouched. Whatever
the peer rule is for, it is not a general "peer-sensitive data" rule.

### Archaeology

The restricted projection and the company-wide gate that feeds it both arrived
together in `c09037ffa` (2026-02-19, the original agent-hiring commit) and the
two later commits that touched the symbol — `f261e43eb` (2026-07-30,
`BLO-18969`) and `62423987d` (2026-10-03, `PEN-3726`) — changed neither the
gate nor the per-row application. The suspicion raised on `PEN-4775` §7.3 that
the over-strip arrived with `PEN-2839` or `PEN-3139` is therefore **false**;
the self-row drop was present from the day the projection was written.

## The policy question is SETTLED, and it was never `PEN-3206`'s

**`PEN-5228` ruled: KEEP THE WITHHOLD.** A peer's `adapterConfig` /
`runtimeConfig` stay unreadable to an agent actor that does not hold the
implication. The ground is that `agent_config:read` and `agent_config:update`
are governed by the identical grant pair (`agents:configure` or
`agents:suggest-changes`), so a non-holder's `{}` is the read side matching the
write side rather than an over-correction. The peer column of the table above
is now a ruling, not merely the behaviour as it stands.

⚠️ **This row is NOT `PEN-3206`, and earlier revisions of this file said it
was.** That pointer is what the parent row was opened to correct. `PEN-3206`
ruled on `project_workspaces.metadata.runtimeConfig` behind
`workspace_runtime:read` — a different column, a different gate and a different
projection that merely shares a name. Its §2 is still cited here, but only as
the *precedent for the withheld-is-not-absent signal*, never as the owner of
this question. Conflating the two has cost readers twice.

`PEN-4775` deliberately changed only the self row, because that row was wrong
under either answer — the same viewer was handed the same subject's config by
the detail route one call earlier. `PEN-5230` then added the signal above,
which is disclosure-neutral: it returns no config byte that was withheld before
it.

### The `tools:manage_runtime` asymmetry is struck, not live

`PEN-4775` §6 recorded a gap that would follow from the "not readable" ruling:
a seat holding `tools:manage_runtime` can **write** a peer's `runtimeConfig`
and cannot read it back to verify the write. **That gap does not exist.**
Re-checked at source on `PEN-5230` and independently confirmed in review:
`tools:manage_runtime` has four non-test call sites — `tool-gateway.ts` × 3 via
`assertBoardPermission`, and `tool-access.ts` via `assertBoardToolPermission`.
Both helpers call `assertBoard(req)` first and then check a **`user`**
principal, and the string occurs zero times in `services/authorization.ts`. No
agent-actor route exercises it, so no agent seat can reach the write half. The
asymmetry needs no answer because it has no holder.

## Regression tests

- `server/src/__tests__/agent-permissions-routes.test.ts` — `company agent list
  keeps the viewer's own row (PEN-4775)`: self row populated, peer row `{}`,
  low-trust self row still `{}`, and the holder-of-the-grant path unnarrowed.
- `server/src/__tests__/agent-permissions-routes.test.ts` — `agent configuration
  read gate`: the `agents:suggest-changes` half of the implication.
- `server/src/__tests__/agent-secret-redaction.test.ts` — `agent metadata
  containment on the spread-based redactors`: both projections, including that
  the restricted one is reached via a **peer** row.
- `server/src/__tests__/agent-permissions-routes.test.ts` — ``the peer `{}`
  says it was withheld (PEN-5230)``: the markers on both routes, their
  **absence** for a grant holder and on the self row, that no config byte
  widened, and that they cannot be PATCHed back onto the agent row.
  Its disclosure-budget case asserts the populated and the genuinely-empty
  subject return **byte-identical bodies** — whole-body equality, not a list of
  named fields, because a named-field comparison let a `hasRuntimeConfig`
  presence bit through while claiming to catch it.
