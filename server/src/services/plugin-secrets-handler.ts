/**
 * Plugin secrets host-side handler. Plugin workers may resolve shared
 * `secret_ref` config bindings only with an explicit company context.
 */

import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companySecretBindings } from "@paperclipai/db";
import type { EnvSecretRefBinding, SecretProjectionClass, SecretVersionSelector } from "@paperclipai/shared";
import { envBindingSecretRefSchema } from "@paperclipai/shared";
import {
  collectSecretRefPaths,
  isUuidSecretRef,
  readConfigValueAtPath,
} from "./json-schema-secret-refs.js";
import { secretService } from "./secrets.js";
import { unprocessable } from "../errors.js";

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

function invalidSecretRef(secretRef: unknown): Error {
  const rendered =
    typeof secretRef === "string" ? secretRef.trim() || "<empty>" : JSON.stringify(secretRef);
  const err = new Error(
    `Invalid secret reference for plugin: ${rendered ?? "<empty>"}. Use { type: "secret_ref", secretId, version? }`,
  );
  err.name = "InvalidSecretRefError";
  return err;
}

function requireCompanyId(companyId: unknown): string {
  if (typeof companyId !== "string" || companyId.trim().length === 0) {
    throw unprocessable("companyId is required for plugin secret resolution");
  }
  return companyId.trim();
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSecretRefBinding(value: unknown): EnvSecretRefBinding | null {
  const parsed = envBindingSecretRefSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Legacy plugin configs stored a secret reference as a bare UUID string, and
 * plugin `instanceConfigSchema`s still declare those fields as
 * `type: "string", format: "secret-ref"`. Requiring the object form on both the
 * write and resolve paths made those configs unwritable *and* unresolvable —
 * the JSON-schema validator rejects the object, the secret-ref validator
 * rejects the string, so no value satisfied both (BLO-20219).
 *
 * Coerce the legacy spelling to the object binding instead. Omitting `version`
 * selects `latest`, which is exactly what the bare-string form always meant.
 * Callers must only opt into this at schema-declared `format: "secret-ref"`
 * paths, so an unrelated UUID-shaped config value is never treated as a secret.
 */
function coerceLegacySecretRef(value: unknown): EnvSecretRefBinding | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!isUuidSecretRef(trimmed)) return null;
  return parseSecretRefBinding({ type: "secret_ref", secretId: trimmed });
}

function assertSecretRefBinding(
  value: unknown,
  path: string,
  allowLegacyUuid = false,
): EnvSecretRefBinding | null {
  if (allowLegacyUuid) {
    const legacy = coerceLegacySecretRef(value);
    if (legacy) return legacy;
  }
  if (!isPlainRecord(value) || value.type !== "secret_ref") return null;
  const parsed = parseSecretRefBinding(value);
  if (!parsed) {
    throw unprocessable(`Invalid secret_ref binding at ${path}`);
  }
  return parsed;
}

export interface PluginConfigSecretRefBinding {
  secretId: string;
  configPath: string;
  versionSelector?: SecretVersionSelector;
  required?: boolean;
  label?: string | null;
  projectionClass?: SecretProjectionClass;
  projectionAllowlistKey?: string | null;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Extract shared object-shaped secret refs from plugin config. */
export function extractSecretRefBindingsFromConfig(
  configJson: unknown,
  schema?: Record<string, unknown> | null,
): PluginConfigSecretRefBinding[] {
  if (configJson == null || typeof configJson !== "object") return [];

  const refsByPath = new Map<string, PluginConfigSecretRefBinding>();
  const addRef = (binding: EnvSecretRefBinding, configPath: string) => {
    refsByPath.set(configPath, {
      secretId: binding.secretId,
      configPath,
      versionSelector: binding.version ?? "latest",
      required: true,
      label: configPath,
      projectionClass: binding.projectionClass,
      projectionAllowlistKey: binding.projectionAllowlistKey ?? null,
    });
  };

  const secretPaths = collectSecretRefPaths(schema);
  for (const dotPath of secretPaths) {
    const current = readConfigValueAtPath(configJson as Record<string, unknown>, dotPath);
    // Legacy bare-UUID refs are accepted *only* here, at paths the manifest
    // declares as `format: "secret-ref"`. The untyped walk below must not
    // coerce, or any UUID-shaped config value would become a secret binding.
    const binding = assertSecretRefBinding(current, dotPath, true);
    if (binding) addRef(binding, dotPath);
  }

  function walk(value: unknown, path: string): void {
    const binding = assertSecretRefBinding(value, path || "$");
    if (binding) {
      addRef(binding, path || "$");
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, path ? `${path}.${index}` : String(index)));
      return;
    }
    if (!isPlainRecord(value)) return;
    for (const [key, child] of Object.entries(value)) {
      walk(child, path ? `${path}.${key}` : key);
    }
  }

  walk(configJson, "");
  return [...refsByPath.values()];
}

/** Backward-compatible helper returning only secret IDs. */
export function extractSecretRefsFromConfig(
  configJson: unknown,
  schema?: Record<string, unknown> | null,
): Set<string> {
  return new Set(extractSecretRefBindingsFromConfig(configJson, schema).map((ref) => ref.secretId));
}

