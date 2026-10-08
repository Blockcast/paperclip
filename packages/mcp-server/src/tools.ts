import { z } from "zod";
import {
  addIssueCommentSchema,
  askUserQuestionsPayloadSchema,
  checkoutIssueSchema,
  createApprovalSchema,
  createIssueInputSchema,
  createMilestoneSchema,
  issueExecutionMonitorPolicySchema,
  issueThreadInteractionContinuationPolicySchema,
  requestCheckboxConfirmationPayloadSchema,
  requestConfirmationPayloadSchema,
  suggestTasksPayloadSchema,
  updateIssueSchema,
  updateMilestoneSchema,
  upsertIssueDocumentSchema,
  linkIssueApprovalSchema,
} from "@paperclipai/shared";
import { PaperclipApiClient } from "./client.js";
import { formatErrorResponse, formatTextResponse } from "./format.js";

export interface ToolDefinition {
  name: string;
  description: string;
  schema: z.AnyZodObject;
  execute: (input: Record<string, unknown>) => Promise<{
    content: Array<{ type: "text"; text: string }>;
    // Set by formatErrorResponse. Keeping it in the declared return type makes
    // MCP error propagation visible to implementers and tests (BLO-18466).
    isError?: boolean;
  }>;
}

function makeTool<TSchema extends z.ZodRawShape>(
  name: string,
  description: string,
  schema: z.ZodObject<TSchema>,
  execute: (input: z.infer<typeof schema>) => Promise<unknown>,
): ToolDefinition {
  return {
    name,
    description,
    schema,
    execute: async (input) => {
      try {
        const parsed = schema.parse(input);
        return formatTextResponse(await execute(parsed));
      } catch (error) {
        return formatErrorResponse(error);
      }
    },
  };
}

function parseOptionalJson(raw: string | undefined | null): unknown {
  if (!raw || raw.trim().length === 0) return undefined;
  return JSON.parse(raw);
}

// Accept either a company UUID or a human issue-prefix (e.g. "PEN", "BLO").
// Prefixes are resolved against the auth token's company memberships server-side.
const companyIdOptional = z.string().trim().min(1).optional().nullable();
const agentIdOptional = z.string().uuid().optional().nullable();
const issueIdSchema = z.string().min(1);
const projectIdSchema = z.string().min(1);
const goalIdSchema = z.string().uuid();
const approvalIdSchema = z.string().uuid();
const documentKeySchema = z.string().trim().min(1).max(64);

// BLO-27561: `q` is a literal contiguous ILIKE '%…%' over four columns — it is NOT
// tokenized (server/src/services/issues.ts, `list`). Agent instructions fleet-wide
// mandate this call as the pre-filing duplicate gate, and its failure direction is the
// harmful one: a descriptive multi-word query returns `[]`, which is indistinguishable
// from "no such issue exists". Both tools share this string so the alias cannot drift
// out of sync with the primary.
const ISSUE_SEARCH_Q_DESCRIPTION =
  "Literal contiguous substring match (case-insensitive), NOT tokenized: no AND-of-terms, no stemming, no fuzzy matching. Matched against title, identifier, description, and comment bodies; results are bucketed title > identifier > comment > description, which is a coarse field precedence and not a relevance score.\n\nMULTI-WORD INPUT IS UNRELIABLE — the whole string must appear verbatim and contiguously, so word order and every interior word matter. `dependency-waits provider` does NOT match a title reading `dependency-waits and provider-capacity`; deleting one interior word turns a hit into a miss.\n\nThis matters most when you are using this call as a duplicate check before filing. An empty result for a multi-word phrase is NOT evidence that no such issue exists, and the more precisely you describe your finding the more certain the false clear. Query ONE distinctive token (an error code, a ticket identifier, a rare noun, a symbol name) and read the results yourself; run several single-token queries rather than one descriptive phrase. `%` and `_` are matched literally, not as wildcards.";

// BLO-40145: `GET /companies/:id/issues` implements NO time bound. These params
// are DECLARED only so they can be REFUSED — they are not supported and never
// reach the server.
//
// Declaring them is load-bearing, not decoration. `index.ts` registers every
// tool as `server.tool(name, desc, schema.shape, execute)`, and the SDK rebuilds
// its own non-strict object from that raw shape — so an UNDECLARED key is
// stripped before `execute` ever runs. Measured on the real client/server
// transport: `paperclipListIssues(q, limit, updated_after)` issued
// `?q=Cilium&limit=3` with no `updated_after` at all, and returned `isError:
// undefined`. The route's own 400 therefore cannot fire for an MCP caller, and
// the caller gets a clean 200 over the WHOLE corpus with nothing to read as a
// warning. Declared, Zod refuses the call instead.
//
// `.refine` rather than `z.never()`: the point is that the caller learns where
// the real time bound lives, and "Expected never, received string" does not say
// that.
//
// The route's shape-matched regex (`parseUnsupportedTimeFilterParams`) is NOT a
// backstop for an MCP caller: by the stripping above, an undeclared alias never
// reaches it. Enumerating keys in the shape is the only lever this layer has —
// an object-level `.superRefine`/`.passthrough()` is discarded, because only
// `schema.shape` is registered. So the aliases are generated from the same
// prefix x suffix lists as `TIME_FILTER_PARAM_PATTERN` in
// server/src/lib/issue-list-query.ts — keep the two in sync — in both
// snake_case and camelCase. Other casings that case-insensitive regex also
// matches (`UpdatedAfter`, `updatedafter`) are still stripped here.
const unsupportedTimeFilter = z
  .unknown()
  .optional()
  .refine((value) => value === undefined, {
    message:
      "not supported on this endpoint — it applies no time bound, and the param was previously dropped unread so the call returned the whole corpus while reading as a bounded census (BLO-40145). Use GET /api/companies/:companyId/search with updatedAfter or updatedWithin, or sortField=id with afterId to walk rows by key.",
  })
  .describe(
    "NOT SUPPORTED — rejected, never applied. Declared only so the call fails loudly instead of silently returning unfiltered rows. See the time-bound paragraph in this tool's description.",
  );

const TIME_FILTER_PREFIXES = [
  "updated",
  "created",
  "started",
  "completed",
  "resolved",
  "closed",
  "modified",
] as const;
const TIME_FILTER_SUFFIXES = ["after", "before", "since", "until", "within", "from", "to"] as const;
type TimeFilterPrefix = (typeof TIME_FILTER_PREFIXES)[number];
type TimeFilterSuffix = (typeof TIME_FILTER_SUFFIXES)[number];
type TimeFilterKey =
  | `${TimeFilterPrefix}_${TimeFilterSuffix}`
  | `${TimeFilterPrefix}${Capitalize<TimeFilterSuffix>}`;

const unsupportedTimeFilterShape = Object.fromEntries(
  TIME_FILTER_PREFIXES.flatMap((prefix) =>
    TIME_FILTER_SUFFIXES.flatMap((suffix) => [
      `${prefix}_${suffix}`,
      `${prefix}${suffix[0].toUpperCase()}${suffix.slice(1)}`,
    ]),
  ).map((key) => [key, unsupportedTimeFilter]),
) as Record<TimeFilterKey, typeof unsupportedTimeFilter>;

