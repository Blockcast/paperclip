import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const workflow = readFileSync(new URL("../../.github/workflows/pr.yml", import.meta.url), "utf8");

test("PR verification runs for merge-queue heads with event-appropriate diff SHAs", () => {
  assert.match(workflow, /\n  merge_group:\n    types:\n      - checks_requested\n/);
  assert.match(
    workflow,
    /PR_BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \|\| github\.event\.merge_group\.base_sha \}\}/,
  );
  assert.match(
    workflow,
    /PR_HEAD_SHA: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.event\.merge_group\.head_sha \}\}/,
  );
  assert.match(
    workflow,
    /if: >-\n          github\.event_name == 'pull_request' &&\n          github\.head_ref != 'chore\/refresh-lockfile'/,
    "merge-group runs must not re-evaluate PR-only lockfile exemptions without author/branch metadata",
  );
  assert.match(workflow, /\n  verify:\n/);
  assert.match(
    workflow,
    /\n  verify:\n(?:    [^\n]*\n)*?    if: \$\{\{ always\(\) && !cancelled\(\) \}\}\n/,
    "a cancelled workflow must not materialize verify and retain the merge-group concurrency lock",
  );
});

// BLO-20867: extract the actual `run:` shell script from the `verify` job's
// "Fail if any split verify lane failed" step so this test exercises the real
// script, not a re-implementation of it.
function getVerifyLaneScript() {
  const stepMarker = "\n      - name: Fail if any split verify lane failed\n";
  const stepStart = workflow.indexOf(stepMarker);
  assert.notEqual(stepStart, -1, "pr.yml must define the verify lane-outcome step");

  const runMarker = "\n        run: |\n";
  const runStart = workflow.indexOf(runMarker, stepStart);
  assert.notEqual(runStart, -1, "verify lane-outcome step must use a `run: |` block");

  const remainder = workflow.slice(runStart + runMarker.length);
  const lines = remainder.split("\n");
  const scriptLines = [];
  for (const line of lines) {
    if (line !== "" && !line.startsWith("          ")) break;
    scriptLines.push(line.slice(10));
  }
  return scriptLines.join("\n");
}

function laneEnv(results) {
  return {
    // BLO-28999: the set of failed lanes the classify step proved were killed
    // mid-job by the runner pool. Empty unless a scenario opts in, so every
    // pre-existing scenario keeps exercising the plain failure path.
    INFRA_LANES: results.INFRA_LANES ?? "",
    HELM_CHART_RESULT: results.helm_chart ?? "success",
    TYPECHECK_RELEASE_REGISTRY_RESULT: results.typecheck_release_registry ?? "success",
    GENERAL_TESTS_RESULT: results.general_tests ?? "success",
    WORKTREE_INSTALL_RESULT: results.worktree_install ?? "success",
    OPENCODE_RESPONSES_REPLAY_RESULT: results.opencode_responses_replay ?? "success",
    OPENCODE_K8S_SEED_COLD_START_RESULT: results.opencode_k8s_seed_cold_start ?? "success",
    BUILD_RESULT: results.build ?? "success",
    VENDOR_CLAUDE_K8S_RESULT: results.vendor_claude_k8s ?? "success",
  };
}

function runVerifyStep(results) {
  const script = getVerifyLaneScript();
  const env = { ...process.env, ...laneEnv(results) };
  return spawnSync("bash", ["-c", script], { env, encoding: "utf8" });
}

