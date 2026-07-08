/**
 * Upstream routing config: path-prefix -> upstream URL/metadata.
 *
 * Prefer `PAPERCLIP_MCP_UPSTREAMS_STATE_URL`, which is expected to return
 * metadata from penstock state for the token principal's tenant scope. The
 * state payload must contain only metadata: name, prefix, URL, and credential
 * env-var names. Credential values are injected from the gateway process env.
 * A successful state fetch is written to `PAPERCLIP_MCP_UPSTREAMS_CACHE_FILE`
 * so a control-plane outage can fall back to the last-known-good config.
 * Legacy `PAPERCLIP_MCP_UPSTREAMS_FILE` and `PAPERCLIP_MCP_UPSTREAMS` remain
 * supported for bootstrap/local development.
 */

import fs from "node:fs";
import path from "node:path";

export interface UpstreamCredentialHeader {
  header: string;
  env: string;
  scheme?: string;
}

export interface UpstreamConfig {
  name?: string;
  url: string;
  credentialHeaders: UpstreamCredentialHeader[];
}

export type UpstreamMap = Record<string, UpstreamConfig>;

const DEFAULT_UPSTREAMS_CACHE_FILE = "/cache/upstreams-lkg.json";
const CREDENTIAL_ENV_ALLOWLIST = "PAPERCLIP_MCP_UPSTREAM_CREDENTIAL_ENVS";

export async function loadUpstreams(env: NodeJS.ProcessEnv = process.env): Promise<UpstreamMap> {
  const stateUrl = env.PAPERCLIP_MCP_UPSTREAMS_STATE_URL?.trim();
  if (stateUrl && stateUrl.length > 0) {
    return loadStateUpstreams(stateUrl, env);
  }
  return loadLocalUpstreams(env);
}

export function loadLocalUpstreams(env: NodeJS.ProcessEnv = process.env): UpstreamMap {
  const filePath = env.PAPERCLIP_MCP_UPSTREAMS_FILE?.trim();
  if (filePath && filePath.length > 0) {
    const raw = fs.readFileSync(filePath, "utf8");
    return parseUpstreamMap(raw, `file ${filePath}`);
  }
  const inline = env.PAPERCLIP_MCP_UPSTREAMS?.trim();
  if (inline && inline.length > 0) {
    return parseUpstreamMap(inline, "PAPERCLIP_MCP_UPSTREAMS");
  }
  throw new Error(
    "No upstreams configured. Set PAPERCLIP_MCP_UPSTREAMS_STATE_URL (penstock state), PAPERCLIP_MCP_UPSTREAMS_FILE (path to JSON), or PAPERCLIP_MCP_UPSTREAMS (inline JSON).",
  );
}

async function loadStateUpstreams(stateUrl: string, env: NodeJS.ProcessEnv): Promise<UpstreamMap> {
  const cacheFile = env.PAPERCLIP_MCP_UPSTREAMS_CACHE_FILE?.trim() || DEFAULT_UPSTREAMS_CACHE_FILE;
  let raw: string;
  try {
    const headers: Record<string, string> = { accept: "application/json" };
    const token = env.PAPERCLIP_MCP_UPSTREAMS_STATE_TOKEN?.trim();
    if (token) headers.authorization = `Bearer ${token}`;
    const response = await fetch(stateUrl, { headers });
    if (!response.ok) {
      throw new Error(`status=${response.status}`);
    }
    raw = await response.text();
  } catch (e) {
    const cachedRaw = readLastKnownGood(cacheFile);
    if (cachedRaw) {
      // eslint-disable-next-line no-console
      console.warn(`[mcp-gateway] state config unavailable; using last-known-good cache: ${(e as Error).message}`);
      const cachedUpstreams = parseUpstreamMap(cachedRaw, `last-known-good ${cacheFile}`);
      validateCredentialEnvNames(cachedUpstreams, env);
      return cachedUpstreams;
    }
    throw new Error(`upstreams: failed to load penstock state and no last-known-good cache is available: ${(e as Error).message}`);
  }
  const upstreams = parseUpstreamMap(raw, "PAPERCLIP_MCP_UPSTREAMS_STATE_URL");
  validateCredentialEnvNames(upstreams, env);
  writeLastKnownGood(cacheFile, raw);
  return upstreams;
}

function writeLastKnownGood(cacheFile: string, raw: string): void {
  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, raw, { encoding: "utf8", mode: 0o600 });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[mcp-gateway] failed to write upstream last-known-good cache: ${(e as Error).message}`);
  }
}

function readLastKnownGood(cacheFile: string): string | null {
  try {
    return fs.readFileSync(cacheFile, "utf8");
  } catch {
    return null;
  }
}

export function parseUpstreamMap(raw: string, source: string): UpstreamMap {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`upstreams: failed to parse ${source} as JSON: ${(e as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`upstreams: ${source} must be a JSON object`);
  }
  const result: UpstreamMap = {};
  for (const [prefix, value] of upstreamEntries(parsed)) {
    if (!/^[a-zA-Z0-9_-]+$/.test(prefix)) {
      throw new Error(`upstreams: prefix "${prefix}" must match /^[a-zA-Z0-9_-]+$/`);
    }
    const config = parseUpstreamConfig(prefix, value);
    if (!/^https?:\/\//.test(config.url)) {
      throw new Error(`upstreams: prefix "${prefix}" URL must start with http:// or https://`);
    }
    result[prefix] = config;
  }
  if (Object.keys(result).length === 0) {
    throw new Error(`upstreams: ${source} contained no prefix->URL mappings`);
  }
  return result;
}

