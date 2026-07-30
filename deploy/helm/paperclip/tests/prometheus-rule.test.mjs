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
    rendered,
    /kube_pod_status_unschedulable/,
    "kube_pod_status_unschedulable is not portable across kube-state-metrics builds; do not reintroduce it",
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