// BLO-17980: adding a lane to the `verify` job's lane list without also giving
// it a default here leaves its env var unset. The script's `case` treats an
// empty result as `*)` — a failure — so EVERY scenario in this file, including
// "every lane succeeds", starts emitting a spurious lane-failure annotation.
// That is exactly how the `vendor_claude_k8s` lane broke this suite.
//
// The workflow moved from an associative `declare -A lane_results` to two
// PARALLEL indexed arrays (`lane_names` + `lane_results`) for portability, so
// this now also asserts the two stay the same length and in the same order.
// That pairing is load-bearing and silent when wrong: the script indexes
// `lane_results[$i]` by `lane_names` position, so a single insertion into one
// array shifts every later lane onto the wrong result and misreports which lane
// failed — with no syntax error to catch it.
test("every lane in the workflow's lane list is paired and has a test default", () => {
  const script = getVerifyLaneScript();
  const readArray = (name) => {
    const start = script.indexOf(`${name}=(`);
    assert.notEqual(start, -1, `could not find ${name} in pr.yml`);
    return script
      .slice(start + `${name}=(`.length, script.indexOf(")", start))
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  };

  const laneNames = readArray("lane_names");
  const laneResults = readArray("lane_results");
  assert.ok(laneNames.length > 0, "could not parse lane_names out of pr.yml");
  assert.equal(
    laneNames.length,
    laneResults.length,
    `lane_names (${laneNames.length}) and lane_results (${laneResults.length}) must stay the ` +
      `same length — the script pairs them by index, so a mismatch silently reports the wrong lane`,
  );

  const defaults = laneEnv({});
  for (const [i, lane] of laneNames.entries()) {
    const envVar = laneResults[i].replace(/^"\$/, "").replace(/"$/, "");
    assert.equal(
      envVar,
      `${lane.toUpperCase()}_RESULT`,
      `lane_names[${i}] is '${lane}' but lane_results[${i}] reads $${envVar} — the arrays are ` +
        `out of order, so this lane's outcome would be read from a different lane's result`,
    );
    assert.ok(
      envVar in defaults,
      `lane '${lane}' reads $${envVar} in pr.yml but laneEnv() sets no default for it — ` +
        `add '${lane}' to laneEnv() or these tests will report it as a failed lane`,
    );
  }
});

test("verify step passes when every lane succeeds", () => {
  const result = runVerifyStep({});
  assert.equal(result.status, 0);
});

for (const [lane, laneLabel] of [
  ["opencode_responses_replay", "OpenCode Responses replay"],
  ["opencode_k8s_seed_cold_start", "k8s-ro seed transport cold start"],
]) {
  for (const [laneResult, annotation] of [
    ["failure", "failure"],
    ["skipped", "skipped"],
    ["cancelled", "cancelled"],
  ]) {
    test(`verify step rejects a ${laneLabel} ${laneResult}`, () => {
      const result = runVerifyStep({ [lane]: laneResult });
      assert.notEqual(result.status, 0);
      assert.match(
        result.stdout,
        new RegExp(`::error title=verify: lane ${annotation}::`),
      );
      assert.match(result.stdout, new RegExp(lane));
    });
  }
}

test("verify step exits non-zero and annotates a cancelled lane without asserting a specific cause", () => {
  const result = runVerifyStep({ general_tests: "cancelled" });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /::error title=verify: lane cancelled::/);
  assert.match(result.stdout, /general_tests/);
  // The annotation must not claim the cancellation IS infrastructure — only
  // that it's a possible cause. A manual cancel or another source is also
  // possible, and this job cannot tell them apart from here (gstack review,
  // BLO-20867 PR #964).
  assert.doesNotMatch(result.stdout, /This is a CI infrastructure interruption/);
  assert.doesNotMatch(result.stdout, /::error title=verify: lane failure::/);
  assert.doesNotMatch(result.stdout, /::error title=verify: lane skipped::/);
});

test("verify step exits non-zero and annotates a real lane failure distinctly from a cancellation", () => {
  const result = runVerifyStep({ build: "failure" });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /::error title=verify: lane failure::/);
  assert.match(result.stdout, /build/);
  assert.doesNotMatch(result.stdout, /::error title=verify: lane cancelled::/);
});

test("verify step treats Helm chart failure as a required lane failure", () => {
  const result = runVerifyStep({ helm_chart: "failure" });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /::error title=verify: lane failure::/);
  assert.match(result.stdout, /helm_chart/);
});

test("verify step annotates both a real failure and a cancellation when a run has both", () => {
  const result = runVerifyStep({ build: "failure", general_tests: "cancelled" });
  assert.notEqual(result.status, 0);
  // BLO-20867 AC-3 / PR #964 review: a cancelled lane must never be hidden
  // behind a failed one — both are real, distinct outcomes and each gets its
  // own annotation so the cancellation isn't misattributed to the diff.
  assert.match(result.stdout, /::error title=verify: lane failure::/);
  assert.match(result.stdout, /build/);
  assert.match(result.stdout, /::error title=verify: lane cancelled::/);
  assert.match(result.stdout, /general_tests/);
});

