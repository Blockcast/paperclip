import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

const TEMPLATE = "templates/grafana-dashboard-runtime.yaml";
const DASHBOARD_KEY = "runtime-run-queue-health.json";

const QUEUED = "paperclip_queued_run_oldest_age_seconds";
const OVERDUE = "paperclip_overdue_scheduled_retry_oldest_age_seconds";

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

/**
 * Pull the dashboard back out of the RENDERED ConfigMap rather than reading
 * dashboards/*.json directly -- same rationale as
 * tests/grafana-dashboard.test.mjs: it proves the block-scalar indentation
 * survives templating and that `__PAPERCLIP_DS_UID__` was substituted. Reading
 * the source file would assert neither.
 */
function renderDashboard(extraArgs = []) {
  const rendered = renderChart(["--show-only", TEMPLATE, ...extraArgs]);

  const marker = `${DASHBOARD_KEY}: |`;
  const start = rendered.indexOf(marker);
  assert.notEqual(start, -1, `rendered ConfigMap has no ${DASHBOARD_KEY} key`);

  const body = rendered
    .slice(rendered.indexOf("\n", start) + 1)
    .split("\n")
    .reduce(
      (acc, line) => {
        if (!acc.open) return acc;
        if (line.trim() === "") return acc;
        if (!line.startsWith("    ")) return { ...acc, open: false };
        return { ...acc, lines: [...acc.lines, line.slice(4)] };
      },
      { open: true, lines: [] },
    )
    .lines.join("\n");

  return { rendered, dashboard: JSON.parse(body) };
}

const allTargets = (dashboard) =>
  dashboard.panels.flatMap((panel) =>
    (panel.targets ?? []).map((target) => ({ panel, target })),
  );

test("Blockcast values render the runtime dashboard ConfigMap with the sidecar label (BLO-23450)", () => {
  // Without this exact label pair the ConfigMap deploys fine and no dashboard
  // ever appears. That silent-success is the whole failure mode.
  const rendered = renderChart();

  assert.match(
    rendered,
    /name: paperclip-grafana-dashboard-runtime-run-queue-health/,
    "Blockcast values must render the runtime run-queue dashboard ConfigMap",
  );

  const doc = renderChart(["--show-only", TEMPLATE]);
  assert.match(
    doc,
    /^\s+grafana_dashboard: "1"$/m,
    'dashboard ConfigMap must carry grafana_dashboard: "1" or the Grafana sidecar will not adopt it',
  );
});

test("runtime dashboard is a core ConfigMap, not a monitoring.coreos.com CRD", () => {
  // paperclip-ci-deploy is bound to ClusterRole/admin in the paperclip
  // namespace, which covers configmaps but NOT the monitoring.coreos.com CRDs.
  // A CRD-backed kind here 403s the entire `helm upgrade`, not just this
  // resource -- same trap templates/prometheusrule.yaml is disabled for.
  const rendered = renderChart(["--show-only", TEMPLATE]);

  assert.match(rendered, /^kind: ConfigMap$/m);
  assert.doesNotMatch(
    rendered,
    /apiVersion:\s*(monitoring\.coreos\.com|integreatly\.org|grafana\.integreatly\.org)/,
    "must stay a core ConfigMap; CRD-backed kinds 403 the paperclip-ci-deploy service account",
  );
});

test("every runtime panel target is pinned to a datasource uid that can see paperclip_* series", () => {
  // Only the `cluster` datasource scrapes the paperclip control plane. A panel
  // pointed at `thanos` or `prometheus-monitoring` renders "No data" while
  // looking perfectly healthy in review.
  const { dashboard } = renderDashboard();

  const uids = new Set(
    allTargets(dashboard).map(({ target }) => target.datasource?.uid),
  );

  assert.deepEqual([...uids], ["cluster"]);
  assert.ok(
    !JSON.stringify(dashboard).includes("__PAPERCLIP_DS_UID__"),
    "the datasource placeholder must be substituted at render time",
  );
});

