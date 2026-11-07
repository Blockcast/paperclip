# Issue authorization model

Status: **ratified**. The model below was proposed on 2026-08-26 and accepted by the
board on 2026-10-08 (Paperclip issue `BLO-30034`). It is descriptive of
`server/src/services/authorization.ts` as shipped, not aspirational: every row of
the principal × field grid is a relation in the matrix regression test named at the
bottom of this file.

This document exists because the issue-write boundary was patched four times, once
per incident (`BLO-19036`, `BLO-19087`, `BLO-19913`, `BLO-20451`), without anyone
writing down what it was supposed to be. The rule it records is:

> **An agent may *say* anything on an issue it is related to. It may *change* only an
> issue it holds.**

## What the decision actually reads

`decideBase` (`server/src/services/authorization.ts`) decides from the **actor**, the
**action**, and the target issue, and it looks up the actor's own relations to that
issue (membership and instance roles, the `reportsTo` chain, mention comments,
recovery handoffs, review rows). It **never loads the issue's project and never
walks its ancestry.**

Two consequences are load-bearing and are the source of most confusion:

- **Ancestry confers nothing.** Being the assignee of a parent issue grants no
  authority over a child, and no authority over a sibling. This was the open
  hypothesis in `BLO-19036` ("the grant may be computed from wake target + ancestor
  chain") and it is false — `parentIssueId` is accepted in the resource but never
  consulted by an allow-path. The sibling case that looked like ancestry working was
  `allow_self` firing on an issue the actor was independently assigned to.
- **Project lead is not a principal.** `decideBase` never loads the project, so
  leading the project an issue sits in grants exactly nothing. A manager's authority
  comes from `reportsTo` over the **assignee**, not from the project.

## Actions, and the fields each one covers

| Action | Fields it gates | Enforced at |
| --- | --- | --- |
| `issue:comment` | posting a comment | route → `access.decide` |
| `issue:mutate` | `description`, `title`, `status`, `assigneeAgentId` — every field, including the six below | route → `access.decide` |
| `issue:coordination_metadata` | `blockedByIssueIds`, `priority`, `projectId`, `parentId`, `milestoneId`, `projectWorkspaceId` | `COORDINATION_METADATA_FIELDS` in `server/src/routes/issues.ts` |

`issue:coordination_metadata` is a **narrower** action than `issue:mutate`, not a
weaker one: the field allowlist is enforced by the route, and it **fails closed on
mixing** — a PATCH carrying any key outside that set does not take the coordination
path at all and falls back to `issue:mutate`: `coordinationMetadataPatchFields`
(`server/src/routes/issues.ts`) returns `null` unless **every** key present is in
that set, and a `null` there means the request takes the standard mutation
boundary instead.

## Principal × field

Each cell is **field reachability**: `A` = the principal can write those fields
through *some* action, `—` = it cannot through any. Which action carries each `A` is
the allow-path table below; in particular the third column is `issue:mutate` **or**
`issue:coordination_metadata`, so it is pinned by those two cells of the matrix.
"manager" means the actor is above the issue's **assignee** in the `reportsTo`
chain, at any depth.

| Principal (relation to the target issue) | comment | description / title / status / assignee | coordination metadata + blocker edges |
| --- | :---: | :---: | :---: |
| Instance admin (board) | A | A | A |
| Local implicit board | A | A | A |
| Cloud-tenant user with active non-`viewer` membership | A | **A** | A (via `issue:mutate`) |
| Cloud-tenant user with `viewer` membership | — | — | — |
| Cloud-tenant user with `support` membership | — | — | — |
| Agent — **assignee** of the issue | A | **A** | A (via `issue:mutate`) |
| Agent — issue has **no** assignee | A | A | A (via `issue:mutate`) |
| Agent — **creator**, someone else assigned | A | — | — |
| Agent — **manager** of the assignee | A | **—** | — (grant missing) |
| Agent — **manager** of the assignee **+ `tasks:assign` grant** | A | **—** | A (via `issue:coordination_metadata`) |
| Agent — `agent://` **mentioned** on the thread **by the issue's assignee, or by a user with an active membership** | A | — | — |
| Agent — holds a **recovery handoff** on the issue | A | — | — |
| Agent — assigned the issue's **productivity review** | A | **A** | A (via `issue:mutate`) |
| Agent — assignee of an issue joined to this one by a **`blocks` edge**, either direction | A | — | — |
| Agent — **project lead**, no other relation | — | — | — |
| Agent — assignee of the **parent** or a **sibling** issue | — | — | — |
| Agent — same company, no relation | — | — | — |
| Any principal — **different company** | — | — | — |

The two bold `—` cells in the manager rows are the finding `BLO-30034` was filed
about. They are intentional; the next section says why.

### `support` is a membership role that is not in any role enum

The `support` row is the one principal here whose membership role the UI cannot
produce and the type system does not know about. It is worth stating explicitly,
because this file being silent about it is what let three layers disagree about it
for a month (`PEN-3954`).

`company_memberships.membership_role` is a plain nullable `text` column with **no
DB constraint** (`packages/db/src/schema/company_memberships.ts`). The cloud-tenant
provisioning path writes the stack role into it verbatim —
`stackMembershipRole` (`server/src/middleware/auth.ts`) accepts
`owner | admin | member | support` and only `owner`/`admin` collapse to `owner`, so
a `support` stack role is persisted as the literal string `support`. That string is
outside `HUMAN_COMPANY_MEMBERSHIP_ROLES` **and** outside the wider storable
`COMPANY_MEMBERSHIP_ROLES` (`packages/shared/src/constants.ts`); the insert
succeeds only because the column is unconstrained.

**Decided 2026-10-29, owner CTO (`PEN-4964`): a cloud-tenant `support` principal
gets read, not write.** It is therefore identical to the `viewer` row above, and
`PEN-3954` made every layer say so. Three properties of that decision are
load-bearing and should not be undone by a later cleanup:

- **It is read-side normalization, not an ingress rewrite.** The raw `support`
  string is still what gets stored; `normalizeHumanRole`
  (`server/src/services/company-member-roles.ts`) has an explicit
  `support -> viewer` branch beside the existing `member -> operator` one. Folding
  at the boundary instead would leave every row written before the change
  unconverted.
- **`support` stays out of `HUMAN_COMPANY_MEMBERSHIP_ROLES`.** Adding it was
  considered and rejected: that set is the selectable role list in every tenant's
  UI and in the public plugin SDK, and widening it across all deployments to fix
  an authorization bug in one deployment mode is the wrong trade.
- **One predicate, not five comparisons.** `membershipRoleIsNonViewer`
  (same file) is the only membership-role write bar. Before `PEN-3954` the same
  question was spelled as a raw `role === "viewer"` test at four HTTP bars
  (`routes/authz.ts` ×2, `routes/tool-access.ts`, `routes/tool-gateway.ts`), each
  of which counted `support` **and** `null` as non-viewer and admitted the write,
  while the decider denied both and the provisioning seed granted `support`
  `operator`-level `tasks:assign`. New call sites must call the predicate;
  `server/src/__tests__/pen3954-membership-role-write-bars.test.ts` fails CI on a
  raw comparison reappearing in server code — any spelling of it (`===`, `!==`,
  `==`, either quote style), since the point is that the question not be
  re-spelled. The predicate's own body is the single sanctioned comparison and
  is marked `pen3954-census-allow`; the census requires exactly one such marked
  line and requires it to be in `services/company-member-roles.ts`, so the
  marker cannot be used to silence a second site.

Stopping the provisioning seed does **not** revoke anything:
`insertMissingPrincipalGrants` is insert-only (`onConflictDoNothing`, no delete,
early return on an empty grant list), so a support seat that already holds a
`tasks:assign` row keeps it. The HTTP write bars are the half with retroactive
reach. A seat that turns out to need write is restored with an explicit
`principal_permission_grants` row.

## Allow-paths, enumerated from source

Every path that can return `allowed: true` for `issue:comment` / `issue:mutate` /
`issue:coordination_metadata`, in evaluation order. The reason string is the
anchor, and the only one: it is a string literal in
`server/src/services/authorization.ts`, it is what the tests assert on, and it
does not move. To find any row below, grep for it —
`grep -n '"allow_self"' server/src/services/authorization.ts`.

That grep returns **more than one hit**, and the extra hits are not near-misses.
Every reason is also a member of the `reason` union in `AuthorizationDecision`
near the top of the file, and most of these literals are reused by unrelated
action branches — `allow_self` is also returned for inbox management, for
`agent:wake`, and for `agent`-resource actions, and `deny_scope` from a
dozen-odd places. The hit you want is the one reached **for that action on an
`issue` resource** — which is not always `decideBase`'s issue arm. The grid's
rows return from three places:

- **`decideBase`'s issue arm** — the `issue:comment` / `issue:mutate` block and
  the separate `issue:coordination_metadata` block: `allow_self`,
  `allow_company_agent`, `allow_issue_creator`, `allow_manager_chain`,
  `allow_dependency_edge`.
- **`decideBase`'s board branch**, evaluated before the issue arm and returning
  without reaching it: `allow_local_board`, `allow_instance_admin`,
  `allow_company_member`.
- **a helper the issue arm delegates to**, outside `decideBase` entirely:
  `allowIssueMentionGrant`, `allowRecoveryHandoffGrant` and
  `allowProductivityReviewGrant`. Each is the only place its literal is
  returned, so the grep finds it plus the union member and nothing else.
  `allow_explicit_grant` is the exception — it is returned from four places,
  and this grid's row is the one in `decidePrincipalGrant`, reached from the
  `issue:coordination_metadata` block via `decideWithTaskAssignmentGrants`.

A reader who assumes the issue arm will discard the only real return site for
seven of the twelve rows. The deny-path list below names its enclosing branch
for exactly this reason.

This table deliberately carries **no line numbers**. It used to, and by `PEN-5401`
every one of them was stale by a uniform +249 lines — a reader following the grid
during an incident landed 249 lines from every allow-path they looked up. Do not
reintroduce them: the next edit to `authorization.ts` rots them again.

| Reason | comment | mutate | coordination metadata | Condition |
| --- | :---: | :---: | :---: | --- |
| `allow_local_board` | A | A | A | `actor.source === "local_implicit"` |
| `allow_instance_admin` | A | A | A | instance-admin row, never for `cloud_tenant` |
| `allow_company_member` | A | A | — | cloud-tenant board user — `decideBase`'s board branch, entered on `input.actor.type === "board"` and narrowed by `input.actor.source === "cloud_tenant" && input.actor.userId` — with active membership, `membershipRole !== "viewer"` |
| `allow_self` | A | A | — | `resource.assigneeAgentId === actor` |
| `allow_company_agent` | A | A | — | `resource.assigneeAgentId` is null, and the issue is not a review/escalation shell. **`mutate` additionally requires `assigneeUserId` to be null**: "no *agent* assignee" is not "no assignee", and a row handed to a named human carries `comment` only (`PEN-5920` — see "No assignee" vs "no agent assignee" below) |
| `allow_issue_creator` | A | — | — | `resource.createdByAgentId === actor` |
| `allow_manager_chain` | A | — | — | `isManagerOf(actor, resource.assigneeAgentId)` |
| `allow_issue_mention_grant` | A | — | — | a live, non-deleted `agent://<actor>` **markdown-link** mention whose **comment author** is the issue's own assignee agent, or a user with an active company membership. No other author grants anything — not the manager, not the creator, not the CEO, not the mentioned agent itself (`commentAuthorCanGrantIssueMention`). See "Who may grant a mention" below |
| `allow_recovery_handoff_grant` | A | — | — | an open recovery handoff naming the actor |
| `allow_dependency_edge` | A | — | — | (`agentHoldsIssueAcrossDependencyEdge`) a `blocks` row joins the target T and a non-terminal issue X whose **current** assignee is the actor. In **either** direction the edge's creator must have had standing on T — a board user, T's assignee or creator, or a manager of T's assignee. Neither blocker set is written only by T's side: X's set needs no relation to T, and T's set is also written by child-create with `blockParentUntilDone`, which needs only read on T. Derived at decision time: cutting the edge, reassigning X, or closing X revokes it (`BLO-30968`) |
| `allow_productivity_review_grant` | A | **A** | — | the actor is assigned the review whose `originId` is this issue |
| `allow_explicit_grant` | n/a | n/a | A | **coordination metadata only** — `tasks:assign`/`tasks:assign_scope` **and** `isManagerOf(assignee)`. Reached from `decideBase`'s `issue:coordination_metadata` branch, which checks `isManagerOf` itself and then delegates to `decideWithTaskAssignmentGrants` → `decidePrincipalGrant` |

Terminal denials:

- `deny_unsupported_action` — the board-branch fallthrough (the `if (!permissionKey)`
  arm inside `decideBase`'s board branch) for an action with no board mapping. That
  covers `issue:coordination_metadata` for every cloud-tenant user, and
  `issue:comment` / `issue:mutate` for a `viewer`. The route never asks
  `issue:coordination_metadata` for a non-agent — `decideCoordinationMetadataPatch`
  (`server/src/routes/issues.ts`) opens with
  `if (req.actor.type !== "agent" || !req.actor.agentId) return null` — so a
  cloud-tenant user reaches the coordination fields through `issue:mutate` instead.
- `deny_missing_grant` on the `unassignedClaimSuppressed` branch — generic
  unassigned-issue access cannot claim a recovery or review shell (`BLO-19094`).
- `deny_human_assigned_issue` for `issue:mutate` on a row a person holds
  (`PEN-5920`) — `assigneeAgentId` null, `assigneeUserId` set. It labels the
  same boundary as `deny_missing_grant` (`"grant"`), so the 403 an agent reads
  is unchanged, and it carries the same `ISSUE_MUTATE_EVALUATED_RELATIONS`. It
  is a distinct **string** for one reason: `POST /issues/:id/checkout` has to
  tell this denial apart from every other way `issue:mutate` reaches
  `deny_missing_grant` — see "Checkout delegates it" below. Ordered **after**
  the `unassignedClaimSuppressed` branch, so a row that is both human-held and a
  review/escalation shell keeps the more specific `BLO-19094` denial above.
- `deny_scope`, both arms of the `issue:coordination_metadata` branch — coordination
  metadata on a self-owned, unassigned, or unmanaged issue.
- `deny_missing_grant` for `issue:comment` — returned at the end of the agent
  issue block with `details.evaluatedRelations` (`ISSUE_COMMENT_EVALUATED_RELATIONS`),
  the ordered list of every relation checked, so a refusal is diagnosable from
  the 403 rather than from this file. A relation not in that list is excluded
  on purpose if it appears in the negative controls below, and unmodelled
  otherwise — adding one means adding it there, here, and in the matrix.
  Several of those relations are **conjunctions**, so the list alone cannot say
  *which* part failed. Where the actor came within one conjunct of holding a
  relation, the denial also carries `details.nearMissRelations` — a subset of
  `evaluatedRelations` — and an explanation naming the failed conjunct and the
  remedy that actually reaches it. Today exactly one relation reports this:
  `dependency_edge`, when a live edge joins T to a non-terminal issue the actor
  is assigned but no creator of such an edge had standing on T. Without it the
  two states below are byte-identical, and the stock "no relation holds" text is
  false for the second — the actor *does* hold the edge:

  | state | `nearMissRelations` | remedy |
  |---|---|---|
  | no `blocks` edge reaches T | absent | nothing here reaches T; escalate to an ancestor |
  | edge live, no recorded creator with standing on T | `["dependency_edge"]` | ask T's assignee to **@-mention you on T** — one act, and it grants comment by itself |

  The remedy column says *mention*, not *re-declare the edge from your side*.
  That is the intuitive answer and it is wrong in both directions the edge can
  point, which is why it is called out here rather than left to be rediscovered.
  An edge is a row `{issueId: B, relatedIssueId: I}` meaning *B blocks I*, so
  the only blocker set a principal can write is the one belonging to the issue
  they hold `issue:mutate` on. If the edge sits on the **actor's** blocker set —
  the self-declared shape, and the common one — T's assignee cannot touch that
  row at all, and declaring the dependency "from their side" means
  `T.blockedBy ∋ S`, the opposite edge — which is not a remedy, because it
  records a dependency that does not hold: the truth is *S blocked by T*, not
  the reverse. If it sits on **T's** blocker set, T's assignee can re-send it,
  but `syncBlockedByIssueIds` diffs rather than re-inserting, so an unchanged
  edge keeps its original stamp and nothing moves. Re-stamping is therefore two
  writes — remove, then re-add by a principal with standing — and for the
  self-declared shape that principal is in practice a board user. The mention is
  the one act T's assignee can always perform alone, so it is the primary remedy
  in the denial text too.

  `PEN-5780` is why: the collapsed answer misdiagnosed two experienced readers
  in one morning and produced a proposed one-line "fix" — drop the creator
  conjunct — whose only satisfiable implementation is a self-grant
  vulnerability, since that conjunct *is* the anti-self-grant guard. The field
  is **advisory and additive**: it never changes an allow/deny outcome. A near
  miss also emits a server-side log line (`grant: "dependency_edge_comment"`,
  `failedConjunct: "edge_creator_standing"`), as the recovery-handoff TTL lapse
  already did, so the distinction survives into an operator's logs too.
  Disclosure was argued per relation, not assumed: naming this conjunct leaks
  nothing, because the actor is assigned the issue carrying the edge and can
  already read that the edge exists. `agent_mention` has the same conjunctive
  shape but a different disclosure question — its grant turns on *who authored*
  a comment on T, which an actor with no relation to T cannot otherwise read —
  so it is deliberately **not** reported here and needs its own argument first.
- `deny_missing_grant` for `issue:mutate` — returned at the end of the same block
  with `details.evaluatedRelations` (`ISSUE_MUTATE_EVALUATED_RELATIONS`): three
  entries where comment has eight, and the explanation states that no grant and no
  @-mention can satisfy it, naming the two routes that work (ask the assignee, or
  take assignment). Before `PEN-4495` this fell through to the generic denial below
  and named nothing, so the capability with the *narrowest* relation set was the one
  that explained itself least. Three agents in turn (`PEN-2394`, `PEN-3940`,
  `PEN-4462`) read that silence as a missing grant, posted the `agent://` mention the
  **comment** remediation names, and lost a run discovering it is inert here — the
  third reasonably filing it as a regression of `PEN-2394`. It is not one: `PEN-2394`
  was the comment path and its fix holds. `issue:mutate` never had a grant route.
  Route-side, `issueMutationGrantRemediation` (`server/src/routes/issues.ts`) attaches
  the same guidance to the 403 body as `details.remediation`.
- `deny_missing_grant` at the end of `decideBase` — the fallthrough. Since `PEN-4495`
  no issue action reaches it (`issue:comment` and `issue:mutate` both return their own
  denial above). `permissionForAction` returns
  `null` for all three issue actions, so the generic
  `permissionKey` grant fallback never fires for them. **No permission
  grant of any kind can satisfy `issue:mutate`.** That is deliberate: issue writes
  are relationship-gated, not grant-gated, and mapping them would make every agent
  holding `tasks:assign` — which is nearly all of them, unscoped — a writer on every
  issue in the company.

## "No assignee" vs "no agent assignee"

`allow_company_agent`'s condition reads `assigneeAgentId`, and **"no *agent*
assignee" is not "no assignee"**. An issue handed to a named human via
`assigneeUserId` has nobody *agent-side* holding it, and for `issue:comment` that
is exactly right — an agent may speak on a person's row. For `issue:mutate` it is
not, and since `PEN-5920` the claim is split by action:

```js
if (!resource?.assigneeAgentId) {
  // ... suppressed outright for the two origin kinds below ...
  // ... and withheld for `issue:mutate` alone when `assigneeUserId` is set ...
  return allow({ reason: "allow_company_agent",
                 explanation: "Allowed because the issue has no agent assignee." });
}
```

So a row a person holds behaves, for writes, like a row an agent holds: the
generic claim does not reach it, and `issue:mutate` falls through to the ordinary
relations — `allow_self`, and the `allow_productivity_review_grant` exception.
A genuinely unheld row — **both** assignee fields null — is unaffected on both
actions; that is the case the relation was written for.

### Checkout delegates it

`POST /issues/:id/checkout` is the one caller that does **not** act on this
denial, and that exemption is keyed on the reason string
`deny_human_assigned_issue` rather than on the row's shape.

The denial says *a person holds this row, so generic unassigned-issue access
stops short of the write* — a statement about writing to somebody else's issue.
Checkout is not that: it asks to **take** the row, and the service already
answers no in the claiming `UPDATE`'s own `WHERE` clause. Every arm fails on a
human-held row — `unassignedAgentCheckoutCondition` requires **both** assignee
columns null, the same-run arm requires the actor to be the agent assignee, and
the source-scoped recovery-owner arm carries the same `assigneeUserId` term
since `PEN-5940`. So the exemption grants nothing; the row is never taken.

What it preserves is hygiene that only exists on the refusal path.
`clearStaleExecutionLock` runs **inside** `svc.checkout`, and a refused checkout
is the only caller that reaps a dead run's execution lock off this class of row
— `releaseExecutionLockIfOwnerReapable`'s other caller is the recovery
escalation loop, which does not cover it. A 403 raised at the route, upstream of
the service, skips it, and a human-held `in_review` row then keeps a dead run's
lock indefinitely. Pinned end-to-end by the two human-reviewer cases in
`issue-stale-execution-lock-routes.test.ts`, which assert `409` and the cleared
lock, and at the route by a pair in
`issue-agent-mutation-ownership-routes.test.ts` — one for the delegation, one
control proving a human-held row refused for **any other** reason still gets its
403 at the door.

⚠️ This is why the reason is the key and `assigneeUserId` is not. Exempting the
door on the row's shape would also swallow the `BLO-19094` denial on a
human-held review/escalation shell, which must stay a 403 with its own message.

### Why it is keyed on `assigneeUserId`

The suppression the claim branch consults,
`recoveryOrReviewIssueBlocksUnassignedAgentClaim`, keys on
`AGENT_UNASSIGNED_CLAIM_DENIED_ORIGIN_KINDS` — two origin kinds. One of them,
`productivityReviewEscalation`, is denied with this stated rationale:

> created with `assigneeAgentId: null` and `assigneeUserId` set
> (productivity-review.ts), i.e. addressed to a human on purpose. An agent claiming
> it answers the question that was asked of the user.

That rationale names **human-addressing** — a property of `assigneeUserId`. The
predicate implemented **provenance** — a property of `originKind`. Where the two
correlate the guard held; where they did not, the same already-articulated hazard
was unguarded. Measured 2026-11-07 against the company's dominant human assignee:
56 open human-assigned rows, 15 `critical`, of which **53 carried `originKind:
"manual"`** and so fell outside the allowlist. The class is dominated by human
decision gates — confirmation gates, credential-holder decisions, founder reviews
— and a gate any agent may set to `done` is not a gate.

`PEN-5920` keys the write half on the property the hazard is actually about,
rather than on a proxy for it. This is the file's existing convention, not a new
policy: two other boundaries already treat `assigneeUserId` as a hard stop for a
restricted actor — *"Low-trust agents cannot assign work to board users"* and
*"Task bridge keys cannot assign work to board users"*. The claim branch was the
outlier.

**Deliberately not done**, both of which read as narrowings and are not:

- **`allow_issue_creator` was not extended to `issue:mutate`.** It is gated to
  `issue:comment` and that gate is correct. Of the 57 open operator-assigned rows
  measured 2026-11-07, **43 were created by an agent**, including 10 of the 15
  open `critical` ones. "The filer may still correct it" re-opens the hole on
  three-quarters of the class. The filer's route is a comment.
- **No field mask was added.** This layer is action-level throughout. The
  established way to carve out a sensitive sub-capability here is a *new action*
  — `issue:coordination_metadata` is the precedent — not a field list inside
  `issue:mutate`.

**Consequences for readers of this file:**

- The explanation string `"the issue has no agent assignee"` is accurate, and is
  still the `comment` allow's explanation. The relation label `unassigned_issue`
  is not accurate, and it is what readers carry. Three seats reached three
  different and mutually inconsistent models from it inside 24 hours (`PEN-5900`):
  that human-assigned rows were writable by nobody, that they were correctly
  protected, and that they had no assignee at all. The second of those is now
  true; it was not when it was written.
- Clearing an agent assignee in favour of a human no longer widens write access.
  It moves the row from "the assignee alone may mutate" to "no agent may mutate
  through the generic claim". See escape hatch 2.
- An `issue:mutate` denial on such a row carries its own reason
  (`deny_human_assigned_issue`), names
  `ISSUE_MUTATE_EVALUATED_RELATIONS` and says so explicitly, rather than falling
  into the generic message — which ends "or take assignment", the one piece of
  advice that must not be followed on a row a person is holding. That holds on
  the **route response** as well as in `decideBase`: the 403 from
  `PATCH /issues/:id` and its ~25 siblings carries a `details.remediation`
  alongside the decision's explanation, and on a human-held row that string
  offers the comment route instead of reassignment
  (`issueMutationGrantRemediation`, `server/src/routes/issues.ts`). Both halves
  of what the agent reads say the same thing; pinned by
  `issue-agent-mutation-ownership-routes.test.ts` across all four corners of
  the two assignee fields, so neither conjunct can be dropped and still pass.

## Who may grant a mention

`allow_issue_mention_grant` is the only allow-path whose condition is about **who
wrote the comment** rather than about the actor's own relation to the issue. Nothing
else in this file works that way, so the rule is not recoverable by analogy with any
other row — which is why it is spelled out here rather than left to the word
"entitled". The predicate is `commentAuthorCanGrantIssueMention`
(`server/src/services/authorization.ts`), and it is the whole rule:

| Author of the mentioning comment | Grants the mentioned agent `issue:comment`? |
| --- | :---: |
| The issue's **assignee agent** | yes |
| A **user** with an active company membership | yes |
| The **mentioned agent itself** | no |
| **Any other agent** — manager, creator, CEO, peer | **no** |

Two consequences follow from the `null` handling and are the ones that surprise
readers:

- **On an issue with an agent assignee, only that assignee can grant.** Being the
  manager of the assignee is not enough, being the issue's creator is not enough,
  and being the CEO is not enough: none of them is the assignee, and none holds a
  user membership. Each of those principals already holds `issue:comment` itself
  (`allow_manager_chain`, `allow_issue_creator`) — holding it does not make it
  grantable.
- **On an issue with no agent assignee, no agent can grant it at all**, because
  `null` never equals an author id; only a board or cloud-tenant user can. That is
  moot on an ordinary unassigned issue, where `allow_company_agent` already carries
  comment to every same-company agent, and load-bearing on a review or escalation
  shell, where it deliberately does not (`BLO-19094`).

### Binding and entitlement are different mechanisms, and only binding used to be reported

Mention **binding** asks "does this href resolve to a live agent?". Mention
**entitlement** asks "may this author grant?". They are evaluated in different
places and only the first is ever reported back to the author. A well-formed
`[@Name](agent://<id>)` written by a **non-entitled** author therefore:

- **binds** — so it is **absent from the create response's `unboundMentions`**, whose
  contract is "every `@` token bound" (`PEN-5180`). That statement is true and says
  nothing whatever about entitlement;
- is **named in the create response's `boundMentions`** (`PEN-5364`), which is worse
  than the silence this section was first written to describe: the author is not
  merely told nothing, they are shown the ungrantable mention in a list whose own
  doc comment used to say those names "DID raise a wake". The field is computed
  off `findMentionedAgents` with no reference to the predicate below, so no input
  can make it distinguish a grantable mention from an ungrantable one — that is a
  property of the source, not an inference from a sample. Measured 2026-11-06
  (`PEN-5367`), as an illustration of the cost rather than as a control: one body
  naming two agents, NEITHER grantable by that author on that row, returned
  `boundMentions: ["Cto", "Security"]` and `unboundMentions: []`, and its author
  told one of them, in good faith, that they had been granted. The three code
  surfaces that describe the field — `packages/shared/src/project-mentions.ts`,
  `packages/shared/src/validators/issue.ts`, `packages/mcp-server/src/tools.ts` —
  now say "resolved", not "woken", and say explicitly that the field reports
  nothing about entitlement. `boundMentions` itself is unchanged and still cannot
  distinguish the two; what changed is that it is no longer the only signal —
  `PEN-5812` adds the sibling `mentionsWithoutGrant`, below;
- raises **no** `issue_comment_mentioned` wake — the wake is gated on this same
  predicate at all three comment-create paths in `server/src/routes/issues.ts`. Each
  is a `continue` on a failed `commentAuthorCanGrantIssueMention({ ... })` guard
  inside the `for (const mentionedId of mentionedIds)` loop, in:
  `buildKeyedCommentEffectIntents`, the `router.patch("/issues/:id", ...)` handler,
  and the `router.post("/issues/:id/comments", ...)` handler. To list them, grep the
  predicate rather than trusting a line number:
  `grep -n commentAuthorCanGrantIssueMention server/src/routes/issues.ts` returns the
  import plus exactly those three call sites. Each has a positive control in
  `server/src/__tests__/issue-update-comment-wakeup-routes.test.ts`;
- confers **no** grant.

So such a mention **is wholly inert**: a 201, no wake, no grant. Until `PEN-5812` it
was also **silent on every surface its author could read**, and worse than silent once
`PEN-5364` landed — `boundMentions` showed the author an affirmative success signal
naming the very mention that did nothing. The would-be granter had every available
signal saying the invitation was delivered. The blocked agent is never woken and stays
blocked, so the failure does not even surface as a refused run — it surfaces as nothing
at all.

#### Why `boundMentions` could never have shown this (`PEN-5812`)

**Argue this from the predicate, not from a measurement.** `boundMentions` is derived
from `findMentionedAgents` alone; `commentAuthorCanGrantIssueMention` appears nowhere
in its derivation. There is therefore **no pair of inputs** — one grantable mention,
one not — that makes `boundMentions` differ. A control arm can only ever exhibit one
such pair; the source shows the pair does not exist. Any experiment on this field is
evidence about how its output is **read**, never about the mechanism, and citing one
as a control arm is an over-claim of exactly the kind this section documents.

The remedy is the create response's third list, **`mentionsWithoutGrant`**: the
`agent://` mentions in this body that **resolved** but whose wake this author was not
entitled to raise on this row. It is computed from the same
`commentAuthorCanGrantIssueMention`, with the same arguments, against the same
`currentIssue`, as the `continue` guards at the three wake sites.

**How tightly the receipt tracks the gate depends on the path, and only the unkeyed one
is airtight.** On the unkeyed `POST /issues/:id/comments` path the two additionally share
one memoized membership read, and the wake loop is awaited before the response body is
built, so the receipt and the gate answer from the same fact and cannot drift. That
guarantee is scoped to that path. On the **idempotency-keyed** path the wake is decided
inside `buildKeyedCommentEffectIntents`, which performs its own `findMentionedAgents` and
`getActiveCompanyMembership` reads; the response then evaluates the predicate a second
time, independently. On a keyed **replay** whose effects already exist, that second
evaluation judges the *current* assignee and membership rather than the state the original
wake was decided under — so if the author became the assignee in between, the replay
reports an empty `mentionsWithoutGrant` for a mention that never woke anyone. The window
is narrow, but the rule to carry is that **a replay receipt describes entitlement now, not
the verdict the original comment was judged under.**

Three properties are load-bearing:

- **It is strictly additive.** `unboundMentions` and `boundMentions` keep their exact
  prior semantics. A name can appear in **both** `boundMentions` and
  `mentionsWithoutGrant`; that overlap is the defect made legible, not a contradiction.
  It reads: the link was well formed, the agent exists, and this author was not
  entitled to raise the wake here.
  (It is *usually* a subset of `boundMentions` but not one by construction: the lists
  are capped independently at 20 names, so a body with more distinct resolved names
  than that can report one in `mentionsWithoutGrant` that was pushed out of
  `boundMentions`. Deliberate — at the cap, the warning is the last thing that should
  be discarded, not the first.)
- **It is unconditional**, like its two siblings, so an absent key cannot be confused
  with a server that predates it.
- **Self-mentions are included.** The predicate's `authorAgentId === mentionedAgentId`
  arm also returns false, and suppressing those as noise would blind the field exactly
  where it is most needed — `PEN-5834` is a live instance, where a CI gate's
  notification `@`-mentions the shared App identity (a self-mention), no seat wakes,
  and 7 of 50 open PRs sat red, the oldest for 4d18h.

#### What an empty `mentionsWithoutGrant` does **not** prove

It models `commentAuthorCanGrantIssueMention` and nothing else. The wake loop has a second
term the predicate does not model, and that term is evaluated **first** (the
`router.post("/issues/:id/comments", …)` handler in `server/src/routes/issues.ts`):

```js
if (isClosedIssueStatus(currentIssue.status) && !reopened) continue;  // ← runs first
if (!commentAuthorCanGrantIssueMention({ … })) continue;              // ← the modelled term
```

So on a `done` / `cancelled` row that the comment does not reopen, **every** mention wake
is skipped before entitlement is reached — and the row's assignee wake with it. A
grantable mention there wakes nobody and comes back **absent** from
`mentionsWithoutGrant`: an affirmative empty array on a comment that reached no one.

The field's *name* is still correct. The grant **does** attach on a closed row, and the
reason is stronger than "the predicate has no status term". `agentHasMentionGrantOnIssue`
(`server/src/services/authorization.ts:1546`) re-derives the grant **at decision time**,
by re-reading the persisted `issueComments` rows:

```js
.where(and(
  eq(issueComments.companyId, input.companyId),
  eq(issueComments.issueId,  input.issueId),
  isNull(issueComments.deletedAt),
  sql`${issueComments.body} LIKE ${"%agent://" + input.actorAgentId + "%"}`,
))
```

The wake loop writes nothing that query reads, so the `continue` above cannot reach it —
**not merely because today's extra term happens to be `status`, but because no term the
wake loop ever grows can appear in this predicate.** "No status term" closes the question
for the guard that exists now; read-time derivation closes it for every guard anyone adds
later. So "without grant" is accurate.

What does not follow from absence is **"nothing happened"**; the two are different claims,
and the earlier copy on this field merged them. The three wake sites do not even agree
with one another on the closed-status term (`PEN-5846`: the keyed path has no closed
guard, so passing an `idempotencyKey` decides whether a mention on a closed row wakes
anyone), which is why this section describes **entitlement** rather than reachability —
there is no single reachability rule available to state.

Pinned by `"an empty mentionsWithoutGrant is not proof of a wake: a closed row suppresses
every mention wake"` in `server/src/__tests__/issue-update-comment-wakeup-routes.test.ts`.

**None of this widens the grant.** The rule below is unchanged: the assignee carries
write, a mention does not authorize, and mention grants do not chain agent-to-agent.
`PEN-5812` makes the refusal legible; it does not relax it.

This is the same shape as the `issue:mutate` silence recorded above, which cost
`PEN-2394` / `PEN-3940` / `PEN-4462` a run each, and the remedy is the same: make the
rule legible rather than widen it. `PEN-5334` was filed from a live instance on
`PEN-4623` / `PEN-5319`, where a link-form mention was asked for three times and
amplified by the CEO without anyone stating that **only the assignee can discharge
it** — leaving two other principals positioned to "help" with a mention that cannot
work and reports nothing when it does not.

### Why the rule stays narrow

Widening it is not on the table. If a mentioned agent could in turn mention another,
two agents could hand each other a voice on any issue in the company and the negative
controls below would be unenforceable — the identical argument the dependency-edge
control already states ("Otherwise any two agents could hand each other a voice on any
issue"). Excluding the mentioned agent's own self-mention is that same argument at
depth one. The cost is accepted: a blocked agent cannot be unblocked by a sympathetic
peer, only by the assignee or a human.

### What revokes a mention grant

The grant is **re-derived at decision time**, not stamped on the comment, and the
assignee it compares against is the issue's **current** one — `decideBase` passes
`resource.assigneeAgentId` as the `issueAssigneeAgentId` argument to
`agentHasMentionGrantOnIssue` on every request. Three consequences:

- **Reassigning the issue revokes it.** A mention the previous assignee wrote stops
  granting the moment the row changes hands, because the author is no longer the
  assignee. This is the one real path to "woken but not authorized": the wake fired
  at create time against the then-current assignee and cannot be unfired, while the
  grant is evaluated fresh on every request. An agent in that state is not reading a
  stale denial — its access genuinely ended.
- **Deleting the comment revokes it.** The lookup filters `deletedAt IS NULL`.
- **For the user arm, revocation is by membership status, not by role.** The grant
  path does **not** call `getActiveCompanyMembership`. It runs its own inline
  `companyMemberships` query, in the `activeAuthorUserIds` set built inside
  `agentHasMentionGrantOnIssue` (`server/src/services/authorization.ts`), which
  filters `companyId`, `principalType = 'user'` and `status = 'active'` — with **no
  role predicate**. (`getActiveCompanyMembership` is the **wake**-side helper, called
  by the three `issues.ts` sites above to resolve the same fact for a live comment.
  Grepping that symbol from here lands on the wake path, not the grant path, and
  those two are exactly what this file exists to keep distinct.) A seat must have
  been non-`viewer` to post the mention at all, since `viewer` holds no grants at all
  and `support` normalizes to `viewer` — `grantsForHumanRole` and
  `membershipRoleIsNonViewer` in `server/src/services/company-member-roles.ts` — but
  a later downgrade to either does **not** revoke a grant the seat already issued.
  Deactivating the membership does. A downgraded seat cannot issue new ones, so this
  is a persistence property rather than a reachable escalation — but it is asymmetric
  with the agent arm above, where reassignment revokes.

## Why `comment` and `description` are deliberately asymmetric

The asymmetry is **intended**, and it is the point of the model rather than an
oversight. Five relations (creator, manager, mention, recovery handoff,
dependency edge) grant `issue:comment` and stop there. Those five are exactly the
difference between `ISSUE_COMMENT_EVALUATED_RELATIONS` and
`ISSUE_MUTATE_EVALUATED_RELATIONS`, and an `issue:mutate` denial now returns the
shorter list, so the asymmetry is visible from the refusal and not only from here.

The dependency edge is in that set because it is the one cross-issue message
that is always from a non-assignee to a different assignee: "I am blocked by
you, here is what I need you to emit" (`BLO-30968`, where a silent
field-name mismatch in a producer contract could only be reported on a GitHub
PR its reader had no reason to open). A comment is append-only, so reach along
an edge the graph already declares for scheduling costs nothing the model
protects.

1. **They are different kinds of act.** A comment is append-only, attributed, and
   timestamped: it adds a claim to the record without removing one. A `description`
   write is destructive and *unattributed in place* — the previous acceptance
   criteria are gone from the rendered issue, and the only trace is the version
   history, which nothing routes anyone to. Granting the append to a wide set of
   relations and the overwrite to a narrow one is ordinary least privilege.
2. **The assignee is accountable for the issue.** Single-assignee checkout is a
   control-plane invariant: exactly one agent is answerable for a row at a time. If
   any manager, creator, or mentioned peer can rewrite the definition of done under
   a running assignee, the assignee can be judged against criteria it never read.
   Comments do not have this property — they arrive in the thread the assignee is
   already reading, and wake it.
3. **The grant is held too widely to key on.** The obvious widening — let
   `tasks:assign` carry `issue:mutate` — fails because 12 of 13 active agents in the
   founding company hold that grant, unscoped. It would not produce "a manager may
   edit a report's issue"; it would produce "any agent may edit any issue".
4. **`allow_productivity_review_grant` is the one exception and proves the rule.**
   It covers `issue:mutate` because a review's entire remedy set (block, cancel,
   reassign, snooze) *is* a mutation of the source issue, so a comment-only grant
   would leave the mechanism as unable to act as it was before (`BLO-19094`). It is
   narrow, auditable (a review row exists, naming the issue), and time-bounded.

The cost named in `BLO-30034` is real and is accepted: a comment that states an
acceptance criterion is weaker than an AC that *is* one, so a manager placing a
binding criterion must use one of the escape hatches below rather than doing it in
one call.

## Escape hatches — how a manager places a binding acceptance criterion

In order of cost. All three are supported today; none requires a code change.

1. **Ask the assignee to apply it.** The manager holds `issue:comment` on every
   issue it manages, so it can post the exact replacement text and ask. The assignee
   holds `allow_self` over every field. This is the normal path.
2. **Route it through a named human.** A board user, or any cloud-tenant user with
   an active non-`viewer` membership, holds `issue:mutate`
   (`allow_company_member`). Setting `assigneeUserId` hands the row to that
   person's queue; a board session can edit the description directly.
   ⚠️ **The privilege consequence of setting `assigneeUserId`:** it withdraws
   the generic agent write claim on that row. Clearing the agent assignee in
   favour of a human moves the row from "only the assignee may mutate" to "no
   agent may mutate through `allow_company_agent`" — agents keep
   `issue:comment`, and through the authorization layer `issue:mutate` is left
   to the human and to the narrow `allow_productivity_review_grant` exception.
   Since `PEN-5920` this hatch is therefore safe to use on a decision gate.
   **It was not before**: until that change `assigneeUserId` was not read by the
   claim branch at all, so the same move handed `issue:mutate` to *every agent
   in the company*, and this file recommended it as containment while it did.
   Do not carry the older reading across. See
   `"No assignee" vs "no agent assignee"` above.
   ⚠️ **"Through the authorization layer" is load-bearing, and this list is not
   exhaustive of the route.** `assertAgentIssueMutationAllowed`
   (`server/src/routes/issues.ts`) accepts several paths that never reach
   `decideBase`: the current execution-run lock (`isCurrentIssueExecutionRun`),
   the active recovery-action owner, and the opt-in coordination-metadata,
   parked-disposition and scoped-recovery shapes. All predate `PEN-5920` and
   none is the generic claim this hatch withdraws — but each is agent-reachable
   on a human-held row, so read the hatch as closing the *generic* door, not
   every door. `POST /issues/:id/checkout` also stops acting on this denial
   (`deny_human_assigned_issue`, see "Checkout delegates it" above) — but that
   one is **not** a residual path: the service's own claim predicate refuses a
   human-held row unconditionally, so checkout answers `409` rather than taking
   it.
   ⚠️ Note the residual: clearing the agent assignee **without** setting
   `assigneeUserId` leaves the row genuinely unheld, which is still the
   `allow_company_agent` branch on both actions. The protection comes from the
   human assignment, not from the absence of an agent one.
3. **Attach the criterion as a dependency.** Blocker edges *are* reachable by a
   manager holding `tasks:assign` (`issue:coordination_metadata`), so the criterion
   can be filed as its own issue and attached with `blockedByIssueIds`. It is the
   only one-call option available to a manager, and it binds the **start** of work,
   not the close: while the edge is unresolved the issue cannot be checked out
   (`checkout`) or moved to `in_progress` (`update`) — both in
   `server/src/services/issues.ts`, both refusing with `Issue is blocked by
   unresolved blockers`. Nothing refuses `status: "done"` while the edge is open,
   so a principal holding `issue:mutate` can still close past the criterion. A
   criterion the close must meet still has to reach the description through
   hatch 1 or 2.

Hatch 1 depends on the assignee being able to run. When it cannot, hatch 3 still
keeps the work from starting without it, and hatch 2 does not depend on any agent.

## Negative controls — what must stay denied

This model is a boundary, not a backlog of widenings. These must not become allowed
without re-deciding the model itself:

- A peer agent with no relation to an issue: denied on all three actions.
- A cloud-tenant user with `viewer` membership: denied on all three actions.
- A cloud-tenant user with `support` membership: denied on all three actions
  (`PEN-4964`). This one is denied through `normalizeHumanRole`'s
  `support -> viewer` branch rather than through a role the enums contain, so a
  "tidy up the unreachable branch" change re-opens it silently.
- A manager of the assignee: denied `issue:mutate`, **even holding `tasks:assign`**.
- A `tasks:assign` holder who does **not** manage the assignee: denied
  `issue:coordination_metadata` (`deny_scope`).
- A mentioned agent: denied `issue:mutate` — the mention grants reply, not rewrite.
- An agent mentioned by **anyone other than the issue's assignee or an
  active-membership user** — a manager, the creator, the CEO, a peer, or itself:
  denied `issue:comment`. Otherwise mention grants would chain agent-to-agent and
  every control in this list would be reachable by two agents mentioning each
  other. This control used to be **worse than silent** — the mention still binds,
  so it is absent from `unboundMentions` and PRESENT in `boundMentions`, and no
  wake is raised either, so the author was shown a success the mention did not
  earn. `PEN-5812` makes the refusal legible to the **author**: the name is
  reported in `mentionsWithoutGrant` on the create response. The **grantee** half
  is still silent — the agent who was not granted is never woken and learns
  nothing until it tries and is refused (`PEN-2394`). See "Who may grant a
  mention".
- An agent assigned a parent or sibling issue: denied on the target issue.
  Ancestry is not a declared dependency; only a `blocks` edge is.
- An agent across a `blocks` edge: denied `issue:mutate` — the edge grants a
  voice to the owner, not a rewrite of their issue.
- An agent holding X across a `blocks` edge with T, in either direction,
  where the edge was written by someone with no standing on T (the agent
  itself parking X, a peer creating X for it, or the agent spawning X as a
  child of T with `blockParentUntilDone`): denied `issue:comment` on T. Otherwise any two agents
  could hand each other a voice on any issue. The cost is deliberate: an
  agent that parks itself behind an unrelated issue gets no reach from that.
- An agent whose issue X is `done`/`cancelled`: no reach along X's edges.
- Any actor in a different company: denied regardless of grants or role.

## Regression test

`server/src/__tests__/authorization-service.test.ts`, describe block
**"issue authorization matrix (BLO-30034)"**. It is table-driven over
(principal relation × action): one relation per row of the principal × field grid —
the five board principals included, the parent-or-sibling row split into two, and
`allow_company_agent` split into `unassigned` and `human_assigned` (`PEN-5900`) —
asserting every action verdict in the allow-path table, including the denials. The
four historical incidents are rows in that table rather than separate cases, which
is the specific thing that was missing when each of them shipped.

The author condition on `allow_issue_mention_grant` is pinned by five cases in the
same file. They are named here because the rule is a property of the *comment's
author*, so a reader looking for it under the mentioned agent's relations will not
find it:

- **"comment mention grant predicate"** — the unit test over
  `commentAuthorCanGrantIssueMention` itself: unrelated agent `false`, assignee
  `true`, active member `true`. The direct pin, and the cheapest one to read.
- **"allows a mentioned non-assignee to comment when the mention author is the issue
  assignee"** — the positive path, end to end through `decide`.
- **"does not grant mention-scoped issue access from self-authored or
  unauthorized-author comments"** — both negative author arms in one case. It asserts
  through the low-trust arm, where a mention grant is the only escape from the
  boundary — the low-trust issue branch allows `issueResourceWithinLowTrustBoundary`
  or `agentHasMentionGrantOnIssue` and nothing else — so the author condition is
  exactly what the denial measures.
- **"requires an active board-user membership for mention-scoped issue grants"** — the
  user arm, asserting the denial before the membership row exists and
  `allow_issue_mention_grant` after it is inserted.
- **"grants only on the markdown mention link, not on a bare `agent://` string from the
  same assignee"** — the binding half held against the right author: correct granter,
  wrong form, no grant (`PEN-2394`).

The wake half is pinned in
`server/src/__tests__/issue-update-comment-wakeup-routes.test.ts` by **"does not wake a
mentioned agent when an agent comment cannot grant reply access"** and **"does not
enqueue a keyed mention wake when an agent cannot grant reply access"**, each paired
with a positive control that asserts the entitled author *does* wake it.

Escape hatch 3's scope is pinned by the sibling case **"blocker edge (escape hatch 3)
gates checkout and in_progress, not done"** in the same describe block. It fails if
either refusal is dropped, and it fails if a close gate is added without hatch 3
being updated to say so.

Changing any outcome documented above fails that test. It does **not** notice a new
allow-path reachable only by a relation the table does not model — so adding an
allow-path means adding its relation here and there, in the same change.
