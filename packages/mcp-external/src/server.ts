import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PaperclipApiClient } from "./client.js";
import { readConfigFromEnv, type PaperclipExternalConfig } from "./config.js";
import { createToolDefinitions } from "./tools.js";

export function createMcpServer(config: PaperclipExternalConfig = readConfigFromEnv()) {
  const server = new McpServer({ name: "paperclip", version: "0.1.0" });
  const client = new PaperclipApiClient(config);
  const tools = createToolDefinitions(client);
  for (const tool of tools) {
    server.tool(tool.name, tool.description, tool.schema.shape, tool.execute as never);
  }
  return { server, client, tools };
}
