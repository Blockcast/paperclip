# onprem-k8s: agent-authored PR review routing (BLO-21564)

Counterpart technical work lives in `Blockcast/onprem-k8s` PR #2011:
<https://github.com/Blockcast/onprem-k8s/pull/2011/files>

## TL;DR for the next agent

If a PR in `Blockcast/onprem-k8s` has green CI but is still blocked, first
check the review state:

```sh
gh pr view <n> --repo Blockcast/onprem-k8s \
  --json author,mergeable,mergeStateStatus,reviewDecision,reviewRequests
```

Read `mergeStateStatus`, not only `mergeable`. `mergeable` only answers
whether GitHub sees a content conflict. A PR can be conflict-free and still
show `mergeStateStatus: BLOCKED` because protected-review requirements are
unsatisfied.

The safe path depends on the PR author:

1. If the PR is independently authored, obtain both reviews on the same exact
   head SHA:
   - an exact-head review from the `allyblockcast` GitHub App, which supplies
     the evidence accepted by `review/ally-complete`; and
   - a separate exact-head approval from the `allyblockcast` User seat, which
     satisfies the singleton `Blockcast/onprem-k8s-ally-reviewer` team rule.
2. If the PR is authored by `app/allyblockcast`, the App cannot review its own
   PR. Reopen the exact intended diff under an independent author, link the
   source PR and its review evidence, and obtain both reviews above on the
   replacement PR's exact head.
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

PR #2011 added `* @Blockcast/onprem-k8s-ally-reviewer` as the first CODEOWNERS
entry in the target repo. The live GitHub API later showed #2011 requesting
that team plus the named security-path owners (`kkroo`, `eyad-hussein`, and
`MohamedElmdary`). Do not preserve the earlier stale diagnosis that the team
request was missing; that evidence was superseded.

The remaining routing requirement is to collect two independent review
artifacts on one immutable head. The Paperclip agent normally authors PRs as
the App identity `allyblockcast[bot]`. Because the App cannot approve its own
PR, those PRs require an independent-author replacement before the App can
produce valid `review/ally-complete` evidence. The separate `allyblockcast`
User then provides the protected-team approval on that same replacement head.

## Historical evidence

Historical merges or approvals that predate the current gate are context, not
proof that one identity can satisfy both requirements. Validate the current
rules and check results on the candidate head instead of inferring the contract
from an older merged PR.

At the time of the BLO-21564 investigation, independently authored PRs needed
both an App exact-head review and a distinct `allyblockcast` User exact-head
approval. App-authored PRs could not acquire the first artifact without being
reopened under an independent author.

## Escalation template

When raising the Paperclip board approval, include:

- The PR URL and exact head SHA.
- The current `mergeStateStatus`, `reviewDecision`, and requested reviewers.
- Whether the PR author is `app/allyblockcast` or a human account.
- The unresolved review-thread count and current required-check state.
- A request for the `allyblockcast` User seat to inspect that exact head and
  submit a formal approve or request-changes review for the singleton-team
  rule.
- A separate request for an exact-head App review that satisfies
  `review/ally-complete`.
- For an App-authored source PR, the independent-author replacement URL and a
  diff/evidence link back to the source. Avoid replacement PRs when authorship
  already permits both reviews.

See [BLO-21564](https://paperclip.blockcast.net/BLO/issues/BLO-21564) for the
investigation trail.
