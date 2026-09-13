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
