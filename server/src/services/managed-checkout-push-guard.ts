/**
 * Make a managed project checkout refuse inbound pushes (BLO-31555 / BLO-31359).
 *
 * BLO-31359 found agent runs pushing branches straight into the project *base*
 * checkout: 67 push-created refs across 3 bases, 117 push events. Its fix
 * (#1616) stopped the ephemeral run clone from carrying the base as its
 * configured `origin`, which closed the path runs actually took. It did not
 * close the capability. The run pod and the base share one filesystem, so this
 * still lands from any run workspace:
 * paperclip:allow-git-push: the next line quotes the hazard, it is not an invocation
 *     git push /paperclip/instances/.../<repo> HEAD:refs/heads/whatever
 *
 * and so does re-adding the remote by hand. Removing a configured
 * remote removes a convenience; only the *receiving* side can remove the
 * capability. This module is that receiving side.
 *
 * ## Why a hook, and why the hook placement is the whole problem
 *
 * There is no config-only way to refuse a *branch creation*. `receive.denyDeletes`
 * and `receive.denyNonFastForwards` refuse destructive updates, and
 * `receive.denyCurrentBranch` refuses the checked-out branch -- none of them
 * covers pushing a brand-new ref name, which is the observed shape (BLO-31359
 * measured 12+ `blo-*` branches in one base). So a `pre-receive` hook is
 * load-bearing rather than belt-and-braces. The config keys are still set,
 * because they keep protecting existing refs even if the hook file is removed,
 * and AC6 of this ticket is that no existing ref is ever deleted --
 * `refs/preserved/blo-31282-base-dirty` anchors unreviewed work.
 *
 * The trap is that `.git/hooks/pre-receive` is **silently ignored** whenever
 * `core.hooksPath` is set, and this codebase demonstrably runs where it is:
 * `workspace-runtime.test.ts` and `execution-workspace-per-run-isolation.test.ts`
 * both neutralize an *inherited global* `core.hooksPath` to make their fixtures
 * hermetic. Measured on git 2.47.3: with a global `core.hooksPath` set, a naive
 * `.git/hooks/pre-receive` that exits 1 does not run and the push succeeds. A
 * guard written blindly to `.git/hooks` is dead on arrival in exactly the
 * environment that needs it.
 *
 * ## The placement rule
 *
 * Resolve where hooks *actually* come from, then choose the least invasive site:
 *
 * - **Effective hooks dir is inside this repo's git common dir** -> install
 *   `pre-receive` there and write no config at all. This covers the unset case
 *   (`<commondir>/hooks`, measured as 40 of 40 managed checkouts on 2026-09-03)
 *   and the repo-private-override case (`.git/no-hooks`, what the two test
 *   fixtures above create). Every pre-existing hook keeps working and the
 *   operator's intent is preserved.
 * - **Effective hooks dir is outside the repo** (a shared or global directory)
 *   -> do NOT write into it; a file dropped in a global hooks dir would apply to
 *   every repository on the host. Instead set a *local* `core.hooksPath` to a
 *   private dir and install there. Local config beats global, so this is
 *   deterministic rather than dependent on discovery defaults.
 *
 * Only the second branch displaces anything, and it records what it displaced in
 * `paperclip.pushGuard.displacedHooksPath` and warns, so the change is legible
 * and reversible rather than silent.
 *
 * ## What this must not break
 *
 * A `pre-receive` hook runs only under `receive-pack`, i.e. only for an inbound
 * push. Verified end-to-end on git 2.47.3 that all of these are unaffected:
 * `git clone --shared` *from* the base (BLO-31351's property), `git fetch` into
 * the base, `git config` writes (`ensureCheckoutGitIdentity`, BLO-23894), and
 * `git worktree add`. The guard deletes no refs and rewrites no history.
 *
 * Failure here is always non-fatal. This is hardening on a provisioning path;
 * taking a run down because a hook could not be written would trade a latent
 * hazard for a certain outage.
 */

import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

/** Budget for the `git config`/`rev-parse` reads and writes. */
export const PUSH_GUARD_GIT_TIMEOUT_MS = 10_000;

/** Private hooks dir, used only when the effective one is outside the repo. */
export const PUSH_GUARD_PRIVATE_HOOKS_DIRNAME = "paperclip-hooks";

