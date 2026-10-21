import { createHash } from "node:crypto";
import type { AdapterModel } from "@paperclipai/adapter-utils";
import { models as DIRECT_MODELS } from "../index.js";

const ANTHROPIC_MODELS_ENDPOINT = "/v1/models";
const ANTHROPIC_MODELS_TIMEOUT_MS = 5000;
const ANTHROPIC_MODELS_CACHE_TTL_MS = 60_000;
const ANTHROPIC_API_VERSION = "2023-06-01";

/** AWS Bedrock model IDs — region-qualified identifiers required by the Bedrock API. */
const BEDROCK_MODELS: AdapterModel[] = [
  { id: "us.anthropic.claude-opus-4-8-v1", label: "Bedrock Opus 4.8" },
  { id: "us.anthropic.claude-opus-5", label: "Bedrock Opus 5" },
  { id: "us.anthropic.claude-sonnet-5", label: "Bedrock Sonnet 5" },
  { id: "us.anthropic.claude-fable-5-1-v1", label: "Bedrock Fable 5.1" },
  { id: "us.anthropic.claude-fable-5-v1", label: "Bedrock Fable 5" },
  { id: "us.anthropic.claude-opus-4-6-v1", label: "Bedrock Opus 4.6" },
  { id: "us.anthropic.claude-sonnet-4-5-20250929-v2:0", label: "Bedrock Sonnet 4.5" },
  { id: "us.anthropic.claude-haiku-4-5-20251001-v1:0", label: "Bedrock Haiku 4.5" },
];

let cached: { keyFingerprint: string; baseUrl: string; expiresAt: number; models: AdapterModel[] } | null = null;

function isBedrockValues(values: {
  useBedrock?: string | undefined;
  bedrockBaseUrl?: string | undefined;
}): boolean {
  return (
    values.useBedrock === "1" ||
    values.useBedrock === "true" ||
    (typeof values.bedrockBaseUrl === "string" && values.bedrockBaseUrl.trim().length > 0)
  );
}

function isBedrockEnv(): boolean {
  return isBedrockValues({
    useBedrock: process.env.CLAUDE_CODE_USE_BEDROCK,
    bedrockBaseUrl: process.env.ANTHROPIC_BEDROCK_BASE_URL,
  });
}

/**
 * Bedrock-ness of ONE agent's configuration, not of this server process.
 *
 * `adapterConfig.env` is the agent's own environment and outranks the server's
 * where both name a key, so an agent can run against Bedrock on a server that
 * does not, and vice versa. A key PRESENT in `adapterConfig.env` wins even when
 * its value is empty — that is how an agent opts out of an inherited setting.
 * A managed-secret reference reads as a non-empty string here, which is the
 * safe direction: a config that names a Bedrock base URL at all resolves to the
 * Bedrock registry.
 */
export function isBedrockAdapterConfig(
  adapterConfig: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const configEnv =
    typeof adapterConfig.env === "object" && adapterConfig.env !== null
      ? (adapterConfig.env as Record<string, unknown>)
      : {};
  const read = (key: string): string | undefined => {
    if (Object.prototype.hasOwnProperty.call(configEnv, key)) {
      const value = configEnv[key];
      return typeof value === "string" ? value : value == null ? "" : String(value);
    }
    return env[key];
  };
  return isBedrockValues({
    useBedrock: read("CLAUDE_CODE_USE_BEDROCK"),
    bedrockBaseUrl: read("ANTHROPIC_BEDROCK_BASE_URL"),
  });
}

function fingerprint(apiKey: string): string {
  const digest = createHash("sha256").update(apiKey).digest("base64url").slice(0, 16);
  return `${apiKey.length}:${digest}`;
}

function dedupeModels(models: AdapterModel[]): AdapterModel[] {
  const seen = new Set<string>();
  const deduped: AdapterModel[] = [];
  for (const model of models) {
    const id = model.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    deduped.push({ id, label: model.label.trim() || id });
  }
  return deduped;
}

function mergedWithFallback(models: AdapterModel[]): AdapterModel[] {
  return dedupeModels([
    ...models,
    ...DIRECT_MODELS,
  ]);
}

