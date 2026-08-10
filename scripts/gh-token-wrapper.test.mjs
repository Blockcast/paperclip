import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const WRAPPER = path.join(import.meta.dirname, "gh-token-wrapper.sh");

// A stub "real gh" that just dumps the env vars the wrapper is responsible
// for setting, plus its argv, so assertions can inspect exactly what the
// wrapper handed off — without needing the actual `gh` CLI installed.
const STUB_GH_SOURCE = `#!/bin/sh
echo "GH_TOKEN=\${GH_TOKEN:-}"
echo "GITHUB_TOKEN=\${GITHUB_TOKEN:-}"
echo "ARGS=$*"
`;

function withTempDir(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "gh-token-wrapper-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Every credential input the wrapper reads. A test that means to exercise one
// branch has to clear all of them, because the wrapper's whole job is to pick a
// branch based on which are set — inheriting one from the ambient environment
// silently re-points the test at a different branch than it names. This is not
// hypothetical: these tests run inside agent pods, and GH_SEAT_TOKEN_VALUE
// is exactly what the scoped secret-binding path (BLO-18927) exports there.
const WRAPPER_CREDENTIAL_ENV_VARS = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "PAPERCLIP_GITHUB_TOKEN_FILE",
  "GH_SEAT_TOKEN_VALUE",
];

// The single way any test in this file builds an environment. Starts from a
// copy of process.env with every credential input stripped, then applies only
// what the caller asked for, so each test states its full credential premise.
function sanitizedEnv(overrides = {}) {
  const env = { ...process.env };
  for (const name of WRAPPER_CREDENTIAL_ENV_VARS) {
    delete env[name];
  }
  return Object.assign(env, overrides);
}

function runWrapper(dir, { tokenFileContent, tokenValue, args = ["api", "user"] } = {}) {
  const stubGhPath = path.join(dir, "gh.real");
  writeFileSync(stubGhPath, STUB_GH_SOURCE);
  chmodSync(stubGhPath, 0o755);

  const env = sanitizedEnv({ GH_TOKEN_WRAPPER_REAL_GH: stubGhPath });

  if (tokenValue !== undefined) {
    env.GH_SEAT_TOKEN_VALUE = tokenValue;
  }

  if (tokenFileContent !== undefined) {
    const tokenFilePath = path.join(dir, "token");
    writeFileSync(tokenFilePath, tokenFileContent);
    env.PAPERCLIP_GITHUB_TOKEN_FILE = tokenFilePath;
  } else {
    // Point at a path that does not exist, exercising the fallback branch.
    env.PAPERCLIP_GITHUB_TOKEN_FILE = path.join(dir, "does-not-exist");
  }

  const out = execFileSync("sh", [WRAPPER, ...args], { env, encoding: "utf8" });
  return Object.fromEntries(
    out
      .trim()
      .split("\n")
      .map((line) => {
        const idx = line.indexOf("=");
        return [line.slice(0, idx), line.slice(idx + 1)];
      }),
  );
}

test("exports GH_TOKEN/GITHUB_TOKEN from a fresh token file and execs through", () => {
  withTempDir((dir) => {
    const result = runWrapper(dir, { tokenFileContent: "ghs_freshtoken123\n" });
    assert.equal(result.GH_TOKEN, "ghs_freshtoken123");
    assert.equal(result.GITHUB_TOKEN, "ghs_freshtoken123");
    assert.equal(result.ARGS, "api user");
  });
});

test("strips trailing newline/CR from the token file", () => {
  withTempDir((dir) => {
    const result = runWrapper(dir, { tokenFileContent: "ghs_windows_style\r\n" });
    assert.equal(result.GH_TOKEN, "ghs_windows_style");
  });
});

test("falls back to the real binary unmodified when the token file is absent", () => {
  withTempDir((dir) => {
    const result = runWrapper(dir, { args: ["auth", "status"] });
    assert.equal(result.GH_TOKEN, "");
    assert.equal(result.GITHUB_TOKEN, "");
    assert.equal(result.ARGS, "auth status");
  });
});

