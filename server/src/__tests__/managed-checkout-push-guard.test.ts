/**
 * BLO-31555 / BLO-31359: the managed-checkout inbound-push guard.
 *
 * Driven against real git repositories rather than mocks. The property under
 * test -- "does `receive-pack` refuse this ref" -- lives entirely in git's hook
 * discovery and config precedence, which is exactly the machinery a mock would
 * stub out. The original defect (BLO-31359: 67 push-created refs across 3 base
 * checkouts) was invisible to unit tests for that reason.
 *
 * Two fixtures matter and are easy to conflate:
 *
 * - A base checkout provisioned **before** the guard existed, then provisioned
 *   again. That is the shape of every base checkout in production, and the one
 *   BLO-23894 and BLO-31351 were both written to reach. Note the limit: these
 *   tests exercise the guard module directly, so they prove it works on a
 *   pre-existing checkout but cannot prove the *call site* sits at
 *   `ensureManagedProjectWorkspace`'s single exit point rather than after the
 *   `git clone`. That function is private to heartbeat.ts and both sibling
 *   guards are covered the same way; placement is a review property.
 * - An inherited **global** `core.hooksPath`. A naive `.git/hooks/pre-receive`
 *   is silently ignored when that is set, and this repository's own fixtures
 *   (`workspace-runtime.test.ts`, `execution-workspace-per-run-isolation.test.ts`)
 *   demonstrate it is set in real environments.
 */

import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  ensureManagedCheckoutRejectsPushes,
  PUSH_GUARD_DISPLACED_HOOK_SUFFIX,
  PUSH_GUARD_DISPLACED_HOOKS_PATH_KEY,
  PUSH_GUARD_HOOK,
  PUSH_GUARD_HOOK_MARKER,
  PUSH_GUARD_MAX_DISPLACED_HOOK_BACKUPS,
  PUSH_GUARD_PRIVATE_HOOKS_DIRNAME,
  PUSH_GUARD_RECEIVE_CONFIG,
} from "../services/managed-checkout-push-guard.js";

const execFile = promisify(execFileCallback);

let root: string;
let hermeticGlobalConfig: string;
const savedEnv: Record<string, string | undefined> = {};

/**
 * The guard shells out with `process.env`, so hermeticity has to be installed
 * there rather than only in this file's helper. Otherwise a developer's global
 * `core.hooksPath` (the very thing test 3 simulates) would leak into every other
 * case and quietly change what is being measured.
 */
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-push-guard-"));
  hermeticGlobalConfig = path.join(root, "gitconfig-empty");
  await fs.writeFile(hermeticGlobalConfig, "", "utf8");
  for (const key of [
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_SYSTEM",
    "GIT_AUTHOR_NAME",
    "GIT_AUTHOR_EMAIL",
    "GIT_COMMITTER_NAME",
    "GIT_COMMITTER_EMAIL",
  ]) {
    savedEnv[key] = process.env[key];
  }
  process.env.GIT_CONFIG_GLOBAL = hermeticGlobalConfig;
  process.env.GIT_CONFIG_SYSTEM = "/dev/null";
  process.env.GIT_AUTHOR_NAME = "Push Guard Test";
  process.env.GIT_AUTHOR_EMAIL = "push-guard-test@example.invalid";
  process.env.GIT_COMMITTER_NAME = "Push Guard Test";
  process.env.GIT_COMMITTER_EMAIL = "push-guard-test@example.invalid";
});

afterAll(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (root) await fs.rm(root, { recursive: true, force: true });
});

afterEach(() => {
  // Test 3 repoints this; restore so ordering cannot change any other outcome.
  process.env.GIT_CONFIG_GLOBAL = hermeticGlobalConfig;
});

async function git(args: string[], cwd: string) {
  return await execFile("git", args, { cwd, env: process.env, maxBuffer: 32 * 1024 * 1024 });
}

/** Run a git command expected to fail, returning its combined output. */
async function gitExpectFailure(args: string[], cwd: string): Promise<string> {
  try {
    await git(args, cwd);
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    return `${err.stdout ?? ""}${err.stderr ?? ""}${err.message ?? ""}`;
  }
  throw new Error(`Expected \`git ${args.join(" ")}\` to fail in ${cwd}, but it succeeded.`);
}

let counter = 0;

/**
 * A managed base checkout as it exists *before* this change: a plain clone
 * target with no guard of any kind. Everything in production looks like this.
 */
