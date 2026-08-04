# onprem-k8s: agent-authored PRs need a human reviewer (BLO-21564)

Full technical writeup lives in the target repo:
[`Blockcast/onprem-k8s:docs/runbooks/agent-pr-review-routing.md`](https://github.com/Blockcast/onprem-k8s/blob/master/docs/runbooks/agent-pr-review-routing.md)
(added by [PR #2011](https://github.com/Blockcast/onprem-k8s/pull/2011)).

## TL;DR for the next agent

If a PR you opened in `Blockcast/onprem-k8s` shows CI green but
`gh pr view <n> --json mergeable,mergeStateStatus,reviewDecision` reads
`mergeStateStatus: BLOCKED` with `reviewDecision: null` and **zero reviews
posted or requested** — this is expected, not a bug in your PR. Org ruleset
`19646877` requires an approving review from GitHub team
`Blockcast/onprem-k8s-ally-reviewer`, and **GitHub Apps cannot hold team
membership** — the `allyblockcast[bot]` identity every Paperclip agent
authenticates as can structurally never satisfy that rule on its own PR, or
anyone else's.

**Do not silently poll or wait.** Once CI is green:

1. Confirm the state with `gh pr view <n> --json mergeable,mergeStateStatus,reviewDecision`
   (read `mergeStateStatus`, not `mergeable` — the latter only means "no
   conflicts").
2. Raise a Paperclip board approval (`request_board_approval`) naming the PR
   and asking a human who is a member of `Blockcast/onprem-k8s-ally-reviewer`
   to review, and if clean, approve + merge. Precedent: approval
   `8aae07f1-6639-40b7-bd46-b57c459b3ade` for
   [BLO-21304](https://paperclip.blockcast.net/BLO/issues/BLO-21304).
3. Never add an agent identity to that team, or grant a second agent identity
   write access so it can approve — that recreates the exact self-approval
   hole `BLO-17828` exists to prevent. Out of scope, always.

## What PR #2011 changes (best-effort, not guaranteed)

`.github/CODEOWNERS` in onprem-k8s now has `* @Blockcast/onprem-k8s-ally-reviewer`
as its first line, so GitHub *should* auto-request that team's review on
every PR open. **Observed caveat:** on PR #2011 itself, GitHub populated
`reviewRequests` with the three named security-path owners
(`kkroo`, `eyad-hussein`, `MohamedElmdary`) but did **not** list the team,
even though `codeowners/errors` reported no errors. This matches the
silent-ignore failure mode GitHub has for CODEOWNERS entries naming a
team/user without explicit repo access — plausible cause: the
`onprem-k8s-ally-reviewer` team may only be wired into the org ruleset's
`required_reviewers` rule and not separately added as a repo collaborator
team, but this could not be confirmed with this agent's GitHub token (org
`members`/team-read scopes return 403 for the App). **Open item for a human
with org-admin access:** check whether `Blockcast/onprem-k8s-ally-reviewer`
has at least read access on `Blockcast/onprem-k8s` under repo Settings →
Collaborators & teams, and grant it if not, so the CODEOWNERS notification
actually fires. Until confirmed, treat step 2 above (board approval) as the
only mechanism to rely on — it does not depend on GitHub's notification
system.

## Root cause, precisely

- Org ruleset `19646877` on `onprem-k8s`, `pull_request` rule,
  `required_reviewers: [{team: 18686279 (Blockcast/onprem-k8s-ally-reviewer),
  minimum_approvals: 1, file_patterns: ["*","**/*"]}]` — this is the **sole**
  merge authorization. See `.github/scripts/require-ally-review.py`'s module
  docstring in onprem-k8s for the full breakdown.
- The separate `review/ally-complete` commit status (from
  `.github/workflows/review-gate.yml`) is **advisory only** and cannot block
  or authorize a merge in any state — a common misdiagnosis trap.
- `allyblockcast[bot]` (the GitHub App every Paperclip agent authenticates
  as) posts `COMMENTED` reviews and, being an App, cannot hold team
  membership — it is structurally excluded from ever satisfying the
  `required_reviewers` rule.
- A distinct **User** account also named `allyblockcast` (id `296676656`,
  vs. the App's id `290875700`) is a separate identity that has approved both
  human-authored PRs and at least one agent-authored PR historically
  (`onprem-k8s#1774`) — so the rule is not literally "no identity can ever
  approve an agent PR," it is "a human must actually do it, and nothing
  routed that human's attention for agent PRs."
- Evidence at investigation time (2026-08-04): 12/12 recent merged PRs
  (all authored by human `kkroo`) were approved by the User seat; 0/N
  agent-authored PRs (author `app/allyblockcast`) had ever merged.

See [BLO-21564](https://paperclip.blockcast.net/BLO/issues/BLO-21564) for the
full investigation and decision trail.
