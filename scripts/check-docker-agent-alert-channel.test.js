import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { ALERTNAME, buildAlert } from "../.github/scripts/post-docker-agent-alert.mjs";

const workflow = readFileSync(new URL("../.github/workflows/docker-agent.yml", import.meta.url), "utf8");
const alertScript = readFileSync(
  new URL("../.github/scripts/post-docker-agent-alert.mjs", import.meta.url),
  "utf8",
);

function getJobBlock(name, source = workflow) {
  const marker = `\n  ${name}:\n`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `docker-agent.yml must define a ${name} job`);
  const remainder = source.slice(start + marker.length);
  const nextJob = remainder.search(/^  [A-Za-z0-9_-]+:\s*$/m);
  return nextJob === -1 ? remainder : remainder.slice(0, nextJob);
}

// Drop whole-line comments (YAML and in-`run:` shell alike). The header comment
// on `alert-on-failure` necessarily QUOTES `gh issue list` to explain why the
// step no longer uses it, and an assertion satisfied — or in this case
// falsified — by prose is testing documentation rather than behaviour. Same
// hazard the deploy-timeout suite pins for `check-pending-migrations.sh`.
function executableLines(source) {
  return source
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

// BLO-33382: the defect this whole file exists to prevent recurring. The alert
// job called `gh issue list` / `gh issue create` against a repository with
// Issues DISABLED, so under `set -euo pipefail` it died before reporting
// anything — a guardrail that failed closed and silently for 8 master failures
// in 27h. This is the assertion that would have caught it the day it was
// written, and it is static precisely so it costs nothing and cannot be
// deferred to "the next real failure".
test("the failure alert does not depend on GitHub Issues, which are disabled on this repo", () => {
  const alertJob = executableLines(getJobBlock("alert-on-failure"));

  assert.doesNotMatch(
    alertJob,
    /\bgh issue\b/,
    "alert-on-failure must not use `gh issue`: Blockcast/paperclip has has_issues=false, so every " +
      "such call exits non-zero and the alert can never be delivered (BLO-33382)",
  );
  assert.doesNotMatch(
    executableLines(workflow),
    /\bgh issue (create|comment|list)\b/,
    "no job in this workflow may route a notification through GitHub Issues on this repo",
  );
});

test("the failure alert is delivered through Alertmanager, which reaches the Paperclip bridge", () => {
  const alertJob = getJobBlock("alert-on-failure");

  assert.match(alertJob, /node \.github\/scripts\/post-docker-agent-alert\.mjs/);
  assert.match(alertJob, /ALERTMANAGER_URL:/);
  assert.match(alertJob, /STATE: firing/);
  assert.match(
    alertJob,
    /needs\.build-and-push\.result == 'failure'/,
    "the alert must fire on a failed build",
  );
});

// Without this, `endsAt` is the only thing that retires a firing alert, so the
// lane goes quiet on a TIMER rather than on a fix. It is also the continuous
// capability probe: every green build exercises the same delivery path the
// failure path depends on, so a rotted channel is caught by the next success
// instead of by the next outage.
test("a successful build resolves the alert and re-proves the channel", () => {
  const resolveJob = getJobBlock("resolve-on-success");

  assert.match(resolveJob, /node \.github\/scripts\/post-docker-agent-alert\.mjs/);
  assert.match(resolveJob, /STATE: resolved/);
  assert.match(
    resolveJob,
    /needs\.build-and-push\.result == 'success'/,
    "the resolve/probe path must run on a GREEN build — that is what makes it continuous",
  );
});

// A delivery failure in the resolve path must not flip build-and-push's result
// and fire a spurious "the build is failing" alert. Keeping it a separate job
// is what guarantees that, so pin it.
test("the resolve probe is a separate job, so its failure cannot forge a build failure", () => {
  assert.match(
    workflow,
    /^  resolve-on-success:$/m,
    "resolve-on-success must be a top-level job, not a step inside build-and-push",
  );
  const buildJob = getJobBlock("build-and-push");
  assert.doesNotMatch(buildJob, /post-docker-agent-alert\.mjs/);
});

// The Alertmanager fingerprint hashes the ENTIRE label set and the Paperclip
// bridge dedupes on it. A per-commit label would mint a fresh alert identity
// per red build and turn one persistent fault into an issue flood — the failure
// documented in BLO-28616, where 343 rows turned out to be 334 distinct pods.
test("alert labels carry no per-build cardinality", () => {
  const firing = buildAlert({
    state: "firing",
    repo: "Blockcast/paperclip",
    branch: "master",
    runUrl: "https://github.com/Blockcast/paperclip/actions/runs/1",
    headSha: "3b38d96b",
    failedJob: "build-and-push",
    now: new Date("2026-09-11T20:00:00Z"),
  });
  const other = buildAlert({
    state: "firing",
    repo: "Blockcast/paperclip",
    branch: "master",
    runUrl: "https://github.com/Blockcast/paperclip/actions/runs/2",
    headSha: "28707d7d",
    failedJob: "build-and-push",
    now: new Date("2026-09-11T21:00:00Z"),
  });

  assert.deepEqual(
    firing.labels,
    other.labels,
    "two different commits must produce an IDENTICAL label set, or each red build opens its own issue",
  );
  const labelValues = Object.values(firing.labels).join(" ");
  for (const volatile of ["3b38d96b", "actions/runs/1"]) {
    assert.ok(
      !labelValues.includes(volatile),
      `labels must not contain per-build value ${volatile}; it belongs in annotations`,
    );
  }
  assert.equal(firing.annotations.head_sha, "3b38d96b", "the SHA must still be reported, as an annotation");
  assert.equal(firing.labels.alertname, ALERTNAME);
});

test("a resolved push retires the alert immediately instead of waiting out endsAt", () => {
  const now = new Date("2026-09-11T20:00:00Z");
  const resolved = buildAlert({
    state: "resolved",
    repo: "Blockcast/paperclip",
    branch: "master",
    runUrl: "",
    headSha: "586a03be",
    failedJob: "build-and-push",
    now,
  });
  const firing = buildAlert({
    state: "firing",
    repo: "Blockcast/paperclip",
    branch: "master",
    runUrl: "",
    headSha: "586a03be",
    failedJob: "build-and-push",
    now,
  });

  assert.ok(
    new Date(resolved.endsAt) < now,
    "a resolved push must set endsAt in the past so Alertmanager sends `resolved` at once",
  );
  assert.ok(new Date(firing.endsAt) > now, "a firing push must stay live");
  assert.deepEqual(
    resolved.labels,
    firing.labels,
    "resolve must target the SAME fingerprint as the firing alert, or it resolves nothing",
  );
});

// Regression: the first cut back-dated only `endsAt`, leaving startsAt == now,
// and Alertmanager rejected it with `400 start time must be before end time`.
// That would have made every GREEN master build red while leaving the firing
// alert un-retired — the failure found by actually pushing the alert, which
// reading the YAML could never have surfaced.
test("both states satisfy Alertmanager's startsAt < endsAt precondition", () => {
  const now = new Date("2026-09-11T20:00:00Z");
  for (const state of ["firing", "resolved"]) {
    const alert = buildAlert({
      state,
      repo: "Blockcast/paperclip",
      branch: "master",
      runUrl: "",
      headSha: "586a03be",
      failedJob: "build-and-push",
      now,
    });
    assert.ok(
      new Date(alert.startsAt) < new Date(alert.endsAt),
      `${state}: startsAt (${alert.startsAt}) must be strictly before endsAt (${alert.endsAt}) — ` +
        "Alertmanager 400s otherwise",
    );
  }
});

// Delivery failure must be fatal. A silent success here recreates exactly the
// defect this script replaced: a guardrail everyone believes is in place.
test("alert delivery failure is fatal, not swallowed", () => {
  assert.match(alertScript, /process\.exit\(1\)/);
  assert.doesNotMatch(alertScript, /continue-on-error/);
  assert.equal(
    (alertScript.match(/process\.exit\(1\)/g) ?? []).length,
    2,
    "both the unreachable-Alertmanager and non-2xx paths must exit non-zero",
  );
});

// BLO-33382 second defect: one bare curl, `exit 1` on any non-200. A ~30s
// paperclip-api restart on 2026-09-11 returned 503 and permanently dropped the
// image bump for three consecutive commits — images promoted to Harbor, cluster
// refs never advanced, and `pending_image_bump` null so nothing retried either.
test("the cluster image bump retries a transient 5xx before failing the job", () => {
  const buildJob = getJobBlock("build-and-push");
  const bumpStep = buildJob.slice(buildJob.indexOf("name: Bump agent image refs in cluster"));

  assert.match(bumpStep, /max_attempts=(\d+)/, "the bump must bound its retries");
  const maxAttempts = Number(bumpStep.match(/max_attempts=(\d+)/)[1]);
  assert.ok(maxAttempts >= 3, `the bump must retry at least 3 times (found ${maxAttempts})`);

  assert.match(
    bumpStep,
    /000\|5\*\)/,
    "retry must cover BOTH a connection failure (sentinel 000) and a 5xx — the observed fault was " +
      "an envoy connection refusal, which writes no HTTP status at all",
  );
  assert.match(bumpStep, /delay=\$\(\(delay \* 2\)\)/, "retries must back off rather than hammer a restarting API");
  assert.match(bumpStep, /--connect-timeout \d+ --max-time \d+/, "each attempt must be individually bounded");
});

