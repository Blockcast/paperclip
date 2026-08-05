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
  child needs from the parent, and `Retarget to <default-branch> after #<number>
  merges`.
- After the parent merges, immediately retarget or rebase the child onto the
  default branch, rerun required checks, refresh the PR body if the diff changed,
  and only then put it in the merge queue.
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
  reviews under this identity. Paperclip trusts App-authored review output when
  it carries the canonical consolidated review body with an exact-head
  attestation.
- **User-seat token** — mounted at `/paperclip/.secrets/github-merge-token/token`
  when provisioned. This is the **`allyblockcast` user** account, a *distinct*
  GitHub identity from the `app/allyblockcast[bot]` App. The review bot posts its
  **formal approvals** under this seat. Paperclip trusts that seat review only
  when it is `APPROVED` and contains the canonical consolidated review body with
  exactly one exact-head `Reviewed head: <sha>` attestation. It is *not* an
  authoring credential.

GitHub forbids an identity from submitting a **formal review** (`APPROVE` /
`REQUEST_CHANGES`) on a PR it authored, so the author and the reviewer must be
different identities.

Holding the user-seat token does **not** make you a reviewer, and it is not your
push/create credential either — the review bot's own approvals come from that very
same login, which is both why authoring under it blocks review and why you must
never submit a review under it outside the dedicated reviewer pipeline (see
[Why the user seat must never post a review](#why-the-user-seat-must-never-post-a-review)).

The dedicated reviewer pipeline has two trusted clean-review evidence shapes:

1. Post the canonical `## Ally — Consolidated PR Review` body, with exactly one
   full `Reviewed head: <sha>` attestation, as the App identity for comment-mode
   reviews or App-authored review output.
2. If the review is clean and the PR is App-authored, submit the formal approval
   under the user-seat identity with that same canonical body and exact-head
   attestation. The approval satisfies branch protection, and the attested body
   is the durable evidence Paperclip requires before completing the reviewer run.

A seat approval without the canonical `APPROVED` exact-head attestation is
untrusted, and an App comment cannot satisfy a repository rule that explicitly
requires a formal approval.

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

Closing is the destructive step, so everything the replacement needs must be
captured and re-validated *before* it, and every unsuccessful exit after it must
put the original PR back. Four ways this goes wrong if you improvise it: a read
fails and the captured fields come back empty, so an empty SHA compares equal to
an empty remote SHA and the check "passes" on two blanks; the branch moves
between capture and re-create, so the "same SHA" promise silently breaks;
`gh pr create` fails — or the script is interrupted — and the branch is left with
its review artifact closed and no replacement open; or the replacement is created
under the seat as well, reproducing the exact defect while reporting success.

```sh
set -euo pipefail

REPO=<org>/<repo>
NUM=<number>

# Preflight: the point of this recovery is an App-authored replacement, so prove
# the active identity IS the App before touching anything. Recreating under the
# seat reproduces the defect being recovered from and reports success doing it.
# Assert the App's signature rather than the seat's absence: any other outcome —
# a seat login, a network failure, a broken `gh` — must abort, not proceed.
case "$(gh api user 2>&1 || true)" in
  *"Resource not accessible by integration"*) ;;  # 403 == App installation
  *) echo "abort: not authenticated as the App installation" >&2; exit 1 ;;
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
# original stays closed is worse than not having tried. Verify the author too —
# the preflight can pass and the create still land under another identity, and a
# seat-authored replacement is exactly the defect being recovered from.
NEW_JSON="$(gh pr view "$NEW_NUM" --repo "$REPO" --json headRefOid,baseRefName,author)"
[ "$(printf '%s' "$NEW_JSON" | jq -r '.headRefOid  // empty')" = "$ORIG_SHA" ] ||
  { echo "abort: #$NEW_NUM is not at $ORIG_SHA" >&2; exit 1; }
[ "$(printf '%s' "$NEW_JSON" | jq -r '.baseRefName // empty')" = "$BASE_REF" ] ||
  { echo "abort: #$NEW_NUM is not onto $BASE_REF" >&2; exit 1; }
NEW_AUTHOR="$(printf '%s' "$NEW_JSON" | jq -r '.author.login // empty')"
case "$NEW_AUTHOR" in
  app/*) ;;
  *) echo "abort: #$NEW_NUM is authored by '$NEW_AUTHOR', not the App" >&2; exit 1 ;;
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
  with it — not `--approve`, not `--request-changes`, not `--comment`. This rule
  governs agents consuming this workflow; only the dedicated reviewer service may
  produce the canonical exact-head `APPROVED` review under that seat. Never post
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
the gate for a change no reviewer ever looked at, and a manually forged canonical
body is indistinguishable from the reviewer's own evidence after the fact. Only
the reviewer's own pipeline may produce a review that clears that gate, and
Paperclip completes that pipeline only after GitHub confirms the exact-head
trusted evidence described above.

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
- Writing the body to this skill's generic structure in a repo that ships its own
  PR template. The template's headings win; ours are the fallback. Discovering the
  mismatch from a red check after pushing costs a CI run every time, and trains you
  to read a red template gate as first-push noise.
- Approving your own PR under the user-seat merge token to turn the review gate
  green. That is a forged review, not a merge unblock — see the credential rules
  above.
