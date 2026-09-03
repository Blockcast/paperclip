import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyAgentGitIdentityToRuntimeConfig,
  buildAgentGitIdentityEnv,
  buildAgentGitIdentity,
  ensureCheckoutGitIdentity,
  isPaperclipProvisionedAuthorEmail,
  isSharedAppAuthorEmail,
  PAPERCLIP_AGENT_EMAIL_DOMAIN,
  SHARED_APP_AUTHOR_EMAILS,
} from "../services/git-checkout-identity.ts";

const SERVICES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "services");

const APP_EMAIL_NUMERIC = "290875700+allyblockcast[bot]@users.noreply.github.com";
const APP_EMAIL_BARE = "allyblockcast[bot]@users.noreply.github.com";

const tempRoots = new Set<string>();

afterEach(() => {
  for (const root of tempRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  tempRoots.clear();
});

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pc-git-identity-"));
  tempRoots.add(root);
  return root;
}

function git(args: string[], cwd: string, env?: Record<string, string>): string {
  return execFileSync("git", args, {
    cwd,
    env: env ? { ...process.env, ...env } : undefined,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  }).trim();
}

/**
 * Real `git` behind the module's runner seam, recording every invocation so a
 * test can assert that no *write* happened, not merely that the reported status
 * said so.
 */
function recordingGit(calls: string[][]) {
  return async (args: string[], cwd: string) => {
    calls.push(args);
    return git(args, cwd);
  };
}

/** A checkout with no local `user.name`/`user.email`, plus one commit. */
function initRepo(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  git(["init", "-b", "main"], dir);
  // Seeded via -c so the commit does not persist an identity into the config
  // under test. gpgsign is forced off so a signing-by-default host still works.
  git(
    [
      "-c", "user.email=seed@example.invalid",
      "-c", "user.name=Seed",
      "-c", "commit.gpgsign=false",
      "commit", "--allow-empty", "-m", "init",
    ],
    dir,
  );
  return dir;
}

function readLocal(cwd: string, key: string): string | null {
  try {
    return git(["config", "--local", "--get", key], cwd) || null;
  } catch {
    return null;
  }
}

const AGENT = { id: "3f3c1d1e-0b1b-4a1a-8a1a-0b1b4a1a8a1a", name: "Platform SRE Engineer" };
const AGENT_EMAIL = `platform-sre-engineer@${PAPERCLIP_AGENT_EMAIL_DOMAIN}`;

describe("buildAgentGitIdentity", () => {
  it("derives the email local part from the agent url key", () => {
    expect(buildAgentGitIdentity(AGENT)).toEqual({
      email: AGENT_EMAIL,
      name: "Platform SRE Engineer",
    });
  });

  it("falls back to the agent id when the name normalizes to nothing", () => {
    // normalizeAgentUrlKey("***") is null, so a naive template would produce a
    // malformed "@paperclip.blockcast.net" with an empty local part.
    const identity = buildAgentGitIdentity({ id: AGENT.id, name: "***" });
    expect(identity.email).toBe(`${AGENT.id}@${PAPERCLIP_AGENT_EMAIL_DOMAIN}`);
    expect(identity.email.startsWith("@")).toBe(false);
    expect(identity.name).toBe("***");
  });

  it("falls back to the literal agent key when neither name nor id normalizes", () => {
    const identity = buildAgentGitIdentity({ id: null, name: "!!!" });
    expect(identity.email).toBe(`agent@${PAPERCLIP_AGENT_EMAIL_DOMAIN}`);
    expect(identity.name).toBe("!!!");
  });

  it("strips ident delimiters and a leading dash from the author name", () => {
    // "<" / ">" would corrupt the `Name <email>` header, and a leading "-" would
    // be consumed by `git config` as an option instead of a value.
    expect(buildAgentGitIdentity({ id: AGENT.id, name: "--Ally <bot>" }).name).toBe("Ally bot");
    expect(buildAgentGitIdentity({ id: AGENT.id, name: "  --Ally" }).name).toBe("Ally");
  });

  it("keeps digits in the author name", () => {
    // Regression guard: a `[<space>-<]` character class silently covers 0-9.
    expect(buildAgentGitIdentity({ id: AGENT.id, name: "Agent 007" }).name).toBe("Agent 007");
  });
});

