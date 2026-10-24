# Terminal-gate reconciler (BLO-27515)

## What it does

Re-reads the pull-request gates an issue monitor declared in
`executionPolicy.monitor.gateSignals`, and — when every one of them is merged —
posts a system comment on the issue naming the resolved gate.

When the pull-request gates are all merged but the monitor also declared a gate
naming a **human** (`omar-go`, `hold-lift`, `approval:…`), it posts a different
comment instead, saying so: the machine half is done and the remainder is a
person who has not been told this row exists. See *The human-gate announcement
(PEN-4545)* below. That is a report, never a resolution.

Two populations qualify (`listCandidateIssues`): a **terminated** monitor, which
has stopped polling (`monitorNextCheckAt IS NULL`); and an **armed but never
evaluated** monitor (`monitorAttemptCount = 0 AND monitorLastTriggeredAt IS
NULL`), which was armed on a gate that was already satisfied and would otherwise
wait out its whole window before anything looked — BLO-36289. The comment copy
branches on whether the monitor can still wake the issue: the armed variant, which
states the monitor is still armed and must not be treated as stranded, is used
only when the first check is still in the future, AND the row is one the
scheduler will fire (`issueAllowsMonitor`: agent-assigned, no user assignee,
`in_progress`/`in_review`), AND the monitor has road left to run
(`exhaustedMonitorClearReason`, evaluated at `attemptCount 0`). An overdue check,
a `todo`/`blocked`/human-assigned row, or a monitor already past its own
`timeoutAt` — nothing constrains `nextCheckAt <= timeoutAt`, so "check in 6h,
give up after 2h" arms fine and is cleared rather than fired — gets the stranded
copy.

It dispatches nothing, closes nothing, and clears no monitor.

- Module: `server/src/services/terminal-gate-reconciler.ts`
- Wiring: `server/src/index.ts` (worker tier only, `paperclipNodeRole !== "api"`)
- Config: `PAPERCLIP_TERMINAL_GATE_RECONCILER_ENABLED` (default on),
  `PAPERCLIP_TERMINAL_GATE_RECONCILER_INTERVAL_MINUTES` (default 10)
- Requires GitHub App credentials. Without them every gate read fails closed as
  `gate_read_failed` and nothing can ever resolve, so the sweep does not start at
  all — it logs `Terminal-gate reconciler disabled: GitHub App credentials are not
  configured (BLO-27515)` once at boot. If the sweep is silent, check that line
  before assuming there are no candidates.
- Consumer: `productivity-review.ts` suppresses a `long_active_duration` review
  whose source carries a recorded resolution (`terminalGateResolvedSuppressed`)

## The gap it closes

BLO-24166's monitor polled `pr:blockcast/paperclip#1281:merged` at
`2026-08-12T23:20:27.842Z` and correctly recorded `merged=NO`. The PR merged
**16 minutes later**, at `23:36:22Z`. By then polling had stopped, and the issue
sat complete-but-open for **2 days 8 hours** — costing a productivity review
issue, a CEO run to disposition it, and a queued CTO run that would have
re-derived an answer already on the thread.

Every mechanism behaved correctly in isolation, which is what made this a gap
rather than a bug in any one of them:

1. The monitor re-armed on an *unchanged* gate signature so that three unchanged
   re-checks would converge to a stall (BLO-18294) rather than rotating the
   signature to keep the loop alive. That is the intended discipline. It also
   means the last poll before an outage is the last poll, ever.
2. The restore sweep knowingly hands back a stale gate and says so — monitor
   writes are assignee-or-board, so a sweep cannot re-arm one.
3. The assignee wake that would have re-evaluated it then queued for 3h.

Convergence-to-stall and outage-strand both terminate polling with the gate in
an **unknown** state, not an unsatisfied one, and nothing distinguished those.

## Why this site, and not the other two

The choice was between three places. Stated plainly so a later change does not
quietly relocate it.

### Chosen: a board-side re-check that needs no assignee permissions

A standalone reconciler on its own cadence, running with the App installation
token and no agent identity.

It is the only one of the three whose trigger is *the gate becoming resolvable*
rather than something else happening first. Re-reading a PR is one API call;
waking an agent to read it is a full model run plus queue latency plus a
`long_active_duration` review if the queue is slow. That asymmetry is the whole
point, and only a site that runs without an agent can exploit it.

### Rejected: the restore / recovery sweep

Wrong shape twice over.

- **It is an event, not a reconciler.** It fires when an issue is stranded and
  restored. BLO-24166's gate resolved ~6h *before* the strand and would have had
  to be caught by luck; a gate that resolves *after* a restore is missed again
  with nothing scheduled to look. Correctness here cannot depend on an unrelated
  incident happening to occur at the right moment.
