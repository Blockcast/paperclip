// A read-only `GET Pod` returns the full container spec, including every
// literal `env[].value`. Anything with Pod read in the tenant namespace can
// therefore retrieve any credential injected that way (BLO-17973/BLO-17980).
// Sensitive values must reach the container through `envFrom.secretRef`,
// `valueFrom.secretKeyRef`, or a mounted secret volume — none of which surface
// the value through the Pod object.
//
// This guard is fail-closed and runs on every manifest we build, so a future
// literal credential breaks the build and the test suite rather than silently
// shipping.
//
// It does NOT mirror any protection in the external claude_k8s adapter, which
// is the code that actually renders production agent-job pods. As of the SHA
// pinned by `Dockerfile` (`CLAUDE_K8S_REF=3ad3370`), that adapter applies no
// allowlist, denylist, or filter of any kind on the pod-env path:
// `getSelfPodInfo()` (`k8s-client.ts`) snapshots the paperclip server's own pod
// wholesale, and `job-manifest.ts` replays every channel of it onto each agent
// pod — literal `env[].value`s, `valueFrom.secretKeyRef`s, `envFrom` sources,
// and mounted secret volumes alike. The only entries dropped are empty-string
// values and unnamed ones.
//
// So this guard covers only manifests built by this repo's Kubernetes
// sandbox-provider path, and provides zero coverage for that adapter. See
// BLO-22514 for the gap and BLO-22506 for the related k8s-ro read exposure.
//
// POLICY: allowlist, not denylist.
//
// The first version of this guard rejected names matching
// /TOKEN|SECRET|PASSWORD|KEY|CREDENTIAL|AUTH/i. Review of #901 established that
// a denylist cannot hold this invariant, for two concrete reasons:
//
//   1. It permits every literal whose name simply misses the pattern. The known
//      counter-example is `MCP_CONFIG`, which carries a merged mcp.json with
//      embedded `Authorization: Bearer …` headers and matches nothing.
//   2. It exempted `*_FILE` on the name alone, so
//      `{ name: "API_TOKEN_FILE", value: "<the actual token>" }` passed even
//      though the value was never a path.
//
// So the rule is inverted: a literal `value` is refused unless it is
// affirmatively known to be safe — either an explicitly allowlisted
// name=value pair, or a `*_FILE` pointer whose value really is a
// mounted-secret path. Note the allowlist binds the *pair*: allowlisting a bare
// name would leave the same hole one variable wide (`HOME=<credential>`).
// Adding a new literal env var therefore requires a deliberate edit here, which
// is exactly the review checkpoint a credential-disclosure defect warrants.

/**
 * Env vars permitted to carry a literal value, keyed by name and constrained to
 * an exact set of permitted values. Keep this list short and justify every
 * addition — an entry here is an assertion that a read-only `GET Pod` may
 * disclose that exact string.
 *
 * The value set is not decoration. Allowlisting by *name* alone would reproduce
 * the denylist flaw this guard exists to remove, just narrowed to one variable:
 * `{ name: "HOME", value: "<credential>" }` would sail through while the header
 * above claims every accepted literal is affirmatively known safe. Binding the
 * name to its value keeps that claim true.
 */
const SAFE_LITERAL_ENV_VALUES = new Map<string, ReadonlySet<string>>([
  // Filesystem home for the agent user. Not secret, and needed before any
  // secret material is mounted. Both builders emit exactly this value
  // (pod-spec-builder.ts, sandbox-cr-builder.ts).
  ["HOME", new Set(["/home/paperclip"])],
]);

/**
 * `*_FILE` vars hold a *path* to a mounted secret (e.g.
 * PAPERCLIP_GITHUB_TOKEN_FILE=/paperclip/.secrets/github-token/token). That is
 * the pattern we want people reaching for, so the guard must not push them off
 * it — but it must confirm the value really is a path, or the suffix becomes a
 * trivial bypass.
 */
const PATH_POINTER_ENV_NAME = /_FILE$/;