test("verify step annotates a skipped lane as an unmet dependency, not a failure", () => {
  const result = runVerifyStep({ worktree_install: "skipped" });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /::error title=verify: lane skipped::/);
  assert.match(result.stdout, /worktree_install/);
  assert.match(result.stdout, /policy/);
  assert.doesNotMatch(result.stdout, /::error title=verify: lane failure::/);
});

test("verify step annotates both a skipped and a cancelled lane when a run has both", () => {
  const result = runVerifyStep({ worktree_install: "skipped", general_tests: "cancelled" });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /::error title=verify: lane skipped::/);
  assert.match(result.stdout, /::error title=verify: lane cancelled::/);
});

test("verify step annotates both a real failure and a skipped lane when a run has both", () => {
  const result = runVerifyStep({ build: "failure", worktree_install: "skipped" });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /::error title=verify: lane failure::/);
  assert.match(result.stdout, /::error title=verify: lane skipped::/);
});

test("verify step exits non-zero for an unrecognized result and treats it as a failure", () => {
  const result = runVerifyStep({ general_tests: "timed_out" });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /::error title=verify: lane failure::/);
  assert.match(result.stdout, /general_tests/);
});

// ---------------------------------------------------------------------------
// BLO-28999: ARC mid-job runner kills reported as "reported failure".
//
// The fixtures below are real payload shapes captured from
// https://github.com/Blockcast/paperclip/actions/runs/32268626936 (three lanes
// killed mid-job) and from genuine failures in neighbouring runs, so these
// tests pin the classifier against what GitHub actually returns rather than an
// invented shape.
// ---------------------------------------------------------------------------

// Real shape: run 32268626936, job 96185315192 ("Build"). Killed by the ARC
// pool — note `conclusion: failure` with NOT ONE step concluding `failure`.
const KILLED_JOB = {
  id: 96185315192,
  name: "Build",
  conclusion: "failure",
  steps: [
    ...Array.from({ length: 7 }, (_, i) => ({ name: `step-${i}`, conclusion: "success" })),
    { name: "Build packages", conclusion: "cancelled" },
    ...Array.from({ length: 4 }, (_, i) => ({ name: `post-${i}`, conclusion: "skipped" })),
  ],
};
const KILLED_ANNOTATIONS = [{ annotation_level: "failure", message: "The operation was canceled." }];

// Real shape: a lane that genuinely failed — a step concluded `failure` and the
// annotation is the ordinary non-zero-exit message.
const GENUINELY_FAILED_JOB = {
  id: 96224412919,
  name: "Build",
  conclusion: "failure",
  steps: [
    { name: "Checkout repository", conclusion: "success" },
    { name: "Build packages", conclusion: "failure" },
    { name: "Post Checkout repository", conclusion: "success" },
  ],
};
const GENUINELY_FAILED_ANNOTATIONS = [
  {
    annotation_level: "warning",
    message: "Node.js 20 is deprecated. The following actions target Node.js 20...",
  },
  { annotation_level: "failure", message: "Process completed with exit code 1." },
];

test("classifier separates a killed job from a genuinely failed one", async () => {
  const { classifyJobFailure } = await import("../classify-lane-failures.mjs");

  assert.equal(
    classifyJobFailure(KILLED_JOB, KILLED_ANNOTATIONS),
    "infrastructure",
    "a job killed mid-run by the runner pool must not be reported as a diff failure",
  );
  assert.equal(
    classifyJobFailure(GENUINELY_FAILED_JOB, GENUINELY_FAILED_ANNOTATIONS),
    "reported",
    "a real step failure must keep being reported as a failure",
  );

  // Falsification guard required by BLO-28999: both fixtures conclude
  // `failure`, so a classifier reverted to conclusion-only returns the same
  // verdict for both and the first assertion above goes red. This asserts the
  // two fixtures really are indistinguishable on `conclusion` alone, so that
  // guarantee cannot quietly rot.
  assert.equal(KILLED_JOB.conclusion, GENUINELY_FAILED_JOB.conclusion);
});

