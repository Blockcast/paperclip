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
      "fetch",
      "--prune",
      "origin",
    ]);
  });

  it("resets the helper list before adding ours, so an agent-written helper cannot harvest the token", () => {
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

  it("honours the PAPERCLIP_SERVER_GIT override", () => {
    process.env.PAPERCLIP_SERVER_GIT = fakeGit;
    const resolved = resolveServerGitInvocation(["status"], {
      gitBinary: missing,
      credentialHelper: missing,
    });
    expect(resolved.command).toBe(fakeGit);
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
