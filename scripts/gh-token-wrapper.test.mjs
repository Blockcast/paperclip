import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

function runWrapper(dir, { tokenFileContent, tokenValue, args = ["api", "user"] } = {}) {
  const stubGhPath = path.join(dir, "gh.real");
  writeFileSync(stubGhPath, STUB_GH_SOURCE);
  chmodSync(stubGhPath, 0o755);

  const env = { ...process.env, GH_TOKEN_WRAPPER_REAL_GH: stubGhPath };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  delete env.PAPERCLIP_GITHUB_TOKEN_VALUE;

  if (tokenValue !== undefined) {
    env.PAPERCLIP_GITHUB_TOKEN_VALUE = tokenValue;
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

    const env = {
      ...process.env,
      GH_TOKEN_WRAPPER_REAL_GH: stubGhPath,
      PAPERCLIP_GITHUB_TOKEN_FILE: tokenFilePath,
      GH_TOKEN: "user_supplied_override",
      GITHUB_TOKEN: "user_supplied_override",
    };
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

test("logs a diagnostic to stderr and falls back when the token file exists but isn't readable (BLO-13241 review S2)", (t) => {  // chmod-based unreadability is meaningless for root (root bypasses
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

    const env = {
      ...process.env,
      GH_TOKEN_WRAPPER_REAL_GH: stubGhPath,
      PAPERCLIP_GITHUB_TOKEN_FILE: tokenFilePath,
    };
    delete env.GH_TOKEN;
    delete env.GITHUB_TOKEN;

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

// PAPERCLIP_GITHUB_TOKEN_VALUE — credentials delivered by the scoped
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

test("an empty token value falls through to the token file", () => {
  // An unset binding must not silently blank out the default identity.
  withTempDir((dir) => {
    const result = runWrapper(dir, {
      tokenFileContent: "ghs_apptoken\n",
      tokenValue: "",
    });
    assert.equal(result.GH_TOKEN, "ghs_apptoken");
    assert.equal(result.GITHUB_TOKEN, "ghs_apptoken");
  });
});

test("a whitespace-only token value neither authenticates nor falls through to the file", () => {
  // Guards the tr-strip: a value that is only CR/LF is a malformed binding, not
  // a request to use the App token. Failing closed makes it visible.
  withTempDir((dir) => {
    const result = runWrapper(dir, {
      tokenFileContent: "ghs_apptoken\n",
      tokenValue: "\r\n",
    });
    assert.equal(result.GH_TOKEN, "");
    assert.equal(result.GITHUB_TOKEN, "");
  });
});

test("a token supplied by value overrides a pre-existing GH_TOKEN in the caller's env", () => {
  withTempDir((dir) => {
    const stubGhPath = path.join(dir, "gh.real");
    writeFileSync(stubGhPath, STUB_GH_SOURCE);
    chmodSync(stubGhPath, 0o755);

    const env = {
      ...process.env,
      GH_TOKEN_WRAPPER_REAL_GH: stubGhPath,
      PAPERCLIP_GITHUB_TOKEN_VALUE: "ghu_userseat",
      GH_TOKEN: "user_supplied_override",
      GITHUB_TOKEN: "user_supplied_override",
    };
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