test("classifier detects a runner kill from the annotation even when a step reports failure", async () => {
  const { classifyJobFailure } = await import("../classify-lane-failures.mjs");

  // On runner loss the in-flight step can be marked `failure` with its paired
  // `Post <step>` `cancelled`, so an EMPTY failing-step set reliably means an
  // abort but a non-empty one means nothing. The annotation must therefore be
  // an independent signal, not a tie-breaker consulted only when steps are
  // clean — otherwise this exact shape is misreported as a diff defect.
  const killedMidStep = {
    id: 1,
    name: "Build",
    conclusion: "failure",
    steps: [
      { name: "Build packages", conclusion: "failure" },
      { name: "Post Build packages", conclusion: "cancelled" },
    ],
  };
  assert.equal(classifyJobFailure(killedMidStep, KILLED_ANNOTATIONS), "infrastructure");
  assert.equal(classifyJobFailure(killedMidStep, GENUINELY_FAILED_ANNOTATIONS), "reported");
});

// Real shape: a lane GitHub cancelled because it blew its `timeout-minutes`.
// This is the adversarial case for both signals at once — the annotation set
// carries "The operation was canceled." (signal 1 fires) AND the in-flight step
// is left `cancelled` rather than `failure` (signal 2 fires) — yet it is a REAL
// failure: a hung or pathologically slow test in the diff.
const TIMED_OUT_JOB = {
  id: 96248631011,
  name: "Typecheck + Release Registry",
  conclusion: "failure",
  steps: [
    { name: "Checkout repository", conclusion: "success" },
    { name: "Run full test suite", conclusion: "cancelled" },
    { name: "Post Checkout repository", conclusion: "skipped" },
  ],
};
const TIMED_OUT_ANNOTATIONS = [
  {
    annotation_level: "failure",
    message:
      "The job running on runner arc-paperclip-general-s8vwz-runner-gdxtk has exceeded the maximum execution time of 40 minutes.",
  },
  { annotation_level: "failure", message: "The operation was canceled." },
];

test("classifier reports a timeout expiry as a real failure, not an infrastructure kill", async () => {
  const { classifyJobFailure } = await import("../classify-lane-failures.mjs");

  assert.equal(
    classifyJobFailure(TIMED_OUT_JOB, TIMED_OUT_ANNOTATIONS),
    "reported",
    "a `timeout-minutes` expiry is a real failure — announcing it as a pool kill would " +
      "invite re-running a hung test forever",
  );

  // Falsification: the fixture must genuinely defeat BOTH signals, so this
  // cannot pass by accident. Strip the timeout annotation and the very same job
  // classifies as infrastructure — which is exactly what the override prevents.
  const withoutTimeoutAnnotation = TIMED_OUT_ANNOTATIONS.filter(
    (annotation) => !/exceeded the maximum execution time/.test(annotation.message),
  );
  assert.equal(
    classifyJobFailure(TIMED_OUT_JOB, withoutTimeoutAnnotation),
    "infrastructure",
    "fixture no longer exercises the override — it must be indistinguishable from a kill " +
      "once the timeout annotation is removed",
  );

  // And the override must be an override, not a tie-breaker: signal 2 fires on
  // an empty failing-step set alone, so a timeout with NO runner-loss
  // annotation at all must still be reported.
  assert.equal(
    classifyJobFailure(TIMED_OUT_JOB, [TIMED_OUT_ANNOTATIONS[0]]),
    "reported",
    "the timeout override must be consulted before the step-shape signal",
  );
});

test("a timed-out lane keeps the unchanged failure wording end to end", async () => {
  const { classifyLaneFailures } = await import("../classify-lane-failures.mjs");

  const { infrastructure, reported } = classifyLaneFailures({
    lanes: ["typecheck_release_registry"],
    laneJobNames: ["Typecheck + Release Registry"],
    jobs: [TIMED_OUT_JOB],
    annotationsByJobId: { [TIMED_OUT_JOB.id]: TIMED_OUT_ANNOTATIONS },
  });
  assert.deepEqual({ infrastructure, reported }, {
    infrastructure: [],
    reported: ["typecheck_release_registry"],
  });

  // The aggregation step must then emit the ordinary failure annotation for it.
  const result = runVerifyStep({ typecheck_release_registry: "failure", INFRA_LANES: "" });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /::error title=verify: lane failure::/);
  assert.doesNotMatch(result.stdout, /::error title=verify: lane infrastructure kill::/);
});

