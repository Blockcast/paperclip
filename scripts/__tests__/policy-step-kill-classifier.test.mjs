import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  classifyStepKills,
  fetchAnnotations,
  renderAnnotations,
  selectCurrentJob,
  stepElapsedSeconds,
} from "../classify-policy-step-kills.mjs";

// ---------------------------------------------------------------------------
// Banked payloads. Every fixture below is a verbatim excerpt of a real Actions
// API response, not a hand-written approximation — the whole point of this
// suite is that the classifier survives the shapes GitHub actually emits, and
// three of the four cases here contradict what a from-first-principles fixture
// would have looked like.
// ---------------------------------------------------------------------------

// Run 34154564717 attempt 1, job 101843653563, commit a759f828: a real
// step-timeout kill of `Test approval admissibility-probe backoff` under a 60s
// bound. NOTE the elapsed time — 19:18:15Z -> 19:19:28Z is SEVENTY-THREE
// seconds against that 60s budget. A detector keyed on "elapsed is within 2s of
// the budget" would score its own negative control as a pass-through.
const KILLED_STEP = {
  name: "Test approval admissibility-probe backoff (BLO-28471)",
  number: 18,
  status: "completed",
  conclusion: "failure",
  started_at: "2026-09-07T19:18:15Z",
  completed_at: "2026-09-07T19:19:28Z",
};

// The same job's annotations, in full. A killed step emits the timeout line AND
// the ordinary exit-code line, so the exit-code annotation can never be read as
// "this was a real failure".
const KILLED_JOB_ANNOTATIONS = [
  {
    annotation_level: "warning",
    message:
      "Node.js 20 is deprecated. The following actions target Node.js 20 but are being forced to run on Node.js 24: actions/setup-python@v5.",
  },
  { annotation_level: "failure", message: "Process completed with exit code 1." },
  {
    annotation_level: "failure",
    message:
      "The action 'Test approval admissibility-probe backoff (BLO-28471)' has timed out after 1 minutes.",
  },
];

// Job 101872142739 from the same run: a GENUINE assertion failure. Its message
// contains the words "timed out after 1000ms" because the test asserts on its
// own internal timeout. This is the adversarial case — a substring match on
// "timed out after" relabels a real defect as an infrastructure flake.
const ASSERTION_FAILURE_ANNOTATIONS = [
  { annotation_level: "failure", message: "Process completed with exit code 1." },
  {
    annotation_level: "failure",
    message:
      'AssertionError: promise rejected "Error: productivity review wake enqueue r…" instead of resolving\n ❯ src/__tests__/productivity-review-service.test.ts:5589:5',
  },
  {
    annotation_level: "failure",
    message:
      "Caused by: Caused by: Error: productivity review wake enqueue row-lock replay timed out after 1000ms",
  },
];

const ASSERTION_FAILURE_STEP = {
  name: "Run grouped general test suites",
  status: "completed",
  conclusion: "failure",
  started_at: "2026-09-07T22:36:35Z",
  completed_at: "2026-09-07T23:29:37Z",
};

// Run 34154564717 attempt 2, job 101870919838: the same `policy` job, GREEN.
// It still carries a failure-level annotation, emitted by a non-blocking step,
// so "the job has a failure annotation" is not a usable proxy for "the job
// failed" — let alone for "a step was killed".
const GREEN_JOB_ANNOTATIONS = [
  {
    annotation_level: "warning",
    message: "Node.js 20 is deprecated. The following actions target Node.js 20…",
  },
  { annotation_level: "failure", message: "Process completed with exit code 1." },
];

function killAnnotationFor(verdict) {
  return renderAnnotations(verdict).filter((line) => line.startsWith("::error"));
}

function warningsFor(verdict) {
  return renderAnnotations(verdict).filter((line) => line.startsWith("::warning"));
}

// ---------------------------------------------------------------------------
// (a) A killed step yields the timeout annotation.
// ---------------------------------------------------------------------------

test("the banked kill is classified as a timeout kill, with its real elapsed time", () => {
  const verdict = classifyStepKills({
    annotations: KILLED_JOB_ANNOTATIONS,
    steps: [KILLED_STEP],
  });

  assert.equal(verdict.degraded, null);
  assert.deepEqual(verdict.kills, [
    {
      name: "Test approval admissibility-probe backoff (BLO-28471)",
      budgetMinutes: 1,
      elapsedSeconds: 73,
    },
  ]);
});