test("falls back when the token file exists but is empty", () => {
  withTempDir((dir) => {
    const result = runWrapper(dir, { tokenFileContent: "" });
    assert.equal(result.GH_TOKEN, "");
    assert.equal(result.GITHUB_TOKEN, "");
  });
});

test("overrides a pre-existing GH_TOKEN/GITHUB_TOKEN in the caller's env (BLO-13241 review S1)", () => {
  // Deliberate precedence flip from stock `gh`: the live bot token always
  // wins over whatever the caller already exported, not just an unset one.
  withTempDir((dir) => {
    const stubGhPath = path.join(dir, "gh.real");
    writeFileSync(stubGhPath, STUB_GH_SOURCE);
    chmodSync(stubGhPath, 0o755);
    const tokenFilePath = path.join(dir, "token");
    writeFileSync(tokenFilePath, "ghs_livebottoken\n");

    const env = sanitizedEnv({
      GH_TOKEN_WRAPPER_REAL_GH: stubGhPath,
      PAPERCLIP_GITHUB_TOKEN_FILE: tokenFilePath,
      GH_TOKEN: "user_supplied_override",
      GITHUB_TOKEN: "user_supplied_override",
    });
    const out = execFileSync("sh", [WRAPPER, "api", "user"], { env, encoding: "utf8" });
    const result = Object.fromEntries(
      out
        .trim()
        .split("\n")
        .map((line) => {
          const idx = line.indexOf("=");
          return [line.slice(0, idx), line.slice(idx + 1)];
        }),
    );
    assert.equal(result.GH_TOKEN, "ghs_livebottoken");
    assert.equal(result.GITHUB_TOKEN, "ghs_livebottoken");
  });
});

test("logs a diagnostic to stderr and falls back when the token file exists but isn't readable (BLO-13241 review S2)", (t) => {
  // chmod-based unreadability is meaningless for root (root bypasses
  // permission bits entirely), which is how this repo's Docker build and
  // some CI runners execute. Skip rather than false-fail there.
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    t.skip("running as root; permission bits don't apply");
    return;
  }
  withTempDir((dir) => {
    const stubGhPath = path.join(dir, "gh.real");
    writeFileSync(stubGhPath, STUB_GH_SOURCE);
    chmodSync(stubGhPath, 0o755);
    const tokenFilePath = path.join(dir, "token");
    writeFileSync(tokenFilePath, "ghs_unreadable\n");
    chmodSync(tokenFilePath, 0o000);

    const env = sanitizedEnv({
      GH_TOKEN_WRAPPER_REAL_GH: stubGhPath,
      PAPERCLIP_GITHUB_TOKEN_FILE: tokenFilePath,
    });

    const proc = spawnSync("sh", [WRAPPER, "auth", "status"], { env, encoding: "utf8" });
    assert.equal(proc.status, 0);
    assert.match(proc.stderr, /exists but is not readable/);
    const result = Object.fromEntries(
      proc.stdout
        .trim()
        .split("\n")
        .map((line) => {
          const idx = line.indexOf("=");
          return [line.slice(0, idx), line.slice(idx + 1)];
        }),
    );
    assert.equal(result.GH_TOKEN, "");
    assert.equal(result.GITHUB_TOKEN, "");
  });
});

// GH_SEAT_TOKEN_VALUE — credentials delivered by the scoped
// secret-binding path rather than a mounted secret volume (BLO-18927).

test("exports a token supplied by value when no token file exists", () => {
  withTempDir((dir) => {
    const result = runWrapper(dir, { tokenValue: "ghu_fromenvbinding" });
    assert.equal(result.GH_TOKEN, "ghu_fromenvbinding");
    assert.equal(result.GITHUB_TOKEN, "ghu_fromenvbinding");
    assert.equal(result.ARGS, "api user");
  });
});

test("a token supplied by value wins over the token file", () => {
  // Both are explicit per-invocation identity selections; the more specific one
  // wins so a caller can pick the user seat for a single `gh` call while the
  // default App-token file stays mounted for everything else.
  withTempDir((dir) => {
    const result = runWrapper(dir, {
      tokenFileContent: "ghs_apptoken\n",
      tokenValue: "ghu_userseat",
    });
    assert.equal(result.GH_TOKEN, "ghu_userseat");
    assert.equal(result.GITHUB_TOKEN, "ghu_userseat");
  });
});

