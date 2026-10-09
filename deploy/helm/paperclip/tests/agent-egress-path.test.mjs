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

function assertWrapperOrdering(pathValue, base) {
  const entries = pathValue.split(":");
  const systemIdx = entries.indexOf("/usr/bin");
  assert.notEqual(systemIdx, -1, "expected /usr/bin on PATH");

  // PEN-3840: the root-owned image directory is now the ONLY wrapper directory,
  // so the invariant is absolute rather than relative. "Ahead of /usr/bin" was
  // sufficient while a second, lower-priority wrapper generation existed to be
  // ordered against; with one generation, anything in front of it resolves
  // gh/git/github-mcp-server first. The property is that NOTHING precedes it.
  assert.equal(
    entries[0],
    IMAGE_WRAPPER_BIN,
    `the root-owned ${IMAGE_WRAPPER_BIN} must be first on PATH, got ${pathValue}`,
  );

  // The retired generation must be gone, not merely outranked: a PATH still
  // carrying it would keep executing agent-writable copies wherever the files
  // survive on the PVC.
  assert.ok(
    !entries.includes(`${base}/.local/bin`),
    `the retired agent-writable ${base}/.local/bin must no longer be on PATH, got ${pathValue}`,
  );

  // ...and the tooling directory must survive the removal. Not a wrapper
  // directory and not security-ordered, but kubectl/helm/yq/kyverno/chrome live
  // there: dropping it alongside the wrapper entries is the silent collateral
  // the wrapperBinDirs/toolingBinDir split exists to prevent.
  const toolingIdx = entries.indexOf(`${base}/bin`);
  assert.notEqual(
    toolingIdx,
    -1,
    `the tooling directory ${base}/bin must stay on PATH, got ${pathValue}`,
  );
  assert.ok(
    toolingIdx > 0 && toolingIdx < systemIdx,
    `${base}/bin must sit behind the wrapper directory and ahead of /usr/bin, got ${pathValue}`,
  );
}

// --- The invariant, under the chart's own defaults ------------------------

test("default values put the root-owned image wrappers first on PATH (workers)", () => {
  const rendered = render("templates/statefulset.yaml");
  assertWrapperOrdering(containerPath(rendered), "/paperclip");
});

test("default values put the root-owned image wrappers first on PATH (api tier)", () => {
  // The API tier mounts the same RWX PVC, so it sees the same wrappers and
  // needs the same ordering.
  const rendered = render("templates/deployment-api.yaml", {
    set: [
      "api.enabled=true",
      "persistence.existingClaim=paperclip-shared",
    ],
  });
  assertWrapperOrdering(containerPath(rendered), "/paperclip");
});