test("classifier maps matrix lane shards onto their lane", async () => {
  const { classifyLaneFailures, jobBelongsToLane } = await import("../classify-lane-failures.mjs");

  // `general_tests` is declared `General tests (${{ matrix.group_label }})`,
  // so GitHub renders each shard with the label appended.
  assert.ok(jobBelongsToLane("General tests (workspaces-b)", "General tests"));
  assert.ok(jobBelongsToLane("Build", "Build"));
  assert.ok(!jobBelongsToLane("Build standalone packages", "Build"));

  // A lane fans out to several shards. It is only excused as infrastructure
  // when EVERY failing shard was killed — otherwise a real defect could hide
  // behind a coincidental kill in a sibling shard.
  const mixed = classifyLaneFailures({
    lanes: ["general_tests"],
    laneJobNames: ["General tests"],
    jobs: [
      { ...KILLED_JOB, id: 10, name: "General tests (workspaces-a)" },
      { ...GENUINELY_FAILED_JOB, id: 11, name: "General tests (workspaces-b)" },
    ],
    annotationsByJobId: { 10: KILLED_ANNOTATIONS, 11: GENUINELY_FAILED_ANNOTATIONS },
  });
  assert.deepEqual(mixed, { infrastructure: [], reported: ["general_tests"] });

  const allKilled = classifyLaneFailures({
    lanes: ["general_tests"],
    laneJobNames: ["General tests"],
    jobs: [
      { ...KILLED_JOB, id: 10, name: "General tests (workspaces-a)" },
      { ...KILLED_JOB, id: 11, name: "General tests (workspaces-b)" },
    ],
    annotationsByJobId: { 10: KILLED_ANNOTATIONS, 11: KILLED_ANNOTATIONS },
  });
  assert.deepEqual(allKilled, { infrastructure: ["general_tests"], reported: [] });
});

test("classifier fails safe when no job matches the lane", async () => {
  const { classifyLaneFailures } = await import("../classify-lane-failures.mjs");

  // If we cannot see why a lane failed we must NOT excuse it — an unmatched
  // lane keeps the existing failure wording.
  const result = classifyLaneFailures({
    lanes: ["build"],
    laneJobNames: ["Build"],
    jobs: [],
    annotationsByJobId: {},
  });
  assert.deepEqual(result, { infrastructure: [], reported: ["build"] });
});

test("verify step reports an infrastructure kill as not-your-diff and still fails", () => {
  const result = runVerifyStep({ build: "failure", INFRA_LANES: "build" });

  // AC-3: the gate is unchanged — this alters the explanation, not the verdict.
  assert.notEqual(result.status, 0, "an infrastructure kill must still fail verify");
  assert.match(result.stdout, /::error title=verify: lane infrastructure kill::/);
  assert.match(result.stdout, /build/);
  assert.match(result.stdout, /not a report of a defect in this PR's diff/);
  assert.match(result.stdout, /Re-run the job/);
  // AC-2 (other direction): a killed lane must not also be announced as a
  // plain failure, or the misattribution this fixes survives alongside it.
  assert.doesNotMatch(result.stdout, /::error title=verify: lane failure::/);
});

test("verify step keeps the unchanged failure wording for a genuine failure", () => {
  // Same lane, same `failure` result — only the classifier's verdict differs.
  const result = runVerifyStep({ build: "failure", INFRA_LANES: "" });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /::error title=verify: lane failure::/);
  assert.doesNotMatch(result.stdout, /::error title=verify: lane infrastructure kill::/);
});