test("the rendered annotation names the step, its budget and its elapsed time", () => {
  const lines = killAnnotationFor(
    classifyStepKills({ annotations: KILLED_JOB_ANNOTATIONS, steps: [KILLED_STEP] }),
  );

  assert.equal(lines.length, 1, "exactly one kill annotation");
  const [line] = lines;
  assert.match(line, /^::error title=/, "must be a GitHub error annotation, visible in the checks UI");
  assert.match(line, /Test approval admissibility-probe backoff \(BLO-28471\)/, "names the step");
  assert.match(line, /60s budget/, "states the configured budget");
  assert.match(line, /running 73s/, "states the elapsed duration");
  assert.match(line, /DURATION kill, not an assertion failure/, "says it was not a test failure");
});

// The overshoot is the reason this script reads GitHub's verdict instead of
// doing arithmetic. Pin it, so nobody "simplifies" the detector back into a
// duration comparison without first having to delete this assertion.
test("a real kill overshoots its budget, so elapsed-vs-budget is not a usable detector", () => {
  const elapsed = stepElapsedSeconds(KILLED_STEP);
  const budgetSeconds = 60;
  assert.equal(elapsed, 73);
  assert.ok(
    elapsed - budgetSeconds > 2,
    `banked kill overshot its ${budgetSeconds}s bound by ${elapsed - budgetSeconds}s, ` +
      "which a 2s-tolerance duration rule would classify as a non-kill",
  );
});

// ---------------------------------------------------------------------------
// (b) The case that matters: a real failure must NOT be relabelled.
// ---------------------------------------------------------------------------

test("a genuine assertion failure yields no timeout annotation", () => {
  const verdict = classifyStepKills({
    annotations: ASSERTION_FAILURE_ANNOTATIONS,
    steps: [ASSERTION_FAILURE_STEP],
  });

  assert.deepEqual(verdict.kills, [], "a real defect must never be relabelled as a timeout kill");
  assert.equal(verdict.degraded, null);
  assert.deepEqual(renderAnnotations(verdict), []);
});

test("a test's own 'timed out after 1000ms' text does not match the runner's timeout line", () => {
  const verdict = classifyStepKills({
    annotations: [
      {
        annotation_level: "failure",
        message: "Error: row-lock replay timed out after 1000ms",
      },
      {
        annotation_level: "failure",
        message: "The action 'Some step' has timed out after 30 minutes, allegedly.",
      },
    ],
    steps: [],
  });

  assert.deepEqual(
    verdict.kills,
    [],
    "only GitHub's exact, fully-anchored phrasing counts as a kill",
  );
});

test("a step that failed fast is not annotated even when a sibling step was killed", () => {
  const verdict = classifyStepKills({
    annotations: KILLED_JOB_ANNOTATIONS,
    steps: [
      KILLED_STEP,
      {
        name: "Test gh token wrapper",
        status: "completed",
        conclusion: "failure",
        started_at: "2026-09-07T19:19:57Z",
        completed_at: "2026-09-07T19:19:58Z",
      },
    ],
  });

  assert.deepEqual(
    verdict.kills.map((kill) => kill.name),
    ["Test approval admissibility-probe backoff (BLO-28471)"],
    "only the step GitHub named is annotated",
  );
});

// ---------------------------------------------------------------------------
// Negative control: a green run must produce nothing — including the green run
// that carries a failure-level annotation of its own.
// ---------------------------------------------------------------------------

test("a green policy run produces no annotation, despite carrying a failure-level one", () => {
  assert.ok(
    GREEN_JOB_ANNOTATIONS.some((annotation) => annotation.annotation_level === "failure"),
    "fixture must retain the failure-level annotation a green policy run really carries",
  );

  const verdict = classifyStepKills({ annotations: GREEN_JOB_ANNOTATIONS, steps: [] });
  assert.deepEqual(verdict.kills, []);
  assert.deepEqual(renderAnnotations(verdict), []);
});

test("an empty annotation set is evidence of absence and stays silent", () => {
  const verdict = classifyStepKills({ annotations: [], steps: [] });
  assert.deepEqual(verdict.kills, []);
  assert.equal(verdict.degraded, null, "an empty set was successfully queried; nothing degraded");
  assert.deepEqual(renderAnnotations(verdict), []);
});

