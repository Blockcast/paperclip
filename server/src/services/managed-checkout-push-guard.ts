/**
 * Make a managed project checkout refuse inbound pushes (BLO-31555 / BLO-31359).
 *
 * BLO-31359 found agent runs pushing branches straight into the project *base*
 * checkout: 44 push-created refs across 3 bases, 117 push events. (67 refs were
 * *touched* by a push; 44 is the subset a push brought into existence, which is
 * the number this guard is about. The two are easy to conflate -- BLO-31555's
 * own acceptance criteria cited 67 for the created-count and were corrected.)
 * Its fix
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
 *   fixtures above create). Every pre-existing hook of a *different* name keeps
 *   working untouched; a pre-existing `pre-receive` is the one file this module
 *   must own, so it is moved aside to `pre-receive.paperclip-displaced` and
 *   reported rather than overwritten in place. Nothing is ever destroyed.
 * - **Effective hooks dir is outside the repo** (a shared or global directory)
 *   -> do NOT write into it; a file dropped in a global hooks dir would apply to
 *   every repository on the host. Instead set a *local* `core.hooksPath` to a
 *   private dir and install there. Local config beats global, so this is
 *   deterministic rather than dependent on discovery defaults.
 *
 * Both displacing branches record what they displaced -- the hooks dir in
 * `paperclip.pushGuard.displacedHooksPath`, an operator hook by leaving the file
 * on disk under a suffixed name -- and warn, so the change is legible and
 * reversible rather than silent.
 *
 * Note the second branch's blast radius: git stores `--local` config in the git
 * *common* dir, which every linked worktree shares. This project provisions run
 * workspaces as worktrees, so taking `core.hooksPath` over repoints hook
 * resolution for those run workspaces too, not only for the base. That is
 * checked rather than assumed: as of 2026-09-04 no non-test source path in this
 * repository reads `core.hooksPath` or installs/depends on any git hook, so
 * nothing in the run-workspace flow relies on an inherited `post-checkout` /
 * `pre-commit` / `commit-msg`. Per-worktree scoping (`extensions.worktreeConfig`
 * plus `--worktree`) is therefore deliberately not used -- it carries its own
 * consequences and buys nothing here. The warning names the wider scope so an
 * operator with such hooks is not surprised.
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

/**
 * Ownership marker, deliberately **version-free**.
 *
 * Two different questions get asked about an existing `pre-receive`, and
 * conflating them is what lets an operator's own hook be destroyed:
 *
 * - *Is it current?* -- answered verbatim against {@link PUSH_GUARD_HOOK}, so a
 *   bumped version or a hand-edit is refreshed rather than accepted.
 * - *Is it ours to overwrite?* -- answered by this marker. It must not carry the
 *   version, or bumping {@link PUSH_GUARD_HOOK_VERSION} would make every
 *   previously-installed guard look foreign and leave a backup behind on every
 *   checkout at the next provision.
 *
 * A file that does not carry it is treated as the operator's and preserved (see
 * {@link PUSH_GUARD_DISPLACED_HOOK_SUFFIX}). That is the safe direction: the
 * cost of a false "foreign" reading is one unused backup file, and the cost of a
 * false "ours" reading is someone's hook silently and irreversibly gone.
 */
export const PUSH_GUARD_HOOK_MARKER = "paperclip-push-guard";

/** Suffix for an operator `pre-receive` we had to move aside. */
export const PUSH_GUARD_DISPLACED_HOOK_SUFFIX = ".paperclip-displaced";

/**
 * Cap on displaced-hook backups before we refuse rather than overwrite one.
 *
 * Reaching this means an operator has re-installed their own `pre-receive`
 * several times over. Destroying an earlier backup to make room would be the
 * exact silent data loss this whole path exists to avoid, so the guard declines
 * to install instead -- it is defence-in-depth (BLO-31359's fix already removed
 * the path runs actually took), and hardening never outranks operator intent.
 */
export const PUSH_GUARD_MAX_DISPLACED_HOOK_BACKUPS = 8;

