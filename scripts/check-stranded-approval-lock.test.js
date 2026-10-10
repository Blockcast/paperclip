// BLO-41774. The stranded-lock checker is a detector, and a detector that only
// ever says one thing has not been shown to discriminate. Every verdict it can
// reach is exercised here against a stubbed cluster, in both directions:
//
//   clean    - no lock at all, and a lock whose rollout genuinely completed
//   landing  - a rollout still rolling, and a settled one inside the deploy window
//   stranded - the BLO-31598 shape (helm never ran), the BLO-41478 shape (moved
//              onto a different pod plan), the provisional-lock shape, and the
//              server-plan-drift shape that the first production run found
//
// The script derives every predicate and constant from the shipping approval
// script rather than restating them, so the lifting seams are mutation-tested
// too: each is broken on a copy and the script must refuse to conclude. A
// detector that silently degrades to "clean" when it cannot read its own
// predicate is worse than no detector, and that is the failure direction a
// presence-only assertion would miss.
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const checkerPath = path.join(repoRoot, "scripts/check-stranded-approval-lock.sh");
const approvePath = path.join(repoRoot, "scripts/approve-paperclip-api-digest.sh");
const approveScript = readFileSync(approvePath, "utf8");
const workflowPath = path.join(repoRoot, ".github/workflows/docker.yml");

// Read out of the shipping script, never restated: a renamed annotation that
// left these literals behind would make every fixture below exercise a lock
// shape the real script no longer writes.
function shellConst(name) {
  const m = approveScript.match(new RegExp(`^${name}="([^"$]*)"$`, "m"));
  assert.ok(m, `could not read ${name} out of ${approvePath}`);
  return m[1];
}

const IMAGE_REPOSITORY = shellConst("IMAGE_REPOSITORY");
const A = {
  digest: shellConst("LOCK_DIGEST_ANNOTATION"),
  plan: shellConst("LOCK_PLAN_ANNOTATION"),
  uid: shellConst("LOCK_UID_ANNOTATION"),
  generation: shellConst("LOCK_GENERATION_ANNOTATION"),
  marker: shellConst("LOCK_MARKER_ANNOTATION"),
  serverPlan: shellConst("LOCK_SERVER_PLAN_ANNOTATION"),
  owner: shellConst("LOCK_OWNER_ANNOTATION"),
  rolloutMarker: shellConst("ROLLOUT_MARKER_ANNOTATION"),
};

const DIGEST = `sha256:${"c1".repeat(32)}`;
const OTHER_DIGEST = `sha256:${"d2".repeat(32)}`;
const OWNER = "a1".repeat(32);
const MARKER = "e3".repeat(32);
const OTHER_MARKER = "f4".repeat(32);
const UID = "9fb4475f-9b2d-47f2-ac8a-ba16cd6ed3f0";