/** Backward-compatible helper returning secret IDs grouped by config path. */
export function extractSecretRefPathsFromConfig(
  configJson: unknown,
  schema?: Record<string, unknown> | null,
): Map<string, Set<string>> {
  const refs = new Map<string, Set<string>>();
  for (const ref of extractSecretRefBindingsFromConfig(configJson, schema)) {
    const paths = refs.get(ref.secretId) ?? new Set<string>();
    paths.add(ref.configPath);
    refs.set(ref.secretId, paths);
  }
  return refs;
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

export interface PluginSecretsResolveParams {
  /** Shared secret reference object from company-scoped plugin config. */
  secretRef: string | EnvSecretRefBinding;
  /** Authorized company context for this worker invocation. */
  companyId?: string;
  /** Config path that produced this ref. Required when a secret appears in multiple paths. */
  configPath?: string;
  actorType?: "agent" | "user" | "system" | "plugin";
  actorId?: string | null;
  issueId?: string | null;
  heartbeatRunId?: string | null;
}

export interface PluginSecretsHandlerOptions {
  db: Db;
  pluginId: string;
}

export interface PluginSecretsService {
  resolve(params: PluginSecretsResolveParams): Promise<string>;
}

function createRateLimiter(maxAttempts: number, windowMs: number) {
  const attempts = new Map<string, number[]>();

  return {
    check(key: string): boolean {
      const now = Date.now();
      const windowStart = now - windowMs;
      const existing = (attempts.get(key) ?? []).filter((ts) => ts > windowStart);
      if (existing.length >= maxAttempts) return false;
      existing.push(now);
      attempts.set(key, existing);
      return true;
    },
  };
}

export function createPluginSecretsHandler(
  options: PluginSecretsHandlerOptions,
): PluginSecretsService {
  const { db, pluginId } = options;
  const rateLimiter = createRateLimiter(30, 60_000);

  async function lookupBinding(input: {
    companyId: string;
    secretId: string;
    versionSelector: SecretVersionSelector;
    configPath?: string;
  }) {
    const conditions = [
      eq(companySecretBindings.companyId, input.companyId),
      eq(companySecretBindings.targetType, "plugin"),
      eq(companySecretBindings.targetId, pluginId),
      eq(companySecretBindings.secretId, input.secretId),
    ];
    if (input.configPath) {
      conditions.push(eq(companySecretBindings.configPath, input.configPath));
    }
    const rows = await db
      .select()
      .from(companySecretBindings)
      .where(and(...conditions));
    const matchingVersion = rows.filter(
      (row) => row.versionSelector === String(input.versionSelector),
    );
    return matchingVersion;
  }

  return {
    async resolve(params: PluginSecretsResolveParams): Promise<string> {
      // A legacy bare-UUID ref resolves as `{ secretId, version: "latest" }`.
      // This does not widen what a worker can reach: `lookupBinding` below is
      // the authorization gate, and it still requires an explicit
      // companySecretBindings row scoped to this company *and* this plugin.
      const rawRef =
        typeof params.secretRef === "string"
          ? coerceLegacySecretRef(params.secretRef)
          : params.secretRef;
      if (!rawRef) throw invalidSecretRef(params.secretRef);

      const bindingRef = parseSecretRefBinding(rawRef);
      if (!bindingRef) throw invalidSecretRef(params.secretRef);

      const companyId = requireCompanyId(params.companyId);

      if (!rateLimiter.check(`${companyId}:${pluginId}`)) {
        const err = new Error("Rate limit exceeded for secret resolution");
        err.name = "RateLimitExceededError";
        throw err;
      }

      const versionSelector = bindingRef.version ?? "latest";
      const bindings = await lookupBinding({
        companyId,
        secretId: bindingRef.secretId,
        versionSelector,
        configPath: params.configPath,
      });

      if (bindings.length === 0) {
        throw unprocessable(
          `Secret is not bound to plugin:${pluginId}${params.configPath ? ` at ${params.configPath}` : ""}`,
          { code: "binding_missing" },
        );
      }
      if (bindings.length > 1) {
        throw unprocessable(
          "Plugin secret reference is ambiguous; pass configPath when resolving this secret",
          { code: "binding_ambiguous" },
        );
      }

      const binding = bindings[0]!;
      return secretService(db).resolveSecretValue(companyId, bindingRef.secretId, versionSelector, {
        bindingContext: {
          consumerType: "plugin",
          consumerId: pluginId,
          configPath: binding.configPath,
          actorType: params.actorType ?? "plugin",
          actorId: params.actorId ?? pluginId,
          issueId: params.issueId ?? null,
          heartbeatRunId: params.heartbeatRunId ?? null,
          pluginId,
        },
        accessContext: {
          consumerType: "plugin_worker",
          consumerId: pluginId,
          configPath: binding.configPath,
          actorType: params.actorType ?? "plugin",
          actorId: params.actorId ?? pluginId,
          issueId: params.issueId ?? null,
          heartbeatRunId: params.heartbeatRunId ?? null,
          pluginId,
        },
      });
    },
  };
}