// paperclip:allow-git-push: remediation text printed to a rejected pusher, not an invocation
const PUSH_GUARD_REMEDIATION_COMMAND = "git push origin HEAD:refs/heads/<your-branch>";

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
# ${PUSH_GUARD_HOOK_MARKER} v${PUSH_GUARD_HOOK_VERSION} -- installed by Paperclip (BLO-31555). Do not edit.
#
# This is a Paperclip-managed *base* checkout, shared by every run for this
# project. It is not a publishing target: refs pushed here are invisible to the
# forge, invisible to review, and accumulate silently (BLO-31359 found 44 such
# refs across 3 base checkouts).
# Git already prefixes everything a hook writes to stderr with "remote: ", so
# these lines carry no prefix of their own -- adding one renders as "remote: remote:".
cat >&2 <<'PAPERCLIP_PUSH_GUARD_EOF'
error: This is a Paperclip-managed base checkout and does not accept pushes.

Refs pushed here are invisible to the forge and to review, and they
accumulate silently (BLO-31359 found 44 such refs across 3 base checkouts).
If you are trying to hand work to another run, open a pull request.

Publish from your own run workspace instead, via the forge remote:
PAPERCLIP_PUSH_GUARD_EOF
# Emitted separately so the reason marker below stays a shell comment rather than
# becoming part of the message the rejected pusher sees. The command itself is
# interpolated from a constant so this file ships no Paperclip lint pragmas.
echo '    ${PUSH_GUARD_REMEDIATION_COMMAND}' >&2
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
  /** Set when an operator's own `pre-receive` was moved aside to this path. */
  displacedHookPath: string | null;
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
 *
 * `scope` is load-bearing and differs per key:
 *
 * - `"effective"` resolves across system/global/local, which is what
 *   `core.hooksPath` needs: the question there is "where does `receive-pack`
 *   *actually* look", and an inherited value is the whole hazard.
 * - `"local"` reads only this checkout's own config, which is what
 *   {@link PUSH_GUARD_RECEIVE_CONFIG} needs. Those keys exist so protection
 *   survives in config *the checkout owns*; an effective read would see an
 *   inherited global value, skip the write as already-satisfied, and leave the
 *   checkout depending on config a different pod or image may not carry.
 */
