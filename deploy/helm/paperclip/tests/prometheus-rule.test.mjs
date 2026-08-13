import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

function renderChart(extraArgs = []) {
  return execFileSync(
    "helm",
    [
      "template",
      "paperclip",
      "deploy/helm/paperclip",
      "--namespace",
      "paperclip",
      "-f",
      "deploy/helm/paperclip/values.blockcast.yaml",
      ...extraArgs,
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
}

test("Blockcast values do not render a PrometheusRule (paperclip-ci-deploy has no RBAC for it)", () => {
  // BLO-14556: the paperclip-ci-deploy ServiceAccount that runs `helm upgrade`
  // has no RBAC grant on prometheusrules.monitoring.coreos.com. If this flag
  // flips back to true without that grant, every deploy fails at "helm
  // upgrade" (not just skips the resource) and blocks the whole company.
  const rendered = renderChart();

  assert.doesNotMatch(
    rendered,
    /kind: PrometheusRule/,
    "values.blockcast.yaml must keep prometheusRule.enabled=false until paperclip-ci-deploy is granted RBAC on prometheusrules.monitoring.coreos.com",
  );
});
test("prometheusRule.enabled=true still renders the PrometheusRule (flag remains usable once RBAC exists)", () => {
  const rendered = execFileSync(
    "helm",
    [
      "template",
      "paperclip",
      "deploy/helm/paperclip",
      "--namespace",
      "paperclip",
      "-f",
      "deploy/helm/paperclip/values.blockcast.yaml",
      "--show-only",
      "templates/prometheusrule.yaml",
      "--set",
      "prometheusRule.enabled=true",
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );

  assert.match(rendered, /kind: PrometheusRule/);
  assert.match(rendered, /name: paperclip-runtime-alerts/);
});

test("PaperclipAgentPodUnschedulable keys on kube_pod_status_scheduled, not the non-portable kube_pod_status_unschedulable (BLO-16224)", () => {
  // kube_pod_status_unschedulable is not exposed by many kube-state-metrics
  // builds/allowlists (confirmed absent on the Blockcast cluster's KSM), so the
  // original expr was permanently no-data there. kube_pod_status_scheduled
  // {condition="false"} is a core, always-emitted KSM series. Pin the portable
  // metric so a future edit can't silently regress the alert to no-data.
  const rendered = execFileSync(
    "helm",
    [
      "template",
      "paperclip",
      "deploy/helm/paperclip",
      "--namespace",
      "paperclip",
      "-f",
      "deploy/helm/paperclip/values.blockcast.yaml",
      "--show-only",
      "templates/prometheusrule.yaml",
      "--set",
      "prometheusRule.enabled=true",
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );

  assert.match(rendered, /alert: PaperclipAgentPodUnschedulable/);
  assert.match(
    rendered,
    /expr: count\(kube_pod_status_scheduled\{condition="false"/,
    "PodUnschedulable alert must key on kube_pod_status_scheduled{condition=false}",
  );
  assert.doesNotMatch(
    rendered
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n"),
    /expr:.*kube_pod_status_unschedulable/,
    "kube_pod_status_unschedulable is not portable across kube-state-metrics builds; do not use it in alert expressions",
  );
});

test("PaperclipGithubReviewRequestDeadLettered fires on any dead-lettered delivery and is silent at zero (BLO-18859)", () => {
  const rendered = execFileSync(
    "helm",
    [
      "template",
      "paperclip",
      "deploy/helm/paperclip",
      "--namespace",
      "paperclip",
      "-f",
      "deploy/helm/paperclip/values.blockcast.yaml",
      "--show-only",
      "templates/prometheusrule.yaml",
      "--set",
      "prometheusRule.enabled=true",
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );

  assert.match(rendered, /alert: PaperclipGithubReviewRequestDeadLettered/);
  // Pin the state selector: the alert is meaningless if a future edit drops
  // it and starts summing all four funnel states (received/queued would fire
  // it continuously in normal operation).
  assert.match(
    rendered,
    /increase\(paperclip_github_review_request_delivery_total\{state="dead_lettered"\}\[[^\]]+\]\)/,
    "dead-letter alert must select only state=dead_lettered",
  );
  // `> 0` is the silent-in-steady-state guarantee: the counter is
  // zero-initialized, so increase() over a flat series is 0 and never fires.
  // A threshold of >= 0 or a missing comparison would fire permanently.
  assert.match(
    rendered,
    /state="dead_lettered"\}\[[^\]]+\]\)\) > 0/,
    "dead-letter alert must fire only on a strictly positive increase",
  );
  // BLO-18859 review follow-up: the durable-gauge arm. Without it a dead letter
  // recorded before the first scrape (no baseline for increase()) or one whose
  // pod is replaced before `for` elapses (series retires out of the range) is
  // silently un-alertable — a terminal loss that pages nobody. The gauge is
  // re-derived from committed rows every reconcile pass, so it survives both.
  assert.match(
    rendered,
    /or \(sum\(paperclip_github_review_request_dead_letter_unresolved\) > 0\)/,
    "dead-letter alert must also key on the restart-safe durable gauge",
  );
});

test("PaperclipGithubReviewRequestSuppressionOutage pages on outage-like causes only (BLO-18859)", () => {
  const rendered = execFileSync(
    "helm",
    [
      "template",
      "paperclip",
      "deploy/helm/paperclip",
      "--namespace",
      "paperclip",
      "-f",
      "deploy/helm/paperclip/values.blockcast.yaml",
      "--show-only",
      "templates/prometheusrule.yaml",
      "--set",
      "prometheusRule.enabled=true",
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );

  assert.match(rendered, /alert: PaperclipGithubReviewRequestSuppressionOutage/);
  const [, expr] = rendered.match(
    /alert: PaperclipGithubReviewRequestSuppressionOutage[\s\S]*?\n\s+expr: (.+)\n/,
  ) ?? [];
  assert.ok(expr, "suppression alert must render an expr");

  // Must key on the cause-breakdown counter, not the funnel state: alerting on
  // delivery_total{state="suppressed"} would page on every expected decline.
  assert.match(
    expr,
    /increase\(paperclip_github_review_request_suppression_total\{cause=~"[^"]+"\}\[[^\]]+\]\)\) > 0$/,
    "suppression alert must select a cause regex on the suppression counter and fire only on a strictly positive increase",
  );

  const [, causes] = expr.match(/cause=~"([^"]+)"/) ?? [];
  const selected = causes.split("|");
  // The outage cases. `other` is deliberately pageable: it means the server
  // emitted a skip reason missing from KNOWN_GITHUB_SUPPRESSION_CAUSES, which
  // has not been triaged as an expected decline.
  for (const cause of ["heartbeat.scheduling_suppressed", "dispatch_rejected", "other"]) {
    assert.ok(selected.includes(cause), `outage-like cause ${cause} must be alertable`);
  }
  // The whole point of the cause split: a paused company or a cooldown is the
  // fleet correctly declining. Paging on those would force an operator to
  // silence the rule, which is what left a stuck scheduling-suppression flag
  // unalertable in the first place.
  for (const expected of [
    "company.inactive",
    "heartbeat.cooldown.active",
    "heartbeat.disabled",
    "heartbeat.wakeOnDemand.disabled",
    "budget.blocked",
    "agent.not_invokable",
    "heartbeat.worktree_execution_cutoff",
    "issue_tree_hold_active",
  ]) {
    assert.ok(
      !selected.includes(expected),
      `expected policy decline ${expected} must not page`,
    );
  }
});

test("PaperclipPrReviewWakeTerminalFailed is pr_review-scoped, gauge-keyed, and links its runbook (BLO-20255)", () => {
  const rendered = execFileSync(
    "helm",
    [
      "template",
      "paperclip",
      "deploy/helm/paperclip",
      "--namespace",
      "paperclip",
      "-f",
      "deploy/helm/paperclip/values.blockcast.yaml",
      "--show-only",
      "templates/prometheusrule.yaml",
      "--set",
      "prometheusRule.enabled=true",
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );

  assert.match(rendered, /alert: PaperclipPrReviewWakeTerminalFailed/);
  const [, expr] = rendered.match(
    /alert: PaperclipPrReviewWakeTerminalFailed[\s\S]*?\n\s+expr: (.+)\n/,
  ) ?? [];
  assert.ok(expr, "terminal-failed alert must render an expr");

  // Pin the scope selector AND the age gauge.
  //
  // Scope: dropping the selector would sum scope="other" too, and ordinary
  // issue wakes that failed are re-driven by the issue's own lifecycle --
  // paging on those trains the operator to ignore this alert.
  //
  // Age gauge: this must threshold
  // paperclip_agent_wakeup_terminal_failed_oldest_age_seconds, NOT a summed
  // count under a long `for:`. A `for:` clause measures how long the
  // EXPRESSION has been continuously true, not how long any one row has been
  // failed. With `sum(..._unresolved{scope="pr_review"}) > 0` and `for: 30m`,
  // two different short failures overlapping by a single scrape hold the sum
  // non-zero across the whole window: A carries it 29 minutes, B arrives as A
  // clears, the expression never goes false, and B pages about a minute old
  // while the annotation claims thirty. Splitting on error_code does not help,
  // because the expression sums that label away. The age gauge carries the
  // server-computed per-row age, so the threshold means what it says.
  assert.match(
    expr,
    /^max\(paperclip_agent_wakeup_terminal_failed_oldest_age_seconds\{scope="pr_review"\}\) > (\d+)$/,
    "terminal-failed alert must threshold the per-row age gauge for scope=pr_review, "
      + "not a summed count under a long `for:`",
  );

  const [, ageThreshold] = expr.match(/> (\d+)$/) ?? [];
  // The gauge is zero-initialized and reset to 0 for a scope with no
  // unresolved rows, so a strictly-positive threshold is the
  // silent-in-steady-state guarantee. `> 0` would page on a row that failed
  // one second ago.
  assert.ok(
    Number(ageThreshold) > 0,
    "age threshold must be strictly positive so a zero-valued gauge is silent",
  );
  // Past the 45m HARD_STALE window would be ideal but 30m is the tuned start
  // per the issue AC; anything at or under the 10m second bounded-retry step
  // would race a retry that has not yet written its successor rows.
  assert.ok(
    Number(ageThreshold) >= 1800,
    `age threshold ${ageThreshold}s must be at least 1800s (30m) per the BLO-20255 AC`,
  );

  const [, forWindow] = rendered.match(
    /alert: PaperclipPrReviewWakeTerminalFailed[\s\S]*?\n\s+for: (.+)\n/,
  ) ?? [];
  // `for:` is now scrape-flap tolerance ONLY -- the ageing lives in the
  // threshold above. It must stay short: a long `for:` here would stack on top
  // of the age threshold and delay the page well past the intended window.
  assert.ok(forWindow, "terminal-failed alert must render a for window");
  const forMinutes = /^(\d+)m$/.test(forWindow.trim())
    ? Number(forWindow.trim().slice(0, -1))
    : /^(\d+)h$/.test(forWindow.trim())
      ? Number(forWindow.trim().slice(0, -1)) * 60
      : null;
  assert.ok(
    forMinutes !== null && forMinutes > 0 && forMinutes <= 10,
    `for window ${forWindow} must be a short scrape-flap tolerance (<= 10m); `
      + "the ageing belongs in the age-gauge threshold, not here",
  );

  // The runbook link is the operator's decision procedure (re-review vs
  // accept). This is the first paperclip alert to carry runbook_url; without
  // the assertion a future edit drops it silently.
  assert.match(
    rendered,
    /alert: PaperclipPrReviewWakeTerminalFailed[\s\S]*?runbook_url: "[^"]*runbooks\/agent-wakeup-terminal-failed\.md"/,
    "terminal-failed alert must link the runbook from its annotation",
  );
});

test("PaperclipQueuedRunStranded is agent-keyed, freshness-gated, and fires before 30m (BLO-21116)", () => {
  const rendered = renderChart([
    "--show-only",
    "templates/prometheusrule.yaml",
    "--set",
    "prometheusRule.enabled=true",
  ]);

  assert.match(rendered, /alert: PaperclipQueuedRunStranded/);
  const [, expr] = rendered.match(
    /alert: PaperclipQueuedRunStranded[\s\S]*?\n\s+expr: (.+)\n/,
  ) ?? [];
  assert.ok(expr, "queued-run-stranded alert must render an expr");

  // Must threshold the per-agent age gauge, not a summed queued-run count
  // under a long `for:` -- same reasoning as the terminal-failed alert above:
  // a `for:` clause measures how long the EXPRESSION has stayed true, and a
  // summed count across agents lets one agent's strand clearing exactly as
  // another's appears keep the expression permanently true while any one row
  // is young.
  assert.match(
    expr,
    /^max by \(agent_id\) \(paperclip_queued_run_oldest_age_seconds and on\(instance\) \(paperclip_queued_run_age_metrics_refresh_success == 1\)\) > (\d+)$/,
    "queued-run-stranded alert must gate each replica's age before taking the per-agent max",
  );

  const [, ageThreshold] = expr.match(/> (\d+)$/) ?? [];
  // The gauge is reset-then-set to 0 for every known agent on each refresh
  // (see setQueuedRunOldestAgeMetrics), so a strictly positive threshold is
  // the silent-in-steady-state guarantee.
  assert.ok(
    Number(ageThreshold) > 0,
    "age threshold must be strictly positive so a zero-valued gauge is silent",
  );
  const [, forWindow] = rendered.match(
    /alert: PaperclipQueuedRunStranded[\s\S]*?\n\s+for: (.+)\n/,
  ) ?? [];
  // `for:` is scrape-flap tolerance only -- the ageing lives in the threshold
  // above. It must stay short so it does not stack on top of the age
  // threshold and delay the page well past the AC's ~30m intent.
  assert.ok(forWindow, "queued-run-stranded alert must render a for window");
  const forMinutes = /^(\d+)m$/.test(forWindow.trim())
    ? Number(forWindow.trim().slice(0, -1))
    : /^(\d+)h$/.test(forWindow.trim())
      ? Number(forWindow.trim().slice(0, -1)) * 60
      : null;
  assert.ok(
    forMinutes !== null && forMinutes > 0 && forMinutes <= 10,
    `for window ${forWindow} must be a short scrape-flap tolerance (<= 10m); `
      + "the ageing belongs in the age-gauge threshold, not here",
  );

  // BLO-21116's own AC is "firing before the age exceeds ~30m" -- the FIRST
  // real-clock moment the alert can fire, which is threshold + for, not the
  // threshold in isolation. Checking each independently is exactly the gap
  // Ally's review caught here: a bare threshold of 1800s (30m) with this
  // same 5m `for:` does not fire until 2100s (35m) of real age, past the AC,
  // even though 1800 alone looks compliant and 5m alone looks short.
  assert.ok(
    Number(ageThreshold) + forMinutes * 60 <= 1800,
    `age threshold ${ageThreshold}s plus for-window ${forWindow} stacks to `
      + `${Number(ageThreshold) + forMinutes * 60}s, past the 1800s (30m) BLO-21116 AC`,
  );

  assert.match(
    rendered,
    /alert: PaperclipQueuedRunStranded[\s\S]*?runbook_url: "[^"]*runbooks\/queued-run-stranded\.md"/,
    "queued-run-stranded alert must link the runbook from its annotation",
  );
});

test("PaperclipQueuedRunAgeMetricsRefreshFailed exposes a stale snapshot instead of hiding it", () => {
  const rendered = renderChart([
    "--show-only",
    "templates/prometheusrule.yaml",
    "--set",
    "prometheusRule.enabled=true",
  ]);

  assert.match(
    rendered,
    /alert: PaperclipQueuedRunAgeMetricsRefreshFailed[\s\S]*?\n\s+expr: paperclip_queued_run_age_metrics_refresh_success == 0\n/,
    "a failed queued-run-age refresh must have its own alert",
  );
  assert.match(
    rendered,
    /alert: PaperclipQueuedRunAgeMetricsRefreshFailed[\s\S]*?runbook_url: "[^"]*runbooks\/queued-run-stranded\.md"/,
    "the freshness failure alert must route responders to the queued-run runbook",
  );
});

test("PaperclipAgentJobBackoffLimitExceeded is deleted, not just renamed (BLO-23413)", () => {
  // BLO-23413: this alert was verified structurally unable to fire on the
  // live cluster (kube-state-metrics only ever emits ONE post-failure
  // sample per ac-* Job before the object is deleted, so rate()/increase()
  // -- which need >=2 samples -- can never compute a value). It must stay
  // deleted; a permanently-inert rule is worse than none because its
  // presence implies coverage that does not exist.
  const rendered = renderChart(["--set", "prometheusRule.enabled=true"]);
  assert.doesNotMatch(
    rendered,
    /alert: PaperclipAgentJobBackoffLimitExceeded/,
    "PaperclipAgentJobBackoffLimitExceeded must not be re-added without a fresh live-series proof (BLO-23413)",
  );
});

test("PaperclipAgentHeartbeatStale is an outcome-side per-agent-interval alert (BLO-23413)", () => {
  const rendered = renderChart(["--set", "prometheusRule.enabled=true"]);

  assert.match(rendered, /alert: PaperclipAgentHeartbeatStale/);
  const [, expr] = rendered.match(
    /alert: PaperclipAgentHeartbeatStale[\s\S]*?\n\s+expr: (.+)\n/,
  ) ?? [];
  assert.ok(expr, "heartbeat-stale alert must render an expr");

  // Must threshold as a MULTIPLE of the agent's OWN configured interval via
  // an `on (agent_id)` join, not one fleet-wide constant -- a fleet runs
  // agents with different heartbeat.intervalSec, and a constant threshold
  // would be wrong for every agent not on the modal interval.
  //
  // BLO-23413 review fix: the multiplier must sit INSIDE the parenthesised
  // right-hand operand, and both sides must be pre-aggregated with
  // `max by (agent_id)`. The original form
  //   age > N * on (agent_id) interval
  // bound the matching modifier to the `*` (scalar left operand) and failed
  // to parse; and even with the parens fixed, the un-aggregated form is a
  // many-to-many match because every control-plane pod exports its own copy
  // of these gauges. Both were reproduced against live Prometheus (HTTP 400
  // and HTTP 422 respectively). See the template comment for the full proof.
  assert.match(
    expr,
    /^max by \(agent_id\) \(paperclip_agent_heartbeat_age_seconds\) > on \(agent_id\) \(\d+ \* max by \(agent_id\) \(paperclip_agent_heartbeat_interval_seconds\)\)$/,
    "heartbeat-stale alert must threshold max-by-agent age against max-by-agent interval*multiplier, joined 1:1 on agent_id",
  );

  const [, multiplier] = expr.match(/\((\d+) \* max by/) ?? [];
  assert.ok(
    Number(multiplier) >= 3,
    `heartbeat-stale multiplier ${multiplier} must be at least 3x per the BLO-23413 AC`,
  );

  const [, forWindow] = rendered.match(
    /alert: PaperclipAgentHeartbeatStale[\s\S]*?\n\s+for: (.+)\n/,
  ) ?? [];
  assert.ok(forWindow, "heartbeat-stale alert must render a for window");
});

// BLO-23413. The bug this guards against shipped once and the existing
// per-alert test did not catch it -- worse, that test pinned the broken string
// as if it were correct, so the regex was actively enforcing the defect.
//
// PromQL permits a vector-matching modifier (`on (...)` / `ignoring (...)`)
// only BETWEEN TWO INSTANT VECTORS. Writing `age > 3 * on (agent_id) interval`
// binds the modifier to the `*`, whose left operand is the scalar `3`, and the
// whole rule then fails to parse -- Prometheus returns a query error and the
// alert can never fire. That is the same silently-inert-rule class this file
// deleted PaperclipAgentJobBackoffLimitExceeded for, so re-introducing one
// would be a straight regression of the issue's own premise.
//
// SCOPE, stated honestly: this is a targeted structural guard for that one
// defect class, NOT a PromQL parser. Full parse+evaluation validation needs
// `promtool check rules` / `promtool test rules`, which requires a promtool
// binary this job does not install, and which belongs with the copies that
// actually render live (Blockcast/onprem-k8s) rather than with this chart copy
// -- the file header notes prometheusRule.enabled=false for Blockcast values,
// so nothing here reaches a live Prometheus. This guard is cheap, hermetic and
// catches the specific mistake that was made; it is not a substitute for
// promtool, and should not be described as one.
test("no rendered alert applies a vector-matching modifier to a scalar operand (BLO-23413)", () => {
  const rendered = renderChart(["--set", "prometheusRule.enabled=true"]);

  const exprs = [...rendered.matchAll(/^\s+expr:\s*(.+?)\s*$/gm)].map(
    ([, expr]) => expr,
  );
  assert.ok(
    exprs.length > 0,
    "expected the PrometheusRule to render at least one expr to check",
  );

  // Match `<operand> <binop> on|ignoring (`; flag it when <operand> is a bare
  // numeric literal. `metric > on (...)` and `) > on (...)` are both fine.
  const modifierJoin =
    /([A-Za-z_:][A-Za-z0-9_:]*|\d+(?:\.\d+)?|\))\s*(\*|\/|%|\^|\+|-|==|!=|>=|<=|>|<)\s*(on|ignoring)\s*\(/g;

  const offenders = [];
  for (const expr of exprs) {
    for (const [, lhs, op, mod] of expr.matchAll(modifierJoin)) {
      if (/^\d/.test(lhs)) {
        offenders.push(`${expr}\n    (scalar '${lhs}' ${op} ${mod} (...))`);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `vector-matching modifier applied to a scalar operand -- this rule cannot ` +
      `parse and will never fire. Put the scalar inside the parenthesised ` +
      `vector operand instead, e.g. 'a > on (l) (3 * b)' not ` +
      `'a > 3 * on (l) b':\n  ${offenders.join("\n  ")}`,
  );
});

// BLO-23413. Second defect found in review of the same alert: fixing the parse
// error alone is NOT sufficient. These agent gauges are published from the
// reconcileFailedWakeDispatches pass, and EVERY control-plane pod running that
// pass exports its own copy -- measured live, the sibling metric from the same
// pass (paperclip_agent_wakeup_terminal_failed_unresolved) is present on 3 pods
// x 16 agents = 48 series. With 3 series per agent_id on each side, a bare
// `on (agent_id)` join is many-to-many and errors at RUNTIME with HTTP 422
// "found duplicate series for the match group" -- reproduced directly against
// that metric. Pre-aggregating each side with `max by (agent_id)` collapses it
// to a 1:1 join, yields exactly one alert per dark agent instead of one per
// replica, and keeps alert identity stable across pod restarts.
test("agent_id-joined alerts pre-aggregate both sides (multi-replica safe, BLO-23413)", () => {
  const rendered = renderChart(["--set", "prometheusRule.enabled=true"]);

  const exprs = [...rendered.matchAll(/^\s+expr:\s*(.+?)\s*$/gm)].map(
    ([, expr]) => expr,
  );

  const unaggregated = exprs.filter((expr) => {
    if (!/\bon\s*\(\s*agent_id\s*\)/.test(expr)) return false;
    // Every bare selector of a per-agent control-plane gauge must be wrapped in
    // an aggregation that collapses the instance/pod dimension.
    const bareSelectors = [
      ...expr.matchAll(/(^|[^)\w])(paperclip_agent_[a-z0-9_]+)/g),
    ].map(([, , name]) => name);
    return bareSelectors.some(
      (name) =>
        !new RegExp(
          `(max|min|avg|sum|count)\\s+by\\s*\\(\\s*agent_id\\s*\\)\\s*\\(\\s*${name}\\s*\\)`,
        ).test(expr),
    );
  });

  assert.deepEqual(
    unaggregated,
    [],
    `an alert joins on agent_id without collapsing the per-pod dimension. ` +
      `Every control-plane replica exports its own copy of these gauges, so a ` +
      `bare 'on (agent_id)' join is many-to-many and fails at evaluation time ` +
      `with "found duplicate series for the match group". Wrap each side in ` +
      `'max by (agent_id) (...)':\n  ${unaggregated.join("\n  ")}`,
  );
});

test("PaperclipOverdueScheduledRetry is agent-keyed, gauge-thresholded, and links its runbook (BLO-22094)", () => {
  const rendered = renderChart([
    "--show-only",
    "templates/prometheusrule.yaml",
    "--set",
    "prometheusRule.enabled=true",
  ]);

  assert.match(rendered, /alert: PaperclipOverdueScheduledRetry/);
  const [, expr] = rendered.match(
    /alert: PaperclipOverdueScheduledRetry\n[\s\S]*?\n\s+expr: (.+)\n/,
  ) ?? [];
  assert.ok(expr, "overdue-scheduled-retry alert must render an expr");

  // Must threshold the per-agent overdue-parked-age gauge, not a summed
  // scheduled_retry row count under a long `for:` -- same reasoning as
  // PaperclipQueuedRunStranded above. The `and on(instance) (... == 1)`
  // freshness gate is load-bearing and asserted here rather than left
  // optional: refreshOverdueScheduledRetryAgeMetrics only reset-then-sets on
  // its success path, so a failed refresh freezes the last per-agent values
  // while /metrics still returns 200 -- and the frozen value is almost always
  // 0, the HEALTHY reading. Ungated, this alert would sit silently green on
  // top of a dead detector, the exact invisible failure BLO-22094 exists to
  // close. The gate must sit INSIDE the `max by (agent_id)` because
  // `on(instance)` needs the instance label the aggregation strips.
  assert.match(
    expr,
    /^max by \(agent_id\) \(paperclip_overdue_scheduled_retry_oldest_age_seconds and on\(instance\) \(paperclip_overdue_scheduled_retry_age_metrics_refresh_success == 1\)\) > (\d+)$/,
    "overdue-scheduled-retry alert must gate each replica's age on its own "
      + "freshness gauge before taking the per-agent max",
  );

  const [, ageThreshold] = expr.match(/> (\d+)$/) ?? [];
  // The gauge is reset-then-set to 0 for every known agent on each refresh
  // (see setOverdueScheduledRetryAgeMetrics), so a strictly positive
  // threshold is the silent-in-steady-state guarantee.
  assert.ok(
    Number(ageThreshold) > 0,
    "age threshold must be strictly positive so a zero-valued gauge is silent",
  );

  const [, forWindow] = rendered.match(
    /alert: PaperclipOverdueScheduledRetry\n[\s\S]*?\n\s+for: (.+)\n/,
  ) ?? [];
  // `for:` is scrape-flap tolerance only -- the ageing lives in the
  // threshold above, derived from a 7-day population (see values.yaml
  // comment), not from `for:` duration.
  assert.ok(forWindow, "overdue-scheduled-retry alert must render a for window");
  const forMinutes = /^(\d+)m$/.test(forWindow.trim())
    ? Number(forWindow.trim().slice(0, -1))
    : /^(\d+)h$/.test(forWindow.trim())
      ? Number(forWindow.trim().slice(0, -1)) * 60
      : null;
  assert.ok(
    forMinutes !== null && forMinutes > 0 && forMinutes <= 10,
    `for window ${forWindow} must be a short scrape-flap tolerance (<= 10m); `
      + "the ageing belongs in the age-gauge threshold, not here",
  );

  assert.match(
    rendered,
    /alert: PaperclipOverdueScheduledRetry\n[\s\S]*?runbook_url: "[^"]*runbooks\/queued-run-stranded\.md#overdue-scheduled-retry-blo-22094"/,
    "overdue-scheduled-retry alert must link the runbook from its annotation",
  );

  // A run merely backing off (scheduled_retry_at in the future) must never
  // read as overdue -- the gauge only ages off rows already past due, so a
  // strictly-greater-than comparison against a positive threshold is the
  // only way this alert can stay silent for designed backoff.
  assert.match(expr, />/, "overdue-scheduled-retry alert must use a strict greater-than comparison");
});

test("PaperclipOverdueScheduledRetryAgeMetricsRefreshFailed exposes a stale snapshot instead of hiding it (BLO-22094)", () => {
  const rendered = renderChart([
    "--show-only",
    "templates/prometheusrule.yaml",
    "--set",
    "prometheusRule.enabled=true",
  ]);

  // Closing the freshness gate on PaperclipOverdueScheduledRetry silences it.
  // Without a companion alert on the gate itself, that silence is
  // indistinguishable from a healthy fleet -- the detector would be dead and
  // nothing would say so.
  assert.match(
    rendered,
    /alert: PaperclipOverdueScheduledRetryAgeMetricsRefreshFailed[\s\S]*?\n\s+expr: paperclip_overdue_scheduled_retry_age_metrics_refresh_success == 0\n/,
    "a failed overdue-scheduled_retry-age refresh must have its own alert",
  );
  assert.match(
    rendered,
    /alert: PaperclipOverdueScheduledRetryAgeMetricsRefreshFailed[\s\S]*?runbook_url: "[^"]*runbooks\/queued-run-stranded\.md#overdue-scheduled-retry-blo-22094"/,
    "the freshness failure alert must route responders to the overdue-scheduled-retry runbook section",
  );

  // The two refreshes query different aggregates behind different indexes
  // (0217 for status='queued', 0224 for the overdue-parked predicate), so
  // this must be its OWN series -- sharing the sibling's freshness gauge
  // would let a healthy queued-run refresh vouch for a dead one.
  assert.doesNotMatch(
    rendered,
    /alert: PaperclipOverdueScheduledRetry\n[\s\S]*?\n\s+expr: [^\n]*paperclip_queued_run_age_metrics_refresh_success/,
    "the overdue alert must gate on its own freshness gauge, not the sibling's",
  );
});

test("PaperclipPlugin{Critical,}Errored key on the boolean gauge, split severity by plugin_key, and preserve error!=disabled (BLO-21092)", () => {
  const rendered = execFileSync(
    "helm",
    [
      "template",
      "paperclip",
      "deploy/helm/paperclip",
      "--namespace",
      "paperclip",
      "-f",
      "deploy/helm/paperclip/values.blockcast.yaml",
      "--show-only",
      "templates/prometheusrule.yaml",
      "--set",
      "prometheusRule.enabled=true",
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );

  assert.match(rendered, /alert: PaperclipPluginCriticalErrored/);
  assert.match(rendered, /alert: PaperclipPluginErrored/);

  // Both alerts key on the boolean gauge with a strict equality, not a
  // summed/thresholded count -- paperclip_plugin_error is already 0/1 per
  // plugin, so `== 1` is the whole condition.
  const [, criticalExpr] = rendered.match(
    /alert: PaperclipPluginCriticalErrored[\s\S]*?\n\s+expr: (.+)\n/,
  ) ?? [];
  const [, warningExpr] = rendered.match(
    /alert: PaperclipPluginErrored[\s\S]*?\n\s+expr: (.+)\n/,
  ) ?? [];
  assert.match(criticalExpr, /^paperclip_plugin_error\{plugin_key=~"[^"]+"\} == 1$/);
  assert.match(warningExpr, /^paperclip_plugin_error\{plugin_key!~"[^"]+"\} == 1$/);

  // Default critical key regex must select lucitra.plugin-secrets -- the
  // exact plugin BLO-20410 found dead for 9+ hours with nothing alerting --
  // and the two alerts' selectors must be exact complements (same regex, one
  // positive one negative) so a plugin can never dual-fire nor fall through
  // both.
  const [, criticalRegex] = criticalExpr.match(/plugin_key=~"([^"]+)"/) ?? [];
  const [, warningRegex] = warningExpr.match(/plugin_key!~"([^"]+)"/) ?? [];
  assert.ok(criticalRegex, "critical alert must render a plugin_key=~ selector");
  assert.equal(criticalRegex, warningRegex, "critical and warning selectors must be exact complements");
  // Compare against the raw rendered (PromQL-string-escaped) text rather than
  // constructing a JS RegExp from it -- criticalRegex is still PromQL/Go
  // string-literal-escaped (e.g. a literal dot renders as `\\.`), so
  // re-parsing it as a JS regex source would double-decode the escaping.
  assert.ok(
    criticalRegex.includes("plugin-secrets"),
    `default critical key regex ${criticalRegex} must select lucitra.plugin-secrets`,
  );

  const [, criticalSeverity] = rendered.match(
    /alert: PaperclipPluginCriticalErrored[\s\S]*?severity: (\w+)/,
  ) ?? [];
  const [, warningSeverity] = rendered.match(
    /alert: PaperclipPluginErrored[\s\S]*?severity: (\w+)/,
  ) ?? [];
  assert.equal(criticalSeverity, "critical");
  assert.equal(warningSeverity, "warning");

  // Both alerts must render a `for:` grace period so a deploy's brief
  // activation retry (BLO-978) does not page.
  for (const alertName of ["PaperclipPluginCriticalErrored", "PaperclipPluginErrored"]) {
    const [, forWindow] = rendered.match(
      new RegExp(`alert: ${alertName}[\\s\\S]*?\\n\\s+for: (.+)\\n`),
    ) ?? [];
    assert.ok(forWindow, `${alertName} must render a for window`);
  }

  assert.match(
    rendered,
    /alert: PaperclipPluginCriticalErrored[\s\S]*?runbook_url: "[^"]*runbooks\/plugin-error\.md"/,
    "critical plugin-error alert must link the runbook",
  );
  assert.match(
    rendered,
    /alert: PaperclipPluginErrored[\s\S]*?runbook_url: "[^"]*runbooks\/plugin-error\.md"/,
    "plugin-error alert must link the runbook",
  );
});

