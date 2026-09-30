import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
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

// Split a kubectl jsonpath into its field list. `.` separates fields unless
// escaped; a bracketed segment (`['a.json']`) is normalised to the escaped-dot
// form first so both spellings kubectl accepts reach one splitter.
function jsonpathFields(expr) {
  return expr
    .replace(/\['([^']*)'\]|\["([^"]*)"\]/g, (_m, a, b) => `.${(a ?? b).replace(/\./g, "\\.")}`)
    .replace(/^\./, "")
    .split(/(?<!\\)\./)
    .map((s) => s.replace(/\\\./g, "."));
}

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
  //
  // Note the asymmetry: on the two TIMESERIES panels this assertion is doing
  // real work. On the bare-max() stat panel it is not -- `max(max by (agent_id)
  // (x))` is exactly `max(x)`, because the outer max already collapses every
  // label. That panel is correct for a different reason than this test
  // asserts. The grouping is kept for uniformity so the next panel author
  // copies the safe shape, but do not read a pass here as proof the stat panel
  // needed it.
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
  // Total absence of the series -- refresh loop removed, metric renamed, all
  // replicas down -- is strictly worse than the 0 this panel was built to
  // catch, but bare min() returns empty and renders "No data" instead of
  // STALE. `or vector(0)` makes the worst case read as the worst case.
  assert.match(
    target.target.expr,
    /or vector\(0\)/,
    "refresh health must fall back to 0 when the series is absent entirely, not render No data",
  );
});

test("an absent queued-age series renders NO DATA on red, never a green zero", () => {
  // The sibling refresher panel gets absence right because its BASE threshold
  // is red, so a bare `or vector(0)` lands on red. This panel's base is green
  // and its unit is seconds, so the same treatment would render a dead emit
  // path as "0 s" on green -- an affirmatively healthy tile, which is worse
  // than the "No data" it replaced. An empty queue and a dead exporter are
  // both "no series" to Grafana and only one of them is healthy, so absence
  // needs a value that is out of band for the metric: a negative age.
  //
  // All three assertions are one fact. `or vector(-1)` with a green base is a
  // green tile; a red base without the sentinel reddens a legitimately empty
  // queue. They are only correct together, so they fail together.
  const { dashboard } = renderDashboard();

  const panel = dashboard.panels.find((p) => p.title === "Worst queued-run age");
  assert.ok(panel, "dashboard must chart the worst queued-run age");

  assert.match(
    panel.targets[0].expr,
    /or vector\(-1\)/,
    "absent queued-age series must fall back to an out-of-band sentinel, not render No data",
  );

  const steps = panel.fieldConfig.defaults.thresholds.steps;
  assert.equal(
    steps[0].color,
    "red",
    "base threshold must be red so the -1 sentinel colours the tile red",
  );
  assert.equal(
    steps[1].value,
    0,
    "green must start at 0 so a legitimately empty queue is not reported as absent",
  );

  const mapped = panel.fieldConfig.defaults.mappings?.flatMap((m) =>
    Object.keys(m.options ?? {}),
  );
  assert.ok(
    mapped?.includes("-1"),
    "the -1 sentinel must be mapped to readable text; a bare '-1 s' age reads as a bug in the panel, not as absence",
  );
});

test("an absent overdue-retry series renders NO DATA on red, never a green zero", () => {
  // Same defect as the tile above, on a count() rather than a max(). It needs a
  // DIFFERENT idiom: `count(x > 0) or vector(0)` returns 0 both when the metric
  // is absent and when it is present-and-idle, so a rename or a dead emit path
  // is pixel-identical to a healthy cluster. count() cannot use `or vector(-1)`
  // the way the max() tile does, because count() of an empty inner result is
  // also empty -- there is nothing to distinguish. absent() is what separates
  // them, and the two arms must be ordered absent-before-zero or the zero arm
  // swallows absence.
  //
  // The refresher tile does NOT cover this: that is a different metric and
  // would still read 1/OK while this one is dead.
  //
  // Validated live across all three states before adopting (2026-09-20):
  // absent -> -1, present-and-idle -> 0, present-and-overdue -> 1.
  const { dashboard } = renderDashboard();

  const panel = dashboard.panels.find(
    (p) => p.title === "Agents with an overdue parked retry",
  );
  assert.ok(panel, "dashboard must chart the overdue-agent count");

  assert.match(
    panel.targets[0].expr,
    new RegExp(`absent\\(${OVERDUE}\\)\\s*\\*\\s*-1`),
    "an absent overdue-retry series must resolve to the -1 sentinel; `or vector(0)` alone renders a dead emit path as a green '0 agents overdue'",
  );
  assert.ok(
    panel.targets[0].expr.indexOf("absent(") <
      panel.targets[0].expr.indexOf("or vector(0)"),
    "the absent() arm must precede `or vector(0)`, otherwise the zero arm matches first and absence never reaches the sentinel",
  );

  const steps = panel.fieldConfig.defaults.thresholds.steps;
  assert.equal(
    steps[0].color,
    "red",
    "base threshold must be red so the -1 sentinel colours the tile red",
  );
  assert.equal(
    steps[1].value,
    0,
    "green must start at 0 so a genuinely idle fleet is not reported as absent",
  );

  const mapped = panel.fieldConfig.defaults.mappings?.flatMap((m) =>
    Object.keys(m.options ?? {}),
  );
  assert.ok(
    mapped?.includes("-1"),
    "the -1 sentinel must be mapped to readable text; a bare '-1' count reads as a bug in the panel, not as absence",
  );
});