// ---------------------------------------------------------------------------
// (c) Degradation is surfaced, never thrown, and never silent.
// ---------------------------------------------------------------------------

test("unavailable annotations degrade to a warning rather than a silent empty verdict", () => {
  const verdict = classifyStepKills({ annotations: null, steps: [KILLED_STEP] });

  assert.deepEqual(verdict.kills, []);
  assert.ok(verdict.degraded, "a 403 must not read downstream as 'nothing was killed'");

  const warnings = warningsFor(verdict);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^::warning title=Step-kill classifier degraded::/);
  assert.deepEqual(killAnnotationFor(verdict), [], "degrading must not invent a kill");
});

test("omitting the annotations argument defaults to the safe state", () => {
  // The permissive default is the dangerous one: it would let a caller that
  // never obtained annotations assert that nothing was killed.
  assert.ok(classifyStepKills({ steps: [KILLED_STEP] }).degraded);
  assert.ok(classifyStepKills({}).degraded);
});

test("malformed payloads yield an empty verdict instead of throwing", () => {
  for (const input of [
    { annotations: "not-an-array", steps: [] },
    { annotations: [null, undefined, {}], steps: null },
    { annotations: [{ annotation_level: "failure" }], steps: [] },
    {},
    undefined,
  ]) {
    assert.doesNotThrow(() => renderAnnotations(classifyStepKills(input)), `input: ${JSON.stringify(input)}`);
    assert.deepEqual(classifyStepKills(input).kills, []);
  }
});

test("a kill is still announced when its step timestamps cannot be recovered", () => {
  // GitHub told us it killed something. Dropping the annotation because the
  // elapsed time could not be enriched would restore the silence this exists
  // to break.
  const verdict = classifyStepKills({ annotations: KILLED_JOB_ANNOTATIONS, steps: [] });
  assert.equal(verdict.kills.length, 1);
  assert.equal(verdict.kills[0].elapsedSeconds, null);
  assert.match(killAnnotationFor(verdict)[0], /after running unknown/);
});

test("a '%' in a step name is escaped rather than read as a command escape", () => {
  const [line] = killAnnotationFor(
    classifyStepKills({
      annotations: [
        {
          annotation_level: "failure",
          message: "The action 'Test 100% branch coverage' has timed out after 2 minutes.",
        },
      ],
      steps: [],
    }),
  );

  assert.match(line, /Test 100%25 branch coverage/, "% is escaped to %25");
  assert.equal(line.split("\n").length, 1, "a command must occupy exactly one line");
});

test("a multi-line degradation reason cannot split the warning across lines", () => {
  // The realistic multi-line string is an API error, not a step name: YAML step
  // names are single-line, but a fetch failure message is routinely wrapped.
  const [line] = warningsFor(
    classifyStepKills({ annotations: null }),
  ).concat(
    renderAnnotations({
      kills: [],
      degraded: "GET /check-runs/1/annotations failed:\n503 Service Unavailable",
    }),
  ).slice(-1);

  assert.equal(line.split("\n").length, 1, "a newline in the reason must not split the command");
  assert.match(line, /failed:%0A503 Service Unavailable/, "newline is escaped to %0A");
});

test("the timeout pattern is anchored to a single-line message", () => {
  // A step name cannot contain a newline, so a multi-line message is not a
  // timeout line however much of it looks like one. Pinned so that widening the
  // pattern to `s`/`m` flags — which would let arbitrary test output smuggle in
  // a match — has to be a deliberate edit to this assertion.
  const verdict = classifyStepKills({
    annotations: [
      {
        annotation_level: "failure",
        message: "Some test output\nThe action 'x' has timed out after 1 minutes.",
      },
    ],
    steps: [],
  });

  assert.deepEqual(verdict.kills, []);
});