const listIssuesSchema = z.object({
  companyId: companyIdOptional,
  status: z.string().optional(),
  // Not real filters. See `unsupportedTimeFilter` above.
  ...unsupportedTimeFilterShape,
  projectId: z.string().uuid().optional(),
  assigneeAgentId: z.string().uuid().optional(),
  participantAgentId: z.string().uuid().optional(),
  assigneeUserId: z.string().optional(),
  touchedByUserId: z.string().optional(),
  inboxArchivedByUserId: z.string().optional(),
  unreadForUserId: z.string().optional(),
  labelId: z.string().uuid().optional(),
  executionWorkspaceId: z.string().uuid().optional(),
  originKind: z.string().optional(),
  originId: z.string().optional(),
  includeRoutineExecutions: z.boolean().optional(),
  includeLiveDescendantSummary: z.boolean().optional(),
  parentId: z
    .string()
    .uuid()
    .optional()
    .describe(
      "Return the DIRECT children of this issue. There is no `children` field on any issue read — this filter is the only way to enumerate sub-issues. An epic that looks childless because you did not pass this has NOT been shown to be childless.",
    ),
  descendantOf: z
    .string()
    .uuid()
    .optional()
    .describe("Return the whole subtree under this issue (all descendants, not just direct children)."),
  includeBlockedBy: z
    .boolean()
    .optional()
    .describe(
      "Hydrate `blockedBy` on every row. Default false, in which case the key is ABSENT (not `[]`) — do not read a missing key as 'no blockers'. `blocks` is never hydrated on list at any setting; use paperclipGetIssue for that.",
    ),
  q: z.string().optional().describe(ISSUE_SEARCH_Q_DESCRIPTION),
  // BLO-33741: without these an MCP caller could neither raise the 500 default
  // nor page past it, so learning a page was truncated left nothing to do
  // about it. They pass straight through as query params.
  //
  // Deliberately NO `.max()`: the REST endpoint clamps an oversized `limit` to
  // ISSUE_LIST_MAX_LIMIT (`clampIssueListLimit`) and 400s only on a
  // non-positive / non-integer value. A schema bound here would reject the
  // oversized request this very description tells callers is clamped, so they
  // could never observe `appliedLimit: 1000`. Keep the client permissive and
  // let the server's clamp be the single source of truth.
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Rows to return. Defaults to 500; the server hard-caps it at 1000 and a larger value is silently clamped to 1000, NOT rejected. When the cap bites, the response is an object `{truncated: true, appliedLimit, returnedCount, note, issues: [...]}` instead of the usual bare array — so a plain array back is itself the proof that you have every matching row. Page the remainder with `offset`.",
    ),
  offset: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Rows to skip. Use with `limit` to page past a truncated result."),
});

const searchIssuesSchema = listIssuesSchema.omit({ q: true }).extend({
  query: z.string().trim().min(1).describe(ISSUE_SEARCH_Q_DESCRIPTION),
});

const listCommentsSchema = z.object({
  issueId: issueIdSchema,
  after: z.string().uuid().optional(),
  order: z.enum(["asc", "desc"]).optional(),
  limit: z.number().int().positive().max(500).optional(),
});

const upsertDocumentToolSchema = z.object({
  issueId: issueIdSchema,
  key: documentKeySchema,
  title: z.string().trim().max(200).nullable().optional(),
  format: z.enum(["markdown"]).default("markdown"),
  body: z.string().max(524288),
  changeSummary: z.string().trim().max(500).nullable().optional(),
  baseRevisionId: z.string().uuid().nullable().optional(),
});

const createIssueToolSchema = z.object({
  companyId: companyIdOptional,
}).merge(createIssueInputSchema);

const updateIssueToolSchema = z.object({
  issueId: issueIdSchema,
}).merge(updateIssueSchema);

const checkoutIssueToolSchema = z.object({
  issueId: issueIdSchema,
  agentId: agentIdOptional,
  expectedStatuses: checkoutIssueSchema.shape.expectedStatuses.optional(),
});

const setIssueMonitorToolSchema = z.object({
  issueId: issueIdSchema,
}).merge(issueExecutionMonitorPolicySchema);

const addCommentToolSchema = z.object({
  issueId: issueIdSchema,
}).merge(addIssueCommentSchema.innerType());

const createSuggestTasksToolSchema = z.object({
  issueId: issueIdSchema,
  idempotencyKey: z.string().trim().max(255).nullable().optional(),
  sourceCommentId: z.string().uuid().nullable().optional(),
  sourceRunId: z.string().uuid().nullable().optional(),
  title: z.string().trim().max(240).nullable().optional(),
  summary: z.string().trim().max(1000).nullable().optional(),
  continuationPolicy: issueThreadInteractionContinuationPolicySchema.optional().default("wake_assignee"),
  payload: suggestTasksPayloadSchema,
});

const withdrawInteractionToolSchema = z.object({
  issueId: issueIdSchema,
  interactionId: z.string().uuid(),
  reason: z.string().trim().max(4000).optional(),
});

const createAskUserQuestionsToolSchema = z.object({
  issueId: issueIdSchema,
  idempotencyKey: z.string().trim().max(255).nullable().optional(),
  sourceCommentId: z.string().uuid().nullable().optional(),
  sourceRunId: z.string().uuid().nullable().optional(),
  title: z.string().trim().max(240).nullable().optional(),
  summary: z.string().trim().max(1000).nullable().optional(),
  continuationPolicy: issueThreadInteractionContinuationPolicySchema.optional().default("wake_assignee"),
  payload: askUserQuestionsPayloadSchema,
});

const createRequestConfirmationToolSchema = z.object({
  issueId: issueIdSchema,
  idempotencyKey: z.string().trim().max(255).nullable().optional(),
  sourceCommentId: z.string().uuid().nullable().optional(),
  sourceRunId: z.string().uuid().nullable().optional(),
  title: z.string().trim().max(240).nullable().optional(),
  summary: z.string().trim().max(1000).nullable().optional(),
  continuationPolicy: issueThreadInteractionContinuationPolicySchema.optional().default("none"),
  payload: requestConfirmationPayloadSchema,
});

const createRequestCheckboxConfirmationToolSchema = z.object({
  issueId: issueIdSchema,
  idempotencyKey: z.string().trim().max(255).nullable().optional(),
  sourceCommentId: z.string().uuid().nullable().optional(),
  sourceRunId: z.string().uuid().nullable().optional(),
  title: z.string().trim().max(240).nullable().optional(),
  summary: z.string().trim().max(1000).nullable().optional(),
  continuationPolicy: issueThreadInteractionContinuationPolicySchema.optional().default("wake_assignee"),
  payload: requestCheckboxConfirmationPayloadSchema,
});

const approvalDecisionSchema = z.object({
  approvalId: approvalIdSchema,
  action: z.enum(["approve", "reject", "requestRevision", "resubmit", "withdraw"]),
  decisionNote: z.string().optional(),
  // `withdraw` and `resubmit` are both requester-scoped; only approve/reject/
  // requestRevision call assertBoard. The withdraw route additionally requires a
  // non-empty reason, so accept a dedicated `reason` rather than making callers
  // learn that `decisionNote` is overloaded. `decisionNote` is still read as a
  // fallback, and on the non-withdraw path `reason` folds back into
  // `decisionNote` so a note can never be silently dropped either way.
  reason: z.string().optional(),
  payloadJson: z.string().optional(),
});

const createApprovalToolSchema = z.object({
  companyId: companyIdOptional,
}).merge(createApprovalSchema);

const milestoneIdSchema = z.string().uuid();

const createMilestoneToolSchema = z.object({
  companyId: companyIdOptional,
}).merge(createMilestoneSchema);

const listMilestonesToolSchema = z.object({
  companyId: companyIdOptional,
  projectId: z.string().uuid().optional(),
});

const updateMilestoneToolSchema = z.object({
  milestoneId: milestoneIdSchema,
}).merge(updateMilestoneSchema);

const apiRequestSchema = z.object({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  path: z.string().min(1),
  jsonBody: z.string().optional(),
});

const workspaceRuntimeControlTargetSchema = z.object({
  workspaceCommandId: z.string().min(1).optional().nullable(),
  runtimeServiceId: z.string().uuid().optional().nullable(),
  serviceIndex: z.number().int().nonnegative().optional().nullable(),
});

const issueWorkspaceRuntimeControlSchema = z.object({
  issueId: issueIdSchema,
  action: z.enum(["start", "stop", "restart"]),
}).merge(workspaceRuntimeControlTargetSchema);

const waitForIssueWorkspaceServiceSchema = z.object({
  issueId: issueIdSchema,
  runtimeServiceId: z.string().uuid().optional().nullable(),
  serviceName: z.string().min(1).optional().nullable(),
  timeoutSeconds: z.number().int().positive().max(300).optional(),
});

