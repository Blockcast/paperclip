import type http from "node:http";

export interface CredentialCustodyConfig {
  readonly prefix: string;
  readonly app: string;
  readonly leaseUrl: string;
  readonly credentialBaseUrl: string;
  readonly leaseMode: "exclusive" | "shared";
  readonly leaseTtlMs: number;
  readonly upstreamAuthorizationScheme: string;
}

export interface CredentialCustodyState {
  readonly configs: Record<string, CredentialCustodyConfig>;
}

export interface CredentialCustodyLease {
  readonly credentialRef: string;
}

export interface CredentialCustodyToken {
  readonly authorizationHeader: string;
}

export class CredentialCustodyError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly retryAfter?: string,
  ) {
    super(message);
    this.name = "CredentialCustodyError";
  }
}

export function loadCredentialCustodyState(
  env: NodeJS.ProcessEnv = process.env,
): CredentialCustodyState {
  const leaseUrl = env.PAPERCLIP_MCP_FIGMA_LEASE_URL?.trim();
  const credentialBaseUrl = env.PAPERCLIP_MCP_FIGMA_CREDENTIAL_BASE_URL?.trim();
  if (!leaseUrl && !credentialBaseUrl) {
    return { configs: {} };
  }
  if (!leaseUrl || !credentialBaseUrl) {
    throw new Error(
      "Figma MCP custody requires both PAPERCLIP_MCP_FIGMA_LEASE_URL and PAPERCLIP_MCP_FIGMA_CREDENTIAL_BASE_URL.",
    );
  }
  return {
    configs: {
      figma: {
        prefix: "figma",
        app: env.PAPERCLIP_MCP_FIGMA_APP?.trim() || "figma",
        leaseUrl,
        credentialBaseUrl: credentialBaseUrl.replace(/\/+$/, ""),
        leaseMode: env.PAPERCLIP_MCP_FIGMA_LEASE_MODE === "shared" ? "shared" : "exclusive",
        leaseTtlMs: parsePositiveInteger(env.PAPERCLIP_MCP_FIGMA_LEASE_TTL_MS, 60 * 60 * 1000),
        upstreamAuthorizationScheme: env.PAPERCLIP_MCP_FIGMA_UPSTREAM_AUTH_SCHEME?.trim() || "Bearer",
      },
    },
  };
}

export function configForPrefix(
  state: CredentialCustodyState | undefined,
  prefix: string,
): CredentialCustodyConfig | undefined {
  return state?.configs[prefix];
}

export async function resolveCustodiedToken(
  config: CredentialCustodyConfig,
  inboundHeaders: http.IncomingHttpHeaders,
  mcpSessionId: string,
): Promise<CredentialCustodyToken> {
  const callerAuthorization = inboundAuthorization(inboundHeaders);
  if (!callerAuthorization) {
    throw new CredentialCustodyError("Missing caller authorization for MCP credential custody", 401);
  }
  const lease = await acquireLease(config, callerAuthorization, inboundHeaders, mcpSessionId);
  const value = await readCredential(config, callerAuthorization, inboundHeaders, lease.credentialRef);
  return { authorizationHeader: `${config.upstreamAuthorizationScheme} ${value}` };
}

export function applyCustodiedAuthorization(
  headers: Record<string, string>,
  token: CredentialCustodyToken | undefined,
): void {
  if (!token) return;
  delete headers.authorization;
  headers.authorization = token.authorizationHeader;
}

async function acquireLease(
  config: CredentialCustodyConfig,
  callerAuthorization: string,
  inboundHeaders: http.IncomingHttpHeaders,
  mcpSessionId: string,
): Promise<CredentialCustodyLease> {
  const response = await fetch(config.leaseUrl, {
    method: "POST",
    headers: jsonControlPlaneHeaders(callerAuthorization, inboundHeaders),
    body: JSON.stringify({
      app: config.app,
      mcp_session_id: mcpSessionId,
      holder: mcpSessionId,
      mode: config.leaseMode,
      ttl_ms: config.leaseTtlMs,
    }),
  });
  if (!response.ok) {
    throw custodyHttpError("MCP app lease acquisition failed", response);
  }
  const body = await response.json() as unknown;
  const credentialRef = pickString(body, ["credential_ref", "credentialRef"], ["lease"]);
  if (!credentialRef) {
    throw new CredentialCustodyError("MCP app lease response did not include credential_ref", 502);
  }
  return { credentialRef };
}

async function readCredential(
  config: CredentialCustodyConfig,
  callerAuthorization: string,
  inboundHeaders: http.IncomingHttpHeaders,
  credentialRef: string,
): Promise<string> {
  const response = await fetch(
    `${config.credentialBaseUrl}/${encodeURIComponent(credentialRef)}`,
    { headers: jsonControlPlaneHeaders(callerAuthorization, inboundHeaders) },
  );
  if (!response.ok) {
    throw custodyHttpError("MCP credential resolution failed", response);
  }
  const body = await response.json() as unknown;
  const value = pickString(body, ["value"], ["credential"]);
  if (!value) {
    throw new CredentialCustodyError("MCP credential response did not include a secret value", 502);
  }
  return value;
}

function custodyHttpError(message: string, response: Response): CredentialCustodyError {
  return new CredentialCustodyError(message, response.status, response.headers.get("retry-after") ?? undefined);
}

function jsonControlPlaneHeaders(
  authorization: string,
  inboundHeaders: http.IncomingHttpHeaders,
): Record<string, string> {
  const headers: Record<string, string> = {
    authorization,
    accept: "application/json",
    "content-type": "application/json",
  };
  const requestId = firstHeader(inboundHeaders["x-request-id"]);
  if (requestId) {
    headers["x-request-id"] = requestId;
  }
  return headers;
}

function inboundAuthorization(headers: http.IncomingHttpHeaders): string | undefined {
  return firstHeader(headers.authorization);
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function pickString(
  value: unknown,
  keys: readonly string[],
  nestedKeys: readonly string[] = [],
): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  for (const key of keys) {
    const candidate = (value as Record<string, unknown>)[key];
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  for (const nestedKey of nestedKeys) {
    const nested = (value as Record<string, unknown>)[nestedKey];
    const candidate = pickString(nested, keys);
    if (candidate) return candidate;
  }
  return undefined;
}
