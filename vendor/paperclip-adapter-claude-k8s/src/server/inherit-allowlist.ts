/**
 * Allowlist governing what the paperclip **server** pod hands down to the agent
 * **Job** pods this adapter creates (BLO-22514).
 *
 * `getSelfPodInfo()` reads the running server pod and snapshots its env,
 * `envFrom` sources and mounted secret volumes; `job-manifest.ts` replays all of
 * it onto every agent Job. Before this module there was no filter on that path,
 * so each agent container received the server's entire secret env — including
 * `PAPERCLIP_AGENT_JWT_SECRET` (mint an API key for *any* agent),
 * `DATABASE_URL` (bypass the API and all of authorization.ts) and
 * `GITHUB_APP_PRIVATE_KEY` (mint installation tokens for the whole org).
 *
 * The threat model is not an external breach — the readers are our own agents in
 * our own cluster. It is **prompt injection**: agents routinely ingest
 * attacker-influenceable text (PR bodies, issue comments, fetched pages), so a
 * payload that induces one agent to read and post these values turns a content
 * bug into full control-plane compromise.
 *
 * POLICY: allowlist, not denylist.
 *
 * A denylist cannot hold this invariant — it permits every name that simply
 * misses the pattern, and the server's env grows without anyone re-reading this
 * file. So inheritance is refused unless a name is affirmatively known to be
 * needed by an agent. Adding one is a deliberate edit here, which is exactly the
 * review checkpoint a credential-disclosure defect warrants. This mirrors the
 * reasoning already written down for the literal-value guard in
 * `packages/plugins/sandbox-providers/kubernetes/src/sensitive-env-guard.ts`.
 *
 * There is deliberately **no operator/config escape hatch.** Per-agent
 * `assigneeAdapterOverrides.adapterConfig` is writable from the Paperclip API,
 * so a config-extensible allowlist would let an agent re-admit `DATABASE_URL`
 * for itself — reintroducing the escalation this module exists to close.
 * Widening the allowlist requires a code change and a review.
 */

/**
 * Server-only names that must NEVER reach an agent pod.
 *
 * Redundant with "allowlist, not denylist" by construction — nothing here
 * appears in the allowlist below — and that redundancy is the point. It is
 * checked FIRST and overrides every other rule, so a future prefix family
 * broad enough to match one of these cannot silently re-admit it. Each entry is
 * a credential whose disclosure is a control-plane compromise, not a
 * degradation.
 */
export const SERVER_ONLY_ENV_DENY: ReadonlySet<string> = new Set([
  // Signing key for agent API tokens. Derivation is deterministic
  // (HMAC-SHA256(master, `jwt:${instanceId}:${companyId}`), see
  // server/src/agent-auth-jwt.ts), so holding this is strictly stronger than
  // stealing any individual agent's live token.
  "PAPERCLIP_AGENT_JWT_SECRET",
  // Direct Postgres access — bypasses the API and every authorization check.
  "DATABASE_URL",
  // Master seed for secret encryption. Not named in BLO-22514's acceptance
  // criteria; found while enumerating the server pod's env for this fix, and
  // it belongs in the same class as the JWT signing key.
  "PAPERCLIP_MASTER_KEY_SEED",
  // GitHub App identity: mint installation tokens across the whole installation.
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_APP_ID",
  "GITHUB_APP_INSTALLATION_ID",
  // Forge webhook deliveries (including review-request wakes).
  "GITHUB_WEBHOOK_SECRET",
  // Dashboard/OIDC login secret.
  "PAPERCLIP_DEX_OIDC_CLIENT_SECRET",
  // Authenticates inbound Alertmanager webhooks.
  "PAPERCLIP_ALERTMANAGER_WEBHOOK_TOKEN",
]);

/**
 * Exact env names an agent Job legitimately needs from the server pod.
 *
 * Every entry is justified below. Two classes are represented: names this
 * adapter itself reads back off `selfPod.inheritedEnv` by name, and names
 * consumed further down by the agent runtime (Claude Code, the `gh` wrapper,
 * MCP bridges) which therefore never appear as a read in this repo.
 */
