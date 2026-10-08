import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  classifyGitCheckoutProbeFailure,
  probeGitCheckout,
} from "../services/workspace-runtime.ts";

const execFileAsync = promisify(execFile);

// PEN-3633. `isGitCheckout` used to be
//   Boolean(await runGit(["rev-parse", "--git-dir"], cwd).catch(() => null))
// which discarded git's stderr and exit status at the call site, collapsing
// "there is no repository here" and "the probe could not run" into one
// indistinguishable `false`. A measured 8.6-hour episode (33 runs across 19
// issues, all against one project checkout) was unattributable purely because
// of that swallow. These tests pin the two properties that fix depends on:
// the reason survives, and only git's own fatal is read as absence.
describe("classifyGitCheckoutProbeFailure", () => {
  it("reads git's own 'not a git repository' fatal as positive absence", () => {
    const stderr = "fatal: not a git repository (or any of the parent directories): .git";
    const probe = classifyGitCheckoutProbeFailure(new Error(stderr));
    expect(probe.state).toBe("not_a_checkout");
    expect(probe.reason).toBe(stderr);
  });

  // The load-bearing half: these are the failures that are NOT evidence the
  // directory lacks a repository, and each one used to render as `false`.
  it.each([
    ["dubious ownership", "fatal: detected dubious ownership in repository at '/w'"],
    ["lock contention", "fatal: Unable to create '/w/.git/index.lock': File exists."],
    ["permission denied", "fatal: could not read Username for 'https://github.com': Permission denied"],
    ["stale handle", "fatal: Unable to read current working directory: Stale file handle"],
    ["spawn failure", "spawn git ENOENT"],
    ["timeout", "git rev-parse --git-dir timed out after 5000ms"],
  ])("reports %s as indeterminate and preserves the diagnosis verbatim", (_label, stderr) => {
    const probe = classifyGitCheckoutProbeFailure(new Error(stderr));
    expect(probe.state).toBe("indeterminate");
    expect(probe.reason).toBe(stderr);
  });

  // Guards the regression directly: a classifier that returned a constant
  // string, or dropped the message, would pass a bare state assertion.
  it("never returns an empty reason, even for a valueless throw", () => {
    for (const thrown of [new Error(""), new Error("   "), null, undefined, ""]) {
      const probe = classifyGitCheckoutProbeFailure(thrown);
      expect(probe.state).toBe("indeterminate");
      expect(probe.reason.trim().length).toBeGreaterThan(0);
    }
  });

  // "not a git repository" must be matched as git's diagnosis, not as part of
  // an arbitrary path: each fixture carries the phrase inside a path, so an
  // unanchored match would downgrade a genuine failure to positive absence.
  it.each([
    ["lock contention", "fatal: Unable to create '/srv/not a git repository/index.lock': File exists."],
    ["dubious ownership", "fatal: detected dubious ownership in repository at '/w/not a git repository'"],
    ["stale handle", "fatal: Unable to read current working directory: Stale file handle (/srv/Not A Git Repository/x)"],
  ])("does not mistake %s on a path that merely mentions the fatal wording", (_label, stderr) => {
    const probe = classifyGitCheckoutProbeFailure(new Error(stderr));
    expect(probe.state).toBe("indeterminate");
    expect(probe.reason).toBe(stderr);
  });

  it("reads git's 'not a git repository: <path>' form as positive absence", () => {
    const stderr = "warning: unrelated\nfatal: not a git repository: '/srv/missing/.git'";
    expect(classifyGitCheckoutProbeFailure(new Error(stderr)).state).toBe("not_a_checkout");
  });
});

describe("probeGitCheckout (real git)", () => {
  let root: string;
  let checkout: string;
  let plainDir: string;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "pen3633-"));
    checkout = path.join(root, "checkout");
    plainDir = path.join(root, "plain");
    await fs.mkdir(checkout, { recursive: true });
    await fs.mkdir(plainDir, { recursive: true });
    await execFileAsync("git", ["init", "--quiet"], { cwd: checkout });
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("classifies a real checkout as checkout and carries no reason", async () => {
    const probe = await probeGitCheckout(checkout);
    expect(probe.state).toBe("checkout");
    expect(probe.reason).toBeNull();
  });

  // Positive control for the suite: if this returned anything other than
  // not_a_checkout the fixtures above would be meaningless.
  it("classifies a real non-repository directory as not_a_checkout", async () => {
    const probe = await probeGitCheckout(plainDir);
    expect(probe.state).toBe("not_a_checkout");
    expect(probe.reason).toMatch(/not a git repository/i);
  });

  it("attributes an absent directory as not_a_checkout, naming the path", async () => {
    // `runGit`'s ENOENT carries no stderr, so without the explicit
    // directory check this would degrade to a bare "git ... failed".
    const missing = path.join(root, "missing");
    const probe = await probeGitCheckout(missing);
    expect(probe.state).toBe("not_a_checkout");
    expect(probe.reason).toContain(missing);
  });

  // The behaviour-preservation guarantee: this refactor must not move the
  // allow/refuse decision for any call site, only what it can say about it.
  it.each([["checkout"], ["plain"], ["missing"]])(
    "agrees with the original Boolean(stdout) semantic on %s",
    async (kind) => {
      const dir = kind === "checkout" ? checkout : kind === "plain" ? plainDir : path.join(root, "missing");
      const original = Boolean(
        await execFileAsync("git", ["rev-parse", "--git-dir"], { cwd: dir })
          .then((r) => r.stdout.trim())
          .catch(() => null),
      );
      expect((await probeGitCheckout(dir)).state === "checkout").toBe(original);
    },
  );
});
