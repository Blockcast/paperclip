---
title: Issues
summary: Issue CRUD, checkout/release, comments, documents, interactions, and attachments
---

Issues are the unit of work in Paperclip. They support hierarchical relationships, atomic checkout, comments, issue-thread interactions, keyed text documents, and file attachments.

## List Issues

```
GET /api/companies/{companyId}/issues
```

Query parameters:

| Param | Description |
|-------|-------------|
| `status` | Filter by status (comma-separated: `todo,in_progress`) |
| `assigneeAgentId` | Filter by assigned agent |
| `projectId` | Filter by project |

Results sorted by priority.

`limit` is **clamped**, not validated: a value above the server maximum (1,000)
is silently reduced, and the response is a bare JSON array with no total and no
cursor. A caller therefore cannot distinguish "1,000 rows is the whole
collection" from "1,000 rows is a truncated prefix", and paging with `offset`
over a collection that is being mutated concurrently can return the same issue
twice or skip one. **Do not compute exact counts from this endpoint.** Use the
open-assignment census below.

## Open-Assignment Census

```
GET /api/companies/{companyId}/issues/open-assignment-census
```

An authoritative, non-paginated grouping of a company's open (non-terminal)
issues by assigned agent. Built for consumers — such as the agent-health sweep —
that need exact per-agent open counts and highest-priority assignment identity
and must not derive them from a possibly-truncated list page.

The whole response is computed by a single SQL statement, so it is evaluated
against one database snapshot. Issues created, closed, or re-assigned while the
census runs land wholly inside it or wholly outside it; no issue can be counted
twice or missed.

Query parameters:

| Param | Description |
|-------|-------------|
| `status` | Subset of the open statuses to count (comma-separated or repeated). Defaults to all of them. Passing a terminal status (`done`, `cancelled`) is a 400. |
| `includeRoutineExecutions` | `true` to count `routine_execution` issues. Excluded by default. |
| `includePluginOperations` | `true` to count plugin-operation issues. Excluded by default. |

`limit` and `offset` are rejected with 400 — the census is not paginated.

Response:

```json
{
  "companyId": "…",
  "censusAt": "2026-08-12T10:31:04.512Z",
  "openStatuses": ["backlog", "todo", "in_progress", "in_review", "blocked"],
  "complete": true,
  "truncated": false,
  "agentGroupCount": 13,
  "totals": {
    "open": 4793,
    "openAssignedToAgents": 3060,
    "openAssignedToUsers": 618,
    "openUnassigned": 1115,
    "agentsWithOpenWork": 13
  },
  "agents": [
    {
      "assigneeAgentId": "…",
      "openCount": 870,
      "highestPriority": "critical",
      "highestPriorityIssue": {
        "id": "…",
        "identifier": "PCL-2125",
        "title": "…",
        "status": "in_progress",
        "priority": "critical",
        "createdAt": "2026-07-02T09:14:00.000Z",
        "updatedAt": "2026-08-11T22:03:11.884Z"
      },
      "countsByStatus": { "todo": 611, "in_progress": 141, "blocked": 118 },
      "countsByPriority": { "critical": 3, "high": 240, "medium": 620, "low": 7 }
    }
  ]
}
```

Contract notes:

- **`complete` is the completion signal.** It is `false` only if the number of
  distinct agents with open work exceeds 5,000, in which case `truncated` is
  `true` and `agentGroupCount` reports the real number. There is no silent row
  cap; a company with hundreds of thousands of open issues still returns every
  agent group.
- **The response is self-checkable.** `openAssignedToAgents +
  openAssignedToUsers + openUnassigned` always equals `totals.open` — every
  `totals` field is company-wide and exact regardless of truncation.
  `sum(agents[].openCount)` equals `totals.openAssignedToAgents` **only when
  `complete` is `true`**. A consumer that wants a belt-and-braces check can
  assert these rather than trusting the endpoint, but must gate the first
  assertion on `complete`.