test("both the queue-window and park-window gauges are charted (BLO-23450 acceptance criterion)", () => {
  const { dashboard } = renderDashboard();
  const exprs = allTargets(dashboard).map(({ target }) => target.expr ?? "");

  for (const metric of [QUEUED, OVERDUE]) {
    assert.ok(
      exprs.some((expr) => expr.includes(metric)),
      `dashboard must chart ${metric}`,
    );
  }
});

test("the two age panels sit side by side so park- and queue-window read together (BLO-23450)", () => {
  // The acceptance criterion is specifically "positioned next to" -- the whole
  // point is comparing the two windows at a glance. Same row, adjacent
  // columns, equal height.
  const { dashboard } = renderDashboard();

  const byMetric = (metric) =>
    dashboard.panels.find(
      (panel) =>
        panel.type === "timeseries" &&
        (panel.targets ?? []).some((target) => target.expr?.includes(metric)),
    );

  const queued = byMetric(QUEUED);
  const overdue = byMetric(OVERDUE);
  assert.ok(queued, "expected a timeseries panel for the queued-age gauge");
  assert.ok(overdue, "expected a timeseries panel for the overdue-retry gauge");

  assert.equal(
    queued.gridPos.y,
    overdue.gridPos.y,
    "the two age panels must share a row",
  );
  assert.equal(
    queued.gridPos.x + queued.gridPos.w,
    overdue.gridPos.x,
    "the overdue-retry panel must sit immediately to the right of the queued-age panel",
  );
  assert.equal(queued.gridPos.h, overdue.gridPos.h);
});

test("age gauges are aggregated with max by (agent_id), never summed across replicas", () => {
  // The gauges are emitted by EVERY control-plane replica with identical
  // values -- measured 2026-09-02: 3 pods across service=paperclip (2) and
  // service=paperclip-workers (1), 46 agent series each. sum() therefore
  // reports triple the real age and still looks like a plausible number, which
  // is exactly the kind of wrong that survives review.
  const { dashboard } = renderDashboard();

  const ageTargets = allTargets(dashboard).filter(
    ({ target }) =>
      target.expr?.includes(QUEUED) || target.expr?.includes(OVERDUE),
  );
  assert.ok(ageTargets.length >= 2, "expected the age gauges to back panels");

  for (const { panel, target } of ageTargets) {
    assert.match(
      target.expr,
      /max by \(agent_id\)/,
      `panel '${panel.title}' must collapse replicas with max by (agent_id)`,
    );
    assert.doesNotMatch(
      target.expr,
      /\bsum\s*(by\s*\([^)]*\)\s*)?\(/,
      `panel '${panel.title}' sums a per-replica gauge; that multiplies the age by the replica count`,
    );
  }
});

test("the refresher-health panel is present so a frozen gauge cannot read as healthy", () => {
  // If the refresh loop dies the age gauges keep serving their last value
  // forever. A stale gauge and a healthy one are pixel-identical on every
  // other panel, so the freshness signal has to be charted explicitly.
  const { dashboard } = renderDashboard();

  const target = allTargets(dashboard).find(({ target }) =>
    target.expr?.includes(
      "paperclip_overdue_scheduled_retry_age_metrics_refresh_success",
    ),
  );
  assert.ok(target, "dashboard must chart the refresh-success gauge");
  assert.match(
    target.target.expr,
    /^min\(/,
    "refresh health must be min() across replicas; one failing replica is already a stale gauge",
  );
});

test("grafanaDashboard.enabled=false renders no runtime ConfigMap", () => {
  const rendered = renderChart(["--set", "grafanaDashboard.enabled=false"]);

  assert.doesNotMatch(
    rendered,
    /paperclip-grafana-dashboard-runtime-run-queue-health/,
    "disabling the flag must drop the dashboard ConfigMap entirely",
  );
});

test("the runtime dashboard datasource uid is overridable", () => {
  const { dashboard } = renderDashboard([
    "--set",
    "grafanaDashboard.datasourceUid=some-other-prom",
  ]);

  const uids = new Set(
    allTargets(dashboard).map(({ target }) => target.datasource?.uid),
  );
  assert.deepEqual([...uids], ["some-other-prom"]);
});
