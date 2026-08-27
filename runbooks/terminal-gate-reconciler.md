# Terminal-gate reconciler (BLO-27515)

## What it does

Re-reads the pull-request gates a **terminated** issue monitor declared in
`executionPolicy.monitor.gateSignals`, and — when every one of them is merged —
posts a system comment on the issue naming the resolved gate.

It dispatches nothing, closes nothing, and clears no monitor.

- Module: `server/src/services/terminal-gate-reconciler.ts`
- Wiring: `server/src/index.ts` (worker tier only, `paperclipNodeRole !== "api"`)
- Config: `PAPERCLIP_TERMINAL_GATE_RECONCILER_ENABLED` (default on),
  `PAPERCLIP_TERMINAL_GATE_RECONCILER_INTERVAL_MINUTES` (default 10)
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
  (`deploy:paperclip-api`, `approval:board`) means the issue is still waiting on
  something the reconciler cannot see, so the issue is left alone. There is no
  partial resolution.
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
- **Cost per pass** is at most one GitHub read per distinct still-unresolved PR,
  capped at 100 reads per pass. Once a resolution is recorded the issue is
  filtered out *before* any API call.
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
