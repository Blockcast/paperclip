import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

// BLO-29008 / BLO-29307: the two-tier convergence gate in docker.yml's `deploy`
// job is the assertion that turns an api-only roll from a green run into a
// failure. Its failure mode is fail-OPEN: if the `tier_failures` accumulation
// or the `$'\n'` quoting is subtly wrong, the string stays empty,
// `if [ -n "${tier_failures}" ]` never fires, and every partial roll keeps
// reporting success -- with CI fully green. Chart-render tests cannot see that.
//
// So this file does not read the block, it RUNS it: the shell is extracted
// verbatim from the workflow and executed against a stub `kubectl` that replays
// recorded cluster states. The negative cases are the point; case "converged"
// alone would pass against a gate that can never fail.
//
// Precedent for unit-testing docker.yml shell: scripts/check-docker-deploy-timeout.test.js
// and scripts/guard-pending-deploy.test.js.

const workflowPath = new URL("../.github/workflows/docker.yml", import.meta.url);
const workflow = readFileSync(workflowPath, "utf8");

const DIGEST = "sha256:88f5dc3683f9a1c2d3e4f5061728394a5b6c7d8e9f00112233445566778899aab";
const STALE_DIGEST = "sha256:39a40bdb8b8f89a85ad88c5a2cbb838e3f32726e69142dfc9d82981ab7aec534";
const COMMIT = "8f032604e2eaa2bd37ac443b934adcdddb539c29";
const STALE_COMMIT = "18dfc156a0b1c2d3e4f5061728394a5b6c7d8e9f";
const EXPECTED_IMAGE = `harbor.blockcast.net/paperclip/paperclip@${DIGEST}`;
const STALE_IMAGE = `harbor.blockcast.net/paperclip/paperclip@${STALE_DIGEST}`;
const REVISION = "paperclip-9c6dd75b6";

const workDir = mkdtempSync(join(tmpdir(), "two-tier-gate-"));
after(() => rmSync(workDir, { recursive: true, force: true }));

/**
 * Pull the convergence gate out of the workflow by its own anchors and dedent
 * it back to column 0. Both anchors are asserted, so a refactor that renames or
 * removes the block fails this file loudly instead of silently testing nothing.
 */