async function createUnguardedBase(): Promise<string> {
  const base = path.join(root, `base-${counter++}`);
  await fs.mkdir(base, { recursive: true });
  await git(["init", "-b", "main"], base);
  await fs.writeFile(path.join(base, "README.md"), "hello\n", "utf8");
  await git(["add", "README.md"], base);
  await git(["commit", "-m", "initial"], base);
  return base;
}

/** A run workspace, cloned from the base the way execution workspaces are. */
async function createRunWorkspace(base: string): Promise<string> {
  const run = path.join(root, `run-${counter++}`);
  await git(["clone", "--shared", base, run], root);
  await fs.appendFile(path.join(run, "README.md"), "from the run\n", "utf8");
  await git(["commit", "-am", "run work"], run);
  return run;
}

async function refExists(repo: string, ref: string): Promise<boolean> {
  return await git(["show-ref", "--verify", "--quiet", ref], repo).then(
    () => true,
    () => false,
  );
}

describe("ensureManagedCheckoutRejectsPushes", () => {
  it("refuses a branch CREATION pushed by explicit path from a run workspace", async () => {
    const base = await createUnguardedBase();
    const run = await createRunWorkspace(base);

    // Baseline: this is the live hazard, and asserting it here is what stops the
    // test passing vacuously if the push were failing for some unrelated reason.
    await git(["push", base, "HEAD:refs/heads/probe-baseline"], run);
    expect(await refExists(base, "refs/heads/probe-baseline")).toBe(true);

    const result = await ensureManagedCheckoutRejectsPushes({ cwd: base });
    expect(result.state).toBe("installed");

    const output = await gitExpectFailure(["push", base, "HEAD:refs/heads/probe-ac2"], run);
    expect(output).toContain("does not accept pushes");
    expect(await refExists(base, "refs/heads/probe-ac2")).toBe(false);
  });

  it("protects a checkout that already existed, and is idempotent across provisions", async () => {
    // This base was never provisioned by the guarded code path -- true of every
    // base checkout in production -- so it pins the half of AC2 a module-level
    // test can actually reach: the guard works on a checkout it did not create.
    //
    // It does NOT pin the call-site placement. Nothing here invokes
    // `ensureManagedProjectWorkspace`, so moving that call after the `git clone`
    // would leave this test green. `ensureManagedProjectWorkspace` is private to
    // heartbeat.ts and its two sibling guards (BLO-23894, BLO-31351) are covered
    // the same module-level way; placement is verified by review, not here.
    const base = await createUnguardedBase();
    const run = await createRunWorkspace(base);

    const first = await ensureManagedCheckoutRejectsPushes({ cwd: base });
    expect(first.state).toBe("installed");

    // Second provision: no rewrite, and protection still in force.
    const second = await ensureManagedCheckoutRejectsPushes({ cwd: base });
    expect(second.state).toBe("already_installed");
    expect(second.warning).toBeNull();
    expect(second.hookPath).toBe(first.hookPath);

    await gitExpectFailure(["push", base, "HEAD:refs/heads/probe-second-pass"], run);
    expect(await refExists(base, "refs/heads/probe-second-pass")).toBe(false);
  });

  it("survives an inherited global core.hooksPath", async () => {
    const base = await createUnguardedBase();
    const run = await createRunWorkspace(base);

    // An unrelated hooks directory -- the shape a Git LFS install or an org-wide
    // policy leaves behind. The sentinel `post-checkout` is what makes the
    // worktree assertion at the end of this test capable of failing.
    const globalHooks = path.join(root, `global-hooks-${counter++}`);
    await fs.mkdir(globalHooks, { recursive: true });
    const sentinel = path.join(root, `global-hook-firings-${counter++}.txt`);
    await fs.writeFile(
      path.join(globalHooks, "post-checkout"),
      `#!/bin/sh\necho fired >> ${JSON.stringify(sentinel)}\n`,
      { encoding: "utf8", mode: 0o755 },
    );
    await fs.chmod(path.join(globalHooks, "post-checkout"), 0o755);
    const globalConfig = path.join(root, `gitconfig-hookspath-${counter++}`);
    await fs.writeFile(globalConfig, `[core]\n\thooksPath = ${globalHooks}\n`, "utf8");
    process.env.GIT_CONFIG_GLOBAL = globalConfig;

    // Control: the naive placement really is dead here. Without this the test
    // would pass on an implementation that writes to `.git/hooks` and happens to
    // work because the global setting never took effect.
    const naiveHook = path.join(base, ".git", "hooks", "pre-receive");
    await fs.mkdir(path.dirname(naiveHook), { recursive: true });
    await fs.writeFile(naiveHook, "#!/bin/sh\nexit 1\n", { encoding: "utf8", mode: 0o755 });
    await fs.chmod(naiveHook, 0o755);
    await git(["push", base, "HEAD:refs/heads/probe-naive"], run);
    expect(await refExists(base, "refs/heads/probe-naive")).toBe(true);
    await fs.rm(naiveHook);

    // Second control, and the baseline for the worktree assertion below: while
    // the global dir is still in force its hooks genuinely run. Without this the
    // "did not fire" check afterwards could pass because the sentinel never
    // worked at all.
    const worktreeBefore = path.join(root, `worktree-before-takeover-${counter++}`);
    await git(["worktree", "add", "-b", "wt-before-takeover", worktreeBefore], base);
    expect(await fs.readFile(sentinel, "utf8")).toContain("fired");
    await fs.rm(sentinel);

    const result = await ensureManagedCheckoutRejectsPushes({ cwd: base });
    expect(result.state).toBe("installed");
    // The global dir is shared across every repo on the host, so the guard must
    // not have written into it -- only the sentinel hook we put there.
    expect(result.displacedHooksPath).toBe(globalHooks);
    expect(await fs.readdir(globalHooks)).toEqual(["post-checkout"]);
    expect(result.hookPath).toBe(path.join(base, ".git", PUSH_GUARD_PRIVATE_HOOKS_DIRNAME, "pre-receive"));
    expect(result.warning).toContain("outside this repository entirely");

    const output = await gitExpectFailure(["push", base, "HEAD:refs/heads/probe-global-hookspath"], run);
    expect(output).toContain("does not accept pushes");
    expect(await refExists(base, "refs/heads/probe-global-hookspath")).toBe(false);

    // The displaced value is recorded rather than destroyed.
    const recorded = await git(["config", "--local", "--get", PUSH_GUARD_DISPLACED_HOOKS_PATH_KEY], base);
    expect(recorded.stdout.trim()).toBe(globalHooks);

    // The takeover's blast radius, measured rather than asserted in prose.
    // Worktrees share the git common dir, so the local core.hooksPath written
    // above applies to them too. Asserting only that `worktree add` succeeds
    // could not fail -- git skips a missing hook silently and post-checkout's
    // exit code does not fail a checkout -- so read the resolved value back AND
    // show the displaced dir's hook stops firing, which is the actual cost.
    const worktree = path.join(root, `worktree-displaced-${counter++}`);
    await git(["worktree", "add", "-b", "wt-displaced-probe", worktree], base);
    expect((await git(["config", "--get", "core.hooksPath"], worktree)).stdout.trim()).toBe(
      path.join(base, ".git", PUSH_GUARD_PRIVATE_HOOKS_DIRNAME),
    );
    expect(await fs.readFile(sentinel, "utf8").catch(() => "")).not.toContain("fired");
    expect((await git(["rev-parse", "HEAD"], worktree)).stdout.trim()).toMatch(/^[0-9a-f]{40}$/);
  });

  it("installs into a repo-private core.hooksPath without touching config", async () => {
    // The shape `workspace-runtime.test.ts` creates to disable inherited hooks.
    // Taking core.hooksPath over here would silently undo that intent, so the
    // guard writes into the operator's own directory instead.
    const base = await createUnguardedBase();
    const run = await createRunWorkspace(base);
    const privateHooks = path.join(base, ".git", "no-hooks");
    await git(["config", "core.hooksPath", privateHooks], base);

    const result = await ensureManagedCheckoutRejectsPushes({ cwd: base });
    expect(result.state).toBe("installed");
    expect(result.displacedHooksPath).toBeNull();
    expect(result.hookPath).toBe(path.join(privateHooks, "pre-receive"));
    expect((await git(["config", "--get", "core.hooksPath"], base)).stdout.trim()).toBe(privateHooks);

    await gitExpectFailure(["push", base, "HEAD:refs/heads/probe-private"], run);
    expect(await refExists(base, "refs/heads/probe-private")).toBe(false);
  });

  it("writes into a repo's own TRACKED hooks dir rather than displacing it", async () => {
    // The commonest non-default convention: the repo ships its hooks in
    // `.githooks/` and points core.hooksPath at them. Git resolves a relative
    // value against the top of the WORKING TREE, so this lands inside the repo
    // but outside `.git` -- and a placement rule that asks only "is it under
    // .git?" sends it down the takeover path meant for global directories. That
    // is the more invasive branch: it repoints core.hooksPath for the base and
    // every worktree derived from it, so the repo's own committed hooks stop
    // running. Writing one untracked `pre-receive` beside them leaves them alive.
    const base = await createUnguardedBase();
    const trackedHooks = path.join(base, ".githooks");
    await fs.mkdir(trackedHooks, { recursive: true });
    const sentinel = path.join(root, `tracked-hook-firings-${counter++}.txt`);
    await fs.writeFile(
      path.join(trackedHooks, "post-checkout"),
      `#!/bin/sh\necho fired >> ${JSON.stringify(sentinel)}\n`,
      { encoding: "utf8", mode: 0o755 },
    );
    await fs.chmod(path.join(trackedHooks, "post-checkout"), 0o755);
    await git(["add", ".githooks/post-checkout"], base);
    await git(["commit", "-m", "track hooks"], base);
    await git(["config", "core.hooksPath", ".githooks"], base);
    const run = await createRunWorkspace(base);

    const result = await ensureManagedCheckoutRejectsPushes({ cwd: base });

    // Least invasive: installed in place, nothing displaced.
    expect(result.state).toBe("installed");
    expect(result.displacedHooksPath).toBeNull();
    expect(result.hookPath).toBe(path.join(trackedHooks, "pre-receive"));

    // ...but the relative value had to be spelled absolutely. Git resolves a
    // relative core.hooksPath against each command's cwd, and receive-pack's cwd
    // is the git dir -- so before this the guard sat where an inbound push would
    // never look. The push probe below is what makes that visible; asserting
    // `hookPath` alone passes against a guard that does not guard.
    expect(result.normalizedHooksPath).toBe(trackedHooks);
    expect((await git(["config", "--get", "core.hooksPath"], base)).stdout.trim()).toBe(trackedHooks);
    expect(result.warning).toContain("resolves against each command's working directory");

    // The property that the takeover branch destroys: the repo's committed hooks
    // keep running, for the base and for worktrees provisioned from it.
    const worktree = path.join(root, `worktree-tracked-${counter++}`);
    await git(["worktree", "add", "-b", "wt-tracked-probe", worktree], base);
    expect(await fs.readFile(sentinel, "utf8")).toContain("fired");

    // ...and the guard actually guards.
    const output = await gitExpectFailure(["push", base, "HEAD:refs/heads/probe-tracked"], run);
    expect(output).toContain("does not accept pushes");
    expect(await refExists(base, "refs/heads/probe-tracked")).toBe(false);

    // The base must stay CLEAN. The hook is an untracked file inside a directory
    // the repo tracks, so without an info/exclude entry the checkout is
    // permanently dirty -- and `execution-workspaces.ts` throws
    // "requires a clean worktree" on branch reconciliation, whose target for a
    // `project_primary` workspace is this very base. Asserting `hookPath` alone
    // passes against a guard that breaks reconciliation for every repo it
    // installs in place for.
    const status = await git(["status", "--porcelain", "--untracked-files=all"], base);
    expect(status.stdout.trim()).toBe("");
    expect(result.excludedHookPath).toBe(path.join(trackedHooks, "pre-receive"));

    // The other half of the same entry: an untracked hook is something
    // `git clean -fd` deletes, which would silently disarm the guard until the
    // next provisioning pass. Run a real clean rather than trusting `-n`.
    await git(["clean", "-fd"], base);
    expect(await fs.readFile(path.join(trackedHooks, "pre-receive"), "utf8")).toContain(
      PUSH_GUARD_HOOK_MARKER,
    );
    const afterClean = await gitExpectFailure(["push", base, "HEAD:refs/heads/probe-after-clean"], run);
    expect(afterClean).toContain("does not accept pushes");
    expect(await refExists(base, "refs/heads/probe-after-clean")).toBe(false);

    // Converges: the value is absolute now, so there is nothing left to rewrite.
    const second = await ensureManagedCheckoutRejectsPushes({ cwd: base });
    expect(second.state).toBe("already_installed");
    expect(second.normalizedHooksPath).toBeNull();
    expect(second.warning).toBeNull();

    // The exclude entry converges too -- a second pass must not append a
    // duplicate, or the file grows by two lines on every heartbeat.
    const excludeFile = path.join(base, ".git", "info", "exclude");
    const excludeBody = await fs.readFile(excludeFile, "utf8");
    const hits = excludeBody.split(/\r?\n/).filter((line) => line.trim() === "/.githooks/pre-receive");
    expect(hits).toHaveLength(1);
  });

  it("declines rather than displace a TRACKED pre-receive, leaving the repo untouched", async () => {
    // The one shape this module cannot serve. Displacing a tracked file renames
    // version-controlled content: `git status` shows a modification, and any
    // `git checkout -- .` silently restores the operator's hook over the guard.
    // Because the backup keeps its name, the next provision sees a foreign hook
    // again and reserves the next number, so a revert/re-provision cycle walks
    // the backup budget to exhaustion and lands on a permanent decline anyway --
    // having dirtied the checkout on every pass. info/exclude cannot help: the
    // file is tracked. So the guard declines up front and changes nothing.
    const base = await createUnguardedBase();
    const trackedHooks = path.join(base, ".githooks");
    await fs.mkdir(trackedHooks, { recursive: true });
    const operatorHook = path.join(trackedHooks, "pre-receive");
    const operatorBody = "#!/bin/sh\n# operator's own, committed deliberately\nexit 0\n";
    await fs.writeFile(operatorHook, operatorBody, { encoding: "utf8", mode: 0o755 });
    await git(["add", ".githooks/pre-receive"], base);
    await git(["commit", "-m", "track a pre-receive"], base);
    await git(["config", "core.hooksPath", trackedHooks], base);

    const result = await ensureManagedCheckoutRejectsPushes({ cwd: base });

    expect(result.state).toBe("install_failed");
    expect(result.hookPath).toBeNull();
    expect(result.excludedHookPath).toBeNull();
    expect(result.warning).toContain("is tracked in this repository");

    // "Changes nothing" is the whole claim, so assert it rather than implying it
    // from the state: content intact, no backup beside it, worktree still clean.
    expect(await fs.readFile(operatorHook, "utf8")).toBe(operatorBody);
    expect(await fs.readdir(trackedHooks)).toEqual(["pre-receive"]);
    const status = await git(["status", "--porcelain", "--untracked-files=all"], base);
    expect(status.stdout.trim()).toBe("");

    // Idempotent: a second provision must not start accumulating backups or
    // dirtying the tree either. This is the pass that would have walked the
    // budget under the displacement behaviour.
    const second = await ensureManagedCheckoutRejectsPushes({ cwd: base });
    expect(second.state).toBe("install_failed");
    expect(await fs.readdir(trackedHooks)).toEqual(["pre-receive"]);

    // The honest cost of declining, stated as a test so it cannot be forgotten:
    // this checkout still accepts pushes. #1616 is what stops runs reaching it.
    const run = await createRunWorkspace(base);
    await git(["push", base, "HEAD:refs/heads/probe-tracked-decline"], run); // paperclip:allow-git-push: asserting the documented residual gap
    expect(await refExists(base, "refs/heads/probe-tracked-decline")).toBe(true);
  });

  it("writes into an ABSOLUTE in-tree hooks dir with no config write at all", async () => {
    // Same convention, already spelled absolutely: nothing is ambiguous, so the
    // guard installs in place and touches no configuration.
    const base = await createUnguardedBase();
    const trackedHooks = path.join(base, ".githooks");
    await fs.mkdir(trackedHooks, { recursive: true });
    await git(["config", "core.hooksPath", trackedHooks], base);
    const run = await createRunWorkspace(base);

    const result = await ensureManagedCheckoutRejectsPushes({ cwd: base });
    expect(result.state).toBe("installed");
    expect(result.displacedHooksPath).toBeNull();
    expect(result.normalizedHooksPath).toBeNull();
    expect(result.warning).toBeNull();
    expect(result.hookPath).toBe(path.join(trackedHooks, "pre-receive"));
    expect((await git(["config", "--get", "core.hooksPath"], base)).stdout.trim()).toBe(trackedHooks);

    await gitExpectFailure(["push", base, "HEAD:refs/heads/probe-abs-tracked"], run);
    expect(await refExists(base, "refs/heads/probe-abs-tracked")).toBe(false);
  });

  it("keeps reporting an EARLIER displacement once core.hooksPath points at us", async () => {
    // A takeover erases its own evidence from the placement computation: on the
    // next pass core.hooksPath is an absolute path under the common dir, so the
    // dir reads as repo-owned and the result would say nothing was displaced --
    // while the checkout is still displaced. The single warning at takeover time
    // would then be an operator's only notice, ever.
    const base = await createUnguardedBase();
    const globalHooks = path.join(root, `global-hooks-carry-${counter++}`);
    await fs.mkdir(globalHooks, { recursive: true });
    const globalConfig = path.join(root, `gitconfig-carry-${counter++}`);
    await fs.writeFile(globalConfig, `[core]\n\thooksPath = ${globalHooks}\n`, "utf8");
    process.env.GIT_CONFIG_GLOBAL = globalConfig;

    const first = await ensureManagedCheckoutRejectsPushes({ cwd: base });
    expect(first.state).toBe("installed");
    expect(first.displacedHooksPath).toBe(globalHooks);

    const second = await ensureManagedCheckoutRejectsPushes({ cwd: base });
    // Converged -- the state describes what THIS call changed, which is nothing.
    expect(second.state).toBe("already_installed");
    // ...but the payload stays truthful about what is still displaced.
    expect(second.displacedHooksPath).toBe(globalHooks);
    // Converged means quiet: the warning is not repeated on every heartbeat.
    expect(second.warning).toBeNull();
  });

  it("keeps the base able to serve clones (BLO-31351 is not regressed)", async () => {
    const base = await createUnguardedBase();
    await ensureManagedCheckoutRejectsPushes({ cwd: base });

    const shared = path.join(root, `clone-shared-${counter++}`);
    await git(["clone", "--shared", base, shared], root);
    expect((await git(["rev-parse", "HEAD"], shared)).stdout.trim()).toMatch(/^[0-9a-f]{40}$/);

    // `file://` too: a plain local clone hardlinks objects and never invokes
    // `upload-pack`, so it cannot witness a broken server side. This is the
    // transport BLO-31351's guard exists for.
    const overFileUrl = path.join(root, `clone-file-${counter++}`);
    await git(["clone", `file://${base}`, overFileUrl], root);
    expect((await git(["rev-parse", "HEAD"], overFileUrl)).stdout.trim()).toMatch(/^[0-9a-f]{40}$/);
  });

  it("leaves legitimate server-side writes to the base unaffected", async () => {
    const base = await createUnguardedBase();
    const run = await createRunWorkspace(base);
    await ensureManagedCheckoutRejectsPushes({ cwd: base });

    // `ensureCheckoutGitIdentity`'s writes (BLO-23894).
    await git(["config", "user.email", "bot@paperclip.invalid"], base);
    expect((await git(["config", "--get", "user.email"], base)).stdout.trim()).toBe("bot@paperclip.invalid");

    // A fetch INTO the base writes refs without going through `receive-pack`.
    await git(["remote", "add", "run", run], base);
    await git(["fetch", "run"], base);
    expect(await refExists(base, "refs/remotes/run/main")).toBe(true);

    // Worktree provisioning, the strategy this project actually uses.
    const worktree = path.join(root, `worktree-${counter++}`);
    await git(["worktree", "add", "-b", "wt-probe", worktree], base);
    expect((await git(["rev-parse", "HEAD"], worktree)).stdout.trim()).toMatch(/^[0-9a-f]{40}$/);
  });

  it("refuses updates and deletes of existing refs, so no anchored ref can be lost", async () => {
    // AC6: `refs/preserved/blo-31282-base-dirty` anchors unreviewed work in a
    // real base checkout, so ref destruction is the failure that cannot happen.
    const base = await createUnguardedBase();
    const run = await createRunWorkspace(base);
    await git(["update-ref", "refs/preserved/anchored", "HEAD"], base);
    const anchoredBefore = (await git(["rev-parse", "refs/preserved/anchored"], base)).stdout.trim();

    await ensureManagedCheckoutRejectsPushes({ cwd: base });

    await gitExpectFailure(["push", base, "HEAD:refs/heads/main"], run);
    await gitExpectFailure(["push", "--force", base, "HEAD:refs/heads/main"], run);
    await gitExpectFailure(["push", base, ":refs/preserved/anchored"], run);

    expect(await refExists(base, "refs/preserved/anchored")).toBe(true);
    expect((await git(["rev-parse", "refs/preserved/anchored"], base)).stdout.trim()).toBe(anchoredBefore);
    // The guard installs no refs and rewrites none.
    expect((await git(["rev-parse", "refs/heads/main"], base)).stdout.trim()).toBe(anchoredBefore);
  });

  it("rewrites a stale or tampered hook rather than accepting it", async () => {
    const base = await createUnguardedBase();
    const run = await createRunWorkspace(base);
    const first = await ensureManagedCheckoutRejectsPushes({ cwd: base });

    // Someone defanging the guard by replacing the file wholesale. Because the
    // replacement carries no ownership marker it is treated as foreign and
    // preserved rather than destroyed -- but the guard is still reinstated, so
    // the security property (a defanged guard does not survive a provision) is
    // unchanged. The preserved copy is asserted in the foreign-hook test below.
    await fs.writeFile(first.hookPath!, "#!/bin/sh\nexit 0\n", { encoding: "utf8", mode: 0o755 });
    const refreshed = await ensureManagedCheckoutRejectsPushes({ cwd: base });
    expect(refreshed.state).toBe("installed");
    expect(await fs.readFile(first.hookPath!, "utf8")).toBe(PUSH_GUARD_HOOK);

    await gitExpectFailure(["push", base, "HEAD:refs/heads/probe-stale"], run);
    expect(await refExists(base, "refs/heads/probe-stale")).toBe(false);
  });

  it("refreshes a marker-bearing older guard IN PLACE, leaving no backup behind", async () => {
    // The reason PUSH_GUARD_HOOK_MARKER carries no version. A previous guard
    // version is still *ours*, so bumping PUSH_GUARD_HOOK_VERSION must refresh
    // it in place. If the marker were version-stamped, every checkout on the
    // fleet would sprout a `.paperclip-displaced` backup on the next provision.
    //
    // Asserted directly, because the behavioural half below can only catch a
    // version-stamped marker if its fixture is independent of the constant.
    expect(PUSH_GUARD_HOOK_MARKER).not.toMatch(/v\d/);

    const base = await createUnguardedBase();
    const run = await createRunWorkspace(base);
    const first = await ensureManagedCheckoutRejectsPushes({ cwd: base });

    // Deliberately a LITERAL rather than interpolating PUSH_GUARD_HOOK_MARKER: a
    // fixture built from the constant under test moves with it, so stamping the
    // marker would also stamp the fixture and this test would pass either way.
    // The version here must differ from PUSH_GUARD_HOOK_VERSION for that reason.
    const olderGuard =
      "#!/bin/sh\n# paperclip-push-guard v0 -- installed by Paperclip (BLO-31555). Do not edit.\nexit 1\n";
    await fs.writeFile(first.hookPath!, olderGuard, { encoding: "utf8", mode: 0o755 });

    const refreshed = await ensureManagedCheckoutRejectsPushes({ cwd: base });
    expect(refreshed.state).toBe("installed");
    expect(refreshed.displacedHookPath).toBeNull();
    expect(await fs.readFile(first.hookPath!, "utf8")).toBe(PUSH_GUARD_HOOK);
    await expect(fs.stat(`${first.hookPath!}${PUSH_GUARD_DISPLACED_HOOK_SUFFIX}`)).rejects.toThrow();

    await gitExpectFailure(["push", base, "HEAD:refs/heads/probe-older-guard"], run);
    expect(await refExists(base, "refs/heads/probe-older-guard")).toBe(false);
  });

  it("preserves an operator's own pre-receive instead of destroying it", async () => {
    // Default `git init`/`clone` templates ship `pre-receive.sample`, never
    // `pre-receive`, so a real file here is operator-installed. Overwriting it
    // would be silent and irreversible -- the one failure mode this module must
    // not have, since it runs unattended on every provisioning pass.
    const base = await createUnguardedBase();
    const run = await createRunWorkspace(base);

    const operatorHook = "#!/bin/sh\n# operator policy: audit inbound refs\necho audited >&2\nexit 0\n";
    const hooksDir = path.join(base, ".git", "hooks");
    await fs.mkdir(hooksDir, { recursive: true });
    const hookPath = path.join(hooksDir, "pre-receive");
    await fs.writeFile(hookPath, operatorHook, { encoding: "utf8", mode: 0o755 });

    const result = await ensureManagedCheckoutRejectsPushes({ cwd: base });
    expect(result.state).toBe("installed");
    expect(result.hookPath).toBe(hookPath);

    // Moved aside, byte-for-byte, and reported rather than silently dropped.
    const backup = `${hookPath}${PUSH_GUARD_DISPLACED_HOOK_SUFFIX}`;
    expect(result.displacedHookPath).toBe(backup);
    expect(await fs.readFile(backup, "utf8")).toBe(operatorHook);
    expect(result.warning).toContain("non-Paperclip");

    // ...and the guard is genuinely the hook git now runs.
    expect(await fs.readFile(hookPath, "utf8")).toBe(PUSH_GUARD_HOOK);
    await gitExpectFailure(["push", base, "HEAD:refs/heads/probe-operator-hook"], run);
    expect(await refExists(base, "refs/heads/probe-operator-hook")).toBe(false);
  });

  it("declines to install rather than overwrite an exhausted backup budget", async () => {
    // `fs.rename` overwrites, so reusing an occupied backup name would destroy
    // an EARLIER displaced hook. When there is nowhere safe left to put it, the
    // operator's file wins: this guard is defence-in-depth (BLO-31359's fix
    // already closed the path runs took) and never outranks operator intent.
    const base = await createUnguardedBase();
    const hooksDir = path.join(base, ".git", "hooks");
    await fs.mkdir(hooksDir, { recursive: true });
    const hookPath = path.join(hooksDir, "pre-receive");
    const operatorHook = "#!/bin/sh\n# operator policy\nexit 0\n";
    await fs.writeFile(hookPath, operatorHook, { encoding: "utf8", mode: 0o755 });

    // Exactly the names reserveDisplacedHookPath() reserves: the unnumbered one
    // plus `.1`..`.MAX-1`, MAX in total. Occupying one FEWER must still SUCCEED,
    // and that half is what pins the loop bound -- a test that only over-fills
    // passes just as happily against an off-by-one budget.
    const backupName = (index: number) =>
      index === 0
        ? `${hookPath}${PUSH_GUARD_DISPLACED_HOOK_SUFFIX}`
        : `${hookPath}${PUSH_GUARD_DISPLACED_HOOK_SUFFIX}.${index}`;
    for (let index = 0; index < PUSH_GUARD_MAX_DISPLACED_HOOK_BACKUPS - 1; index += 1) {
      await fs.writeFile(backupName(index), `old-${index}\n`, "utf8");
    }

    // One slot left: the guard installs and consumes it.
    const spare = await ensureManagedCheckoutRejectsPushes({ cwd: base });
    expect(spare.state).toBe("installed");
    expect(spare.displacedHookPath).toBe(backupName(PUSH_GUARD_MAX_DISPLACED_HOOK_BACKUPS - 1));
    expect(await fs.readFile(spare.displacedHookPath!, "utf8")).toBe(operatorHook);

    // Re-arm with every slot now taken.
    await fs.writeFile(hookPath, operatorHook, { encoding: "utf8", mode: 0o755 });
    const result = await ensureManagedCheckoutRejectsPushes({ cwd: base });
    expect(result.state).toBe("install_failed");
    expect(result.warning).toContain("declined");
    // Nothing touched: neither the live hook nor any existing backup.
    expect(await fs.readFile(hookPath, "utf8")).toBe(operatorHook);
    expect(await fs.readFile(backupName(0), "utf8")).toBe("old-0\n");
  });

  it("materializes the receive.* keys locally even when a global config already sets them", async () => {
    // These keys exist so ref protection survives the hook file being deleted
    // (AC6). That only holds if they live in config the CHECKOUT owns: an
    // inherited global value belongs to the host, and a different pod or image
    // need not carry it. An idempotency read that resolves across scopes sees
    // the global value, concludes "already set", and writes nothing -- leaving
    // the durability property claimed but absent.
    const base = await createUnguardedBase();

    const globalConfig = path.join(root, `gitconfig-receive-${counter++}`);
    await fs.writeFile(
      globalConfig,
      `[receive]\n${PUSH_GUARD_RECEIVE_CONFIG.map(([key, value]) => `\t${key.replace(/^receive\./, "")} = ${value}`).join("\n")}\n`,
      "utf8",
    );
    process.env.GIT_CONFIG_GLOBAL = globalConfig;

    // Control: the values really are visible from the effective scope already,
    // so this test cannot pass just because the global config failed to load.
    for (const [key, value] of PUSH_GUARD_RECEIVE_CONFIG) {
      expect((await git(["config", "--get", key], base)).stdout.trim()).toBe(value);
    }

    await ensureManagedCheckoutRejectsPushes({ cwd: base });

    for (const [key, value] of PUSH_GUARD_RECEIVE_CONFIG) {
      const local = await git(["config", "--local", "--get", key], base);
      expect(local.stdout.trim()).toBe(value);
    }
  });

  it("is a no-op on a path that is not a checkout, without walking up to an ancestor repo", async () => {
    // `git` resolves upward from its cwd, so a bare directory nested under a
    // repository would otherwise be "guarded" by writing into that ancestor.
    const base = await createUnguardedBase();
    const nested = path.join(base, "not-a-checkout");
    await fs.mkdir(nested, { recursive: true });

    const result = await ensureManagedCheckoutRejectsPushes({ cwd: nested });
    expect(result.state).toBe("not_a_checkout");
    expect(result.hookPath).toBeNull();

    const ancestorHook = path.join(base, ".git", "hooks", "pre-receive");
    await expect(fs.stat(ancestorHook)).rejects.toThrow();
  });

  it("degrades to a warning rather than throwing when git is unusable", async () => {
    // Hardening on a provisioning path must never take a run down: a checkout
    // that cannot be guarded is strictly better than a run that cannot start.
    const base = await createUnguardedBase();
    const result = await ensureManagedCheckoutRejectsPushes({
      cwd: base,
      runGit: async () => {
        throw Object.assign(new Error("git exploded"), { code: 128 });
      },
    });
    expect(result.state).toBe("install_failed");
    expect(result.warning).toContain("could not resolve its git directory");
  });
});