describe("isSharedAppAuthorEmail", () => {
  it("matches both App forms, case-insensitively", () => {
    for (const email of SHARED_APP_AUTHOR_EMAILS) {
      expect(isSharedAppAuthorEmail(email)).toBe(true);
      expect(isSharedAppAuthorEmail(email.toUpperCase())).toBe(true);
    }
  });

  it("does not match a per-agent address", () => {
    expect(isSharedAppAuthorEmail(AGENT_EMAIL)).toBe(false);
    expect(isSharedAppAuthorEmail(null)).toBe(false);
  });
});

describe("isPaperclipProvisionedAuthorEmail", () => {
  it("matches addresses in paperclip's own namespace, case-insensitively", () => {
    expect(isPaperclipProvisionedAuthorEmail(AGENT_EMAIL)).toBe(true);
    expect(isPaperclipProvisionedAuthorEmail(AGENT_EMAIL.toUpperCase())).toBe(true);
    expect(isPaperclipProvisionedAuthorEmail(`  ${AGENT_EMAIL}  `)).toBe(true);
  });

  it("does not match a human address, the App forms, or a lookalike domain", () => {
    expect(isPaperclipProvisionedAuthorEmail("omar@blockcast.net")).toBe(false);
    expect(isPaperclipProvisionedAuthorEmail(APP_EMAIL_NUMERIC)).toBe(false);
    expect(isPaperclipProvisionedAuthorEmail(null)).toBe(false);
    // The suffix is anchored on "@", so a domain that merely *ends* with the
    // literal does not read as paperclip-owned and keeps its identity.
    expect(isPaperclipProvisionedAuthorEmail("a@evil-paperclip.blockcast.net")).toBe(false);
    expect(isPaperclipProvisionedAuthorEmail("a@sub.paperclip.blockcast.net")).toBe(false);
  });
});

describe("per-run git identity environment", () => {
  it("overrides every user-supplied Git identity value", () => {
    const result = applyAgentGitIdentityToRuntimeConfig({
      runtimeConfig: {
        env: {
          GIT_AUTHOR_NAME: "attacker",
          GIT_AUTHOR_EMAIL: "attacker@example.invalid",
          GIT_COMMITTER_NAME: "attacker",
          GIT_COMMITTER_EMAIL: "attacker@example.invalid",
          KEEP: "yes",
        },
      },
      agent: AGENT,
    });

    expect(result.env).toEqual({
      ...buildAgentGitIdentityEnv(AGENT),
      KEEP: "yes",
    });
  });

  it("creates an independent commit identity even when checkout config is foreign", () => {
    expect(buildAgentGitIdentityEnv(AGENT)).toEqual({
      GIT_AUTHOR_NAME: AGENT.name,
      GIT_AUTHOR_EMAIL: AGENT_EMAIL,
      GIT_COMMITTER_NAME: AGENT.name,
      GIT_COMMITTER_EMAIL: AGENT_EMAIL,
    });
  });
});