- **It cannot write the thing it would need to write.** The CEO restore sweep on
  BLO-24166 says so in as many words: *"I cannot re-arm the monitor for you
  (monitor writes are assignee-or-board), so that is yours to do."* A sweep that
  correctly identifies the hazard and correctly notes it lacks the permission to
  fix it can only push re-evaluation onto an assignee wake — which is the
  expensive path this exists to remove, and, during an outage, the exact path
  that is broken.

### Rejected: the productivity-review detector

Right consumer, wrong owner.

- **It is downstream of a threshold.** It only looks at an issue once
  `long_active_duration` is on the table (6h by default), so a gate that
  resolves at minute 1 stays unobserved for six hours by construction. The
  reconciler's cadence is a knob; the detector's is a *symptom*.
- **Its output is oversight, not resolution.** The detector files a review
  *about* an issue and deliberately does not act *on* it. Giving it a
  GitHub-reading, comment-posting side effect on the source issue widens a
  narrow, well-guarded mandate.
- **It would still not observe most cases.** Its candidate query is scoped to
  `todo`/`in_progress`; the population this exists for spends much of its life
  `blocked` after an outage strand.

So the detector **consumes** the recorded resolution — a plain lookup, no
network call of its own — and owns none of the re-evaluation.

## Fail-closed rules

- **Only `merged` counts.** A PR closed *without* merging is equally terminal
  but the work did not land — a different situation needing a different
  response. It must not read as "done, go close the issue", and must not
  suppress oversight.
- **Every declared signal must resolve.** One unparseable token
  (`deploy:paperclip-api`, `mq:drained`) means the issue is still waiting on
  something the reconciler cannot see, so the issue is left alone. There is no
  partial resolution. The parse loop runs to completion *before* the read loop,
  so an unparseable token costs zero GitHub calls.
- **A human gate is reported, never resolved** (PEN-4545; see below). It is the
  one unparseable class that gets a verdict of its own, and that verdict is
  still not `satisfied`.
- **Merge subsumes the sub-gates.** A merged PR satisfies `:checks` and
  `:review` as well as `:merged`, because merge is strictly stronger than any of
  them. Checks passing is *not* itself terminal — a green check can go red on
  the next push — so nothing resolves on checks alone.
- **A live `blockedBy` edge blocks resolution.** BLO-18294 folds unresolved
  blockers into the monitor's gate fingerprint, so they are part of the gate set.
- **Suppression is scoped to `long_active_duration` only**, and only when it is
  the *entire* fired set. A satisfied gate explains elapsed wall-clock. It
  explains nothing about conduct: `high_churn` and `runtime_failure_streak` are
  records of runs that executed and burned cost or failed, and a PR merging does
  not make either untrue. `no_comment_streak` is excluded too — unlike a
  dependency gate, which *causes* silence by cancelling queued runs before
  dispatch, a monitor gate does not stop the assignee from commenting.

## The human-gate announcement (PEN-4545)

### The gap

The fail-closed rule above is correct as a *resolution* rule and was silent as a
*reporting* rule. Any token the parser could not read sent the whole issue down
one branch — `unresolvable_signal`, no comment, no log line, nothing — and the
tokens agents write to say "a person must act" went down it with the rest.

That made this sweep, the one board-side audit that reads `gateSignals` at all,
structurally blind to the gate class that most needs a reader. Measured
2026-10-23: six `in_review` rows across three agents, each with a PR that was
`OPEN`, `MERGEABLE` and green, each carrying *"do not merge until Omar gives an
explicit go"*, each declaring that go on its monitor. Every one had an armed
`monitorNextCheckAt`, so:

- not `blocked` → zero-blocker sweeps skipped them;
- no `external owner:` lines → the declaration regex never saw them;
- armed monitor → every dashboard read them as **actively attended**.

The rows politely re-checked a gate nothing on the owner's side could ever
answer. **Silence was indistinguishable from progress**, and the row looked
better cared-for than a silent one. The complement is worse: when the go
finally arrived — a blanket *"go for all"* at 12:16Z, thirteen PRs merged
inside fifteen minutes — nothing connected that event to the rows parked
against it. Two were parked to dates three and six days past the event they
were waiting for.

### What it does

`parseTerminalGateSignal` now returns a third kind, `human_gate`, for tokens on
an explicit allowlist (`omar-go`, `hold-lift`, `human-go`, `founder-go`,
`approval`, `board-approval`, `card`, `signoff`, `sign-off`, `cto-ruling`,
`ceo-ruling`, each with an optional `:suffix`). When **every** other declared
gate is satisfied and only human gates remain, `resolveTerminalGate` returns
`human_gate_only` and the sweep posts a distinct comment under the
`terminal-gate-human-only:` idempotency prefix.