test("strips trailing newline/CR from a token supplied by value", () => {
  withTempDir((dir) => {
    const result = runWrapper(dir, { tokenValue: "ghu_windows_style\r\n" });
    assert.equal(result.GH_TOKEN, "ghu_windows_style");
  });
});

// Every rejection below is asserted with BOTH a readable token file and
// ambient GH_TOKEN/GITHUB_TOKEN present, because those are the two things a
// fall-through would silently authenticate as. Asserting only the exit code
// against a bare env would pass even if the wrapper had fallen through.
function runMalformedValue(dir, tokenValue) {
  const stubGhPath = path.join(dir, "gh.real");
  writeFileSync(stubGhPath, STUB_GH_SOURCE);
  chmodSync(stubGhPath, 0o755);
  const tokenFilePath = path.join(dir, "token");
  writeFileSync(tokenFilePath, "ghs_apptoken\n");

  return spawnSync("sh", [WRAPPER, "api", "user"], {
    encoding: "utf8",
    env: sanitizedEnv({
      GH_TOKEN_WRAPPER_REAL_GH: stubGhPath,
      PAPERCLIP_GITHUB_TOKEN_FILE: tokenFilePath,
      GH_SEAT_TOKEN_VALUE: tokenValue,
      GH_TOKEN: "user_supplied_override",
      GITHUB_TOKEN: "user_supplied_override",
    }),
  });
}

for (const [label, tokenValue] of [
  ["empty", ""],
  ["CRLF only", "\r\n"],
  ["spaces only", "   "],
  ["tabs only", "\t\t"],
  ["mixed whitespace only", " \t\r\n "],
]) {
  test(`a whitespace-only token value (${label}) fails before ambient auth can be used`, () => {
    // A binding that resolved to nothing is a misconfiguration, not a request
    // to fall back to the App token file or to inherited caller credentials.
    withTempDir((dir) => {
      const proc = runMalformedValue(dir, tokenValue);
      assert.equal(proc.status, 64);
      assert.match(proc.stderr, /GH_SEAT_TOKEN_VALUE is set but holds only whitespace/);
      assert.equal(proc.stdout, "");
    });
  });
}

for (const [label, tokenValue] of [
  ["embedded LF", "ghu_aaa\nbbb"],
  ["embedded CRLF", "ghu_aaa\r\nbbb"],
  ["embedded space", "ghu_aaa bbb"],
  ["embedded tab", "ghu_aaa\tbbb"],
]) {
  test(`a token value with interior whitespace (${label}) is rejected, not spliced`, () => {
    // The pre-hardening `tr -d` would have joined these into "ghu_aaabbb" and
    // authenticated as a token nobody issued. Refusing is the point.
    withTempDir((dir) => {
      const proc = runMalformedValue(dir, tokenValue);
      assert.equal(proc.status, 64);
      assert.match(proc.stderr, /contains embedded whitespace/);
      assert.equal(proc.stdout, "");
      // The malformed value must not be echoed into logs.
      assert.doesNotMatch(proc.stderr, /ghu_aaa/);
    });
  });
}

test("trims surrounding whitespace, not just line terminators, from a token value", () => {
  withTempDir((dir) => {
    const result = runWrapper(dir, { tokenValue: " \tghu_padded \r\n" });
    assert.equal(result.GH_TOKEN, "ghu_padded");
    assert.equal(result.GITHUB_TOKEN, "ghu_padded");
  });
});

test("a token supplied by value overrides a pre-existing GH_TOKEN in the caller's env", () => {
  withTempDir((dir) => {
    const stubGhPath = path.join(dir, "gh.real");
    writeFileSync(stubGhPath, STUB_GH_SOURCE);
    chmodSync(stubGhPath, 0o755);

    const env = sanitizedEnv({
      GH_TOKEN_WRAPPER_REAL_GH: stubGhPath,
      GH_SEAT_TOKEN_VALUE: "ghu_userseat",
      GH_TOKEN: "user_supplied_override",
      GITHUB_TOKEN: "user_supplied_override",
    });
    const out = execFileSync("sh", [WRAPPER, "api", "user"], { env, encoding: "utf8" });
    const result = Object.fromEntries(
      out
        .trim()
        .split("\n")
        .map((line) => {
          const idx = line.indexOf("=");
          return [line.slice(0, idx), line.slice(idx + 1)];
        }),
    );
    assert.equal(result.GH_TOKEN, "ghu_userseat");
    assert.equal(result.GITHUB_TOKEN, "ghu_userseat");
  });
});

