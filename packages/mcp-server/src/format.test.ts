import { describe, expect, it } from "vitest";
import { PaperclipApiError } from "./client.js";
import { formatErrorResponse, formatTextResponse } from "./format.js";

function parsePayload(response: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(response.content[0].text) as Record<string, unknown>;
}

describe("formatTextResponse", () => {
  it("does not mark successful results as errors", () => {
    const response = formatTextResponse({ priority: "critical" });
    expect(response.isError).toBeUndefined();
    expect(parsePayload(response)).toEqual({ priority: "critical" });
  });

  it("passes strings through without JSON encoding them", () => {
    expect(formatTextResponse("done").content[0].text).toBe("done");
  });
});

describe("formatErrorResponse", () => {
  // BLO-18466: the regression that motivated `isError`. Without the flag MCP
  // reports the call as a success, and a caller reading `.priority` off the
  // result sees it absent rather than seeing a failure.
  it("marks an API error as an MCP error and keeps the diagnostic fields", () => {
    const response = formatErrorResponse(
      new PaperclipApiError({
        status: 403,
        method: "PATCH",
        path: "/issues/75901b6e-8c97-40e1-8576-514de1f3f972",
        body: { error: "deny_missing_grant", boundary: "grant" },
        message: "PATCH /issues/75901b6e-8c97-40e1-8576-514de1f3f972 failed with 403: deny_missing_grant",
      }),
    );

    expect(response.isError).toBe(true);
    expect(parsePayload(response)).toMatchObject({
      status: 403,
      method: "PATCH",
      path: "/issues/75901b6e-8c97-40e1-8576-514de1f3f972",
      body: { error: "deny_missing_grant", boundary: "grant" },
    });
  });

  it("marks a plain Error as an MCP error", () => {
    const response = formatErrorResponse(new Error("boom"));
    expect(response.isError).toBe(true);
    expect(parsePayload(response)).toEqual({ error: "boom" });
  });

  it("marks a non-Error throw as an MCP error", () => {
    const response = formatErrorResponse("kaboom");
    expect(response.isError).toBe(true);
    expect(parsePayload(response)).toEqual({ error: "kaboom" });
  });
});
