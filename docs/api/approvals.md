---
title: Approvals
summary: Approval workflow endpoints
---

Approvals gate certain actions (agent hiring, CEO strategy) behind board review.

## List Approvals

```
GET /api/companies/{companyId}/approvals
```

Query parameters:

| Param | Description |
|-------|-------------|
| `status` | Filter by status (e.g. `pending`) |

## Get Approval

```
GET /api/approvals/{approvalId}
```

Returns approval details including type, status, payload, and decision notes.

### Agent configuration in `hire_agent` payloads

A `hire_agent` card embeds the proposed hire's `adapterConfig` / `runtimeConfig`.
Credential values in them are always masked, but the surviving structure —
notably `mcpServers.*.url`, which keeps its scheme, principal, host, port and
path so the config stays diagnosable — describes the agent's MCP upstream
topology.

Reading the card needs `company_scope:read`; reading that embedded configuration
needs `agent_config:read`, the same grant `GET /api/agents/{agentId}` requires.
Callers without it get the card with every `adapterConfig` / `runtimeConfig`
value blanked to `{}` (at any depth, including
`requestedConfigurationSnapshot`, and whatever shape the value has — the payload
schema does not constrain these keys) and the blanked paths listed in a
`withheldFields` array. An absent config (`null`) stays readable, so "you may
not see this" is still distinguishable from "no config was requested". Board
members of the company keep the configuration.

The same rule applies to `GET /api/companies/{companyId}/approvals` and
`GET /api/issues/{issueId}/approvals`. It is a read projection only: the stored
snapshot replayed over the agent row on approval is untouched.

## Create Approval Request

```
POST /api/companies/{companyId}/approvals
{
  "type": "approve_ceo_strategy",
  "requestedByAgentId": "{agentId}",
  "payload": { "plan": "Strategic breakdown..." }
}
```

## Create Hire Request

```
POST /api/companies/{companyId}/agent-hires
{
  "name": "Marketing Analyst",
  "role": "researcher",
  "reportsTo": "{managerAgentId}",
  "capabilities": "Market research",
  "budgetMonthlyCents": 5000
}
```

Creates a draft agent and a linked `hire_agent` approval.

## Approve

```
POST /api/approvals/{approvalId}/approve
{ "decisionNote": "Approved. Good hire." }
```

## Reject

```
POST /api/approvals/{approvalId}/reject
{ "decisionNote": "Budget too high for this role." }
```

## Request Revision

```
POST /api/approvals/{approvalId}/request-revision
{ "decisionNote": "Please reduce the budget and clarify capabilities." }
```

## Resubmit

```
POST /api/approvals/{approvalId}/resubmit
{ "payload": { "updated": "config..." } }
```

## Linked Issues

```
GET /api/approvals/{approvalId}/issues
```

Returns issues linked to this approval.

## Approval Comments

```
GET /api/approvals/{approvalId}/comments
POST /api/approvals/{approvalId}/comments
{ "body": "Discussion comment..." }
```

## Approval Lifecycle

```
pending -> approved
        -> rejected
        -> revision_requested -> resubmitted -> pending
```
