---
name: github-pr-workflow
description: Prepare a GitHub pull request from a feature branch — branch hygiene, commit shape, title/body, verification notes, screenshots for UI work, and replies to review comments.
key: paperclipai/bundled/software-development/github-pr-workflow
recommendedForRoles:
  - engineer
tags:
  - github
  - pull-requests
  - code-review
  - release
---

# GitHub Pull Request Workflow

Ship a PR a reviewer can land without follow-up clarifying questions. The aim is high signal in the title and body, evidence the change works, and clean replies when feedback comes in.

## When to use

- You are about to open a PR for a change that is functionally complete.
- A reviewer left comments and you need to respond and push fixes.
- A PR has been open more than a day and needs to be brought back into shape (stale conflicts, missing description, missing verification).

## When not to use

- The change is not yet functionally complete. Finish the work first; draft PRs that bounce on review are noise.
- The repository uses a non-GitHub forge. Adjust to that forge's conventions; do not force GitHub-isms.

## Branch hygiene before opening

- Rebase or merge from the target base so the diff is current.
- Squash WIP commits into reviewable units. Prefer one commit per logical change; do not force one-commit-per-PR if the work is genuinely multi-step.
- Confirm tests, typecheck, and lint pass locally. Note any deliberate skips in the PR body.
- Remove debug prints, commented-out code, and `TODO` markers that are not tracked.

## PR title

- Imperative mood, under 70 characters.
- Lead with the user-visible change, not the file touched. `Allow CSV export from reports table` beats `Update reports.tsx`.
- If the repo uses an issue prefix convention (`PAP-1234:`, `[security]`), follow it.
- No trailing period.

## PR body

Use this structure:

```md
## Summary
- 1–3 bullets describing what changed and why.

## Implementation notes
- Anything non-obvious in the diff: trade-offs, dropped alternatives, gotchas.
- Migration or config implications.

## Verification
- The exact commands or steps you ran.
- Screenshots or short clips for UI changes (required if pixels moved).
- Edge cases you exercised by hand.

## Risk and rollback
- What breaks if this is reverted, and how to revert cleanly.
```

Skip the `Risk and rollback` section only for clearly trivial PRs (typos, docs).

## Verification evidence

- Tests passing in CI is necessary, not sufficient. Reviewers also need to know the change behaves correctly end to end.
- For UI work, include screenshots of the golden path and one edge case. Tag dark and light mode if the project supports both.
- For migrations, include a dry-run plan and reversal steps.
- For performance changes, include a before/after measurement, not adjectives.

## Replying to review comments

- Reply on every comment, even with just "fixed in <commit-sha>" — silent fixes leave the reviewer guessing.
- Push fixes as new commits while review is active; do not amend during review unless the reviewer agrees.
- If you disagree with feedback, say so with one sentence of rationale and let the reviewer decide. Don't escalate over comments.
- Re-request review explicitly after pushing changes.

## Merge checklist

- All required checks green.
- All review comments resolved.
- PR title/body still accurate (update if scope changed mid-review).
- Linked issue moves to `in_review` or `done` per project convention.
- Delete the branch after merge unless it is a long-lived integration branch.

## Which credential to use (authoring, reviewing, merging)

You have two GitHub identities available, and which one **authors** your PR
decides whether the PR can receive a formal review at all:

- **Default App-installation token** — identity `app/allyblockcast[bot]`. This is
  the **authoring identity**: commits, branch push, `gh pr create`, comments,
  replies, status, reads, and merges. The review bot posts its **comment-mode**
  reviews under this identity.
- **User-seat token** — mounted at `/paperclip/.secrets/github-merge-token/token`
  when provisioned. This is the **`allyblockcast` user** account, a *distinct*
  GitHub identity from the `app/allyblockcast[bot]` App. The review bot posts its
  **formal approvals** under this seat. It is *not* an authoring credential.

GitHub forbids an identity from submitting a **formal review** (`APPROVE` /
`REQUEST_CHANGES`) on a PR it authored, so the author and the reviewer must be
different identities.

