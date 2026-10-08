import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PaperclipApiClient } from "./client.js";
import { readConfigFromEnv, type PaperclipMcpConfig } from "./config.js";
import { createToolDefinitions } from "./tools.js";
import { loadPluginToolDefinitions } from "./plugin-tools.js";
import { registerHeartbeatRunResources } from "./heartbeat-resources.js";

export function createPaperclipMcpServer(config: PaperclipMcpConfig = readConfigFromEnv()) {
  const server = new McpServer({
    name: "paperclip",
    version: "0.1.0",
  });

  const client = new PaperclipApiClient(config);
  registerHeartbeatRunResources(server, client);
  const tools = createToolDefinitions(client);
  for (const tool of tools) {
    // BLO-41373: hand the SDK the ZodObject, NOT `tool.schema.shape`. Given a raw
    // shape the SDK rebuilds its own non-strict `z.object()`, which strips any
    // undeclared argument before `execute` runs — so the `.strict()` in `makeTool`
    // never sees it and the caller gets a clean success over an unfiltered result.
    // `server.tool()` cannot be used here: it rejects a ZodObject as a third
    // positional arg ("expected a Zod schema or ToolAnnotations"). `registerTool`
    // passes `inputSchema` through `getZodSchemaObject`, which keeps our object
    // whole, so strictness survives to `tools/call` validation and also surfaces
    // as `additionalProperties: false` in the served `tools/list` schema.
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.schema },
      tool.execute,
    );
  }

  return {
    server,
    tools,
    client,
  };
}

export async function runServer(config: PaperclipMcpConfig = readConfigFromEnv()) {
  const { server, client } = createPaperclipMcpServer(config);

  // Plugin tools are discovered at startup. They're folded in alongside the
  // built-in `paperclip*` tools so a single MCP server gives the agent
  // access to both paperclip's first-class entities and the live plugin
  // tool registry (Linear, Slack, Alertmanager, future GitHub/Figma).
  // If the registry is unreachable we still serve built-ins (load function
  // logs to stderr and returns []).
  const pluginTools = await loadPluginToolDefinitions(client);
  for (const tool of pluginTools) {
    // Deliberately still raw-shape / non-strict: BLO-41373 scoped itself to the
    // built-in `paperclip*` tools. These schemas are derived from a remote plugin
    // manifest we do not control, and the strictness blast radius was measured for
    // `paperclip*` calls only — an under-declaring manifest would start erroring
    // with no measurement behind it. The silent-strip caveat still applies here.
    server.tool(tool.name, tool.description, tool.schema.shape, tool.execute);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