function minutesAgo(minutes) {
  return new Date(Date.now() - minutes * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function deployment({
  digest = DIGEST,
  marker = MARKER,
  generation = 595,
  uid = UID,
  replicas = 2,
  ready = 2,
  updated = 2,
  observedGeneration = 595,
} = {}) {
  return {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name: "paperclip-api", namespace: "paperclip", uid, generation },
    spec: {
      replicas,
      template: {
        metadata: { labels: { "app.kubernetes.io/name": "paperclip" }, annotations: { [A.rolloutMarker]: marker } },
        spec: { containers: [{ name: "paperclip", image: `${IMAGE_REPOSITORY}@${digest}` }] },
      },
    },
    status: {
      observedGeneration,
      updatedReplicas: updated,
      readyReplicas: ready,
      availableReplicas: ready,
      unavailableReplicas: replicas - ready,
    },
  };
}

function configmap(lock) {
  const annotations = {};
  if (lock) {
    annotations[A.digest] = lock.digest ?? DIGEST;
    annotations[A.plan] = lock.plan ?? "b5".repeat(32);
    annotations[A.uid] = lock.uid ?? UID;
    annotations[A.generation] = String(lock.generation ?? 590);
    annotations[A.marker] = lock.marker ?? MARKER;
    annotations[A.serverPlan] = lock.serverPlan ?? "";
    annotations[A.owner] = lock.owner ?? OWNER;
  }
  return {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: {
      name: "paperclip-api-approved-images",
      namespace: "paperclip-release-approvals",
      annotations,
      managedFields: [
        { manager: "kubectl-create", operation: "Update", time: "2026-08-03T21:22:23Z" },
        { manager: "kubectl-replace", operation: "Update", time: lock?.writtenAt ?? minutesAgo(300) },
      ],
    },
    data: { approvedDigests: DIGEST },
  };
}

// The approver's own canonical projection, computed the way the script computes
// it rather than hard-coded, so a "clean" fixture stays clean if that projection
// ever changes shape.
//
// The hashing form here must be the APPROVAL SCRIPT's -- `printf '%s' "$(jq ...)"`,
// no trailing newline -- because the approval script is what writes the hash the
// lock stores. Minting the fixture with the checker's own form instead makes the
// fixture and the checker agree with each other while both disagree with
// production: that is how BLO-42073 shipped a `server_plan_match` arm that was
// constant false, with all 19 tests green. If the checker reverts to piping jq
// into sha256sum, the "satisfiable lock" case below must fail.
function canonicalHash(deploymentJson) {
  const run = spawnSync(
    "bash",
    [
      "-c",
      'canon="$(sed -n "/^# BEGIN CANONICAL_DEPLOYMENT_JQ$/,/^# END CANONICAL_DEPLOYMENT_JQ$/p" "$1" | sed "1d;\\$d")"; ' +
        'printf "%s" "$(jq -cS "$canon" "$2")" | sha256sum | awk "{print \\$1}"',
      "bash",
      approvePath,
      deploymentJson,
    ],
    { encoding: "utf8" },
  );
  assert.equal(run.status, 0, `canonical hash helper failed: ${run.stderr}`);
  return run.stdout.trim();
}

// kubectl is stubbed rather than mocked at a seam inside the script: the two
// `get` calls, their flags, and the namespaces they target are part of what is
// under test. A stub that answered regardless of arguments would let a checker
// reading the wrong object pass.
function runChecker({ cm, deploy, deployReadFails = false, env = {}, approveScriptOverride } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "stranded-lock-"));
  const cmPath = path.join(dir, "cm.json");
  const deployPath = path.join(dir, "deploy.json");
  writeFileSync(cmPath, JSON.stringify(cm, null, 2));
  writeFileSync(deployPath, JSON.stringify(deploy ?? deployment(), null, 2));

  const binDir = path.join(dir, "bin");
  spawnSync("mkdir", ["-p", binDir]);
  const stub = `#!/usr/bin/env bash
for arg in "$@"; do
  case "$arg" in
    configmap) exec cat ${JSON.stringify(cmPath)} ;;
    deployment)
      ${deployReadFails ? 'echo "Error from server (Forbidden): deployments.apps is forbidden" >&2; exit 1' : `exec cat ${JSON.stringify(deployPath)}`} ;;
  esac
done
echo "unexpected kubectl invocation: $*" >&2
exit 64
`;
  const stubPath = path.join(binDir, "kubectl");
  writeFileSync(stubPath, stub);
  chmodSync(stubPath, 0o755);

  return {
    dir,
    deployPath,
    ...spawnSync("bash", [checkerPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        ...(approveScriptOverride ? { PAPERCLIP_APPROVE_SCRIPT: approveScriptOverride } : {}),
        ...env,
      },
    }),
  };
}

function field(stdout, name) {
  const m = stdout.match(new RegExp(`^${name}\\s*=\\s*(\\S+)`, "m"));
  assert.ok(m, `checker output has no ${name} line:\n${stdout}`);
  return m[1];
}

