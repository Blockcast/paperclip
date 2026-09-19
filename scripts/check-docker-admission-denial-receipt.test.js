import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const workflow = readFileSync(path.join(repoRoot, ".github/workflows/docker.yml"), "utf8");

// BLO-33027. The deploy job ends with a negative admission probe: it replays the
// live paperclip-api Deployment through `replace --dry-run=server` with one field
// changed — the container image, set to a synthetic unapproved digest — and
// expects ValidatingAdmissionPolicy/paperclip-api-image-approval to deny it. That
// denial is the only production-side evidence the policy is EVALUATED rather than
// merely installed; as of 2026-09-09 the policy had zero samples in
// apiserver_validating_admission_policy_check_total while five other policies
// reported into the same family.
//
// This file EXECUTES the step rather than reading it, for the reason
// check-docker-retire-in-flight-lock.test.js gives: #1636's review showed two
// presence-only assertions passing against mutated code. A probe whose verdict
// logic is inverted, or which treats any non-zero kubectl exit as "denied", would
// sail through a grep-based test while reporting a green receipt forever — which
// is precisely the false confidence this step exists to remove.
//
// jq is real here, so the image-substitution program is genuinely exercised.
// kubectl is stubbed, and the stub captures the manifest on stdin so the tests can
// assert what would actually reach the apiserver.

const SYNTHETIC_DIGEST = `sha256:${"deadbeef".repeat(8)}`;
const APPROVED_DIGEST = `sha256:${"a".repeat(64)}`;
const REPOSITORY = "harbor.blockcast.net/paperclip/paperclip";
const POLICY = "paperclip-api-image-approval";
const DENY_MESSAGE =
  `deployments.apps "paperclip-api" is forbidden: ValidatingAdmissionPolicy '${POLICY}' ` +
  `with binding '${POLICY}' denied request: the paperclip-api Deployment may only run an ` +
  `approved immutable digest of ${REPOSITORY}; approve the release digest via ` +
  `scripts/approve-paperclip-api-digest.sh before deploying.`;

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

// Extracted between explicit markers rather than by matching step text, so
// rewording a message cannot silently reduce this file to testing nothing: a
// missing marker throws here instead of yielding an empty script that passes.
function extractProbe() {
  const beginMarker = "# BEGIN ADMISSION_DENIAL_RECEIPT_PROBE";
  const endMarker = "# END ADMISSION_DENIAL_RECEIPT_PROBE";
  const start = workflow.indexOf(beginMarker);
  assert.notEqual(start, -1, `could not locate ${beginMarker} in docker.yml`);
  const end = workflow.indexOf(endMarker, start);
  assert.notEqual(end, -1, `could not locate ${endMarker} in docker.yml`);

  const body = workflow
    .slice(start + beginMarker.length, end)
    .split("\n")
    .map((line) => (line.startsWith(" ".repeat(10)) ? line.slice(10) : line))
    .join("\n");

  // The two decisions that make the step worth having. If either string stops
  // appearing, the extraction is no longer covering the verdict logic.
  assert.match(body, /verdict=denied-by-policy/, "extracted body lost its deny verdict");
  assert.match(body, /exit 1/, "extracted body lost its failure path");
  return body;
}

const probeScript = extractProbe();

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function liveDeployment(generation) {
  return JSON.stringify({
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: {
      name: "paperclip-api",
      namespace: "paperclip",
      generation,
      resourceVersion: "436717285",
      uid: "9fb4475f-9b2d-47f2-ac8a-ba16cd6ed3f0",
      // Present so the tests can prove the probe does not strip it and does not
      // set the reserved bootstrap canary the policy's first validation rejects.
      annotations: { "paperclip.blockcast.net/approval-plan-sha256": "cd5a3f82" },
      managedFields: [{ manager: "helm", operation: "Update" }],
    },
    spec: {
      replicas: 2,
      // Immutable. The probe must preserve it byte-for-byte or the apiserver
      // rejects on "field is immutable" and the denial loses its attribution.
      selector: { matchLabels: { "app.kubernetes.io/name": "paperclip-api" } },
      template: {
        metadata: { labels: { "app.kubernetes.io/name": "paperclip-api" } },
        spec: {
          containers: [
            {
              name: "paperclip",
              image: `${REPOSITORY}@${APPROVED_DIGEST}`,
              // Stands in for the ~52 real entries. Its presence in the captured
              // manifest is fine; its presence in the STEP LOG would not be.
              env: [{ name: "PAPERCLIP_DB_URL", value: "postgres://secret" }],
            },
          ],
        },
      },
    },
    status: { availableReplicas: 2, observedGeneration: generation },
  });
}

