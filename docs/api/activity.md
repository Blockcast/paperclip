---
title: Activity
summary: Activity log queries
---

Query the recorded action trail for a company or a single issue.

## List Activity

```
GET /api/companies/{companyId}/activity
```

Query parameters:

| Param | Description |
|-------|-------------|
| `agentId` | Filter by actor agent (must be a UUID) |
| `entityType` | Filter by entity type (`issue`, `agent`, `approval`) |
| `entityId` | Filter by specific entity |
| `action` | Filter by action name (e.g. `issue.comment_added`) |
| `limit` | Rows to return; defaults to 100, clamped to 500 |

An empty value (`?action=`) is rejected rather than silently widening the
query. Rows come back newest-first and capped, so an older event can fall
outside the window — this endpoint is a feed, not an exhaustive export. For
everything recorded against one issue, use the issue-scoped endpoint below.

⚠ An **unnarrowed** page — one that sets none of `action`, `agentId`,
`entityType` or `entityId` (`limit` does not count as narrowing) — additionally
omits `heartbeat.run_events_streamed` altogether. That action is written once
per live-events socket × owning agent per 30s window, so leaving it in would
make it most of every recency-ordered page. **Any** narrowing filter returns it
like any other row. The response carries an `X-Applied-Filters` header
(percent-encoded JSON) echoing the filter actually applied, with the omission
listed under `excludeActions` — so "filter applied, zero matches" stays
distinguishable from "filter never applied", and this exclusion is never silent.

## Issue Activity

```
GET /api/issues/{id}/activity
```

Every `activity_log` row for one issue, newest first. Unlike the company-scoped
endpoint this one applies **no limit** — the response is the complete set of
rows recorded against the issue, so a missing row is a missing *write*, never a
truncated read.

## Activity Record

Each entry includes:

| Field | Description |
|-------|-------------|
| `actor` | Agent or user who performed the action |
| `action` | What was done (created, updated, commented, etc.) |
| `entityType` | What type of entity was affected |
| `entityId` | ID of the affected entity |
| `details` | Specifics of the change |
| `createdAt` | When the action occurred |

## ⚠ Comment coverage is partial — absence is not evidence

**Do not read this log as a complete record of comments on an issue.** The
positive direction is reliable: an `issue.comment_added` row means that comment
was posted. The negative direction carries no information — for system comments
an absent row is universal, and for agent comments it is routine.

`issue.comment_added` is written by the HTTP comment handlers in
`server/src/routes/issues.ts` (and the Linear bridge in `routes/linear-auth.ts`).
It is not written by `issues.addComment()` itself, so coverage is a property of
*how* the comment was created, not of the comment.

Two distinct gaps follow, with different causes. Measured 2026-10-31 over 115
issues in one company (3,621 comments inside their logs' coverage windows):

| `authorType` | comments | unlogged | rate |
|---|---:|---:|---:|
| `user` | 608 | 0 | 0% |
| `agent` | 2,600 | 75 | 2.9% |
| `system` | 413 | **413** | **100%** |

### `system` comments are never logged — by design

A comment with `authorType: "system"` is written by an internal producer —
reconcilers, sweeps, watchdogs, routine schedulers, webhook handlers — calling
`issues.addComment()` directly in the service layer. That never traverses an
HTTP comment route, so no `issue.comment_added` row is ever written. This is
categorical and deterministic, not loss: 413 of 413 across the sample, with no
system comment anywhere in the matched set.

This is a property of the *route*, not of the request: 280 of those 413 system
comments carried an `idempotencyKey`, and were unlogged anyway. The durable
effect ledger described below is wired up in the route handler, so a producer
that never reaches the route cannot reach the ledger either.

This is deliberate and should not be "fixed" by emitting the action for system
comments. `issue.comment_added` is not a pure audit record — it is consumed as a
control signal:

- `server/src/services/issue-rewake-throttle.ts` treats it as new external input
  and **wakes agents** on it.
- `ui/src/context/LiveUpdatesProvider.tsx` lists it in `ISSUE_TOAST_ACTIONS` and
  **raises a board toast** for it.

Emitting it for every reconciler and sweep comment would wake agents and toast
operators on routine system chatter. System producers already record their own
domain action instead (e.g. `issue.stranded_blocked_reconciled`), which is the
row to look for.

**To enumerate comments, call `GET /api/issues/{id}/comments`.** That is the
system of record. Scoring a system action as "did not happen" because the
activity log has no comment row for it is a false negative by construction.

### `agent`/`user` comments: the unkeyed route path is best-effort

On the route path, durability depends on whether the request supplied an
`idempotencyKey`:

- **With a key**, the comment insert and a durable effect ledger row commit in
  one transaction (`server/src/services/issue-comment-effects.ts`). A reconciler
  retries the `comment_activity` effect until the row exists, so the write
  survives a crash, a timeout, or a pod rotation.
- **Without a key**, the comment is committed first and the activity row is
  written afterwards as a non-atomic, unledgered follow-up. Anything that
  interrupts that window — a throw in reference sync, a statement timeout, a
  terminating pod — loses the row permanently. Nothing retries it and nothing
  reconciles it.

Splitting the same sample on that key:

| path | comments | unlogged | rate |
|---|---:|---:|---:|
| keyed (ledger-backed) | 93 | **0** | 0% |
| unkeyed (best-effort) | 3,115 | 75 | 2.4% |

Read the keyed row as corroboration, not proof on its own: at the unkeyed rate a
93-comment sample would be expected to lose ~2.3, so observing zero is only
marginally significant (p ≈ 0.1). The load-bearing evidence is the source — the
keyed path commits its ledger row in the comment's own transaction and a
reconciler drives it to completion, so it has no window in which to lose the
write. Every observed loss, in both families, is on a path with such a window.

The residual ~2.4% is a **long-standing background rate, not a regression**. It
is flat across time: 2.91% (73/2,511) before 2026-10-30T12:56Z versus 2.25%
(2/89) after, measured in the same sample.

## What Gets Logged

Mutations across issues, agents, approvals, budgets and company configuration
each record their own action. The log is append-only and immutable, but it is a
log of *recorded actions*, not a guaranteed-complete journal of every write —
see the comment-coverage limits above before reasoning from an absence.

## Measuring coverage yourself

`scripts/check-issue-activity-comment-coverage.mjs` reproduces the table above
against a live deployment and reports coverage in **both** directions, so it can
report a clean result as well as a lossy one:

```
node scripts/check-issue-activity-comment-coverage.mjs --issue PEN-1593
node scripts/check-issue-activity-comment-coverage.mjs --limit 120
```

Which rows it reads, so the table above reproduces: `--issue` pins one issue.
Without it the probe takes the first N issues from
`GET /api/companies/{companyId}/issues`, which returns them in that endpoint's
priority-then-recency order — a deterministic slice of the backlog, not a
uniform random sample of it. Per issue it **pages** the comment list with the
`after` cursor, so an issue with more than 500 comments is measured whole
instead of from its oldest 500; if the page cap stops a walk short, the issue is
named in the output rather than folded silently into the result.