test("no in-flight lock reports clean", () => {
  const run = runChecker({ cm: configmap(null) });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /verdict=clean/);
  assert.match(run.stdout, /No in-flight approval lock/);
});

// The post-release steady state the acceptance criteria call for: a live lock is
// by design here, and the next approval retires it on its own.
test("a lock whose rollout completed reports clean", () => {
  const deploy = deployment();
  const dir = mkdtempSync(path.join(tmpdir(), "stranded-hash-"));
  const p = path.join(dir, "d.json");
  writeFileSync(p, JSON.stringify(deploy, null, 2));
  const run = runChecker({
    cm: configmap({ generation: 590, serverPlan: canonicalHash(p) }),
    deploy,
  });
  assert.equal(run.status, 0, run.stderr + run.stdout);
  assert.equal(field(run.stdout, "rollout_complete"), "true");
  assert.equal(field(run.stdout, "server_plan_match"), "true");
  assert.match(run.stdout, /verdict=clean/);
});

test("a rollout still in flight reports landing, not stranded", () => {
  const run = runChecker({
    cm: configmap({ generation: 590, writtenAt: minutesAgo(600) }),
    // Replicas updated but not yet ready: mid-roll, however old the lock is.
    deploy: deployment({ ready: 1, updated: 2, generation: 596, observedGeneration: 596 }),
  });
  assert.equal(run.status, 0, run.stderr + run.stdout);
  assert.equal(field(run.stdout, "serving_healthy"), "false");
  assert.match(run.stdout, /verdict=landing/);
});

// The `helm upgrade --atomic` race the issue flags: a release that lands and is
// rolled back while the deploy job still runs presents as advanced + settled +
// mismatched. Inside the deploy window that must NOT read as stranded.
test("a settled mismatch inside the deploy window reports landing", () => {
  const run = runChecker({
    cm: configmap({ generation: 590, writtenAt: minutesAgo(10) }),
    deploy: deployment({ digest: OTHER_DIGEST, marker: OTHER_MARKER, generation: 597, observedGeneration: 597 }),
  });
  assert.equal(run.status, 0, run.stderr + run.stdout);
  assert.equal(field(run.stdout, "advanced"), "true");
  assert.equal(field(run.stdout, "serving_healthy"), "true");
  assert.match(run.stdout, /verdict=landing/);
  assert.match(run.stdout, /--atomic/);
});

test("BLO-41478 shape: landed then rolled back onto a different plan", () => {
  const run = runChecker({
    cm: configmap({ generation: 590, writtenAt: minutesAgo(300) }),
    deploy: deployment({ digest: OTHER_DIGEST, marker: OTHER_MARKER, generation: 594, observedGeneration: 594 }),
  });
  assert.equal(run.status, 1);
  assert.equal(field(run.stdout, "image_match"), "false");
  assert.equal(field(run.stdout, "marker_match"), "false");
  assert.equal(field(run.stdout, "advanced"), "true");
  assert.equal(field(run.stdout, "serving_healthy"), "true");
  assert.match(run.stdout, /verdict=stranded/);
  assert.match(run.stdout, /BLO-41478 shape/);
});

test("BLO-31598 shape: helm never ran, so the Deployment never moved", () => {
  const run = runChecker({
    // Lock nonce equals the live generation: nothing has happened since.
    cm: configmap({ generation: 595, writtenAt: minutesAgo(300) }),
    deploy: deployment({ digest: OTHER_DIGEST, marker: OTHER_MARKER }),
  });
  assert.equal(run.status, 1);
  assert.equal(field(run.stdout, "advanced"), "false");
  assert.match(run.stdout, /verdict=stranded/);
  assert.match(run.stdout, /BLO-31598 shape/);
});

