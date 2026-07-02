import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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

function runWrapper(dir, { tokenFileContent, args = ["api", "user"] } = {}) {
  const stubGhPath = path.join(dir, "gh.real");
  writeFileSync(stubGhPath, STUB_GH_SOURCE);
  chmodSync(stubGhPath, 0o755);

  const env = { ...process.env, GH_TOKEN_WRAPPER_REAL_GH: stubGhPath };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;

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
