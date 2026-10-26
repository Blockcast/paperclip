# Agent configuration read model (`agent_config:read`)

Status: **descriptive**. Every claim below was read out of
`server/src/services/authorization.ts` and `server/src/routes/agents.ts` at the
commit that added this file, and the two live-seat readings in
["Measured confirmation"](#measured-confirmation) were taken against the
Penstock instance on 2026-10-26. Nothing here is aspirational.

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

`permissionForAction` (`services/authorization.ts:175`) maps an action to the
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
| 1 | `decideLowTrustAccess` (`:1181`, action list at `:1217`) | actor resolves to the low-trust review preset | **deny** `deny_low_trust_boundary`, unconditionally — preempts both paths below |
| 2 | `decideBase` (`:2794`) | `resource.type === "agent"` **and** `resource.agentId === actorAgentId` | **allow** `allow_self` |
| 3 | `decideWithAgentConfigReadGrant` (`:1957`) | actor holds `agents:configure`, else `agents:suggest-changes` | **allow** `allow_explicit_grant` |

A **board** (human) actor takes a different door entirely — company membership
is sufficient, at `routes/agents.ts:1014`
(`actorCanReadConfigurationsForCompany`) and its shared twin
`routes/authz.ts:189` (`actorCanReadAgentConfig`).

Path 3 is a read projection keyed on two *write* permissions. That reads as a
design smell and `PEN-4775` demoted it as a hypothesis for exactly that reason,
but it is deliberate and the suggest-tier half is tested: an agent preparing a
consented config diff must be able to read what it is diffing. The rule to
carry away is that **config read authority is implied by config change
authority**, in both the direct and the suggest tier.

## What does NOT imply it

`decideWithAgentConfigReadGrant` delegates to `decidePrincipalGrant`
(`:902`), and that function consults exactly two things: an **active
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
without a grant is `canCreateAgentsLegacy` (`:210`), and its reach is three
actions — `agents:create`, `tasks:manage_active_checkouts`,
`tasks:override_execution_stage` (`:2863`). It sits *below* the
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

The axis is **(viewer × subject × route)**, not any one of the three. The
detail route asks the per-subject question (`canReadSensitiveDetail = isSelf ?
true : ...`, `routes/agents.ts:3005`); the list route asked the company-wide
question once and applied the answer to every row, including the viewer's own.

**Masked is not the same as dropped, and only one of them is at issue here.**
On an allowed read the secrets are present-and-masked — `env` values as `***`,
an MCP `Authorization` header as `***REDACTED***` — by `redactAgentSecrets`
(`agent-redaction.ts:137`). The restricted projection
(`redactForRestrictedAgentView`, `routes/agents.ts:2250`) does not redact; it
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

## What this document does NOT decide

**Whether a peer's config should be company-readable at all is still open**, and
it is owned by `PEN-3206`. `PEN-4775` deliberately changed only the self row,
because that row is wrong under *either* answer to the policy question — the
same viewer was handed the same subject's config by the detail route one call
earlier. Everything in the peer column above is the behaviour as it stands, not
a ruling that it is correct.

If `PEN-3206` lands on "company-readable", the change belongs in
`decideWithAgentConfigReadGrant` or in the list route's peer arm, and this table
needs rewriting. If it lands on "not readable", the live gap it leaves is the
one `PEN-4775` §6 recorded: a seat holding `tools:manage_runtime` can **write**
a peer's `runtimeConfig` and cannot read it back to verify the write, and that
asymmetry then needs its own answer.

## Regression tests

- `server/src/__tests__/agent-permissions-routes.test.ts` — `company agent list
  keeps the viewer's own row (PEN-4775)`: self row populated, peer row `{}`,
  low-trust self row still `{}`, and the holder-of-the-grant path unnarrowed.
- `server/src/__tests__/agent-permissions-routes.test.ts` — `agent configuration
  read gate`: the `agents:suggest-changes` half of the implication.
- `server/src/__tests__/agent-secret-redaction.test.ts` — `agent metadata
  containment on the spread-based redactors`: both projections, including that
  the restricted one is reached via a **peer** row.