// `replace` outcomes, keyed by attempt number so retry behaviour is testable.
// Each entry is [exitCode, stderr].
const OUTCOMES = {
  deny: () => [1, `Error from server (Forbidden): ${DENY_MESSAGE}`],
  admit: () => [0, ""],
  otherPolicy: () => [
    1,
    "Error from server (Forbidden): deployments.apps \"paperclip-api\" is forbidden: " +
      "ValidatingAdmissionPolicy 'bc-protected-secret-write' with binding " +
      "'bc-protected-secret-write' denied request: protected write refused.",
  ],
  // The policy did not deny, so the request reached the storage layer. Names the
  // policy nowhere, so it must not be credited as a receipt.
  conflict: () => [
    1,
    'Operation cannot be fulfilled on deployments.apps "paperclip-api": the object ' +
      "has been modified; please apply your changes to the latest version and try again",
  ],
  unreachable: () => [1, "Unable to connect to the server: dial tcp: i/o timeout"],
  // Names the policy but omits the message fragment: a denial from the same
  // policy's OTHER validation (the bootstrap canary). Must not be credited.
  policyNameOnly: () => [
    1,
    `Error from server (Forbidden): deployments.apps "paperclip-api" is forbidden: ` +
      `ValidatingAdmissionPolicy '${POLICY}' with binding '${POLICY}' denied request: ` +
      "the reserved paperclip image-approval bootstrap canary annotation must not be set.",
  ],
};

function runProbe({
  replaceOutcomes = ["deny"],
  generationBefore = "577",
  generationAfter = "577",
  getJsonFails = false,
} = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "admission-probe-"));
  const bin = path.join(dir, "bin");
  const capture = path.join(dir, "replace-stdin.json");
  const counter = path.join(dir, "attempt");
  spawnSync("mkdir", ["-p", bin]);

  // Outcome table the stub consults per attempt.
  writeFileSync(
    path.join(dir, "outcomes.txt"),
    replaceOutcomes
      .map((name) => {
        const [code, stderr] = OUTCOMES[name]();
        return `${code}\t${stderr.replace(/\t/g, " ")}`;
      })
      .join("\n") + "\n",
  );

  const kubectl = `#!/usr/bin/env bash
# Stub kubectl. Dispatches on the flags the probe actually passes.
#
# ARM ORDER IS LOAD-BEARING: \`-o jsonpath={...}\` contains the literal substring
# \`-o json\`, so a \`*"-o json"*\` arm placed first also swallows every jsonpath
# call and returns the whole Deployment. That shadowing is not a hypothetical —
# it made gen_after the full live JSON, which tripped the side-effect guard and
# failed six tests (including the receipt path) against a probe that is correct
# against real kubectl. Keep the jsonpath arm ABOVE the -o json arm.
args="$*"
case "$args" in
  *"auth whoami"*)
    echo "system:serviceaccount:paperclip:paperclip-ci-deploy"; exit 0 ;;
  *"auth can-i"*)
    echo "yes"; exit 0 ;;
  *"jsonpath={.metadata.generation}"*)
    printf '%s' ${JSON.stringify(generationAfter)}; exit 0 ;;
  *"get deployment paperclip-api -o json"*)
    if [ "${getJsonFails ? "1" : "0"}" = "1" ]; then
      echo "Unable to connect to the server: dial tcp: i/o timeout" >&2
      exit 1
    fi
    cat ${JSON.stringify(path.join(dir, "live.json"))}
    exit 0 ;;
  *"replace --dry-run=server"*)
    n=0
    [ -f ${JSON.stringify(counter)} ] && n="$(cat ${JSON.stringify(counter)})"
    n=$((n + 1))
    printf '%s' "$n" > ${JSON.stringify(counter)}
    cat > ${JSON.stringify(capture)}
    line="$(sed -n "\${n}p" ${JSON.stringify(path.join(dir, "outcomes.txt"))})"
    if [ -z "$line" ]; then
      line="$(tail -1 ${JSON.stringify(path.join(dir, "outcomes.txt"))})"
    fi
    code="\${line%%$'\\t'*}"
    msg="\${line#*$'\\t'}"
    [ -n "$msg" ] && printf '%s\\n' "$msg" >&2
    exit "$code" ;;
esac
echo "stub kubectl: unhandled args: $args" >&2
exit 64
`;

  writeFileSync(path.join(dir, "live.json"), liveDeployment(Number(generationBefore)));
  writeFileSync(path.join(bin, "kubectl"), kubectl);
  chmodSync(path.join(bin, "kubectl"), 0o755);

  const summary = path.join(dir, "summary.md");
  const result = spawnSync("bash", ["-c", probeScript], {
    encoding: "utf8",
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      NS: "paperclip",
      GITHUB_STEP_SUMMARY: summary,
      HOME: dir,
    },
  });

  return {
    ...result,
    output: `${result.stdout || ""}${result.stderr || ""}`,
    summary: existsSync(summary) ? readFileSync(summary, "utf8") : "",
    captured: existsSync(capture) ? readFileSync(capture, "utf8") : "",
    attempts: existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0,
  };
}

