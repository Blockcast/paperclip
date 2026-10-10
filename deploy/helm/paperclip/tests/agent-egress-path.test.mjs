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

// PEN-3713: the root-owned image directory the wrappers now ship in. Restated
// here on purpose — it is the one value in this file that MUST agree with
// three places outside the chart (the Dockerfile COPY target, Dockerfile.agent's
// COPY --from=server, and GITHUB_WRAPPER_BIN_DIR in the claude_k8s adapter), and
// a test that derived it from the chart could not catch the chart drifting away
// from the image. The agreement is asserted explicitly further down.
const IMAGE_WRAPPER_BIN = "/usr/local/libexec/paperclip/bin";

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

/**
 * PEN-3156: the same publish step, but captured through the `git` symlink
 * rather than stopping at the `gh` one.
 *
 * A separate walker rather than a parameter on the one above, so that the `gh`
 * assertion keeps testing exactly the region it always did and cannot start
 * passing because of a line added for `git`.
 */
function extractPathPublishFragmentThroughGit(rendered) {
  const lines = rendered.split("\n");
  const startIdx = lines.findIndex((line) =>
    /^\s*PATH_BIN="\$\{BASE\}\/bin"$/.test(line),
  );
  assert.notEqual(startIdx, -1, "seed script no longer publishes onto the default PATH");
  const indent = lines[startIdx].match(/^(\s*)/)[1];
  const body = [];
  for (let i = startIdx; i < lines.length; i += 1) {
    const line = lines[i].slice(indent.length);
    body.push(line);
    if (/^ln -sf "\$\{LOCAL_BIN\}\/git"/.test(line)) return body.join("\n");
  }
  throw new Error(
    "the seed does not publish git onto the PATH-visible bin; the push guard would be off the traffic path (PEN-3156)",
  );
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
  for (const dir of [IMAGE_WRAPPER_BIN, `${base}/.local/bin`, `${base}/bin`]) {
    const idx = entries.indexOf(dir);
    assert.notEqual(idx, -1, `expected ${dir} on PATH, got ${pathValue}`);
    assert.ok(
      idx < systemIdx,
      `${dir} must precede /usr/bin, got ${pathValue}`,
    );
  }
  // PEN-3713: the root-owned copy must win over the agent-writable PVC copies,
  // not merely be present somewhere ahead of /usr/bin. Both generations are on
  // PATH during the migration precisely so neither rollout order has a window,
  // which makes their relative order the thing that decides which file runs.
  for (const pvcDir of [`${base}/.local/bin`, `${base}/bin`]) {
    assert.ok(
      entries.indexOf(IMAGE_WRAPPER_BIN) < entries.indexOf(pvcDir),
      `the root-owned ${IMAGE_WRAPPER_BIN} must precede the agent-writable ${pvcDir}, got ${pathValue}`,
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
  // The image wrapper directory is a path inside the image and does not follow
  // the PVC; everything else must. Removing it before the check keeps this
  // assertion about relocation rather than about the substring "paperclip".
  assert.ok(
    !value
      .split(":")
      .filter((entry) => entry !== IMAGE_WRAPPER_BIN)
      .join(":")
      .includes("/paperclip/"),
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

// --- The publish guard on the `git` door (PEN-3156) -------------------------

test("a non-login shell resolves git to the publish-guarding wrapper", () => {
  // The regression this pins, measured in a live agent Job pod on 2026-09-10:
  // ${LOCAL_BIN}/git existed and was byte-identical to the chart, but the pod's
  // PATH carried /paperclip/bin without /paperclip/.local/bin and nothing
  // published git into the former — so `command -v git` gave /usr/bin/git and
  // any guard in the wrapper was a choke point nothing traversed. `gh` had the
  // same defect and PEN-2527 fixed it with a symlink; git never got one.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "git-path-reach-"));
  const localBin = path.join(base, ".local", "bin");
  const imageBin = path.join(base, "usr-bin");
  for (const dir of [localBin, imageBin]) fs.mkdirSync(dir, { recursive: true });

  const rendered = render("templates/statefulset.yaml", {
    set: [`persistence.mountPath=${base}`],
  });

  writeExecutable(localBin, "git", "#!/bin/sh\necho guarding-wrapper\n");
  writeExecutable(imageBin, "git", "#!/bin/sh\necho image-git\n");

  // Run the seed's own publish step, so this fails if the seed stops publishing
  // git rather than merely if a symlink is missing.
  const seeded = spawnSync(
    "sh",
    [
      "-c",
      [
        "set -eu",
        `BASE=${JSON.stringify(base)}`,
        `LOCAL_BIN=${JSON.stringify(localBin)}`,
        extractPathPublishFragmentThroughGit(rendered),
      ].join("\n"),
    ],
    { encoding: "utf8" },
  );
  assert.equal(seeded.status, 0, seeded.stderr);

  const containerPathValue = containerPath(rendered);
  const testPath = containerPathValue
    .split(":")
    .map((entry) => (entry === "/usr/bin" ? imageBin : entry))
    .join(":");

  const result = spawnSync("/bin/sh", ["-c", "git"], {
    encoding: "utf8",
    env: { PATH: testPath },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "guarding-wrapper");
});

test("the seeded git wrapper routes through the egress runtime, inside the token wrapper", () => {
  const rendered = render("templates/statefulset.yaml", {});
  const match = /cat > "\$\{LOCAL_BIN\}\/git" <<'EOF'\n([\s\S]*?)\n[ \t]*EOF/.exec(rendered);
  assert.notEqual(match, null, "the seed no longer writes a git wrapper");
  const body = match[1];

  assert.match(
    body,
    /github-git-egress-runtime\.js/,
    "the git wrapper does not reach the publish guard (PEN-3156)",
  );

  // Ordering is load-bearing in one direction: the token wrapper must stay
  // outermost or git runs without its credentials.
  const tokenAt = body.indexOf("paperclip-github-token-env");
  const runtimeAt = body.indexOf("github-git-egress-runtime.js");
  assert.ok(tokenAt >= 0 && runtimeAt > tokenAt, "the scrub runtime must sit inside the token wrapper");
});

test("the seed installs a pre-push hook for the guard to run", () => {
  const rendered = render("templates/statefulset.yaml", {});
  // Without the hook the wrapper injects core.hooksPath at a directory holding
  // nothing, and every push is allowed while looking guarded.
  assert.match(rendered, /paperclip-git-hooks/, "no hooks directory is seeded");
  assert.match(
    rendered,
    /cat > "\$\{GIT_HOOKS_DIR\}\/pre-push" <<'EOF'/,
    "the seed does not write a pre-push hook",
  );
  assert.match(rendered, /--pre-push-hook/, "the seeded hook does not invoke the guard");
});

test("the seeded hooks directory is the one the runtime actually looks in", () => {
  // The assertions above match `--pre-push-hook` and `paperclip-git-hooks` as
  // strings, which catches deletion but not DIVERGENCE — and divergence is the
  // failure this seam actually has. The runtime hardcodes DEFAULT_HOOKS_DIR
  // (`/paperclip/...`) while the seed writes to `${BASE}/...` from
  // persistence.mountPath. They are equal in every values file today, so a
  // deployment that relocated the PVC would point core.hooksPath at a directory
  // holding no hook. `prePushHookPresent` exists to turn that into a refusal
  // rather than a silent unscanned push; this turns it into a failing test
  // instead, which is cheaper than discovering it in production.
  const rendered = render("templates/statefulset.yaml", {});

  const base = rendered.match(/^\s*BASE=(?:"([^"]*)"|'([^']*)'|(\S+))\s*$/m);
  assert.ok(base, "could not find BASE in the rendered seed script");
  const baseValue = base[1] ?? base[2] ?? base[3];

  const hooks = rendered.match(/GIT_HOOKS_DIR="\$\{BASE\}([^"]*)"/);
  assert.ok(hooks, "could not find GIT_HOOKS_DIR in the rendered seed script");
  const seeded = `${baseValue}${hooks[1]}`;

  // Read the constant from source rather than restating it: a test that
  // hardcodes both sides of an equality cannot observe either one moving.
  const runtimeSource = fs.readFileSync(
    path.join(repoRoot, "packages/adapter-utils/src/github-git-egress-runtime.ts"),
    "utf8",
  );
  const declared = runtimeSource.match(/DEFAULT_HOOKS_DIR\s*=\s*"([^"]+)"/);
  assert.ok(declared, "could not read DEFAULT_HOOKS_DIR from the runtime source");

  assert.equal(
    seeded,
    declared[1],
    "the seed writes the pre-push hook somewhere the runtime will not look",
  );
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
    `env.path=/usr/bin:${IMAGE_WRAPPER_BIN}:/paperclip/.local/bin:/paperclip/bin`,
  ]);
  assert.match(stderr, /must place the Paperclip GitHub egress wrapper/);
});

// PEN-3713. The override that would silently reinstate the defect: every
// directory the guard knew about before this change is present and correctly
// ordered, and only the root-owned one is missing — so `gh` resolves to a
// wrapper uid 1000 can rewrite while every pre-PEN-3713 assertion stays green.
test("an env.path override that drops the root-owned image wrapper directory is rejected", () => {
  const stderr = renderExpectingFailure([
    "env.path=/paperclip/.local/bin:/paperclip/bin:/usr/bin:/bin",
  ]);
  assert.match(stderr, /must include the Paperclip GitHub egress wrapper/);
  assert.match(stderr, /\/usr\/local\/libexec\/paperclip\/bin/);
});

// PEN-3713, the same silent reinstatement reached by reordering rather than
// omission. Every directory is present and every one precedes /usr/bin, so each
// per-directory check passes — but `gh` resolves to the first match, and that is
// the PVC copy uid 1000 can rewrite. This rendered green until the order check
// landed; the assertion at the top of this file stating that relative order is
// "the thing that decides which file runs" was only ever exercised against
// correctly-ordered inputs.
test("an env.path override that puts the PVC wrapper directories ahead of the root-owned one is rejected", () => {
  const stderr = renderExpectingFailure([
    `env.path=/paperclip/.local/bin:/paperclip/bin:${IMAGE_WRAPPER_BIN}:/usr/bin:/bin`,
  ]);
  assert.match(stderr, /must keep the Paperclip GitHub egress wrapper/);
  assert.match(stderr, /\/usr\/local\/libexec\/paperclip\/bin/);
});

// A positive control for the four rejections above: the validation has to
// discriminate, not refuse everything. Without this, a helper that failed
// unconditionally would pass all four.
test("an env.path override that keeps the wrappers first is accepted", () => {
  const rendered = render("templates/statefulset.yaml", {
    set: [
      `env.path=${IMAGE_WRAPPER_BIN}:/paperclip/.local/bin:/paperclip/bin:/opt/custom/bin:/usr/bin:/bin`,
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
    `${IMAGE_WRAPPER_BIN}:/paperclip/.local/bin:/paperclip/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
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

// PEN-3713 deliberately does NOT move this one wrapper, and the test exists to
// keep the next editor from "finishing the job" and taking the fleet down.
//
// The seed runs in the SERVER pod. The .mcp.json it writes is consumed by agent
// Job pods running a different image, pinned by `adapterConfig.image` — a
// database value that moves on an image bump, not on a chart deploy. So the
// server carrying the root-owned wrapper is no evidence that the agent does,
// and an absolute command cannot fall back the way a PATH lookup can: pointing
// this at the image directory the moment the server has it breaks the github
// MCP server on every agent pod still on an older image.
//
// The flip belongs in the follow-up that deletes the seed install outright,
// which is already gated on the whole fleet carrying the directory — at which
// point there is no second copy and no skew window.
test("the seeded github MCP upstream stays on the PVC wrapper until the seed install is deleted (PEN-3713)", () => {
  const rendered = render("templates/statefulset.yaml");

  assert.equal(
    seededMcpGitHubCommand(rendered),
    "${LOCAL_BIN}/github-mcp-server",
    "the seeded github MCP command must reach LOCAL_BIN, so the fallback tracks wherever the seed installs",
  );

  // The actual regression guard. A chart that names the image directory in an
  // absolute MCP command is deciding, from the server pod, a question only the
  // agent pod can answer.
  assert.ok(
    !seededMcpGitHubCommand(rendered).includes(IMAGE_WRAPPER_BIN),
    `the seeded github MCP command must not hardcode ${IMAGE_WRAPPER_BIN}: this seed runs in the server pod, but the file is consumed by agent pods on an independently pinned image`,
  );
});

// The two halves that must agree for the preferred branch to resolve: the chart
// names a directory, and the Dockerfiles install into one. A mismatch is
// invisible to every other test here — the render succeeds, the PATH ordering
// holds, and every pod silently takes the fallback.
test("the chart's image wrapper directory is the one the Dockerfiles install into", () => {
  const dockerfile = fs.readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");
  assert.match(
    dockerfile,
    new RegExp(
      `COPY --chmod=0755 --exclude=\\*\\.md docker/github-wrappers/ ${IMAGE_WRAPPER_BIN}/`,
    ),
    "Dockerfile must install the wrappers into the directory the chart puts on PATH",
  );

  const agentDockerfile = fs.readFileSync(
    path.join(repoRoot, "Dockerfile.agent"),
    "utf8",
  );
  assert.ok(
    agentDockerfile.includes(
      `COPY --from=server ${IMAGE_WRAPPER_BIN} ${IMAGE_WRAPPER_BIN}`,
    ),
    "the agent image must carry the same wrappers as the server image",
  );

  // Both adapters prepend this same directory to every agent Job's PATH, on a
  // surface the Helm render guard above cannot reach.
  //
  // PEN-3916: this loop used to name claude_k8s alone, because opencode_k8s was
  // cloned from a fork at a pinned SHA and there was no in-tree file to read.
  // `scripts/check-opencode-k8s-pin-reachable.mjs` covered it instead, by
  // grepping the pinned tree over the network for a MENTION of the directory --
  // which, as Ally noted on #2392, attests presence and not ordering. Now that
  // the source is vendored the assertion is an ordinary file read, and the
  // ORDERING itself is asserted behaviourally by the adapter's own suite
  // (`buildJobManifest -- GitHub egress wrapper PATH ordering`, five cases
  // including present-but-late). Neither property depends on a network probe.
  for (const adapterDir of [
    "vendor/paperclip-adapter-claude-k8s",
    "vendor/paperclip-adapter-opencode-k8s",
  ]) {
    const adapter = fs.readFileSync(
      path.join(repoRoot, adapterDir, "src/server/job-manifest.ts"),
      "utf8",
    );
    assert.ok(
      adapter.includes(`const GITHUB_WRAPPER_BIN_DIR = "${IMAGE_WRAPPER_BIN}";`),
      `${adapterDir} must prepend the same directory the chart names`,
    );
  }

  // The third place the directory is named: inside the wrapper scripts
  // themselves. `git` and `github-mcp-server` chain-load
  // `<dir>/paperclip-github-token-env` as an ABSOLUTE path, so they do not
  // track PATH the way their own resolution does — a directory move that
  // misses them leaves a wrapper that resolves fine and then execs a path
  // that no longer exists.
  //
  // This is deliberately asserted here rather than left to the drift test
  // below. That test catches it only transitively and only by accident: it
  // rewrites `/paperclip/.local/bin` to IMAGE_WRAPPER_BIN on the seeded copy
  // before comparing, so a stale absolute path in the repo copy shows up as a
  // mismatch. That cover disappears with the seed block in the PEN-3713
  // follow-up — which is also the change most likely to tidy these paths.
  // The count, not merely the presence. `git` names the directory TWICE — once
  // to chain-load paperclip-github-token-env, once to point
  // credential.https://github.com.helper at github-token-credential-helper —
  // and `.includes()` is satisfied by either one alone. A hand-edited directory
  // move that updates the first and misses the second passes a presence check
  // while leaving the helper pointing at a path that is not there, and git
  // treats an unresolvable credential helper as NO credential helper: it keeps
  // running, so the half-done move degrades silently rather than failing.
  //
  // The expected counts are per wrapper and are deliberately not derived from
  // the file (a count read out of the body it is checking asserts nothing).
  // They are small integers that change only when a wrapper is rewritten, which
  // is exactly when a human should re-read this.
  for (const [name, expected] of [
    ["git", 2],
    ["github-mcp-server", 1],
  ]) {
    const body = fs.readFileSync(
      path.join(repoRoot, "docker/github-wrappers", name),
      "utf8",
    );
    assert.equal(
      body.split(IMAGE_WRAPPER_BIN).length - 1,
      expected,
      `the ${name} wrapper chain-loads an absolute path and must name ${IMAGE_WRAPPER_BIN} exactly ${expected} time(s): it does not resolve this one through PATH, so a directory move that misses it execs a path that is not there`,
    );
  }
});

// While both generations exist, the repo files and the seed heredocs are two
// copies of one rule and can drift. They are compared after rewriting the PVC
// directory to the image directory, which is the only difference either copy is
// allowed to have.
//
// Scope this test does NOT cover, so the next person to debug it does not have
// to infer it: both sides are compared line-by-line AFTER trimming each line, so
// indentation drift is invisible here. That is deliberate — the seed copy is a
// heredoc nested inside YAML and carries the block's indentation, which the repo
// copy cannot have — but it means a wrapper reindented on one side only will
// pass. Shell is whitespace-insensitive at this granularity, so the behaviour
// under test is unaffected; the limit is on what a green result proves.
test("the repo wrapper files and the seed heredocs are the same scripts", () => {
  const rendered = render("templates/statefulset.yaml");
  for (const name of [
    "paperclip-github-token-env",
    "github-token-credential-helper",
    "gh",
    "github-mcp-server",
    "git",
  ]) {
    const seeded = extractWrapperBody(rendered, name)
      .split("\n")
      .map((line) => line.replaceAll("/paperclip/.local/bin", IMAGE_WRAPPER_BIN))
      .join("\n");
    const baked = fs
      .readFileSync(path.join(repoRoot, "docker/github-wrappers", name), "utf8")
      .split("\n")
      .map((line) => line.trim())
      .join("\n")
      .trimEnd();
    assert.equal(
      baked,
      seeded.trimEnd(),
      `docker/github-wrappers/${name} has drifted from the seed heredoc`,
    );
  }
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

