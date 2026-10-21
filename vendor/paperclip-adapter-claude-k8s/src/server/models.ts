import type { AdapterModel } from "@paperclipai/adapter-utils";

const DIRECT_MODELS: AdapterModel[] = [
  { id: "claude-fable-5-1[1m]", label: "Claude Fable 5.1 (1M)" },
  { id: "claude-fable-5-1", label: "Claude Fable 5.1" },
  { id: "claude-opus-5-5[1m]", label: "Claude Opus 5.5 (1M)" },
  { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
  { id: "claude-sonnet-5-5[1m]", label: "Claude Sonnet 5.5 (1M)" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
  { id: "claude-opus-5[1m]", label: "Claude Opus 5 (1M)" },
  { id: "claude-opus-5", label: "Claude Opus 5" },
  { id: "claude-opus-4-8[1m]", label: "Claude Opus 4.8 (1M)" },
  { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
  { id: "claude-sonnet-4-6[1m]", label: "Claude Sonnet 4.6 (1M)" },
  { id: "claude-opus-4-7", label: "Claude Opus 4.7" },
  { id: "claude-opus-4-6", label: "Claude Opus 4.6" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  { id: "claude-haiku-4-6", label: "Claude Haiku 4.6" },
  { id: "claude-sonnet-4-5-20250929", label: "Claude Sonnet 4.5" },
  { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
];

const BEDROCK_MODELS: AdapterModel[] = [
  { id: "us.anthropic.claude-fable-5-1-v1", label: "Bedrock Fable 5.1" },
  { id: "us.anthropic.claude-opus-4-7", label: "Bedrock Opus 4.7" },
  { id: "us.anthropic.claude-opus-5", label: "Bedrock Opus 5" },
  { id: "us.anthropic.claude-sonnet-5", label: "Bedrock Sonnet 5" },
  { id: "us.anthropic.claude-opus-4-6-v1", label: "Bedrock Opus 4.6" },
  { id: "us.anthropic.claude-sonnet-4-6", label: "Bedrock Sonnet 4.6" },
  { id: "us.anthropic.claude-sonnet-4-5-20250929-v1:0", label: "Bedrock Sonnet 4.5" },
  { id: "us.anthropic.claude-haiku-4-5-20251001-v1:0", label: "Bedrock Haiku 4.5" },
];

/**
 * Aliases the Claude CLI resolves itself (`claude --model opus`). They are
 * deliberately absent from the lists above, which feed the model picker and
 * should show canonical ids — but they ARE valid configuration, so admission
 * has to include them or a working lane gets a 422 on its next write.
 * The `[1m]` suffix is accepted on an alias the same way it is on a full id.
 */
const CLI_ALIASES = ["opus", "sonnet", "haiku", "opusplan"] as const;

const CLI_ALIAS_MODELS: AdapterModel[] = CLI_ALIASES.flatMap((alias) => [
  { id: alias, label: `${alias} (CLI alias)` },
  { id: `${alias}[1m]`, label: `${alias} (CLI alias, 1M)` },
]);

function isBedrockValues(useBedrock: string | undefined, bedrockBaseUrl: string | undefined): boolean {
  return (
    useBedrock === "1" ||
    useBedrock === "true" ||
    (typeof bedrockBaseUrl === "string" && bedrockBaseUrl.trim().length > 0)
  );
}

function isBedrockEnv(): boolean {
  return isBedrockValues(
    process.env.CLAUDE_CODE_USE_BEDROCK,
    process.env.ANTHROPIC_BEDROCK_BASE_URL,
  );
}

/**
 * Bedrock-ness of ONE agent's configuration, not of the server process.
 *
 * This adapter runs each agent in its own Job pod, whose env is the server's
 * inherited env with `adapterConfig.env` layered OVER it (job-manifest.ts layer
 * 4 "wins over everything"; both `CLAUDE_CODE_*` and `ANTHROPIC_*` are in the
 * inherit allowlist). So an agent can be a Bedrock lane on a non-Bedrock server
 * and the reverse, and `process.env` alone is the wrong oracle for "which model
 * ids may this agent be written with".
 *
 * A key PRESENT in `adapterConfig.env` wins even when its value is empty — that
 * is how an agent opts out of an inherited setting, and the pod merge behaves
 * the same way. A managed-secret reference reads as a non-empty string, which
 * is the safe direction: a config that names a Bedrock base URL at all resolves
 * to the Bedrock registry.
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
  return isBedrockValues(read("CLAUDE_CODE_USE_BEDROCK"), read("ANTHROPIC_BEDROCK_BASE_URL"));
}

export async function listK8sModels(): Promise<AdapterModel[]> {
  return isBedrockEnv() ? BEDROCK_MODELS : DIRECT_MODELS;
}

/**
 * Model set admissible for ONE agent's configuration (PEN-4447).
 *
 * Paperclip calls this when validating a write to `adapterConfig.model`, so
 * that an agent is judged against the registry its own pod will use rather than
 * against whichever branch this server process happens to be on.
 */
export async function listK8sModelsForConfig(
  adapterConfig: Record<string, unknown>,
): Promise<AdapterModel[]> {
  const base = isBedrockAdapterConfig(adapterConfig) ? BEDROCK_MODELS : DIRECT_MODELS;
  return [...base, ...CLI_ALIAS_MODELS];
}

/**
 * Accept an id no list can enumerate.
 *
 * Bedrock inference profiles are region-prefixed (`us.` / `eu.` / `apac.`) and
 * may be a full ARN, so `BEDROCK_MODELS` is a convenience list and never the
 * admissible set. Gated on the config actually resolving to Bedrock: a
 * Bedrock-shaped id on a direct lane is still a real mistake.
 */
export function acceptsK8sModelForConfig(
  model: string,
  adapterConfig: Record<string, unknown>,
): boolean {
  if (!isBedrockAdapterConfig(adapterConfig)) return false;
  return isBedrockModelId(model.trim());
}

/** Region-qualified inference profile, bare Bedrock id, or an inference-profile ARN. */
export function isBedrockModelId(model: string): boolean {
  return /^(\w+\.)?anthropic\./.test(model) || model.startsWith("arn:aws:bedrock:");
}