const tailHeartbeatRunLogSchema = z.object({
  runId: z.string().min(1),
  offset: z.number().int().nonnegative().optional().default(0),
  limitBytes: z.number().int().positive().max(256_000).optional().default(16_384),
});

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readCurrentExecutionWorkspace(context: unknown): Record<string, unknown> | null {
  if (!context || typeof context !== "object") return null;
  const workspace = (context as { currentExecutionWorkspace?: unknown }).currentExecutionWorkspace;
  return workspace && typeof workspace === "object" ? workspace as Record<string, unknown> : null;
}

function readWorkspaceRuntimeServices(workspace: Record<string, unknown> | null): Array<Record<string, unknown>> {
  const raw = workspace?.runtimeServices;
  return Array.isArray(raw)
    ? raw.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
    : [];
}

function selectRuntimeService(
  services: Array<Record<string, unknown>>,
  input: { runtimeServiceId?: string | null; serviceName?: string | null },
) {
  if (input.runtimeServiceId) {
    return services.find((service) => service.id === input.runtimeServiceId) ?? null;
  }
  if (input.serviceName) {
    return services.find((service) => service.serviceName === input.serviceName) ?? null;
  }
  return services.find((service) => service.status === "running" || service.status === "starting")
    ?? services[0]
    ?? null;
}

async function getIssueWorkspaceRuntime(client: PaperclipApiClient, issueId: string) {
  const context = await client.requestJson("GET", `/issues/${encodeURIComponent(issueId)}/heartbeat-context`);
  const workspace = readCurrentExecutionWorkspace(context);
  return {
    context,
    workspace,
    runtimeServices: readWorkspaceRuntimeServices(workspace),
  };
}

type ListIssuesInput = z.infer<typeof listIssuesSchema>;

/**
 * BLO-33741: fold the server's truncation headers into the tool result.
 *
 * Exported for test. The asymmetry is deliberate and is the whole point: an
 * UNtruncated response passes through as the bare array callers already parse,
 * so nothing that works today changes shape. Only the case that is currently
 * silently wrong — a capped page indistinguishable from a complete one — gets
 * the envelope, and it gets one loud enough that a caller cannot read past it.
 */
export function applyIssueListTruncationEnvelope(data: unknown, headers: Headers): unknown {
  if (headers.get("x-result-truncated") !== "true") return data;
  const appliedLimit = Number(headers.get("x-applied-limit"));
  const rows = Array.isArray(data) ? data : [];
  return {
    truncated: true,
    appliedLimit: Number.isFinite(appliedLimit) ? appliedLimit : null,
    returnedCount: rows.length,
    note:
      `TRUNCATED: this response holds ${rows.length} rows and MORE MATCH beyond it. ` +
      "This is a prefix, not the population — do not report a count from it. " +
      "Page with `offset` (offset += appliedLimit), or narrow the query where the surface supports it.",
    issues: rows,
  };
}

async function listIssues(client: PaperclipApiClient, input: ListIssuesInput) {
  const companyId = await client.resolveCompany({ override: input.companyId });
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (key === "companyId" || value === undefined || value === null) continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  const { data, headers } = await client.requestJsonWithHeaders(
    "GET",
    `/companies/${companyId}/issues${qs ? `?${qs}` : ""}`,
    { companyId },
  );
  return applyIssueListTruncationEnvelope(data, headers);
}

