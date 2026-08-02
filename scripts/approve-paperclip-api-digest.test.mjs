// Behavioural tests for scripts/approve-paperclip-api-digest.sh — the exact
// script the production release workflow runs (BLO-19955).
//
// The rotation used to be inlined into .github/workflows/docker.yml, which meant
// the shipping code path had no test at all: the only coverage lived in
// Blockcast/onprem-k8s against a copy that had already drifted from it. These
// tests drive the real file with a stub `kubectl` so the ring semantics are
// pinned here, in the repo that ships them, without needing a cluster.
//
// `jq` is a hard dependency of the script itself. Locally the behavioural cases
// skip (visibly, with a reason) on a machine that lacks it; in CI they must NOT,
// because a skip and a pass are the same green tick — losing jq from the runner
// image would silently reduce this file to its one structural case while the
// policy job still reported success. Under CI a missing dependency is a failure.
// The structural cases at the bottom always run: they are what stops the
// rotation from being re-inlined into the workflow and drifting again.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const SCRIPT = new URL("./approve-paperclip-api-digest.sh", import.meta.url).pathname;
const WORKFLOW = new URL("../.github/workflows/docker.yml", import.meta.url).pathname;

function have(bin) {
  try {
    execFileSync("sh", ["-c", `command -v ${bin}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const REQUIRED_BINS = ["jq", "bash"];
const missing = REQUIRED_BINS.filter((b) => !have(b));
const skip = missing.length ? `requires ${missing.join(" + ")} on PATH` : false;

// Fail closed on CI rather than skipping into a green run.
test("behavioural prerequisites are present on CI", () => {
  if (!process.env.CI) return;
  assert.deepEqual(
    missing,
    [],
    `CI runner is missing ${missing.join(", ")}; the behavioural cases below would ` +
      "silently skip and this job would still pass. Install the dependency in the " +
      "policy job (or drop it from the script) rather than letting coverage vanish.",
  );
});

/** A 64-lowercase-hex digest, distinct per `n`. */
const digest = (n) => `sha256:${n.toString(16).padStart(64, "0")}`;
const [A, B, C, D] = [1, 2, 3, 4].map(digest);

// A stub `kubectl` covering exactly the three invocations the script makes:
//   get configmap -o json        -> the stored object
//   replace -f -                 -> optimistic-concurrency write
//   get configmap -o jsonpath=.. -> the read-back
// State lives in a JSON file so it survives across the script's retry loop.
const KUBECTL_STUB = `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
const statePath = process.env.STUB_STATE;
const state = JSON.parse(readFileSync(statePath, "utf8"));
const argv = process.argv.slice(2);

if (state.absent) {
  process.stderr.write("Error from server (NotFound): configmaps not found\\n");
  process.exit(1);
}

if (argv.includes("replace")) {
  const body = JSON.parse(readFileSync(0, "utf8"));
  // Burn a scripted conflict before accepting the write, to exercise retry.
  if (state.conflictsRemaining > 0) {
    state.conflictsRemaining -= 1;
    state.resourceVersion = String(Number(state.resourceVersion) + 1);
    writeFileSync(statePath, JSON.stringify(state));
    process.stderr.write(
      "Error from server (Conflict): the object has been modified; please apply your changes to the latest version\\n",
    );
    process.exit(1);
  }
  if (body.metadata.resourceVersion !== state.resourceVersion) {
    process.stderr.write("Error from server (Conflict): the object has been modified\\n");
    process.exit(1);
  }
  state.data = body.data;
  state.resourceVersion = String(Number(state.resourceVersion) + 1);
  // Simulate a write the apiserver accepted but that did not land as sent.
  if (state.tamperOnWrite !== undefined) state.data.approvedDigests = state.tamperOnWrite;
  writeFileSync(statePath, JSON.stringify(state));
  process.exit(0);
}

const jsonpath = argv.find((a) => a.startsWith("jsonpath="));
if (jsonpath) {
  process.stdout.write(state.data.approvedDigests ?? "");
  process.exit(0);
}

process.stdout.write(
  JSON.stringify({
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: {
      name: "paperclip-api-approved-images",
      namespace: "paperclip-release-approvals",
      resourceVersion: state.resourceVersion,
    },
    data: state.data,
  }),
);
`;

/**
 * Run the real script against a stub cluster.
 * @returns {{status:number, stdout:string, stderr:string, window:string[]}}
 */
function approve(digestArg, { current, absent = false, conflicts = 0, tamperOnWrite, env = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "paperclip-approve-"));
  const statePath = join(dir, "state.json");
  const state = {
    resourceVersion: "1",
    data: current === undefined ? {} : { approvedDigests: current },
    absent,
    conflictsRemaining: conflicts,
  };
  if (tamperOnWrite !== undefined) state.tamperOnWrite = tamperOnWrite;
  writeFileSync(statePath, JSON.stringify(state));

  const stub = join(dir, "kubectl");
  writeFileSync(stub, KUBECTL_STUB);
  chmodSync(stub, 0o755);

  const run = spawnSync("bash", [SCRIPT, digestArg], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      STUB_STATE: statePath,
      PAPERCLIP_APPROVAL_ROTATE_ATTEMPTS: "3",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const { status, stdout, stderr } = { status: run.status, stdout: run.stdout, stderr: run.stderr };

  const persisted = JSON.parse(readFileSync(statePath, "utf8")).data.approvedDigests ?? "";
  const window = persisted.split("\n").filter(Boolean);
  return { status, stdout, stderr, window };
}

test("prepends the new digest and evicts the oldest at the 3-entry bound", { skip }, () => {
  const { status, window } = approve(D, { current: [A, B, C].join("\n") });
  assert.equal(status, 0);
  assert.deepEqual(window, [D, A, B]);
});

// The window size is enforced by CEL in the admission policy, which this script
// cannot read. It used to be an override (`${PAPERCLIP_MAX_APPROVED_DIGESTS:-3}`)
// that also fed the post-write guard, so raising it moved the check that exists
// to catch exactly that: the script wrote a 4-entry ring, compared it against
// the same raised 4, and reported "Approved. 4 digest(s) in the window." while
// the policy — still bounded at 3 — answered by denying *every* rollout. A
// widened writer bound is a hard outage, never a widened policy, so a
// disagreeing value must be refused before the ring is touched.
test("refuses a window bound that disagrees with the policy, leaving the ring intact", { skip }, () => {
  const { status, stderr, window } = approve(D, {
    current: [A, B, C].join("\n"),
    env: { PAPERCLIP_MAX_APPROVED_DIGESTS: "4" },
  });
  assert.equal(status, 2, "a disagreeing bound must be refused, not honoured");
  assert.match(stderr, /disagrees with the/);
  assert.deepEqual(window, [A, B, C], "the approval ring must be untouched on refusal");
});

test("accepts a bound that agrees with the policy", { skip }, () => {
  const { status, window } = approve(D, {
    current: [A, B, C].join("\n"),
    env: { PAPERCLIP_MAX_APPROVED_DIGESTS: "3" },
  });
  assert.equal(status, 0);
  assert.deepEqual(window, [D, A, B]);
});

// The regression this file was added for. Rotating `A,A,B` used to yield
// `C,A,A` — three entries, two distinct — silently dropping B and leaving one
// usable rollback target where the window promises two.
test("collapses pre-existing duplicates instead of spending rollback slots", { skip }, () => {
  const { status, window } = approve(C, { current: [A, A, B].join("\n") });
  assert.equal(status, 0);
  assert.deepEqual(window, [C, A, B]);
  assert.equal(new Set(window).size, window.length, "window must hold distinct digests");
});

test("re-approving a digest already in the window moves it to the front", { skip }, () => {
  const { status, window } = approve(B, { current: [A, B, C].join("\n") });
  assert.equal(status, 0);
  assert.deepEqual(window, [B, A, C]);
});

test("tolerates CRLF and surrounding whitespace in the stored window", { skip }, () => {
  const { status, window } = approve(C, { current: `  ${A}  \r\n${B}\r\n` });
  assert.equal(status, 0);
  assert.deepEqual(window, [C, A, B]);
});

test("discards malformed and mixed-case entries rather than carrying them", { skip }, () => {
  const current = ["not-a-digest", A, "", `SHA256:${"A".repeat(64)}`, `sha256:${"z".repeat(64)}`].join("\n");
  const { status, window } = approve(C, { current });
  assert.equal(status, 0);
  assert.deepEqual(window, [C, A]);
});

test("seeds an empty window", { skip }, () => {
  const { status, window } = approve(A, { current: "" });
  assert.equal(status, 0);
  assert.deepEqual(window, [A]);
});

test("refuses a digest that is not lowercase sha256", { skip }, () => {
  for (const bad of [`sha256:${"A".repeat(64)}`, "sha256:abc", "harbor.example/x@sha256:" + "a".repeat(64), ""]) {
    const { status, stderr } = approve(bad, { current: "" });
    assert.equal(status, 2, `expected refusal for ${JSON.stringify(bad)}`);
    assert.match(stderr, /well-formed lowercase sha256|usage:/);
  }
});

test("fails closed when the approval ConfigMap is absent, without creating it", { skip }, () => {
  const { status, stderr } = approve(A, { current: "", absent: true });
  assert.equal(status, 1);
  assert.match(stderr, /cannot read paperclip-release-approvals\/paperclip-api-approved-images/);
  assert.match(stderr, /never creates it/);
});

test("retries a concurrent rotation instead of clobbering it", { skip }, () => {
  const { status, window, stderr } = approve(C, { current: [A, B].join("\n"), conflicts: 1 });
  assert.equal(status, 0);
  assert.match(stderr, /changed underneath us; retrying/);
  assert.deepEqual(window, [C, A, B]);
});

test("fails when the write is accepted but the digest did not persist", { skip }, () => {
  const { status, stderr } = approve(C, { current: [A, B].join("\n"), tamperOnWrite: [A, B].join("\n") });
  assert.equal(status, 1);
  assert.match(stderr, /approval did not persist/);
});

test("fails when the persisted window is wider than the policy accepts", { skip }, () => {
  const { status, stderr } = approve(C, {
    current: [A, B].join("\n"),
    tamperOnWrite: [C, A, B, D].join("\n"),
  });
  assert.equal(status, 1);
  assert.match(stderr, /over the 3 the policy accepts/);
});

// Always runs: no external tooling, and it is the guard that keeps the workflow
// and the tested script from diverging again.
test("the deploy workflow calls the script rather than re-inlining the rotation", () => {
  const workflow = readFileSync(WORKFLOW, "utf8");
  const marker = "\n      - name: Approve deploy digest at admission time\n";
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, "docker.yml must keep the admission-approval step");
  const rest = workflow.slice(start + marker.length);
  const next = rest.search(/^ {6}- name: /m);
  const step = next === -1 ? rest : rest.slice(0, next);

  assert.match(
    step,
    /"\$\{APPROVE_SCRIPT\}" "\$\{DIGEST\}"/,
    "the step must invoke the committed script",
  );
  assert.doesNotMatch(
    step,
    /kubectl .*(patch|replace) configmap|head -n "\$\{MAX_APPROVED\}"/,
    "the step must not reimplement the rotation inline",
  );

  // The bound belongs to the admission policy, so the workflow must not carry a
  // second copy of it. A value here can only ever agree (redundant) or disagree
  // (a ring the policy denies outright); the script owns it as a constant.
  // Scoped to an actual env assignment so the step may still explain *why* it
  // does not set one.
  assert.doesNotMatch(
    step,
    /^\s*PAPERCLIP_MAX_APPROVED_DIGESTS\s*:/m,
    "the workflow must not pin the approval window size; the script owns that constant",
  );

  // The approver is the higher-privilege of the two credentials this job
  // handles; on a self-hosted runner a mid-step failure must not leave it on
  // disk, so the trap has to be armed before the secret is written.
  const trapAt = step.indexOf("trap 'rm -rf");
  const writeAt = step.indexOf('printf \'%s\' "${APPROVER_KUBECONFIG}"');
  const unsetAt = step.indexOf("unset APPROVER_KUBECONFIG");
  const invokeAt = step.indexOf('"${APPROVE_SCRIPT}" "${DIGEST}"');
  assert.notEqual(trapAt, -1, "the step must install an EXIT trap for the approver credential");
  assert.notEqual(writeAt, -1, "the step must write the approver kubeconfig");
  assert.ok(trapAt < writeAt, "the EXIT trap must be armed before the credential reaches disk");
  assert.notEqual(unsetAt, -1, "the step must unset the raw approver secret after writing the kubeconfig");
  assert.notEqual(invokeAt, -1, "the step must invoke the committed script");
  assert.ok(writeAt < unsetAt, "the raw approver secret must stay available until the kubeconfig is materialized");
  assert.ok(unsetAt < invokeAt, "the raw approver secret must not be inherited by the approval script");

  // A fixed path is opened through any symlink already sitting at that name.
  // arc-deploy is a self-hosted pool, so residue from an earlier workload could
  // redirect the credential write; mktemp -d cannot open an existing entry.
  assert.match(
    step,
    /mktemp -d "\$\{RUNNER_TEMP\}\/approver\.X{6,}"/,
    "the approver credential must live under a mktemp -d directory",
  );
  assert.doesNotMatch(
    step,
    /approver_kubeconfig="\$\{?RUNNER_TEMP\}?\//,
    "the approver credential path must not be a predictable literal",
  );
});

// The approval step runs with a credential that can rewrite the live admission
// allowlist. `target_sha` is operator-supplied and, for a rollback, an arbitrary
// historical revision — so the tooling it executes must come from the workflow's
// own revision instead. Without this the credential runs whatever that commit
// contained: nothing (rollback to before the script existed) or a reverted
// implementation.
test("the approval step runs tooling from the trusted workflow revision", () => {
  const workflow = readFileSync(WORKFLOW, "utf8");

  const checkoutAt = workflow.indexOf("- name: Checkout release tooling at trusted revision");
  const preflightAt = workflow.indexOf("- name: Render and validate deploy chart");
  const approveAt = workflow.indexOf("- name: Approve deploy digest at admission time");
  const helmAt = workflow.indexOf("- name: helm upgrade");
  assert.notEqual(checkoutAt, -1, "docker.yml must check out release tooling separately");
  assert.notEqual(preflightAt, -1, "docker.yml must validate the rendered chart before approval");
  assert.notEqual(helmAt, -1, "docker.yml must still perform the Helm rollout");
  assert.ok(checkoutAt < approveAt, "the tooling checkout must precede the approval step");
  assert.ok(preflightAt < approveAt, "chart rendering must be validated before mutating the admission allowlist");
  assert.ok(approveAt < helmAt, "Helm rollout must remain after admission approval");

  const checkout = workflow.slice(checkoutAt, approveAt);
  assert.match(
    checkout,
    /ref: \$\{\{ github\.workflow_sha \}\}/,
    "release tooling must be pinned to github.workflow_sha, not the deploy target",
  );
  assert.match(
    checkout,
    /path: \.release-tooling/,
    "release tooling must land beside, not on top of, the deploy checkout",
  );
  assert.match(
    checkout,
    /actual=\$\(git -C \.release-tooling rev-parse HEAD/,
    "the resolved tooling revision must be asserted, not assumed",
  );

  // The deploy checkout is still what Helm renders — only the approval tooling
  // moves to the trusted revision.
  const approveStep = workflow.slice(approveAt);
  assert.doesNotMatch(
    approveStep.slice(0, approveStep.search(/^ {6}- name: /m) || undefined),
    /\.\/scripts\/approve-paperclip-api-digest\.sh/,
    "the approval step must not execute the script out of the deploy checkout",
  );

  const preflightStep = workflow.slice(preflightAt, approveAt);
  assert.match(
    preflightStep,
    /helm template "\$\{RELEASE\}" \.\/deploy\/helm\/paperclip/,
    "the side-effect-free preflight must render the target chart",
  );
  assert.match(
    preflightStep,
    /Chart did not render every Paperclip workload as \$\{expected_image\}/,
    "the preflight must validate rendered Paperclip images before approval",
  );

  const helmStep = workflow.slice(helmAt);
  const helmStepBody = helmStep.slice(0, helmStep.search(/^ {6}- name: /m) || undefined);
  assert.doesNotMatch(
    helmStepBody,
    /helm template "\$\{RELEASE\}" \.\/deploy\/helm\/paperclip/,
    "chart rendering must not wait until after admission approval",
  );
});
