# onprem-k8s: agent-authored PR review routing (BLO-21564)

The deployed counterpart technical work lives in `Blockcast/onprem-k8s` PR
#2023: <https://github.com/Blockcast/onprem-k8s/pull/2023/files>. It superseded
the closed, unmerged App-authored source PR #2011.

## TL;DR for the next agent

If a PR in `Blockcast/onprem-k8s` has green CI but is still blocked, first
check the review state:

```sh
gh pr view <n> --repo Blockcast/onprem-k8s \
  --json author,headRefOid,mergeable,mergeStateStatus,reviewDecision,reviewRequests

head=$(gh pr view <n> --repo Blockcast/onprem-k8s --json headRefOid \
  --jq .headRefOid)
gh api repos/Blockcast/onprem-k8s/pulls/<n>/reviews --paginate \
  --jq ".[] | select(.commit_id == \"$head\") | {reviewer: .user.login, state}"
```

Read `mergeStateStatus`, not only `mergeable`. `mergeable` only answers
whether GitHub sees a content conflict. A PR can be conflict-free and still
show `mergeStateStatus: BLOCKED` because protected-review requirements are
unsatisfied.

The safe path depends on the PR author:

1. An independent author is neither the `app/allyblockcast` App nor the
   `allyblockcast` User. If the PR is independently authored, obtain both
   reviews on the same exact head SHA:
   - an exact-head review from the `allyblockcast` GitHub App, which supplies
     the evidence accepted by `review/ally-complete`; and
   - a separate exact-head approval from the `allyblockcast` User seat, which
     satisfies the singleton `Blockcast/onprem-k8s-ally-reviewer` team rule.
2. If either required reviewer identity authored the PR, it cannot supply its
   own required review. Reopen the exact intended diff under an independent
   author, link the source PR and its review evidence, and obtain both reviews
   above on the replacement PR's exact head.
3. Do not treat App comments as a formal App review. Do not treat the User-seat
   approval as satisfying `review/ally-complete`, or the App review as
   satisfying the singleton-team approval. Never expose or distribute either
   credential.

The distinct GitHub User account named `allyblockcast` can satisfy the
protected team approval when it is a member of
`Blockcast/onprem-k8s-ally-reviewer`. That User is a real maintain-capable seat,
not the `allyblockcast[bot]` App installation. Its approval is necessary but is
not the App review consumed by `review/ally-complete`.

## Current routing evidence

Org ruleset `19646877` on `Blockcast/onprem-k8s` has a pull-request rule whose
required reviewer is GitHub team `18686279`
(`Blockcast/onprem-k8s-ally-reviewer`) with one required approval across
`*` and `**/*`.

Merged PR #2023 added `* @Blockcast/onprem-k8s-ally-reviewer` as the first
CODEOWNERS entry in the target repo and retained that team on every later
security-path rule alongside the named owners (`kkroo`, `eyad-hussein`, and
`MohamedElmdary`). It independently re-authored and superseded closed,
unmerged App-authored PR #2011. Do not use #2011 as evidence of the deployed
routing state.

The remaining routing requirement is to collect two independent review
artifacts on one immutable head. The Paperclip agent normally authors PRs as
the App identity `allyblockcast[bot]`. A PR authored by either the App or the
`allyblockcast` User requires an independent-author replacement because its
author cannot provide the corresponding required review. The App and User
then provide their distinct review artifacts on that same replacement head.

## Ageing an unanswered review request (BLO-24517)

Routing a request is not the same as getting one answered. Nothing used to
notice that a required-team request had gone unanswered; this is the policy that
does. It is implemented in `server/src/services/pr-review-request-ageing.ts`.

**Threshold: 7 days** of no answering review. **Cap: 15** escalations per sweep,
oldest first, with the remainder reported as a count.

