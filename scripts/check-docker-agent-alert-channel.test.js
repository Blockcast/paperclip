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

// Steps are at indent 6 under `steps:`. Same shape as getJobBlock: slice from
// this step's `- name:` to the next one at the same indent.
function getStepBlock(name, source = workflow) {
  const marker = `      - name: ${name}\n`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `docker-agent.yml must define a step named ${name}`);
  const remainder = source.slice(start + marker.length);
  const nextStep = remainder.search(/^ {6}- name: /m);
  return nextStep === -1 ? remainder : remainder.slice(0, nextStep);
}

const CONTROL_STEP =
  "Prove a shadowing PVC browser cannot outrank the pinned one (PEN-4682 positive control)";
const SMOKE_STEP = "Smoke test restricted headless screenshot";

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
  const buildJob = getJobBlock("bump-agent-image");
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
  const buildJob = getJobBlock("bump-agent-image");
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
  const buildJob = getJobBlock("bump-agent-image");
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

// BLO-43939: the delivery defect in the same lane. `github.ref` is constant on
// a master-only `workflow_run` trigger, so the job's concurrency group covers
// all of trunk; with `cancel-in-progress: true` a ~73-minute build was killed
// by the next successful server build. 17 of 100 master runs died mid-build at
// a median 38 minutes and the worst gap between two published agent images was
// 16.3h — silently, because `alert-on-failure` keys on `failure`, not
// `cancelled`. `false` keeps supersession (GitHub holds one run pending per
// group and the newest commit wins that slot) without destroying work in
// flight, and leaves max concurrency at 1 so arc-dind gains no parallel builds.
test("a master push does not cancel an agent-base build already in flight", () => {
  const buildJob = executableLines(getJobBlock("build-and-push"));

  assert.match(buildJob, /^\s*concurrency:$/m, "build-and-push must still declare a concurrency group");
  assert.match(
    buildJob,
    /^\s*cancel-in-progress: false$/m,
    "build-and-push must set cancel-in-progress: false — this group is all of trunk, and `true` " +
      "destroys a ~73-minute build every time the next master commit lands (BLO-43939)",
  );
  assert.doesNotMatch(buildJob, /^\s*cancel-in-progress: true$/m);
});

test("reintroducing cancel-in-progress: true falsifies the delivery assertion", () => {
  const poisoned = workflow.replace("cancel-in-progress: false", "cancel-in-progress: true");
  assert.notEqual(poisoned, workflow, "fixture check: the literal must be present to be swapped");
  assert.match(
    executableLines(getJobBlock("build-and-push", poisoned)),
    /^\s*cancel-in-progress: true$/m,
    "the guard must read the executed key, not the comment above it that quotes the old value",
  );
});
// PEN-4682: the control that shipped in #2988 could never go red, so every
// master agent-image build failed at it -- inside build-and-push, upstream of
// `Promote verified agent image` -- and the Alertmanager lane fired on each
// one. Docker mounts `--tmpfs` noexec unless `exec` is given, so the planted
// /paperclip/bin/google-chrome was never executable however it was chmodded;
// bash `command -v` skips a PATH match it cannot execute, so the canary
// skipped the plant, fell through to $CHROME_BIN (/usr/local/bin/google-chrome,
// on the default PATH) and PASSED exactly where (b) requires it to fail. The
// step then printed CONTROL FAILED and blamed the image.
//
// WHY STATIC, AND WHY HERE. docker-agent.yml runs only on `workflow_run` of
// Docker on master and on workflow_dispatch, so no PR lane ever executes that
// step -- #2988 went in with 25 green checks and the defect was invisible
// until it reached trunk. This suite does run on PRs, so these assertions are
// the only thing standing between a future edit of that mount and another
// round of red master builds.
test("the shadowing control plants on an exec-capable tmpfs, or it can never go red", () => {
  const control = executableLines(getStepBlock(CONTROL_STEP));

  assert.match(
    control,
    /--tmpfs \/paperclip:rw,exec,nosuid,size=\d+m,mode=1777 /,
    "the PEN-4682 control must mount /paperclip with `exec` and `mode=1777`: Docker defaults --tmpfs to noexec " +
      "and root-owned 0755. Without mode=1777 the uid-1000 mkdir is denied and the step reds before " +
      "any control runs (BLO-33389); without exec the plant is skipped by `command -v`, so control (b) passes when it must " +
      "red and the step fails every master build (PEN-4682)",
  );
});

test("the control proves the plant is executable before drawing a conclusion from it", () => {
  const control = executableLines(getStepBlock(CONTROL_STEP));

  assert.match(
    control,
    /^\s*test -x \/paperclip\/bin\/google-chrome$/m,
    "the control must assert the plant is executable right after the chmod: under `sh -eu` that " +
      "fails at the cause, instead of surfacing four lines later as a CONTROL FAILED that blames " +
      "the image for the control's own broken mount (PEN-4682)",
  );
});

