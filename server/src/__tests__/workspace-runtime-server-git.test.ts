import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { resolveServerGitInvocation } from "../services/workspace-runtime.ts";

// BLO-42838 / BLO-41987. The chart publishes an agent publish-guard `git` at
// `${PAPERCLIP_HOME}/bin/git` and puts that directory ahead of /usr/bin on the
// container PATH for every process in the pod, so the server's own
// `spawn("git")` resolved to the guard. The guard admits only `submodule
// status`, which made the submodule *repair* step (`sync`, then `update
// --init`) fail with `workspace_git_submodule_unavailable` on every freshly
// created worktree of a repo with submodules. These tests pin the two
// properties the fix depends on: the real binary is actually selected, and the
// credential configuration the wrapper used to supply is carried over in the
// order that keeps it safe.

let tmpDir: string;
let fakeGit: string;
let fakeHelper: string;
const missing = path.join(os.tmpdir(), "paperclip-blo42838-does-not-exist");

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-server-git-"));
  fakeGit = path.join(tmpDir, "git");
  fakeHelper = path.join(tmpDir, "github-token-credential-helper");
  await fs.writeFile(fakeGit, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await fs.writeFile(fakeHelper, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

afterEach(() => {
  delete process.env.PAPERCLIP_SERVER_GIT;
});

describe("resolveServerGitInvocation", () => {
  it("spawns the real binary by absolute path, not the `git` the PATH resolves", () => {
    const resolved = resolveServerGitInvocation(["submodule", "update", "--init"], {
      gitBinary: fakeGit,
      credentialHelper: missing,
    });
    // The whole defect was that this said "git" and PATH chose the wrapper.
    expect(resolved.command).toBe(fakeGit);
    expect(resolved.args).toEqual(["submodule", "update", "--init"]);
  });

  it("re-supplies the credential helper the wrapper used to configure", () => {
    const resolved = resolveServerGitInvocation(["fetch", "--prune", "origin"], {
      gitBinary: fakeGit,
      credentialHelper: fakeHelper,
    });
    expect(resolved.command).toBe(fakeGit);
    // Without this the server's https fetch (refreshRemoteTrackingBaseRef)
    // loses authentication the moment it stops going through the wrapper.
    expect(resolved.args).toEqual([
      "-c",
      "credential.https://github.com.helper=",
      "-c",
      `credential.https://github.com.helper=${fakeHelper}`,
      "-c",
      "url.https://github.com/.insteadOf=ssh://git@github.com/",
      "-c",
      "url.https://github.com/.insteadOf=git@github.com:",
      "fetch",
      "--prune",
      "origin",
    ]);
  });

  it("resets the helper list before adding ours, so a repo-config helper an agent adds cannot harvest the token", () => {
    const resolved = resolveServerGitInvocation(["status"], {
      gitBinary: fakeGit,
      credentialHelper: fakeHelper,
    });
    const helperArgs = resolved.args.filter((arg) => arg.startsWith("credential.https://github.com.helper="));
    // Order is the security property, not decoration, and it is measured: git
    // consults every helper configured for the host in config order, and a
    // worktree's .git/config is agent-writable. With system and global config
    // neutralised, a repo-config helper was invoked when ours was merely
    // appended, and was not invoked once the empty assignment preceded it.
    expect(helperArgs).toHaveLength(2);
    expect(helperArgs[0]).toBe("credential.https://github.com.helper=");
    expect(helperArgs[1]).toBe(`credential.https://github.com.helper=${fakeHelper}`);
  });

  it("rewrites GitHub SSH submodule URLs to https, because the server has no SSH key (BLO-48535)", async () => {
    // Real git and a real submodule clone, because the property that matters is
    // that the `-c` rewrite reaches the CHILD clone `submodule update` spawns --
    // an argv assertion cannot show that. Every transport is forbidden, so the
    // clone fails without touching the network and its error names the
    // transport it tried: https with the rewrite, ssh without it.
    const { execFileSync, spawnSync } = await import("node:child_process");
    const { existsSync } = await import("node:fs");
    const gitBin = existsSync("/usr/bin/git") ? "/usr/bin/git" : "git";
    const git = (cwd: string, ...a: string[]) =>
      execFileSync(gitBin, ["-c", "protocol.file.allow=always", "-c", "user.name=t", "-c", "user.email=t@t", ...a], {
        cwd,
        stdio: "pipe",
      });
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-blo48535-"));
    try {
      const sub = path.join(root, "sub");
      const sup = path.join(root, "super");
      await fs.mkdir(sub);
      await fs.mkdir(sup);
      git(sub, "init", "-q");
      git(sub, "commit", "-q", "--allow-empty", "-m", "s");
      git(sup, "init", "-q");
      git(sup, "submodule", "add", "-q", sub, "sub");
      git(sup, "config", "-f", ".gitmodules", "submodule.sub.url", "ssh://git@github.com/Org/sub.git");
      git(sup, "commit", "-qam", "ssh url");
      const clone = path.join(root, "clone");
      git(root, "clone", "-q", sup, clone);
      const resolved = resolveServerGitInvocation(["submodule", "update", "--init"], {
        gitBinary: gitBin,
        credentialHelper: fakeHelper,
      });
      const run = spawnSync(gitBin, ["-c", "protocol.allow=never", ...resolved.args], { cwd: clone, encoding: "utf8" });
      expect(run.status).not.toBe(0);
      expect(run.stderr).toContain("transport 'https' not allowed");
      expect(run.stderr).not.toContain("transport 'ssh' not allowed");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("falls back to bare `git` off-image, where there is no wrapper to bypass", () => {
    const resolved = resolveServerGitInvocation(["rev-parse", "HEAD"], {
      gitBinary: missing,
      credentialHelper: missing,
    });
    expect(resolved.command).toBe("git");
    expect(resolved.args).toEqual(["rev-parse", "HEAD"]);
  });

  it("adds no credential configuration when the helper is absent", () => {
    // Bare `git` carries no credential override either -- the config would name
    // a helper path that does not exist, which git reports as a failure.
    const onPath = resolveServerGitInvocation(["fetch"], { gitBinary: missing, credentialHelper: fakeHelper });
    expect(onPath.command).toBe("git");
    expect(onPath.args).toEqual(["fetch"]);

    const noHelper = resolveServerGitInvocation(["fetch"], { gitBinary: fakeGit, credentialHelper: missing });
    expect(noHelper.args).toEqual(["fetch"]);
  });

  it("honours the PAPERCLIP_SERVER_GIT override verbatim, with no credential arguments", () => {
    process.env.PAPERCLIP_SERVER_GIT = fakeGit;
    // The helper exists here, so a non-override resolution would prefix `-c` pairs;
    // the override must not, or a test shim matching on `$1` misses on any host
    // that has the chart's helper.
    const resolved = resolveServerGitInvocation(["status"], {
      gitBinary: missing,
      credentialHelper: fakeHelper,
    });
    expect(resolved).toEqual({ command: fakeGit, args: ["status"] });
  });

  it("ignores a blank override rather than spawning an empty command", () => {
    process.env.PAPERCLIP_SERVER_GIT = "   ";
    const resolved = resolveServerGitInvocation(["status"], {
      gitBinary: missing,
      credentialHelper: missing,
    });
    expect(resolved.command).toBe("git");
  });
});

// PEN-4979. The pin above is justified by server code not publishing. That was
// held in a code comment and by convention only: two of the three call sites
// (`runGit`, `recordGitOperation`) take arbitrary args, so a future caller
// passing `push` would have got a path that is past both the agent egress
// wrapper and the pre-push hook, authenticated unprompted by the system
// credential helper, with nothing failing. These assertions are the reason that
// comment may now point at code; deleting the check must fail CI.
describe("resolveServerGitInvocation refuses to build a publishing invocation", () => {
  const paths = () => ({ gitBinary: fakeGit, credentialHelper: fakeHelper });

  it.each(["push", "send-pack", "http-push"])("refuses `git %s`", (verb) => {
    expect(() => resolveServerGitInvocation([verb, "origin", "HEAD"], paths())).toThrow(/refusing to build/);
  });

  it("refuses a publishing verb hidden behind global options, not just args[0]", () => {
    // Located with the shim's own `gitGlobalOptions`, so `-c` pairs are skipped
    // the way git skips them. Reading `args[0]` would pass this straight through.
    expect(() => resolveServerGitInvocation(["-c", "http.sslVerify=false", "push"], paths())).toThrow(
      /refusing to build/,
    );
    expect(() => resolveServerGitInvocation(["-C", "/srv/repo", "push"], paths())).toThrow(/refusing to build/);
  });

  it("refuses under the PAPERCLIP_SERVER_GIT override too", () => {
    // The invariant is about what this module asks git to DO, not which binary
    // runs it, so the test seam must not become a way around the check.
    process.env.PAPERCLIP_SERVER_GIT = fakeGit;
    expect(() => resolveServerGitInvocation(["push"], paths())).toThrow(/refusing to build/);
  });

  it("names the pin and the remedy, so the refusal is not read as a tooling gap", () => {
    // A bare "not allowed" invites the wrong fix (widen the list). The message
    // has to say why the path is unguarded and where a real publish belongs.
    expect(() => resolveServerGitInvocation(["push"], paths())).toThrow(/pre-push hook/);
    expect(() => resolveServerGitInvocation(["push"], paths())).toThrow(/credential helper/);
  });

  it("still admits every verb the server actually runs, submodule repair included", () => {
    // The point of the pin (BLO-41987). `submodule` is deliberately absent from
    // the agent door's allowlist, which is why this door decides with the
    // DENYLIST instead -- deciding here with `isNonPublishingGitVerb` would
    // refuse the one operation the pin exists to perform. This case is what
    // fails if someone "tightens" it to the allowlist for symmetry.
    const serverVerbs = [
      ["submodule", "sync", "--recursive"],
      ["submodule", "update", "--init"],
      ["fetch", "--prune", "origin"],
      ["worktree", "add", "-b", "b", "/tmp/w", "HEAD"],
      ["checkout", "-B", "b", "HEAD"],
      ["merge-base", "--is-ancestor", "a", "b"],
      ["rev-parse", "HEAD"],
      ["reset", "--hard", "HEAD"],
      ["branch", "-d", "b"],
      ["commit", "-m", "m"],
      ["add", "-A"],
      ["status"],
      ["config", "user.name"],
      ["remote", "-v"],
      ["rev-list", "--count", "HEAD"],
      ["show-ref", "--verify", "refs/heads/b"],
      ["symbolic-ref", "HEAD"],
    ];
    for (const args of serverVerbs) {
      expect(() => resolveServerGitInvocation(args, paths()), args.join(" ")).not.toThrow();
    }
  });

  it("leaves an argv with no subcommand to git rather than inventing a verdict", () => {
    expect(() => resolveServerGitInvocation([], paths())).not.toThrow();
    expect(() => resolveServerGitInvocation(["--version"], paths())).not.toThrow();
  });
});