test("the runbook's verification commands name objects that actually render", () => {
  // The runbook's whole job is telling an operator whether a merged dashboard
  // is live. A wrong ConfigMap name or data key there fails in the worst
  // direction: `kubectl get cm` says NotFound, the operator concludes the
  // deploy is stale, and goes chasing a pipeline that is fine. (Caught for
  // real -- the first draft of that block guessed the name and was wrong.)
  const runbook = readFileSync(
    path.join(repoRoot, "runbooks/grafana-dashboard-as-code.md"),
    "utf8",
  );
  const rendered = renderChart();

  const cm = runbook.match(/^CM=(\S+)/m);
  const key = runbook.match(/^KEY=(\S+)/m);
  const src = runbook.match(/^SRC=(\S+)/m);
  assert.ok(cm && key && src, "runbook must define CM=, KEY= and SRC=");

  // Anchor to end-of-line, NOT \b. Every one of these names is a prefix of a
  // longer sibling (`...-runtime` vs `...-runtime-run-queue-health`) and the
  // next char is `-`, which IS a word boundary -- so a \b-anchored match
  // accepts the truncated name and the guard silently passes. Found by
  // mutation-testing this very assertion: it did not fail when the runbook's
  // CM= was replaced with the wrong, shorter name.
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(
    rendered,
    new RegExp(`^\\s+name: ${esc(cm[1])}\\s*$`, "m"),
    `runbook names ConfigMap '${cm[1]}' but the chart renders no such ConfigMap`,
  );
  assert.ok(
    rendered.includes(`${key[1]}: |`),
    `runbook names data key '${key[1]}' but the rendered ConfigMap has no such key`,
  );
  assert.equal(
    src[1],
    `deploy/helm/paperclip/dashboards/$KEY`,
    "SRC must be derived from $KEY so the diff cannot compare two different dashboards",
  );
});

test("the runbook's step-2 jsonpath resolves, not just names the right key", () => {
  // The test above checks the NAMES appear. Names and the jsonpath EXPRESSION
  // are separate failure surfaces, and the second one failed in review:
  // kubectl's JSONPath reads `.` as a field separator, so `{.data.$KEY}` with
  // KEY=runtime-run-queue-health.json parses as data -> runtime-run-queue-health
  // -> json, resolves to nothing, and exits 0 with no output and nothing on
  // stderr. `jq -S .` on empty stdin also exits 0 silently, so step 2 printed
  // `STALE -- deploy has not run` unconditionally -- including when the
  // ConfigMap was current. Measured on the live cluster: as-written returned 0
  // bytes, escaped returned 17565.
  //
  // That is worse than the `jq -r 'keys'` version it replaced -- that answered
  // nothing, this answers WRONGLY, and the runbook exists because the deploy
  // pipeline genuinely does run hundreds of commits behind, so a false STALE is
  // indistinguishable from the real condition step 2 detects.
  //
  // MUTATION TEST: delete the `\\.` from the runbook's KEY_JP line. If this
  // still passes, it has gone back to checking names.
  const runbook = readFileSync(
    path.join(repoRoot, "runbooks/grafana-dashboard-as-code.md"),
    "utf8",
  );
  const rendered = renderChart(["--show-only", TEMPLATE]);

  // Accept either jsonpath form kubectl supports for a dotted key -- the dotted
  // `{.data.a\.json}` and the bracketed `{.data['a.json']}` both resolve. The
  // property under test is that the expression selects one real data key, not
  // which syntax it uses; pinning the dotted form would fail a correct runbook.
  const jp = runbook.match(/-o jsonpath="\{(\.data[.[][^}]+)\}"/);
  assert.ok(jp, "runbook step 2 must read the ConfigMap via -o jsonpath");

  // Expand the runbook's own shell assignments with bash rather than
  // re-implementing `${KEY//./\\.}` -- a hand-rolled expansion could agree with
  // a wrong runbook.
  const assigns = [...runbook.matchAll(/^(?:CM|KEY|KEY_JP)=.*$/gm)]
    .map((m) => m[0].split("#")[0].trimEnd())
    .join("\n");
  const expanded = execFileSync(
    "bash",
    ["-c", `set -u\n${assigns}\nprintf '%s' "${jp[1]}"`],
    { encoding: "utf8" },
  );

  // Apply kubectl's own splitting rule: `.` separates fields unless escaped.
  // Bracketed segments are normalised to the escaped-dot form first, so both
  // spellings reach one splitter. Widening the capture above WITHOUT this would
  // just relocate the bad message: `.data['a.json']` dot-splits into
  // `data['a` -> `json']`, failing the ".data" assertion instead of the
  // field-count one -- still a wrong message about a correct runbook.
  const fields = jsonpathFields(expanded);

  assert.deepEqual(
    fields.slice(0, 1),
    ["data"],
    `jsonpath '${expanded}' does not start at .data`,
  );
  assert.equal(
    fields.length,
    2,
    `jsonpath '${expanded}' splits into ${fields.length} fields (${fields.join(" -> ")}); ` +
      "a dot inside the key must be escaped or kubectl reads it as a nested field and silently returns nothing",
  );
  assert.ok(
    rendered.includes(`${fields[1]}: |`),
    `jsonpath '${expanded}' resolves to data key '${fields[1]}', which the rendered ConfigMap does not have`,
  );
});

