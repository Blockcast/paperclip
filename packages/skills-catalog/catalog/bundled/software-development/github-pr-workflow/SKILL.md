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

- Rebase from the target base so the diff is current — but **only if the repo has
  no merge queue**. If it does, skip this entirely and see "Repos with a merge
  queue" below: syncing a PR there is not merely unnecessary, it can permanently
  break the PR.
- Squash WIP commits into reviewable units. Prefer one commit per logical change; do not force one-commit-per-PR if the work is genuinely multi-step.
- Confirm tests, typecheck, and lint pass locally. Note any deliberate skips in the PR body.
- Remove debug prints, commented-out code, and `TODO` markers that are not tracked.

## Repos with a merge queue: never sync a PR, enqueue it

Check once, before you touch the branch:

```bash
gh api graphql -f query='{ repository(owner:"<owner>", name:"<repo>") {
  mergeQueue(branch:"<base>") { configuration { mergeMethod mergingStrategy } } } }'
```

Three outcomes, and they are distinguishable — which is the point:

| result | meaning | action |
|---|---|---|
| `"mergeQueue": {...}` with a `mergeMethod` | queue present | do not sync; enqueue |
| `"mergeQueue": null` | no queue | syncing is safe |
| non-zero exit / `errors` | **you could not tell** | **treat as queue present; do not sync** |

**Fail closed on the third row.** Do not use a `rulesets`-and-`xargs` pipeline
here: a denied read prints nothing on stdout, which is indistinguishable from
"no queue" and silently authorizes the destructive action. Protection-adjacent
reads really are denied to some identities — a GitHub App installation token
gets `403 Resource not accessible by integration` on
`repos/<owner>/<repo>/branches/<base>/protection`. The GraphQL query above needs
no ruleset read, returns a clean `null` for the no-queue case, and exits
non-zero on failure so the error cannot be mistaken for an answer.

Then:

- **Do not call `PUT /repos/<owner>/<repo>/pulls/<n>/update-branch`. Do not
  `git merge <base>` into the PR branch. Do not use the "Update branch" button.**
  A PR being `BEHIND` is not a reason to act — the queue re-tests each entry
  against the current base and runs the required checks itself in `merge_group`.
- **Enqueue instead**: `gh pr merge <n> --repo <owner>/<repo> --rebase`. The
  warning `! The merge strategy for <base> is set by the merge queue` means it
  was enqueued, not that it failed. Read the queue entry back to confirm —
  `state` and `mergedAt` stay `OPEN` / `null` while it sits in the queue, so
  neither the exit code nor those fields tell you anything.

Syncing anyway costs you the PR, in two independent ways:

1. `update-branch` gives the PR a head that Actions never runs, so no check
   suite is created for it. Where required checks are enforced on the PR head,
   the required context can never report and the PR can never be enqueued.
   Nothing short of a real tree-changing push recovers it — close/reopen,
   draft→ready, and re-requesting the suite were all measured to create zero
   runs. This is an empirical result on `Blockcast/paperclip`, not an
   established mechanism: the same App identity triggers workflow runs
   perfectly well by other means, so it is not blanket App suppression. Treat
   it as "assume this happens until you have measured otherwise on your repo",
   which is the safe direction anyway — the advice not to sync holds either
   way.
2. On a `REBASE` queue, any merge commit on the branch makes it
   non-rebaseable. `mergeable_state` reads `clean` while `rebaseable` is
   `false`, and GitHub ejects the entry at head-of-queue before creating a
   build. Put `rebaseable` in any gate check on such a repo; `mergeable` alone
   is unsound there.

A genuine conflict (`mergeable_state: dirty`) is the one case needing branch
work — resolve it by squash-linearizing onto the base, never by merging the
base in, and prove content is preserved by comparing blob SHAs before you
force-push.

## Stacked PRs for dependent work

Use stacked PRs only when a follow-up change truly depends on another in-flight
PR and splitting the work lets CI and review start earlier. Do not stack
unrelated backlog items, dirty branches, or failing PRs just to put more work in
flight, and keep the stack short enough that each reviewer can understand the
incremental diff.

