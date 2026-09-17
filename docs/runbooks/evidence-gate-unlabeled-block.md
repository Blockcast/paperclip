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

## What the flag does and does not govern

| shape | satisfiable when entering `in_review`? | flag makes it blocking? |
|---|---|---|
| `review:ally-clean` | yes — a PR may be open, at head, 0 Critical / 0 Important | **yes**, unless suppressed (below) |
| `review:ally-clean`, no linked PR | **never** — there is no head to review | **no, at any value** |
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
  than `deploy:landed`, which at least becomes satisfiable on merge. This is
  also why it is not the unlabeled path's job to enforce it: that path exists
  to cover doc-only and refactor issues, which by design have no PR. CTO
  ruling 2026-09-16. If we ever want "code work must have a PR", that is an
  explicit requirement on a labeled path, decided on its own merits.

This is what retired the old flip criterion about `harness_liveness_escalation`
origins and BLO-24843: those issues have no PR by design and would have 422'd
forever. The code now covers the general case, so the operator does not have to
remember the instance.

## Before anything: two baselines, both on the day the truth shapes deploy

**1. Issues whose linked PR the webhook never saw.** These read
`no-linked-pull-request` and can never pass until the Task B10 backfill runs.

```bash
curl -sS -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/issues?status=in_review&limit=500" \
| jq '[.[] | select(.lastEvidenceVerdict.diagnostics // [] | index("no-linked-pull-request"))] | length'
```

Record it in BLO-3202. Run `scripts/ops/backfill-pr-work-products.mjs`
(needs **Node >= 22.18** — it imports a `.ts` module and relies on built-in
type stripping; Node 20 throws `ERR_UNKNOWN_FILE_EXTENSION`), re-measure,
expect near zero.

> **Two different literals, both real — do not "reconcile" them.** The verdict
> array is `[...evaluation.diagnostics, ...truthDiagnostics]`
> (`evidence-gate-wiring.ts`), so it carries both of these at once and they
> answer different questions:
>
> - `no-linked-pull-request` — bare, pushed by the **probe**
>   (`evidence-truth.ts`) whenever it finds no linked PR. Emitted on every
>   path and at every flag value, including labeled issues that never reach
>   the unlabeled escalation. This is the one the jq above wants: the backfill
>   population is "has no linked PR", not "was suppressed".
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
(`server/src/services/agent-scorecards.ts:116`). Every issue that reaches
`in_review` without a merged, Ally-clean PR now records `warn` where it used to
record `pass`, so **every agent's `reviewPassRate` steps down on deploy day for
reasons unrelated to agent behaviour**. Capture the pre-deploy numbers or the
step reads as a fleet-wide regression a week later:

```bash
curl -sS -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/agent-scorecards" \
| jq '[.[] | {agentId, reviewedIssues, passedReviews, reviewPassRate}]'
```

## Measure daily for seven days

```bash
curl -sS -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/issues?status=in_review&limit=500" \
| jq '[.[] | select(.lastEvidenceVerdict != null)] | {
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
    probeFailed: map(select(.lastEvidenceVerdict.diagnostics // [] | map(startswith("github-truth-probe-failed")) | any)) | length }'
```

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
  The gate suppresses them permanently at every flag value (CTO ruling
  2026-09-16, `unlabeled-truth-block-suppressed:no-linked-pull-request`), so
  they are not blast radius. Track the number anyway — a rising `noPr` on
  code-bearing issues means PRs are not being linked, which is a real defect
  with a different owner.

`onlyTruthMissing` remains a safe upper bound on `willBlock`; since the registry
change its only excess is the two suppressed populations.

## Flip criterion

Seven consecutive days with **all** of:

- `willBlock` below 2% of `total`;
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
`feat(evidence): enforce truth shapes for unlabeled issues` with the seven daily
rows in the body.

## Abort criterion — check daily after the flip

If `block` verdicts exceed 5% of `in_review` transitions on any day, or GitHub
reports an incident, set `"0"` and redeploy. Do not wait for a root cause: the
flag is the rollback. This is a daily *flow* against a different base than the
flip gate's stock (see above) — expect it to be noisier day to day, which is
why the flip gate carries margin rather than sitting at the same number.