// ---------------------------------------------------------------------------
// The receipt path
// ---------------------------------------------------------------------------

test("a policy denial naming both required strings is a captured receipt and passes", () => {
  const r = runProbe({ replaceOutcomes: ["deny"] });
  assert.equal(r.status, 0, `expected pass, got ${r.status}\n${r.output}`);
  assert.match(r.output, /verdict: denied-by-policy/);
  assert.match(r.output, /Denial receipt captured/);
  assert.doesNotMatch(r.output, /::error::/);
  // The denial text itself must reach the log and the summary verbatim: the
  // issue's verifying signal is the operator reading it, not our paraphrase.
  assert.match(r.output, /approved immutable digest/);
  assert.match(r.summary, /Admission denial receipt \(BLO-33027\)/);
  assert.match(r.summary, /approved immutable digest/);
});

test("the probe changes the image and nothing else", () => {
  const r = runProbe({ replaceOutcomes: ["deny"] });
  const sent = JSON.parse(r.captured);
  const live = JSON.parse(liveDeployment(577));

  assert.deepEqual(
    sent.spec.template.spec.containers.map((c) => c.image),
    [`${REPOSITORY}@${SYNTHETIC_DIGEST}`],
    "the probe must carry the synthetic unapproved digest",
  );
  // Immutable field preserved => the image validation is the only rule that can
  // reject this. A hand-rolled skeleton would trip "field is immutable" instead
  // and produce a denial from the wrong source, which the attribution check
  // would then (correctly) refuse to credit.
  assert.deepEqual(sent.spec.selector, live.spec.selector);
  assert.equal(sent.metadata.name, "paperclip-api");
  assert.equal(sent.metadata.resourceVersion, live.metadata.resourceVersion);
  assert.equal(sent.spec.replicas, live.spec.replicas);
  // Reserved annotation the policy's FIRST validation rejects. If the probe ever
  // set it, every run would deny for that reason and the image validation would
  // go untested while still printing "approved immutable digest"... no: it would
  // deny with the canary message, which policyNameOnly below proves is refused.
  assert.ok(
    !("paperclip.blockcast.net/image-approval-bootstrap-canary" in
      (sent.metadata.annotations || {})),
    "probe must not set the reserved bootstrap canary annotation",
  );
  assert.equal(sent.status, undefined, "status must be stripped from a replace payload");
  assert.equal(sent.metadata.managedFields, undefined, "managedFields must be stripped");
});

