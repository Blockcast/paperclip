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

export function createToolDefinitions(client: PaperclipApiClient): ToolDefinition[] {
  const getAgentSchema = z.object({
    agent_id: z
      .string()
      .default("me")
      .describe('Agent UUID, or the literal "me" for the currently authenticated agent.'),
  });

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
  ];
}
