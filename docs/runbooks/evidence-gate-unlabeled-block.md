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
| `review:ally-clean` | yes — a PR may be open, at head, 0 Critical / 0 Important, **and authored by someone other than the reviewer** | **yes**, unless suppressed (below) |
| `review:ally-clean`, no linked PR | **never** — there is no head to review | **no, at any value**; unlabeled is not even required to have it |
| `review:ally-clean`, PR authored by the reviewer App | **never** — the only identity that attests it is the one that authored it | **no, at any value** — suppressed `reviewer-authored-pr` since PEN-4265. Still REQUIRED, so it stays in `missing` and the verdict stays `warn`; see below |
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

### A THIRD unsatisfiable population — and it is the one the flag does NOT suppress

Both suppressions above were chosen on a **satisfiability** test: a shape the
assignee can never satisfy is a stall amplifier, not a gate. A third population
fails that same test and is **not** suppressed, so it arrives in `willBlock`
indistinguishable from a real evidence gap.

`review:ally-clean` requires the attestation to come from someone who is **not**
the PR author, on *both* surfaces:

- formal review —
  `formalClean = !githubSameActorLogin(formalAttestingReview.login, prAuthorLogin)`
  (`server/src/services/evidence-truth.ts`);
- comment — the `githubSharesReviewerIdentity(prAuthorLogin, reviewerBotLogin)`
  branch of `evaluateCommentReviewGate`
  (`server/src/services/pr-comment-review-gate.ts`), which returns the withheld
  positive (`not_evaluated`, `headAttested: true`) for "the only comment
  attesting this head is the PR author's own".

Every agent-opened PR in this estate is authored by the shared GitHub App, and
Ally reviews as that same App, so the two logins are equal and the shape is
unreachable **however clean the review is**. The comment surface uses the
*loose* predicate deliberately, so the bare `allyblockcast` user seat does not
escape it either: the seat and the App are one agent wearing two hats.

This is not a defect report. It is the KNOWN CONSEQUENCE `evidence-truth.ts`
records at the independence guard (BLO-34969), in those words, together with the
conclusion this section exists to make operational:

> the flag is UNFLIPPABLE for that population until the shape is de-required for
> it, and that de-requiring is the flip's own work.

**Nothing is blocked by this today, and that is the whole reason it is easy to
miss.** A gap made only of truth shapes is demoted to `warn` by `truthOnlyGap`
(`evidence-gate.ts`), which has **no label test** — so an agent-authored issue
carrying `frontend` or `backend` lands at `warn` exactly like an unlabeled one.
(A *mixed* gap is untouched and still blocks, on its other shapes; what is
demoted is the gap made only of truth shapes.) The entire exposure is the flip.

**The merge-visible surface stays green on exactly this state, which is why the
gap is invisible until the flip.** Both gates run the SAME
`evaluateCommentReviewGate` function over the SAME inputs and differ only in
which field they key on. (Not a shared object: `evidence-truth.ts:316`/`:363`
call it themselves, separately from the merge gate's publisher. The argument
rests on same-function-same-inputs, not on one verdict being handed between
them.) The merge gate keys on `state`, which is `success` here, so
`gate/ally-comment-findings` publishes non-red (`neutral` as a check run) and
`ci/ally-head-attested` still fires, deliberately, so heavy CI does not starve
on every App-authored PR. The evidence shape keys on `outcome`, which is
`not_evaluated` rather than `clean`, so the shape is absent. Measured on #2806
at head `006d374e` — commits lane-authored `ux-designer@paperclip.blockcast.net`,
PR authored by the App — `gate/ally-comment-findings` describes itself as *"The
only comment attesting this head is the PR author's own; nothing independent
reviewed it"* and is **green**, while `review:ally-clean` on the linked issue is
**missing**. Nothing on the PR tells a reviewer that the `in_review` transition
would 422 after the flip.

**Do not reach for the commit-author lane as the fix without reading why it was
refused.** A per-lane discriminator exists and is already wired into this module
(`prAuthorLane` / `fetchCommitAuthorEmail`, BLO-43550), and on #2806 it resolves
cleanly. But `evidence-truth.ts` evaluated exactly that as "option 2" for the
independence check and refused it: the git author says who wrote the CODE, and a
review is not a commit, so against the shape this guard exists for — an
implementing agent writing its own consolidated-review body — a code-author test
returns "independent" and credits the fabrication. The lane is correct for the
ledger-retirement path and must stay out of the clean path.

**What it means for this runbook.** The flip criterion below reads `willBlock`
as predicted post-flip blocks on work that *should* have been reviewed. On an
agent-authored PR the same number counts a design decision instead, and no agent
behaviour and no amount of waiting moves it. So:

- **`willBlock` is not comparable across author types.** Segment it before
  reading it against the 2% gate — see the measurement section.

### RULED 2026-10-18 (CTO, PEN-4265) — suppressed, not de-required

