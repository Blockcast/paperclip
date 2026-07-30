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