test("PaperclipPluginStatusCollectorStale watches the collector's own heartbeat, not the plugin data it produces (BLO-21092 review follow-up)", () => {
  const rendered = execFileSync(
    "helm",
    [
      "template",
      "paperclip",
      "deploy/helm/paperclip",
      "--namespace",
      "paperclip",
      "-f",
      "deploy/helm/paperclip/values.blockcast.yaml",
      "--show-only",
      "templates/prometheusrule.yaml",
      "--set",
      "prometheusRule.enabled=true",
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );

  assert.match(rendered, /alert: PaperclipPluginStatusCollectorStale/);

  const [, expr] = rendered.match(
    /alert: PaperclipPluginStatusCollectorStale[\s\S]*?\n\s+expr: (.+)\n/,
  ) ?? [];
  assert.match(
    expr,
    /^\(time\(\) - paperclip_plugin_status_collector_last_success_timestamp_seconds\{role="worker"\}\) > \d+$/,
    "collector-stale alert must key on time() minus the last-success gauge, not on paperclip_plugin_error itself, "
      + "and must select role=\"worker\" -- Ally review: the gauge is a bare (zero-label) series is what prom-client "
      + "auto-publishes at 0 from construction alone with no .set() call, so without this label an API-tier pod "
      + "(which never starts the collector) would freeze the series at 0 and permanently satisfy this expr there",
  );

  const [, forWindow] = rendered.match(
    /alert: PaperclipPluginStatusCollectorStale[\s\S]*?\n\s+for: (.+)\n/,
  ) ?? [];
  assert.ok(forWindow, "collector-stale alert must render a for window");

  assert.match(
    rendered,
    /alert: PaperclipPluginStatusCollectorStale[\s\S]*?runbook_url: "[^"]*runbooks\/plugin-error\.md"/,
    "collector-stale alert must link the runbook",
  );
});

