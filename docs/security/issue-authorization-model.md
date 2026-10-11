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

`decideBase` (`server/src/services/authorization.ts`) takes three inputs and nothing
else: the **actor**, the **action**, and the **target issue's own columns**
(`assigneeAgentId`, `createdByAgentId`, `issueId`, `parentIssueId`, `originKind`).

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
| `issue:coordination_metadata` | `blockedByIssueIds`, `priority`, `projectId`, `parentId`, `milestoneId`, `projectWorkspaceId` | `COORDINATION_METADATA_FIELDS`, `server/src/routes/issues.ts:560` |

`issue:coordination_metadata` is a **narrower** action than `issue:mutate`, not a
weaker one: the field allowlist is enforced by the route, and it **fails closed on
mixing** — a PATCH carrying any key outside that set does not take the coordination
path at all and falls back to `issue:mutate` (`server/src/routes/issues.ts:6105`).

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
| Agent — **assignee** of the issue | A | **A** | A (via `issue:mutate`) |
| Agent — issue has **no** assignee | A | A | A (via `issue:mutate`) |
| Agent — **creator**, someone else assigned | A | — | — |
| Agent — **manager** of the assignee | A | **—** | — (grant missing) |
| Agent — **manager** of the assignee **+ `tasks:assign` grant** | A | **—** | A (via `issue:coordination_metadata`) |
| Agent — `agent://` **mentioned** on the thread | A | — | — |
| Agent — holds a **recovery handoff** on the issue | A | — | — |
| Agent — assigned the issue's **productivity review** | A | **A** | A (via `issue:mutate`) |
| Agent — **project lead**, no other relation | — | — | — |
| Agent — assignee of the **parent** or a **sibling** issue | — | — | — |
| Agent — same company, no relation | — | — | — |
| Any principal — **different company** | — | — | — |

The two bold `—` cells in the manager rows are the finding `BLO-30034` was filed
about. They are intentional; the next section says why.

## Allow-paths, enumerated from source

Every path that can return `allowed: true` for `issue:comment` / `issue:mutate` /
`issue:coordination_metadata`, in evaluation order. Line numbers are as of
`98839e63`; the reason strings are stable and are what the tests assert on.

| Reason | `authorization.ts` | comment | mutate | coordination metadata | Condition |
| --- | --- | :---: | :---: | :---: | --- |
| `allow_local_board` | `:1872` | A | A | A | `actor.source === "local_implicit"` |
| `allow_instance_admin` | `:1886` | A | A | A | instance-admin row, never for `cloud_tenant` |
| `allow_company_member` | `:1916` | A | A | — | cloud-tenant board user (`actor.type === "board"`, `:1867`; `actor.source === "cloud_tenant" && actor.userId`, `:1895`) with active membership, `membershipRole !== "viewer"` |
| `allow_self` | `:2420` | A | A | — | `resource.assigneeAgentId === actor` |
| `allow_company_agent` | `:2438` | A | A | — | issue has no assignee, and is not a review/escalation shell |
| `allow_issue_creator` | `:2449` | A | — | — | `resource.createdByAgentId === actor` |
| `allow_manager_chain` | `:2466` | A | — | — | `isManagerOf(actor, resource.assigneeAgentId)` |
| `allow_issue_mention_grant` | `:2481` | A | — | — | a live, non-deleted `agent://<actor>` mention from a principal entitled to grant it |
| `allow_recovery_handoff_grant` | `:2493` | A | — | — | an open recovery handoff naming the actor |
| `allow_productivity_review_grant` | `:2518` | A | **A** | — | the actor is assigned the review whose `originId` is this issue |
| `allow_explicit_grant` | `:857` via `:2411` | n/a | n/a | A | **coordination metadata only** — `tasks:assign`/`tasks:assign_scope` **and** `isManagerOf(assignee)` |

Terminal denials:

- `:2004` `deny_unsupported_action` — the board-branch fallthrough (`:1965`) for an
  action with no board mapping. That covers `issue:coordination_metadata` for every
  cloud-tenant user, and `issue:comment` / `issue:mutate` for a `viewer`. The route
  never asks `issue:coordination_metadata` for a non-agent
  (`server/src/routes/issues.ts:6168`), so a cloud-tenant user reaches the
  coordination fields through `issue:mutate` instead.
- `:2523` `deny_missing_grant` — generic unassigned-issue access cannot claim a
  recovery or review shell (`BLO-19094`).
- `:2398`, `:2404` `deny_scope` — coordination metadata on a self-owned, unassigned,
  or unmanaged issue.
- `:2637` `deny_missing_grant` — the fallthrough. `permissionForAction` returns
  `null` for all three issue actions (`:186`, `:192`), so the generic
  `permissionKey` grant fallback at `:2597` never fires for them. **No permission
  grant of any kind can satisfy `issue:mutate`.** That is deliberate: issue writes
  are relationship-gated, not grant-gated, and mapping them would make every agent
  holding `tasks:assign` — which is nearly all of them, unscoped — a writer on every
  issue in the company.

## Why `comment` and `description` are deliberately asymmetric

The asymmetry is **intended**, and it is the point of the model rather than an
oversight. Four relations (creator, manager, mention, recovery handoff) grant
`issue:comment` and stop there.

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
   an active non-`viewer` membership, holds `issue:mutate` (`:1916`). Setting
   `assigneeUserId` hands the row to that person's queue; a board session can edit
   the description directly.
3. **Attach the criterion as a dependency.** Blocker edges *are* reachable by a
   manager holding `tasks:assign` (`issue:coordination_metadata`), so the criterion
   can be filed as its own issue and attached with `blockedByIssueIds`. This is
   strictly binding — the issue cannot close while the edge is unresolved — and it
   is the only one-call option available to a manager.

Hatch 1 depends on the assignee being able to run. When it cannot, hatch 3 binds
without it and hatch 2 does not depend on any agent.

## Negative controls — what must stay denied

This model is a boundary, not a backlog of widenings. These must not become allowed
without re-deciding the model itself:

- A peer agent with no relation to an issue: denied on all three actions.
- A cloud-tenant user with `viewer` membership: denied on all three actions.
- A manager of the assignee: denied `issue:mutate`, **even holding `tasks:assign`**.
- A `tasks:assign` holder who does **not** manage the assignee: denied
  `issue:coordination_metadata` (`deny_scope`).
- A mentioned agent: denied `issue:mutate` — the mention grants reply, not rewrite.
- An agent assigned a parent or sibling issue: denied on the target issue.
- Any actor in a different company: denied regardless of grants or role.

## Regression test

`server/src/__tests__/authorization-service.test.ts`, describe block
**"issue authorization matrix (BLO-30034)"**. It is table-driven over
(principal relation × action): one relation per row of the principal × field grid —
the four board principals included, and the parent-or-sibling row split into two —
asserting every action verdict in the allow-path table, including the denials. The
four historical incidents are rows in that table rather than separate cases, which
is the specific thing that was missing when each of them shipped.

Changing any outcome documented above fails that test. It does **not** notice a new
allow-path reachable only by a relation the table does not model — so adding an
allow-path means adding its relation here and there, in the same change.
