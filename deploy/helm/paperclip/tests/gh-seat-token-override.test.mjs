import { execFileSync, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";

// Covers BLO-22243: the seed init container installs `paperclip-github-token-env`
// (the wrapper `gh`, `git`, and `github-mcp-server` all route through) and
// `github-token-credential-helper` (the git credential helper) into the shared
// PVC. Both must honor a per-call `GH_SEAT_TOKEN_VALUE` override before falling
// back to the fleet-wide App-installation token file, without ever emitting a
// malformed or ambient-derived credential.

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

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

// The rendered init container command is a single `sh -c` heredoc-of-heredocs:
// the seed script `cat`s each wrapper script's body into the shared PVC via
// `<<'EOF' ... EOF`. Extract one wrapper's body as it will actually run,
// de-indenting by whatever the YAML block scalar's common indent happens to be.
function extractHeredoc(rendered, scriptName) {
  const lines = rendered.split("\n");
  const startRe = new RegExp(
    `^(\\s*)cat > "\\$\\{LOCAL_BIN\\}/${scriptName}" <<'EOF'$`,
  );
  let startIdx = -1;
  let indent = "";
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(startRe);
    if (match) {
      startIdx = i;
      indent = match[1];
      break;
    }
  }
  assert.notEqual(startIdx, -1, `did not find heredoc start for ${scriptName}`);

  const body = [];
  for (let i = startIdx + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.slice(0, indent.length) === indent && line.slice(indent.length) === "EOF") {
      return body.join("\n");
    }
    body.push(line.slice(indent.length));
  }
  throw new Error(`did not find heredoc terminator for ${scriptName}`);
}

function writeExecutable(dir, name, body) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, body, { mode: 0o755 });
  return file;
}

const rendered = renderStatefulSet();
const envScriptBody = extractHeredoc(rendered, "paperclip-github-token-env");
const credHelperBody = extractHeredoc(rendered, "github-token-credential-helper");

test("rendered statefulset still installs both GitHub credential wrapper scripts", () => {
  assert.match(envScriptBody, /^#!\/bin\/sh/);
  assert.match(credHelperBody, /^#!\/bin\/sh/);
});

test("paperclip-github-token-env: GH_SEAT_TOKEN_VALUE overrides the App-installation token file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gh-seat-token-"));
  const script = writeExecutable(dir, "paperclip-github-token-env", envScriptBody);

  const result = spawnSync("sh", [script, "sh", "-c", 'echo "GH_TOKEN=${GH_TOKEN} GITHUB_TOKEN=${GITHUB_TOKEN} GITHUB_PERSONAL_ACCESS_TOKEN=${GITHUB_PERSONAL_ACCESS_TOKEN}"'], {
    encoding: "utf8",
    env: { ...process.env, GH_SEAT_TOKEN_VALUE: "seat-token-value" },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout.trim(),
    "GH_TOKEN=seat-token-value GITHUB_TOKEN=seat-token-value GITHUB_PERSONAL_ACCESS_TOKEN=seat-token-value",
  );
});

test("paperclip-github-token-env: trims incidental leading/trailing whitespace from the override", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gh-seat-token-"));
  const script = writeExecutable(dir, "paperclip-github-token-env", envScriptBody);

  const result = spawnSync("sh", [script, "sh", "-c", 'echo "GH_TOKEN=${GH_TOKEN}"'], {
    encoding: "utf8",
    env: { ...process.env, GH_SEAT_TOKEN_VALUE: "  seat-token-value\t\n" },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "GH_TOKEN=seat-token-value");
});

test("paperclip-github-token-env: rejects a whitespace-only override instead of falling back to ambient auth", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gh-seat-token-"));
  const script = writeExecutable(dir, "paperclip-github-token-env", envScriptBody);

  const result = spawnSync("sh", [script, "true"], {
    encoding: "utf8",
    env: { ...process.env, GH_SEAT_TOKEN_VALUE: "   " },
  });

  assert.equal(result.status, 64);
  assert.match(result.stderr, /holds only whitespace/);
});

test("paperclip-github-token-env: rejects an override with embedded whitespace", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gh-seat-token-"));
  const script = writeExecutable(dir, "paperclip-github-token-env", envScriptBody);

  const result = spawnSync("sh", [script, "true"], {
    encoding: "utf8",
    env: { ...process.env, GH_SEAT_TOKEN_VALUE: "not a single token" },
  });

  assert.equal(result.status, 64);
  assert.match(result.stderr, /embedded whitespace/);
});

