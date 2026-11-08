// Guards the cache-first install in .github/actions/setup-actionlint (PEN-6132).
//
// `policy`'s actionlint fetch is the job's last unconditional external draw,
// and `policy` is what every other lane `needs:` -- so one failed fetch reds
// the run and, in a merge_group, ejects the entry and rebuilds every entry
// behind it. BLO-54857 widened the retry budget from 2 attempts to 6; this
// change restores the tarball from the master-seeded cache so the common path
// makes no network draw at all.
//
// WHY THESE TESTS RUN THE REAL SHELL RATHER THAN GREPPING THE YAML
//
// ci-cache-routing.test.mjs already asserts the WIRING -- that the action
// restores and never saves, that the prime saves the same path and key. What
// it cannot assert is the BEHAVIOUR of the branch that decides whether to
// trust the restored bytes, and that branch is the whole security surface of
// the change: a cache entry is writable by any run in its scope, so "restored"
// must never mean "trusted". These tests extract the step's own `run:` body
// and execute it, so they test the text that ships.
//
// They are offline by construction. `curl` and `sleep` are stubbed on PATH --
// curl always fails, which is the degraded-egress case the whole change is
// about, and sleep collapses the ~2.6 min retry budget to nothing. The pinned
// digest is supplied per-case over a tarball the test builds, so nothing here
// depends on the real 1.7.12 asset being reachable or on its bytes.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const actionPath = ".github/actions/setup-actionlint/action.yml";

// The install step's `run:` body, lifted from the action rather than retyped,
// so a future edit to the action is what these cases run.
function installScript() {
  const yaml = readFileSync(actionPath, "utf8");
  const match = yaml.match(/\n {4}- name: Install actionlint\n[\s\S]*?\n {6}run: \|\n([\s\S]*?)$/);
  assert.ok(match, `${actionPath} must carry an "Install actionlint" step with a run: block`);
  return match[1]
    .split("\n")
    .map((line) => (line.startsWith(" ".repeat(8)) ? line.slice(8) : line))
    .join("\n");
}

// A stand-in for the release tarball: one executable named `actionlint` that
// answers --version. The digest of whatever we build becomes the pin, so the
// cases below exercise match and mismatch without a network fetch.
function makeTarball(dir, body) {
  const staging = path.join(dir, "staging");
  mkdirSync(staging, { recursive: true });
  const binary = path.join(staging, "actionlint");
  writeFileSync(binary, body);
  chmodSync(binary, 0o755);
  const tarball = path.join(dir, "built.tar.gz");
  execFileSync("tar", ["-czf", tarball, "-C", staging, "actionlint"]);
  const digest = execFileSync("sha256sum", [tarball], { encoding: "utf8" }).split(" ")[0];
  return { tarball, digest };
}

