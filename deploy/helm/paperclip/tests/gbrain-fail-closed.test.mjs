import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

const CEO_AGENT_ID = "4eca1725-632f-45fa-97a2-8cf7e0430958";

function renderTemplate(template, extraArgs = []) {
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
      template,
      ...extraArgs,
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
}

function hasJq() {
  try {
    execFileSync("sh", ["-c", "command -v jq"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Slice `[startMatch, endMatch)` out of the rendered script and dedent it. */
function extractBlock(rendered, startMatch, endMatch, { inclusive = false } = {}) {
  const lines = rendered.split("\n");
  const start = lines.findIndex((l) => l.includes(startMatch));
  assert.notEqual(start, -1, `block start not found in rendered chart: ${startMatch}`);
  const matches =
    typeof endMatch === "function" ? endMatch : (l) => l.includes(endMatch);
  const endIdx = lines.findIndex((l, i) => i > start && matches(l));
  assert.notEqual(endIdx, -1, "block end not found in rendered chart");

  const block = lines.slice(start, inclusive ? endIdx + 1 : endIdx);
  // Dedent by the MINIMUM indent across the block, not the first line's. The
  // assembly block opens inside an `if` (deeper indent) but its heredoc body
  // sits shallower; dedenting by the first line would silently chop real
  // characters off every body line and corrupt the emitted JSON.
  const indent = Math.min(
    ...block
      .filter((l) => l.trim().length > 0)
      .map((l) => l.length - l.trimStart().length),
  );
  return block.map((l) => l.slice(indent)).join("\n");
}

const gbrainBlock = (rendered) =>
  extractBlock(rendered, "# gbrain endpoint selection", 'if [ -f "${MCP_BRIDGE_JS}" ]');

// The mcp.json assembly: the GBRAIN_JSON fragment build plus the heredoc write.
// The terminator must be the heredoc's closing `EOF` on its own line — matching
// on "EOF" alone would stop at the `cat > ... <<EOF` opener and truncate the
// block, producing an empty file rather than a test failure that explains
// itself.
const assemblyBlock = (rendered) =>
  extractBlock(rendered, 'GBRAIN_JSON=""', (l) => l.trim() === "EOF", {
    inclusive: true,
  });

/**
 * Run the gbrain endpoint-selection block under a controlled failure and
 * return { stdout, entry }. `curlBehaviour` stubs curl on PATH so the Authbot
 * fetch and the /token mint can be driven independently.
 */
function runGbrainBlock(rendered, { serviceKey = null, authbotResponse = null, tokenResponse = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gbrain-block-"));
  try {
    const keyPath = path.join(dir, "service-key");
    if (serviceKey !== null) fs.writeFileSync(keyPath, serviceKey);

    const binDir = path.join(dir, "bin");
    fs.mkdirSync(binDir);
    // Stub curl: the /token POST is identified by its URL, everything else is
    // treated as the Authbot clients fetch.
    fs.writeFileSync(
      path.join(binDir, "curl"),
      `#!/bin/sh\nfor a in "$@"; do\n  case "$a" in\n    *:3130/token) printf '%s' "$STUB_TOKEN_RESPONSE"; exit 0 ;;\n  esac\ndone\nprintf '%s' "$STUB_AUTHBOT_RESPONSE"\nexit 0\n`,
      { mode: 0o755 },
    );

    const script = path.join(dir, "block.sh");
    fs.writeFileSync(
      script,
      `PAPERCLIP_GBRAIN_AUTHBOT_SERVICE_KEY_FILE="${keyPath}"\n` +
        `export PAPERCLIP_GBRAIN_AUTHBOT_SERVICE_KEY_FILE\n` +
        `${gbrainBlock(rendered)}\n` +
        `printf 'RESULT:%s\\n' "\${GBRAIN_ENTRY}"\n`,
    );

    const stdout = execFileSync("sh", [script], {
      encoding: "utf8",
      timeout: 60_000,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        STUB_AUTHBOT_RESPONSE: authbotResponse ?? "",
        STUB_TOKEN_RESPONSE: tokenResponse ?? "",
      },
    });
    const entry = (stdout.match(/RESULT:(.*)$/m) ?? [])[1];
    return { stdout, entry };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Execute the mcp.json assembly with a given GBRAIN_ENTRY; return parsed JSON. */
function runAssembly(rendered, gbrainEntry) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gbrain-assembly-"));
  try {
    const mcpFile = path.join(dir, ".mcp.json");
    const script = path.join(dir, "assemble.sh");
    fs.writeFileSync(
      script,
      `MCP_FILE="${mcpFile}"\n` +
        `MCP_BRIDGE_JS="/app/packages/mcp-server/dist/stdio.js"\n` +
        `GBRAIN_ENTRY='${gbrainEntry}'\n` +
        `${assemblyBlock(rendered)}\n`,
    );
    execFileSync("sh", [script], { encoding: "utf8", timeout: 60_000 });
    const raw = fs.readFileSync(mcpFile, "utf8");
    return { raw, parsed: JSON.parse(raw) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("seed-init never falls back to the unauthenticated gbrain bridge", () => {
  const rendered = renderTemplate("templates/statefulset.yaml");

  // The bridge at gbrain-mcp-internal:3131 is unauthenticated, and as of
  // 2026-08 it has no Service and no container behind it. Routing to it on a
  // mint failure was a fail-open that had silently decayed into a
  // non-resolving entry.
  //
  // Comment lines are excluded on purpose: the block deliberately documents
  // the removed endpoint so the next reader knows why it is gone. What must
  // never come back is an *executable* reference to it.
  const executable = rendered
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("#"))
    .join("\n");

  assert.doesNotMatch(
    executable,
    /gbrain-mcp-internal[^\s"']*:3131/,
    "seed-init must not reference the unauthenticated gbrain bridge at :3131 outside of comments",
  );
});

test("gbrain entry defaults to null and every failure branch is announced", () => {
  const rendered = renderTemplate("templates/statefulset.yaml");

  assert.match(rendered, /GBRAIN_ENTRY='null'/);

  // Two of these branches previously logged nothing at all, which is why the
  // dead fallback went unnoticed for so long.
  const logs = rendered.match(/seed: FAIL-CLOSED gbrain/g) ?? [];
  assert.equal(logs.length, 3, `expected 3 FAIL-CLOSED branches, found ${logs.length}`);
});

test("mcp.json omits gbrain entirely when the mint failed — never writes a null", () => {
  const rendered = renderTemplate("templates/statefulset.yaml");
  const { raw, parsed } = runAssembly(rendered, "null");

  assert.equal(
    Object.prototype.hasOwnProperty.call(parsed.mcpServers, "gbrain"),
    false,
    `gbrain key must be absent on the fail-closed path, got: ${raw}`,
  );
  // Not merely absent-after-stripping: a null must never be written at all,
  // so no intermediate state of this file can contain one.
  assert.doesNotMatch(raw, /null/, "no null literal may appear in the written config");

  // The rest of the baseline must survive untouched.
  for (const name of ["paperclip", "prometheus", "tempo", "k8s-ro", "github", "linear"]) {
    assert.ok(parsed.mcpServers[name], `expected ${name} to remain in mcp.json`);
  }
});

test("mcp.json keeps gbrain when a Bearer was minted", () => {
  const rendered = renderTemplate("templates/statefulset.yaml");
  const entry =
    '{"type":"http","url":"http://gbrain-mcp-admin.paperclip.svc.cluster.local:3130/mcp","headers":{"Authorization":"Bearer test-token"}}';
  const { parsed } = runAssembly(rendered, entry);

  assert.equal(parsed.mcpServers.gbrain.type, "http");
  assert.match(parsed.mcpServers.gbrain.url, /:3130\/mcp$/);
  assert.equal(parsed.mcpServers.gbrain.headers.Authorization, "Bearer test-token");
  assert.ok(parsed.mcpServers.linear, "sibling servers must be unaffected");
});

test("fail-closed branch 1: no Authbot clients bundle available", () => {
  const rendered = renderTemplate("templates/statefulset.yaml");
  // Service key absent — the shape of a missing mount or an Authbot outage.
  const { stdout, entry } = runGbrainBlock(rendered, { serviceKey: null });

  assert.equal(entry, "null");
  assert.match(stdout, /seed: FAIL-CLOSED gbrain — no OAuth clients bundle available/);
  assert.doesNotMatch(stdout, /3131/);
});

test("fail-closed branch 2: CEO OAuth client absent from the bundle", { skip: hasJq() ? false : "jq not available" }, () => {
  const rendered = renderTemplate("templates/statefulset.yaml");
  // Bundle fetches fine but carries no entry for the CEO agent.
  const { stdout, entry } = runGbrainBlock(rendered, {
    serviceKey: "test-service-key",
    authbotResponse: JSON.stringify({ value: { "some-other-agent": { client_id: "x", client_secret: "y" } } }),
  });

  assert.equal(entry, "null");
  assert.match(stdout, /seed: FAIL-CLOSED gbrain — CEO OAuth client absent from clients bundle/);
  assert.doesNotMatch(stdout, /3131/);
});

test("fail-closed branch 3: /token mint returns no access_token", { skip: hasJq() ? false : "jq not available" }, () => {
  const rendered = renderTemplate("templates/statefulset.yaml");
  // Bundle and CEO client are present; the token endpoint yields nothing usable.
  const { stdout, entry } = runGbrainBlock(rendered, {
    serviceKey: "test-service-key",
    authbotResponse: JSON.stringify({
      value: { [CEO_AGENT_ID]: { client_id: "test-id", client_secret: "test-secret" } },
    }),
    tokenResponse: "{}",
  });

  assert.equal(entry, "null");
  assert.match(stdout, /seed: FAIL-CLOSED gbrain — \/token call failed/);
  assert.doesNotMatch(stdout, /3131/);
});

test("success path: a minted Bearer produces an admin-ui endpoint", { skip: hasJq() ? false : "jq not available" }, () => {
  const rendered = renderTemplate("templates/statefulset.yaml");
  const { stdout, entry } = runGbrainBlock(rendered, {
    serviceKey: "test-service-key",
    authbotResponse: JSON.stringify({
      value: { [CEO_AGENT_ID]: { client_id: "test-id", client_secret: "test-secret" } },
    }),
    tokenResponse: JSON.stringify({ access_token: "minted-token", expires_in: 86400 }),
  });

  assert.notEqual(entry, "null", `expected a minted entry, got stdout:\n${stdout}`);
  assert.match(entry, /:3130\/mcp/);
  assert.match(entry, /Bearer minted-token/);
  assert.match(stdout, /seed: minted gbrain Bearer/);
  assert.doesNotMatch(stdout, /FAIL-CLOSED/);
});
