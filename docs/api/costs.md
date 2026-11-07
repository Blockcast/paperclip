---
title: Costs
summary: Cost events, summaries, and budget management
---

Track token usage and spending across agents, projects, and the company.

## Report Cost Event

```
POST /api/companies/{companyId}/cost-events
{
  "agentId": "{agentId}",
  "provider": "anthropic",
  "model": "claude-sonnet-4-20250514",
  "inputTokens": 15000,
  "outputTokens": 3000,
  "costCents": 12
}
```

Typically reported automatically by adapters after each heartbeat.

## Company Cost Summary

```
GET /api/companies/{companyId}/costs/summary
```

Returns total spend, budget, and utilization for the current month.

## Costs by Agent

```
GET /api/companies/{companyId}/costs/by-agent
```

Returns per-agent cost breakdown for the current month.

## Costs by Project

```
GET /api/companies/{companyId}/costs/by-project
```

Returns per-project cost breakdown for the requested window.

**`from` is required, and the window may be at most 5 days (PEN-5591).** Unlike the
other cost aggregates, this one joins run-to-project attribution, which cannot be
answered for a wider window inside the database statement timeout — and the attempt
is what sheds unrelated routes, so it is refused up front with `400` rather than
left to time out as `503`. A wider or unbounded range returns:

```json
{ "error": "costs/by-project window is 30.0 days; the maximum is 5. ...",
  "details": { "code": "window_too_wide", "maxWindowDays": 5, "issue": "PEN-5591" } }
```

This is a stopgap, not the intended ceiling; it is lifted by durable forward
project attribution, which removes the join entirely.

## Budget Management

### Set Company Budget

```
PATCH /api/companies/{companyId}
{ "budgetMonthlyCents": 100000 }
```

### Set Agent Budget

```
PATCH /api/agents/{agentId}
{ "budgetMonthlyCents": 5000 }
```

## Budget Enforcement

| Threshold | Effect |
|-----------|--------|
| 80% | Soft alert — agent should focus on critical tasks |
| 100% | Hard stop — agent is auto-paused |

Budget windows reset on the first of each month (UTC).