// BLO-18484: the wrapper injects the token into `gh`'s process env only, so the
// git CLI had no credential of its own. Against a *private* repo every push and
// fetch failed with "Invalid username or token" — an authentication-absence
// error that reads like a permissions problem, which is what sent BLO-18481
// down a spurious access-escalation path. Public repos masked it by cloning
// anonymously. These two tests pin the halves of the fix: that the wrapper
// serves the credential-helper invocation, and that the image asks the wrapper
// (not gh.real) for it.
test("injects the token when invoked as a git credential helper (BLO-18484)", () => {
  withTempDir((dir) => {
    const result = runWrapper(dir, {
      tokenFileContent: "ghs_credentialhelper\n",
      args: ["auth", "git-credential", "get"],
    });
    assert.equal(result.GH_TOKEN, "ghs_credentialhelper");
    assert.equal(result.ARGS, "auth git-credential get");
  });
});

test("Dockerfile.runtime points git's credential helper at the wrapper, not gh.real (BLO-18484)", () => {
  const dockerfile = readFileSync(path.join(import.meta.dirname, "..", "Dockerfile.runtime"), "utf8");

  const helper = dockerfile.match(
    /git config --system credential\.https:\/\/github\.com\.helper\s*\\?\s*'([^']+)'/,
  );
  assert.ok(helper, "Dockerfile.runtime must configure a system-level github.com credential helper");

  // The trap this test exists for: `gh auth setup-git` writes a gh.real helper
  // (gh resolves its own argv[0] after the wrapper exec's it), and gh.real never
  // reads the token file — so that helper returns nothing and git silently falls
  // through to prompting for a username.
  assert.equal(helper[1], "!/usr/bin/gh auth git-credential");
  assert.doesNotMatch(helper[1], /gh\.real/);
});

// Pins the isolation the helper above provides, by re-running this whole file
// in a child process with every credential input already set in the ambient
// environment. Before the sanitized-env helper, that run failed two tests: the
// GH_TOKEN-override test authenticated as the inherited value instead of the
// file's, and the unreadable-file test never emitted its diagnostic, because
// the inherited GH_SEAT_TOKEN_VALUE sent both down the value branch.
// A plain assertion inside a single test cannot catch that class of bug — the
// leak is in how each test builds its environment, so the check has to be a
// second run of every test under a dirty one.
if (!process.env.GH_TOKEN_WRAPPER_TEST_NESTED) {
  test("the suite is hermetic against inherited credential env vars", () => {
    const nestedEnv = {
      ...process.env,
      // Stops the child from spawning its own child, forever.
      GH_TOKEN_WRAPPER_TEST_NESTED: "1",
      GH_TOKEN: "ambient_caller_token",
      GITHUB_TOKEN: "ambient_caller_token",
      PAPERCLIP_GITHUB_TOKEN_FILE: path.join(os.tmpdir(), "ambient-token-does-not-exist"),
      GH_SEAT_TOKEN_VALUE: "ghu_ambient_scoped_binding",
    };
    // node:test sets NODE_TEST_CONTEXT=child-v8 in every test-file subprocess.
    // Inheriting it makes the nested run report through the v8 serializer to a
    // parent that is not listening, and — the part that matters — exit 0 even
    // with failing tests, which silently makes this assertion vacuous. Verified
    // on node v24.16: same nested run exits 1 without it, 0 with it.
    delete nestedEnv.NODE_TEST_CONTEXT;

    const proc = spawnSync(process.execPath, ["--test", import.meta.filename], {
      encoding: "utf8",
      env: nestedEnv,
    });
    assert.equal(
      proc.status,
      0,
      `suite is not hermetic — it passes clean but fails with credential env vars inherited:\n${proc.stdout}\n${proc.stderr}`,
    );
  });
}
