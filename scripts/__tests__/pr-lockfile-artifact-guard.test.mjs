import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const workflow = readFileSync(new URL("../../.github/workflows/pr.yml", import.meta.url), "utf8");

// BLO-22675 / PR #1119 review: every "Restore regenerated PR lockfile"
// download must be gated on the policy job's lockfile_regenerated output, or
// merge_group runs go back to logging a misleading ##[error] "Artifact not
// found" on every run that didn't touch a manifest.
test("every pr-lockfile download step is guarded by policy.outputs.lockfile_regenerated", () => {
  const stepName = "Restore regenerated PR lockfile (if policy uploaded one)";
  const stepMarker = `\n      - name: ${stepName}\n`;
  const guardLine = "        if: needs.policy.outputs.lockfile_regenerated == '1'\n";

  let cursor = 0;
  let stepCount = 0;
  for (;;) {
    const stepStart = workflow.indexOf(stepMarker, cursor);
    if (stepStart === -1) break;
    stepCount += 1;
    const nextLine = workflow.slice(stepStart + stepMarker.length, stepStart + stepMarker.length + guardLine.length);
    assert.equal(
      nextLine,
      guardLine,
      `"${stepName}" step at offset ${stepStart} must be immediately followed by the lockfile_regenerated guard`,
    );
    cursor = stepStart + stepMarker.length;
  }

  assert.equal(stepCount, 7, "expected exactly the 7 known pr-lockfile download steps in pr.yml");
});

// BLO-20867-style extraction: pull the actual `run:` shell script from the
// e2e job's "Install Playwright system dependencies" step so this test
// exercises the real script, not a re-implementation of it.
function getPlaywrightInstallDepsScript() {
  const stepMarker = "\n      - name: Install Playwright system dependencies\n";
  const stepStart = workflow.indexOf(stepMarker);
  assert.notEqual(stepStart, -1, "pr.yml must define the Playwright system deps install step");

  const runMarker = "\n        run: |\n";
  const runStart = workflow.indexOf(runMarker, stepStart);
  assert.notEqual(runStart, -1, "Playwright system deps step must use a `run: |` block");

  const remainder = workflow.slice(runStart + runMarker.length);
  const lines = remainder.split("\n");
  const scriptLines = [];
  for (const line of lines) {
    if (line !== "" && !line.startsWith("          ")) break;
    scriptLines.push(line.slice(10));
  }
  return scriptLines.join("\n");
}

// Stub `pnpm` to fail a fixed number of times before succeeding (or always
// fail), and stub `sleep` to record its calls without actually waiting, so
// the test observes attempt/backoff behavior without taking 30+ real seconds.
function runInstallDepsScript({ failCount }) {
  const script = getPlaywrightInstallDepsScript();
  const binDir = mkdtempSync(join(tmpdir(), "pr-lockfile-guard-"));
  const callLog = join(binDir, "calls.log");
  writeFileSync(callLog, "");

  try {
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      join(binDir, "pnpm"),
      `#!/bin/sh\necho pnpm >> "${callLog}"\nn=$(grep -c '^pnpm$' "${callLog}")\n[ "$n" -gt ${failCount} ] && exit 0\nexit 1\n`,
      { mode: 0o755 },
    );
    writeFileSync(join(binDir, "sleep"), `#!/bin/sh\necho "sleep $1" >> "${callLog}"\n`, { mode: 0o755 });

    const result = spawnSync("bash", ["-c", script], {
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
      encoding: "utf8",
    });
    const calls = readFileSync(callLog, "utf8").trim().split("\n").filter(Boolean);
    return { ...result, calls };
  } finally {
    rmSync(binDir, { recursive: true, force: true });
  }
}

test("Playwright deps install succeeds without retrying when the first attempt succeeds", () => {
  const { status, calls } = runInstallDepsScript({ failCount: 0 });
  assert.equal(status, 0);
  assert.deepEqual(calls, ["pnpm"]);
});

test("Playwright deps install retries a transient failure and then succeeds", () => {
  const { status, calls } = runInstallDepsScript({ failCount: 1 });
  assert.equal(status, 0);
  assert.deepEqual(calls, ["pnpm", "sleep 15", "pnpm"]);
});

// This is the exact defect flagged in the PR #1119 review: the third and
// final attempt must not sleep before exiting, or three failures cost 45s
// instead of the documented 30s max.
test("Playwright deps install stops after 3 attempts without a trailing sleep", () => {
  const { status, calls } = runInstallDepsScript({ failCount: 3 });
  assert.notEqual(status, 0);
  assert.deepEqual(calls, ["pnpm", "sleep 15", "pnpm", "sleep 15", "pnpm"]);
});
