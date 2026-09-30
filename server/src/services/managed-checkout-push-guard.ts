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
 * - **Effective hooks dir belongs to this repo** -- i.e. it is inside the git
 *   common dir *or* inside the working tree -> install `pre-receive` there and
 *   write no config at all. This covers the unset case (`<commondir>/hooks`,
 *   measured as 40 of 40 managed checkouts on 2026-09-03), the
 *   repo-private-override case (`.git/no-hooks`, what the two test fixtures
 *   above create), and the tracked-hooks convention (`.githooks/`, `.husky/`),
 *   which git resolves against the top of the working tree and which is
 *   therefore in the repo but not in `.git`. Every pre-existing hook of a
 *   *different* name keeps working untouched; a pre-existing `pre-receive` is
 *   the one file this module must own, so it is moved aside to
 *   `pre-receive.paperclip-displaced` and reported rather than overwritten in
 *   place. Nothing is ever destroyed.
 * - **Effective hooks dir is outside the repo entirely** (a shared or global
 *   directory, outside both the common dir and the working tree)
 *   -> do NOT write into it; a file dropped in a global hooks dir would apply to
 *   every repository on the host. Instead set a *local* `core.hooksPath` to a
 *   private dir and install there. Local config beats global, so this is
 *   deterministic rather than dependent on discovery defaults.
 *
 * The distinction matters because the second branch is much more invasive than
 * it looks: it repoints hook resolution for the base *and* for every run
 * workspace worktree, so any other hook the repo relied on stops running. It is
 * reserved for the case where the alternative is worse (writing into a directory
 * shared with other repositories), and a repo-tracked hooks dir is not that
 * case -- writing one untracked `pre-receive` beside the repo's own hooks leaves
 * them all working.
 *
 * ## The in-tree placement has a working-tree cost, and it is paid explicitly
 *
 * "One untracked `pre-receive`" is untracked *content* in a directory the repo
 * tracks, which means `git status` reports it and `git clean -fd` deletes it.
 * Neither is cosmetic. `execution-workspaces.ts` refuses branch reconciliation
 * on a non-clean worktree, and for a `project_primary` workspace the path it
 * inspects is the managed base itself -- so an unexcluded guard would break
 * reconciliation for precisely the repos it installs in place for, on every
 * pass. And a routine `git clean -fd` would silently disarm the guard until the
 * next provision. Both are closed by adding the hook's path to the repository's
 * `info/exclude` (measured on git 2.47.3: status clean, and the hook survives
 * `git clean -fd`). `info/exclude` rather than `.gitignore` because the latter is
 * tracked -- writing there would turn a dirty worktree into a committable diff.
 * Only our own file is excluded; a displaced operator hook keeps its `??` line,
 * because that content is theirs and was already untracked before Paperclip
 * touched anything.
 *
 * ## The one shape this module refuses to serve: a TRACKED `pre-receive`
 *
 * If the repo commits `pre-receive` itself, every available move is destructive
 * and the guard declines instead. Displacement renames version-controlled
 * content: `git status` shows a modification, any `git checkout -- .` silently
 * restores the operator's hook over the guard, and because the backup keeps its
 * name the next provision sees a foreign hook again and reserves the next
 * number -- so a revert/re-provision cycle walks the backup budget to exhaustion
 * and reaches a permanent decline anyway, having dirtied the checkout every pass
 * on the way. `info/exclude` cannot help, because the file is tracked. Taking
 * `core.hooksPath` over was the considered alternative and was rejected: it
 * stops the repo's own committed hooks running for the base and every worktree
 * derived from it, to install defence-in-depth that #1616 has already made
 * redundant. A `pre-receive` in version control is deliberate operator intent,
 * and hardening does not outrank it -- the same principle as the backup-budget
 * decline. The warning says plainly that such a checkout still accepts pushes.
 *
 * One wrinkle sits underneath both branches: a **relative** `core.hooksPath` does
 * not name a single directory. Git resolves it against the running process's cwd,
 * and that differs by command -- the working tree for `git worktree add`, but the
 * *git dir* for `receive-pack`. Measured on git 2.47.3 with
 * `core.hooksPath = .githooks`, a guard installed at `<worktree>/.githooks` is
 * never consulted by an inbound push and the push is ACCEPTED, while the guard
 * reports success. So for an in-repo relative value the local config is rewritten
 * to the absolute directory it already pointed at. That is a normalization, not a
 * displacement: the same hooks keep running, and it is reported in
 * `normalizedHooksPath` rather than `displacedHooksPath`.
 *
 * Both displacing branches record what they displaced -- the hooks dir in
 * `paperclip.pushGuard.displacedHooksPath`, an operator hook by leaving the file
 * on disk under a suffixed name -- and warn, so the change is legible and
 * reversible rather than silent.
 *
 * Note the second branch's blast radius: git stores `--local` config in the git
 * *common* dir, which every linked worktree shares. This project provisions run
 * workspaces as worktrees, so taking `core.hooksPath` over repoints hook
 * resolution for those run workspaces too, not only for the base.
 *
 * Two different things bound that risk, and only the first is measured. Paperclip's
 * own orchestration does not depend on hooks: as of 2026-09-04 no non-test source
 * path in *this* repository reads `core.hooksPath` or installs/depends on any git
 * hook, so nothing in the run-workspace flow relies on an inherited
 * `post-checkout` / `pre-commit` / `commit-msg`. That grep does NOT cover the
 * repos the code actually runs against -- `ensureManagedProjectWorkspace`
 * provisions managed checkouts of arbitrary project repos, any of which may ship
 * hooks of its own, and no grep here can see them. What protects those is the
 * placement rule rather than a measurement: a repo that tracks its hooks now
 * takes the in-place branch, so the displacement branch is reached only for a
 * directory outside the repo altogether, which by construction is not the repo's
 * own hooks. Per-worktree scoping (`extensions.worktreeConfig` plus `--worktree`)
 * is therefore deliberately not used -- it carries its own consequences and buys
 * little once the misclassification is gone. The warning names the wider scope so
 * an operator with genuinely shared hooks is not surprised.
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
 * Header written above our entry in `info/exclude`, so the line is legible to an
 * operator who finds it and can be removed deliberately rather than guessed at.
 */
