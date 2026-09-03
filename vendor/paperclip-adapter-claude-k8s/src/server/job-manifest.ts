import type * as k8s from "@kubernetes/client-node";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import {
  asString,
  asNumber,
  asBoolean,
  asStringArray,
  parseObject,
  buildPaperclipEnv,
  renderTemplate,
} from "@paperclipai/adapter-utils/server-utils";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ClaudePromptBundle } from "./prompt-cache.js";
import { buildEnvGuardSetupShell } from "./env-guard.js";
import { SERVER_ONLY_ENV_DENY } from "./inherit-allowlist.js";

/**
 * Default path to the project-scope .mcp.json that paperclip's helm-chart seed-init
 * writes on every pod start. The adapter runs inside the paperclip
 * StatefulSet pod, which mounts the same /paperclip PVC the Job pods will
 * mount, so reading this path here gives us the exact baseline the Job
 * pod would otherwise inherit. Read lazily so the adapter does not require
 * the file to exist for normal operation — and so unit tests don't blow up.
 */
const DEFAULT_SHARED_MCP_BASELINE_PATH = "/paperclip/.mcp.json";

function sharedMcpBaselinePath(): string {
  if (process.env.PAPERCLIP_SHARED_MCP_BASELINE_PATH === "") return "";
  return process.env.PAPERCLIP_SHARED_MCP_BASELINE_PATH || DEFAULT_SHARED_MCP_BASELINE_PATH;
}

function loadSharedMcpBaseline(): Record<string, unknown> {
  const baselinePath = sharedMcpBaselinePath();
  if (!baselinePath) return {};
  try {
    const raw = readFileSync(baselinePath, "utf8");
    const parsed = JSON.parse(raw) as { mcpServers?: unknown };
    if (parsed && typeof parsed === "object" && parsed.mcpServers && typeof parsed.mcpServers === "object") {
      return parsed.mcpServers as Record<string, unknown>;
    }
  } catch {
    // Missing / unreadable / malformed baseline → start from empty.
    // Per-agent overrides alone are still a valid mcp.json.
  }
  return {};
}

function assertSafePathComponent(field: string, value: string): void {
  if (!/^[a-zA-Z0-9-]+$/.test(value)) {
    throw new Error(`Invalid ${field} for log path: ${value}`);
  }
}

function sanitizeForK8sPath(value: string): string {
  return value.replace(/[^a-zA-Z0-9-]/g, "");
}

/**
 * Validates an operator-configured filesystem path that is both used as a
 * Kubernetes `mountPath` and interpolated into a container's `sh -c` command.
 *
 * Quoting at each interpolation site is what *guarantees* the shell treats these
 * as one word; this is the second, independent defence, and it fails the
 * manifest build loudly instead of emitting a Pod whose init command contains
 * operator-supplied shell syntax. Kubernetes independently requires an absolute
 * mountPath, so rejecting a relative one here only moves that error earlier.
 */
