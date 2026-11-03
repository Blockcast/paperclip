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
  second request, no new field, no schema change. `executionAgentNameKey` is
  co-written with `executionRunId` in the same `UPDATE .set()`, so it
  describes this holder by construction and survives the holder's run row
  going terminal; `activeRun.agentId` is used only when `activeRun.id ===
  holder`, so a skewed payload cannot attribute the wrong seat.
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