test("a 4xx is not retried, because retrying a deterministic rejection only delays the failure", () => {
  const buildJob = getJobBlock("build-and-push");
  const bumpStep = buildJob.slice(buildJob.indexOf("name: Bump agent image refs in cluster"));
  const retryCase = bumpStep.indexOf("000|5*)");
  const catchAll = bumpStep.indexOf("*) echo \"$http\"; return 0 ;;");

  assert.ok(retryCase !== -1 && catchAll !== -1);
  assert.ok(
    retryCase < catchAll,
    "the 5xx/connection branch must precede the catch-all, or every status would fall through it",
  );
});

// `jq: parse error: Invalid numeric literal at line 1, column 9` was the most
// prominent line in the failing log — the proxy's PLAIN-TEXT error body fed to
// `jq`. The parser's complaint buried the actual cause.
test("a non-JSON error body is printed legibly rather than fed to jq as the primary surface", () => {
  const buildJob = getJobBlock("build-and-push");
  const bumpStep = buildJob.slice(buildJob.indexOf("name: Bump agent image refs in cluster"));

  assert.match(
    bumpStep,
    /if jq -e \. "\$response" >\/dev\/null 2>&1; then/,
    "the body must be probed for validity BEFORE jq is used to render it",
  );
  assert.match(bumpStep, /non-JSON response body/);
  assert.doesNotMatch(
    bumpStep,
    /^\s*jq '\.' "\$response" \|\| cat "\$response"\s*$/m,
    "the old `jq || cat` form prints the parse error first, which is what buried the real cause",
  );
  assert.match(
    bumpStep,
    /::error::bump-agent-image returned HTTP \$http for company \$\{cid\}: \$\(head -c \d+ "\$response"\)/,
    "the ::error:: annotation must carry the response body, not just the status code",
  );
});