The comment names the gate tokens, says the machine half is done, and says
plainly that a re-check will return the same answer forever. It closes nothing,
clears no monitor, dispatches no run, and files no card — picking between
extending a pending card, recording a named owner on the row, and accepting the
row as frozen is the owner's judgement, and guessing from here would reproduce
the same defect one level out.

### Why an allowlist and not "anything unparseable"

`deploy:landed`, `mq:drained`, `argo:synced`, `cron:nightly`, `heap:stable` and
`insync:true` are unparseable here but *are* resolved by the assignee's own
poll, and no human is expected to clear them. Announcing "waiting on a person"
over one would be false. The split is drawn from the token census in
`listCandidateIssues`, not guessed at.

It fails in the safe direction: a human-gate token the list does not know keeps
the old behaviour exactly — silent `unresolvable_signal` — so an omission costs
the status quo, while a false positive would post a wrong-headed comment. Add
prefixes on evidence.

### Invariants a later change must not break

- **`human_gate_only` is not `satisfied`.** It must never enter
  `listResolvedTerminalGates`, which is the productivity-review suppression
  path. A human-gated row is the case where oversight is *most* warranted: the
  work is finished, unreachable, and nobody has been told. Two independent
  guards hold this — the `kind === "pull_request"` filter and the separate
  idempotency prefix — and both are deliberate.
- **The anti-join must test both prefixes.** `listCandidateIssues` excludes a
  row announced under *either* key for its current signal set. Testing only the
  resolved prefix would re-admit every announced human-gate row on every pass,
  where it can never clear — the `SCAN_LIMIT` starvation vector the resolved-side
  anti-join exists to remove, reached through a new door. `TGA` pins this on
  `scanned: 0`, which a JS-side filter cannot fake.
- **Read cost.** A human-gated row with PR tokens now *does* spend PR reads
  (previously it bailed at parse time). Bounded by the existing per-pass cap and
  deduped by `gateCache`; a row whose unparseable tokens are not human gates is
  unchanged and still costs zero.

## Operational notes

- **Idempotency** is the `issue_comments` unique index
  `issue_comments_issue_system_idempotency_idx` on `(issue_id, idempotency_key)`
  for system-authored rows, with `onConflictDoNothing`. Safe from any number of
  worker replicas.
- **The key is derived from the signal set**
  (`terminal-gate-resolved:<sha256(sorted signals)[0:32]>`), so a monitor
  re-armed on *different* gates produces a different key: the old resolution
  stops matching and oversight resumes. A re-arm on the *same* gates keeps
  matching, which is correct — the same gate is still resolved.
  **The candidate scan recomputes this same digest in SQL** so the
  already-announced anti-join tests the exact current signal set rather than
  approximating it with a prefix match plus a timestamp. If you change
  `terminalGateResolutionIdempotencyKey`, change `gateSignalDigestSql` with it —
  the `scanned` assertions in `terminal-gate-reconciler.test.ts` fail if the two
  drift. A drift is fail-open (the row is admitted and the authoritative JS key
  filter drops it), so it costs a wasted scan slot, never a missed announcement.
- **Cost per pass** is at most one GitHub read per distinct still-unresolved PR,
  capped at 100 reads per pass. Once a resolution is recorded the issue is
  filtered out *before* any API call.
- **Saturation is logged, not inferred.** The read budget fails closed, so an
  issue past the cap is left alone and looks exactly like "nothing to resolve".
  When that happens the pass emits a `warn` —
  `terminal-gate reconciler exhausted its per-pass pull-request read budget` —
  carrying `readCapped`, `pullRequestReads`, `scanned` and `maxReads`. Sustained
  across passes it means the window is saturated rather than idle: candidates
  are ordered `updated_at ASC`, which is stable, so the same head-of-list issues
  can consume the budget every pass while issues behind them never get read.
  Raise `maxPullRequestReads`, or shorten the interval, before concluding the
  reconciler has nothing to do. Note there is no negative caching for PRs that
  read as still-open, so unmerged PRs are re-read every pass and count against
  the budget each time.
- **The comment is written directly to `issue_comments`**, not through
  `issuesSvc.addComment`, because that path can enqueue a wake. Not dispatching
  is the behaviour under test, not an implementation detail — see the
  `heartbeat_runs` / `agent_wakeup_requests` assertions in
  `server/src/__tests__/terminal-gate-reconciler.test.ts`.

## Related

- BLO-18294 — the convergence guard that (correctly) stops re-arming.
- BLO-25865 — `tickExpiredIssueMonitors`, the adjacent sweep for a monitor left
  `triggered` past its `timeoutAt`. That one recovers the *monitor*; this one
  reads the *gate*.
- BLO-25722 — the elapsed-accounting half. It makes a review body honest about
  queue wait; it does not close the issue. Both are needed.
