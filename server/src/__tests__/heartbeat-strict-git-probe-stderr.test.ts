// PEN-3889. `probeGitCheckoutStateStrict` classifies git's stderr, and
// `not_a_checkout` is the sole *allow* verdict at its only call site
// (heartbeat.ts, the BLO-18147 fail-closed k8s run-isolation guard): dispatch
// is refused unless the probe POSITIVELY confirms the cwd holds no repository.
// So a misclassification here does not mislabel, it waves a run through — the
// inverse of the sibling classifier in workspace-runtime.ts, where both
// verdicts refuse identically.
//
// The matcher used to be an unanchored `/not a git repository/i` tested
// against the whole stderr, so any unrelated git failure whose message merely
// CONTAINED that phrase — most plausibly inside a path — was read as positive
// absence. Those are exactly the storage-layer failures (stale handle, lock
// contention, dubious ownership) the function's own doc comment says it
// exists to reject.
//
// These tests drive the real exported function rather than a extracted copy
// of the regex, so they exercise the actual execFile error plumbing: a `git`
// shim first on PATH emits the fixture stderr and exits 128, which is how a
// real git failure reaches the classifier.
import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { probeGitCheckoutStateStrict } from "../services/heartbeat.js";

const execFile = promisify(execFileCallback);

const REAL_GIT = process.env.REAL_GIT ?? "/usr/bin/git";

describe("probeGitCheckoutStateStrict stderr classification", () => {
  let root = "";
  let shimBin = "";
  let probeCwd = "";
  const previousHome = process.env.PAPERCLIP_HOME;
  const previousPath = process.env.PATH;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "pen3889-"));
    shimBin = path.join(root, "bin");
    probeCwd = path.join(root, "cwd");
    await fs.mkdir(shimBin, { recursive: true });
    await fs.mkdir(probeCwd, { recursive: true });
    // The probe strips PAPERCLIP_HOME from PATH (BLO-40317). Point it at a
    // directory that contains no shim, so the one installed below is reached
    // and the fixtures are what the classifier actually sees.
    process.env.PAPERCLIP_HOME = path.join(root, "home");
    process.env.PATH = `${shimBin}${path.delimiter}${previousPath ?? ""}`;
  });

  afterEach(async () => {
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = previousHome;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await fs.rm(root, { recursive: true, force: true });
  });

  // Exits 128 like real git, so the rejection carries `.stderr` and a numeric
  // code — never "ENOENT", which the branch above the matcher would absorb.
  // The fixture goes to a sidecar file the shim cats, rather than through a
  // shell string: embedding it would put the escaping of a newline between
  // the fixture and the classifier, and the whole point of the `m` flag is
  // that a newline is present. (It bit once: `printf '%s'` does not expand a
  // backslash-n in its ARGUMENT, so the multi-line fixture arrived as one
  // line and the anchored matcher correctly refused it.)
  const installGitShim = async (stderr: string) => {
    const fixture = path.join(shimBin, "stderr.fixture");
    await fs.writeFile(fixture, stderr, "utf8");
    await fs.writeFile(
      path.join(shimBin, "git"),
      `#!/bin/sh\ncat ${JSON.stringify(fixture)} >&2\nexit 128\n`,
      { mode: 0o755 },
    );
  };

  it("is reached by the shim at all (positive control)", async () => {
    // Without this, every assertion below could pass because the shim was
    // never used and real git happened to agree.
    await installGitShim("fatal: sentinel shim reached");
    await expect(
      execFile("git", ["rev-parse", "--show-toplevel"], { cwd: probeCwd }),
    ).rejects.toMatchObject({ stderr: expect.stringContaining("sentinel shim reached") });
    expect(await probeGitCheckoutStateStrict(probeCwd)).toBe("indeterminate");
  });

  // The load-bearing half. Each fixture carries the phrase INSIDE a path, so
  // it genuinely fails against the unanchored form: these all returned
  // `not_a_checkout` before PEN-3889, i.e. they allowed dispatch.
  it.each([
    ["lock contention", "fatal: Unable to create '/srv/not a git repository/index.lock': File exists."],
    ["dubious ownership", "fatal: detected dubious ownership in repository at '/w/not a git repository'"],
    [
      "stale handle",
      "fatal: Unable to read current working directory: Stale file handle (/srv/Not A Git Repository/x)",
    ],
  ])("refuses %s on a path that merely mentions the fatal wording", async (_label, stderr) => {
    await installGitShim(stderr);
    expect(await probeGitCheckoutStateStrict(probeCwd)).toBe("indeterminate");
  });

  // Positive controls for the anchor itself: both forms real git emits must
  // still reach the allow verdict, or the fix would have closed the hole by
  // making the guard unsatisfiable.
  it("reads git's '(or any of the parent directories)' form as positive absence", async () => {
    await installGitShim("fatal: not a git repository (or any of the parent directories): .git");
    expect(await probeGitCheckoutStateStrict(probeCwd)).toBe("not_a_checkout");
  });

  // Guards the `m` flag specifically: drop it and this one goes red while the
  // single-line control above still passes.
  it("reads the ': <path>' form as positive absence after a preceding stderr line", async () => {
    await installGitShim("warning: unrelated\nfatal: not a git repository: '/srv/missing/.git'");
    expect(await probeGitCheckoutStateStrict(probeCwd)).toBe("not_a_checkout");
  });

  // Pins the fixtures to what git really emits. If a future git reworded or
  // re-indented this fatal, the anchored matcher would silently stop matching
  // and every dispatch through this guard would be refused; this fails first.
  it("matches the real git binary's fatal, byte for byte at column 0", async () => {
    const realStderr = await execFile(REAL_GIT, ["rev-parse", "--show-toplevel"], { cwd: probeCwd })
      .then(() => "", (error: { stderr?: string }) => error.stderr ?? "");
    expect(realStderr).toMatch(/^fatal: not a git repository/m);
    await installGitShim(realStderr.trimEnd());
    expect(await probeGitCheckoutStateStrict(probeCwd)).toBe("not_a_checkout");
  });
});
