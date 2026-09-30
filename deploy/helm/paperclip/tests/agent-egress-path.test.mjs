import { execFileSync, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";

// PEN-2527/PEN-2526. Agent-authored GitHub content is scrubbed of
// credential-shaped material by wrapper binaries the seed init container
// publishes onto the PVC. The scrubber only sits on the traffic path if those
// wrapper directories precede /usr/bin, where the unscrubbed image `gh` lives.
//
// Two failures have already happened at this seam, and each was invisible to the
// tests that existed at the time:
//
//   1. #1509 shipped the wrapper into ${BASE}/.local/bin, which is prepended to
//      PATH only by .profile/.bashrc — sourced by *login* shells. Agent tool
//      harnesses spawn non-login shells, so the merged, deployed, correct
//      scrubber was never reached.
//   2. #1546 published it to ${BASE}/bin as well, but ${BASE}/bin was put on
//      PATH only by values.blockcast.yaml. Every other deployment of this chart
//      still resolved `gh` to the image CLI. The chart tests all rendered *with*
//      values.blockcast.yaml, so they could not see it.
//
// Hence: these tests render with the chart's DEFAULT values, and take the PATH
// under test from the render rather than restating it. A test that hardcodes the
// PATH it expects is testing itself.

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
const chartDir = "deploy/helm/paperclip";

function render(template, { valuesFile, set = [] } = {}) {
  const args = ["template", "paperclip", chartDir, "--namespace", "paperclip"];
  if (valuesFile) args.push("-f", `${chartDir}/${valuesFile}`);
  for (const entry of set) args.push("--set", entry);
  args.push("--show-only", template);
  return execFileSync("helm", args, { cwd: repoRoot, encoding: "utf8" });
}

function renderExpectingFailure(set) {
  const result = spawnSync(
    "helm",
    [
      "template",
      "paperclip",
      chartDir,
      "--namespace",
      "paperclip",
      ...set.flatMap((entry) => ["--set", entry]),
      "--show-only",
      "templates/statefulset.yaml",
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
  assert.notEqual(
    result.status,
    0,
    "expected the render to fail closed, but it succeeded",
  );
  return result.stderr;
}

// The container's PATH as the chart sets it. Reads the *first* PATH entry in the
// rendered container env and asserts there is exactly one: a duplicate would be
// resolved by the kubelet in a way this test could not see, which is the very
// thing env.extra is rejected for.
function containerPath(rendered) {
  const matches = [
    ...rendered.matchAll(/- name: PATH\n\s+value: (.+)/g),
  ].map((match) => match[1].trim().replace(/^"|"$/g, ""));
  assert.equal(
    matches.length,
    1,
    `expected exactly one PATH env entry, found ${matches.length}`,
  );
  return matches[0];
}

// The seed step that publishes the scrubbing `gh` onto the default PATH, lifted
// from the rendered script so a test runs the real thing rather than a
// restatement of it. Asserts rather than returning empty when the step is
// missing, so its removal fails loudly instead of silently passing.
function extractPathPublishFragment(rendered) {
  const lines = rendered.split("\n");
  const startIdx = lines.findIndex((line) =>
    /^\s*PATH_BIN="\$\{BASE\}\/bin"$/.test(line),
  );
  assert.notEqual(
    startIdx,
    -1,
    "seed script no longer publishes gh onto the default PATH",
  );
  const indent = lines[startIdx].match(/^(\s*)/)[1];
  const body = [];
  for (let i = startIdx; i < lines.length; i += 1) {
    const line = lines[i].slice(indent.length);
    body.push(line);
    if (/^ln -sf /.test(line)) return body.join("\n");
  }
  throw new Error("did not find the gh symlink line in the publish step");
}

function writeExecutable(dir, name, body) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, body, { mode: 0o755 });
  return file;
}

function assertWrappersPrecedeSystemBin(pathValue, base) {
  const entries = pathValue.split(":");
  const systemIdx = entries.indexOf("/usr/bin");
  assert.notEqual(systemIdx, -1, "expected /usr/bin on PATH");
  for (const dir of [`${base}/.local/bin`, `${base}/bin`]) {
    const idx = entries.indexOf(dir);
    assert.notEqual(idx, -1, `expected ${dir} on PATH, got ${pathValue}`);
    assert.ok(
      idx < systemIdx,
      `${dir} must precede /usr/bin, got ${pathValue}`,
    );
  }
}

// --- The invariant, under the chart's own defaults ------------------------

test("default values put the seeded egress wrappers ahead of /usr/bin (workers)", () => {
  const rendered = render("templates/statefulset.yaml");
  assertWrappersPrecedeSystemBin(containerPath(rendered), "/paperclip");
});

test("default values put the seeded egress wrappers ahead of /usr/bin (api tier)", () => {
  // The API tier mounts the same RWX PVC, so it sees the same wrappers and
  // needs the same ordering.
  const rendered = render("templates/deployment-api.yaml", {
    set: [
      "api.enabled=true",
      "persistence.existingClaim=paperclip-shared",
    ],
  });
  assertWrappersPrecedeSystemBin(containerPath(rendered), "/paperclip");
});

test("the PATH follows persistence.mountPath rather than a hardcoded /paperclip", () => {
  const rendered = render("templates/statefulset.yaml", {
    set: ["persistence.mountPath=/data"],
  });
  const value = containerPath(rendered);
  assertWrappersPrecedeSystemBin(value, "/data");
  assert.ok(
    !value.includes("/paperclip/"),
    `relocating the PVC must not leave /paperclip on PATH, got ${value}`,
  );
});

// --- The end-to-end resolution the invariant exists to produce -------------

test("a non-login shell resolves gh to the scrubbing wrapper under the default-values PATH", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "gh-path-reach-"));
  const localBin = path.join(base, ".local", "bin");
  const imageBin = path.join(base, "usr-bin");
  for (const dir of [localBin, imageBin]) fs.mkdirSync(dir, { recursive: true });

  // Render the chart's defaults with the PVC relocated onto the temp dir, so the
  // PATH and the publish step under test both address paths this test can
  // actually create. Nothing about the ordering is restated here.
  const rendered = render("templates/statefulset.yaml", {
    set: [`persistence.mountPath=${base}`],
  });

  // The scrubbing wrapper as the seed installs it, and the image CLI it must win
  // against. Each announces itself so the winner is unambiguous.
  writeExecutable(localBin, "gh", "#!/bin/sh\necho scrubbing-wrapper\n");
  writeExecutable(imageBin, "gh", "#!/bin/sh\necho image-cli\n");

  // Run the seed's own publish step rather than symlinking here, so this test
  // fails if the seed stops publishing onto the PATH-visible bin.
  const seeded = spawnSync(
    "sh",
    [
      "-c",
      [
        "set -eu",
        `BASE=${JSON.stringify(base)}`,
        `LOCAL_BIN=${JSON.stringify(localBin)}`,
        extractPathPublishFragment(rendered),
      ].join("\n"),
    ],
    { encoding: "utf8" },
  );
  assert.equal(seeded.status, 0, seeded.stderr);

  // The container PATH exactly as the chart renders it, with only the location
  // of the image CLI substituted — /usr/bin on the test host holds no `gh`, and
  // substituting in place preserves the ordering that is the thing under test.
  const containerPathValue = containerPath(rendered);
  assert.ok(
    containerPathValue.split(":").includes("/usr/bin"),
    "expected /usr/bin on the rendered PATH to substitute",
  );
  const testPath = containerPathValue
    .split(":")
    .map((entry) => (entry === "/usr/bin" ? imageBin : entry))
    .join(":");

  // /bin/sh by absolute path so the shell itself does not depend on the PATH
  // under test — only the `gh` lookup inside it does.
  const result = spawnSync("/bin/sh", ["-c", "gh"], {
    encoding: "utf8",
    env: { PATH: testPath },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "scrubbing-wrapper");
});