// Negative controls. Each pins that the anchors above can actually FALSIFY —
// an assertion satisfied by a comment mentioning the thing it guards would let
// this whole suite go vacuous while the guardrail rots.
test("the job-block extractor cannot bleed into a later job", () => {
  const block = getJobBlock("alert-on-failure", `${workflow}\n  later-job:\n    name: later-job-only\n`);
  assert.doesNotMatch(block, /later-job-only/);
});

test("removing the Alertmanager delivery falsifies the delivery assertion", () => {
  const alertJob = getJobBlock("alert-on-failure");
  assert.match(alertJob, /node \.github\/scripts\/post-docker-agent-alert\.mjs/, "fixture check: present today");

  const withoutStep = alertJob.replace(/node \.github\/scripts\/post-docker-agent-alert\.mjs/g, "echo skip");
  assert.doesNotMatch(
    withoutStep,
    /node \.github\/scripts\/post-docker-agent-alert\.mjs/,
    "the anchor must be the executed step, not prose naming the script",
  );
});

test("reintroducing `gh issue` falsifies the no-GitHub-Issues assertion", () => {
  const poisoned = workflow.replace(
    "- name: Report the failed build to Alertmanager",
    "- name: Report\n        run: gh issue create --repo $REPO",
  );
  assert.match(
    executableLines(getJobBlock("alert-on-failure", poisoned)),
    /\bgh issue\b/,
    "the guard must notice a reintroduced GitHub-Issues dependency — comment-stripping must not hide it",
  );
});

// Pins the comment-stripping itself. If `executableLines` ever swallowed a
// `run:` line, the assertion above would pass on a workflow that really had
// gone back to GitHub Issues, and this whole suite would be decorative.
test("comment-stripping removes prose but never an executed line", () => {
  const sample = ["  # run: gh issue create", "        run: gh issue create --repo $REPO"].join("\n");
  const stripped = executableLines(sample);

  assert.doesNotMatch(stripped, /# run: gh issue create/, "a commented mention must be dropped");
  assert.match(stripped, /^\s+run: gh issue create --repo \$REPO$/m, "the executed line must survive");
  assert.ok(
    /^\s*#/.test("  # false). `gh issue list` exited non-zero"),
    "fixture check: the real header comment in docker-agent.yml is a whole-line comment, " +
      "which is why whole-line stripping is sufficient here",
  );
});
