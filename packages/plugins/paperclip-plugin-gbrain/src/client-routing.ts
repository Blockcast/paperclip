export function resolveGbrainUrlForAgent(opts: {
  configuredUrl: string;
  oauthLoaded: boolean;
  hasAgentClient: boolean;
}): string {
  return opts.configuredUrl;
}
