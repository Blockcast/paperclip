import {
  DEFAULT_GBRAIN_MCP_URL,
  LEGACY_BRIDGE_GBRAIN_MCP_URL,
} from "./manifest.js";

export function resolveGbrainUrlForAgent(opts: {
  configuredUrl: string;
  oauthLoaded: boolean;
  hasAgentClient: boolean;
}): string {
  if (
    opts.oauthLoaded &&
    !opts.hasAgentClient &&
    opts.configuredUrl === DEFAULT_GBRAIN_MCP_URL
  ) {
    return LEGACY_BRIDGE_GBRAIN_MCP_URL;
  }
  return opts.configuredUrl;
}