// --- Fail closed on overrides that would take the scrubber off the path ----

test("a PATH entry in env.extra is rejected rather than silently overriding the chart", () => {
  const stderr = renderExpectingFailure([
    "env.extra[0].name=PATH",
    "env.extra[0].value=/usr/bin:/bin",
  ]);
  assert.match(stderr, /env\.extra must not define PATH/);
});

test("an env.path override that drops a wrapper directory is rejected", () => {
  const stderr = renderExpectingFailure([
    "env.path=/usr/local/bin:/usr/bin:/bin",
  ]);
  assert.match(stderr, /must include the Paperclip GitHub egress wrapper/);
});

test("an env.path override that orders a wrapper directory after /usr/bin is rejected", () => {
  const stderr = renderExpectingFailure([
    "env.path=/usr/bin:/paperclip/.local/bin:/paperclip/bin",
  ]);
  assert.match(stderr, /must place the Paperclip GitHub egress wrapper/);
});

// A positive control for the three rejections above: the validation has to
// discriminate, not refuse everything. Without this, a helper that failed
// unconditionally would pass all three.
test("an env.path override that keeps the wrappers first is accepted", () => {
  const rendered = render("templates/statefulset.yaml", {
    set: [
      "env.path=/paperclip/.local/bin:/paperclip/bin:/opt/custom/bin:/usr/bin:/bin",
    ],
  });
  const value = containerPath(rendered);
  assertWrappersPrecedeSystemBin(value, "/paperclip");
  assert.ok(value.includes("/opt/custom/bin"), "override must be honored");
});