// The image ENTRYPOINT runs ahead of the control's `sh -eu -c`. Once mode=1777
// made /paperclip writable by uid 1000, install_browser_link's own `mkdir -p`
// started succeeding too, so it now seeds /paperclip/bin/google-chrome as a
// symlink to $CHROME_BIN before the plant is written. Shell `>` follows
// symlinks, so the plant would write through to the real browser on the
// --read-only rootfs (EROFS on CI; reproduced locally as EACCES, rc=2) -- and
// had it landed, the plant would BE the pinned browser, so control (b) would
// pass and the step would print CONTROL FAILED against a healthy image.
// The two executed lines whose ORDER the control depends on, shared so the
// assertion and its falsification partner cannot drift apart.
const UNLINK_LINE = /^\s*rm -f \/paperclip\/bin\/google-chrome$/m;
const PLANT_LINE = /^\s*printf "[^"]*" > \/paperclip\/bin\/google-chrome$/m;

test("the control unlinks the entrypoint-seeded symlink before planting", () => {
  const control = executableLines(getStepBlock(CONTROL_STEP));

  assert.match(
    control,
    /^\s*rm -f \/paperclip\/bin\/google-chrome$/m,
    "the control must `rm -f /paperclip/bin/google-chrome` between the mkdir and the printf: the " +
      "image entrypoint seeds that path as a symlink to $CHROME_BIN, and `>` follows symlinks, so " +
      "without the unlink the plant writes through to the read-only rootfs and the step reds at " +
      "the printf instead of proving anything (PEN-4682)",
  );

  // Presence is not enough: an unlink that runs AFTER the printf removes the
  // plant the control is about to rely on, and one that runs after the whole
  // write-through has already failed removes nothing. Pin the order too.
  const unlinkAt = control.search(UNLINK_LINE);
  const plantAt = control.search(PLANT_LINE);
  assert.ok(plantAt >= 0, "fixture check: the printf plant line must be present to order against");
  assert.ok(
    unlinkAt < plantAt,
    "the unlink must precede the printf: after it, the `>` has already followed the " +
      "entrypoint's symlink to $CHROME_BIN on the read-only rootfs, and the unlink would then " +
      "delete the plant control (a) and (b) resolve through (PEN-4682)",
  );
});

test("moving the unlink after the plant falsifies the ordering assertion", () => {
  const poisoned = workflow
    .replace("              rm -f /paperclip/bin/google-chrome\n", "")
    .replace(
      '              printf "#!/bin/sh\\nexit 0\\n" > /paperclip/bin/google-chrome\n',
      '              printf "#!/bin/sh\\nexit 0\\n" > /paperclip/bin/google-chrome\n' +
        "              rm -f /paperclip/bin/google-chrome\n",
    );
  assert.notEqual(poisoned, workflow, "fixture check: both literals must be present to be swapped");

  const control = executableLines(getStepBlock(CONTROL_STEP, poisoned));
  assert.match(control, UNLINK_LINE, "fixture check: the moved unlink is still present, just later");
  assert.ok(
    control.search(UNLINK_LINE) > control.search(PLANT_LINE),
    "the guard must read position, not mere presence: a trailing unlink satisfies a " +
      "presence-only assertion while deleting the plant",
  );
});

test("dropping the unlink falsifies the plant assertion", () => {
  const poisoned = workflow.replace("              rm -f /paperclip/bin/google-chrome\n", "");
  assert.notEqual(poisoned, workflow, "fixture check: the literal must be present to be removed");

  assert.doesNotMatch(
    executableLines(getStepBlock(CONTROL_STEP, poisoned)),
    /^\s*rm -f \/paperclip\/bin\/google-chrome$/m,
    "the guard must read the executed unlink, not the comment above it that names the same path",
  );
});

// Scope check. `exec` is needed only where this step writes and runs its own
// planted script; the plain smoke step plants nothing, so widening its mount
// would be unearned.
test("the plain smoke step keeps /paperclip noexec, because it plants nothing", () => {
  const smoke = executableLines(getStepBlock(SMOKE_STEP));

  assert.match(smoke, /--tmpfs \/paperclip:rw,nosuid,size=\d+m/);
  assert.doesNotMatch(
    smoke,
    /--tmpfs \/paperclip:[^\s]*\bexec\b/,
    "the smoke step must not gain `exec`: it plants no executable, so the mount stays as narrow " +
      "as it has always been",
  );
});

test("dropping exec from the control's tmpfs falsifies the assertion", () => {
  const poisoned = workflow.replace(
    "--tmpfs /paperclip:rw,exec,nosuid,size=16m",
    "--tmpfs /paperclip:rw,nosuid,size=16m",
  );
  assert.notEqual(poisoned, workflow, "fixture check: the literal must be present to be swapped");

  assert.doesNotMatch(
    executableLines(getStepBlock(CONTROL_STEP, poisoned)),
    /--tmpfs \/paperclip:rw,exec,nosuid,size=\d+m,mode=1777 /,
    "the guard must read the executed mount flag, not the comment above it that names noexec",
  );
});

test("the step-block extractor cannot bleed into a later step", () => {
  const control = getStepBlock(CONTROL_STEP);
  assert.doesNotMatch(
    control,
    /Assert the agent image's git-config surface/,
    "getStepBlock must stop at the next step, or an assertion could be satisfied by a neighbour",
  );
  assert.match(control, /control \(b\): wrapper directory absent/, "fixture check: it kept its own body");
});
