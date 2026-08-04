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

1. If the PR is authored by `app/allyblockcast`, request a formal review from
   the distinct `allyblockcast` User seat. The User must inspect the exact head
   and submit the review through GitHub's review API. A replacement PR under
   `kkroo` is not required merely to satisfy approval.
2. If the PR is human-authored, use the same exact-head review path. The
   `allyblockcast` User can satisfy the protected-team requirement after
   reviewing the current head; App comments are supporting review evidence,
   not a substitute for the formal User review.
3. Never use the App's own comments as formal approval of an App-authored PR,
   and never expose or distribute the User seat's credential. The credential
   is reserved for formal review actions after the reviewer has inspected the
   exact head and unresolved threads.

The distinct GitHub User account named `allyblockcast` can satisfy the
protected team approval when it is a member of
`Blockcast/onprem-k8s-ally-reviewer`. That User is a real maintain-capable seat,
not the `allyblockcast[bot]` App installation. GitHub therefore permits the User
to review a PR authored by the App.

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

The remaining routing requirement is to send formal review work to the User
seat. The Paperclip agent normally authors PRs as the App identity
`allyblockcast[bot]`. A GitHub App cannot hold membership in the protected
reviewer team or approve its own PR, while the separate `allyblockcast` User
can provide the protected-team approval after reviewing the exact head.

## Historical evidence

`Blockcast/onprem-k8s` PR #1774 was authored by `app/allyblockcast` and merged
on 2026-07-30 after review activity from the distinct `allyblockcast` User.
That is the expected identity split: App authorship does not make a formal
review from the separate User seat a self-review.

At the time of the BLO-21564 investigation, recent human-authored PRs were
successfully approved by the `allyblockcast` User. App-authored PRs stalled
when automation produced only App comments and never submitted a formal review
through the User seat.

## Escalation template

When raising the Paperclip board approval, include:

- The PR URL and exact head SHA.
- The current `mergeStateStatus`, `reviewDecision`, and requested reviewers.
- Whether the PR author is `app/allyblockcast` or a human account.
- The unresolved review-thread count and current required-check state.
- A request for the `allyblockcast` User seat to inspect that exact head and
  submit a formal approve or request-changes review. Do not request a carrier
  PR solely to change the author identity.

See [BLO-21564](https://paperclip.blockcast.net/BLO/issues/BLO-21564) for the
investigation trail.
