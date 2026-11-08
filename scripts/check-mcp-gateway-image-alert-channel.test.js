import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  ALERTNAME,
  JOB_TIMEOUT_ANNOTATION,
  NON_PAGING_CANCELLATIONS,
  buildAlert,
  classifyBuildCancellation,
  classifyCancellation,
  shouldPage,
} from "../.github/scripts/post-mcp-gateway-image-alert.mjs";

const workflow = readFileSync(
  new URL("../.github/workflows/docker-mcp-gateway.yml", import.meta.url),
  "utf8",
);
const alertScript = readFileSync(
  new URL("../.github/scripts/post-mcp-gateway-image-alert.mjs", import.meta.url),
  "utf8",
);

// Drop whole-line comments (YAML and in-`run:` shell alike). An assertion
// satisfied — or falsified — by prose is testing documentation rather than
// behaviour, and this file's subject necessarily DISCUSSES `gh issue` and
// quotes the GitHub annotation strings it matches on. Same hazard pinned in
// check-docker-agent-alert-channel.test.js and check-guard-liveness-alert-channel.test.js.
function executableLines(source) {
  return source
    .split("\n")
    .filter((line) => !/^\s*(#|\*|\/\*|\/\/)/.test(line))
    .join("\n");
}

// The JS analogue, stripping STRING LITERALS as well as comments. The operator
// text in this script names Harbor, PEN-6034 and the annotation shapes; without
// this, assertions about what the CODE does would be answerable by the prose it
// carries.
function executableCode(source) {
  return executableLines(source)
    .replace(/`(?:[^`\\]|\\.)*`/g, "``")
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
}

function getJobBlock(name, source = workflow) {
  const marker = `\n  ${name}:\n`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `docker-mcp-gateway.yml must define a ${name} job`);
  const remainder = source.slice(start + marker.length);
  const nextJob = remainder.search(/^ {2}[A-Za-z0-9_-]+:\s*$/m);
  const block = nextJob === -1 ? remainder : remainder.slice(0, nextJob);
  // Comment-stripped, ALWAYS. Returning the raw block is how an assertion comes
  // to be satisfied by the prose that explains it: a first cut of this file
  // asserted `/checks: read/` against the raw block and passed with the
  // `permissions:` entry deleted, because the job's own header comment says
  // "actions: read + checks: read are what let the script tell a timeout kill
  // from a supersede". It was caught by mutation, not by review.
  return executableLines(block);
}

const NOW = new Date("2026-11-07T02:10:46Z");

function firingAlert(overrides = {}) {
  return buildAlert({
    state: "firing",
    repo: "Blockcast/paperclip",
    branch: "master",
    runUrl: "https://github.com/Blockcast/paperclip/actions/runs/42326582436",
    headSha: "e079fc2be",
    buildResult: "cancelled",
    cancellation: "job_timeout",
    now: NOW,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Banked annotation payloads. Every fixture below is a verbatim `message` from
// a real `GET /repos/Blockcast/paperclip/check-runs/<id>/annotations` response
// on THIS workflow, read 2026-11-08. They are the whole evidential basis for
// the claim that a `cancelled` conclusion is separable, so a hand-written
// approximation would defeat the purpose: the point is that the classifier
// survives the strings GitHub actually emits, including the ones that
// co-occur.
//
// These four are the complete set of cancellations in this workflow's 44-run
// lifetime, fully paginated back to 2026-05-14 — 4 of 4, no overlap between
// the causes.
// ---------------------------------------------------------------------------

// Run 42326582436, job 128263163554, head e079fc2b — the kill PEN-6034 was
// filed on. NOTE that the generic "The operation was canceled." line is
// present too: a detector that matched only on that would classify a timeout as
// an ordinary cancellation, which is exactly the ambiguity being removed.
const JOB_TIMEOUT_ANNOTATIONS = [
  { annotation_level: "failure", message: "The job has exceeded the maximum execution time of 15m0s" },
  { annotation_level: "failure", message: "The operation was canceled." },
];

// Run 41562000182, job 125674536251, head 076c01d — the second kill, five days
// earlier, and the reason this is a pattern rather than an incident.
const SECOND_JOB_TIMEOUT_ANNOTATIONS = [
  { annotation_level: "failure", message: "The job has exceeded the maximum execution time of 15m0s" },
  { annotation_level: "failure", message: "The operation was canceled." },
];

// Run 25984348202, job 76378834187, head 94949fd — a concurrency supersede.
// `cancel-in-progress: true` makes this the ORDINARY outcome of two master
// landings in quick succession, so it is the shape that must never page.
const SUPERSEDE_ANNOTATIONS = [
  {
    annotation_level: "failure",
    message:
      "Canceling since a higher priority waiting request for docker-mcp-gateway-refs/heads/master exists",
  },
];

// Run 25839436286, job 75927434856, head 21f008f — a human pressed cancel.
const MANUAL_CANCEL_ANNOTATIONS = [
  { annotation_level: "failure", message: "The run was canceled forcefully by @kkroo." },
];

// ---------------------------------------------------------------------------
// The classifier
// ---------------------------------------------------------------------------

test("every cancellation in this workflow's history classifies, and only the kills page", () => {
  assert.equal(classifyCancellation(JOB_TIMEOUT_ANNOTATIONS), "job_timeout");
  assert.equal(classifyCancellation(SECOND_JOB_TIMEOUT_ANNOTATIONS), "job_timeout");
  assert.equal(classifyCancellation(SUPERSEDE_ANNOTATIONS), "superseded");
  assert.equal(classifyCancellation(MANUAL_CANCEL_ANNOTATIONS), "manual_cancel");

  assert.equal(shouldPage({ buildResult: "cancelled", cancellation: "job_timeout" }), true);
  assert.equal(shouldPage({ buildResult: "cancelled", cancellation: "superseded" }), false);
  assert.equal(shouldPage({ buildResult: "cancelled", cancellation: "manual_cancel" }), false);
});

// PEN-6034's Finding 1 is that a timeout and a supersede are indistinguishable.
// That is true of the CONCLUSION FIELD and false of the annotations — which is
// the entire reason this classifier exists, so it is asserted rather than left
// as narrative. Both fixtures below carry `conclusion: cancelled`.
test("the conclusion field cannot separate these, and the annotations can", () => {
  const sameConclusion = "cancelled";
  assert.notEqual(
    classifyCancellation(JOB_TIMEOUT_ANNOTATIONS),
    classifyCancellation(SUPERSEDE_ANNOTATIONS),
    "a timeout kill and a concurrency supersede must not classify alike",
  );
  assert.notEqual(
    shouldPage({ buildResult: sameConclusion, cancellation: classifyCancellation(JOB_TIMEOUT_ANNOTATIONS) }),
    shouldPage({ buildResult: sameConclusion, cancellation: classifyCancellation(SUPERSEDE_ANNOTATIONS) }),
    "the two must reach opposite paging decisions from the same conclusion",
  );
});

// The direction that matters. An unreadable, empty or unrecognised annotation
// set is NOT evidence that an image was published, so it pages. Getting this
// backwards reproduces PEN-6034 exactly: a build that published nothing and
// said nothing.
test("an unrecognised or missing annotation set fails CLOSED, toward paging", () => {
  for (const input of [[], undefined, null, [{ message: "Something new GitHub started emitting" }]]) {
    assert.equal(classifyCancellation(input), "unknown", `${JSON.stringify(input)} must classify unknown`);
    assert.equal(
      shouldPage({ buildResult: "cancelled", cancellation: classifyCancellation(input) }),
      true,
      "an unclassifiable cancellation must page",
    );
  }
  assert.equal(
    NON_PAGING_CANCELLATIONS.has("unknown"),
    false,
    "`unknown` must never be added to the suppression set — that is the fail-OPEN direction",
  );
});

// A timeout kill emits its own annotation AND the generic cancel line, so the
// branches can co-occur in principle. Any co-occurrence must resolve toward
// paging, which is a property of the ORDER of the tests in classifyCancellation
// and is therefore worth pinning: a reordering would be invisible on the four
// real fixtures above and silently suppress a kill.
test("a kill shape wins over a suppressing shape when both are present", () => {
  assert.equal(
    classifyCancellation([...SUPERSEDE_ANNOTATIONS, ...JOB_TIMEOUT_ANNOTATIONS]),
    "job_timeout",
  );
  assert.equal(
    classifyCancellation([...MANUAL_CANCEL_ANNOTATIONS, ...JOB_TIMEOUT_ANNOTATIONS]),
    "job_timeout",
  );
});

// The supersede branch is the only one that SUPPRESSES a page on a real
// annotation, so it is anchored on this workflow's own concurrency group. A
// bare "higher priority waiting request" match would suppress an eviction
// belonging to some other group if one ever surfaced on this job's check run.
test("the supersede suppression is anchored to this workflow's concurrency group", () => {
  assert.equal(
    classifyCancellation([
      { message: "Canceling since a higher priority waiting request for docker-agent-refs/heads/master exists" },
    ]),
    "unknown",
    "another workflow's eviction must not suppress this lane's page",
  );

  const group = /group: docker-mcp-gateway-/.test(executableLines(workflow));
  assert.ok(group, "the anchor above is only correct while the concurrency group keeps this prefix");
});

// The duration in the timeout annotation is the CURRENT ceiling. Pinning it
// would make the classifier go quiet the next time the budget is re-sized —
// a classifier that silently stops paging is this row's own defect in a new
// costume, so the regex must stay duration-agnostic.
test("the timeout matcher does not pin the current ceiling", () => {
  assert.match("The job has exceeded the maximum execution time of 15m0s", JOB_TIMEOUT_ANNOTATION);
  assert.match("The job has exceeded the maximum execution time of 35m0s", JOB_TIMEOUT_ANNOTATION);
  assert.match("The job has exceeded the maximum execution time of 1h0m0s", JOB_TIMEOUT_ANNOTATION);
  assert.doesNotMatch(
    executableCode(alertScript).replace(/JOB_TIMEOUT_ANNOTATION[\s\S]{0,200}/, ""),
    /15m0s/,
    "no branch of the classifier may depend on the ceiling being 15 minutes",
  );
});

// Fail-closed toward alerting at the TRANSPORT layer too: an API outage can
// only ever produce a page, never suppress one. Suppression requires positive
// evidence that was actually read.
test("an API failure classifies unknown rather than suppressing the page", async () => {
  const env = {
    GITHUB_TOKEN: "t",
    GITHUB_REPOSITORY: "Blockcast/paperclip",
    GITHUB_RUN_ID: "42326582436",
  };
  const throwing = async () => {
    throw new Error("network down");
  };
  assert.equal(await classifyBuildCancellation(env, throwing), "unknown");

  const notOk = async () => ({ ok: false, status: 503, json: async () => ({}) });
  assert.equal(await classifyBuildCancellation(env, notOk), "unknown");

  // No credential at all — the shape a mis-scoped `permissions:` block produces.
  assert.equal(await classifyBuildCancellation({}, throwing), "unknown");
});

test("the classifier reads the build job's annotations for this run attempt", async () => {
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(url);
    if (url.includes("/jobs")) {
      return {
        ok: true,
        json: async () => ({
          jobs: [
            { id: 1, name: "some-other-job" },
            { id: 128263163554, name: "build-and-push" },
          ],
        }),
      };
    }
    return { ok: true, json: async () => JOB_TIMEOUT_ANNOTATIONS };
  };

  const verdict = await classifyBuildCancellation(
    {
      GITHUB_TOKEN: "t",
      GITHUB_REPOSITORY: "Blockcast/paperclip",
      GITHUB_RUN_ID: "42326582436",
      GITHUB_RUN_ATTEMPT: "2",
    },
    fetchFn,
  );

  assert.equal(verdict, "job_timeout");
  assert.match(calls[0], /\/actions\/runs\/42326582436\/attempts\/2\/jobs/);
  assert.match(calls[1], /\/check-runs\/128263163554\/annotations/);
});

// ---------------------------------------------------------------------------
// The workflow wiring
// ---------------------------------------------------------------------------

// THE LOAD-BEARING INVARIANT OF THE WHOLE ROW. A step-level timeout concludes
// `failure`; a job-level one concludes `cancelled`, which this workflow's own
// `cancel-in-progress: true` also produces on every routine supersede. Keeping
// the step budget strictly BELOW the job ceiling is what makes an overrun
// self-reported and loud. Equal values would be a race; inverting them restores
// PEN-6034 in full, and nothing at runtime would say so.
test("the build step's budget is strictly below the job ceiling", () => {
  const job = getJobBlock("build-and-push");
  const jobTimeout = Number(/^ {4}timeout-minutes: (\d+)$/m.exec(job)?.[1]);
  const stepTimeout = Number(
    /- name: Build and push\n(?:\s+#.*\n)*\s+timeout-minutes: (\d+)\n/.exec(job)?.[1],
  );

  assert.ok(Number.isInteger(jobTimeout), "build-and-push must declare a job-level timeout-minutes");
  assert.ok(Number.isInteger(stepTimeout), "the `Build and push` step must declare its own timeout-minutes");
  assert.ok(
    stepTimeout < jobTimeout,
    `the step budget (${stepTimeout}) must be strictly below the job ceiling (${jobTimeout}), or an ` +
      "overrun is recorded as `cancelled` and becomes indistinguishable from a supersede (PEN-6034)",
  );
});

// The budget must stay above the demand that was actually observed. The two
// killed builds spent 14.37 and 13.27 minutes inside `Build and push` before
// the 15-minute job ceiling ended them, so their true demand is unknown and
// strictly greater than 14.4. A budget at or below that is known-insufficient
// from data already in hand.
test("the build step's budget clears the longest observed killed attempt", () => {
  const job = getJobBlock("build-and-push");
  const stepTimeout = Number(
    /- name: Build and push\n(?:\s+#.*\n)*\s+timeout-minutes: (\d+)\n/.exec(job)?.[1],
  );
  assert.ok(
    stepTimeout > 15,
    `a step budget of ${stepTimeout} min does not clear the 14.37 min the longest KILLED build had ` +
      "already spent when it was cut off; its real demand is unknown and larger (PEN-6034)",
  );
});

// BLO-33382: the agent-image lane's alert job called `gh issue list` on a repo
// where Issues are DISABLED (`has_issues` -> false). Under `set -euo pipefail`
// it died before reporting anything — a guardrail that failed closed AND
// silently for 8 master failures in 27h.
test("the routing path does not depend on GitHub Issues, which are disabled on this repo", () => {
  assert.doesNotMatch(executableLines(workflow), /\bgh issue (create|comment|list)\b/);
  assert.doesNotMatch(executableCode(alertScript), /\bgh issue\b/);
});

// `cancelled` in the condition is the row. A gate keyed on `failure` alone
// would have missed run 42326582436 exactly as every other signal did.
test("a cancelled build reaches the alert job, not just a failed one", () => {
  const job = getJobBlock("alert-on-failure");

  assert.match(job, /needs: \[build-and-push\]/);
  assert.match(job, /needs\.build-and-push\.result == 'failure'/);
  assert.match(
    job,
    /needs\.build-and-push\.result == 'cancelled'/,
    "a `timeout-minutes` kill is recorded as `cancelled`; omitting it reopens PEN-6034",
  );
  assert.match(job, /always\(\)/, "the job must dispatch after a cancelled dependency");
  assert.match(job, /node \.github\/scripts\/post-mcp-gateway-image-alert\.mjs/);
  assert.match(job, /STATE: firing/);
  assert.match(job, /ALERTMANAGER_URL:/);
  assert.match(
    job,
    /BUILD_RESULT: \$\{\{ needs\.build-and-push\.result \}\}/,
    "the script classifies on the dependency's result; without it every cancellation pages",
  );
});

// Without these scopes the classifier cannot read the annotations, every
// cancellation classifies `unknown`, and the alert pages on every routine
// supersede — fail-closed, but noisy enough to get muted, which is the silence
// this row exists to end.
test("the alert job can read the annotations its classifier depends on", () => {
  const job = getJobBlock("alert-on-failure");
  assert.match(job, /actions: read/);
  assert.match(job, /checks: read/);
  assert.match(job, /GITHUB_TOKEN: \$\{\{ github\.token \}\}/);
});

// Without this, `endsAt` is the only thing retiring a firing alert, so the lane
// goes quiet on a TIMER rather than on a fix. It is also the continuous
// capability probe BLO-33382 went undetected for want of — and it matters more
// here than on a busy lane, because gateway builds are sparse (44 in six
// months, with a 34-day stretch carrying none).
test("a successful build resolves the alert and re-proves the channel", () => {
  const job = getJobBlock("resolve-on-success");

  assert.match(job, /needs\.build-and-push\.result == 'success'/);
  assert.match(job, /STATE: resolved/);
  assert.match(job, /node \.github\/scripts\/post-mcp-gateway-image-alert\.mjs/);
});

// A delivery failure in the alert path must not flip the build's own result and
// fire a spurious "the build is failing" alert about itself.
test("routing lives in its own jobs, not inside the build", () => {
  const build = getJobBlock("build-and-push");
  assert.doesNotMatch(
    build,
    /post-mcp-gateway-image-alert\.mjs/,
    "the alert must not run inside build-and-push",
  );
});

// ---------------------------------------------------------------------------
// Alert identity
// ---------------------------------------------------------------------------

// The Alertmanager fingerprint hashes the ENTIRE label set and the Paperclip
// bridge dedupes on it, refreshing one issue in place. A head SHA, run id or
// cancellation reason in a LABEL would mint a fresh identity per build and turn
// one persistent fault into one new issue per red run — the flood of BLO-28616.
test("alert labels carry no per-occurrence cardinality", () => {
  const a = firingAlert();
  const b = firingAlert({
    headSha: "076c01d8a",
    runUrl: "https://github.com/Blockcast/paperclip/actions/runs/41562000182",
    cancellation: "unknown",
    buildResult: "failure",
  });

  assert.deepEqual(a.labels, b.labels, "two different failures must share one alert identity");
  assert.equal(a.labels.alertname, ALERTNAME);
  assert.equal(a.labels.namespace, "paperclip");
  assert.equal(a.labels.service, "paperclip-mcp-gateway-image-delivery");

  const labelValues = Object.values(a.labels).join(" ");
  for (const perOccurrence of ["e079fc2be", "42326582436", "job_timeout"]) {
    assert.ok(!labelValues.includes(perOccurrence), `${perOccurrence} must not appear in a label`);
  }
  assert.equal(a.annotations.head_sha, "e079fc2be");
  assert.equal(a.annotations.cancellation_reason, "job_timeout");
  assert.match(a.annotations.run_url, /42326582436/);
});

// It must not collide with the agent-image lane's alert either: two lanes
// sharing an identity means fixing one cancels the other's issue.
test("the alert identity is distinct from the agent-image lane's", async () => {
  const agent = await import("../.github/scripts/post-docker-agent-alert.mjs");
  assert.notEqual(ALERTNAME, agent.ALERTNAME);
});

// Alertmanager rejects `startsAt >= endsAt` with `400 start time must be before
// end time`, so a resolved push cannot simply back-date `endsAt` against a
// `now` start. This is the live 400 BLO-33382's first cut hit on 2026-09-11,
// which would have left every green build red and the firing alert un-retired.
test("a resolved push back-dates both ends, so Alertmanager accepts it", () => {
  const resolved = firingAlert({ state: "resolved" });
  assert.ok(
    new Date(resolved.startsAt) < new Date(resolved.endsAt),
    "startsAt must precede endsAt or Alertmanager 400s",
  );
  assert.ok(new Date(resolved.endsAt) < NOW, "a resolved alert's endsAt must be in the past");

  const firing = firingAlert();
  assert.ok(new Date(firing.endsAt) > NOW, "a firing alert must not be born expired");
});

// The alert is read by whoever is about to re-pin a manifest. It has to say
// which commit got no image and where to look — PEN-5690 nearly re-pinned a CVE
// remediation to `sha-e079fc2`, a tag that does not exist.
test("the alert names the unpublished commit and routes to its row", () => {
  const alert = firingAlert();
  assert.match(alert.annotations.description, /e079fc2be/);
  assert.match(alert.annotations.description, /paperclip-mcp-gateway/);
  assert.match(alert.annotations.runbook_url, /PEN-6034/);
  assert.equal(alert.annotations.build_result, "cancelled");
});
