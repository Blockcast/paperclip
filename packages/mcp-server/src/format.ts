import { PaperclipApiError } from "./client.js";

type McpTextResponse = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

export function formatTextResponse(value: unknown): McpTextResponse {
  return {
    content: [
      {
        type: "text",
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}

// Every response from here MUST carry `isError: true` (BLO-18466). Without it
// the MCP protocol reports the call as a SUCCESS whose payload happens to
// contain an `error` key, so a caller that reads result fields sees the
// requested field simply absent — a denied `paperclipUpdateIssue` read back as
// `priority: None` and the agent reported the priority as raised. A write that
// fails has to fail loudly; a success-shaped denial is worse than an outage,
// because nothing downstream knows to retry or escalate.
export function formatErrorResponse(error: unknown): McpTextResponse {
  if (error instanceof PaperclipApiError) {
    return {
      ...formatTextResponse({
        error: error.message,
        status: error.status,
        method: error.method,
        path: error.path,
        body: error.body,
      }),
      isError: true,
    };
  }
  return {
    ...formatTextResponse({
      error: error instanceof Error ? error.message : String(error),
    }),
    isError: true,
  };
}