test("verify step does not conflate a killed lane with a genuinely failed one", () => {
  const result = runVerifyStep({
    build: "failure",
    general_tests: "failure",
    INFRA_LANES: "build",
  });
  assert.notEqual(result.status, 0);

  const infraLine = result.stdout
    .split("\n")
    .find((line) => line.includes("lane infrastructure kill::"));
  const failureLine = result.stdout.split("\n").find((line) => line.includes("lane failure::"));
  assert.ok(infraLine, "the killed lane needs its own annotation");
  assert.ok(failureLine, "the genuinely failed lane needs its own annotation");
  assert.match(infraLine, /build/);
  assert.doesNotMatch(infraLine, /general_tests/);
  assert.match(failureLine, /general_tests/);
  assert.doesNotMatch(failureLine, /\bbuild\b/);
});

test("verify step ignores an unknown lane name in INFRA_LANES", () => {
  // A stale or malformed classifier output must not silently excuse a lane.
  const result = runVerifyStep({ build: "failure", INFRA_LANES: "not_a_lane" });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /::error title=verify: lane failure::/);
  assert.doesNotMatch(result.stdout, /::error title=verify: lane infrastructure kill::/);
});

// The classify step carries a THIRD parallel array mapping each lane to the
// `name:` GitHub renders for its job. That mapping is load-bearing and silent
// when wrong: a stale entry matches no job, the lane falls through to the
// fail-safe branch, and the runner-kill wording quietly stops working. Assert
// it against the job definitions in this same workflow.
test("classify step lane_job_names matches each lane job's declared name", () => {
  const stepMarker = "\n      - name: Classify failed lanes as infrastructure kills or real failures\n";
  const stepStart = workflow.indexOf(stepMarker);
  assert.notEqual(stepStart, -1, "pr.yml must define the lane classification step");

  const readArray = (name) => {
    const start = workflow.indexOf(`${name}=(`, stepStart);
    assert.notEqual(start, -1, `could not find ${name} in the classify step`);
    // Terminate on the array's own closing line, not the first `)` — lane job
    // names legitimately contain parentheses (`Worktree install (NODE_ENV=...)`).
    const end = workflow.indexOf("\n          )", start);
    assert.notEqual(end, -1, `could not find the end of ${name}`);
    return workflow
      .slice(start + `${name}=(`.length, end)
      .split("\n")
      .map((line) => line.trim().replace(/^"(.*)"$/, "$1"))
      .filter(Boolean);
  };

  const laneNames = readArray("lane_names");
  const laneJobNames = readArray("lane_job_names");
  assert.equal(
    laneNames.length,
    laneJobNames.length,
    "lane_names and lane_job_names are paired by index — a mismatch maps a lane onto the wrong job",
  );

  for (const [i, lane] of laneNames.entries()) {
    const jobBlock = workflow.slice(workflow.indexOf(`\n  ${lane}:\n`));
    const declaredName = jobBlock.match(/\n    name: (.+)\n/)?.[1]?.trim();
    assert.ok(declaredName, `could not read the declared name: for job '${lane}'`);

    // A matrix lane interpolates its shard label; the static prefix before the
    // first `${{` is what identifies the lane.
    const staticPrefix = declaredName.split("${{")[0].trim().replace(/\($/, "").trim();
    assert.equal(
      laneJobNames[i],
      staticPrefix,
      `lane '${lane}' declares name: '${declaredName}' but lane_job_names[${i}] is ` +
        `'${laneJobNames[i]}' — the classifier would match no job and silently stop ` +
        `recognizing runner kills for this lane`,
    );
  }
});

test("classifier refuses a lanes/laneJobNames length mismatch instead of misreporting", async () => {
  const { classifyLaneFailures } = await import("../classify-lane-failures.mjs");

  // Regression guard. The classify step passes only the FAILED lanes but must
  // pass their job names in lockstep. An earlier revision of that step appended
  // to `job_names` for every lane while appending to `failed` only for failed
  // ones, so `laneJobNames[index]` pointed at an unrelated lane's job. Nothing
  // errored — each lane simply matched no job and fell through to the fail-safe
  // "reported" branch, so runner-kill detection was silently dead for every
  // lane except the first. Pairing errors must be loud.
  assert.throws(
    () =>
      classifyLaneFailures({
        lanes: ["build"],
        laneJobNames: ["Helm chart", "Typecheck + Release Registry", "Build"],
        jobs: [],
        annotationsByJobId: {},
      }),
    /paired by index/,
  );
});

test("classify step builds failed lanes and their job names in lockstep", () => {
  const stepMarker =
    "\n      - name: Classify failed lanes as infrastructure kills or real failures\n";
  const step = workflow.slice(workflow.indexOf(stepMarker));
  const loop = step.slice(step.indexOf("failed=()"), step.indexOf("infra=\"\""));

  // Both appends must live in the SAME `*)` branch. If `job_names+=` sits
  // outside it, the arrays desynchronize and the classifier is silently
  // disabled (see the mismatch test above).
  const defaultBranch = loop.match(/\*\)([\s\S]*?);;/)?.[1] ?? "";
  assert.match(defaultBranch, /failed\+=\("\$\{lane_names\[\$i\]\}"\)/);
  assert.match(
    defaultBranch,
    /job_names\+=\("\$\{lane_job_names\[\$i\]\}"\)/,
    "job_names must be appended inside the failure branch so it stays paired with failed",
  );
  assert.equal(
    (loop.match(/job_names\+=/g) ?? []).length,
    1,
    "job_names must be appended exactly once, from the failure branch only",
  );
});