/** Records the hooks dir we displaced, so the takeover is reversible. */
export const PUSH_GUARD_DISPLACED_HOOKS_PATH_KEY = "paperclip.pushGuard.displacedHooksPath";

/**
 * Bumped when {@link PUSH_GUARD_HOOK} changes. The installed file is compared
 * against the expected content verbatim, so an older guard is rewritten rather
 * than left in place -- the same self-healing property the sibling provisioning
 * guards rely on.
 */
export const PUSH_GUARD_HOOK_VERSION = 1;

const PUSH_GUARD_HOOK_MARKER = `paperclip-push-guard v${PUSH_GUARD_HOOK_VERSION}`;

/**
 * Refuse every inbound push, whatever the ref.
 *
 * Deliberately not selective. A managed base checkout is never a legitimate
 * push target: agents publish through `origin` on the forge, and every
 * server-side write to the base (clone, fetch, worktree, config) goes through a
 * path that does not invoke `receive-pack`. A hook that tried to allow "safe"
 * ref namespaces would be a policy surface with no legitimate caller.
 *
 * The message names the actual remedy, because the audience is an agent run
 * that just had a push rejected and will otherwise retry it.
 */
export const PUSH_GUARD_HOOK = `#!/bin/sh
# ${PUSH_GUARD_HOOK_MARKER} -- installed by Paperclip (BLO-31555). Do not edit.
#
# This is a Paperclip-managed *base* checkout, shared by every run for this
# project. It is not a publishing target: refs pushed here are invisible to the
# forge, invisible to review, and accumulate silently (BLO-31359 found 67 such
# refs across 3 base checkouts).
# Git already prefixes everything a hook writes to stderr with "remote: ", so
# these lines carry no prefix of their own -- adding one renders as "remote: remote:".
cat >&2 <<'PAPERCLIP_PUSH_GUARD_EOF'
error: This is a Paperclip-managed base checkout and does not accept pushes.

Refs pushed here are invisible to the forge and to review, and they
accumulate silently (BLO-31359 found 67 such refs across 3 base checkouts).
If you are trying to hand work to another run, open a pull request.

Publish from your own run workspace instead, via the forge remote:
PAPERCLIP_PUSH_GUARD_EOF
# Emitted separately so the reason marker below stays a shell comment rather than
# becoming part of the message the rejected pusher sees.
echo '    git push origin HEAD:refs/heads/<your-branch>' >&2 # paperclip:allow-git-push: remediation text printed to a rejected pusher, not an invocation
echo 'See BLO-31555.' >&2
exit 1
`;

/**
 * Config that keeps protecting *existing* refs even with the hook file removed.
 *
 * Not a substitute for the hook -- neither key refuses creating a new ref, which
 * is the shape this ticket exists to stop. They are here for AC6: no existing
 * ref in any base checkout may be deleted or rewritten, and that must survive
 * someone deleting the hook.
 */
export const PUSH_GUARD_RECEIVE_CONFIG: ReadonlyArray<readonly [string, string]> = [
  ["receive.denyDeletes", "true"],
  ["receive.denyNonFastForwards", "true"],
  ["receive.denyCurrentBranch", "refuse"],
];

export type ManagedCheckoutPushGuardState =
  /** No git metadata at the path -- nothing to guard. */
  | "not_a_checkout"
  /** The guard was already installed and current. */
  | "already_installed"
  /** The guard was installed or refreshed. */
  | "installed"
  /** Something went wrong; the checkout is left as found. Non-fatal. */
  | "install_failed";

export type ManagedCheckoutPushGuardResult = {
  state: ManagedCheckoutPushGuardState;
  /** Absolute path of the `pre-receive` we installed, when we installed one. */
  hookPath: string | null;
  /** Set when we had to take `core.hooksPath` over from an out-of-repo dir. */
  displacedHooksPath: string | null;
  warning: string | null;
};

/** Injection seam for tests; defaults to a plain `execFile("git", ...)`. */
export type PushGuardGitRunner = (args: string[], cwd: string) => Promise<string>;

async function defaultRunGit(args: string[], cwd: string): Promise<string> {
  const result = await execFile("git", args, { cwd, timeout: PUSH_GUARD_GIT_TIMEOUT_MS });
  return result.stdout;
}