test("PaperclipPluginStatusCollectorStale's role label prevents an API-tier target from permanently satisfying the expr (BLO-21092 Ally review: mixed API/worker topology)", () => {
  // Simulates production's actual mixed topology at the PromQL level, since
  // this repo's Helm tests render text rather than evaluate rules against
  // live series (no promtool in this environment). paperclip_plugin_error and
  // the collector-freshness gauge are worker-tier-only in reality; the API
  // tier's /metrics registers the SAME metric names (shared registry code)
  // but, per the Ally fix, never calls the setter that would attach the
  // role="worker" label -- so an API-tier scrape contributes no series for
  // this metric name at all. A regex-selected instant vector like
  // `metric{role="worker"}` is unaffected by unrelated series under the same
  // name; only an unlabeled/wildcard selector would wrongly match both.
  const rendered = execFileSync(
    "helm",
    [
      "template",
      "paperclip",
      "deploy/helm/paperclip",
      "--namespace",
      "paperclip",
      "-f",
      "deploy/helm/paperclip/values.blockcast.yaml",
      "--show-only",
      "templates/prometheusrule.yaml",
      "--set",
      "prometheusRule.enabled=true",
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );

  const [, expr] = rendered.match(
    /alert: PaperclipPluginStatusCollectorStale[\s\S]*?\n\s+expr: (.+)\n/,
  ) ?? [];
  assert.ok(expr, "collector-stale alert must render an expr");
  assert.doesNotMatch(
    expr,
    /paperclip_plugin_status_collector_last_success_timestamp_seconds\s*[)>]/,
    "the metric selector must not be a bare/unlabeled reference -- a bare gauge is what auto-publishes at 0 on "
      + "every tier including API, which is exactly the false-fire this alert must not reintroduce",
  );
});
