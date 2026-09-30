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

test("under api.enabled=true, the ServiceMonitor's selector matches both the API and worker Services (BLO-21092 Ally review: worker-only metrics like paperclip_plugin_error must stay reachable)", () => {
  // The API/worker split (BLO-8xxx) puts worker-tier-only metrics --
  // paperclip_plugin_error and paperclip_plugin_status_collector_last_success_timestamp_seconds
  // among them -- exclusively on worker pods, reachable only through the
  // `paperclip-workers` Service (service-workers.yaml), not the primary
  // `paperclip` Service (which routes to API pods once api.enabled=true --
  // see paperclip.serviceSelectorLabels in _helpers.tpl). A ServiceMonitor
  // selector narrowed to just the primary Service's distinguishing label
  // (app.kubernetes.io/component: api) would render clean and pass every
  // other test here while silently making worker-only series permanently
  // unscraped. Assert the selector is exactly the shared name+instance
  // labels -- present on BOTH Services -- and does NOT include `component`,
  // which is what keeps both Endpoints objects in scope.
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
      "--show-only",
      "templates/service.yaml",
      "--show-only",
      "templates/service-workers.yaml",
      "--set",
      "serviceMonitor.enabled=true",
      "--set",
      "api.enabled=true",
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );

  const documents = rendered.split(/^---$/m).filter((doc) => doc.trim().length > 0);
  const findDoc = (kindPattern, namePattern) =>
    documents.find((doc) => kindPattern.test(doc) && namePattern.test(doc));

  const serviceMonitorDoc = findDoc(/kind: ServiceMonitor/, /name: paperclip\s*$/m);
  const apiServiceDoc = findDoc(/kind: Service\s*$/m, /name: paperclip\s*$/m);
  const workerServiceDoc = findDoc(/kind: Service\s*$/m, /name: paperclip-workers\s*$/m);
  assert.ok(serviceMonitorDoc, "must render a ServiceMonitor");
  assert.ok(apiServiceDoc, "must render the primary (API-tier) Service");
  assert.ok(workerServiceDoc, "must render the worker-tier Service");

  const [, matchLabelsBlock] = serviceMonitorDoc.match(
    /selector:\s*\n\s+matchLabels:\s*\n((?:\s{4,}.+\n)+)/,
  ) ?? [];
  assert.ok(matchLabelsBlock, "ServiceMonitor must render a selector.matchLabels block");
  const requiredLabels = [...matchLabelsBlock.matchAll(/^\s*([\w./-]+):\s*(.+)$/gm)].map(
    ([, key, value]) => [key, value.trim()],
  );
  assert.ok(requiredLabels.length > 0, "must parse at least one required label from matchLabels");

  assert.doesNotMatch(
    matchLabelsBlock,
    /app\.kubernetes\.io\/component/,
    "ServiceMonitor selector must not key on app.kubernetes.io/component -- that label is what "
      + "distinguishes the API Service from the worker Service, so selecting on it would exclude one of them",
  );

  for (const doc of [
    ["primary (API-tier)", apiServiceDoc],
    ["worker-tier", workerServiceDoc],
  ]) {
    const [tierName, serviceDoc] = doc;
    const [, labelsBlock] = serviceDoc.match(/^metadata:\n(?:.*\n)*?\s+labels:\s*\n((?:\s{4,}.+\n)+)/m) ?? [];
    assert.ok(labelsBlock, `${tierName} Service must render metadata.labels`);
    for (const [key, value] of requiredLabels) {
      assert.match(
        labelsBlock,
        new RegExp(`^\\s*${key.replace(/[./]/g, "\\$&")}:\\s*${value.replace(/[".]/g, "\\$&")}\\s*$`, "m"),
        `${tierName} Service must carry ServiceMonitor-required label ${key}: ${value}, or it drops out of scrape scope`,
      );
    }
  }
});
