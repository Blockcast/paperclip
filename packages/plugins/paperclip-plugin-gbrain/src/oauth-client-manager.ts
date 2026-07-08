// Per-agent OAuth bearer token manager for gbrain MCP calls.
//
// gbrain's admin-ui container serves the same MCP surface as the
// supergateway-bridge container, but with Bearer auth required. Switching
// the plugin onto that endpoint kills our dependency on the leaky
// supergateway bridge while also giving every write a real "who did
// this" attribution recorded by gbrain itself, replacing the metadata
// tagging we used in wave 1.
//
// Token lifecycle:
//   client_credentials grant against POST /token on admin-ui:3130.
//   gbrain returns {access_token, token_type:"bearer", expires_in:3600,
//   scope:"read write"}. We cache per-agent until ~60s before expiry,
//   then re-fetch lazily on the next call.
//
// Bootstrap shape — clients.json mounted as a file:
//   {
//     "<agentUuid>": {
//       "client_id":     "gbrain_cl_…",
//       "client_secret": "gbrain_cs_…",
//       "name":          "paperclip:Blockcast:CTO"
//     },
//     …
//   }

import { readFile } from "node:fs/promises";

const REFRESH_LEEWAY_SEC = 60;
const DEFAULT_AUTHBOT_TIMEOUT_MS = 10_000;
const AUTHBOT_CONSUMER_HEADER = "paperclip-gbrain-plugin";

export interface OAuthClientEntry {
  client_id: string;
  client_secret: string;
  name?: string;
}

interface CachedToken {
  bearer: string;
  refreshAtEpochSec: number;
}

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope?: string;
}

interface AuthbotCredentialResponse {
  credential_id?: unknown;
  service?: unknown;
  source?: unknown;
  value?: unknown;
  value_redacted?: unknown;
}

interface AuthbotCredentialEnvelope {
  credential?: unknown;
  value?: unknown;
}

export interface OAuthClientsLoadOptions {
  /** Authbot credential API URL. When set, this source is authoritative. */
  authbotUrl?: string;
  /** Managed service key file used for the Authbot credential API. */
  authbotServiceKeyFile?: string;
  /** Legacy mounted clients.json path. Used only when authbotUrl is absent. */
  filePath: string;
  /** Override fetch (tests). */
  fetch?: typeof fetch;
  /** Authbot read timeout. */
  timeoutMs?: number;
}

export interface LoadedOAuthClients {
  source: "authbot" | "file";
  sourceLabel: string;
  clients: Record<string, OAuthClientEntry>;
}

export interface OAuthClientManagerOptions {
  /** OAuth token endpoint, e.g. http://gbrain-mcp-admin.paperclip.svc:3130/token */
  tokenUrl: string;
  /** Map of agentId → {client_id, client_secret} */
  clients: Record<string, OAuthClientEntry>;
  /** Override fetch (tests). */
  fetch?: typeof fetch;
  /** Scope to request. Defaults to "read write". */
  scope?: string;
  /** Override clock (tests). Returns seconds since epoch. */
  nowSec?: () => number;
}

export class OAuthClientManager {
  private readonly tokenUrl: string;
  private readonly clients: Record<string, OAuthClientEntry>;
  private readonly fetchImpl: typeof fetch;
  private readonly scope: string;
  private readonly nowSec: () => number;
  private readonly cache = new Map<string, CachedToken>();
  // Coalesce concurrent refreshes of the same agent so we never run two
  // /token exchanges in parallel for one client_id.
  private readonly inflight = new Map<string, Promise<string>>();

  constructor(opts: OAuthClientManagerOptions) {
    this.tokenUrl = opts.tokenUrl;
    this.clients = opts.clients;
    this.fetchImpl = opts.fetch ?? fetch;
    this.scope = opts.scope ?? "read write";
    this.nowSec = opts.nowSec ?? (() => Math.floor(Date.now() / 1000));
  }