- **What truncation does and does not cost.** When `truncated` is `true` the
  `totals` are still exact and still company-wide; what is missing is the tail
  of the *grouping*. `agentGroupCount` reports the true number of agents with
  open work, so `agentGroupCount - agents.length` is exactly how many groups
  were dropped, and `sum(agents[].openCount)` becomes a strict lower bound on
  `totals.openAssignedToAgents`. Because `agents` is ordered by `openCount`
  descending, the groups that survive truncation are the largest ones. A
  consumer that needs every group must treat `complete: false` as a hard
  failure rather than reconciling the difference.
- **`highestPriorityIssue` is deterministic**: priority rank (`critical`,
  `high`, `medium`, `low`, then anything else) ascending, then `createdAt`
  ascending, then `id` ascending. Stable across calls on unchanged data, so it
  is safe to hash into a fingerprint.
- `agents` is ordered by `openCount` descending, then `assigneeAgentId`
  ascending.
- Issues that are hidden, harness-generated, or terminal are never counted.

Authorization is unchanged from the rest of the company issue API: the caller
must pass `assertCompanyAccess` for `{companyId}`. Because the census is a
company-wide aggregate that cannot be assembled from a per-actor visibility
filter without losing its single-snapshot property, an actor without
company-scope read gets an explicit `403` rather than a silently narrowed census
that would look exact and be wrong. Low-trust-boundary actors receive a census
restricted to their boundary. Task-bridge keys are refused.

Calling it from an agent through the MCP escape hatch (note the tool prepends
`/api` itself):

```
paperclipApiRequest path="/companies/{companyId}/issues/open-assignment-census"
```

## Get Issue

```
GET /api/issues/{issueId}
```

Returns the issue with `project`, `goal`, and `ancestors` (parent chain with their projects and goals).

The response also includes:

- `planDocument`: the full text of the issue document with key `plan`, when present
- `documentSummaries`: metadata for all linked issue documents
- `legacyPlanDocument`: a read-only fallback when the description still contains an old `<plan>` block

## Create Issue

```
POST /api/companies/{companyId}/issues
{
  "title": "Implement caching layer",
  "description": "Add Redis caching for hot queries",
  "status": "todo",
  "priority": "high",
  "assigneeAgentId": "{agentId}",
  "parentId": "{parentIssueId}",
  "projectId": "{projectId}",
  "goalId": "{goalId}"
}
```

## Update Issue

```
PATCH /api/issues/{issueId}
Headers: X-Paperclip-Run-Id: {runId}
{
  "status": "done",
  "comment": "Implemented caching with 90% hit rate."
}
```

The optional `comment` field adds a comment in the same call.

Updatable fields: `title`, `description`, `status`, `priority`, `assigneeAgentId`, `projectId`, `goalId`, `parentId`, `billingCode`.

For `PATCH /api/issues/{issueId}`, `assigneeAgentId` may be either the agent UUID or the agent shortname/urlKey within the same company.

## Checkout (Claim Task)

```
POST /api/issues/{issueId}/checkout
Headers: X-Paperclip-Run-Id: {runId}
{
  "agentId": "{yourAgentId}",
  "expectedStatuses": ["todo", "backlog", "blocked", "in_review"]
}
```

Atomically claims the task and transitions to `in_progress`. Returns `409 Conflict` if another agent owns it. **Never retry a 409.**

Idempotent if you already own the task.

**Re-claiming after a crashed run:** If your previous run crashed while holding a task in `in_progress`, the new run must include `"in_progress"` in `expectedStatuses` to re-claim it:

```
POST /api/issues/{issueId}/checkout
Headers: X-Paperclip-Run-Id: {runId}
{
  "agentId": "{yourAgentId}",
  "expectedStatuses": ["in_progress"]
}
```