function upstreamEntries(parsed: object): Array<[string, unknown]> {
  const root = parsed as { upstreams?: unknown };
  if (Array.isArray(root.upstreams)) {
    return root.upstreams.map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new Error("upstreams: each upstream entry must be an object");
      }
      const record = item as { prefix?: unknown; name?: unknown };
      const prefix = typeof record.prefix === "string" ? record.prefix : record.name;
      if (typeof prefix !== "string" || prefix.length === 0) {
        throw new Error("upstreams: each upstream entry must include a non-empty prefix or name");
      }
      return [prefix, item];
    });
  }
  if (root.upstreams && typeof root.upstreams === "object" && !Array.isArray(root.upstreams)) {
    return Object.entries(root.upstreams as Record<string, unknown>);
  }
  return Object.entries(parsed as Record<string, unknown>);
}

function parseUpstreamConfig(prefix: string, value: unknown): UpstreamConfig {
  if (typeof value === "string") {
    if (value.length === 0) {
      throw new Error(`upstreams: prefix "${prefix}" must map to a non-empty URL string`);
    }
    return { url: value, credentialHeaders: [] };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`upstreams: prefix "${prefix}" must map to a URL string or metadata object`);
  }
  rejectCredentialValues(prefix, value);
  const record = value as Record<string, unknown>;
  if (typeof record.url !== "string" || record.url.length === 0) {
    throw new Error(`upstreams: prefix "${prefix}" metadata must include a non-empty url string`);
  }
  return {
    name: typeof record.name === "string" && record.name.length > 0 ? record.name : undefined,
    url: record.url,
    credentialHeaders: parseCredentialHeaders(record),
  };
}

function rejectCredentialValues(prefix: string, value: unknown): void {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (/^(value|secret|token|password|apiKey|credentialValue)$/i.test(key)) {
      throw new Error(`upstreams: prefix "${prefix}" contains credential value field "${key}"; state may only contain env-var names`);
    }
    rejectCredentialValues(prefix, child);
  }
}

function parseCredentialHeaders(record: Record<string, unknown>): UpstreamCredentialHeader[] {
  const headers: UpstreamCredentialHeader[] = [];
  const authorizationEnv = firstString(record.authorizationEnv, record.credentialEnv);
  if (authorizationEnv) headers.push({ header: "authorization", env: authorizationEnv, scheme: "Bearer" });

  const credentialHeaders = record.credentialHeaders;
  if (Array.isArray(credentialHeaders)) {
    for (const item of credentialHeaders) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new Error("upstreams: credentialHeaders entries must be objects");
      }
      const entry = item as Record<string, unknown>;
      const header = firstString(entry.header, entry.name);
      const env = firstString(entry.env, entry.envName, entry.keyName);
      if (!header || !env) {
        throw new Error("upstreams: credentialHeaders entries must include header and env/envName/keyName");
      }
      headers.push({ header: header.toLowerCase(), env, scheme: firstString(entry.scheme) });
    }
  }

  const credentialHeaderMap = record.credentialHeaderEnvNames ?? record.credentialKeyNames;
  if (credentialHeaderMap && typeof credentialHeaderMap === "object" && !Array.isArray(credentialHeaderMap)) {
    for (const [header, envName] of Object.entries(credentialHeaderMap as Record<string, unknown>)) {
      if (typeof envName !== "string" || envName.length === 0) {
        throw new Error(`upstreams: credential key for header "${header}" must be a non-empty env-var name`);
      }
      headers.push({ header: header.toLowerCase(), env: envName, scheme: header.toLowerCase() === "authorization" ? "Bearer" : undefined });
    }
  }
  return headers;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

export function buildCredentialHeaders(config: UpstreamConfig, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  validateCredentialEnvNames({ upstream: config }, env);
  const headers: Record<string, string> = {};
  for (const credential of config.credentialHeaders) {
    const value = env[credential.env];
    if (!value) continue;
    headers[credential.header.toLowerCase()] = credential.scheme ? `${credential.scheme} ${value}` : value;
  }
  return headers;
}

function validateCredentialEnvNames(upstreams: UpstreamMap, env: NodeJS.ProcessEnv): void {
  const allowed = parseCredentialEnvAllowlist(env);
  for (const [prefix, config] of Object.entries(upstreams)) {
    for (const credential of config.credentialHeaders) {
      if (!allowed.has(credential.env)) {
        throw new Error(
          `upstreams: prefix "${prefix}" credential env "${credential.env}" is not listed in ${CREDENTIAL_ENV_ALLOWLIST}`,
        );
      }
    }
  }
}

function parseCredentialEnvAllowlist(env: NodeJS.ProcessEnv): Set<string> {
  const raw = env[CREDENTIAL_ENV_ALLOWLIST]?.trim();
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((name) => name.trim())
      .filter((name) => name.length > 0),
  );
}

/**
 * Match an incoming path against the upstream table.
 * Input: "/figma/mcp", table: { figma: { url: "http://...:8000/mcp" } }
 * Returns: the upstream URL, plus the remainder of the path beyond the
 * prefix (so a request to "/figma/mcp/extra" forwards to
 * "<upstream>/extra").
 */
export function matchUpstream(
  pathName: string,
  upstreams: UpstreamMap,
): { upstreamUrl: string; remainder: string; config: UpstreamConfig } | null {
  const trimmed = pathName.startsWith("/") ? pathName.slice(1) : pathName;
  const slashIdx = trimmed.indexOf("/");
  const prefix = slashIdx === -1 ? trimmed : trimmed.slice(0, slashIdx);
  const remainder = slashIdx === -1 ? "" : trimmed.slice(slashIdx);
  const config = upstreams[prefix];
  if (!config) return null;
  const finalUrl = remainder === "/mcp" || remainder === "" ? config.url : `${config.url}${remainder.replace(/^\/mcp/, "")}`;
  return { upstreamUrl: finalUrl, remainder, config };
}