function extractGate() {
  // `expected_image=` also appears in the earlier chart-render check, so anchor
  // on the gate's own comment first and search forward from there.
  const gateComment = "# BLO-29008: two-tier convergence gate.";
  const startAnchor = '          expected_image="harbor.blockcast.net/paperclip/paperclip@${DIGEST}"';
  const endAnchor = '          echo "Two-tier convergence OK:';

  const commentAt = workflow.indexOf(gateComment);
  assert.notEqual(commentAt, -1, "docker.yml must define the two-tier convergence gate");
  const start = workflow.indexOf(startAnchor, commentAt);
  assert.notEqual(start, -1, "the convergence gate must compute expected_image");
  const endStart = workflow.indexOf(endAnchor, start);
  assert.notEqual(endStart, -1, "the convergence gate must end with its OK echo");
  const end = workflow.indexOf("\n", endStart);

  const block = workflow.slice(start, end);
  const dedented = block
    .split("\n")
    .map((line) => (line.startsWith("          ") ? line.slice(10) : line))
    .join("\n");

  // Extraction sanity. Without these the harness could "pass" every case by
  // running an empty or truncated script -- the same fail-open shape the gate
  // itself is being tested for.
  assert.match(dedented, /^expected_image=/, "extracted block must start at expected_image");
  assert.ok(dedented.includes("exit 1"), "extracted block must contain the failing exit");
  assert.equal(
    (dedented.match(/tier_failures="\$\{tier_failures\}/g) ?? []).length,
    5,
    "extracted block must accumulate all five tier conditions",
  );
  return dedented;
}

const gate = extractGate();

const kubectlStub = `#!/usr/bin/env bash
# Replays a recorded cluster state for the exact reads the gate performs.
# Any other invocation is a test bug, not a pass: exit 64 so it is loud.
set -uo pipefail
kind=""
jpath=""
prev=""
for arg in "$@"; do
  case "$prev" in
    get) kind="$arg" ;;
    -o) jpath="$arg" ;;
  esac
  prev="$arg"
done
case "$kind" in
  deployment|statefulset) ;;
  *) echo "kubectl stub: unexpected resource kind '$kind' in: $*" >&2; exit 64 ;;
esac
case "$jpath" in
  *"containers[0].image"*) key="IMAGE" ;;
  *deployed-commit*)       key="COMMIT" ;;
  *currentRevision*)       key="STS_CURRENT" ;;
  *updateRevision*)        key="STS_UPDATE" ;;
  *) echo "kubectl stub: unexpected jsonpath '$jpath' in: $*" >&2; exit 64 ;;
esac
case "$kind:$key" in
  deployment:IMAGE)        printf '%s' "\${STUB_API_IMAGE-}" ;;
  statefulset:IMAGE)       printf '%s' "\${STUB_WORKER_IMAGE-}" ;;
  deployment:COMMIT)       printf '%s' "\${STUB_API_COMMIT-}" ;;
  statefulset:COMMIT)      printf '%s' "\${STUB_WORKER_COMMIT-}" ;;
  statefulset:STS_CURRENT) printf '%s' "\${STUB_STS_CURRENT-}" ;;
  statefulset:STS_UPDATE)  printf '%s' "\${STUB_STS_UPDATE-}" ;;
  *) echo "kubectl stub: unsupported read $kind/$key" >&2; exit 64 ;;
esac
`;

const binDir = join(workDir, "bin");
execFileSync("mkdir", ["-p", binDir]);
const kubectlPath = join(binDir, "kubectl");
writeFileSync(kubectlPath, kubectlStub);
chmodSync(kubectlPath, 0o755);

// Same options the real step runs under (docker.yml `deploy` sets these).
const harnessPath = join(workDir, "gate.sh");
writeFileSync(harnessPath, `set -euo pipefail\n${gate}\n`);

/**
 * Run the extracted gate against one recorded cluster state.
 * @returns {{status: number, stdout: string, stderr: string}}
 */
function runGate(state) {
  const result = execFileSync(
    "bash",
    [harnessPath],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        NS: "paperclip",
        DIGEST,
        COMMIT,
        STUB_API_IMAGE: state.apiImage ?? EXPECTED_IMAGE,
        STUB_WORKER_IMAGE: state.workerImage ?? EXPECTED_IMAGE,
        STUB_API_COMMIT: state.apiCommit ?? COMMIT,
        STUB_WORKER_COMMIT: state.workerCommit ?? COMMIT,
        STUB_STS_CURRENT: state.stsCurrent ?? REVISION,
        STUB_STS_UPDATE: state.stsUpdate ?? REVISION,
      },
      // Capture rather than throw so the negative cases can assert on output.
      stdio: ["ignore", "pipe", "pipe"],
    },
    // execFileSync throws on non-zero; wrapped by the caller below.
  );
  return { status: 0, stdout: result, stderr: "" };
}

function runGateExpectingFailure(state) {
  try {
    const ok = runGate(state);
    return { status: 0, stdout: ok.stdout, stderr: ok.stderr };
  } catch (err) {
    return {
      status: err.status ?? -1,
      stdout: String(err.stdout ?? ""),
      stderr: String(err.stderr ?? ""),
    };
  }
}