test("the live Deployment's container env never reaches the step log or summary", () => {
  const r = runProbe({ replaceOutcomes: ["deny"] });
  // It is in the manifest that goes to the apiserver...
  assert.match(r.captured, /postgres:\/\/secret/);
  // ...and must not be in anything a run log or job summary renders.
  assert.doesNotMatch(r.output, /postgres:\/\/secret/, "probe leaked container env to stdout");
  assert.doesNotMatch(r.summary, /postgres:\/\/secret/, "probe leaked container env to the summary");
});

// ---------------------------------------------------------------------------
// The failure paths — each must genuinely exit non-zero
// ---------------------------------------------------------------------------

test("an ADMITTED unapproved digest fails the step", () => {
  const r = runProbe({ replaceOutcomes: ["admit"] });
  assert.equal(r.status, 1, `expected failure, got ${r.status}\n${r.output}`);
  assert.match(r.output, /verdict: admitted/);
  assert.match(r.output, /::error::/);
  assert.match(r.output, /ADMITTED an unapproved/);
});

test("a denial from a different policy fails on attribution", () => {
  const r = runProbe({ replaceOutcomes: ["otherPolicy"] });
  assert.equal(r.status, 1, `expected failure, got ${r.status}\n${r.output}`);
  assert.match(r.output, /verdict: denied-by-other-policy/);
  assert.match(r.output, /::error::/);
  assert.match(r.output, /Attribution failed/);
});

test("a denial naming the policy but WITHOUT the message fragment is not a receipt", () => {
  // Both literal strings are required, exactly as onprem-k8s's expect_deny
  // asserts. This is the same policy's bootstrap-canary validation firing, which
  // proves nothing about image approval.
  const r = runProbe({ replaceOutcomes: ["policyNameOnly"] });
  assert.equal(r.status, 1, `expected failure, got ${r.status}\n${r.output}`);
  assert.match(r.output, /verdict: denied-by-other-policy/);
  assert.doesNotMatch(r.output, /Denial receipt captured/);
});

test("a storage-layer rejection that names no policy is not a receipt", () => {
  // Retries are exhausted, so this lands inconclusive rather than being credited.
  const r = runProbe({ replaceOutcomes: ["conflict", "conflict", "conflict"] });
  assert.doesNotMatch(r.output, /Denial receipt captured/);
  assert.match(r.output, /verdict: inconclusive/);
});

test("a generation change outranks the verdict and fails, even on a good denial", () => {
  const r = runProbe({
    replaceOutcomes: ["deny"],
    generationBefore: "577",
    generationAfter: "578",
  });
  assert.equal(r.status, 1, `expected failure, got ${r.status}\n${r.output}`);
  assert.match(r.output, /::error::/);
  assert.match(r.output, /must be side-effect-free/);
  // Ordering matters: a probe that mutated production is the more serious
  // finding, so it must not be masked by a passing admission verdict.
  assert.doesNotMatch(r.output, /Denial receipt captured/);
});

// ---------------------------------------------------------------------------
// Inconclusive must warn, never fail
// ---------------------------------------------------------------------------

test("an unreachable apiserver warns and does not fail the step", () => {
  // The release has already landed by this point. An apiserver hiccup is not
  // evidence of an enforcement regression, and must not turn a good release red.
  const r = runProbe({ getJsonFails: true });
  assert.equal(r.status, 0, `expected pass, got ${r.status}\n${r.output}`);
  assert.match(r.output, /::warning::/);
  assert.match(r.output, /inconclusive/);
  assert.doesNotMatch(r.output, /::error::/);
});

test("resourceVersion contention is retried, then credited once the policy denies", () => {
  const r = runProbe({ replaceOutcomes: ["conflict", "deny"] });
  assert.equal(r.status, 0, `expected pass, got ${r.status}\n${r.output}`);
  assert.equal(r.attempts, 2, "a conflict must be re-read and re-probed, not credited");
  assert.match(r.output, /verdict: denied-by-policy/);
  assert.match(r.output, /Denial receipt captured/);
});