async function readConfigValue(
  runGit: PushGuardGitRunner,
  cwd: string,
  key: string,
  scope: "effective" | "local" = "effective",
): Promise<{ value: string | null; unreadable: string | null }> {
  const scopeArgs = scope === "local" ? ["--local"] : [];
  try {
    const raw = await runGit(["config", ...scopeArgs, "--get", key], cwd);
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
 * Pick a free path to move an operator's `pre-receive` aside to.
 *
 * Never returns a path that already exists: `fs.rename` overwrites silently, so
 * reusing an occupied backup name would destroy an *earlier* displaced hook --
 * the same irreversible loss this function exists to prevent, one step removed.
 * Returns `null` once {@link PUSH_GUARD_MAX_DISPLACED_HOOK_BACKUPS} is exhausted,
 * which the caller treats as "do not install" rather than "overwrite".
 */
async function reserveDisplacedHookPath(hookPath: string): Promise<string | null> {
  for (let attempt = 0; attempt <= PUSH_GUARD_MAX_DISPLACED_HOOK_BACKUPS; attempt += 1) {
    const candidate =
      attempt === 0
        ? `${hookPath}${PUSH_GUARD_DISPLACED_HOOK_SUFFIX}`
        : `${hookPath}${PUSH_GUARD_DISPLACED_HOOK_SUFFIX}.${attempt}`;
    const taken = await fs
      .lstat(candidate)
      .then(() => true)
      .catch(() => false);
    if (!taken) return candidate;
  }
  return null;
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
    displacedHookPath: null,
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
  // Two distinct questions -- see PUSH_GUARD_HOOK_MARKER. "Current" is verbatim
  // so a bumped version or a hand-edit is refreshed; "ours" is by marker so an
  // operator's own hook is preserved rather than clobbered.
  const hookCurrent = existing === PUSH_GUARD_HOOK;
  const foreignHook = existing !== null && !existing.includes(PUSH_GUARD_HOOK_MARKER);

  // Reserved before any write so an exhausted backup budget aborts cleanly,
  // leaving the operator's hook exactly where it was.
  const foreignBackupPath = foreignHook ? await reserveDisplacedHookPath(hookPath) : null;
  if (foreignHook && !foreignBackupPath) {
    return {
      ...base,
      state: "install_failed",
      warning:
        `Managed checkout "${cwd}": a non-Paperclip \`pre-receive\` hook is installed at "${hookPath}" and ` +
        `Paperclip has already displaced ${PUSH_GUARD_MAX_DISPLACED_HOOK_BACKUPS} earlier ones, so it declined ` +
        `to install the inbound-push guard rather than overwrite a backup. The operator hook is untouched. ` +
        `Remove the stale "${path.basename(hookPath)}${PUSH_GUARD_DISPLACED_HOOK_SUFFIX}*" backups to re-enable ` +
        `the guard; until then this checkout may still accept pushes from run workspaces (BLO-31359).`,
    };
  }

  let hookInstalled = hookCurrent;
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
      // Displace only once our replacement is fully staged, so a failed write
      // cannot leave the checkout with the operator's hook moved and nothing in
      // its place.
      if (foreignBackupPath) await fs.rename(hookPath, foreignBackupPath);
      await fs.rename(staging, hookPath);
      hookInstalled = true;
    }

    if (displacedHooksPath) {
      await runGit(["config", "--local", "core.hooksPath", hooksDir], cwd);
      await runGit(["config", "--local", PUSH_GUARD_DISPLACED_HOOKS_PATH_KEY, displacedHooksPath], cwd);
    }

    // Set last and best-effort: the hook above is what refuses ref *creation*,
    // so a failure here must not discard a guard that is already installed.
    const configFailures: string[] = [];
    for (const [key, value] of PUSH_GUARD_RECEIVE_CONFIG) {
      const current = await readConfigValue(runGit, cwd, key, "local");
      if (current.value === value) continue;
      const failure = await runGit(["config", "--local", key, value], cwd).then(
        () => null,
        (error: unknown) => `${key}: ${error instanceof Error ? error.message : String(error)}`,
      );
      if (failure) configFailures.push(failure);
    }

    const notes: string[] = [];
    if (foreignBackupPath) {
      notes.push(
        `Managed checkout "${cwd}" already had a non-Paperclip \`pre-receive\` hook. Paperclip moved it to ` +
          `"${foreignBackupPath}" and installed the inbound-push guard in its place; it is no longer run. ` +
          `Restore it by merging its contents into the guard, or move it back to disable the guard.`,
      );
    }
    if (displacedHooksPath) {
      notes.push(
        `Managed checkout "${cwd}" loaded hooks from "${displacedHooksPath}", which is outside the ` +
          `repository. Paperclip set a local core.hooksPath to "${hooksDir}" instead of writing into a ` +
          `shared hooks directory. The previous value is recorded in ` +
          `${PUSH_GUARD_DISPLACED_HOOKS_PATH_KEY}. Note the scope: git stores --local config in the git ` +
          `*common* dir, which every linked worktree shares, so hooks that lived in "${displacedHooksPath}" ` +
          `no longer run for this checkout OR for any run workspace provisioned as a worktree from it ` +
          `(post-checkout, pre-commit, commit-msg and the rest). Paperclip installs only \`pre-receive\`, ` +
          `which run worktrees inherit harmlessly -- nothing pushes into one either.`,
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
      state:
        hookCurrent && !displacedHooksPath && configFailures.length === 0 ? "already_installed" : "installed",
      hookPath,
      displacedHooksPath,
      displacedHookPath: foreignBackupPath,
      warning: notes.length > 0 ? notes.join(" ") : null,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // Report what was actually achieved. The hook is written before both config
    // writes, so a `git config` failure leaves the guard genuinely in force --
    // telling an operator their checkout still accepts pushes would send them
    // hunting for a hazard that is already closed.
    const consequence = hookInstalled
      ? `The \`pre-receive\` guard itself IS installed at "${hookPath}" and inbound pushes are refused, but ` +
        `the follow-up configuration did not complete` +
        (displacedHooksPath
          ? `, so core.hooksPath may still point at "${displacedHooksPath}" and the guard may therefore not ` +
            `be the hook git loads. Re-provisioning will retry.`
          : `, so the receive.* keys that protect existing refs if the hook file is removed may be unset. ` +
            `Re-provisioning will retry.`)
      : `This checkout may still accept pushes from run workspaces, creating refs that are invisible to the ` +
        `forge and to review (BLO-31359).`;
    return {
      ...base,
      state: "install_failed",
      hookPath: hookInstalled ? hookPath : null,
      displacedHooksPath,
      displacedHookPath: foreignBackupPath,
      warning: `Managed checkout "${cwd}": could not fully install the inbound-push guard at "${hookPath}" (${reason}). ${consequence}`,
    };
  }
}