// --- The live deployment must not move ------------------------------------

test("the Blockcast overlay renders the PATH the chart now derives", () => {
  // This value used to live in values.blockcast.yaml's env.extra. Moving it into
  // the chart is only safe if the rendered result is unchanged for the running
  // deployment; this pins that.
  const rendered = render("templates/statefulset.yaml", {
    valuesFile: "values.blockcast.yaml",
  });
  assert.equal(
    containerPath(rendered),
    "/paperclip/.local/bin:/paperclip/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  );
});

// --- The second door: the github MCP server (PEN-3152) --------------------
//
// The `gh` tests above turn on PATH ordering, because `gh` is resolved by name.
// The MCP door is reached differently and so fails differently: the seeded
// `.mcp.json` names an ABSOLUTE command, so PATH is irrelevant and the
// equivalent question is whether that absolute path is the scrubbing wrapper or
// the image server. PEN-3152 was filed because it was the latter — the wrapper
// existed and injected a token, and no scrubber sat on the path.
//
// Same discipline as above: read both halves out of the render, and never
// restate the value under test.
//
// One asymmetry worth naming rather than fixing here: the `gh` door's
// reachability follows `persistence.mountPath` (see the test above), whereas
// both the MCP wrapper's inner exec and the seeded command hardcode
// `/paperclip/.local/bin`. That coupling predates PEN-3152 — the wrapper it
// replaced hardcoded the same path — and the two halves hardcode it
// consistently, so it holds at the default mountPath. The assertions below pin
// the current reality; they are not an endorsement of the hardcode.

// One wrapper's heredoc body, lifted from the rendered seed script. Asserts
// rather than returning empty, so deleting a wrapper fails loudly.
function extractWrapperBody(rendered, name) {
  const lines = rendered.split("\n");
  const startIdx = lines.findIndex(
    (line) => line.trim() === `cat > "\${LOCAL_BIN}/${name}" <<'EOF'`,
  );
  assert.notEqual(startIdx, -1, `seed script no longer writes a ${name} wrapper`);
  const body = [];
  for (let i = startIdx + 1; i < lines.length; i += 1) {
    if (lines[i].trim() === "EOF") return body.join("\n");
    body.push(lines[i].trim());
  }
  throw new Error(`${name} wrapper heredoc is not terminated`);
}

// The `github` upstream's command as the seeded .mcp.json carries it.
function seededMcpGitHubCommand(rendered) {
  const match = /"github":\s*\{\s*"command":\s*"([^"]+)"/.exec(rendered);
  assert.notEqual(match, null, "the seeded mcpServers block no longer has a github command");
  return match[1];
}

test("the seeded github MCP upstream dials the scrubbing wrapper, not the image server", () => {
  const rendered = render("templates/statefulset.yaml");
  const command = seededMcpGitHubCommand(rendered);

  // The whole control rests on this indirection. Pointing the seed at
  // /usr/local/bin/github-mcp-server restores the PEN-3152 gap exactly, while
  // leaving every wrapper assertion in this file green.
  assert.equal(command, "/paperclip/.local/bin/github-mcp-server");

  // ...and the thing it names must be a wrapper the seed actually writes.
  assert.ok(
    rendered.includes(`cat > "\${LOCAL_BIN}/${path.basename(command)}" <<'EOF'`),
    `the seed does not write a ${path.basename(command)} wrapper for the mcp.json command to reach`,
  );
});

