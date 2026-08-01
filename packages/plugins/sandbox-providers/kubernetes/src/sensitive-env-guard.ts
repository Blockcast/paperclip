// A read-only `GET Pod` returns the full container spec, including every
// literal `env[].value`. Anything with Pod read in the tenant namespace can
// therefore retrieve any credential injected that way (BLO-17973/BLO-17980).
// Sensitive values must reach the container through `envFrom.secretRef`,
// `valueFrom.secretKeyRef`, or a mounted secret volume — none of which surface
// the value through the Pod object.
//
// This guard is fail-closed and runs on every manifest we build, so a future
// literal credential breaks the build and the test suite rather than silently
// shipping. It mirrors the same check in the external claude_k8s adapter
// (paperclip-adapter-claude-k8s `job-manifest.ts`), which renders the
// production agent-job pods.

const SENSITIVE_ENV_NAME = /TOKEN|SECRET|PASSWORD|KEY|CREDENTIAL|AUTH/i;

// `*_FILE` vars hold a *path* to a mounted secret (e.g.
// PAPERCLIP_GITHUB_TOKEN_FILE=/paperclip/.secrets/github-token/token). That is
// the pattern we want people reaching for, so the guard must not push them off
// it — the path is not the secret.
const PATH_POINTER_ENV_NAME = /_FILE$/;

export function isSensitiveEnvName(name: string): boolean {
  return SENSITIVE_ENV_NAME.test(name) && !PATH_POINTER_ENV_NAME.test(name);
}

export interface LiteralSensitiveEnvVar {
  container: string;
  envName: string;
}

interface ContainerLike {
  name?: unknown;
  env?: unknown;
}

// Every place a pod spec can carry containers. Used both to scan a known pod
// spec and to recognise one inside an arbitrary manifest — keep it single so
// the two cannot drift apart.
const CONTAINER_LIST_KEYS = ["initContainers", "containers", "ephemeralContainers"] as const;

function collectContainers(podSpec: unknown): Array<{ kind: string; container: ContainerLike }> {
  const spec = (podSpec ?? {}) as Record<string, unknown>;
  const out: Array<{ kind: string; container: ContainerLike }> = [];
  for (const kind of CONTAINER_LIST_KEYS) {
    const list = spec[kind];
    if (!Array.isArray(list)) continue;
    for (const container of list) {
      if (container && typeof container === "object") {
        out.push({ kind, container: container as ContainerLike });
      }
    }
  }
  return out;
}

/**
 * Returns every env var that carries credential material as a literal `value`.
 * An env var is reported only when it actually has a literal `value`; a
 * `valueFrom` reference (or no value at all) is the secure form and passes.
 */
export function findLiteralSensitiveEnvVars(podSpec: unknown): LiteralSensitiveEnvVar[] {
  const findings: LiteralSensitiveEnvVar[] = [];
  for (const { kind, container } of collectContainers(podSpec)) {
    if (!Array.isArray(container.env)) continue;
    const containerName =
      typeof container.name === "string" && container.name.length > 0
        ? container.name
        : `<unnamed ${kind} entry>`;
    for (const entry of container.env) {
      if (!entry || typeof entry !== "object") continue;
      const envVar = entry as Record<string, unknown>;
      const envName = envVar.name;
      if (typeof envName !== "string" || !isSensitiveEnvName(envName)) continue;
      // Only a literal `value` leaks through GET Pod.
      if (!("value" in envVar) || envVar.value === undefined) continue;
      findings.push({ container: containerName, envName });
    }
  }
  return findings;
}

/**
 * Throws if any container in `podSpec` injects a sensitive-named env var as a
 * literal value. Call this on every pod-bearing manifest before it is sent to
 * the API server.
 */
export function assertNoLiteralSensitiveEnv(podSpec: unknown, manifestDescription: string): void {
  const findings = findLiteralSensitiveEnvVars(podSpec);
  if (findings.length === 0) return;
  const detail = findings.map((f) => `${f.container}.env[${f.envName}]`).join(", ");
  throw new Error(
    `${manifestDescription}: refusing to build a pod spec with credential material in literal env values ` +
      `(${detail}). A read-only GET Pod would expose these. Route them through envFrom.secretRef, ` +
      `valueFrom.secretKeyRef, or a mounted secret volume instead. If the value is genuinely not a ` +
      `secret, rename it so it does not match /${SENSITIVE_ENV_NAME.source}/i, or use a *_FILE path pointer.`,
  );
}

// Job nests its pod spec under spec.template.spec; the Sandbox CR uses
// spec.podTemplate.spec; future kinds will pick their own path. Rather than
// making every call site know the shape, find pod specs structurally.
const MAX_MANIFEST_DEPTH = 8;

function collectPodSpecs(node: unknown, depth = 0): unknown[] {
  if (depth > MAX_MANIFEST_DEPTH || !node || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap((item) => collectPodSpecs(item, depth + 1));
  const obj = node as Record<string, unknown>;
  const found: unknown[] = [];
  // A pod spec is any object carrying a container list.
  if (CONTAINER_LIST_KEYS.some((key) => Array.isArray(obj[key]))) found.push(obj);
  for (const value of Object.values(obj)) found.push(...collectPodSpecs(value, depth + 1));
  return found;
}

/**
 * Shape-agnostic variant of assertNoLiteralSensitiveEnv: walks an entire
 * manifest for embedded pod specs and asserts on each.
 *
 * This is the choke-point check. The builders assert on their own output, but
 * `createJob`/`createSandboxCr` accept an arbitrary manifest, so a hand-built
 * one would otherwise reach the API server unguarded.
 */
export function assertManifestHasNoLiteralSensitiveEnv(
  manifest: unknown,
  manifestDescription: string,
): void {
  for (const podSpec of collectPodSpecs(manifest)) {
    assertNoLiteralSensitiveEnv(podSpec, manifestDescription);
  }
}
