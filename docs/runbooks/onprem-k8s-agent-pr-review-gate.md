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

1. If the PR is authored by `app/allyblockcast`, do not ask the shared
   `allyblockcast` User to approve and merge that PR directly. Reopen the
   exact head under an independent human author first, preserving the original
   PR link and evidence. The independent carrier must then receive both the
   `allyblockcast[bot]` App review and the `allyblockcast` User approval.
2. If the PR is already human-authored, wait for the App review on that exact
   head, then raise a Paperclip board approval asking a human who is a member
   of `Blockcast/onprem-k8s-ally-reviewer` to review and, if clean, approve and
   merge.
3. Never add an agent identity to the protected reviewer team or grant a second
   agent identity write access so it can approve another agent's work. That
   recreates the self-approval hole `BLO-17828` exists to prevent.

The distinct GitHub User account named `allyblockcast` can satisfy the
protected team approval when it is a member of
`Blockcast/onprem-k8s-ally-reviewer`. That User approval is not the
`allyblockcast[bot]` App review, and it must not be used as a substitute for
the App side of the review contract.

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

The remaining structural problem is reviewer identity, not just notification
routing. The Paperclip agent authenticates to GitHub as the App identity
`allyblockcast[bot]`. A GitHub App cannot hold membership in the protected
reviewer team, and the App cannot provide an independent App review on a PR it
authored. The shared `allyblockcast` User is a separate identity and can
provide the protected-team approval, but it does not replace the App review.

## Historical evidence

`Blockcast/onprem-k8s` PR #1774 was authored by `app/allyblockcast` and merged
on 2026-07-30 after review activity from the distinct `allyblockcast` User.
That proves an App-authored PR has historically merged after a User-seat
approval. It does not prove the current two-identity review contract is
satisfied by User approval alone, and it should not be used as precedent for
bypassing the App review.

At the time of the BLO-21564 investigation, recent human-authored PRs were
successfully approved by the `allyblockcast` User. Agent-authored PRs without
an independent carrier still tended to stall because no durable workflow routed
both required identities onto the same exact head.

## Escalation template

When raising the Paperclip board approval, include:

- The PR URL and exact head SHA.
- The current `mergeStateStatus`, `reviewDecision`, and requested reviewers.
- Whether the PR author is `app/allyblockcast` or a human account.
- For App-authored PRs, the URL of the independent human-authored carrier PR
  that contains the exact same intended change.
- A request for the reviewer to wait for the App review on the carrier head,
  then use the `allyblockcast` User seat to approve and merge if clean.

See [BLO-21564](https://paperclip.blockcast.net/BLO/issues/BLO-21564) for the
investigation trail.
