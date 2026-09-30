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
 * The secret-binding rows {@link syncAgentAdapterEnvBindings} would write for an
 * adapterConfig, keyed by config path.
 *
 * Built from `collectSecretRefs`/`collectUserSecretRefs` themselves rather than
 * from a third traversal of its own, so a binding shape the route guard misses
 * cannot be a shape the sync persists — lockstep holds by construction rather
 * than by convention.
 *
 * `projectionClass`/`projectionAllowlistKey` are deliberately excluded from the
 * signature: they are derived server-side from `(targetType, configPath)`
 * (`resolveProjectionClassification` in `services/secrets.ts`), so a
 * caller-declared value cannot change the row that lands and must not count as
 * a change here.
 *
 * A config path is a single object key in one traversal, so at most one binding
 * can occupy it — the map is total, not lossy.
 */
function secretBindingSignaturesByPath(adapterConfig: unknown): Map<string, string> {
  const signatures = new Map<string, string>();
  for (const ref of collectSecretRefs(adapterConfig)) {
    signatures.set(
      ref.configPath,
      JSON.stringify(["secret_ref", ref.secretId, ref.versionSelector ?? "latest"]),
    );
  }
  for (const ref of collectUserSecretRefs(adapterConfig)) {
    signatures.set(
      ref.configPath,
      JSON.stringify([
        "user_secret_ref",
        ref.definitionKey,
        ref.versionSelector ?? "latest",
        ref.required ?? true,
        ref.allowMissingOverride ?? false,
      ]),
    );
  }
  return signatures;
}

/**
 * Config paths whose secret binding would be created, modified, or removed by
 * persisting `afterAdapterConfig` in place of `beforeAdapterConfig` (BLO-27991).
 *
 * The route guard is a diff rather than a blanket refusal for two reasons, both
 * of which a blanket refusal got wrong:
 *
 *  - An agent-facing GET does *not* mask every binding. `redactAgentSecrets`
 *    flattens only the top-level `env` map to the `***` sentinel; a `secret_ref`
 *    anywhere else — and every binding returned by `redactAgentConfiguration` —
 *    stays a readable pointer by design (`redaction.ts`,
 *    `sanitizeSecretRefPointer`). So an honest read-modify-write round-trip does
 *    echo literal bindings back, and refusing them outright 403s the honest
 *    caller.
 *  - `syncSecretRefsForTarget` runs with `replaceAll: true`, so *dropping* a key
 *    deletes its binding row. A guard that only looks at what the request
 *    carries cannot see a removal, and pushes the caller it just refused
 *    straight at one.
 */
export function diffAgentAdapterSecretBindings(
  beforeAdapterConfig: unknown,
  afterAdapterConfig: unknown,
): string[] {
  const before = secretBindingSignaturesByPath(beforeAdapterConfig);
  const after = secretBindingSignaturesByPath(afterAdapterConfig);
  const changed = new Set<string>();
  for (const [configPath, signature] of after) {
    if (before.get(configPath) !== signature) changed.add(configPath);
  }
  for (const configPath of before.keys()) {
    if (!after.has(configPath)) changed.add(configPath);
  }
  return [...changed].sort();
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
