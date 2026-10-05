// BLO-40317: the strict agent-home git probe must not resolve `git` through a
// Paperclip-home credential shim. `/paperclip/.local/bin/git` execs the real git
// behind a token wrapper and exits 1 when its token file is unreadable; that
// stderr is neither ENOENT nor "not a git repository", so the probe returned
// `indeterminate` and dispatch was refused for every workspace-less row in the
// fleet. `rev-parse --show-toplevel` reads only the local filesystem.
import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertGitWorktreeBaseWorkspaceReady,
  assertPushCapabilityCheckoutValid,
  isRetryableInteractionContinuationInfrastructureFailure,
  probeGitCheckoutStateStrict,
} from "../services/heartbeat.js";

const execFile = promisify(execFileCallback);

describe("probeGitCheckoutStateStrict PATH resolution", () => {
  let home = "";
  let probeCwd = "";
  const previousHome = process.env.PAPERCLIP_HOME;
  const previousPath = process.env.PATH;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-probe-home-"));
    probeCwd = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-probe-cwd-"));
    const shimBin = path.join(home, ".local", "bin");
    await fs.mkdir(shimBin, { recursive: true });
    // Same shape as the real failure: refuses before ever reaching git.
    await fs.writeFile(
      path.join(shimBin, "git"),
      '#!/bin/sh\necho "paperclip github token file not readable" >&2\nexit 1\n',
      { mode: 0o755 },
    );
    process.env.PAPERCLIP_HOME = home;
    process.env.PATH = `${shimBin}${path.delimiter}${previousPath ?? ""}`;
  });

  afterEach(async () => {
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = previousHome;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(probeCwd, { recursive: true, force: true });
  });

  it("ignores a Paperclip-home git shim and still reports not_a_checkout", async () => {
    // Positive control: the shim really is first on PATH and really does break
    // an unfiltered probe. Without this, the assertion below could pass for
    // reasons unrelated to the PATH filter.
    await expect(
      execFile("git", ["rev-parse", "--show-toplevel"], { cwd: probeCwd }),
    ).rejects.toMatchObject({ stderr: expect.stringContaining("token file not readable") });

    expect(await probeGitCheckoutStateStrict(probeCwd)).toBe("not_a_checkout");
  });

  it("still reports checkout for a real repository under the same shimmed PATH", async () => {
    await execFile("/usr/bin/git", ["init", "--quiet", probeCwd]);
    expect(await probeGitCheckoutStateStrict(probeCwd)).toBe("checkout");
  });

  it("still fails closed when the directory is unreadable", async () => {
    const unreadable = path.join(probeCwd, "locked");
    await fs.mkdir(unreadable);
    await fs.chmod(unreadable, 0o000);
    try {
      // Not ENOENT and not "not a git repository" -> no verdict -> refuse.
      expect(await probeGitCheckoutStateStrict(unreadable)).not.toBe("not_a_checkout");
    } finally {
      await fs.chmod(unreadable, 0o700);
    }
  });

  it("accepts a real checkout as a git_worktree base under the same shimmed PATH", async () => {
    await execFile("/usr/bin/git", ["init", "--quiet", probeCwd]);
    await expect(assertGitWorktreeBaseWorkspaceReady({
      requestedExecutionWorkspaceMode: "isolated_workspace",
      config: { workspaceStrategy: { type: "git_worktree" } },
      issue: {
        id: "issue-1",
        identifier: "PAP-1",
        projectId: "project-1",
        projectWorkspaceId: "workspace-1",
      },
      base: {
        baseCwd: probeCwd,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: null,
      },
    })).resolves.toBeUndefined();
  });

  it("finds a configured push remote under the same shimmed PATH", async () => {
    await execFile("/usr/bin/git", ["init", "--quiet", probeCwd]);
    await execFile("/usr/bin/git", ["-C", probeCwd, "remote", "add", "origin", "https://example.invalid/repo.git"]);
    await expect(assertPushCapabilityCheckoutValid({
      enabled: true,
      issue: { id: "issue-1", identifier: "PAP-1" },
      cwd: probeCwd,
    })).resolves.toBeUndefined();
  });
});

describe("agent-home git bootstrap retryability", () => {
  const run = (gitProbeState: string | null) => ({
    error: null,
    errorCode: "workspace_validation_failed",
    resultJson: {
      workspaceValidation: {
        reason: "k8s_agent_home_git_bootstrap_unsupported",
        ...(gitProbeState === null ? {} : { gitProbeState }),
      },
    },
  });

  it("keeps an inconclusive probe retryable", () => {
    // No verdict was reached, so there is nothing for anyone to repair and no
    // grounds to latch the run out of every retry path.
    expect(isRetryableInteractionContinuationInfrastructureFailure(run("indeterminate"))).toBe(true);
  });

  it("still refuses to retry a confirmed checkout", () => {
    // A repository really is under the fallback cwd: a human must remove it or
    // bind a workspace, and retrying changes nothing.
    expect(isRetryableInteractionContinuationInfrastructureFailure(run("checkout"))).toBe(false);
    expect(isRetryableInteractionContinuationInfrastructureFailure(run(null))).toBe(false);
  });
});
