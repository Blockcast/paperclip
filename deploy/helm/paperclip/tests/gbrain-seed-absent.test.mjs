import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

// Replaces gbrain-fail-closed.test.mjs (PEN-2428 step 3).
//
// That file had 8 tests, all exercising the seed-init block that minted a
// Bearer for the CEO agent's OAuth client and wrote it into the shared
// .mcp.json baseline. The block is gone, so those tests are gone with it —
// they asserted that a removed thing failed closed correctly.
//
// Deleting the file outright would have left nothing stopping the block's
// return, so the guard is INVERTED rather than dropped: the seed must mint no
// shared Bearer and emit no gbrain entry, and the rest of the baseline must
// survive. The one assertion that was never about the removed block — that the
// unauthenticated :3131 bridge stays unreferenced — is carried over unchanged.
//
// Why the block went: it gave EVERY agent in both companies the same
// `paperclip:Blockcast:CEO` gbrain identity, written to a world-readable file,
// with read+write across ~37 federated sources and no per-agent attribution.
// Agents now get gbrain through per-agent adapter_config.mcpServers.gbrain,
// minted by the gbrain-oauth-refresher CronJob in onprem-k8s and merged over
// this baseline by name.

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

/** Rendered script with comment lines stripped, so documentation of the
 *  removed endpoints cannot satisfy or trip an assertion about live code. */
function executableOnly(rendered) {
  return rendered
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("#"))
    .join("\n");
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
  // assembly opens inside an `if` (deeper indent) but its heredoc body sits
  // shallower; dedenting by the first line would silently chop real characters
  // off every body line and corrupt the emitted JSON.
  const indent = Math.min(
    ...block
      .filter((l) => l.trim().length > 0)
      .map((l) => l.length - l.trimStart().length),
  );
  return block.map((l) => l.slice(indent)).join("\n");
}

// The mcp.json assembly is now just the heredoc write. The terminator must be
// the heredoc's closing `EOF` on its own line — matching on "EOF" alone would
// stop at the `<<EOF` opener and truncate the block, producing an empty file
// rather than a test failure that explains itself.
const assemblyBlock = (rendered) =>
  extractBlock(rendered, 'cat > "${MCP_FILE}" <<EOF', (l) => l.trim() === "EOF", {
    inclusive: true,
  });

/** Execute the mcp.json assembly and return the written file. */
function runAssembly(rendered) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gbrain-assembly-"));
  try {
    const mcpFile = path.join(dir, ".mcp.json");
    const script = path.join(dir, "assemble.sh");
    fs.writeFileSync(
      script,
      `MCP_FILE="${mcpFile}"\n` +
        `MCP_BRIDGE_JS="/app/packages/mcp-server/dist/stdio.js"\n` +
        `LOCAL_BIN="/usr/local/bin"\n` +
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
  assert.doesNotMatch(
    executableOnly(rendered),
    /gbrain-mcp-internal[^\s"']*:3131/,
    "seed-init must not reference the unauthenticated gbrain bridge at :3131 outside of comments",
  );
});

test("seed-init mints no shared gbrain Bearer", () => {
  const executable = executableOnly(renderTemplate("templates/statefulset.yaml"));

  // Control: the extraction is live. If this ever fails, every absence
  // assertion below is being made against an empty or wrong string and would
  // pass vacuously.
  assert.match(
    executable,
    /MCP_FILE=/,
    "could not find the seed script in the rendered chart — the absence checks below would be vacuous",
  );

  for (const forbidden of [/GBRAIN_ENTRY/, /GBRAIN_JSON/, /:3130\/token/]) {
    assert.doesNotMatch(
      executable,
      forbidden,
      `seed-init must not mint a shared gbrain Bearer (matched ${forbidden}). ` +
        "Per-agent clients come from the gbrain-oauth-refresher CronJob in onprem-k8s; " +
        "reintroducing a seed-side mint restores the shared paperclip:Blockcast:CEO identity (PEN-2428).",
    );
  }
});

test("the seeded mcp.json carries no gbrain entry and the rest of the baseline survives", () => {
  const rendered = renderTemplate("templates/statefulset.yaml");
  const { raw, parsed } = runAssembly(rendered);

  assert.equal(
    Object.prototype.hasOwnProperty.call(parsed.mcpServers, "gbrain"),
    false,
    `the shared baseline must carry no gbrain entry, got: ${raw}`,
  );

  // The point of the change is that NOTHING ELSE moved. An empty or truncated
  // baseline would also satisfy the assertion above, so pin the survivors.
  for (const name of ["paperclip", "prometheus", "tempo", "k8s-ro", "github"]) {
    assert.ok(parsed.mcpServers[name], `expected ${name} to remain in mcp.json`);
  }
  assert.doesNotMatch(raw, /null/, "no null literal may appear in the written config");
});
