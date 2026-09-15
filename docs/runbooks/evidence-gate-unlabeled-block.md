# Evidence gate: turning on the unlabeled truth block

`PAPERCLIP_EVIDENCE_UNLABELED_BLOCK` escalates the evidence gate's verdict from
`warn` to `block` when an issue entering `in_review` is missing **only** truth
evidence. Chart value: `evidenceGate.unlabeledTruthBlock` in
`deploy/helm/paperclip/values.blockcast.yaml`. Default `"0"`.

```
  off ──(7 clean days, baseline recorded, BLO-24843 handled)──► on
  on  ──(block rate > 5%/day, or a GitHub incident)──────────► off
```

No data migration is involved in either direction; the flip is a values change
plus a redeploy.

## What the flag does and does not govern

| shape | satisfiable when entering `in_review`? | flag makes it blocking? |
|---|---|---|
| `review:ally-clean` | yes — a PR may be open, at head, 0 Critical / 0 Important | **yes** |
| `deploy:landed` | **never** — it means merged | **no, at any value** |

The gate runs on exactly one transition, INTO `in_review`
(`doc/EVIDENCE_GATE.md` L3/L15). `deploy:landed` means the PR is merged, so it
cannot be satisfied at the only moment it is evaluated — no flag value can
change that, and the code does not let one
(`BLOCKABLE_TRUTH_SHAPES` in `server/src/services/evidence-gate.ts`).
`deploy:landed` stays a detected/missing shape that feeds the scorecards and
the measurement below. A probe that failed (`probeFailed`) always stays `warn`:
the flag escalates only evidence the probe actually established.

## Before anything: two baselines, both on the day the truth shapes deploy

**1. Issues whose linked PR the webhook never saw.** These read
`no-linked-pull-request` and can never pass until the Task B10 backfill runs.

```bash
curl -sS -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/issues?status=in_review&limit=500" \
| jq '[.[] | select(.lastEvidenceVerdict.diagnostics // [] | index("no-linked-pull-request"))] | length'
```

Record it in BLO-3202. Run `scripts/ops/backfill-pr-work-products.mjs`,
re-measure, expect near zero.

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
    onlyAllyCleanMissing: map(select(.lastEvidenceVerdict.missing == ["review:ally-clean"])) | length,
    probeFailed: map(select(.lastEvidenceVerdict.diagnostics // [] | map(startswith("github-truth-probe-failed")) | any)) | length }'
```

`onlyAllyCleanMissing` is the set the flip actually converts to `block`;
`onlyTruthMissing` is the wider set and is the conservative number to read.

## Flip criterion

Seven consecutive days with **all** of:

- `onlyTruthMissing` below 10% of `total`;
- `probeFailed` below 2% of `total`;
- the landing routine merged every candidate it selected;
- BLO-24843 resolved, **or** issues with origin `harness_liveness_escalation`
  excluded from the block — they have no PR by design and would 422 forever.

Then set `unlabeledTruthBlock: "1"` and open
`feat(evidence): enforce truth shapes for unlabeled issues` with the seven daily
rows in the body.

## Abort criterion — check daily after the flip

If `block` verdicts exceed 5% of `in_review` transitions on any day, or GitHub
reports an incident, set `"0"` and redeploy. Do not wait for a root cause: the
flag is the rollback.