// Found by the first production run of this checker: every clause of
// ROLLOUT_COMPLETE_JQ passes and the lock is still unsatisfiable, because
// live_deployment_completed_digest gates on the server plan before it ever
// evaluates that predicate. Neither known shape, which is why the report names
// the failing half rather than guessing an incident.
test("server-plan drift strands a lock whose rollout is otherwise complete", () => {
  const deploy = deployment();
  const run = runChecker({
    cm: configmap({ generation: 590, serverPlan: "ab".repeat(32), writtenAt: minutesAgo(300) }),
    deploy,
  });
  assert.equal(run.status, 1);
  assert.equal(field(run.stdout, "rollout_complete"), "true");
  assert.equal(field(run.stdout, "server_plan_match"), "false");
  assert.match(run.stdout, /verdict=stranded/);
  assert.match(run.stdout, /no longer canonicalizes to the\n\s*server plan/);
});

test("a provisional lock with no server plan is stranded and says so", () => {
  const deploy = deployment();
  const run = runChecker({
    cm: configmap({ generation: 590, serverPlan: "", writtenAt: minutesAgo(300) }),
    deploy,
  });
  assert.equal(run.status, 1);
  assert.match(run.stdout, /provisional/);
});

test("the report names the digest and owner docker.yml asks for", () => {
  const run = runChecker({
    cm: configmap({ generation: 590, writtenAt: minutesAgo(300) }),
    deploy: deployment({ digest: OTHER_DIGEST, marker: OTHER_MARKER, generation: 596, observedGeneration: 596 }),
  });
  assert.equal(run.status, 1);
  assert.match(run.stdout, new RegExp(`abandon_in_flight:\\s+${DIGEST}`));
  assert.match(run.stdout, new RegExp(`abandon_in_flight_owner:\\s+${OWNER}`));
});

// An unreadable Deployment is a check that cannot conclude. Reporting clean
// there is the silent-failure direction this whole channel distrusts.
test("an unreadable Deployment fails closed rather than reporting clean", () => {
  const run = runChecker({
    cm: configmap({ generation: 590 }),
    deployReadFails: true,
  });
  assert.equal(run.status, 2);
  assert.doesNotMatch(run.stdout, /verdict=/);
  assert.match(run.stderr, /cannot read Deployment/);
});

// The grace window is only safe while it outlives the job that can hold a lock.
// docker.yml caps the deploy job; raising that cap must fail here rather than
// silently narrowing this window into the --atomic race.
test("the grace window covers the whole deploy job", () => {
  const workflow = readFileSync(workflowPath, "utf8");
  const marker = "\n  deploy:\n";
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, "docker.yml must define a deploy job");
  const remainder = workflow.slice(start + marker.length);
  const nextJob = remainder.search(/^ {2}[A-Za-z0-9_-]+:\s*$/m);
  const deployJob = nextJob === -1 ? remainder : remainder.slice(0, nextJob);
  const jobTimeout = deployJob.match(/^ {4}timeout-minutes:\s*(\d+)\s*$/m);
  assert.ok(jobTimeout, "deploy job must declare timeout-minutes");

  const checker = readFileSync(checkerPath, "utf8");
  const grace = checker.match(/PAPERCLIP_STRANDED_LOCK_GRACE_MINUTES:-(\d+)/);
  assert.ok(grace, "checker must default PAPERCLIP_STRANDED_LOCK_GRACE_MINUTES");
  assert.ok(
    Number(grace[1]) >= Number(jobTimeout[1]),
    `grace window (${grace[1]}m) must cover the deploy job timeout (${jobTimeout[1]}m), or a lock ` +
      "still held by a running deploy -- including one inside a `helm upgrade --atomic` rollback -- " +
      "reads as stranded",
  );
});