function assertSafeAbsolutePath(field: string, value: string): void {
  if (!path.posix.isAbsolute(value)) {
    throw new Error(`${field} must be an absolute path: ${value}`);
  }
  // Anything that could terminate a word, chain a command, expand, redirect, or
  // start a new line. Deliberately a denylist of shell-active characters rather
  // than an allowlist, so ordinary path punctuation (`.`, `-`, `_`, `/`) works.
  if (/[;&|()<>$`'"\\\r\n\t*?\[\]{}!#~ ]/.test(value)) {
    throw new Error(`${field} contains characters that are unsafe in a shell command: ${value}`);
  }
}

export function buildPodLogPath(companyId: string, agentId: string, runId: string, isolationKey?: string): string {
  const dir = isolationKey
    ? `/paperclip/instances/default/data/run-logs/${companyId}/${agentId}/isolated/${isolationKey}`
    : `/paperclip/instances/default/data/run-logs/${companyId}/${agentId}`;
  return `${dir}/${runId}.pod.ndjson`;
}

/** Prompts above this size (bytes) are staged via a Secret instead of an
 *  init container env var, protecting against the ~1 MiB PodSpec limit. */
const LARGE_PROMPT_THRESHOLD_BYTES = 256 * 1024;
const RUNTIME_CACHE_VOLUME_NAME = "runtime-cache";
const RUNTIME_CACHE_MOUNT_PATH = "/runtime-cache";
const RUNTIME_CACHE_SIZE_LIMIT = "20Gi";
const RUNTIME_CACHE_ENV: Record<string, string> = {
  XDG_CACHE_HOME: `${RUNTIME_CACHE_MOUNT_PATH}/xdg`,
  GOCACHE: `${RUNTIME_CACHE_MOUNT_PATH}/go-build`,
  GOMODCACHE: `${RUNTIME_CACHE_MOUNT_PATH}/gomod`,
  npm_config_cache: `${RUNTIME_CACHE_MOUNT_PATH}/npm`,
  BUN_INSTALL_CACHE: `${RUNTIME_CACHE_MOUNT_PATH}/bun`,
  PIP_CACHE_DIR: `${RUNTIME_CACHE_MOUNT_PATH}/pip`,
  PLAYWRIGHT_BROWSERS_PATH: `${RUNTIME_CACHE_MOUNT_PATH}/ms-playwright`,
};

type IsolationStorage = "ephemeral" | "persistent";

export type JobIsolation = {
  enabled: boolean;
  mode: "shared" | "run" | "workspace";
  source: "runtime" | "config" | "shared";
  key: string;
  root: string;
  homeRoot: string;
  sessionRoot: string;
  workspaceRoot: string;
  cacheRoot: string;
  tmpRoot: string;
  promptCacheRoot: string;
  storage: {
    workspace: IsolationStorage;
    home: IsolationStorage;
    session: IsolationStorage;
    cache: IsolationStorage;
  };
};

const SHARED_JOB_ISOLATION: JobIsolation = {
  enabled: false,
  mode: "shared",
  source: "shared",
  key: "",
  root: "",
  homeRoot: "",
  sessionRoot: "",
  workspaceRoot: "",
  cacheRoot: "",
  tmpRoot: "",
  promptCacheRoot: "",
  storage: {
    workspace: "persistent",
    home: "persistent",
    session: "persistent",
    cache: "persistent",
  },
};

function readRequiredDescriptorString(raw: Record<string, unknown>, field: string): string {
  const value = asString(raw[field], "").trim();
  if (!value) throw new Error(`runtime isolation descriptor requires ${field}`);
  return value;
}

function readDescriptorStorage(raw: Record<string, unknown>, field: string): IsolationStorage {
  const value = asString(raw[field], "").trim();
  if (value !== "ephemeral" && value !== "persistent") {
    throw new Error(`runtime isolation descriptor has invalid storage.${field}`);
  }
  return value;
}

export function resolveJobIsolation(
  ctx: Pick<AdapterExecutionContext, "runtime" | "agent">,
  config: Record<string, unknown>,
): JobIsolation {
  const runtimeIsolation = (ctx.runtime as unknown as { isolation?: unknown }).isolation;
  if (runtimeIsolation !== null && runtimeIsolation !== undefined) {
    if (typeof runtimeIsolation !== "object" || Array.isArray(runtimeIsolation)) {
      throw new Error("runtime isolation descriptor must be an object");
    }
    const raw = runtimeIsolation as Record<string, unknown>;
    const mode = asString(raw.isolationMode, "").trim();
    if (mode === "shared") {
      const rawKey = readRequiredDescriptorString(raw, "isolationKey");
      const key = sanitizeForK8sPath(rawKey) || shortHash(rawKey);
      assertSafePathComponent("isolationKey", key);
      return { ...SHARED_JOB_ISOLATION, source: "runtime", key };
    }
    if (mode !== "run" && mode !== "workspace") {
      throw new Error(`runtime isolation descriptor has invalid isolationMode: ${mode || "<missing>"}`);
    }
    const rawKey = readRequiredDescriptorString(raw, "isolationKey");
    const key = sanitizeForK8sPath(rawKey) || shortHash(rawKey);
    assertSafePathComponent("isolationKey", key);
    const storage = parseObject(raw.storage);
    const workspaceRoot = readRequiredDescriptorString(raw, "workspaceRoot");
    const homeRoot = readRequiredDescriptorString(raw, "homeRoot");
    const sessionRoot = readRequiredDescriptorString(raw, "sessionRoot");
    const cacheRoot = readRequiredDescriptorString(raw, "cacheRoot");
    const tmpRoot = readRequiredDescriptorString(raw, "tmpRoot");
    for (const [field, value] of Object.entries({ workspaceRoot, homeRoot, sessionRoot, cacheRoot, tmpRoot })) {
      if (!path.posix.isAbsolute(value)) throw new Error(`runtime isolation descriptor ${field} must be absolute`);
    }
    return {
      enabled: true,
      mode,
      source: "runtime",
      key,
      root: path.posix.dirname(homeRoot),
      homeRoot,
      sessionRoot,
      workspaceRoot,
      cacheRoot,
      tmpRoot,
      promptCacheRoot: "",
      storage: {
        workspace: readDescriptorStorage(storage, "workspace"),
        home: readDescriptorStorage(storage, "home"),
        session: readDescriptorStorage(storage, "session"),
        cache: readDescriptorStorage(storage, "cache"),
      },
    };
  }

  const mode = asString(config.isolationMode, "shared").trim().toLowerCase();
  const enabled = mode === "isolated" || mode === "isolate";
  if (!enabled) return SHARED_JOB_ISOLATION;

  const rawKey = asString(config.isolationKey, "").trim();
  if (!rawKey) throw new Error("isolationMode=isolated requires isolationKey");
  const key = sanitizeForK8sPath(rawKey) || shortHash(rawKey);
  assertSafePathComponent("isolationKey", key);
  const companyId = sanitizeForK8sPath(ctx.agent.companyId);
  const agentId = sanitizeForK8sPath(ctx.agent.id);
  assertSafePathComponent("companyId", companyId);
  assertSafePathComponent("agentId", agentId);
  const root = asString(config.isolationRoot, "").trim() || `/paperclip/instances/default/data/k8s-isolation/${companyId}/${agentId}/${key}`;
  const homeRoot = asString(config.homeRoot, "").trim() || `${root}/home`;
  const sessionRoot = asString(config.sessionRoot, "").trim() || homeRoot;
  const workspaceRoot = asString(config.workspaceRoot, "").trim() || `${root}/workspace`;
  const cacheRoot = asString(config.cacheRoot, "").trim() || `${root}/cache`;
  const tmpRoot = asString(config.tmpRoot, "").trim() || `${root}/tmp`;
  const promptCacheRoot = asString(config.promptCacheRoot, "").trim() || `${root}/prompt-cache`;
  return {
    enabled,
    mode: "workspace",
    source: "config",
    key,
    root,
    homeRoot,
    sessionRoot,
    workspaceRoot,
    cacheRoot,
    tmpRoot,
    promptCacheRoot,
    storage: {
      workspace: "persistent",
      home: "persistent",
      session: "persistent",
      cache: "persistent",
    },
  };
}

function encodeClaudeCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9-]/g, "-");
}

function resolveClaudeConfigDir(config: Record<string, unknown>, selfPod: SelfPodInfo): string {
  const envConfig = parseObject(config.env);
  const configured = asString(envConfig.CLAUDE_CONFIG_DIR, "").trim();
  if (configured) return configured;
  const inherited = asString(selfPod.inheritedEnv.CLAUDE_CONFIG_DIR, "").trim();
  if (inherited) return inherited;
  return "/paperclip/.claude";
}

function resolveResumableClaudeSessionId(input: {
  requestedSessionId: string;
  requestedModel: string;
  sessionModel: string;
  workingDir: string;
  config: Record<string, unknown>;
  selfPod: SelfPodInfo;
  claudeConfigDir?: string | null;
}): string {
  const sessionId = input.requestedSessionId.trim();
  if (!sessionId) return "";
  const requestedModel = input.requestedModel.trim();
  if (requestedModel && input.sessionModel.trim() !== requestedModel) return "";
  const sessionFile = path.join(
    input.claudeConfigDir || resolveClaudeConfigDir(input.config, input.selfPod),
    "projects",
    encodeClaudeCwd(input.workingDir),
    `${sessionId}.jsonl`,
  );
  return existsSync(sessionFile) ? sessionId : "";
}

// Inline prompt assembly — these functions are not yet in the published adapter-utils
function joinPromptSections(sections: string[], separator = "\n\n"): string {
  return sections.filter((s) => s.trim().length > 0).join(separator);
}

function stringifyPaperclipWakePayload(wake: unknown): string | null {
  if (!wake || typeof wake !== "object") return null;
  try {
    const json = JSON.stringify(wake);
    return json === "{}" ? null : json;
  } catch {
    return null;
  }
}

function renderPaperclipWakePrompt(wake: unknown, _opts?: { resumedSession?: boolean }): string {
  if (!wake || typeof wake !== "object") return "";
  const w = wake as Record<string, unknown>;
  const reason = typeof w.reason === "string" ? w.reason.trim() : "";
  const comments = Array.isArray(w.comments) ? w.comments : [];
  if (!reason && comments.length === 0) return "";
  const parts: string[] = [];
  if (reason) parts.push(`Wake reason: ${reason}`);
  for (const c of comments) {
    if (typeof c === "object" && c !== null) {
      const comment = c as Record<string, unknown>;
      const body = typeof comment.body === "string" ? comment.body.trim() : "";
      if (body) parts.push(`Comment: ${body}`);
    }
  }
  return parts.join("\n\n");
}
import type { SelfPodInfo } from "./k8s-client.js";

/**
 * Parse a config value that may be either a JSON object or multiline
 * `key=value` text (one pair per line).  This fixes the config-hint
 * parity issue where textarea hints promise `key=value` per line but
 * `parseObject` only handles JSON.
 */
function parseKeyValueConfig(raw: unknown): Record<string, string> {
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    // Already an object (JSON was parsed upstream)
    const result: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === "string") result[k] = v;
    }
    return result;
  }
  if (typeof raw !== "string" || !raw.trim()) return {};
  // Try JSON parse first
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const result: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === "string") result[k] = v;
      }
      return result;
    }
  } catch {
    // Not JSON — fall through to key=value parsing
  }
  // Parse key=value lines
  const result: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx <= 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (key) result[key] = value;
  }
  return result;
}

export interface JobBuildInput {
  ctx: AdapterExecutionContext;
  selfPod: SelfPodInfo;
  /** Prepared prompt bundle (skills + instructions). When provided, --add-dir and --append-system-prompt-file use bundle paths. */
  promptBundle?: ClaudePromptBundle | null;
}

/** When the prompt exceeds the env-var size limit, the manifest uses a
 *  Secret-backed volume instead of the init container's PROMPT_CONTENT env.
 *  The caller must create this Secret before the Job and clean it up after. */
export interface PromptSecret {
  name: string;
  namespace: string;
  data: Record<string, string>;
}

/** Non-null when one or more env vars matched the sensitive-name pattern
 *  (see isSensitiveEnvName). Their values are moved out of the Job's
 *  env[].value into this Secret and referenced via secretKeyRef instead, so
 *  a read-only `GET Pod` on the Job never returns them (BLO-17980/BLO-17973).
 *  Same lifecycle as promptSecret: the caller creates it before the Job and
 *  cleans it up after. */
export interface EnvSecret {
  name: string;
  namespace: string;
  data: Record<string, string>;
}

/** Non-null whenever a merged mcp.json is shipped to the pod. mcp.json
 *  commonly embeds MCP server credentials (e.g. an `Authorization: Bearer
 *  ...` header for an HTTP-transport server, or stdio server env) supplied
 *  via adapterConfig.mcpServers — unlike the name-based EnvSecret routing,
 *  there is no single env-var name to key off, so mcp.json is always
 *  staged as a Secret-backed volume instead of the init container's
 *  MCP_CONFIG env, regardless of size (BLO-17980/BLO-17973). Same
 *  lifecycle as promptSecret: the caller creates it before the Job and
 *  cleans it up after. */
export interface McpConfigSecret {
  name: string;
  namespace: string;
  data: Record<string, string>;
}

/**
 * Env var name patterns that must never carry a literal Job-pod value.
 * Matches anywhere in the name, case-insensitive. A false-positive match
 * only costs an extra secretKeyRef indirection; a false negative is the
 * exact defect BLO-17980/BLO-17973 report (credential material readable
 * via a plain `GET Pod` through the read-only Kubernetes MCP), so this is
 * intentionally broad.
 */
const SENSITIVE_ENV_NAME_RE = /(TOKEN|SECRET|PASSWORD|KEY|CREDENTIAL|AUTH)/i;

export type EnvClassification = "SECRET" | "SAFE_LITERAL";

/** One declared env name (or name family) this file can put on a Job pod. */
export interface EnvNameClassification {
  /** Exact env var name, or the family prefix when `prefix` is true. */
  name: string;
  /** True when `name` is a prefix covering a family of generated names. */
  prefix?: boolean;
  classification: EnvClassification;
  /**
   * Why this classification. For SAFE_LITERAL this is the review artifact —
   * the sentence a future reviewer reads instead of re-deriving whether the
   * value can carry a credential.
   */
  reason: string;
}

/**
 * Declarative classification of every env name this adapter's own code can put
 * on an agent Job pod (BLO-29804, recording the decision on BLO-21858 remedy 2).
 *
 * WHY THIS EXISTS. `SENSITIVE_ENV_NAME_RE` is fail-closed against over-matching
 * but fail-*open* against a credential-carrying variable whose name simply
 * doesn't match; BLO-21858 is the proof it happens. Pinning names one at a time
 * only fixes the instances someone notices. This table is the forcing function:
 * `job-manifest.test.ts` builds manifests across the config permutations and
 * fails, naming the variable, when an emitted name is absent here. A new env var
 * therefore reddens CI in the pull request that introduces it, and the author
 * has to state which class it is rather than inheriting a default.
 *
 * The alternative considered and declined was inverting to "everything is
 * Secret-backed unless declared safe-literal". Measured on live `ac-*` pods
 * there are 8 secretKeyRef vars against 37-41 non-sensitive literals, so
 * inversion would move ~40 operationally-load-bearing fields (`HOME`, `TMPDIR`,
 * `PAPERCLIP_RUN_ID`, the isolation roots) into an opaque Secret and stop
 * `GET Pod` being a triage tool — a bounded security gain for an unbounded
 * operability loss. See BLO-29804 for the full reasoning.
 *
 * SCOPE — read this before adding an entry. This table covers names *this code*
 * introduces. Three channels put operator-supplied names on the pod and cannot
 * be pre-declared, because their names are data rather than code:
 *
 *   1. `adapterConfig.env` (layer 4) — arbitrary keys chosen by an operator.
 *   2. `selfPod.inheritedEnv` — the server Deployment's env, already governed by
 *      `AGENT_ENV_ALLOWLIST` in `inherit-allowlist.ts`, which is the same
 *      declare-or-refuse shape applied at that boundary.
 *   3. `selfPod.inheritedEnvValueFrom` — Deployment `valueFrom` entries, which
 *      carry no literal value on the pod spec at all.
 *
 * The test supplies known values through all three and subtracts exactly those
 * names, so what remains is code-originated and must appear below.
 *
 * NOT a behaviour switch. `isSensitiveEnvName()` keeps its semantics — regex ∪
 * pinned SECRET names — so which vars are Secret-backed is unchanged by the
 * table's existence. A `SECRET` entry whose name the regex already matches is a
 * statement about that name, not a new route.
 */
export const ENV_NAME_CLASSIFICATION: readonly EnvNameClassification[] = [
  // --- SECRET -----------------------------------------------------------
  {
    name: "PAPERCLIP_API_KEY",
    classification: "SECRET",
    reason: "Run-scoped JWT authenticating agent callbacks to the Paperclip API.",
  },
  {
    name: "ANTHROPIC_CUSTOM_HEADERS",
    classification: "SECRET",
    reason:
      "Arbitrary 'Name: value' lines Claude Code forwards on every Anthropic API call, so it can hold a real Authorization: header; matches none of the regex patterns, hence pinned (BLO-21858).",
  },
  {
    name: "PAPERCLIP_K8S_ISOLATION_KEY",
    classification: "SECRET",
    reason:
      "Not a credential — an isolation-root path segment — but the name contains KEY, so SENSITIVE_ENV_NAME_RE already routes it to a secretKeyRef. Declared SECRET to record today's behaviour truthfully; reclassifying it is a behaviour change and gets its own row (BLO-29804).",
  },

  // --- SAFE_LITERAL: identity and run context ---------------------------
  {
    name: "PAPERCLIP_AGENT_ID",
    classification: "SAFE_LITERAL",
    reason: "Opaque agent UUID. Confers nothing without PAPERCLIP_API_KEY, and is already a Job label.",
  },
  {
    name: "PAPERCLIP_COMPANY_ID",
    classification: "SAFE_LITERAL",
    reason: "Opaque company UUID; scoping identifier, not an authorization token.",
  },
  {
    name: "PAPERCLIP_API_URL",
    classification: "SAFE_LITERAL",
    reason: "In-cluster service URL inherited from the Deployment; an address, not a secret.",
  },
  {
    name: "PAPERCLIP_RUN_ID",
    classification: "SAFE_LITERAL",
    reason: "Opaque run UUID. Load-bearing for triage — it is how an SRE ties a wedged pod to its run.",
  },
  {
    name: "PAPERCLIP_TASK_ID",
    classification: "SAFE_LITERAL",
    reason: "Issue UUID the run was woken for; readable by anyone who can read the board.",
  },
  {
    name: "PAPERCLIP_LINKED_ISSUE_IDS",
    classification: "SAFE_LITERAL",
    reason: "Comma-separated issue UUIDs from the approval wake; board identifiers.",
  },

  // --- SAFE_LITERAL: wake context ---------------------------------------
  {
    name: "PAPERCLIP_WAKE_REASON",
    classification: "SAFE_LITERAL",
    reason: "Enum-shaped wake cause (issue_assigned, issue_commented, ...).",
  },
  {
    name: "PAPERCLIP_WAKE_COMMENT_ID",
    classification: "SAFE_LITERAL",
    reason: "Opaque comment UUID.",
  },
  {
    name: "PAPERCLIP_WAKE_PAYLOAD_JSON",
    classification: "SAFE_LITERAL",
    reason:
      "Compact issue summary plus the new-comment batch. Board content, not credential material, and already readable by this pod through its own API token — but it is the one SAFE_LITERAL here whose value is free-form text, so a credential pasted into an issue comment would appear on the pod spec. Accepted: the same text is equally readable via the API, so Secret-backing it would not close that path.",
  },
  {
    name: "PAPERCLIP_APPROVAL_ID",
    classification: "SAFE_LITERAL",
    reason: "Opaque approval UUID.",
  },
  {
    name: "PAPERCLIP_APPROVAL_STATUS",
    classification: "SAFE_LITERAL",
    reason: "Enum-shaped approval outcome.",
  },

  // --- SAFE_LITERAL: workspace wiring -----------------------------------
  {
    name: "PAPERCLIP_WORKSPACE_",
    prefix: true,
    classification: "SAFE_LITERAL",
    reason:
      "Workspace coordinates — cwd, source, strategy, id, repo URL/ref, branch, worktree path. Filesystem paths and a git remote; the remote is authenticated separately by the gh App token, never embedded here. Prefix because the family is set field-by-field from workspace context.",
  },
  {
    name: "PAPERCLIP_WORKSPACES_JSON",
    classification: "SAFE_LITERAL",
    reason: "Serialized list of the same workspace coordinates for multi-workspace projects.",
  },
  {
    name: "AGENT_HOME",
    classification: "SAFE_LITERAL",
    reason: "Filesystem path to the agent's home directory on the mounted PVC.",
  },

  // --- SAFE_LITERAL: runtime services -----------------------------------
  {
    name: "PAPERCLIP_RUNTIME_SERVICES_JSON",
    classification: "SAFE_LITERAL",
    reason: "Managed preview/dev service descriptors: names, ports, in-cluster URLs.",
  },
  {
    name: "PAPERCLIP_RUNTIME_SERVICE_INTENTS_JSON",
    classification: "SAFE_LITERAL",
    reason: "Requested runtime services not yet started; same shape as above.",
  },
  {
    name: "PAPERCLIP_RUNTIME_PRIMARY_URL",
    classification: "SAFE_LITERAL",
    reason: "In-cluster URL of the primary runtime service; an address.",
  },

  // --- SAFE_LITERAL: isolation and home ---------------------------------
  {
    name: "HOME",
    classification: "SAFE_LITERAL",
    reason: "Must be readable off the pod spec — it is the first thing checked when session resume misbehaves.",
  },
  {
    name: "CLAUDE_CONFIG_DIR",
    classification: "SAFE_LITERAL",
    reason: "Path to the run's Claude config dir under the isolation root.",
  },
  {
    name: "XDG_CONFIG_HOME",
    classification: "SAFE_LITERAL",
    reason: "Path to the run's XDG config root.",
  },
  {
    name: "PAPERCLIP_K8S_ISOLATION_MODE",
    classification: "SAFE_LITERAL",
    reason: "Enum: shared | run | workspace. Diagnostic for cross-run state bleed.",
  },

  // --- SAFE_LITERAL: caches and temp ------------------------------------
  {
    name: "XDG_CACHE_HOME",
    classification: "SAFE_LITERAL",
    reason: "Cache path on the runtime-cache volume.",
  },
  {
    name: "GOCACHE",
    classification: "SAFE_LITERAL",
    reason: "Go build cache path.",
  },
  {
    name: "GOMODCACHE",
    classification: "SAFE_LITERAL",
    reason: "Go module cache path.",
  },
  {
    name: "npm_config_cache",
    classification: "SAFE_LITERAL",
    reason: "npm cache path. Lower-cased by npm convention; matching is case-sensitive so this is exact.",
  },
  {
    name: "BUN_INSTALL_CACHE",
    classification: "SAFE_LITERAL",
    reason: "Bun install cache path.",
  },
  {
    name: "PIP_CACHE_DIR",
    classification: "SAFE_LITERAL",
    reason: "pip cache path.",
  },
  {
    name: "PLAYWRIGHT_BROWSERS_PATH",
    classification: "SAFE_LITERAL",
    reason: "Playwright browser download path.",
  },
  {
    name: "TMPDIR",
    classification: "SAFE_LITERAL",
    reason: "Run-scoped temp dir (BLO-16219). Load-bearing for triaging concurrent-run collisions.",
  },
  {
    name: "TMP",
    classification: "SAFE_LITERAL",
    reason: "Same path as TMPDIR, for tools that read TMP.",
  },
  {
    name: "TEMP",
    classification: "SAFE_LITERAL",
    reason: "Same path as TMPDIR, for tools that read TEMP.",
  },

  // --- SAFE_LITERAL: container wiring -----------------------------------
  {
    name: "DOCKER_HOST",
    classification: "SAFE_LITERAL",
    reason: "unix:///var/run/docker.sock — the DinD sidecar socket path. Constant, no credential.",
  },
  {
    name: "DOCKER_TLS_CERTDIR",
    classification: "SAFE_LITERAL",
    reason: "Set empty on the DinD sidecar to disable TLS on the shared emptyDir socket. A constant.",
  },
  {
    name: "PROMPT_CONTENT",
    classification: "SAFE_LITERAL",
    reason:
      "Init-container-only. The prompt the agent is about to run; it is written to an emptyDir and read via stdin. Oversized prompts already move to a Secret-backed volume for size reasons, so this path carries only small prompts. Not credential material by construction — the prompt is board-authored text.",
  },
];

/**
 * Names pinned as always-Secret because they carry credential material while
 * matching none of the patterns above (BLO-21858, from the BLO-21593 review).
 *
 * Derived from ENV_NAME_CLASSIFICATION so the table is the single source of
 * truth: declaring a name SECRET there is what pins it here. Compared
 * upper-cased so it behaves like the case-insensitive regex.
 */
const ALWAYS_SECRET_ENV_NAMES = new Set(
  ENV_NAME_CLASSIFICATION.filter((e) => e.classification === "SECRET" && !e.prefix).map((e) =>
    e.name.toUpperCase(),
  ),
);

export function isSensitiveEnvName(name: string): boolean {
  return ALWAYS_SECRET_ENV_NAMES.has(name.toUpperCase()) || SENSITIVE_ENV_NAME_RE.test(name);
}

/**
 * Look up an env name in ENV_NAME_CLASSIFICATION. Exact matches win over
 * prefix matches. Returns null when the name is undeclared — which is what
 * the classification test in job-manifest.test.ts fails on.
 */
export function classifyEnvName(name: string): EnvClassification | null {
  const exact = ENV_NAME_CLASSIFICATION.find((e) => !e.prefix && e.name === name);
  if (exact) return exact.classification;
  const prefixed = ENV_NAME_CLASSIFICATION.find((e) => e.prefix && name.startsWith(e.name));
  return prefixed ? prefixed.classification : null;
}

/**
 * Defense-in-depth: return the names of any container env entries with a
 * sensitive-looking name that still carry a literal `value`. buildEnvVars()
 * never produces these, but this runs unconditionally in buildJobManifest
 * (after every push onto the env array, including ones added later for
 * sidecar wiring) so a future code path that appends a literal env var
 * can't silently reintroduce the leak — buildJobManifest throws instead of
 * returning a Pod spec that would expose it via `GET Pod`.
 */
export function findLiteralSensitiveEnvVars(env: k8s.V1EnvVar[]): string[] {
  return env
    .filter((e) => e.name && isSensitiveEnvName(e.name) && typeof e.value === "string" && e.value.length > 0)
    .map((e) => e.name);
}

/**
 * Same check as findLiteralSensitiveEnvVars, but driven off the pod spec that
 * was actually assembled rather than off the individual env arrays the caller
 * happens to remember to pass in. Every container that ends up on the pod is
 * covered — main, init, native sidecars (the DinD sidecar is an init container
 * with restartPolicy: Always) and ephemeral — so adding a container can't
 * silently escape the guard the way it could when the check enumerated two
 * hand-maintained local arrays.
 *
 * Returns `container/ENV_NAME` so the failure names the offending container.
 */
export function findLiteralSensitiveEnvVarsInPodSpec(podSpec: k8s.V1PodSpec): string[] {
  const containers: k8s.V1Container[] = [
    ...(podSpec.initContainers ?? []),
    ...(podSpec.containers ?? []),
    ...((podSpec.ephemeralContainers ?? []) as unknown as k8s.V1Container[]),
  ];
  return containers.flatMap((c) =>
    findLiteralSensitiveEnvVars(c.env ?? []).map((name) => `${c.name || "<unnamed>"}/${name}`),
  );
}

/**
 * Defense-in-depth backstop for the inheritance allowlist (BLO-22514).
 *
 * The primary control is in `getSelfPodInfo()`, which filters the server pod's
 * env before it ever reaches this file. This is the second line: it re-checks
 * the *assembled* pod spec for server-only credential names and lets
 * buildJobManifest throw rather than return a manifest that would hand an agent
 * the JWT signing key or the database URL.
 *
 * Worth having as well as the upstream filter for two reasons. The upstream
 * filter guards one function; this guards the artifact, so a future code path
 * that reintroduces a server credential by some route other than
 * `selfPod.inheritedEnv` is still caught. And `SelfPodInfo` is a plain object
 * that tests and callers can construct directly — as `makeSelfPod()` in the
 * test suite does — so the type system alone never guarantees the values in it
 * came through the filter.
 *
 * Unlike `findLiteralSensitiveEnvVars`, this flags an entry whatever its
 * source: a `secretKeyRef` hides the value from `GET Pod` but the kubelet still
 * resolves it into the container's environment, which is the whole point of
 * this issue.
 *
 * Returns `container/ENV_NAME` so the failure names the offending container.
 */
export function findServerOnlyEnvVarsInPodSpec(podSpec: k8s.V1PodSpec): string[] {
  const containers: k8s.V1Container[] = [
    ...(podSpec.initContainers ?? []),
    ...(podSpec.containers ?? []),
    ...((podSpec.ephemeralContainers ?? []) as unknown as k8s.V1Container[]),
  ];
  return containers.flatMap((c) =>
    (c.env ?? [])
      .filter((e) => e.name && SERVER_ONLY_ENV_DENY.has(e.name))
      .map((e) => `${c.name || "<unnamed>"}/${e.name}`),
  );
}

export interface JobBuildResult {
  job: k8s.V1Job;
  jobName: string;
  namespace: string;
  prompt: string;
  claudeArgs: string[];
  promptMetrics: Record<string, number>;
  /** Non-null when the prompt is too large for an env var and must be
   *  staged as a K8s Secret before creating the Job. */
  promptSecret: PromptSecret | null;
  /** Non-null when one or more env vars matched the sensitive-name pattern
   *  and must be staged as a K8s Secret (referenced via secretKeyRef)
   *  before creating the Job. */
  envSecret: EnvSecret | null;
  /** Non-null whenever a merged mcp.json is shipped to the pod — always
   *  Secret-backed, never a literal init-container env var (BLO-17980/BLO-17973). */
  mcpConfigSecret: McpConfigSecret | null;
  /** User-supplied extra labels that were dropped because they used a reserved prefix. */
  skippedLabels: string[];
  /** Path to the pod log file on the shared PVC. */
  podLogPath: string;
  /** Resolved ServiceAccount for the Job's pod template — echoed here so
   *  callers can log/report it without a cluster read (BLO-21812). */
  serviceAccountName: string;
}

function sanitizeForK8sName(value: string, maxLen = 16): string {
  // Trim trailing hyphens after slicing so names don't end with `-` when
  // truncation lands on a hyphen boundary (finding #16, FAR-15).
  return value.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, maxLen).replace(/-+$/, "");
}

/**
 * Sanitize a string for use as a Kubernetes label value (RFC 1123 subset:
 * `[a-zA-Z0-9]([-_.a-zA-Z0-9]*[a-zA-Z0-9])?`, max 63 chars).  Returns `null`
 * when no usable characters remain — the caller should omit the label.
 */
export function sanitizeLabelValue(value: string, maxLen = 63): string | null {
  const cleaned = value.replace(/[^a-zA-Z0-9._-]/g, "").slice(0, maxLen);
  const trimmed = cleaned.replace(/^[^a-zA-Z0-9]+/, "").replace(/[^a-zA-Z0-9]+$/, "");
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Build a short deterministic hash suffix from the raw inputs to avoid
 * collisions when sanitized slugs happen to be identical.
 */
function shortHash(input: string, len = 6): string {
  return createHash("sha256").update(input).digest("hex").slice(0, len);
}

/**
 * "x-penstock-session: agent:<name>" header line for ANTHROPIC_CUSTOM_HEADERS.
 * Name falls back to the agent id; CR/LF stripped (header injection) and
 * length-bounded, mirroring the opencode_k8s adapter's stamp.
 */
function penstockSessionHeaderLine(agent: { id?: string; name?: string | null }): string | null {
  const name = String(agent?.name ?? "").replace(/[\r\n]/g, "").trim();
  const id = String(agent?.id ?? "").replace(/[\r\n]/g, "").trim();
  const label = (name || id).slice(0, 128);
  return label ? `x-penstock-session: agent:${label}` : null;
}

function buildEnvVars(
  ctx: AdapterExecutionContext,
  selfPod: SelfPodInfo,
  config: Record<string, unknown>,
  isolation: JobIsolation,
  envSecretName: string,
): { envVars: k8s.V1EnvVar[]; sensitiveEnvData: Record<string, string> } {
  const { runId, agent, context } = ctx;
  const envConfig = parseObject(config.env);

  // Layer 1: PAPERCLIP_* base vars
  const paperclipEnv = buildPaperclipEnv(agent);

  // Layer 2: Context vars (run, wake, workspace — same as claude_local)
  paperclipEnv.PAPERCLIP_RUN_ID = runId;

  const setIfPresent = (envKey: string, value: unknown) => {
    if (typeof value === "string" && value.trim().length > 0) {
      paperclipEnv[envKey] = value.trim();
    }
  };

  setIfPresent("PAPERCLIP_TASK_ID", context.taskId ?? context.issueId);
  setIfPresent("PAPERCLIP_WAKE_REASON", context.wakeReason);
  setIfPresent("PAPERCLIP_WAKE_COMMENT_ID", context.wakeCommentId ?? context.commentId);
  setIfPresent("PAPERCLIP_APPROVAL_ID", context.approvalId);
  setIfPresent("PAPERCLIP_APPROVAL_STATUS", context.approvalStatus);

  const wakePayloadJson = stringifyPaperclipWakePayload(context.paperclipWake);
  if (wakePayloadJson) {
    paperclipEnv.PAPERCLIP_WAKE_PAYLOAD_JSON = wakePayloadJson;
  }

  const workspaceContext = parseObject(context.paperclipWorkspace);
  setIfPresent("PAPERCLIP_WORKSPACE_CWD", workspaceContext.cwd);
  setIfPresent("PAPERCLIP_WORKSPACE_SOURCE", workspaceContext.source);
  setIfPresent("PAPERCLIP_WORKSPACE_STRATEGY", workspaceContext.strategy);
  setIfPresent("PAPERCLIP_WORKSPACE_ID", workspaceContext.workspaceId);
  setIfPresent("PAPERCLIP_WORKSPACE_REPO_URL", workspaceContext.repoUrl);
  setIfPresent("PAPERCLIP_WORKSPACE_REPO_REF", workspaceContext.repoRef);
  setIfPresent("PAPERCLIP_WORKSPACE_BRANCH", workspaceContext.branchName);
  setIfPresent("PAPERCLIP_WORKSPACE_WORKTREE_PATH", workspaceContext.worktreePath);
  setIfPresent("AGENT_HOME", workspaceContext.agentHome);

  const linkedIssueIds = Array.isArray(context.issueIds)
    ? context.issueIds.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    : [];
  if (linkedIssueIds.length > 0) {
    paperclipEnv.PAPERCLIP_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
  }

  if (Array.isArray(context.paperclipWorkspaces) && context.paperclipWorkspaces.length > 0) {
    paperclipEnv.PAPERCLIP_WORKSPACES_JSON = JSON.stringify(context.paperclipWorkspaces);
  }
  if (Array.isArray(context.paperclipRuntimeServiceIntents) && context.paperclipRuntimeServiceIntents.length > 0) {
    paperclipEnv.PAPERCLIP_RUNTIME_SERVICE_INTENTS_JSON = JSON.stringify(context.paperclipRuntimeServiceIntents);
  }
  if (Array.isArray(context.paperclipRuntimeServices) && context.paperclipRuntimeServices.length > 0) {
    paperclipEnv.PAPERCLIP_RUNTIME_SERVICES_JSON = JSON.stringify(context.paperclipRuntimeServices);
  }
  setIfPresent("PAPERCLIP_RUNTIME_PRIMARY_URL", context.paperclipRuntimePrimaryUrl);

  // Auth token for agent callback to Paperclip API
  if (ctx.authToken) {
    paperclipEnv.PAPERCLIP_API_KEY = ctx.authToken;
  }

  // PAPERCLIP_API_URL is inherited from the Deployment env via selfPod.inheritedEnv.
  // buildPaperclipEnv() sets a localhost value which is wrong for Job pods —
  // the inherited value (set in the infra repo) points to the in-cluster service.
  if (selfPod.inheritedEnv.PAPERCLIP_API_URL) {
    paperclipEnv.PAPERCLIP_API_URL = selfPod.inheritedEnv.PAPERCLIP_API_URL;
  }
  // PAPERCLIP_AGENT_ID and PAPERCLIP_COMPANY_ID come from buildPaperclipEnv.
  // PAPERCLIP_RUN_ID is set above. Together they form the runContext that
  // the bundled paperclip-mcp-server stdio bridge uses to authenticate
  // /plugins/tools/execute calls when an agent invokes a plugin tool via MCP.

  // Layer 3: Inherited from Deployment (Bedrock, API keys, etc.)
  const merged: Record<string, string> = {
    ...selfPod.inheritedEnv,
    ...paperclipEnv,
  };

  // Layer 4: User-defined overrides from adapterConfig.env (wins over everything)
  const userEnvKeys = new Set(Object.keys(envConfig));
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") merged[key] = value;
  }

  // Per-agent Penstock session identity (org_penstock #accounts attribution).
  // Every agent Job shares the one org API key, so without a per-agent
  // client-session header the whole fleet melts into a single UNTAGGED bucket
  // on the consumption dashboard. Claude Code forwards ANTHROPIC_CUSTOM_HEADERS
  // ("Name: value" lines) on every API request, and Penstock's client-session
  // extraction gives x-penstock-session top precedence. Merged AFTER the user
  // env layer and skipped when an x-penstock-session line is already present,
  // so a manual override always wins (same semantics as the host's
  // claude_local X-Anthropic-Agent-Id stamp).
  const sessionHeaderLine = penstockSessionHeaderLine(agent);
  if (sessionHeaderLine) {
    const existingHeaders =
      typeof merged.ANTHROPIC_CUSTOM_HEADERS === "string" ? merged.ANTHROPIC_CUSTOM_HEADERS : "";
    if (!/(^|\n)\s*x-penstock-session\s*:/i.test(existingHeaders)) {
      merged.ANTHROPIC_CUSTOM_HEADERS = existingHeaders
        ? `${existingHeaders}\n${sessionHeaderLine}`
        : sessionHeaderLine;
    }
  }

  // HOME must live on the mounted data PVC to enable session resume. Isolated
  // mode scopes Claude config/cache/session state away from shared /paperclip.
  merged.HOME = isolation.enabled ? isolation.homeRoot : "/paperclip";
  if (isolation.enabled) {
    merged.CLAUDE_CONFIG_DIR = `${isolation.sessionRoot}/.claude`;
    merged.XDG_CONFIG_HOME = `${isolation.sessionRoot}/.config`;
    merged.PAPERCLIP_K8S_ISOLATION_KEY = isolation.key;
    merged.PAPERCLIP_K8S_ISOLATION_MODE = isolation.mode;
    merged.PAPERCLIP_WORKSPACE_CWD = isolation.workspaceRoot;
  }
  const cacheEnv = isolation.enabled
    ? {
        XDG_CACHE_HOME: `${isolation.cacheRoot}/xdg`,
        GOCACHE: `${isolation.cacheRoot}/go-build`,
        GOMODCACHE: `${isolation.cacheRoot}/gomod`,
        npm_config_cache: `${isolation.cacheRoot}/npm`,
        BUN_INSTALL_CACHE: `${isolation.cacheRoot}/bun`,
        PIP_CACHE_DIR: `${isolation.cacheRoot}/pip`,
        PLAYWRIGHT_BROWSERS_PATH: `${isolation.cacheRoot}/ms-playwright`,
        // Run-scoped so concurrent stateless Jobs never share a writable temp
        // directory (BLO-16219) — previously unset here, defaulting to the
        // image's shared /tmp and colliding across concurrent runs.
        TMPDIR: isolation.tmpRoot,
        TMP: isolation.tmpRoot,
        TEMP: isolation.tmpRoot,
      }
    : RUNTIME_CACHE_ENV;
  for (const [key, value] of Object.entries(cacheEnv)) {
    if (!userEnvKeys.has(key)) merged[key] = value;
  }

  // Convert literal env to V1EnvVar array. Names matching the sensitive
  // pattern (isSensitiveEnvName) are routed to a Secret referenced via
  // secretKeyRef instead of an inline literal `value`, so a read-only
  // `GET Pod` on the Job never returns their contents (BLO-17980/BLO-17973).
  const sensitiveEnvData: Record<string, string> = {};
  const envVars: k8s.V1EnvVar[] = [];
  for (const [name, value] of Object.entries(merged)) {
    if (isSensitiveEnvName(name) && value) {
      sensitiveEnvData[name] = value;
      envVars.push({ name, valueFrom: { secretKeyRef: { name: envSecretName, key: name } } });
    } else {
      envVars.push({ name, value });
    }
  }

  // Append valueFrom entries from the Deployment container (secretKeyRef,
  // configMapKeyRef, fieldRef, etc.).  Skip any whose name was already set
  // by a literal value — the literal value wins (same precedence as above).
  const literalNames = new Set(Object.keys(merged));
  for (const entry of selfPod.inheritedEnvValueFrom) {
    if (!literalNames.has(entry.name)) {
      envVars.push(entry);
    }
  }

  return { envVars, sensitiveEnvData };
}

/**
 * docker:dind sidecar exposing /var/run/docker.sock to the agent container
 * via a shared emptyDir. Deployed as a native Kubernetes 1.29+ sidecar
 * (initContainer with restartPolicy: "Always"): starts before the main
 * container, lives for the duration of the Job, terminates when main exits.
 *
 * Privileged because dockerd needs cgroups + devices. The cluster does not
 * enforce PodSecurityStandards (see the k8s repo's
 * feedback_pss_enforcement.md), so a privileged Pod is acceptable for
 * opt-in agent toolchain use.
 *
 * DOCKER_TLS_CERTDIR="" disables dockerd's auto-TLS bootstrap — traffic
 * stays on the unix socket inside the pod network namespace, no TCP
 * exposure, no TLS handshakes adding to startup time.
 */
function buildDindSidecar(opts: {
  image: string;
  cpuLimit: string;
  memoryLimit: string;
}): k8s.V1Container {
  // restartPolicy: "Always" on an init container is the native sidecar
  // pattern (k8s 1.29 GA, 1.28 beta). The @kubernetes/client-node
  // V1Container type predates this addition, so we declare an intersection
  // type that adds the field instead of any-casting the whole container.
  type SidecarContainer = k8s.V1Container & { restartPolicy?: string };
  const sidecar: SidecarContainer = {
    name: "dind",
    image: opts.image,
    imagePullPolicy: "IfNotPresent",
    // `--group=1000` makes dockerd create /var/run/docker.sock with group 1000
    // (mode 0660 root:1000). The main agent container runs as uid 1000 with
    // the pod's primary runAsGroup=1000, so without this it can't connect to
    // the socket (dockerd otherwise creates it root:root mode 0660). BLO-5492.
    args: ["dockerd", "--host=unix:///var/run/docker.sock", "--storage-driver=overlay2", "--group=1000"],
    securityContext: { privileged: true, runAsUser: 0, runAsNonRoot: false },
    env: [{ name: "DOCKER_TLS_CERTDIR", value: "" }],
    resources: {
      requests: { cpu: "100m", memory: "256Mi" },
      limits: { cpu: opts.cpuLimit, memory: opts.memoryLimit },
    },
    volumeMounts: [
      { name: "docker-graph", mountPath: "/var/lib/docker" },
      { name: "docker-sock", mountPath: "/var/run" },
    ],
    restartPolicy: "Always",
  };
  return sidecar;
}

/**
 * Shell snippet the main container prepends to its command when the DinD
 * sidecar is enabled. Polls for /var/run/docker.sock to appear (sidecar
 * dockerd needs ~5–15 s to come up) and bails out if it never does, so
 * agent runs never silently proceed without docker available.
 */
const DIND_WAIT_PREAMBLE =
  `i=0; while [ ! -S /var/run/docker.sock ] && [ $i -lt 60 ]; do sleep 0.5; i=$((i+1)); done; ` +
  `if [ ! -S /var/run/docker.sock ]; then echo "dind sidecar socket /var/run/docker.sock never appeared after 30s" >&2; exit 1; fi`;

/**
 * Resolve the ServiceAccount a Job pod runs as. An unset per-agent
 * `serviceAccountName` used to be silently admitted as the namespace's bare
 * `default` ServiceAccount — an identity with no cluster-scoped read. That
 * silent fallback cost a full misdiagnosed incident (BLO-21499) before the
 * cause was traced to identity rather than RBAC drift. Binding cluster read
 * to `default` itself was rejected there: `default` is the ambient identity
 * every unconfigured pod in the namespace receives, including ad-hoc preview
 * workloads, so granting it read would be a fail-open grant to all of them.
 *
 * Resolution order: per-agent config, then an explicit fleet-wide default
 * (PAPERCLIP_DEFAULT_SERVICE_ACCOUNT_NAME set on the adapter Deployment, an
 * opt-in ops action — mirrors PAPERCLIP_NAMESPACE's role in
 * `readInClusterNamespace()`). If neither resolves, refuse to build the Job
 * manifest so misprovisioning surfaces at launch as a named, actionable
 * error instead of a scattered `Forbidden` days later.
 */
export function resolveServiceAccountName(config: Record<string, unknown>): string {
  const perAgent = asString(config.serviceAccountName, "").trim();
  if (perAgent) return perAgent;
  const fleetDefault = (process.env.PAPERCLIP_DEFAULT_SERVICE_ACCOUNT_NAME ?? "").trim();
  if (fleetDefault) return fleetDefault;
  throw new Error(
    'claude_k8s: no serviceAccountName resolved for this agent\'s Job pods. Set the agent\'s "Service Account" config field (serviceAccountName), or set PAPERCLIP_DEFAULT_SERVICE_ACCOUNT_NAME on the paperclip Deployment for a fleet-wide default. Refusing to fall back to the namespace\'s `default` ServiceAccount, which has no cluster-scoped read (BLO-21812).',
  );
}

export function buildJobManifest(input: JobBuildInput): JobBuildResult {
  const { ctx, selfPod, promptBundle } = input;
  const { runId, agent, runtime, config: rawConfig, context } = ctx;
  const config = parseObject(rawConfig);

  // Resolve config values
  const namespace = asString(config.namespace, "") || selfPod.namespace;
  const serviceAccountName = resolveServiceAccountName(config);
  const image = asString(config.image, "") || selfPod.image;
  const enableDocker = asBoolean(config.enableDocker, false);
  const dockerImage = asString(config.dockerImage, "docker:28-dind");
  const dockerCpuLimit = asString(config.dockerCpuLimit, "4");
  const dockerMemoryLimit = asString(config.dockerMemoryLimit, "8Gi");
  const model = asString(config.model, "");
  const effort = asString(config.effort, "");
  const maxTurns = asNumber(config.maxTurnsPerRun, 0);
  // K8s Job pods are always unattended — no one to approve permission prompts
  const dangerouslySkipPermissions = asBoolean(config.dangerouslySkipPermissions, true);
  const extraArgs = asStringArray(config.extraArgs);
  const timeoutSec = asNumber(config.timeoutSec, 0);
  const ttlSeconds = asNumber(config.ttlSecondsAfterFinished, 300);
  const hasConfigKey = (key: string) => Object.prototype.hasOwnProperty.call(config, key);
  const configuredNodeSelector = parseKeyValueConfig(config.nodeSelector);
  const nodeSelector = hasConfigKey("nodeSelector") ? configuredNodeSelector : selfPod.nodeSelector;
  const configuredTolerations = Array.isArray(config.tolerations) ? config.tolerations : [];
  const tolerations = hasConfigKey("tolerations") ? configuredTolerations : selfPod.tolerations;
  const extraLabels = parseKeyValueConfig(config.labels);
  const isolation = resolveJobIsolation(ctx, config);

  // Resolve working directory — use workspace cwd, fall back to /paperclip
  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const configuredCwd = asString(config.cwd, "");
  const workingDir = isolation.enabled ? isolation.workspaceRoot : workspaceCwd || configuredCwd || "/paperclip";
  const containerWorkingDir =
    isolation.mode === "run" && workspaceCwd && workspaceCwd !== isolation.workspaceRoot
      ? isolation.root || path.posix.dirname(isolation.workspaceRoot) || "/paperclip"
      : workingDir;

  // Build a deterministic, collision-resistant job name within the 63-char
  // DNS label limit.  Layout: "ac-{agentSlug}-{runSlug}-{hash}" where the
  // hash is derived from the raw (un-truncated) agent+run IDs.
  const agentSlug = sanitizeForK8sName(agent.id, 16);
  const runSlug = sanitizeForK8sName(runId, 16);
  const hash = shortHash(`${agent.id}:${runId}`);
  const jobName = `ac-${agentSlug}-${runSlug}-${hash}`;

  // Build prompt (same logic as claude_local)
  const promptTemplate = asString(
    config.promptTemplate,
    "You are agent {{agent.id}} ({{agent.name}}). Continue your Paperclip work.",
  );
  const bootstrapPromptTemplate = asString(config.bootstrapPromptTemplate, "");
  const runtimeSessionParams = parseObject(runtime.sessionParams);
  const runtimeSessionId = asString(runtimeSessionParams.sessionId, runtime.sessionId ?? "");
  const runtimeSessionModel = asString(runtimeSessionParams.model, "");
  const claudeResumeSessionId = resolveResumableClaudeSessionId({
    requestedSessionId: runtimeSessionId,
    requestedModel: model,
    sessionModel: runtimeSessionModel,
    workingDir,
    config,
    selfPod,
    claudeConfigDir: isolation.enabled ? `${isolation.sessionRoot}/.claude` : null,
  });
  const templateData = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  };
  const renderedBootstrapPrompt =
    !claudeResumeSessionId && bootstrapPromptTemplate.trim().length > 0
      ? renderTemplate(bootstrapPromptTemplate, templateData).trim()
      : "";
  const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, { resumedSession: Boolean(claudeResumeSessionId) });
  // Server's heartbeat composes `context.paperclipTaskMarkdown` for wakes
  // that carry first-class task context (PR-review wakes, issue wakes,
  // wake-comment wakes). renderPaperclipWakePrompt only covers the
  // issue/comment path via paperclipWake, so without this slot a
  // github_pr_* wake reaches the pod with NO PR number / repo in the
  // prompt and the reviewer agent has nothing to act on.
  const taskMarkdown = asString(context.paperclipTaskMarkdown, "").trim();
  const shouldUseResumeDeltaPrompt = Boolean(claudeResumeSessionId) && wakePrompt.length > 0;
  const renderedPrompt = shouldUseResumeDeltaPrompt ? "" : renderTemplate(promptTemplate, templateData);
  const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
  const prompt = joinPromptSections([
    renderedBootstrapPrompt,
    wakePrompt,
    taskMarkdown,
    sessionHandoffNote,
    renderedPrompt,
  ]);
  const promptMetrics = {
    promptChars: prompt.length,
    bootstrapPromptChars: renderedBootstrapPrompt.length,
    wakePromptChars: wakePrompt.length,
    taskMarkdownChars: taskMarkdown.length,
    sessionHandoffChars: sessionHandoffNote.length,
    heartbeatPromptChars: renderedPrompt.length,
  };

  // Per-agent MCP layering — adapterConfig.mcpServers is a map of
  // server-name → MCP server spec ({command, args, env, ...} for stdio
  // or {type: "http"|"sse", url} for transport-typed entries).
  // Always merge with the shared baseline at /paperclip/.mcp.json
  // (paperclip + prometheus + tempo + kubernetes-readonly + github,
  // written by the helm chart's seed-init) and ship the result with
  // claude --mcp-config + --strict-mcp-config so the agent gets exactly
  // the merged set with no surprise reads from disk.
  // Spread semantics: per-agent entries override baseline by name; new
  // entries are added. To swap kubernetes-readonly for ns-rw or admin,
  // override the "kubernetes" key. To add figma, set a new "figma" key.
  const perAgentMcpServers = parseObject(config.mcpServers);
  const baselineMcpServers = loadSharedMcpBaseline();
  const mergedMcpServers = { ...baselineMcpServers, ...perAgentMcpServers };
  let mergedMcpJson: string | null = null;
  if (Object.keys(mergedMcpServers).length > 0) {
    mergedMcpJson = JSON.stringify({ mcpServers: mergedMcpServers });
  }

  // Build Claude CLI args
  // Prefer the bundle's materialized instructions file over the raw config path.
  // Never inject --append-system-prompt-file on session resumes — the instructions
  // are already in the session cache and re-injecting wastes tokens.
  const rawInstructionsFilePath = asString(config.instructionsFilePath, "").trim();
  const effectiveInstructionsFilePath =
    promptBundle?.instructionsFilePath ?? (rawInstructionsFilePath || null);
  const claudeArgs = ["--print", "-", "--output-format", "stream-json", "--verbose"];
  if (claudeResumeSessionId) claudeArgs.push("--resume", claudeResumeSessionId);
  if (dangerouslySkipPermissions) claudeArgs.push("--dangerously-skip-permissions");
  if (model) claudeArgs.push("--model", model);
  if (effort) claudeArgs.push("--effort", effort);
  if (maxTurns > 0) claudeArgs.push("--max-turns", String(maxTurns));
  if (effectiveInstructionsFilePath && !claudeResumeSessionId) {
    claudeArgs.push("--append-system-prompt-file", effectiveInstructionsFilePath);
  }
  if (promptBundle) claudeArgs.push("--add-dir", promptBundle.addDir);
  if (mergedMcpJson) {
    // --strict-mcp-config makes claude ignore the project-scope file at
    // workingDir/.mcp.json and use ONLY the file we materialize below.
    // Without it, claude would still read /paperclip/.mcp.json and merge
    // it on top of ours — losing per-agent overrides like kubernetes
    // ns-rw replacing readonly, since the project-scope file would win.
    claudeArgs.push("--mcp-config", "/tmp/prompt/mcp.json", "--strict-mcp-config");
  }
  if (extraArgs.length > 0) claudeArgs.push(...extraArgs);

  // Build env vars. envSecretName is computed from jobName (already resolved
  // above) so sensitive-named vars can be wired to secretKeyRef in one pass.
  const envSecretName = `${jobName}-env`;
  const { envVars, sensitiveEnvData } = buildEnvVars(ctx, selfPod, config, isolation, envSecretName);
  const envSecret: EnvSecret | null =
    Object.keys(sensitiveEnvData).length > 0 ? { name: envSecretName, namespace, data: sensitiveEnvData } : null;

  // Resource defaults — UI stores dotted keys (e.g. "resources.requests.cpu")
  // as flat config entries, so read them directly from config with the dotted key.
  const containerResources: k8s.V1ResourceRequirements = {
    requests: {
      cpu: asString(config["resources.requests.cpu"], "1000m"),
      memory: asString(config["resources.requests.memory"], "2Gi"),
    },
    limits: {
      cpu: asString(config["resources.limits.cpu"], "4000m"),
      memory: asString(config["resources.limits.memory"], "8Gi"),
    },
  };

  // Labels — system identifiers must pass RFC 1123 label value format.
  const sanitizedAgentId = sanitizeLabelValue(agent.id);
  const sanitizedRunId = sanitizeLabelValue(runId);
  const sanitizedCompanyId = sanitizeLabelValue(agent.companyId);
  const skippedLabels: string[] = [];
  if (!sanitizedRunId) skippedLabels.push("paperclip.io/run-id");
  if (!sanitizedCompanyId) skippedLabels.push("paperclip.io/company-id");
  const labels: Record<string, string> = {
    "app.kubernetes.io/managed-by": "paperclip",
    "app.kubernetes.io/component": "agent-job",
    // sanitizedAgentId null-check is enforced in execute.ts before Job creation
    "paperclip.io/agent-id": sanitizedAgentId ?? agent.id,
    "paperclip.io/adapter-type": "claude_k8s",
  };
  if (sanitizedRunId) labels["paperclip.io/run-id"] = sanitizedRunId;
  if (sanitizedCompanyId) labels["paperclip.io/company-id"] = sanitizedCompanyId;
  // Reattach-target labels: let a future execute() identify this Job as the
  // continuation of the same logical unit of work (same task + same resume
  // session) so it can attach to the running pod across a Paperclip restart
  // instead of deleting it and starting over (FAR-124).
  const taskIdRaw = asString(context.taskId, "") || asString(context.issueId, "");
  const taskLabel = taskIdRaw ? sanitizeLabelValue(taskIdRaw) : null;
  if (taskLabel) labels["paperclip.io/task-id"] = taskLabel;
  const sessionLabel = runtimeSessionId ? sanitizeLabelValue(runtimeSessionId) : null;
  if (sessionLabel) labels["paperclip.io/session-id"] = sessionLabel;
  if (isolation.enabled || isolation.source === "runtime") {
    labels["paperclip.io/isolation-mode"] = isolation.mode;
    labels["paperclip.io/isolation-key"] = isolation.key;
  }
  for (const [key, value] of Object.entries(extraLabels)) {
    if (key.startsWith("paperclip.io/") || key.startsWith("app.kubernetes.io/")) {
      skippedLabels.push(key);
    } else {
      labels[key] = value;
    }
  }

  // Volumes
  const volumes: k8s.V1Volume[] = [
    {
      name: "prompt",
      emptyDir: {},
    },
    {
      name: RUNTIME_CACHE_VOLUME_NAME,
      emptyDir: { sizeLimit: RUNTIME_CACHE_SIZE_LIMIT },
    },
  ];
  const volumeMounts: k8s.V1VolumeMount[] = [
    {
      name: "prompt",
      mountPath: "/tmp/prompt",
    },
    {
      name: RUNTIME_CACHE_VOLUME_NAME,
      mountPath: RUNTIME_CACHE_MOUNT_PATH,
    },
  ];

  // Mount shared PVC for /paperclip (session state, workspaces, data).
  //
  // Phase E.1 — when paperclip's k8s execution target supplies
  // `workspaceVolumeClaim` / `workspaceMountPath`, those win over the
  // adapter defaults derived from selfPod.  When unset, retain the
  // selfPod-derived PVC and the conventional /paperclip mount path.
  // `effectiveConfig` (built in execute.ts) lands these env-supplied
  // values into `config.workspaceVolumeClaim` / `config.workspaceMountPath`.
  const envWorkspaceClaim = asString(config.workspaceVolumeClaim, "").trim();
  const envWorkspaceMountPath = asString(config.workspaceMountPath, "").trim();
  const dataClaimName = envWorkspaceClaim || selfPod.pvcClaimName || "";
  const dataMountPath = envWorkspaceMountPath || "/paperclip";
  if (envWorkspaceMountPath) assertSafeAbsolutePath("config.workspaceMountPath", envWorkspaceMountPath);
  // Kubernetes rejects a Pod outright when one container declares two
  // volumeMounts at the same `mountPath`, so an operator-supplied
  // `workspaceMountPath` that happens to equal a path this builder already
  // emits (`/tmp/prompt`, `/runtime-cache`, or an inherited secret mount) does
  // not "win" — it produces a manifest that never admits, and the operator sees
  // an opaque API rejection rather than the config mistake that caused it.
  // `assertSafeAbsolutePath` above does not catch this: it validates the shape
  // of the path, not whether the path is already taken.
  //
  // Fail closed at construction with a message that names the conflict. Only
  // EXACT duplicates are a conflict — nesting (`/paperclip` alongside
  // `/paperclip/cache`) is legal and stays allowed.
  const normalizeMountPath = (value: string): string =>
    value.length > 1 ? value.replace(/\/+$/, "") : value;
  const claimedMountPaths = new Map<string, string>();
  for (const mount of volumeMounts) {
    claimedMountPaths.set(normalizeMountPath(mount.mountPath), mount.name);
  }
  const normalizedDataMountPath = normalizeMountPath(dataMountPath);
  const reservedCollision = claimedMountPaths.get(normalizedDataMountPath);
  if (reservedCollision) {
    throw new Error(
      `config.workspaceMountPath must not collide with the reserved "${reservedCollision}" mount at ${normalizedDataMountPath}`,
    );
  }
  claimedMountPaths.set(normalizedDataMountPath, "data");
  // The `data` volume is ALWAYS declared — PVC-backed when a claim is
  // configured, `emptyDir` otherwise.
  //
  // It was previously declared only alongside a claim, which forced every
  // consumer to mirror that condition on its mount. Two failure modes came out
  // of that, at different stages: an unconditional mount emitted a Pod that
  // Kubernetes rejects outright (a volumeMount naming an undeclared volume is
  // an admission error for the *whole* Pod), and the conditional mount that
  // replaced it merely moved the failure later — the init container still runs
  // `mkdir -p ${dataMountPath}/instances/...` unconditionally as runAsUser:1000,
  // which is EACCES on the image's read-only root when nothing is mounted there.
  // So no-PVC could not start either way.
  //
  // Declaring the volume unconditionally removes the condition instead of
  // duplicating it: mounts are unconditional again (so the two lists cannot
  // drift), the Pod always passes admission, and the mount point is always
  // writable. Without a claim the state is ephemeral and dies with the pod,
  // which is the honest semantic for "no persistent claim configured" — and is
  // strictly better than rejecting the configuration, since a run that keeps no
  // persistent state still completes.
  volumes.push(
    dataClaimName
      ? { name: "data", persistentVolumeClaim: { claimName: dataClaimName } }
      : { name: "data", emptyDir: {} },
  );
  volumeMounts.push({
    name: "data",
    mountPath: dataMountPath,
  });

  // Mount secret volumes inherited from the Deployment pod
  //
  // These are platform state, not operator config: the running Deployment is
  // already using them, so a collision here must not wedge every run. An
  // inherited mount that duplicates a path already claimed above is therefore
  // SKIPPED rather than thrown on — except when it collides with the
  // operator-chosen workspace mount, which is a config mistake the operator can
  // actually fix and so is surfaced instead of silently dropping a secret.
  for (const sv of selfPod.secretVolumes) {
    const normalized = normalizeMountPath(sv.mountPath);
    if (normalized === normalizedDataMountPath) {
      throw new Error(
        `config.workspaceMountPath must not collide with inherited secret mount "${sv.volumeName}" at ${normalized}`,
      );
    }
    if (claimedMountPaths.has(normalized)) continue;
    claimedMountPaths.set(normalized, sv.volumeName);
    volumes.push({
      name: sv.volumeName,
      secret: {
        secretName: sv.secretName,
        defaultMode: sv.defaultMode,
        // Carry the source's key selector through. Without this, a source mount
        // that projects one key out of a multi-key Secret is re-expanded here
        // into every key of that Secret, so the agent pod ends up holding more
        // key material than the container the mount was copied from.
        ...(sv.items ? { items: sv.items } : {}),
        // Deliberately always optional, regardless of the source's setting: a
        // propagated Secret that is absent must not hard-fail the agent Job.
        optional: true,
      },
    });
    volumeMounts.push({
      name: sv.volumeName,
      mountPath: sv.mountPath,
      readOnly: true,
    });
  }

  // Security context matching the main Deployment
  const securityContext: k8s.V1SecurityContext = {
    capabilities: { drop: ["ALL"] },
    readOnlyRootFilesystem: false,
    runAsNonRoot: true,
    runAsUser: 1000,
    allowPrivilegeEscalation: false,
  };

  const podSecurityContext: k8s.V1PodSecurityContext = {
    runAsNonRoot: true,
    runAsUser: 1000,
    runAsGroup: 1000,
  };

  // Build the claude command string for the main container
  const claudeArgsEscaped = claudeArgs.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
  const logPathCompanyId = sanitizeForK8sPath(agent.companyId);
  const logPathAgentId = sanitizeForK8sPath(agent.id);
  const logPathRunId = sanitizeForK8sPath(runId);
  assertSafePathComponent("companyId", logPathCompanyId);
  assertSafePathComponent("agentId", logPathAgentId);
  assertSafePathComponent("runId", logPathRunId);
  const podLogPath = buildPodLogPath(logPathCompanyId, logPathAgentId, logPathRunId, isolation.enabled ? isolation.key : undefined);
  // Refresh OAuth credentials via ccrotate before invoking claude. The shared
  // /paperclip/.claude/.credentials.json on the RWX PVC may contain an expired
  // access token (claude OAuth tokens last ~30-60 min and the paperclip pod
  // doesn't refresh them automatically — that's ccrotate's job). Without this,
  // claude in the Job pod fails with `401 Invalid authentication credentials`
  // whenever the cached token is older than its expiresAt.
  //
  // Just `next --yes` — no pre-snap. Claude-code's installed Stop hook
  // already snaps the active account's just-refreshed tokens at session
  // end, so the previous Job's exit handles the normal save path. Doing
  // an extra `snap --force` here under multiple-concurrent-Jobs raced
  // with another Job's `next` mid-write of the active config files
  // (ccrotate.js writeClaudeFiles writes credentials and config in two
  // steps); a pre-snap reading partial state then committed mismatched
  // creds into a profile labeled with the previous account's email,
  // clobbering tokens across unrelated profiles. Edge case lost: if a
  // prior agent crashed without firing its Stop hook, its just-refreshed
  // access token isn't saved — recoverable on the next switchTo via the
  // refresh-token, costing one extra OAuth refresh.
  // `--yes` is still required because Job pods have no stdin, so without
  // it ccrotate prompts and hangs/exits when all accounts are at extra
  // usage. Failure is non-fatal: if ccrotate isn't on PATH or all
  // accounts are exhausted, we still try claude with whatever
  // credentials are on disk so the operator gets a meaningful
  // 401-from-claude instead of an opaque init failure.
  // When the environment driver supplies a per-env Anthropic account pool
  // (effectiveConfig.providers.anthropic.accounts, plumbed through
  // mergeEnvironmentConfig from executionTarget.config), constrain ccrotate's
  // rotation to just that pool via `--accounts a@b.net,c@d.net`. An absent pool
  // → the appended segment is the empty string and the command stays
  // bit-for-bit identical to the global-rotation behavior.
  //
  // The pool is operator-supplied config, and it lands in a string that the main
  // container runs through `sh -c`. Interpolating it raw made it a command
  // injection point: an account of `a@example.test; env; #` executes `env`
  // *before* Claude starts, so it runs ahead of the PreToolUse env-guard and
  // dumps the pod's inherited credentials into the log. Two independent
  // defences, since either alone is one typo from being bypassed:
  //   1. validate — an account identifier is an email/handle, so anything
  //      outside this conservative set cannot be a real account and is dropped
  //      rather than passed on;
  //   2. single-quote the whole `--accounts` value, which is what actually
  //      guarantees the shell treats it as one literal word.
  //
  // Absent configuration and invalid configuration are deliberately NOT the same
  // thing. Dropping invalid entries and emitting no `--accounts` segment looks
  // fail-safe but is fail-*open*: an operator who scoped this environment to a
  // specific pool would silently get ccrotate's documented *global* rotation
  // instead, consuming credentials from outside the pool they asked for —
  // widening credential scope on a config typo. So:
  //   - no `accounts` key at all      → global rotation (the documented default)
  //   - a configured pool, some valid → use the valid entries
  //   - a configured pool, none valid → skip rotation entirely, and say so
  //
  // PRESENCE IS TESTED SEPARATELY FROM VALIDITY, and that distinction is the
  // whole fix. Collapsing "malformed" into "absent" with a single
  // `Array.isArray(...) ? ... : null` reintroduced exactly the fail-open this
  // block exists to prevent: `accounts: "a@example.test"` (a bare string rather
  // than a list — the likeliest possible typo) is not an array, became `null`,
  // read as "no pool configured", and selected unrestricted global rotation.
  // `parseObject` returns `{}` for any non-object, so `providers.anthropic`
  // itself has the same failure mode one level up and is checked the same way.
  //
  // An explicitly empty pool (`accounts: []`) is also treated as configured but
  // unusable. It is a deliberate statement that no account is eligible, so
  // widening it to every account on the box is the same fail-open in miniature.
  //
  // Diagnostics report the offending TYPE only, never the value: this config is
  // adjacent to credential material and the message lands in the pod log.
  const quoteShellArg = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
  const ACCOUNT_ID_RE = /^[A-Za-z0-9._%+-]+(?:@[A-Za-z0-9.-]+)?$/;
  const isConfigured = (value: unknown): boolean => value !== undefined && value !== null;
  const isPlainObject = (value: unknown): boolean =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  const describeType = (value: unknown): string => (Array.isArray(value) ? "array" : typeof value);

  const providersConfig = parseObject(config.providers);
  const rawAnthropic = providersConfig.anthropic;
  const anthropicConfig = parseObject(rawAnthropic);
  const rawAnthropicAccounts = anthropicConfig.accounts;

  // A configured value that this builder cannot interpret. Fail closed.
  const malformedPoolReason = !isConfigured(rawAnthropic)
    ? null
    : !isPlainObject(rawAnthropic)
      ? `providers.anthropic must be an object, got ${describeType(rawAnthropic)}`
      : !isConfigured(rawAnthropicAccounts)
        ? null
        : !Array.isArray(rawAnthropicAccounts)
          ? `providers.anthropic.accounts must be an array, got ${describeType(rawAnthropicAccounts)}`
          : null;

  const configuredAccounts: ReadonlyArray<unknown> = Array.isArray(rawAnthropicAccounts)
    ? rawAnthropicAccounts
    : [];
  const anthropicAccounts = configuredAccounts.filter(
    (s): s is string => typeof s === "string" && s.length > 0 && ACCOUNT_ID_RE.test(s),
  );
  // A pool was configured but nothing in it is usable — malformed shape, an
  // explicitly empty list, or entries that all failed validation.
  const accountPoolConfiguredButUnusable =
    malformedPoolReason !== null ||
    (Array.isArray(rawAnthropicAccounts) && anthropicAccounts.length === 0);
  const unusablePoolReason =
    malformedPoolReason ??
    (configuredAccounts.length === 0
      ? "providers.anthropic.accounts is an empty list, so no account is eligible"
      : "no entry in providers.anthropic.accounts is a valid account identifier");
  const accountsArg =
    anthropicAccounts.length > 0 ? ` --accounts ${quoteShellArg(anthropicAccounts.join(","))}` : "";
  const ccrotateRefresh = accountPoolConfiguredButUnusable
    ? `echo "[paperclip] ${unusablePoolReason}; skipping ccrotate rather than falling back to global rotation" >&2`
    : `(command -v ccrotate >/dev/null 2>&1 && ccrotate next --yes --target claude${accountsArg} >/dev/null 2>&1) || true`;
  // RCA 2026-05-06: terminal rate-limit fail-fast. Before this, a
  // `rate_limit_event` with `overageStatus:"rejected"` +
  // `overageDisabledReason:"out_of_credits"` was not a terminal signal to
  // claude — the CLI keeps the session open and the wrapper sat there
  // indefinitely (one observed pod hung 20h on this exact event). Watch
  // the stream for that combination and exit non-zero; SIGPIPE then
  // unwinds the upstream claude process and pipefail surfaces the
  // failure. The harness recovery path will retry on a fresh account
  // when quotas reset, instead of letting a wedged pod consume a slot.
  //
  // awk runs after `tee`, so the rate_limit_event line is already
  // persisted to the pod log before we exit. `fflush()` keeps the awk
  // pipeline line-buffered (default `gawk`/`mawk` would buffer otherwise
  // and stream-json events would batch to ~4 KiB before flushing).
  const failFastFilter =
    `awk '{ print; fflush() } /\"overageStatus\":\"rejected\"/ && /\"overageDisabledReason\":\"out_of_credits\"/ { print \"[wrapper] terminal rate-limit: out_of_credits overage rejected; exiting non-zero so harness can retry on quota reset\" > \"/dev/stderr\"; exit 1 }'`;
  // `set -o pipefail` so a claude binary crash (OOM, segfault, missing-bin)
  // OR the fail-fast awk surfaces as a non-zero shell exit code instead
  // of being masked by the trailing `cat`'s exit code. Without pipefail
  // the pod marks Succeeded even when claude never emits any stream-json
  // — paperclip-server's parser only catches type:error events from
  // inside the JSON stream, not pre-stream crashes.
  // BLO-31359: `git clone` points the new clone's `origin` at whatever it was
  // cloned from, so cloning the project base checkout hands every ephemeral run
  // a remote that writes back into shared, long-lived state on the PVC. Git only
  // refuses a push to the base's *currently checked out* branch; any other
  // refname lands, which is how base checkouts accumulate agent-authored
  // `blo-*` branches. Keep the clone — cloning from local disk with `--shared`
  // is what makes provisioning cheap — but repoint `origin` at the real
  // upstream so a push leaves the cluster instead of mutating the base.
  //
  // Remove-then-add rather than `set-url`: `git remote remove` drops the whole
  // `remote.origin` section, so the re-added remote cannot inherit a stale
  // `pushurl` still aimed at the base.
  //
  // `remote remove` also deletes every `refs/remotes/origin/*`, so the clone is
  // briefly left with no remote-tracking refs and `origin/<branch>` is an
  // unknown revision. That is deliberate, not collateral: those refs described
  // the *base's* local branches while being named as though they described
  // upstream, and a lying ref is worse than a missing one. The best-effort
  // fetch below repopulates `refs/remotes/origin/<branch>` from the real
  // upstream, which is the first time `origin/master` in a run workspace has
  // actually meant upstream.
  //
  // `fetch` restores branches but NOT `refs/remotes/origin/HEAD` (a symbolic
  // ref that a plain clone does carry, and that tooling reads via
  // `git symbolic-ref refs/remotes/origin/HEAD` to find the default branch),
  // so the fetch is paired with `remote set-head -a`. Same reasoning as the
  // branches: the old `origin/HEAD` pointed at the *base's* current branch, so
  // it too was a lying ref, and this repoints it at upstream's default.
  //
  // Guarding rule for this chain: commands that establish the security property
  // (the base must not be reachable as a remote) stay UNGUARDED so a failure
  // fails the run closed rather than handing back a base-writable workspace.
  // Commands that only provide ergonomics or diagnostics are guarded, so a
  // network blip or a read-only config cannot take down pod startup.
  const upstreamRepoUrl = asString(workspaceContext.repoUrl, "").trim();
  const runWorkspaceGit = `git -C ${quoteShellArg(isolation.workspaceRoot)}`;
  const workspaceSetup = isolation.mode === "run" && workspaceCwd && workspaceCwd !== isolation.workspaceRoot
    ? [
        `if git -C ${quoteShellArg(workspaceCwd)} rev-parse --verify HEAD >/dev/null 2>&1; then`,
        `${[
          `source_head=$(git -C ${quoteShellArg(workspaceCwd)} rev-parse HEAD)`,
          `rm -rf ${quoteShellArg(isolation.workspaceRoot)}`,
          // Git objects are immutable/content-addressed and may be shared read-only;
          // the clone still owns its refs, index, worktree, and lock files.
          //
          // `--origin origin` pins the remote name: `git clone` otherwise honors
          // `clone.defaultRemoteName`, and because the removal below is unguarded,
          // an image that ever set that config would hard-fail every run-isolated
          // pod with `error: No such remote: 'origin'`.
          `git clone --shared --no-checkout --origin origin -- ${quoteShellArg(workspaceCwd)} ${quoteShellArg(isolation.workspaceRoot)}`,
          `${runWorkspaceGit} checkout --detach "$source_head"`,
          `${runWorkspaceGit} remote remove origin`,
          ...(upstreamRepoUrl
            ? [
                // `--` because `quoteShellArg` stops shell injection but not git's
                // own option parsing, and a repoUrl starting with `-` would
                // otherwise be read as a flag.
                `${runWorkspaceGit} remote add origin -- ${quoteShellArg(upstreamRepoUrl)}`,
                // Ergonomics, not security: restore `origin/<branch>` so the
                // common `git rebase origin/master` / `git log origin/master..HEAD`
                // phrasings resolve, then `set-head` so `origin/HEAD` resolves
                // too. Guarded, and leaves a breadcrumb when it cannot run, so
                // an offline pod degrades to "fetch first" rather than to a
                // failed run or an unexplained `unknown revision`.
                //
                // This runs on every run-isolated pod start, so the fetch is
                // bounded: `http.lowSpeedLimit`/`lowSpeedTime` abort a transfer
                // that stalls below 1 KiB/s for 15s instead of letting a
                // blackholed network hold pod startup open. That bounds a
                // stalled *transfer*; a connect that never completes is still
                // bounded only by the kernel's TCP retry, which is finite but
                // longer.
                //
                // `set-head` is nested inside its own guard so that when the
                // fetch succeeds but `set-head` fails, the chain does not fall
                // through and write the misleading `originFetchFailed`
                // breadcrumb about a fetch that actually worked.
                `(${runWorkspaceGit} -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=15 fetch --no-tags --quiet origin && (${runWorkspaceGit} remote set-head origin -a >/dev/null 2>&1 || true) || ${runWorkspaceGit} config paperclip.originFetchFailed 'best-effort fetch failed; run \`git fetch origin\` before using origin/<branch> (BLO-31359)' || true)`,
              ]
            : [
                // No recorded upstream: leave the clone with no remote at all
                // rather than one aimed at the base, and say so on the
                // workspace so the resulting `fatal: 'origin' does not appear
                // to be a git repository` is self-explaining.
                //
                // The reachable case is a `local_path` project workspace.
                // `validateProjectWorkspace` requires only *one* of `cwd` or
                // `repoUrl`, so a workspace configured by path satisfies it via
                // `cwd` and carries `repoUrl: null` by construction. A project
                // with no git workspace at all never reaches here — it fails the
                // `rev-parse --verify HEAD` guard above.
                `(${runWorkspaceGit} config paperclip.originRemoved 'no upstream recorded for this run; origin removed so the clone source (a shared base checkout) is not a push target (BLO-31359)' || true)`,
              ]),
        ].join(" && ")};`,
        // Stateless PR-review agents may start from the generic per-agent fallback
        // directory, which is intentionally not a repository. Give those runs a
        // clean private cwd; the review workflow clones its target repository.
        `else rm -rf ${quoteShellArg(isolation.workspaceRoot)} && mkdir -p ${quoteShellArg(isolation.workspaceRoot)};`,
        `fi && cd ${quoteShellArg(isolation.workspaceRoot)}`,
      ].join(" ")
    : "";
  const preparePodLog = `mkdir -p ${quoteShellArg(path.posix.dirname(podLogPath))} || exit $?`;
  const claudeInvocation = `set -o pipefail; ${workspaceSetup ? `${workspaceSetup} || exit $?; ` : ""}${buildEnvGuardSetupShell()}; ${ccrotateRefresh}; ${preparePodLog}; cat /tmp/prompt/prompt.txt | claude ${claudeArgsEscaped} | tee ${quoteShellArg(podLogPath)} | ${failFastFilter} > /dev/null`;
  // When the DinD sidecar is wired in, prepend the wait-for-socket loop
  // so the agent never starts before dockerd is listening on the shared
  // unix socket. Mirrors the opencode_k8s adapter.
  const mainCommand = enableDocker ? `${DIND_WAIT_PREAMBLE}; ${claudeInvocation}` : claudeInvocation;

  // Wire the DinD sidecar's shared volumes + DOCKER_HOST env into the main
  // container. Done after volumes/volumeMounts/envVars are otherwise built
  // so this is a single localized change, easy to remove if we later move
  // dockerd to a dedicated pod.
  if (enableDocker) {
    volumes.push(
      { name: "docker-graph", emptyDir: {} },
      { name: "docker-sock", emptyDir: {} },
    );
    volumeMounts.push({ name: "docker-sock", mountPath: "/var/run" });
    envVars.push({ name: "DOCKER_HOST", value: "unix:///var/run/docker.sock" });
  }

  // Decide prompt delivery strategy: env var (small) or Secret volume (large).
  const promptBytes = Buffer.byteLength(prompt, "utf-8");
  const useLargePromptPath = promptBytes > LARGE_PROMPT_THRESHOLD_BYTES;
  let promptSecret: PromptSecret | null = null;
  const promptSecretName = `${jobName}-prompt`;

  if (useLargePromptPath) {
    // Stage prompt as a Secret; the init container copies from the mounted
    // secret volume to the emptyDir so the main container reads it the
    // same way regardless of prompt size.
    promptSecret = {
      name: promptSecretName,
      namespace,
      data: { "prompt.txt": prompt },
    };
    volumes.push({
      name: "prompt-secret",
      secret: { secretName: promptSecretName, optional: false },
    });
  }

  // Build the init container — writes the prompt (always) and, when an
  // agent supplied adapterConfig.mcpServers, the merged mcp.json next to
  // it in the same prompt emptyDir. mcp.json routinely embeds MCP server
  // credentials (e.g. an HTTP-transport server's `Authorization` header,
  // or stdio server env) supplied via adapterConfig.mcpServers, so — unlike
  // the prompt, which only goes Secret-backed above a size threshold —
  // mcp.json is ALWAYS staged as a Secret-backed volume, never a literal
  // init-container env var, regardless of size (BLO-17980/BLO-17973).
  const initCommandParts = useLargePromptPath
    ? ["cp /tmp/prompt-secret/prompt.txt /tmp/prompt/prompt.txt"]
    : [`printf '%s' "$PROMPT_CONTENT" > /tmp/prompt/prompt.txt`];
  const initEnv: k8s.V1EnvVar[] = useLargePromptPath
    ? []
    : [{ name: "PROMPT_CONTENT", value: prompt }];
  let mcpConfigSecret: McpConfigSecret | null = null;
  if (mergedMcpJson) {
    const mcpConfigSecretName = `${jobName}-mcp`;
    mcpConfigSecret = {
      name: mcpConfigSecretName,
      namespace,
      data: { "mcp.json": mergedMcpJson },
    };
    volumes.push({
      name: "mcp-config-secret",
      secret: { secretName: mcpConfigSecretName, optional: false },
    });
    initCommandParts.push("cp /tmp/mcp-secret/mcp.json /tmp/prompt/mcp.json");
  }
  // Redirect Chrome's BrowserMetrics spool to the per-pod ephemeral
  // runtime-cache. The `agent-browser` designer tool launches system Chrome
  // with the default ${dataMountPath}/.config/google-chrome profile; on
  // headless Chrome's unclean shutdown the ~4MiB *.pma metrics buffers are
  // never reaped, and they accumulated to 42GiB on the shared CephFS HOME,
  // walling the whole agent fleet at workspace setup with EDQUOT (BLO-10699).
  // Only BrowserMetrics is redirected — the rest of the profile (claude.ai
  // /design auth + cookies) stays persistent on the data PVC. Idempotent:
  // skip when it is already a symlink (the shared HOME may have been converted
  // by an earlier pod). The runtime-cache emptyDir is shared with the main
  // container, so Chrome there writes through the symlink to ephemeral storage
  // that dies with the pod.
  const browserHome = isolation.enabled ? isolation.homeRoot : dataMountPath;
  const browserMetricsTarget = isolation.enabled ? `${isolation.cacheRoot}/chrome-browser-metrics` : `${RUNTIME_CACHE_MOUNT_PATH}/chrome-browser-metrics`;
  // Every path below is operator-configurable (`config.workspaceMountPath` →
  // `dataMountPath`, `config.homeRoot` → `isolation.homeRoot`) and is
  // interpolated into the init container's `sh -c`, which runs *before* the
  // Claude PreToolUse guard is installed — so an unquoted `/tmp/x; env; #` as a
  // mount path would execute with the prompt/MCP/PVC mounts already attached.
  // Quote at every interpolation site; `assertSafeAbsolutePath` (applied where
  // these are derived) is the second, independent defence.
  const browserChromeDir = quoteShellArg(`${browserHome}/.config/google-chrome`);
  const browserMetricsLink = quoteShellArg(`${browserHome}/.config/google-chrome/BrowserMetrics`);
  const browserMetricsTargetQ = quoteShellArg(browserMetricsTarget);
  initCommandParts.push(
    ...(isolation.enabled
      ? [`mkdir -p ${[isolation.homeRoot, isolation.sessionRoot, isolation.workspaceRoot, isolation.cacheRoot, isolation.tmpRoot, isolation.promptCacheRoot]
          .filter(Boolean)
          .map(quoteShellArg)
          .join(" ")}`]
      : []),
    `mkdir -p ${browserChromeDir} ${browserMetricsTargetQ}`,
    `[ -L ${browserMetricsLink} ] || { rm -rf ${browserMetricsLink}; ln -sfn ${browserMetricsTargetQ} ${browserMetricsLink}; }`,
  );
  // The `data` volume is declared unconditionally above (PVC-backed, or an
  // `emptyDir` when no claim is configured), so this mount needs no condition
  // and cannot drift from the main container's list. `job-manifest.test.ts` pins
  // the invariant ("every volumeMount resolves to a declared volume", asserted
  // across both containers and every PVC/secret combination).
  const initVolumeMounts: k8s.V1VolumeMount[] = [
    { name: "data", mountPath: dataMountPath },
    { name: "prompt", mountPath: "/tmp/prompt" },
    // Needed so the BrowserMetrics symlink target above resolves in the init
    // container; same emptyDir instance the main container mounts.
    { name: RUNTIME_CACHE_VOLUME_NAME, mountPath: RUNTIME_CACHE_MOUNT_PATH },
  ];
  if (useLargePromptPath) {
    initVolumeMounts.push({
      name: "prompt-secret",
      mountPath: "/tmp/prompt-secret",
      readOnly: true,
    });
  }
  if (mcpConfigSecret) {
    initVolumeMounts.push({
      name: "mcp-config-secret",
      mountPath: "/tmp/mcp-secret",
      readOnly: true,
    });
  }
  const initContainer: k8s.V1Container = {
    name: "write-prompt",
    image: "busybox:1.36",
    imagePullPolicy: "IfNotPresent",
    command: ["sh", "-c", initCommandParts.join("; ")],
    ...(initEnv.length > 0 ? { env: initEnv } : {}),
    volumeMounts: initVolumeMounts,
    securityContext,
    resources: {
      requests: { cpu: "10m", memory: "16Mi" },
      limits: { cpu: "100m", memory: "64Mi" },
    },
  };

  // Backstop for the duplicate-mountPath rule, asserted once both lists are
  // final. The targeted check on `config.workspaceMountPath` above gives the
  // better error message and catches the operator-reachable case, but it runs
  // before `docker-sock` (/var/run), `prompt-secret` and `mcp-config-secret` are
  // appended — and the init container keeps a SECOND, independently-built list.
  // Kubernetes rejects the whole Pod for a duplicate path in *any* container, so
  // assert the invariant per container rather than trusting each append site to
  // remember it. This is the same "assert the invariant, don't duplicate the
  // condition" shape already used for volume/mount correspondence.
  for (const [containerName, mounts] of [
    ["write-prompt (init)", initVolumeMounts],
    ["claude (main)", volumeMounts],
  ] as ReadonlyArray<readonly [string, ReadonlyArray<k8s.V1VolumeMount>]>) {
    const seen = new Map<string, string>();
    for (const mount of mounts) {
      const normalized = normalizeMountPath(mount.mountPath);
      const previous = seen.get(normalized);
      if (previous !== undefined) {
        throw new Error(
          `container ${containerName} would declare duplicate volumeMounts at ${normalized} (volumes "${previous}" and "${mount.name}"); Kubernetes rejects such a Pod`,
        );
      }
      seen.set(normalized, mount.name);
    }
  }

  const job: k8s.V1Job = {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name: jobName,
      namespace,
      labels,
      annotations: {
        "paperclip.io/adapter-type": "claude_k8s",
        "paperclip.io/agent-name": agent.name,
      },
    },
    spec: {
      backoffLimit: 0,
      ...(timeoutSec > 0 ? { activeDeadlineSeconds: timeoutSec } : {}),
      ttlSecondsAfterFinished: ttlSeconds,
      template: {
        metadata: { labels },
        spec: {
          restartPolicy: "Never",
          serviceAccountName,
          securityContext: podSecurityContext,
          ...(selfPod.imagePullSecrets.length > 0 ? { imagePullSecrets: selfPod.imagePullSecrets } : {}),
          ...(selfPod.dnsConfig ? { dnsConfig: selfPod.dnsConfig } : {}),
          ...(Object.keys(nodeSelector).length > 0 ? { nodeSelector } : {}),
          ...(tolerations.length > 0 ? { tolerations: tolerations as k8s.V1Toleration[] } : {}),
          initContainers: [
            initContainer,
            ...(enableDocker
              ? [buildDindSidecar({ image: dockerImage, cpuLimit: dockerCpuLimit, memoryLimit: dockerMemoryLimit })]
              : []),
          ],
          containers: [
            {
              name: "claude",
              image,
              imagePullPolicy: asString(config.imagePullPolicy, "IfNotPresent"),
              workingDir: containerWorkingDir,
              command: ["sh", "-c", mainCommand],
              env: envVars,
              ...(selfPod.inheritedEnvFrom.length > 0 ? { envFrom: selfPod.inheritedEnvFrom } : {}),
              volumeMounts,
              securityContext,
              resources: containerResources,
            },
          ],
          volumes,
        },
      },
    },
  };

  // Defense-in-depth (BLO-17980/BLO-17973): fail the build rather than ship a
  // Pod spec that would expose a credential-shaped env var via `GET Pod`.
  // Deliberately checked against the assembled pod spec, not against the
  // envVars/initEnv locals: the pod also carries the DinD sidecar container,
  // whose env is built inside buildDindSidecar() and never passed through
  // those locals. Reading the containers back off the spec means any container
  // added later is covered automatically instead of silently bypassing this.
  const literalSensitiveNames = findLiteralSensitiveEnvVarsInPodSpec(job.spec!.template.spec!);
  if (literalSensitiveNames.length > 0) {
    throw new Error(
      `claude_k8s: refusing to build Job manifest — sensitive-named env var(s) would be injected as a literal value instead of secretKeyRef: ${literalSensitiveNames.join(", ")}`,
    );
  }

  // Fail-closed backstop for the inheritance allowlist (BLO-22514). Checked on
  // the assembled spec for the same reason as the guard above: it covers every
  // container, including ones added later. A server-only credential reaching an
  // agent pod is a control-plane compromise, so refuse to build rather than
  // return a manifest that leaks it.
  const serverOnlyNames = findServerOnlyEnvVarsInPodSpec(job.spec!.template.spec!);
  if (serverOnlyNames.length > 0) {
    throw new Error(
      `claude_k8s: refusing to build Job manifest — server-only credential env var(s) would be propagated to the agent pod: ${serverOnlyNames.join(", ")}`,
    );
  }

  return { job, jobName, namespace, prompt, claudeArgs, promptMetrics, promptSecret, envSecret, mcpConfigSecret, skippedLabels, podLogPath, serviceAccountName };
}
