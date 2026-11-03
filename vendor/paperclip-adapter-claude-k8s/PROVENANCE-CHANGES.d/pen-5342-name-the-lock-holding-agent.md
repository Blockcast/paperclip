# PEN-5342 — the push guard's refusal names the agent holding the lock

`src/server/env-guard.ts` (`ENV_GUARD_SCRIPT`), plus its test.

The lock-guard refusal printed the holder as a bare run id:

    … whose lock is held by run 389edf09-… .

A bare id does not carry what it takes to be read correctly, so the reader
supplies the missing half, and the only sibling relationship the framing
suggests is *another run of mine*. That default is wrong across seats.
Measured on PEN-5082 cmt `e87c9e8b`: a DevOps run read this exact message and
reported, in good faith, "another DevOps run is on this row right now". The
holder was an Engineer run.

What changed:

- New `describeHolderAgent(issue, holder, selfAgentId)` resolves the holding
  agent from the response `foreignLockHolder()` has **already fetched** — no
  second request, no new field, no schema change.
- Precedence is **id first, name second**, and that ordering is load-bearing.
  `activeRun.agentId` is authoritative (`activeRun` is hydrated by keying off
  `executionRunId`) and is used only when `activeRun.id === holder`, so a
  skewed payload cannot attribute the wrong seat. `executionAgentNameKey` can
  be **stale**: only `runningCheckoutExecutionPatch` and the heartbeat claim
  write it alongside `executionRunId`, while four adoption writers in
  `issues.ts` set the run id alone and leave the previous holder's name
  behind. An earlier revision of this change asserted the opposite invariant;
  Ally caught it in review on PR #3314. When the name is the only source it is
  reported as UNVERIFIED rather than as attribution.
- When the id IS available it is printed **alone**; the name key is not
  appended beside it. The two live in different namespaces — a name key
  (`"engineer"`) against a run's agent uuid — so nothing at this surface can
  tell a pair that agrees from one that contradicts, and on the adoption path
  above they genuinely contradict. A second revision of this change printed
  `agent "reviewer-seat" (<your own run's agent id>)`, naming a foreign seat
  as the owner of the reader's own sibling run: the same cross-seat
  misattribution the change exists to remove, reintroduced by the fix for it.
  Ally caught that too, on the same PR. Caveating the name was rejected over
  dropping it — the pair agrees in the common case, so a warning printed on
  every message is one readers learn to skip. The readable name is a real
  loss; `activeRun` carries no agent name today, and adding one means a join
  on the issues-list hot path that PEN-3596 is separately fighting for
  latency, so it is left out rather than bought at that price.
- `PAPERCLIP_AGENT_ID` (already in the job manifest) turns the attribution
  into the verdict the reader was guessing at: "which is YOUR OWN agent" vs
  "which is a DIFFERENT agent from yours".
- When nothing in the payload names the holder, the message says so and tells
  the reader not to assume a sibling — silence is spoken rather than left as a
  bare id, because the bare id is the input to the misread.
- `PAPERCLIP_AGENT_ID` added to the test suite's `LOCK_VARS` scrub list; the
  suite can itself run inside an agent pod, where a real seat id would leak
  into the unset case.

Tests assert the emitted stderr, not a server-side object: per PEN-5336's
lesson (BLO-27858), a key surviving onto an internal object is not a delivery
test.
