import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
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
  // re-derived from committed rows on every heartbeat scheduler tick, so it
  // survives both. (BLO-31335 moved that emission off the wake-dispatch
  // reconcile pass, which only ran on an unsuppressed replica.)
  //
  // BLO-31335: the aggregation is pinned, not just the metric name. This gauge
  // is a full rewrite of global, DB-derived state, so it is replica-invariant —
  // every publishing pod exports the same value. A bare `sum()` therefore
  // multiplies by the replica count (3× today) and silently rescales on any
  // replica-count change. `max by (reason)` collapses the pod dimension first;
  // the outer `sum` then adds the 8 reason buckets, which a bare `max()` would
  // have undercounted to the single largest bucket. Both halves are load-bearing
  // and neither is recoverable from `promtool check rules` or a render test.
  assert.match(
    rendered,
    /or \(sum\(max by \(reason\) \(paperclip_github_review_request_dead_letter_unresolved\)\) > 0\)/,
    "dead-letter alert must key on the restart-safe durable gauge, aggregated replica-safely",
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

  // BLO-31335: the description hands the responder a query, and since this
  // gauge moved onto the scheduler tick EVERY replica publishes it with the
  // same value (full rewrite of global DB-derived state). So the aggregation
  // has to be spelled out and it has to be replica-invariant -- a bare
  // `sum by (error_code)` reads 3x on a 3-replica deploy. The rule's own
  // `expr` is unaffected (it is the replica-invariant max() over the age
  // gauge, asserted above), which is exactly why this can rot unnoticed: no
  // rendered expression breaks, only the human following the instructions.
  const [, terminalFailedDescription] = rendered.match(
    /alert: PaperclipPrReviewWakeTerminalFailed[\s\S]*?\n\s+description: "([\s\S]*?)"\n/,
  ) ?? [];
  assert.ok(
    terminalFailedDescription,
    "terminal-failed alert must render a description annotation",
  );
  assert.match(
    terminalFailedDescription,
    /max by \(error_code, scope\)/,
    "terminal-failed description must name the replica-invariant aggregation "
      + "(max by (error_code, scope)), matching the metric's own help string",
  );
  assert.doesNotMatch(
    terminalFailedDescription,
    /Break down by the `error_code` label on the count series/,
    "terminal-failed description must not tell the responder to break the "
      + "count series down without naming an aggregation -- the natural "
      + "reading is `sum by (error_code)`, which multiplies by replica count",
  );
});