  hasAgent(agentId: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.clients, agentId);
  }

  agentCount(): number {
    return Object.keys(this.clients).length;
  }

  /**
   * Fetch (or return cached) Bearer token for the given agentId.
   * Throws if the agent is not in the clients map.
   */
  async getToken(agentId: string): Promise<string> {
    const cached = this.cache.get(agentId);
    if (cached && cached.refreshAtEpochSec > this.nowSec()) {
      return cached.bearer;
    }
    const inflight = this.inflight.get(agentId);
    if (inflight) return inflight;

    const p = this.refresh(agentId).finally(() => {
      this.inflight.delete(agentId);
    });
    this.inflight.set(agentId, p);
    return p;
  }

  /**
   * Drop any cached token for this agentId. Call after a 401 to force a
   * fresh exchange on the next request.
   */
  invalidate(agentId: string): void {
    this.cache.delete(agentId);
  }

  private async refresh(agentId: string): Promise<string> {
    const entry = this.clients[agentId];
    if (!entry) {
      throw new Error(`gbrain OAuth: no client configured for agentId ${agentId}`);
    }
    const body = new URLSearchParams();
    body.set("grant_type", "client_credentials");
    body.set("client_id", entry.client_id);
    body.set("client_secret", entry.client_secret);
    body.set("scope", this.scope);
    const resp = await this.fetchImpl(this.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      throw new Error(
        `gbrain OAuth: /token returned HTTP ${resp.status} for ${agentId}: ${detail.slice(0, 200)}`,
      );
    }
    const payload = (await resp.json()) as TokenResponse;
    if (!payload?.access_token) {
      throw new Error(`gbrain OAuth: /token response missing access_token for ${agentId}`);
    }
    const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : 3600;
    const refreshAt = this.nowSec() + Math.max(60, expiresIn - REFRESH_LEEWAY_SEC);
    this.cache.set(agentId, { bearer: payload.access_token, refreshAtEpochSec: refreshAt });
    return payload.access_token;
  }
}

function parseClientsJson(raw: string): Record<string, OAuthClientEntry> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const out: Record<string, OAuthClientEntry> = {};
  for (const [agentId, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const v = value as Record<string, unknown>;
    if (typeof v.client_id === "string" && typeof v.client_secret === "string") {
      out[agentId] = {
        client_id: v.client_id,
        client_secret: v.client_secret,
        name: typeof v.name === "string" ? v.name : undefined,
      };
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

function authbotCredentialValue(payload: AuthbotCredentialEnvelope): string | null {
  const candidate =
    payload.credential && typeof payload.credential === "object"
      ? (payload.credential as AuthbotCredentialResponse)
      : (payload as AuthbotCredentialResponse);
  return typeof candidate.value === "string" && candidate.value.length > 0
    ? candidate.value
    : null;
}

/**
 * Load the per-agent OAuth clients JSON from a file mounted via k8s
 * Secret (or any other path). Returns null when the file is absent,
 * unreadable, or malformed — caller falls back to anonymous mode.
 *
 * The expected shape is documented in the manager header.
 */
export async function loadClientsFromFile(
  path: string,
): Promise<Record<string, OAuthClientEntry> | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return null;
  }
  return parseClientsJson(raw);
}

export async function loadClientsFromAuthbot(
  opts: {
    url: string;
    serviceKeyFile?: string;
    fetch?: typeof fetch;
    timeoutMs?: number;
  },
): Promise<Record<string, OAuthClientEntry> | null> {
  if (!opts.serviceKeyFile) return null;
  let serviceKey: string;
  try {
    serviceKey = (await readFile(opts.serviceKeyFile, "utf8")).trim();
  } catch {
    return null;
  }
  if (!serviceKey) return null;

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    opts.timeoutMs ?? DEFAULT_AUTHBOT_TIMEOUT_MS,
  );
  try {
    const resp = await (opts.fetch ?? fetch)(opts.url, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${serviceKey}`,
        "x-paperclip-consumer": AUTHBOT_CONSUMER_HEADER,
      },
      signal: controller.signal,
    });
    if (!resp.ok) return null;
    const value = authbotCredentialValue((await resp.json()) as AuthbotCredentialEnvelope);
    return value ? parseClientsJson(value) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function loadClients(
  opts: OAuthClientsLoadOptions,
): Promise<LoadedOAuthClients | null> {
  if (opts.authbotUrl) {
    const clients = await loadClientsFromAuthbot({
      url: opts.authbotUrl,
      serviceKeyFile: opts.authbotServiceKeyFile,
      fetch: opts.fetch,
      timeoutMs: opts.timeoutMs,
    });
    return clients
      ? { source: "authbot", sourceLabel: opts.authbotUrl, clients }
      : null;
  }

  const clients = await loadClientsFromFile(opts.filePath);
  return clients ? { source: "file", sourceLabel: opts.filePath, clients } : null;
}
