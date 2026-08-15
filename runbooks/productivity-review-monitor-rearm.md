# A productivity-review owner needs to restore a stranded issue's execution path

Source: `server/src/routes/issues.ts` (`assertCanManageIssueMonitor`, `assertAgentIssueMutationAllowed`), `server/src/services/heartbeat.ts` (`tickDueIssueMonitors`, `ISSUE_MONITOR_DISPATCH_LAPSE_MS`), `server/src/services/recovery/service.ts` (`reconcileStrandedAssignedIssues`)
Trigger: you are adjudicating an open productivity review and the reviewed issue's `executionState.monitor` reads `status: "triggered"`, `nextCheckAt: null`, and there is no active run (`activeRun: null` or its status is terminal) — i.e. the evidence block says `monitor lapsed at …, never re-armed`.
Owner: Platform / SRE (BLO-24149)

## The invariant

A productivity review exists to catch exactly this shape: an `in_progress`
issue nothing is scheduled to wake. Ruling "continue" only means something if
the reviewer can also make continuing possible — restoring a live scheduled
execution path in the same PATCH that records the verdict, without waiting on
the (possibly paused or errored) assignee to act first.

## The supported repair path (do this)

As the owner of an open productivity review of the issue, `PATCH
/api/issues/:id` directly, re-arming the monitor:

```json
PATCH /api/issues/{issueId}
{
  "executionPolicy": {
    "monitor": {
      "nextCheckAt": "<a few minutes out>",
      "notes": "restored by productivity review continue verdict",
      "scheduledBy": "assignee"
    }
  },
  "comment": "Continue: restored the monitor after the wake lapsed. Next check at <time>."
}
```

This is authorized by the `allow_productivity_review_grant` boundary reason
plus the `productivityReviewOwnerAuthorized` flag threaded into
`assertCanManageIssueMonitor` (`server/src/routes/issues.ts`) — no assignee
action, no board escalation, and no other route needed. It works whether or
not you are also in the assignee's manager chain.

If you manage the assignee (manager-chain relation) instead of holding the
review, the same `PATCH /issues/:id` accepts a **monitor-only** patch shape
(`executionPolicy: { monitor: {...} }` and nothing else) via
`managerMonitorRearmAuthorized` / `isLapsedMonitorRearmPatch`. Sending
`stages`, `authorizationPolicy`, or `mode` alongside the monitor in that path
is refused (403) — re-arm the timer, don't rewrite the assignee's policy.

Verify the write took:

```
GET /api/issues/{issueId}
```

Confirm `monitorNextCheckAt` is now in the future and `monitorAttemptCount` /
`monitorNotes` reflect your re-arm. Expect the assignee to execute a run
within one heartbeat interval of that timestamp.

## What NOT to do: the `todo` bounce is superseded

Earlier reviews (predating this runbook) discovered that `PATCH {status:
"todo"}` also succeeds for a productivity-review owner and unsticks the issue
by dropping it into the assignee's ordinary pick-up queue. That is **not**
the supported path going forward:

- it discards `in_progress` semantics for no reason related to the actual
  defect,
- it schedules nothing at a known time — the issue waits for the assignee's
  next unrelated pick-up pass rather than a monitored wake,
- it forces a re-checkout the assignee didn't ask for,
- and it depends on the reviewer having independently discovered the trick.

Use it only if the direct monitor re-arm above 403s and you cannot wait for a
fix to that gap — and say so explicitly in your review comment (cite the 403
body) so the gap gets tracked rather than silently re-relied-on.

## Why a lapse should mostly self-heal before you ever see it

Two independent nets exist above the review-owner path, so most lapses never
reach a productivity review at all:

- `tickDueIssueMonitors` (`heartbeat.ts`) auto-re-arms a monitor whose
  wake-carrying run never dispatched within
  `ISSUE_MONITOR_DISPATCH_LAPSE_MS` (15m) — the specific "wake consumed by a
  run that then sat queued forever" shape from BLO-18278.
- `reconcileStrandedAssignedIssues` (`recovery/service.ts`) runs every
  heartbeat-scheduler tick and re-dispatches **any** non-terminal assigned
  issue with no live run, independent of monitor state.

A review reaching you with a lapsed monitor and no active run means both of
those nets missed this instance — treat that as worth a comment on BLO-24149
or a follow-up, not just a one-off re-arm.

## Verifying signal

- Automated: `server/src/__tests__/issue-agent-mutation-ownership-routes.test.ts`
  — `"lets a productivity-review owner restore a scheduled execution path on
  a fully stranded issue (BLO-24149)"` and the `BLO-24421` describe block
  pin the authorization path this runbook relies on.
- Live: after re-arming, confirm on the issue thread that the assignee
  executed a run within one heartbeat interval of the new `nextCheckAt`, and
  paste the run id/timestamp on the productivity-review issue.
