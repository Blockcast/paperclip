# Accepted-interaction outcome (PEN-4409)

Covers `PaperclipAcceptedInteractionActionUnobserved`,
`PaperclipAcceptedInteractionUntracked` and
`PaperclipAcceptedInteractionOutcomeMetricsRefreshFailed`.

## What this measures, and what it deliberately does not do

An accepted issue-thread confirmation records that a decision was **made**.
Nothing recorded whether the action it **authorised** happened. The sweep in
`server/src/services/accepted-interaction-outcome-sweep.ts` closes that by
reading an *agent-declared* `payload.expectedOutcome` and checking it against
state this process already holds.

**The sweep reports only. It performs no writes of any kind** — it cannot
resolve, cancel, re-open or wake an interaction, and it must never be given the
ability to. The records it reads are board and operator decisions; a sweep that
could act on one would be executing a decision nobody delegated to it. If you
are extending this module, that is the line.

## The originating instance

Interaction `f2a8595c-6264-4978-8ebd-de2ee02bb1e3` (PEN-4318) was accepted
2026-10-19T07:01:42Z, authorising the merge of `Blockcast/paperclip#2584`. At
2026-10-20T09:4xZ the PR was still `OPEN` at its original head `3ecdf1dd` —
about 26h45m — and the card still read `accepted`, having emitted nothing.

The innocent explanation does not hold. #2584 did lack an approving review
(`reviewDecision: REVIEW_REQUIRED`), but **4 of 6 sampled PRs that merged in the
same window merged with zero approving reviews**, and #2587 merged 59 minutes
after the acceptance in the identical gate state. No gate was holding it. The
action was simply not done, and nothing noticed, because an accepted decision
whose action never happened was byte-identical to one whose action did.

## `PaperclipAcceptedInteractionActionUnobserved`

A declared outcome has not been observed, and the oldest such card is past
`acceptedInteractionUnobservedAgeSeconds` (default 24h).

1. Find the card. The control-plane log line
   `accepted interactions whose authorised action has not been observed`
   carries `unobservedSample` with the interaction id, issue identifier,
   declared outcome kind and age.
2. **Check the real object before concluding anything.** `unobserved` is not
   proof the action did not happen — see the ambiguity note below.
3. If the action genuinely has not happened: do it, or withdraw the interaction
   if it has gone moot. Nothing automated will clear this.

### `unobserved` resolves ambiguity toward the alarm, on purpose

| Declared kind | Observed from | Why absence is not proof |
|---|---|---|
| `github_pr_merged` | `issue_pull_requests.mergedAt`, scoped to the interaction's company | The table is webhook-fed on merge and backfilled only for repos that already have at least one forward-captured PR. A merge this installation never recorded reads `unobserved`. |
| `issue_status` | `issues.status` in the same company | Fully in-DB; absence here really does mean the status was not reached. |

An outcome `kind` this build has no observer for also reads `unobserved`. That
is deliberate: adding a kind without adding its observer fails toward the alarm,
never toward a false clear. A false alarm costs a look; a false clear is
strictly worse than the silence this replaced, because silence at least does not
claim to have checked.

## `PaperclipAcceptedInteractionUntracked`

`info`. Acceptances are sitting with **no** `expectedOutcome` at all, so nothing
can check them. This is an adoption signal, not an incident — the field is
optional on purpose, because requiring it would break every existing caller.

It is surfaced rather than filtered because a report showing only the cards that
volunteered a reference reads clean precisely by excluding the population the
defect was measured on. `f2a8595c` declared nothing; a sweep that dropped this
bucket would have been blind to the very card that motivated the work.

Resolve by having filing agents populate `payload.expectedOutcome` on
confirmations that authorise a concrete action.

### Why this is declared and never extracted from the card's prose

`f2a8595c`'s payload named, in prose: `#2584`, `#2569`, `3ecdf1dd`, `8b14f0e6`,
`PEN-4318`, `PEN-4284`, `ci.yml:578`, `:1380`, `27.7%`, `02:30–03:30Z`. An
extractor picks one of those. The correct answer, `#2584`, is not the first, not
the most frequent, and not distinguishable by shape from `#2569` — the PR the
*decline* path would have acted on.

A wrong pick produces a card reported as **tracked** while observing the wrong
object, and reported green while the real action never happened. Do not add
prose extraction to this module.

## `PaperclipAcceptedInteractionOutcomeMetricsRefreshFailed`

The sweep is erroring. The bucket gauges keep their last values rather than
being zeroed — an all-zero report reads as "every acceptance has been acted on",
the one wrong answer this sweep exists to prevent — so the two alerts above are
gated off by their own freshness check while this fires instead.

The gauge is initialised to 0 at process start, so a replica that has never
completed a sweep also fires this. **Check whether the scrape collector tick is
running at all before assuming a query fault**: the refresh is registered as
`accepted-interaction-outcome` in
`server/src/services/scrape-metrics-collector.ts`.

## Adding an outcome kind

Two halves, both required:

1. The variant and its zod schema in `packages/shared/src/types/issue.ts` and
   `packages/shared/src/validators/issue.ts`.
2. Its observer arm in the sweep's SQL.

Ship them together. A kind with no observer is admitted at the ask and then
reads `unobserved` forever, which manufactures a permanent false finding.

`github_pr_approved` is deliberately **absent**. The only approval state the
installation persists is `pull_request_review_state`, which covers *open* PRs
and is pruned once a PR leaves the open set — so an approval observed before a
merge becomes unobservable after it, and the card would flip back to
`unobserved` permanently. Add it when an approval record outlives the PR's open
state, not before.
