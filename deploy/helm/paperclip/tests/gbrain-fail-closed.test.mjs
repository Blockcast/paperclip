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

/**
 * Pull the gbrain endpoint-selection block out of the rendered seed-init
 * script and dedent it so it can be executed as a standalone POSIX shell
 * fragment. The block runs from its banner comment up to the mcp.json
 * assembly guard.
 */
function extractGbrainBlock(rendered) {
  const lines = rendered.split("\n");
  const start = lines.findIndex((l) => l.includes("# gbrain endpoint selection"));
  assert.notEqual(start, -1, "gbrain endpoint-selection block not found in rendered chart");
  const end = lines.findIndex(
    (l, i) => i > start && l.includes('if [ -f "${MCP_BRIDGE_JS}" ]'),
  );
  assert.notEqual(end, -1, "end of gbrain block not found in rendered chart");

  const block = lines.slice(start, end);
  const indent = block[0].length - block[0].trimStart().length;
  return block.map((l) => l.slice(indent)).join("\n");
}

test("seed-init never falls back to the unauthenticated gbrain bridge", () => {
  const rendered = renderTemplate("templates/statefulset.yaml");

  // The bridge at gbrain-mcp-internal:3131 is unauthenticated, and as of
  // 2026-08 it has no Service and no container behind it. Routing to it on a
  // mint failure was a fail-open that had silently decayed into a
  // non-resolving entry. It must not reappear as a fallback.
  //
  // Comment lines are excluded on purpose: the block above deliberately
  // documents the removed endpoint so the next reader knows why it is gone.
  // What must never come back is an *executable* reference to it.
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

test("gbrain entry defaults to null so a failed mint omits the server", () => {
  const rendered = renderTemplate("templates/statefulset.yaml");

  assert.match(
    rendered,
    /GBRAIN_ENTRY='null'/,
    "GBRAIN_ENTRY must default to null (fail closed), not to a usable endpoint",
  );

  // All three failure branches must announce themselves. Two of them
  // previously logged nothing at all, which is why the dead fallback went
  // unnoticed for so long.
  const failClosedLogs = rendered.match(/seed: FAIL-CLOSED gbrain/g) ?? [];
  assert.equal(
    failClosedLogs.length,
    3,
    `expected 3 FAIL-CLOSED log branches (no bundle / no CEO client / token call failed), found ${failClosedLogs.length}`,
  );
});

test("mcp.json assembly strips null-valued server entries", () => {
  const rendered = renderTemplate("templates/statefulset.yaml");

  assert.match(
    rendered,
    /with_entries\(select\(\.value != null\)\)/,
    "mcp.json write must drop null-valued mcpServers entries so a failed mint omits the key entirely",
  );
  // Filter through a temp file so a jq failure cannot truncate the live,
  // fleet-wide .mcp.json on the shared RWX volume.
  assert.match(rendered, /\$\{MCP_FILE\}\.tmp/);
});

test("gbrain block fails closed when the Authbot clients bundle is unavailable", () => {
  const rendered = renderTemplate("templates/statefulset.yaml");
  const block = extractGbrainBlock(rendered);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gbrain-failclosed-"));
  try {
    const script = path.join(dir, "block.sh");
    // Point the service key at a path that cannot exist, which is what a
    // missing mount or an Authbot outage looks like to this block.
    fs.writeFileSync(
      script,
      `PAPERCLIP_GBRAIN_AUTHBOT_SERVICE_KEY_FILE="${path.join(dir, "absent-key")}"\n` +
        `export PAPERCLIP_GBRAIN_AUTHBOT_SERVICE_KEY_FILE\n` +
        `${block}\n` +
        `printf 'RESULT:%s\\n' "\${GBRAIN_ENTRY}"\n`,
    );

    const out = execFileSync("sh", [script], { encoding: "utf8", timeout: 60_000 });

    assert.match(
      out,
      /RESULT:null/,
      `expected GBRAIN_ENTRY to be null when no clients bundle is available, got:\n${out}`,
    );
    assert.match(
      out,
      /seed: FAIL-CLOSED gbrain — no OAuth clients bundle available/,
      `expected a FAIL-CLOSED log line, got:\n${out}`,
    );
    assert.doesNotMatch(
      out,
      /3131/,
      "the failure path must not produce a :3131 bridge endpoint",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