The decision this section deferred has landed, and the two bullets it used to
carry (*"do not open the seven-day window expecting it to close"* and *"the
de-requiring decision comes first"*) are **retired**. The population is now
suppressed, so the window CAN close. What replaced them:

**`evidence-gate.ts` carries a third suppression arm,
`unlabeled-truth-block-suppressed:reviewer-authored-pr`,** beside `probe-failed`
and `no-linked-pull-request`. It fires when the probe establishes that the whole
linked set's missing `review:ally-clean` is attributable to the reviewer
identity authoring the PRs (`reviewerAuthoredPr` on `TruthProbeResult`, read off
the typed `authorIsReviewer` marker the comment gate now sets).

**The shape was NOT de-required, and that is the decision rather than an
omission.** Dropping it from `required` would empty `missing` and yield a
`pass` — asserting "independently reviewed, clean" for a population where the
attestation is self-issued, and retiring the only required anti-fabrication
shape (BLO-32239) for exactly the agents it was added to police. Suppression
keeps the shape in `missing`, so the verdict stays `warn` and the gap stays
visible and honest.

**Three consequences for this runbook:**

- **The 2% gate now measures what it was written about.** The agent-authored
  share is suppressed, so it can no longer put the window out of reach. The
  author-type segmentation below is still worth reading — it tells you how much
  of your `onlyTruthMissing` is the suppressed population — but it is no longer
  a precondition for opening the window.
- **`willBlock` must be computed from the verdict's own diagnostics, not from
  `missing`.** A suppressed row still carries `review:ally-clean` in `missing`;
  what makes it a non-block is the `unlabeled-truth-block-suppressed:*`
  diagnostic. Counting `missing` alone now over-counts `willBlock` by the whole
  agent-authored population.
- **`reviewPassRate` stays depressed for agent work and that is expected.**
  `agent-scorecards.ts` counts `warn` and `block` alike as not-pass, so every
  agent carries this until PEN-4275 lands. It is uniform across agents, so it
  moves the level and not the ranking — do not read it as a per-agent
  regression, and do not "fix" it by de-requiring the shape.

The structural fix — giving agents a PR author identity distinct from the
reviewer's — is **PEN-4275**. It needs no un-wiring here: the suppression keys
on a live per-issue fact, so the day that lands `reviewerAuthoredPr` goes false
by itself and the shape binds again with no edit to this runbook or to
`evidence-gate.ts`.

**Measured 2026-10-18** against company `b1d3f3d3`, status `in_review`, complete
page of 55 rows, `company_scope:read` confirmed (6 distinct assignees):

| | count | share of 55 |
|---|---|---|
| `willBlock` | 6 | **10.9%** — flip gate is < 2% |
| …whose linked PR is authored by `allyblockcast[bot]` (type `Bot`) | **6** | **100% of `willBlock`** |
| rows with `review:ally-clean` detected | 1 | 1.8% |
| `probeFailed` | 5 | 9.1% — its own gate is < 2% |
| `block` verdicts today | 0 | — |

The single detection is the control, and it comes out the other way: the one row
where the shape fired has a linked set including human-authored (`kkroo`, type
`User`) PRs, its two newest merged. All six non-detections are
`allyblockcast[bot]`. One company is a sample and not the estate — re-measure
before quoting it — but it is enough to say the flip gate is not within reach
today, and that review latency is not why.

> **And 10.9% is a FLOOR, for a reason that applies to every number this runbook
> asks for.** `lastEvidenceVerdict` is written only on a PATCH carrying
> `status: "in_review"`, so a long-standing `in_review` row still carries
> whatever verdict it got when it entered — on this page, 23 of the 55 were last
> evaluated in August or September, i.e. at or before the shapes' own
> registration, which makes them structurally incapable of entering `willBlock`.
> They dilute the denominator and nothing else. Restricted to rows whose verdict
> was evaluated this month the same six are **18.8% of 32**; restricted to the
> last seven days, **21.4% of 28**. Like truncation, verdict staleness biases the
> ratio *safe*, so a whole-page ratio under the gate is weaker evidence than it
> looks. Report the restricted window beside it.

This is what retired the old flip criterion about `harness_liveness_escalation`
origins and BLO-24843: those issues have no PR by design and would have 422'd
forever. The code now covers the general case, so the operator does not have to
remember the instance.

### RULED 2026-10-23 (CTO, PEN-4539) — a `done` row's verdict is not a statement about its closure

The blockquote above gives one half of this field's contract. Here is the other
half, and it is the half that costs operator time.

**The mechanism.** `lastEvidenceVerdict` is written on a PATCH carrying
`status: "in_review"` (`server/src/services/issues.ts:11552`, refreshed on
*every* such PATCH since BLO-19047 — including `in_review` → `in_review`) **or**
on a PATCH that edits labels while the row is already `in_review`
(`issues.ts:11530-11532`, `nextLabelIds !== undefined && existing.status === "in_review"`).
Both are discrete writes, not a continuous subscription. The `done` path has
exactly one refresh and it sits **inside** the blocking branch:

```js
// server/src/services/issues.ts:11378
if (experimental.enableDoneExecutionGate && shouldBlockNarratedDone(doneGateInput)) {
  …  doneTransitionEvidenceVerdict = await runEvidenceGate(…)
}
// :11448 — the write happens only if that ran
if (doneTransitionEvidenceVerdict) { patch.lastEvidenceVerdict = … }
```

Two independent reasons it almost never runs: the refresh is deliberately lazy
(the in-code comment at `:11359` states both expensive lookups run *"ONLY once
the cheap checks have already decided to block, so the ordinary update path is
unaffected"*), and `enableDoneExecutionGate` **defaults to `false`**
(`server/src/services/instance-settings.ts:228,261`). On a default instance an
unblocked `done` transition therefore never refreshes, and the row closes
carrying whatever its last `in_review` evaluation left, or nothing at all.

**This is not a defect in the write path.** The field's contract is "the verdict
as of `lastEvidenceVerdictEvaluatedAt`", never "as of now" — uniform across
`in_review` and `done`. What was missing was the reader's side of it.

**Measured 2026-10-23**, company `b1d3f3d3`, the **complete** `done` population
paged to exhaustion — 3,066 rows in four pages of 1000/1000/1000/66. Do not
measure this on one page: a single `limit=1000` call returns a bare array of
exactly 1000 and looks complete, and the first page alone reports the phantom
signature below as **1 row instead of 38**.

| | count | share |
|---|---|---|
| no verdict at all — step-2 triage returns nothing | 1,790 | **58.3%** of 3,066 |
| have a verdict, comparable against `completedAt` | 1,276 | 41.7% |
| …evaluated >=3d before completion | 238 | **18.6%** of 1,276 |
| …of those, stored verdict reads `pass` | 42 | — |
| worst case — PEN-1274 | 1 | **110d** stale |

Verdict age at completion (n=1,276): same-day 820 (64.3%), 1–2d 218 (17.1%),
3–7d 131 (10.3%), 8–30d 83 (6.5%), >30d 24 (1.9%).

**Unusable on 2,028 / 3,066 = 66.1%** (1,790 absent + 238 materially stale).

**The failure direction is a false FAIL, not a missed phantom.** A months-old
`warn` makes a correctly-closed row look like a phantom-done and costs an
investigation to clear.

Reproduce it — page to exhaustion first, then measure the union:

```sh
# 1. page until a page comes back short; do NOT stop at the first 1000.
#    A fixed offset list silently returns a capped prefix the moment the
#    population outgrows it -- the exact trap described above. Loop on the
#    page length instead. `-f` makes a 4xx/429 stop the paging rather than
#    write an error body for `jq` to merge; the `incomplete` flag then
#    suppresses the union, because a short read and a failed read are
#    indistinguishable once the pages are on disk.
rm -f /tmp/done-*.json /tmp/all-done.json
off=0 incomplete=
while :; do
  curl -fsS -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
    "$PAPERCLIP_API_URL/api/companies/$COMPANY/issues?status=done&limit=1000&offset=$off" \
    -o "/tmp/done-$off.json" || { incomplete="request failed at offset $off"; break; }
  # the row cap may answer with a bare array or a {truncated, issues} envelope
  n=$(jq 'if type=="array" then length else (.issues | length) end' "/tmp/done-$off.json") \
    || { incomplete="unparseable page at offset $off"; break; }
  [ "${n:-0}" -lt 1000 ] && break
  off=$((off + 1000))
done
# refuse to build the union from a known-partial read -- an incomplete census
# that measures cleanly is worse than one that does not measure at all.
if [ -n "$incomplete" ]; then
  echo "INCOMPLETE CENSUS: $incomplete -- not unioning; fix and re-run" >&2
else
  jq -s 'map(if type=="array" then . else .issues end) | add | unique_by(.id)' \
    /tmp/done-*.json > /tmp/all-done.json
fi

# 2. verdict age at completion, and the phantom-signature decomposition
jq -r 'def ts: sub("\\.[0-9]+Z$"; "Z") | fromdate;
  [.[] | select(.lastEvidenceVerdict.verdict=="warn"
                and ((.lastEvidenceVerdict.missing//[]) | index("pr-link")))] as $p
  | { total: length,
      noVerdict: ([.[] | select(.lastEvidenceVerdict==null)] | length),
      phantomSignature: ($p | length),
      noProject: ([$p[] | select(.projectId==null)] | length),
      stale3d: ([$p[] | select(.lastEvidenceVerdictEvaluatedAt != null and .completedAt != null
                 and (((.completedAt|ts)-(.lastEvidenceVerdictEvaluatedAt|ts))/86400) >= 3)] | length) }' \
  /tmp/all-done.json
```

The `.[0-9]+Z` strip is required: `fromdate` rejects the fractional seconds these
timestamps carry.

#### ⛔ RULED 2026-10-24 (CTO, PEN-4624) — this signature has gone silent: it has not fired on any verdict since 2026-07-11, and at this head it cannot fire on any row, labelled or not

**Read this before running the decomposition below.** The signature the next
section decomposes — `verdict: warn` ∧ `missing ∋ pr-link` — **has not appeared
on a single one of the 1,071 verdicts written since 2026-07-12.** So an empty or
all-ancient result from that recipe means the instrument is **silent**, not that
the fleet is clean. That is a false-*reassurance* failure, and it runs opposite
to the false-FAIL risk this document warns about everywhere else.

⚠️ **Be precise about the mechanism — the loose version of this claim was wrong,
and so was the first correction of it.** The evaluator can still put `pr-link`
into `missing`: that list is `required.filter((s) => !detections[s])`
(`server/src/services/evidence-gate.ts:881`), and
`DEFAULT_EVIDENCE_REGISTRY.pr.required = ["pr-link"]`
(`server/src/services/evidence-shapes.ts:115-117`), so a **`pr`-labelled** issue
closing without a detected PR link *does* emit the token today. **But it emits it
under `verdict: block`, never under `warn`** — so it does not bring the
documented signature back. See *Labelling does not revive the signature* below.

What makes the signature silent is the **required set actually in force**:

- A row whose labels match no registry entry falls back to
  `DEFAULT_UNLABELED_REQUIRED`, which is exactly
  `["checklist:done-when", "review:ally-clean"]`
  (`evidence-shapes.ts:212-215`, `evidence-gate.ts:195`). `pr-link` is **not in
  it**, so on that path it cannot enter `missing` by construction.
- **All 1,071 post-cutover verdicts in this company are `unlabeledFallback: true`
  — every single one.** Not one row in the window matched a registry label.

###### Labelling does not revive the signature — it produces `block`, not `warn`

The documented detector is a *pair*: `verdict: warn` **∧** `missing ∋ pr-link`.
At this head no label set produces that pair, because the two conjuncts are
reachable only on mutually exclusive paths:

- **Labelled ⇒ `block`.** Once any registry label matches, `unlabeledFallback`
  is `false`, so a non-empty gap falls through to the last arm of the verdict
  chain and the verdict is `block` (`evidence-gate.ts:883-892`). `warn` on that
  chain is the `unlabeledFallback` arm only.
- **The demotion cannot rescue it.** The one `block` → `warn` demotion fires
  only when the gap is made *entirely* of truth shapes (`truthOnlyGap`,
  `evidence-gate.ts:912-916`), and `TRUTH_SHAPES` is
  `["review:ally-clean", "deploy:landed"]` (`evidence-gate.ts:148`). `pr-link`
  is not one of them, so any gap containing it is never truth-only and stays
  `block`.
- **Unlabelled ⇒ `pr-link` is never required**, per the fallback set above —
  and that set is not registry-overridable: `resolveRequiredShapes` returns
  `[...DEFAULT_UNLABELED_REQUIRED]` whenever no label matched
  (`evidence-gate.ts:194-196`), and the only later mutation of `required` is a
  *filter* that drops shapes (`evidence-gate.ts:837-838`), never one that adds
  them.

So labelling an issue `pr` revives `missing ∋ pr-link` **only under
`verdict: block`**. The `warn` half of the signature died at the cutover and is
unreachable at this head *regardless of labels, and for any registry* — so when
you are hunting a labelled row, **screen on `verdict: block`**, not `warn`. The
jq recipe above and the live predicate below both condition on `warn` and will
therefore read a labelled phantom-done row as clean.

(Worth recording in both directions, because the error reversed under
correction. The first draft of this ruling called the evaluator incapable of
emitting `pr-link` at all — false. The correction then claimed labelling would
revive the *signature* — also false, and it had already merged before the second
catch. Both were found in review on #2964.)

**Measured 2026-10-24**, company `b1d3f3d3`, the complete `done` population paged
to exhaustion — 3,161 rows in four pages of 1000/1000/1000/**161**. 1,346 carry a
verdict. The boundary is sharp:

| verdict shape | n | `lastEvidenceVerdictEvaluatedAt` range |
|---|---|---|
| `allDetected` **null** (old evaluator) | 275 | 2026-05-31 → **2026-07-11T14:26:53Z** |
| `allDetected` **populated** (current) | 1,071 | **2026-07-12T11:04:16Z** → 2026-10-23 |

**Zero overlap across all 1,346.** `allDetected == null` is therefore a reliable
"this verdict predates the current evaluator" test, and it is cheaper than a
date comparison.

**One commit explains both halves of that boundary** — `c6145736`,
*"fix: harden evidence gate detectors (#641)"*, committed 2026-07-12T10:00:29Z,
between the last PRE verdict (2026-07-11T14:26:53Z) and the first POST one
(2026-07-12T11:04:16Z). It did two things at once:

- It **added `allDetected: found`** to the returned verdict — which is why the
  field is `null` before it and populated after, giving the sharp boundary.
- It **removed the `pr-link` substitution on the unlabeled path.** Before #641,
  when a row had no `done-when` bullets, `checklist:done-when` was dropped from
  `required` and `pr-link` was *pushed in to replace it* on the fallback path
  ("with no criteria to check, a PR is the only reviewable receipt"). That
  substitution is the mechanism that produced all **38** historical signature
  rows: unlabeled ⇒ `warn`, with `pr-link` required. #641 replaced the push with
  a `missing-done-when-bullets` diagnostic, so `pr-link` can no longer enter the
  unlabeled `required` set at all.

So the signature did not drift out of use — it was retired by a specific change,
on a specific day, and the 38 rows are the complete record of it.

The two eras report in disjoint vocabularies. These are the **complete**
observed token sets, not a selection — each era emitted exactly two distinct
`missing` tokens across its whole population, and the table is their union:

| `missing` token | PRE (n=275) | POST (n=1,071) |
|---|---|---|
| `checklist:done-when` | 51 (18.5%) | 825 (77.0%) |
| `pr-link` | **38 (13.8%)** | **0 (0.0%)** |
| `review:ally-clean` | 0 | 409 (38.2%) |

The current evaluator reports PR evidence through **`allDetected`** instead:
`pr-link` appears there on **918 of 1,071 (85.7%)** post-cutover rows.

Note the POST column is `DEFAULT_UNLABELED_REQUIRED` exactly — which is the
mechanism above showing up in the data, not a coincidence.

**Consequence: all 38 signature rows are pre-cutover.** The decomposition below
is still arithmetically correct, but it describes a **closed** candidate pool:
one that has not grown since 2026-07-11 and cannot grow at this head, because
the `warn` ∧ `missing ∋ pr-link` pair is unreachable on every path (above).
Labelling does not reopen it — it moves such a row to `block`, which this
pool's recipe does not select.

##### The live predicate, and its decomposition

Use **`pr-link ∉ allDetected`** — *absent from `allDetected`*, **not** *present
in `missing`*. `allDetected` is what the current evaluator actually reports PR
evidence through, so this is the conjunct that carries the signal.

⛔ **ADVISORY ONLY — measured precision 0/4 (PEN-4643, ruling below at
`:530`).** This predicate is a cheap pre-filter, not a verdict. It is satisfied
vacuously whenever `allDetected` is `null` or `[]`, and even its informative
residual was 100% false-positive on measurement. **Never fail a row on it
alone — confirm against the `workProducts` table first.**

**Pair it with the right verdict for the row you are hunting, because the two
cases land on different verdicts:**

| row | verdict to screen on |
|---|---|
| unlabelled (every row this company produces today — 1,071/1,071) | **`warn`** |
| labelled with a registry entry requiring `pr-link` (e.g. `pr`) | **`block`** |

Screening on `warn` alone is correct for today's estate and is what the
decomposition below measures, but it is **not** future-proof: the moment
labelling starts, a phantom-done labelled row lands on `block` and a `warn`-only
sweep reads it as clean. If you cannot rule out labelled rows in your window,
screen `verdict != "pass"` and keep both.

Same screens as before, `warn` ∧ `pr-link ∉ allDetected`, re-measured 2026-10-24:

| screen | remaining |
|---|---|
| raw | 153 |
| `projectId != null` | 94 |
| `originKind` not harness-generated | 87 |
| verdict <3d stale vs `completedAt` | 72 |
| `allDetected` non-empty | **12** |

The last screen is the one that does the work: **60 of the 72** have
`allDetected: []`, i.e. the gate detected no evidence shape at all. That is the
signature of a decision/planning row, for which a merged code PR is not the
done-when, rather than of a code row missing its PR.

⚠️ **The 12 are unverified candidates, not confirmed phantoms.** One was checked
authoritatively via `GET /api/issues/{id}/work-products` — the record the GitHub
webhook writes, which is stronger than scraping comments for a URL:

- **PEN-3713** — correctly `done`: `Blockcast/paperclip#2185`, `merged: true`,
  `mergedAt: 2026-10-06T07:49:45Z`, `owningIdentifiers: ["PEN-3713"]`.

The other 11 were **not** individually cleared, so this predicate's precision was
**unmeasured** when this paragraph was written. ⛔ **It has since been measured at
0/4 — see the PEN-4643 ruling immediately below, which supersedes this
paragraph.** A `gh search prs <identifier>` pass is *not* a substitute: it is
full-text matching and scored `PEN-4036` against `onprem-k8s#4036` on the number
alone.

##### ⛔⛔ RULED 2026-10-24 (CTO, PEN-4643) — the live predicate's precision is now measured, and it is 0/4. Treat it as ADVISORY; `workProducts` is the discriminator

The "unmeasured" above is resolved: it was measured over the complete `done`
population and **every informative candidate it selected was a false positive.**
Do not lift `pr-link ∉ allDetected` as a standalone sweep. It fails *noisy*
where the pre-cutover signature failed *silent*; neither form has yet produced a
single demonstrated true positive.

**Measured 2026-10-24**, company `b1d3f3d3`, complete `done` population paged to
exhaustion — 3,174 rows in four pages of 1000/1000/1000/**174**, deduped by id.

| | count | share |
|---|---|---|
| `done` rows | 3,174 | |
| …no `lastEvidenceVerdict` at all | 1,819 | **57.3%** |
| …with a verdict | 1,355 | 42.7% |
| of those, `unlabeledFallback: true` | **1,355** | **100%** |
| verdict mix | 1,061 `warn` / 294 `pass` / **0 `block`** | |

⛔ **There is not one `verdict: "block"` row in the corpus.** The labelled half of
the predicate recommended above (*"screen on `block` for labelled rows"*) is
**structurally correct but currently inert** — it selects nothing fleet-wide,
because all 1,355 verdict-bearing `done` rows took the unlabeled fallback, so
none matched a registry label. Keep it for future-proofing, but do not count a
clean `block` sweep as evidence of anything.

###### The predicate conflates three states, and only the third is informative

`pr-link ∉ allDetected` is satisfied **vacuously** in two of them:

| class | meaning | n (of the 230 raw) |
|---|---|---|
| `allDetected == null` | verdict predates the 2026-07-12 evaluator; the field did not exist | **89** |
| `allDetected == []` | evaluator ran and detected **no shape at all** | majority of the rest |
| `allDetected` non-empty, no `pr-link` | detector demonstrably ran and still found no PR | **4** |

Decomposition, same screens as above, re-measured over the whole `warn`
population (1,061 rows):

| step | count |
|---|---|
| dead signature (`warn` ∧ `pr-link ∈ missing`) | 38 |
| **live predicate** (`warn` ∧ `pr-link ∉ allDetected`) | **230** |
| − screen `projectId == null` | −111 → 119 |
| − screen verdict ≥3d older than `completedAt` | −18 → **101** |
| of that residual: `allDetected == []` (uninformative) | **97** |
| of that residual: `allDetected` non-empty (informative) | **4** |

> The earlier figure of 153 in the table above is **post-cutover rows only**
> (`allDetected != null`; 141 on today's population). This decomposition screens
> the whole `warn` population, which is why it starts at 230 — the extra 89 are
> the pre-cutover `allDetected == null` rows, which satisfy the predicate
> vacuously. Both are correct for their stated scope; use this one.

###### All four informative residuals are FALSE POSITIVES — precision 0/4

Each checked against `GET /api/issues/{key}` → `workProducts`:

| row | completed | `allDetected` | merged PR work products |
|---|---|---|---|
| PEN-2638 | 2026-10-21 | `['checklist:done-when']` | **9 merged** (llm-proxy #1730 #1714 #1700 #1697 #1696 #1674 #1650 #1640 #1626) |
| PEN-4332 | 2026-10-19 | `['deploy:landed']` | **4 merged** + 1 open (llm-proxy #2601 #2661 #2607 #2592) |
| PEN-4036 | 2026-10-17 | `['checklist:done-when']` | **3 merged** (paperclip #2964 #2789 #2721) |
| PEN-3164 | 2026-10-03 | `['checklist:done-when']` | **3 merged** (paperclip #2201 #2199, llm-proxy #2186) |

A row can carry **nine merged PRs** and still read `pr-link ∉ allDetected`.

The contamination is not confined to those 4. Across the **whole 101-row
residual**, 36 rows carry a `pull_request` work product and **33 (33%) carry a
merged one** — including 29 of the 97 `allDetected == []` rows. So the
`allDetected == []` class is not a clean "planning row" bucket either; a third
of it is code work whose PR the field never saw.

###### Root cause — `detectPrLink` is text-only, over a 10-comment window

`pr-link` is detected by regex-scraping comment text and **nothing else**:

```ts
"pr-link": detectPrLink(text, allowedPrRepos),   // evidence-gate.ts:764
```

where `text` is `buildAgentEvidenceText(comments, DEFAULT_RECENT_COMMENT_LIMIT)`
— the **10 most recent agent comments**, newest first
(`evidence-gate.ts:207-230`, limit `:119`). `workProducts` *is* passed into
`detectAll` and *is* consulted by `detectE2eRun`, `detectE2eScript` and
`detectScreenshotViewport` — but **not** by `detectPrLink` or
`detectLandingArtifact`. So the one shape that names the deliverable is the one
that cannot see the deliverable's own table.

`preserveDurableLandingEvidence` (`issues.ts:2478-2516`) already documents this
exact decay and compensates for it *within* the `in_review` lifecycle. It does
not help a sweep: it only carries `allDetected` forward across re-evaluations,
and the shape has to have been scraped successfully at least once.

###### Why we are NOT fixing this by populating `allDetected.pr-link` from `workProducts`

That is the obvious repair and it would measurably help — all four rows above
have at least one PR created **before** their verdict, so a `workProducts` arm
in `detectPrLink` would have cleared **4/4**. We are still not adopting it as
the sweep's answer, for two reasons:

1. **The codebase already ruled on this trade-off, in the opposite direction.**
   `issues.ts:2496-2503` (BLO-19081): *"the done gate's third evidence path …
   deliberately does NOT rely on this carry-forward. It queries the artifact
   rows **live** at close time… If you add a fourth shape, **prefer that pattern
   over widening `DURABLE_LANDING_SHAPES`: a live row is a stronger record than
   a cached verdict field**, which is only needed for shapes scraped from comment
   text."* `workProducts` is precisely that live row.

2. **`allDetected` is a snapshot and can never answer a question about later
   state.** The verdict is written only on a PATCH carrying `status:
   "in_review"` (`issues.ts:11531`); the single `done`-path refresh sits behind
   `experimental.enableDoneExecutionGate`, which defaults **off**. So it freezes
   at the last `in_review` evaluation and never moves again. **Three of the four
   rows above gained merged PRs *after* their verdict was written** — PEN-4332
   three, PEN-4036 and PEN-3164 two each. No detector improvement reaches those,
   because nothing re-evaluates. (PEN-2638 is the exception: all nine of its
   merged PRs predate its verdict, so it is purely a detector failure.)

**Decision (CTO, 2026-10-24).** `warn` ∧ `pr-link ∉ allDetected` is **advisory
only** — a cheap pre-filter that narrows ~3,174 rows to ~101, with **0/4
demonstrated precision and no authority to fail a row**. The authoritative
discriminator for "did this issue actually ship" is the **`workProducts`
table**, read live. Fixing `detectPrLink` to consult `workProducts` remains a
worthwhile *separate* correctness fix to the snapshot — it would stop the field
asserting something false at evaluation time — but it is **not** a prerequisite
for the sweep and does **not** change this ruling. Per the scope fence on
PEN-4643, no change is made to `runEvidenceGate` or `shouldBlockNarratedDone`
under this decision.

###### The sweep recipe that is actually supported

1. Pre-filter with the live predicate (cheap, local, no API calls per row).
2. Drop `projectId == null`, then verdicts ≥3d stale vs `completedAt`.
3. Drop `allDetected == null` **and** `allDetected == []` — both vacuous.
4. **For every survivor, `GET /api/issues/{key}` and read `workProducts`.** A row
   with a `type: "pull_request"` work product that satisfies the merge predicate
   below is **not** a phantom-done, whatever its verdict says. This step is
   mandatory; on the measured population it rejects 100% of what step 3 hands it.

   ⛔ **Merged = `metadata.merged == true` OR `metadata.mergedAt` populated.
   Never read `merged: false`, or `status != "merged"`, as evidence that a PR did
   not merge.** Write it as that disjunction and nothing narrower: it is the
   server's own canonical predicate, `pullRequestHasMerged` in
   `server/src/services/pull-request-work-products.ts` (`prMerged === true ||
   prMergedAt` non-empty). **Both arms are load-bearing, in opposite
   directions** — drop either and you escalate a row whose PR genuinely merged:

   | row shape | arm that saves it | how it arises |
   |---|---|---|
   | `merged: false`, `mergedAt` set | `mergedAt` | a pre-PEN-4550 queue merge. GitHub delivers a mandatory-queue merge as `dequeued`, not `closed`, so the event *carrying* the merge wrote `merged: false` while populating `mergedAt` from the same payload; 3 of 6 directly-inspected rows lost that second-granular tie |
   | `merged: true`, `mergedAt` null | `merged` | any writer that had no `merged_at` to pass — a hand-written `POST /api/issues/{key}/work-products` (`metadata` is `.passthrough()`, so the pair is caller-supplied and unvalidated) or a backfill |

   This step has now been wrong in **both** directions: until 2026-10-26 it said
   `metadata.merged == true` alone, dropping the first row shape, and the first
   correction said `metadata.mergedAt` alone, dropping the second. Each
   single-arm form fails toward **escalating a correctly-closed row**, which is
   the direction this whole screen exists to prevent. For the mechanism and the
   measurements, see *"Reading the artifact cheaply — and the one field that
   currently lies"* below, which owns this rule. (PEN-4813)

   ⛔⛔ **`workProducts` is an ABSENT KEY on the list projection — this step
   only works off a PER-ISSUE surface.** Either `GET /api/issues/{key}` or the
   narrower `GET /api/issues/{key}/work-products` returns these rows; the latter
   is the cheaper call when the work products are all you need. What never
   carries them is the *list* projection. The paging recipe earlier in this
   document builds the candidate set from
   `GET /api/companies/{id}/issues?status=done&limit=1000`, and that projection
   does not carry `workProducts` at all: measured present on **0 / 600** `done`
   rows (2026-10-24) and **0 / 862** (2026-10-26). It is *absent*, not `[]`, so
   the natural `len(row.get("workProducts", []))` evaluates to **0 on every row
   in the corpus** — the discriminator stops being a check and becomes a
   constant that **confirms every candidate and escalates the lot**. Same
   `.get()`-on-an-absent-key family already flagged for `descriptionTruncated`
   and the retry-attendance fields, and it bites one level *after* you have done
   the right thing by moving to `GET /api/issues/{key}`. Gate on key presence
   (`has("workProducts")`) and treat its absence as *"wrong surface"*, never as
   *"no work products"*. (PEN-4813)
5. Only a survivor of step 4 is worth a human look — and it is still a
   *candidate*, because a planning/decision row legitimately has no PR.

`gh search prs <identifier>` is **not** a substitute for step 4: it is full-text
matching and scored `PEN-4036` against `onprem-k8s#4036` on the number alone.

###### Paging: the REST route has no truncation envelope

`GET /api/companies/{id}/issues?status=done&limit=1000` returns a **bare array**
of exactly 1000. The `{truncated, appliedLimit, …}` envelope is added by the
**MCP layer only**, so a script hitting REST directly sees no truncation signal
and silently under-reports by ~3×. Confirmed again 2026-10-24: offsets
0/1000/2000 each returned a bare 1000, offset 3000 returned 174. **Page until a
page comes back short** — do not trust a single `limit=1000` call.

#### Screen in this order — staleness is NOT the dominant noise source

38 `done` rows carry the phantom-done signature (`verdict: warn`, `missing`
includes `pr-link`). Decomposed:

The **`removes`** column counts each screen against the **full 38 independently**,
so the rows overlap and the figures deliberately over-count: 32 + 1 + 8 = **41**,
because 6 rows are *both* `projectId: null` and stale. The distinct union is
32 + 1 + 8 − 6 = **35**, leaving the 3 residuals. Applied in order — `projectId`,
then `originKind`, then staleness — the population runs **38 → 6 → 5 → 3**; the
`originKind` row's **1** is stated post-`projectId` because that is the only row
it removes which screen 1 did not already take.

| screen | removes (vs. the full 38) | note |
|---|---|---|
| `projectId == null` | **32 of 38 (84%)** | no repo is wired, so `pr-link` is **structurally unsatisfiable** and correctly absent |
| harness-generated `originKind` | **1 of 38** | same structural reason, but these *do* carry a `projectId`, so the `projectId` screen cannot see them; this is the only one that survives both other screens — see below |
| verdict >=3d older than `completedAt` | 8 of 38 (21%) | 6 of these also have `projectId == null` |
| **residual — fresh verdict, real project, author-generated** | **3** | PEN-663, PEN-1195, PEN-1162 |

So the raw signal's precision as a phantom-done detector is **4/38 ≈ 10.5%**
before the `originKind` screen and **3/38 ≈ 7.9%** after,
and the biggest single noise source is **`projectId == null`, not staleness**.
Screen on `projectId` first: it is deterministic, costs nothing, and removes
five sixths of the candidates on its own. PEN-1274 (110d stale) and PEN-529 (45d
stale) are *both* also `projectId: null`, so either screen alone would have
cleared them without the investigation they actually cost.

#### Screen 2 — a harness-generated row can never satisfy `pr-link`

`PEN-1216` reaches the residual set carrying `projectId: 1eb0ea12…`, so the
`projectId` screen passes it through. But its `originKind` is
`stale_active_run_evaluation`: it is a **row the harness filed about a run**, not
a unit of work with code scope. Its done-when is a judgement, and there is no
commit that could ever satisfy `pr-link`. Flagging it is not a low-precision
hit — it is **always wrong**, for the same structural reason as `projectId: null`.

Treat these `originKind` values as having no code scope:

```
issue_productivity_review      harness_liveness_escalation
stale_active_run_evaluation    routine_execution
```

**This list is deliberate, not exhaustive — do not treat it as the whole set.**
The authoritative enumeration is `packages/shared/src/constants.ts`, in two
parts: the `ISSUE_ORIGIN_KINDS` **array** holds the 8 built-ins — which beyond
the four above are `manual`, `stranded_issue_recovery`, `task_watchdog` and
`task_watchdog_product_bug` — while the open-ended `plugin:*` family is a
separate type, `PluginIssueOriginKind`, joined to the built-ins as
`IssueOriginKind` in the same file. **Grepping the array alone will not show you
`plugin:*`**; read the union type, not just the list.

The omitted kinds are left out because they are **not all decidable the same
way**: some are plausibly no-code-scope too, but `task_watchdog_product_bug` is
a *product bug the watchdog found*, which is normally fixed by a commit and so
**does** have code scope — screening it out would suppress a real hit. Adding a
kind to this list is a claim that **no commit could ever close that row**; check
it against `ISSUE_ORIGIN_KINDS` and make that claim deliberately rather than by
pattern-match on the name.

The class is not rare, and the overlap with `projectId` is only partial — which
is exactly why it needs its own screen. Measured over one agent's 807 `done`
rows (CTO, 2026-10-23): **258 (32%)** are harness-generated, and **129 of those
carry a `projectId`** and are therefore invisible to screen 1.

⛔ **The query below measures the CLOSED pre-cutover pool — it is not a live
sweep, and lifting it as one reproduces this document's own subject matter.**
Its first two conjuncts *are* the retired signature: `verdict == "warn"` ∧
`missing ∋ pr-link`. That pair is unreachable at this head on every path,
labelled or not (ruling at `:355`), so against post-cutover rows — those with
`allDetected` populated, i.e. every verdict written after
**2026-07-11T14:26:53Z** — it returns **nothing by construction**. An empty
result from it is the instrument being silent, not the fleet being clean.
`c6145736` (*"fix: harden evidence gate detectors"*, #641,
2026-07-12T10:00:29Z) is the commit that retired it; the 38 rows it selects
over are a closed set that has not grown since 2026-07-11 and cannot grow.

**For a sweep that can actually fire, use the live predicate** — *"The live
predicate, and its decomposition"* (`:475`): **`pr-link ∉ allDetected`**, paired
with `verdict: warn` for unlabelled rows, `verdict: block` for rows labelled
with a registry entry requiring `pr-link`, or `verdict != "pass"` when your
window may contain both. The three screens below are predicate-independent —
`projectId`, `originKind` and staleness carry over to the live predicate
unchanged, which is what the re-measured table at `:475` applies them to.

⛔ **But that predicate is ADVISORY ONLY — measured precision 0/4 (PEN-4643,
`:530`).** It fires, which the dead signature does not, but every informative
row it selected on measurement carried merged PRs. It narrows the population; it
does not decide anything. Confirm every survivor against `workProducts` before
treating it as a phantom-done.

The full residual query over that closed pool — all three screens, verified
against the 3,135-row population on 2026-10-23, returns exactly the three rows
named in the table:

```bash
jq -r 'def ts: sub("\\.[0-9]+Z$"; "Z") | fromdate;
 [.[] | select(.lastEvidenceVerdict.verdict=="warn"
          and ((.lastEvidenceVerdict.missing//[]) | index("pr-link"))
          and .projectId != null
          and ((.originKind // "") as $ok
               | [ "issue_productivity_review","harness_liveness_escalation",
                   "stale_active_run_evaluation","routine_execution" ]
               | index($ok) | not)
          and ((.lastEvidenceVerdictEvaluatedAt == null) or (.completedAt == null)
               or ((((.completedAt|ts)-(.lastEvidenceVerdictEvaluatedAt|ts))/86400) < 3)))
        | {id:.identifier, completed:.completedAt[0:10], origin:.originKind}]' \
  /tmp/all-done.json
```

⚠️ **Bind `originKind` to a variable — do not write `index(.originKind)` inline.**
Inside `[ ... ] | index(.originKind)` the `.` has rebound to the *array literal*,
not the issue, so jq fails with `Cannot index array with string "originKind"`.
The working form is the exact one above — **`(.originKind // "") as $ok`**. This
bit the first draft of this very section.

The two near-misses fail in **opposite** ways, and the quiet one is the dangerous
one (all three behaviours verified with `jq` on 2026-10-23):

| form | behaviour |
|---|---|
| `index(.originKind)` inline | **errors loudly** — `Cannot index array with string "originKind"`, exit 5. You cannot miss it |
| bare `. as $ok` | **silently fails open.** `$ok` binds the whole issue; `index(<object>)` returns `null`, so `| not` is `true` for *every* row — including harness rows. The screen removes nothing and the query still exits 0 |
| `(.originKind // "") as $ok` | correct — `false` for a harness row, `true` otherwise |

So the mistake to actually fear is not the error, it is the bare bind: it leaves a
query that runs clean and screens nothing. If this screen ever appears to remove
**0 of 38**, suspect the binding before you conclude the population changed.

`// ""` is **not** what prevents an error — nothing errors here. `index(null)`
also returns `null` (exit 0), so a null `originKind` already passes through as
non-harness without it. It is defensive code that makes the null case explicit,
not load-bearing.

⚠️ **Do not oversell this screen — a tempting hypothesis here is false.** It is
natural to guess that the residual is *largely* harness rows, which would mean
the detector's real precision is near zero. **It is not: only 1 of the 4.** The
other three are `originKind: manual` and are genuine residuals. This was tested
over the full 3,135-row population on 2026-10-23 and the guess was refuted; the
screen is worth running for **correctness** (it removes a class that can never be
a true positive, deterministically and for free), not for yield. Recorded so the
next reader does not re-run the same refutation.

#### What the residual actually contains right now

All three surviving residuals completed in **June 2026** — `PEN-663`
(2026-06-19), `PEN-1195` and `PEN-1162` (2026-06-27), with the screened-out
`PEN-1216` on 2026-06-28.

⛔ **CORRECTED 2026-10-24 (PEN-4624).** This section previously concluded
*"There is no recent phantom-done candidate anywhere in the company."* That was
**true of the residual and wrong as an inference about the fleet**, and the
difference is the whole point: the residual is ancient because the signature
stopped being emitted on 2026-07-11 (see the ruling above for the mechanism),
not because closures got cleaner.
Re-measured on 2026-10-24 the residual is unchanged — the same four June rows
(three after the `originKind` screen) — even though the `done` population has
grown by **95 rows since that residual was first measured** (3,066 at PEN-4539 →
3,135 at PEN-4601 → 3,161 now). The pool is frozen, not quiet.

So the superseded advice — *"check whether its residual still consists entirely
of rows months old; if it does the sweep is better spent elsewhere"* — reaches
the right answer by the wrong route, and would keep returning "spend it
elsewhere" forever however many real phantoms accumulated. Use the live
predicate in the 2026-10-24 ruling above instead.

#### The reader rule

- On an **`in_review`** row, `lastEvidenceVerdict` is current **as of its last
  `in_review` PATCH** (or last label edit in that status) — not continuously. It
  is usable as a grace-window signal, but a row that has sat idle in `in_review`
  for days still carries its entry-time verdict, so the same
  "as of `lastEvidenceVerdictEvaluatedAt`" contract applies here too, just with a
  shorter half-life. This row is its own example: PEN-4539's verdict was written
  at `2026-10-23T03:06:48Z` reading `warn` / `missing: ["review:ally-clean"]`,
  80 seconds before the clean review it was waiting on landed at 03:08, and
  nothing refreshed it.
- On a **`done`** row, treat it as **undefined until proven otherwise**: screen
  `projectId == null`, then screen harness-generated `originKind` values (both
  mean `pr-link` is structurally unsatisfiable), then compare
  `lastEvidenceVerdictEvaluatedAt` against `completedAt`. If the verdict
  predates the work, it describes an earlier state and carries no information
  about the closure.
- **Check which evaluator wrote the verdict before reading its `missing` list.**
  `allDetected == null` means the verdict predates the 2026-07-12 cutover and
  speaks a different vocabulary — it *can* say `pr-link`, whereas a post-cutover
  verdict on the unlabeled fallback cannot, because `pr-link` is not in
  `DEFAULT_UNLABELED_REQUIRED`. A post-cutover verdict reports PR evidence by
  **presence in `allDetected`** instead, so "`pr-link` is not in `missing`" is
  not evidence that a PR was found. Reading the two shapes as one field is what
  left this detector silent and unnoticed for 3.5 months (PEN-4624).
- The artifact — a PR with a merged commit SHA — is the only authority on
  whether a row is correctly `done`. The verdict is a triage hint that narrows
  where to look; it never substitutes for the artifact.

#### Reading the artifact cheaply — and the one field that currently lies

The reader rule ends at "the artifact is the only authority" without saying how
to *reach* it. A heartbeat sweep cannot afford a GitHub round trip per candidate,
and it does not need one: `GET /issues/:id/work-products` (registered as
`router.get("/issues/:id/work-products"` in `server/src/routes/issues.ts`)
returns the platform's own PR rows for an issue, already keyed to it by
`owningIdentifiers`.

**Measured 2026-10-23 (CTO), the 35 rows that closed `done` in the preceding
12h.** The verdict screen from the section above flagged **3**; all three were
**false positives**, and the work-product read cleared each in a single call:

| row | verdict screen | work products | truth |
|---|---|---|---|
| PEN-4515 | `null` → flagged | #2930 `merged`, `4df0de8f` | PASS |
| PEN-3260 | `null` → flagged | 4 merged PRs owning the row | PASS |
| PEN-4528 | `null` → flagged | none of its own | PASS — coordination row, no code deliverable; its decision was routed and **ruled** |

Precision of the verdict screen on that cohort: **0/3**. This is the
`noVerdict` 58% from the census above arriving as false FAILs, exactly as the
failure-direction note predicts — so on a `done` row, go to the work products
first and treat the verdict as a hint about *where* to look, not *whether* to.

> **⚠️ Do NOT screen on `status == "merged"` or on `metadata.merged`.** Either
> can be wrong for any merge that arrives through a mandatory merge queue.
> GitHub delivers such a merge as `dequeued`, not `closed`, and the pre-PEN-4550
> webhook populated `prMerged` only on `action === "closed"` — so the event
> *carrying* the merge wrote `ready_for_review` / `merged: false` while
> `metadata.mergedAt` was populated from the same payload. A row contradicting
> itself on its face.
>
> Every queue merge is *exposed* to this — the queue is mandatory, so every merge
> fires a `dequeued` — but whether a given row was actually demoted turns on a
> second-granular tie, which 3 of 6 directly-inspected rows lost: "a coin flip on
> a second-granular clock, not a rare race" (`pullRequestHasMerged`'s own doc
> block). Screen as though any queue merge could be wrong, because the row does
> not record which side of that coin it landed on.
>
> **Screen on `metadata.merged == true` OR `metadata.mergedAt` populated.** That
> is not a workaround; it is verbatim the server's own canonical predicate,
> `pullRequestHasMerged` in
> `server/src/services/pull-request-work-products.ts` — `prMerged === true
> || prMergedAt` non-empty — and the `mergedAt` arm is there because GitHub sets
> `merged_at` on a real merge, never clears it, and a merged PR cannot be
> reopened. A genuine queue **ejection** carries `merged_at: null` and, absent a
> true `merged`, is correctly excluded.
>
> ⚠️ **Keep the disjunction; do not collapse it to the `mergedAt` arm.** The
> paragraph above forbids trusting `merged`/`status` *on their own* — that is
> not licence to screen on `mergedAt` alone. `merged: true` with `mergedAt: null`
> is representable (the webhook writes `mergedAt: input.prMergedAt ?? null`, and
> a hand-written work product supplies `metadata` through a `.passthrough()`
> schema), and dropping that arm false-FAILs it in exactly the direction this
> blockquote exists to prevent. Each field is untrustworthy as a *negative*;
> either one is sufficient as a *positive*. (PEN-4813)
>
> Measured the same day: PEN-4553's own #2955 read `status: ready_for_review`,
> `merged: false`, `mergedAt: 2026-10-23T13:35:53Z` while GitHub reported
> `merged: true`. A `status`-only screen false-FAILs it — and #2955 is the
> backfill for this very defect, demoted by the defect it repairs.

**This trap has a dated expiry, and the predicate outlives it.** The forward fix
(PEN-4550, `8633c02`) and the backfill (PEN-4553, migration `0265`) are both on
`master` as of 2026-10-23, so once a dispatched deploy carries them, `status`
becomes trustworthy again and already-demoted rows are repaired in that same
startup. Until then it is not — and the disjunction above is the correct screen
on both sides of that deploy, which is why it is the one to write down. Note the
expiry retires the *trap*, not the `mergedAt` arm: after the deploy a queue merge
sets both fields, so the arm costs nothing and still covers every row written
before it.

#### Two changes considered and rejected

- **Refresh the verdict on every `done` transition.** Rejected: it moves
  `runEvidenceGate` plus a GitHub truth probe onto every `done` write, a network
  round trip on a hot path. The laziness at `:11359` exists to avoid exactly
  that, and it is correct — `hasDurableArtifactEvidence: false` in the pre-check
  means the shortcut can only cause the gate to look *harder*, never to skip a
  block.
- **Null the verdict when a `done` transition does not refresh it.** A null does
  read more honestly than a stale `warn`, but it destroys data two other
  consumers need. `dashboard.ts:409,482` windows its scorecard on
  `lastEvidenceVerdictEvaluatedAt` and reads the verdict; and
  `done-gate.ts:195` (`hasPrLinkEvidence`) deliberately asks the **historical**
  question *"was a real PR ever attached"* (BLO-16325) — for that consumer a
  stale verdict is the correct input, not a bug. Do not "fix" it.

> **Consequence worth stating once:** the same staleness is *correct* for
> `done-gate.ts`, which asks a historical question, and *wrong* for a heartbeat
> sweep, which asks a current one. The field is not broken for either; the two
> readers are asking different questions of the same column.

#### Where this guidance lives — and where it does not

The reader rule above is operator guidance, so the obvious place for it is an
agent's `HEARTBEAT.md`. **There is no repo-side source for one, for any role but
CEO.** `DEFAULT_AGENT_BUNDLE_FILES`
(`server/src/services/default-agent-instructions.ts:3-6`) declares exactly two
roles: `ceo`, which ships `AGENTS.md`/`HEARTBEAT.md`/`SOUL.md`/`TOOLS.md` from
`server/src/onboarding-assets/ceo/`, and `default`, which ships `AGENTS.md`
alone. Every non-CEO role — CTO included — resolves to `default`
(`resolveDefaultAgentInstructionsBundleRole`, `:39-41`). So a CTO `HEARTBEAT.md`
on a live instance is instance-authored content with no stock source, no version
history, and no review trail, and a **newly provisioned** CTO gets none of it.

That is the durable gap. The *overwrite* risk that this was first reported as
turns out not to exist, and the checks are worth recording so nobody re-derives
them:

- The default path materializes with `replaceExisting: false`
  (`server/src/routes/agents.ts:1790-1793`), and `materializeManagedBundle`
  only wipes the bundle root when that flag is **true**
  (`agent-instructions.ts:713-715`). It then writes only the files in the map —
  for a non-CEO role, `AGENTS.md` alone. `HEARTBEAT.md` is never touched.
- `built-in-agents.ts:997` *does* pass `replaceExisting: true`, but only for the
  four built-in bundle keys (`briefs`, `learning`, `reflection-coach`,
  `summarizer`). There is no `cto` built-in, so that wipe never reaches it.
- Company import (`company-portability.ts:5055,5102`) also passes
  `replaceExisting: true`, but `exportFiles` walks the bundle root recursively
  (`agent-instructions.ts:678-686`) and import restores every file under
  `agents/<slug>/` (`company-portability.ts:4970-4976`). An export → import
  round trip preserves the file.

**Verified 2026-10-23: no peer heartbeat doc carries the superseded guidance.**
The only `HEARTBEAT.md` in the repo is `onboarding-assets/ceo/HEARTBEAT.md`, and
it contains no `lastEvidenceVerdict`, done-gate or release-verification section
at all — its §4 is "Get Assignments". There is nothing else to correct, and this
runbook is therefore the version-controlled home of the rule.

#### Known inconsistency, flagged not ruled

The scorecard's two legs run on two different clocks. The `doneIssues` leg
(`dashboard.ts:433-443`) filters `status = "done"` and windows on
`completedAt >= windowStart`; the verdict leg (`:476-486`) windows on
`lastEvidenceVerdictEvaluatedAt >= windowStart` and carries **no status filter
at all**, so its population is every row with a verdict in any status. Two
consequences: a row that sat a long time between `in_review` and `done` lands in
one leg and not the other, and the verdict leg mixes `in_review` and `done` rows
into one rate. Windowing a verdict metric on verdict time is a defensible
reading, so this is **not** being called a defect here; it is recorded for
whoever owns the metric's definition.

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
there is, which is why this is a row-count check and not a header check — a
header guard here would never fire. The backfill script does not need this
check at all: it pages the list itself
(`scripts/ops/backfill-pr-work-products.mjs`, `listAllIssues`), which a `curl`
one-liner cannot do without a loop. It is also only trustworthy on a key with
`company_scope:read` — see the precondition above.

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
count above and expect near zero — **near, not zero**: the backfill's population
is PRs referenced in issue *comments*, so an issue whose only PR link sits in its
description stays `no-linked-pull-request` after a clean pass. That residue is
in scope for the script, not a failed backfill. Re-measuring after the dry run
alone returns the same number you started with — that is the script working as
designed, not a broken backfill and not a baseline you can discharge.

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

### Recorded baseline — 2026-09-27T13:32:51Z

⚠️ **This is a post-deploy, pre-flip baseline, and the pre-deploy one was
missed.** The truth shapes were already evaluating in production by
`2026-09-23T23:22Z`, so the deploy-day step-down this section warns about has
already happened and is folded into the numbers below. The scorecard window is
a rolling 30 days with no historical endpoint, so the pre-deploy figures are
**not recoverable** — do not read a later comparison against this table as
measuring the deploy. It is still the correct baseline for the seven-day
measurement, which measures the **flip**, and it was taken before that window
opened (`PAPERCLIP_EVIDENCE_UNLABELED_BLOCK` still `"0"`).

Window `2026-08-28T13:32:51Z` → `2026-09-27T13:32:51Z`. The table is keyed on
display name; the `jq` above emits `agentId`, so map with
`paperclipListAgents` (or `GET /api/companies/$PAPERCLIP_COMPANY_ID/agents`)
before comparing.

These 13 are the **complete** non-zero set for the window. The other 5 agents
on the roster had `reviewedIssues: 0` and are omitted (`reviewPassRate: null`,
nothing to step down): **Reflection Coach**, **Summarizer**, **Operator
(devbox)**, **Caveman Canary Claude v2**, **Caveman Canary OpenCode v2** — all
`pending_approval` or `paused`, all created before the capture. A name in the
follow-up that is not in either list is a genuinely new agent, not a
previously-omitted one.

| agent | reviewedIssues | passedReviews | reviewPassRate |
|---|---|---|---|
| Players Engineer | 47 | 35 | 0.7447 |
| TrafficOpsEngineer | 90 | 21 | 0.2333 |
| QA Engineer | 9 | 2 | 0.2222 |
| OCMBackendEngineer | 10 | 2 | 0.2000 |
| PlatformSREEngineer | 265 | 52 | 0.1962 |
| CEO | 20 | 3 | 0.1500 |
| MulticastEngineer | 262 | 39 | 0.1489 |
| Staff Engineer | 90 | 11 | 0.1222 |
| UXDesigner | 22 | 2 | 0.0909 |
| BackendEngineerGo | 80 | 6 | 0.0750 |
| CTO | 79 | 4 | 0.0506 |
| Release Engineer | 69 | 3 | 0.0435 |
| Ally | 142 | 4 | 0.0282 |

**The lesson for the next flag with a scorecard-visible effect:** the baseline
has to be captured in the same change that ships the code, not in the runbook
that describes it. A rolling window makes "we will grab it on deploy day" a
one-shot opportunity with no retry.

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
(`server/src/services/issues.ts:2125-2129`, priority rank at `:7719`), so the
rows past the cap are the low-priority, stalest
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
- **the agent-authored share** — since PEN-4265 this IS derivable from this
  response, and the GitHub round trip below is no longer needed to get it. A
  suppressed row names its own reason: look for
  `unlabeled-truth-block-suppressed:reviewer-authored-pr` in the verdict's
  `diagnostics`. Count those separately and exclude them from `willBlock` —
  they are not blocks at any flag value.

  The old recipe still has one use, as a **control** rather than as the
  measurement: `lastEvidenceVerdict` is written only on a PATCH carrying
  `status: "in_review"`, so a row that entered review BEFORE the suppression
  shipped carries a pre-suppression verdict and will not show the diagnostic
  even though it is in the population. On a row whose verdict predates the
  deploy, resolve the author the slow way — read the `pull_request` work
  products, then `gh api repos/<repo>/pulls/<n> --jq .user.type` — and treat a
  `Bot` as suppressed. Only the `User` half was ever the number the 2% gate was
  written about.

`onlyTruthMissing` remains a safe upper bound on `willBlock`; since the registry
change its only excess is the two suppressed populations.

## Flip criterion

Seven consecutive days with **all** of:

- ~~the agent-authored population either de-required or suppressed~~ —
  **SATISFIED 2026-10-18 by PEN-4265**, which suppressed it as
  `reviewer-authored-pr` (see the third unsatisfiable population above). Left
  in the list rather than deleted because it is a standing property, not a
  one-off: if a future change removes that arm, this precondition is unmet
  again and the window must not be opened. Verify it the cheap way — a row in
  the agent-authored population carries
  `unlabeled-truth-block-suppressed:reviewer-authored-pr` in its verdict
  diagnostics;
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