function runInstall({ cachedTarball, sha256, version = "9.9.9", extraCacheFiles = {} }) {
  const home = mkdtempSync(path.join(tmpdir(), "setup-actionlint-"));
  const cacheDir = path.join(home, ".cache", "actionlint");
  mkdirSync(cacheDir, { recursive: true });
  if (cachedTarball) {
    writeFileSync(path.join(cacheDir, "actionlint.tar.gz"), readFileSync(cachedTarball));
  }
  // Anything else a restored entry might carry. The checksum gates the
  // tarball alone, so these stand in for the bytes nothing verifies.
  for (const [name, body] of Object.entries(extraCacheFiles)) {
    const extra = path.join(cacheDir, name);
    writeFileSync(extra, body);
    chmodSync(extra, 0o755);
  }

  // curl fails on every attempt: the degraded-egress case. sleep is a no-op so
  // the six-attempt budget costs no wall-clock here.
  const stubBin = path.join(home, "stub-bin");
  mkdirSync(stubBin, { recursive: true });
  for (const [name, body] of [
    ["curl", "#!/bin/sh\nprintf '504 203.0.113.9 stub'\nexit 22\n"],
    ["sleep", "#!/bin/sh\nexit 0\n"],
  ]) {
    const stub = path.join(stubBin, name);
    writeFileSync(stub, body);
    chmodSync(stub, 0o755);
  }

  const runnerTemp = path.join(home, "runner-temp");
  mkdirSync(runnerTemp, { recursive: true });
  const githubPath = path.join(home, "github_path");

  const scriptPath = path.join(home, "install.sh");
  writeFileSync(scriptPath, installScript());
  const result = spawnSync("bash", [scriptPath], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      RUNNER_TEMP: runnerTemp,
      PATH: `${stubBin}:${process.env.PATH}`,
      VERSION: version,
      SHA256: sha256,
      GITHUB_OUTPUT: path.join(home, "github_output"),
      GITHUB_PATH: githubPath,
    },
  });
  return {
    status: result.status,
    output: `${result.stdout || ""}${result.stderr || ""}`,
    cacheDir,
    // Where the action says it put the binary, and where it asked the job to
    // look for it. Read from the real $GITHUB_PATH / $GITHUB_OUTPUT files
    // rather than recomputed, so a change to either is visible here.
    installedBinary: path.join(runnerTemp, `actionlint-${version}`, "actionlint"),
    pathEntries: existsSync(githubPath)
      ? readFileSync(githubPath, "utf8").split("\n").filter(Boolean)
      : [],
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

test("a cached tarball matching the pin installs with no network draw", () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "actionlint-fixture-"));
  try {
    const { tarball, digest } = makeTarball(scratch, "#!/bin/sh\necho 9.9.9\n");
    const run = runInstall({ cachedTarball: tarball, sha256: digest });
    try {
      // curl is guaranteed to fail here, so a success proves the fetch was
      // never reached. This is the property the change exists to buy: a
      // GitHub release-asset outage stops reaching `policy` at all.
      assert.equal(run.status, 0, `expected success from the cache, got:\n${run.output}`);
      assert.match(run.output, /restored from cache; no network draw/);
      assert.doesNotMatch(run.output, /download attempt/);
      assert.ok(existsSync(run.installedBinary), "the binary must be extracted from the restored tarball");
    } finally {
      run.cleanup();
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("the restored cache directory is never put on $GITHUB_PATH", () => {
  // The regression this guards is the one that shipped in the first cut of
  // PEN-6132: `dest` was both the restore target and the directory handed to
  // $GITHUB_PATH. The checksum gates ONE file -- the tarball -- but a restore
  // unpacks the WHOLE entry, and $GITHUB_PATH PREPENDS, so any extra
  // executable in that entry would shadow the real one for every later step
  // in `policy`, the job that gates the merge queue. The tarball check passes
  // here, so this case fails only on the PATH wiring and nothing else.
  const scratch = mkdtempSync(path.join(tmpdir(), "actionlint-fixture-"));
  try {
    const { tarball, digest } = makeTarball(scratch, "#!/bin/sh\necho 9.9.9\n");
    const run = runInstall({
      cachedTarball: tarball,
      sha256: digest,
      extraCacheFiles: { jq: "#!/bin/sh\necho shadowed\n" },
    });
    try {
      assert.equal(run.status, 0, `expected success from the cache, got:\n${run.output}`);
      assert.ok(run.pathEntries.length > 0, "the action must write a $GITHUB_PATH entry");
      assert.ok(
        !run.pathEntries.includes(run.cacheDir),
        `the restored cache directory must never reach PATH, got: ${run.pathEntries.join(", ")}`,
      );
      // ...and what it DOES put on PATH must hold the verified binary and
      // nothing that rode along in the entry.
      for (const entry of run.pathEntries) {
        assert.ok(
          !existsSync(path.join(entry, "jq")),
          `an unverified file from the cache entry reached a PATH directory: ${entry}`,
        );
      }
      assert.ok(existsSync(run.installedBinary), "the binary must be extracted from the restored tarball");
      assert.ok(
        run.pathEntries.includes(path.dirname(run.installedBinary)),
        "the directory holding the verified binary must be the one added to PATH",
      );
    } finally {
      run.cleanup();
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("a cached tarball that does not match the pin is never trusted", () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "actionlint-fixture-"));
  try {
    // A cache entry is writable by any run in its scope, so the restore path
    // must be gated by the same checksum the download path is. Here the
    // entry is a well-formed tarball carrying the wrong binary, and the
    // network is down -- the only safe outcome is a red job and no binary.
    const { tarball } = makeTarball(scratch, "#!/bin/sh\necho pwned\n");
    const { digest: pinnedDigest } = makeTarball(
      path.join(scratch, "real"),
      "#!/bin/sh\necho 9.9.9\n",
    );
    const run = runInstall({ cachedTarball: tarball, sha256: pinnedDigest });
    try {
      assert.equal(run.status, 1, `a mismatched cache entry must fail closed, got:\n${run.output}`);
      assert.match(run.output, /cached actionlint tarball failed the .* checksum; re-downloading/);
      assert.ok(
        !existsSync(run.installedBinary),
        "no binary may be installed from a tarball that failed the pin",
      );
    } finally {
      run.cleanup();
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("an empty cache falls back to the download and still fails closed on a sustained outage", () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "actionlint-fixture-"));
  try {
    const { digest } = makeTarball(scratch, "#!/bin/sh\necho 9.9.9\n");
    const run = runInstall({ cachedTarball: null, sha256: digest });
    try {
      // The cache is a mitigation, not a dependency: a miss must degrade to
      // the pre-PEN-6132 download, with BLO-54857's budget intact and the
      // same deliberate red at the end of it. Proceeding without the linter
      // is the failure this gate was built to prevent.
      assert.equal(run.status, 1, `a cold cache with no egress must fail, got:\n${run.output}`);
      assert.match(run.output, /download attempt 1\/6 failed/);
      assert.match(run.output, /download attempt 6\/6 failed/);
      assert.match(run.output, /Could not download actionlint .* after 6 attempts/);
    } finally {
      run.cleanup();
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