test("a sub-minute budget is matched, and reported as its real second count", () => {
  // `timeout-minutes: 0.5` renders as `has timed out after 0.5 minutes.`. An
  // integer-only group misses it, which is fail-safe but silent — and BLO-32670
  // was an exercise in re-sizing exactly these budgets, so a later edit
  // tightening one below a minute is the expected direction of travel.
  const verdict = classifyStepKills({
    annotations: [
      {
        annotation_level: "failure",
        message: "The action 'Cheap lint gate' has timed out after 0.5 minutes.",
      },
    ],
    steps: [],
  });

  assert.deepEqual(verdict.kills, [
    { name: "Cheap lint gate", budgetMinutes: 0.5, elapsedSeconds: null },
  ]);
  assert.match(killAnnotationFor(verdict)[0], /30s budget/, "0.5 minutes is 30 seconds, not 0");
});

test("duplicate step names attribute the timestamps of the LATER attempt", () => {
  // `policy` has no duplicate step names today, so this only decides which
  // elapsed time the annotation quotes. It is worth pinning because quoting the
  // earlier attempt's duration would undercut the one number the annotation
  // exists to be trusted for.
  const name = "Test approval admissibility-probe backoff (BLO-28471)";
  const verdict = classifyStepKills({
    annotations: KILLED_JOB_ANNOTATIONS,
    steps: [
      { name, conclusion: "failure", started_at: "2026-09-07T19:00:00Z", completed_at: "2026-09-07T19:00:05Z" },
      { name, conclusion: "failure", started_at: "2026-09-07T19:18:15Z", completed_at: "2026-09-07T19:19:28Z" },
    ],
  });

  assert.equal(verdict.kills[0].elapsedSeconds, 73, "the later attempt is the one that was killed");
});

// ---------------------------------------------------------------------------
// Annotation paging. The default page size is 30; `policy` keeps executing all
// ~60 of its steps on a red run because every one carries `if: !cancelled()`,
// and each failing step contributes at least one failure-level annotation. A
// single-page read can therefore drop the timeout line off the end on precisely
// the run this script exists for.
// ---------------------------------------------------------------------------

