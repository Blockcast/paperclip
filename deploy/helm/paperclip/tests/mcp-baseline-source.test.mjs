// PEN-3714: the shared MCP baseline must not be sourced from the agent-writable PVC.
//
// /paperclip/.mcp.json is mode 644 node:node on the fleet-shared CephFS volume,
// and uid 1000 is the uid every agent runs as. That alone would be contained —
// except the claude_k8s adapter runs inside the server pod and reads that same
// path as `loadSharedMcpBaseline()`, merging whatever it finds into the
// Secret-backed /tmp/prompt/mcp.json of EVERY agent Job it launches. So one
// agent's write reaches the whole fleet. `--strict-mcp-config` does not bound
// it: that flag stops claude re-reading the file after the server already
// merged it.
//
// The fix is a path the consumers cannot write — the server pod's own
// runtime-config emptyDir, which is not in the agent Job spec at all. These
// tests pin the two halves together, because either one alone is silently
// useless: the env without the seed write points at a missing file (agents
// degrade to per-agent servers only), and the seed write without the env is
// a file nothing reads.
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

const BASELINE_ENV = "PAPERCLIP_SHARED_MCP_BASELINE_PATH";
const BASELINE_PATH = "/runtime-config/mcp.json";
// The default the adapter falls back to when the env is unset
// (DEFAULT_SHARED_MCP_BASELINE_PATH in job-manifest.ts). Agent-writable.
const PVC_BASELINE_PATH = "/paperclip/.mcp.json";

function renderStatefulSet(extraArgs = []) {
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
      ...extraArgs,
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
}

test("the adapter is pointed at the agent-unreachable MCP baseline", () => {
  const rendered = renderStatefulSet();
  assert.match(
    rendered,
    new RegExp(`name: ${BASELINE_ENV}\\s*\\n\\s*value: "${BASELINE_PATH}"`),
    `${BASELINE_ENV} must point at ${BASELINE_PATH}; without it the adapter falls back to ` +
      `${PVC_BASELINE_PATH}, which every agent on the shared volume can rewrite.`,
  );
});

test("the seed writes the baseline the env names", () => {
  const rendered = renderStatefulSet();
  // Asserting the literal path rather than the shell variable: the point of
  // the pair is that these two resolve to the same file, and a test that
  // matched `${BASELINE_FILE}` would still pass if the env moved.
  assert.ok(
    rendered.includes(`BASELINE_FILE="${BASELINE_PATH}"`),
    `the seed must write ${BASELINE_PATH}; the env names it, so a missing write ` +
      `leaves every agent with per-agent MCP servers only.`,
  );
});

test("disabling runtimeConfig withdraws both halves together", () => {
  // No emptyDir means nowhere unreachable to put the file. The correct
  // behaviour is to fall back to today's default, not to name a path that
  // will not exist — which would be a silent functional regression for any
  // deployment with this volume off.
  const rendered = renderStatefulSet(["--set", "runtimeConfig.enabled=false"]);
  assert.ok(
    !rendered.includes(BASELINE_ENV),
    `${BASELINE_ENV} must not be set when runtimeConfig is disabled: the volume ` +
      `that backs ${BASELINE_PATH} is not mounted, so the file cannot exist.`,
  );
  assert.ok(
    !rendered.includes("BASELINE_FILE="),
    "the seed must not write the baseline when the volume backing it is absent.",
  );
});

test("the paperclip MCP server is launched by absolute interpreter path", () => {
  // A bare "node" resolves via execvp against the agent pod's PATH, whose
  // first entry is /paperclip/opencode-api-key-bin — 2775 node:node on the
  // shared PVC, holding a `node` shim. That shim was measured on the launch
  // chain of the server holding PAPERCLIP_API_KEY. /usr/local/bin/node is the
  // base image's interpreter and is present on every agent image, so pinning
  // it opens no rollout skew window.
  const rendered = renderStatefulSet();
  assert.ok(
    rendered.includes('"command": "/usr/local/bin/node"'),
    "the paperclip MCP entry must name the interpreter absolutely.",
  );
  assert.ok(
    !/"paperclip":\s*\{\s*\n\s*"command":\s*"node"/.test(rendered),
    'the paperclip MCP entry must not use a bare "node" command: it resolves ' +
      "through an agent-writable PATH directory.",
  );
});