test("retries are bounded", () => {
  const r = runProbe({ replaceOutcomes: ["conflict", "conflict", "conflict", "conflict"] });
  assert.ok(r.attempts <= 3, `probe attempted ${r.attempts} times; must be bounded`);
  assert.equal(r.status, 0, "exhausted retries are inconclusive, not a failure");
});

// ---------------------------------------------------------------------------
// Wiring that the executed body cannot see
// ---------------------------------------------------------------------------

test("the step reports and cannot gate: continue-on-error keeps the job conclusion", () => {
  // scheduled-production-deploy.yml selects the newest run with a job named
  // `deploy` whose conclusion == "success" to decide whether production is
  // behind master. If this step could fail the JOB, a release that actually
  // landed would look undeployed and the dispatcher would re-request a human
  // production approval on every schedule tick, forever.
  const stepStart = workflow.indexOf("- name: Negative admission probe");
  assert.notEqual(stepStart, -1, "probe step not found in docker.yml");
  const nextStep = workflow.indexOf("\n      - name:", stepStart + 1);
  const step = workflow.slice(stepStart, nextStep === -1 ? undefined : nextStep);
  assert.match(step, /continue-on-error: true/, "probe must not be able to fail the deploy job");

  const dispatcher = readFileSync(
    path.join(repoRoot, ".github/workflows/scheduled-production-deploy.yml"),
    "utf8",
  );
  assert.match(
    dispatcher,
    /select\(\.name == "deploy" and \.conclusion == "success"\)/,
    "the dispatcher no longer keys on the deploy job conclusion; re-derive whether " +
      "continue-on-error is still the right call before relaxing it",
  );
});

test("the probe runs after the rollout has landed, so it cannot delay a release", () => {
  const helm = workflow.indexOf("- name: helm upgrade");
  const probe = workflow.indexOf("- name: Negative admission probe");
  const retire = workflow.indexOf("- name: Retire the in-flight approval lock");
  assert.ok(helm !== -1 && probe !== -1 && retire !== -1, "expected all three steps present");
  assert.ok(helm < probe, "probe must run after helm upgrade, not before it");
  // Ahead of the always() cleanup, which leaves the lock alone once helm ran.
  assert.ok(probe < retire, "probe must precede the in-flight lock cleanup");
});

test("the synthetic digest is well-formed, unapproved, and cannot become real", () => {
  assert.match(probeScript, new RegExp(`probe_digest="${SYNTHETIC_DIGEST}"`));
  // Well-formed against the policy's own filter, so the denial stays attributable
  // to non-approval rather than to malformed input.
  assert.match(SYNTHETIC_DIGEST, /^sha256:[0-9a-f]{64}$/);
  // Obviously synthetic: a repeated byte pattern no build can emit, so it can
  // never collide with a real release artifact nor be approved by accident.
  assert.equal(SYNTHETIC_DIGEST.slice(7), "deadbeef".repeat(8));
  // Same repository as the real artifact, so the digest is the only variable.
  assert.match(probeScript, new RegExp(`probe_repository="${REPOSITORY}"`));
});

test("the probed name is the literal the policy narrows to", () => {
  // The policy narrows via matchConditions (object.metadata.name == 'paperclip-api')
  // and the Binding again via resourceNames: [paperclip-api]. A suffixed or
  // interpolated name would fall OUTSIDE the policy and be admitted for the wrong
  // reason, which this step would then report as an enforcement failure.
  assert.match(probeScript, /probe_deployment="paperclip-api"/);
});

test("the step records the deploy identity's own capability, not an impersonated one", () => {
  // The issue's verifying signal asks for `can-i create deployments.apps`. Taken
  // from the seat that performs the probe it proves more than `--as=` from
  // elsewhere, and it re-states on every release that no grant was needed.
  assert.match(probeScript, /auth whoami/);
  assert.match(probeScript, /can-i \\?\s*\n?\s*create deployments\.apps/);
});