function resolveAnthropicApiKey(): string | null {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  return apiKey && apiKey.length > 0 ? apiKey : null;
}

function resolveAnthropicBaseUrl(): string {
  const baseUrl = process.env.ANTHROPIC_BASE_URL?.trim();
  return baseUrl && baseUrl.length > 0 ? baseUrl.replace(/\/+$/, "") : "https://api.anthropic.com";
}

async function fetchAnthropicModels(apiKey: string, baseUrl: string): Promise<AdapterModel[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ANTHROPIC_MODELS_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}${ANTHROPIC_MODELS_ENDPOINT}`, {
      headers: {
        "anthropic-version": ANTHROPIC_API_VERSION,
        "x-api-key": apiKey,
      },
      signal: controller.signal,
    });
    if (!response.ok) return [];

    const payload = (await response.json()) as { data?: unknown };
    const data = Array.isArray(payload.data) ? payload.data : [];
    const models: AdapterModel[] = [];
    for (const item of data) {
      if (typeof item !== "object" || item === null) continue;
      const record = item as { id?: unknown; display_name?: unknown };
      if (typeof record.id !== "string" || record.id.trim().length === 0) continue;
      const displayName =
        typeof record.display_name === "string" && record.display_name.trim().length > 0
          ? record.display_name
          : record.id;
      models.push({
        id: record.id,
        label: displayName,
      });
    }
    return dedupeModels(models);
  } catch (error) {
    console.warn("[paperclip] Claude model discovery failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

async function loadClaudeModels(
  options?: { forceRefresh?: boolean; bedrock?: boolean },
): Promise<AdapterModel[]> {
  if (options?.bedrock ?? isBedrockEnv()) return dedupeModels(BEDROCK_MODELS);

  const fallback = dedupeModels(DIRECT_MODELS);
  const apiKey = resolveAnthropicApiKey();
  if (!apiKey) return fallback;

  const now = Date.now();
  const baseUrl = resolveAnthropicBaseUrl();
  const keyFingerprint = fingerprint(apiKey);
  if (
    options?.forceRefresh !== true &&
    cached &&
    cached.keyFingerprint === keyFingerprint &&
    cached.baseUrl === baseUrl &&
    cached.expiresAt > now
  ) {
    return cached.models;
  }

  const fetched = await fetchAnthropicModels(apiKey, baseUrl);
  if (fetched.length > 0) {
    const merged = mergedWithFallback(fetched);
    cached = {
      keyFingerprint,
      baseUrl,
      expiresAt: now + ANTHROPIC_MODELS_CACHE_TTL_MS,
      models: merged,
    };
    return merged;
  }

  if (cached && cached.keyFingerprint === keyFingerprint && cached.baseUrl === baseUrl && cached.models.length > 0) {
    return cached.models;
  }

  return fallback;
}

/**
 * Return the model list appropriate for the current auth mode.
 * When Bedrock env vars are detected, returns Bedrock-native model IDs;
 * otherwise returns standard Anthropic API model IDs.
 */
export async function listClaudeModels(): Promise<AdapterModel[]> {
  return loadClaudeModels();
}

export async function refreshClaudeModels(): Promise<AdapterModel[]> {
  return loadClaudeModels({ forceRefresh: true });
}

/**
 * Model set admissible for ONE agent's configuration (PEN-4447).
 *
 * Same list as `listClaudeModels()` except that the Bedrock branch is decided
 * from the agent's own `adapterConfig.env` rather than this process's env, so
 * write-time validation judges an agent against the registry its own lane will
 * use.
 */
export async function listClaudeModelsForConfig(
  adapterConfig: Record<string, unknown>,
): Promise<AdapterModel[]> {
  return loadClaudeModels({ bedrock: isBedrockAdapterConfig(adapterConfig) });
}

export function resetClaudeModelsCacheForTests() {
  cached = null;
}

/** Check whether a model ID is a Bedrock-native identifier (not an Anthropic API short name). */
/** Bedrock model IDs use region-qualified prefixes (e.g. us.anthropic.*, eu.anthropic.*) or ARNs. */
export function isBedrockModelId(model: string): boolean {
  return /^\w+\.anthropic\./.test(model) || model.startsWith("arn:aws:bedrock:");
}