test("converged deploy passes the gate", () => {
  const { status, stdout } = runGate({});
  assert.equal(status, 0);
  assert.match(stdout, /Two-tier convergence OK/);
  assert.match(stdout, new RegExp(DIGEST.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("BLO-28920 state fails: api rolled, worker stale and unstamped", () => {
  // The exact production split this gate exists to catch. Before it, this state
  // produced a green deploy job.
  const { status, stderr } = runGateExpectingFailure({
    workerImage: STALE_IMAGE,
    workerCommit: "",
  });
  assert.equal(status, 1, "a partial roll must fail the deploy");
  assert.match(stderr, /Two-tier convergence check FAILED \(BLO-29008\)/);
  assert.match(stderr, /worker image {2}.*39a40bdb/);
  assert.match(stderr, /worker commit <unstamped>/);
});

test("worker image mismatch alone fails", () => {
  const { status, stderr } = runGateExpectingFailure({ workerImage: STALE_IMAGE });
  assert.equal(status, 1);
  assert.match(stderr, /worker image/);
});

test("worker commit unstamped alone fails", () => {
  const { status, stderr } = runGateExpectingFailure({ workerCommit: "" });
  assert.equal(status, 1);
  assert.match(stderr, /worker commit <unstamped>/);
});

test("worker commit stale-but-present alone fails", () => {
  const { status, stderr } = runGateExpectingFailure({ workerCommit: STALE_COMMIT });
  assert.equal(status, 1);
  assert.match(stderr, new RegExp(`worker commit ${STALE_COMMIT}`));
});

test("reverse split fails: worker rolled, api stale (BLO-21492 shape)", () => {
  const { status, stderr } = runGateExpectingFailure({
    apiImage: STALE_IMAGE,
    apiCommit: STALE_COMMIT,
  });
  assert.equal(status, 1);
  assert.match(stderr, /api image/);
  assert.match(stderr, /api commit/);
});

test("unsettled worker revision fails even when both tiers read converged", () => {
  const { status, stderr } = runGateExpectingFailure({ stsUpdate: "paperclip-685988f646" });
  assert.equal(status, 1);
  assert.match(stderr, /worker revision unsettled/);
});

test("converged-but-stale pair fails: both tiers agree on the wrong build", () => {
  // A bare `api == worker` equality check would pass this. Anchoring to the
  // expected digest is what makes it fail.
  const { status, stderr } = runGateExpectingFailure({
    apiImage: STALE_IMAGE,
    workerImage: STALE_IMAGE,
    apiCommit: STALE_COMMIT,
    workerCommit: STALE_COMMIT,
  });
  assert.equal(status, 1);
  assert.match(stderr, /api image/);
  assert.match(stderr, /worker image/);
});

test("every failing condition is reported, not just the first", () => {
  // Guards the `tier_failures` string accumulation and the `$'\n'` separator --
  // the specific mechanism whose breakage would make the gate fail open.
  const { status, stderr } = runGateExpectingFailure({
    apiImage: STALE_IMAGE,
    workerImage: STALE_IMAGE,
    apiCommit: STALE_COMMIT,
    workerCommit: "",
    stsUpdate: "paperclip-685988f646",
  });
  assert.equal(status, 1);
  for (const expected of [
    /^ {2}api image {5}/m,
    /^ {2}worker image {2}/m,
    /^ {2}api commit {4}/m,
    /^ {2}worker commit /m,
    /^ {2}worker revision unsettled: /m,
  ]) {
    assert.match(stderr, expected);
  }
  // One line per condition: proves the separator is a real newline, not a
  // literal backslash-n or a swallowed append.
  const detailLines = stderr
    .split("\n")
    .filter((line) => /^ {2}(api|worker) /.test(line) && line.includes("!="));
  assert.equal(detailLines.length, 5, `expected 5 detail lines, got:\n${stderr}`);
});

test("the deploy job waits on both tiers before asserting convergence", () => {
  // The gate reads `.spec`, which is set the instant Helm applies. Without a
  // rollout wait on the worker it would pass while the worker pod was still
  // the old one, so the wait is part of the assertion, not decoration.
  const deployStart = workflow.indexOf("\n  deploy:\n");
  assert.notEqual(deployStart, -1);
  const job = workflow.slice(deployStart);
  // The workflow derives the Deployment name from the approved rendered plan;
  // keep this assertion coupled to that variable rather than a stale chart
  // name so a legitimate release-name override does not fail the policy gate.
  const apiWait = job.indexOf('rollout status "deployment/${api_deployment}"');
  const workerWait = job.indexOf("rollout status statefulset/paperclip");
  const gateStart = job.indexOf("# BLO-29008: two-tier convergence gate.");

  assert.ok(apiWait > 0, "deploy job must wait on the api rollout");
  assert.ok(workerWait > 0, "deploy job must wait on the worker rollout");
  assert.ok(gateStart > workerWait, "convergence gate must run after the worker rollout wait");
});
