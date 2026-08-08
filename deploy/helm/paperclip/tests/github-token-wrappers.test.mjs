import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

const credentialEnvNames = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GITHUB_PERSONAL_ACCESS_TOKEN",
  "PAPERCLIP_GITHUB_TOKEN_FILE",
  "GH_SEAT_TOKEN_VALUE",
];

function withTempDir(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "paperclip-github-wrapper-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function sanitizedEnv(overrides = {}) {
  const env = { ...process.env };
  for (const name of credentialEnvNames) {
    delete env[name];
  }
  return Object.assign(env, overrides);
}

function renderStatefulSet() {
  return execFileSync(
    "helm",
    [
      "template",
      "paperclip",
      "deploy/helm/paperclip",
      "--namespace",
      "paperclip",
      "-f",
      "deploy/helm/paperclip/values.blockcast.yaml",
      "--show-only",
      "templates/statefulset.yaml",
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
}

function extractSeedScript(rendered, name) {
  const marker = `cat > "\${LOCAL_BIN}/${name}" <<'EOF'\n`;
  const start = rendered.indexOf(marker);
  assert.notEqual(start, -1, `${name} must be seeded into the shared PVC`);

  const bodyStart = start + marker.length;
  const end = rendered.indexOf("\n              EOF", bodyStart);
  assert.notEqual(end, -1, `${name} heredoc must be terminated`);

  return rendered.slice(bodyStart, end).replace(/^              /gm, "");
}

function writeExecutable(file, source) {
  writeFileSync(file, source);
  chmodSync(file, 0o755);
}

function materializeSharedWrappers(dir) {
  const rendered = renderStatefulSet();
  const binDir = path.join(dir, ".local", "bin");
  const tokenEnv = path.join(binDir, "paperclip-github-token-env");
  const credentialHelper = path.join(binDir, "github-token-credential-helper");
  const stubCommand = path.join(dir, "real-command");
  mkdirSync(binDir, { recursive: true });

  // This test uses fixed placeholder strings only. The stub checks the values
  // it receives without writing them to stdout or stderr.
  writeExecutable(
    stubCommand,
    `#!/bin/sh
set -eu
[ "\${GH_TOKEN:-}" = "\${TEST_EXPECTED_GITHUB_TOKEN:?}" ]
[ "\${GITHUB_TOKEN:-}" = "\${TEST_EXPECTED_GITHUB_TOKEN}" ]
[ "\${GITHUB_PERSONAL_ACCESS_TOKEN:-}" = "\${TEST_EXPECTED_GITHUB_TOKEN}" ]
`,
  );
  writeExecutable(tokenEnv, extractSeedScript(rendered, "paperclip-github-token-env"));
  writeExecutable(
    credentialHelper,
    extractSeedScript(rendered, "github-token-credential-helper"),
  );

  const replaceSharedPaths = (source) => source.replaceAll("/paperclip/.local/bin", binDir);
  writeExecutable(
    path.join(binDir, "gh"),
    replaceSharedPaths(extractSeedScript(rendered, "gh")).replace("/usr/bin/gh", stubCommand),
  );
  writeExecutable(
    path.join(binDir, "git"),
    replaceSharedPaths(extractSeedScript(rendered, "git")).replace("/usr/bin/git", stubCommand),
  );

  return {
    credentialHelper,
    gh: path.join(binDir, "gh"),
    git: path.join(binDir, "git"),
  };
}

test("shared-PVC gh and git wrappers prefer a scoped seat token over the App token file", () => {
  withTempDir((dir) => {
    const wrappers = materializeSharedWrappers(dir);
    const tokenFile = path.join(dir, "app-token");
    writeFileSync(tokenFile, "app-placeholder\n");

    const overrideEnv = sanitizedEnv({
      GH_SEAT_TOKEN_VALUE: " \tseat-placeholder\r\n",
      GH_TOKEN: "ambient-placeholder",
      GITHUB_TOKEN: "ambient-placeholder",
      PAPERCLIP_GITHUB_TOKEN_FILE: tokenFile,
      TEST_EXPECTED_GITHUB_TOKEN: "seat-placeholder",
    });
    for (const wrapper of [wrappers.gh, wrappers.git]) {
      const result = spawnSync("sh", [wrapper, "status"], {
        encoding: "utf8",
        env: overrideEnv,
      });
      assert.equal(result.status, 0, result.stderr);
    }

    const fallbackEnv = sanitizedEnv({
      PAPERCLIP_GITHUB_TOKEN_FILE: tokenFile,
      TEST_EXPECTED_GITHUB_TOKEN: "app-placeholder",
    });
    for (const wrapper of [wrappers.gh, wrappers.git]) {
      const result = spawnSync("sh", [wrapper, "status"], {
        encoding: "utf8",
        env: fallbackEnv,
      });
      assert.equal(result.status, 0, result.stderr);
    }
  });
});

test("shared-PVC credential helper uses the scoped token and rejects malformed overrides", () => {
  withTempDir((dir) => {
    const { credentialHelper } = materializeSharedWrappers(dir);
    const tokenFile = path.join(dir, "app-token");
    writeFileSync(tokenFile, "app-placeholder\n");
    const input = "protocol=https\nhost=github.com\n\n";

    const selected = spawnSync("sh", [credentialHelper], {
      encoding: "utf8",
      env: sanitizedEnv({
        GH_SEAT_TOKEN_VALUE: " seat-placeholder ",
        PAPERCLIP_GITHUB_TOKEN_FILE: tokenFile,
      }),
      input,
    });
    assert.equal(selected.status, 0, selected.stderr);
    assert.equal(
      selected.stdout,
      "username=x-access-token\npassword=seat-placeholder\n\n",
    );

    const malformed = spawnSync("sh", [credentialHelper], {
      encoding: "utf8",
      env: sanitizedEnv({
        GH_SEAT_TOKEN_VALUE: "not a token",
        PAPERCLIP_GITHUB_TOKEN_FILE: tokenFile,
      }),
      input,
    });
    assert.equal(malformed.status, 1);
    assert.equal(malformed.stdout, "");
    assert.match(malformed.stderr, /contains embedded whitespace/);
  });
});
