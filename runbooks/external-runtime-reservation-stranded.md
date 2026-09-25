# Stranded external-runtime reservation (an agent cannot launch anything)

Source: `server/src/services/external-runtime-reservation-strand-metrics.ts`
(`refreshExternalRuntimeReservationStrandMetrics`) and
`server/src/services/metrics.ts`
(`EXTERNAL_RUNTIME_RESERVATION_STRANDED_OLDEST_AGE_METRIC`,
`EXTERNAL_RUNTIME_RESERVATION_STRAND_METRICS_REFRESH_SUCCESS_METRIC`).

Triggers:

- `PaperclipExternalRuntimeReservationStranded` — an agent holds an unreleased
  `external_runtime_reservations` row older than
  `externalRuntimeReservationStrandedAgeSeconds` (900 seconds by default)
  whose run is terminal or silent, and the age snapshot refreshed
  successfully.
- `PaperclipExternalRuntimeReservationStrandMetricsRefreshFailed` — the most
  recent `/metrics` database refresh failed, so strand ages are stale and
  intentionally do not qualify the strand alert.

Owner: Platform / SRE (BLO-28865, parent BLO-27700)

## The invariant

An unreleased reservation holds the agent's runtime slot through the partial
unique index `external_runtime_reservations_active_slot_idx (agent_id,
slot_id) WHERE released_at IS NULL`. That is the whole point of the row — it
is the concurrency lock. So the blast radius of one stranded reservation is
**the entire agent**, not the one run that stranded it. Every subsequent
launch for that agent fails to claim a slot and nothing dispatches.

The lifecycle is `reserved → launching → launched → released`. Every one of
those states is transient. A row sitting unreleased while its run is over, or
while its run has gone silent, is a lock nobody will ever unlock.

## What this alert is NOT

There is an older gauge,
`paperclip_external_runtime_reservation_oldest_age_seconds`. **Do not build
rules on it and do not "simplify" this alert onto it.** It is a single
unlabelled global that measures reservation *age only*. Measured over 7 days
on healthy replicas it ranged from ~93 minutes to ~9.0 hours — all legitimate
long-running work. Any threshold over it either pages on healthy long runs or
misses real wedges, and it cannot name the affected agent even when it fires.

`paperclip_external_runtime_reservation_stranded_oldest_age_seconds` is
different: the strand condition is evaluated **in SQL, per agent**, and a
healthy long run publishes `0`. A reservation is counted only when it is
unreleased **and** either:

- its `heartbeat_runs` row is already terminal (`succeeded`, `failed`,
  `cancelled`, `timed_out`) — the run is over, so the reservation must not
  outlive it; or
- its run is non-terminal but has emitted nothing (no useful action, no
  output, nothing since it started) for longer than 45 minutes, matching
  `EXTERNAL_LIFECYCLE_HARD_STALE_MS`.

## Why this needed an alert at all

BLO-27700: two agents (MulticastEngineer and the CTO) were wedged in `error`
and unable to run at all. The cause was an adapter-type migration —
`opencode_k8s` → `claude_k8s` re-prefixes the Kubernetes Job name from
`agent-opencode-*` to `ac-*`. `recordExpectedExternalRuntimeJobName` matches a
`launched` reservation by **exact `expectedJobName` equality**, so zero rows
matched and every launch threw, forever, while the unreleased row held the
slot.

Three reservation gauges were already exported and scraped. **No alert rule
referenced any of them.** A human noticed the incident. That is the gap this
alert closes, and the decision it informs is: *an agent's launch path is
wedged and someone must intervene.*

## Triage

1. **Confirm it is firing, and for which agent.** The `agent_id` label names
   the wedged agent.

   ```promql
   ALERTS{alertname="PaperclipExternalRuntimeReservationStranded", alertstate="firing"}
   max by (agent_id) (paperclip_external_runtime_reservation_stranded_oldest_age_seconds)
   ```

2. **Check whether the launch path is actively rejecting.** A nonzero rate
   here means launches are being refused because the presented Job name
   disagrees with the reservation — the adapter-type strand shape specifically:

   ```promql
   rate(paperclip_external_runtime_reservation_events_total{event="name_mismatch"}[15m])
   ```

3. **Read the row.**

   ```sql
   select id, agent_id, run_id, state, expected_job_name, job_name, job_uid,
          reserved_at, released_at
     from external_runtime_reservations
    where released_at is null
    order by reserved_at asc;
   ```

   Join to the run to see why it is stranded:

   ```sql
   select r.id, r.status, r.started_at, r.last_useful_action_at, r.last_output_at
     from heartbeat_runs r
     join external_runtime_reservations res on res.run_id = r.id
    where res.released_at is null;
   ```

4. **Did the agent's `adapterType` change recently?** That is the known cause.
   Since BLO-28865 it should self-heal: the adapter-type change now deletes
   the persisted old-named Job, cancels the in-flight run, and lets the reaper
   release the reservation within one cycle. **A firing alert with a recent
   adapter-type change therefore means teardown failed or did not run** — check
   the API logs for `adapter-type change: reservation-holder teardown failed`,
   `cancelRun: cascade Job delete failed`, or
   `cancelExternalRuntimeReservationHoldersForAgent: failed to tear down reservation holder`.

## Do not do this

**Do not clear `job_name` / `job_uid` to unwedge the row.** It looks like the
fix — launches resume immediately — and it is a trap.
`rearmExternalRuntimeReservationForRetry` nulls exactly those two columns, and
they are the **only** handle `deleteExactExternalRuntimeJob` has on the
orphaned Job. Clearing them abandons a live pre-migration pod that still holds
node CPU and can still make model calls against a workspace the control plane
believes is idle. You will have traded a visible wedge for an invisible leak.

The correct manual intervention is the same thing the fix automates: make the
**run** terminal (`cancelRun`), which deletes the Job by its still-correct old
name and lets the reaper release the reservation.

Also note `release_pending` is never written by any code in `server/src` (all
three references are reads), so do not expect to reach it or set it by hand.

## Related

- `runbooks/queued-run-stranded.md` — the sibling "invisible strand" alert.
  That one covers a run that never got dispatched; this one covers an agent
  that cannot dispatch anything at all.
- `runbooks/k8s-live-job-block-guard.md` — live-Job-vs-run-state disagreement.
