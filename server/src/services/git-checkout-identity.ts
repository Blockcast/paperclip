/**
 * Per-agent git author identity for runtime checkouts (BLO-23894).
 *
 * Every agent pod pushes with the same shared `allyblockcast[bot]` GitHub App
 * credential, so the only thing that distinguishes one agent's commit from
 * another's once it reaches the remote is the *local* `user.name`/`user.email`
 * of the checkout it commits from. Nothing provisioned that: a 2026-08-10 sweep
 * of 71 checkouts under `/paperclip/work` found 11 already stamped with the
 * shared App identity and 18 with no local identity at all, and AGENTS.md
 * compensated by asking every agent to run `git config` by hand.
 *
 * This module provides both the best-effort checkout provisioning step and the
 * authoritative per-run environment overlay. It is called from every path that
 * hands a checkout to a run -- the managed project workspace in `heartbeat.ts`
 * and both git-worktree realization paths in `workspace-runtime.ts` -- and the
 * environment overlay is applied immediately before adapter dispatch.
 *
 * The environment variables are the authority for a run. Local config remains a
 * compatibility aid for standalone checkouts and for operators inspecting a
 * workspace after a run, but it cannot be used as the concurrency boundary:
 * linked worktrees resolve `--local` through the common repository config.
 *
 * The provisioning helper is deliberately shaped to be safe to call
 * unconditionally:
 *
 * - It **no-ops when the path carries no git metadata.** Running `git config` in
 *   a plain directory does not fail harmlessly: git walks *up* from the cwd, so
 *   a repo-less managed workspace nested under any ancestor repository would
 *   have its identity written into that ancestor's config instead.
 * - It **never throws.** This runs on a provisioning path where an unwritable
 *   config must not take the run down, so every failure is reported as a warning
 *   string the caller can surface alongside its other warnings.
 * - It is **idempotent**: a checkout already carrying this agent's identity is
 *   left untouched, so repeated runs do not rewrite the config.
 *
 * Scope note: standalone checkouts use a local (`git config --local`) write,
 * never `--global` or `--system`. For a *linked worktree*, `.git` is a file and
 * `--local` resolves to the common repository config rather than to something
 * worktree-private. We intentionally skip that write and rely on the final
 * per-run environment overlay; enabling `extensions.worktreeConfig` would be a
 * repo-wide migration with its own `core.bare` and `core.worktree` caveats.
 */

import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { deriveAgentUrlKey } from "@paperclipai/shared";

const execFile = promisify(execFileCallback);

/** Domain for synthesized per-agent author addresses. */
export const PAPERCLIP_AGENT_EMAIL_DOMAIN = "paperclip.blockcast.net";

/** Budget for the handful of `git config` reads and writes below. */
export const GIT_IDENTITY_COMMAND_TIMEOUT_MS = 10_000;

/** Git's four process-level identity overrides, in the order Git consumes them. */
export const GIT_IDENTITY_ENV_KEYS = [
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
] as const;

/**
 * Author emails that identify the shared write credential rather than an agent,
 * and must therefore be replaced when found in a checkout's local config.
 *
 * Both forms are listed on purpose. Only the numeric-prefixed one is an offense
 * to `scripts/check-commit-author-attribution.mjs` -- the bare form is the
 * `graphify-reindex` bot's own legitimate push identity, which that gate must
 * not flag. But in an *agent's* checkout either value means the same thing: the
 * commit will not be attributed to the agent that wrote it. See AGENTS.md.
 */
export const SHARED_APP_AUTHOR_EMAILS: readonly string[] = [
  "290875700+allyblockcast[bot]@users.noreply.github.com",
  "allyblockcast[bot]@users.noreply.github.com",
];

const SHARED_APP_AUTHOR_EMAIL_SET = new Set(
  SHARED_APP_AUTHOR_EMAILS.map((value) => value.toLowerCase()),
);

/** Runs `git <args>` in `cwd`, resolving to trimmed stdout or rejecting. */
export type GitConfigRunner = (args: string[], cwd: string) => Promise<string>;

/**
 * The identity-bearing subset of an agent row. Kept structural so both
 * `agents.$inferSelect` (heartbeat) and `ExecutionWorkspaceAgentRef`
 * (workspace-runtime) satisfy it without a cast.
 */
export type CheckoutIdentityAgentRef = {
  id?: string | null;
  name?: string | null;
};

export type CheckoutGitIdentityStatus =
  /** No git metadata at `cwd` -- a repo-less directory, nothing to provision. */
  | "skipped_no_git"
  /** No agent to attribute to; a placeholder identity would be worse. */
  | "skipped_no_agent"
  /** A linked worktree has shared local config; the run-level env is authoritative. */
  | "skipped_linked_worktree"
  /**
   * The checkout carries an identity paperclip did not write -- a human's, in a
   * checkout they also use. Left untouched on purpose; see the policy note on
   * `ensureCheckoutGitIdentity`.
   */
  | "skipped_foreign_identity"
  /** Local config already held exactly this agent's identity. */
  | "unchanged"
  /** Local config was unset, App-stamped, or another agent's -- now corrected. */
  | "updated"
  /** Probe or write failed; see `warning`. The run is not affected. */
  | "failed";