Holding the user-seat token does **not** make you a reviewer, and it is not your
push/create credential either — the review bot's own approvals come from that very
same login, which is both why authoring under it blocks review and why you must
never submit a review under it (see
[Why the user seat must never post a review](#why-the-user-seat-must-never-post-a-review)).

**Author and push under the default App token. Never author or push a PR under
the user-seat token.** No token selection is needed — the default `gh` and `git`
credentials already are the App token.

### Why seat-authoring breaks review

A PR authored under the seat makes author == approver, so GitHub refuses the
approval, the review bot silently degrades to a comment-mode review, and the
`review/ally-complete` gate maps a clean comment-mode review to `pending`, never
`success`. The PR cannot go green, and no amount of re-requesting review will
change that.

A PR's author is **fixed at creation**, so there is no in-place fix. If you find
yourself on a seat-authored PR, the sanctioned recovery is to re-open it under the
App: close the PR, then re-create it from the *same branch and SHA* with the
default credential (GitHub permits only one open PR per head/base, so the close
must come first). No force-push and no CI re-plumbing is needed.

```sh
# Capture head, base, title and body BEFORE closing — a closed PR is still
# readable, but reconstructing these by hand is how a re-opened PR silently
# acquires a different base (and so a different diff and a different check set).
# Never assume `master`: stacked PRs and repos with another default branch
# target something else.
gh pr view <number> --repo <org>/<repo> \
  --json headRefName,baseRefName,title,body > /tmp/pr-<number>.json

gh pr close <number> --repo <org>/<repo>

gh pr create --repo <org>/<repo> \
  --head  "$(jq -r .headRefName /tmp/pr-<number>.json)" \
  --base  "$(jq -r .baseRefName /tmp/pr-<number>.json)" \
  --title "$(jq -r .title       /tmp/pr-<number>.json)" \
  --body  "$(jq -r .body        /tmp/pr-<number>.json)"
```

Confirm the new PR reports the same `baseRefName` and `headRefOid` as the old one
before you treat the recovery as done.

Pushing under the seat is also unsafe where branch protection sets
`require_last_push_approval` — the most recent pusher cannot approve, so a
seat-push disqualifies the only identity that can approve and leaves the PR with
no eligible approver at all. The seat PAT additionally lacks `workflow` scope and
cannot push `.github/workflows/**`.

### Confirming which identity you are on

```sh
gh api user   # 403 "Resource not accessible by integration" == the App token (correct)
              # 200 with a login == you are on the user seat (wrong for authoring)
```

The agent image wraps `gh` and deliberately replaces `GH_TOKEN` with the token
read from `PAPERCLIP_GITHUB_TOKEN_FILE` on every invocation. Setting `GH_TOKEN`
does not switch identities in these pods; a token file is the only selector, and
the same override reaches the `gh` credential helper used by `git push`.

### Merging

Merge under the **default App token** — it holds merge rights on this fleet's
main repos, and no token selection is needed:

```sh
gh pr merge <number> --repo <org>/<repo> --squash
```

Rules:
- Use the **default App token** for authoring, pushing, commenting, and merging.
- **Never submit a formal review under the user-seat token.** No `gh pr review`
  with it — not `--approve`, not `--request-changes`, not `--comment`. Never post
  an `ally-verdict:` marker or a `Reviewed head: <sha>` line under it, on a review
  or in a comment. This holds even when the review is honest and even when the
  change is yours: the prohibition is on the *credential*, not on your intent.
- If merge is refused because branch protection requires an identity the App
  lacks, that is a **permission gate, not a credential puzzle** — do not reach for
  the seat to work around it. Note the exact refusal on the issue and escalate;
  where a repo's required-reviewer rule can only be satisfied by a human or by an
  org-admin change, no agent-held token can clear it.
- Only merge when the merge checklist above is satisfied (checks green, comments
  resolved).

### Why the user seat must never post a review

The user-seat token authenticates as the `allyblockcast` **user** — the same
identity the review bot's own formal approvals come from. GitHub records only
that shared identity, so a review you post under it is **indistinguishable from
the reviewer's own**, to a human reader and to CI alike.

The `review/ally-complete` merge gate keys off exactly that: an `APPROVED` review
from an `allyblockcast` login. An approval posted under the seat therefore clears
the gate for a change no reviewer ever looked at, and nothing in the audit trail
can afterwards tell the two apart. Only the reviewer's own pipeline may produce a
review that clears that gate.

So when you are looking at a red `review/ally-complete` on your own PR, the
sanctioned move is to **get a review** — re-request one (see the repo's review
handoff convention) and wait. If the PR turns out to be seat-authored, no review
can clear it and re-requesting is futile; re-open it under the App first, per
[Why seat-authoring breaks review](#why-seat-authoring-breaks-review). Posting the
approval yourself is not a shortcut past a slow reviewer; it is a forged review,
and it has already shipped a data-loss bug to master that the real review had
caught.

## Anti-patterns

- PR description that says "see commits". Reviewers should not need to read the log.
- Mixing refactor and behavior change in the same PR with no separation in the body.
- "Address feedback" commits that bundle unrelated edits. One commit per round of feedback is fine; one commit for everything in flight is not.
- Force-pushing during active review without telling the reviewer.
- Approving your own PR under the user-seat merge token to turn the review gate
  green. That is a forged review, not a merge unblock — see the credential rules
  above.
