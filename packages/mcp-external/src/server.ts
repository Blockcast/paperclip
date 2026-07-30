import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PaperclipApiClient } from "./client.js";
import { readConfigFromEnv, type PaperclipExternalConfig } from "./config.js";
import { createToolDefinitions } from "./tools.js";
import { registerHeartbeatRunResources } from "./heartbeat-resources.js";

export function createMcpServer(
  config: PaperclipExternalConfig = readConfigFromEnv(),
  options: { stateless?: boolean } = {},
) {
  const server = new McpServer({ name: "paperclip", version: "0.1.0" });
  const client = new PaperclipApiClient(config);
  // Resource push-subscriptions require a standing per-session SSE stream to
  // deliver `notifications/resources/updated`. A stateless server has no
  // session (and no standing stream), so advertise + wire subscriptions only
  // when stateful. resources/read and resources/list work either way.
  registerHeartbeatRunResources(server, client, { enableSubscriptions: !options.stateless });
  const tools = createToolDefinitions(client);
  for (const tool of tools) {
    // ToolDefinition uses loose arg types to stay transport-agnostic; the SDK's
    // typed ToolCallback is assignment-incompatible but functionally correct.
    server.tool(tool.name, tool.description, tool.schema.shape, tool.execute as never);
  }
  return { server, client, tools };
}
