import { describe, expect, it } from "vitest";
import { resolveGbrainUrlForAgent } from "../client-routing.js";
import {
  DEFAULT_GBRAIN_MCP_URL,
} from "../manifest.js";

describe("resolveGbrainUrlForAgent", () => {
  it("keeps agents with OAuth clients on the configured URL", () => {
    expect(
      resolveGbrainUrlForAgent({
        configuredUrl: DEFAULT_GBRAIN_MCP_URL,
        oauthLoaded: true,
        hasAgentClient: true,
      }),
    ).toBe(DEFAULT_GBRAIN_MCP_URL);
  });

  it("keeps missing OAuth clients on the configured URL", () => {
    expect(
      resolveGbrainUrlForAgent({
        configuredUrl: DEFAULT_GBRAIN_MCP_URL,
        oauthLoaded: true,
        hasAgentClient: false,
      }),
    ).toBe(DEFAULT_GBRAIN_MCP_URL);
  });

  it("preserves explicit custom URLs", () => {
    const customUrl = "http://custom-gbrain.example/mcp";
    expect(
      resolveGbrainUrlForAgent({
        configuredUrl: customUrl,
        oauthLoaded: true,
        hasAgentClient: false,
      }),
    ).toBe(customUrl);
  });
});
