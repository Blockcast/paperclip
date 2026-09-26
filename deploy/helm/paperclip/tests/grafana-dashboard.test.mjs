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

const DASHBOARD_KEY = "github-review-request-funnel.json";
const PLATFORM_KEY = "paperclip-platform.json";

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
 * Render the dashboard ConfigMap and pull the embedded dashboard back out as a
 * parsed object. Going through the rendered ConfigMap rather than reading
 * dashboards/*.json directly is the point: it proves the block-scalar
 * indentation survives templating and that the `__PAPERCLIP_DS_UID__`
 * placeholder was substituted. Reading the source file would assert neither.
 */
function renderDashboard(extraArgs = [], key = DASHBOARD_KEY) {
  const rendered = renderChart([
    "--show-only",
    "templates/grafana-dashboard.yaml",
    ...extraArgs,
  ]);

  const marker = `${key}: |`;
  const start = rendered.indexOf(marker);
  assert.notEqual(start, -1, `rendered ConfigMap has no ${key} key`);

  const body = rendered
    .slice(rendered.indexOf("\n", start) + 1)
    .split("\n")
    // The block scalar is indented 4 spaces; stop at the first line that is
    // neither blank nor part of the block.
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

test("Blockcast values render the Grafana dashboard ConfigMap with the sidecar label (BLO-20171)", () => {
  // The kiwigrid sidecar on orc8r-user-grafana watches LABEL=grafana_dashboard
  // / LABEL_VALUE=1 with NAMESPACE=ALL. Without this exact label pair the
  // ConfigMap is inert -- it deploys fine and no dashboard ever appears, which
  // is the silent-failure mode this test exists to catch.
  const rendered = renderChart();

  assert.match(
    rendered,
    /name: paperclip-grafana-dashboard-review-request-funnel/,
    "Blockcast values must render the review-request funnel dashboard ConfigMap",
  );
  assert.match(
    rendered,
    /^\s+grafana_dashboard: "1"$/m,
    'dashboard ConfigMap must carry grafana_dashboard: "1" or the Grafana sidecar will not adopt it',
  );
});

test("dashboard ConfigMap is a core ConfigMap, not a monitoring.coreos.com CRD (BLO-14032/BLO-14556 trap)", () => {
  // prometheusRule and serviceMonitor are both disabled on Blockcast because
  // paperclip-ci-deploy has no RBAC on monitoring.coreos.com, and enabling them
  // 403s the entire `helm upgrade` rather than skipping the resource. This
  // dashboard is deliberately a plain ConfigMap, which ClusterRole/admin (bound
  // via paperclip-ci-deploy-admin) does cover. Pin that so nobody "upgrades"
  // this to a GrafanaDashboard CRD and silently breaks every deploy.
  const rendered = renderChart([
    "--show-only",
    "templates/grafana-dashboard.yaml",
  ]);

  assert.match(rendered, /^kind: ConfigMap$/m);
  assert.doesNotMatch(
    rendered,
    /apiVersion:\s*(monitoring\.coreos\.com|integreatly\.org|grafana\.integreatly\.org)/,
    "the dashboard must stay a core ConfigMap; CRD-backed kinds 403 the paperclip-ci-deploy service account",
  );
});

test("every dashboard target is pinned to a datasource uid that can see paperclip_* series (BLO-21025)", () => {
  // Only the `cluster` datasource (http://prometheus.monitoring.svc:9090)
  // scrapes the paperclip control plane. `thanos` is the Grafana default and
  // `prometheus-monitoring` is the orc8r one; a panel pointed at either renders
  // "No data" while looking perfectly healthy in review.
  const { dashboard } = renderDashboard();

  const uids = new Set(
    allTargets(dashboard).map(({ target }) => target.datasource?.uid),
  );

  assert.deepEqual(
    [...uids],
    ["cluster"],
    "all panel targets must query the `cluster` datasource uid",
  );
  assert.ok(
    !JSON.stringify(dashboard).includes("__PAPERCLIP_DS_UID__"),
    "the datasource placeholder must be substituted at render time",
  );
});

test("the funnel panel plots all four required delivery states (BLO-20171 acceptance criterion)", () => {
  const { dashboard } = renderDashboard();

  const funnel = dashboard.panels.find((panel) =>
    panel.title.startsWith("Delivery funnel by state"),
  );
  assert.ok(funnel, "dashboard must carry a delivery-funnel panel");

  const expr = funnel.targets.map((target) => target.expr).join("\n");
  assert.match(expr, /paperclip_github_review_request_delivery_total/);

  for (const state of ["received", "queued", "retried", "dead_lettered"]) {
    assert.ok(
      expr.includes(state),
      `funnel panel must plot the '${state}' delivery state`,
    );
  }
});

test("every funnel panel filters to a single service tier so the promoter cannot corrupt the arithmetic (BLO-20171)", () => {
  // paperclip-0 is the promoter and carries service="paperclip-workers". It
  // emits `queued` with no matching `received`, so any panel that aggregates
  // both tiers shows queued > received and reads as a broken funnel. The
  // invariant received == queued + suppressed + deferred + dead_lettered holds
  // only within service="paperclip".
  const { dashboard } = renderDashboard();

  const deliveryTargets = allTargets(dashboard).filter(({ target }) =>
    target.expr?.includes("paperclip_github_review_request_delivery_total"),
  );
  assert.ok(
    deliveryTargets.length >= 4,
    "expected the delivery counter to back several panels",
  );

  for (const { panel, target } of deliveryTargets) {
    assert.match(
      target.expr,
      /service="paperclip(-workers)?"/,
      `panel '${panel.title}' queries the delivery counter without a service selector; it would mix the promoter into the funnel`,
    );
  }

  // The promoter must be charted on its own panel, never summed into a funnel
  // panel alongside the API tier.
  const promoterPanels = deliveryTargets.filter(({ target }) =>
    target.expr.includes('service="paperclip-workers"'),
  );
  assert.equal(
    promoterPanels.length,
    1,
    "the promoter tier belongs on exactly one dedicated panel",
  );
  assert.ok(
    !promoterPanels[0].target.expr.includes('service="paperclip"'),
    "the promoter panel must not also aggregate the API tier",
  );
});

test("the restart-safe dead-letter gauge is on the dashboard (BLO-20171 acceptance criterion)", () => {
  const { dashboard } = renderDashboard();

  const gaugeTargets = allTargets(dashboard).filter(({ target }) =>
    target.expr?.includes("paperclip_github_review_request_dead_letter_unresolved"),
  );

  assert.ok(
    gaugeTargets.length >= 1,
    "dashboard must chart paperclip_github_review_request_dead_letter_unresolved",
  );

  // Steady state is zero, so the panel has to make a non-zero value obvious
  // rather than rendering it as just another number.
  const [{ panel }] = gaugeTargets;
  const steps = panel.fieldConfig?.defaults?.thresholds?.steps ?? [];
  assert.ok(
    steps.some((step) => step.color === "red" && step.value === 1),
    "the dead-letter gauge must turn red at 1; an unresolved dead-letter is a permanently lost review",
  );
});

test("the suppression-cause counter is charted (BLO-20171 acceptance criterion)", () => {
  const { dashboard } = renderDashboard();

  const exprs = allTargets(dashboard).map(({ target }) => target.expr ?? "");
  assert.ok(
    exprs.some((expr) =>
      expr.includes("paperclip_github_review_request_suppression_total"),
    ),
    "dashboard must chart paperclip_github_review_request_suppression_total",
  );
  assert.ok(
    exprs.some(
      (expr) =>
        expr.includes("paperclip_github_review_request_suppression_total") &&
        expr.includes("by (cause)"),
    ),
    "suppression must be broken down by cause; the aggregate mixes expected declines with outages",
  );
});

test("the dead-letter alert annotation links to this dashboard (BLO-20171 acceptance criterion)", () => {
  // An operator paged by PaperclipGithubReviewRequestDeadLettered should not
  // have to go hunting for the panel. NOTE: this chart's PrometheusRule is
  // disabled on Blockcast -- the copy that actually fires lives in
  // Blockcast/onprem-k8s monitoring/prometheus-rules-2-configmap.yaml, and this
  // assertion does NOT reach it. See templates/prometheusrule.yaml.
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

  const alertBlock = rendered.slice(
    rendered.indexOf("alert: PaperclipGithubReviewRequestDeadLettered"),
    rendered.indexOf("alert: PaperclipGithubReviewRequestSuppressionOutage"),
  );
  assert.ok(alertBlock.length > 0, "dead-letter alert must render");
  assert.match(
    alertBlock,
    /\/d\/paperclip-review-request-funnel/,
    "the dead-letter alert must carry a link to the review-request funnel dashboard",
  );
});

test("adding grafanaDashboard did not orphan serviceMonitor.scrapeAllowFromNamespaces (BLO-20171 review catch)", () => {
  // The `grafanaDashboard` block was originally inserted into the MIDDLE of the
  // `serviceMonitor` mapping in values.yaml, between `scrapeTimeout` and
  // `scrapeAllowFromNamespaces`. YAML reparented the trailing key, so the
  // documented `serviceMonitor.scrapeAllowFromNamespaces` silently became
  // `grafanaDashboard.scrapeAllowFromNamespaces` while templates/networkpolicy.yaml
  // still read the serviceMonitor path.
  //
  // This has to be a STRUCTURAL assertion on values.yaml, not a render assertion.
  // A render test that passes the value with `--set serviceMonitor....` supplies the
  // correct path itself and therefore passes whether or not the default is
  // misplaced -- verified: re-introducing the bug left such a test green. And the
  // shipped default is `[]`, which renders identically to a missing key. The
  // failure mode is real but only bites someone who copies values.yaml and edits
  // it in place, so values.yaml's own shape is the thing worth pinning.
  const valuesPath = path.join(repoRoot, "deploy/helm/paperclip/values.yaml");
  const values = readFileSync(valuesPath, "utf8");

  const blockOf = (topLevelKey) => {
    const start = values.indexOf(`\n${topLevelKey}:\n`);
    assert.notEqual(start, -1, `values.yaml has no top-level ${topLevelKey}`);
    const rest = values.slice(start + 1);
    // Next top-level key = a line starting with a non-space, non-comment char.
    const nextKey = rest.slice(1).search(/\n[A-Za-z]/);
    return nextKey === -1 ? rest : rest.slice(0, nextKey + 1);
  };

  assert.match(
    blockOf("serviceMonitor"),
    /^\s{2}scrapeAllowFromNamespaces:/m,
    "scrapeAllowFromNamespaces must sit inside the serviceMonitor mapping; templates/networkpolicy.yaml reads .Values.serviceMonitor.scrapeAllowFromNamespaces",
  );
  assert.doesNotMatch(
    blockOf("grafanaDashboard"),
    /scrapeAllowFromNamespaces/,
    "scrapeAllowFromNamespaces has been reparented under grafanaDashboard by an insertion in the middle of the serviceMonitor mapping",
  );

  // ...and the wiring it protects still works end to end.
  const rendered = renderChart([
    "--set",
    "serviceMonitor.enabled=true",
    "--set",
    "networkPolicy.enabled=true",
    "--set",
    "serviceMonitor.scrapeAllowFromNamespaces[0].namespaceSelector.matchLabels.kubernetes\\.io/metadata\\.name=monitoring",
    "--show-only",
    "templates/networkpolicy.yaml",
  ]);
  assert.match(
    rendered,
    /kubernetes\.io\/metadata\.name: monitoring/,
    "serviceMonitor.scrapeAllowFromNamespaces must reach the NetworkPolicy ingress rules",
  );
});

test("grafanaDashboard.enabled=false renders no ConfigMap (chart stays installable without a Grafana sidecar)", () => {
  const rendered = renderChart(["--set", "grafanaDashboard.enabled=false"]);

  assert.doesNotMatch(
    rendered,
    /paperclip-grafana-dashboard-review-request-funnel/,
    "disabling the flag must drop the dashboard ConfigMap entirely",
  );
  assert.doesNotMatch(
    rendered,
    /paperclip-grafana-dashboard-platform/,
    "disabling the flag must drop every dashboard ConfigMap, not just the first",
  );
});

test("the datasource uid is overridable for clusters whose paperclip-scraping Prometheus is named differently", () => {
  const { dashboard } = renderDashboard([
    "--set",
    "grafanaDashboard.datasourceUid=some-other-prom",
  ]);

  const uids = new Set(
    allTargets(dashboard).map(({ target }) => target.datasource?.uid),
  );
  assert.deepEqual([...uids], ["some-other-prom"]);
});

// ---------------------------------------------------------------------------
// Paperclip Platform dashboard (BLO-22498) -- BLO-18012's operational signal.
// ---------------------------------------------------------------------------

test("Blockcast values render the Paperclip Platform dashboard ConfigMap with the sidecar label (BLO-22498)", () => {
  // AC 3 of BLO-22498 is the verb "renders", not "is merged". The panel JSON
  // sat correct-and-undeployed on onprem-k8s master for 12 days because that
  // repo's monitoring/dashboards/ directory is not a delivery path -- nothing
  // renders it into a ConfigMap. This chart is the delivery path, and without
  // the exact label pair below the ConfigMap is inert: it deploys fine and no
  // dashboard ever appears.
  const rendered = renderChart();

  assert.match(
    rendered,
    /name: paperclip-grafana-dashboard-platform/,
    "Blockcast values must render the Paperclip Platform dashboard ConfigMap",
  );

  const block = rendered.slice(
    rendered.indexOf("name: paperclip-grafana-dashboard-platform"),
  );
  assert.match(
    block,
    /^\s+grafana_dashboard: "1"$/m,
    'the platform dashboard ConfigMap must carry grafana_dashboard: "1" or the Grafana sidecar will not adopt it',
  );
});

test("the platform dashboard carries no import-only datasource scaffolding (BLO-22498 green-over-blind trap)", () => {
  // The onprem-k8s copy is written for Grafana's import UI: `__inputs`,
  // `__requires`, and a `DS_PROMETHEUS` datasource template variable whose
  // `current` is the NAME "Prometheus". Those are honoured only by the import
  // dialog. A sidecar-provisioned dashboard resolves ${DS_PROMETHEUS} against
  // the Grafana default datasource instead -- `thanos`, which does not scrape
  // the paperclip control plane -- so every panel renders "No data" while the
  // dashboard looks perfectly healthy in review. Deploying that would satisfy
  // "a panel exists" and fail "a panel renders".
  const { rendered, dashboard } = renderDashboard([], PLATFORM_KEY);

  assert.ok(
    !("__inputs" in dashboard),
    "__inputs is import-UI scaffolding; a provisioned dashboard must pin its datasource instead",
  );
  assert.ok(!("__requires" in dashboard), "__requires is import-UI scaffolding");
  assert.ok(
    !JSON.stringify(dashboard).includes("${DS_"),
    "no panel may resolve its datasource through a template variable; it would silently fall back to the Grafana default",
  );
  assert.ok(
    !rendered.includes("__PAPERCLIP_DS_UID__"),
    "the datasource placeholder must be substituted at render time",
  );

  const uids = new Set(
    allTargets(dashboard).map(({ target }) => target.datasource?.uid),
  );
  assert.deepEqual(
    [...uids],
    ["cluster"],
    "all platform panel targets must query the `cluster` datasource uid",
  );
});

test("the platform dashboard charts both BLO-18012 series, discriminated by error_reason (BLO-22498 AC 1/2)", () => {
  // A generic "agents in error" count cannot tell a session_unavailable agent
  // from an unrelated failure and would raise a false BLO-18012 alarm on any
  // of them -- observed live 2026-09-10, a 2581s BackoffLimitExceeded agent.
  // The by-reason split is what makes the panel answer the question asked.
  const { dashboard } = renderDashboard([], PLATFORM_KEY);
  const exprs = allTargets(dashboard).map(({ target }) => target.expr ?? "");

  const countExpr = exprs.find((expr) =>
    expr.includes("paperclip_agent_status_error_agents"),
  );
  assert.ok(countExpr, "dashboard must chart paperclip_agent_status_error_agents");
  assert.match(
    countExpr,
    /by \(error_reason\)/,
    "the agents-in-error count must be split by error_reason; the aggregate cannot isolate the BLO-18012 condition",
  );
  assert.match(
    countExpr,
    /^max by/,
    "the gauge is fleet-wide and identical on every replica; a bare sum multiplies the count by the replica count",
  );

  const ageExpr = exprs.find((expr) =>
    expr.includes("paperclip_agent_status_error_oldest_age_seconds"),
  );
  assert.ok(
    ageExpr,
    "dashboard must chart paperclip_agent_status_error_oldest_age_seconds",
  );
  assert.match(
    ageExpr,
    /error_reason="session_unavailable"/,
    "the time-in-error panel must be scoped to session_unavailable; unrelated long-lived failures would read as a BLO-18012 breach that never happened",
  );
});

test("the time-in-error panel shows the 2-min BLO-18012 bound as a threshold (BLO-22498 AC 3)", () => {
  // AC 3 requires "a visible threshold line at the BLO-18012 bound". A red
  // step alone is not visible on a timeseries unless thresholdsStyle is on,
  // and the bound is meaningless if the axis is not in seconds.
  const { dashboard } = renderDashboard([], PLATFORM_KEY);

  const panel = dashboard.panels.find(({ targets }) =>
    (targets ?? []).some(({ expr }) =>
      expr?.includes("paperclip_agent_status_error_oldest_age_seconds"),
    ),
  );
  assert.ok(panel, "the time-in-error panel must exist");

  const defaults = panel.fieldConfig?.defaults ?? {};
  assert.equal(
    defaults.unit,
    "s",
    "the panel plots seconds; any other unit makes the 120 threshold mean something else",
  );
  assert.ok(
    (defaults.thresholds?.steps ?? []).some(
      (step) => step.color === "red" && step.value === 120,
    ),
    "the panel must carry a red threshold at 120s -- BLO-18012's <=2 min recovery bound",
  );
  assert.notEqual(
    defaults.custom?.thresholdsStyle?.mode,
    "off",
    "the threshold must be drawn on the plot; an unrendered threshold is not a visible bound",
  );
});

test("the platform dashboard uid is stable, so the URL posted on BLO-18012 keeps resolving", () => {
  const { dashboard } = renderDashboard([], PLATFORM_KEY);
  assert.equal(dashboard.uid, "paperclip-platform");
});

test("the platform dashboard datasource uid is overridable alongside the funnel's", () => {
  const { dashboard } = renderDashboard(
    ["--set", "grafanaDashboard.datasourceUid=some-other-prom"],
    PLATFORM_KEY,
  );

  const uids = new Set(
    allTargets(dashboard).map(({ target }) => target.datasource?.uid),
  );
  assert.deepEqual([...uids], ["some-other-prom"]);
});
