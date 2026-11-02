import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

// The wrapper's compiled-in default, used only when PAPERCLIP_GITHUB_TOKEN_FILE
// is unset. Tests that exercise that branch MUST skip when this file exists:
// inside an agent pod it holds the live bot token, and the stub gh below prints
// GH_TOKEN to stdout, so running there would both break hermeticity and print a
// live credential into the test log.
const COMPILED_IN_DEFAULT_TOKEN_FILE = "/etc/paperclip/secrets/github-token/token";

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
//
// PAPERCLIP_HOME is pinned too (BLO-40279): the wrapper refuses a token file on
// the shared data volume `${PAPERCLIP_HOME:-/paperclip}`, compared by device,
// and agent Jobs run this file with TMPDIR on that same CephFS — so every temp
// token file here would otherwise read as "on the shared volume". /proc is
// always present and never the device of a regular file, so the check stays
// live and each token-file test is also its distinct-device positive control.
function sanitizedEnv(overrides = {}) {
  const env = { ...process.env };
  for (const name of WRAPPER_CREDENTIAL_ENV_VARS) {
    delete env[name];
  }
  env.PAPERCLIP_HOME = "/proc";
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

// Same premise-building as runWrapper, but hands back the raw process so a test
// can assert on a non-zero exit. execFileSync throws on non-zero, which suits
// the happy paths above and is useless for the exit-64 refusals below.
// setTokenFileVar: false leaves PAPERCLIP_GITHUB_TOKEN_FILE unset, exercising
// the compiled-in-default branch that must stay lenient for non-agent callers.
// extraEnv is applied after sanitizing, for tests whose premise includes a
// caller-supplied credential.
function spawnWrapper(
  dir,
  { tokenFileContent, args = ["api", "user"], setTokenFileVar = true, extraEnv = {}, input } = {},
) {
  const stubGhPath = path.join(dir, "gh.real");
  writeFileSync(stubGhPath, STUB_GH_SOURCE);
  chmodSync(stubGhPath, 0o755);

  const env = sanitizedEnv({ GH_TOKEN_WRAPPER_REAL_GH: stubGhPath, ...extraEnv });

  if (setTokenFileVar) {
    if (tokenFileContent !== undefined) {
      const tokenFilePath = path.join(dir, "token");
      writeFileSync(tokenFilePath, tokenFileContent);
      env.PAPERCLIP_GITHUB_TOKEN_FILE = tokenFilePath;
    } else {
      env.PAPERCLIP_GITHUB_TOKEN_FILE = path.join(dir, "does-not-exist");
    }
  }

  // The wrapper resolves its path with `${VAR:-default}`, so an unset *or
  // empty* var both land on the compiled-in default — which holds the live bot
  // token in an agent pod, and STUB_GH_SOURCE echoes GH_TOKEN to stdout. The
  // `setTokenFileVar: false` test guards itself with t.skip; `extraEnv: {
  // PAPERCLIP_GITHUB_TOKEN_FILE: "" }` reaches the same branch and does not —
  // Ally hit exactly that while probing 396e913f and printed a live token.
  // One guard here, at the only place that can reach the default (runWrapper
  // always assigns the var), instead of trusting every future caller.
  if (!env.PAPERCLIP_GITHUB_TOKEN_FILE && existsSync(COMPILED_IN_DEFAULT_TOKEN_FILE)) {
    throw new Error(
      `refusing to spawn: PAPERCLIP_GITHUB_TOKEN_FILE is unset/empty and ${COMPILED_IN_DEFAULT_TOKEN_FILE} exists, so the wrapper would read the live credential and the stub gh would print it. Point the var at a temp file, or skip this test as the non-agent-fallback one does.`,
    );
  }

  // `input` is passed through only when a caller asks for it, so every existing
  // caller keeps spawnSync's default (an inherited/empty stdin). It exists for
  // the credential-helper tests below, which must feed the wrapper exactly what
  // git feeds a helper rather than approximating it.
  return spawnSync("sh", [WRAPPER, ...args], { env, encoding: "utf8", ...(input === undefined ? {} : { input }) });
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

// BLO-37977: the three tests that follow used to assert the opposite — that an
// absent/empty/unreadable token file fell through to the real binary under
// ambient auth. That is what turned a fleet credential fault into `gh` silently
// doing nothing on a pod reporting healthy. With PAPERCLIP_GITHUB_TOKEN_FILE
// set, the caller has named a credential and these are now refusals.
test("refuses when PAPERCLIP_GITHUB_TOKEN_FILE names an absent file (BLO-37977)", () => {
  withTempDir((dir) => {
    const proc = spawnWrapper(dir, { args: ["auth", "status"] });
    assert.equal(proc.status, 64);
    assert.match(proc.stderr, /is absent; refusing to run with ambient auth/);
    // Must not have reached the real binary at all.
    assert.equal(proc.stdout, "");
  });
});

// BLO-40279: both token Secrets used to mount under /paperclip/.secrets, and an
// absolute path pinned in prose (a runbook, an agent instruction bundle) cannot
// be swept the way an in-repo one can. The refusal stays a refusal — resolving a
// named merge-seat path to the compiled-in App default would run as a different
// GitHub identity than the caller asked for — but it names where the path went,
// so a stale pin costs one read instead of a silent dead end.
test("names the BLO-40279 move when the stale /paperclip/.secrets path is pinned", (t) => {
  // Deliberately a name nothing mounts: a readable file here would exec the stub
  // gh, which echoes GH_TOKEN. Same hermeticity rule as the compiled-in default.
  const stale = "/paperclip/.secrets/gh-token-wrapper-test-absent/token";
  if (existsSync(stale)) return t.skip(`${stale} unexpectedly exists`);

  withTempDir((dir) => {
    const proc = spawnWrapper(dir, {
      setTokenFileVar: false,
      extraEnv: { PAPERCLIP_GITHUB_TOKEN_FILE: stale },
      args: ["auth", "status"],
    });
    assert.equal(proc.status, 64);
    assert.match(proc.stderr, /is absent; refusing to run with ambient auth/);
    assert.match(proc.stderr, /moved to \/etc\/paperclip\/secrets\/<name>\/token in BLO-40279/);
    assert.equal(proc.stdout, "");
  });
});

test("does not mention the BLO-40279 move for a path that was never under it", () => {
  // Anti-vacuity for the test above: the hint must be conditional on the stale
  // prefix, not unconditional boilerplate every refusal happens to carry.
  withTempDir((dir) => {
    const proc = spawnWrapper(dir, { args: ["auth", "status"] });
    assert.equal(proc.status, 64);
    assert.doesNotMatch(proc.stderr, /BLO-40279/);
  });
});

// BLO-40279: the vacated /paperclip/.secrets/<name>/ is a bare, group-writable
// directory on the shared volume, so a readable token there may be one any agent
// planted. A named path on that volume is refused, not read — the token never
// reaches the stub gh, which would echo it.
test("refuses a named token file on the shared data volume instead of reading it", () => {
  withTempDir((dir) => {
    const proc = spawnWrapper(dir, {
      tokenFileContent: "planted-token\n",
      extraEnv: { PAPERCLIP_HOME: dir },
    });
    assert.equal(proc.status, 64);
    assert.match(proc.stderr, /is on the shared .* volume, which every agent can write; refusing to run with ambient auth/);
    assert.equal(proc.stdout, "");
    assert.doesNotMatch(proc.stderr, /planted-token/);
  });
});

test("refuses when the token file exists but is empty (BLO-37977)", () => {
  withTempDir((dir) => {
    const proc = spawnWrapper(dir, { tokenFileContent: "" });
    assert.equal(proc.status, 64);
    assert.match(proc.stderr, /is empty; refusing to run with ambient auth/);
    assert.equal(proc.stdout, "");
  });
});

test("refuses a whitespace-only token file rather than exporting a blank token (BLO-37977)", () => {
  // `tr -d '\r\n'` leaves spaces and tabs behind, so without the whitespace
  // fold this exported GH_TOKEN="  \t " and authenticated as nobody.
  withTempDir((dir) => {
    const proc = spawnWrapper(dir, { tokenFileContent: "  \t \n" });
    assert.equal(proc.status, 64);
    assert.match(proc.stderr, /is empty; refusing to run with ambient auth/);
    assert.equal(proc.stdout, "");
  });
});

// Ally review on PR #2111: local-only commands never contact GitHub, so a
// missing named credential cannot make their answer wrong. Refusing them hides
// whether the binary works at all, during the very outage the refusal is for.
for (const args of [["--version"], ["version"], ["--help"], ["-h"], ["help", "api"], [], ["completion", "-s", "bash"], ["config", "get", "editor"]]) {
  test(`does not refuse local-only \`gh ${args.join(" ")}\` when the named token file is absent (BLO-37977)`, () => {
    withTempDir((dir) => {
      const proc = spawnWrapper(dir, { args });
      assert.equal(proc.status, 0, proc.stderr);
      assert.match(proc.stdout, new RegExp(`\\nARGS=${args.join(" ")}\\n`));
    });
  });
}

test("still refuses `auth git-credential` when the named token file is absent (BLO-37977)", () => {
  // The boundary the local-only exemption above must not widen past: git
  // resolving a remote is a real query.
  withTempDir((dir) => {
    const proc = spawnWrapper(dir, { args: ["auth", "git-credential", "get"] });
    assert.equal(proc.status, 64);
    assert.match(proc.stderr, /is absent; refusing to run with ambient auth/);
    assert.equal(proc.stdout, "");
  });
});

test("refusal ignores a caller's GH_TOKEN and names GH_SEAT_TOKEN_VALUE, which does work (BLO-37977)", () => {
  // A caller-supplied GH_TOKEN used to be honoured when the named file was
  // missing; it no longer is, so the error must say how to get a working gh.
  withTempDir((dir) => {
    const callerToken = { GH_TOKEN: "user_supplied_override", GITHUB_TOKEN: "user_supplied_override" };
    const refused = spawnWrapper(dir, { extraEnv: callerToken });
    assert.equal(refused.status, 64);
    assert.equal(refused.stdout, "");
    assert.match(refused.stderr, /to run under a specific token, set GH_SEAT_TOKEN_VALUE/);
    assert.doesNotMatch(refused.stderr, /user_supplied_override/);

    const overridden = spawnWrapper(dir, { extraEnv: { ...callerToken, GH_SEAT_TOKEN_VALUE: "ghu_operator" } });
    assert.equal(overridden.status, 0, overridden.stderr);
    assert.match(overridden.stdout, /^GH_TOKEN=ghu_operator$/m);
  });
});

test("still falls back to the real binary when PAPERCLIP_GITHUB_TOKEN_FILE is unset (non-agent image use)", (t) => {
  // The refusals above must not reach a caller that never named a credential —
  // that is the whole non-agent case the wrapper header promises. Skipped
  // inside an agent pod, where the compiled-in default holds the live token and
  // the stub gh would print it to stdout.
  if (existsSync(COMPILED_IN_DEFAULT_TOKEN_FILE)) {
    t.skip(`${COMPILED_IN_DEFAULT_TOKEN_FILE} exists; refusing to read a live credential`);
    return;
  }
  withTempDir((dir) => {
    const proc = spawnWrapper(dir, { args: ["auth", "status"], setTokenFileVar: false });
    assert.equal(proc.status, 0);
    assert.match(proc.stdout, /GH_TOKEN=\n/);
    assert.match(proc.stdout, /ARGS=auth status/);
  });
});

test("refuses when PAPERCLIP_GITHUB_TOKEN_FILE is set but EMPTY (Ally review of c9eb188d)", (t) => {
  // Pins `${VAR+x}` against the `[ -n "${VAR:-}" ]` Ally suggested for the
  // diagnostic's sake: `-n` is false for a set-but-empty value, so it would
  // fall straight through to ambient auth — reopening, for exactly the shape a
  // broken deployment produces, the fail-open this PR exists to close. The
  // message was reworded instead. Same skip as the fallback test above: with
  // the var empty the wrapper resolves the compiled-in default, which holds the
  // live token in an agent pod.
  if (existsSync(COMPILED_IN_DEFAULT_TOKEN_FILE)) {
    t.skip(`${COMPILED_IN_DEFAULT_TOKEN_FILE} exists; refusing to read a live credential`);
    return;
  }
  withTempDir((dir) => {
    const proc = spawnWrapper(dir, {
      args: ["auth", "status"],
      setTokenFileVar: false,
      extraEnv: { PAPERCLIP_GITHUB_TOKEN_FILE: "" },
    });
    assert.equal(proc.status, 64);
    assert.match(proc.stderr, /is absent; refusing to run with ambient auth/);
    // The message must not claim the variable named this path — it did not.
    assert.match(proc.stderr, /is set, so a token file is required, but/);
    assert.equal(proc.stdout, "");
  });
});

test("refuses to spawn against the live compiled-in default token file (Ally review of 396e913f)", (t) => {
  // The mirror of the skip above, which protects only itself: any *new* test
  // taking `setTokenFileVar: false` reaches the same live credential, and the
  // wrapper's `${VAR:-default}` treats unset and empty alike — so assert both
  // shapes. Runs only in the environment that ships, where the hazard exists.
  if (!existsSync(COMPILED_IN_DEFAULT_TOKEN_FILE)) {
    t.skip(`${COMPILED_IN_DEFAULT_TOKEN_FILE} absent; the hazard this guards against is unreachable here`);
    return;
  }
  withTempDir((dir) => {
    assert.throws(() => spawnWrapper(dir, { setTokenFileVar: false }), /refusing to spawn/);
    assert.throws(
      () => spawnWrapper(dir, { setTokenFileVar: false, extraEnv: { PAPERCLIP_GITHUB_TOKEN_FILE: "" } }),
      /refusing to spawn/,
    );
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

test("refuses when the token file exists but isn't readable (BLO-13241 review S2; refusal per BLO-37977)", (t) => {
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
    assert.equal(proc.status, 64);
    assert.match(proc.stderr, /exists but is not readable; refusing to run with ambient auth/);
    assert.equal(proc.stdout, "");
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
      // BLO-40279: the documented `$(cat <token file>)` recipe against a stale
      // /paperclip/.secrets path lands here, not in reject_token_file().
      assert.match(proc.stderr, /stale since BLO-40279/);
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

// ---------------------------------------------------------------------------
// PEN-4933 / PEN-3183 §5 — THE STARVATION ASSERTION.
//
// §5 requires that /etc/gitconfig's system credential helper be *shown* to
// starve once the push credential leaves the agent container, explicitly not
// assumed: git treats a credential helper's non-zero exit as "no credential"
// and carries on, so a broken boundary here fails SILENTLY IN THE PERMISSIVE
// DIRECTION. There is no error anywhere — `git push` simply authenticates.
//
// The claim is about a bare `/usr/bin/git push` from uid 1000, i.e. PEN-3183's
// surviving bypass 4: a caller-chosen PATH misses the egress wrappers entirely,
// so NOTHING on the docker/github-wrappers/ path participates. The chain that
// does run is four links, and the claim holds only if every one of them does:
//
//   A. /etc/gitconfig names `!/usr/bin/gh auth git-credential`
//      -> pinned by the Dockerfile.runtime test directly above (BLO-18484).
//   B. /usr/bin/gh IS this wrapper (a symlink to gh-token-wrapper.sh), not the
//      upstream binary moved aside as gh.real
//      -> pinned below. Link A alone does NOT give you this: the helper string
//         stays byte-identical if /usr/bin/gh is reverted to the real binary.
//   C. the wrapper refuses, rather than falling through to ambient auth, when
//      PAPERCLIP_GITHUB_TOKEN_FILE is set and the file is absent
//      -> that refusal is pinned by the BLO-37977 tests above; the composed
//         form, with git's own stdin protocol, is pinned below.
//   D. the brokered agent container still SETS PAPERCLIP_GITHUB_TOKEN_FILE
//      while not mounting the Secret
//      -> pinned in vendor/paperclip-adapter-claude-k8s/src/server/
//         job-manifest.github-publish-broker.test.ts ("gives the agent a socket
//         to ask over, and nothing that resembles a token").
//
// C and D are a PAIR and either half passes alone while the pair is broken.
// Removing the mount and the variable together reads like tidying up — the
// variable points at a path that no longer exists, so deleting it looks
// correct — and it flips link C from refuse to fall-back-to-unwrapped-auth.
// The positive control at the end of this block is what makes D load-bearing:
// it pins that an unset variable really does re-authenticate, so D is not
// decoration.
//
// ⚠ Correction of record: PEN-3183 §7.3's "expected mechanism" paragraph names
// docker/github-wrappers/paperclip-github-token-env as the binary that starves.
// It is not on this path. That file installs to /usr/local/libexec/paperclip/
// bin/ (Dockerfile:674) and is reached through PATH — which is precisely what
// bypass 4 sidesteps. The decisive conjunct is TOKEN_FILE_REQUIRED in this
// wrapper (gh-token-wrapper.sh), reached via link B. An assertion written
// against the documented mechanism would pin the wrong file and stay green
// while the real chain broke.
// ---------------------------------------------------------------------------

test("link B: /usr/bin/gh is this wrapper, not the real binary (PEN-3183 §5)", () => {
  const dockerfile = readFileSync(path.join(import.meta.dirname, "..", "Dockerfile.runtime"), "utf8");

  // The upstream binary must be moved aside...
  assert.match(
    dockerfile,
    /mv\s+\/usr\/bin\/gh\s+\/usr\/bin\/gh\.real/,
    "Dockerfile.runtime must move the upstream gh aside as /usr/bin/gh.real",
  );
  // ...and /usr/bin/gh must be this wrapper. Without this, the helper string
  // asserted above resolves to a binary that never reads the token file and
  // never refuses, and the starvation claim is false with every other test in
  // this file still green.
  assert.match(
    dockerfile,
    /ln\s+-s\s+\/usr\/bin\/gh-token-wrapper\.sh\s+\/usr\/bin\/gh\b/,
    "/usr/bin/gh must be a symlink to gh-token-wrapper.sh",
  );
});

test("link C composed: the system credential helper returns no credential when the mount is gone (PEN-3183 §5)", () => {
  // Exactly what git runs and exactly what git writes to it. git invokes the
  // helper with the `get` operation and feeds a request on stdin, then reads
  // `username=`/`password=` back off stdout. Approximating this with an
  // arbitrary `gh` subcommand would assert a refusal git never performs.
  withTempDir((dir) => {
    const proc = spawnWrapper(dir, {
      args: ["auth", "git-credential", "get"],
      input: "protocol=https\nhost=github.com\n\n",
    });

    assert.equal(proc.status, 64, proc.stderr);
    assert.match(proc.stderr, /is absent; refusing to run with ambient auth/);

    // The assertion that IS the starvation claim: git consumes stdout, so what
    // matters is that no credential appears there. Checked as the specific keys
    // git parses as well as emptiness, because a future change that made the
    // wrapper chatty on stdout would weaken the blanket check without anyone
    // noticing it had.
    assert.equal(proc.stdout, "");
    assert.doesNotMatch(proc.stdout, /^password=/m);
    assert.doesNotMatch(proc.stdout, /^username=/m);

    // And it starved without reaching the real binary at all — which is also
    // what closes the second fallback §7.3 names, a stale ~/.config/gh/
    // hosts.yml: gh.real is the only thing that would read it, and gh.real did
    // not run. (STUB_GH_SOURCE always prints, so empty stdout proves this.)
  });
});

test("link D is load-bearing: unsetting PAPERCLIP_GITHUB_TOKEN_FILE re-authenticates the helper (PEN-3183 §5)", (t) => {
  // The positive control for the C/D pair. This is the failure mode to guard:
  // remove the Secret mount AND the variable together and the wrapper stops
  // refusing. If this test ever goes red because the wrapper refuses with the
  // variable unset, that is a BEHAVIOUR CHANGE in the wrapper's non-agent
  // contract, not a security regression — read it against the
  // "still falls back to the real binary ... (non-agent image use)" test above
  // before changing anything here.
  //
  // Skipped inside an agent pod for the same reason that one is: with the
  // variable unset the wrapper falls through to the compiled-in default, which
  // holds the live bot token there, and the stub gh prints GH_TOKEN to stdout.
  if (existsSync(COMPILED_IN_DEFAULT_TOKEN_FILE)) {
    t.skip(`${COMPILED_IN_DEFAULT_TOKEN_FILE} exists; refusing to read a live credential`);
    return;
  }
  withTempDir((dir) => {
    const proc = spawnWrapper(dir, {
      args: ["auth", "git-credential", "get"],
      input: "protocol=https\nhost=github.com\n\n",
      setTokenFileVar: false,
    });

    // Reached the real binary: no refusal, and the stub ran. That is the
    // permissive branch link D exists to keep the fleet out of.
    assert.equal(proc.status, 0, proc.stderr);
    assert.match(proc.stdout, /ARGS=auth git-credential get/);
    assert.doesNotMatch(proc.stderr, /refusing to run with ambient auth/);
  });
});

// BLO-25702: `gh auth setup-git` resolves its OWN on-disk path (via
// /proc/self/exe, not argv[0]) when it writes git's credential.*.helper. This
// wrapper delegates by `exec`, so by the time that happens the running binary
// *is* REAL_GH — a plain exec here reproduces the regression the test above
// pins: `gh auth setup-git` (run directly, or via an interactive `gh auth
// login` prompt) clobbers Dockerfile.runtime's correct system-level helper
// with one shelling out to gh.real, which never reads the token file. These
// tests pin that the wrapper intercepts the subcommand and rewrites the
// helper it just wrote back to itself, instead of reproducing the regression
// or silently skipping a command the caller explicitly asked for.

// A stub "real gh" whose `auth setup-git` writes a credential helper
// pointing at ITS OWN path — mirroring gh.real actually resolving its own
// on-disk location rather than argv[0]. Calls /usr/bin/git directly (not
// bare `git`) so the test is hermetic against whatever else PATH resolves
// "git" to in the sandbox this suite happens to run in.
// `gh auth login` writes the identical credential helper as a side effect of
// its own internal setup-git step (interactively-accepted, or via
// `--git-protocol https`) — this stub reproduces that by handling "auth
// login" exactly like "auth setup-git", so tests can pin the wrapper's
// interception of both entry points into the same regression.
const SETUP_GIT_STUB_GH_SOURCE = `#!/bin/sh
if { [ "$1" = "auth" ] && [ "$2" = "setup-git" ]; } || { [ "$1" = "auth" ] && [ "$2" = "login" ]; }; then
  SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
  /usr/bin/git config --global credential."https://github.com".helper ""
  /usr/bin/git config --global --add credential."https://github.com".helper "!\${SELF} auth git-credential"
  /usr/bin/git config --global credential."https://gist.github.com".helper ""
  /usr/bin/git config --global --add credential."https://gist.github.com".helper "!\${SELF} auth git-credential"
  exit 0
fi
echo "STUB-GH-REAL $*"
`;

function runSetupGit(dir, { args = ["auth", "setup-git"], setHome = true, preExistingXdgGitConfig = false } = {}) {
  const stubGhPath = path.join(dir, "gh.real");
  writeFileSync(stubGhPath, SETUP_GIT_STUB_GH_SOURCE);
  chmodSync(stubGhPath, 0o755);

  const homeDir = path.join(dir, "home");
  mkdirSync(homeDir, { recursive: true });
  const selfGhPath = path.join(dir, "gh");

  // Per git-config(1): `--global` writes to "$XDG_CONFIG_HOME/git/config"
  // instead of "${HOME}/.gitconfig" when that XDG file already exists.
  // Pre-creating it here is how the XDG-repair test below exercises that
  // branch; every other test isolates against it by pointing XDG_CONFIG_HOME
  // at a path that does not exist, so it doesn't affect them.
  const xdgConfigHome = path.join(dir, preExistingXdgGitConfig ? "xdg" : "xdg-does-not-exist");
  const xdgGitConfigPath = path.join(xdgConfigHome, "git", "config");
  if (preExistingXdgGitConfig) {
    mkdirSync(path.dirname(xdgGitConfigPath), { recursive: true });
    writeFileSync(xdgGitConfigPath, "");
  }

  const env = sanitizedEnv({
    GH_TOKEN_WRAPPER_REAL_GH: stubGhPath,
    GH_TOKEN_WRAPPER_SELF: selfGhPath,
    PAPERCLIP_GITHUB_TOKEN_FILE: path.join(dir, "does-not-exist"),
    XDG_CONFIG_HOME: xdgConfigHome,
  });
  if (setHome) {
    env.HOME = homeDir;
  } else {
    delete env.HOME;
  }

  const proc = spawnSync("sh", [WRAPPER, ...args], { env, encoding: "utf8" });
  const gitconfigPath = path.join(homeDir, ".gitconfig");
  const gitconfig = existsSync(gitconfigPath) ? readFileSync(gitconfigPath, "utf8") : null;
  const xdgGitConfig = existsSync(xdgGitConfigPath) ? readFileSync(xdgGitConfigPath, "utf8") : null;
  return { proc, gitconfig, gitconfigPath, xdgGitConfig, xdgGitConfigPath, selfGhPath, stubGhPath };
}

test("gh auth setup-git's broken gh.real helper is rewritten back to the wrapper (BLO-25702)", () => {
  withTempDir((dir) => {
    const { proc, gitconfig, selfGhPath, stubGhPath } = runSetupGit(dir);
    assert.equal(proc.status, 0, `wrapper exited non-zero: ${proc.stderr}`);
    assert.ok(gitconfig, "expected gh auth setup-git to write ~/.gitconfig");

    // Both hosts gh.real wrote for must now route through the wrapper...
    assert.match(gitconfig, new RegExp(`!${selfGhPath.replace(/\//g, "\\/")} auth git-credential`, "g"));
    assert.match(gitconfig, /"https:\/\/github\.com"/);
    assert.match(gitconfig, /"https:\/\/gist\.github\.com"/);
    // ...and neither may still shell out to the raw binary.
    assert.doesNotMatch(gitconfig, new RegExp(stubGhPath.replace(/\//g, "\\/")));

    assert.match(proc.stderr, /rewrote the global git config to route through/);
  });
});

test("gh auth login's internal setup-git write is also rewritten back to the wrapper (BLO-25702 review S1)", () => {
  // Ally's review on PR #1311 flagged that the wrapper only special-cased a
  // top-level `gh auth setup-git`: when `gh auth login` runs the identical
  // logic internally (interactively-accepted, or via `--git-protocol
  // https`), the wrapper had already exec'd into REAL_GH for the `login`
  // command, so the repair never ran and the original BLO-25702 failure mode
  // survived under `gh auth login`. This pins that `auth login` is
  // intercepted the same way `auth setup-git` is.
  withTempDir((dir) => {
    const { proc, gitconfig, selfGhPath, stubGhPath } = runSetupGit(dir, { args: ["auth", "login"] });
    assert.equal(proc.status, 0, `wrapper exited non-zero: ${proc.stderr}`);
    assert.ok(gitconfig, "expected gh auth login to write ~/.gitconfig");

    assert.match(gitconfig, new RegExp(`!${selfGhPath.replace(/\//g, "\\/")} auth git-credential`, "g"));
    assert.match(gitconfig, /"https:\/\/github\.com"/);
    assert.match(gitconfig, /"https:\/\/gist\.github\.com"/);
    assert.doesNotMatch(gitconfig, new RegExp(stubGhPath.replace(/\//g, "\\/")));

    assert.match(proc.stderr, /rewrote the global git config to route through/);
  });
});

test("gh.real helper written to $XDG_CONFIG_HOME/git/config is also rewritten (BLO-25702 review S2, PR #1311)", () => {
  // Ally's review on PR #1311 flagged that the repair only ever inspected
  // "${HOME}/.gitconfig", but `git config --global` writes to
  // "$XDG_CONFIG_HOME/git/config" instead whenever that file already exists
  // (git-config(1)) — a pod that set up an XDG git config before `gh auth
  // setup-git`/`gh auth login` ran would silently keep the broken gh.real
  // helper forever, with the wrapper reporting nothing wrong. This pins that
  // the repair finds and fixes that file too, and leaves ~/.gitconfig alone
  // since gh/git never wrote to it in this scenario.
  withTempDir((dir) => {
    const { proc, gitconfig, xdgGitConfig, selfGhPath, stubGhPath } = runSetupGit(dir, {
      preExistingXdgGitConfig: true,
    });
    assert.equal(proc.status, 0, `wrapper exited non-zero: ${proc.stderr}`);
    assert.equal(gitconfig, null, "gh auth setup-git should not have touched ~/.gitconfig here");
    assert.ok(xdgGitConfig, "expected gh auth setup-git to write $XDG_CONFIG_HOME/git/config");

    assert.match(xdgGitConfig, new RegExp(`!${selfGhPath.replace(/\//g, "\\/")} auth git-credential`, "g"));
    assert.match(xdgGitConfig, /"https:\/\/github\.com"/);
    assert.match(xdgGitConfig, /"https:\/\/gist\.github\.com"/);
    assert.doesNotMatch(xdgGitConfig, new RegExp(stubGhPath.replace(/\//g, "\\/")));

    assert.match(proc.stderr, /rewrote the global git config to route through/);
  });
});

test("a REAL_GH/GH_SELF path containing sed/regex metacharacters is repaired without corrupting the gitconfig (BLO-25702 review, PR #1311)", () => {
  // The CTO's review on PR #1311 flagged a second defect with the same root
  // cause as Ally's: the original repair ran the caller-controlled
  // REAL_GH/GH_SELF paths through a hand-built `sed` substitution that only
  // escaped ".", using "#" as the s### delimiter and interpolating GH_SELF
  // unescaped into the replacement. A path containing "#", "&", "\", or
  // another sed/regex metacharacter would corrupt the file instead of
  // failing loudly. The current repair never builds a sed script at all —
  // it goes through `git config --fixed-value`, which treats both paths as
  // exact strings end to end — so this pins that a maximally hostile path
  // (with a "#" delimiter clash, an "&" whole-match backreference, and a
  // literal backslash) round-trips correctly.
  withTempDir((dir) => {
    const nastyDir = path.join(dir, "gh#real&dir\\with-backslash");
    mkdirSync(nastyDir, { recursive: true });
    const stubGhPath = path.join(nastyDir, "gh.real");
    writeFileSync(stubGhPath, SETUP_GIT_STUB_GH_SOURCE);
    chmodSync(stubGhPath, 0o755);

    const nastySelfDir = path.join(dir, "gh#self&dir\\also-backslash");
    mkdirSync(nastySelfDir, { recursive: true });
    const selfGhPath = path.join(nastySelfDir, "gh");

    const homeDir = path.join(dir, "home");
    mkdirSync(homeDir, { recursive: true });

    const env = sanitizedEnv({
      GH_TOKEN_WRAPPER_REAL_GH: stubGhPath,
      GH_TOKEN_WRAPPER_SELF: selfGhPath,
      PAPERCLIP_GITHUB_TOKEN_FILE: path.join(dir, "does-not-exist"),
      XDG_CONFIG_HOME: path.join(dir, "xdg-does-not-exist"),
      HOME: homeDir,
    });

    const proc = spawnSync("sh", [WRAPPER, "auth", "setup-git"], { env, encoding: "utf8" });
    assert.equal(proc.status, 0, `wrapper exited non-zero: ${proc.stderr}`);

    const gitconfigPath = path.join(homeDir, ".gitconfig");
    const gitconfig = readFileSync(gitconfigPath, "utf8");

    // A corrupted file (the old sed bug) would either fail to parse or drop
    // the well-formed helper line; `git config --get` is the authoritative
    // check that git itself still considers the file valid and the value
    // fully intact, backslash and all. Calls /usr/bin/git directly (not bare
    // `git`) for the same hermeticity reason as SETUP_GIT_STUB_GH_SOURCE
    // above — whatever else PATH resolves "git" to in the sandbox this
    // suite happens to run in must not matter here.
    const helper = spawnSync(
      "/usr/bin/git",
      ["config", "--file", gitconfigPath, "--get", "credential.https://github.com.helper"],
      { encoding: "utf8" },
    );
    assert.equal(helper.status, 0, `git could not read the repaired file: ${helper.stderr}`);
    assert.equal(helper.stdout.trim(), `!${selfGhPath} auth git-credential`);
    assert.doesNotMatch(gitconfig, new RegExp(stubGhPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });
});

test("gh auth setup-git interception preserves the real command's exit status", () => {
  withTempDir((dir) => {
    const failingStubPath = path.join(dir, "gh.real");
    writeFileSync(
      failingStubPath,
      `#!/bin/sh\n[ "$1" = "auth" ] && [ "$2" = "setup-git" ] && { echo "no authenticated hosts" >&2; exit 1; }\nexit 0\n`,
    );
    chmodSync(failingStubPath, 0o755);
    const homeDir = path.join(dir, "home");
    mkdirSync(homeDir, { recursive: true });

    const env = sanitizedEnv({
      GH_TOKEN_WRAPPER_REAL_GH: failingStubPath,
      GH_TOKEN_WRAPPER_SELF: path.join(dir, "gh"),
      PAPERCLIP_GITHUB_TOKEN_FILE: path.join(dir, "does-not-exist"),
      XDG_CONFIG_HOME: path.join(dir, "xdg-does-not-exist"),
      HOME: homeDir,
    });

    const proc = spawnSync("sh", [WRAPPER, "auth", "setup-git"], { env, encoding: "utf8" });
    assert.equal(proc.status, 1);
    assert.match(proc.stderr, /no authenticated hosts/);
  });
});

test("gh auth setup-git interception is a silent no-op when nothing was written to ~/.gitconfig", () => {
  // Exercises the case where the real command legitimately touches nothing
  // (e.g. it fails before writing, or writes to a path this stub doesn't
  // simulate) — the wrapper must not fabricate a file, error out, or emit a
  // rewrite diagnostic that didn't happen.
  withTempDir((dir) => {
    const stubGhPath = path.join(dir, "gh.real");
    writeFileSync(stubGhPath, STUB_GH_SOURCE);
    chmodSync(stubGhPath, 0o755);
    const homeDir = path.join(dir, "home");
    mkdirSync(homeDir, { recursive: true });

    const env = sanitizedEnv({
      GH_TOKEN_WRAPPER_REAL_GH: stubGhPath,
      GH_TOKEN_WRAPPER_SELF: path.join(dir, "gh"),
      PAPERCLIP_GITHUB_TOKEN_FILE: path.join(dir, "does-not-exist"),
      XDG_CONFIG_HOME: path.join(dir, "xdg-does-not-exist"),
      HOME: homeDir,
    });

    const proc = spawnSync("sh", [WRAPPER, "auth", "setup-git"], { env, encoding: "utf8" });
    assert.equal(proc.status, 0, `wrapper exited non-zero: ${proc.stderr}`);
    assert.match(proc.stdout, /ARGS=auth setup-git/);
    assert.equal(proc.stderr, "");
    assert.equal(existsSync(path.join(homeDir, ".gitconfig")), false);
  });
});

test("gh auth setup-git interception does not require HOME to be set", () => {
  withTempDir((dir) => {
    const { proc } = runSetupGit(dir, { setHome: false });
    assert.equal(proc.status, 0, `wrapper exited non-zero: ${proc.stderr}`);
  });
});

// BLO-47692: `pr merge --squash` always reaches the real gh with an explicit
// body that carries no AI co-author / "Generated with" line. The stub answers
// `pr view` with a fixed PR body and, for `pr merge`, prints the argv and the
// contents of whatever --body-file it was handed.
const PR_BODY = [
  "Fix the thing.",
  "",
  "values-ack: chart-1.2",
  "Signed-off-by: Dev <dev@example.com>",
  "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>",
  "  co-authored-by: HangPlayerEngineer <h@example.com>",
  "🤖 Generated with [Claude Code](https://claude.com/claude-code)",
].join("\n");
const MERGE_STUB_GH = `#!/bin/sh
if [ "$1 $2" = "pr view" ]; then echo "VIEW=$*" >&2; printf '%s\\n' "$PR_BODY"; exit 0; fi
echo "ARGS=$*"
prev=""
for a; do [ "$prev" = --body-file ] && { echo "BODY<<"; cat "$a"; echo ">>BODY"; }; prev="$a"; done
`;

function runMerge(dir, args, { input, prBody = PR_BODY, status = 0 } = {}) {
  const stub = path.join(dir, "gh.real");
  writeFileSync(stub, MERGE_STUB_GH);
  chmodSync(stub, 0o755);
  const tokenFile = path.join(dir, "token");
  writeFileSync(tokenFile, "ghs_test");
  const env = sanitizedEnv({
    GH_TOKEN_WRAPPER_REAL_GH: stub,
    PAPERCLIP_GITHUB_TOKEN_FILE: tokenFile,
    PR_BODY: prBody,
    TMPDIR: dir,
  });
  const proc = spawnSync("sh", [WRAPPER, ...args], { env, encoding: "utf8", input });
  assert.equal(proc.status, status, proc.stderr);
  const body = /BODY<<\n([\s\S]*?)>>BODY/.exec(proc.stdout)?.[1] ?? null;
  return { proc, args: /^ARGS=(.*)$/m.exec(proc.stdout)?.[1], body };
}

function assertClean(body) {
  assert.ok(body !== null, "no --body-file reached the real gh");
  assert.doesNotMatch(body, /co-authored-by/i);
  assert.doesNotMatch(body, /generated with/i);
}

test("squash merge with no body injects the PR body minus AI trailers (BLO-47692)", () => {
  withTempDir((dir) => {
    const { proc, args, body } = runMerge(dir, ["pr", "merge", "573", "--squash", "-R", "Blockcast/libmmt", "--delete-branch"]);
    assertClean(body);
    assert.match(body, /^Fix the thing\.$/m);
    assert.match(body, /^values-ack: chart-1\.2$/m);
    assert.match(body, /^Signed-off-by: Dev <dev@example\.com>$/m);
    assert.match(proc.stderr, /VIEW=pr view 573 --repo Blockcast\/libmmt --json body/);
    assert.match(args, /^pr merge 573 --squash -R Blockcast\/libmmt --delete-branch --body-file /);
  });
});

for (const [label, flags] of [
  ["--body", (b) => ["--body", b]],
  ["-b", (b) => ["-b", b]],
  ["--body=", (b) => [`--body=${b}`]],
]) {
  test(`squash merge scrubs a caller-supplied ${label} body (BLO-47692)`, () => {
    withTempDir((dir) => {
      const { proc, args, body } = runMerge(dir, ["pr", "merge", "-s", ...flags(PR_BODY)]);
      assertClean(body);
      assert.match(body, /^values-ack: chart-1\.2$/m);
      assert.doesNotMatch(proc.stderr, /VIEW=/, "must not fetch the PR body when the caller gave one");
      assert.doesNotMatch(args, /--body |-b /);
    });
  });
}

test("squash merge scrubs a caller-supplied --body-file, including stdin (BLO-47692)", () => {
  withTempDir((dir) => {
    const f = path.join(dir, "msg");
    writeFileSync(f, PR_BODY);
    const fromFile = runMerge(dir, ["pr", "merge", "--squash", "--body-file", f]);
    assertClean(fromFile.body);
    assert.equal(readFileSync(f, "utf8"), PR_BODY, "the caller's file must not be modified");
    const fromStdin = runMerge(dir, ["pr", "merge", "--squash", "-F", "-"], { input: PR_BODY });
    assertClean(fromStdin.body);
    assert.match(fromStdin.body, /^values-ack: chart-1\.2$/m);
  });
});

// The PR template's required `## Model used` section, and the one-line forms,
// reached main through a squash body (hang-mmt-fec d93d2bba, moqtail-private
// f4e2b747).
const TEMPLATED_BODY = [
  "## Summary",
  "Fix the thing.",
  "",
  "## Model used",
  "Claude Opus 5.5",
  "",
  "## Test plan",
  "- unit tests",
  "Model used: Claude Opus 5.5.",
  "**Model used:** Claude Opus 5.5",
  "values-ack: chart-1.2",
].join("\n");

test("squash merge drops a `## Model used` section and `Model used:` lines (BLO-47692)", () => {
  withTempDir((dir) => {
    const { body } = runMerge(dir, ["pr", "merge", "826", "--squash"], { prBody: TEMPLATED_BODY });
    assert.ok(body !== null);
    assert.doesNotMatch(body, /model used|claude opus/i);
    assert.match(body, /^## Summary\nFix the thing\.$/m);
    assert.match(body, /^## Test plan\n- unit tests$/m, "the section after `## Model used` must survive");
    assert.match(body, /^values-ack: chart-1\.2$/m);
  });
});

// The repo's real PR template, filled in: its checklist says "the model used"
// in prose, which must not trip the post-scrub refusal (review on #2883).
test("squash merge of a body built from the real PR template goes through (BLO-47692)", () => {
  withTempDir((dir) => {
    const template = readFileSync(new URL("../.github/PULL_REQUEST_TEMPLATE.md", import.meta.url), "utf8")
      .replace(/^## Model Used\n([\s\S]*?)^-$/m, "## Model Used\n$1- Claude Opus 5.5 (1M context)");
    assert.match(template, /Claude Opus 5\.5/, "fixture must fill in the Model Used section");
    const { body } = runMerge(dir, ["pr", "merge", "2883", "--squash"], { prBody: template });
    assert.ok(body !== null);
    assert.doesNotMatch(body, /claude opus/i);
    assert.match(body, /^- \[ \] I have specified the model used/m);
  });
});

test("the Model used skip honours code fences and subheadings (BLO-47692)", () => {
  withTempDir((dir) => {
    const prBody = [
      "## Summary",
      "```sh",
      "# Model used for the build",
      "make",
      "```",
      "kept after the fence",
      "## Model used",
      "### Details",
      "Opus 5.5 1M",
      "## Test plan",
      "- unit tests",
      "Regenerated with buf.",
    ].join("\n");
    const { body } = runMerge(dir, ["pr", "merge", "9", "--squash"], { prBody });
    assert.ok(body !== null);
    assert.match(body, /^make\n```\nkept after the fence$/m);
    assert.doesNotMatch(body, /opus|details/i);
    assert.match(body, /^## Test plan\n- unit tests\nRegenerated with buf\.$/m);
  });
});

for (const [label, leftover] of [
  ["a bulleted trailer", "- Co-authored-by: Paperclip <noreply@paperclip.ing>"],
  ["an anthropic noreply address in prose", "Thanks claude <noreply@anthropic.com> for this"],
  ["an inline Generated-with mention", "This was (Generated with Claude Code)"],
]) {
  test(`squash merge is refused when ${label} survives the scrub (BLO-47692)`, () => {
    withTempDir((dir) => {
      const { proc, args } = runMerge(dir, ["pr", "merge", "-s"], { prBody: `Fix.\n${leftover}`, status: 1 });
      assert.equal(args, undefined, "the real merge must not run");
      assert.match(proc.stderr, /refusing the squash merge/);
    });
  });
}

test("prose that documents the Co-authored-by trailer does not refuse the merge (BLO-48206)", () => {
  withTempDir((dir) => {
    const prose = "This PR drops the `Co-authored-by:` trailer from squash bodies.";
    const { body } = runMerge(dir, ["pr", "merge", "-s"], { prBody: `Fix.\n${prose}` });
    assert.ok(body !== null);
    assert.match(body, /^This PR drops the `Co-authored-by:` trailer/m);
  });
});

test("a quoted Co-authored-by trailer is still refused after the scrub (BLO-48206)", () => {
  withTempDir((dir) => {
    const { proc, args } = runMerge(dir, ["pr", "merge", "-s"], {
      prBody: "Fix.\n> Co-authored-by: Dev <dev@example.com>",
      status: 1,
    });
    assert.equal(args, undefined, "the real merge must not run");
    assert.match(proc.stderr, /refusing the squash merge/);
  });
});

test("a `-ds` short-flag cluster is treated as a squash (BLO-47692)", () => {
  withTempDir((dir) => {
    const { body } = runMerge(dir, ["pr", "merge", "7", "-ds"]);
    assertClean(body);
  });
});

for (const args of [
  ["api", "-X", "PUT", "repos/Blockcast/moqtail-private/pulls/563/merge", "-f", "merge_method=squash"],
  ["api", "--method=PUT", "/repos/o/r/pulls/5/merge"],
  ["api", "-X", "Put", "repos/o/r/pulls/5/merge"],
  ["api", "-X=PUT", "repos/o/r/pulls/5/merge"],
  ["api", "graphql", "-f", "query=mutation{mergePullRequest(input:{pullRequestId:\"x\",mergeMethod:SQUASH}){clientMutationId}}"],
  ["api", "graphql", "-f", "query=mutation{enablePullRequestAutoMerge(input:{pullRequestId:\"x\"}){clientMutationId}}"],
]) {
  test(`\`gh ${args.join(" ").slice(0, 70)}\` is refused (BLO-47692)`, () => {
    withTempDir((dir) => {
      const { proc, args: ran } = runMerge(dir, args, { status: 1 });
      assert.equal(ran, undefined, "the real gh must not run");
      assert.match(proc.stderr, /refusing a pull-request merge through `gh api`/);
    });
  });
}

test("read-only gh api calls on the merge endpoint still pass through (BLO-47692)", () => {
  withTempDir((dir) => {
    assert.equal(runMerge(dir, ["api", "repos/o/r/pulls/5/merge"]).args, "api repos/o/r/pulls/5/merge");
    assert.equal(runMerge(dir, ["api", "-X", "PUT", "repos/o/r/pulls/5/update-branch"]).args, "api -X PUT repos/o/r/pulls/5/update-branch");
  });
});

test("non-squash merge is passed through untouched (BLO-47692)", () => {
  withTempDir((dir) => {
    const { proc, args, body } = runMerge(dir, ["pr", "merge", "12", "--rebase"]);
    assert.equal(args, "pr merge 12 --rebase");
    assert.equal(body, null);
    assert.doesNotMatch(proc.stderr, /VIEW=/);
  });
});

// BLO-48359: `gh pr ready` must not un-draft a human hold. The stub answers
// `pr view` with a PR url and `api graphql` with PR_JSON run through the real
// --jq expression, so the hold logic itself is exercised, not a canned verdict.
const READY_STUB_GH = `#!/bin/sh
if [ "$1 $2" = "pr view" ]; then echo https://github.com/Blockcast/pim-multicast-gateway/pull/4057; exit 0; fi
if [ "$1 $2" = "api graphql" ]; then
  prev=""; for a; do [ "$prev" = --jq ] && q="$a"; prev="$a"; done
  printf '%s' "$PR_JSON" | jq -r "$q"; exit $?
fi
echo "ARGS=$*"
`;

// `allyblockcast` is the App (GraphQL `Bot`); every other login is a human `User`.
const who = (login) => ({ login, __typename: login === "allyblockcast" ? "Bot" : "User" });

function prJson({ author = "allyblockcast", draftedBy, comments = [], isDraft = true }) {
  return JSON.stringify({ data: { repository: { pullRequest: {
    isDraft,
    author: who(author),
    timelineItems: { nodes: draftedBy ? [{ createdAt: "2026-10-22T03:51:35Z", actor: who(draftedBy) }] : [] },
    comments: { nodes: comments.map(([login, body]) => ({ author: who(login), createdAt: "2026-10-22T03:51:04Z", url: "u", body })) },
  } } } });
}

function runReady(dir, args, pr, status) {
  const stub = path.join(dir, "gh.real");
  writeFileSync(stub, READY_STUB_GH);
  chmodSync(stub, 0o755);
  const tokenFile = path.join(dir, "token");
  writeFileSync(tokenFile, "ghs_test");
  const env = sanitizedEnv({ GH_TOKEN_WRAPPER_REAL_GH: stub, PAPERCLIP_GITHUB_TOKEN_FILE: tokenFile, PR_JSON: pr });
  const proc = spawnSync("sh", [WRAPPER, ...args], { env, encoding: "utf8" });
  assert.equal(proc.status, status, proc.stderr);
  return { proc, ran: /^ARGS=(.*)$/m.exec(proc.stdout)?.[1] };
}

for (const [label, pr] of [
  // The #4057 replay: Ally-authored, green, C0/I0, drafted by the drive session.
  ["drafted by someone other than the author", prJson({ draftedBy: "kkroo" })],
  ["a non-author hold comment", prJson({ comments: [["kkroo", "Production hold: this needs the user's go before landing."]] })],
  ["a non-author 'do not merge'", prJson({ comments: [["kkroo", "Do NOT merge until the gitlink moves."]] })],
  // paperclip#2910: human-authored, drafted by that same human.
  ["a human's own draft of their own PR", prJson({ author: "kkroo", draftedBy: "kkroo" })],
  ["a PR a human opened as a draft", prJson({ author: "kkroo" })],
  ["a human author's own hold comment", prJson({ author: "kkroo", draftedBy: "allyblockcast", comments: [["kkroo", "do not merge yet"]] })],
]) {
  test(`gh pr ready is refused on ${label} (BLO-48359)`, () => {
    withTempDir((dir) => {
      const { proc, ran } = runReady(dir, ["pr", "ready", "4057", "-R", "Blockcast/pim-multicast-gateway"], pr, 1);
      assert.equal(ran, undefined, "the real gh must not un-draft");
      assert.match(proc.stderr, /human hold/);
    });
  });
}

for (const [label, pr] of [
  ["a plain draft", prJson({})],
  ["a draft the author itself drafted", prJson({ draftedBy: "allyblockcast" })],
  ["hold language only in the agent's own comments", prJson({ comments: [["allyblockcast", "do not merge yet"]] })],
  ["a human PR the agent itself drafted", prJson({ author: "kkroo", draftedBy: "allyblockcast" })],
  ["a PR that is not a draft", prJson({ author: "kkroo", draftedBy: "kkroo", isDraft: false })],
]) {
  test(`gh pr ready passes through on ${label} (BLO-48359)`, () => {
    withTempDir((dir) => {
      assert.equal(runReady(dir, ["pr", "ready", "7"], pr, 0).ran, "pr ready 7");
    });
  });
}

test("gh pr ready --undo is never checked (BLO-48359)", () => {
  withTempDir((dir) => {
    assert.equal(runReady(dir, ["pr", "ready", "7", "--undo"], prJson({ draftedBy: "kkroo" }), 0).ran, "pr ready 7 --undo");
  });
});

test("gh pr ready fails closed when the PR cannot be read (BLO-48359)", () => {
  withTempDir((dir) => {
    const { ran } = runReady(dir, ["pr", "ready", "7"], "not json", 1);
    assert.equal(ran, undefined);
  });
});

test("gh pr ready fails closed on a GraphQL error with no PR (BLO-48359)", () => {
  withTempDir((dir) => {
    const { ran } = runReady(dir, ["pr", "ready", "7"], JSON.stringify({ data: { repository: null } }), 1);
    assert.equal(ran, undefined);
  });
});

test("markPullRequestReadyForReview through gh api is refused (BLO-48359)", () => {
  withTempDir((dir) => {
    const { proc, ran } = runReady(dir, ["api", "graphql", "-f", "query=mutation{markPullRequestReadyForReview(input:{pullRequestId:\"x\"}){clientMutationId}}"], prJson({}), 1);
    assert.equal(ran, undefined);
    assert.match(proc.stderr, /use `gh pr ready`/);
  });
});

// --- PEN-5241: `gh paperclip-auth-check` -----------------------------------
//
// The defect these pin: `401 Bad credentials` is byte-identical for a revoked
// token, an expired token, an unset variable, an empty file read and an empty
// `Authorization: Bearer `. Two agents reached opposite wrong conclusions from
// it inside fifteen minutes on 2026-11-02 (PEN-5239, PEN-5226). So the property
// under test is not "the self-test runs" — it is that the states GitHub
// collapses into one string come back DISTINGUISHABLE, in both the verdict text
// and the exit code, which is what a script can branch on.

// Deliberately short. The publish guard's vendor-key rule matches
// `gh[pousr]_` followed by 20+ word characters and refuses the push outright —
// a fixture is indistinguishable from a real token to a regex, which is the
// point of the rule. Every other `ghs_` fixture in this file is short for the
// same reason; keep new ones under that bound (PEN-3920).
const AUTH_CHECK_VALID_TOKEN = "ghs_valid_app_tok";

// A stand-in for api.github.com. The verdict logic keys on the exact signature
// PEN-5239 established as the working oracle — an *unauthenticated* /rate_limit
// beside an authenticated /installation/repositories — so the stub reproduces
// both arms, including the 60/hr anonymous rate limit that separates "fell
// through to anonymous" from "authenticated as the App". Local HTTP, so the
// suite keeps running with no network and no credential.
//
// It runs in its OWN PROCESS, and that is load-bearing rather than tidiness.
// Every assertion here drives the wrapper through spawnSync, which blocks this
// process's event loop until the child exits — so a server on this loop could
// never answer the curl that child is making, and every probe would instead sit
// out its --max-time and come back as GITHUB_UNREACHABLE. That failure mode is
// a nasty one because the suite still goes green: GITHUB_UNREACHABLE is a
// verdict these tests legitimately assert elsewhere, so the stub would look
// like it was working while testing nothing. Same written-to-disk-then-spawned
// shape as STUB_GH_SOURCE above.
const STUB_GITHUB_SOURCE = `import http from "node:http";

const VALID = ${JSON.stringify(AUTH_CHECK_VALID_TOKEN)};

const server = http.createServer((req, res) => {
  const auth = req.headers.authorization ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
  const authenticated = token === VALID;

  if (req.url.startsWith("/rate_limit")) {
    // An empty or garbage Bearer gets the 401 GitHub really returns; a request
    // carrying no header at all is the anonymous control, limited to 60/hr.
    if (token && !authenticated) {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end(JSON.stringify({ message: "Bad credentials", status: "401" }));
    }
    res.writeHead(200, { "x-ratelimit-limit": authenticated ? "9500" : "60" });
    return res.end("{}");
  }

  if (req.url.startsWith("/installation/repositories")) {
    if (!authenticated) {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end(JSON.stringify({ message: "Bad credentials", status: "401" }));
    }
    res.writeHead(200, { "x-ratelimit-limit": "9500" });
    return res.end("{}");
  }

  res.writeHead(404);
  res.end("{}");
});

server.listen(0, "127.0.0.1", () => {
  process.stdout.write(\`PORT=\${server.address().port}\\n\`);
});
`;

async function withStubGitHub(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "gh-stub-github-"));
  const scriptPath = path.join(dir, "stub-github.mjs");
  writeFileSync(scriptPath, STUB_GITHUB_SOURCE);

  const child = spawn(process.execPath, [scriptPath], { stdio: ["ignore", "pipe", "inherit"] });
  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("stub GitHub did not report a port within 10s")), 10_000);
      let buffered = "";
      child.stdout.on("data", (chunk) => {
        buffered += chunk;
        const match = buffered.match(/PORT=(\d+)/);
        if (match) {
          clearTimeout(timer);
          resolve(Number(match[1]));
        }
      });
      child.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`stub GitHub exited early with code ${code}`));
      });
    });
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    // SIGKILL, not SIGTERM: curl holds the connection open, so a graceful close
    // would wait on a socket nothing is going to read again.
    child.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
}

// Always assigns PAPERCLIP_GITHUB_TOKEN_FILE, for the same reason spawnWrapper
// guards it: unset resolves to the compiled-in default, which inside an agent
// pod is the live fleet credential — and this subcommand would then probe real
// GitHub with it. tokenFilePath lets a caller supply a path it built itself
// (the mount-generation test needs a kubelet-shaped directory).
function runAuthCheck(dir, { tokenFileContent, tokenValue, tokenFilePath, apiBase, mode } = {}) {
  const env = sanitizedEnv({});
  if (apiBase !== undefined) env.GH_TOKEN_WRAPPER_API_BASE = apiBase;
  if (tokenValue !== undefined) env.GH_SEAT_TOKEN_VALUE = tokenValue;

  let filePath = tokenFilePath;
  if (filePath === undefined) {
    if (tokenFileContent === undefined) {
      filePath = path.join(dir, "does-not-exist");
    } else {
      filePath = path.join(dir, "token");
      writeFileSync(filePath, tokenFileContent);
      if (mode !== undefined) chmodSync(filePath, mode);
    }
  }
  env.PAPERCLIP_GITHUB_TOKEN_FILE = filePath;

  return spawnSync("sh", [WRAPPER, "paperclip-auth-check"], { env, encoding: "utf8" });
}

// THE REQUIRED REGRESSION (PEN-5241 Done-when #4). An empty/unreadable file and
// a token GitHub refuses are the two states that both surface as `401 Bad
// credentials` through any ordinary probe. They must never be reported alike:
// one is a configuration fault on this pod, the other is a dead credential for
// everyone holding that generation, and the remedies have nothing in common.
test("reports an empty token file distinctly from a token GitHub rejects (PEN-5241)", async () => {
  await withStubGitHub(async (apiBase) => {
    withTempDir((dir) => {
      const empty = runAuthCheck(dir, { tokenFileContent: "", apiBase });
      const rejected = runAuthCheck(dir, { tokenFileContent: "ghs_revoked_token\n", apiBase });

      assert.match(empty.stdout, /verdict:\s+NO_CREDENTIAL/);
      assert.doesNotMatch(empty.stdout, /REJECTED/);
      assert.equal(empty.status, 2);

      assert.match(rejected.stdout, /verdict:\s+REJECTED/);
      assert.doesNotMatch(rejected.stdout, /NO_CREDENTIAL/);
      assert.equal(rejected.status, 1);

      // The exit codes are the part a caller can branch on without parsing prose.
      assert.notEqual(empty.status, rejected.status);
    });
  });
});

test("reports an unreadable token file distinctly from a token GitHub rejects (PEN-5241)", async (t) => {
  // Same root caveat as the unreadable-file refusal test above.
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    t.skip("running as root; permission bits don't apply");
    return;
  }
  await withStubGitHub(async (apiBase) => {
    // A temp dir each: both arms write `token`, and the unreadable one leaves it
    // mode 000, so sharing a dir makes the second writeFileSync fail EACCES.
    const unreadable = withTempDir((dir) =>
      runAuthCheck(dir, { tokenFileContent: "ghs_unreadable\n", mode: 0o000, apiBase }),
    );
    assert.match(unreadable.stdout, /credential:\s+exists-but-unreadable/);
    assert.match(unreadable.stdout, /verdict:\s+NO_CREDENTIAL/);
    assert.equal(unreadable.status, 2);

    const rejected = withTempDir((dir) =>
      runAuthCheck(dir, { tokenFileContent: "ghs_revoked_token\n", apiBase }),
    );
    assert.equal(rejected.status, 1);
    assert.notEqual(unreadable.status, rejected.status);
  });
});

test("reports an absent token file as NO_CREDENTIAL and says gh will refuse, not fall back", async () => {
  await withStubGitHub(async (apiBase) => {
    withTempDir((dir) => {
      const proc = runAuthCheck(dir, { apiBase });
      assert.match(proc.stdout, /credential:\s+absent/);
      assert.match(proc.stdout, /verdict:\s+NO_CREDENTIAL/);
      // The wrong remedy here is "retry and hope"; say which way the wrapper fails.
      assert.match(proc.stdout, /will NOT fall back to ambient auth/);
      assert.equal(proc.status, 2);
    });
  });
});

test("reports a healthy installation token as OK with its rate limit", async () => {
  await withStubGitHub(async (apiBase) => {
    withTempDir((dir) => {
      const proc = runAuthCheck(dir, { tokenFileContent: `${AUTH_CHECK_VALID_TOKEN}\n`, apiBase });
      assert.match(proc.stdout, /verdict:\s+OK — valid GitHub App installation token/);
      assert.match(proc.stdout, /authenticated:\s+\/installation\/repositories -> 200, x-ratelimit-limit 9500/);
      assert.equal(proc.status, 0);
    });
  });
});

// PEN-5239 had to establish this by hand, mid-incident, to know whether it was
// looking at a dead credential or a dead network. Reporting a transport failure
// as a credential fault is what sends an agent to rotate a healthy token.
test("reports GITHUB_UNREACHABLE rather than a credential fault when the API never answers", async () => {
  withTempDir((dir) => {
    // Reserved, guaranteed-unroutable port on loopback: connect fails fast and
    // locally, with no DNS and no dependence on the sandbox's egress policy.
    const proc = runAuthCheck(dir, {
      tokenFileContent: `${AUTH_CHECK_VALID_TOKEN}\n`,
      apiBase: "http://127.0.0.1:1",
    });
    assert.match(proc.stdout, /verdict:\s+GITHUB_UNREACHABLE/);
    assert.match(proc.stdout, /this is NOT a credential fault/);
    assert.match(proc.stdout, /github-reachable:\s+NO/);
    assert.equal(proc.status, 4);
  });
});

// An authenticated 401 is only evidence about the credential if GitHub answered
// the unauthenticated control. Without that pairing a network fault reads as a
// revoked token — the exact inversion of the test above, and the reason the
// unauthenticated probe is unconditional rather than a fallback.
test("will not call a token REJECTED when unauthenticated GitHub is unreachable too", async () => {
  withTempDir((dir) => {
    const proc = runAuthCheck(dir, { tokenFileContent: "ghs_revoked_token\n", apiBase: "http://127.0.0.1:1" });
    assert.doesNotMatch(proc.stdout, /REJECTED/);
    assert.match(proc.stdout, /verdict:\s+GITHUB_UNREACHABLE/);
    assert.equal(proc.status, 4);
  });
});

// The whole point of a self-test an agent can run during an incident is that its
// output is safe to paste into an issue thread. A truncated hash identifies a
// generation; the token identifies the bearer.
test("prints a truncated hash and never the credential itself", async () => {
  await withStubGitHub(async (apiBase) => {
    withTempDir((dir) => {
      const proc = runAuthCheck(dir, { tokenFileContent: `${AUTH_CHECK_VALID_TOKEN}\n`, apiBase });
      const output = `${proc.stdout}${proc.stderr}`;
      assert.doesNotMatch(output, /ghs_valid_app_tok/);
      assert.match(proc.stdout, /token-sha256:\s+[0-9a-f]{8}$/m);
    });
  });
});

test("prints a truncated hash and never the credential itself on the seat-value path", async () => {
  await withStubGitHub(async (apiBase) => {
    withTempDir((dir) => {
      const proc = runAuthCheck(dir, { tokenValue: AUTH_CHECK_VALID_TOKEN, apiBase });
      const output = `${proc.stdout}${proc.stderr}`;
      assert.doesNotMatch(output, /ghs_valid_app_tok/);
      assert.match(proc.stdout, /source:\s+GH_SEAT_TOKEN_VALUE/);
      assert.equal(proc.status, 0);
    });
  });
});

// The field whose absence produced PEN-5241's own false clear: the CTO measured
// a 200 on a *later* generation than the one being reported on, and wrote the
// all-clear into the bug report. The rotator re-mints every 20 minutes and
// kubelet propagates into a running pod within seconds, so a result that does
// not name its generation cannot be compared across pods OR across time.
test("reports the kubelet mount generation backing a Secret-mounted token", async () => {
  await withStubGitHub(async (apiBase) => {
    withTempDir((dir) => {
      // kubelet's atomic writer: a `..<timestamp>.<nonce>` directory holding the
      // payload, with `..data` flipped at it and the key symlinked through.
      //
      // The nonce is derived rather than written out. A real one is a ~10-digit
      // run, which is credential-shaped to the publish guard and refuses the
      // push (PEN-3920) — and the assertion does not care what it is, only that
      // whatever kubelet chose comes back verbatim.
      const generation = `..2026_11_02_03_40_22.${Date.now()}`;
      mkdirSync(path.join(dir, generation));
      writeFileSync(path.join(dir, generation, "token"), `${AUTH_CHECK_VALID_TOKEN}\n`);
      symlinkSync(generation, path.join(dir, "..data"));
      symlinkSync(path.join("..data", "token"), path.join(dir, "token"));

      const proc = runAuthCheck(dir, { tokenFilePath: path.join(dir, "token"), apiBase });
      assert.match(proc.stdout, new RegExp(`mount-generation:\\s+${generation.replace(/\./g, "\\.")}`));
      assert.equal(proc.status, 0);
    });
  });
});

test("reports no mount generation for a token file that is not a Secret mount", async () => {
  await withStubGitHub(async (apiBase) => {
    withTempDir((dir) => {
      const proc = runAuthCheck(dir, { tokenFileContent: `${AUTH_CHECK_VALID_TOKEN}\n`, apiBase });
      assert.match(proc.stdout, /mount-generation:\s+-$/m);
    });
  });
});

// Property 1 of the subcommand: it is dispatched above every credential branch.
// A diagnostic that needs a working credential to report a broken one is not a
// diagnostic — and with PAPERCLIP_GITHUB_TOKEN_FILE set to an absent path, every
// other `gh` invocation on this pod exits 64 without reaching the binary.
test("answers even in the state where every other gh invocation exits 64", async () => {
  await withStubGitHub(async (apiBase) => {
    withTempDir((dir) => {
      const refused = spawnWrapper(dir, { args: ["api", "user"] });
      assert.equal(refused.status, 64);

      const check = runAuthCheck(dir, { apiBase });
      assert.match(check.stdout, /verdict:\s+NO_CREDENTIAL/);
      assert.equal(check.status, 2);
    });
  });
});

// The ambient-auth arm: PAPERCLIP_GITHUB_TOKEN_FILE unset AND the compiled-in
// default absent. The tail of the wrapper then `exec`s the real binary with no
// override, so `gh` authenticates with whatever the CALLER had — its own
// GH_TOKEN/GITHUB_TOKEN, or ~/.config/gh/hosts.yml. Two outputs used to claim
// otherwise: the verdict said gh "falls through to unauthenticated GitHub", and
// the `auth status` notice said "$GH_TOKEN is empty there" when in this branch
// it is the caller's own variable and is set. A diagnostic that contradicts the
// path it diagnoses is worse than no diagnostic, which is the entire premise of
// PEN-5241 — so this arm gets coverage rather than staying the one branch
// runAuthCheck structurally cannot reach (it always assigns the file variable).
//
// Reaching it needs the compiled-in default redirected, because the real one is
// the live fleet credential inside an agent pod. Rewriting it in a copy of the
// script keeps the test hermetic instead of skipping wherever the mount exists.
function wrapperWithRedirectedDefault(dir) {
  const source = readFileSync(WRAPPER, "utf8");
  const redirected = source.replace(
    COMPILED_IN_DEFAULT_TOKEN_FILE,
    path.join(dir, "no-such-compiled-in-default"),
  );
  assert.notEqual(redirected, source, "compiled-in default path not found in the wrapper");
  assert.ok(
    !redirected.includes(COMPILED_IN_DEFAULT_TOKEN_FILE),
    "a reference to the live default token file survived the redirect",
  );
  const copy = path.join(dir, "gh-token-wrapper-ambient.sh");
  writeFileSync(copy, redirected);
  return copy;
}

test("the no-credential-supplied arm reports ambient auth, and does not claim gh goes unauthenticated", async () => {
  await withStubGitHub(async (apiBase) => {
    withTempDir((dir) => {
      const env = sanitizedEnv({ GH_TOKEN_WRAPPER_API_BASE: apiBase });
      // The premise of the branch: the caller HAS ambient auth of its own.
      env.GH_TOKEN = "caller_supplied_token";
      const proc = spawnSync("sh", [wrapperWithRedirectedDefault(dir), "paperclip-auth-check"], {
        env,
        encoding: "utf8",
      });

      assert.equal(proc.status, 3);
      assert.match(proc.stdout, /verdict:\s+AMBIENT_AUTH/);
      // The claim that was false: this check never probed the caller's token.
      assert.match(proc.stdout, /does NOT probe that/);
      assert.doesNotMatch(proc.stdout, /falls through to unauthenticated GitHub/);
      // And it still must not print credential material on this path.
      assert.doesNotMatch(proc.stdout, /caller_supplied_token/);
      assert.doesNotMatch(proc.stderr, /caller_supplied_token/);
    });
  });
});

test("gh auth status does not claim $GH_TOKEN is empty when the wrapper exported nothing", () => {
  withTempDir((dir) => {
    const stubGhPath = path.join(dir, "gh.real");
    writeFileSync(stubGhPath, STUB_GH_SOURCE);
    chmodSync(stubGhPath, 0o755);

    const env = sanitizedEnv({ GH_TOKEN_WRAPPER_REAL_GH: stubGhPath });
    env.GH_TOKEN = "caller_supplied_token";
    const proc = spawnSync("sh", [wrapperWithRedirectedDefault(dir), "auth", "status"], {
      env,
      encoding: "utf8",
    });

    assert.equal(proc.status, 0);
    // gh really does see the caller's GH_TOKEN here — the wrapper did not
    // override it — so the "(GH_TOKEN) is not set in your shell" correction
    // would be backwards. Assert on the stub rather than trusting the branch.
    assert.match(proc.stdout, /GH_TOKEN=caller_supplied_token/);
    assert.doesNotMatch(proc.stderr, /\$GH_TOKEN is empty there/);
    assert.match(proc.stderr, /this wrapper supplied no credential/i);
    assert.match(proc.stderr, /does NOT probe ambient auth/);
  });
});

// PEN-5241 re-review, suggestion 1. `auth_check_probe` runs inside `$(…)`, so
// its `exit 70` ends only the subshell: the caller saw an empty `set --`,
// `anon_code="$1"` tripped `set -u`, and the wrapper died with rc 2 — which is
// the NO_CREDENTIAL verdict code. A caller branching on the exit status would
// have read a broken TMPDIR as a missing credential, which is exactly the
// collapse-two-faults-into-one-signal bug this subcommand exists to end.
// TMPDIR points at a path that is not a directory rather than a read-only one,
// so mktemp fails for root too and the test does not depend on the uid of CI.
test("a temp-dir fault exits 70, not the NO_CREDENTIAL code (PEN-5241)", () => {
  withTempDir((dir) => {
    const tokenFile = path.join(dir, "token");
    writeFileSync(tokenFile, `${AUTH_CHECK_VALID_TOKEN}\n`);
    const env = sanitizedEnv({});
    env.PAPERCLIP_GITHUB_TOKEN_FILE = tokenFile;
    env.TMPDIR = path.join(dir, "not-a-directory");
    const proc = spawnSync("sh", [WRAPPER, "paperclip-auth-check"], { env, encoding: "utf8" });

    assert.equal(proc.status, 70);
    assert.notEqual(proc.status, 2, "a temp-dir fault must not share the NO_CREDENTIAL exit code");
    assert.match(proc.stderr, /cannot create a temp file in/);
    // The `set -u` death this guard replaced. It named a line number and a
    // positional parameter, which tells an agent mid-incident nothing at all.
    assert.doesNotMatch(proc.stderr, /parameter not set/);
  });
});

// PEN-5241 re-review, suggestion 2. `-` is the probe's "no limit header seen",
// so rendering it as "(rate limit -/hr)" dresses an unknown up as a reading —
// the same category error as reporting an unreachable API as a bad credential.
test("the ambient verdict omits the rate limit when the anonymous probe never answered", () => {
  withTempDir((dir) => {
    const env = sanitizedEnv({ GH_TOKEN_WRAPPER_API_BASE: "http://127.0.0.1:1" });
    const proc = spawnSync("sh", [wrapperWithRedirectedDefault(dir), "paperclip-auth-check"], {
      env,
      encoding: "utf8",
    });

    assert.equal(proc.status, 3);
    assert.match(proc.stdout, /verdict:\s+AMBIENT_AUTH/);
    assert.doesNotMatch(proc.stdout, /rate limit -\/hr/);
    // The reachability line still reports the transport failure in full; it is
    // only the verdict's parenthetical that had nothing to say.
    assert.match(proc.stdout, /did not complete/);
  });
});

// Done-when #2. `gh auth status` reports "(GH_TOKEN)" because that is what this
// wrapper handed the binary — but GH_TOKEN is not set in the caller's shell, so
// the obvious follow-up (`curl -H "Authorization: Bearer $GH_TOKEN"`) sends an
// empty Bearer and returns 401 whatever the credential's health. That is a
// one-command false positive that reads as confirmation, so the correction has
// to land on `auth status` itself, not in a runbook nobody opens mid-incident.
test("gh auth status names the real credential source instead of leaving (GH_TOKEN) to misdirect", () => {
  withTempDir((dir) => {
    const proc = spawnWrapper(dir, { tokenFileContent: "ghs_sometoken\n", args: ["auth", "status"] });
    assert.equal(proc.status, 0);
    assert.match(proc.stderr, /credential source is the file named by PAPERCLIP_GITHUB_TOKEN_FILE/);
    assert.match(proc.stderr, /\$GH_TOKEN is empty there/);
    assert.match(proc.stderr, /gh paperclip-auth-check/);
    // The correction goes to stderr so nothing parsing gh's stdout changes.
    assert.doesNotMatch(proc.stdout, /credential source is/);
  });
});

test("gh auth status names GH_SEAT_TOKEN_VALUE when that is what supplied the token", () => {
  withTempDir((dir) => {
    const proc = spawnWrapper(dir, {
      extraEnv: { GH_SEAT_TOKEN_VALUE: "ghs_seat_token" },
      args: ["auth", "status"],
    });
    assert.equal(proc.status, 0);
    assert.match(proc.stderr, /credential source is GH_SEAT_TOKEN_VALUE/);
  });
});

// Noise on every invocation would get the line filtered out, and it would also
// change the stderr of commands whose stderr callers already parse.
test("the credential-source line appears only on auth status", () => {
  withTempDir((dir) => {
    const proc = spawnWrapper(dir, { tokenFileContent: "ghs_sometoken\n", args: ["api", "user"] });
    assert.equal(proc.status, 0);
    assert.doesNotMatch(proc.stderr, /credential source is/);
  });
});

// Discoverability: the moment an agent is most likely to need the self-test is
// the moment the wrapper is refusing, so the refusal names it.
test("the exit-64 refusal names the self-test", () => {
  withTempDir((dir) => {
    const proc = spawnWrapper(dir, { args: ["api", "user"] });
    assert.equal(proc.status, 64);
    assert.match(proc.stderr, /gh paperclip-auth-check/);
  });
});

// --- PEN-5255: the self-test must not drift away from the path it diagnoses --
//
// `paperclip_auth_check` reports what the GH_SEAT_TOKEN_VALUE branch WOULD do.
// It used to say so by re-implementing that branch's precedence and trimming
// instead of sharing it, and nothing held the two together: Ally mutated the
// check's copy three ways — dropped the leading-whitespace trim, swapped
// `${GH_SEAT_TOKEN_VALUE+x}` for `-n`, disabled the embedded-whitespace
// refusal — and the suite stayed green through every one. A diagnostic that
// disagrees with the path it diagnoses is worse than no diagnostic because it
// is confident, which is the entire thesis of PEN-5241; shipping an unpinned
// duplicate of its subject quietly reopened it.
//
// `trim_seat_token` now gives both sites one implementation, which closes the
// two trim mutations by construction. It cannot reach the third: WHICH BRANCH
// is selected for a set-but-empty value is not trimming, and no amount of
// extraction pins it. So that one is asserted directly, as the biconditional a
// caller actually relies on —
//
//     verdict is NO_CREDENTIAL   <=>   `gh api user` exits 64
//
// — over the four values whose handling differs between the two states GitHub
// collapses into one string.
//
// Each case runs twice, with and without a VALID token file also present, and
// that second column is the part that earns its keep. It is what pins branch
// selection: with a good readable file behind it, a check that fell through to
// the file branch reports OK while the real path still exits 64. With no file
// there the same mutation is INVISIBLE — the file branch's own refusal then
// yields NO_CREDENTIAL for an unrelated reason and the biconditional still
// holds. Measured, not assumed: against mutation (b) this test fails on the
// with-file column and passes with that column removed.
const SEAT_TOKEN_PARITY_CASES = [
  // Set-but-empty is the sharp one: it is a *named* credential that is not
  // usable, so the real path refuses rather than falling back, and the check
  // has to agree that nothing usable was supplied.
  { name: "set but empty", tokenValue: "", expectNoCredential: true },
  { name: "whitespace only", tokenValue: "  ", expectNoCredential: true },
  // The one value in the table that is usable, and only after trimming — so it
  // is also the only case that can show the two sides trimming differently.
  { name: "surrounded by whitespace", tokenValue: " ghs_x\n", expectNoCredential: false, trimsTo: "ghs_x" },
  { name: "embedded whitespace", tokenValue: "a b", expectNoCredential: true },
];

// Drives both halves of the biconditional under one identical environment —
// same value, same token file, same stub GitHub — because the claim is about
// the two agreeing, and building their premises separately is how they would
// come to disagree without the test noticing.
function runSeatTokenParity(dir, { tokenValue, apiBase, withValidTokenFile }) {
  const stubGhPath = path.join(dir, "gh.real");
  writeFileSync(stubGhPath, STUB_GH_SOURCE);
  chmodSync(stubGhPath, 0o755);

  let tokenFilePath = path.join(dir, "does-not-exist");
  if (withValidTokenFile) {
    tokenFilePath = path.join(dir, "token");
    writeFileSync(tokenFilePath, `${AUTH_CHECK_VALID_TOKEN}\n`);
  }

  // Assigned through sanitizedEnv's overrides, so GH_SEAT_TOKEN_VALUE arrives
  // set-but-empty for the "" case rather than unset — which is the whole
  // premise of that row, and the difference `+x` reads and `-n` does not.
  const env = sanitizedEnv({
    GH_SEAT_TOKEN_VALUE: tokenValue,
    PAPERCLIP_GITHUB_TOKEN_FILE: tokenFilePath,
    GH_TOKEN_WRAPPER_API_BASE: apiBase,
    GH_TOKEN_WRAPPER_REAL_GH: stubGhPath,
  });

  return {
    check: spawnSync("sh", [WRAPPER, "paperclip-auth-check"], { env, encoding: "utf8" }),
    real: spawnSync("sh", [WRAPPER, "api", "user"], { env, encoding: "utf8" }),
  };
}

test("the self-test's verdict and the real path's exit code agree on every seat-token shape (PEN-5255)", async () => {
  await withStubGitHub(async (apiBase) => {
    for (const parityCase of SEAT_TOKEN_PARITY_CASES) {
      for (const withValidTokenFile of [false, true]) {
        withTempDir((dir) => {
          const { check, real } = runSeatTokenParity(dir, {
            tokenValue: parityCase.tokenValue,
            apiBase,
            withValidTokenFile,
          });
          const premise = `${parityCase.name}${withValidTokenFile ? " + valid token file behind it" : " + no token file"}`;

          // A check that died before printing would make every comparison below
          // vacuously true, and 70 (temp-dir fault) is the realistic way that
          // happens in CI. Fail on it explicitly rather than measuring nothing.
          assert.notEqual(check.status, 70, `${premise}: self-test hit a temp-dir fault\n${check.stderr}`);
          assert.match(check.stdout, /verdict:\s+\S/, `${premise}: self-test printed no verdict\n${check.stderr}`);

          const saysNoCredential = /verdict:\s+NO_CREDENTIAL\b/.test(check.stdout);
          const realRefuses = real.status === 64;

          // Both absolute expectations AND the biconditional. The pair alone
          // would still pass a mutation that moved both sides together; the
          // biconditional alone would not say which side went wrong.
          assert.equal(
            saysNoCredential,
            parityCase.expectNoCredential,
            `${premise}: self-test verdict is wrong on its own terms\n${check.stdout}`,
          );
          assert.equal(
            realRefuses,
            parityCase.expectNoCredential,
            `${premise}: real path exited ${real.status}, expected ${parityCase.expectNoCredential ? 64 : "not 64"}\n${real.stdout}${real.stderr}`,
          );
          assert.equal(
            saysNoCredential,
            realRefuses,
            `${premise}: self-test and real path disagree — verdict NO_CREDENTIAL=${saysNoCredential}, real path exit ${real.status}\n${check.stdout}`,
          );

          // The exit code is what a script branches on, so it has to carry the
          // same answer as the prose a human reads.
          assert.equal(
            check.status === 2,
            saysNoCredential,
            `${premise}: verdict text and exit code disagree — exit ${check.status}\n${check.stdout}`,
          );

          if (parityCase.trimsTo !== undefined) {
            // The only case that can catch the two sides trimming differently,
            // and it reads each side where that side's trim actually lands:
            // the check's reported hash, and the value the real path exported.
            const expectedHash = createHash("sha256").update(parityCase.trimsTo).digest("hex").slice(0, 8);
            assert.match(
              check.stdout,
              new RegExp(`token-sha256:\\s+${expectedHash}$`, "m"),
              `${premise}: self-test hashed something other than the trimmed token\n${check.stdout}`,
            );
            assert.match(
              real.stdout,
              new RegExp(`^GH_TOKEN=${parityCase.trimsTo}$`, "m"),
              `${premise}: real path exported something other than the trimmed token\n${real.stdout}`,
            );
          }
        });
      }
    }
  });
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
