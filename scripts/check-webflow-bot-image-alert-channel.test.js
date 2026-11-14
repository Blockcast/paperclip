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
} from "../.github/scripts/post-webflow-bot-image-alert.mjs";

const workflow = readFileSync(
  new URL("../.github/workflows/docker-webflow-bot.yml", import.meta.url),
  "utf8",
);
const alertScript = readFileSync(
  new URL("../.github/scripts/post-webflow-bot-image-alert.mjs", import.meta.url),
  "utf8",
);

// Drop whole-line comments (YAML and in-`run:` shell alike). An assertion
// satisfied — or falsified — by prose is testing documentation rather than
// behaviour, and this file's subject necessarily QUOTES the GitHub annotation
// strings it matches on. Same hazard pinned in
// check-mcp-external-image-alert-channel.test.js.
function executableLines(source) {
  return source
    .split("\n")
    .filter((line) => !/^\s*(#|\*|\/\*|\/\/)/.test(line))
    .join("\n");
}

// The JS analogue, stripping STRING LITERALS as well as comments. The operator
// text in this script names Harbor, PEN-6683 and the annotation shapes; without
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
  assert.notEqual(start, -1, `docker-webflow-bot.yml must define a ${name} job`);
  const remainder = source.slice(start + marker.length);
  const nextJob = remainder.search(/^ {2}[A-Za-z0-9_-]+:\s*$/m);
  const block = nextJob === -1 ? remainder : remainder.slice(0, nextJob);
  // Comment-stripped, ALWAYS — returning the raw block is how an assertion
  // comes to be satisfied by the prose that explains it.
  return executableLines(block);
}

function stepBudget() {
  const job = getJobBlock("build-and-push");
  return Number(/- name: Build and push\n(?:\s+#.*\n)*\s+timeout-minutes: (\d+)\n/.exec(job)?.[1]);
}

function jobCeiling() {
  const job = getJobBlock("build-and-push");
  return Number(/^ {4}timeout-minutes: (\d+)$/m.exec(job)?.[1]);
}

// PEN-6683. A STEP-level `timeout-minutes` kill concludes `failure`; a
// JOB-level one concludes `cancelled`, which this workflow's own
// `cancel-in-progress: true` also produces on every routine supersede. Keeping
// the step budget strictly BELOW the job ceiling is what makes an overrun
// self-reported and loud. Equal values would be a race; inverting them restores
// the original defect, and nothing at runtime would say so.
test("the build step's budget is strictly below the job ceiling", () => {
  const jobTimeout = jobCeiling();
  const stepTimeout = stepBudget();

  assert.ok(Number.isInteger(jobTimeout), "build-and-push must declare a job-level timeout-minutes");
  assert.ok(
    Number.isInteger(stepTimeout),
    "the `Build and push` step must declare its own timeout-minutes",
  );
  assert.ok(
    stepTimeout < jobTimeout,
    `the step budget (${stepTimeout}) must be strictly below the job ceiling (${jobTimeout}), or an ` +
      "overrun is recorded as `cancelled` and becomes indistinguishable from a supersede (PEN-6683)",
  );
});

// The budget is sized off the SUCCESSFUL population, never the killed runs: a
// kill's elapsed time measures the CEILING, not the build's demand.
//
// Measured first-party against the Actions API on 2026-11-14 over all 58 runs
// this workflow has ever had. 9 builds of `build-and-push` succeeded. Six
// retain step detail — 6.07 min (run #7), 4.85 (#2), 2.82 (#79), 0.58 (#84),
// 0.50 (#3), 0.18 (#5) — and three are old enough that GitHub has aged their
// step array out, so their JOB durations bound the step from above at 12.03
// (#39), 1.10 (#13) and 0.97 (#43). The longest build that can have completed
// on this lane is therefore 12.03 min, and that is an UPPER BOUND: the step is
// strictly shorter than the job that contains it.
//
// 20 clears that bound by 66% and leaves 10 min of headroom under the
// 30-minute ceiling.
test("the build step's budget clears the longest observed SUCCESSFUL build", () => {
  const stepTimeout = stepBudget();
  assert.ok(
    stepTimeout > 12.03,
    `a step budget of ${stepTimeout} min does not clear the 12.03 min upper bound on the longest ` +
      "build that has ever completed on this lane (run #39); it would kill a healthy build (PEN-6683)",
  );
});

// A hang must not be able to consume the whole job ceiling in silence. If the
// step budget ever creeps up to meet the ceiling, the `cancelled`-vs-`failure`
// distinction this row exists to restore is gone again.
test("the step budget leaves real headroom under the ceiling", () => {
  const slack = jobCeiling() - stepBudget();
  assert.ok(
    slack >= 2,
    `only ${slack} min separates the step budget from the job ceiling; a kill that lands in that ` +
      "window is recorded as `cancelled` and reaches nobody (PEN-6683)",
  );
});

// The exact gap PEN-6034 named and PEN-6683 re-measured on this workflow: a
// `timeout-minutes` kill reports `cancelled`, NOT `failure`. An alert arm keyed
// only on `failure` is silent for precisely the failure it exists to catch —
// webflow-bot #81 ran 30.08 min against a 30-minute ceiling on a master PUSH,
// was recorded `cancelled`, and reached nobody.
test("a cancelled build reaches the alert job, not just a failed one", () => {
  const job = getJobBlock("alert-on-failure");
  assert.match(job, /needs\.build-and-push\.result == 'cancelled'/);
  assert.match(job, /needs\.build-and-push\.result == 'failure'/);
  assert.match(job, /always\(\)/);
});

// The classifier reads check-run annotations, which require these scopes.
// Without them every cancellation classifies `unknown` and pages — fail-closed,
// but uselessly noisy, and noise is what gets an alert muted.
test("the alert job can read the annotations its classifier depends on", () => {
  const job = getJobBlock("alert-on-failure");
  assert.match(job, /actions: read/);
  assert.match(job, /checks: read/);
});

// Without the resolve arm, `endsAt` is the only thing retiring a firing alert,
// so the lane goes quiet on a TIMER rather than on a fix. It is also the
// continuous capability probe: this lane published 8 images across its 60 most
// recent runs, so a rotted channel would otherwise be found by the next outage.
test("a successful build resolves the alert and re-proves the channel", () => {
  const job = getJobBlock("resolve-on-success");
  assert.match(job, /needs\.build-and-push\.result == 'success'/);
  assert.match(job, /STATE: resolved/);
});

// A delivery failure inside the alert step must not flip build-and-push's own
// result and fire a spurious "the build is failing" alert about itself.
test("routing lives in its own jobs, not inside the build", () => {
  const build = getJobBlock("build-and-push");
  assert.doesNotMatch(build, /post-webflow-bot-image-alert/);
  assert.match(getJobBlock("alert-on-failure"), /post-webflow-bot-image-alert\.mjs/);
  assert.match(getJobBlock("resolve-on-success"), /post-webflow-bot-image-alert\.mjs/);
});

// The supersede suppression must be anchored to THIS workflow's concurrency
// group. A looser regex would suppress a real kill on any workflow whose group
// name happens to share a prefix — and on this repo four of them do: the main
// `docker-refs/...` lane, `docker-designer-`, `docker-webflow-bot-` and
// `docker-mcp-external-`.
test("the supersede suppression is anchored to this workflow's concurrency group", () => {
  assert.equal(classifyCancellation([{ message: "Canceling since a higher priority waiting request for 'docker-webflow-bot-refs/heads/master' exists" }]), "superseded");
  assert.equal(classifyCancellation([{ message: "Canceling since a higher priority waiting request for 'docker-figma-bot-refs/heads/master' exists" }]), "unknown");
  assert.equal(classifyCancellation([{ message: "Canceling since a higher priority waiting request for 'docker-refs/heads/master-publish' exists" }]), "unknown");
  assert.match(executableLines(workflow), /group: docker-webflow-bot-/);
});

// `conclusion` cannot separate these shapes; only the annotations can. This is
// the whole reason the classifier exists.
test("the kill shapes page and the intended cancellations do not", () => {
  assert.equal(classifyCancellation([{ message: "The job running on runner X has exceeded the maximum execution time of 30 minutes." }]), "job_timeout");
  assert.equal(classifyCancellation([{ message: "The action 'Build and push' has timed out after 20 minutes." }]), "step_timeout");
  assert.equal(classifyCancellation([{ message: "The run was canceled by @someone." }]), "manual_cancel");

  assert.equal(shouldPage({ buildResult: "cancelled", cancellation: "job_timeout" }), true);
  assert.equal(shouldPage({ buildResult: "cancelled", cancellation: "step_timeout" }), true);
  assert.equal(shouldPage({ buildResult: "cancelled", cancellation: "superseded" }), false);
  assert.equal(shouldPage({ buildResult: "cancelled", cancellation: "manual_cancel" }), false);
  assert.equal(shouldPage({ buildResult: "failure", cancellation: "n/a" }), true);
  assert.equal(shouldPage({ buildResult: "success", cancellation: "n/a" }), false);
});

// A build-and-push that never ran — this workflow skips it on `pull_request`,
// and `needs: test` skips it when the test job fails — must not page. A skipped
// build publishes no image, but the run is already red for the real reason and
// a second alert about it would be a duplicate.
test("a skipped build does not page", () => {
  assert.equal(shouldPage({ buildResult: "skipped", cancellation: "n/a" }), false);
});

// MUTATION: if `unknown` were ever added to the non-paging set, an unreadable
// cancellation would silently suppress the page — the exact silence this lane
// was built to end.
test("an unrecognised or missing annotation set fails CLOSED, toward paging", () => {
  assert.equal(classifyCancellation([]), "unknown");
  assert.equal(classifyCancellation([{ message: "something nobody has seen before" }]), "unknown");
  assert.equal(classifyCancellation(undefined), "unknown");
  assert.ok(!NON_PAGING_CANCELLATIONS.has("unknown"));
  assert.equal(shouldPage({ buildResult: "cancelled", cancellation: "unknown" }), true);
});

// A kill annotation must win over a suppressing one when both are present: a
// job can be superseded AFTER it has already blown its budget.
test("a kill shape wins over a suppressing shape when both are present", () => {
  const both = [
    { message: "Canceling since a higher priority waiting request for 'docker-webflow-bot-x' exists" },
    { message: "The job running on runner X has exceeded the maximum execution time of 30 minutes." },
  ];
  assert.equal(classifyCancellation(both), "job_timeout");
});

// An API outage must not be able to suppress a page.
test("an API failure classifies unknown rather than suppressing the page", async () => {
  const env = {
    GITHUB_REPOSITORY: "Blockcast/paperclip",
    GITHUB_RUN_ID: "1",
    GITHUB_TOKEN: "t",
  };
  const failing = async () => ({ ok: false, status: 500, json: async () => ({}) });
  assert.equal(await classifyBuildCancellation(env, failing), "unknown");
  const throwing = async () => {
    throw new Error("network down");
  };
  assert.equal(await classifyBuildCancellation(env, throwing), "unknown");
});

// The classifier must read THIS run attempt's jobs, not the run's first.
test("the classifier reads the build job's annotations for this run attempt", async () => {
  const seen = [];
  const env = {
    GITHUB_REPOSITORY: "Blockcast/paperclip",
    GITHUB_RUN_ID: "77",
    GITHUB_RUN_ATTEMPT: "3",
    GITHUB_TOKEN: "t",
  };
  const fetchFn = async (url) => {
    seen.push(String(url));
    if (String(url).includes("/jobs")) {
      return { ok: true, status: 200, json: async () => ({ jobs: [{ id: 9, name: "build-and-push" }] }) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => [{ message: "The job running on runner X has exceeded the maximum execution time of 30 minutes." }],
    };
  };
  assert.equal(await classifyBuildCancellation(env, fetchFn), "job_timeout");
  assert.ok(seen.some((u) => u.includes("/actions/runs/77/attempts/3/jobs")));
  assert.ok(seen.some((u) => u.includes("/check-runs/9/annotations")));
});

// The Alertmanager fingerprint hashes the ENTIRE label set and the Paperclip
// bridge dedupes on it. A SHA or run URL in a LABEL mints a fresh alert
// identity per commit and turns one persistent fault into one issue per red
// build (BLO-28616).
test("alert labels carry no per-occurrence cardinality", () => {
  const a = buildAlert({
    state: "firing",
    repo: "Blockcast/paperclip",
    branch: "master",
    runUrl: "https://example/run/1",
    headSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    buildResult: "cancelled",
    cancellation: "job_timeout",
    now: new Date("2026-11-14T15:08:27Z"),
  });
  const labels = JSON.stringify(a.labels);
  assert.doesNotMatch(labels, /deadbeef/);
  assert.doesNotMatch(labels, /example\/run/);
  assert.equal(a.labels.alertname, ALERTNAME);
  assert.equal(a.annotations.head_sha, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
  assert.equal(a.annotations.run_url, "https://example/run/1");
});

// Alertmanager rejects `startsAt >= endsAt` with 400, so a resolved push has to
// move BOTH ends, not just back-date one.
test("a resolved push back-dates both ends, so Alertmanager accepts it", () => {
  const now = new Date("2026-11-14T15:08:27Z");
  const a = buildAlert({
    state: "resolved",
    repo: "Blockcast/paperclip",
    branch: "master",
    runUrl: "",
    headSha: "abc",
    buildResult: "success",
    cancellation: "n/a",
    now,
  });
  assert.ok(new Date(a.startsAt) < new Date(a.endsAt), "startsAt must be before endsAt");
  assert.ok(new Date(a.endsAt) < now, "a resolved push must back-date endsAt");
});

// Each image lane must own a distinct alert identity, or two lanes dedupe onto
// one Paperclip issue and the second failure is invisible.
test("the alert identity is distinct from the other image lanes'", async () => {
  const gateway = await import("../.github/scripts/post-mcp-gateway-image-alert.mjs");
  const external = await import("../.github/scripts/post-mcp-external-image-alert.mjs");
  const agent = await import("../.github/scripts/post-docker-agent-alert.mjs");
  assert.notEqual(ALERTNAME, gateway.ALERTNAME);
  assert.notEqual(ALERTNAME, external.ALERTNAME);
  assert.notEqual(ALERTNAME, agent.ALERTNAME);

  // The `service` label is part of the fingerprint too, so it must be distinct
  // on its own — two lanes sharing it would dedupe even with distinct names.
  const mine = buildAlert({
    state: "firing", repo: "r", branch: "master", runUrl: "", headSha: "a",
    buildResult: "failure", cancellation: "n/a", now: new Date(),
  }).labels.service;
  for (const other of [gateway, external, agent]) {
    const theirs = other.buildAlert({
      state: "firing", repo: "r", branch: "master", runUrl: "", headSha: "a",
      buildResult: "failure", cancellation: "n/a", now: new Date(),
    }).labels.service;
    assert.notEqual(mine, theirs);
  }
});

// The alert must name the unpublished commit so the row it opens is actionable.
test("the alert names the unpublished commit and routes to its row", () => {
  const a = buildAlert({
    state: "firing",
    repo: "Blockcast/paperclip",
    branch: "master",
    runUrl: "https://example/run/1",
    headSha: "271ebf093",
    buildResult: "cancelled",
    cancellation: "job_timeout",
    now: new Date(),
  });
  assert.match(a.annotations.description, /271ebf093/);
  assert.match(a.annotations.description, /PEN-6683/);
  assert.equal(a.labels.service, "paperclip-webflow-bot-image-delivery");
});

// BLO-33382: the agent-image lane's alert step called `gh issue list` on a repo
// where Issues are DISABLED. Under `set -euo pipefail` it died before reporting
// anything — a guardrail that failed closed AND silently.
test("the routing path does not depend on GitHub Issues, which are disabled on this repo", () => {
  assert.doesNotMatch(executableLines(workflow), /\bgh issue (create|comment|list)\b/);
  assert.doesNotMatch(executableCode(alertScript), /\bgh issue\b/);
});

// JOB_TIMEOUT_ANNOTATION must not pin the current ceiling, or changing
// `timeout-minutes` silently stops the classifier recognising its own kill.
test("the timeout matcher does not pin the current ceiling", () => {
  assert.ok(JOB_TIMEOUT_ANNOTATION.test("has exceeded the maximum execution time of 30 minutes"));
  assert.ok(JOB_TIMEOUT_ANNOTATION.test("has exceeded the maximum execution time of 45 minutes"));
  assert.doesNotMatch(JOB_TIMEOUT_ANNOTATION.source, /30|20/);
});
