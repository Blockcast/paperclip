import { envBindingSchema, type SecretProjectionClass, type SecretVersionSelector } from "@paperclipai/shared";

interface AgentSecretBindingSyncService {
  syncSecretRefsForTarget?: (
    companyId: string,
    target: { targetType: "agent"; targetId: string },
    refs: Array<{
      secretId: string;
      configPath: string;
      versionSelector?: SecretVersionSelector;
      required?: boolean;
      label?: string | null;
      projectionClass?: SecretProjectionClass;
      projectionAllowlistKey?: string | null;
    }>,
    options?: { replaceAll?: boolean },
  ) => Promise<unknown>;
  syncEnvBindingsForTarget?: (
    companyId: string,
    target: { targetType: "agent"; targetId: string; pathPrefix?: string },
    envValue: unknown,
  ) => Promise<unknown>;
  syncUserSecretDeclarationsForTarget?: (
    companyId: string,
    target: { targetType: "agent"; targetId: string; pathPrefix?: string },
    refs: Array<{
      definitionKey: string;
      configPath: string;
      envKey: string;
      versionSelector?: SecretVersionSelector;
      required?: boolean;
      allowMissingOverride?: boolean;
      label?: string | null;
    }>,
    options?: { replaceAll?: boolean },
  ) => Promise<unknown>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function collectSecretRefs(adapterConfig: unknown): Array<{
  secretId: string;
  configPath: string;
  versionSelector?: SecretVersionSelector;
  projectionClass?: SecretProjectionClass;
  projectionAllowlistKey?: string | null;
}> {
  const config = asRecord(adapterConfig);
  if (!config) return [];
  const refs: Array<{
    secretId: string;
    configPath: string;
    versionSelector?: SecretVersionSelector;
    projectionClass?: SecretProjectionClass;
    projectionAllowlistKey?: string | null;
  }> = [];

  const envValue = asRecord(config.env);
  for (const [key, rawBinding] of Object.entries(envValue ?? {})) {
    const parsed = envBindingSchema.safeParse(rawBinding);
    if (!parsed.success) continue;
    const binding = parsed.data;
    if (typeof binding !== "object" || binding === null || binding.type !== "secret_ref") continue;
    refs.push({
      secretId: binding.secretId,
      configPath: `env.${key}`,
      versionSelector: binding.version ?? "latest",
      projectionClass: binding.projectionClass,
      projectionAllowlistKey: binding.projectionAllowlistKey ?? null,
    });
  }

  for (const [key, rawBinding] of Object.entries(config)) {
    if (key === "env") continue;
    const parsed = envBindingSchema.safeParse(rawBinding);
    if (!parsed.success) continue;
    const binding = parsed.data;
    if (typeof binding !== "object" || binding === null || binding.type !== "secret_ref") continue;
    refs.push({
      secretId: binding.secretId,
      configPath: key,
      versionSelector: binding.version ?? "latest",
      projectionClass: binding.projectionClass,
      projectionAllowlistKey: binding.projectionAllowlistKey ?? null,
    });
  }

  return refs;
}

/**
 * Config paths in an adapterConfig that would be written as secret bindings by
 * {@link syncAgentAdapterEnvBindings}.
 *
 * Deliberately mirrors the traversal and parse used by `collectSecretRefs` and
 * `collectUserSecretRefs` below: a binding shape this misses but those collect
 * would be a binding an agent could create while the route guard stayed silent.
 * Keep the three in lockstep.
 */
export function collectAgentAdapterSecretBindingPaths(adapterConfig: unknown): string[] {
  const config = asRecord(adapterConfig);
  if (!config) return [];
  const paths: string[] = [];

  const envValue = asRecord(config.env);
  for (const [key, rawBinding] of Object.entries(envValue ?? {})) {
    if (isSecretBindingRef(rawBinding)) paths.push(`env.${key}`);
  }

  for (const [key, rawBinding] of Object.entries(config)) {
    if (key === "env") continue;
    if (isSecretBindingRef(rawBinding)) paths.push(key);
  }

  return paths;
}

function isSecretBindingRef(rawBinding: unknown): boolean {
  const parsed = envBindingSchema.safeParse(rawBinding);
  if (!parsed.success) return false;
  const binding = parsed.data;
  if (typeof binding !== "object" || binding === null) return false;
  return binding.type === "secret_ref" || binding.type === "user_secret_ref";
}

function collectUserSecretRefs(adapterConfig: unknown): Array<{
  definitionKey: string;
  configPath: string;
  envKey: string;
  versionSelector?: SecretVersionSelector;
  required?: boolean;
  allowMissingOverride?: boolean;
}> {
  const config = asRecord(adapterConfig);
  if (!config) return [];
  const refs: Array<{
    definitionKey: string;
    configPath: string;
    envKey: string;
    versionSelector?: SecretVersionSelector;
    required?: boolean;
    allowMissingOverride?: boolean;
  }> = [];

  const envValue = asRecord(config.env);
  for (const [key, rawBinding] of Object.entries(envValue ?? {})) {
    const parsed = envBindingSchema.safeParse(rawBinding);
    if (!parsed.success) continue;
    const binding = parsed.data;
    if (typeof binding !== "object" || binding === null || binding.type !== "user_secret_ref") continue;
    refs.push({
      definitionKey: binding.key,
      configPath: `env.${key}`,
      envKey: key,
      versionSelector: binding.version ?? "latest",
      required: binding.required ?? true,
      allowMissingOverride: binding.allowMissingOverride ?? false,
    });
  }

  for (const [key, rawBinding] of Object.entries(config)) {
    if (key === "env") continue;
    const parsed = envBindingSchema.safeParse(rawBinding);
    if (!parsed.success) continue;
    const binding = parsed.data;
    if (typeof binding !== "object" || binding === null || binding.type !== "user_secret_ref") continue;
    refs.push({
      definitionKey: binding.key,
      configPath: key,
      envKey: key,
      versionSelector: binding.version ?? "latest",
      required: binding.required ?? true,
      allowMissingOverride: binding.allowMissingOverride ?? false,
    });
  }

  return refs;
}

export async function syncAgentAdapterEnvBindings(input: {
  secretsSvc: AgentSecretBindingSyncService;
  companyId: string;
  agentId: string;
  adapterConfig: unknown;
}) {
  if (input.secretsSvc.syncSecretRefsForTarget) {
    await input.secretsSvc.syncSecretRefsForTarget(
      input.companyId,
      { targetType: "agent", targetId: input.agentId },
      collectSecretRefs(input.adapterConfig),
      { replaceAll: true },
    );
    await input.secretsSvc.syncUserSecretDeclarationsForTarget?.(
      input.companyId,
      { targetType: "agent", targetId: input.agentId },
      collectUserSecretRefs(input.adapterConfig),
      { replaceAll: true },
    );
    return;
  }
  const envValue = asRecord(asRecord(input.adapterConfig)?.env);
  await input.secretsSvc.syncEnvBindingsForTarget?.(
    input.companyId,
    { targetType: "agent", targetId: input.agentId },
    envValue,
  );
}
