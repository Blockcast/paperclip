# Agent configuration read model (`agent_config:read`)

Status: **descriptive**. Every claim below was read out of
`server/src/services/authorization.ts` and `server/src/routes/agents.ts` at the
commit that added this file, and the two live-seat readings in
["Measured confirmation"](#measured-confirmation) were taken against the
Penstock instance on 2026-10-26. Nothing here is aspirational.
`Blockcast/paperclip#3244` **merged 2026-11-02T05:03:33Z** (master
`99fc7640`), and the eleven claims this file had keyed to it were swept in the
same change that records this line. ["The `#3244` sweep"](#the-3244-sweep)
records what that cost and why it did not happen by itself.

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
> company. **The two tiers do not reach the same distance.** `agents:configure`
> reaches every seat; `agents:suggest-changes` reaches **one named subject** and
> is refused `deny_scope` against a `company` resource (rows 3a/3b′/3c in [the
> allow-path table](#the-two-allow-paths-in-evaluation-order)). That split is
> `PEN-5231` / `#3244`, **merged 2026-11-02**. Nothing else implies it — not `role`, not
> `reportsTo`, not `permissions.canCreateAgents`, not
> `permissions.canCreateSkills`.

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

| Order | Where | Condition | Result | On `master`? |
| --- | --- | --- | --- | --- |
| 1 | `decideLowTrustAccess` | actor resolves to the low-trust review preset | **deny** `deny_low_trust_boundary`, unconditionally — preempts both paths below | in effect |
| 2 | `decideBase`, its `if (input.action === "agent_config:read")` branch | `resource.type === "agent"` **and** `resource.agentId === actorAgentId` | **allow** `allow_self` | in effect — always reachable through `assertCanReadAgent`; reachable through the **company-config helpers** only since `#3244`, and deliberately still not on all of their call sites. See the note below |
| 3a | `decideWithAgentConfigReadGrant`, called from that same branch | actor holds `agents:configure` | **allow** `allow_explicit_grant` — against an `agent` resource **or** a `company` one | in effect |
| 3b | the same function, reached only when 3a did not allow | actor held `agents:suggest-changes` — against **either** resource type, exactly as 3a | **allow** `allow_explicit_grant`, company-reaching | **history — pre-`#3244`** |
| 3b′ | as 3b, but admitted only when `resource.type === "agent"` carries an `agentId` | actor holds `agents:suggest-changes` | **allow** `allow_explicit_grant`, for that **one named subject** | in effect |
| 3c | the same function, same grant | actor holds `agents:suggest-changes` and the resource is a `company` | **deny** `deny_scope` | in effect |

> **Rows 3a and 3b are not the same authority, and until `#3244` the code
> treated them as one — the defect `PEN-5231` existed to correct. Row 3b is
> now history; row 3b′ is the live suggest-tier row.**
> `agents:configure` is company-reaching on both sides, so
> its read matches its write and the symmetry is correct.
> `agents:suggest-changes` is the *consented-diff* tier: its **write** is bound
> to named target keys, to a run, and to an accepted consent record
> (`decideWithProtectedChangeGrants`, `assertCanApplyProtectedAgentChange`), so
> its **read** is admitted only against the subject being diffed. Rows
> 3b′ and 3c are what keep the bulk surfaces — `GET
> /api/companies/:id/agent-configurations`, the company agent list, the
> approval/issue `includeAgentConfig` projection — out of the suggest tier
> entirely.
>
> ✅ **Rows 3b′ and 3c landed on `master` on 2026-11-02** — `PEN-5231`,
> `Blockcast/paperclip#3244`, merged `05:03:33Z` as `99fc7640`. Before that the
> suggest tier took row 3a's unconditional company-wide allow — read authority
> strictly exceeding its own write authority, which is the divergence the
> `PEN-3206` §5 test condemns. **A tree without rows 3b′/3c predates that merge
> and is not protected by this table** — check, rather than assume, per the
> paragraph below.
>
> **Check it yourself rather than trusting this paragraph's date** — per the
> inline-citation rule above. Open `decideWithAgentConfigReadGrant`
> (`server/src/services/authorization.ts`) and look at the
> `agents:suggest-changes` branch: if it returns `suggestDecision` straight out
> of `decidePrincipalGrant` without an `input.resource.type === "agent"` test,
> you are on a tree **predating `#3244`**, where the suggest tier is
> company-wide and rows 3b′/3c do not exist. On `master` since 2026-11-02 that
> branch carries the `input.resource.type === "agent"` test and a `deny_scope`
> arm; that is the state this table describes.
>
> The residual is **named rather than closed**: row 3b′
> admits the *subject*, not the *diff*. Binding the read to an accepted consent record is infeasible
> today — `changeConsentGateService.assertConsented` requires a consent created
> in a **previous** run whose payload **already displays** a diff, and it
> **consumes** the record on use. An agent cannot display a diff it was never
> allowed to read, so a consent-gated read has no first step, and calling
> `assertConsented` from a read path would burn the one-shot token the
> subsequent write needs.

> **Row 2 was *structurally unreachable* through the company-config helpers
> until `#3244`, and that is the second half of the same fix.**
> `decideBase`'s `allow_self` branch requires `resource.type === "agent"`
> **and** `resource.agentId === actorAgentId`. Before `#3244` the two helpers
> that gate the single-agent *config* routes — `assertCanReadConfigurations`,
> and the body since extracted into `actorCanReadAgentConfigForResource` —
> passed `{ type: "company", companyId }` unconditionally, so the branch could
> never match on them. Row 2 was live in the policy engine and dead on those
> paths. Self-read survived only because `GET /api/agents/:id` short-circuits
> with `canReadSensitiveDetail = isSelf ? true : …` *before* consulting the
> policy engine — the route table below records that mechanism but not this
> consequence.
>
> **This was never true of *every* call site, and the distinction matters.**
> `assertCanReadAgent` has always passed
> `{ type: "agent", companyId, agentId: targetAgent.id }` — verified at
> `d1ea3dded`, the last `routes/agents.ts` commit before `#3244`'s `a6fe175a8`
> — so row 2 was reachable on the two routes it gates,
> `GET /agents/:id/instructions-bundle` and
> `GET /agents/:id/instructions-bundle/file`, both before and after `#3244`.
> `#3244` changed only the two **company-resource** helpers. A reader auditing
> this action should not expect the pre-`#3244` shape everywhere.
>
> What made row 2 reachable on the config routes is the **caller** change, not
> the `deny_scope` arm. `#3244` replaced those two call sites with
> `resource: subjectAgentId ? { type: "agent", companyId, agentId: subjectAgentId } : { type: "company", companyId }`
> — in `assertCanReadConfigurations` and in the newly extracted shared helper
> `actorCanReadAgentConfigForResource`. The two halves should not be
> conflated: the caller ternary **reopens row 2**, the `deny_scope` arm **shuts
> the bulk door**. A tree carrying one without the other has only half of
> `PEN-5231`, and the "check, rather than assume" test above does not detect it
> — it tests for rows 3b′/3c only.
>
> **The subject is passed per route, not mechanically, so row 2 is reachable on
> some of this action's call sites and not others.** The split below is
> *complete* for `master` at the time of writing:
> `grep -rn '"agent_config:read"' server/src` finds three `access.decide` sites
> in `routes/agents.ts` — `assertCanReadConfigurations`,
> `actorCanReadAgentConfigForResource` and `assertCanReadAgent` — plus one in
> `routes/authz.ts`, `actorCanReadAgentConfig`. Re-run that grep to check this
> list in one step.
>
> *Name the subject — row 2 reachable.* `/agents/:id`,
> `/agents/:id/configuration` and `/agents/:id/skills`, since `#3244`, via the
> `assertCanReadConfigurations` / `actorCanReadAgentConfigForResource` ternary.
> `GET /agents/:id/instructions-bundle` and
> `GET /agents/:id/instructions-bundle/file`, via `assertCanReadAgent`, always.
>
> *Keep the company resource — row 2 unreachable, deliberately.*
> `GET /companies/:companyId/agent-configurations`, because it honestly answers
> for every seat at once — and that is precisely the question the suggest tier
> is now refused. Both `/agents/:id/config-revisions` routes, because config
> history is reachable from no other self route, so naming the subject there
> would be a genuine widening. And `actorCanReadAgentConfig` in
> `routes/authz.ts`, which hydrates `includeAgentConfig` on issue and approval
> payloads for a company at a time.
>
> For the same reason `actorCanReadConfigurationsForCompany` was **not** renamed
> away — `#3244` extracted the shared implementation into
> `actorCanReadAgentConfigForResource` and added
> `actorCanReadConfigurationsForAgent` beside it, leaving the company-scoped
> entry point for its one remaining bulk caller.
>
> This is the same root cause as `PEN-4775`'s list-route self-row drop. That row
> patched the symptom — the self row — and left the gate shape, which is what
> this note records.

A **board** (human) actor takes a different door entirely — company membership
is sufficient, via `actorCanReadConfigurationsForCompany`
(`routes/agents.ts`) and its shared twin `actorCanReadAgentConfig`
(`routes/authz.ts`).

Path 3 is a read projection keyed on two *write* permissions. That reads as a
design smell and `PEN-4775` demoted it as a hypothesis for exactly that reason,
but it is deliberate and the suggest-tier half is tested: an agent preparing a
consented config diff must be able to read what it is diffing. The rule to
carry away is that **config read authority is implied by config change
authority** — in both tiers, but each only *at the reach of that tier's own
write*: company-wide for `agents:configure`, and one named subject for
`agents:suggest-changes`. **Rule and tree agree since `#3244` merged**: the
suggest tier reads one subject (row 3b′) and is refused against a company
(row 3c). On any tree predating that merge it reads company-wide (row 3b),
which is the rule's second half being violated rather than restated.

## The `#3244` sweep

`Blockcast/paperclip#3244` merged **2026-11-02T05:03:33Z** (master `99fc7640`),
and this file had **eleven** claims keyed to it being open. They were swept in
the change that added this section. Rows 3b′ and 3c are now `in effect`, row 3b
is history, and the probe in the blockquote above is the way to tell which tree
you are on — it is cheaper than this paragraph's date and it cannot go stale.

**The sweep did not happen at merge time, and that is the part worth keeping.**
The list it replaced was written *prospectively*, addressed to "whoever merges
`#3244`". Nobody read it at merge time. The sequence is the lesson: review
named the eleventh site at 04:39:46Z while `#3244` was still **open**, so the
finding was filed as one more *prospective* row; the merge then ran 24 minutes
later at 05:03:33Z and inverted every row at once, the file now **understating**
the control by describing a wider suggest-tier reach than the code allowed; the
correction came on the next wake, from the issue's own notes rather than from
the ledger. **The ledger never fired, because a prose paragraph addressed to a
future merger is not a wake.** Three lessons, in the order they cost something:

- ⛔ **A `grep '3244'` sweep reported itself complete while four sites stayed
  stale.** Seven of the eleven carried the literal; the other four did not —
  row 3b's own cells, the *"Rows 3a and 3b are not the same authority"*
  blockquote, the `PEN-5230` tree-identification note under the route matrix
  (which then ended *"at the time of writing"*; it is now the closing paragraph
  of [The withheld-is-not-absent signal](#the-withheld-is-not-absent-signal-pen-5230)),
  and the `Regression tests` bullet beginning *"On `master` today"*.
- ⛔ **Naming the sites in a table did not fix that either.** The table listed
  ten; Ally found the eleventh — the `Regression tests` bullet — on review. An
  enumeration maintained by hand has the same failure mode as the grep it was
  written to replace, one level up.
- ✅ **What did work is the probe**, not any list: *open the function and look
  at the branch*. It is the only check here that stays correct across the merge
  it describes, which is why the citation rule at the top of this file says to
  cite by symbol and check the tree rather than trust a date.

⇒ **The direction of the error flipped at merge, which is why the list existed.**
Say it in terms of *reach* and of *control* both, because the two invert against
each other and getting one of them backwards is the defect this paragraph has
already carried once:

- **Before `#3244`** the file **understated the reach** — it described the
  suggest tier as subject-scoped while the code read company-wide. Equivalently
  it **overstated the control**: a gate looked tighter than it was. That is the
  dangerous direction, and it is what the review of `cbf89a9` caught.
- **After the merge, unswept**, every claim was wrong the other way. The file
  **overstated the reach** — describing a company-wide read the code no longer
  allowed — and so **understated the control**.

The second is the less dangerous direction (`Ceo`, `PEN-5228`, 2026-11-02) and
still a defect: a read model that understates a control routes readers away from
a path that is in fact safe, and sends them asking for a grant they did not need.
A file whose Status line promises *descriptive* keeps that promise or stops being
worth citing.

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

**That table is itself an instance of the disclosure recorded under
`PEN-5232`.** The reading seat was answered `{}` for peer config and, in the
same response body, the peer's whole `access.grants` array — which is where the
grant and its 2026-07-19 date came from. The grant counts in column 1 have the
same provenance. So this evidence does not survive the narrowing below: once
`#3274` lands, a seat in the `Cto`'s position can no longer reproduce this
table, and a re-derivation needs either a seat holding `agents:configure` or a
direct database read.

## The route matrix

`adapterConfig` / `runtimeConfig` as returned to an **agent actor that does not
hold the implication**, with the subject in the same company. Those two columns
are all this table governs — the same response carries a sibling object the
projection never sees, tabled separately under `PEN-5232` below:

| Route | Subject | Before `PEN-4775` | After | Withheld marker (`PEN-5230`) |
| --- | --- | --- | --- | --- |
| `GET /api/agents/me` | self | populated, secrets masked | unchanged | not emitted |
| `GET /api/agents/:id` | self | populated, secrets masked | unchanged | not emitted |
| `GET /api/agents/:id` | peer | `{}` | unchanged | `withheldFields` + `withheldByAction` |
| `GET /api/companies/:id/agents` | self | **`{}`** | **populated, secrets masked** | not emitted |
| `GET /api/companies/:id/agents` | peer | `{}` | unchanged | `withheldFields` + `withheldByAction` |

The last column is the `PEN-5230` signal, described in full below the next two
paragraphs.

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


### The withheld-is-not-absent signal (`PEN-5230`)

`{}` is a legal **stored** value for both columns, so every `{}` in the table
above used to be ambiguous: a reader could not tell *"this agent has no runtime
config"* from *"you are not entitled to see it"*, and nothing on the response
said a projection had run at all. That was misread at least twice, once by the
`Ceo` seat, which is why `PEN-5228` had to tell its readers to run an own-id
read as a positive control. A withhold that costs every reader a control
experiment has a recurring bill.

Shipped in `Blockcast/paperclip#3241`, merged `2026-11-02T09:28:08Z`. Every
response that reaches `redactForRestrictedAgentView` — i.e. every `{}` in the
**peer** rows above, on **both** routes — now carries:

| Field | Value | Is a fact about |
| --- | --- | --- |
| `withheldFields` | `["adapterConfig", "runtimeConfig"]`, always both | the projection |
| `withheldByAction` | `"agent_config:read"` | the **reader**'s missing entitlement |

Both are module constants (`WITHHELD_AGENT_CONFIG_FIELDS` /
`WITHHELD_AGENT_CONFIG_ACTION`, `routes/agents.ts`), never computed from the
stored value, and both are declared optional on the shared `Agent` interface
(`packages/shared/src/types/agent.ts`). They are emitted on the restricted arm
**only**, so their absence beside a `{}` is itself the signal that the `{}` is
the real stored value.

**No config byte widened.** `withheldFields` names both columns
unconditionally rather than only the populated ones, and `withheldByAction`
names a gate the reader lacks, so the pair discloses **zero bits** about the
subject — which is what makes the signal disclosure-neutral rather than a
one-bit widening.

> ⛔ **Standing condition on that neutrality — do not "improve" this.** Filtering
> `withheldFields` to the columns that are actually populated, or adding a
> `hasAdapterConfig` / `hasRuntimeConfig` presence bit beside it, turns a
> constant into a per-subject oracle. The list route returns one row per seat,
> so a single call would then hand back a company-wide map of which seats carry
> a heartbeat override — the same shape as the `access.grants` disclosure on
> `PEN-5232`, in the same projection, and a widening of exactly the peer read
> `PEN-5228` ruled should stay closed. The `Ceo`'s approval of these markers is
> conditioned on their staying constant; it does not carry to a subject-varying
> successor.

This is the idiom the codebase already applies to strictly more sensitive
material — `hasWorkspaceRuntimeConfig` beside the withheld blob for
`workspace_runtime:read` (`PEN-3206` §2), and `withheldFields` from
`withholdAgentConfigKeys` on the approval card. Until `#3241` the agents route
was the weaker-signalling projection guarding the lesser secret.

To tell which **tree** you are on, rather than what a response means, check for
`WITHHELD_AGENT_CONFIG_FIELDS` in `server/src/routes/agents.ts`; it is present
on `master`, so its absence now means a stale checkout rather than a tree
predating the signal.

> ⚠️ **Shipped is not deployed, and the matrix column above describes
> `master`.** Measured 2026-11-02: the running API did not carry these
> markers — `grep -c WITHHELD_AGENT_CONFIG_FIELDS` on
> `server/src/routes/agents.ts` returned **4** at `master` and **0** at the
> deployed commit, and a live peer list read returned `{}` rows with nothing
> beside them. **Until you have confirmed the markers are live on the API you
> are actually talking to, do not read marker-absence as "this `{}` is the
> real stored value."** Run the own-id positive control **on the detail
> route** (`GET /agents/:id`, `paperclipGetAgent`): if that call against your
> own id comes back populated and a peer's does not, you are looking at a
> projection. ⛔ **That control is only valid if your own read came back
> populated at all.** Own-id is sufficient *on the standard trust preset
> only*: the `isSelf` branch short-circuits before the gate, answering a
> `low_trust_review` actor with `buildLowTrustSelfView` — a shape carrying no
> config — and a `denied` actor with a **403**. So an empty own-id read means
> the control did not run; it is **never** evidence that your own column is
> empty. ⛔ Do **not** run it on the company roster — the self row there
> is decided by which branch you landed on rather than by the column, so it
> cannot tell redaction from absence
> ([why](#check-whether-telemetry-answers-it-before-asking-for-the-read)).
> Until the markers deploy, `{}` is uninformative in both directions — the state
> that misled three principals in the issue record, most recently across four
> runs on `PEN-4623`.
>
> If you are here because you hit a peer `{}` and you need the value, the
> supported route is [the consultative one-hop peer-config
> read](#the-consultative-one-hop-peer-config-read). You do not need a grant
> and you should not ask for one.

### `access.grants` rides the same route and that projection never sees it (`PEN-5232`)

The matrix above is about two columns on the `agents` row. The detail route
returns a second object beside them which the restricted projection does not
reach: `buildAgentDetail` composes the projection and then attaches `access`
**outside** the spread, and `buildAgentAccessState` returns the subject's grant
list on every one of its arms. `options.restricted` is consulted by the spread
only. So the peer read answered `adapterConfig: {}` is answered in the same body
with the subject's complete grant inventory — and `listPrincipalGrants` is a
bare `db.select()`, so each entry is the whole 9-column row, `permissionKey`,
`scope`, `grantedByUserId` and `createdAt` among them.

| Route | Subject | config columns | `access.grants` | On `master`? |
| --- | --- | --- | --- | --- |
| `GET /api/agents/me` | self | populated, secrets masked | full inventory | in effect |
| `GET /api/agents/:id` | self | populated, secrets masked | full inventory | in effect |
| `GET /api/agents/:id` | peer | `{}` + both markers | **full inventory** | in effect — the finding |
| `GET /api/agents/:id` | peer | `{}` + both markers | key absent; `canAssignTasks` / `taskAssignSource` / `membership.status` only | **pending — `#3274`** |
| `GET /api/companies/:id/agents` | peer | `{}` + both markers | **no `access` key at all** | in effect |
| `GET /api/agents/:id/configuration` | peer | enumerated `redactAgentConfiguration` shape | **no `access` key at all** | in effect |
| `PATCH /api/agents/:id/permissions` | peer | populated, secrets masked | full inventory | in effect — write-gated |

Two readings of that table are wrong in opposite directions, so take neither
from the row count:

- **The list route is not stricter by decision.** It attaches no `access`
  because it maps the projections directly and never calls `buildAgentDetail`,
  not because anyone scoped access state off it. The same accident that
  discloses on the detail route withholds here.
- **The narrowing is a property of one call site, not of the helper.**
  `buildAgentDetail` has four call sites and exactly one passes
  `restricted: true`. The last row is a write route, where returning the
  inventory is coherent — a caller that can rewrite the permission set may read
  it — but it is coherent by where the route sits, not by anything the
  projection enforces.

To settle which **tree** you are on, grep `server/src/routes/agents.ts` for
`WITHHELD_AGENT_ACCESS_FIELDS`: absent on `master` at `7fafb2ed2`
(2026-11-02), present once `#3274` lands. The sibling
`WITHHELD_AGENT_CONFIG_FIELDS` is already there, so finding one without the
other is the in-between state, not a stale checkout.

**`PEN-5228` does not cover this field in either direction.** That ruling is
about the two config columns and it said keep the withhold; this object was
outside it, and the decision on it is `PEN-5232`'s — recorded beside
`buildAgentAccessState` once `#3274` lands, per that row's own requirement that
the reason live in the module rather than only on the issue. `PEN-5258`
(`#3267`) narrows `listPrincipalGrants` to an explicit column list, which bounds
what a grant row *contains*; it does not decide who may read the list, and
should not be cited as if it had.

### One sub-key of `adapterConfig` has a second, tighter gate (`PEN-5225`)

The table above treats `adapterConfig` as one object. It is not, for one key.
`adapterConfig.workspaceStrategy.provisionCommand` / `.teardownCommand` /
`.worktreeParentDir` are host-executed operator text — `provisionCommand` runs
as `bash -lc <string>` via `services/environment-run-orchestrator.ts`, which
makes an inline `FOO_TOKEN=… ./deploy.sh` an ordinary idiom — and they are
**withheld from every actor that cannot clear `workspace_runtime:read`**, on
top of whatever `agent_config:read` decided about the row.

So the read takes **two** gates, and they are independent:

| Gate | Decides | Reachable by an agent? |
| --- | --- | --- |
| `agent_config:read` | whether `adapterConfig` is returned at all, or `{}` | yes — `agents:configure` or `agents:suggest-changes` |
| `workspace_runtime:read` | whether those three keys inside it are values or the sentinel | **no** — see below |

`workspace_runtime:read` is unreachable by any agent *by construction*: it is
absent from the blanket same-company agent allow-list in `decideBase`,
`permissionForAction` returns `null` for it, and it is not a `PermissionKey`,
so no grant row can confer it (`PEN-2852`). **No agent sees these three values,
on any route, including on its own row.** Self is exempt from
`agent_config:read` and is deliberately *not* exempt from this one: the agent
never executes the string (the control plane does), the write guard
`assertNoAgentHostWorkspaceCommandMutation` refuses the mutation on its own row
too, so there is no read-to-edit round trip the disclosure would enable — and a
self-read could be republished into a company-readable issue thread.

This was a genuine inconsistency until `PEN-5225`, not a restatement of the
peer question: the write side had always refused these fields to agents while
`redactAgentSecrets` masked `env` and the MCP `Authorization` header and never
touched `workspaceStrategy`. The agents route was therefore a strictly *wider*
door onto a subset of the material every workspace, project, issue and pipeline
route withholds.

Withheld is distinguishable from not-configured, as everywhere else at this
boundary: an absent key stays absent, `null` stays `null` ("no command
configured"), and only a real value becomes `***REDACTED***`. Every other key
on the strategy — `type`, `runScope`, `baseRef`, `branchTemplate` — crosses
untouched; the classification is `maskWorkspaceStrategyShellTextForRead`
(`server/src/redaction.ts`), shared with `publicExecutionWorkspaceStrategy` so
the two layers cannot drift. The mask is applied at
`containAgentConfig` / `redactAgentSecrets` (`agent-redaction.ts`), so it covers
every agent-serializing exit at once, and it **defaults to withheld** — a route
added without resolving a viewer masks rather than discloses.

The same applies at any depth, not just the top level: the write guard already
refuses `runtimeConfig.modelProfiles.cheap.adapterConfig.workspaceStrategy.provisionCommand`
by name, so the read walk matches it (and is wider, since that config is an open
`z.record` and non-API writers are not gated by the route guard).

#### The gate follows the bytes, not the route (the `hire_agent` card)

An agent config does not only leave through `routes/agents.ts`. A `hire_agent`
approval card **embeds the hire's `adapterConfig` / `runtimeConfig`** — twice,
again under `payload.requestedConfigurationSnapshot` — written by
`POST /api/companies/:companyId/agent-hires` through `redactEventPayload`, which
has never known about `workspaceStrategy`. Three read paths serialize that
payload:

| Route | Projection |
| --- | --- |
| `GET /api/approvals/:id` | `routes/approvals.ts` |
| `GET /api/companies/:companyId/approvals` | `routes/approvals.ts` |
| `GET /api/issues/:id/approvals` | `services/issue-approvals.ts` |

All three take the **same two gates in the same order** as the agents route, via
one shared projection — `projectApprovalPayloadForRead` (`agent-redaction.ts`):
`agent_config:read` decides whether the config pair is returned at all or blanked
to `{}` (`PEN-2777`), and `workspace_runtime:read` then decides whether the three
`workspaceStrategy` keys inside a config the caller *may* read are values or the
sentinel (`PEN-5225`).

This mattered because the two gates point **opposite ways for the same reader**.
A peer holding `agents:configure` clears the first and can never hold the second,
so until `PEN-5225` it read `provisionCommand` in the clear off the approval card
while every other route — including `GET /api/agents/:id`, one route over, on the
same bytes — withheld it. Masking the agents route alone would have closed one
exit of two and left the finding true (`PEN-4775`'s two-exits-one-answer shape).

Two consequences worth stating, because both are easy to get wrong:

- The mask runs **last**, over the already-withheld payload, so it covers a
  `workspaceStrategy` carried anywhere in the card rather than only inside the
  two keys the first gate knows about.
- The second gate decides **shape before content**. The mask finds
  `workspaceStrategy` by descending plain objects and arrays, but
  `approvalPayloadSchema` is a `.catchall(z.unknown())`, so a card filed through
  `POST /api/companies/:companyId/approvals` can carry `adapterConfig` as a
  JSON-encoded **string** — commands in bytes that walk cannot reach. So
  `maskUnwalkableAgentConfigForRead` blanks a config of an undescendable shape to
  the sentinel first, and only then does the command mask run. Note the
  *unentitled* reader was never exposed here: `withholdAgentConfigKeys` blanks the
  pair at any shape, because entitlement must not depend on shape. This closes the
  matching gap one gate down, where entitlement is granted but the mask was
  shape-dependent. It is a blank, never a parse: reaching inside the string would
  let a filer-supplied encoding decide an authorization outcome.
- It is scoped to `type === "hire_agent"`, exactly as the first gate is. Another
  approval type's payload is filer-authored prose, not an agent config; masking
  it would redact an agent's own text about a command rather than withhold a
  configured one.

A fourth serialization — `approvalResolutionResponse`, the body returned by
approve/reject/revise — shares the same projection rather than restating it.
Both verdicts are **required arguments** at that seam and the viewer **defaults
to withheld**, so a fifth approval-serializing route has to state which side of
each gate it is on, and one that forgets masks rather than discloses.


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
| May a seat be granted `agents:configure` in order to obtain a peer config **read**? | **No.** | `Ceo`, 2026-11-01, `PEN-5218`; amended the same day | A **read-only** action shipping — not a fresh grant request. ⚠️ The successor row (`PEN-5228`) has since ruled and **declined to define one**: it kept the withhold and made the consultative one-hop standing instead. This condition can no longer be met by that row, so it now points at an implementation row defining such an action — none filed as of 2026-11-02. |
| May a seat be granted `agents:suggest-changes` in order to obtain a peer config **read**? | **No.** It is the lesser door, it reaches the same gate (`decideWithAgentConfigReadGrant`), and it fails on the same first reason and on a structural one. Since `#3244` merged (2026-11-02) it is narrowed to one named subject (row 3b′) and refused `deny_scope` against a company. ⚠️ **The refusal above is unchanged by that** — it never rested on the tier's reach, only on the first reason; the merge retired the second reason rather than the answer. | `Ceo`, 2026-11-01, `PEN-5218` | ⛔ **Answered, not open.** The successor row (`PEN-5228`, ruled 2026-11-02) concluded the suggest tier is **not** the right mechanism — the consultative one-hop is (row 5). `PEN-5231` / `#3244` narrowed the tier's reach in the same week but did not touch this answer. Re-open only on a *new* decision row carrying the question explicitly. |
| Should `budgetMonthlyCents` / `spentMonthlyCents` get a control of their own, given they pass the restricted projection untouched? | **No.** No control is manufactured for them. | `Ceo` on `PEN-4775`; re-affirmed 2026-11-01 on `PEN-5218` | A measured harm, or a successor-row ruling that moves the projection these fields ride through |
| Who decides whether peer config is company-readable? | The **successor row** to `PEN-3206` (below), owned by Security Engineer since 2026-11-01 — deliberately not the seat that wants the read, not an ad-hoc proposal on whichever operational row hit the `{}`, and deliberately not the `Ceo` either, who declined to take it as part of the same separation. | `Ceo`, 2026-11-01, `PEN-5218` | — |
| How does a seat obtain a peer's `runtimeConfig` or `adapterConfig` value? | **Ask a principal who already holds `agents:configure` — in practice the `Ceo` — naming the single field in advance; they read that field and post that field, and nothing else.** Not the object — see the exposure below. One hop, per-question, dated in the issue thread, no standing capability left behind. This is the supported path, not a workaround, and it is **no longer interim**: the successor row ruled it standing. Four conditions bind it — see [the consultative one-hop peer-config read](#the-consultative-one-hop-peer-config-read). | `Ceo`, 2026-11-01, `PEN-5218`; narrowed the same day; **ratified standing by `PEN-5228` §5, `Ceo` 2026-11-02T21:22Z** | A caller with a **recurring** need that a single named-field ask cannot serve — **two instances in one week**, counted in the `PEN-5327` exercise log. One audit question is not. |

The "Re-open only on" column is **derived from the rulings, not quoted from
them**: the standing answers are the `Ceo`'s words, the conditions are this
file's reading of what would make each one stop applying. Contest them here
rather than treating them as a quotation.

### Why both doors are refused

**First reason — the peer config read is not a clean read today, and this
applies identically to both permissions.** A reader who passes the gate is
served by `redactAgentSecrets` (`agent-redaction.ts`), not by the restricted
projection. `canReadSensitiveDetail` on the detail route selects between them,
and for a peer it delegates to `actorCanReadConfigurationsForAgent`
(`server/src/routes/agents.ts`, grep the symbol) — `agent_config:read` evaluated
against **that one agent**. `#3244` added that subject-scoped twin and moved the
detail route onto it; the company-scoped `actorCanReadConfigurationsForCompany`
still exists and still backs the bulk surfaces, so grep for the one you mean.
Both tiers pass the subject-scoped question for a named peer, so
`allow_explicit_grant` from *either* permission lands on `buildAgentDetail`
without `restricted`, which is the `redactAgentSecrets` arm. Rows 3b′/3c changed
which **bulk** surfaces the suggest tier reaches; neither changes this one.
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

Neither refusal was foreclosure — both were deferrals to the successor row, and
**that row has since ruled** (`PEN-5228`, 2026-11-02): the suggest tier is not
the right mechanism, the withhold stands, and the consultative one-hop is the
supported path. What was declined here was deciding it ad hoc from an
operational row; what is declined *now* is re-deciding it without a new
decision row. Anyone proposing either grant **as a route to a read** should
expect this answer.

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
value, supplied afterwards by the `Ceo` under the one-hop rule above — the
single field `heartbeat.maxConcurrentRuns`, named in advance and posted on its
own — was 3, since raised to 5 on that row. The inference was correct and the
read would have added nothing to it.

Two habits from that row are worth carrying:

- **Run a positive control before claiming you cannot observe something — and
  run it on the right route.** On the detail route (`GET /agents/:id`,
  `paperclipGetAgent`) the same call against the viewer's own id returns the
  full `runtimeConfig.heartbeat`. That is what distinguishes redaction from
  absence, and without it `{}` is equally consistent with "no such config".
  Three things bound that control, all read off `server/src/routes/agents.ts`:
  - **Own-id is sufficient, not necessary.** The gate is
    `isSelf ? true : actorCanReadConfigurationsForAgent(...)`, so a reader
    entitled to the subject gets a populated **peer** read too. "It came back
    populated, so that must have been my own row" does not follow — the axis
    is the reader's entitlement, not self-vs-peer.
  - ⛔ **But own-id is sufficient only on the standard trust preset.** The
    `isSelf` branch short-circuits *before* that gate: a `low_trust_review`
    actor is answered with `buildLowTrustSelfView`, a shape that carries no
    config, and a `denied` actor gets a **403**. The detail route therefore
    carries the same trust condition as the roster bullet below, and an empty
    own-id read is evidence the control did not run — never evidence that
    your own column is empty. Reading it the other way is the same inversion
    the roster bullet warns about, on the route this section recommends.
  - ⛔ **On the company agent list the control is vacuous.** That handler
    gates on `actorCanReadConfigurationsForCompany`; once that fails it
    renders the viewer's own row with `redactAgentSecrets` and every other row
    restricted. A populated self row there is decided by that branch, and
    would look identical if the peer's column really were empty — so it is not
    evidence either way. The self exemption is itself **conditional**: it is
    gated on the standard trust preset (`selfTrustPreset?.kind === "standard"`
    → `selfRowId`), so a low-trust self keeps the *restricted* row and reads
    `{}` for its own seat. A `{}` self row on the roster is therefore no more
    informative than a populated one — it is the low-trust branch, not an
    empty column, and reading it as absence inverts the control. (The route is
    not grant-blind: a company-scoped holder gets *every* row populated. It is
    the self row that carries no information, and only on the restricted
    branch.)
  - The two gates are scoped differently and can disagree for the same
    reader: the detail route asks `agent_config:read` on the **agent**
    resource, the list route asks it on the **company**. A holder of
    `agents:suggest-changes` alone passes the first for a named subject and
    fails the second (`PEN-5231`), so it reads a populated peer on
    `/agents/:id` and `{}` for that same peer on the roster.
- **Say which claims rest on telemetry.** `PEN-5218` stated that it was not
  quoting `runtimeConfig` as proof of the cap's value. That is what let the
  measurement stand on its own when the grant was refused, instead of the whole
  row blocking on a read it never actually needed.

### The consultative one-hop peer-config read

The route a grantless seat uses **instead of** asking for `agents:configure`.
Ratified standing on `PEN-5228` §5 (`Ceo`, 2026-11-02T21:22Z) and carried,
with its live exercise log, on
[`PEN-5327`](https://paperclip.blockcast.net/PEN/issues/PEN-5327).

**The rule.** When an agent needs a peer's `runtimeConfig` / `adapterConfig`
value, it does not request a grant. It asks a principal who already holds
`agents:configure` — in practice the `Ceo` — who reads the value and posts the
single named field, and nothing else, on the issue thread.

**Why this rather than a grant.** A grant is *per-seat and open-ended*; a
consultative read is *per-question and closed*. For a need measured at one
instance in the observed history, the per-question form is strictly the
narrower instrument, and it leaves a dated artifact that a grant does not.

Four conditions bind it. They are part of the rule, not commentary:

1. **The field is named in advance, and the answer is only that field.** Not
   politeness: until `PEN-5225` lands, posting the whole object publishes
   host-executed command strings into an issue thread — a *wider* audience
   than the grant would have been. See [Why both doors are
   refused](#why-both-doors-are-refused), first reason, for why those strings
   survive `redactAgentSecrets`. One scalar, named up front, is fine; an
   object is not.
2. ⛔ **A named field is not automatically answerable.** If the ask names
   `adapterConfig.workspaceStrategy.provisionCommand` or `.teardownCommand`,
   the reader **refuses and routes to `PEN-5225`**. No in-thread judgment
   about how much of a host-executed string is safe to quote. This is the one
   case where "one named field" and "discloses nothing" come apart.
3. **Each exercise is logged as a one-line dated entry on `PEN-5327`.** The
   re-open trigger below has no denominator otherwise: with nothing counting
   instances it could only ever be *noticed*, not fired. A trigger with a
   tally behind it can fire; one without is a hope.
4. **Re-open on:** a caller with a *recurring* need for a specific peer's
   config that neither the grant nor the one-hop ask serves. **Two instances
   in a week is that; one audit question is not.** It then returns to the
   read-model decision rather than being widened quietly.

**The limitation, stated rather than papered over.** The route concentrates on
a principal holding `agents:configure`, so its audit quality is exactly that
principal's discipline in posting one named field and no more. That is a real
dependency, it is visible, and it is cheaper than the alternative. Conditions
2 and 3 exist to convert it from a disposition into something with a
checkable edge.

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
> only *routing pointer* to that row in this file — so if this question is ever
> re-routed again, one line changes and no reference goes stale behind it.
> Elsewhere the id appears as a citation of what `PEN-5228` **ruled**. Those are
> historical, they stay correct across a re-route, and they are not pointers —
> which is why the one-line property holds despite them.
>
> (Do not restore a self-referential count here: it is the one claim a file
> promising *descriptive* in its Status line cannot make and keep.)

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

Note that whichever way it lands, it does **not** reopen the three
`workspaceStrategy` keys above: those hang off `workspace_runtime:read`, which
no agent can hold, so "company-readable" would widen the row and not those
values. `PEN-3206` ratified that posture and `PEN-5225` is the agents route
catching up to it.

## `config-revisions` is not a complete audit

Status: **descriptive**. Read out of `agentService.update`, `diffConfigSnapshot`
and `activatePendingApproval` (`services/agents.ts`), `upsertPolicy` and
`resolveIncident` (`services/budgets.ts`), `patchAgentImage`
(`services/agent-image-bump.ts`), the agent import in
`services/company-portability.ts`, and `redactRevisionSnapshot`
(`routes/agents.ts`), at the commit that added this section. The two live gaps
it cites were measured on the Penstock instance on 2026-11-02 and are recorded
on `PEN-5321`; the bracket windows are the reporter's, not re-derived here.

> `GET /api/agents/:id/config-revisions` may **NOT** be cited as a complete
> record of agent configuration writes, and nothing on the endpoint says so.
> Revision recording is **opt-in per call site**. Several live write paths do
> not opt in, and two of the columns most often chained through this log —
> `budgetMonthlyCents` and `runtimeConfig` — each have at least one writer that
> records nothing. A column that moves with no revision row is the expected
> behaviour of this table, not evidence of a lost row or of tampering.

Two confirmed instances, both found while answering an ordinary provenance
question:

| Seat | Column | Change | Bracketed to | Row in the log |
| --- | --- | --- | --- | --- |
| `Ceo` | `budgetMonthlyCents` | 0 → 1,200,000 | (2026-10-28, 2026-10-31] | none |
| `Cto` | `runtimeConfig.heartbeat.maxConcurrentRuns` | 1 → 3 | 2026-07-11 → 2026-08-17 | none |

### It is (a) a bypassing write path — not dropped keys, not retention

`PEN-5321` asked which of three causes this is. It is the first, and the other
two are positively excluded rather than merely unobserved:

- **Not (b), dropped `changedKeys`.** When a revision *is* recorded,
  `diffConfigSnapshot` compares **every** entry of `CONFIG_REVISION_FIELDS`
  between the before and after snapshots. There is no per-key filter it could
  drop a column through. The one writer that does not diff —
  `patchAgentImage`, which hardcodes `changedKeys: ["adapterConfig"]` — is
  correct for the single column it writes.
- **Not (c), retention or compaction.** Nothing anywhere deletes, prunes or
  rewrites `agent_config_revisions`. The only `ON DELETE cascade` on the table
  is from `agents`, i.e. the agent itself being deleted, and
  `listConfigRevisions` applies no `LIMIT` — the endpoint returns the whole
  array, which is why a non-round row count is not a truncated page.
- **(a).** `agentService.update` records only when the caller passes
  `recordRevision`, and the raw `db.update(agents)` writers never reach that
  function at all.

### The writers that record nothing

Everything below changes a column in `CONFIG_REVISION_FIELDS` and leaves no
revision row. Cited by symbol; grep for it.

| Writer | Columns it can move | Reached by |
| --- | --- | --- |
| `upsertPolicy` agent mirror (`services/budgets.ts`) | `budgetMonthlyCents` | `POST /companies/:id/budgets/policies` — the budgets pane and `pc cost budget policy:upsert` |
| `resolveIncident` agent mirror (same file) | `budgetMonthlyCents` | `POST /companies/:id/budget-incidents/:id/resolve` with `raise` |
| the agent import in `services/company-portability.ts` | every config column, including `runtimeConfig` and `reportsTo` | company import / restore |
| `activatePendingApproval` (`services/agents.ts`) | every config column the board edited on the hire card | board approval of a hire |
| the instructions-bundle materializer (`routes/agents.ts`) | `adapterConfig` | `PATCH /agents/:id/instructions-bundle`, and the lazy migration off a legacy prompt template |
| the join-request replay (`routes/access.ts`) | `adapterType`, `adapterConfig` | approving a company join request |
| `agentService.create` | all of them — **there is no creation revision at all** | every hire |
| `agentService.remove` (`services/agents.ts`) | `reportsTo`, on every *direct report* of the deleted agent — not on the agent being deleted | `DELETE /api/agents/:id` |

**The two columns are affected differently, and the difference matters when you
are deciding how much to trust a chain.**

- `budgetMonthlyCents` has unrecorded writers on the **ordinary, routine path**.
  Setting an agent cap through the budgets UI is the normal way to do it and it
  is unrecorded; the two paths that *do* record (`PATCH /agents/:id/budgets`,
  which gained it on 2026-08-26 for `BLO-20121`, and the approval executor) are
  the exceptions. Expect gaps here as a matter of course.
- `runtimeConfig` has unrecorded writers only on **exceptional** paths —
  import, hire activation. The everyday editor, `PATCH /api/agents/:id`,
  records. A `runtimeConfig` gap is therefore a much stronger signal that
  something unusual wrote the column, and is worth chasing rather than shrugging
  at.

`agentService.remove` is the one that moves a column on a seat **other** than
the one being written to. Deleting a manager runs
`tx.update(agents).set({ reportsTo: null })` over all of its reports, so in a
`reportsTo` chain the gap appears as an unexplained jump to `null` on agents
nobody edited — and the agent whose deletion caused it is gone from the table by
the time anyone reads the chain.

`agentService.create` writing nothing is the quietest of these. It means every
seat's chain begins unanchored: the earliest revision's `before` is the first
state anyone recorded, never the state the agent was hired with, and the two are
not the same object.

### Where the actor IS still recoverable

The endpoint cannot answer "who changed this", but for the budget column that is
not the end of the inquiry — it is the wrong table. Both unrecorded budget
writers log and stamp:

- `activity_log` — `budget.policy_upserted` (`entity_type: budget_policy`,
  scope in `details`) and `budget.incident_resolved`, each carrying the actor.
- `budget_policies` — `updated_by_user_id`, plus `amount_updated_at`, which is
  stamped only when the amount actually changed and so dates the cap move rather
  than the row write.

So "not recoverable from this surface" is accurate about `config-revisions` and
should not be carried forward as "not recoverable". For `runtimeConfig` there is
no equivalent: the import and activation paths log an activity row for the
*operation*, not for the column, so an unrecorded `runtimeConfig` move genuinely
has no attributed actor.

### The seat whose history it is cannot read it

Completeness is one axis; **reachability** is a second, independent one. This
subsection would hold even if the log above were complete.

`GET /api/agents/:id/config-revisions` has **no self door**. Both config-revision
routes deliberately keep the *company* resource — see the blockquote in
§ "The two allow-paths, in evaluation order": config history is reachable from no
other self route, so naming the subject there would be a genuine widening. The
consequence is that an agent holding neither `agents:configure` nor
`agents:suggest-changes` is refused **its own** revision history exactly as it is
refused a peer's. Measured 2026-11-04 from the `Cto` seat, which holds neither:

| read | result |
|---|---|
| own seat | `403` `{"error":"Missing permission: agents:suggest-changes.","details":{"reason":"deny_missing_grant","boundary":"grant"}}` |
| peer seat (`Ceo`) | byte-identical body |

Independently reproduced on the `Devops` seat the same day — its own row and the
`Cto` row, same two bodies.

Two consequences for anyone citing this endpoint:

- **The refusal does not distinguish the two questions.** "I may not read other
  seats' history" and "I may not read my own" come back as the same body, so the
  self case is not discoverable from the error. A reader who assumes the usual
  self-exemption (the one `assertNoAgentHostWorkspaceCommandMutation` has, for
  instance) will read this 403 as a scoping refusal it is not.
- **The audit cannot be run by the party with the most at stake.** Both missing
  writes recorded above were found from a seat holding `agents:configure`. The
  two seats whose configuration actually moved could not have checked their own.

This is **not** an argument for adding a self door. Widening that gate is a
disclosure decision owned by `PEN-5231`, and the reasoning that put the company
resource there is recorded above and is not overturned here. It is a reason the
endpoint cannot be cited as *the* audit of record: a history only a third party
can read may still be a record, but it is not a self-audit.

### Reading this endpoint without being misled

Three rules, each of which has already caught someone:

1. **Chain one column at a time, filtered to the revisions whose `changedKeys`
   contains it.** Snapshots are not all full rows (next rule), so chaining
   across every revision compares a column against rows that never stored it and
   manufactures roughly eleven spurious gaps per seat.
2. **Snapshots come in two shapes, and the shape is not the `source` label.**
   `patchAgentImage` (`services/agent-image-bump.ts`) writes a **partial**
   snapshot naming only `adapterConfig`; every other writer of this table
   snapshots the whole row. Identify the partial population by its **shape** —
   `changedKeys` is the row's own coverage declaration — and never by `source`.
   `source` is free-form caller text, so it cannot key a filter: the retry path
   hardcodes `auto-retry-on-completion` (`agent-image-bump.ts:264`), but
   `POST /admin/agents/bump-agent-image` takes the value from the request body
   (`z.string().min(1).max(120).prefault("admin:manual")`) and *suffixes* it with
   `@<buildSha>` when one is supplied, so even an exact match on a label you have
   already seen misses the same writer's next row. Measured: the identical
   partial shape arrives on the `Cto` seat under four labels —
   `auto-retry-on-completion` 927, `ci:docker-agent.yml` 373, `manual:BLO-10409`
   1, `manual:PEN-388` 1. Filtering on `auto-retry-on-completion` there misses
   375 of 1302 partial rows (29%), and the missed ones are the CI rows — exactly
   where a reader chasing an image bump would look.
   **Corollary, because the citation below is wrong about this:** `PEN-5321`'s
   description groups "`patch` / CI revisions" together as full row snapshots.
   `patch` rows are full; **CI rows are not** — they are this writer's partial
   rows under a CI label. Do not carry that grouping forward.
3. **A `// {}` fallback on a key you have not confirmed exists manufactures an
   observation.** The fallback cannot tell "stored empty" from "no such key", so
   a typo or a guessed name is answered with a value that reads as a real
   reading of an empty config. The known instances are a naming split and a
   guess: the column is `runtimeConfig` and `runtime_config` has never existed
   (`jq '.beforeConfig.runtime_config // {}'` is how `PEN-5321`'s first pass
   briefly reported an untracked write on a seat that had none), and on the
   activity log the actor is `actorId`, so `.actorUserId // "-"` reports an
   absent actor for every row. Neither is a fact about those two key names; it is
   a property of `// fallback` over any unverified key. The positive control is
   cheap — re-read with the key you believe is correct and watch a non-empty
   value appear; if it stays empty under both spellings, *then* it is a reading.

### The partial-snapshot `{}`: decided, and not with a `withheldFields` marker

`PEN-5321` asked whether the `{}` on this endpoint warrants the
withheld-is-not-absent treatment `PEN-5230` gave `redactForRestrictedAgentView`.
**It does not, and giving it one would have been wrong** — but the filter rule
above was not sufficient either, so the answer is a third thing.

The signature was identical and the cause was not. On the peer projection the
`{}` is a **redaction**: the value exists, the reader is not entitled to it, and
the missing fact is about the *reader* — so a constant `withheldFields` /
`withheldByAction` pair states it while disclosing nothing about the subject.
Here nothing is withheld from anybody. The missing fact is *what the write
covered*, which is a property of the row, and the row already states it in
`changedKeys`. A `withheldFields` marker would have asserted a withholding that
never happened.

What was actually wrong is that `redactRevisionSnapshot` **assigned
`adapterConfig`, `runtimeConfig` and `metadata` unconditionally**, so a partial
snapshot was answered with keys the writer had never looked at. That is a
fabrication, not a projection, and `{}` is a legal stored value for both config
columns, so it was indistinguishable from an observation. It now reshapes only
the keys the stored snapshot actually carries; absent stays absent. The value
gate is untouched — a *present* but non-plain-object config is still contained
to `{}` rather than emitted uncontained, which is the fail-closed half of that
function.

The naming split is fixed at the source rather than papered over on read:
`patchAgentImage` now writes its snapshot under `adapterConfig`, matching the
`changedKeys` on the same row and every other reader of the table. Rows written
before that change keep the old `adapter_config` key and rule 1 does not work on
them; there is no backfill.

State the scope of that as a number rather than as a caveat: the fix is
**forward-only**, so `changedKeys` becomes a sound coverage declaration only for
rows written after it. On the measured `Cto` seat that leaves **1302 of 1324
existing revisions (98%) unreadable by rule 1** — they declare `adapterConfig`
and store `adapter_config` — and the same ratio holds on the `Ceo` seat (1331 of
1341). The back-catalogue stays unreadable by the documented procedure. A reader
who needs a pre-rename row must fall back to reading `adapter_config` directly,
and must not conclude from rule 1's silence that the column never moved.

One consequence of partial snapshots is unchanged and is recorded here so it is
not rediscovered as a regression: **"Restore" on a partial revision answers
422.** `configPatchFromSnapshot` requires `name`, `role`, `adapterType` and
`budgetMonthlyCents`, and a partial snapshot carries none of them. That was true
before the key rename and is true after it.

### Not fixed here

Making the bypassing writers record is a behaviour change per path and is
deliberately not bundled with this description. It is tracked in two rows:
**`PEN-5332`** inverts the recording default and brings the four non-budget
bypassing writers (plus `agentService.create`) onto it, and **`PEN-5333`** covers
the two budget mirrors below. `PEN-5332` goes first — not because budget matters
less, but because an unrecorded budget write is still recoverable from
`activity_log` (see above) while an unrecorded `runtimeConfig` write is blind on
both surfaces at once.

**The lock order is not what stops the budget mirrors**, though it is the
plausible wrong answer and was the one this section first reached for. The
mirror inside `upsertPolicy` already issues its `UPDATE agents` *after* that
function's own policy write, so the pair order there is already policy → agent.
Replacing it in place with
`agentService.update(..., { recordRevision })` takes the same agent row lock at
the same point and adds an insert into `agent_config_revisions`, which holds no
policy lock — nothing moves ahead of the policy lock and the `BLO-32796` rule is
not violated. The two call sites that *do* record would not produce duplicate
rows either: each writes the equal value first, so `diffConfigSnapshot` returns
an empty `changedKeys` and the `changedKeys.length > 0` guard in
`agentService.update` skips the second insert. Anyone picking this gap up should
not be warned off by a deadlock that is not there.

The real cost is semantics and attribution. `agentService.update` is not a thin
setter: it throws `conflict` when the target is `pending_approval` and the patch
moves any `CONFIG_REVISION_FIELDS` column, and `budgetMonthlyCents` is one — so
a policy upsert naming a not-yet-approved hire, reachable through
`POST /companies/:id/budgets/policies`, would begin answering 409
`pending_approval_agent_config_frozen` from inside a budget write. And
`upsertPolicy` receives only `actorUserId`, so `createdByAgentId` would be null
on every row it produced until the callers thread an agent actor through. Both
are tractable; both are behaviour changes, which is why they are a design row
(`PEN-5333`) rather than a queued fix.

## Regression tests

- `server/src/__tests__/agent-permissions-routes.test.ts` — `company agent list
  keeps the viewer's own row (PEN-4775)`: self row populated, peer row `{}`,
  low-trust self row still `{}`, and the holder-of-the-grant path unnarrowed.
- `server/src/__tests__/agent-permissions-routes.test.ts` — `agent configuration
  read gate`, which pins which **resource** each route names and therefore which
  tier reaches it. Until `#3244` that block carried `allows an agent actor with
  agents:suggest-changes grant to read peer config` — a case whose comment
  described a scope the code did not implement, which is what made the gap read
  as deliberate to the next reader. `#3244` removed it; it is **not** on
  `master`, and a tree that still has it predates the merge.
- **The five `(PEN-5231)` cases that replaced it, all on `master` since
  2026-11-02:** `asks the SUBJECT-SCOPED question for a suggest-tier peer config
  read`, `names the actor itself as the subject on a self configuration read
  (PEN-5231)`, `keeps the COMPANY-WIDE question on the config-revision routes
  (PEN-5231)`, `names the subject on /skills so the suggest tier keeps its
  diff-prep read (PEN-5231)`, and `keeps the COMPANY-WIDE question on the bulk
  configuration list (PEN-5231)`.
  ⚠️ `grep -c PEN-5231` on that file **no longer discriminates** — it returned
  `0` before the merge and `5` after, so both the merged branch and `master` now
  read `5`. It was the cheapest tree check and it is spent; use the
  `decideWithAgentConfigReadGrant` probe above instead.
- `server/src/__tests__/authorization-service.test.ts` — the engine-level proof
  that rows 3a and 3b′ diverge (same grant allowed against an `agent` resource,
  refused `deny_scope` against a `company` one). On `master` since `#3244`.
- `server/src/__tests__/agent-secret-redaction.test.ts` — `agent metadata
  containment on the spread-based redactors`: both projections, including that
  the restricted one is reached via a **peer** row.

- `server/src/__tests__/agent-secret-redaction.test.ts` — `agent workspace
  command withholding (PEN-5225)`: the peer case with `agent_config:read`
  **allowed** and `workspace_runtime:read` denied (the shipped bug is invisible
  to a mock that answers one boolean for both), self-read masked, an entitled
  reader still disclosed, the list and `/configuration` routes, the
  `modelProfiles` nesting, `null`-vs-sentinel-vs-absent, a non-object
  `workspaceStrategy`, and the `PATCH` round-trip restoring the stored command
  instead of persisting the sentinel.
  Three round-trips are pinned, not one, because each reaches a different
  restore function: the top-level config
  (`stripRedactedEnvBindingsFromAdapterConfig`), the `modelProfiles.*`
  nesting (`restoreRedactedRuntimeConfigValues`), and the whole-value sentinel
  a non-object `workspaceStrategy` is masked to.
- `server/src/__tests__/redaction.test.ts` — `hire_agent approval payload
  workspace-command withholding (PEN-5225)`: the shared projection itself —
  both copies of the config in the card, the `modelProfiles` nesting, the
  withheld-by-default polarity, the two gates staying independent and
  distinguishable, and a non-hire card left untouched.
- `server/src/__tests__/approval-agent-config-authz-routes.test.ts` —
  `hire_agent approval reads withhold host-executed workspace commands
  (PEN-5225)`: the same question at the route layer, for the reader that
  clears `agent_config:read` and not `workspace_runtime:read`, on
  `GET /approvals/:id`, the company list, and a resolution response, with a
  board reader still disclosed. The `workspaceStrategy` carrier sits on the
  file's **shared** fixture, so every case in it would catch a re-disclosure.

- `server/src/__tests__/agent-secret-redaction.test.ts` — `does not manufacture
  config keys a PARTIAL revision snapshot never stored`, and its fail-closed
  twin `still contains a stored but non-plain-object config to {}`. The pair is
  the point: the first pins that absent stays absent, the second that the
  containment it sits next to was not weakened to get there.
- `server/src/__tests__/agent-image-bump.test.ts` — `writes the revision
  snapshot under the camelCase column name`: the key the row declares in
  `changedKeys` is the key its snapshot carries, and the snapshot stays partial.
- `server/src/__tests__/agent-permissions-routes.test.ts` — ``the peer `{}`
  says it was withheld (PEN-5230)``, which pins the right-hand matrix column:
  the markers on both peer routes, **absent** on the viewer's own row and for a
  grant holder, and both config columns still `{}`. Its last case,
  ``emits IDENTICAL markers for a populated and a genuinely empty subject``, is
  the disclosure-budget proof — whole-body equality between the two subjects,
  behind positive controls so it cannot pass against a build with the markers
  stripped. On `master` since 2026-11-02.

