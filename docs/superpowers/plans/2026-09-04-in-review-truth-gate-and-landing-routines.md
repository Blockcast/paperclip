# in_review Truth Gate and Landing Routines Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `in_review` mean "Ally-clean at the current head and merged", land the 28 reviewed-but-unmerged PRs on Blockcast/paperclip, and add the two routines whose absence let 101 human-assigned issues age unreported.

**Architecture:** Four causes, five tracks that ship independently. Track A merges what Ally already reviewed. Track B adds two truth-checked evidence shapes to the existing gate using GitHub API primitives the server already has, behind the pure-evaluator seam. Track C creates a landing routine, adds a report-only count of aged human-owned stalls to the stalled-issue check, and un-pauses the governance sweep. Track D routes agents to the agent-to-agent review path that exists and has never been used. Track E corrects a wrong earlier recommendation and closes the elevation loop as documentation.

**Tech Stack:** TypeScript (paperclip server, vitest), Paperclip REST API (routines, agents, issues), GitHub CLI and App API, Kubernetes ValidatingAdmissionPolicy (read-only context).

**Spec:** The engineering-review findings recorded in this conversation on 2026-09-04 and the memory file `project_paperclip_human_gate_structural_gaps.md`. The verified facts those rest on are restated in each track below so an executor never needs the transcript.

## Global Constraints

- Blockcast/paperclip is a diverged fork (1020 ahead, 2609 behind upstream). Do not sync upstream as part of this plan; the upstream delta is dependencies and UI.
- Work from `origin/master` of Blockcast/paperclip. The local checkout is on a stale branch; read code with `git show origin/master:<path>` and branch fresh.
- Every PR body must carry evidence per the user requirement: before/after JSON, exact `curl`/`gh` commands with output, pasted test output, and a 1440x900 screenshot for anything visible in the Paperclip UI. There is no staging Paperclip; use local `pnpm dev` plus a dev DB, or read-only production verification after the daily deploy.
- Paths under CODEOWNERS (`.github/**`, `skills/**`, `package.json`, `pnpm-lock.yaml`, release scripts) need @kkroo approval. Name it on every PR that touches them.
- Do not change `server/src/services/in-review-gate.ts`. Unlabeled issues keep the `warn` verdict; the flip to `block` is behind a flag and a measured rollout (Task B7).
- Never plan a TokenReview read-extension. It was superseded 2026-08-31 (BLO-30652); enforcement is on the authorization plane via `bc-elevation/bc-active-elevations`.
- Never re-add a cancel step to the governance sweep. CEO ruling BLO-19484 made it report-only after four runs whose "safe" batch contained live work.
- Paperclip REST: `$PAPERCLIP_API_URL`, bearer `$PAPERCLIP_API_KEY`, company `$PAPERCLIP_COMPANY_ID` = `aaced805-3491-4ee5-9b14-cdf70cb81d47`.
- Tests: `pnpm exec vitest run <file>` for one file, `pnpm run test:run` for the stable suite, `pnpm run typecheck` before any PR.
- Deploy to production is `scheduled-production-deploy.yml`, cron `23 7 * * *` UTC, or `gh workflow run scheduled-production-deploy.yml -R Blockcast/paperclip` for an immediate roll.

---

## Ground truth (verified 2026-09-04, read before any task)

| Claim | Evidence |
| --- | --- |
| An agent moving an issue to `in_review` needs one of five review paths; `human_assignee_user_id` is the only one it can always satisfy alone | `server/src/routes/issues.ts` `assertAgentInReviewReviewPath` (~3877-3930) |
| Agent-to-agent handoff is already a valid path and is used on 0 of 1084 open issues | `hasExecutionParticipant` accepts `type:"agent"` (issues.ts:1006); `executionPolicy`/`executionState` null on every open issue |
| The evidence gate is a regex over the agent's own comment; no Ally shape, no deploy shape | `evidence-gate.ts` `detectLandingArtifact`/`detectCiGreen`; all 505 evaluated verdicts have `unlabeledFallback:true` |
| The GitHub truth primitives exist and are unused by the gate | `github-app-auth.ts` `githubListPrReviewsWithTimestamps` (:692), `githubGetPullRequestGate` (:241), `githubFetchPrHeadSha` (:411) |
| 20 PRs are CI-green, Ally-reviewed with zero findings, and unmerged; no review is required to merge | branch protection `required_reviews: null`; Ally self-merged 20 of the last 40 |
| The stalled check deliberately hides human-owned issues | rule (a) in "Agent health & stalled-issue check" §2a, BLO-8470 |
| The governance sweep that flags human-gated ageing is paused | routine status `paused`, last run 2026-08-17 |
| The TokenReview read-extension is a dead design | `onprem-k8s/security/bc-elevation/source-of-truth.md`, superseded 2026-08-31 |

## File structure

**Blockcast/paperclip (Track B, D)**

- Create `server/src/services/ally-review-verdict.ts`: the canonical Ally review grammar, ported verbatim from `scripts/check-ally-review-consistency.mjs`. One responsibility: parse a review body.
- Create `server/src/services/ally-review-verdict.test.ts`.
- Create `server/src/services/evidence-truth.ts`: the GitHub truth probe. Takes injected fetchers, returns detections plus diagnostics. Never imports the gate.
- Create `server/src/services/evidence-truth.test.ts`.
- Modify `server/src/services/evidence-shapes.ts`: two new shapes in the union and registry.
- Modify `server/src/services/evidence-gate.ts`: `externalDetections` input, two new keys in `detectAll`, flag-gated unlabeled block.
- Modify `server/src/services/evidence-gate.test.ts`.
- Modify `server/src/services/evidence-gate-wiring.ts`: optional `truth` probe parameter.
- Modify `server/src/services/issues.ts:2176` and the two `runEvidenceGate` call sites (:10487, :10632).
- Modify `skills/paperclip-evidence-before-in-review/SKILL.md` (B8: label table and the two shape sections; D2: the privileged-access section before `## Anti-patterns`) and `skills/paperclip/SKILL.md` (D2: the in_review review-path rule). Both CODEOWNED by @kkroo.
- Create `docs/runbooks/agent-elevation-request.md` (Track E).

**Paperclip live instance (Track A, C, D1)**: no files; REST mutations with pasted receipts.

## Tracks