export const AGENT_ENV_ALLOWLIST: ReadonlySet<string> = new Set([
  // --- Read by name in this adapter -------------------------------------
  // job-manifest.ts: the inherited value points at the in-cluster service;
  // buildPaperclipEnv()'s localhost default is wrong for a Job pod.
  // Load-bearing beyond this adapter: packages/mcp-server/src/config.ts THROWS
  // when it is unset, so dropping it breaks the agent-side MCP stdio bridge
  // outright rather than degrading it.
  "PAPERCLIP_API_URL",
  // job-manifest.ts: seeds the agent's Claude config directory. Also read
  // agent-side by env-guard.ts, which writes its hook and settings.json there.
  "CLAUDE_CONFIG_DIR",
  // Read agent-side only — packages/mcp-server/src/paperclip-links.ts uses it
  // to build the issue/board links the MCP bridge hands back to the agent. It
  // appears nowhere in this adapter, which is exactly why an allowlist derived
  // purely from adapter reads would have missed it.
  "PAPERCLIP_PUBLIC_URL",

  // --- Agent runtime identity/layout ------------------------------------
  "PAPERCLIP_HOME",
  "PAPERCLIP_INSTANCE_ID",
  // Binary lookup for every tool the agent shells out to.
  "PATH",
  // V8 heap ceiling. Inherited today, so agents already run under it;
  // re-tuning it for differently-sized Job pods is a separate change and is
  // deliberately not bundled into a security fix. Worth a follow-up: the value
  // is tuned for the server's 10Gi limit, while a Job pod's is 8Gi, so it
  // leaves less headroom there than intended.
  "NODE_OPTIONS",

  // --- Path pointers to mounted secrets ---------------------------------
  // Carries a *path*, not a credential; the material arrives through the
  // allowlisted secret volumes below. Read by scripts/gh-token-wrapper.sh —
  // the target of the /usr/bin/gh symlink — and by the PVC-resident git
  // credential helper, so every gh/git/github-mcp-server call in the pod
  // depends on it. Dropping it degrades the whole fleet to anonymous GitHub
  // auth, which presents as a permissions problem rather than a config one.
  "PAPERCLIP_GITHUB_TOKEN_FILE",
  // Retained conservatively. No agent-pod reader was found for these two — the
  // known readers are the server's seed-init container and the server-side
  // gbrain client factory, and agents reach gbrain over HTTP with a Bearer
  // pre-minted into their mcpServers config. They are a URL and a path pointer
  // rather than credentials, so keeping them is not a disclosure; they are
  // listed as a tightening candidate rather than dropped blind, because the
  // cost of being wrong is breaking gbrain for every agent.
  "PAPERCLIP_GBRAIN_AUTHBOT_SERVICE_KEY_FILE",
  "PAPERCLIP_GBRAIN_OAUTH_CLIENTS_URL",

  // --- Agent runtime model routing --------------------------------------
  // Also retained conservatively, on the same basis: the confirmed readers are
  // the codex_local / opencode_local server-side adapters, and a claude_k8s
  // pod's codex path (scripts/paperclip-consult-codex.sh) reads none of them.
  // Non-secret routing config; tightening candidates.
  "PAPERCLIP_CODEX_PROVIDERS",
  "PAPERCLIP_CODEX_USE_HOST_HOME",
  "PAPERCLIP_OPENCODE_MODEL_ALLOWLIST",

  // --- Toolchain cache locations ----------------------------------------
  // Non-secret paths. Inheriting these is in practice INERT: buildEnvVars()
  // always applies its own RUNTIME_CACHE_ENV (or the isolation cacheEnv) over
  // them, and only an explicit adapterConfig.env entry wins — an inherited
  // value never does. They are allowlisted so that a future change which stops
  // setting them does not silently strand the toolchain, not because a
  // deployment can override them this way.
  //
  // XDG_CONFIG_HOME is deliberately NOT here. The adapter sets it only under
  // isolation, so in shared mode the inherited value ("/runtime-config") is an
  // emptyDir the Job pod never mounts — and it is load-bearing for
  // `git config --global` resolution. Inheriting a path that does not exist in
  // the pod is worse than letting it fall back to $HOME.
  "GOCACHE",
  "GOMODCACHE",
  "BUN_INSTALL_CACHE",
  "PIP_CACHE_DIR",
  "PLAYWRIGHT_BROWSERS_PATH",
  "XDG_CACHE_HOME",
  "npm_config_cache",
]);