export const PUSH_GUARD_EXCLUDE_COMMENT =
  "# paperclip-push-guard (BLO-31555): keeps the inbound-push hook from dirtying this worktree.";

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
  /**
   * Set when a *relative* `core.hooksPath` was rewritten to the absolute
   * directory it already pointed at. Not a displacement -- the same hooks keep
   * running -- but it is a config write, so it is reported separately.
   */
  normalizedHooksPath: string | null;
  /**
   * Set when the hook landed in the working tree and its path was added to
   * `info/exclude` so the checkout stays clean. Null when the hook landed inside
   * the git dir, where it is invisible to `git status` already.
   */
  excludedHookPath: string | null;
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
 *
 * The bound is `<`, not `<=`: attempt 0 is the unnumbered name, so the loop
 * yields exactly MAX candidates (unnumbered plus `.1`..`.MAX-1`). With `<=` it
 * yielded MAX+1, which made both the constant's name and the decline warning's
 * count understate reality by one.
 */
async function reserveDisplacedHookPath(hookPath: string): Promise<string | null> {
  for (let attempt = 0; attempt < PUSH_GUARD_MAX_DISPLACED_HOOK_BACKUPS; attempt += 1) {
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
 * Translate an absolute in-tree path into an anchored `info/exclude` pattern.
 *
 * Anchored with a leading `/` so it matches only the hook we installed at the
 * top of this working tree, never a same-named file elsewhere in the repo. The
 * escaping is not decorative: a repository whose hooks dir contains a gitignore
 * metacharacter (`*?[]`) would otherwise get a pattern matching a *wider* set of
 * files than the one we wrote, silently hiding an operator's real changes from
 * `git status`. Leading `#`/`!` need no escape because the anchor precedes them.
 */
function toExcludePattern(worktreeRoot: string, absolutePath: string): string {
  const relative = path.relative(worktreeRoot, absolutePath).split(path.sep).join("/");
  const escaped = relative.replace(/[\\*?[\]]/g, (character) => `\\${character}`);
  // A trailing space is stripped by git unless escaped, which would leave the
  // pattern pointing at a different name than the file we created.
  return `/${escaped.replace(/ $/, "\\ ")}`;
}

/**
 * Add `pattern` to `<commonDir>/info/exclude`, idempotently.
 *
 * `info/exclude` rather than `.gitignore`: the latter is tracked content, so
 * writing to it would be a *committable* change to the operator's repository --
 * exactly the dirtiness being fixed, one level worse. `info/exclude` is
 * untracked, repo-local, and shared by every linked worktree, which matches the
 * scope of the hook it covers.
 *
 * Returns whether a write happened, so a converged checkout can still report
 * `already_installed`.
 */
async function ensureExcluded(commonDir: string, pattern: string): Promise<boolean> {
  const excludeFile = path.join(commonDir, "info", "exclude");
  const existing = await fs.readFile(excludeFile, "utf8").catch(() => null);
  if (existing !== null && existing.split(/\r?\n/).some((line) => line.trim() === pattern)) return false;
  await fs.mkdir(path.dirname(excludeFile), { recursive: true });
  // Never rewrite the file: an operator's own patterns live here too. Append,
  // and open a fresh line first if the last one was unterminated -- otherwise
  // our pattern would graft onto the tail of theirs and change its meaning.
  const separator = existing === null || existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
  await fs.appendFile(excludeFile, `${separator}${PUSH_GUARD_EXCLUDE_COMMENT}\n${pattern}\n`, "utf8");
  return true;
}

/**
 * Is `absolutePath` tracked in this checkout's index?
 *
 * `git ls-files` rather than `--error-unmatch`: the latter signals "untracked"
 * by exit code 1, which is indistinguishable here from a genuine fault, and this
 * question decides whether the guard installs at all. `ls-files` exits 0 either
 * way and answers by printing the path, so a thrown error means a real failure.
 *
 * Deliberately true for a tracked file that has been *deleted* from the working
 * tree: writing our hook over that path shows up as a staged-able modification
 * just the same, which is the condition being avoided.
 */
async function isTracked(runGit: PushGuardGitRunner, cwd: string, absolutePath: string): Promise<boolean> {
  const relative = path.relative(cwd, absolutePath).split(path.sep).join("/");
  const output = await runGit(["ls-files", "--", relative], cwd);
  return typeof output === "string" && output.trim().length > 0;
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
    normalizedHooksPath: null,
    excludedHookPath: null,
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

  // `core.hooksPath` may be relative. Resolve it against the top of the working
  // tree -- that is where a repo's own tracked hooks live, and it is how every
  // worktree-side command resolves it. See `relativeHooksPath` below for why
  // that is NOT how `receive-pack` resolves it.
  const effectiveHooksDir = configured.value
    ? path.resolve(cwd, configured.value)
    : path.join(commonDir, "hooks");

  // Least-invasive placement: write into the effective dir when it belongs to
  // this repo, and only take core.hooksPath over when it does not. Writing a
  // `pre-receive` into a shared or global hooks dir would apply it to every
  // repository on the host, which is far worse than the hazard being closed.
  //
  // "Belongs to this repo" is BOTH the git dir and the working tree, and the
  // second half is not redundant: the commonest non-default convention is a repo
  // that TRACKS its hooks (`.githooks/`, `.husky/`) and points `core.hooksPath`
  // at them, which lands inside the repo but outside `.git`. Testing only
  // `commonDir` sent exactly that case down the displacement path, which
  // repoints `core.hooksPath` for the base AND every worktree derived from it,
  // so the repo's own committed `post-checkout`/`pre-commit`/`commit-msg`
  // silently stop running (measured on git 2.47.3: a tracked post-checkout fired
  // on `git worktree add` before the takeover and not after). `cwd` is safe as
  // the working-tree root because the structural `.git` probe above only
  // proceeds when `.git` sits directly in it.
  const insideRepo = isInside(commonDir, effectiveHooksDir) || isInside(cwd, effectiveHooksDir);

  // A relative `core.hooksPath` does not name one directory -- git resolves it
  // against the *current process's* cwd, and that differs by command. Measured
  // on git 2.47.3 with `core.hooksPath = .githooks`:
  //
  //   git worktree add  (cwd = working tree) -> <cwd>/.githooks       -- hooks run
  //   receive-pack      (cwd = the git dir)  -> <commondir>/.githooks -- guard sought HERE
  //
  // So installing into the resolved-against-the-worktree directory is silently
  // ineffective for the one hook this module exists to install: the guard
  // reports success and the push is still accepted (verified end-to-end -- this
  // is why the test pushes rather than only asserting `hookPath`). Rewriting the
  // value to the absolute directory it already points at collapses the two
  // resolutions onto the same place, so the guard works AND the repo's own hooks
  // keep running. That is a config write but not a displacement, and it is
  // strictly less invasive than pointing `core.hooksPath` at a private dir.
  const relativeHooksPath = Boolean(configured.value) && !path.isAbsolute(configured.value!);
  const normalizedHooksPath = insideRepo && relativeHooksPath ? effectiveHooksDir : null;

  const hooksDir = insideRepo ? effectiveHooksDir : path.join(commonDir, PUSH_GUARD_PRIVATE_HOOKS_DIRNAME);
  const privateHooksDir = path.join(commonDir, PUSH_GUARD_PRIVATE_HOOKS_DIRNAME);

  // A takeover erases its own evidence from this computation: afterwards
  // `core.hooksPath` is an absolute path under the common dir, so `insideRepo` is
  // true and the line above yields null -- the result would report no
  // displacement while the checkout is still displaced, and the single warning at
  // takeover time would be the only notice an operator ever gets. Recover it from
  // the key we wrote. Read only when the effective dir IS our private dir, which
  // is the signature of a prior takeover, so the common case (an unset
  // `core.hooksPath`) adds no subprocess.
  const priorDisplacement =
    insideRepo && effectiveHooksDir === privateHooksDir
      ? (await readConfigValue(runGit, cwd, PUSH_GUARD_DISPLACED_HOOKS_PATH_KEY, "local")).value
      : null;
  const displacedHooksPath = insideRepo ? priorDisplacement : effectiveHooksDir;
  // Only a displacement performed by THIS call writes config and warns; a prior
  // one is already recorded on disk and merely needs reporting.
  const displacingNow = !insideRepo;
  const hookPath = path.join(hooksDir, "pre-receive");

  // Does the hook land in the WORKING TREE rather than the git dir? Only the
  // tracked-hooks convention (`.githooks/`, `.husky/`) does, and only there can
  // the guard show up in `git status` or be swept by `git clean`. A bare/mirror
  // checkout has no working tree, so the question does not arise.
  const hookInWorkTree = hasGitMetadata && insideRepo && !isInside(commonDir, hookPath);

  // A TRACKED `pre-receive` is the one shape this module cannot serve, and the
  // honest answer is to decline rather than to half-handle it. Displacement
  // renames a tracked file, which (measured, git 2.47.3) leaves `M .githooks/
  // pre-receive` plus an untracked backup, and any `git checkout -- .` silently
  // restores the operator's hook over the guard. Because the backup still holds
  // its name, the next provision sees a foreign hook again and reserves the next
  // number, so a revert/re-provision cycle walks the backup budget to exhaustion
  // and lands on the permanent decline below anyway -- having dirtied the
  // checkout every pass on the way. `info/exclude` cannot help: the file is
  // tracked. Declining up front reaches the same terminal state immediately,
  // without touching the repository at all.
  //
  // Taking `core.hooksPath` over instead was the alternative considered. It was
  // rejected because it stops the repo's OWN committed hooks from running for
  // the base and every worktree derived from it -- the exact regression this
  // module's placement rule exists to avoid -- to install defence-in-depth that
  // BLO-31359's primary fix has already made redundant. Operator intent
  // committed to version control outranks hardening.
  const trackedTarget = hookInWorkTree
    ? await isTracked(runGit, cwd, hookPath).catch(() => null)
    : false;
  if (trackedTarget !== false) {
    const cause =
      trackedTarget === null
        ? `Paperclip could not determine whether "${hookPath}" is tracked`
        : `"${hookPath}" is tracked in this repository`;
    return {
      ...base,
      state: "install_failed",
      displacedHooksPath,
      warning:
        `Managed checkout "${cwd}": ${cause}, so Paperclip did not install the inbound-push guard. A ` +
        `version-controlled \`pre-receive\` is deliberate operator intent, and Paperclip will not move a ` +
        `tracked file aside: the rename would show as a local modification and any \`git checkout\` would ` +
        `silently restore the original over the guard. This checkout may therefore still accept ` +
        `\`git push <path>\` from run workspaces (BLO-31359); note #1616 already stopped runs from ` + // paperclip:allow-git-push: operator-facing warning text, not an invocation
        `carrying this base as their \`origin\`, so this is defence-in-depth rather than the live hazard. ` +
        `To enable the guard, stop tracking "${path.basename(hookPath)}" in "${path.dirname(hookPath)}" ` +
        `(move your logic to a differently-named hook, which Paperclip never touches).`,
    };
  }

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
      // Carried deliberately: this is the exit where an operator most needs the
      // full picture, and `base` would report a resolved out-of-repo hooks dir
      // as null.
      displacedHooksPath,
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

    if (displacingNow) {
      await runGit(["config", "--local", "core.hooksPath", hooksDir], cwd);
      await runGit(["config", "--local", PUSH_GUARD_DISPLACED_HOOKS_PATH_KEY, effectiveHooksDir], cwd);
    } else if (normalizedHooksPath) {
      // Same directory, spelled absolutely -- see `relativeHooksPath` above.
      await runGit(["config", "--local", "core.hooksPath", normalizedHooksPath], cwd);
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

    // A hook in the working tree is an untracked file in a directory the repo
    // tracks, so without this the base checkout is permanently dirty. That is
    // not cosmetic: `execution-workspaces.ts` refuses branch reconciliation on a
    // non-clean worktree, and a `project_primary` workspace inspects the managed
    // base itself -- so the guard would break reconciliation for exactly the
    // repos it installs in place for. `git clean -fd` would also delete the
    // guard, silently disarming it until the next provisioning pass. Excluding
    // the path closes both (measured, git 2.47.3: status clean, and the hook
    // survives `git clean -fd`).
    //
    // Only our own file. A displaced operator hook keeps its `??` line
    // deliberately: that content is theirs, it was already untracked before
    // Paperclip touched anything, and hiding someone's hook from `git status` to
    // tidy our own output would be the wrong trade.
    let excludedHookPath: string | null = null;
    let excludeWritten = false;
    let excludeFailure: string | null = null;
    if (hookInWorkTree) {
      const pattern = toExcludePattern(cwd, hookPath);
      const outcome = await ensureExcluded(commonDir, pattern).then(
        (written) => ({ written, error: null }),
        (error: unknown) => ({ written: false, error: error instanceof Error ? error.message : String(error) }),
      );
      excludeFailure = outcome.error;
      excludeWritten = outcome.written;
      if (!outcome.error) excludedHookPath = hookPath;
    }

    const notes: string[] = [];
    if (foreignBackupPath) {
      notes.push(
        `Managed checkout "${cwd}" already had a non-Paperclip \`pre-receive\` hook. Paperclip moved it to ` +
          `"${foreignBackupPath}" and installed the inbound-push guard in its place; it is no longer run. ` +
          `Do NOT merge your logic into the installed guard: \`pre-receive\` is Paperclip-owned and is ` +
          `rewritten wholesale on the next provisioning pass. A merged file carries Paperclip's ownership ` +
          `marker, so it reads as ours to overwrite -- the merge would be discarded silently, with no ` +
          `backup and no warning. Two remedies survive re-provisioning: keep your logic under a different ` +
          `hook name, or move "${path.basename(foreignBackupPath)}" back over the guard to disable it.`,
      );
    }
    if (displacingNow) {
      notes.push(
        `Managed checkout "${cwd}" loaded hooks from "${displacedHooksPath}", which is outside this ` +
          `repository entirely -- neither in its git directory nor in its working tree, so it is a shared ` +
          `or global directory rather than hooks the repo ships. Paperclip set a local core.hooksPath to ` +
          `"${hooksDir}" instead of writing into it, which would have applied the guard to every repository ` +
          `using that directory. The previous value is recorded in ` +
          `${PUSH_GUARD_DISPLACED_HOOKS_PATH_KEY}. Note the scope: git stores --local config in the git ` +
          `*common* dir, which every linked worktree shares, so hooks that lived in "${displacedHooksPath}" ` +
          `no longer run for this checkout OR for any run workspace provisioned as a worktree from it ` +
          `(post-checkout, pre-commit, commit-msg and the rest). To restore them, move your hooks into the ` +
          `repository (a tracked ".githooks/" is written into in place, not displaced) or unset the local ` +
          `core.hooksPath. Paperclip installs only \`pre-receive\`, which run worktrees inherit ` +
          `harmlessly -- nothing pushes into one either.`,
      );
    }
    if (normalizedHooksPath) {
      notes.push(
        `Managed checkout "${cwd}": core.hooksPath was the relative value ` +
          `"${configured.value}", which git resolves against each command's working directory -- the working ` +
          `tree for worktree commands, but the git directory for \`receive-pack\`, so a \`pre-receive\` ` +
          `placed at "${normalizedHooksPath}" would never have been found by an inbound push. Paperclip ` +
          `rewrote the local value to that same directory spelled absolutely. The same hooks run as before; ` +
          `only the spelling changed. One consequence worth knowing: a linked worktree now resolves hooks to ` +
          `the base's copy rather than its own checked-out one, so a branch that changes a hook no longer ` +
          `changes it for that worktree.`,
      );
    }
    if (excludeFailure) {
      notes.push(
        `Managed checkout "${cwd}": the inbound-push guard is installed at "${hookPath}", but its path could ` +
          `not be added to the repository's info/exclude (${excludeFailure}). The guard works; the checkout ` +
          `will read as dirty (an untracked "${path.basename(hookPath)}"), which blocks execution-workspace ` +
          `branch reconciliation, and \`git clean -fd\` will remove the guard until the next provision.`,
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
      // Convergence is about what THIS call changed, so a displacement carried
      // over from an earlier provision must not keep re-reporting "installed"
      // forever. `displacedHooksPath` stays populated in the payload either way
      // -- the state says what happened, the field says what is true.
      state:
        hookCurrent &&
        !displacingNow &&
        !normalizedHooksPath &&
        !excludeWritten &&
        configFailures.length === 0 &&
        !excludeFailure
          ? "already_installed"
          : "installed",
      hookPath,
      displacedHooksPath,
      displacedHookPath: foreignBackupPath,
      normalizedHooksPath,
      excludedHookPath,
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
        (displacingNow
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
      normalizedHooksPath,
      // The exclude write happens after every statement that can reach this
      // catch, so nothing was excluded on this path.
      excludedHookPath: null,
      warning: `Managed checkout "${cwd}": could not fully install the inbound-push guard at "${hookPath}" (${reason}). ${consequence}`,
    };
  }
}