Both numbers come from the live distribution of the 196 open App-authored
`onprem-k8s` PRs carrying an unanswered team request, measured 2026-08-20:
`<3d` 42 · `3–7d` 24 · **`7–14d` 88** · `14–30d` 42 · `>=30d` **0** (median 8d,
oldest 18d). Nothing survives past ~18 days, and not because review arrives — of
the last 250 closed App-authored PRs, 118 merged and **132 were closed
unmerged**, so the queue drains ~47% by abandonment. A threshold near that edge
would fire only after the moment a nudge could still change the outcome. 7d
fires at the front of the largest band; because that is 130 of 196 on day one,
the cap is what keeps the digest readable.

**Escalation target: a named human who is not an ally identity.** File a
Paperclip issue with a non-null `assigneeUserId`. Do **not** re-request a
reviewer on GitHub — see the measurement note below; a request is already
pending on 196 of 206, so re-requesting only adds a duplicate to a queue nobody
is reading. That is the failure mode that put 28 stacked review-request markers
on `paperclip#937`.

The notify set must exclude both `allyblockcast` seats. An escalation the agent
fleet can satisfy itself is not an escalation — the same reason the ageing clock
below refuses to count an ally review as an answer.

**Idempotency: one escalation per PR, ever.** Keyed on a stored `escalatedAt`,
not on PR state. Nothing on GitHub changes when an escalation is filed, so a
sweep that re-derives "have I escalated this?" from the PR will re-fire on every
pass.

### Measuring this correctly

**Do not use the REST pending-reviewer arrays as ground truth.** The App token
has no org-team read scope, so a request pending against a *team* is invisible
to it: REST omits it from `requested_teams` and GraphQL nulls
`reviewRequests.nodes[].requestedReviewer`. Neither surface says "no request" —
both say "no request *you can see*". Measured 2026-08-20 across 206 open
App-authored PRs, REST reported 145 with zero pending reviewers; that is exactly
10 genuinely-zero plus 135 pending-but-unreadable. Ten of the 135, sampled
against the timeline, each showed one `review_requested` to
`onprem-k8s-ally-reviewer` and **zero** `review_request_removed`.

Use the timeline for ground truth:

```sh
gh api repos/Blockcast/onprem-k8s/issues/<n>/timeline --paginate \
  --jq '.[] | select(.event | test("review_request"))
        | "\(.created_at) \(.event) \(.requested_reviewer.login // .requested_team.slug)"'
```

**An ally review does not answer a request.** Of those 196 PRs, 155 carry ally
reviews only, 3 carry a review from a genuine non-ally human, and 48 carry none.
A naive "does this PR have a review?" check therefore sees 158 of 206 as
answered when a human has looked at 3.

Note this sits in tension with the routing guidance above, which treats the
`allyblockcast` User-seat approval as a legitimate way to satisfy the
singleton-team rule. It is legitimate *today* only because that seat is a member
of team `18686279` — which is the loophole BLO-24517 is open against. If the org
removes that seat from the team (or repoints the ruleset at a humans-only team),
the routing steps above must be revised at the same time.

## Historical evidence

Historical merges or approvals that predate the current gate are context, not
proof that one identity can satisfy both requirements. Validate the current
rules and check results on the candidate head instead of inferring the contract
from an older merged PR.

At the time of the BLO-21564 investigation, independently authored PRs needed
both an App exact-head review and a distinct `allyblockcast` User exact-head
approval. A PR authored by either required reviewer identity could not acquire
both artifacts without being reopened under an independent author.

## Escalation template

When raising the Paperclip board approval, include:

- The PR URL and exact head SHA.
- The current `mergeStateStatus`, `reviewDecision`, and requested reviewers.
- Whether the PR author is `app/allyblockcast`, the `allyblockcast` User, or an
  independent account.
- The unresolved review-thread count and current required-check state.
- A request for the `allyblockcast` User seat to inspect that exact head and
  submit a formal approve or request-changes review for the singleton-team
  rule.
- A separate request for an exact-head App review that satisfies
  `review/ally-complete`.
- For a source PR authored by either required reviewer identity, the
  independent-author replacement URL and a diff/evidence link back to the
  source. Avoid replacement PRs when authorship already permits both reviews.

See [BLO-21564](https://paperclip.blockcast.net/BLO/issues/BLO-21564) for the
investigation trail.