test("the PATH follows persistence.mountPath rather than a hardcoded /paperclip", () => {
  const rendered = render("templates/statefulset.yaml", {
    set: ["persistence.mountPath=/data"],
  });
  const value = containerPath(rendered);
  assertWrapperOrdering(value, "/data");
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

// PEN-3840: these used to execute the seed's own publish step, so the test
// failed if the seed stopped publishing onto the PATH-visible bin. The seed is
// gone and there is nothing left to publish — the wrapper simply IS the file in
// the image directory. So the substitution moves: the image wrapper directory
// and /usr/bin are each redirected at a temp dir this test can populate, and
// the ordering under test still comes from the render rather than being
// restated here.
function resolvesTo(tool) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `${tool}-path-reach-`));
  const wrapperBin = path.join(base, "image-wrapper-bin");
  const imageBin = path.join(base, "usr-bin");
  for (const dir of [wrapperBin, imageBin]) fs.mkdirSync(dir, { recursive: true });

  const rendered = render("templates/statefulset.yaml", {
    set: [`persistence.mountPath=${base}`],
  });

  // Each announces itself, so the winner is unambiguous.
  writeExecutable(wrapperBin, tool, "#!/bin/sh\necho scrubbing-wrapper\n");
  writeExecutable(imageBin, tool, "#!/bin/sh\necho image-cli\n");

  const containerPathValue = containerPath(rendered);
  assert.ok(
    containerPathValue.split(":").includes("/usr/bin"),
    "expected /usr/bin on the rendered PATH to substitute",
  );
  assert.ok(
    containerPathValue.split(":").includes(IMAGE_WRAPPER_BIN),
    "expected the image wrapper directory on the rendered PATH to substitute",
  );
  const testPath = containerPathValue
    .split(":")
    .map((entry) => {
      if (entry === "/usr/bin") return imageBin;
      if (entry === IMAGE_WRAPPER_BIN) return wrapperBin;
      return entry;
    })
    .join(":");

  // /bin/sh by absolute path so the shell itself does not depend on the PATH
  // under test — only the lookup inside it does.
  const result = spawnSync("/bin/sh", ["-c", tool], {
    encoding: "utf8",
    env: { PATH: testPath },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test("a non-login shell resolves gh to the root-owned wrapper under the default-values PATH", () => {
  assert.equal(resolvesTo("gh"), "scrubbing-wrapper");
});

// PEN-3156: the publish guard on the `git` door needs the same reachability.
// The regression this pins, measured in a live agent Job pod on 2026-09-10: a
// `git` wrapper existed and was byte-identical to the chart, but nothing put it
// on the PATH the pod actually carried, so `command -v git` gave /usr/bin/git
// and the guard was a choke point nothing traversed.
test("a non-login shell resolves git to the publish-guarding wrapper", () => {
  assert.equal(resolvesTo("git"), "scrubbing-wrapper");
});

test("the git wrapper routes through the egress runtime, inside the token wrapper", () => {
  const body = wrapperBody("git");

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

test("an env.path override that drops the wrapper directory is rejected", () => {
  const stderr = renderExpectingFailure(["env.path=/usr/local/bin:/usr/bin:/bin"]);
  assert.match(stderr, /must BEGIN with the Paperclip GitHub egress wrapper/);
  assert.match(stderr, /\/usr\/local\/libexec\/paperclip\/bin/);
});

test("an env.path override that orders the wrapper directory after /usr/bin is rejected", () => {
  const stderr = renderExpectingFailure([
    `env.path=/paperclip/bin:/usr/bin:${IMAGE_WRAPPER_BIN}`,
  ]);
  assert.match(stderr, /must BEGIN with the Paperclip GitHub egress wrapper/);
});

// PEN-3840, the override this change had to grow a new guard to reject.
//
// Reducing wrapperBinDirs to a single entry silently retired the relative-order
// check: with two generations listed, "keep them in declared order" was what
// stopped an override from putting the agent-writable copy first, and with one
// entry that check passes vacuously. So this PATH — which names the image
// directory, keeps it ahead of /usr/bin, and keeps the tooling directory —
// satisfied every per-directory check the chart had, while resolving `gh` to a
// directory uid 1000 can rewrite. It is the exact defect PEN-3713 fixed,
// reachable again through configuration alone.
test("an env.path override that prepends an agent-writable directory is rejected", () => {
  const stderr = renderExpectingFailure([
    `env.path=/paperclip/.local/bin:${IMAGE_WRAPPER_BIN}:/paperclip/bin:/usr/bin:/bin`,
  ]);
  assert.match(stderr, /must BEGIN with the Paperclip GitHub egress wrapper/);
  assert.match(stderr, /\/paperclip\/\.local\/bin/);
});

// PEN-3840's other new guard, and the landmine the card warned about: dropping
// /paperclip/bin from wrapperBinDirs takes it off PATH entirely unless the
// chart adds it back deliberately, and the wrapper guard cannot notice — it
// only validates directories something still declares. Without this check the
// render succeeds and the server pod silently loses kubectl, helm, yq, kyverno
// and google-chrome.
test("an env.path override that drops the tooling directory is rejected", () => {
  const stderr = renderExpectingFailure([
    `env.path=${IMAGE_WRAPPER_BIN}:/usr/local/bin:/usr/bin:/bin`,
  ]);
  assert.match(stderr, /must include the Paperclip tooling directory/);
  assert.match(stderr, /\/paperclip\/bin/);
});

// A positive control for the rejections above: the validation has to
// discriminate, not refuse everything. Without this, a guard that failed
// unconditionally would pass all four.
test("an env.path override that keeps the wrapper directory first is accepted", () => {
  const rendered = render("templates/statefulset.yaml", {
    set: [
      `env.path=${IMAGE_WRAPPER_BIN}:/paperclip/bin:/opt/custom/bin:/usr/bin:/bin`,
    ],
  });
  const value = containerPath(rendered);
  assertWrapperOrdering(value, "/paperclip");
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
    `${IMAGE_WRAPPER_BIN}:/paperclip/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
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
// PEN-3840 resolved an asymmetry that used to live here: the MCP wrapper's
// inner exec and the seeded command both hardcoded `/paperclip/.local/bin`,
// which held only at the default mountPath, while the `gh` door's reachability
// followed persistence.mountPath. Both now name the image directory, which is a
// path inside the image and correctly does NOT follow the PVC.

// PEN-3840: one wrapper's body, read from docker/github-wrappers/ — which is
// now the ONLY generation, and the thing the Dockerfile COPYs into the image.
// This used to lift the body out of the rendered seed heredoc; with the seed
// deleted there is no rendered copy, and reading the shipped file is strictly
// closer to what executes.
function wrapperBody(name) {
  return fs
    .readFileSync(path.join(repoRoot, "docker/github-wrappers", name), "utf8")
    .trimEnd();
}

// The `github` upstream's command as the seeded .mcp.json carries it.
function seededMcpGitHubCommand(rendered) {
  const match = /"github":\s*\{\s*"command":\s*"([^"]+)"/.exec(rendered);
  assert.notEqual(match, null, "the seeded mcpServers block no longer has a github command");
  return match[1];
}

// PEN-3713 deliberately did NOT move this one wrapper, and PEN-3840 is the
// change that discharges that deferral. Both directions matter, so read why
// before flipping it back.
//
// The seed runs in the SERVER pod; the .mcp.json it writes is consumed by agent
// Job pods on a different image, pinned by `adapterConfig.image` — a database
// value that moves on an image bump, not on a chart deploy. An ABSOLUTE command
// cannot fall back the way a PATH lookup can, so naming the image directory
// while any agent pod still lacked it would have broken the github MCP server
// fleet-wide, with no reachable second copy.
//
// That skew window is what PEN-3840's entry gate measured shut: every agent Job
// pod observed from 2026-10-06T10:00Z onward runs an image descended from
// bb62073a, so every consumer of this file now carries the directory. This is
// also the first point at which all five wrappers are root-owned on the traffic
// path — PEN-3713 reached four of five, and this absolute path was the fifth.
test("the seeded github MCP upstream names the root-owned image wrapper (PEN-3840)", () => {
  const rendered = render("templates/statefulset.yaml");

  assert.equal(
    seededMcpGitHubCommand(rendered),
    `${IMAGE_WRAPPER_BIN}/github-mcp-server`,
    "the seeded github MCP command must name the root-owned image wrapper",
  );

  // The regression guard, now pointing the other way: this command must not go
  // back to a PVC path. It is an absolute path, so it gets none of the
  // PATH-ordering protection the rest of the wrappers rest on — a PVC target
  // here is executed by every agent pod and is writable by all of them.
  assert.ok(
    !seededMcpGitHubCommand(rendered).includes("/.local/bin"),
    "the seeded github MCP command must not name an agent-writable PVC path",
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

  // The adapter prepends this same directory to every agent Job's PATH, on a
  // surface the Helm render guard above cannot reach.
  const adapter = fs.readFileSync(
    path.join(
      repoRoot,
      "vendor/paperclip-adapter-claude-k8s/src/server/job-manifest.ts",
    ),
    "utf8",
  );
  assert.ok(
    adapter.includes(`const GITHUB_WRAPPER_BIN_DIR = "${IMAGE_WRAPPER_BIN}";`),
    "the claude_k8s adapter must prepend the same directory the chart names",
  );

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
  for (const name of ["git", "github-mcp-server"]) {
    const body = fs.readFileSync(
      path.join(repoRoot, "docker/github-wrappers", name),
      "utf8",
    );
    assert.ok(
      body.includes(IMAGE_WRAPPER_BIN),
      `the ${name} wrapper chain-loads an absolute path and must name ${IMAGE_WRAPPER_BIN}: it does not resolve this one through PATH, so a directory move that misses it execs a path that is not there`,
    );
  }
});

// PEN-3840: this used to compare the repo wrapper files against the seed
// heredocs, because while both generations existed they were two copies of one
// rule and could drift. There is one copy now, so that comparison is retired —
// and what replaces it is the assertion that there is still only one.
//
// This is the guard against a future edit quietly reintroducing a PVC copy "as
// a fallback": PATH ordering cannot protect a file the consumer can rewrite in
// place, which is the whole of PEN-3713.
test("the chart writes no GitHub wrapper onto the PVC", () => {
  const rendered = render("templates/statefulset.yaml");
  for (const name of [
    "paperclip-github-token-env",
    "github-token-credential-helper",
    "gh",
    "github-mcp-server",
    "git",
  ]) {
    assert.ok(
      !new RegExp(`cat > "[^"]*/${name}" <<`).test(rendered),
      `the seed writes a ${name} wrapper onto the PVC again: it would be owned by uid 1000, the same uid every agent runs as, so the writer is the consumer (PEN-3713/PEN-3840)`,
    );
  }

  // Narrow on purpose: ${BASE}/.local/bin itself is NOT retired and this must
  // not assert that it is. The seed legitimately keeps recreating `claude` and
  // `codex` symlinks there, because the chat plugin hard-spawns
  // ${HOME}/.local/bin/<binary> by absolute path and the PVC mount hides the
  // image's baked copies under ${BASE}. What PEN-3840 retired is that
  // directory's place ON PATH and the GitHub wrappers that lived in it — which
  // is also why dropping it from PATH is safe for those two binaries: the
  // hard-spawn does not consult PATH, and a lookup by name still resolves them
  // at /usr/local/bin, which is not under ${BASE} and stays on PATH.
  assert.ok(
    !/\$\{LOCAL_BIN\}/.test(rendered),
    "the seed reintroduced a LOCAL_BIN GitHub wrapper directory (PEN-3840)",
  );

  // Positive control: the seed still runs and still writes the one PVC file
  // this change deliberately KEEPS — the PEN-3156 pre-push hook, which is not a
  // wrapper and not on PATH. Without this, a seed that stopped doing anything
  // at all would pass every assertion above.
  assert.match(
    rendered,
    /cat > "\$\{GIT_HOOKS_DIR\}\/pre-push" <<'EOF'/,
    "the seed no longer writes the pre-push hook; the assertions above would pass vacuously",
  );
});

test("the rendered github-mcp-server wrapper execs the scrub runtime inside the token wrapper", () => {
  const body = wrapperBody("github-mcp-server");

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

  const body = wrapperBody("github-mcp-server");
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
    .replace("/usr/local/libexec/paperclip/bin/paperclip-github-token-env", tokenEnv)
    .replace("/usr/local/bin/node", node)
    .replace(/\S*github-mcp-egress-runtime\.js/, runtime);

  // The rewrite must have consumed every path this host lacks, or the
  // assertions below would be testing a line that cannot run for the wrong
  // reason.
  assert.ok(
    !rewritten.includes("/usr/local/libexec/paperclip/bin/paperclip-github-token-env"),
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