export function createToolDefinitions(client: PaperclipApiClient): ToolDefinition[] {
  return [
    makeTool(
      "paperclipMe",
      "Get your own agent identity: id, companyId, role, chainOfCommand, and budget. Call this first in a heartbeat if identity isn't already in context.",
      z.object({}),
      async () => client.requestJson("GET", "/agents/me"),
    ),
    makeTool(
      "paperclipInboxLite",
      "Get your compact assignment list for prioritizing this heartbeat. Returns ONLY issues assigned to you in todo, in_progress, or blocked. `in_review` is deliberately excluded: review/approval waits resume via comment, interaction, and monitor wakes rather than being re-picked every heartbeat. So an empty array means \"nothing to pick\" — NOT that the call failed. On an unscoped heartbeat wake, exit. If the wake NAMES an issue (PAPERCLIP_TASK_ID set, or a comment/mention/interaction/approval/monitor/recovery wake), do NOT exit on empty — read that issue by id with paperclipGetIssue and work it; empty is the expected response when the named issue is `in_review`. Either way, never fall back to a raw paperclipListIssues sweep to find work: it is checkout-lock-blind and can duplicate a concurrent run's work. Each entry carries `activeRun`, `dependencyReady`, and `unresolvedBlockerCount` so you can skip work another run already owns. ⚠ It is INTENDED to carry all three wake-path fields — `activeRun`, `monitorNextCheckAt`, and `scheduledRetryAt` (plus `scheduledRetryReason`/`scheduledRetryAttempt`) — each explicitly `null` when unset. VERIFY THAT BEFORE RELYING ON IT. `activeRun` is always present, but the other four were ABSENT KEYS until the BLO-34421 fix, and this description and the paperclip-api deploy reach you on DIFFERENT CADENCES — so a deployment predating the fix serves this sentence over a payload that cannot support it (measured absent on 493/493 rows, with `activeRun` present on 493/493 as the positive control, 2026-09-30). Absent is not `null`: read as `null` it scores EVERY row unattended, which is the bulk-demotion direction this warning exists to prevent. So gate the predicate on key presence — `has(\"monitorNextCheckAt\") and has(\"scheduledRetryAt\")` — and when either key is absent, attendance is NOT computable from this response: use paperclipListIssues(assigneeAgentId=me), which hydrates all four (BLO-34421). It ALSO carries the deliberate-park columns — `parkedUntil`, `parkedReason`, `parkedByAgentId`, `parkedAt` — each explicitly `null` when unset, and they inherit the same caveat for the same reason: they were ABSENT KEYS until the BLO-39015 fix, so gate on `has(\"parkedUntil\")` before reading one and treat an absent key as \"not computable from this response\", never as \"not parked\". A park is a strandedness-sweep satisfier, NOT a dispatch gate: a live `parkedUntil` row is still OFFERED here on purpose (suppressing it would remove the row from the only surface BLO-27553 disposition 2 leaves it reachable on), so read it to tell a deliberate park apart from an idle row — not as permission to skip it. It is NOT a lane-wide attendance census: rows held by another running run, `in_review` rows, and pre-cutoff worktree rows are withheld, and all three skew attended. A live monitor means `monitorNextCheckAt` in the future; an overdue one is a wake that did not happen. Prefer this over paperclipListIssues(assigneeAgentId=me) for the normal heartbeat inbox check — it's the cheaper, purpose-built call.\n\nATTENDED IS NOT THE SAME AS ABLE. `activeRun.writeContainment` (PEN-3275) answers the question the three liveness paths do not: not 'is a run attending this row?' but 'can that run perform this row's remedy?'. It is `\"status_only\"`, `\"planning_only\"`, or `null` for an unconstrained run. A contained run reads as fully attended — the wake is delivered and serviced, `activeRun` populates — while the approval writes the row may need are refused 403 by the route guards. A `status_only` run may create ONLY a `request_board_approval`, and is refused creating, modifying, commenting on, resubmitting, withdrawing, applying, and linking/unlinking every other approval; a `planning_only` run is refused approval create/modify outright, with no escalation exit. So a populated `activeRun` is NOT evidence the row can be moved, and the opposite reading ('nothing is chasing this') is equally wrong. ⚠ Same deploy-skew caveat as the scalars above, and the same fail-open direction: a deployment predating PEN-3275 omits `writeContainment` entirely, and ABSENT IS NOT `null` — `null` means positively unconstrained, absent means unknown. A truthiness test reads both as 'not contained'. Gate on key presence before concluding a run is unconstrained.\n\n⚠ THIS PAGE IS CAPPED AND ORDERED BY PRIORITY — `critical` → `high` → `medium` → `low`, then most-recent-activity first WITHIN each band. The cap is 500 today; when the envelope fires it reports the live value as `appliedLimit` (see THE TELL below) — page off that rather than hardcoding a number. On a lane deeper than the cap the cut lands mid-band and every row below it is absent, so on a deep lane `low` rows can be entirely unreachable from page 1. The rows are still perfectly healthy — `todo`, assigned, dependency-clear — which is why nothing downstream notices (BLO-39015: 139 of 634 rows invisible on one lane, including all 44 `low`).\n\nTHE TELL: when the cap bites, the response is an OBJECT `{truncated: true, appliedLimit, returnedCount, note, issues: [...]}` instead of the usual bare array. A bare array is the proof you have every row; an object means you are holding a PREFIX. Page the remainder with `offset` (offset += appliedLimit) until a bare array comes back. Do NOT infer truncation from the returned length: eligibility filters (foreign-run holds, worktree cutoff) only ever SHORTEN the page, so a truncated page routinely returns fewer than `appliedLimit` rows — `returnedCount < appliedLimit` with `truncated: true` is normal, not a contradiction.\n\n⚠ PAGING MAKES THE TAIL REACHABLE; IT DOES NOT MAKE THE UNION A CENSUS. Offset paging over a mutating collection duplicates and drops rows, and the within-band sort key is last-activity — which every comment bumps — so on an active lane a page-2 row can migrate into the page-1 window between fetches and never be seen at all. For an exact per-agent open count use `GET /companies/:id/issues/open-assignment-census` (one statement, one MVCC snapshot). It needs company-scope read, which not every agent seat holds; if yours does not, report the paged union as a floor rather than as a count.\n\nThis matters for BLO-27553's strand remedy, which says to park unreachable work as `todo` because `todo` keeps a row here and re-dispatchable. That holds only for the rows this page actually returns: on a deep lane, demoting a `low` row to `todo` without paging is disposal with a healthy-looking receipt.",
      z.object({
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            "Rows to skip. Use to page past a truncated page: offset += appliedLimit, repeat until a bare array returns.",
          ),
      }),
      async ({ offset }) => {
        const suffix = offset === undefined ? "" : `?offset=${offset}`;
        const { data, headers } = await client.requestJsonWithHeaders(
          "GET",
          `/agents/me/inbox-lite${suffix}`,
        );
        return applyIssueListTruncationEnvelope(data, headers);
      },
    ),
    makeTool(
      "paperclipListAgents",
      "List every agent in a company with their name, role, status (running/idle/paused/error), and reporting line.",
      z.object({ companyId: companyIdOptional }),
      async ({ companyId }) => {
        const resolved = await client.resolveCompany({ override: companyId });
        return client.requestJson("GET", `/companies/${resolved}/agents`, { companyId: resolved });
      },
    ),
    makeTool(
      "paperclipListParkedAgents",
      "Answer \"which agents cannot run right now, and until when?\". Lists agents whose heartbeat run is parked on a scheduled retry, soonest-due first, with the retry reason, attempt number, and — for provider-capacity parks — what the provider advertised beside what was actually booked. Use this instead of invoking a heartbeat on each agent to discover it is frozen. Filter with reason (e.g. ccrotate_capacity).\n\nTwo populations, told apart by `runStatus` (PEN-3607). `scheduled_retry` = still parked, waiting out its own horizon; `overdueMs` is 0 and `retryInMs` says how much longer. `queued` = the park already FIRED and promotion succeeded, but dispatch has not claimed the run. These have unrelated remedies: the first is provider capacity, the second is the dispatcher, so do not report a `queued` row as a capacity wait. Note `promoteScheduledRetryRun` never clears `scheduledRetryAt` / `scheduledRetryReason` / `scheduledRetryAttempt` on promotion, so a `queued` row's `reason` describes the park it CAME FROM, and `attempt: 0` there means \"promoted on its first due-time hit, never re-deferred\" — NOT \"never retried\".\n\n⚠️ `overdueMs` is time past the park's OWN due time, and on a `queued` row that spans park-due → promotion → now — the SUM of promotion lag and dispatch wait, not the dispatch wait. Read `queuedForMs` (from `queuedAt`, stamped at promotion) for how long dispatch has actually failed to claim it, and the difference between the two for how slow the promotion sweep was. Reporting `overdueMs` as dispatch wait blames the dispatcher for a wedged sweep — a 28 h sweep stall that promotes a due park 10 min ago shows `overdueMs ≈ 29 h` against a real dispatch wait of 10 min. `queuedForMs` is null on rows promoted before that column existed, meaning unmeasurable, NOT zero.\n\n⚠️ Counts come in two units and they are different numbers. `parkedRunCount` / `overdueRunCount` count RUNS and `agents[]` is one entry per run, so a seat holding several parks appears several times — that is the normal case, and it is exactly what the seat behind PEN-3607 looked like. `parkedAgentCount` / `overdueAgentCount` are the SEAT counts; use those to answer \"how many agents are down\". (Older `parkedCount` / `overdueCount` are gone rather than redefined, so a stale reader breaks instead of silently over-counting seats.) When `truncated` is true, `limit` bounded rows, so both agent counts are lower bounds.\n\n⛔ `overdueAgentCount: 0` is not by itself a clean bill of health for the fleet: it counts only rows this endpoint selected. An agent that is dark for some reason other than a park (a dispatch gate, a wedged start lock) still does not appear here at all. Check the seat's own run rows before concluding it is fine.",
      z.object({ companyId: companyIdOptional, reason: z.string().min(1).max(64).optional(), limit: z.number().int().min(1).max(1000).optional() }),
      async ({ companyId, reason, limit }) => {
        const resolved = await client.resolveCompany({ override: companyId });
        const query = new URLSearchParams();
        if (reason) query.set("reason", reason);
        if (limit !== undefined) query.set("limit", String(limit));
        const suffix = query.size > 0 ? `?${query.toString()}` : "";
        return client.requestJson("GET", `/companies/${resolved}/parked-agents${suffix}`, {
          companyId: resolved,
        });
      },
    ),
    makeTool(
      "paperclipGetAgent",
      "Get one agent's full record by id: status, budget (monthly cap + spend), pause/error reason, and org-chain health.",
      z.object({ agentId: z.string().min(1), companyId: companyIdOptional }),
      async ({ agentId, companyId }) => {
        const resolved = await client.resolveCompany({ override: companyId });
        const qs = companyId ? `?companyId=${encodeURIComponent(resolved)}` : "";
        return client.requestJson("GET", `/agents/${encodeURIComponent(agentId)}${qs}`, {
          companyId: resolved,
        });
      },
    ),
    makeTool(
      "paperclipListIssues",
      "List issues for a company with optional filters (status, projectId, assigneeAgentId, labelId, q, ...). Omitting a filter does not scope it — pass status explicitly if you only want open work; unfiltered can return the full company backlog.\n\nTHERE IS NO TIME BOUND ON THIS CALL, AND ASKING FOR ONE NOW FAILS INSTEAD OF BEING IGNORED. `updated_after` and its aliases were never implemented here — they were dropped unread, so the call returned the WHOLE corpus while reading as a bounded census (BLO-40145). They are now rejected: an alias is refused by this tool, and the route 400s any param of that shape. ⚠ THE OLD FAILURE PASSED ITS OWN SPOT CHECK, which is why it survived: the default sort is priority band then recency, so a recent floor with a small `limit` returned rows that genuinely were recent and the bound looked honoured. Adding a second filter (`q`, `originKind`) moved the window off that recency-hot prefix and surfaced old rows — which reads as 'the time bound composes badly' rather than 'there is no time bound'. The direction is the expensive one: a census written as 'rows in class C since the fix' silently becomes 'the first N rows of the corpus', and since the fix is recent almost nothing in that prefix post-dates it, so the read returns a small number or zero and that reads as the fix holding. For a real time-bounded read use `GET /api/companies/:companyId/search` with `updatedAfter` / `updatedWithin`, or walk rows by key with `sortField=id` + `afterId`. Every other filter here (`status`, `assigneeAgentId`, `projectId`, `labelId`, `q`, `originKind`) IS read and composes normally — the defect was the absence of a time filter, not composition.\n\nTHIS CALL IS CAPPED AT 500 ROWS BY DEFAULT AND 1000 MAXIMUM. Pass `limit` to raise it up to 1000; a larger value is clamped to 1000, not rejected. When the cap bites you get an OBJECT — `{truncated: true, appliedLimit, returnedCount, note, issues: [...]}` — instead of the usual bare array, so a bare array back is positive proof you have every matching row and an object means you are holding a PREFIX. Never report a population count off a truncated page; page the rest with `limit`/`offset` or narrow the filters.\n\nRELATIONAL FIELDS ARE NOT HYDRATED HERE. `blockedBy` is absent unless you pass includeBlockedBy=true; `blocks` and `children` are NEVER present at any setting. An absent key is not an empty relation — never conclude 'this issue has no blockers' or 'this epic has no children' from a list row. To enumerate children pass parentId (direct) or descendantOf (subtree); to read `blocks`, call paperclipGetIssue.\n\nLIVENESS IS THREE PATHS, AND EVERY ROW CARRIES ALL THREE. An issue is *attended* by a live run (`activeRun`), an armed monitor (`monitorNextCheckAt` + peers), or a scheduled retry (`scheduledRetryAt`, `scheduledRetryReason`, `scheduledRetryAttempt`). The retry scalars are always **present**, explicitly `null` when the issue has no parked run — so `scheduledRetryAt === null` genuinely means 'no retry', and a row is unattended only when all three paths are empty. Auditing on `activeRun` alone systematically over-reports unattended, because a run parked on a concrete `scheduledRetryAt` is not abandoned; that is the defect BLO-28843 fixed, after it produced a >20× lane-capacity error. The scalars mirror `paperclipGetIssue`'s `scheduledRetry` object and agree with `paperclipListParkedAgents` for the same run.\n\nATTENDED IS NOT THE SAME AS ABLE — a fourth, orthogonal axis. `activeRun.writeContainment` (PEN-3275) is `\"status_only\"`, `\"planning_only\"`, or `null` for an unconstrained run, and it answers 'can the attending run perform this row's remedy?' rather than 'is one attending?'. A contained run satisfies the `activeRun` path above while the approval writes the row needs are refused 403 by the route guards: `status_only` may create ONLY a `request_board_approval` and is refused every other approval create/modify/comment/resubmit/withdraw/apply/link; `planning_only` is refused approval create/modify outright, with no escalation exit. Auditing attendance alone therefore scores a structurally stuck row as fine. ⚠ ABSENT IS NOT `null`: a deployment predating PEN-3275 omits the key, `null` means positively unconstrained, and a truthiness test reads both as 'not contained' — the fail-open direction. Gate on key presence.\n\n`blockerAttention` is a coarse triage signal, NOT a summary of `blockedBy`, and reading it as one is wrong in three ways: (1) it is computed for non-terminal rows whose status is `blocked` or whose dependency readiness has unresolved explicit blockers; all-zeros means the row is not an attention root, but open child issues do NOT make a row a root, so all-zeros still tells you nothing about children — enumerate them with parentId; (2) `unresolvedBlockerCount` counts explicit blockers UNION open child issues, so it legitimately exceeds `blockedBy.length`; (3) `sampleBlockerIdentifier` is drawn from the transitive closure and often names an issue absent from `blockedBy`. Use it to rank attention, never to decide a specific issue is unblocked.",
      listIssuesSchema,
      async (input) => listIssues(client, input),
    ),
    makeTool(
      "paperclip_search_issues",
      "Find Paperclip issues whose title, identifier, description, or comments CONTAIN a literal substring. Compatibility alias for clients that ask for paperclip_search_issues; prefer paperclipListIssues with q when choosing tools directly.\n\nDespite the name this is substring matching, not search: the query is not tokenized, so a multi-word phrase must appear verbatim and contiguously. Pass a single distinctive token — see the `query` parameter description before using this as a duplicate check.\n\nSame 500-default / 1000-maximum row cap as paperclipListIssues, and the same signal: a bare array means you have every match, an object with `truncated: true` means you are holding a prefix.",
      searchIssuesSchema,
      async ({ query, ...input }) => listIssues(client, { ...input, q: query }),
    ),
    makeTool(
      "paperclipGetIssue",
      "Get a single issue by UUID or identifier. Cross-company identifiers (e.g. PEN-307) are routed by prefix; the optional company override takes precedence. Dependency edges appear under `blockedBy` (issues blocking this one) and `blocks` (issues this one blocks); the write-only `blockedByIssueIds` field is null here. Use `blockedBy`/`blocks` to read the dependency graph — both are always hydrated on this call, which is why it is the authoritative blocker read.\n\nThere is NO `children` field here (despite older docs claiming one). To enumerate sub-issues call paperclipListIssues with parentId=<this issue id> for direct children, or descendantOf=<id> for the whole subtree.",
      z.object({ issueId: issueIdSchema, company: companyIdOptional }),
      async ({ issueId, company }) => {
        if (!company?.trim()) {
          return client.requestJson("GET", `/issues/${encodeURIComponent(issueId)}`);
        }
        const companyId = await client.resolveCompany({ override: company });
        return client.requestJson("GET", `/issues/${encodeURIComponent(issueId)}`, { companyId });
      },
    ),
    makeTool(
      "paperclipGetHeartbeatContext",
      "Get compact heartbeat context for an issue",
      z.object({ issueId: issueIdSchema, wakeCommentId: z.string().uuid().optional() }),
      async ({ issueId, wakeCommentId }) => {
        const qs = wakeCommentId ? `?wakeCommentId=${encodeURIComponent(wakeCommentId)}` : "";
        return client.requestJson("GET", `/issues/${encodeURIComponent(issueId)}/heartbeat-context${qs}`);
      },
    ),
    makeTool(
      "paperclipListComments",
      "List issue comments with incremental options",
      listCommentsSchema,
      async ({ issueId, after, order, limit }) => {
        const params = new URLSearchParams();
        if (after) params.set("after", after);
        if (order) params.set("order", order);
        if (limit) params.set("limit", String(limit));
        const qs = params.toString();
        return client.requestJson("GET", `/issues/${encodeURIComponent(issueId)}/comments${qs ? `?${qs}` : ""}`);
      },
    ),
    makeTool(
      "paperclipGetComment",
      "Get a specific issue comment by id",
      z.object({ issueId: issueIdSchema, commentId: z.string().uuid() }),
      async ({ issueId, commentId }) =>
        client.requestJson("GET", `/issues/${encodeURIComponent(issueId)}/comments/${encodeURIComponent(commentId)}`),
    ),
    makeTool(
      "paperclipListIssueApprovals",
      "List approvals linked to an issue",
      z.object({ issueId: issueIdSchema }),
      async ({ issueId }) => client.requestJson("GET", `/issues/${encodeURIComponent(issueId)}/approvals`),
    ),
    makeTool(
      "paperclipListDocuments",
      "List issue documents",
      z.object({ issueId: issueIdSchema }),
      async ({ issueId }) => client.requestJson("GET", `/issues/${encodeURIComponent(issueId)}/documents`),
    ),
    makeTool(
      "paperclipGetDocument",
      "Get one issue document by key",
      z.object({ issueId: issueIdSchema, key: documentKeySchema }),
      async ({ issueId, key }) =>
        client.requestJson("GET", `/issues/${encodeURIComponent(issueId)}/documents/${encodeURIComponent(key)}`),
    ),
    makeTool(
      "paperclipListDocumentRevisions",
      "List revisions for an issue document",
      z.object({ issueId: issueIdSchema, key: documentKeySchema }),
      async ({ issueId, key }) =>
        client.requestJson(
          "GET",
          `/issues/${encodeURIComponent(issueId)}/documents/${encodeURIComponent(key)}/revisions`,
        ),
    ),
    makeTool(
      "paperclipListProjects",
      "List projects in a company",
      z.object({ companyId: companyIdOptional }),
      async ({ companyId }) => {
        const resolved = await client.resolveCompany({ override: companyId });
        return client.requestJson("GET", `/companies/${resolved}/projects`, { companyId: resolved });
      },
    ),
    makeTool(
      "paperclipGetProject",
      "Get a project by id or company-scoped short reference",
      z.object({ projectId: projectIdSchema, companyId: companyIdOptional }),
      async ({ projectId, companyId }) => {
        const resolved = await client.resolveCompany({ override: companyId });
        const qs = companyId ? `?companyId=${encodeURIComponent(resolved)}` : "";
        return client.requestJson("GET", `/projects/${encodeURIComponent(projectId)}${qs}`, {
          companyId: resolved,
        });
      },
    ),
    makeTool(
      "paperclipGetIssueWorkspaceRuntime",
      "Get the current execution workspace and runtime services for an issue, including service URLs",
      z.object({ issueId: issueIdSchema }),
      async ({ issueId }) => getIssueWorkspaceRuntime(client, issueId),
    ),
    makeTool(
      "paperclipControlIssueWorkspaceServices",
      "Start, stop, or restart the current issue execution workspace runtime services",
      issueWorkspaceRuntimeControlSchema,
      async ({ issueId, action, ...target }) => {
        const runtime = await getIssueWorkspaceRuntime(client, issueId);
        const workspaceId = typeof runtime.workspace?.id === "string" ? runtime.workspace.id : null;
        if (!workspaceId) {
          throw new Error("Issue has no current execution workspace");
        }
        return client.requestJson(
          "POST",
          `/execution-workspaces/${encodeURIComponent(workspaceId)}/runtime-services/${action}`,
          { body: target },
        );
      },
    ),
    makeTool(
      "paperclipWaitForIssueWorkspaceService",
      "Wait until an issue execution workspace runtime service is running and has a URL when one is exposed",
      waitForIssueWorkspaceServiceSchema,
      async ({ issueId, runtimeServiceId, serviceName, timeoutSeconds }) => {
        const deadline = Date.now() + (timeoutSeconds ?? 60) * 1000;
        let latest: Awaited<ReturnType<typeof getIssueWorkspaceRuntime>> | null = null;
        while (Date.now() <= deadline) {
          latest = await getIssueWorkspaceRuntime(client, issueId);
          const service = selectRuntimeService(latest.runtimeServices, { runtimeServiceId, serviceName });
          if (service?.status === "running" && service.healthStatus !== "unhealthy") {
            return {
              workspace: latest.workspace,
              service,
            };
          }
          await sleep(1000);
        }

        return {
          timedOut: true,
          latestWorkspace: latest?.workspace ?? null,
          latestRuntimeServices: latest?.runtimeServices ?? [],
        };
      },
    ),
    makeTool(
      "paperclipListGoals",
      "List goals in a company",
      z.object({ companyId: companyIdOptional }),
      async ({ companyId }) => {
        const resolved = await client.resolveCompany({ override: companyId });
        return client.requestJson("GET", `/companies/${resolved}/goals`, { companyId: resolved });
      },
    ),
    makeTool(
      "paperclipGetGoal",
      "Get a goal by id",
      z.object({ goalId: goalIdSchema }),
      async ({ goalId }) => client.requestJson("GET", `/goals/${encodeURIComponent(goalId)}`),
    ),
    makeTool(
      "paperclipListApprovals",
      "List approvals in a company. Default view=full returns whole payload bodies and is expensive (hundreds of KB on a busy queue). Before filing a new approval, check for an existing one with view=count or view=summary — summary omits payload and returns a derived, always-populated `label` per row, so a duplicate check costs a fraction of a re-file. Filter by type, issueId, requestedByAgentId, or idempotencyKey to narrow further.",
      z.object({
        companyId: companyIdOptional,
        status: z.string().optional(),
        type: z.string().optional(),
        issueId: z.string().uuid().optional().describe("Only approvals linked to this issue"),
        requestedByAgentId: z.string().uuid().optional(),
        idempotencyKey: z
          .string()
          .optional()
          .describe("Exact-match probe for a key you are about to reuse"),
        view: z
          .enum(["full", "summary", "count"])
          .optional()
          .describe("full (default, includes payload) | summary (no payload, adds label) | count"),
      }),
      async ({ companyId, ...query }) => {
        const resolved = await client.resolveCompany({ override: companyId });
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(query)) {
          if (value !== undefined && value !== null) params.set(key, String(value));
        }
        const qs = params.size > 0 ? `?${params.toString()}` : "";
        return client.requestJson("GET", `/companies/${resolved}/approvals${qs}`, {
          companyId: resolved,
        });
      },
    ),
    makeTool(
      "paperclipCreateApproval",
      "Create a board approval request, optionally linked to one or more issues. Pass idempotencyKey (a stable token derived from the ask itself, e.g. \"rotate-creds:BLO-18969\") so a retry replays the original instead of filing a duplicate: the response then carries deduplicated:true and a statusReadback line telling you the original is still pending. A pending approval emits nothing on its own, so use that readback — or paperclipListApprovals with view=count — instead of re-filing to find out. When the ask is \"a human must click a GitHub Actions gate\", ALSO set payload.gate = {kind:\"github_actions_run\", repoFullName, runId} (url optional) — naming the run in prose alone leaves nothing able to tell whether that gate is still alive, and the card then outlives its run and sends approvers to a dead gate. With payload.gate set, the card is closed automatically and the death announced on every linked issue once the run terminates (BLO-29359).",
      createApprovalToolSchema,
      async ({ companyId, ...body }) => {
        const resolved = await client.resolveCompany({ override: companyId });
        return client.requestJson("POST", `/companies/${resolved}/approvals`, {
          body,
          companyId: resolved,
        });
      },
    ),
    makeTool(
      "paperclipGetApproval",
      "Get an approval by id",
      z.object({ approvalId: approvalIdSchema }),
      async ({ approvalId }) => client.requestJson("GET", `/approvals/${encodeURIComponent(approvalId)}`),
    ),
    makeTool(
      "paperclipGetApprovalIssues",
      "List issues linked to an approval",
      z.object({ approvalId: approvalIdSchema }),
      async ({ approvalId }) => client.requestJson("GET", `/approvals/${encodeURIComponent(approvalId)}/issues`),
    ),
    makeTool(
      "paperclipListApprovalComments",
      "List comments for an approval",
      z.object({ approvalId: approvalIdSchema }),
      async ({ approvalId }) => client.requestJson("GET", `/approvals/${encodeURIComponent(approvalId)}/comments`),
    ),
    makeTool(
      "paperclipCreateIssue",
      "Create a new issue. The response includes advisory `duplicateCandidates`; matches never refuse the create and are independent of `allowDuplicate`. Pass blockedByIssueIds to set dependency blockers at creation (write-only — they read back under `blockedBy`, not `blockedByIssueIds`).",
      createIssueToolSchema,
      async ({ companyId, ...body }) => {
        const resolved = await client.resolveCompany({ override: companyId });
        return client.requestJson("POST", `/companies/${resolved}/issues`, { body, companyId: resolved });
      },
    ),
    makeTool(
      "paperclipUpdateIssue",
      "Patch an issue, optionally including a comment. Include comment with status changes when approving or requesting changes in a review/approval stage; include resume=true when intentionally requesting follow-up on resumable closed work. To set dependencies, pass blockedByIssueIds (the FULL blocker set; it replaces existing, [] clears) — this persists but is WRITE-ONLY: re-reading the issue shows the edges under `blockedBy` (and `relatedWork`), while `blockedByIssueIds` itself reads back null. Verify via `blockedBy`, not `blockedByIssueIds`.",
      updateIssueToolSchema,
      async ({ issueId, ...body }) =>
        client.requestJson("PATCH", `/issues/${encodeURIComponent(issueId)}`, { body }),
    ),
    makeTool(
      "paperclipCheckoutIssue",
      "Check out an issue: assigns it (if unassigned) and acquires the run-scoped execution lock. Ordinary work moves to in_progress; pending execution-policy review/approval stages stay in_review so the reviewer can approve or request changes. You MUST do this before doing any work on an issue. Returns 409 on a checkout conflict — commonly another live run already owns it, but can also fire on a status mismatch. Re-fetch the issue to see the actual status, checkoutRunId, and executionRunId before deciding whether to wait, skip, or pick different work.",
      checkoutIssueToolSchema,
      async ({ issueId, agentId, expectedStatuses }) =>
        client.requestJson("POST", `/issues/${encodeURIComponent(issueId)}/checkout`, {
          body: {
            agentId: client.resolveAgentId(agentId),
            expectedStatuses: expectedStatuses ?? ["todo", "backlog", "blocked", "in_review"],
          },
        }),
    ),
    makeTool(
      "paperclipSetIssueMonitor",
      "Arm or re-arm an issue monitor (wake) and NOTHING ELSE. Prefer this over `paperclipUpdateIssue`'s `executionPolicy.monitor`: that path REPLACES the whole `executionPolicy`, so arming through it means read-modify-write — re-send the complete current policy or you silently delete another agent's `stages`, `reviewPreset` and `authorizationPolicy`, and you race whoever else is writing the row. This call touches the monitor only, so there is nothing to read first and nothing to lose. Same authorization as the legacy path (assignee agent, the agent holding the current execution run, or a board user). Re-arming supersedes a `triggered` monitor, but `attemptCount` survives, so re-sending a `maxAttempts` at or below that count (or a past `timeoutAt`) is still rejected 422 as exhausted — use paperclipClearIssueMonitor for a wedged one. Monitors only hold on an `in_progress`/`in_review` issue assigned to an agent, and an unresolved `blockedBy` edge suppresses the wake, so ALWAYS re-read `monitorNextCheckAt` and treat `null` as failure rather than reporting success off a 200. The BLO-18294 convergence guard applies unchanged: an assignee-scheduled monitor that re-checks the same gate set 3 times running is refused on the 4th and the issue moves to `blocked`.",
      setIssueMonitorToolSchema,
      async ({ issueId, ...monitor }) =>
        client.requestJson("PATCH", `/issues/${encodeURIComponent(issueId)}/monitor`, { body: monitor }),
    ),
    makeTool(
      "paperclipClearIssueMonitor",
      "Clear an issue monitor and NOTHING ELSE, leaving `stages`, `reviewPreset` and `authorizationPolicy` untouched. This is the only reliable exit for a WEDGED monitor: once a monitor fires it is stripped out of `executionPolicy` and survives only in `executionState`, so `paperclipUpdateIssue({executionPolicy:{}})` used to return 200 having changed nothing, while a re-arm 422s as soon as `attemptCount >= maxAttempts` — no exit in either direction. This call keys on `executionState`, so it clears a `triggered` and even an exhausted monitor, and it nulls `monitorNotes` so the next run does not inherit a retired monitor's notes as a live gate. Read back `monitorNextCheckAt` (null) and `executionState.monitor.status` (`cleared`) to confirm.",
      z.object({ issueId: issueIdSchema }),
      async ({ issueId }) =>
        client.requestJson("DELETE", `/issues/${encodeURIComponent(issueId)}/monitor`),
    ),
    makeTool(
      "paperclipReleaseIssue",
      "Release your checkout on an issue: unassigns it and resets it to todo (regardless of what status it was in before checkout — this is not a revert). Inverse of paperclipCheckoutIssue — use when you can no longer make progress and want another agent to be able to pick it up.",
      z.object({ issueId: issueIdSchema }),
      async ({ issueId }) => client.requestJson("POST", `/issues/${encodeURIComponent(issueId)}/release`, { body: {} }),
    ),
    makeTool(
      "paperclipAddComment",
      "Add a comment to an issue; include resume=true when intentionally requesting follow-up on resumable closed work",
      addCommentToolSchema,
      async ({ issueId, ...body }) =>
        client.requestJson("POST", `/issues/${encodeURIComponent(issueId)}/comments`, { body }),
    ),
    makeTool(
      "paperclipSuggestTasks",
      "Create a suggest_tasks interaction on an issue",
      createSuggestTasksToolSchema,
      async ({ issueId, ...body }) =>
        client.requestJson("POST", `/issues/${encodeURIComponent(issueId)}/interactions`, {
          body: {
            kind: "suggest_tasks",
            ...body,
          },
        }),
    ),
    makeTool(
      "paperclipAskUserQuestions",
      "Create an ask_user_questions interaction on an issue. NOTE: `payload.supersedeOnUserComment` DEFAULTS TO TRUE when omitted — while true, any user comment on the issue expires this ask unanswered, including an unrelated one. Pass `false` explicitly for a gate that must survive routine thread traffic, and confirm it in the response.",
      createAskUserQuestionsToolSchema,
      async ({ issueId, ...body }) =>
        client.requestJson("POST", `/issues/${encodeURIComponent(issueId)}/interactions`, {
          body: {
            kind: "ask_user_questions",
            ...body,
          },
        }),
    ),
    makeTool(
      "paperclipRequestConfirmation",
      "Create a request_confirmation interaction on an issue. NOTE: `payload.supersedeOnUserComment` DEFAULTS TO TRUE when omitted — while true, any user comment on the issue expires this ask unanswered, including an unrelated one. Pass `false` explicitly for a gate that must survive routine thread traffic, and confirm it in the response.",
      createRequestConfirmationToolSchema,
      async ({ issueId, ...body }) =>
        client.requestJson("POST", `/issues/${encodeURIComponent(issueId)}/interactions`, {
          body: {
            kind: "request_confirmation",
            ...body,
          },
        }),
    ),
    makeTool(
      "paperclipRequestCheckboxConfirmation",
      "Create a request_checkbox_confirmation interaction on an issue. NOTE: `payload.supersedeOnUserComment` DEFAULTS TO TRUE when omitted — while true, any user comment on the issue expires this ask unanswered, including an unrelated one. Pass `false` explicitly for a gate that must survive routine thread traffic, and confirm it in the response.",
      createRequestCheckboxConfirmationToolSchema,
      async ({ issueId, ...body }) =>
        client.requestJson("POST", `/issues/${encodeURIComponent(issueId)}/interactions`, {
          body: {
            kind: "request_checkbox_confirmation",
            ...body,
          },
        }),
    ),
    makeTool(
      "paperclipWithdrawInteraction",
      "Withdraw a still-pending issue-thread interaction you created (ask_user_questions, request_confirmation, request_checkbox_confirmation, suggest_tasks). Marks it cancelled so it leaves the board's actionable queue while staying visible in issue history. You can only withdraw cards you created, and only while they are still pending. Tool-action confirmations are the human approval gate in front of a write/destructive tool call and can never be withdrawn — accept or reject those instead.",
      withdrawInteractionToolSchema,
      async ({ issueId, interactionId, ...body }) =>
        client.requestJson(
          "POST",
          `/issues/${encodeURIComponent(issueId)}/interactions/${encodeURIComponent(interactionId)}/withdraw`,
          { body },
        ),
    ),
    makeTool(
      "paperclipUpsertIssueDocument",
      "Create or update an issue document",
      upsertDocumentToolSchema,
      async ({ issueId, key, ...body }) =>
        client.requestJson(
          "PUT",
          `/issues/${encodeURIComponent(issueId)}/documents/${encodeURIComponent(key)}`,
          { body },
        ),
    ),
    makeTool(
      "paperclipRestoreIssueDocumentRevision",
      "Restore a prior revision of an issue document",
      z.object({
        issueId: issueIdSchema,
        key: documentKeySchema,
        revisionId: z.string().uuid(),
      }),
      async ({ issueId, key, revisionId }) =>
        client.requestJson(
          "POST",
          `/issues/${encodeURIComponent(issueId)}/documents/${encodeURIComponent(key)}/revisions/${encodeURIComponent(revisionId)}/restore`,
          { body: {} },
        ),
    ),
    makeTool(
      "paperclipLinkIssueApproval",
      "Link an approval to an issue",
      z.object({ issueId: issueIdSchema }).merge(linkIssueApprovalSchema),
      async ({ issueId, approvalId }) =>
        client.requestJson("POST", `/issues/${encodeURIComponent(issueId)}/approvals`, {
          body: { approvalId },
        }),
    ),
    makeTool(
      "paperclipUnlinkIssueApproval",
      "Unlink an approval from an issue",
      z.object({ issueId: issueIdSchema, approvalId: approvalIdSchema }),
      async ({ issueId, approvalId }) =>
        client.requestJson(
          "DELETE",
          `/issues/${encodeURIComponent(issueId)}/approvals/${encodeURIComponent(approvalId)}`,
        ),
    ),
    makeTool(
      "paperclipApprovalDecision",
      "Approve, reject, request revision, resubmit, or withdraw an approval. `approve`, `reject`, and `requestRevision` are board-only — an agent calling them gets `403 Board access required`. `withdraw` and `resubmit` are **both requester-scoped**: the requesting agent may rescind its own ask or resubmit it, so a card that went moot is yours to clear rather than something to ask a human to close, and a card the board sent back as `revision_requested` is yours to resubmit. You can only act on cards you filed; another agent's card is refused (403).\n\n⚠️ `withdraw` accepts the whole UNDECIDED set — `pending` **and** `revision_requested` (`APPROVAL_UNDECIDED_STATUSES`) — so a card the board sent back is yours to retire in ONE hop. `resubmit` requires `revision_requested`. An already-decided card is refused `409 Only undecided approvals can be withdrawn`, which names `allowedStatuses`. A bounced card is NOT stranded and NOT board-only to clear; believing otherwise is what left a 118-card `revision_requested` backlog whose own requesters thought they could not touch it (BLO-27406).\n\n`withdraw` requires a non-empty `reason` (or `decisionNote`), because the audit trail relies on it to tell a moot request apart from an abandoned one. WHERE that reason lands depends on whether the board already wrote one: a non-blank `decisionNote` is preserved **byte-identical**, with its `decidedByUserId`/`decidedAt` attribution, and your `reason` is recorded as an approval comment instead; only a card the board never wrote on takes the reason into `decisionNote`. **So withdrawing never destroys the board's reasoning (BLO-27036) — do not avoid it to protect a note.** `resubmit` is the call that clears the decision fields, and it archives the note to an approval comment first. Read `decisionNote` AND the approval comments before either: the board's reasoning is frequently in a comment while the note field is null.\n\nNote one destructive side effect: withdrawing a `hire_agent` approval also terminates the pending agent it would have created (it would otherwise be stranded frozen with no approval left to decide it).",
      approvalDecisionSchema,
      async ({ approvalId, action, decisionNote, reason, payloadJson }) => {
        if (action === "withdraw") {
          // Refuse here rather than letting an empty reason reach the server as a
          // bare 400: the caller learns which field to fill, and a withdrawal can
          // never silently lose the note the audit trail depends on.
          const withdrawReason = (reason ?? decisionNote ?? "").trim();
          if (!withdrawReason) {
            throw new Error(
              "withdraw requires a non-empty reason: pass `reason` (or `decisionNote`) saying why the request became moot",
            );
          }
          return client.requestJson(
            "POST",
            `/approvals/${encodeURIComponent(approvalId)}/withdraw`,
            { body: { reason: withdrawReason } },
          );
        }

        const path =
          action === "approve"
            ? `/approvals/${encodeURIComponent(approvalId)}/approve`
            : action === "reject"
              ? `/approvals/${encodeURIComponent(approvalId)}/reject`
              : action === "requestRevision"
                ? `/approvals/${encodeURIComponent(approvalId)}/request-revision`
                : `/approvals/${encodeURIComponent(approvalId)}/resubmit`;

        const replacementPayload = action === "resubmit" ? parseOptionalJson(payloadJson) : undefined;
        const body =
          action === "resubmit"
            ? replacementPayload === undefined
              ? {}
              : { payload: replacementPayload }
            : { decisionNote: decisionNote ?? reason };

        return client.requestJson("POST", path, { body });
      },
    ),
    makeTool(
      "paperclipAddApprovalComment",
      "Add a comment to an approval",
      z.object({ approvalId: approvalIdSchema, body: z.string().min(1) }),
      async ({ approvalId, body }) =>
        client.requestJson("POST", `/approvals/${encodeURIComponent(approvalId)}/comments`, {
          body: { body },
        }),
    ),
    makeTool(
      "paperclipCreateMilestone",
      "Creates a new milestone on a Linear project.",
      createMilestoneToolSchema,
      async ({ companyId, ...body }) => {
        const resolved = await client.resolveCompany({ override: companyId });
        return client.requestJson("POST", `/companies/${resolved}/milestones`, {
          body,
          companyId: resolved,
        });
      },
    ),
    makeTool(
      "paperclipListMilestones",
      "Lists milestones for a Linear project. Returns id, name, description, and target date.",
      listMilestonesToolSchema,
      async ({ companyId, projectId }) => {
        const resolved = await client.resolveCompany({ override: companyId });
        const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
        return client.requestJson("GET", `/companies/${resolved}/milestones${qs}`, {
          companyId: resolved,
        });
      },
    ),
    makeTool(
      "paperclipGetMilestone",
      "Gets full detail on a single Linear milestone by ID.",
      z.object({ milestoneId: milestoneIdSchema }),
      async ({ milestoneId }) =>
        client.requestJson("GET", `/milestones/${encodeURIComponent(milestoneId)}`),
    ),
    makeTool(
      "paperclipUpdateMilestone",
      "Updates a Linear project milestone.",
      updateMilestoneToolSchema,
      async ({ milestoneId, ...body }) =>
        client.requestJson("PATCH", `/milestones/${encodeURIComponent(milestoneId)}`, { body }),
    ),
    makeTool(
      "paperclipDeleteMilestone",
      "Deletes a milestone by ID.",
      z.object({ milestoneId: milestoneIdSchema }),
      async ({ milestoneId }) =>
        client.requestJson("DELETE", `/milestones/${encodeURIComponent(milestoneId)}`),
    ),
    makeTool(
      "paperclipTailHeartbeatRunLog",
      "Fallback raw NDJSON log tail for ONE heartbeat run, for MCP clients without resource " +
        "subscription support. Prefer paperclipGetIssue/paperclipGetAgent for status first — " +
        "cheap and structured; reach for this only to debug why a specific run did what it did. " +
        "A runId is a snapshot of a single heartbeat cycle: once the agent has cycled to a newer " +
        "run, tailing this runId further shows no new activity even though the agent may still be " +
        "working — re-check the issue's current executionRunId before re-tailing. Each run's log " +
        "starts with ~15-20KB of boilerplate (SessionStart hooks, tool/skill list); pass a nonzero " +
        "offset to skip past it. Default limitBytes is 16384 (matches the resource-subscription " +
        "chunk size) — for a low-context read, pass 2000-4000 explicitly instead.",
      tailHeartbeatRunLogSchema,
      async ({ runId, offset, limitBytes }) =>
        client.requestJson(
          "GET",
          `/heartbeat-runs/${encodeURIComponent(runId)}/log?offset=${offset}&limitBytes=${limitBytes}`,
        ),
    ),
    makeTool(
      "paperclipApiRequest",
      "Escape hatch: make a raw JSON request to any Paperclip API endpoint not covered by a named tool above. Prefer the named tools when one exists — they validate inputs and shape errors consistently; this one does neither. path is relative to /api — pass '/agents/me', not '/api/agents/me'.",
      apiRequestSchema,
      async ({ method, path, jsonBody }) => {
        if (!path.startsWith("/") || path.includes("..")) {
          throw new Error("path must start with / and be relative to /api, and must not contain '..'");
        }
        // The client's base URL already ends in /api, so an /api-prefixed path would
        // request /api/api/... and come back 404 "API route not found" — byte-identical
        // to an absent route. Reject it, so a usage error can never read as a measurement.
        if (/^\/api([/?#]|$)/i.test(path)) {
          const relative = path.slice(4);
          throw new Error(
            `path is relative to /api — pass '${relative.startsWith("/") ? relative : "/agents/me"}', not '${path}'. ` +
              "This is a usage error in the caller, not a missing route on the server.",
          );
        }
        return client.requestJson(method, path, {
          body: parseOptionalJson(jsonBody),
        });
      },
    ),
  ];
}