/**
 * Third-party LLM/cloud provider families an agent Job needs in full.
 *
 * Prefixes rather than exact names because provider routing is
 * deployment-shaped: this cluster runs Anthropic + OpenAI through the Penstock
 * gateway, while a Bedrock or Vertex deployment needs a different set that
 * nobody would remember to add here (job-manifest.ts calls this layer
 * "Bedrock, API keys, etc."). Pinning exact names would break those
 * deployments silently.
 *
 * Safe to widen this way because these namespaces are owned by external SDKs:
 * no Paperclip control-plane secret can be named `ANTHROPIC_*` or `AWS_*`, and
 * `SERVER_ONLY_ENV_DENY` is checked first regardless. The credentials that do
 * match (e.g. `ANTHROPIC_AUTH_TOKEN`) are *agent* credentials — the agent
 * cannot do its job without them, and they are already scoped to model access
 * rather than to the control plane.
 */
export const AGENT_ENV_ALLOWED_PREFIXES: readonly string[] = [
  "ANTHROPIC_",
  "OPENAI_",
  "AZURE_OPENAI_",
  "AWS_", // Bedrock deployments
  "GOOGLE_", // Vertex deployments
  "VERTEX_",
  "CLAUDE_CODE_",
];

/**
 * Secret volumes the server pod mounts that agent Jobs legitimately re-mount.
 *
 * Keyed by `secretName` rather than volume name: the volume name is a local
 * label, while the Secret is the thing whose key material is being handed over.
 *
 * This propagation is intentional and documented in
 * deploy/helm/paperclip/values.blockcast.yaml ("The adapter auto-propagates
 * this main-container secret volume into agent Job pods"). Agents genuinely
 * need all three — they are agent-scoped credentials, not control-plane ones.
 */
export const AGENT_SECRET_VOLUME_ALLOWLIST: ReadonlySet<string> = new Set([
  // gbrain plugin's managed service key (read via PAPERCLIP_GBRAIN_*_FILE).
  "authbot-mcp-consumer-service-keys",
  // GitHub App installation token — the identity `gh` uses for PR/API work.
  "paperclip-github-mcp-token",
  // @allyblockcast user-seat token used for PR authoring + merge (BLO-11994).
  "paperclip-github-merge-token",
]);

/**
 * `envFrom` sources (whole-Secret / whole-ConfigMap injection) an agent Job may
 * inherit, keyed by the referenced Secret or ConfigMap name.
 *
 * Empty, and that is the correct default rather than an oversight: `envFrom`
 * injects an entire object's keys under names this file never sees, which
 * defeats a per-name allowlist by construction. No `envFrom` exists anywhere in
 * deploy/helm/paperclip today, so denying the whole class is a no-op against
 * the current deployment while closing the path pre-emptively. A deployment
 * that needs one should prefer explicit `valueFrom.secretKeyRef` entries, whose
 * names this allowlist can actually reason about.
 */
export const AGENT_ENV_FROM_ALLOWLIST: ReadonlySet<string> = new Set([]);

/** True when an agent Job pod may inherit `name` from the server pod. */
export function isAgentInheritableEnvName(name: string): boolean {
  // Deny wins over everything, including the prefix families.
  if (SERVER_ONLY_ENV_DENY.has(name)) return false;
  if (AGENT_ENV_ALLOWLIST.has(name)) return true;
  return AGENT_ENV_ALLOWED_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/** True when an agent Job pod may re-mount a secret volume backed by `secretName`. */
export function isAgentInheritableSecretVolume(secretName: string): boolean {
  return AGENT_SECRET_VOLUME_ALLOWLIST.has(secretName);
}

/** True when an agent Job pod may inherit an `envFrom` source naming `refName`. */
export function isAgentInheritableEnvFromRef(refName: string): boolean {
  return AGENT_ENV_FROM_ALLOWLIST.has(refName);
}