// Mutation tests for the lifting seams. Each removes one thing the checker
// lifts out of the approval script; the checker must refuse to conclude rather
// than degrade to a verdict. A presence-only assertion would miss all of these:
// every one of them leaves a script that still runs.
for (const [name, mutate] of [
  [
    "ROLLOUT_COMPLETE_JQ markers",
    (s) => s.replace("# BEGIN ROLLOUT_COMPLETE_JQ", "# BEGIN ROLLOUT_COMPLETE_JQ_RENAMED"),
  ],
  [
    "ROLLOUT_SERVING_JQ markers",
    (s) => s.replace("# BEGIN ROLLOUT_SERVING_JQ", "# BEGIN ROLLOUT_SERVING_JQ_RENAMED"),
  ],
  [
    "CANONICAL_DEPLOYMENT_JQ markers",
    (s) => s.replace("# BEGIN CANONICAL_DEPLOYMENT_JQ", "# BEGIN CANONICAL_DEPLOYMENT_JQ_RENAMED"),
  ],
  [
    "the `advanced` helper inside ROLLOUT_COMPLETE_JQ",
    (s) => s.replace("def advanced:", "def rolled_forward:"),
  ],
  [
    "the LOCK_OWNER_ANNOTATION constant",
    (s) => s.replace(/^LOCK_OWNER_ANNOTATION="[^"]*"$/m, "LOCK_OWNER_ANNOTATION=\"${SOME_VAR}\""),
  ],
]) {
  test(`refuses to conclude when ${name} cannot be lifted`, () => {
    const dir = mkdtempSync(path.join(tmpdir(), "stranded-mutate-"));
    const mutated = path.join(dir, "approve.sh");
    const before = readFileSync(approvePath, "utf8");
    const after = mutate(before);
    assert.notEqual(after, before, `mutation for ${name} matched nothing — it tests nothing`);
    writeFileSync(mutated, after);

    const run = runChecker({
      cm: configmap({ generation: 590, writtenAt: minutesAgo(300) }),
      approveScriptOverride: mutated,
    });
    assert.equal(run.status, 2, `expected exit 2, got ${run.status}:\n${run.stdout}${run.stderr}`);
    assert.doesNotMatch(run.stdout, /verdict=/);
  });
}

// A lift that SUCCEEDS but yields a program jq cannot run is a shape the cases
// above cannot catch: the markers are intact, so every lifting seam passes, and
// only jq's exit status (1 = false, 3/5 = could not evaluate) separates a false
// predicate from a broken one. Folding the two read a runtime-broken serving
// predicate as `false` and reported this BLO-41478 lock -- stranded when the
// predicate runs -- as `landing`, exit 0, with nothing on stderr.
test("refuses to conclude when a lifted predicate cannot be evaluated", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "stranded-mutate-"));
  const mutated = path.join(dir, "approve.sh");
  const before = readFileSync(approvePath, "utf8");
  const after = before.replace(
    "# BEGIN ROLLOUT_SERVING_JQ\n",
    "# BEGIN ROLLOUT_SERVING_JQ\n(null | keys | length) >= 0 and\n",
  );
  assert.notEqual(after, before, "body mutation matched nothing -- it tests nothing");
  writeFileSync(mutated, after);

  const run = runChecker({
    cm: configmap({ generation: 590, writtenAt: minutesAgo(300) }),
    deploy: deployment({ digest: OTHER_DIGEST, marker: OTHER_MARKER, generation: 594, observedGeneration: 594 }),
    approveScriptOverride: mutated,
  });
  assert.equal(run.status, 2, `expected exit 2, got ${run.status}:\n${run.stdout}${run.stderr}`);
  assert.doesNotMatch(run.stdout, /verdict=/);
  assert.match(run.stderr, /jq could not evaluate a lifted predicate/);
});

test("a missing approval script is refused, not treated as no lock", () => {
  const run = runChecker({
    cm: configmap(null),
    approveScriptOverride: "/nonexistent/approve-paperclip-api-digest.sh",
  });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /cannot read the approval script/);
});

test("the checker never mutates: it issues only `get`", () => {
  const checker = readFileSync(checkerPath, "utf8");
  const mutatingVerbs = checker.match(
    /kubectl[^\n|]*\b(replace|apply|patch|annotate|delete|create|edit|scale)\b/g,
  );
  assert.equal(
    mutatingVerbs,
    null,
    `checker must stay read-only; found: ${JSON.stringify(mutatingVerbs)}`,
  );
});