/**
 * Roots under which mounted secrets legitimately appear. A pointer outside
 * these is refused: not because a path elsewhere is necessarily a credential,
 * but because the entire value of this check is that it stays narrow.
 *
 * `/paperclip/.secrets/` rather than `/paperclip/`: the latter is the whole
 * persistent data volume (`persistence.mountPath`), so it would admit every
 * workspace path under `/paperclip/instances/…`. The mounted-secret convention
 * is the `.secrets` subtree — see the `PAPERCLIP_GITHUB_TOKEN_FILE` default in
 * deploy/helm/paperclip/templates/statefulset.yaml.
 */
const SECRET_MOUNT_ROOTS = [
  "/paperclip/.secrets/",
  "/var/run/secrets/",
  "/run/secrets/",
  "/etc/paperclip/",
];

/**
 * True when `value` is a credible mounted-secret path rather than an inlined
 * credential. Requires an absolute POSIX path, free of whitespace and `..`
 * traversal, under a known mount root. A raw token satisfies none of these.
 */
export function isMountedSecretPath(value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (!value.startsWith("/")) return false;
  if (/\s/.test(value)) return false;
  if (value.split("/").includes("..")) return false;
  return SECRET_MOUNT_ROOTS.some((root) => value.startsWith(root));
}

/**
 * True when `name`/`value` may appear as a literal `env[].value` in a pod spec.
 *
 * Always takes the *pair*, never the name alone: an allowlisted name is safe
 * only with an allowlisted value, and a `*_FILE` name only with a value that is
 * genuinely a path.
 */
export function isSafeLiteralEnv(name: string, value: unknown): boolean {
  const permittedValues = SAFE_LITERAL_ENV_VALUES.get(name);
  if (permittedValues) return typeof value === "string" && permittedValues.has(value);
  if (PATH_POINTER_ENV_NAME.test(name)) return isMountedSecretPath(value);
  return false;
}

export interface LiteralSensitiveEnvVar {
  container: string;
  envName: string;
  /** Why it was refused — never includes the value itself. */
  reason: "not-allowlisted" | "value-not-allowlisted" | "file-pointer-not-a-path";
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
 * Returns every env var carrying a literal `value` that is not affirmatively
 * safe. An env var is reported only when it actually has a literal `value`; a
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
      if (typeof envName !== "string") continue;
      // Only a literal `value` leaks through GET Pod.
      if (!("value" in envVar) || envVar.value === undefined) continue;
      if (isSafeLiteralEnv(envName, envVar.value)) continue;
      findings.push({
        container: containerName,
        envName,
        reason: SAFE_LITERAL_ENV_VALUES.has(envName)
          ? "value-not-allowlisted"
          : PATH_POINTER_ENV_NAME.test(envName)
            ? "file-pointer-not-a-path"
            : "not-allowlisted",
      });
    }
  }
  return findings;
}

/**
 * Throws if any container in `podSpec` injects a literal env value that is not
 * affirmatively safe. Call this on every pod-bearing manifest before it is sent
 * to the API server.
 *
 * The message names the container and variable but never the value, so the
 * guard cannot itself become a disclosure path.
 */
export function assertNoLiteralSensitiveEnv(podSpec: unknown, manifestDescription: string): void {
  const findings = findLiteralSensitiveEnvVars(podSpec);
  if (findings.length === 0) return;
  const detail = findings.map((f) => `${f.container}.env[${f.envName}] (${f.reason})`).join(", ");
  const allowlisted = [...SAFE_LITERAL_ENV_VALUES]
    .map(([name, values]) => [...values].map((v) => `${name}=${v}`).join(", "))
    .join(", ");
  throw new Error(
    `${manifestDescription}: refusing to build a pod spec with a literal env value that is not known ` +
      `to be non-secret (${detail}). A read-only GET Pod would expose these. Route the value through ` +
      `envFrom.secretRef, valueFrom.secretKeyRef, or a mounted secret volume. If it is a pointer to a ` +
      `mounted secret, name it *_FILE and set it to an absolute path under one of ` +
      `${SECRET_MOUNT_ROOTS.join(", ")}. If it is genuinely not secret, add the exact name=value to ` +
      `SAFE_LITERAL_ENV_VALUES in sensitive-env-guard.ts (currently: ${allowlisted}) with a comment ` +
      `saying why it is safe to disclose.`,
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