// ---------------------------------------------------------------------------
// The classifier's inputs, not its logic. Every failure on this path is silent
// by design — `continue-on-error: true` on the step plus `main().catch` emitting
// the empty set — so a missing token scope looks exactly like "no lanes were
// killed". These pin the wiring that makes that impossible to reintroduce.
// ---------------------------------------------------------------------------

function getVerifyJobBlock() {
  const start = workflow.indexOf("\n  verify:\n");
  assert.notEqual(start, -1, "pr.yml must define the verify job");
  // Next top-level job key (two-space indent) ends the block.
  const rest = workflow.slice(start + 1);
  const nextJob = rest.search(/\n {2}[a-z_][a-z0-9_]*:\n/);
  return nextJob === -1 ? rest : rest.slice(0, nextJob);
}

test("verify job declares the token scopes the classifier needs", () => {
  const verifyJob = getVerifyJobBlock();

  const permissions = verifyJob.match(/\n {4}permissions:\n((?: {6}[^\n]*\n)+)/)?.[1];
  assert.ok(
    permissions,
    "verify must declare a job-level `permissions:` block — pr.yml has no workflow-level " +
      "one, so under a restricted default-permissions preset every scope is `none`, the " +
      "classifier 403s, and runner-kill detection is inert while looking like it works",
  );

  // `/actions/runs/{id}/jobs` needs `actions: read`; `/check-runs/{id}/annotations`
  // needs `checks: read` — a DIFFERENT scope. `contents: read` is required
  // because a job-level block replaces rather than merges, so without it
  // actions/checkout cannot read the repo.
  for (const scope of ["contents: read", "actions: read", "checks: read"]) {
    assert.ok(
      permissions.includes(scope),
      `verify's permissions block is missing \`${scope}\``,
    );
  }
});

test("verify surfaces a degraded classifier instead of silently reporting no kills", () => {
  const verifyJob = getVerifyJobBlock();

  // stdout carries the lane list, so the diagnostic can only travel on stderr.
  // It must be captured and re-emitted as an annotation, or a 403 is
  // indistinguishable from a clean "nothing was killed".
  assert.match(
    verifyJob,
    /2>"\$classify_err"/,
    "the classify step must capture the script's stderr",
  );
  assert.match(
    verifyJob,
    /::warning title=verify: lane classifier degraded::/,
    "a degraded classifier must emit a warning annotation, not fail silently",
  );

  // The classify step needs its own bound: it runs exactly when the pool is
  // saturated, and if it hangs the job timeout kills verify before the
  // aggregation step can emit any annotation at all.
  const classifyStep = verifyJob.slice(
    verifyJob.indexOf("- name: Classify failed lanes"),
    verifyJob.indexOf("- name: Fail if any split verify lane failed"),
  );
  assert.match(classifyStep, /timeout-minutes: \d+/, "the classify step must be time-bounded");
});