test("the rendered github-mcp-server wrapper execs the scrub runtime inside the token wrapper", () => {
  const body = extractWrapperBody(render("templates/statefulset.yaml"), "github-mcp-server");

  const tokenAt = body.indexOf("paperclip-github-token-env");
  const runtimeAt = body.indexOf("github-mcp-egress-runtime.js");
  assert.notEqual(tokenAt, -1, "the MCP wrapper no longer injects the seat token");
  assert.notEqual(runtimeAt, -1, "the MCP wrapper no longer execs the egress scrub runtime");

  // Ordering is load-bearing in one direction only. The token wrapper must be
  // OUTERMOST so the real server still inherits GITHUB_PERSONAL_ACCESS_TOKEN;
  // putting the scrub outside it would start the server unauthenticated and
  // fail every tool call, which is the shape that gets a security control
  // reverted rather than fixed.
  assert.ok(runtimeAt > tokenAt, `scrub runtime must run inside the token wrapper: ${body}`);

  // The CLI runtime rewrites argv and the MCP runtime rewrites JSON-RPC frames;
  // they are not interchangeable. Pointing this wrapper at the CLI runtime
  // yields a process that starts, scrubs nothing, and looks plausible.
  assert.ok(
    !body.includes("github-cli-egress-runtime.js"),
    "the MCP wrapper must not exec the CLI runtime",
  );
});

test("the rendered MCP wrapper hands the real server to the scrub runtime as its target, with args after it", () => {
  // Execute the wrapper the chart actually renders, with each absolute path
  // replaced by a stub, so this fails if the exec chain is reordered — a
  // runtime that received `stdio` as its target and the server path as an
  // argument would still "run", and would scrub nothing.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "gh-mcp-egress-"));
  const stubs = path.join(base, "stubs");
  fs.mkdirSync(stubs, { recursive: true });

  const body = extractWrapperBody(render("templates/statefulset.yaml"), "github-mcp-server");
  const execLine = body.split("\n").find((line) => line.startsWith("exec "));
  assert.ok(execLine, `no exec line in the MCP wrapper: ${body}`);

  // Stand-ins, each preserving the real component's argv contract: token-env
  // and node both exec their remaining argv; the runtime reports what it got.
  const tokenEnv = writeExecutable(stubs, "token-env", '#!/bin/sh\nexec "$@"\n');
  const node = writeExecutable(stubs, "node", '#!/bin/sh\nexec "$@"\n');
  const runtime = writeExecutable(
    stubs,
    "runtime",
    '#!/bin/sh\nprintf "args=%s\\n" "$*"\n',
  );

  const rewritten = execLine
    .replace("/paperclip/.local/bin/paperclip-github-token-env", tokenEnv)
    .replace("/usr/local/bin/node", node)
    .replace(/\S*github-mcp-egress-runtime\.js/, runtime);

  // The rewrite must have consumed every path this host lacks, or the
  // assertions below would be testing a line that cannot run for the wrong
  // reason.
  assert.ok(
    !rewritten.includes("/paperclip/.local/bin/paperclip-github-token-env"),
    `token-env path not substituted: ${rewritten}`,
  );
  assert.ok(
    !rewritten.includes("github-mcp-egress-runtime.js"),
    `runtime path not substituted: ${rewritten}`,
  );

  // "$@" in the wrapper takes the mcp.json args; $0 is supplied separately.
  const result = spawnSync("/bin/sh", ["-c", rewritten, "sh", "stdio"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);

  // The real server must be the runtime's target, with the mcp.json args after
  // it — which is the argv contract github-mcp-egress-runtime.js reads as
  // process.argv[2] (target) and slice(3) (args).
  assert.equal(
    result.stdout.trim(),
    "args=/usr/local/bin/github-mcp-server stdio",
    `unexpected argv threading: ${result.stdout}`,
  );
});

