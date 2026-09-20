# Evidence gate: turning on the unlabeled truth block

`PAPERCLIP_EVIDENCE_UNLABELED_BLOCK` escalates the evidence gate's verdict from
`warn` to `block` when an issue entering `in_review` is missing **only** truth
evidence. Chart value: `evidenceGate.unlabeledTruthBlock` in
`deploy/helm/paperclip/values.blockcast.yaml`. Default `"0"`.

```
  off ──(7 clean days, baseline recorded)──────────────────► on
  on  ──(block rate > 5%/day, or a GitHub incident)──────────► off
```

No data migration is involved in either direction; the flip is a values change
plus a redeploy.

> **Precondition: [#1857](https://github.com/Blockcast/paperclip/pull/1857)
> (B2/B3/B5/B6/B7) must be on `master` and deployed before any number below
> means anything.** That PR is what registers `review:ally-clean` and
> `deploy:landed`, adds `evidence-truth.ts`, and teaches `loadConfig` to read
> `PAPERCLIP_EVIDENCE_UNLABELED_BLOCK`. Until then every symbol this runbook
> cites is absent and the shapes cannot enter `missing` — so the jq below still
> parses and still returns numbers, and **every one of them is structurally
> zero**. A zero `willBlock` from an uninstalled gate is indistinguishable from
> a clean one, which would satisfy the flip criterion on day one. The
> `total` > 0 guard on the measurement window exists to catch exactly that; do
> not open the window before checking it.

## What the flag does and does not govern

> **The name is narrower than the behaviour.** The env var says `UNLABELED`,
> but the escalation binds **any** truth-only gap — labeled or unlabeled. A
> labeled issue missing only `review:ally-clean` is escalated to `block` on the
> same path as an unlabeled one; the guard has no label test
> (`unlabeledTruthBlock && truthOnlyGap && blockableGap` in
> `server/src/services/evidence-gate.ts`, which says the same thing at
> `unlabeledTruthBlock`'s docstring). The name is kept because it is
> load-bearing in the Helm chart, this runbook and the measurement baseline.
>
> So the blast radius is **not** the unlabeled doc/refactor population alone.
> Six labeled arrays require `review:ally-clean` (`frontend`, `ui`,
> `cms-published`, `backend`, `db-migration`, `migration` in
> `evidence-shapes.ts`) — the code-completion labels, i.e. plausibly the
> dominant share. A `willBlock` count above the flip gate is not by itself
> evidence of an unlabeled-side problem; scope the investigation to both.

| shape | satisfiable when entering `in_review`? | flag makes it blocking? |
|---|---|---|
| `review:ally-clean` | yes — a PR may be open, at head, 0 Critical / 0 Important | **yes**, unless suppressed (below) |
| `review:ally-clean`, no linked PR | **never** — there is no head to review | **no, at any value**; unlabeled is not even required to have it |
| `deploy:landed` | **never** — it means merged | **no, at any value** |

The gate runs on exactly one transition, INTO `in_review`
(`doc/EVIDENCE_GATE.md` L3/L15). `deploy:landed` means the PR is merged, so it
cannot be satisfied at the only moment it is evaluated — no flag value can
change that, and the code does not let one
(`BLOCKABLE_TRUTH_SHAPES` in `server/src/services/evidence-gate.ts`).
`deploy:landed` is therefore **required nowhere** — not by any labeled array and
not by `DEFAULT_UNLABELED_REQUIRED` (CTO ruling 2026-09-17). It stays a
registered, detected shape, reported via `allDetected` rather than
`required`/`missing`, and it feeds the scorecards and the measurement below.
Keeping it required would have made `pass` unreachable for every labeled
code-completion issue and for the unlabeled majority, leaving merge-before-review
as the only route to `pass` — an inverted incentive, not a degraded metric.

Two populations are suppressed at every flag value, for two different reasons,
and the verdict names which one applied:

- `unlabeled-truth-block-suppressed:probe-failed` — we could not ask GitHub.
  The flag escalates only evidence the probe actually established; otherwise a
  GitHub outage becomes an estate-wide `in_review` freeze.
- `unlabeled-truth-block-suppressed:no-linked-pull-request` — the probe worked
  and the issue has no linked PR. `review:ally-clean` needs a head to review,
  so the shape is unsatisfiable by the assignee **forever** — a stronger case
  than `deploy:landed`, which at least becomes satisfiable on merge. CTO
  ruling 2026-09-16. If we ever want "code work must have a PR", that is an
  explicit requirement on a labeled path, decided on its own merits.

  **This diagnostic is now LABELED-only, and that is not a narrowing of the
  ruling but a strengthening of it.** On the **unlabeled** path a PR-less issue
  no longer reaches the escalation at all: the truth shapes are dropped from
  `required` outright, `missing` is empty, and the verdict is **`pass`** with
  `truth-shapes-not-required:no-linked-pull-request` instead
  (`prLessUnlabeledTruthDrop` in `evidence-gate.ts`, BLO-32239). Suppressing
  the escalation alone fixed the block hazard and left a metric one — the shape
  stayed in `missing`, so the verdict was a permanent `warn`, which
  `reviewPassRate` scores identically to `block` (see baseline 2 below).

  A **labeled** PR-less issue keeps the shape required and still lands here,
  because its assignee *can* satisfy it by opening a PR. The split is
  satisfiability, not blast radius. So both mechanisms are live over disjoint
  populations, and a labeled `noPr` issue is the one worth chasing: it means a
  code-bearing issue has no PR linked.

This is what retired the old flip criterion about `harness_liveness_escalation`
origins and BLO-24843: those issues have no PR by design and would have 422'd
forever. The code now covers the general case, so the operator does not have to
remember the instance.

## Before anything: two baselines, both on the day the truth shapes deploy

**Precondition: `PAPERCLIP_API_KEY` must hold `company_scope:read`.** Without it
the route filters the page **after** the 1000-row cap is applied
(`server/src/routes/issues.ts:8085-8088` — `svc.list` fetches at the clamped
limit, then `filterIssuesForActor` drops rows the actor may not read, and it is
the *filtered* array that is serialized at `:8140`). Two consequences, and the
first is the one that bites silently: a page cut at exactly 1000 in the database
arrives with **fewer** than 1000 rows, so every `truncated` guard below reads
`false` on a truncated page; and `total`, `willBlock`, `onlyTruthMissing`,
`noPr` and `probeFailed` are all scoped subsets reading as estate totals. The
server compensates for exactly this internally — the blocked-count pager at
`:8277-8286` tests the *unfiltered* `rows.length` for its stop condition — but
an external `curl` cannot see `rows.length`, so this is a property of the
credential, not something a better query can fix.

Confirm the key before day 1 — this must return a row for an issue assigned to
another agent:

```bash
curl -sS -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/issues?status=in_review&limit=1000" \
| jq '[.[] | select(.assigneeAgentId != null)] | {scopeOk: (length > 0), sampleAssignees: ([.[].assigneeAgentId] | unique | length)}'
```

`scopeOk: false`, or a `sampleAssignees` of 1 when you know several agents hold
`in_review` work, means the key is scoped — **stop and re-issue it.** Every
count below is a subset until it is.

**1. Issues whose linked PR the webhook never saw.** These read
`no-linked-pull-request`. A **labeled** one cannot reach `pass` until its PR is
linked — that is what the Task B10 backfill is for. An **unlabeled** one now
passes on its own (the shapes are not required without a head to review), so
this count is a backfill work-list, not a stuck-issue count; split it by
`labelIds` before reading it as either.

```bash
curl -sS -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/issues?status=in_review&limit=1000" \
| jq '{ truncated: (length >= 1000),
        noPr: [.[] | select(.lastEvidenceVerdict.diagnostics // [] | index("no-linked-pull-request"))] | length }'
```

**`truncated: true` means page it or narrow the status — do not record the
number.** The list route clamps to `ISSUE_LIST_MAX_LIMIT` (1000) and returns a
**bare array**: no total, no cursor, and no truncation header
(`server/src/services/issues.ts:7894-7902`). A full page is the only signal
there is, which is why this is a row-count check and not a header check — the
same check `scripts/ops/backfill-pr-work-products.mjs:133` makes for the same
reason. A header guard here would never fire. It is also only trustworthy on a
key with `company_scope:read` — see the precondition above.

Record it in BLO-3202. Then run the backfill — **it is dry-run by default**, so
it takes two invocations and only the second one writes:

```bash
node scripts/ops/backfill-pr-work-products.mjs            # review the proposed rows
node scripts/ops/backfill-pr-work-products.mjs --apply    # write them
```

(needs **Node >= 22.18** — it imports a `.ts` module and relies on built-in
type stripping; Node 20 throws `ERR_UNKNOWN_FILE_EXTENSION`). Read the
`would-create=` count on the dry run and the `created=` count on the apply; if
they disagree, something changed between the two passes. Then re-measure the
count above and expect near zero. Re-measuring after the dry run alone returns
the same number you started with — that is the script working as designed, not
a broken backfill and not a baseline you can discharge.

> **Two different literals, both real — do not "reconcile" them.** The verdict
> array is `[...evaluation.diagnostics, ...truthDiagnostics]`
> (`evidence-gate-wiring.ts`), so it carries both of these at once and they
> answer different questions:
>
> - `no-linked-pull-request` — bare, pushed by the **probe**
>   (`evidence-truth.ts`) whenever it finds no linked PR. Emitted on every
>   path and at every flag value, labeled or unlabeled. This is the one the jq
>   above wants: the backfill population is "has no linked PR", not "was
>   suppressed".
> - `unlabeled-truth-block-suppressed:no-linked-pull-request` — pushed by the
>   **evaluator** (`evidence-gate.ts`) only where escalation would otherwise
>   have fired. A strict subset.
>
> The matching is asymmetric on purpose. `index(...)` is an exact *element*
> match in jq, which is right for the bare fixed literal; `probe-failed` needs
> `startswith` because it is always emitted with a variable suffix
> (`github-truth-probe-failed:pull_request:<tag>:<error>`). Matching the
> prefixed spelling here would read **0** and make the backfill look
> unnecessary.

**2. The agent-scorecard pass rate, BEFORE the measurement window opens.**
`reviewPassRate = pass / (pass + warn + block)` counts `warn` as not-pass
(see `reviewPassRate` in `server/src/services/agent-scorecards.ts`). Every issue
that reaches
`in_review` without a merged, Ally-clean PR now records `warn` where it used to
record `pass`, so **every agent's `reviewPassRate` steps down on deploy day for
reasons unrelated to agent behaviour**. Capture the pre-deploy numbers or the
step reads as a fleet-wide regression a week later:

Two exemptions bound how far it steps down, and both exist because a shape no
correct behaviour can satisfy must not be scored: `deploy:landed` is required
nowhere (2026-09-17), and on the unlabeled path the truth shapes are not
required at all when there is no linked PR (BLO-32239). So a PR-less doc-only
issue still records `pass`. What steps down is work that *has* a PR and no clean
Ally review at head — which is the thing the shapes were added to measure.

```bash
curl -sS -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/agent-scorecards" \
| jq '[.[] | {agentId, reviewedIssues, passedReviews, reviewPassRate}]'
```

## Measure daily for seven days

**Before day 1, confirm the gate is actually installed.** The window is only
meaningful once #1857 is deployed, and the cheap check is that the measurement
is capable of producing a non-zero number at all:

- `total` > 0 — there is a standing `in_review` population carrying a verdict
  to measure; and
- `onlyTruthMissing + noPr + probeFailed` > 0 on at least one of the seven
  days — the truth shapes are registered and the probe is running.

All four of those reading 0 on day 1 is the signature of an **absent** gate,
not a quiet one: with the shapes unregistered, `missing` can never contain
`review:ally-clean`, so every counter below is zero by construction and the
flip criterion is met trivially. Do not start the window; check the deploy.

```bash
curl -sS -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/issues?status=in_review&limit=1000" \
| jq '{truncated: (length >= 1000)} + ([.[] | select(.lastEvidenceVerdict != null)] | {
    total: length,
    pass: map(select(.lastEvidenceVerdict.verdict=="pass")) | length,
    onlyTruthMissing: map(select((.lastEvidenceVerdict.missing|length)>0 and ((.lastEvidenceVerdict.missing - ["review:ally-clean","deploy:landed"])|length)==0)) | length,
    willBlock: map(select(
        (.lastEvidenceVerdict.missing|length)>0
        and ((.lastEvidenceVerdict.missing - ["review:ally-clean","deploy:landed"])|length)==0
        and (.lastEvidenceVerdict.missing|index("review:ally-clean"))
        and ((.lastEvidenceVerdict.diagnostics // []) | map(startswith("github-truth-probe-failed")) | any | not)
        and ((.lastEvidenceVerdict.diagnostics // []) | index("no-linked-pull-request") | not))) | length,
    noPr: map(select((.lastEvidenceVerdict.diagnostics // []) | index("no-linked-pull-request"))) | length,
    probeFailed: map(select(.lastEvidenceVerdict.diagnostics // [] | map(startswith("github-truth-probe-failed")) | any)) | length })'
```

**A day that comes back `truncated: true` is an unmeasured day, not a clean
one** — `total` and `willBlock` are both floors, and the cut falls on the wrong
side. With no `sortField` the list orders by priority then recency
(`issues.ts:2216-2221`), so the rows past the cap are the low-priority, stalest
`in_review` issues — exactly where an issue sits without a clean Ally review at
head. Truncation therefore under-samples `willBlock` harder than `total` and the
ratio reads *safer* than reality. It voids the install check above for the same
reason. Page it with `&offset=` or narrow the status, and do not count the day
until the page is complete. On a key without `company_scope:read` this flag
cannot fire at all — see the precondition above.

`willBlock` is the number that matters: it mirrors the escalation predicate in
`evidence-gate.ts` exactly — `truthOnlyGap && blockableGap`, minus the two
suppressions. Read it, not `onlyTruthMissing`.

Note what `blockableGap` is: `missing.some(s => BLOCKABLE_TRUTH_SHAPES.includes(s))`,
**not** an exact match. Since the 2026-09-17 registry change that distinction is
currently moot: `deploy:landed` is required nowhere, so it can never enter
`missing`, and a truth-only gap is therefore always exactly
`["review:ally-clean"]`. `willBlock` and `onlyTruthMissing` now differ **only**
by the two suppressed populations. The jq keeps subtracting both shapes anyway —
a no-op today, and the thing that stops this measurement going wrong if a future
registry re-requires `deploy:landed`.

Read the history here rather than re-deriving it, because the correct set has
changed once. An earlier draft measured `missing == ["review:ally-clean"]`
exactly, and that was backwards **under the registry as it then stood**: with
`deploy:landed` co-required, the exact set counted only the narrow
merged-PR-but-not-Ally-clean case and read ≈0 for seven days. Dropping
`deploy:landed` from `required` removed that trap, so the exact set is
well-defined again — but measure `willBlock` as written, not the exact set,
because only `willBlock` also subtracts the suppressions.

The two suppressed populations are broken out because they are different
problems:

- `probeFailed` — we could not ask GitHub. A tooling/outage number.
- `noPr` — the probe worked and the issue has no linked pull request at all.
  These can **never** satisfy `review:ally-clean`; there is no head to review.
  Never blast radius, at any flag value, but by two different mechanisms since
  BLO-32239: an **unlabeled** one is not required to have the shape and records
  `pass`; a **labeled** one keeps it required and is suppressed at the
  escalation (CTO ruling 2026-09-16,
  `unlabeled-truth-block-suppressed:no-linked-pull-request`). Track the number
  anyway, and **split it by label** — a rising labeled `noPr` means PRs are not
  being linked on code-bearing issues, which is a real defect with a different
  owner, while the unlabeled share is mostly the doc-only population this path
  exists for.

`onlyTruthMissing` remains a safe upper bound on `willBlock`; since the registry
change its only excess is the two suppressed populations.

## Flip criterion

Seven consecutive days with **all** of:

- every day's page complete — `truncated: false`. A truncated day does not
  count toward the seven and is not a failure either; it is unmeasured, and the
  window pauses until you re-measure it completely. Same standard as the seven
  all-zero rows below: a number you cannot see all of is not a clean number;
- the install check above still passing — `total` > 0 every day, and
  `onlyTruthMissing + noPr + probeFailed` > 0 on at least one of the seven.
  Seven all-zero rows are not a clean gate, they are an absent one;
- `willBlock` below 2% of `total`, **or** `willBlock` of 0 on a `total` under
  50 — below that the percentage is arithmetically "must be 0" (2% of 50 is one
  issue), so state the floor rather than letting a single slow-to-review PR read
  as a broken gate;
- `probeFailed` below 2% of `total`;
- the landing routine merged every candidate it selected.

**Why 2% against a 5% abort trigger, and not 10%.** `willBlock` *is* the
predicted post-flip `block` count — that is the whole point of the number — so
any flip threshold at or above the abort trigger authorises a flip that trips
the abort on day one, and the abort says not to wait for a root cause. The
operator would follow this runbook correctly and land back where they started,
having spent a deploy and a rollback. The two numbers are also measured against
**different bases**: `willBlock / total` is a *stock* (the standing `in_review`
population carrying a verdict), while the abort's `block / in_review
transitions` is a *daily flow*, which is noisier and can exceed the stock rate
on a slow day. Equal thresholds would leave no margin for that. 2% is the
tolerance this runbook already uses for `probeFailed`, so there is one number to
remember rather than three.

Then set `unlabeledTruthBlock: "1"` and open
`feat(evidence): enforce review:ally-clean on truth-only gaps (labeled and
unlabeled)` with the seven daily rows in the body. Do not describe the flip as
unlabeled-only in the permanent record — see the scope note at the top.

## Abort criterion — check daily after the flip

If `block` verdicts exceed 5% of `in_review` transitions on any day, or GitHub
reports an incident, set `"0"` and redeploy. Do not wait for a root cause: the
flag is the rollback. This is a daily *flow* against a different base than the
flip gate's stock (see above) — expect it to be noisier day to day, which is
why the flip gate carries margin rather than sitting at the same number.