describe("ensureCheckoutGitIdentity", () => {
  it("sets an unset local identity", async () => {
    const repo = initRepo(path.join(makeTempRoot(), "repo"));
    expect(readLocal(repo, "user.email")).toBeNull();

    const result = await ensureCheckoutGitIdentity({ cwd: repo, agent: AGENT });

    expect(result.status).toBe("updated");
    expect(result.previousEmail).toBeNull();
    expect(result.warning).toBeNull();
    expect(readLocal(repo, "user.email")).toBe(AGENT_EMAIL);
    expect(readLocal(repo, "user.name")).toBe("Platform SRE Engineer");
  });

  it.each([
    ["numeric-prefixed App email", APP_EMAIL_NUMERIC],
    ["bare App email", APP_EMAIL_BARE],
  ])("corrects a checkout stamped with the %s", async (_label, appEmail) => {
    const repo = initRepo(path.join(makeTempRoot(), "repo"));
    git(["config", "--local", "user.email", appEmail], repo);
    git(["config", "--local", "user.name", "allyblockcast[bot]"], repo);

    const result = await ensureCheckoutGitIdentity({ cwd: repo, agent: AGENT });

    expect(result.status).toBe("updated");
    expect(result.previousEmail).toBe(appEmail);
    expect(readLocal(repo, "user.email")).toBe(AGENT_EMAIL);
    expect(readLocal(repo, "user.name")).toBe("Platform SRE Engineer");
  });

  it("leaves an already-correct identity alone and writes nothing", async () => {
    const repo = initRepo(path.join(makeTempRoot(), "repo"));
    git(["config", "--local", "user.email", AGENT_EMAIL], repo);
    git(["config", "--local", "user.name", AGENT.name], repo);
    const before = fs.readFileSync(path.join(repo, ".git", "config"), "utf8");

    const calls: string[][] = [];
    const result = await ensureCheckoutGitIdentity({
      cwd: repo,
      agent: AGENT,
      runGit: recordingGit(calls),
    });

    expect(result.status).toBe("unchanged");
    expect(calls.every((args) => args.includes("--get"))).toBe(true);
    expect(fs.readFileSync(path.join(repo, ".git", "config"), "utf8")).toBe(before);
  });

  it("is idempotent across repeated provisioning", async () => {
    const repo = initRepo(path.join(makeTempRoot(), "repo"));

    const first = await ensureCheckoutGitIdentity({ cwd: repo, agent: AGENT });
    const second = await ensureCheckoutGitIdentity({ cwd: repo, agent: AGENT });

    expect(first.status).toBe("updated");
    expect(second.status).toBe("unchanged");
    expect(readLocal(repo, "user.email")).toBe(AGENT_EMAIL);
  });

  it("re-points a checkout stamped with a different agent's identity", async () => {
    // A managed project workspace is shared across a company's agents, and the
    // agent about to run is the one that will commit from it. Safe to rewrite
    // because the address sits in paperclip's own namespace -- we wrote it.
    const repo = initRepo(path.join(makeTempRoot(), "repo"));
    git(["config", "--local", "user.email", `someone-else@${PAPERCLIP_AGENT_EMAIL_DOMAIN}`], repo);
    git(["config", "--local", "user.name", "Someone Else"], repo);

    const result = await ensureCheckoutGitIdentity({ cwd: repo, agent: AGENT });

    expect(result.status).toBe("updated");
    expect(readLocal(repo, "user.email")).toBe(AGENT_EMAIL);
  });

  it("leaves a human's identity alone and writes nothing", async () => {
    // The `project_primary` strategy runs the agent directly in the project
    // checkout, and `git config --local` inside a linked worktree resolves to
    // the parent repository's config -- so an unconditional rewrite would
    // silently retarget a developer's `user.email` repo-wide. Only unset, the
    // App forms, and paperclip's own namespace are ours to overwrite.
    const repo = initRepo(path.join(makeTempRoot(), "repo"));
    git(["config", "--local", "user.email", "omar@blockcast.net"], repo);
    git(["config", "--local", "user.name", "Omar Ramadan"], repo);
    const before = fs.readFileSync(path.join(repo, ".git", "config"), "utf8");

    const calls: string[][] = [];
    const result = await ensureCheckoutGitIdentity({
      cwd: repo,
      agent: AGENT,
      runGit: recordingGit(calls),
    });

    expect(result.status).toBe("skipped_foreign_identity");
    expect(result.previousEmail).toBe("omar@blockcast.net");
    // A deliberate policy outcome, not a failure: nothing to surface to the run.
    expect(result.warning).toBeNull();
    expect(calls.every((args) => args.includes("--get"))).toBe(true);
    expect(fs.readFileSync(path.join(repo, ".git", "config"), "utf8")).toBe(before);
  });

  it("still corrects an App-stamped checkout whose user.name is a human's", async () => {
    // Ownership is decided on the email alone. A half-configured checkout --
    // App email, leftover human name -- is still a misattributing checkout.
    const repo = initRepo(path.join(makeTempRoot(), "repo"));
    git(["config", "--local", "user.email", APP_EMAIL_NUMERIC], repo);
    git(["config", "--local", "user.name", "Omar Ramadan"], repo);

    const result = await ensureCheckoutGitIdentity({ cwd: repo, agent: AGENT });

    expect(result.status).toBe("updated");
    expect(readLocal(repo, "user.email")).toBe(AGENT_EMAIL);
    expect(readLocal(repo, "user.name")).toBe("Platform SRE Engineer");
  });

  it("does not write shared config for a linked worktree, whose .git is a FILE", async () => {
    const root = makeTempRoot();
    const repo = initRepo(path.join(root, "repo"));
    const worktree = path.join(root, "wt");
    git(["worktree", "add", "-b", "feature", worktree, "main"], repo);
    expect(fs.lstatSync(path.join(worktree, ".git")).isFile()).toBe(true);
    expect(fs.lstatSync(path.join(worktree, ".git")).isDirectory()).toBe(false);

    git(["config", "--local", "user.email", "developer@example.invalid"], repo);
    git(["config", "--local", "user.name", "Developer"], repo);
    const result = await ensureCheckoutGitIdentity({ cwd: worktree, agent: AGENT });

    // An isDirectory()-only probe would report "skipped_no_git" here, which is
    // exactly how the git_worktree strategy's checkouts went unprovisioned.
    expect(result.status).toBe("skipped_linked_worktree");
    expect(readLocal(worktree, "user.email")).toBe("developer@example.invalid");
    expect(readLocal(repo, "user.email")).toBe("developer@example.invalid");

    git(
      ["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "agent identity"],
      worktree,
      buildAgentGitIdentityEnv(AGENT),
    );
    expect(git(["show", "-s", "--format=%an <%ae> / %cn <%ce>"], worktree)).toBe(
      "Platform SRE Engineer <platform-sre-engineer@paperclip.blockcast.net> / Platform SRE Engineer <platform-sre-engineer@paperclip.blockcast.net>",
    );
  });

  it("is a no-op for a repo-less directory, and does not write an ancestor's config", async () => {
    // The hazard the git-metadata gate exists for: `git config` discovers
    // upwards, so provisioning a plain directory nested in a repository would
    // silently stamp that repository instead.
    const root = makeTempRoot();
    const ancestor = initRepo(path.join(root, "ancestor"));
    const plainDir = path.join(ancestor, "managed", "workspace");
    fs.mkdirSync(plainDir, { recursive: true });

    const calls: string[][] = [];
    const result = await ensureCheckoutGitIdentity({
      cwd: plainDir,
      agent: AGENT,
      runGit: recordingGit(calls),
    });

    expect(result.status).toBe("skipped_no_git");
    expect(result.warning).toBeNull();
    expect(calls).toEqual([]);
    expect(readLocal(ancestor, "user.email")).toBeNull();
  });

  it("is a no-op for a missing path and for an empty cwd", async () => {
    const missing = path.join(makeTempRoot(), "nope");
    await expect(
      ensureCheckoutGitIdentity({ cwd: missing, agent: AGENT }),
    ).resolves.toMatchObject({ status: "skipped_no_git", warning: null });
    await expect(
      ensureCheckoutGitIdentity({ cwd: "   ", agent: AGENT }),
    ).resolves.toMatchObject({ status: "skipped_no_git", warning: null });
  });

  it("skips rather than stamping a placeholder when there is no agent", async () => {
    const repo = initRepo(path.join(makeTempRoot(), "repo"));

    await expect(
      ensureCheckoutGitIdentity({ cwd: repo, agent: null }),
    ).resolves.toMatchObject({ status: "skipped_no_agent" });
    await expect(
      ensureCheckoutGitIdentity({ cwd: repo, agent: { id: null, name: "  " } }),
    ).resolves.toMatchObject({ status: "skipped_no_agent" });
    expect(readLocal(repo, "user.email")).toBeNull();
  });

  it("reports a warning instead of throwing when the write fails", async () => {
    const repo = initRepo(path.join(makeTempRoot(), "repo"));

    const result = await ensureCheckoutGitIdentity({
      cwd: repo,
      agent: AGENT,
      runGit: async (args, cwd) => {
        if (!args.includes("--get")) throw new Error("could not lock config file");
        return git(args, cwd);
      },
    });

    expect(result.status).toBe("failed");
    expect(result.warning).toContain("could not lock config file");
    expect(result.warning).toContain(AGENT_EMAIL);
  });
});

/**
 * The provisioning call sites are structural invariants, not behavior a unit
 * test can reach: `ensureManagedProjectWorkspace`'s inner resolver and
 * `provisionExecutionWorktree` are both module-private, and driving them for
 * real needs a full heartbeat run. These guards encode the property that made
 * BLO-23894 possible in the first place -- a return path that skips
 * provisioning -- so adding one fails loudly here instead of silently shipping
 * unstamped checkouts.
 */
describe("provisioning call-site invariants", () => {
  function readService(name: string): string {
    return fs.readFileSync(path.join(SERVICES_DIR, name), "utf8");
  }

  function countOccurrences(haystack: string, needle: string): number {
    return haystack.split(needle).length - 1;
  }

  it("routes every managed-workspace return through the identity wrapper", () => {
    const source = readService("heartbeat.ts");

    // Declaration plus exactly one call: the wrapper. A second caller would be a
    // path whose early returns bypass identity provisioning.
    expect(countOccurrences(source, "resolveManagedProjectWorkspaceCheckout(")).toBe(2);

    const wrapperStart = source.indexOf("async function ensureManagedProjectWorkspace(");
    expect(wrapperStart).toBeGreaterThan(-1);
    const wrapperBody = source.slice(wrapperStart, wrapperStart + 1200);
    expect(wrapperBody).toContain("resolveManagedProjectWorkspaceCheckout(input)");
    expect(wrapperBody).toContain("ensureCheckoutGitIdentity({");
  });

  it("routes every managed-workspace return through the partial-clone guard (BLO-31351)", () => {
    // Same invariant, same reason. Paperclip never *creates* a partial mirror --
    // the managed clone passes no `--filter` -- it adopts whatever already sits
    // at the managed path, and the `.git`-already-exists return is the one that
    // matters. A guard placed after the clone would only ever inspect the one
    // checkout that cannot be partial, which is how this reached production.
    const source = readService("heartbeat.ts");
    const wrapperStart = source.indexOf("async function ensureManagedProjectWorkspace(");
    expect(wrapperStart).toBeGreaterThan(-1);
    const wrapperBody = source.slice(wrapperStart, wrapperStart + 2400);

    expect(wrapperBody).toContain("ensureManagedCheckoutCanServeClones({");
    // A mirror that cannot serve must fail as a workspace validation failure,
    // not as a bare Error: that specific cause is the one the recovery machinery
    // treats as manual-repair and exempts from the wake-attempt budget. A plain
    // throw here would burn attempts on a cause no retry can move.
    expect(wrapperBody).toContain("partial_cannot_serve");
    expect(wrapperBody).toContain("new WorkspaceValidationFailure(");
    expect(wrapperBody).toContain("managed_checkout_partial_clone_unservable");
  });

  it("does not let the realization loop swallow a WorkspaceValidationFailure (BLO-31351)", () => {
    // Ally's Critical finding on PR #1611, and the reason the assertion above is
    // not sufficient on its own: it greps for the *throw*, which is satisfied by
    // a throw nobody lets out. `ensureManagedProjectWorkspace` has two callers.
    // The repo-less one propagates; the repo-backed one sits inside the
    // `realizationCandidates` loop behind `catch { ...; continue; }`, and the
    // fall-through below that loop ends at `resolveDefaultAgentWorkspaceDir` --
    // an EMPTY per-agent directory. Swallowing an unservable-mirror failure
    // there runs the agent to completion against the wrong tree and records no
    // `workspace_validation_failed` cause at all, which is strictly worse than
    // the pre-guard behaviour of failing loudly at clone time.
    const source = readService("heartbeat.ts");
    const loopStart = source.indexOf("for (const workspace of realizationCandidates) {");
    expect(loopStart).toBeGreaterThan(-1);
    const loopBody = source.slice(loopStart, loopStart + 4000);

    expect(loopBody).toContain("ensureManagedProjectWorkspace({");
    // The rethrow must sit before the warning/continue, or the typed failure and
    // its whole workspaceValidation evidence payload are lost to the fall-through.
    const rethrowIndex = loopBody.indexOf("if (error instanceof WorkspaceValidationFailure) throw error;");
    expect(rethrowIndex).toBeGreaterThan(-1);
    expect(rethrowIndex).toBeLessThan(loopBody.indexOf("continue;"));
  });

  it("keeps the managed clone free of any object filter (BLO-31351)", () => {
    // The guard above exists because this clone is a full clone. If a `--filter`
    // or `--depth` is ever added here, Paperclip starts *manufacturing* the
    // partial mirrors it currently only adopts, and every execution-workspace
    // clone from one becomes a fake "repository corruption" failure.
    const source = readService("heartbeat.ts");
    const cloneIndex = source.indexOf('await execFile("git", ["clone"');
    expect(cloneIndex).toBeGreaterThan(-1);
    const cloneCall = source.slice(cloneIndex, cloneIndex + 200);
    expect(cloneCall).not.toContain("--filter");
    expect(cloneCall).not.toContain("--depth");
  });

  it("provisions identity inside the worktree funnel, before the provision-command early return", () => {
    const source = readService("workspace-runtime.ts");
    const funnelStart = source.indexOf("async function provisionExecutionWorktree(");
    expect(funnelStart).toBeGreaterThan(-1);

    const identityAt = source.indexOf("ensureCheckoutGitIdentity({", funnelStart);
    const earlyReturnAt = source.indexOf("if (!provisionCommand) return", funnelStart);
    expect(identityAt).toBeGreaterThan(-1);
    expect(earlyReturnAt).toBeGreaterThan(-1);
    expect(identityAt).toBeLessThan(earlyReturnAt);
  });

  it("stamps identity on the project_primary strategy, which bypasses the worktree funnel", () => {
    const source = readService("workspace-runtime.ts");

    // `project_primary` is the DEFAULT strategy and returns a checkout without
    // ever calling provisionExecutionWorktree, so it needs its own seam. Three
    // call sites: realizeExecutionWorkspace's non-worktree return, and
    // ensurePersistedExecutionWorkspaceAvailable's rebound-managed-cwd and
    // recorded-cwd returns.
    expect(source).toContain("async function stampCheckoutIdentity(");
    expect(countOccurrences(source, "stampCheckoutIdentity(")).toBeGreaterThanOrEqual(4);

    // The default must not be able to drift back to an unstamped literal return.
    const realizeStart = source.indexOf('const strategyType = asString(rawStrategy.type, "project_primary");');
    expect(realizeStart).toBeGreaterThan(-1);
    const nonWorktreeBranch = source.slice(realizeStart, realizeStart + 1600);
    expect(nonWorktreeBranch).toContain("stampCheckoutIdentity(input.base.baseCwd, input.agent)");
  });

  it("captures the funnel's warnings at every worktree call site", () => {
    const source = readService("workspace-runtime.ts");
    const calls = countOccurrences(source, "await provisionExecutionWorktree({");
    expect(calls).toBeGreaterThanOrEqual(4);
    // A call site that drops the return value also drops the warning explaining
    // why a checkout went unstamped.
    expect(countOccurrences(source, "= await provisionExecutionWorktree({")).toBe(calls);
    // And no call site may be conditional on a provision command: the reuse path
    // for an already-existing worktree is exactly the broken population.
    expect(source).not.toContain("if (provisionCommand) {");
  });
});