test("paperclip-github-token-env: falls back to the token file when the override is unset", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gh-seat-token-"));
  const script = writeExecutable(dir, "paperclip-github-token-env", envScriptBody);
  const tokenFile = path.join(dir, "token");
  fs.writeFileSync(tokenFile, "app-install-token\n");

  const env = { ...process.env, PAPERCLIP_GITHUB_TOKEN_FILE: tokenFile };
  delete env.GH_SEAT_TOKEN_VALUE;

  const result = spawnSync("sh", [script, "sh", "-c", 'echo "GH_TOKEN=${GH_TOKEN}"'], {
    encoding: "utf8",
    env,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "GH_TOKEN=app-install-token");
});

test("paperclip-github-token-env: fails loudly when the fallback token file is unreadable", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gh-seat-token-"));
  const script = writeExecutable(dir, "paperclip-github-token-env", envScriptBody);

  const env = {
    ...process.env,
    PAPERCLIP_GITHUB_TOKEN_FILE: path.join(dir, "does-not-exist"),
  };
  delete env.GH_SEAT_TOKEN_VALUE;

  const result = spawnSync("sh", [script, "true"], { encoding: "utf8", env });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not readable/);
});

function runCredHelper(
  scriptPath,
  { seatToken, tokenFile, host = "github.com", protocol = "https" } = {},
) {
  const env = { ...process.env };
  if (seatToken === undefined) {
    delete env.GH_SEAT_TOKEN_VALUE;
  } else {
    env.GH_SEAT_TOKEN_VALUE = seatToken;
  }
  if (tokenFile !== undefined) {
    env.PAPERCLIP_GITHUB_TOKEN_FILE = tokenFile;
  } else {
    delete env.PAPERCLIP_GITHUB_TOKEN_FILE;
  }
  return spawnSync("sh", [scriptPath, "get"], {
    encoding: "utf8",
    input: `protocol=${protocol}\nhost=${host}\n`,
    env,
  });
}

test("github-token-credential-helper: emits the seat override as the git credential", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gh-seat-token-"));
  const script = writeExecutable(dir, "github-token-credential-helper", credHelperBody);

  const result = runCredHelper(script, { seatToken: "seat-token-value" });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    "username=x-access-token\npassword=seat-token-value\n\n",
  );
});

test("github-token-credential-helper: rejects a whitespace-only override instead of emitting ambient auth", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gh-seat-token-"));
  const script = writeExecutable(dir, "github-token-credential-helper", credHelperBody);

  const result = runCredHelper(script, { seatToken: "   " });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /holds only whitespace/);
});

test("github-token-credential-helper: rejects an override with embedded whitespace", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gh-seat-token-"));
  const script = writeExecutable(dir, "github-token-credential-helper", credHelperBody);

  const result = runCredHelper(script, { seatToken: "not a single token" });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /embedded whitespace/);
});

test("github-token-credential-helper: falls back to the token file when the override is unset", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gh-seat-token-"));
  const script = writeExecutable(dir, "github-token-credential-helper", credHelperBody);
  const tokenFile = path.join(dir, "token");
  fs.writeFileSync(tokenFile, "app-install-token\n");

  const result = runCredHelper(script, { tokenFile });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    "username=x-access-token\npassword=app-install-token\n\n",
  );
});

test("github-token-credential-helper: stays silent for a non-github.com host", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gh-seat-token-"));
  const script = writeExecutable(dir, "github-token-credential-helper", credHelperBody);

  const result = runCredHelper(script, {
    seatToken: "seat-token-value",
    host: "gitlab.example.com",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
});

test("github-token-credential-helper: stays silent for a lookalike host that merely contains github.com as a substring", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gh-seat-token-"));
  const script = writeExecutable(dir, "github-token-credential-helper", credHelperBody);

  const result = runCredHelper(script, {
    seatToken: "seat-token-value",
    host: "github.com.evil.example",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
});

test("github-token-credential-helper: stays silent for a plaintext http remote instead of sending the token unencrypted", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gh-seat-token-"));
  const script = writeExecutable(dir, "github-token-credential-helper", credHelperBody);

  const result = runCredHelper(script, {
    seatToken: "seat-token-value",
    protocol: "http",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
});