Rules:
- The parent PR targets the protected/default base (`master`, `main`, or the
  repo's actual default branch). A child PR targets its parent branch and must be
  reviewed as an incremental diff against that base branch.
- The child PR body must name the stack relationship and the retargeting plan:
  `Stack: parent #<number>`, `Base branch: <parent-branch>`, the dependency the
  child needs from the parent, and `After #<number> merges: change base to
  <default-branch>, reconcile child commits, verify final diff, request fresh
  review`.
- After the parent merges, immediately change the child PR's configured base to
  the protected/default branch. Then reconcile the child commits for the parent's
  merge method: a squash, rebase, or conflict resolution can change which commits
  are already present on the default branch, so rebase or cherry-pick only the
  child changes as needed.
- Verify the final base and diff before continuing. `gh pr view` must show the
  protected/default branch as the child PR's base branch, and the final PR diff
  must contain only the child change.
- Rerun required checks and request a fresh exact-head review after the final
  base, head, and diff are established. Put the child in the merge queue only
  after that fresh review/approval and the required checks are current.
- Do not approve or auto-merge a stacked child while its base branch is an
  unprotected feature branch. GitHub may reject auto-merge with "Protected branch
  rules not configured for this branch", and the approval can be wasted if the
  retargeted diff changes.

## PR title

- Imperative mood, under 70 characters.
- Lead with the user-visible change, not the file touched. `Allow CSV export from reports table` beats `Update reports.tsx`.
- If the repo uses an issue prefix convention (`PAP-1234:`, `[security]`), follow it.
- No trailing period.

## PR body

**Look for a repo-local PR template before you write anything.** When the
repository ships one, its headings are the contract and the generic structure at
the end of this section is only the fallback. GitHub honours a template at the
repo root, under `.github/`, or under `docs/`, in either letter case, and a
directory of named templates in place of a single file. Search all three
locations case-insensitively — an enumeration that guesses the casing wrong
prints nothing, which is indistinguishable from a repo that has no template:

```sh
find . .github docs -maxdepth 1 -iname 'pull_request_template*' 2>/dev/null
```

A `PULL_REQUEST_TEMPLATE/` **directory** is the one case with no default: GitHub
applies none of its files unless the PR is opened with `?template=`. Read the
repo's checker to see which file it enforces — that one is the contract. Absent a
checker, pick the template whose headings fit the change and say which you used.

Where one exists, follow it — and note that following it means more than copying
it across:

- **Reproduce every `## ` heading verbatim and in order.** A template gate matches
  the literal heading string, so `## Risks` and `## Risk and rollback` are not
  interchangeable, and a heading that reads as redundant is still a hard failure
  when it is missing.
- **Delete the instructional HTML comments as you fill each section in.** This is
  the failure that looks most like success: your prose is sitting right there
  under the heading, but a checker reading the *first* thing in the section finds
  `<!--` and scores the section empty.
- **Replace every placeholder.** A bare `-`, `_No response_`, and `<model>` are
  precisely what these gates look for.
- **Avoid writing a section's heading text into your prose above that section.**
  These checkers typically find a section by plain substring search, unanchored to
  the start of a line, so an earlier mention — even inside a fenced code block —
  captures the match and the gate grades that fragment instead of your real
  section. It fails confusingly when it fails, and passes for the wrong reason
  when it does not. Quote the section name without its `##` marker.
- **Map the advice below onto the repo's headings rather than dropping it.** The
  section names change; what a reviewer needs to see does not.

Paperclip repos commonly enforce `.github/PULL_REQUEST_TEMPLATE.md`. For
implementation PRs, fill `## Thinking Path`,
`## Linked Issues or Issue Description`, `## What Changed`, `## Verification`,
`## Risks`, `## Model Used`, and `## Checklist`; include `Fixes: #123`,
`Closes #123`, or `Refs #123` when an issue exists, or a real in-PR issue
description when it does not. Search GitHub for duplicate or related PRs before
opening the PR, and check this line exactly:

```md
- [x] I have searched GitHub for duplicate or related PRs and linked them above
```

**Run the gate locally before you push.** A repo that enforces a template almost
always ships the checker as a script that CI merely invokes, so the same verdict
is available in a second instead of costing a push, a red check, and a rewrite:

```sh
ls .github/scripts/ .github/workflows/ 2>/dev/null   # find the checker
# Typical shape: takes the body from a file or env var, prints JSON, exits non-zero.
PR_BODY="$(cat pr-body.md)" node .github/scripts/<checker>.mjs
gh pr create --body-file pr-body.md                  # only once it passes
```

Drafting the body into a file and passing `--body-file` also stops the shell
mangling backticks and newlines on the way through.

**If the repo has no template of its own**, use this structure:

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

## Repository pre-review gates

Before requesting or re-requesting review, inspect the repository for its actual
quality-gate workflow or checker. If it has a commitperclip workflow or checker
(for example `.github/workflows/commitperclip-review.yml`), missing template
sections, a missing linked issue/issue description, or an unchecked dedup-search
checkbox wastes a review cycle and blocks `commitperclip PR Review`. If it does
not have commitperclip, wait for the repository's actual required quality gates
and checks instead; do not assume a Paperclip-specific check exists.

Before requesting or re-requesting review:

- Confirm the PR body still matches `.github/PULL_REQUEST_TEMPLATE.md` if the repo has one.
- Confirm the dedup-search checkbox is present and checked after you searched the GitHub PR list.
- For a repository with commitperclip, confirm `commitperclip PR Review` and its related quality gates are passing; for other repositories, confirm their actual required quality gates are passing. If a gate fails, update the PR and wait for it to rerun before pinging Ally or another reviewer.

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

Three GitHub-reachable credentials are mounted or reachable from an agent pod.
They have different jobs. None of them is a magic bypass around the reviewer
identity rules, and which identity **authors** your PR decides whether the PR can
receive the formal reviews branch protection needs:

- **Default App-installation token** — identity `app/allyblockcast[bot]`. This is
  the default automation identity for branch pushes, `gh` reads, comments,
  replies, status writes, and merges. The review bot also uses this identity for
  gate-authorizing Bot/App reviews. That means a PR authored by this App cannot
  receive the App's own formal review; clean App comments on an App-authored PR
  are useful triage, not merge-gate evidence.
- **User-seat token** — mounted at `/paperclip/.secrets/github-merge-token/token`
  when provisioned. This is the **`allyblockcast` user** account, a *distinct*
  GitHub identity from the `app/allyblockcast[bot]` App. A dedicated reviewer
  service may use this identity for singleton Ally-team approval evidence on the
  same exact head as the Bot/App review. It is *not* an authoring credential, not
  the Bot/App reviewer, and not a substitute for the Bot/App approval.
- **Cluster SSH key** — `/paperclip/.ssh/id_ed25519`, readable by any agent pod
  that mounts the shared `/paperclip` PVC. It exists to reach cluster hosts
  (`sfo12-public`, `home-residential`) per `/paperclip/.ssh/config` — that is its
  only sanctioned use. It is *also* registered on a human's personal GitHub
  **user** account (`kkroo`), an unintended side effect of that cluster
  provisioning and not a GitHub authoring grant: `ssh -T git@github.com` with it
  authenticates as that human, and it can push to every repo that account can
  write — including repos entirely outside the App installation, where neither of
  the two credentials above has any write path.

  **Never use this key for any GitHub operation** — no `git push`, no
  `git clone`/`fetch` over an `ssh://git@github.com` or `git@github.com:` remote,
  no `ssh -T git@github.com`. A push made with it is attributed to that human's
  account, not the agent, and is indistinguishable from one they made themselves.
  See BLO-21854.

GitHub forbids an identity from submitting a **formal review** (`APPROVE` /
`REQUEST_CHANGES`) on a PR it authored, so the author and the reviewer must be
different identities.

Holding the user-seat token does **not** make you a reviewer, and it is not your
push/create credential either. A seat approval posted by an ordinary agent is
forged team evidence; it still cannot replace the Bot/App approval that
`review/ally-complete` requires. Never submit a review under it outside the
dedicated reviewer pipeline (see
[Why the user seat must never post a review](#why-the-user-seat-must-never-post-a-review)).

The dedicated reviewer pipeline has two required clean-review evidence shapes for
protected PRs:

1. A Bot/App formal `APPROVED` review from `app/allyblockcast[bot]`, carrying the
   canonical `## Ally — Consolidated PR Review` body with exactly one full
   `Reviewed head: <sha>` attestation.
2. The singleton Ally-team user approval on that same exact head, when the repo's
   rules require team evidence in addition to the Bot/App review.

For a non-App-authored PR, both evidence shapes must be current on the same head.
For an App-authored PR, there is no gate-authorizing App review path: GitHub will
not let the App approve its own PR. Reopen the exact head under an independent
author before requesting review. A user-seat approval is team evidence, not a
substitute for the Bot/App review, and an App comment cannot satisfy a repository
rule that explicitly requires a formal approval.

**A protected PR that requires `review/ally-complete` must be authored by an
independent identity, not by `app/allyblockcast[bot]` and not by the
`allyblockcast` user seat. Never author or push a PR under the user-seat token,
and never over the cluster SSH key either.** Use the default App token for normal
automation writes that are allowed under that repo's rules — comments, status,
routine branch maintenance, and merges after the review gate is satisfied.
GitHub operations must never go over SSH in these pods.

### Why shared-identity authoring breaks review

A PR authored under a reviewer identity makes author == reviewer. GitHub refuses
that same identity's formal review, so the reviewer can only leave comment-mode
evidence and the protected review gate cannot go green. That is true for the
`allyblockcast` user seat and for `app/allyblockcast[bot]` on repos whose gate
requires the App's Bot/App approval.

A PR's author is **fixed at creation**, so there is no in-place fix. If you find
yourself on a PR authored by either reviewer identity, the sanctioned recovery is
to re-open the exact head under an independent author: close the PR, then
re-create it from the *same branch and SHA* with an identity that is neither the
App nor the `allyblockcast` user. GitHub permits only one open PR per head/base,
so the close must come first. No force-push and no CI re-plumbing is needed.

Closing is the destructive step, so everything the replacement needs must be
captured and re-validated *before* it, and every unsuccessful exit after it must
put the original PR back. Four ways this goes wrong if you improvise it: a read
fails and the captured fields come back empty, so an empty SHA compares equal to
an empty remote SHA and the check "passes" on two blanks; the branch moves
between capture and re-create, so the "same SHA" promise silently breaks;
`gh pr create` fails — or the script is interrupted — and the branch is left with
its review artifact closed and no replacement open; or the replacement is created
under a reviewer identity as well, reproducing the exact defect while reporting
success.

```sh
set -euo pipefail

REPO=<org>/<repo>
NUM=<number>

# Preflight: the point of this recovery is an independently authored replacement,
# so prove the active identity is neither reviewer identity before touching
# anything. Recreating under the App or the seat reproduces the defect.
AUTHOR_LOGIN="$(gh api user 2>/dev/null | jq -r '.login // empty' || true)"
case "$AUTHOR_LOGIN" in
  ""|allyblockcast|app/*|*"[bot]") echo "abort: not authenticated as an independent author" >&2; exit 1 ;;
esac

# Capture head, base, title, body AND the exact head SHA BEFORE closing.
# Never assume `master`: stacked PRs and repos with another default branch
# target something else. Reconstructing any of this by hand is how a re-opened
# PR silently acquires a different base — a different diff and check set.
gh pr view "$NUM" --repo "$REPO" \
  --json headRefName,baseRefName,headRefOid,title,body > "/tmp/pr-$NUM.json"

HEAD_REF="$(jq -r '.headRefName // empty' "/tmp/pr-$NUM.json")"
ORIG_SHA="$(jq -r '.headRefOid  // empty' "/tmp/pr-$NUM.json")"
BASE_REF="$(jq -r '.baseRefName // empty' "/tmp/pr-$NUM.json")"

# Validate every captured field before the destructive step. `jq` prints an empty
# string for a missing or null key, and "" = "" compares equal — so an
# unvalidated capture and a failed remote read agree with each other and close
# the PR for nothing. Require a full 40-hex SHA, not merely "non-empty".
[ -n "$HEAD_REF" ] || { echo "abort: #$NUM has no headRefName" >&2; exit 1; }
[ -n "$BASE_REF" ] || { echo "abort: #$NUM has no baseRefName" >&2; exit 1; }
printf '%s' "$ORIG_SHA" | grep -Eq '^[0-9a-f]{40}$' ||
  { echo "abort: headRefOid '$ORIG_SHA' is not a full SHA" >&2; exit 1; }

# Re-validate the SHA against the remote immediately before closing, and abort
# instead of closing on a mismatch: if the branch has moved, the replacement PR
# would open on a head nobody reviewed. Ask GitHub, not the local checkout —
# a stale local ref would confirm the wrong thing.
REMOTE_SHA="$(gh api "repos/$REPO/git/ref/heads/$HEAD_REF" --jq '.object.sha // empty')"
printf '%s' "$REMOTE_SHA" | grep -Eq '^[0-9a-f]{40}$' ||
  { echo "abort: could not read origin/$HEAD_REF" >&2; exit 1; }
[ "$REMOTE_SHA" = "$ORIG_SHA" ] ||
  { echo "abort: origin/$HEAD_REF is $REMOTE_SHA, expected $ORIG_SHA" >&2; exit 1; }

# Arm rollback BEFORE closing anything, and arm it for every unsuccessful exit.
# Re-query GitHub inside rollback because a close/create can apply remotely and
# still return a client error or be interrupted before this script records it.
CLOSED=0
NEW_NUM=""
reconcile_original_state() {
  state="$(gh pr view "$NUM" --repo "$REPO" --json state --jq '.state // empty' 2>/dev/null || true)"
  if [ "$state" = "CLOSED" ]; then CLOSED=1; fi
}
reconcile_replacement_state() {
  if printf '%s' "$NEW_NUM" | grep -Eq '^[0-9]+$'; then return 0; fi
  NEW_NUM="$(gh pr list --repo "$REPO" \
    --head "$HEAD_REF" \
    --base "$BASE_REF" \
    --state open \
    --json number,headRefOid,baseRefName \
    --jq ".[] | select(.number != $NUM and .headRefOid == \"$ORIG_SHA\" and .baseRefName == \"$BASE_REF\") | .number" \
    2>/dev/null | head -n 1 || true)"
  printf '%s' "$NEW_NUM" | grep -Eq '^[0-9]+$' || NEW_NUM=""
}
rollback_status() {
  status="$1"
  if [ "$status" -eq 0 ]; then return 0; fi
  trap - EXIT INT TERM
  reconcile_original_state
  reconcile_replacement_state
  echo "recovery failed (exit $status); restoring #$NUM" >&2
  if [ -n "$NEW_NUM" ]; then
    gh pr close "$NEW_NUM" --repo "$REPO" ||
      echo "ROLLBACK INCOMPLETE: close #$NEW_NUM by hand" >&2
  fi
  if [ "$CLOSED" -eq 1 ]; then
    gh pr reopen "$NUM" --repo "$REPO" ||
      echo "ROLLBACK FAILED: reopen #$NUM by hand" >&2
  fi
}
rollback() { rollback_status "$?"; }
handle_signal() {
  signal="$1"
  echo "interrupted by $signal" >&2
  rollback_status 130
  exit 130
}
trap rollback EXIT
trap 'handle_signal INT' INT
trap 'handle_signal TERM' TERM

if ! gh pr close "$NUM" --repo "$REPO"; then
  reconcile_original_state
  exit 1
fi
CLOSED=1

if ! NEW_URL="$(gh pr create --repo "$REPO" \
    --head  "$HEAD_REF" \
    --base  "$BASE_REF" \
    --title "$(jq -r .title "/tmp/pr-$NUM.json")" \
    --body  "$(jq -r .body  "/tmp/pr-$NUM.json")")"; then
  reconcile_replacement_state
  exit 1
fi
NEW_NUM="${NEW_URL##*/}"

# Validate the number too: an empty or non-numeric NEW_URL would otherwise send
# the checks below to `gh pr view ""`, and an unvalidated blank is exactly the
# fail-open the capture step above guards against.
printf '%s' "$NEW_NUM" | grep -Eq '^[0-9]+$' ||
  { echo "abort: gh pr create returned '$NEW_URL'" >&2; reconcile_replacement_state; exit 1; }

# Verification is part of the recovery, not a follow-up step: a replacement on a
# different head or base is not a recovery, and leaving it open while the
# original stays closed is worse than not having tried. Verify the author too:
# the preflight can pass and the create still land under another identity, and a
# replacement authored by either reviewer identity is exactly the defect being
# recovered from.
NEW_JSON="$(gh pr view "$NEW_NUM" --repo "$REPO" --json headRefOid,baseRefName,author)"
[ "$(printf '%s' "$NEW_JSON" | jq -r '.headRefOid  // empty')" = "$ORIG_SHA" ] ||
  { echo "abort: #$NEW_NUM is not at $ORIG_SHA" >&2; exit 1; }
[ "$(printf '%s' "$NEW_JSON" | jq -r '.baseRefName // empty')" = "$BASE_REF" ] ||
  { echo "abort: #$NEW_NUM is not onto $BASE_REF" >&2; exit 1; }
NEW_AUTHOR="$(printf '%s' "$NEW_JSON" | jq -r '.author.login // empty')"
case "$NEW_AUTHOR" in
  ""|allyblockcast|app/*|*"[bot]") echo "abort: #$NEW_NUM is authored by reviewer identity '$NEW_AUTHOR'" >&2; exit 1 ;;
esac

trap - EXIT INT TERM
echo "recovered $NUM -> $NEW_NUM at $ORIG_SHA onto $BASE_REF as $NEW_AUTHOR"
```

The recovery is done only when that final check passes. If it aborted, the
rollback has put you back on the original PR with nothing lost — diagnose before
retrying. If it printed `ROLLBACK FAILED` or `ROLLBACK INCOMPLETE`, the restore
itself did not complete: fix that by hand first, before anything else.

The replacement carries the original head, base, title, and body — and nothing
else. Labels, assignees, requested reviewers, milestone, linked issues, and the
original's draft state are **not** restored; in particular a draft original comes
back ready-for-review, which is usually what you want (a draft PR gets no
reviewer wake at all) but is a change you should expect rather than discover.
Re-apply anything you need on the replacement.

Pushing under either reviewer identity is also unsafe where branch protection sets
`require_last_push_approval` — the most recent pusher cannot approve, so a
reviewer-identity push can disqualify the identity the gate needs. The seat PAT
additionally lacks `workflow` scope and cannot push `.github/workflows/**`.

### Confirming which identity you are on

```sh
gh api user --jq '.login // empty'
# 403 "Resource not accessible by integration" == the App installation
# allyblockcast == the user seat
# any other expected human/service login == independent authoring identity
```

The agent image wraps `gh` and deliberately replaces `GH_TOKEN` with the token
read from `PAPERCLIP_GITHUB_TOKEN_FILE` on every invocation. Setting `GH_TOKEN`
does not switch identities in these pods; a token file is the only selector, and
the same override reaches the `gh` credential helper used by `git push`.

### Merging

Merge under the **default App token** after the review gate is already satisfied
— it holds merge rights on this fleet's main repos, and no token selection is
needed:

```sh
gh pr merge <number> --repo <org>/<repo> --squash
```

Rules:
- Use the **default App token** for comments, status, routine branch maintenance,
  and merging. Do not create a protected PR under the App when that repo requires
  the Ally App's own formal review.
- **Never submit a formal review under the user-seat token.** No `gh pr review`
  with it — not `--approve`, not `--request-changes`, not `--comment`. This rule
  governs agents consuming this workflow; only the dedicated reviewer service may
  produce singleton Ally-team approval evidence under that seat. Never post an
  `ally-verdict:` marker or a `Reviewed head: <sha>` line under it, on a review or
  in a comment. This holds even when the review is honest and even when the change
  is yours: the prohibition is on the *credential*, not on your intent.
- If merge is refused because branch protection requires an identity the App
  lacks, that is a **permission gate, not a credential puzzle** — do not reach for
  the seat to work around it. Note the exact refusal on the issue and escalate;
  where a repo's required-reviewer rule can only be satisfied by a human or by an
  org-admin change, no agent-held token can clear it.
- Only merge when the merge checklist above is satisfied (checks green, comments
  resolved).

### Why the user seat must never post a review

The user-seat token authenticates as the `allyblockcast` **user** — the same
identity the dedicated reviewer service may use for singleton team evidence.
GitHub records only that shared identity, so a review you post under it is
**indistinguishable from the reviewer's own user-seat evidence**, to a human
reader and to CI alike.

The `review/ally-complete` merge gate requires the Bot/App formal approval
described above. A user-seat approval posted by an ordinary agent cannot
substitute for that App approval, and a manually forged canonical body pollutes
the exact-head evidence trail after the fact. Only the dedicated reviewer
pipeline may produce either trusted review artifact, and Paperclip completes that
pipeline only after GitHub confirms the exact-head evidence described above.

So when you are looking at a red `review/ally-complete` on your own PR, the
sanctioned move is to **get a review** — re-request one (see the repo's review
handoff convention) and wait. If the PR turns out to be authored by either
reviewer identity, no review can clear it and re-requesting is futile; re-open the
exact head under an independent author first, per
[Why shared-identity authoring breaks review](#why-shared-identity-authoring-breaks-review).
Posting the approval yourself is not a shortcut past a slow reviewer; it is a
forged review, and it has already shipped a data-loss bug to master that the real
review had caught.

## Anti-patterns

- PR description that says "see commits". Reviewers should not need to read the log.
- Mixing refactor and behavior change in the same PR with no separation in the body.
- "Address feedback" commits that bundle unrelated edits. One commit per round of feedback is fine; one commit for everything in flight is not.
- Clicking "Update branch", calling `update-branch`, or merging the base into a
  PR branch on a repo that has a merge queue, because the PR reads `BEHIND`. The
  queue already rebases; the sync destroys the head's checks and can leave the PR
  permanently unenqueueable. See "Repos with a merge queue" above.
- Force-pushing during active review without telling the reviewer.
- Writing the body to this skill's generic structure in a repo that ships its own
  PR template. The template's headings win; ours are the fallback. Discovering the
  mismatch from a red check after pushing costs a CI run every time, and trains you
  to read a red template gate as first-push noise.
- Approving your own PR under the user-seat merge token to turn the review gate
  green. That is a forged review, not a merge unblock — see the credential rules
  above.
- Keeping a protected PR authored by `app/allyblockcast[bot]` and treating a
  user-seat approval as the missing review. The App cannot approve its own PR, and
  the seat is not a substitute for the Bot/App review.
- Reaching for the cluster SSH key (`/paperclip/.ssh/id_ed25519`) because the App
  token lacks write access to some repo. A repo the App isn't installed on is a
  permission gate, not a credential puzzle — the SSH key's GitHub registration is
  a human's personal account, not a sanctioned bypass. Note the gap and escalate.
