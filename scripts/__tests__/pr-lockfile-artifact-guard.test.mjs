import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const workflow = readFileSync(new URL("../../.github/workflows/pr.yml", import.meta.url), "utf8");
const lockfileStepName = "Restore regenerated PR lockfile (if policy uploaded one)";

function getWorkflowSteps(name) {
  const stepMarker = `      - name: ${name}\n`;
  const steps = [];
  let cursor = 0;

  for (;;) {
    const stepStart = workflow.indexOf(stepMarker, cursor);
    if (stepStart === -1) break;
    const nextStep = workflow.indexOf("\n      - ", stepStart + stepMarker.length);
    steps.push(workflow.slice(stepStart, nextStep === -1 ? undefined : nextStep));
    cursor = stepStart + stepMarker.length;
  }

  return steps;
}

test("every regenerated-lockfile download skips only the no-artifact case", () => {
  const steps = getWorkflowSteps(lockfileStepName);
  assert.equal(steps.length, 7, "expected all seven PR/merge-queue lockfile consumers");

  for (const [index, step] of steps.entries()) {
    assert.match(
      step,
      /^        if: needs\.policy\.outputs\.lockfile_regenerated == '1'$/m,
      `lockfile download ${index + 1} must be gated by the policy output`,
    );
    assert.match(
      step,
      /^        uses: actions\/download-artifact@v4$/m,
      `lockfile download ${index + 1} must use the expected artifact action`,
    );
    assert.match(step, /^          name: pr-lockfile$/m, `lockfile download ${index + 1} must use pr-lockfile`);
    assert.doesNotMatch(
      step,
      /^        continue-on-error:/m,
      `lockfile download ${index + 1} must fail when policy says the artifact is required`,
    );
  }
});

// Extract the workflow's actual shell block so this test pins production retry
// behavior instead of reimplementing it in test-only code.
function getPlaywrightInstallDepsScript() {
  const [step] = getWorkflowSteps("Install Playwright system dependencies");
  assert.ok(step, "pr.yml must define the Playwright system dependency step");

  const runMarker = "        run: |\n";
  const runStart = step.indexOf(runMarker);
  assert.notEqual(runStart, -1, "Playwright system dependency step must use a run block");

  return step
    .slice(runStart + runMarker.length)
    .split("\n")
    .filter((line) => line === "" || line.startsWith("          "))
    .map((line) => line.slice(10))
    .join("\n");
}

function runInstallDepsScript({ failCount }) {
  const binDir = mkdtempSync(join(tmpdir(), "pr-lockfile-guard-"));
  const callLog = join(binDir, "calls.log");
  writeFileSync(callLog, "");

  try {
    writeFileSync(
      join(binDir, "pnpm"),
      `#!/bin/sh\necho pnpm >> "${callLog}"\nn=$(grep -c '^pnpm$' "${callLog}")\n[ "$n" -gt ${failCount} ] && exit 0\nexit 1\n`,
      { mode: 0o755 },
    );
    writeFileSync(join(binDir, "sleep"), `#!/bin/sh\necho "sleep $1" >> "${callLog}"\n`, { mode: 0o755 });

    const result = spawnSync("bash", ["-c", getPlaywrightInstallDepsScript()], {
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
      encoding: "utf8",
    });
    const calls = readFileSync(callLog, "utf8").trim().split("\n").filter(Boolean);
    return { ...result, calls };
  } finally {
    rmSync(binDir, { recursive: true, force: true });
  }
}

test("Playwright deps install succeeds immediately without sleeping", () => {
  const { status, calls, stderr } = runInstallDepsScript({ failCount: 0 });
  assert.equal(status, 0);
  assert.deepEqual(calls, ["pnpm"]);
  assert.equal(stderr, "");
});

test("Playwright deps install exposes and retries a transient failure", () => {
  const { status, calls, stderr } = runInstallDepsScript({ failCount: 1 });
  assert.equal(status, 0);
  assert.deepEqual(calls, ["pnpm", "sleep 15", "pnpm"]);
  assert.match(stderr, /\(attempt 1\/3\); retrying in 15s/);
});

test("Playwright deps install fails visibly after three attempts without a trailing sleep", () => {
  const { status, calls, stderr } = runInstallDepsScript({ failCount: 3 });
  assert.notEqual(status, 0);
  assert.deepEqual(calls, ["pnpm", "sleep 15", "pnpm", "sleep 15", "pnpm"]);
  assert.match(stderr, /\(attempt 1\/3\); retrying in 15s/);
  assert.match(stderr, /\(attempt 2\/3\); retrying in 15s/);
  assert.match(stderr, /failed after 3 attempts/);
  assert.doesNotMatch(stderr, /\(attempt 3\/3\); retrying/);
});
