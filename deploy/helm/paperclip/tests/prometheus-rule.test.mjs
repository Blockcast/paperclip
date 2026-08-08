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

test("PaperclipQueuedRunStranded uses per-agent queue-entry age and fires before 30 minutes (BLO-21116)", () => {
  const rendered = renderChart([
    "--show-only",
    "templates/prometheusrule.yaml",
    "--set",
    "prometheusRule.enabled=true",
  ]);

  assert.match(rendered, /alert: PaperclipQueuedRunStranded/);
  const [, expression] = rendered.match(
    /alert: PaperclipQueuedRunStranded[\s\S]*?\n\s+expr: (.+)\n/,
  ) ?? [];
  assert.ok(expression, "queued-run stranded alert must render an expression");
  assert.match(
    expression,
    /^max\(paperclip_queued_run_oldest_age_seconds\) by \(agent_id\) > \d+$/,
    "the alert must threshold the per-agent queue-age gauge, not a count",
  );

  const [, threshold] = expression.match(/> (\d+)$/) ?? [];
  const [, hold] = rendered.match(
    /alert: PaperclipQueuedRunStranded[\s\S]*?\n\s+for: (\d+)m\n/,
  ) ?? [];
  assert.ok(threshold && hold, "queued-run stranded alert must have numeric age and hold values");
  assert.ok(
    Number(threshold) + Number(hold) * 60 <= 1_800,
    "age threshold plus alert hold must fire before 30 minutes of real queue wait",
  );
  assert.match(
    rendered,
    /coalesce\(queued_at, created_at\).*order by coalesce\(queued_at, created_at\) asc/,
    "the responder query must use the same queue-entry timestamp as the gauge",
  );
  assert.match(
    rendered,
    /alert: PaperclipQueuedRunStranded[\s\S]*?runbook_url: "[^"]*runbooks\/queued-run-stranded\.md"/,
    "queued-run stranded alert must link the operational runbook",
  );
});