test("annotations are read past the first page, at the same size the jobs call uses", async () => {
  const requested = [];
  const originalFetch = globalThis.fetch;
  // Page 1 full (100), page 2 short (1) — the terminating condition.
  const pages = [
    Array.from({ length: 100 }, () => ({
      annotation_level: "failure",
      message: "Process completed with exit code 1.",
    })),
    [
      {
        annotation_level: "failure",
        message: "The action 'Late step' has timed out after 3 minutes.",
      },
    ],
  ];

  globalThis.fetch = async (url) => {
    requested.push(String(url));
    const page = Number(new URL(String(url)).searchParams.get("page"));
    return { ok: true, status: 200, statusText: "OK", json: async () => pages[page - 1] ?? [] };
  };

  try {
    const annotations = await fetchAnnotations(4242, "token", "Blockcast/paperclip");

    assert.equal(annotations.length, 101, "both pages are concatenated");
    assert.equal(requested.length, 2, "paging stops on the first short page");
    for (const url of requested) {
      assert.match(url, /[?&]per_page=100(&|$)/, "must not fall back to the 30-item default");
    }
    // The point of paging: a timeout line sitting past item 30 is still found.
    assert.deepEqual(classifyStepKills({ annotations, steps: [] }).kills, [
      { name: "Late step", budgetMinutes: 3, elapsedSeconds: null },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("annotation paging is bounded rather than trusting the server to terminate", async () => {
  // A pathological response that never returns a short page must not spin here
  // forever — the same reasoning as MAX_JOB_PAGES on the jobs loop.
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls += 1;
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => Array.from({ length: 100 }, () => ({ annotation_level: "notice", message: "x" })),
    };
  };

  try {
    const annotations = await fetchAnnotations(1, "token", "Blockcast/paperclip");
    assert.ok(calls <= 5, `paging must be bounded, made ${calls} requests`);
    assert.equal(annotations.length, calls * 100);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// Current-job selection.
// ---------------------------------------------------------------------------

test("the current job is selected by name, preferring the in-progress attempt", () => {
  const jobs = [
    { id: 1, name: "policy", status: "completed" },
    { id: 2, name: "Helm chart", status: "completed" },
    { id: 3, name: "policy", status: "in_progress" },
  ];

  assert.equal(selectCurrentJob(jobs, "policy").id, 3, "this script runs inside the in-progress job");
  assert.equal(selectCurrentJob(jobs, "Helm chart").id, 2);
  assert.equal(selectCurrentJob(jobs, "nope"), null);
  assert.equal(selectCurrentJob(null, "policy"), null);
});

// ---------------------------------------------------------------------------
// The CLI contract, exercised as a subprocess. The pure functions above cannot
// prove the two properties `policy` actually depends on: that the script exits
// 0 on every path, and that a failure still says something.
// ---------------------------------------------------------------------------

test("the CLI exits 0 and warns when it cannot run at all", () => {
  const script = fileURLToPath(new URL("../classify-policy-step-kills.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script], {
    encoding: "utf8",
    // Deliberately missing GH_TOKEN/GITHUB_REPOSITORY/GITHUB_RUN_ID.
    env: { PATH: process.env.PATH },
  });

  assert.equal(result.status, 0, "a classifier fault must never contribute a non-zero exit to policy");
  assert.match(
    result.stdout,
    /^::warning title=Step-kill classifier degraded::/,
    "an unrunnable classifier must say so rather than exit silently",
  );
  assert.doesNotMatch(result.stdout, /^::error/m, "it must not invent a kill it never observed");
});

// ---------------------------------------------------------------------------
// Workflow wiring. These are the assertions that keep the contract true in
// pr.yml, where the code above cannot enforce it.
// ---------------------------------------------------------------------------

const workflow = readFileSync(new URL("../../.github/workflows/pr.yml", import.meta.url), "utf8");

function policyRegion() {
  const start = workflow.indexOf("\n  policy:\n");
  const end = workflow.indexOf("\n  helm_chart:\n", start);
  assert.notEqual(start, -1, "pr.yml must define policy");
  assert.notEqual(end, -1, "pr.yml must define helm_chart after policy");
  return workflow.slice(start, end);
}

function classifyStep() {
  const step = policyRegion()
    .split("\n      - name: ")
    .slice(1)
    .find((candidate) => candidate.includes("classify-policy-step-kills.mjs"));
  assert.ok(step, "policy must run the step-kill classifier");
  return step;
}

test("policy declares every permission the classifier needs, checkout included", () => {
  const region = policyRegion();
  const permissions = region.match(/\n    permissions:\n((?: {6}.*\n|\n)*)/)?.[1];
  assert.ok(permissions, "policy must declare a job-level permissions block");

  // A job-level block REPLACES the workflow-level one rather than merging into
  // it, so omitting `contents: read` silently breaks `actions/checkout` and
  // every step after it. That is the footgun this test exists to pin.
  assert.match(permissions, /^ {6}contents: read$/m, "contents: read keeps actions/checkout working");
  assert.match(permissions, /^ {6}actions: read$/m, "actions: read reads the run's jobs and step conclusions");
  assert.match(permissions, /^ {6}checks: read$/m, "checks: read reads the timeout annotation itself");
});

test("policy still checks out the repository under that permissions block", () => {
  assert.match(
    policyRegion(),
    /\n      - name: Checkout repository\n        uses: actions\/checkout@v6\n/,
    "the permissions block must not have displaced the checkout step",
  );
});

test("the classifier can never change whether policy passes or fails", () => {
  const step = classifyStep();
  assert.match(step, /\n        continue-on-error: true\n/, "a classifier fault must not fail policy");
  assert.match(step, /\n        timeout-minutes: \d+\n/, "the classifier needs its own bound");
  assert.match(
    step,
    /\n        if: \$\{\{ !cancelled\(\) && failure\(\) \}\}\n/,
    "run only when policy is already red, so green runs pay nothing; the leading " +
      "!cancelled() is what policy-node-test-timeouts.test.mjs requires of every step here",
  );
});

test("the job name handed to the classifier is the one GitHub will report", () => {
  const region = policyRegion();
  const declaredName = region.match(/\n    name: (.+)\n/)?.[1];
  // `github.job` is the YAML key, which is the DISPLAY name only while the job
  // declares no `name:`. If someone adds one, the classifier would look for a
  // job that does not exist and degrade on every run — silently, but for the
  // warning it emits. Pin the pairing instead.
  assert.equal(declaredName, undefined, "policy must not declare a name:, or POLICY_JOB_NAME must be updated");
  assert.match(
    classifyStep(),
    /\n          POLICY_JOB_NAME: \$\{\{ github\.job \}\}\n/,
    "the classifier must be told which job to look for",
  );
});
