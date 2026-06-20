import { z, type ZodRawShape } from "zod";
import { PaperclipApiError, type PaperclipApiClient } from "./client.js";

export interface ToolDefinition {
  name: string;
  description: string;
  schema: z.ZodObject<ZodRawShape>;
  execute: (
    args: Record<string, unknown>,
    extra: unknown,
  ) => Promise<{ content: Array<{ type: "text"; text: string }> }>;
}

function textResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

const CONFLICT_MESSAGE =
  "Conflict (409): resource is already checked out or owned by another agent. Do not retry this request.";

/** Python `_err` parity: a non-throwing error payload the MCP client reads as data. */
function errorResult(message: string, status?: number) {
  const payload: Record<string, unknown> = { isError: true, message };
  if (status !== undefined) payload.status = status;
  return textResult(payload);
}

/**
 * Run a tool's API work and convert the canonical Python server's result/error
 * shapes: empty/204 -> { ok: true }; 409 -> do-not-retry payload; other API
 * errors -> { isError, status, message }. Non-API errors (e.g. company
 * resolution) propagate unchanged.
 */
async function runTool(
  fn: () => Promise<unknown>,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  try {
    const data = await fn();
    return textResult(data ?? { ok: true });
  } catch (error) {
    if (error instanceof PaperclipApiError) {
      if (error.status === 409) return errorResult(CONFLICT_MESSAGE, 409);
      const bodyText = typeof error.body === "string" ? error.body : JSON.stringify(error.body ?? "");
      return errorResult(`HTTP ${error.status} from Paperclip API: ${bodyText.slice(0, 400)}`, error.status);
    }
    throw error;
  }
}

function clampLimit(limit: unknown, max: number): number {
  const n = typeof limit === "number" && Number.isFinite(limit) ? Math.trunc(limit) : 50;
  return Math.max(1, Math.min(n, max));
}

export function createToolDefinitions(client: PaperclipApiClient): ToolDefinition[] {
  const getAgentSchema = z.object({
    agent_id: z
      .string()
      .default("me")
      .describe('Agent UUID, or the literal "me" for the currently authenticated agent.'),
  });

  async function runListIssues(args: Record<string, unknown>) {
    const company = await client.resolveCompany({ override: args.company_id as string | undefined });
    const query: Record<string, string | number | undefined> = {
      status: String((args.status as string | undefined) ?? "todo,in_progress"),
      limit: clampLimit(args.limit, 200),
    };
    if (args.assignee_agent_id) query.assigneeAgentId = String(args.assignee_agent_id);
    if (args.project_id) query.projectId = String(args.project_id);
    if (args.label) query.label = String(args.label);
    if (args.q) query.q = String(args.q);
    return client.requestJson("GET", `/companies/${encodeURIComponent(company)}/issues`, { query, companyId: company });
  }

  return [
    {
      name: "get_agent",
      description: "Get details for a specific agent, or the currently authenticated agent.",
      schema: getAgentSchema,
      execute: async (args) =>
        runTool(async () => {
          const agentId = String((args.agent_id as string | undefined) ?? "me").trim() || "me";
          const path = agentId.toLowerCase() === "me" ? "/agents/me" : `/agents/${encodeURIComponent(agentId)}`;
          return client.requestJson("GET", path);
        }),
    },
    {
      name: "list_issues",
      description: "List issues (tasks) in a company.",
      schema: z.object({
        status: z.string().default("todo,in_progress").describe(
          "Comma-separated statuses: todo, in_progress, blocked, done, cancelled. Default: todo,in_progress",
        ),
        assignee_agent_id: z.string().default("").describe("Filter by assignee agent UUID. Empty for all."),
        project_id: z.string().default("").describe("Filter by project UUID. Empty for all."),
        label: z.string().default("").describe("Filter by label name. Empty to skip."),
        q: z.string().default("").describe("Full-text query. Empty to skip."),
        limit: z.number().int().default(50).describe("Max results (1-200). Default: 50."),
        company_id: z.string().default("").describe("Target company by context (UUID or prefix). Empty for default."),
      }),
      execute: async (args) => runTool(() => runListIssues(args)),
    },
    {
      name: "paperclip_search_issues",
      description:
        "Search Paperclip issues by text. Compatibility alias for list_issues(q=...).",
      schema: z.object({
        query: z.string().describe("Full-text issue search query."),
        status: z.string().default("todo,in_progress").describe(
          "Comma-separated statuses: todo, in_progress, blocked, done, cancelled. Default: todo,in_progress",
        ),
        assignee_agent_id: z.string().default("").describe("Filter by assignee agent UUID. Empty for all."),
        project_id: z.string().default("").describe("Filter by project UUID. Empty for all."),
        label: z.string().default("").describe("Filter by label name. Empty to skip."),
        limit: z.number().int().default(50).describe("Max results (1-200). Default: 50."),
        company_id: z.string().default("").describe("Target company by context (UUID or prefix). Empty for default."),
      }),
      execute: async (args) =>
        runTool(() => runListIssues({ ...args, q: args.query })),
    },
    {
      name: "get_issue",
      description:
        "Get the full details of a single Paperclip issue by UUID or key (e.g. PEN-307). Resolves cross-company server-side.",
      schema: z.object({
        issue_id: z.string().describe('Issue UUID or human-readable key (e.g. "CY-42"). Pass through verbatim.'),
      }),
      execute: async (args) =>
        runTool(() => client.requestJson("GET", `/issues/${encodeURIComponent(String(args.issue_id))}`)),
    },
  ];
}