export type CheckoutGitIdentityResult = {
  status: CheckoutGitIdentityStatus;
  /** The identity now in effect, or null when nothing was provisioned. */
  email: string | null;
  name: string | null;
  /** The `user.email` found before the write, when one was read. */
  previousEmail: string | null;
  /** Non-null only on `failed`. Never thrown. */
  warning: string | null;
};

export function isSharedAppAuthorEmail(value: string | null | undefined): boolean {
  if (typeof value !== "string") return false;
  return SHARED_APP_AUTHOR_EMAIL_SET.has(value.trim().toLowerCase());
}

/**
 * True for an address in paperclip's own synthesized namespace, i.e. one this
 * module wrote on some earlier run (possibly for a different agent).
 *
 * This is what makes it safe to re-point a checkout from agent A to agent B
 * without also trampling an address the *user* configured: paperclip only
 * rewrites values it owns.
 */
export function isPaperclipProvisionedAuthorEmail(value: string | null | undefined): boolean {
  if (typeof value !== "string") return false;
  return value.trim().toLowerCase().endsWith(`@${PAPERCLIP_AGENT_EMAIL_DOMAIN}`);
}

/**
 * git's ident parser reads `Name <email>`, so `<`, `>` and control characters in
 * the name would either be rejected outright or corrupt the header. A leading
 * `-` is worse: `git config` would consume it as an option rather than a value.
 * Strip all of it, and fall back to the url key when nothing printable survives.
 *
 * Written as an explicit code-point scan rather than a character class so the
 * control range cannot be mis-typed as a printable range (`[<space>-<]` silently
 * covers the digits).
 */
function sanitizeGitAuthorName(value: string, fallback: string): string {
  let stripped = "";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    const isControl = code < 0x20 || code === 0x7f;
    stripped += isControl || char === "<" || char === ">" ? " " : char;
  }
  const cleaned = stripped.replace(/\s+/g, " ").trim().replace(/^-+/, "").trim();
  return cleaned.length > 0 ? cleaned : fallback;
}

/**
 * The canonical per-agent identity.
 *
 * The local part is `normalizeAgentUrlKey(agent.name)` -- the same key that is
 * already per-company UNIQUE, enforced on create and rename, and surfaced as
 * `agent.urlKey`. `deriveAgentUrlKey` supplies the null-safe fallback chain
 * (agent id, then the literal `agent`) so an all-punctuation name still yields a
 * legal email local part rather than a bare `@paperclip.blockcast.net`.
 */
export function buildAgentGitIdentity(agent: CheckoutIdentityAgentRef): {
  email: string;
  name: string;
} {
  const urlKey = deriveAgentUrlKey(agent.name ?? null, agent.id ?? null);
  return {
    email: `${urlKey}@${PAPERCLIP_AGENT_EMAIL_DOMAIN}`,
    name: sanitizeGitAuthorName(agent.name ?? "", urlKey),
  };
}

export type AgentGitIdentityEnv = Record<(typeof GIT_IDENTITY_ENV_KEYS)[number], string>;

/**
 * Build the process-level identity used by every adapter invocation.
 *
 * Git gives these variables precedence over repository, global, and system
 * config, which makes the identity independent of shared checkout config and
 * carries it across adapters that clone a workspace inside another runtime.
 */
export function buildAgentGitIdentityEnv(agent: CheckoutIdentityAgentRef): AgentGitIdentityEnv {
  const identity = buildAgentGitIdentity(agent);
  return {
    GIT_AUTHOR_NAME: identity.name,
    GIT_AUTHOR_EMAIL: identity.email,
    GIT_COMMITTER_NAME: identity.name,
    GIT_COMMITTER_EMAIL: identity.email,
  };
}

/**
 * Apply the system identity after all agent/project/routine/environment
 * overlays. User-supplied `GIT_*` values are intentionally overwritten.
 */
export function applyAgentGitIdentityToRuntimeConfig(input: {
  runtimeConfig: Record<string, unknown>;
  agent: CheckoutIdentityAgentRef;
}): Record<string, unknown> {
  const rawEnv = input.runtimeConfig.env;
  const env =
    rawEnv && typeof rawEnv === "object" && !Array.isArray(rawEnv)
      ? (rawEnv as Record<string, unknown>)
      : {};
  return {
    ...input.runtimeConfig,
    env: {
      ...env,
      ...buildAgentGitIdentityEnv(input.agent),
    },
  };
}

async function defaultGitRunner(args: string[], cwd: string): Promise<string> {
  const result = await execFile("git", args, {
    cwd,
    timeout: GIT_IDENTITY_COMMAND_TIMEOUT_MS,
  });
  return typeof result.stdout === "string" ? result.stdout.trim() : "";
}