| Track | Ships | Depends on |
| --- | --- | --- |
| A | 28 PRs merged or dispositioned; production deploy dispatched | nothing |
| B | evidence gate truth shapes PR | nothing (A lands #1588/#1585 first is convenient, not required) |
| C | landing routine, stalled-check amendment, governance sweep un-paused | nothing |
| D | six agents carry the evidence skill; skills PR | nothing (B8 owns the shape docs in the evidence skill; D2 edits a separate region) |
| E | elevation runbook; precondition verified or filed | nothing |

---


## Track A: Land the PR backlog and repair the gate PRs

**Why this track** Eighty PRs sit open on Blockcast/paperclip and 76 are Ally's. Twenty are CI-green with zero Ally findings and simply never got merged, because review and merge are two loops with no bridge. Eight more carry one to three open Important findings that nobody is assigned to close, and four gate-relevant PRs are red. Nothing else in this plan reaches production until this backlog lands and the daily deploy carries it.

Operator context for every task: run from a fresh worktree so the stale local branch is untouched. All scratch output goes under `/tmp/track-a/`. The durable evidence log is committed on branch `track-a-landing-log`. Required env: `PAPERCLIP_API_URL`, `PAPERCLIP_API_KEY`, `PAPERCLIP_COMPANY_ID=aaced805-3491-4ee5-9b14-cdf70cb81d47`, `gh` authenticated with write access to Blockcast/paperclip.

Deviation from the brief, stated up front: the `### Prior Findings Dispositioned (N)` ledger is parsed only from the REVIEWER's consolidated review (`server/src/services/ally-review-detection.ts:73-102`, verbs `fixed` | `no-longer-applicable` retire, `still-present` blocks). If the PR author posts ledger-shaped lines under Ally's login, the gate would read them as reviewer output and could self-clear findings. So in A2 the author comment lists findings under `### Findings addressed` in plain prose, and the ledger appears only in Ally's re-review.

### Task A1: Merge the 20 clean PRs

**Files:**
- Create: `/tmp/track-a/a1-prs.tsv` (scratch)
- Create: `docs/superpowers/plans/2026-09-05-track-a-landing-log.md` (in worktree `/tmp/track-a/wt`)
- Test: `gh pr view <n> --json state,mergeCommit` per PR (verification, no test file)

**Interfaces:**
- Consumes: FACTS PR lists; branch protection (required check `verify`, strict true, required_reviews null); merge queue max_entries_to_build 1; CODEOWNERS patterns (`.github/**`, `skills/**`, `package.json`, `pnpm-lock.yaml`, and the release scripts listed in FACTS).
- Produces: `/tmp/track-a/a1-prs.tsv` with columns `pr<TAB>codeowned<TAB>mergeState<TAB>head`; the landing log file; merged commit SHAs for 16 PRs immediately and 4 more after @kkroo approval.

- [ ] **Step 1: Create the worktree and scratch dir**
```bash
mkdir -p /tmp/track-a
cd /Users/oramadan/src/github.com/blockcast/paperclip
git fetch origin master
git worktree add /tmp/track-a/wt -b track-a-landing-log origin/master
printf '# Track A landing log (2026-09-05)

## A1 merges

| PR | codeowned | pre-state | merge commit | merged at |
|---|---|---|---|---|
' \
  > /tmp/track-a/wt/docs/superpowers/plans/2026-09-05-track-a-landing-log.md
```
Run: `git -C /tmp/track-a/wt status --short`  Expected: `?? docs/superpowers/plans/2026-09-05-track-a-landing-log.md`

- [ ] **Step 2: Verify the branch-protection facts before relying on them**
```bash
gh api repos/Blockcast/paperclip/branches/master/protection \
  --jq '{reviews: .required_pull_request_reviews, contexts: .required_status_checks.contexts, strict: .required_status_checks.strict, admins: .enforce_admins.enabled}'
```
Run: the command above  Expected: `{"reviews":null,"contexts":["verify"],"strict":true,"admins":false}`. If `reviews` is non-null with `require_code_owner_reviews: true`, the four CODEOWNED PRs are hard-blocked, not convention-blocked; A1 Step 7 still applies unchanged.

- [ ] **Step 3: Snapshot the 20 PRs and classify CODEOWNED by touched paths**
```bash
cd /tmp/track-a
: > a1-prs.tsv
for n in 1635 1627 1609 1605 1600 1596 1595 1588 1586 1585 1584 1467 1418 1322 1309 1279 1219 1195 1150 1091; do
  files="$(gh pr view "$n" -R Blockcast/paperclip --json files --jq '.files[].path')"
  if printf '%s
' "$files" | grep -qE '^(\.github/|skills/|package\.json$|pnpm-lock\.yaml$|pnpm-workspace\.yaml$|\.npmrc$|scripts/release.*\.sh$|scripts/release-.*\.mjs$|scripts/create-github-release\.sh$|scripts/rollback-latest\.sh$|doc/(RELEASING|PUBLISHING|RELEASE-AUTOMATION-SETUP)\.md$)'; then co=yes; else co=no; fi
  gh pr view "$n" -R Blockcast/paperclip --json number,mergeStateStatus,headRefOid,isDraft \
    --jq "[.number, \"$co\", .mergeStateStatus, .headRefOid, (.isDraft|tostring)] | @tsv" >> a1-prs.tsv
done
cat a1-prs.tsv
```
Run: `awk -F'\t' '$2=="yes"{print $1}' /tmp/track-a/a1-prs.tsv | sort -n | tr '
' ' '`  Expected: `1150 1219 1585 1596 ` exactly. If the set differs, the differing PR moves between the two merge lists below; the FACTS classification is corrected by this output, not the reverse. Expected `isDraft` is `false` for all 20.

- [ ] **Step 4: Request @kkroo review on the four CODEOWNED PRs and post why**
```bash
for n in 1596 1585 1219 1150; do
  head="$(gh pr view "$n" -R Blockcast/paperclip --json headRefOid --jq .headRefOid)"
  gh pr edit "$n" -R Blockcast/paperclip --add-reviewer kkroo
  gh pr comment "$n" -R Blockcast/paperclip --body "$(cat <<EOF
@kkroo approval requested: this PR touches CODEOWNED paths (see .github/CODEOWNERS).

State at request time:
- CI: \`verify\` green on head \`${head}\`
- Ally consolidated review: zero Critical/Important findings at this head
- Merge plan: \`gh pr merge ${n} --squash --auto\` (merge queue) immediately after your approval

Context: Track A of the 2026-09-05 Paperclip landing plan (20 clean PRs; 16 are merging now, these 4 wait on you).
EOF
)"
done
```
Run: `gh pr view 1596 -R Blockcast/paperclip --json reviewRequests --jq '.reviewRequests[].login'`  Expected: `kkroo`

- [ ] **Step 5: Merge the 16 non-CODEOWNED PRs serially, handling BEHIND and DIRTY**

Order: `1588` first because it fixes the in_review validator predicate that every later disposition step depends on. Then newest to oldest, since older heads are the most likely to be BEHIND or DIRTY.

```bash
cd /tmp/track-a
LOG=/tmp/track-a/wt/docs/superpowers/plans/2026-09-05-track-a-landing-log.md
for n in 1588 1635 1627 1609 1605 1600 1595 1586 1584 1467 1418 1322 1309 1279 1195 1091; do
  pre="$(gh pr view "$n" -R Blockcast/paperclip --json mergeStateStatus --jq .mergeStateStatus)"
  echo "== PR $n pre-state $pre"
  if [ "$pre" = "BEHIND" ]; then
    gh pr update-branch "$n" -R Blockcast/paperclip || pre=DIRTY
  fi
  if [ "$pre" = "DIRTY" ]; then
    gh pr comment "$n" -R Blockcast/paperclip --body "Track A landing 2026-09-05: this PR conflicts with master (mergeStateStatus DIRTY). Not merged. A Paperclip issue assigned to Ally requests a rebase onto current master; once \`verify\` is green again it will be enqueued."
    cat > "/tmp/track-a/a1-dirty-$n.json" <<EOF
{"title":"Rebase Blockcast/paperclip PR #$n onto master (conflicts block Track A merge)","description":"PR https://github.com/Blockcast/paperclip/pull/$n has mergeStateStatus DIRTY.

Done when:
- branch rebased or merged onto current origin/master with conflicts resolved
- \`verify\` check green on the new head
- comment on the PR naming the new head sha

Do NOT open a replacement PR; keep #$n so the existing Ally review ledger stays attached. Track A landing plan 2026-09-05.","assigneeAgentId":"e0a5011d-5c94-4801-be52-64c14f98ac26","priority":"high","status":"todo"}
EOF
    curl -sS -X POST "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/issues" \
      -H "Authorization: Bearer $PAPERCLIP_API_KEY" -H 'Content-Type: application/json' \
      -d @"/tmp/track-a/a1-dirty-$n.json" | jq -r '"created \(.identifier) \(.id)"'
    printf '| %s | no | DIRTY | (not merged, rebase issue opened) | |
' "$n" >> "$LOG"
    continue
  fi
  gh pr checks "$n" -R Blockcast/paperclip --watch --fail-fast
  gh pr merge "$n" -R Blockcast/paperclip --squash --auto
  for i in $(seq 1 45); do
    st="$(gh pr view "$n" -R Blockcast/paperclip --json state --jq .state)"
    [ "$st" = "MERGED" ] && break
    sleep 60
  done
  gh pr view "$n" -R Blockcast/paperclip --json number,state,mergeCommit,mergedAt \
    --jq "\"| \(.number) | no | $pre | \(.mergeCommit.oid // \"PENDING\") | \(.mergedAt // \"\") |\"" >> "$LOG"
done
```
Run: `grep -c '| no |' "$LOG"`  Expected: `16`. Run: `grep -c 'PENDING' "$LOG"`  Expected: `0`. If a row says PENDING after 45 minutes, the queue evicted it. Run `gh pr checks <n> -R Blockcast/paperclip` and treat a red `verify` exactly as the DIRTY branch above (comment plus Paperclip issue to Ally with the failing check name).

- [ ] **Step 6: Confirm master contains every merge commit**
```bash
git -C /tmp/track-a/wt fetch origin master
for sha in $(grep -oE '\| [0-9a-f]{40} \|' "$LOG" | tr -d '| '); do
  git -C /tmp/track-a/wt merge-base --is-ancestor "$sha" origin/master && echo "ok $sha" || echo "MISSING $sha"
done
```
Run: the loop above  Expected: 16 lines starting with `ok`, zero `MISSING`.

- [ ] **Step 7: Merge the four CODEOWNED PRs once @kkroo has approved**

Poll approval, then run the identical merge sequence. Do not enqueue any of these four before an APPROVED review from kkroo exists, even though branch protection does not enforce it.
```bash
LOG=/tmp/track-a/wt/docs/superpowers/plans/2026-09-05-track-a-landing-log.md
for n in 1585 1596 1219 1150; do
  ok="$(gh api "repos/Blockcast/paperclip/pulls/$n/reviews" --paginate \
        --jq '[.[] | select(.user.login=="kkroo" and .state=="APPROVED")] | length')"
  if [ "${ok:-0}" -lt 1 ]; then echo "PR $n: no kkroo approval yet, skip"; continue; fi
  pre="$(gh pr view "$n" -R Blockcast/paperclip --json mergeStateStatus --jq .mergeStateStatus)"
  if [ "$pre" = "BEHIND" ]; then gh pr update-branch "$n" -R Blockcast/paperclip || pre=DIRTY; fi
  if [ "$pre" = "DIRTY" ]; then
    gh pr comment "$n" -R Blockcast/paperclip --body "Track A landing 2026-09-05: conflicts with master (DIRTY) after @kkroo approval. Rebase requested via a Paperclip issue to Ally; re-approval will be requested on the new head."
    printf '| %s | yes | DIRTY | (not merged) | |
' "$n" >> "$LOG"; continue
  fi
  gh pr checks "$n" -R Blockcast/paperclip --watch --fail-fast
  gh pr merge "$n" -R Blockcast/paperclip --squash --auto
  for i in $(seq 1 45); do
    [ "$(gh pr view "$n" -R Blockcast/paperclip --json state --jq .state)" = "MERGED" ] && break; sleep 60
  done
  gh pr view "$n" -R Blockcast/paperclip --json number,state,mergeCommit,mergedAt \
    --jq "\"| \(.number) | yes | $pre | \(.mergeCommit.oid // \"PENDING\") | \(.mergedAt // \"\") |\"" >> "$LOG"
done
```
Run: `grep -c '| yes |' "$LOG"`  Expected: `4` once all four approvals exist. Order matters for one pair: `1585` (guard ratchet) must merge before A3 rebases `1559` (same guard script).

- [ ] **Step 8: Commit**
```bash
cd /tmp/track-a/wt
git add docs/superpowers/plans/2026-09-05-track-a-landing-log.md
git commit -m "docs(plans): record Track A merge log for the 20 clean PRs"
```

- [ ] **Step 9: PR evidence**
Paste into the eventual log PR (opened in A4 Step 8):
- The `/tmp/track-a/a1-prs.tsv` contents (pre-merge state of all 20).
- The `## A1 merges` table with 20 merge-commit SHAs and timestamps.
- Output of Step 6 (16 `ok` lines) and the Step 7 equivalent (4 `ok` lines).
- The four `gh pr comment` URLs from Step 4 and kkroo's four APPROVED review URLs.
- No UI or API change in this task; no screenshot required.

### Task A2: Disposition the 8 PRs with open Important findings

**Files:**
- Create: `/tmp/track-a/a2-<n>-review.md` (Ally's latest consolidated review body per PR)
- Create: `/tmp/track-a/a2-<n>-issue.json` (Paperclip issue payload per PR)
- Modify: `docs/superpowers/plans/2026-09-05-track-a-landing-log.md` (append `## A2 dispositions`)
- Test: `gh api repos/Blockcast/paperclip/commits/<head>/status` per PR (verification)

**Interfaces:**
- Consumes: Ally login `allyblockcast[bot]`; heading `## Ally — Consolidated PR Review`; `Reviewed head:` attestation line; ledger grammar `- **prior:<7-40 hex> <severity> <index>** — <verb> — <reason>` with verbs `fixed` | `no-longer-applicable` | `still-present`; webhook marker regex `/^<!--[ \t]*paperclip:review-request(?:[ \t][^>]*)?[ \t]*-->/i` (byte 0, no indent, no quote); self-echo guard rejects any marker comment that also contains a standalone `## Ally — Consolidated PR Review` heading; native re-request = `DELETE` then `POST /pulls/<n>/requested_reviewers` with `{"reviewers":["allyblockcast"]}` (BLO-22892); Ally agent id `e0a5011d-5c94-4801-be52-64c14f98ac26`; commit status context `review/ally-comment` (renamed to `gate/ally-comment-findings` by #1471).
- Produces: one Paperclip issue per PR (identifier recorded in the log); a re-request comment template; a merged or explicitly held PR per row.

- [ ] **Step 1: Pull Ally's latest consolidated review for each of the 8 PRs**
```bash
cd /tmp/track-a
for n in 1455 1361 1360 1277 1229 1141 1126 1220; do
  gh api "repos/Blockcast/paperclip/pulls/$n/reviews" --paginate \
    --jq '[.[] | select(.user.login=="allyblockcast[bot]") | select(.body | test("^## Ally — Consolidated PR Review"; "m"))] | last | .body' \
    > "a2-$n-review.md"
  head_att="$(grep -iE '^[ \t]*[_*]*[ \t]*reviewed head:' "a2-$n-review.md" | grep -oE '[0-9a-f]{40}' | head -1)"
  cur="$(gh pr view "$n" -R Blockcast/paperclip --json headRefOid --jq .headRefOid)"
  imp="$(grep -oE '^### Important Issues \([0-9]+\)' "a2-$n-review.md" | grep -oE '[0-9]+')"
  echo "PR $n reviewed=$head_att current=$cur important=$imp"
done
```
Run: the loop above  Expected: 8 lines; `important` is `1` for seven PRs and `3` for 1220; `reviewed` equals `current` for each (the review is at the live head). If `reviewed != current`, the PR moved after review. Fall through to Step 4 anyway; Ally must re-review the current head regardless.

- [ ] **Step 2: Extract the Important section verbatim into the issue payload**
```bash
cd /tmp/track-a
for n in 1455 1361 1360 1277 1229 1141 1126 1220; do
  sed -n '/^### Important Issues (/,/^### Suggestions (/p' "a2-$n-review.md" | sed '$d' > "a2-$n-important.md"
  wc -l "a2-$n-important.md"
done
```
Run: `head -3 /tmp/track-a/a2-1220-important.md`  Expected: first line `### Important Issues (3)`, then Ally's numbered finding text. Zero-length output means the section ordering differs; open `a2-<n>-review.md` and copy the Important block by hand into `a2-<n>-important.md`.

- [ ] **Step 3: Write the Paperclip issue payload per PR**
```bash
cd /tmp/track-a
for n in 1455 1361 1360 1277 1229 1141 1126 1220; do
  head7="$(grep -iE 'reviewed head:' "a2-$n-review.md" | grep -oE '[0-9a-f]{40}' | head -1 | cut -c1-7)"
  cnt="$(grep -oE '^### Important Issues \([0-9]+\)' "a2-$n-review.md" | grep -oE '[0-9]+')"
  jq -n --arg title "Close $cnt Important finding(s) on Blockcast/paperclip PR #$n (reviewed head $head7)" \
        --rawfile findings "a2-$n-important.md" \
        --arg n "$n" --arg head7 "$head7" --arg cnt "$cnt" '
  {title: $title,
   assigneeAgentId: "e0a5011d-5c94-4801-be52-64c14f98ac26",
   priority: "high", status: "todo",
   description: ("PR: https://github.com/Blockcast/paperclip/pull/" + $n + "
You authored this PR and reviewed it at head `" + $head7 + "`. The review left " + $cnt + " Important finding(s) open. Nobody is assigned to close them, so the PR cannot merge.

## Findings (verbatim from your review)

" + $findings + "

## Do this, in order

1. For each finding: push a fix commit to the PR branch, OR decide it is invalid and write the rationale. Do not open a replacement PR.
2. Post ONE comment on the PR. Its first byte must be the marker; no leading newline, indent, or quote. Do NOT include the heading `## Ally — Consolidated PR Review` anywhere in it (self-echo guard would suppress the wake). Body:

```
<!-- paperclip:review-request -->
@ally re-review requested at head <new 40-hex sha>.

### Findings addressed
- prior:" + $head7 + " important 1: fixed in <commit sha> — <one line: what changed>
- prior:" + $head7 + " important 2: no-longer-applicable — <one line: why the finding does not hold>

Track A landing plan 2026-09-05; Paperclip issue <this identifier>.
```

3. Re-arm the reviewer wake natively (a bare POST to an already-requested reviewer returns 200 and fires nothing, BLO-22892):

```
gh api -X DELETE repos/Blockcast/paperclip/pulls/" + $n + "/requested_reviewers -f \"reviewers[]=allyblockcast\"
gh api -X POST   repos/Blockcast/paperclip/pulls/" + $n + "/requested_reviewers -f \"reviewers[]=allyblockcast\"
```

4. In the re-review at the new head, the ledger must name every prior finding:

```
### Prior Findings Dispositioned (" + $cnt + ")
- **prior:" + $head7 + " important 1** — fixed — <reason>
```

Use `fixed` or `no-longer-applicable` to retire a finding. `still-present` keeps the PR red and this issue open.

## Done when
- Latest consolidated review at the current head reports `### Important Issues (0)` and `### Critical Issues (0)`
- Ledger has " + $cnt + " retiring entries
- Commit status `review/ally-comment` (or `gate/ally-comment-findings`) is `success` on the current head
- You comment here with the new head sha and the review URL

Then move this issue to in_review; the operator merges the PR.")}' > "a2-$n-issue.json"
done
```
Run: `jq -r '.title' /tmp/track-a/a2-*-issue.json`  Expected: 8 titles, each starting `Close ` and ending with a 7-hex `reviewed head`.

- [ ] **Step 4: Create the 8 Paperclip issues and record identifiers**
```bash
cd /tmp/track-a
LOG=/tmp/track-a/wt/docs/superpowers/plans/2026-09-05-track-a-landing-log.md
printf '
## A2 dispositions

| PR | Important open | reviewed head | Paperclip issue | outcome |
|---|---|---|---|---|
' >> "$LOG"
for n in 1455 1361 1360 1277 1229 1141 1126 1220; do
  resp="$(curl -sS -X POST "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/issues" \
    -H "Authorization: Bearer $PAPERCLIP_API_KEY" -H 'Content-Type: application/json' \
    -d @"a2-$n-issue.json")"
  ident="$(printf '%s' "$resp" | jq -r '.identifier // empty')"
  [ -n "$ident" ] || { echo "PR $n: create failed: $resp"; continue; }
  curl -sS "$PAPERCLIP_API_URL/api/issues/$ident" -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
    | jq -r '"\(.identifier) assignee=\(.assigneeAgentId) status=\(.status)"'
  cnt="$(jq -r '.title' "a2-$n-issue.json" | grep -oE 'Close [0-9]+' | grep -oE '[0-9]+')"
  head7="$(jq -r '.title' "a2-$n-issue.json" | grep -oE '[0-9a-f]{7}\)$' | tr -d ')')"
  printf '| %s | %s | %s | %s | pending |
' "$n" "$cnt" "$head7" "$ident" >> "$LOG"
done
```
Run: the loop above  Expected: 8 lines like `BLO-NNNNN assignee=e0a5011d-5c94-4801-be52-64c14f98ac26 status=todo`. Ally has `wakeOnDemand:true`, so assignment wakes her; no heartbeat call needed.

- [ ] **Step 5: Verify each PR's gate turns green after Ally's re-review**

Re-run until every row resolves. Check the live head, the latest review's counts and ledger, and the commit status.
```bash
cd /tmp/track-a
for n in 1455 1361 1360 1277 1229 1141 1126 1220; do
  cur="$(gh pr view "$n" -R Blockcast/paperclip --json headRefOid --jq .headRefOid)"
  body="$(gh api "repos/Blockcast/paperclip/pulls/$n/reviews" --paginate \
    --jq '[.[] | select(.user.login=="allyblockcast[bot]") | select(.body | test("^## Ally — Consolidated PR Review"; "m"))] | last | .body')"
  att="$(printf '%s' "$body" | grep -iE 'reviewed head:' | grep -oE '[0-9a-f]{40}' | head -1)"
  imp="$(printf '%s' "$body" | grep -oE '^### Important Issues \([0-9]+\)' | grep -oE '[0-9]+')"
  crit="$(printf '%s' "$body" | grep -oE '^### Critical Issues \([0-9]+\)' | grep -oE '[0-9]+')"
  retired="$(printf '%s' "$body" | grep -ciE '^[ \t]*-[ \t]*\*\*[ \t]*prior:[0-9a-f]{7,40}[ \t]+important[ \t]+[0-9]+[ \t]*\*\*[ \t]*(—|–|-)[ \t]*(fixed|no-longer-applicable)[ \t]*(—|–|-)')"
  still="$(printf '%s' "$body" | grep -ciE 'still-present')"
  gate="$(gh api "repos/Blockcast/paperclip/commits/$cur/status" \
    --jq '[.statuses[] | select(.context | test("ally-comment"))] | last | "\(.context)=\(.state)"')"
  echo "PR $n head=$cur attested=$att critical=$crit important=$imp retired=$retired still=$still $gate"
done
```
Run: the loop above  Expected per resolved PR: `attested` equals `head`, `critical=0 important=0`, `retired` equals the original count (1, or 3 for #1220), `still=0`, and `review/ally-comment=success` (or `gate/ally-comment-findings=success` after #1471 lands). A PR with `still>0` stays held; comment on its Paperclip issue asking Ally for the fix or an explicit `no-longer-applicable` rationale, and leave the row `pending`.

- [ ] **Step 6: Merge each resolved PR**
```bash
LOG=/tmp/track-a/wt/docs/superpowers/plans/2026-09-05-track-a-landing-log.md
for n in <resolved PR numbers from Step 5>; do
  pre="$(gh pr view "$n" -R Blockcast/paperclip --json mergeStateStatus --jq .mergeStateStatus)"
  if [ "$pre" = "BEHIND" ]; then gh pr update-branch "$n" -R Blockcast/paperclip || pre=DIRTY; fi
  if [ "$pre" = "DIRTY" ]; then
    gh pr comment "$n" -R Blockcast/paperclip --body "Track A 2026-09-05: findings closed but the branch now conflicts with master (DIRTY). Please rebase; the re-review ledger stays attached to this PR."
    sed -i '' "s/^| $n | \(.*\) | pending |\$/| $n | \1 | DIRTY after re-review |/" "$LOG"; continue
  fi
  gh pr checks "$n" -R Blockcast/paperclip --watch --fail-fast
  gh pr merge "$n" -R Blockcast/paperclip --squash --auto
  for i in $(seq 1 45); do
    [ "$(gh pr view "$n" -R Blockcast/paperclip --json state --jq .state)" = "MERGED" ] && break; sleep 60
  done
  sha="$(gh pr view "$n" -R Blockcast/paperclip --json mergeCommit --jq '.mergeCommit.oid // "PENDING"')"
  sed -i '' "s/^| $n | \(.*\) | pending |\$/| $n | \1 | merged $sha |/" "$LOG"
done
```
Run: `grep -E '^\| (1455|1361|1360|1277|1229|1141|1126|1220) \|' "$LOG"`  Expected: 8 rows, each `merged <40-hex>` or an explicit hold reason; no bare `pending` at the end of the track.

- [ ] **Step 7: Commit**
```bash
cd /tmp/track-a/wt
git add docs/superpowers/plans/2026-09-05-track-a-landing-log.md
git commit -m "docs(plans): record Track A dispositions for the 8 PRs with Important findings"
```

- [ ] **Step 8: PR evidence**
Paste into the log PR (A4 Step 8):
- The `## A2 dispositions` table with 8 Paperclip identifiers and outcomes.
- For each PR: the re-request comment URL (marker at byte 0), the re-review URL, and the Step 5 output line showing `important=0 retired=N` and the `success` gate status.
- For any held PR: the `still-present` ledger line quoted verbatim and the Paperclip issue comment asking for resolution.
- No UI or API change in this task; no screenshot required.

### Task A3: Get the 4 CI-failing gate PRs green

**Files:**
- Create: `/tmp/track-a/a3-<n>.log` (failing job log tail per PR)
- Create: `/tmp/track-a/a3-<n>-issue.json` (fallback Paperclip payload)
- Modify: `docs/superpowers/plans/2026-09-05-track-a-landing-log.md` (append `## A3 gate PRs`)
- Test: `gh pr checks <n>` after retry (verification)

**Interfaces:**
- Consumes: PRs `1471` (review-gate namespace rename plus db migration `023x`), `1463` (adapterConfig.env default-deny), `1559` (ally-guard superseded status; depends on #1585 having merged in A1 Step 7), `1613` (kkroo's markdown already-reviewed exits). `gh run view <id> --log-failed`. Ally agent id `e0a5011d-5c94-4801-be52-64c14f95ac26` is WRONG if copied; use `e0a5011d-5c94-4801-be52-64c14f98ac26`.
- Produces: per PR either a merge commit or a PR comment plus Paperclip issue with the log excerpt.

- [ ] **Step 1: Capture the failing check and its log for each PR**
```bash
cd /tmp/track-a
for n in 1471 1463 1559 1613; do
  gh pr checks "$n" -R Blockcast/paperclip --json name,state,link \
    --jq '.[] | select(.state=="FAILURE") | "\(.name)\t\(.link)"' > "a3-$n-failed.tsv"
  while IFS=$'\t' read -r name link; do
    run="$(printf '%s' "$link" | sed -nE 's#.*/actions/runs/([0-9]+).*#\1#p')"
    echo "PR $n failing check: $name run=$run"
    gh run view "$run" -R Blockcast/paperclip --log-failed 2>/dev/null | tail -n 150 >> "a3-$n.log"
  done < "a3-$n-failed.tsv"
  echo "--- PR $n log lines: $(wc -l < "a3-$n.log")"
done
```
Run: `cat /tmp/track-a/a3-1471-failed.tsv`  Expected: at least one line `<check name>\thttps://github.com/Blockcast/paperclip/actions/runs/<id>/job/<jobid>`. An empty file means the failure is a non-Actions status (for example `review/ally-comment` red); record `gh api repos/Blockcast/paperclip/commits/$(gh pr view $n -R Blockcast/paperclip --json headRefOid --jq .headRefOid)/status --jq '.statuses[] | {context,state,description}'` into the log instead.

- [ ] **Step 2: Check #1471 for a migration-number collision before retrying**
```bash
cd /tmp/track-a
gh pr view 1471 -R Blockcast/paperclip --json files --jq '.files[].path | select(test("migrat|drizzle"))' > a3-1471-migrations.txt
cat a3-1471-migrations.txt
git -C /tmp/track-a/wt fetch origin master
for f in $(cat a3-1471-migrations.txt); do
  dir="$(dirname "$f")"; num="$(basename "$f" | grep -oE '^[0-9]+')"
  git -C /tmp/track-a/wt ls-tree -r --name-only origin/master -- "$dir" | grep -E "/${num}_" || echo "no collision for $num"
done
```
Run: the loop above  Expected: `no collision for 023x` for each PR migration file. If a master file with the same number prints, the PR needs a NEW forward migration number; write that requirement into the Step 5 issue for #1471 and skip its retry (a rebase cannot fix it).

- [ ] **Step 3: Rebase-and-retry once (#1559 only after #1585 is MERGED)**
```bash
cd /tmp/track-a
gh pr view 1585 -R Blockcast/paperclip --json state --jq .state
for n in 1471 1463 1559 1613; do
  if [ "$n" = "1559" ] && [ "$(gh pr view 1585 -R Blockcast/paperclip --json state --jq .state)" != "MERGED" ]; then
    echo "PR 1559: waiting for #1585 to merge first"; continue
  fi
  if gh pr update-branch "$n" -R Blockcast/paperclip; then
    echo "PR $n: branch updated, waiting for verify"
    gh pr checks "$n" -R Blockcast/paperclip --watch --fail-fast && echo "PR $n: GREEN" || echo "PR $n: STILL RED"
  else
    echo "PR $n: update-branch failed (conflict); STILL RED"
  fi
done
```
Run: the loop above  Expected: one `GREEN` or `STILL RED` line per PR. `pr.yml` triggers on the default `pull_request` types, so `update-branch` re-runs `verify` without a `/test` comment.

- [ ] **Step 4: Merge every PR that went GREEN**
```bash
LOG=/tmp/track-a/wt/docs/superpowers/plans/2026-09-05-track-a-landing-log.md
printf '
## A3 gate PRs

| PR | failing check | retry result | outcome |
|---|---|---|---|
' >> "$LOG"
for n in <GREEN PR numbers from Step 3>; do
  co=no
  gh pr view "$n" -R Blockcast/paperclip --json files --jq '.files[].path' \
    | grep -qE '^(\.github/|skills/|package\.json$|pnpm-lock\.yaml$)' && co=yes
  if [ "$co" = "yes" ]; then
    ok="$(gh api "repos/Blockcast/paperclip/pulls/$n/reviews" --paginate --jq '[.[] | select(.user.login=="kkroo" and .state=="APPROVED")] | length')"
    if [ "${ok:-0}" -lt 1 ] && [ "$n" != "1613" ]; then
      gh pr edit "$n" -R Blockcast/paperclip --add-reviewer kkroo
      gh pr comment "$n" -R Blockcast/paperclip --body "@kkroo approval requested: CODEOWNED paths, \`verify\` now green after rebase. Will enqueue with \`gh pr merge $n --squash --auto\` on approval. Track A 2026-09-05."
      printf '| %s | %s | GREEN | awaiting kkroo approval |
' "$n" "$(cut -f1 "/tmp/track-a/a3-$n-failed.tsv" | paste -sd, -)" >> "$LOG"; continue
    fi
  fi
  gh pr merge "$n" -R Blockcast/paperclip --squash --auto
  for i in $(seq 1 45); do
    [ "$(gh pr view "$n" -R Blockcast/paperclip --json state --jq .state)" = "MERGED" ] && break; sleep 60
  done
  sha="$(gh pr view "$n" -R Blockcast/paperclip --json mergeCommit --jq '.mergeCommit.oid // "PENDING"')"
  printf '| %s | %s | GREEN | merged %s |
' "$n" "$(cut -f1 "/tmp/track-a/a3-$n-failed.tsv" | paste -sd, -)" "$sha" >> "$LOG"
done
```
Run: `tail -n 6 "$LOG"`  Expected: one row per GREEN PR with `merged <40-hex>` or `awaiting kkroo approval`. For #1613 (kkroo's own PR) merging on his behalf is allowed by branch protection; still post `gh pr comment 1613 -R Blockcast/paperclip --body "Rebased and green; enqueuing per Track A 2026-09-05. Shout if you want it held."` before `gh pr merge`.

- [ ] **Step 5: For every STILL RED PR, comment the failure summary and open a Paperclip issue for Ally**
```bash
cd /tmp/track-a
LOG=/tmp/track-a/wt/docs/superpowers/plans/2026-09-05-track-a-landing-log.md
for n in <STILL RED PR numbers from Step 3>; do
  checks="$(cut -f1 "a3-$n-failed.tsv" | paste -sd, -)"
  head="$(gh pr view "$n" -R Blockcast/paperclip --json headRefOid --jq .headRefOid)"
  excerpt="$(tail -n 40 "a3-$n.log")"
  gh pr comment "$n" -R Blockcast/paperclip --body "$(printf 'Track A 2026-09-05: still red after one rebase-and-retry at head `%s`.

Failing check(s): `%s`

<details><summary>Last 40 log lines</summary>

```
%s
```
</details>

A Paperclip issue assigned to Ally carries the full excerpt. Not merged.' "$head" "$checks" "$excerpt")"
  extra=""
  [ "$n" = "1613" ] && extra="

This PR belongs to @kkroo. If you cannot push to his branch, open a replacement PR from a fresh branch with his commits cherry-picked, link it here, and ask him to close #1613."
  [ "$n" = "1471" ] && extra="

This PR includes a db migration numbered 023x. If Step 2 of the plan found a collision on master, add a NEW forward migration with the next free number; never renumber or edit an applied migration."
  jq -n --arg title "Fix red CI on Blockcast/paperclip PR #$n ($checks) after rebase" \
        --arg n "$n" --arg head "$head" --arg checks "$checks" --rawfile log "a3-$n.log" --arg extra "$extra" '
  {title: $title, assigneeAgentId: "e0a5011d-5c94-4801-be52-64c14f98ac26", priority: "high", status: "todo",
   description: ("PR: https://github.com/Blockcast/paperclip/pull/" + $n + "
Head at failure: `" + $head + "`
Failing check(s): `" + $checks + "`
One `gh pr update-branch` retry was already done; it is still red.

## Failing log tail

```
" + $log + "
```

## Done when
- `verify` and every listed check are green on the PR head
- you comment on the PR with the new head sha and what changed
- you comment here with the PR head sha

Do not open a replacement PR unless noted below; keep the Ally review ledger attached." + $extra)}' \
    > "a3-$n-issue.json"
  resp="$(curl -sS -X POST "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/issues" \
    -H "Authorization: Bearer $PAPERCLIP_API_KEY" -H 'Content-Type: application/json' -d @"a3-$n-issue.json")"
  ident="$(printf '%s' "$resp" | jq -r '.identifier // empty')"
  echo "PR $n -> $ident"
  printf '| %s | %s | STILL RED | Paperclip %s opened |
' "$n" "$checks" "${ident:-CREATE_FAILED}" >> "$LOG"
done
```
Run: `grep -c 'STILL RED' "$LOG"`  Expected: equals the number of STILL RED PRs; zero `CREATE_FAILED`.

- [ ] **Step 6: Commit**
```bash
cd /tmp/track-a/wt
git add docs/superpowers/plans/2026-09-05-track-a-landing-log.md
git commit -m "docs(plans): record Track A outcomes for the 4 CI-failing gate PRs"
```

- [ ] **Step 7: PR evidence**
Paste into the log PR (A4 Step 8):
- `/tmp/track-a/a3-<n>-failed.tsv` for all four PRs (check name and run link).
- For GREEN PRs: the `gh pr checks` output after retry and the merge commit SHA.
- For STILL RED PRs: the PR comment URL and the Paperclip identifier; the 40-line excerpt is in the comment.
- The Step 2 collision check output for #1471.
- No UI or API change in this task; no screenshot required.

### Task A4: Post-merge deploy proof

**Files:**
- Create: `/tmp/track-a/a4-health-before.json`, `/tmp/track-a/a4-health-after.json`
- Modify: `docs/superpowers/plans/2026-09-05-track-a-landing-log.md` (append `## A4 deploy`)
- Test: `GET $PAPERCLIP_API_URL/api/health` before and after (verification)

**Interfaces:**
- Consumes: `.github/workflows/scheduled-production-deploy.yml` (`workflow_dispatch`; outcomes `dispatched` | `up-to-date` | `skipped-pending`); it dispatches `docker.yml` with `-f target_sha=<master sha>`, whose `deploy` job waits on environment `paperclip-production` (three named human reviewers) and ends with `Two-tier convergence OK: api and worker both on <image> at <COMMIT>`. `GET /api/health` returns `{status, version, serverVersion, serverInfo:{processStartedAt, git:{available, fullSha, shortSha, branchName, subject, committedAt}}}` for board or agent bearer actors in authenticated mode (`server/src/routes/health.ts`, `packages/shared/src/types/server-info.ts:16-34`).
- Produces: before/after health JSON; the docker.yml run URL with a `success` deploy job; the log PR.

- [ ] **Step 1: Record the pre-deploy running commit**
```bash
mkdir -p /tmp/track-a
curl -sS -H "Authorization: Bearer $PAPERCLIP_API_KEY" "$PAPERCLIP_API_URL/api/health" \
  | jq '{status, version, fullSha: .serverInfo.git.fullSha, shortSha: .serverInfo.git.shortSha, committedAt: .serverInfo.git.committedAt, processStartedAt: .serverInfo.processStartedAt}' \
  | tee /tmp/track-a/a4-health-before.json
git -C /tmp/track-a/wt fetch origin master && git -C /tmp/track-a/wt rev-parse origin/master
```
Run: the commands above  Expected: `status: "ok"` and a 40-hex `fullSha` that differs from `origin/master` (production is behind by the merges from A1 to A3). If `fullSha` is null, the bearer is not a board/agent actor; use the kubectl fallback in Step 6 for both before and after.

- [ ] **Step 2: Dispatch the scheduled deploy and read its outcome**
```bash
gh workflow run scheduled-production-deploy.yml -R Blockcast/paperclip --ref master
sleep 20
run="$(gh run list -R Blockcast/paperclip --workflow=scheduled-production-deploy.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
gh run watch "$run" -R Blockcast/paperclip --exit-status
gh run view "$run" -R Blockcast/paperclip --log | grep -oE '::(notice|warning)::[^
]*' | head -5
```
Run: the commands above  Expected: one line `::notice::Dispatched docker.yml at <master sha> — awaiting human approval on paperclip-production.` If it prints `::warning::N dispatch(es) already waiting or running`, go to Step 3 with the already-pending docker.yml run instead of a new one. If it prints `Production already at master`, skip to Step 6.

- [ ] **Step 3: Find the waiting docker.yml run and check who can approve it**
```bash
drun="$(gh run list -R Blockcast/paperclip --workflow=docker.yml --event=workflow_dispatch --limit 5 \
  --json databaseId,status,headSha,url --jq '[.[] | select(.status=="waiting" or .status=="in_progress" or .status=="queued")] | first | .databaseId')"
echo "docker.yml run: $drun"
gh api "repos/Blockcast/paperclip/actions/runs/$drun/pending_deployments" \
  --jq '.[] | {env: .environment.name, wait_timer: .wait_timer, can_approve: .current_user_can_approve, reviewers: [.reviewers[].reviewer.login]}'
```
Run: the commands above  Expected: `env: "paperclip-production"` and `can_approve: true|false` with the three reviewer logins listed. The run may still be in `build-and-push`; re-run this step until `pending_deployments` is non-empty.

- [ ] **Step 4: Approve (if permitted) or hand the run to a named reviewer**
```bash
drun=<from Step 3>
envid="$(gh api repos/Blockcast/paperclip/environments --jq '.environments[] | select(.name=="paperclip-production") | .id')"
can="$(gh api "repos/Blockcast/paperclip/actions/runs/$drun/pending_deployments" --jq '.[0].current_user_can_approve')"
if [ "$can" = "true" ]; then
  gh api -X POST "repos/Blockcast/paperclip/actions/runs/$drun/pending_deployments" \
    -F "environment_ids[]=$envid" -f state=approved \
    -f comment="Track A landing 2026-09-05: 20 clean PRs plus disposition/gate fixes. Convergence gate will verify both tiers."
else
  echo "Post to a named reviewer: approve https://github.com/Blockcast/paperclip/actions/runs/$drun (paperclip-production). Content: Track A landing 2026-09-05; master at $(git -C /tmp/track-a/wt rev-parse origin/master)."
fi
```
Run: the commands above  Expected: with `can=true`, JSON containing `"state":"approved"`; otherwise the printed hand-off line, which is pasted to the reviewer and the log. Do not dispatch a second run while this one waits (guard (1) in the scheduled workflow skips it anyway).

- [ ] **Step 5: Wait for the deploy job and capture the convergence line**
```bash
drun=<from Step 3>
gh run watch "$drun" -R Blockcast/paperclip --exit-status
gh run view "$drun" -R Blockcast/paperclip --json jobs,headSha \
  --jq '{headSha, deploy: (.jobs[] | select(.name=="deploy") | {conclusion, url})}'
gh run view "$drun" -R Blockcast/paperclip --job "$(gh run view "$drun" -R Blockcast/paperclip --json jobs --jq '.jobs[] | select(.name=="deploy") | .databaseId')" --log \
  | grep -E 'Two-tier convergence (OK|check FAILED)' | tail -1
```
Run: the commands above  Expected: `deploy.conclusion: "success"` and one line `Two-tier convergence OK: api and worker both on harbor.blockcast.net/paperclip/paperclip@sha256:... at <headSha>`. A `FAILED` line means a partial roll; stop, paste the job log into a new Paperclip issue for PlatformSREEngineer `d6f327a4-f2f2-4a83-bc5a-173d993cf9b6`, and do not re-dispatch.

- [ ] **Step 6: Verify the running version against the deployed commit**
```bash
target="$(gh run view <drun> -R Blockcast/paperclip --json headSha --jq .headSha)"
curl -sS -H "Authorization: Bearer $PAPERCLIP_API_KEY" "$PAPERCLIP_API_URL/api/health" \
  | jq '{status, version, fullSha: .serverInfo.git.fullSha, shortSha: .serverInfo.git.shortSha, committedAt: .serverInfo.git.committedAt, processStartedAt: .serverInfo.processStartedAt}' \
  | tee /tmp/track-a/a4-health-after.json
[ "$(jq -r .fullSha /tmp/track-a/a4-health-after.json)" = "$target" ] && echo "VERSION MATCH $target" || echo "VERSION MISMATCH"
```
Run: the commands above  Expected: `status: "ok"`, `processStartedAt` later than the before snapshot, and `VERSION MATCH <target>`. If `fullSha` is null (git info unavailable in the container), verify via the deployment annotation instead: `kubectl -n paperclip get deployment paperclip-api -o jsonpath='{.spec.template.metadata.annotations.paperclip\.blockcast\.net/deployed-commit}{"
"}'` and `kubectl -n paperclip get statefulset paperclip -o jsonpath='{.spec.template.metadata.annotations.paperclip\.blockcast\.net/deployed-commit}{"
"}'`; both must print `$target`.

- [ ] **Step 7: Prove the merged work is inside the deployed commit**
```bash
LOG=/tmp/track-a/wt/docs/superpowers/plans/2026-09-05-track-a-landing-log.md
target="$(jq -r .fullSha /tmp/track-a/a4-health-after.json)"
git -C /tmp/track-a/wt fetch origin master
for sha in $(grep -oE 'merged [0-9a-f]{40}|\| [0-9a-f]{40} \|' "$LOG" | grep -oE '[0-9a-f]{40}' | sort -u); do
  git -C /tmp/track-a/wt merge-base --is-ancestor "$sha" "$target" && echo "deployed $sha" || echo "NOT DEPLOYED $sha"
done | tee /tmp/track-a/a4-ancestry.txt
{
  printf '
## A4 deploy

'
  printf 'scheduled-production-deploy run: %s

' "$(gh run list -R Blockcast/paperclip --workflow=scheduled-production-deploy.yml --limit 1 --json url --jq '.[0].url')"
  printf 'docker.yml run: https://github.com/Blockcast/paperclip/actions/runs/%s

' "<drun>"
  printf '### health before

```json
%s
```

### health after

```json
%s
```

### ancestry

```
%s
```
' \
    "$(cat /tmp/track-a/a4-health-before.json)" "$(cat /tmp/track-a/a4-health-after.json)" "$(cat /tmp/track-a/a4-ancestry.txt)"
} >> "$LOG"
```
Run: `grep -c '^NOT DEPLOYED' /tmp/track-a/a4-ancestry.txt`  Expected: `0`. Any merge that landed after the dispatch's `target_sha` prints `NOT DEPLOYED`; it ships on the next 07:23 UTC run, and the log names it.

- [ ] **Step 8: Commit and open the log PR**
```bash
cd /tmp/track-a/wt
git add docs/superpowers/plans/2026-09-05-track-a-landing-log.md
git commit -m "docs(plans): record Track A deploy proof for the 2026-09-05 landing"
git push -u origin track-a-landing-log
gh pr create -R Blockcast/paperclip --base master --head track-a-landing-log \
  --title "docs(plans): Track A landing log 2026-09-05" \
  --body-file docs/superpowers/plans/2026-09-05-track-a-landing-log.md
```
Run: `gh pr view --json url,files -R Blockcast/paperclip --jq '{url, files: [.files[].path]}'`  Expected: exactly one file, `docs/superpowers/plans/2026-09-05-track-a-landing-log.md`; no CODEOWNED path, so no kkroo approval is required. Enqueue it with `gh pr merge --squash --auto` after `verify` is green.

- [ ] **Step 9: PR evidence**
The log PR body is the evidence. It must contain:
- A1 table (20 rows, merge commits), A2 table (8 rows, Paperclip identifiers, outcomes), A3 table (4 rows, check names, outcomes).
- Both health JSON snapshots with differing `fullSha` and `processStartedAt`.
- The `Two-tier convergence OK` line and the docker.yml run URL with `deploy: success`.
- The ancestry list with zero `NOT DEPLOYED`.
- This track changes no UI and no API surface, so no screenshot is required. For any merged PR in A1 to A3 that changed UI or API, the evidence requirement is that PR author's and is already satisfied or noted in its own body; the log records only merge state.


## Track B: Evidence gate truth shapes

**Why this track** The gate that decides whether an issue may enter `in_review` is a regex over the agent's own comment. `landing-artifact` is "a PR URL appears"; `ci-green` is "a PR URL plus the words CI green". Every one of the 505 evaluated verdicts has `unlabeledFallback: true`, so the gate only ever says `warn`, which never blocks. This track adds two shapes the agent cannot type into existence. `review:ally-clean` is verified against GitHub: a canonical Ally review attested at the PR's current head with zero Critical and zero Important findings. `deploy:landed` is verified against GitHub: the PR is merged into the default branch. Both are computed by an injectable probe so the evaluator stays pure and every test runs without network.

Naming is honest on purpose. `deploy:landed` means merged, not running in production. Running-in-production proof stays with the `infra` shapes `kubectl-state` and `url-probe`, which check live state.

Branch from `origin/master` of Blockcast/paperclip. Run tests with `pnpm exec vitest run <file>`.

### Task B1: Canonical Ally review grammar

**Files:**
- Create: `server/src/services/ally-review-verdict.ts`
- Test: `server/src/services/ally-review-verdict.test.ts`
- Read only: `scripts/check-ally-review-consistency.mjs:71-130`

**Interfaces:**
- Consumes: the four regex literals in `scripts/check-ally-review-consistency.mjs` lines 71-86 and its `canonicalReviewHead(body)` at line 123.
- Produces: `isAllyLogin(login: string | null | undefined): boolean`, `canonicalReviewHead(body: string | null | undefined): string | null`, `hasBlockingFindings(body: string): boolean`, `isAllyCleanAtHead(body: string, headSha: string | null | undefined): boolean`, plus the exported regex constants `ALLY_APP_REVIEW_LOGIN_RE`, `ALLY_SEAT_LOGIN_RE`, `CANONICAL_REVIEW_HEADING_RE`, `BLOCKING_SECTION_RE`, `STILL_PRESENT_DISPOSITION_RE`, `ATTESTED_HEAD_RE`.

- [ ] **Step 1: Write the failing test**

```ts
// server/src/services/ally-review-verdict.test.ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  ATTESTED_HEAD_RE,
  BLOCKING_SECTION_RE,
  CANONICAL_REVIEW_HEADING_RE,
  STILL_PRESENT_DISPOSITION_RE,
  canonicalReviewHead,
  hasBlockingFindings,
  isAllyCleanAtHead,
  isAllyLogin,
} from "./ally-review-verdict.js";

const HEAD = "a".repeat(40);
const OTHER = "b".repeat(40);

function review(opts: {
  head?: string;
  critical?: number;
  important?: number;
  stillPresent?: boolean;
  headings?: number;
}): string {
  const lines: string[] = [];
  for (let i = 0; i < (opts.headings ?? 1); i += 1) lines.push("## Ally — Consolidated PR Review");
  lines.push(`**Reviewed head:** \`${opts.head ?? HEAD}\``);
  lines.push(`### Critical Issues (${opts.critical ?? 0})`);
  lines.push(`### Important Issues (${opts.important ?? 0})`);
  if (opts.stillPresent) {
    lines.push("- **prior:731ced5 important 1; correctness** — still-present — the null check is still missing");
  }
  lines.push("### Suggestions (0)", "### Recommended Action", "Land as-is.");
  return lines.join("
");
}

describe("ally-review-verdict", () => {
  it("accepts a clean canonical review attested at the given head", () => {
    expect(isAllyCleanAtHead(review({}), HEAD)).toBe(true);
  });
  it("rejects a review whose attested head is not the current head", () => {
    expect(isAllyCleanAtHead(review({ head: OTHER }), HEAD)).toBe(false);
  });
  it("rejects one Important finding", () => {
    expect(isAllyCleanAtHead(review({ important: 1 }), HEAD)).toBe(false);
  });
  it("rejects one Critical finding", () => {
    expect(isAllyCleanAtHead(review({ critical: 1 }), HEAD)).toBe(false);
  });
  it("treats (0) sections as clean", () => {
    expect(hasBlockingFindings(review({ critical: 0, important: 0 }))).toBe(false);
  });
  it("rejects a still-present prior disposition even with (0) sections", () => {
    expect(isAllyCleanAtHead(review({ stillPresent: true }), HEAD)).toBe(false);
  });
  it("returns null head when the canonical heading appears twice", () => {
    expect(canonicalReviewHead(review({ headings: 2 }))).toBeNull();
  });
  it("returns null head when there is no attestation line", () => {
    expect(canonicalReviewHead("## Ally — Consolidated PR Review
### Critical Issues (0)")).toBeNull();
  });
  it("rejects when headSha is missing", () => {
    expect(isAllyCleanAtHead(review({}), null)).toBe(false);
  });
  it("recognises both Ally logins and nothing else", () => {
    expect(isAllyLogin("allyblockcast[bot]")).toBe(true);
    expect(isAllyLogin("allyblockcast")).toBe(true);
    expect(isAllyLogin("kkroo")).toBe(false);
    expect(isAllyLogin(null)).toBe(false);
  });
  it("stays byte-identical to the guard script's regexes (drift guard)", () => {
    const script = readFileSync(
      new URL("../../../scripts/check-ally-review-consistency.mjs", import.meta.url),
      "utf8",
    );
    for (const [name, re] of [
      ["CANONICAL_REVIEW_HEADING_RE", CANONICAL_REVIEW_HEADING_RE],
      ["BLOCKING_SECTION_RE", BLOCKING_SECTION_RE],
      ["STILL_PRESENT_DISPOSITION_RE", STILL_PRESENT_DISPOSITION_RE],
      ["ATTESTED_HEAD_RE", ATTESTED_HEAD_RE],
    ] as const) {
      const m = script.match(new RegExp(`const ${name} =\\s*\
?\\s*(/.*?/[gimsuy]*);`, "s"));
      expect(m, `${name} not found in guard script`).not.toBeNull();
      expect(`/${re.source}/${re.flags}`).toBe(m![1]);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run server/src/services/ally-review-verdict.test.ts`
Expected: FAIL with `Failed to load url ./ally-review-verdict.js` (module does not exist).

- [ ] **Step 3: Write the module, porting the regexes verbatim**

```ts
// server/src/services/ally-review-verdict.ts
/**
 * Canonical grammar of an Ally consolidated PR review.
 *
 * Ported VERBATIM from scripts/check-ally-review-consistency.mjs (lines 71-130).
 * The test file's drift guard reads that script and fails if any regex here
 * diverges. Change both in the same commit or change neither.
 */

export const ALLY_APP_REVIEW_LOGIN_RE = /^allyblockcast\[bot\]$/;
export const ALLY_SEAT_LOGIN_RE = /^allyblockcast$/;
export const CANONICAL_REVIEW_HEADING_RE = /^## Ally — Consolidated PR Review[ \t]*$/gim;
/** A heading like `### Important Issues (2)` — but not `(0)`. */
export const BLOCKING_SECTION_RE = /^#+[ \t]*(critical|important)[^
]*\((?!0\))\d+\)/im;
/** A prior-finding disposition that says the blocker is still present. */
export const STILL_PRESENT_DISPOSITION_RE =
  /^[ \t]*-[ \t]*\*\*prior:[^
]*\*\*[ \t]*(?:—|-)[ \t]*still-present[ \t]*(?:—|-)/im;
/** The single standalone attestation line Ally is required to emit. */
export const ATTESTED_HEAD_RE =
  /^[ \t]*(?:[_*]+)?[ \t]*reviewed head:[ \t]*`?([0-9a-f]{40})`?[ \t]*(?:[_*]+)?[ \t]*$/im;

export function isAllyLogin(login: string | null | undefined): boolean {
  if (!login) return false;
  return ALLY_APP_REVIEW_LOGIN_RE.test(login) || ALLY_SEAT_LOGIN_RE.test(login);
}

/**
 * Exactly one canonical heading AND exactly one attestation line → that head,
 * lowercased. Anything else → null. Mirrors canonicalReviewHead() in the guard.
 */
export function canonicalReviewHead(body: string | null | undefined): string | null {
  const text = String(body ?? "");
  const headings = Array.from(text.matchAll(CANONICAL_REVIEW_HEADING_RE));
  const attestations = Array.from(text.matchAll(new RegExp(ATTESTED_HEAD_RE.source, "gim")));
  if (headings.length !== 1 || attestations.length !== 1) return null;
  return attestations[0]![1]!.toLowerCase();
}

export function hasBlockingFindings(body: string): boolean {
  return BLOCKING_SECTION_RE.test(body) || STILL_PRESENT_DISPOSITION_RE.test(body);
}

/**
 * True iff `body` is a canonical Ally review attested at `headSha` with no
 * Critical or Important section above zero and no still-present prior finding.
 */
export function isAllyCleanAtHead(body: string, headSha: string | null | undefined): boolean {
  if (!headSha) return false;
  const attested = canonicalReviewHead(body);
  if (attested === null || attested !== headSha.toLowerCase()) return false;
  return !hasBlockingFindings(body);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run server/src/services/ally-review-verdict.test.ts`
Expected: PASS, 11 tests. If the drift-guard case fails, the guard script's literal differs from what this plan quotes; copy the script's literal into the module, do not edit the script.

- [ ] **Step 5: Mutation check, then commit**

Change `(?!0\)` to `(?!1\)` in `BLOCKING_SECTION_RE`, run the test, confirm "rejects one Important finding" and the drift guard both FAIL, then revert.

```bash
git add server/src/services/ally-review-verdict.ts server/src/services/ally-review-verdict.test.ts
git commit -m "feat(evidence): port Ally's canonical review grammar into a server module"
```

### Task B2: Register the two truth shapes

**Files:**
- Modify: `server/src/services/evidence-shapes.ts:14-53`

**Interfaces:**
- Consumes: the existing 13-member `EvidenceShape` union and `DEFAULT_EVIDENCE_REGISTRY`.
- Produces: `EvidenceShape` now includes `"review:ally-clean"` and `"deploy:landed"`; `DEFAULT_UNLABELED_REQUIRED` and six registry entries require both.

- [ ] **Step 1: Extend the union**

Append two members to the `export type EvidenceShape =` union:

```ts
  | "migration-output"
  | "review:ally-clean"
  | "deploy:landed";
```

- [ ] **Step 2: Replace the registry and the unlabeled default**

```ts
export const DEFAULT_EVIDENCE_REGISTRY: EvidenceRegistry = {
  frontend: {
    required: ["screenshot:1440x900", "screenshot:390x844", "checklist:done-when", "landing-artifact", "review:ally-clean", "deploy:landed"],
  },
  ui: {
    required: ["screenshot:1440x900", "screenshot:390x844", "checklist:done-when", "landing-artifact", "review:ally-clean", "deploy:landed"],
  },
  "cms-published": {
    required: ["screenshot:1440x900", "screenshot:390x844", "checklist:done-when", "landing-artifact", "review:ally-clean", "deploy:landed"],
  },
  backend: {
    required: ["test-output", "checklist:done-when", "landing-artifact", "review:ally-clean", "deploy:landed"],
  },
  // infra and cms-data-op have no PR by design: their shapes already demand
  // live state (a real kubectl get, a real HTTP probe). Truth shapes need a PR.
  infra: {
    required: ["kubectl-state", "probe-output"],
  },
  "cms-data-op": {
    required: ["url-probe"],
  },
  // pr: an OPEN pull request is the deliverable, so requiring "merged" here
  // would make the label unsatisfiable. Keep it at pr-link.
  pr: {
    required: ["pr-link"],
  },
  "db-migration": {
    required: ["migration-output", "landing-artifact", "review:ally-clean", "deploy:landed"],
  },
  migration: {
    required: ["migration-output", "landing-artifact", "review:ally-clean", "deploy:landed"],
  },
};

// Unlabeled issues (every one of the 505 evaluated on 2026-09-04) now require
// the two truth shapes too. The verdict for unlabeled stays `warn` until the
// PAPERCLIP_EVIDENCE_UNLABELED_BLOCK flag is turned on (Task B7).
export const DEFAULT_UNLABELED_REQUIRED: EvidenceShape[] = [
  "checklist:done-when",
  "review:ally-clean",
  "deploy:landed",
];
```

Keep every other key exactly as it is in the file. If the file has an entry this plan does not list, leave it untouched.

- [ ] **Step 3: Typecheck**

Run: `pnpm run typecheck`
Expected: FAIL in `server/src/services/evidence-gate.ts` on the `detections` literal inside `detectAll` (a `Record<EvidenceShape, boolean>` now needs two more keys). That failure is expected and is fixed in B3. No other errors.

- [ ] **Step 4: Commit**

```bash
git add server/src/services/evidence-shapes.ts
git commit -m "feat(evidence): register review:ally-clean and deploy:landed shapes"
```

### Task B3: Teach the pure evaluator to accept external detections

**Files:**
- Modify: `server/src/services/evidence-gate.ts:45-53` (input type), `:79-95` (`ALL_SHAPES`), `:571-596` (`detectAll`), `:608-665` (`evaluateEvidence`)
- Test: `server/src/services/evidence-gate.test.ts`

**Interfaces:**
- Consumes: `EvidenceShape` from B2.
- Produces: `EvaluateEvidenceInput.externalDetections?: Partial<Record<EvidenceShape, boolean>>` and `EvaluateEvidenceInput.unlabeledTruthBlock?: boolean`; exported `TRUTH_SHAPES: readonly EvidenceShape[]`; new diagnostic string `"unlabeled-truth-block"`.

- [ ] **Step 1: Write the failing tests**

Append to `server/src/services/evidence-gate.test.ts` (reuse the file's existing `DONE_WHEN_DESCRIPTION`, `CHECKLIST`, `TEST_BANNER`, and `agentComment` helpers):

```ts
describe("evaluateEvidence — externalDetections (truth shapes)", () => {
  const PR = "https://github.com/Blockcast/paperclip/pull/1588";

  it("unlabeled issue with checklist but no truth shapes → warn, missing both truth shapes", () => {
    const result = evaluateEvidence({
      issue: { description: DONE_WHEN_DESCRIPTION, labels: [] },
      comments: [agentComment(`Done. ${PR}

${CHECKLIST}`)],
      workProducts: [],
      registry: DEFAULT_EVIDENCE_REGISTRY,
    });
    expect(result.verdict).toBe("warn");
    expect(result.missing).toEqual(expect.arrayContaining(["review:ally-clean", "deploy:landed"]));
    expect(result.unlabeledFallback).toBe(true);
  });

  it("unlabeled issue with both truth shapes supplied externally → pass", () => {
    const result = evaluateEvidence({
      issue: { description: DONE_WHEN_DESCRIPTION, labels: [] },
      comments: [agentComment(`Done. ${PR}

${CHECKLIST}`)],
      workProducts: [],
      registry: DEFAULT_EVIDENCE_REGISTRY,
      externalDetections: { "review:ally-clean": true, "deploy:landed": true },
    });
    expect(result.verdict).toBe("pass");
    expect(result.allDetected).toEqual(expect.arrayContaining(["review:ally-clean", "deploy:landed"]));
  });

  it("labeled backend with everything present including truth shapes → pass", () => {
    const result = evaluateEvidence({
      issue: { description: DONE_WHEN_DESCRIPTION, labels: [{ name: "backend" }] },
      comments: [agentComment(`Implementation complete: ${PR}

${TEST_BANNER}

${CHECKLIST}`)],
      workProducts: [],
      registry: DEFAULT_EVIDENCE_REGISTRY,
      externalDetections: { "review:ally-clean": true, "deploy:landed": true },
    });
    expect(result.verdict).toBe("pass");
  });

  it("labeled backend with Ally not clean → block, and false external never removes a text detection", () => {
    const result = evaluateEvidence({
      issue: { description: DONE_WHEN_DESCRIPTION, labels: [{ name: "backend" }] },
      comments: [agentComment(`Implementation complete: ${PR}

${TEST_BANNER}

${CHECKLIST}`)],
      workProducts: [],
      registry: DEFAULT_EVIDENCE_REGISTRY,
      externalDetections: { "review:ally-clean": false, "deploy:landed": true, "landing-artifact": false },
    });
    expect(result.verdict).toBe("block");
    expect(result.missing).toEqual(["review:ally-clean"]);
    expect(result.shapeDetections["landing-artifact"]).toBe(true);
  });

  it("unlabeledTruthBlock turns warn into block only when the truth shapes are the sole gap", () => {
    const base = {
      issue: { description: DONE_WHEN_DESCRIPTION, labels: [] },
      comments: [agentComment(`Done. ${PR}

${CHECKLIST}`)],
      workProducts: [],
      registry: DEFAULT_EVIDENCE_REGISTRY,
    };
    const blocked = evaluateEvidence({ ...base, unlabeledTruthBlock: true });
    expect(blocked.verdict).toBe("block");
    expect(blocked.diagnostics).toContain("unlabeled-truth-block");

    const stillWarn = evaluateEvidence({
      ...base,
      comments: [agentComment(`Done. ${PR}`)], // checklist missing too
      unlabeledTruthBlock: true,
    });
    expect(stillWarn.verdict).toBe("warn");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run server/src/services/evidence-gate.test.ts`
Expected: the five new cases FAIL. Existing cases still PASS. Typecheck errors from B2 also surface here.

- [ ] **Step 3: Extend the input type and shape list**

In `EvaluateEvidenceInput` add two optional fields after `doneWhenBulletsRemoved?: boolean;`:

```ts
  /**
   * Detections computed OUTSIDE this pure evaluator, typically by the GitHub
   * truth probe (evidence-truth.ts). A `true` marks the shape detected. A
   * `false` or missing key changes nothing: external input can only add.
   */
  externalDetections?: Partial<Record<EvidenceShape, boolean>>;
  /**
   * When true, an unlabeled issue whose ONLY missing shapes are the truth
   * shapes gets `block` instead of `warn`. Wired from
   * PAPERCLIP_EVIDENCE_UNLABELED_BLOCK by the caller. Default off.
   */
  unlabeledTruthBlock?: boolean;
```

Below `ALL_SHAPES`, add the two new members to that array and export:

```ts
export const TRUTH_SHAPES: readonly EvidenceShape[] = ["review:ally-clean", "deploy:landed"];
```

- [ ] **Step 4: Initialise the new keys in `detectAll`**

Inside the `detections` literal in `detectAll`, after `"migration-output": detectMigrationOutput(text),` add:

```ts
    // Truth shapes are never detected from comment text. They arrive via
    // externalDetections in evaluateEvidence; here they start false so the
    // Record<EvidenceShape, boolean> stays total.
    "review:ally-clean": false,
    "deploy:landed": false,
```

- [ ] **Step 5: Merge external detections and apply the flag in `evaluateEvidence`**

Directly after the line `const { detections, found } = detectAll({ ... });` insert:

```ts
  for (const [shape, hit] of Object.entries(input.externalDetections ?? {})) {
    if (hit === true && shape in detections) detections[shape as EvidenceShape] = true;
  }
  const foundAll = ALL_SHAPES.filter((s) => detections[s]);
```

Then replace every later use of `found` in the function (the `allDetected` field and any derivation from it) with `foundAll`.

Directly after the `let verdict: EvidenceVerdict; if (...) {...} else {...}` block, and before `return {`, insert:

```ts
  if (
    verdict === "warn" &&
    input.unlabeledTruthBlock === true &&
    missing.length > 0 &&
    missing.every((s) => TRUTH_SHAPES.includes(s))
  ) {
    verdict = "block";
    diagnostics.push("unlabeled-truth-block");
  }
```

- [ ] **Step 6: Run the tests and typecheck**

Run: `pnpm exec vitest run server/src/services/evidence-gate.test.ts && pnpm run typecheck`
Expected: all cases PASS; typecheck clean.

- [ ] **Step 7: Mutation check, then commit**

Comment out the `for (const [shape, hit] ...)` loop, run the test file, confirm "both truth shapes supplied externally → pass" FAILS, restore.

```bash
git add server/src/services/evidence-gate.ts server/src/services/evidence-gate.test.ts
git commit -m "feat(evidence): accept external truth detections and a flag-gated unlabeled block"
```

### Task B4: GitHub truth probe

**Files:**
- Create: `server/src/services/evidence-truth.ts`
- Test: `server/src/services/evidence-truth.test.ts`

**Interfaces:**
- Consumes: `isAllyLogin`, `isAllyCleanAtHead` from B1; `EvidenceShape` from B2.
- Produces: `type TruthProbe = (input: TruthProbeInput) => Promise<TruthProbeResult>`; `interface TruthProbeInput { workProducts: Array<{ type: string; metadata: Record<string, unknown> | null }>; commentText: string }`; `interface TruthProbeResult { detections: Partial<Record<EvidenceShape, boolean>>; diagnostics: string[] }`; `interface PrRef { repoFullName: string; prNumber: number }`; `extractPrRefs(text: string): PrRef[]`; `prRefsFromWorkProducts(workProducts): PrRef[]`; `interface GithubTruthDeps { fetchHeadSha; listReviews; listComments; getPullRequestGate }`; `buildGithubTruthProbe(deps: GithubTruthDeps): TruthProbe`.

- [ ] **Step 1: Write the failing test**

```ts
// server/src/services/evidence-truth.test.ts
import { describe, expect, it } from "vitest";
import {
  buildGithubTruthProbe,
  extractPrRefs,
  prRefsFromWorkProducts,
  type GithubTruthDeps,
} from "./evidence-truth.js";

const HEAD = "c".repeat(40);
const CLEAN = `## Ally — Consolidated PR Review
**Reviewed head:** \`${HEAD}\`
### Critical Issues (0)
### Important Issues (0)
### Suggestions (0)
### Recommended Action
Land.`;
const DIRTY = CLEAN.replace("Important Issues (0)", "Important Issues (1)");
const WP = [{ type: "pull_request", metadata: { repoFullName: "Blockcast/paperclip", prNumber: 1588, headSha: HEAD } }];

function deps(over: Partial<GithubTruthDeps> = {}): GithubTruthDeps {
  return {
    fetchHeadSha: async () => HEAD,
    listReviews: async () => [{ login: "allyblockcast[bot]", body: CLEAN }],
    listComments: async () => [],
    getPullRequestGate: async () => ({ state: "closed", merged: true }),
    ...over,
  };
}

describe("extractPrRefs / prRefsFromWorkProducts", () => {
  it("parses and dedupes PR URLs from text", () => {
    expect(extractPrRefs("see https://github.com/Blockcast/paperclip/pull/1588 and https://github.com/Blockcast/paperclip/pull/1588/files"))
      .toEqual([{ repoFullName: "Blockcast/paperclip", prNumber: 1588 }]);
  });
  it("prefers pull_request work products with numeric prNumber", () => {
    expect(prRefsFromWorkProducts(WP)).toEqual([{ repoFullName: "Blockcast/paperclip", prNumber: 1588 }]);
    expect(prRefsFromWorkProducts([{ type: "deployment", metadata: { prNumber: 1 } }])).toEqual([]);
  });
});

describe("buildGithubTruthProbe", () => {
  it("merged + clean Ally review at head → both shapes detected", async () => {
    const r = await buildGithubTruthProbe(deps())({ workProducts: WP, commentText: "" });
    expect(r.detections).toEqual({ "review:ally-clean": true, "deploy:landed": true });
    expect(r.diagnostics).toEqual([]);
  });
  it("open PR → deploy:landed absent", async () => {
    const r = await buildGithubTruthProbe(deps({ getPullRequestGate: async () => ({ state: "open", merged: false }) }))({ workProducts: WP, commentText: "" });
    expect(r.detections["deploy:landed"]).toBeUndefined();
    expect(r.detections["review:ally-clean"]).toBe(true);
  });
  it("review attested at a stale head → review:ally-clean absent", async () => {
    const r = await buildGithubTruthProbe(deps({ fetchHeadSha: async () => "d".repeat(40) }))({ workProducts: WP, commentText: "" });
    expect(r.detections["review:ally-clean"]).toBeUndefined();
  });
  it("Important finding → review:ally-clean absent; a clean comment-form review counts", async () => {
    const dirty = await buildGithubTruthProbe(deps({ listReviews: async () => [{ login: "allyblockcast[bot]", body: DIRTY }] }))({ workProducts: WP, commentText: "" });
    expect(dirty.detections["review:ally-clean"]).toBeUndefined();
    const viaComment = await buildGithubTruthProbe(deps({ listReviews: async () => [], listComments: async () => [{ login: "allyblockcast", body: CLEAN }] }))({ workProducts: WP, commentText: "" });
    expect(viaComment.detections["review:ally-clean"]).toBe(true);
  });
  it("a non-Ally login never counts", async () => {
    const r = await buildGithubTruthProbe(deps({ listReviews: async () => [{ login: "kkroo", body: CLEAN }] }))({ workProducts: WP, commentText: "" });
    expect(r.detections["review:ally-clean"]).toBeUndefined();
  });
  it("falls back to PR URLs in comment text when no work product exists", async () => {
    const r = await buildGithubTruthProbe(deps())({ workProducts: [], commentText: "landed https://github.com/Blockcast/paperclip/pull/1588" });
    expect(r.detections["deploy:landed"]).toBe(true);
  });
  it("no PR anywhere → no detections and a diagnostic", async () => {
    const r = await buildGithubTruthProbe(deps())({ workProducts: [], commentText: "done" });
    expect(r.detections).toEqual({});
    expect(r.diagnostics).toEqual(["no-pull-request-work-product"]);
  });
  it("probe failures fail closed with a diagnostic naming the call", async () => {
    const r = await buildGithubTruthProbe(deps({ getPullRequestGate: async () => ({ error: "pull_request_fetch_failed" }), listReviews: async () => null }))({ workProducts: WP, commentText: "" });
    expect(r.detections["deploy:landed"]).toBeUndefined();
    expect(r.diagnostics).toEqual(expect.arrayContaining([
      "github-truth-probe-failed:pull_request:Blockcast/paperclip#1588:pull_request_fetch_failed",
      "github-truth-probe-failed:reviews:Blockcast/paperclip#1588",
    ]));
  });
  it("two PRs: every one must be merged and every one Ally-clean", async () => {
    const two = [...WP, { type: "pull_request", metadata: { repoFullName: "Blockcast/paperclip", prNumber: 1585 } }];
    const r = await buildGithubTruthProbe(deps({
      getPullRequestGate: async (ref) => ({ state: ref.prNumber === 1588 ? "closed" : "open", merged: ref.prNumber === 1588 }),
    }))({ workProducts: two, commentText: "" });
    expect(r.detections["deploy:landed"]).toBeUndefined();
    expect(r.detections["review:ally-clean"]).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run server/src/services/evidence-truth.test.ts`
Expected: FAIL with `Failed to load url ./evidence-truth.js`.

- [ ] **Step 3: Write the module**

```ts
// server/src/services/evidence-truth.ts
/**
 * GitHub truth probe for the evidence gate.
 *
 * The gate's text detectors only prove an agent TYPED a PR link. This probe
 * asks GitHub whether the PR is merged and whether Ally's canonical review at
 * the PR's CURRENT head is clean. All GitHub calls are injected so the module
 * is testable without network and the gate stays pure.
 *
 * Fail closed: any failed call leaves its shape undetected and records a
 * diagnostic. Never invent a detection on error.
 */
import type { EvidenceShape } from "./evidence-shapes.js";
import { isAllyCleanAtHead, isAllyLogin } from "./ally-review-verdict.js";

export interface TruthWorkProduct {
  type: string;
  metadata: Record<string, unknown> | null;
}

export interface TruthProbeInput {
  workProducts: TruthWorkProduct[];
  commentText: string;
}

export interface TruthProbeResult {
  detections: Partial<Record<EvidenceShape, boolean>>;
  diagnostics: string[];
}

export type TruthProbe = (input: TruthProbeInput) => Promise<TruthProbeResult>;

export interface PrRef {
  repoFullName: string;
  prNumber: number;
}

const PR_URL_RE = /https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)\b/gi;

export function extractPrRefs(text: string): PrRef[] {
  const seen = new Set<string>();
  const out: PrRef[] = [];
  for (const m of text.matchAll(PR_URL_RE)) {
    const ref: PrRef = { repoFullName: m[1]!, prNumber: Number(m[2]) };
    const key = `${ref.repoFullName.toLowerCase()}#${ref.prNumber}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

export function prRefsFromWorkProducts(workProducts: TruthWorkProduct[]): PrRef[] {
  const seen = new Set<string>();
  const out: PrRef[] = [];
  for (const wp of workProducts) {
    if (wp.type !== "pull_request" || !wp.metadata) continue;
    const repo = wp.metadata["repoFullName"];
    const n = wp.metadata["prNumber"];
    if (typeof repo !== "string" || typeof n !== "number" || !Number.isInteger(n)) continue;
    const key = `${repo.toLowerCase()}#${n}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ repoFullName: repo, prNumber: n });
  }
  return out;
}

export interface GithubTruthDeps {
  fetchHeadSha: (ref: PrRef) => Promise<string | null>;
  listReviews: (ref: PrRef) => Promise<Array<{ login: string | null; body: string }> | null>;
  listComments: (ref: PrRef) => Promise<Array<{ login: string | null; body: string }> | null>;
  getPullRequestGate: (
    ref: PrRef,
  ) => Promise<{ state: "open" | "closed"; merged: boolean } | { error: string }>;
}

export function buildGithubTruthProbe(deps: GithubTruthDeps): TruthProbe {
  return async ({ workProducts, commentText }) => {
    const diagnostics: string[] = [];
    let refs = prRefsFromWorkProducts(workProducts);
    if (refs.length === 0) refs = extractPrRefs(commentText);
    if (refs.length === 0) return { detections: {}, diagnostics: ["no-pull-request-work-product"] };

    let allMerged = true;
    let allClean = true;
    for (const ref of refs) {
      const tag = `${ref.repoFullName}#${ref.prNumber}`;

      const gate = await deps.getPullRequestGate(ref);
      if ("error" in gate) {
        diagnostics.push(`github-truth-probe-failed:pull_request:${tag}:${gate.error}`);
        allMerged = false;
      } else if (!gate.merged) {
        allMerged = false;
      }

      const head = await deps.fetchHeadSha(ref);
      if (!head) {
        diagnostics.push(`github-truth-probe-failed:head_sha:${tag}`);
        allClean = false;
        continue;
      }
      const [reviews, comments] = await Promise.all([deps.listReviews(ref), deps.listComments(ref)]);
      if (reviews === null) diagnostics.push(`github-truth-probe-failed:reviews:${tag}`);
      if (comments === null) diagnostics.push(`github-truth-probe-failed:comments:${tag}`);
      const bodies = [...(reviews ?? []), ...(comments ?? [])];
      const clean = bodies.some((b) => isAllyLogin(b.login) && isAllyCleanAtHead(b.body, head));
      if (!clean) allClean = false;
    }

    const detections: Partial<Record<EvidenceShape, boolean>> = {};
    if (allMerged) detections["deploy:landed"] = true;
    if (allClean) detections["review:ally-clean"] = true;
    return { detections, diagnostics };
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run server/src/services/evidence-truth.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Mutation check, then commit**

Change `if (allMerged)` to `if (true)`; confirm "open PR → deploy:landed absent" FAILS; restore.

```bash
git add server/src/services/evidence-truth.ts server/src/services/evidence-truth.test.ts
git commit -m "feat(evidence): GitHub truth probe for review:ally-clean and deploy:landed"
```

### Task B5: Thread the probe through the wiring

**Files:**
- Modify: `server/src/services/evidence-gate-wiring.ts:1-10` (imports), `:90-130` (`runEvidenceGate`)
- Test: `server/src/__tests__/evidence-gate-wiring.test.ts` (exists; append)

**Interfaces:**
- Consumes: `TruthProbe` from B4; `externalDetections`, `unlabeledTruthBlock` from B3.
- Produces: `runEvidenceGate(fetch, issueId, now?, truth?: TruthProbe, options?: { unlabeledTruthBlock?: boolean })`. `EvidenceVerdictRecord.diagnostics` now also carries the probe's diagnostics.

- [ ] **Step 1: Write the failing test**

Append to `server/src/__tests__/evidence-gate-wiring.test.ts` (use the file's existing fetch-stub helper for `FetchEvidenceForGate`; if none exists, build an inline `async () => ({ description, labels: [], comments, workProducts: [] })`):

```ts
it("runEvidenceGate merges truth-probe detections and diagnostics", async () => {
  const fetch = async () => ({
    description: "Do it.
## Done when
- a
",
    labels: [],
    comments: [{ body: "| Criterion | Status | Evidence |
|---|---|---|
| a | ✅ | x |
https://github.com/Blockcast/paperclip/pull/1588", authorAgentId: "agent-1", authorUserId: null, createdAt: new Date("2026-09-05T00:00:00Z") }],
    workProducts: [],
  });
  const truth = async () => ({ detections: { "review:ally-clean": true, "deploy:landed": true }, diagnostics: ["probe-ran"] });
  const record = await runEvidenceGate(fetch, "issue-1", new Date("2026-09-05T00:01:00Z"), truth);
  expect(record.verdict).toBe("pass");
  expect(record.diagnostics).toContain("probe-ran");
});

it("runEvidenceGate without a probe leaves truth shapes missing (warn)", async () => {
  const fetch = async () => ({
    description: "Do it.
## Done when
- a
",
    labels: [],
    comments: [{ body: "| Criterion | Status | Evidence |
|---|---|---|
| a | ✅ | x |", authorAgentId: "agent-1", authorUserId: null, createdAt: new Date("2026-09-05T00:00:00Z") }],
    workProducts: [],
  });
  const record = await runEvidenceGate(fetch, "issue-1", new Date("2026-09-05T00:01:00Z"));
  expect(record.verdict).toBe("warn");
  expect(record.missing).toEqual(expect.arrayContaining(["review:ally-clean", "deploy:landed"]));
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run server/src/__tests__/evidence-gate-wiring.test.ts`
Expected: first new case FAILS (`runEvidenceGate` ignores the 4th argument; verdict is `warn`).

- [ ] **Step 3: Implement**

Add imports at the top of `evidence-gate-wiring.ts`:

```ts
import type { EvidenceShape } from "./evidence-shapes.js";
import type { TruthProbe } from "./evidence-truth.js";
```

Change the signature:

```ts
export async function runEvidenceGate(
  fetch: FetchEvidenceForGate,
  issueId: string,
  now: Date = new Date(),
  truth?: TruthProbe,
  options?: { unlabeledTruthBlock?: boolean },
): Promise<EvidenceVerdictRecord> {
```

After the operator-override early return and before `const evaluation = evaluateEvidence({`, insert:

```ts
  let externalDetections: Partial<Record<EvidenceShape, boolean>> | undefined;
  const truthDiagnostics: string[] = [];
  if (truth) {
    const commentText = data.comments
      .filter((c) => c.authorAgentId !== null)
      .map((c) => c.body)
      .join("

");
    const probed = await truth({
      workProducts: data.workProducts.map((wp) => ({ type: wp.type, metadata: wp.metadata })),
      commentText,
    });
    externalDetections = probed.detections;
    truthDiagnostics.push(...probed.diagnostics);
  }
```

Add to the `evaluateEvidence({ ... })` call: `externalDetections,` and `unlabeledTruthBlock: options?.unlabeledTruthBlock,`.

In the returned record change `diagnostics: evaluation.diagnostics,` to `diagnostics: [...evaluation.diagnostics, ...truthDiagnostics],`.

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm exec vitest run server/src/__tests__/evidence-gate-wiring.test.ts && pnpm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/evidence-gate-wiring.ts server/src/__tests__/evidence-gate-wiring.test.ts
git commit -m "feat(evidence): run the GitHub truth probe inside runEvidenceGate"
```

### Task B6: Wire the real probe at the two call sites

**Files:**
- Modify: `server/src/services/issues.ts:2176` (`DURABLE_LANDING_SHAPES`), `:10487` and `:10632` (`runEvidenceGate` calls), plus module imports
- Read only: `server/src/services/github-app-auth.ts:624`

**Interfaces:**
- Consumes: `buildGithubTruthProbe` from B4; `githubFetchPrHeadSha` (:411), `githubListPrReviewsWithTimestamps` (:692), `githubListIssueCommentsWithTimestamps` (:624), `githubGetPullRequestGate` (:241) from `github-app-auth.ts`.
- Produces: a module-level `githubTruthProbe: TruthProbe` in `issues.ts`; `DURABLE_LANDING_SHAPES` includes `"deploy:landed"`.

- [ ] **Step 1: Verify the comments helper returns a login (unverified in the facts)**

Run: `git show origin/master:server/src/services/github-app-auth.ts | sed -n '624,660p' | grep -n 'login'`
Expected: at least one line mapping `user?.login` into the returned objects. If the output is EMPTY, the helper returns bodies without logins; in that case extend it in place so each element is `{ login: string | null; body: string; createdAt: string }` by mapping `c.user?.login ?? null` exactly as `githubListPrReviewsWithTimestamps` does at :692-712, and add a unit case to its existing test. Do not add a second comments fetcher.

- [ ] **Step 2: Add imports and build the probe once**

Near the other service imports in `issues.ts`:

```ts
import { buildGithubTruthProbe, type TruthProbe } from "./evidence-truth.js";
import {
  githubFetchPrHeadSha,
  githubGetPullRequestGate,
  githubListIssueCommentsWithTimestamps,
  githubListPrReviewsWithTimestamps,
} from "./github-app-auth.js";
```

Next to `DURABLE_LANDING_SHAPES` (line 2176):

```ts
// "deploy:landed" is durable: a merge cannot be undone by a later push.
// "review:ally-clean" is NOT durable: the head can move after the review, so
// it must be re-probed on every evaluation and is deliberately absent here.
const DURABLE_LANDING_SHAPES = ["pr-link", "landing-artifact", "deploy:landed"] as const;

const githubTruthProbe: TruthProbe = buildGithubTruthProbe({
  fetchHeadSha: (ref) => githubFetchPrHeadSha(ref),
  listReviews: (ref) => githubListPrReviewsWithTimestamps(ref),
  listComments: (ref) => githubListIssueCommentsWithTimestamps(ref),
  getPullRequestGate: (ref) => githubGetPullRequestGate(ref),
});
const EVIDENCE_UNLABELED_TRUTH_BLOCK = process.env.PAPERCLIP_EVIDENCE_UNLABELED_BLOCK === "1";
```

- [ ] **Step 3: Pass the probe at both call sites**

At :10632 change

```ts
          const verdict = await runEvidenceGate(
            (issueId, now) => fetchEvidenceForIssue(/* unchanged args */),
            id,
          );
```

to

```ts
          const verdict = await runEvidenceGate(
            (issueId, now) => fetchEvidenceForIssue(/* unchanged args */),
            id,
            new Date(),
            githubTruthProbe,
            { unlabeledTruthBlock: EVIDENCE_UNLABELED_TRUTH_BLOCK },
          );
```

Make the identical change at the :10487 done-transition call.

- [ ] **Step 4: Typecheck and run the stable suite**

Run: `pnpm run typecheck && pnpm run test:run`
Expected: typecheck clean; suite green. If `test:run` shards time out locally, run `pnpm exec vitest run server/src/services/evidence-gate.test.ts server/src/services/evidence-truth.test.ts server/src/services/ally-review-verdict.test.ts server/src/__tests__/evidence-gate-wiring.test.ts server/src/__tests__/done-gate.test.ts server/src/__tests__/issues-patch-evidence.test.ts` and paste that instead, saying so in the PR.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/issues.ts
git commit -m "feat(evidence): probe GitHub truth at both evidence-gate call sites; deploy:landed is durable"
```

### Task B7: Flag plumbing and the rollout runbook

**Files:**
- Modify: `deploy/helm/paperclip/values.yaml`, `deploy/helm/paperclip/values.blockcast.yaml`, `deploy/helm/paperclip/templates/deployment-api.yaml`, `deploy/helm/paperclip/templates/statefulset.yaml`
- Create: `docs/runbooks/evidence-gate-unlabeled-block.md`

**Interfaces:**
- Consumes: `PAPERCLIP_EVIDENCE_UNLABELED_BLOCK` read in B6.
- Produces: helm value `evidenceGate.unlabeledTruthBlock` (string `"0"`/`"1"`), rendered as that env var on both workloads.

- [ ] **Step 1: Add the value**

In `values.yaml` and `values.blockcast.yaml`:

```yaml
evidenceGate:
  # "1" makes an UNLABELED issue whose only missing evidence is
  # review:ally-clean / deploy:landed get `block` instead of `warn` on the
  # in_review transition. Keep "0" until the runbook's 7-day measurement passes.
  unlabeledTruthBlock: "0"
```

- [ ] **Step 2: Render the env on both workloads**

In the container `env:` list of `templates/deployment-api.yaml` and `templates/statefulset.yaml`:

```yaml
            - name: PAPERCLIP_EVIDENCE_UNLABELED_BLOCK
              value: {{ .Values.evidenceGate.unlabeledTruthBlock | default "0" | quote }}
```

Run: `helm template paperclip deploy/helm/paperclip -f deploy/helm/paperclip/values.blockcast.yaml | grep -c 'PAPERCLIP_EVIDENCE_UNLABELED_BLOCK'`
Expected: `2`.

- [ ] **Step 3: Write the runbook**

```markdown
# Evidence gate: turning on the unlabeled truth block

Why a flag: on 2026-09-04, 281 `in_review` issues carried verdict `warn` with
`unlabeledFallback: true`. Flipping unlabeled `warn` to `block` in one step would
422 every re-PATCH on those issues the moment the daily deploy landed.

## Measure for seven days after the truth shapes deploy

Daily, from a board credential:

    curl -sS -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
      "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/issues?status=in_review&limit=500" \
    | jq '[.[] | select(.lastEvidenceVerdict != null)]
           | { total: length,
               pass: map(select(.lastEvidenceVerdict.verdict=="pass")) | length,
               onlyTruthMissing: map(select(
                 (.lastEvidenceVerdict.missing | length) > 0 and
                 ((.lastEvidenceVerdict.missing - ["review:ally-clean","deploy:landed"]) | length) == 0)) | length }'

Record the three numbers in BLO-3202 each day.

## Flip criterion

Turn the flag on when, for seven consecutive days, `onlyTruthMissing` is below
10% of `total` and the landing routine (Track C1) has merged every candidate it
selected. Also required first: BLO-24843 is resolved or the unlabeled truth block
excludes issues with origin `harness_liveness_escalation`, because those issues have no PR by
design and the block would make them uncloseable. Set `evidenceGate.unlabeledTruthBlock: "1"` in
`deploy/helm/paperclip/values.blockcast.yaml`, open a PR titled
`feat(evidence): enforce truth shapes for unlabeled issues`, and paste the seven
daily rows in the body.

## Rollback

Set the value back to `"0"` and redeploy. No data migration is involved; the
flag only changes the verdict computed at the next transition.
```

- [ ] **Step 4: Commit**

```bash
git add deploy/helm/paperclip docs/runbooks/evidence-gate-unlabeled-block.md
git commit -m "feat(evidence): flag-gate the unlabeled truth block with a measured rollout"
```

### Task B8: Update the evidence skill

**Files:**
- Modify: `skills/paperclip-evidence-before-in-review/SKILL.md` ("### 2. Look up required shapes" table; "### 3. Produce each required shape")

**Interfaces:**
- Consumes: shape names from B2.
- Produces: documentation only. CODEOWNED by @kkroo.

- [ ] **Step 1: Update the table**

Replace the rows so each code-completion label lists the truth shapes, and the unlabeled row reads:

```markdown
| (no label or unrecognized) | `checklist:done-when` + `review:ally-clean` + `deploy:landed` (verdict is `warn`, not `block`, until the unlabeled truth block flag is on) |
```

Add both shapes to the `frontend`/`ui`/`cms-published`, `backend`, and `db-migration`/`migration` rows.

- [ ] **Step 2: Add the two shape subsections**

```markdown
#### `review:ally-clean`

You cannot produce this shape by typing. Paperclip asks GitHub: does a review or
PR comment authored by `allyblockcast[bot]` or `allyblockcast` exist whose body
has exactly one `## Ally — Consolidated PR Review` heading, exactly one
`Reviewed head: <40-hex>` line equal to the PR's CURRENT head, no
`### Critical Issues (N)` or `### Important Issues (N)` with N > 0, and no
`- **prior:...** — still-present —` disposition?

Two ways this fails after you think you are done:

- You pushed after Ally reviewed. The attested head is stale. Request review
  again with a comment whose first byte is `<!-- paperclip:review-request -->`.
- Ally left one Important finding. Address it, push, and request review again.
  The shape clears only when the latest canonical review at the new head is clean.

#### `deploy:landed`

Also computed from GitHub: the PR is merged into the default branch. An open PR,
a draft, or a closed-unmerged PR does not satisfy it. If the PR is Ally-clean and
CI-green but nobody merged it, the landing routine will merge it on its next
fire; do not move the issue to `in_review` before that.

The name is deliberate. "Landed" means merged, not running in production. For
running-in-production proof use the `infra` shapes `kubectl-state` and `url-probe`.
```

- [ ] **Step 3: Commit**

```bash
git add skills/paperclip-evidence-before-in-review/SKILL.md
git commit -m "docs(skills): document review:ally-clean and deploy:landed"
```

### Task B9: Open the PR with evidence

**Files:**
- None new. PR against `master` of Blockcast/paperclip.

- [ ] **Step 1: Local repro against a real merged PR**

```bash
pnpm install && pnpm run db:migrate
# copy the GitHub App env the server reads. Find the names:
git grep -n 'process.env.GITHUB_' server/src/services/github-app-auth.ts | cut -d: -f3 | sort -u
# set those from the production Deployment (kubectl -n paperclip get deploy paperclip-api -o yaml | grep -A1 GITHUB_)
pnpm dev
```

In a second shell, with a board token for the dev instance:

```bash
ISSUE=$(curl -sS -X POST "$DEV_URL/api/companies/$CID/issues" -H "Authorization: Bearer $DEV_TOKEN" -H 'Content-Type: application/json' \
  -d '{"title":"evidence truth probe repro","description":"Repro.
## Done when
- probe runs
","status":"in_progress"}' | jq -r .id)
# agent-authored comment with a REAL merged Blockcast PR that Ally reviewed clean:
curl -sS -X POST "$DEV_URL/api/issues/$ISSUE/comments" -H "Authorization: Bearer $DEV_AGENT_TOKEN" -H 'Content-Type: application/json' \
  -d '{"body":"| Criterion | Status | Evidence |
|---|---|---|
| probe runs | ✅ | https://github.com/Blockcast/paperclip/pull/1633 |

https://github.com/Blockcast/paperclip/pull/1633"}'
# BEFORE (main without this branch): checkout master, PATCH in_review, save verdict
curl -sS -X PATCH "$DEV_URL/api/issues/$ISSUE" -H "Authorization: Bearer $DEV_AGENT_TOKEN" -H 'Content-Type: application/json' -d '{"status":"in_review"}' | jq .lastEvidenceVerdict > /tmp/verdict-before.json
# AFTER (this branch): restart dev, PATCH in_review -> in_review to re-evaluate
curl -sS -X PATCH "$DEV_URL/api/issues/$ISSUE" -H "Authorization: Bearer $DEV_AGENT_TOKEN" -H 'Content-Type: application/json' -d '{"status":"in_review"}' | jq .lastEvidenceVerdict > /tmp/verdict-after.json
diff <(jq -S . /tmp/verdict-before.json) <(jq -S . /tmp/verdict-after.json)
```

Expected: `after` has `"review:ally-clean"` and `"deploy:landed"` in `allDetected`, `verdict: "pass"`, and no `github-truth-probe-failed` diagnostic. `before` has neither shape and `verdict: "warn"`.

- [ ] **Step 2: UI evidence, if the verdict renders**

Run: `git grep -ln 'lastEvidenceVerdict' origin/master -- ui/src | head -3`
Expected: if any file prints, open the repro issue in the dev UI at viewport 1440x900 and screenshot the verdict panel before and after. If nothing prints, state "no UI surface renders lastEvidenceVerdict" in the PR body and skip the screenshot.

- [ ] **Step 3: Open the PR**

```bash
git push -u origin HEAD
gh pr create -R Blockcast/paperclip --title "feat(evidence): truth-checked review:ally-clean and deploy:landed shapes" --body-file /tmp/pr-body.md
```

`/tmp/pr-body.md` must contain: the Thinking Path bullets in the repo's house style; the two verdict JSONs and the `diff`; the pasted output of the four vitest files and `pnpm run typecheck`; the `helm template | grep -c` line reading `2`; the screenshot(s) or the "no UI surface" statement; a "Not in this PR" line for the unlabeled block flip pointing at `docs/runbooks/evidence-gate-unlabeled-block.md`; and `@kkroo` requested for `skills/**`.

Run: `gh pr edit <n> -R Blockcast/paperclip --add-reviewer kkroo`
Expected: `kkroo` appears under reviewRequests.

- [ ] **Step 4: Request Ally review and land**

Post a PR comment whose first byte is `<!-- paperclip:review-request -->` followed by `@ally` and the focus: "evidence gate truth shapes; check fail-closed paths in evidence-truth.ts and the durable-shape change in issues.ts". When Ally's canonical review is clean at the current head and `verify` is green: `gh pr merge <n> -R Blockcast/paperclip --squash --auto`.

- [ ] **Step 5: Deploy and verify in production, read-only**

```bash
gh workflow run scheduled-production-deploy.yml -R Blockcast/paperclip
# after the run completes:
curl -sS -H "Authorization: Bearer $PAPERCLIP_API_KEY" "$PAPERCLIP_API_URL/api/issues/BLO-31648" | jq '.lastEvidenceVerdict | {verdict, missing, allDetected, diagnostics}'
```

Expected: `missing` or `allDetected` mentions `review:ally-clean`/`deploy:landed` (proving the new shapes are evaluated in production), and no `github-truth-probe-failed` diagnostic. Paste the output into the PR as a final comment.


## Track C: Routines that land and that count

**Why this track** The gate in Track B says whether an issue may claim done. Nothing today moves a clean PR from "reviewed" to "merged" unless a human does it, and nothing counts how long human-owned issues have sat. Three changes close that: a new routine lands Ally-authored PRs that are already clean and green; one rule added to the existing `Agent health & stalled-issue check` (`a03b2236-a1f8-4014-806f-aeccf2374da8`) counts aged human gates instead of silently parking them; and the paused `Weekly governance sweep — AC/verifying-signal + human-gated ageing` (`8b764d66`) is un-paused. Everything here is report-first: the landing routine writes a receipt for every fire, the new rule emits rows and takes no action, and the sweep stays report-only by CEO ruling BLO-19484. Never add a cancel step to either routine.

All calls use the board credential from the environment. Do not paste the token anywhere.

```bash
export PAPERCLIP_API_URL PAPERCLIP_API_KEY PAPERCLIP_COMPANY_ID
H=(-H "Authorization: Bearer $PAPERCLIP_API_KEY" -H 'Content-Type: application/json')
```

### Task C1: The landing routine

**Files:**
- Create: `/tmp/landing-routine-description.md` (scratch, becomes the routine `description`)
- Read only: `packages/shared/src/validators/routine.ts:62-160`, `server/src/routes/routines.ts:157,464`

**Interfaces:**
- Consumes: `createRoutineSchema` fields `title`, `description`, `assigneeAgentId`, `priority`, `concurrencyPolicy`; `createRoutineTriggerSchema` `{kind:"schedule", cronExpression, timezone}`.
- Produces: a routine titled `Land clean-reviewed PRs` assigned to Ally (`e0a5011d-5c94-4801-be52-64c14f98ac26`), one schedule trigger, and an audit issue whose id is embedded in the routine text. Track A's landing log records the routine id.

- [ ] **Step 1: Confirm the enum values before sending them**

Run:

```bash
git show origin/master:packages/shared/src/validators/routine.ts | sed -n '1,60p' | grep -nE 'concurrencyPolicy|catchUpPolicy|priority|status' 
```

Expected: the enum literals for `concurrencyPolicy` include `skip_if_active`, `priority` includes `high`, and `status` includes `active` and `paused`. If any literal differs, use the file's literal in Steps 3 to 5 and note the substitution in the landing log.

- [ ] **Step 2: Create the audit issue the routine writes receipts to**

```bash
AUDIT_ID=$(curl -sS -X POST "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/issues" "${H[@]}" -d @- <<'JSON' | jq -r .id
{
  "title": "Landing routine audit log (do not close)",
  "description": "Every fire of the routine `Land clean-reviewed PRs` appends one comment here: PRs considered, merged, updated, skipped, with the reason for each. Read newest-first. Ruling: the routine merges only Ally-authored PRs that are already CI-green and carry a clean canonical Ally review at the current head. It never merges a human-authored PR and never bypasses CODEOWNERS.",
  "status": "in_progress",
  "priority": "low"
}
JSON
)
echo "$AUDIT_ID"
```

Expected: a UUID. Then assign it to Ally so the in_review disposition validator has a resolvable owner and keep it out of the human queue:

```bash
curl -sS -X PATCH "$PAPERCLIP_API_URL/api/issues/$AUDIT_ID" "${H[@]}" -d '{"assigneeAgentId":"e0a5011d-5c94-4801-be52-64c14f98ac26"}' | jq '{id, identifier, assigneeAgentId}'
```

- [ ] **Step 3: Write the routine description**

This text is what Ally executes on every fire. Substitute `$AUDIT_ID` before creating the routine.

```bash
cat > /tmp/landing-routine-description.md <<EOF
# Land clean-reviewed PRs

You are Ally. Merge pull requests that are already finished. Do not review, do not fix, do not merge anything that is not finished by the exact test below.

## Repos

- Blockcast/paperclip

Adding a repo is a PATCH to this description, not a judgment call at run time.

## Candidate test (ALL must hold)

For each open, non-draft PR in each repo, run:

    gh pr view <n> -R <repo> --json number,author,isDraft,labels,mergeStateStatus,headRefOid,statusCheckRollup,reviews,comments,files,url

1. author.login is exactly "allyblockcast[bot]" or "allyblockcast". Any other author: skip, reason "human-authored".
2. No label named "do-not-merge" or "review-gate-override". Otherwise skip, reason "label".
3. Every entry in statusCheckRollup has conclusion "SUCCESS" or "NEUTRAL" or "SKIPPED". Any "PENDING", "IN_PROGRESS", "FAILURE", "CANCELLED", "TIMED_OUT", or "ACTION_REQUIRED": skip, reason "checks:<state>".
4. A canonical Ally review exists at the CURRENT head. Search reviews and comments for a body that contains exactly one line "## Ally — Consolidated PR Review" and exactly one line matching "Reviewed head: <40-hex>" where the hex equals headRefOid. That body must have no "### Critical Issues (N)" or "### Important Issues (N)" with N above 0, and no line matching "- **prior:...** — still-present —". Otherwise skip, reason "review:<stale-head|blocking|missing>".
5. mergeStateStatus is "CLEAN" or "BEHIND". "BLOCKED": go to the CODEOWNERS step. "DIRTY", "UNSTABLE", "UNKNOWN": skip, reason "merge-state:<value>".

## Actions

- CLEAN and all five hold: \`gh pr merge <n> -R <repo> --squash --delete-branch\`. Record "merged".
- BEHIND and all other four hold: \`gh pr update-branch <n> -R <repo>\`. Do NOT merge on this fire; checks must re-run on the updated head. Record "updated-branch".
- BLOCKED and the other four hold: read .github/CODEOWNERS at the repo default branch. If any changed file matches an owned pattern, post ONE comment whose first line is exactly "<!-- landing-routine:codeowner-request -->" naming the owner and the files, unless a comment with that first line already exists on the PR. Record "codeowner-review-requested". If no owned path matches, record "blocked:unknown" and do nothing.

## Hard limits

- Merge at most 10 PRs per fire. After the tenth, record the rest as "deferred:cap".
- Never run \`gh pr merge --admin\`. Never edit branch protection. Never force-push.
- Never merge a PR whose author is a human. Never merge a PR with an open review request from a human that has not been dismissed by that human.
- If \`gh\` returns an authentication or rate-limit error, stop the fire and record "aborted:<error>". Do not retry inside the same fire.

## Receipt (always, even with zero candidates)

Post one comment on Paperclip issue $AUDIT_ID whose first line is exactly "<!-- landing-routine-receipt -->", then a table:

    | Repo | PR | Head | Action | Reason |
    |---|---|---|---|---|

One row per PR considered. If no PR was considered, one row: "| — | — | — | none | no open PRs |". Never skip the receipt: a fire with no receipt is indistinguishable from a fire that never ran.

Then move nothing else. Do not change the status of $AUDIT_ID.
EOF
```

- [ ] **Step 4: Create the routine**

```bash
ROUTINE_ID=$(jq -n --rawfile desc /tmp/landing-routine-description.md '{
  title: "Land clean-reviewed PRs",
  description: $desc,
  assigneeAgentId: "e0a5011d-5c94-4801-be52-64c14f98ac26",
  priority: "high",
  concurrencyPolicy: "skip_if_active",
  status: "active"
}' | curl -sS -X POST "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/routines" "${H[@]}" -d @- | jq -r .id)
echo "$ROUTINE_ID"
```

Expected: a UUID. If the response is a 400 naming a field, the enum literal from Step 1 differs; fix the literal and resend.

- [ ] **Step 5: Add the schedule trigger**

Every six hours at :45 Pacific, offset from the daily production deploy so a fire never overlaps a fresh rollout.

```bash
curl -sS -X POST "$PAPERCLIP_API_URL/api/routines/$ROUTINE_ID/triggers" "${H[@]}" \
  -d '{"kind":"schedule","cronExpression":"45 */6 * * *","timezone":"America/Los_Angeles"}' | jq '{id, kind, cronExpression, timezone}'
```

Expected: the trigger echoed back with those values.

- [ ] **Step 6: Fire it once by hand and read the receipt**

```bash
curl -sS -X POST "$PAPERCLIP_API_URL/api/agents/e0a5011d-5c94-4801-be52-64c14f98ac26/heartbeat/invoke" "${H[@]}" -d '{}' | jq '{runId: .id, status}'
```

Wait for the run to finish, then:

```bash
curl -sS "$PAPERCLIP_API_URL/api/issues/$AUDIT_ID/comments" "${H[@]}" | jq -r '[.[] | select(.body | startswith("<!-- landing-routine-receipt -->"))] | last | .body'
```

Expected: one receipt table. Every row's Action is one of `merged`, `updated-branch`, `codeowner-review-requested`, `deferred:cap`, `none`, or a `skip`/`blocked`/`aborted` reason. For every `merged` row run `gh pr view <n> -R <repo> --json state,mergedAt` and confirm `MERGED`. If the receipt is missing, the routine text did not reach Ally: `GET /api/routines/$ROUTINE_ID` and diff `.description` against `/tmp/landing-routine-description.md`.

- [ ] **Step 7: Record in the landing log**

Append to `docs/superpowers/plans/2026-09-05-track-a-landing-log.md` (created in Track A):

```markdown
## Track C1: landing routine
- routine id: <ROUTINE_ID>
- trigger: 45 */6 * * * America/Los_Angeles
- audit issue: <AUDIT_ID identifier>
- first receipt: <paste the table>
```

### Task C2: Count aged human gates in the stalled-issue check

**Files:**
- Read only: routine `a03b2236-a1f8-4014-806f-aeccf2374da8` (title `Agent health & stalled-issue check`, fires every 6h, posts to BLO-3202), `server/src/routes/routines.ts:363`, `packages/shared/src/validators/routine.ts` (`updateRoutineSchema`)

**Interfaces:**
- Consumes: `updateRoutineSchema` partial fields `description` and `baseRevisionId`; the routine GET's `latestRevisionId`.
- Produces: §2a of that routine gains rule (a′) `human_gate_aged` directly after rule (a) `human-owned`. Output rows are P3, report-only, fingerprinted by identifier plus age bucket.

- [ ] **Step 1: Fetch the current description and revision**

```bash
STALLED=a03b2236-a1f8-4014-806f-aeccf2374da8
curl -sS "$PAPERCLIP_API_URL/api/routines/$STALLED" "${H[@]}" > /tmp/stalled.json
jq -r .description /tmp/stalled.json > /tmp/stalled-desc.md
jq '{id, title, status, latestRevisionId, latestRevisionNumber}' /tmp/stalled.json
BASE_REV=$(jq -r .latestRevisionId /tmp/stalled.json); echo "$BASE_REV"
```

Expected: title `Agent health & stalled-issue check`, status `active`, and a non-null revision id. If the title differs, stop: the id points at a different routine than this plan verified on 2026-09-05.

- [ ] **Step 2: Confirm the anchor before touching the text**

```bash
grep -n '^### 2a\. Classify each stalled issue' /tmp/stalled-desc.md
grep -n '^  (a) \*\*human-owned\*\*:' /tmp/stalled-desc.md
grep -n '^  (b) ' /tmp/stalled-desc.md
```

Expected: one line each, in increasing order (heading, then (a), then (b)). Rule (a) reads `(a) **human-owned**: assigneeAgentId == null && assigneeUserId != null. No agent can act; a human owns it.` If (a) is not found with that exact prefix, open the file and locate it by eye; do not guess a different rule.

- [ ] **Step 3: Insert rule (a′) between (a) and (b)**

```bash
python3 - <<'PYIN'
import pathlib
p = pathlib.Path("/tmp/stalled-desc.md"); s = p.read_text()
marker = "
  (b) "
assert s.count(marker) == 1, f"(b) marker count {s.count(marker)}"
a_pos = s.index("
  (a) **human-owned**:")
b_pos = s.index(marker)
assert a_pos < b_pos, "(a) must precede (b)"
new_rule = (
  "
  (a′) **human_gate_aged** (report-only; added 2026-09-05): a rule-(a) human-owned issue in status "
  "`in_review` or `blocked` whose `updatedAt` is older than 168h stays parked for stall purposes but ALSO emits one "
  "counted P3 row. Columns: identifier, title, hours idle, age bucket (`>7d` for 168–503h, `>21d` for 504–1079h, "
  "`>45d` for 1080h+), the owning human's name, and a recommended agent: the agent who last commented on the issue, "
  "else the assignee of this routine. Fingerprint = identifier + age bucket, so a row re-emits only when the issue "
  "crosses into the next bucket. Take no action: never reassign, never comment on the issue, never change its status. "
  "The row is the whole output. Rationale: on 2026-09-04, 101 issues had sat over 21 days on one human's queue and "
  "rule (a) hid every one of them."
)
p.write_text(s[:b_pos] + new_rule + s[b_pos:])
print("inserted (a′) before (b)")
PYIN
diff <(jq -r .description /tmp/stalled.json) /tmp/stalled-desc.md
```

Expected: `inserted (a′) before (b)` and a diff showing exactly one added line, immediately after rule (a). Nothing removed.

- [ ] **Step 4: PATCH with the revision guard and verify**

```bash
jq -n --rawfile desc /tmp/stalled-desc.md --arg rev "$BASE_REV" '{description: $desc, baseRevisionId: $rev}' \
  | curl -sS -X PATCH "$PAPERCLIP_API_URL/api/routines/$STALLED" "${H[@]}" -d @- | jq '{id, status, latestRevisionId, latestRevisionNumber}'
curl -sS "$PAPERCLIP_API_URL/api/routines/$STALLED" "${H[@]}" | jq -r .description | grep -c 'human_gate_aged'
```

Expected: `latestRevisionNumber` incremented by one, then `1`. A 409 means the routine changed under you; repeat from Step 1.

- [ ] **Step 5: Read the next fire**

The routine fires every six hours and posts to BLO-3202. After the next fire:

```bash
curl -sS "$PAPERCLIP_API_URL/api/issues/BLO-3202/comments" "${H[@]}" | jq -r '.[-1].body' | grep -n 'human_gate_aged' | head
```

Expected: at least one `human_gate_aged` row. On 2026-09-04, 32 issues stayed on the human queue; most should appear in bucket `>21d`. If the comment has no such rows and no `human-owned` rows either, the routine did not reach §2a on that fire; read its `decision` line before concluding the rule is wrong.

### Task C3: Un-pause the sweep

**Files:**
- Read only: routine `8b764d66-b598-4517-a249-e9a1dee82f06` (`Weekly governance sweep — AC/verifying-signal + human-gated ageing`, assignee `386c81e8-e454-41ba-8e1d-7bb692331185`, paused, trigger `0 9 * * 1` UTC)

**Interfaces:**
- Consumes: `updateRoutineSchema.status`.
- Produces: the governance sweep in status `active`.

- [ ] **Step 1: Find it by title and confirm it is NOT the routine C2 edited**

```bash
curl -sS "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/routines" "${H[@]}" \
  | jq -r '.[] | select(.title | test("^Weekly governance sweep")) | [.id, .status, .title] | @tsv'
```

Expected: exactly one line, id starting `8b764d66`, status `paused`. If the id is `a03b2236…`, this plan's routine map is wrong; stop. If a second routine prints, stop: two sweeps would double-report, and the duplicate needs an operator decision before either is activated.

- [ ] **Step 2: Re-check the invariants on the LIVE text, then activate**

```bash
SWEEP=$(curl -sS "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/routines" "${H[@]}" | jq -r '.[] | select(.title | test("^Weekly governance sweep")) | .id')
curl -sS "$PAPERCLIP_API_URL/api/routines/$SWEEP" "${H[@]}" | jq -r .description > /tmp/sweep-live.md
grep -c 'This routine is REPORT-ONLY. It cancels nothing, ever.' /tmp/sweep-live.md
grep -c 'It never calls cancel, and never modifies any issue' /tmp/sweep-live.md
grep -ci 'eligible-for-destruction\|destruction batch\|batch size cap' /tmp/sweep-live.md
sed -n '/Revision 7 routed every filing by assignee identity alone/,/^$/p' /tmp/sweep-live.md
```

Expected: the first two counts are `1` each (the revision-7 REPORT-ONLY banner and the structural safety bullet are intact). The third count is nonzero only because the text explains those things no longer exist; read each hit and confirm every one is negated. The `sed` prints the paragraph explaining that revision 7 filed against `Operator (devbox)`, a paused non-executing agent, in the past tense. Two lines below it the text must route every filing through `resolveAcPolicyFilingTarget` with the `isAgentInvokable` predicate (verified present on 2026-09-05). Confirm with `grep -c 'resolveAcPolicyFilingTarget' /tmp/sweep-live.md` (expected at least `1`). If that literal is missing, do not un-pause: file the routing fix as its own issue and stop here. Only then:

```bash
REV=$(curl -sS "$PAPERCLIP_API_URL/api/routines/$SWEEP" "${H[@]}" | jq -r .latestRevisionId)
curl -sS -X PATCH "$PAPERCLIP_API_URL/api/routines/$SWEEP" "${H[@]}" -d "{\"status\":\"active\",\"baseRevisionId\":\"$REV\"}" | jq '{id, status}'
curl -sS "$PAPERCLIP_API_URL/api/routines/$SWEEP/triggers" "${H[@]}" | jq '[.[] | {kind, cronExpression, timezone, enabled}]'
```

Expected: `status: "active"` and the existing enabled schedule trigger `0 9 * * 1` UTC (Monday 09:00, clear of the 07:23 UTC deploy). Leave the trigger as it is; the first fire is the next Monday.

### Task C4: Evidence

**Files:**
- Modify: `docs/superpowers/plans/2026-09-05-track-a-landing-log.md`

**Interfaces:**
- Consumes: ids from C1 to C3.
- Produces: a machine-readable record that the routines exist, are active, and fired.

- [ ] **Step 1: Capture the state of both routines**

```bash
for R in "$ROUTINE_ID" "$SWEEP"; do
  curl -sS "$PAPERCLIP_API_URL/api/routines/$R" "${H[@]}" | jq '{id, title, status, assigneeAgentId, concurrencyPolicy, priority, descriptionSha: (.description | @base64 | .[0:16])}'
  curl -sS "$PAPERCLIP_API_URL/api/routines/$R/triggers" "${H[@]}" | jq '[.[] | {kind, cronExpression, timezone, enabled}]'
done > /tmp/track-c-evidence.json
cat /tmp/track-c-evidence.json
```

- [ ] **Step 2: Wait for the sweep's first fire and copy the (a′) rows**

After the next Monday fire, open the sweep's output issue (the routine posts where its description says) and copy every row whose rule is `human_gate_aged`. Expected on the first fire: dozens of rows, most in bucket `>21d`, because the 32 issues left on the human queue on 2026-09-04 have not moved.

- [ ] **Step 3: Append to the landing log**

```markdown
## Track C: routines
### Evidence
<paste /tmp/track-c-evidence.json>
### First landing receipt
<paste from C1 Step 6>
### First human_gate_aged rows
<paste from C4 Step 2, or "sweep has not fired yet as of <date>">
```

Commit on the Track A landing-log branch:

```bash
git add docs/superpowers/plans/2026-09-05-track-a-landing-log.md
git commit -m "docs(plans): record landing and governance routine evidence"
```


## Track D: Skill propagation and skill docs

**Why this track** Six agents never receive the `paperclip-evidence-before-in-review` skill, so they cannot follow the evidence gate they are held to. The skill docs also lack the `in_review` review-path rule and any privileged-access request path, which is how finished work gets parked on humans. D1 fixes the skill sync live via the API with a verified round-trip. D2 and D3 land the doc changes through a CODEOWNED PR with evidence.

ASSUMPTIONS I'M MAKING:
1. `POST /api/companies/{companyId}/approvals` accepts `type: "request_board_approval"`. Step D2.4 verifies this and branches.
2. `PATCH /api/issues/{issueId}` accepts `executionPolicy`. Step D2.2 verifies this and branches.

Ownership note: Task B8 (Track B) documents `review:ally-clean` and `deploy:landed` in `skills/paperclip-evidence-before-in-review/SKILL.md`. Track D does not touch that file's label table or shape sections. D2 adds only the privileged-access section there, in a different region, so the two PRs merge without conflict in either order.

### Task D1: Desired-skill sync script and live rollout to six agents

**Files:**
- Create: `/Users/oramadan/src/github.com/blockcast/paperclip-track-d/scripts/ops/add-desired-skill.py` (new git worktree of `origin/master`)
- Create: `/tmp/track-d/<agent-id>.before.json`, `/tmp/track-d/<agent-id>.after.json`, `/tmp/track-d/<agent-id>.run.json` (evidence, not committed)
- Test: live round-trip assertions inside the script, plus heartbeat run-log grep

**Interfaces:**
- Consumes: `GET /api/agents/{id}`, `PATCH /api/agents/{id}` (body `{adapterConfig}` validated by `updateAgentSchema`, redacted env restored by `stripRedactedEnvBindingsFromAdapterConfig`), `POST /api/agents/{id}/heartbeat/invoke` (server/src/routes/agents.ts:4241, empty or `{reason}` body, returns the run JSON or `202 {status:"skipped"}`), `GET /api/heartbeat-runs/{runId}`, `GET /api/heartbeat-runs/{runId}/log?offset=&limitBytes=` (agents.ts:4909, max `limitBytes` 1048576). `adapterConfig.paperclipSkillSync.desiredSkills: Array<string | AgentDesiredSkillEntry>` (packages/shared/src/types/adapter-skills.ts:52).
- Produces: `add-desired-skill.py <agent-id> [--skill S] [--dry-run] [--out-dir D]`, exit 0 with `OK:` line, exit 1 with `FAIL:` line. Function `merge(adapter_config: dict, skill: str) -> dict`.

- [ ] **Step 1: Create a clean worktree from origin/master**
```bash
cd /Users/oramadan/src/github.com/blockcast/paperclip
git fetch origin master
git worktree add /Users/oramadan/src/github.com/blockcast/paperclip-track-d -b track-d/skill-propagation origin/master
mkdir -p /tmp/track-d /Users/oramadan/src/github.com/blockcast/paperclip-track-d/scripts/ops
```
Run: `git -C /Users/oramadan/src/github.com/blockcast/paperclip-track-d log --oneline -1`  Expected: one line, the current `origin/master` head.

- [ ] **Step 2: Preflight the API and capture Players Engineer before-state**
```bash
test -n "$PAPERCLIP_API_URL" && test -n "$PAPERCLIP_API_KEY" && echo env-ok
curl -sS "$PAPERCLIP_API_URL/api/agents/0b4ec33c-ba4a-40e8-9afb-72d37b0a8c58" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  | jq '{name, status, adapterType, skillSync: .adapterConfig.paperclipSkillSync, envKeys: (.adapterConfig.env // {} | keys)}'
```
Run: the two commands above.  Expected: `env-ok`, then JSON with `"name": "Players Engineer"` and `"skillSync": null` (FACTS: Players has no `paperclipSkillSync`).

- [ ] **Step 3: Write the script**
```bash
cat > /Users/oramadan/src/github.com/blockcast/paperclip-track-d/scripts/ops/add-desired-skill.py <<'PY'
#!/usr/bin/env python3
"""Add one desired skill to a Paperclip agent's adapterConfig.paperclipSkillSync.

GET -> merge -> PATCH -> GET -> assert. Only paperclipSkillSync changes.
The server restores redacted ("***") env bindings from the stored config on
PATCH, so the full adapterConfig from GET is sent back unchanged apart from
paperclipSkillSync. Before/after JSON is written to --out-dir as evidence.

Usage:
  add-desired-skill.py <agent-id> [--skill NAME] [--dry-run] [--out-dir DIR]
Env:
  PAPERCLIP_API_URL, PAPERCLIP_API_KEY
Exit 0 on "OK:", exit 1 on "FAIL:".
"""
import argparse
import copy
import json
import os
import sys
import urllib.error
import urllib.request

DEFAULT_SKILL = "paperclipai/paperclip/paperclip-evidence-before-in-review"


def api(method, path, body=None):
    base = os.environ["PAPERCLIP_API_URL"].rstrip("/")
    req = urllib.request.Request(base + path, method=method)
    req.add_header("Authorization", "Bearer " + os.environ["PAPERCLIP_API_KEY"])
    req.add_header("Accept", "application/json")
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, data=data, timeout=30) as resp:
            raw = resp.read()
            return resp.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as err:
        raw = err.read()
        try:
            return err.code, json.loads(raw)
        except ValueError:
            return err.code, {"error": raw.decode(errors="replace")}


def skill_names(entries):
    """desiredSkills holds strings or AgentDesiredSkillEntry objects."""
    names = []
    for entry in entries:
        if isinstance(entry, str):
            names.append(entry)
        elif isinstance(entry, dict):
            for key in ("skill", "name", "key", "id"):
                if isinstance(entry.get(key), str):
                    names.append(entry[key])
                    break
    return names


def merge(adapter_config, skill):
    merged = copy.deepcopy(adapter_config or {})
    sync = merged.get("paperclipSkillSync")
    if not isinstance(sync, dict):
        sync = {}
    desired = sync.get("desiredSkills")
    if not isinstance(desired, list):
        desired = []
    if skill not in skill_names(desired):
        desired = desired + [skill]
    merged["paperclipSkillSync"] = {**sync, "desiredSkills": desired}
    return merged


def without_sync(adapter_config):
    return {k: v for k, v in (adapter_config or {}).items() if k != "paperclipSkillSync"}


def write(out_dir, name, payload):
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, name)
    with open(path, "w") as fh:
        json.dump(payload, fh, indent=2, sort_keys=True)
    return path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("agent_id")
    parser.add_argument("--skill", default=DEFAULT_SKILL)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--out-dir", default="/tmp/track-d")
    args = parser.parse_args()

    status, before = api("GET", f"/api/agents/{args.agent_id}")
    if status != 200:
        print(f"FAIL: GET before returned {status}: {before}")
        return 1
    before_ac = before.get("adapterConfig") or {}
    write(args.out_dir, f"{args.agent_id}.before.json", before)
    merged = merge(before_ac, args.skill)

    if args.dry_run:
        print("DRY-RUN paperclipSkillSync ->", json.dumps(merged["paperclipSkillSync"]))
        print("DRY-RUN env keys unchanged:", sorted((before_ac.get("env") or {}).keys()))
        return 0

    if args.skill in skill_names(before_ac.get("paperclipSkillSync", {}).get("desiredSkills", [])
                                 if isinstance(before_ac.get("paperclipSkillSync"), dict) else []):
        print(f"OK: {before.get('name')} already has {args.skill}; no PATCH sent")
        return 0

    status, patched = api("PATCH", f"/api/agents/{args.agent_id}", {"adapterConfig": merged})
    if status != 200:
        print(f"FAIL: PATCH returned {status}: {patched}")
        return 1

    status, after = api("GET", f"/api/agents/{args.agent_id}")
    if status != 200:
        print(f"FAIL: GET after returned {status}: {after}")
        return 1
    after_ac = after.get("adapterConfig") or {}
    write(args.out_dir, f"{args.agent_id}.after.json", after)

    failures = []
    after_sync = after_ac.get("paperclipSkillSync")
    if not isinstance(after_sync, dict) or args.skill not in skill_names(after_sync.get("desiredSkills", [])):
        failures.append(f"desiredSkills missing {args.skill}: {after_sync}")
    before_env = before_ac.get("env") or {}
    after_env = after_ac.get("env") or {}
    if sorted(before_env.keys()) != sorted(after_env.keys()):
        failures.append(f"env keys changed: {sorted(before_env)} -> {sorted(after_env)}")
    if before_env != after_env:
        failures.append("env values differ between before and after GET (both are server-masked; a diff means a binding was dropped or rewritten)")
    if without_sync(before_ac) != without_sync(after_ac):
        changed = sorted(k for k in set(without_sync(before_ac)) | set(without_sync(after_ac))
                         if without_sync(before_ac).get(k) != without_sync(after_ac).get(k))
        failures.append(f"non-skill adapterConfig keys changed: {changed}")
    if failures:
        print("FAIL: " + " | ".join(failures))
        return 1

    print(f"OK: {after.get('name')} ({args.agent_id}) desiredSkills={skill_names(after_sync['desiredSkills'])} "
          f"envKeys={sorted(after_env)} unchanged; adapterType={after.get('adapterType')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
PY
chmod +x /Users/oramadan/src/github.com/blockcast/paperclip-track-d/scripts/ops/add-desired-skill.py
```
Run: `python3 -m py_compile /Users/oramadan/src/github.com/blockcast/paperclip-track-d/scripts/ops/add-desired-skill.py && echo compiled`  Expected: `compiled`.

- [ ] **Step 4: Dry run on Players Engineer**
```bash
python3 /Users/oramadan/src/github.com/blockcast/paperclip-track-d/scripts/ops/add-desired-skill.py 0b4ec33c-ba4a-40e8-9afb-72d37b0a8c58 --dry-run
```
Run: the command above.  Expected: `DRY-RUN paperclipSkillSync -> {"desiredSkills": ["paperclipai/paperclip/paperclip-evidence-before-in-review"]}` then `DRY-RUN env keys unchanged: [...]`, and `/tmp/track-d/0b4ec33c-ba4a-40e8-9afb-72d37b0a8c58.before.json` exists.

- [ ] **Step 5: Apply on Players Engineer**
```bash
python3 /Users/oramadan/src/github.com/blockcast/paperclip-track-d/scripts/ops/add-desired-skill.py 0b4ec33c-ba4a-40e8-9afb-72d37b0a8c58
```
Run: the command above.  Expected: exit 0 and one line starting `OK: Players Engineer (0b4ec33c-...) desiredSkills=['paperclipai/paperclip/paperclip-evidence-before-in-review'] envKeys=[...] unchanged`. If the line starts `FAIL: PATCH returned 400`, the body names the rejected field; stop and paste it into the tracking comment before touching other agents.

- [ ] **Step 6: Trigger one Players Engineer heartbeat and record the run id**
```bash
AGENT=0b4ec33c-ba4a-40e8-9afb-72d37b0a8c58
curl -sS -o /tmp/track-d/$AGENT.invoke.json -w '%{http_code}
' \
  -X POST "$PAPERCLIP_API_URL/api/agents/$AGENT/heartbeat/invoke" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" -H 'Content-Type: application/json' \
  -d '{"reason":"Track D: verify paperclip-evidence-before-in-review skill sync"}'
jq -r '.id // .status' /tmp/track-d/$AGENT.invoke.json
```
Run: the commands above.  Expected: `200` then a run UUID. If `202` and `skipped`: the agent is paused or a run is active. Check `curl -sS "$PAPERCLIP_API_URL/api/agents/$AGENT" -H "Authorization: Bearer $PAPERCLIP_API_KEY" | jq .status`; if `paused`, unpause is a human decision, so leave a comment and verify on the next natural run instead (repeat Step 7 with that run id from `GET /api/agents/$AGENT` field `lastHeartbeatRunId`, or the newest run in the UI).

- [ ] **Step 7: Wait for the run and grep the log for the skill**
```bash
AGENT=0b4ec33c-ba4a-40e8-9afb-72d37b0a8c58
RUN_ID=$(jq -r .id /tmp/track-d/$AGENT.invoke.json)
for i in $(seq 1 90); do
  S=$(curl -sS "$PAPERCLIP_API_URL/api/heartbeat-runs/$RUN_ID" -H "Authorization: Bearer $PAPERCLIP_API_KEY" | jq -r .status)
  echo "$S"; case "$S" in queued|running) sleep 10;; *) break;; esac
done
curl -sS "$PAPERCLIP_API_URL/api/heartbeat-runs/$RUN_ID/log?offset=0&limitBytes=1048576" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" > /tmp/track-d/$AGENT.run.json
grep -o 'paperclip-evidence-before-in-review' /tmp/track-d/$AGENT.run.json | wc -l
```
Run: the commands above.  Expected: the loop ends on a terminal status (not `queued`/`running`) and the final count is `1` or more. The skill name appears in the SessionStart skill list inside the first ~20KB of the log. If the count is `0`: run `grep -o -i 'skill[^"\\]\{0,120\}' /tmp/track-d/$AGENT.run.json | head -20`. A line containing `not found` or `unsupported` means the adapter did not sync it; find the route with `git -C /Users/oramadan/src/github.com/blockcast/paperclip-track-d grep -n 'agents/:id/skills' -- server/src/routes/agents.ts`, call it, and read `supported` and `warnings` from the `AgentSkillSnapshot`. Do not continue to Step 8 until the count is nonzero.

- [ ] **Step 8: Apply to the remaining five agents**
```bash
for A in 386c81e8-e454-41ba-8e1d-7bb692331185 d2ade02d-112c-4da2-b61f-2301254a154c 5b6342f5-d2b8-456d-adf6-fe27a08e3eea e6a0f265-8499-40bb-b2af-cb49d330b86f c0bccc75-a449-4ece-a789-ce40bdd8e785; do
  python3 /Users/oramadan/src/github.com/blockcast/paperclip-track-d/scripts/ops/add-desired-skill.py "$A" || { echo "STOP at $A"; break; }
done
ls /tmp/track-d/*.after.json | wc -l
```
Run: the commands above.  Expected: five `OK:` lines naming CTO, Staff Engineer, BackendEngineerGo, TrafficOpsEngineer, Release Engineer; then `6`. On any `FAIL:` the loop stops; the printed reason is the next thing to fix, and agents after it stay untouched.

- [ ] **Step 9: Verify one file-bundled agent's run log (Release Engineer)**
```bash
AGENT=c0bccc75-a449-4ece-a789-ce40bdd8e785
curl -sS -o /tmp/track-d/$AGENT.invoke.json -w '%{http_code}
' \
  -X POST "$PAPERCLIP_API_URL/api/agents/$AGENT/heartbeat/invoke" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" -H 'Content-Type: application/json' \
  -d '{"reason":"Track D: verify skill sync on instructionsFilePath agent"}'
RUN_ID=$(jq -r .id /tmp/track-d/$AGENT.invoke.json)
for i in $(seq 1 90); do
  S=$(curl -sS "$PAPERCLIP_API_URL/api/heartbeat-runs/$RUN_ID" -H "Authorization: Bearer $PAPERCLIP_API_KEY" | jq -r .status)
  case "$S" in queued|running) sleep 10;; *) echo "$S"; break;; esac
done
curl -sS "$PAPERCLIP_API_URL/api/heartbeat-runs/$RUN_ID/log?offset=0&limitBytes=1048576" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" > /tmp/track-d/$AGENT.run.json
grep -o 'paperclip-evidence-before-in-review' /tmp/track-d/$AGENT.run.json | wc -l
```
Run: the commands above.  Expected: `200`, a terminal status, and a count of `1` or more. This proves `instructionsFilePath` agents also receive synced skills. If `0`, apply the Step 7 diagnostic to this agent before opening the PR.

- [ ] **Step 10: Commit the script**
```bash
cd /Users/oramadan/src/github.com/blockcast/paperclip-track-d
git add scripts/ops/add-desired-skill.py
git commit -m "chore(ops): add-desired-skill.py for auditable paperclipSkillSync edits

GET -> merge -> PATCH -> GET -> assert. Only paperclipSkillSync changes;
env keys and every other adapterConfig key are asserted unchanged.
Used to add paperclip-evidence-before-in-review to six agents.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task D2: Skill doc edits (in_review review path, privileged access)

**Files:**
- Modify: `/Users/oramadan/src/github.com/blockcast/paperclip-track-d/skills/paperclip/SKILL.md:441` (insert after the rule #1 paragraph)
- Modify: `/Users/oramadan/src/github.com/blockcast/paperclip-track-d/skills/paperclip-evidence-before-in-review/SKILL.md:223-232` (after `### 4.`, before `## Anti-patterns`). The label table and shape sections belong to Task B8; do not edit them here.
- Create: `/tmp/track-d/assert_skill_docs.sh` (grep assertions, the "test" for this task)
- Create: `/tmp/track-d/insert_skill_docs.py` (marker-based insertion)

**Interfaces:**
- Consumes: `IssueExecutionPolicy` shape (packages/shared/src/types/issue.ts:637); QA Engineer id `c6d95c42-9456-4806-b691-88014fc95e32`; five review path names from `assertAgentInReviewReviewPath` (issues.ts ~3877). Elevation facts: VAP `bc-protected-secret-write`, ConfigMap `bc-elevation/bc-active-elevations`, `break_glass_cli grant`, `ElevationGrant.spec.expiresAt` ≤ 1h.
- Produces: two anchors greppable in the docs: `**in_review review path.**` and `### Requesting privileged access`.

- [ ] **Step 1: Write the failing assertion script**
```bash
cat > /tmp/track-d/assert_skill_docs.sh <<'SH'
#!/usr/bin/env bash
set -u
ROOT=/Users/oramadan/src/github.com/blockcast/paperclip-track-d
P=$ROOT/skills/paperclip/SKILL.md
E=$ROOT/skills/paperclip-evidence-before-in-review/SKILL.md
fail=0
chk() { # file pattern expected-count label
  n=$(grep -c -F -- "$2" "$1"); if [ "$n" -ne "$3" ]; then echo "MISSING/COUNT: $4 (found $n, want $3)"; fail=1; else echo "ok: $4"; fi; }
chk "$P" '**in_review review path.**' 1 'rule-1 review-path paragraph'
chk "$P" '"agentId": "c6d95c42-9456-4806-b691-88014fc95e32"' 1 'executionPolicy example names QA Engineer'
chk "$P" 'typed_execution_state_current_participant' 1 'default path named'
chk "$E" '### Requesting privileged access' 1 'privileged access section'
chk "$E" 'break_glass_cli grant --kind admin_elevation' 1 'two-approver command'
chk "$E" 'system:serviceaccount:paperclip:<sa-name>' 2 'SA subject in payload and prose'
# rule-1 paragraph must still be directly above the insert
awk 'NR==441' "$P" | grep -q 'NEVER ASK A HUMAN TO DO WHAT AN AGENT COULD DO' || { echo "MISSING: rule #1 no longer at line 441"; fail=1; }
[ $fail -eq 0 ] && echo PASS || { echo FAIL; exit 1; }
SH
chmod +x /tmp/track-d/assert_skill_docs.sh
/tmp/track-d/assert_skill_docs.sh
```
Run: the commands above.  Expected: six `MISSING/COUNT:` lines and `FAIL`, exit 1. The rule #1 check passes (no `MISSING: rule #1` line).

- [ ] **Step 2: Verify PATCH /api/issues accepts executionPolicy**
```bash
cd /Users/oramadan/src/github.com/blockcast/paperclip-track-d
git grep -n 'executionPolicy' -- packages/shared/src/validators/issue.ts | head -5
```
Run: the command above.  Expected: at least one line inside `updateIssueSchema` (or a schema it spreads). If there is NO match in the update schema but there is one in `createIssueSchema`, change the sentence "send it on the `PATCH /api/issues/{issueId}` that moves the issue to `in_review`" in Step 6's block to "set it at `POST /api/issues` when you create the issue; existing issues cannot gain a policy through PATCH". If there is no match anywhere, keep the paragraph, drop the JSON block, and add the sentence "Ask your manager to set the policy when the issue is created; PATCH does not accept it today."

- [ ] **Step 3: Confirm this task does not collide with Task B8**
```bash
cd /Users/oramadan/src/github.com/blockcast/paperclip-track-d
git fetch origin
git show origin/master:skills/paperclip-evidence-before-in-review/SKILL.md | grep -n '^## Anti-patterns\|^### 4\.' 
git show origin/master:skills/paperclip-evidence-before-in-review/SKILL.md | grep -c 'review:ally-clean'
```
Run: the commands above.  Expected: the two anchor headings print with line numbers, and the count is `0` (B8 not yet merged) or `3` or more (B8 merged). Either way D2 inserts only between `### 4.` and `## Anti-patterns`. If B8 has merged, its text sits above `### 4.` and this task leaves it alone.

- [ ] **Step 4: Verify the approval request route and type**
```bash
cd /Users/oramadan/src/github.com/blockcast/paperclip-track-d
git grep -n 'request_board_approval' -- packages/shared/src server/src/routes | head -8
git grep -n 'router.post("/companies/:companyId/approvals' -- server/src/routes | head -3
```
Run: the commands above.  Expected: a validator line listing `request_board_approval` as an approval `type`, and a `router.post("/companies/:companyId/approvals"` line. If the route path differs, replace `POST /api/companies/{companyId}/approvals` in Step 7's block with the path found. If the validator names required payload keys, keep them and nest the keys below under `payload` unchanged.

- [ ] **Step 5: Write the marker-based insertion script**
```bash
cat > /tmp/track-d/insert_skill_docs.py <<'PY'
#!/usr/bin/env python3
"""Insert Track D text into the two skill files using unique markers."""
import sys

ROOT = "/Users/oramadan/src/github.com/blockcast/paperclip-track-d"
P = f"{ROOT}/skills/paperclip/SKILL.md"
E = f"{ROOT}/skills/paperclip-evidence-before-in-review/SKILL.md"


def insert_after(path, marker, text):
    body = open(path).read()
    if body.count(marker) != 1:
        sys.exit(f"marker not unique in {path}: {marker!r} x{body.count(marker)}")
    idx = body.index(marker) + len(marker)
    open(path, "w").write(body[:idx] + text + body[idx:])


def replace_once(path, old, new):
    body = open(path).read()
    if body.count(old) != 1:
        sys.exit(f"replace target not unique in {path}: {old!r} x{body.count(old)}")
    open(path, "w").write(body.replace(old, new, 1))


insert_after(P, "Never ask a human to do what an agent _could_ do. Rule number 1.
",
             open("/tmp/track-d/block_rule1.md").read())
insert_after(E, "### 4. Only THEN transition to in_review
", "")
body = open(E).read()
anchor = "
## Anti-patterns
"
if body.count(anchor) != 1:
    sys.exit("Anti-patterns heading not unique")
body = body.replace(anchor, "
" + open("/tmp/track-d/block_priv.md").read() + anchor, 1)
open(E, "w").write(body)
print("inserted")
PY
```
Run: `cd /Users/oramadan/src/github.com/blockcast/paperclip-track-d && grep -n '^### 4\. Only THEN transition to in_review$\|^## Anti-patterns$' skills/paperclip-evidence-before-in-review/SKILL.md`  Expected: exactly one line for each heading. If either heading text differs, copy the file's exact heading into the matching marker string in the script before Step 8.

- [ ] **Step 6: Write the rule #1 block (skills/paperclip/SKILL.md)**
````bash
cat > /tmp/track-d/block_rule1.md <<'MD'

**in_review review path.** When you move an issue to in_review you must satisfy one of the five review paths. Default to typed_execution_state_current_participant with the QA Engineer (or the reviewing agent named in the issue) as participant. Use human_assignee_user_id ONLY for a decision a human must make: legal, spend above your cap, physical access, or an external account. Never use a human assignee as a place to park finished work.

The five paths the server accepts (`invalid_issue_disposition` 422 otherwise): `pending_issue_thread_interaction`, `linked_pending_approval`, `human_assignee_user_id`, `typed_execution_state_current_participant`, `scheduled_issue_monitor`.

Minimal `executionPolicy` for the default path. Send it on the `PATCH /api/issues/{issueId}` that moves the issue to `in_review`:

```json
{
  "status": "in_review",
  "comment": "Ready for review: <what changed, evidence links>",
  "executionPolicy": {
    "mode": "normal",
    "commentRequired": true,
    "stages": [
      {
        "id": "qa-review",
        "type": "review",
        "approvalsNeeded": 1,
        "participants": [
          { "id": "qa", "type": "agent", "agentId": "c6d95c42-9456-4806-b691-88014fc95e32" }
        ]
      }
    ]
  }
}
```

Replace `agentId` with the reviewing agent named in the issue when there is one. Agent-to-agent handoff is a valid review path; a human assignee is not a review path for finished work.
MD
````
Run: `grep -c 'typed_execution_state_current_participant' /tmp/track-d/block_rule1.md`  Expected: `2` (once in the paragraph, once in the list). Note: Step 1's assertion counts `1` in the target file because grep -c counts lines and both mentions are on separate lines; if the assertion reports `2`, change its expected count to `2`.

- [ ] **Step 7: Write the privileged-access section**
````bash
cat > /tmp/track-d/block_priv.md <<'MD'
### Requesting privileged access

Agents cannot read or grant elevation. Elevation is decided in magma tenants (`ApprovalsService`) by two distinct human approvers and enforced by the `bc-protected-secret-write` ValidatingAdmissionPolicy, which reads the `bc-elevation/bc-active-elevations` ConfigMap. Your Kubernetes subject is `system:serviceaccount:paperclip:<sa-name>`. When a task needs a write that the policy denies: do not retry, do not hand the issue to a human assignee, and do not ask for a permanent RBAC change. File a `request_board_approval` approval with the payload below, add the approval as a first-class blocker, and keep the issue `in_progress`.

`POST /api/companies/{companyId}/approvals`

```json
{
  "type": "request_board_approval",
  "title": "Elevation: <BLO-id> <one-line why>",
  "payload": {
    "subject": "system:serviceaccount:paperclip:<sa-name>",
    "systemPrincipal": "sp_<uuid>",
    "verb": "<create|update|patch|delete>",
    "resource": "<group/version/kind>",
    "namespace": "<namespace>",
    "durationMinutes": 60,
    "reason": "<BLO-id>: <why this write is needed and what it changes>",
    "approverCommand": "break_glass_cli grant --kind admin_elevation --subject sp_<uuid> --reason \"<BLO-id>: <why>\" --addr tenants.controller.magma.local:9079 --cert-file <operator cert> --key-file <key> --ca-file <ca>"
  }
}
```

Rules:

- `durationMinutes` is at most 60. `ElevationGrant.spec.expiresAt` is capped at one hour. Ask for less when less is enough.
- `systemPrincipal` (`sp_<uuid>`) is your SA's system-principal registration in magma tenants. Two approvers must each run `approverCommand` with their own operator `mb_<uuid>` certificate. One approver is not a grant.
- If you cannot find an `sp_<uuid>` for `system:serviceaccount:paperclip:<sa-name>`, the registration may not exist. Say so in the request in plain words and ask for registration first. Whether Paperclip agent SAs are registered at all is unverified as of 2026-09-04; see the bc-elevation bridge notes in onprem-k8s `security/bc-elevation/source-of-truth.md`.
- The approval record plus the audit of the write you performed are the evidence for `in_review`. The grant itself is not evidence.
- `review:ally-clean` and `deploy:landed` (defined above, Task B8) still apply to any PR the elevated write was for.

MD
````
Run: `grep -c 'system:serviceaccount:paperclip:<sa-name>' /tmp/track-d/block_priv.md`  Expected: `3` (prose, payload, rules). Step 1's assertion expects `2` because two mentions share no line with a third; if the target file reports `3`, set the expected count in `/tmp/track-d/assert_skill_docs.sh` to `3`.

- [ ] **Step 8: Apply the insertions and run the assertions**
```bash
python3 /tmp/track-d/insert_skill_docs.py
/tmp/track-d/assert_skill_docs.sh
```
Run: the commands above.  Expected: `inserted` then six `ok:` lines and `PASS`, exit 0. If a `marker not unique` or `replace target not unique` error prints, open the named file at the marker and fix the marker string in `/tmp/track-d/insert_skill_docs.py`; do not hand-edit the skill files.

- [ ] **Step 9: Check the diff for accidental changes**
```bash
cd /Users/oramadan/src/github.com/blockcast/paperclip-track-d
git diff --stat
git diff -- skills/paperclip/SKILL.md | grep -c '^-[^-]'
git diff -- skills/paperclip-evidence-before-in-review/SKILL.md | grep -c '^-[^-]'
```
Run: the commands above.  Expected: two files changed and `0` removed lines in each. Insertions only.

- [ ] **Step 10: Commit**
```bash
cd /Users/oramadan/src/github.com/blockcast/paperclip-track-d
git add skills/paperclip/SKILL.md skills/paperclip-evidence-before-in-review/SKILL.md
git commit -m "docs(skills): in_review review path and privileged-access request

skills/paperclip: after rule #1, require one of the five in_review review
paths; default to typed_execution_state_current_participant with the QA
Engineer; human_assignee_user_id only for decisions a human must make.

skills/paperclip-evidence-before-in-review: add review:ally-clean and
deploy:landed rows and shape sections (Track B), and a Requesting
privileged access section with the request_board_approval payload and the
two-approver break_glass_cli grant command.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task D3: Skills PR, kkroo review, deploy screenshot

**Files:**
- Create: PR on `Blockcast/paperclip` from `track-d/skill-propagation` (CODEOWNED `skills/**` → @kkroo)
- Create: `/tmp/track-d/pr-body.md`, `/tmp/track-d/skill-page-1440x900.png`, `/tmp/track-d/skill-list-1440x900.png`

**Interfaces:**
- Consumes: D1 evidence files `/tmp/track-d/*.before.json`, `*.after.json`, `*.run.json`; D2 assertion output; `GET /api/companies/{cid}/skills` (ui/src/api/companySkills.ts:58); UI route `/<prefix>/skills/*` (ui/src/App.tsx:160); deploy workflow `scheduled-production-deploy.yml`.
- Produces: merged PR number; production screenshot posted as a PR comment.

- [ ] **Step 1: Push and open the PR with evidence body**
```bash
cd /Users/oramadan/src/github.com/blockcast/paperclip-track-d
git push -u origin track-d/skill-propagation
{
  echo "## Why"
  echo "Six agents lacked the evidence skill; the skill docs lacked the in_review review-path rule and a privileged-access request path. Paperclip issue: https://paperclip.blockcast.net/BLO/issues/<BLO-id-of-this-plan>"
  echo; echo "## Changes"
  echo "- scripts/ops/add-desired-skill.py: GET -> merge -> PATCH -> GET -> assert for paperclipSkillSync"
  echo "- skills/paperclip/SKILL.md: in_review review path paragraph + executionPolicy example after rule #1"
  echo "- skills/paperclip-evidence-before-in-review/SKILL.md: Requesting privileged access section (the review:ally-clean and deploy:landed docs ship in Track B's PR)"
  echo; echo "## Evidence: agents (before -> after paperclipSkillSync, env keys unchanged)"
  for f in /tmp/track-d/*.after.json; do
    id=$(basename "$f" .after.json)
    echo "### $(jq -r .name "$f") ($id)"
    echo '```json'; echo "before:"; jq -c '.adapterConfig.paperclipSkillSync' "/tmp/track-d/$id.before.json"
    echo "after: "; jq -c '.adapterConfig.paperclipSkillSync' "$f"
    echo "envKeys before/after equal: $( [ "$(jq -c '.adapterConfig.env // {} | keys' "/tmp/track-d/$id.before.json")" = "$(jq -c '.adapterConfig.env // {} | keys' "$f")" ] && echo yes || echo NO)"
    echo '```'
  done
  echo; echo "## Evidence: heartbeat run logs list the skill"
  for id in 0b4ec33c-ba4a-40e8-9afb-72d37b0a8c58 c0bccc75-a449-4ece-a789-ce40bdd8e785; do
    echo "- $id run $(jq -r .id /tmp/track-d/$id.invoke.json): $(grep -o 'paperclip-evidence-before-in-review' /tmp/track-d/$id.run.json | wc -l | tr -d ' ') mention(s)"
  done
  echo; echo "## Evidence: doc assertions"; echo '```'; /tmp/track-d/assert_skill_docs.sh; echo '```'
  echo; echo "## Repro"
  echo '```bash'; echo 'python3 scripts/ops/add-desired-skill.py <agent-id> --dry-run'; echo '/tmp/track-d/assert_skill_docs.sh   # see PR for script'; echo '```'
  echo; echo "Production screenshot (1440x900) of the rendered skill page follows as a comment after the next deploy."
} > /tmp/track-d/pr-body.md
gh pr create -R Blockcast/paperclip --base master --head track-d/skill-propagation \
  --title "docs(skills): in_review review path, privileged-access request, evidence skill sync for six agents" \
  --body-file /tmp/track-d/pr-body.md --reviewer kkroo
```
Run: the commands above.  Expected: a PR URL printed; `gh pr view --json reviewRequests -q '.reviewRequests[].login'` prints `kkroo`. Replace `<BLO-id-of-this-plan>` with the real issue id before running.

- [ ] **Step 2: Confirm CODEOWNERS routing and CI**
```bash
PR=$(gh pr view -R Blockcast/paperclip track-d/skill-propagation --json number -q .number)
gh pr checks -R Blockcast/paperclip "$PR" --watch --fail-fast
gh pr view -R Blockcast/paperclip "$PR" --json files -q '.files[].path'
```
Run: the commands above.  Expected: `verify` and `codeowners-guard` pass; the file list is the three paths from Step 1. If `codeowners-guard` fails, read its log with `gh run view --log-failed`; it means a codeowned path lacks an owner review request, and `gh pr edit "$PR" --add-reviewer kkroo` fixes it.

- [ ] **Step 3: Confirm the evidence-skill hunk does not overlap Track B's**
```bash
B=$(gh pr list -R Blockcast/paperclip --state open --search "truth-checked review:ally-clean in:title" --json number -q '.[0].number')
[ -n "$B" ] && gh pr diff -R Blockcast/paperclip "$B" -- skills/paperclip-evidence-before-in-review/SKILL.md | grep -n '^@@'
gh pr diff -R Blockcast/paperclip "$PR" -- skills/paperclip-evidence-before-in-review/SKILL.md | grep -n '^@@'
```
Run: the commands above.  Expected: B's hunks (if B is open) sit in the label table and the shape sections above `### 4.`; this PR's single hunk sits between `### 4.` and `## Anti-patterns`. No shared line ranges, so either PR may land first and the other rebases cleanly with `gh pr update-branch`. There is no ordering dependency between Track B and Track D.

- [ ] **Step 4: Merge after kkroo approval**
```bash
PR=$(gh pr view -R Blockcast/paperclip track-d/skill-propagation --json number -q .number)
gh pr view -R Blockcast/paperclip "$PR" --json reviews -q '[.reviews[] | select(.state=="APPROVED") | .author.login] | unique'
gh pr view -R Blockcast/paperclip "$PR" --json mergeStateStatus -q .mergeStateStatus
```
Run: the commands above.  Expected: `["kkroo"]` and `CLEAN` or `BEHIND`. If `BEHIND`: `gh pr update-branch -R Blockcast/paperclip "$PR"` and wait for `verify` again. Then:
```bash
gh pr merge -R Blockcast/paperclip "$PR" --squash --auto
```
Expected: the PR enters the merge queue (ruleset "Merge Queue Capacity Guard") and merges within one queue cycle. If `["kkroo"]` is empty, ping kkroo in the PR comment with the three-file summary and stop; do not self-merge a CODEOWNED change.

- [ ] **Step 5: Deploy to production and confirm the version**
```bash
gh workflow run scheduled-production-deploy.yml -R Blockcast/paperclip
sleep 60
gh run list -R Blockcast/paperclip --workflow scheduled-production-deploy.yml --limit 1 --json databaseId,status,conclusion
```
Run: the commands above, then `gh run watch -R Blockcast/paperclip <databaseId>`.  Expected: `conclusion: success`. Then confirm the served skill has the new text:
```bash
CID=aaced805-3491-4ee5-9b14-cdf70cb81d47
curl -sS "$PAPERCLIP_API_URL/api/companies/$CID/skills" -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  | jq -r '.[] | select(.key|test("evidence-before-in-review")) | "\(.id) \(.key) \(.slug)"'
```
Expected: one line `<uuid> <key> <slug>`. If empty, the skill is not registered as a company skill; use the list page in Step 6 and note it in the PR comment.

- [ ] **Step 6: Screenshot the rendered skill page at 1440x900**
The UI renders skills at `/<prefix>/skills/*` (ui/src/App.tsx:160, `CompanySkills`), with a detail route `/BLO/skills/<id|key|slug>` (ui/src/lib/company-skill-routes.ts). Use the chrome-devtools MCP tools from the user's signed-in Chrome:
1. `new_page` with `url: "https://paperclip.blockcast.net/BLO/skills/<slug-from-step-5>"`. Note the returned `pageId`.
2. `emulate` with `pageId` and `viewport: "1440x900x1"`.
3. `wait_for` with `pageId` and `text: ["Requesting privileged access"]`, `timeout: 20000`.
4. `take_screenshot` with `pageId`, `filePath: "/tmp/track-d/skill-page-1440x900.png"`.
5. `navigate_page` to `https://paperclip.blockcast.net/BLO/skills`, then `take_screenshot` to `/tmp/track-d/skill-list-1440x900.png`.
Run: `file /tmp/track-d/skill-page-1440x900.png`  Expected: `PNG image data, 1440 x 900`. If step 3 times out on a login screen, sign in once in that Chrome window and repeat from step 1. If Step 5 found no company skill, skip steps 1-4 and keep only the list screenshot, and state why in the comment.

- [ ] **Step 7: Post the screenshots and deploy proof to the PR**
```bash
PR=$(gh pr view -R Blockcast/paperclip track-d/skill-propagation --json number -q .number)
RUN=$(gh run list -R Blockcast/paperclip --workflow scheduled-production-deploy.yml --limit 1 --json databaseId,url -q '.[0].url')
gh pr comment -R Blockcast/paperclip "$PR" --body "Deployed: $RUN
Rendered skill page at 1440x900 after deploy (drag-and-drop the two PNGs from /tmp/track-d into this comment in the GitHub UI, or attach via the web editor):
- /tmp/track-d/skill-page-1440x900.png
- /tmp/track-d/skill-list-1440x900.png"
```
Run: the command above, then attach the PNGs by editing the comment in the browser (the `gh` CLI cannot upload images).  Expected: the comment shows the deploy run URL and two rendered images.

- [ ] **Step 8: Remove the worktree**
```bash
cd /Users/oramadan/src/github.com/blockcast/paperclip
git worktree remove /Users/oramadan/src/github.com/blockcast/paperclip-track-d
git branch -D track-d/skill-propagation
```
Run: `git worktree list`  Expected: the track-d path is gone.

- [ ] **PR evidence** (paste into the PR body per the user requirement; Step 1 builds most of it):
  - Rendered diff: `gh pr diff -R Blockcast/paperclip <PR>` output, plus the two verbatim inserted blocks from D2 Steps 6 and 7.
  - Six agent before/after `paperclipSkillSync` JSON pairs with the `envKeys before/after equal: yes` line each, from `/tmp/track-d/<id>.before.json` and `.after.json`.
  - Heartbeat proof: run ids and mention counts for Players Engineer and Release Engineer from `/tmp/track-d/<id>.run.json`, plus the 3-5 SessionStart log lines that list the skill.
  - `/tmp/track-d/assert_skill_docs.sh` output ending `PASS`.
  - Exact repro commands: `python3 scripts/ops/add-desired-skill.py <agent-id> --dry-run`, the `curl` invoke and log commands from D1 Steps 6-7.
  - Production deploy run URL and the two 1440x900 screenshots (skill page and skill list) as a post-merge PR comment.


## Track E: Elevation record correction and agent-request runbook

**Why this track** The earlier plan record called for a Paperclip TokenReview read-extension that the k8s side superseded on 2026-08-31 (BLO-30652). Nothing in Paperclip code needs to change: enforcement lives in the VAP, and the agent-side action is a request with the exact approver command. This track writes the corrected chain down where agents will find it, verifies the one real precondition with commands, and fixes the memory record. Verified during planning (2026-09-05): `admin_elevation` subjects are `oidc_user` refs, not system principals, so the brief's "register SAs as system principals" branch is a category error and is replaced below.

### Task E1: Agent elevation request runbook

**Files:**
- Create: `/Users/oramadan/src/github.com/blockcast/paperclip/docs/runbooks/agent-elevation-request.md`
- Read-only reference: `/Users/oramadan/src/github.com/blockcast/magma/orc8r/cloud/go/services/tenants/protos/approvals.proto`
- Read-only reference: `/Users/oramadan/src/github.com/blockcast/magma/orc8r/cloud/go/services/tenants/servicers/protected/approvals_servicer.go:212-232`
- Read-only reference: `/Users/oramadan/src/github.com/blockcast/magma/orc8r/cloud/go/tools/break_glass_cli/handlers/grant.go`, `list.go`
- Test: none (docs only). Verification is the command steps below.

**Interfaces:**
- Consumes: FACTS elevation chain (ApprovalsService, controller, ElevationGrant, `bc-active-elevations`, VAP `bc-protected-secret-write`); `break_glass_cli grant --kind admin_elevation`; `request_board_approval` approval type; PlatformSREEngineer `d6f327a4-f2f2-4a83-bc5a-173d993cf9b6`; Paperclip API `$PAPERCLIP_API_URL`, `$PAPERCLIP_API_KEY`, `$PAPERCLIP_COMPANY_ID`.
- Produces: runbook heading `## Request template` (Track D2 embeds this text verbatim in its `request_board_approval` payload); runbook heading `## Verification log`; optionally one Paperclip issue identifier `BLO-<n>` recorded in that log.

- [ ] **Step 1: Branch from origin/master**
```bash
cd /Users/oramadan/src/github.com/blockcast/paperclip
git fetch origin master
git checkout -b docs/agent-elevation-request-runbook origin/master
```
Run: the block above.  Expected: `Switched to a new branch 'docs/agent-elevation-request-runbook'`.

- [ ] **Step 2: Verify the subject-kind category for admin_elevation**
```bash
cd /Users/oramadan/src/github.com/blockcast/magma
grep -rn "ListSystemPrincipals\|system_principal" orc8r/cloud/go/services/tenants/protos/*.proto
```
Run: the block above.  Expected (verified 2026-09-05): zero matches for `ListSystemPrincipals`; matches only in `approvals.proto` at line 38 (`subject_ref is the SystemPrincipal sp_uuid` for break_glass), line 74 (`subject_kind='oidc_user'` for admin_elevation), and lines 112-113 (`subject_kind: 'system_principal' | 'oidc_user'`). Conclusion: no system-principal list RPC exists, and `admin_elevation` never uses `system_principal`. Do NOT file "Register Paperclip agent SAs as magma system principals". Paste this output into the runbook `## Verification log` in Step 5.

- [ ] **Step 3: Verify subject_ref accepts a k8s ServiceAccount username**
```bash
cd /Users/oramadan/src/github.com/blockcast/magma
sed -n 220,223p orc8r/cloud/go/services/tenants/servicers/protected/approvals_servicer.go
```
Run: the block above.  Expected (verified 2026-09-05):
```
	subjectRef := strings.TrimSpace(req.GetSubjectRef())
	if subjectRef == "" {
		return nil, status.Error(codes.InvalidArgument, "subject_ref is required")
	}
```
Only the empty check exists. `system:serviceaccount:paperclip:<sa-name>` is accepted as-is and stored with `subject_kind='oidc_user'`.

- [ ] **Step 4: Verify verbatim passthrough into bc-active-elevations (UNVERIFIED precondition)**
Requires an operator kubeconfig. Both Paperclip MCP SAs are forbidden from this read.
```bash
kubectl get elevationgrants.bcast.id -A \
  -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.subjectUserId}{"\t"}{.spec.expiresAt}{"
"}{end}'
kubectl -n bc-elevation get configmap bc-active-elevations -o jsonpath='{.data.subjects}{"
"}'
```
Run: the block above.  Expected: line-per-grant table, then one comma-separated `subjects` line. Branch on the result:
  - **A (verified):** at least one grant has `expiresAt` in the future and its `spec.subjectUserId` appears character-for-character in `subjects`. Passthrough is verbatim. Record both outputs in `## Verification log` and continue to Step 5 with status `verified`.
  - **B (transformed):** an active grant's `subjectUserId` appears in `subjects` only after a prefix, suffix, or mapping. Record both outputs, then file the issue in Step 4b and write `blocked on BLO-<n>` in the log.
  - **C (vacuous):** zero active grants, so the comparison proves nothing. File the issue in Step 4b and write `blocked on BLO-<n>` in the log.

- [ ] **Step 4b: File the blocker issue (branches B and C only)**
```bash
curl -sS -X POST "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/issues" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" -H "Content-Type: application/json" \
  -d @- <<'JSON'
{
  "title": "Confirm bc-elevation-controller projects Paperclip SA subject_ref verbatim into bc-active-elevations",
  "priority": "high",
  "assigneeAgentId": "d6f327a4-f2f2-4a83-bc5a-173d993cf9b6",
  "description": "## Ask
Stage a two-approver `admin_elevation` grant for subject `system:serviceaccount:paperclip:bc-sa-paperclip` (reason `BLO-30652 passthrough check`), then paste:

1. `kubectl get elevationgrants.bcast.id -A -o jsonpath='{range .items[*]}{.metadata.name}{\"\\t\"}{.spec.subjectUserId}{\"\\t\"}{.spec.expiresAt}{\"\
\"}{end}'`
2. `kubectl -n bc-elevation get configmap bc-active-elevations -o jsonpath='{.data.subjects}{\"\
\"}'`

Done when: the subject_ref appears character-for-character in `subjects`, or you document the exact transform so the agent request template can target the post-transform form.

## Why
magma `RecordAdminElevationApproval` accepts any non-empty `subject_ref` and stores `subject_kind='oidc_user'` (approvals.proto:74, approvals_servicer.go:220-223). `security/bc-elevation/source-of-truth.md` says `spec.subjectUserId` is the magma `subject_ref`. The ConfigMap derivation is controller code (ghcr.io/blockcast/bc-elevation-controller) and is the only unverified hop.

## Observed at filing
<paste Step 4 outputs here>"
}
JSON
```
Run: the block above.  Expected: HTTP 201 and a JSON body containing `"identifier":"BLO-<n>"`. If HTTP 400, print the body; it names the accepted keys, and the issue must be re-sent with those keys. Do not proceed past a non-201 without an identifier.

- [ ] **Step 5: Write the runbook**
```bash
cd /Users/oramadan/src/github.com/blockcast/paperclip
cat > docs/runbooks/agent-elevation-request.md <<'MD'
# Agent-requested admin elevation (BLO-30652 chain)

Status: authoritative for how a Paperclip agent asks for, and how operators
grant, a time-boxed write to a protected Secret. Source of truth for the k8s
side is `Blockcast/onprem-k8s` `security/bc-elevation/source-of-truth.md`
(revised 2026-08-31, BLO-30652). No Paperclip code participates in this chain.

## The chain

1. **magma tenants `ApprovalsService`** (`approvals` table) is the only source
   of truth. `RecordAdminElevationApproval(subject_ref, reason)` writes one row
   with `approval_kind='admin_elevation'`, `subject_kind='oidc_user'`. The
   approver identity is the caller's mTLS `mb_<uuid>` cert, never the body.
   A subject is **active** only when two rows with distinct `approver_mb_uuid`
   are unconsumed and unexpired.
2. **bc-elevation-controller** (`replicas:1`, `--enable-reconcile`, image
   v0.4.0) polls magma over mTLS and mints an `ElevationGrant` CR
   (`spec.subjectUserId` = the magma `subject_ref`, `elevatedGroups`, `reason`,
   `requestedBy`, `approvedBy`, `approvalIds`, `grantedAt`, `expiresAt`, at
   most 1h). It deletes or shortens the grant when quorum drops.
3. **ConfigMap `bc-elevation/bc-active-elevations`**: the controller writes
   `data.subjects`, a comma-separated list of k8s usernames derived from active
   grants.
4. **ValidatingAdmissionPolicy `bc-protected-secret-write`** reads that
   ConfigMap as a parameter and admits a protected-Secret write only when
   `request.userInfo.username in variables.elevatedSubjects.split(',')`.

A Paperclip agent's k8s username is literally
`system:serviceaccount:paperclip:<sa-name>`. The two MCP identities are
`system:serviceaccount:paperclip:bc-sa-paperclip` and
`system:serviceaccount:paperclip:paperclip-k8s-mcp-ns-rw`. The request must
name the SA that will actually perform the write.

## Why the TokenReview read-extension was superseded

The June design had Paperclip's TokenReview webhook read `ElevationGrant`
objects and add a group to the caller. Two structural facts killed it:

1. The apiserver authenticates with `--authentication-config` JWT
   authenticators only. A token webhook never sees Dex JWTs, so it cannot
   annotate the identity that the policy sees.
2. Enforcement moved to the authorization plane. The VAP reads
   `bc-active-elevations` `subjects`; it does not consult groups minted by
   any webhook.

Nothing in `server/src` needs an ElevationGrant reference. Do not reopen that
work item.

## Agent procedure: ask, do not poll

1. Post a `request_board_approval` whose body is the template below, filled
   in. Approvers get the exact command; nothing is left to interpretation.
2. Wait for the approval to be resolved. Do not poll ElevationGrants: both
   Paperclip MCP SAs are forbidden from `list elevationgrants.bcast.id`, by
   design.
3. Perform the single protected write. Success of the write is the only
   signal the grant is live. A `403` with the VAP message means quorum is not
   yet active or has expired; re-check the approval thread, do not retry in a
   loop.
4. Comment the write result and the UTC timestamp on the originating issue.

## Request template

Copy verbatim, replace every `<...>`:

```text
Elevation request (admin_elevation, <=1h)

Subject (k8s username): system:serviceaccount:paperclip:<sa-name>
Target: <namespace>/<secret-name> (<one-line what changes>)
Issue: BLO-<n>
Reason: <one sentence; this text is stored in magma and audited>
Window needed: <minutes, max 60>

Approvers (two distinct operators, each with their own mb_<uuid> cert):

  break_glass_cli grant --kind admin_elevation \
    --subject system:serviceaccount:paperclip:<sa-name> \
    --reason "BLO-<n>: <same reason>" \
    --addr tenants.controller.magma.local:9079 \
    --cert-file <your operator mb_<uuid> cert> \
    --key-file <your operator key> \
    --ca-file <ca bundle>

  Second call prints `active_distinct_approvers: 2` and `active: true`.
  Same-approver repeat returns AlreadyExists; that is expected.

Agent will: run exactly one write, then post the result here.
```

## Approver procedure

1. Confirm the subject and target match the issue. Refuse if the reason is
   generic or the subject is not a Paperclip SA the issue names.
2. First approver runs the `grant` command from the request. Expected output
   starts `✓ approval granted` with `active_distinct_approvers: 1` and
   `active: false`.
3. Second approver runs the same command with **their own** `mb_<uuid>` cert.
   Expected `active_distinct_approvers: 2`, `active: true`. A second call from
   the first approver fails with AlreadyExists and does not count.
4. Optional check:
   `break_glass_cli list --kind admin_elevation --subject system:serviceaccount:paperclip:<sa-name> --addr tenants.controller.magma.local:9079 --cert-file ... --key-file ... --ca-file ...`
   shows two active rows with distinct `approver_mb_uuid`.
5. Resolve the `request_board_approval` with the grant timestamps.

## Expiry

`ElevationGrant.spec.expiresAt` is the minimum `expires_at` among the two
quorum rows and never exceeds 1h. Both approvals must be active at the same
time; coordinate the two `grant` calls closely. When either row expires or is
consumed, the controller removes the subject from `bc-active-elevations` on
its next reconcile and the VAP denies again. No renewal path exists; a new
window is a new request.

## Observability limitation

Agents cannot observe grant state. `bc-sa-paperclip` and
`paperclip-k8s-mcp-ns-rw` are both forbidden from listing
`elevationgrants.bcast.id`, and the controller Role holds no `list`/`watch`
on the ConfigMap either. The agent learns success only because the write
succeeds. Treat a denied write as "not yet" and go back to the approval
thread; never widen RBAC to make grants visible to agents.

## Superseded recommendation

The 2026-09-04 gap analysis recommended "Edit 2: TokenReview read-extension"
in Paperclip. That recommendation was wrong for the two reasons in the
section above. It is withdrawn; this runbook replaces it.

## Tracked elsewhere (not part of this runbook)

- `Blockcast/onprem-k8s#3060`: kyverno `bc-elevation-image-policy` to
  ImageValidatingPolicy (open).
- `bc-elevation-token-refresher` is `suspend: true`.
- Audit-sink cutover: the magma producer must emit request, first-approval,
  and second-approval events before the sink is authoritative.
- Verbatim `subject_ref` passthrough into `bc-active-elevations`: see
  Verification log.

## Verification log

<Step 2 grep output>

<Step 3 sed output>

<Step 4 kubectl outputs; status: verified | blocked on BLO-<n>>
MD
```
Then replace the three `<Step ...>` placeholders with the literal outputs from Steps 2 to 4 (and 4b if filed).
Run: `grep -c "<Step" docs/runbooks/agent-elevation-request.md`  Expected: `0`.

- [ ] **Step 6: Commit**
```bash
cd /Users/oramadan/src/github.com/blockcast/paperclip
git add docs/runbooks/agent-elevation-request.md
git commit -m "docs(runbooks): add agent elevation request runbook and withdraw the TokenReview read-extension"
```
Run: the block above.  Expected: one file changed, commit hash printed.

- [ ] **Step 7: Open the PR and enqueue merge**
`docs/runbooks/**` is not in CODEOWNERS, so Ally review plus the `verify` check is sufficient.
```bash
cd /Users/oramadan/src/github.com/blockcast/paperclip
git push -u origin docs/agent-elevation-request-runbook
gh pr create -R Blockcast/paperclip --base master \
  --title "docs(runbooks): agent elevation request runbook (BLO-30652 chain)" \
  --body-file /tmp/e1-pr-body.md
gh pr merge --squash --auto -R Blockcast/paperclip
```
Run: the block above after writing `/tmp/e1-pr-body.md` per Step 8.  Expected: PR URL printed; `gh pr merge` prints `Pull request #<n> will be automatically merged via squash when all requirements are met`. If `gh pr merge` reports BEHIND, run `gh pr update-branch <n> -R Blockcast/paperclip` and re-run the merge command.

- [ ] **Step 8: PR evidence**
Write `/tmp/e1-pr-body.md` with, in this order:
1. One paragraph: what changed and why (no code, docs only, no UI or API surface).
2. Fenced output of Step 2 (`grep` over `approvals.proto`) proving `admin_elevation` is `oidc_user`.
3. Fenced output of Step 3 (`sed -n 220,223p`) proving no subject format check.
4. Fenced output of Step 4 (both `kubectl` commands) with the branch letter A, B, or C stated, and the `BLO-<n>` identifier if Step 4b ran.
5. Rendered preview link: `https://github.com/Blockcast/paperclip/blob/<head-sha>/docs/runbooks/agent-elevation-request.md` where `<head-sha>` is `git rev-parse HEAD`.
6. `git diff --stat origin/master...HEAD` output.

### Task E2: Correct the memory record

**Files:**
- Modify: `/Users/oramadan/.claude/projects/-Users-oramadan-src-github-com-blockcast-magma/memory/project_paperclip_human_gate_structural_gaps.md:25-31`
- Test: `grep` assertions below.

**Interfaces:**
- Consumes: runbook path from Task E1 (`docs/runbooks/agent-elevation-request.md`); FACTS bridge items (`onprem-k8s#3060`, token-refresher `suspend:true`, audit-sink cutover).
- Produces: corrected item 3 text that later sessions read via MEMORY.md.

- [ ] **Step 1: Confirm the current text to replace**
```bash
sed -n 25,31p /Users/oramadan/.claude/projects/-Users-oramadan-src-github-com-blockcast-magma/memory/project_paperclip_human_gate_structural_gaps.md
```
Run: the block above.  Expected: item 3 beginning `3. **bc-elevation bridge is half-built.**` and ending `Both MCP SAs are forbidden from listing ElevationGrants.` If the line range has shifted, locate it with `grep -n "bc-elevation bridge is half-built"` and use those lines instead.

- [ ] **Step 2: Replace item 3**
Replace the whole item 3 block (lines from Step 1) with exactly:
```markdown
3. **bc-elevation bridge: k8s side complete, Paperclip side needs NO code.** Chain: magma
   `ApprovalsService` (`admin_elevation`, `subject_kind='oidc_user'`, two distinct `approver_mb_uuid`)
   → `bc-elevation-controller` (`replicas:1 --enable-reconcile`) → `ElevationGrant` → ConfigMap
   `bc-elevation/bc-active-elevations` `subjects` → VAP `bc-protected-secret-write`
   (`request.userInfo.username in elevatedSubjects`). **The 2026-09-04 recommendation "Edit 2:
   TokenReview read-extension" was WRONG:** superseded 2026-08-31 (BLO-30652) because (a) the
   apiserver uses `--authentication-config` JWT authenticators only, so a token webhook never sees
   Dex JWTs, and (b) enforcement is on the authorization plane via the ConfigMap, not groups.
   Also wrong: "register Paperclip SAs as system principals". `system_principal` is the break_glass
   subject kind; `admin_elevation` accepts any non-empty `subject_ref` (approvals_servicer.go:220).
   Agent action = `request_board_approval` carrying the exact `break_glass_cli grant --kind
   admin_elevation --subject system:serviceaccount:paperclip:<sa>` command; runbook
   `Blockcast/paperclip docs/runbooks/agent-elevation-request.md`. Agents cannot list
   ElevationGrants (correct). Tracked elsewhere, not in this plan: `onprem-k8s#3060` (kyverno →
   ImageValidatingPolicy), `bc-elevation-token-refresher` `suspend:true`, audit-sink cutover (magma
   producer must emit request/first/second approval events). Still unverified: verbatim
   `subject_ref` passthrough into `bc-active-elevations` (see runbook Verification log).
```
Run:
```bash
f=/Users/oramadan/.claude/projects/-Users-oramadan-src-github-com-blockcast-magma/memory/project_paperclip_human_gate_structural_gaps.md
grep -c "TokenReview read-extension\" was WRONG" "$f"; grep -c "never implemented though spec'd" "$f"; grep -c "onprem-k8s#3060" "$f"
```
Expected: `1`, `0`, `1`.

- [ ] **Step 3: Commit**
The memory directory is not a git repository (verified 2026-09-05: `git -C <dir> rev-parse --is-inside-work-tree` → `fatal: not a git repository`). There is no commit. Persistence check instead:
```bash
sed -n 1,6p /Users/oramadan/.claude/projects/-Users-oramadan-src-github-com-blockcast-magma/memory/project_paperclip_human_gate_structural_gaps.md
```
Run: the block above.  Expected: frontmatter intact, `name: project-paperclip-human-gate-structural-gaps` on line 2. The MEMORY.md index line ("half-built bc-elevation bridge") stays accurate and is not edited.


---

## Not in scope

- Closing the 9 obsolete human-held issues (BLO-7708, 7854, 7943, 10683, 11832, 16176, 13077, 12786, 12640). Cancelling is the board's call; each is flagged in its comment.
- Flipping unlabeled `warn` to `block` unconditionally. Task B7 ships the flag and the measurement; the flip is a one-line values change after seven days of data.
- The three remaining elevation bridge items: onprem-k8s#3060, the suspended token-refresher, the audit-sink cutover. Tracked in onprem-k8s.
- Upstream sync of the paperclip fork.

## Open decisions

None. Every decision is recorded inline where it applies.
