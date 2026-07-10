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

test("Blockcast values do not render a ServiceMonitor (paperclip-ci-deploy has no RBAC for it)", () => {
  // BLO-14591: the paperclip-ci-deploy ServiceAccount that runs `helm upgrade`
  // has no RBAC grant on servicemonitors.monitoring.coreos.com either (same
  // gap as prometheusRule, BLO-14556). If this flag flips back to true
  // without that grant, every deploy fails at "helm upgrade" (not just
  // skips the resource) and blocks the whole company.
  const rendered = renderChart();

  assert.doesNotMatch(
    rendered,
    /kind: ServiceMonitor/,
    "values.blockcast.yaml must keep serviceMonitor.enabled=false until paperclip-ci-deploy is granted RBAC on servicemonitors.monitoring.coreos.com",
  );
});

test("serviceMonitor.enabled=true still renders the ServiceMonitor (flag remains usable once RBAC exists)", () => {
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
      "templates/servicemonitor.yaml",
      "--set",
      "serviceMonitor.enabled=true",
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );

  assert.match(rendered, /kind: ServiceMonitor/);
  assert.match(rendered, /name: paperclip/);
});