/**
 * True when `cwd` is the root of a git checkout.
 *
 * `lstat` plus `isDirectory() || isFile()` on purpose: a linked *worktree* has
 * `.git` as a FILE (a gitdir pointer), so an `isDirectory()`-only probe reports
 * every worktree checkout as "not a git checkout" and would skip exactly the
 * checkouts the git_worktree strategy creates.
 */
type GitMetadataKind = "directory" | "file";

async function readGitMetadataKind(cwd: string): Promise<GitMetadataKind | null> {
  return fs
    .lstat(path.resolve(cwd, ".git"))
    .then((entry) => {
      if (entry.isDirectory()) return "directory";
      if (entry.isFile()) return "file";
      return null;
    })
    .catch(() => null);
}

async function readLocalConfigValue(
  runGit: GitConfigRunner,
  cwd: string,
  key: string,
): Promise<string | null> {
  // Exit 1 with no output is git's "key is not set", which is a normal read
  // outcome rather than a failure -- hence catch-to-null instead of rethrow.
  const value = await runGit(["config", "--local", "--get", key], cwd).catch(() => null);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Ensure the checkout at `cwd` commits as `agent` rather than as the shared App
 * identity (or as nobody).
 *
 * Safe to call on any path: repo-less directories and missing agents are no-ops,
 * and every failure comes back as `{ status: "failed", warning }`.
 */
export async function ensureCheckoutGitIdentity(input: {
  cwd: string | null | undefined;
  agent: CheckoutIdentityAgentRef | null | undefined;
  /** Injection seam for tests; defaults to a plain `execFile("git", ...)`. */
  runGit?: GitConfigRunner;
}): Promise<CheckoutGitIdentityResult> {
  const skipped = (status: CheckoutGitIdentityStatus): CheckoutGitIdentityResult => ({
    status,
    email: null,
    name: null,
    previousEmail: null,
    warning: null,
  });

  const cwd = typeof input.cwd === "string" ? input.cwd.trim() : "";
  if (cwd.length === 0) return skipped("skipped_no_git");

  const agent = input.agent ?? null;
  const hasAgentName = typeof agent?.name === "string" && agent.name.trim().length > 0;
  const hasAgentId = typeof agent?.id === "string" && agent.id.trim().length > 0;
  if (!agent || (!hasAgentName && !hasAgentId)) return skipped("skipped_no_agent");

  const runGit = input.runGit ?? defaultGitRunner;
  const identity = buildAgentGitIdentity(agent);

  try {
    const gitMetadataKind = await readGitMetadataKind(cwd);
    if (!gitMetadataKind) return skipped("skipped_no_git");

    // A linked worktree's `.git` file points at `.git/worktrees/<name>` in the
    // common repository. `git config --local` from that cwd therefore mutates
    // the parent checkout's shared identity, making concurrent runs race. The
    // final GIT_* environment overlay is private to this run and covers both
    // the host adapter and any clone performed by a remote adapter.
    if (gitMetadataKind === "file") {
      return {
        status: "skipped_linked_worktree",
        email: identity.email,
        name: identity.name,
        previousEmail: null,
        warning: null,
      };
    }

    const currentEmail = await readLocalConfigValue(runGit, cwd, "user.email");
    const currentName = await readLocalConfigValue(runGit, cwd, "user.name");

    // "Correct" means correct *for this agent*: a checkout is handed to one run
    // at a time and that run's agent is the one about to commit from it.
    if (currentEmail === identity.email && currentName === identity.name) {
      return {
        status: "unchanged",
        email: identity.email,
        name: identity.name,
        previousEmail: currentEmail,
        warning: null,
      };
    }

    // Only rewrite values paperclip owns. Unset and both App forms are exactly
    // the broken populations this change exists to repair; a paperclip-domain
    // address is one we wrote ourselves on an earlier run, so re-pointing it to
    // the current agent is ours to do. Anything else is a human's identity in a
    // checkout they also use -- most reachable via the `project_primary`
    // strategy, which runs the agent directly in the project checkout -- and
    // silently rewriting a user's `user.email` there would be a worse bug than
    // the one being fixed.
    const ownsCurrentIdentity =
      currentEmail === null
      || isSharedAppAuthorEmail(currentEmail)
      || isPaperclipProvisionedAuthorEmail(currentEmail);
    if (!ownsCurrentIdentity) {
      return {
        status: "skipped_foreign_identity",
        email: currentEmail,
        name: currentName,
        previousEmail: currentEmail,
        warning: null,
      };
    }

    await runGit(["config", "--local", "user.email", identity.email], cwd);
    await runGit(["config", "--local", "user.name", identity.name], cwd);

    return {
      status: "updated",
      email: identity.email,
      name: identity.name,
      previousEmail: currentEmail,
      warning: null,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      status: "failed",
      email: null,
      name: null,
      previousEmail: null,
      warning:
        `Could not set the per-agent git author identity in "${cwd}" `
        + `(wanted ${identity.name} <${identity.email}>): ${reason}. `
        + "Commits from this checkout may be attributed to the shared GitHub App.",
    };
  }
}
