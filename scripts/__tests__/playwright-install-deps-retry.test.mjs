import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const workflow = readFileSync(new URL("../../.github/workflows/pr.yml", import.meta.url), "utf8");

// BLO-27699 (BLO-22675 residue): extract the actual `run:` shell script from
// the "Install Playwright system dependencies" step so these tests exercise the
// real workflow script rather than a re-implementation of it. Same technique as
// scripts/__tests__/pr-verify-lane-outcome.test.mjs.
function getInstallDepsScript() {
  const stepMarker = "\n      - name: Install Playwright system dependencies\n";
  const stepStart = workflow.indexOf(stepMarker);
  assert.notEqual(stepStart, -1, "pr.yml must define the Playwright system dependency step");

  const runMarker = "\n        run: |\n";
  const runStart = workflow.indexOf(runMarker, stepStart);
  assert.notEqual(runStart, -1, "install-deps step must use a `run: |` block so it can retry");

  const remainder = workflow.slice(runStart + runMarker.length);
  const scriptLines = [];
  for (const line of remainder.split("\n")) {
    if (line !== "" && !line.startsWith("          ")) break;
    scriptLines.push(line.slice(10));
  }
  return scriptLines.join("\n");
}

/**
 * Run the real install-deps script against a stub `pnpm` that fails its first
 * `failures` invocations and succeeds afterwards. `failures: Infinity` never
 * succeeds. Returns the spawn result plus the observed invocation count and the
 * argv the stub was called with.
 */
function runInstallDeps({ failures }) {
  const dir = mkdtempSync(join(tmpdir(), "playwright-install-deps-"));
  try {
    const counter = join(dir, "count");
    const argvLog = join(dir, "argv");
    writeFileSync(counter, "0");

    const stub = join(dir, "pnpm");
    // Counts invocations, records argv, and fails until the quota is used up.
    writeFileSync(
      stub,
      [
        "#!/usr/bin/env bash",
        `count=$(cat ${JSON.stringify(counter)})`,
        "count=$((count + 1))",
        `printf '%s' "$count" > ${JSON.stringify(counter)}`,
        `printf '%s\\n' "$*" >> ${JSON.stringify(argvLog)}`,
        `if [ "$count" -le "${failures === Infinity ? 999 : failures}" ]; then`,
        '  echo "stub pnpm: simulated apt mirror failure" >&2',
        "  exit 1",
        "fi",
        "exit 0",
      ].join("\n"),
    );
    chmodSync(stub, 0o755);

    const result = spawnSync("bash", ["-c", getInstallDepsScript()], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        // Keep the suite fast; the workflow default (15s, doubling) still
        // applies in CI because this variable is unset there.
        PLAYWRIGHT_INSTALL_DEPS_RETRY_DELAY_SECONDS: "0",
      },
    });

    return {
      result,
      invocations: Number(readFileSync(counter, "utf8")),
      argv: readFileSync(argvLog, "utf8").trim().split("\n").filter(Boolean),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("install-deps invokes playwright exactly once when the first attempt succeeds", () => {
  const { result, invocations, argv } = runInstallDeps({ failures: 0 });
  assert.equal(result.status, 0);
  assert.equal(invocations, 1, "a passing install must not be retried");
  assert.deepEqual(argv, ["exec playwright install-deps chromium"]);
});

// This is the regression Ally asked for on #1119: the wrapper must RE-INVOKE
// on a non-zero exit, not merely swallow it.
test("install-deps retries after a non-zero exit and succeeds on a later attempt", () => {
  const { result, invocations } = runInstallDeps({ failures: 2 });
  assert.equal(result.status, 0, "a transient failure must not fail the job");
  assert.equal(invocations, 3, "must re-invoke after each non-zero exit");
  assert.match(result.stderr, /retrying in 0s/);
});

test("install-deps makes at least 3 attempts before giving up, then fails the job", () => {
  const { result, invocations } = runInstallDeps({ failures: Infinity });
  assert.notEqual(result.status, 0, "a persistent failure must still fail the job");
  assert.ok(invocations >= 3, `expected >= 3 attempts, saw ${invocations}`);
  assert.match(result.stderr, /failed after 3 attempts/);
});

test("install-deps backs off between attempts rather than retrying immediately", () => {
  const script = getInstallDepsScript();
  assert.match(script, /sleep "\$delay"/, "retry loop must sleep between attempts");
  assert.match(script, /delay=\$\(\(delay \* 2\)\)/, "delay must grow between attempts");
  assert.match(
    script,
    /delay="\$\{PLAYWRIGHT_INSTALL_DEPS_RETRY_DELAY_SECONDS:-15\}"/,
    "CI must default to a 15s base delay when the test override is unset",
  );
});