test("the terminal-failed runbook describes the post-BLO-31335 emission path", () => {
  // The sibling of the description guard above, on the other side of
  // `runbook_url`. BLO-31335 moved both wake-dispatch gauges off
  // `reconcileFailedWakeDispatches` and onto the heartbeat scheduler tick,
  // which silently falsified the runbook's "No data" triage step -- it sent an
  // on-call responder mid-incident to check a pass that can no longer suppress
  // these series. Nothing rendered breaks when this rots (the chart does not
  // read the runbook at all), so only an assertion catches it, and this is the
  // page an operator lands on from the alert.
  const runbook = readFileSync(
    path.join(repoRoot, "runbooks/agent-wakeup-terminal-failed.md"),
    "utf8",
  );

  // Split at the status table so the two halves can be asserted apart. The
  // table's `reconcileFailedWakeDispatches` mentions describe which ROWS that
  // pass selects, which BLO-31335 did not change -- they must survive, so this
  // guard must never be satisfiable by a blanket find-and-replace.
  //
  // The -1 check is load-bearing, not defensive boilerplate. `indexOf` returns
  // -1 when the heading is renamed, and `slice(-1)` yields the file's LAST
  // CHARACTER rather than "", which is truthy and matches no phrase -- so
  // without this, `assert.ok` below would pass on a one-character string and
  // the `doesNotMatch` regression guard would pass vacuously, while
  // `slice(0, -1)` widened the row-selection assertion to the whole file. A
  // guard that cannot fire is the same defect class this PR exists to remove.
  const verifyIndex = runbook.indexOf("## Verifying the signal is live");
  assert.notStrictEqual(
    verifyIndex,
    -1,
    "runbook must keep a 'Verifying the signal is live' section -- the "
      + "assertions below scope themselves to it by name and silently stop "
      + "guarding if it is renamed",
  );
  const verifySection = runbook.slice(verifyIndex);

  assert.doesNotMatch(
    verifySection,
    /reconcile pass/,
    "runbook liveness section must not attribute gauge emission to the "
      + "reconcile pass -- since BLO-31335 both gauges publish from the "
      + "heartbeat scheduler tick, so a stalled reconcile no longer explains "
      + "'No data' and sends the responder to the wrong subsystem",
  );
  assert.match(
    verifySection,
    /heartbeat scheduler tick/,
    "runbook liveness section must name the heartbeat scheduler tick as the "
      + "emission path to check",
  );

  // The row-selection statements outside the liveness section are correct and
  // load-bearing; assert they survive so a future sweep of the phrase above
  // cannot take them with it.
  assert.match(
    runbook.slice(0, verifyIndex),
    /`reconcileFailedWakeDispatches` only ever\nselects `dispatch_failed`/,
    "runbook must keep the row-selection statement -- BLO-31335 changed which "
      + "path EMITS the gauges, not which rows that pass selects",
  );

  // Same replica-invariance rule as the alert description: every replica
  // publishes the same value, so a bare `sum` reads 3x on a 3-replica deploy.
  assert.match(
    verifySection,
    /sum\(max by \(error_code, scope\) \(paperclip_agent_wakeup_terminal_failed_unresolved/,
    "runbook copy-paste query must use the replica-invariant aggregation, "
      + "matching the alert description it sits one hop from",
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

test("PaperclipPrReviewQueueWaitSaturated uses the bounded p95 histogram and runbook", () => {
  const rendered = renderChart(["--show-only", "templates/prometheusrule.yaml", "--set", "prometheusRule.enabled=true"]);
  assert.match(rendered, /alert: PaperclipPrReviewQueueWaitSaturated/);
  assert.match(rendered, /histogram_quantile\(0\.95, sum by \(le\) \(rate\(paperclip_pr_review_queue_wait_seconds_bucket\[6h\]\)\)\) > 3600/);
  assert.match(rendered, /alert: PaperclipPrReviewQueueWaitSaturated[\s\S]*?for: 10m/);
  assert.match(rendered, /alert: PaperclipPrReviewQueueWaitSaturated[\s\S]*?runbook_url: "[^\"]*runbooks\/pr-review-queue-wait\.md"/);
});

test("PaperclipRuntimeResourceReconciliationStuck pins both backlog gauges and the worker-down backstop (BLO-21460)", () => {
  const rendered = renderChart(["--set", "prometheusRule.enabled=true"]);

  assert.match(rendered, /alert: PaperclipRuntimeResourceReconciliationStuck/);
  const [, expr] = rendered.match(
    /alert: PaperclipRuntimeResourceReconciliationStuck[\s\S]*?\n\s+expr: >-?\n([\s\S]*?)\n\s+for:/,
  ) ?? [];
  assert.ok(expr, "runtime-resource-reconciliation-stuck alert must render an expr");

  assert.match(
    expr,
    /max\(paperclip_external_runtime_reservations_release_pending\) > 0/,
    "must page on a stuck release-pending external-runtime reservation",
  );
  assert.match(
    expr,
    /max\(paperclip_environment_leases_orphaned_active\) > 0/,
    "must page on an orphaned-active environment lease",
  );
  // The two count arms above read a healthy 0 when the sweep that publishes
  // them throws, because prom-client gauges retain their last value and the
  // process stays up. Without this arm the alert is silent during exactly the
  // kube-API outage its own description tells the operator to check for.
  assert.match(
    expr,
    /max\(paperclip_orphaned_runtime_resource_metrics_refresh_success\)\s*==\s*0/,
    "must page when the reconciliation sweep stops refreshing the backlog gauges, so a stale 0 cannot read as healthy",
  );
  // max(), not a bare comparison: every control-plane pod exports the gauge
  // but only the worker runs the sweep, so a bare `== 0` would fire forever on
  // the api pods' untouched initial 0.
  assert.doesNotMatch(
    expr,
    /(?<!max\()paperclip_orphaned_runtime_resource_metrics_refresh_success\s*==\s*0/,
    "freshness arm must aggregate with max() so non-sweeping pods cannot hold it firing",
  );
  assert.match(
    expr,
    /max\(up\{job="paperclip-control-plane", service="paperclip-workers"\}\)\s*==\s*0/,
    "must page when the worker scrape target is down",
  );
  assert.match(
    expr,
    /absent\(up\{job="paperclip-control-plane", service="paperclip-workers"\}\)/,
    "must alert when the worker scrape target disappears entirely",
  );
  assert.doesNotMatch(
    expr,
    /max by \(job\)/,
    "must scope availability to the worker service, not aggregate API and worker targets",
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

test("PaperclipScheduledRetryParkHorizonImplausible has an independent horizon threshold and freshness alert (BLO-25036)", () => {
  const rendered = renderChart([
    "--show-only",
    "templates/prometheusrule.yaml",
    "--set",
    "prometheusRule.enabled=true",
  ]);

  const [, expr] = rendered.match(
    /alert: PaperclipScheduledRetryParkHorizonImplausible\n[\s\S]*?\n\s+expr: (.+)\n/,
  ) ?? [];
  assert.match(
    expr ?? "",
    /^max by \(agent_id\) \(paperclip_scheduled_retry_park_horizon_seconds and on\(instance\) \(paperclip_scheduled_retry_park_horizon_refresh_success == 1\)\) > (\d+)$/,
  );
  const [, threshold] = expr.match(/> (\d+)$/) ?? [];
  assert.equal(threshold, "5400");
  assert.match(
    rendered,
    /alert: PaperclipScheduledRetryParkHorizonImplausible[\s\S]*?runbook_url: "[^\"]*runbooks\/queued-run-stranded\.md#scheduled-retry-park-horizon-blo-25036"/,
  );
  assert.match(
    rendered,
    /alert: PaperclipScheduledRetryParkHorizonMetricsRefreshFailed[\s\S]*?\n\s+expr: paperclip_scheduled_retry_park_horizon_refresh_success == 0\n/,
  );
  assert.match(
    rendered,
    /alert: PaperclipScheduledRetryParkHorizonMetricsRefreshFailed[\s\S]*?runbook_url: "[^\"]*runbooks\/queued-run-stranded\.md#scheduled-retry-park-horizon-blo-25036"/,
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

  // The critical key regex must select lucitra.plugin-secrets -- the exact
  // plugin BLO-20410 found dead for 9+ hours with nothing alerting -- and
  // paperclip-plugin-alertmanager (PEN-2590), whose failure at warning
  // severity suppresses the very notification reporting it. The two alerts'
  // selectors must be exact complements (same regex, one positive one
  // negative) so a plugin can never dual-fire nor fall through both.
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
  // PEN-2590. Asserted as its own member of the alternation rather than by
  // substring on the whole regex, because `paperclip-plugin-alertmanager` is
  // the plugin's manifest id verbatim and the two keys deliberately use
  // DIFFERENT naming conventions (dotted namespace for externally published
  // plugins, bare hyphenated id for local workspace ones). A regex written on
  // the assumption of one convention silently selects nothing for the other,
  // and a selector matching nothing is a permanently-inert rule rather than a
  // visible failure -- the PEN-2579 class this guards against.
  const criticalKeys = criticalRegex.split("|");
  assert.ok(
    criticalKeys.includes("paperclip-plugin-alertmanager"),
    `critical key regex ${criticalRegex} must select paperclip-plugin-alertmanager exactly (PEN-2590): ` +
      "at warning severity PaperclipPluginErrored's only route is the `paperclip` webhook catch-all, " +
      "whose endpoint is gated on this plugin's own readiness, so the alert is delivered into the " +
      "receiver that is failing because this plugin is failing. critical fans out to slack-relay instead.",
  );
  // The alternation must stay anchorable: no member may be empty (a stray `|`
  // yields an empty branch, which Prometheus anchors to `^$` and therefore
  // matches the EMPTY plugin_key -- quietly promoting label-less series into
  // the paging tier while looking like a harmless typo).
  for (const key of criticalKeys) {
    assert.ok(
      key.length > 0,
      `critical key regex ${criticalRegex} has an empty alternation branch, which matches an empty plugin_key`,
    );
  }

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

test("PaperclipPluginStatusCollectorAbsent covers the worker-down case the staleness rule structurally cannot (BLO-21092 Ally review)", () => {
  // The staleness rule is `(time() - <gauge>) > N` with a `for:` window. That
  // shape can only fire while the series is still queryable, so it catches a
  // collector that is stuck behind a live scrape target and MISSES the worse
  // case: worker down, crashlooping, or never started. There the last sample
  // sits at ~= time() when scraping stopped, so the difference is ~= 0 then
  // and only crosses N at t ~= N -- the same moment Prometheus's lookback
  // delta drops the series from instant queries. True for ~0s, so `for:`
  // never completes. absent_over_time() is the required companion because it
  // reports TRUE on an empty range instead of needing the series to survive.
  const rendered = renderChart(["--set", "prometheusRule.enabled=true"]);

  assert.match(
    rendered,
    /alert: PaperclipPluginStatusCollectorAbsent/,
    "an absence guard must accompany the staleness guard, or a dead/never-started collector is silent forever",
  );

  const [, expr] = rendered.match(
    /alert: PaperclipPluginStatusCollectorAbsent[\s\S]*?\n\s+expr: (.+)\n/,
  ) ?? [];
  assert.ok(expr, "collector-absent alert must render an expr");

  // Must use absent_over_time over a range -- `absent()` on an instant vector
  // is subject to the same lookback-delta eviction that defeats the
  // subtraction form, and a plain `== 0`/threshold cannot represent absence.
  assert.match(
    expr,
    /absent_over_time\(\s*paperclip_plugin_status_collector_last_success_timestamp_seconds\{role="worker"\}\[\d+[smh]\]\s*\)/,
    "absence must be expressed as absent_over_time(<gauge>{role=\"worker\"}[window]) so it is TRUE on an empty range",
  );

  // The window must exceed Prometheus's 5m lookback delta, otherwise a single
  // missed scrape or a rolling worker restart reads as a vanished series.
  const [, win, unit] = expr.match(/\[(\d+)([smh])\]/) ?? [];
  const seconds = Number(win) * (unit === "h" ? 3600 : unit === "m" ? 60 : 1);
  assert.ok(
    seconds > 300,
    `absence window must exceed the 5m lookback delta to be unambiguous, got ${win}${unit}`,
  );

  // Absence is strictly worse than staleness: with no series at all,
  // paperclip_plugin_error is absent too, which is indistinguishable on a
  // dashboard from every plugin being healthy -- the BLO-20410 failure mode.
  const [, block] = rendered.match(
    /alert: PaperclipPluginStatusCollectorAbsent([\s\S]*?)(?=\n\s+- alert:|\n\s{0,4}\S|$)/,
  ) ?? [];
  assert.match(
    block ?? "",
    /severity: critical/,
    "an absent collector must page critical -- it renders the plugin gauges invisible, not merely stale",
  );
});

test("PaperclipExternalRuntimeReservationStranded gates on strand state, not raw reservation age (BLO-28865)", () => {
  const rendered = renderChart([
    "--show-only",
    "templates/prometheusrule.yaml",
    "--set",
    "prometheusRule.enabled=true",
  ]);

  assert.match(rendered, /alert: PaperclipExternalRuntimeReservationStranded/);
  const [, expr] = rendered.match(
    /alert: PaperclipExternalRuntimeReservationStranded[\s\S]*?\n\s+expr: (.+)\n/,
  ) ?? [];
  assert.ok(expr, "stranded-reservation alert must render an expr");
  assert.doesNotMatch(
    expr,
    /paperclip_external_runtime_reservation_oldest_age_seconds/,
    "stranded-reservation alert must not threshold raw reservation age",
  );
  assert.match(
    expr,
    /^max by \(agent_id\) \(paperclip_external_runtime_reservation_stranded_oldest_age_seconds and on\(instance\) \(paperclip_external_runtime_reservation_strand_metrics_refresh_success == 1\)\) > (\d+)$/,
  );
  const [, ageThreshold] = expr.match(/> (\d+)$/) ?? [];
  assert.ok(Number(ageThreshold) > 0);

  const [, forWindow] = rendered.match(
    /alert: PaperclipExternalRuntimeReservationStranded[\s\S]*?\n\s+for: (.+)\n/,
  ) ?? [];
  assert.ok(forWindow, "stranded-reservation alert must render a for window");
  const forMinutes = /^(\d+)m$/.test(forWindow.trim())
    ? Number(forWindow.trim().slice(0, -1))
    : /^(\d+)h$/.test(forWindow.trim())
      ? Number(forWindow.trim().slice(0, -1)) * 60
      : null;
  assert.ok(forMinutes !== null && forMinutes > 0 && forMinutes <= 10);
  assert.ok(Number(ageThreshold) + forMinutes * 60 < 45 * 60);
  assert.match(
    rendered,
    /alert: PaperclipExternalRuntimeReservationStranded[\s\S]*?runbook_url: "[^\"]*runbooks\/external-runtime-reservation-stranded\.md"/,
  );
});

test("PaperclipExternalRuntimeReservationStrandMetricsRefreshFailed exposes a stale snapshot instead of hiding it", () => {
  const rendered = renderChart([
    "--show-only",
    "templates/prometheusrule.yaml",
    "--set",
    "prometheusRule.enabled=true",
  ]);

  assert.match(
    rendered,
    /alert: PaperclipExternalRuntimeReservationStrandMetricsRefreshFailed[\s\S]*?\n\s+expr: paperclip_external_runtime_reservation_strand_metrics_refresh_success == 0\n/,
  );
  assert.match(
    rendered,
    /alert: PaperclipExternalRuntimeReservationStrandMetricsRefreshFailed[\s\S]*?runbook_url: "[^\"]*runbooks\/external-runtime-reservation-stranded\.md"/,
  );
});

test("PaperclipAgentStartLockWedged pages on the abort boundary, so firing means the abort did not land (PEN-3305/PEN-3328)", () => {
  const rendered = renderChart([
    "--show-only",
    "templates/prometheusrule.yaml",
    "--set",
    "prometheusRule.enabled=true",
  ]);

  assert.match(rendered, /alert: PaperclipAgentStartLockWedged/);

  // Slice the one alert block out before asserting anything about its fields.
  // An unbounded `alert: Name[\s\S]*?severity:` matches the FIRST severity
  // anywhere later in the document, so with the alert's own fields absent it
  // would silently borrow a neighbour's -- today it passes only because the
  // next rendered alert happens to be `severity: warning` with a different
  // runbook. Adding any `severity: critical` alert after this group would let
  // a silent downgrade of THIS one to `warning` keep passing.
  const [, block] = rendered.match(
    /\n\s+- alert: PaperclipAgentStartLockWedged\n([\s\S]*?)(?=\n\s+- alert: |\n\s+- name: |$)/,
  ) ?? [];
  assert.ok(block, "wedged-start-lock alert must render its own block");

  const [, expr] = block.match(/\n\s+expr: (.+)\n/) ?? [];
  assert.ok(expr, "wedged-start-lock alert must render an expr");

  // Per-agent max, not a sum: the gauge is published by every replica that
  // serves /metrics, and a sum would add one pod's hold age to another's for
  // the same agent. It must also NOT carry a freshness join -- unlike the
  // queued-run and stranded-reservation gauges there is no separate
  // `..._refresh_success` series, because this one is a synchronous map walk
  // performed on the scrape itself. Asserting the exact shape is what stops a
  // later reader "restoring" a join against a series that does not exist,
  // which would make the alert permanently unevaluable rather than noisy.
  assert.match(
    expr,
    /^max by \(agent_id\) \(paperclip_agent_start_lock_held_seconds\) > (\d+)$/,
    "wedged-start-lock alert must threshold the per-agent max of the hold gauge, with no refresh-freshness join",
  );

  const [, heldThreshold] = expr.match(/> (\d+)$/) ?? [];
  // The gauge is emitted only for locks held at scrape time (reset-then-set,
  // no zero-fill), so any positive threshold is silent in steady state. It is
  // pinned to LOCK_ABORT_MS (14400s / 4h) in
  // server/src/services/agent-start-lock.ts, NOT to LOCK_HELD_ERROR_MS (300s),
  // and that distinction is the whole meaning of the page: the abort fires at
  // this boundary and releases the lock, so a series still present afterwards
  // means the abort was requested and did NOT land. If the constant moves and
  // this does not, the page stops describing that state.
  //
  // ⚠️ PEN-3328: this was "300", tracking LOCK_HELD_ERROR_MS. Do not revert it
  // on the reasoning that the page and the escalated log should share one
  // number of record. Over the 14 days to 2026-09-25, 21 agents held past 300s
  // (peak 8073s) and this alert reached `firing` for 20 of them -- twenty
  // critical pages, all of which resolved on their own, routed by the runbook
  // to pod replacement. A log line is an attention threshold where being early
  // is free; this is a page that routes to a destructive remedy. They answer
  // different questions and no longer share a number.
  assert.equal(
    heldThreshold,
    "14400",
    "hold threshold must track LOCK_ABORT_MS (14400s) in agent-start-lock.ts, not the LOCK_HELD_ERROR_MS log budget",
  );

  const [, forWindow] = block.match(/\n\s+for: (.+)\n/) ?? [];
  assert.ok(forWindow, "wedged-start-lock alert must render a for window");
  const forMinutes = /^(\d+)m$/.test(forWindow.trim())
    ? Number(forWindow.trim().slice(0, -1))
    : /^(\d+)h$/.test(forWindow.trim())
      ? Number(forWindow.trim().slice(0, -1)) * 60
      : null;
  // NOT scrape-flap tolerance, despite the sibling `*For` values that are.
  // Same stacking trap as PaperclipQueuedRunStranded -- threshold and `for:`
  // are not independent, and the sum is what decides whether this page means
  // "the abort did not land" -- but since PEN-3328 this window carries a
  // second, load-bearing job: it is the abort's LANDING BUDGET. This alert and
  // PaperclipAgentStartLockAborted sit on the same 4h boundary, and a landed
  // abort deletes the held series inside a scrape, so this window is the only
  // thing that keeps a recovered section from paging `critical`.
  //
  // ⚠️ Hence a FLOOR, not just a ceiling. The threshold above is pinned to a
  // measurement (> 8073); this window has no equivalent measurement available,
  // because abort-to-release latency cannot be observed until aborts exist in
  // production -- so the floor is the shipped value and the burden is on any
  // edit that lowers it. Anything that delays release past the window
  // (cancellation reaching a fresh connection, a statement tearing down, an
  // unlucky scrape) reintroduces the false-page class PEN-3328 removed.
  // Raising it is safe; lowering it needs evidence, not the "free flap
  // tolerance" reading that values.yaml used to invite.
  assert.ok(
    forMinutes !== null && forMinutes >= 5 && forMinutes <= 10,
    `for window ${forWindow} must be the abort's landing budget (>= 5m), not a bare scrape-flap tolerance, `
      + "and must stay <= 10m so the page still lands promptly. A shorter window pages `critical` on a "
      + "section whose abort landed just after the window opened, which is the false-page class PEN-3328 removed.",
  );
  assert.ok(
    Number(heldThreshold) > 8073,
    `hold threshold ${heldThreshold}s does not clear the observed settling tail (8073s, PEN-3328). `
      + "A critical page below that fires on holds that resolve themselves and routes the responder "
      + "to pod replacement; `for:` cannot rescue it, because a for-window is a continuity requirement "
      + "and not a magnitude one.",
  );

  // Severity, not decoration: past the abort boundary the section's own
  // cancellation has already been requested and failed to release the lock,
  // so what remains is a per-agent dispatch outage lasting until the process
  // is replaced. A warning would reproduce the original failure, which was
  // nobody being paged.
  //
  // ⚠️ That is only true BECAUSE the threshold is the abort boundary. Below
  // it the hold usually settles by itself -- PEN-3328 measured 21 agents past
  // 300s over 14 days, peak 8073s, all self-resolved -- and a critical page
  // there produced twenty false pages routed to pod replacement. Severity and
  // threshold move together or not at all.
  assert.match(
    block,
    /\n\s+severity: critical\n/,
    "a non-self-healing per-agent dispatch outage must page, not warn",
  );
  assert.match(
    block,
    /runbook_url: "[^"]*runbooks\/queued-run-stranded\.md#agent-start-lock-wedged-pen-3305"/,
    "wedged-start-lock alert must link the runbook section from its annotation",
  );
});

test("PaperclipAgentStartLockAborted reports the self-healed wedge the held gauge cannot (PEN-3328)", () => {
  const rendered = renderChart([
    "--show-only",
    "templates/prometheusrule.yaml",
    "--set",
    "prometheusRule.enabled=true",
  ]);

  assert.match(rendered, /alert: PaperclipAgentStartLockAborted/);
  const [, expr] = rendered.match(
    /alert: PaperclipAgentStartLockAborted[\s\S]*?\n\s+expr: (.+)\n/,
  ) ?? [];
  assert.ok(expr, "aborted-start-lock alert must render an expr");

  // A counter over a window, NOT the held gauge. This is the whole reason the
  // rule exists: PEN-3328 cancels a wedged section at the 4h abort boundary,
  // which is the same boundary PaperclipAgentStartLockWedged thresholds on,
  // and the held gauge is emitted only for locks held at scrape time -- so a
  // successful cancellation deletes the series inside the wedge alert's `for:`
  // window and it never fires. Without a durable counter the incident is
  // invisible exactly because it was handled.
  // If a later reader "simplifies" this onto the gauge, that blind spot returns.
  //
  // ⚠️ This assertion pins the rendered STRING and cannot see the semantics it
  // depends on. `increase()` reads `last - first`, so the expression is correct
  // only because `seedAgentStartLockAbortedSeries`
  // (server/src/services/metrics.ts, called from `runExclusively`) publishes
  // the per-agent series at 0 when the lock is taken. Unseeded, the series is
  // born at 1 on the first abort and `increase` evaluates to 0 forever, so this
  // alert would never fire while this test stayed green. The test that actually
  // discriminates lives beside the seed, in
  // server/src/__tests__/agent-start-lock-abort.test.ts ("publishes the abort
  // counter at 0 when the lock is taken"). Change either side and check both.
  assert.match(
    expr,
    /increase\(paperclip_agent_start_lock_aborted_total\[1h\]\) > 0/,
    "aborted alert must read the durable counter over a window, not the transient held gauge",
  );

  // Warning, not critical, and this is the deliberate split from the wedge
  // alert beside it. By the time this fires the lock has been released and the
  // agent is dispatching again, so waking someone is wrong -- but the thing
  // that blocked the section for four hours has NOT been fixed, so staying
  // silent is also wrong.
  assert.match(
    rendered,
    /alert: PaperclipAgentStartLockAborted[\s\S]*?\n\s+severity: warning\n/,
    "a self-healed dispatch wedge must warn rather than page",
  );
  // The anchor is load-bearing, not cosmetic. The wedged section runs "do NOT
  // clear the agent as healthy" and ends in pod replacement; the aborted
  // section opens "Dispatch has already resumed and no queued runs were lost".
  // Linking the wedged anchor here would send a responder to replace a pod that
  // already recovered -- the exact work this alert's description calls
  // unnecessary. Pinned per-alert so the two cannot silently converge again.
  assert.match(
    rendered,
    /alert: PaperclipAgentStartLockAborted[\s\S]*?runbook_url: "[^"]*runbooks\/queued-run-stranded\.md#agent-start-lock-aborted-pen-3328"/,
    "aborted-start-lock alert must link its OWN runbook section, not the wedged one",
  );
  assert.match(
    rendered,
    /alert: PaperclipAgentStartLockWedged[\s\S]*?runbook_url: "[^"]*runbooks\/queued-run-stranded\.md#agent-start-lock-wedged-pen-3305"/,
    "wedged-start-lock alert must keep linking the wedged runbook section",
  );
});

test("PaperclipRecoveryHorizonNoWakeToCurrentOwner{Elevated,Sustained} key on the never_delivered series only and take their thresholds from values (PEN-3000)", () => {
  const rendered = renderChart([
    "--show-only",
    "templates/prometheusrule.yaml",
    "--set",
    "prometheusRule.enabled=true",
    "--set",
    "prometheusRule.recoveryHorizonNoWakeToCurrentOwnerWarnPerDay=2",
    "--set",
    "prometheusRule.recoveryHorizonNoWakeToCurrentOwnerPagePerDay=9",
    "--set",
    "prometheusRule.recoveryHorizonNoWakeToCurrentOwnerPageFor=45m",
  ]);

  // The label selector is the whole point: the metric splits a scheduler-side fault
  // (never_delivered) from the expected background rate of genuine strandings
  // (delivered). A rule on the unlabelled counter would page on the background rate.
  assert.match(
    rendered,
    /alert: PaperclipRecoveryHorizonNoWakeToCurrentOwnerElevated\n\s+expr: sum\(increase\(paperclip_recovery_horizon_expired_total\{delivery="never_delivered"\}\[1d\]\)\) > 2\n\s+for: 10m\n\s+labels:\n\s+severity: warning\n/,
  );
  assert.match(
    rendered,
    /alert: PaperclipRecoveryHorizonNoWakeToCurrentOwnerSustained\n\s+expr: sum\(increase\(paperclip_recovery_horizon_expired_total\{delivery="never_delivered"\}\[1d\]\)\) > 9\n\s+for: 45m\n\s+labels:\n\s+severity: critical\n/,
  );
  assert.doesNotMatch(
    rendered,
    /paperclip_recovery_horizon_expired_total\{delivery="delivered"\}/,
    "the delivered series is the expected background rate and must not have an alert on it",
  );
  // The label is scoped to the current owner (attemptCount restarts on owner churn); the
  // responder-facing text must say so rather than claim the row never woke anyone.
  assert.match(
    rendered,
    /alert: PaperclipRecoveryHorizonNoWakeToCurrentOwnerElevated[\s\S]*?description: "[^"]*for the current owner[^"]*"/,
  );
  // A pager renders the alert NAME and SUMMARY with no metric HELP text attached, so those
  // two carry the scope on their own or the operator reads a lifetime claim the data cannot
  // support. Assert the qualification on both summaries, not just the descriptions.
  assert.match(
    rendered,
    /alert: PaperclipRecoveryHorizonNoWakeToCurrentOwnerElevated[\s\S]*?summary: "[^"]*delivered to their current owner[^"]*"/,
  );
  assert.match(
    rendered,
    /alert: PaperclipRecoveryHorizonNoWakeToCurrentOwnerSustained[\s\S]*?summary: "[^"]*no wake to the current owner[^"]*"/,
  );
  // Regression guard on the wording itself: attemptCount 0 means "no wake reached THIS
  // owner's queue", never "this row woke nobody in its life". An unqualified lifetime
  // phrasing in a name or summary is the defect, so ban the phrasings outright. The \b is
  // load-bearing: without it this also matches the "never delivered" inside the rule
  // comment and the series name, which are the correctly-scoped uses.
  assert.doesNotMatch(
    rendered,
    /\bever delivered/,
    "an unqualified 'ever delivered' overclaims: owner churn restarts attemptCount",
  );
  assert.doesNotMatch(
    rendered,
    /alert: \w*NeverDelivered\w*/,
    "alert names must be current-owner-scoped, not bare NeverDelivered",
  );
});

test("PaperclipCrashRecoveryCandidateIndex{Missing,Unobservable} distinguish a missing index from an unreadable catalog (BLO-21526)", () => {
  // Migration 0226 records COMPLETE on a populated database without building
  // its deferred CREATE INDEX CONCURRENTLY, and its RAISE NOTICE is swallowed
  // by the production client. paperclip_crash_recovery_candidate_index_present
  // is the only channel that states presence out loud; these two rules are
  // what make it actionable. They are a PAIR and neither covers the other's
  // case, so assert both.
  const rendered = renderChart(["--set", "prometheusRule.enabled=true"]);

  const [, missingExpr] = rendered.match(
    /alert: PaperclipCrashRecoveryCandidateIndexMissing[\s\S]*?\n\s+expr: (.+)\n/,
  ) ?? [];
  assert.ok(missingExpr, "index-missing alert must render an expr");

  // `== 0` is the real-absence arm. It can only fire while the series exists,
  // which is precisely why the companion below is required rather than
  // optional.
  assert.match(
    missingExpr,
    /paperclip_crash_recovery_candidate_index_present\)? == 0/,
    "the missing-index arm must key on the gauge reading 0, not on its absence",
  );

  // The aggregation must KEEP the `index` label. It is the only place the
  // index name survives onto the firing alert — everywhere else it is prose in
  // the description — and a bare `max()` would OR a second deferred index into
  // one series the moment one is published through this gauge.
  assert.match(
    missingExpr,
    /max by \(index\) \(/,
    "aggregate with max by (index) so the firing alert names which index is missing",
  );

  const [, absentExpr] = rendered.match(
    /alert: PaperclipCrashRecoveryCandidateIndexUnobservable[\s\S]*?\n\s+expr: (.+)\n/,
  ) ?? [];
  assert.ok(absentExpr, "index-unobservable alert must render an expr");

  // The load-bearing assertion, and the same invariant
  // PaperclipPluginStatusCollectorAbsent carries. The gauge is CLEARED, not
  // zeroed, when the catalog probe throws — so on an unreadable catalog the
  // `== 0` rule above has no series to compare and is structurally silent,
  // which on a dashboard is indistinguishable from a present, healthy index.
  // absent_over_time() is the required primitive because it is TRUE on an
  // empty range; instant `absent()` under a `for:` window is entangled with
  // Prometheus's lookback delta, and no threshold form can represent absence
  // at all.
  assert.match(
    absentExpr,
    /absent_over_time\(\s*paperclip_crash_recovery_candidate_index_present\s*\[\d+[smh]\]\s*\)/,
    'absence must be absent_over_time(<gauge>[window]) so it is TRUE on an empty range',
  );

  // The window debounces rolling restarts, so a `for:` on top would silently
  // double the detection delay and re-introduce the lookback entanglement the
  // range form exists to avoid.
  //
  // Scope the search to THIS alert's own block before asserting absence. A
  // lazy `[\s\S]*?` against the whole document just expands until it finds a
  // `for:` in some later alert, so the naive form fails on a correct chart —
  // and would equally have passed on a broken one for the wrong reason.
  const [, unobservableBlock] = rendered.match(
    /(alert: PaperclipCrashRecoveryCandidateIndexUnobservable[\s\S]*?)(?=\n\s+- alert:|\n\s+- name:|$)/,
  ) ?? [];
  assert.ok(unobservableBlock, "index-unobservable alert must render a block");
  assert.doesNotMatch(
    unobservableBlock,
    /\n\s+for:/,
    "absent_over_time already debounces via its range; an additional for: is redundant and misleading",
  );

  // A responder who reads "cannot observe" as "probably fine" reproduces the
  // exact silent-on-healthy defect this issue closed, so the text must refuse
  // that reading rather than merely imply it.
  assert.match(
    rendered,
    /alert: PaperclipCrashRecoveryCandidateIndexUnobservable[\s\S]*?description: "[^"]*NOT evidence the index is healthy[^"]*"/,
    "the unobservable alert must state that absence is not health",
  );

  // Same defect class, on the other rule: remediation that does not match the
  // code. The gauge publisher is registered ABOVE both scheduler gates, so
  // this alert is reachable from a suppressed replica — and `startServer`
  // takes the suppressed branch and never calls reconcileWorkerCrashedRuns,
  // so an unqualified "startup recovery still runs" tells a responder crashed
  // runs are partly covered when nothing is recovering them at all. The
  // qualifier is the assertion; scope it to this alert's own block so a
  // greedy match cannot borrow text from a sibling rule.
  const [, missingBlock] = rendered.match(
    /(alert: PaperclipCrashRecoveryCandidateIndexMissing[\s\S]*?)(?=\n\s+- alert:|\n\s+- name:|$)/,
  ) ?? [];
  assert.ok(missingBlock, "index-missing alert must render a block");
  assert.match(
    missingBlock,
    /PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS[\s\S]*?skips startup recovery/,
    "the missing-index remediation must name suppression as the state to check first and say it skips startup recovery too",
  );
  assert.doesNotMatch(
    missingBlock,
    /startup recovery still runs/,
    "an unqualified 'startup recovery still runs' is false on a suppressed replica, which is exactly where this alert is newly reachable",
  );
  // resolveHeartbeatSchedulingSuppression accepts EITHER restore variable
  // (heartbeat.ts: PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS || PAPERCLIP_RESTORE_IN_PROGRESS).
  // Naming only the long one sends a responder to check one variable, read it
  // unset, and conclude the replica is unsuppressed while the alias is what is
  // suppressing it — the same remediation-does-not-match-the-code defect this
  // block exists to fix, reintroduced inside the fix.
  assert.match(
    missingBlock,
    /PAPERCLIP_RESTORE_IN_PROGRESS/,
    "the remediation must name the restore alias too, since either variable alone suppresses",
  );
});
