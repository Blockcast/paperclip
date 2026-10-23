// Coverage for the PEN-4541 positive-control driver.
//
// What is actually worth testing here is the INVERSION, because it is the one
// piece of logic in this control whose failure is silent in the dangerous
// direction. The driver's job is to require that the checker goes RED on a
// deliberately-bad image; a driver that got the sense backwards — or that
// swallowed the checker's exit code — would report "all controls passed" on a
// checker that had stopped measuring anything, which is worse than having no
// control at all, because it manufactures evidence.
//
// So the case that matters is the second one below: a checker that returns
// GREEN on every poisoned image (exactly what reading the runner's own
// filesystem instead of the agent image would look like) must make this driver
// FAIL. Nothing in the arc-dind lane can exercise that without deliberately
// breaking the checker.
//
// A `docker` shim stands in for the daemon, which no PR runner has. It serves a
// fixture rootfs to the checker's `docker cp` and no-ops the build.

import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { EXPECTED_SYSTEM_GITCONFIG } from "./git-config-surface.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DRIVER = path.join(repoRoot, "scripts/prove-agent-image-git-config-controls.mjs");

// `buildx build` and `rmi` are no-ops; `create`/`cp`/`rm` serve the fixture the
// caller selected. The point is not to emulate docker — it is to control what
// the checker SEES, so the driver's reaction to a green checker is observable.
const SHIM = `#!/bin/sh
case "$1" in
  buildx) exit 0 ;;
  rmi)    exit 0 ;;
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

function runDriver(systemGitconfig) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pen4541-driver-"));
  try {
    const rootfs = path.join(dir, "rootfs");
    fs.mkdirSync(path.join(rootfs, "etc"), { recursive: true });
    fs.writeFileSync(path.join(rootfs, "etc/gitconfig"), systemGitconfig);
    const wrapper = path.join(rootfs, "usr/local/libexec/paperclip/bin");
    fs.mkdirSync(wrapper, { recursive: true });
    fs.copyFileSync(
      path.join(repoRoot, "docker/github-wrappers/git"),
      path.join(wrapper, "git"),
    );

    const binDir = path.join(dir, "bin");
    fs.mkdirSync(binDir);
    fs.writeFileSync(path.join(binDir, "docker"), SHIM, { mode: 0o755 });

    const result = spawnSync(process.execPath, [DRIVER, "fixture:agent-image"], {
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

// The controls this run actually attempted, read back from the driver's own
// transcript. Every control prints this banner before it is built, so the list
// is the driver's, not a copy of it that can drift.
function attemptedControls(out) {
  return [...out.matchAll(/^--- control '([^']+)'/gm)].map((match) => match[1]);
}

test("the control driver passes when the checker reds on every control", () => {
  // The shim serves a poisoned system scope for every tag, which is what a
  // correctly-mutated control image looks like to the checker.
  const { status, out } = runDriver(
    `${EXPECTED_SYSTEM_GITCONFIG}[url "https://control.invalid/"]\n\tinsteadOf = https://github.com/\n`,
  );
  assert.equal(status, 0, out);
  // Derived from the driver's own output, not restated here. The count used to
  // be a literal `4`, which made adding a control to the driver fail THIS test
  // for a reason that has nothing to do with what it checks -- the same
  // enumerate-don't-restate rule the wrapper test follows when it reads the
  // directory instead of listing it.
  assert.match(
    out,
    new RegExp(`all ${attemptedControls(out).length} positive controls red the checker`),
  );
  assert.doesNotMatch(out, /did NOT red/);
});

// THE CASE THIS FILE EXISTS FOR. The shim serves a CLEAN system scope no matter
// which control image is asked for, so the checker returns green on every
// poisoned build — indistinguishable, from the driver's side, from a checker
// that is reading this runner's filesystem rather than the agent image. The
// driver must call that a failure and name it.
test("the control driver FAILS when the checker stays green on a poisoned image", () => {
  const { status, out } = runDriver(EXPECTED_SYSTEM_GITCONFIG);
  assert.equal(
    status,
    1,
    `the driver accepted a checker that never reds. That is the failure mode PEN-4541's positive controls exist to catch, and it would manufacture evidence that the agent image had been checked:\n${out}`,
  );
  assert.match(out, /did NOT red the checker/);

  // EVERY control the driver attempted must be reported green -- derived from
  // the run, not from a list written here. A driver that stopped at the first
  // green one would under-report which assertions are dead, and a hardcoded
  // subset could not see that: it would keep passing while a newly added
  // control went unreported.
  const attempted = attemptedControls(out);
  assert.ok(
    attempted.length >= 6,
    `the driver attempted only ${attempted.length} control(s); this assertion goes vacuous if the control list is emptied, so it carries a floor:\n${out}`,
  );
  assert.match(out, new RegExp(`${attempted.length} positive control\\(s\\) stayed green`));
  for (const name of attempted) {
    assert.ok(out.includes(`'${name}' did NOT red`), `control '${name}' was not reported as green:\n${out}`);
  }
});
