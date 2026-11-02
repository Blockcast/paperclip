import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  ALERTNAME,
  MAX_DETAIL_CHARS,
  buildAlert,
  truncateDetail,
} from "../.github/scripts/post-guard-liveness-alert.mjs";

const workflow = readFileSync(
  new URL("../.github/workflows/scheduled-guard-liveness.yml", import.meta.url),
  "utf8",
);
const alertScript = readFileSync(
  new URL("../.github/scripts/post-guard-liveness-alert.mjs", import.meta.url),
  "utf8",
);
const detector = readFileSync(
  new URL("./check-scheduled-guard-liveness.mjs", import.meta.url),
  "utf8",
);

// Drop whole-line comments (YAML and in-`run:` shell alike). An assertion
// satisfied by prose is testing documentation rather than behaviour — and this
// file's header necessarily DISCUSSES `gh issue` and `PaperclipProductionDeploy`
// to explain why neither is used, so an unfiltered scan would be falsified by
// its own rationale. Same hazard pinned in check-docker-agent-alert-channel.test.js.
function executableLines(source) {
  return source
    .split("\n")
    .filter((line) => !/^\s*(#|\*|\/\*|\/\/)/.test(line))
    .join("\n");
}

// The JS analogue, and it strips STRING LITERALS as well as comments. The same
// principle the comment filter encodes — an assertion satisfied, or falsified,
// by prose is testing documentation rather than behaviour — applies verbatim to
// operator-facing text, which merely happens to live in a string rather than in
// a comment. This file's subject deliberately NAMES `WATCHED_GUARDS` in its
// runbook annotation (that is the edit an operator makes to retire a guard on
// purpose), and without this the logic-duplication assertion below would be
// falsified by the very guidance it wants the alert to carry.
function executableCode(source) {
  return executableLines(source)
    .replace(/`(?:[^`\\]|\\.)*`/g, "``")
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
}

// Steps are at indent 6 under `steps:`. Slice from this step's `- name:` to the
// next one at the same indent.
function getStepBlock(name, source = workflow) {
  const marker = `      - name: ${name}\n`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `scheduled-guard-liveness.yml must define a step named ${name}`);
  const remainder = source.slice(start + marker.length);
  const nextStep = remainder.search(/^ {6}- name: /m);
  return nextStep === -1 ? remainder : remainder.slice(0, nextStep);
}

const ROUTE_STEP = "Route a stopped-guard verdict to Alertmanager (PEN-5261)";
const RESOLVE_STEP =
  "Resolve the stopped-guard alert and prove the channel still works (PEN-5261)";
const DETECT_STEP = "Report scheduled guards that have stopped executing";
const FAIL_STEP = "Fail the run if a watched guard has stopped";

const NOW = new Date("2026-11-02T08:00:00Z");

function firingAlert(overrides = {}) {
  return buildAlert({
    state: "firing",
    repo: "Blockcast/paperclip",
    runUrl: "https://github.com/Blockcast/paperclip/actions/runs/1",
    detail: "scheduled-production-deploy.yml has state 'disabled_manually'",
    now: NOW,
    ...overrides,
  });
}

// PEN-5261 is a ROUTING row, and its closing constraint is explicit: "do not
// add a new detector — one already works". The detector went red at 04:51:24Z
// on 2026-11-02 naming the exact cause and stayed red hourly; nothing carried
// it to a human. If this script ever starts reaching GitHub to form its own
// opinion, the two will disagree and the routing layer becomes a second,
// unowned detector.
test("the alert script routes a verdict and does not re-derive one", () => {
  const executable = executableCode(alertScript);

  assert.doesNotMatch(
    executable,
    /\bgh\b|api\.github\.com|actions\/workflows|execFileSync|spawnSync/,
    "the alert script must not query GitHub: it transports the detector's verdict, it does not " +
      "compute liveness (PEN-5261)",
  );
  assert.doesNotMatch(
    executable,
    /staleHours|STALE_HOURS|WATCHED_GUARDS/,
    "thresholds and the watched set belong to the detector alone; duplicating them here creates " +
      "a second opinion that can silently diverge",
  );
  assert.match(
    detector,
    /export function summarize/,
    "the detector is expected to remain the single source of the verdict this script carries",
  );
});

// BLO-33382: the agent-image lane's alert job called `gh issue list` on a repo
// where Issues are DISABLED (`has_issues` -> false). Under `set -euo pipefail`
// it died before reporting anything — a guardrail that failed closed AND
// silently for 8 master failures in 27h. This is the static assertion that
// would have caught it the day it was written.
test("the routing path does not depend on GitHub Issues, which are disabled on this repo", () => {
  assert.doesNotMatch(
    executableLines(workflow),
    /\bgh issue (create|comment|list)\b/,
    "no step in this workflow may route a notification through GitHub Issues on this repo",
  );
  assert.doesNotMatch(executableCode(alertScript), /\bgh issue\b/);
});

test("a stopped guard is routed to Alertmanager, which reaches the Paperclip bridge", () => {
  const step = getStepBlock(ROUTE_STEP);

  assert.match(step, /node \.github\/scripts\/post-guard-liveness-alert\.mjs/);
  assert.match(step, /ALERTMANAGER_URL:/);
  assert.match(step, /STATE: firing/);
  assert.match(
    step,
    /steps\.liveness\.outputs\.exit_code != '0'/,
    "the alert must fire exactly when the detector reds",
  );
  assert.match(
    step,
    /GUARD_LIVENESS_DETAIL=/,
    "the detector's own output must be carried into the alert, not re-worded here",
  );
});

// Without this, `endsAt` is the only thing retiring a firing alert, so the lane
// goes quiet on a TIMER rather than on a fix. It is also the continuous
// capability probe BLO-33382 went undetected for want of: every HEALTHY hourly
// run exercises the same delivery path the failure path depends on.
test("a healthy run resolves the alert and re-proves the channel", () => {
  const step = getStepBlock(RESOLVE_STEP);

  assert.match(step, /node \.github\/scripts\/post-guard-liveness-alert\.mjs/);
  assert.match(step, /STATE: resolved/);
  assert.match(
    step,
    /steps\.liveness\.outputs\.exit_code == '0'/,
    "the resolve/probe path must run on a HEALTHY verdict — that is what makes it continuous",
  );
});

// The capture that lets the routing steps run on the red path must not become a
// way for this guard to be permanently green. The detector's exit code is
// re-applied in a final step; if that step is ever dropped, a stopped guard
// routes an alert and then reports success.
test("the detector's verdict still reds the run", () => {
  const detect = getStepBlock(DETECT_STEP);
  assert.match(detect, /id: liveness/);
  assert.match(
    detect,
    /PIPESTATUS\[0\]/,
    "the detector's exit code must survive the `tee`, not be replaced by tee's",
  );
  assert.match(detect, /exit_code=/);

  const fail = getStepBlock(FAIL_STEP);
  assert.match(fail, /steps\.liveness\.outputs\.exit_code != '0'/);
  assert.match(fail, /exit 1/, "a stopped guard must still fail the run");
});

// `2>&1` is load-bearing: `summarize()`'s headline goes to STDERR on the red
// path while the per-guard annotations go to stdout. Capturing stdout alone
// would route an alert whose detail omits the one line that says how many
// guards stopped and why.
test("the capture includes stderr, where the verdict headline is written", () => {
  assert.match(getStepBlock(DETECT_STEP), /check-scheduled-guard-liveness\.mjs 2>&1/);
  assert.match(
    detector,
    /console\.error\(summary\.headline\)/,
    "the headline is expected to remain on stderr; if it moves, the capture above must follow",
  );
});

// The Alertmanager fingerprint hashes the ENTIRE label set and the Paperclip
// bridge dedupes on it. The tempting design here is a `workflow:` label so each
// stopped guard gets its own issue — but the detector's verdict is per-EVENT by
// construction, and the shape it was built for is a SHARED-LANE outage that
// stopped five-to-six guards at once (2026-09-11, 2026-09-14). A per-workflow
// label would mint six issues for one ARC outage: the flood of BLO-28616.
test("alert labels carry no per-occurrence cardinality", () => {
  const a = firingAlert();
  const b = firingAlert({
    runUrl: "https://github.com/Blockcast/paperclip/actions/runs/999",
    detail: "a completely different guard stopped, and three others did too",
    now: new Date("2026-11-03T09:00:00Z"),
  });

  assert.deepEqual(
    a.labels,
    b.labels,
    "two different stopped-guard verdicts must share one alert identity",
  );

  const labelValues = Object.values(a.labels).join(" ");
  assert.doesNotMatch(labelValues, /actions\/runs/, "run URL belongs in annotations, not labels");
  assert.doesNotMatch(labelValues, /\.yml/, "no workflow name may appear in a label");
  assert.doesNotMatch(labelValues, /\d{4}-\d{2}-\d{2}/, "no timestamp may appear in a label");

  assert.equal(a.labels.alertname, ALERTNAME);
  assert.equal(a.annotations.run_url, "https://github.com/Blockcast/paperclip/actions/runs/1");
});

// A resolved push that does not match the firing label set retires NOTHING —
// Alertmanager would treat it as a different alert and the issue would stay
// open forever while every surface said it had been resolved.
test("the resolved push carries the identical label set to the firing one", () => {
  assert.deepEqual(firingAlert().labels, firingAlert({ state: "resolved" }).labels);
});

// Verified live on 2026-09-11 against the sibling script: back-dating `endsAt`
// against a `now` start returns `400 start time must be before end time`, which
// would leave every healthy run red and the firing alert un-retired.
test("a resolved push back-dates both ends, not just endsAt", () => {
  const resolved = firingAlert({ state: "resolved" });

  assert.ok(
    new Date(resolved.startsAt) < new Date(resolved.endsAt),
    "Alertmanager rejects startsAt >= endsAt with a 400",
  );
  assert.ok(
    new Date(resolved.endsAt) < NOW,
    "endsAt must already be in the past so Alertmanager sends `resolved` immediately",
  );
});

// Nothing re-pushes this alert between runs except the detector itself, so the
// TTL is the backstop for the one case the detector cannot report — its own
// stop. It must outlast a quiet weekend.
test("a firing alert outlives a quiet weekend", () => {
  const firing = firingAlert();
  const ttlHours = (new Date(firing.endsAt) - new Date(firing.startsAt)) / 3_600_000;

  assert.ok(ttlHours >= 72, `firing TTL must cover a long weekend, got ${ttlHours}h`);
});

// `check-scheduled-guard-liveness.mjs` prints one annotation per guard and then
// writes the summary headline LAST. Truncating from the end would reliably
// discard the verdict an operator needs first.
test("an oversized detail keeps the tail, where the verdict is", () => {
  const detail = `${"noise ".repeat(5000)}\n3 of 9 watched scheduled guard(s) have stopped executing.`;
  const kept = truncateDetail(detail);

  assert.ok(kept.endsWith("3 of 9 watched scheduled guard(s) have stopped executing."));
  assert.ok(kept.length <= MAX_DETAIL_CHARS + 200);
  assert.match(kept, /truncated/);

  const short = "all nine guards are healthy";
  assert.equal(truncateDetail(short), short, "a detail under the bound must pass through verbatim");
});

// A silent success here would recreate exactly the defect this change closes:
// a guardrail everyone believes is in place. Both failure paths must exit non-zero.
test("delivery failure is fatal on both the unreachable and the non-2xx path", () => {
  const unreachable = alertScript.slice(
    alertScript.indexOf("could not reach Alertmanager"),
    alertScript.indexOf("if (!res.ok)"),
  );
  assert.match(unreachable, /process\.exit\(1\)/);

  const nonOk = alertScript.slice(alertScript.indexOf("if (!res.ok)"));
  assert.match(nonOk.slice(0, nonOk.indexOf("console.log")), /process\.exit\(1\)/);
});

// PEN-5261 ruled out raising `PaperclipProductionDeployFailing` for two reasons,
// the second decisive: that alert keys on `paperclip_api_deploy_failed_since_success
// > 0`, a deploy that was DISPATCHED and DIED. A disabled dispatcher dispatches
// nothing, so it is structurally blind to this fault. If a future edit reaches
// for it from here, that blindness comes with it.
test("routing does not depend on the deploy-attempt gauge, which cannot see a disabled dispatcher", () => {
  assert.doesNotMatch(
    executableCode(alertScript),
    /paperclip_api_deploy_failed_since_success|PaperclipProductionDeployFailing/,
  );
});

// `stale_hours` is a debugging dial that flattens every per-guard threshold at
// once, so a run that used it is answering a hypothetical rather than measuring
// the fleet. Neither routing step may fire on such a run.
//
// The RESOLVE side is the one this test exists for. A low dial reds the
// detector and would mint a false firing alert — loud, and retired by the next
// hourly cron. A high dial GREENS it and would push `resolved`, clearing a
// genuinely firing alert about a guard that is still dead. That direction is
// silent, so a gate on the firing step alone would leave the worse half open.
test("a debugging dispatch routes nothing, in either direction", () => {
  for (const step of [ROUTE_STEP, RESOLVE_STEP]) {
    assert.match(
      executableLines(getStepBlock(step)),
      /if:.*inputs\.stale_hours == ''/,
      `${step} must not route when the stale_hours dial was overridden`,
    );
  }
});

// The gate must not cost the scheduled runs, which are the entire point of the
// channel: on a `schedule` event `inputs` is null, and an `event_name` test
// would be the obvious-looking way to write this that silently also excludes a
// blank-dial manual dispatch — a legitimate on-demand sample of the real
// thresholds. Pin the comparison shape rather than the intent.
test("the routing gate excludes only an overridden dial, not scheduled runs", () => {
  for (const step of [ROUTE_STEP, RESOLVE_STEP]) {
    const guard = executableLines(getStepBlock(step));
    assert.doesNotMatch(
      guard,
      /if:.*github\.event_name/,
      `${step} must gate on the dial, not on the event that set it`,
    );
  }
});