/**
 * Read one config key, distinguishing "not set" from "could not read".
 *
 * `git config --get` exits 1 for an unset key -- a normal outcome -- and
 * something else for a genuine fault. Collapsing both to `null` would make an
 * unreadable config look like a clean repo, so a locked or unreadable config
 * would silently take the "hooks are unset" branch. Same reasoning as the
 * sibling partial-clone guard, and the same failure direction to avoid.
 */
async function readConfigValue(
  runGit: PushGuardGitRunner,
  cwd: string,
  key: string,
): Promise<{ value: string | null; unreadable: string | null }> {
  try {
    const raw = await runGit(["config", "--get", key], cwd);
    const trimmed = typeof raw === "string" ? raw.trim() : "";
    return { value: trimmed.length > 0 ? trimmed : null, unreadable: null };
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === 1) return { value: null, unreadable: null };
    const reason = error instanceof Error ? error.message : String(error);
    return { value: null, unreadable: reason };
  }
}

/** True when `child` is `parent` or sits underneath it. */
function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Install the guard on the managed checkout at `cwd`.
 *
 * Safe to call unconditionally on any managed-workspace path. A repo-less
 * directory is a no-op, and that is not a nicety: `git` walks *up* from its cwd,
 * so probing a plain directory nested under some ancestor repository would read
 * -- and here, write to -- that ancestor. The structural `.git` probe below runs
 * before any git invocation for exactly that reason, which is the same hazard
 * `ensureCheckoutGitIdentity` and `ensureManagedCheckoutCanServeClones` document.
 */