// main() end-to-end. Spawns the real script with a preloaded `fetch` stub so
// argv parsing, LANE_JOB_NAMES newline splitting, pagination and the
// single-line stdout contract that `tail -n 1` depends on are all exercised.
function runClassifierMain({ argv, laneJobNames, jobs, annotations = {}, failStatus = null }) {
  const dir = mkdtempSync(join(tmpdir(), "classify-main-"));
  const preload = join(dir, "stub-fetch.mjs");
  writeFileSync(
    preload,
    `const fixture = JSON.parse(process.env.CLASSIFY_FIXTURE);
globalThis.fetch = async (url) => {
  if (fixture.failStatus) {
    return { ok: false, status: fixture.failStatus, statusText: "Forbidden", json: async () => ({}) };
  }
  const jobsMatch = String(url).match(/\\/actions\\/runs\\/\\d+\\/jobs\\?.*page=(\\d+)/);
  if (jobsMatch) {
    const page = Number(jobsMatch[1]);
    return { ok: true, status: 200, statusText: "OK", json: async () => ({ jobs: fixture.pages[page - 1] ?? [] }) };
  }
  const annMatch = String(url).match(/\\/check-runs\\/(\\d+)\\/annotations/);
  if (annMatch) {
    return { ok: true, status: 200, statusText: "OK", json: async () => fixture.annotations[annMatch[1]] ?? [] };
  }
  throw new Error("unexpected URL " + url);
};
`,
    "utf8",
  );

  const script = new URL("../classify-lane-failures.mjs", import.meta.url).pathname;
  const result = spawnSync(process.execPath, [script, ...argv], {
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_OPTIONS: `--import=${preload}`,
      GH_TOKEN: "stub-token",
      GITHUB_REPOSITORY: "Blockcast/paperclip",
      GITHUB_RUN_ID: "32309028606",
      LANE_JOB_NAMES: laneJobNames.join("\n"),
      CLASSIFY_FIXTURE: JSON.stringify({ pages: [jobs], annotations, failStatus }),
    },
  });
  rmSync(dir, { recursive: true, force: true });
  return result;
}

test("main() emits exactly one stdout line naming only the killed lanes", () => {
  const result = runClassifierMain({
    argv: ["build", "general_tests"],
    laneJobNames: ["Build", "General tests"],
    jobs: [
      { ...KILLED_JOB, id: 10, name: "Build" },
      { ...GENUINELY_FAILED_JOB, id: 11, name: "General tests (workspaces-a)" },
    ],
    annotations: { 10: KILLED_ANNOTATIONS, 11: GENUINELY_FAILED_ANNOTATIONS },
  });

  assert.equal(result.status, 0, `main() exited ${result.status}: ${result.stderr}`);
  // `tail -n 1` in pr.yml consumes this — more than one line and the step would
  // silently read the wrong value.
  assert.equal(
    result.stdout.split("\n").filter(Boolean).length,
    1,
    `stdout must be a single line, got: ${JSON.stringify(result.stdout)}`,
  );
  assert.equal(result.stdout.trim(), "build");
});

test("main() degrades to an empty verdict AND a stderr diagnostic on a 403", () => {
  const result = runClassifierMain({
    argv: ["build"],
    laneJobNames: ["Build"],
    jobs: [],
    failStatus: 403,
  });

  // The gate must not change...
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), "", "a failed classification must excuse no lane");
  // ...but it must not be silent either: this is the string the workflow turns
  // into its "classifier degraded" warning annotation.
  assert.match(result.stderr, /classify-lane-failures:/);
  assert.match(result.stderr, /403/);
});

test("main() refuses to guess when lane job names are missing", () => {
  // A lanes/laneJobNames mismatch must reach the fail-safe path rather than
  // pairing a lane against some other lane's job name.
  const result = runClassifierMain({
    argv: ["build", "general_tests"],
    laneJobNames: ["Build"],
    jobs: [{ ...KILLED_JOB, id: 10, name: "Build" }],
    annotations: { 10: KILLED_ANNOTATIONS },
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), "");
  assert.match(result.stderr, /paired by index/);
});

test("main() exits quietly with no lanes to classify", () => {
  const result = runClassifierMain({ argv: [], laneJobNames: [], jobs: [] });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), "");
});