// The guard above must judge what the expression RESOLVES TO, not which of the
// two syntaxes kubectl accepts it is written in. Both forms below were measured
// against the live cluster at 17565 bytes each, so a future editor switching to
// the bracket form is writing a correct runbook and must not get a failure that
// says the runbook lacks something it visibly has.
test("jsonpath field-split accepts both kubectl spellings of a dotted key", () => {
  const want = ["data", DASHBOARD_KEY];

  assert.deepEqual(jsonpathFields(`.data.${DASHBOARD_KEY.replace(/\./g, "\\.")}`), want);
  assert.deepEqual(jsonpathFields(`.data['${DASHBOARD_KEY}']`), want);
  assert.deepEqual(jsonpathFields(`.data["${DASHBOARD_KEY}"]`), want);

  // Non-vacuity: the unescaped dotted form is the actual defect this whole
  // guard exists to catch, and it must still split into 3 -- otherwise the
  // normalisation has been widened into accepting the bug.
  assert.equal(jsonpathFields(`.data.${DASHBOARD_KEY}`).length, 3);
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

test("no two rendered dashboards claim the same uid", () => {
  // Grafana keys dashboards by the JSON's top-level uid -- NOT by filename or
  // ConfigMap name. The "add another dashboard" recipe says to copy an
  // existing template, so starting from a copy of an existing DASHBOARD is the
  // natural next move; leave its uid and the two collide. Both ConfigMaps
  // apply cleanly, both pass every `kubectl get cm` check in the runbook, and
  // one dashboard silently replaces the other in Grafana. Deploys clean,
  // renders wrong, fails nowhere -- so it has to fail here instead.
  //
  // Scans the WHOLE chart rather than a fixed template list so a third
  // dashboard added in a new template file is covered without touching this
  // test. Self-selecting: a block only counts as a dashboard if it parses as
  // JSON carrying both `uid` and `panels`.
  const rendered = renderChart();

  const byUid = new Map();
  const marker = /^(\s+)([\w.-]+\.json): \|/gm;

  for (const m of rendered.matchAll(marker)) {
    const key = m[2];
    const body = rendered
      .slice(rendered.indexOf("\n", m.index) + 1)
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

    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed.uid !== "string" || !parsed.panels) continue;

    const seen = byUid.get(parsed.uid);
    assert.equal(
      seen,
      undefined,
      `dashboards '${seen}' and '${key}' both use uid '${parsed.uid}'; Grafana keys on uid, so one silently replaces the other`,
    );
    byUid.set(parsed.uid, key);
  }

  // Guard the guard: a scan that matched nothing makes the assertion above
  // vacuous and it would pass on any collision at all.
  //
  // Count against the source dir, NOT a literal. The scanner drops a block it
  // cannot parse (`catch { continue }`) and only recognises a filename matching
  // `[\w.-]+\.json` indented by exactly four spaces -- so a dashboard rendered
  // at a different nindent is skipped SILENTLY. Against a `>= 2` floor, a third
  // dashboard skipped that way leaves the count at 2, the floor still passes,
  // and a uid collision involving it goes unnoticed -- which is exactly the
  // "third dashboard is safe rather than the second one lucky" case this test
  // was added for. Equality turns that silent skip into a failure.
  const shipped = readdirSync(
    path.join(repoRoot, "deploy/helm/paperclip/dashboards"),
  ).filter((f) => f.endsWith(".json"));

  assert.equal(
    byUid.size,
    shipped.length,
    `scanned ${byUid.size} dashboard(s) out of the rendered chart but ${shipped.length} exist on disk (${shipped.join(", ")}); an unscanned dashboard is not checked for uid collisions`,
  );
});