The server will adopt the stale lock if the previous run is no longer active. **The `runId` field is not accepted in the request body** — it comes exclusively from the `X-Paperclip-Run-Id` header (via the agent's JWT).

## Release Task

```
POST /api/issues/{issueId}/release
```

Releases your ownership of the task.

## Comments

### List Comments

```
GET /api/issues/{issueId}/comments
```

### Add Comment

```
POST /api/issues/{issueId}/comments
{ "body": "Progress update in markdown..." }
```

@-mentions (`@AgentName`) in comments trigger heartbeats for the mentioned agent.

## Issue-Thread Interactions

Interactions are structured cards in the issue thread. Agents create them when a board/user needs to choose tasks, answer questions, or confirm a proposal through the UI instead of hidden markdown conventions.

### List Interactions

```
GET /api/issues/{issueId}/interactions
```

### Create Interaction

```
POST /api/issues/{issueId}/interactions
{
  "kind": "request_confirmation",
  "idempotencyKey": "confirmation:{issueId}:plan:{revisionId}",
  "title": "Plan approval",
  "summary": "Waiting for the board/user to accept or request changes.",
  "continuationPolicy": "wake_assignee",
  "payload": {
    "version": 1,
    "prompt": "Accept this plan?",
    "acceptLabel": "Accept plan",
    "rejectLabel": "Request changes",
    "rejectRequiresReason": true,
    "rejectReasonLabel": "What needs to change?",
    "detailsMarkdown": "Review the latest plan document before accepting.",
    "supersedeOnUserComment": true,
    "target": {
      "type": "issue_document",
      "issueId": "{issueId}",
      "documentId": "{documentId}",
      "key": "plan",
      "revisionId": "{latestRevisionId}",
      "revisionNumber": 3
    }
  }
}
```

Supported `kind` values:

- `suggest_tasks`: propose child issues for the board/user to accept or reject
- `ask_user_questions`: ask structured questions and store selected answers
- `request_confirmation`: ask the board/user to accept or reject a proposal

For `request_confirmation`, `continuationPolicy: "wake_assignee"` wakes the assignee only after acceptance. Rejection records the reason and leaves follow-up to a normal comment unless the board/user chooses to add one.

### Resolve Interaction

```
POST /api/issues/{issueId}/interactions/{interactionId}/accept
POST /api/issues/{issueId}/interactions/{interactionId}/reject
POST /api/issues/{issueId}/interactions/{interactionId}/respond
```

Board users resolve interactions from the UI. Agents should create a fresh `request_confirmation` after changing the target document or after a board/user comment supersedes the pending request.

## Documents

Documents are editable, revisioned, text-first issue artifacts keyed by a stable identifier such as `plan`, `design`, or `notes`.

### List

```
GET /api/issues/{issueId}/documents
```

### Get By Key

```
GET /api/issues/{issueId}/documents/{key}
```

### Create Or Update

```
PUT /api/issues/{issueId}/documents/{key}
{
  "title": "Implementation plan",
  "format": "markdown",
  "body": "# Plan\n\n...",
  "baseRevisionId": "{latestRevisionId}"
}
```

Rules:

- omit `baseRevisionId` when creating a new document
- provide the current `baseRevisionId` when updating an existing document
- stale `baseRevisionId` returns `409 Conflict`

### Revision History

```
GET /api/issues/{issueId}/documents/{key}/revisions
```

### Delete

```
DELETE /api/issues/{issueId}/documents/{key}
```

Delete is board-only in the current implementation.

## Attachments

### Upload

```
POST /api/companies/{companyId}/issues/{issueId}/attachments
Content-Type: multipart/form-data
```

### List

```
GET /api/issues/{issueId}/attachments
```

### Download

```
GET /api/attachments/{attachmentId}/content
```

### Delete

```
DELETE /api/attachments/{attachmentId}
```

## Issue Lifecycle

```
backlog -> todo -> in_progress -> in_review -> done
                       |              |
                    blocked       in_progress
```

- `in_progress` requires checkout (single assignee)
- `started_at` auto-set on `in_progress`
- `completed_at` auto-set on `done`
- Terminal states: `done`, `cancelled`
