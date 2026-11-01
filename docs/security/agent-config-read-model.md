# Agent configuration read model (`agent_config:read`)

Status: **descriptive**. Every claim below was read out of
`server/src/services/authorization.ts` and `server/src/routes/agents.ts` at the
commit that added this file, and the two live-seat readings in
["Measured confirmation"](#measured-confirmation) were taken against the
Penstock instance on 2026-10-26. Nothing here is aspirational.

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

**Before proposing a change, a grant, or a scoping decision in this family,
read [Settled calls](#settled-calls) and [What this document does NOT
decide](#what-this-document-does-not-decide).** The first records the questions
in this family that have already been ruled on; the second records the one that
is still open and who owns it. Neither is derivable from the code, so a reader
who skips them can re-open a settled question without knowing it is settled —
which happened twice in one day, on 2026-11-01, to the author of this file, on
rows that same author had closed.

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

## Settled calls

Everything above this section is **mechanism**: what the code does, checkable
against the code. This section is **policy**: questions in this family that
have been asked and answered, with the standing answer and the condition that
would justify re-opening one.

The two fail differently, which is why they are separated. A stale code fact
announces itself — the symbol moved, the test changed, the reader can go and
look. A settled call goes stale only when someone decides it has, and a reader
with no record of the decision cannot tell a settled question from an open one.
The `{}` that sends a reader here is operational and urgent; the ruling that
governs it is neither, and is therefore the half that gets re-litigated.

There is a third case, and it is the one that bit this section twice on the day
it was written: **a policy statement with a mechanism claim buried inside it.**
A refusal shelved as a ruling can rest on "the only way to get X is Y", which is
a checkable fact about `decideBase` — and the first draft of this section rested
on one that was false when it was written. Filed under policy, nobody checks it;
filed under mechanism, a reviewer finds it in one pass, which is exactly what
happened. So: **when a settled call rests on a fact about the code or on a row
id, cite the symbol or the row inline**, so the next reader checks it the way
they would check any mechanism claim. A ruling that cites nothing is
unfalsifiable, and in this file that is a defect rather than a convenience.

| Question | Standing answer | Ruled | Re-open only on |
| --- | --- | --- | --- |
| May a seat be granted `agents:configure` in order to obtain a peer config **read**? | **No.** | `Ceo`, 2026-11-01, `PEN-5218`; amended the same day | The successor row (below) defining a **read-only** action — not a fresh grant request |
| May a seat be granted `agents:suggest-changes` in order to obtain a peer config **read**? | **No.** It is the lesser door and it reaches the same read (`decideWithAgentConfigReadGrant`), but it fails on the same first reason, and on a structural one. | `Ceo`, 2026-11-01, `PEN-5218` | The successor row concluding that the suggest tier is the right interim mechanism — its call to make, not an ad-hoc grant |
| Should `budgetMonthlyCents` / `spentMonthlyCents` get a control of their own, given they pass the restricted projection untouched? | **No.** No control is manufactured for them. | `Ceo` on `PEN-4775`; re-affirmed 2026-11-01 on `PEN-5218` | A measured harm, or a successor-row ruling that moves the projection these fields ride through |
| Who decides whether peer config is company-readable? | The **successor row** to `PEN-3206` (below), owned by Security Engineer since 2026-11-01 — deliberately not the seat that wants the read, not an ad-hoc proposal on whichever operational row hit the `{}`, and deliberately not the `Ceo` either, who declined to take it as part of the same separation. | `Ceo`, 2026-11-01, `PEN-5218` | — |
| How does a seat obtain a peer's `runtimeConfig` or `adapterConfig` value in the meantime? | **Ask the `Ceo`, naming the single field in advance; the `Ceo` reads that field and posts that field.** Not the object — see the exposure below. One hop, audited in the issue thread, no standing grant. This is the supported path, not a workaround. | `Ceo`, 2026-11-01, `PEN-5218`; narrowed the same day | A successor-row ruling |

The "Re-open only on" column is **derived from the rulings, not quoted from
them**: the standing answers are the `Ceo`'s words, the conditions are this
file's reading of what would make each one stop applying. Contest them here
rather than treating them as a quotation.

### Why both doors are refused

**First reason — the peer config read is not a clean read today, and this
applies identically to both permissions.** A reader who passes the gate is
served by `redactAgentSecrets` (`agent-redaction.ts`), not by the restricted
projection. `canReadSensitiveDetail` on the detail route selects between them,
and for a peer it delegates to `actorCanReadConfigurationsForCompany`, which —
for an **agent** actor — is just `agent_config:read` evaluated against the
company. So `allow_explicit_grant` from *either* permission lands on
`buildAgentDetail` without `restricted`, which is the `redactAgentSecrets`
arm.
`redactAgentSecrets` masks `adapterConfig.env` values and routes the rest
through `containAgentConfig` → `redactAgentConfigPayload`, whose coverage is
structural — plain bindings, `env` maps at any depth, Tier-1 key names,
URI-embedded credentials, JWT-shaped strings. A bare command string under an
innocuous key matches none of those rules and survives; that module's own
header says so. So `adapterConfig.workspaceStrategy.provisionCommand` and
`.teardownCommand` reach an entitled reader **unmasked** (`PEN-5225`,
2026-11-01). Those strings are handed to a shell, and `FOO_TOKEN=… ./deploy.sh`
is an ordinary idiom. Granting *any* peer-config read capability today
therefore also hands over host-executed command strings that may carry inline
credentials. That is a confidentiality exposure rather than a proportionality
question, which is why it refuses both doors with one argument. `PEN-5225`
masks it at source; until that ships, this reason stands on its own.

**Second reason — proportionality, and it is specific to `agents:configure`.**
Per [the implication rule](#why-never-a-stored-grant-is-the-load-bearing-part),
config read is implied by config **change** authority, and
`decideWithAgentConfigReadGrant` accepts **two** tiers of it: `agents:configure`
and, failing that, `agents:suggest-changes`. Granting the first to obtain a read
means handing a seat standing authority to rewrite every seat's `runtimeConfig`
and `adapterConfig` in the company, which is not a proportionate price for one
audit read. This reason does **not** carry the suggest tier: that tier is the
consented-diff tier, not rewrite authority, and an earlier draft of this section
claimed config read was implied "by nothing else" than `agents:configure` — a
mechanism claim, false against `decideBase`, contradicted four screens above by
[the short answer](#the-short-answer) and [the allow-path
table](#the-two-allow-paths-in-evaluation-order). It is struck. A proportionality
argument is an exhaustiveness claim with a judgment on top; the judgment half
cannot be checked by a reader, so the exhaustiveness half must be.

**Third reason — structural, and it is what refuses the suggest tier on its own
merits.** A read obtained through a change permission is precisely the category
error the open question exists to resolve. Making that workaround *standing*
lowers the pressure to fix it properly, and the fix is a read-only action.

Neither refusal is foreclosure. If the successor row concludes the suggest tier
is the right interim mechanism, that is its call. What is declined here is
deciding it ad hoc from an operational row. Anyone proposing either grant **as a
route to a read** should expect this answer.

One claim that is *not* load-bearing here and used to be stated as though it
were: the budget fields ride the same projection, but that is the
["the strip is **narrow**" note](#the-route-matrix) at the end of the route
matrix, not the route matrix itself — the table says nothing about budget
fields, and the earlier draft cited the wrong paragraph for it.

### Check whether telemetry answers it before asking for the read

A seat that hits the `{}` usually wants a peer's **effective** behaviour, and
the configured value is only one way to get at it. The effective value is often
observable directly, and an inference from telemetry is not a weaker answer —
it measures what is actually happening rather than what is configured to.

`PEN-5218` established the Engineer seat's effective concurrency ceiling as a
hard 3 with the config read unavailable throughout: `running_count` held flat
at 3 across nine consecutive samples spanning 85 minutes while `queued_count`
never reached 0 and head-of-line age climbed monotonically to 3588 s. A
demand-limited seat drains to 0 between arrivals; this one did not, so the
flat line was a ceiling rather than a coincidence of arrivals. The configured
value, supplied afterwards by the `Ceo` under the interim rule above — the
single field `heartbeat.maxConcurrentRuns`, named in advance and posted on its
own — was 3, since raised to 5 on that row. The inference was correct and the
read would have added nothing to it.

Two habits from that row are worth carrying:

- **Run a positive control before claiming you cannot observe something.** The
  same `paperclipGetAgent` call against the viewer's own id returns the full
  `runtimeConfig.heartbeat`. That is what distinguishes redaction from absence,
  and without it `{}` is equally consistent with "no such config".
- **Say which claims rest on telemetry.** `PEN-5218` stated that it was not
  quoting `runtimeConfig` as proof of the cap's value. That is what let the
  measurement stand on its own when the grant was refused, instead of the whole
  row blocking on a read it never actually needed.

## What this document does NOT decide

**Whether a peer's config should be company-readable at all is still open.**

It was routed to `PEN-3206` on 2026-11-01 and **that routing was wrong.** There
are two different columns called `runtimeConfig`, and `PEN-3206` owns the other
one:

| | `PEN-3206`'s subject | this document's subject |
| --- | --- | --- |
| column | `project_workspaces.metadata.runtimeConfig` | `agents.runtime_config` |
| route | `GET /projects/:id/workspaces` | `GET /api/agents/:id` |
| gate | `workspace_runtime:read` | `agent_config:read` |
| projection | `publicProjectWorkspace` | `redactForRestrictedAgentView` (ungranted) / `redactAgentSecrets` (granted) |

`PEN-3206` ruled **narrow** on its own question and closed `done` on
2026-11-01. It never owned this one, and a pointer to it from this section
would be worse than no pointer: this is the section whose job is to tell a
reader where the question lives, and a wrong address there terminates the
search instead of continuing it.

The question is re-carried by a **successor row**, filed against
`agents.runtime_config`, owned by Security Engineer, with the scope `PEN-3206`
was given: a recommendation plus an implementation row, and **no unilateral
application** — a narrowing goes to the `Ceo`, who approves it directly; a
widening goes to the `Ceo` **first** and then to the board, because the `Ceo`
is the step at which a widening gets refused cheaply.

> **Successor row: [`PEN-5228`](https://paperclip.blockcast.net/PEN/issues/PEN-5228)**,
> filed 2026-11-01T21:50Z, owned by Security Engineer. Every "successor row"
> reference in [Settled calls](#settled-calls) resolves here, and this is the
> only place in this file the id appears — so if this question is ever
> re-routed again, one line changes and no reference goes stale behind it.

`PEN-4775` deliberately changed only the self row,
because that row is wrong under *either* answer to the policy question — the
same viewer was handed the same subject's config by the detail route one call
earlier. Everything in the peer column above is the behaviour as it stands, not
a ruling that it is correct.

If the successor row lands on "company-readable", the change belongs in
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