export async function ensureManagedCheckoutRejectsPushes(input: {
  cwd: string | null | undefined;
  runGit?: PushGuardGitRunner;
}): Promise<ManagedCheckoutPushGuardResult> {
  const cwd = typeof input.cwd === "string" && input.cwd.trim().length > 0 ? input.cwd : null;
  const base: ManagedCheckoutPushGuardResult = {
    state: "not_a_checkout",
    hookPath: null,
    displacedHooksPath: null,
    warning: null,
  };
  if (!cwd) return base;

  // lstat + isDirectory()||isFile(): a linked worktree records `.git` as a FILE
  // (a gitdir pointer), so an isDirectory()-only probe would skip a real
  // checkout. A bare/mirror checkout has no `.git` entry at all and is detected
  // structurally, with no git invocation, for the walk-up reason above.
  const hasGitMetadata = await fs
    .lstat(path.resolve(cwd, ".git"))
    .then((entry) => entry.isDirectory() || entry.isFile())
    .catch(() => false);
  const bareMarkers = await Promise.all(
    ["HEAD", "objects", "refs"].map((entry) =>
      fs.lstat(path.resolve(cwd, entry)).then(() => true).catch(() => false),
    ),
  );
  if (!hasGitMetadata && !bareMarkers.every(Boolean)) return base;

  const baseRunGit = input.runGit ?? defaultRunGit;
  const runGit: PushGuardGitRunner = hasGitMetadata
    ? baseRunGit
    : (args, dir) => baseRunGit(["--git-dir", dir, ...args], dir);

  // Hooks live in the *common* dir: linked worktrees share one hooks directory
  // with their base, so `--git-dir` would give a per-worktree answer and install
  // the guard somewhere `receive-pack` never looks.
  let commonDir: string;
  try {
    const raw = (await runGit(["rev-parse", "--git-common-dir"], cwd)).trim();
    if (!raw) throw new Error("git rev-parse --git-common-dir returned nothing");
    commonDir = path.resolve(cwd, raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      ...base,
      state: "install_failed",
      warning:
        `Managed checkout "${cwd}": could not resolve its git directory (${reason}), so Paperclip did not ` +
        `install the inbound-push guard. This checkout may still accept \`git push <path>\` from run ` + // paperclip:allow-git-push: operator-facing warning text, not an invocation
        `workspaces, which creates refs nobody can see (BLO-31359).`,
    };
  }

  const configured = await readConfigValue(runGit, cwd, "core.hooksPath");
  if (configured.unreadable) {
    return {
      ...base,
      state: "install_failed",
      warning:
        `Managed checkout "${cwd}": could not read core.hooksPath (${configured.unreadable}), so Paperclip ` +
        `could not determine where hooks are loaded from and did not install the inbound-push guard. ` +
        `Installing blindly into .git/hooks would be silently ignored if core.hooksPath is set.`,
    };
  }

  // `core.hooksPath` may be relative, in which case git resolves it against the
  // top of the working tree.
  const effectiveHooksDir = configured.value
    ? path.resolve(cwd, configured.value)
    : path.join(commonDir, "hooks");

  // Least-invasive placement: write into the effective dir when it belongs to
  // this repo, and only take core.hooksPath over when it does not. Writing a
  // `pre-receive` into a shared or global hooks dir would apply it to every
  // repository on the host, which is far worse than the hazard being closed.
  const insideRepo = isInside(commonDir, effectiveHooksDir);
  const hooksDir = insideRepo ? effectiveHooksDir : path.join(commonDir, PUSH_GUARD_PRIVATE_HOOKS_DIRNAME);
  const displacedHooksPath = insideRepo ? null : effectiveHooksDir;
  const hookPath = path.join(hooksDir, "pre-receive");

  const existing = await fs.readFile(hookPath, "utf8").catch(() => null);
  // Compared verbatim rather than by marker so a bumped hook version, or a
  // hand-edited file, is rewritten rather than accepted as current.
  const hookCurrent = existing === PUSH_GUARD_HOOK;

  try {
    if (!hookCurrent) {
      await fs.mkdir(hooksDir, { recursive: true });
      // Write-then-rename: `receive-pack` may execute this file at any moment,
      // and a partially written hook is a hook that exits 0.
      const staging = `${hookPath}.paperclip-tmp`;
      await fs.writeFile(staging, PUSH_GUARD_HOOK, { encoding: "utf8", mode: 0o755 });
      // Explicit chmod: `mode` on writeFile is masked by the process umask, and
      // a hook without the execute bit is skipped by git in silence.
      await fs.chmod(staging, 0o755);
      await fs.rename(staging, hookPath);
    }

    if (displacedHooksPath) {
      await runGit(["config", "--local", "core.hooksPath", hooksDir], cwd);
      await runGit(["config", "--local", PUSH_GUARD_DISPLACED_HOOKS_PATH_KEY, displacedHooksPath], cwd);
    }

    // Set last and best-effort: the hook above is what refuses ref *creation*,
    // so a failure here must not discard a guard that is already installed.
    const configFailures: string[] = [];
    for (const [key, value] of PUSH_GUARD_RECEIVE_CONFIG) {
      const current = await readConfigValue(runGit, cwd, key);
      if (current.value === value) continue;
      const failure = await runGit(["config", "--local", key, value], cwd).then(
        () => null,
        (error: unknown) => `${key}: ${error instanceof Error ? error.message : String(error)}`,
      );
      if (failure) configFailures.push(failure);
    }

    const notes: string[] = [];
    if (displacedHooksPath) {
      notes.push(
        `Managed checkout "${cwd}" loaded hooks from "${displacedHooksPath}", which is outside the ` +
          `repository. Paperclip set a local core.hooksPath to "${hooksDir}" instead of writing into a ` +
          `shared hooks directory. The previous value is recorded in ` +
          `${PUSH_GUARD_DISPLACED_HOOKS_PATH_KEY}; hooks that lived in it no longer run for this checkout.`,
      );
    }
    if (configFailures.length > 0) {
      notes.push(
        `Managed checkout "${cwd}": the inbound-push hook is installed, but these ref-protection keys ` +
          `could not be set: ${configFailures.join("; ")}. Existing refs stay protected by the hook, but ` +
          `not if the hook file is removed.`,
      );
    }

    return {
      state: hookCurrent && !displacedHooksPath && configFailures.length === 0 ? "already_installed" : "installed",
      hookPath,
      displacedHooksPath,
      warning: notes.length > 0 ? notes.join(" ") : null,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      ...base,
      state: "install_failed",
      hookPath: null,
      displacedHooksPath,
      warning:
        `Managed checkout "${cwd}": could not install the inbound-push guard at "${hookPath}" (${reason}). ` +
        `This checkout may still accept \`git push <path>\` from run workspaces, creating refs that are ` + // paperclip:allow-git-push: operator-facing warning text, not an invocation
        `invisible to the forge and to review (BLO-31359).`,
    };
  }
}
