import { afterEach, describe, expect, it } from "vitest";
import {
  PLUGIN_METRIC_CARDINALITY_BUDGET,
  PLUGIN_METRIC_DROPPED_METRIC,
  PLUGIN_METRIC_NAME_BUDGET,
  PLUGIN_METRIC_OVERFLOW_NAME,
  PLUGIN_METRIC_TOTAL_METRIC,
  __resetMetricsForTest,
  recordPluginMetric,
  renderMetrics,
} from "../services/metrics.js";

/**
 * PEN-2799 — plugin-contributed metrics must reach Prometheus.
 *
 * Asserted against the rendered exposition text rather than internal state:
 * the defect being fixed was precisely that a write "succeeded" while
 * producing no series, so a test that inspected our own bookkeeping could pass
 * with the exposition still broken.
 */

afterEach(() => {
  __resetMetricsForTest();
});

const PLUGIN = { pluginId: "plugin-uuid-1", pluginKey: "paperclip-plugin-alertmanager" };

async function lines(): Promise<string[]> {
  const { body } = await renderMetrics();
  return body.split("\n");
}

/** Sample lines for a metric family, excluding `# HELP` / `# TYPE` headers. */
async function seriesFor(metricName: string): Promise<string[]> {
  return (await lines()).filter(
    (line) => line.startsWith(`${metricName}{`) || line === metricName,
  );
}

describe("recordPluginMetric — exposition", () => {
  it("publishes a plugin metric as a real Prometheus series", async () => {
    recordPluginMetric({
      ...PLUGIN,
      name: "alertmanager.owner.fallback_failed",
      value: 1,
      tags: { alertname: "PaperclipAdmissionPolicyExpectationStale", severity: "critical" },
      declaredLabels: ["alertname", "severity"],
    });

    const series = await seriesFor(PLUGIN_METRIC_TOTAL_METRIC);
    expect(series).toHaveLength(1);
    expect(series[0]).toContain('metric="alertmanager.owner.fallback_failed"');
    expect(series[0]).toContain('plugin_key="paperclip-plugin-alertmanager"');
    expect(series[0]).toContain('alertname="PaperclipAdmissionPolicyExpectationStale"');
    expect(series[0]).toContain('severity="critical"');
    expect(series[0]?.trimEnd().endsWith(" 1")).toBe(true);
  });

  it("keeps the plugin's metric name as a LABEL, never as a series name", async () => {
    // Plugins build metric names by interpolation, so a name mapped into the
    // series name would let any plugin mint arbitrary paperclip_* series.
    recordPluginMetric({
      ...PLUGIN,
      name: "slack.tool.evil.error",
      value: 1,
      declaredLabels: [],
    });

    const body = (await renderMetrics()).body;
    expect(body).toContain('metric="slack.tool.evil.error"');
    // No series NAME may be derived from plugin input.
    expect(body).not.toMatch(/^paperclip_plugin_metric_total_slack/m);
    expect(body).not.toMatch(/^slack\./m);
    expect(body).not.toMatch(/^paperclip_slack/m);
  });

  it("never exposes company_id as a label — it is unbounded per tenant", async () => {
    recordPluginMetric({
      ...PLUGIN,
      name: "alertmanager.alert.error",
      value: 1,
      tags: { company_id: "aaced805-3491-4ee5-9b14-cdf70cb81d47", alertname: "X" },
      declaredLabels: ["company_id", "alertname"],
    });

    const series = await seriesFor(PLUGIN_METRIC_TOTAL_METRIC);
    expect(series).toHaveLength(1);
    expect(series[0]).not.toContain("company_id");
    expect(series[0]).not.toContain("aaced805");
  });
});

describe("recordPluginMetric — name validation", () => {
  const BAD_NAMES: Array<[string, string]> = [
    ["empty", ""],
    ["whitespace only", "   "],
    ["uppercase", "Alertmanager.Error"],
    ["leading digit", "1alertmanager.error"],
    ["trailing dot", "alertmanager.error."],
    ["embedded space", "alertmanager error"],
    ["over max length", `a.${"x".repeat(70)}`],
  ];

  for (const [label, name] of BAD_NAMES) {
    it(`drops a ${label} name as bad_name and publishes no series`, async () => {
      recordPluginMetric({ ...PLUGIN, name, value: 1 });

      expect(await seriesFor(PLUGIN_METRIC_TOTAL_METRIC)).toHaveLength(0);
      const dropped = await seriesFor(PLUGIN_METRIC_DROPPED_METRIC);
      expect(dropped).toHaveLength(1);
      expect(dropped[0]).toContain('reason="bad_name"');
    });
  }
});

describe("recordPluginMetric — value validation", () => {
  for (const [label, value] of [
    ["negative", -1],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ] as Array<[string, number]>) {
    it(`drops a ${label} value as bad_value rather than throwing or clamping`, async () => {
      // prom-client's inc() throws on a negative value; an escaping exception
      // here would fail the plugin call that carried the metric.
      expect(() =>
        recordPluginMetric({ ...PLUGIN, name: "alertmanager.alert.error", value }),
      ).not.toThrow();

      expect(await seriesFor(PLUGIN_METRIC_TOTAL_METRIC)).toHaveLength(0);
      const dropped = await seriesFor(PLUGIN_METRIC_DROPPED_METRIC);
      expect(dropped).toHaveLength(1);
      expect(dropped[0]).toContain('reason="bad_value"');
    });
  }

  it("accepts zero — a counter may legitimately be incremented by 0", async () => {
    recordPluginMetric({ ...PLUGIN, name: "alertmanager.alert.error", value: 0 });
    expect(await seriesFor(PLUGIN_METRIC_TOTAL_METRIC)).toHaveLength(1);
    expect(await seriesFor(PLUGIN_METRIC_DROPPED_METRIC)).toHaveLength(0);
  });
});

describe("recordPluginMetric — two-sided label gate", () => {
  it("promotes a key only when the manifest declares it AND the platform allows it", async () => {
    recordPluginMetric({
      ...PLUGIN,
      name: "alertmanager.alert.error",
      value: 1,
      tags: { alertname: "Declared", command_name: "NotPromotable", source: "NotDeclared" },
      // `alertname` — declared + promotable  → label
      // `command_name` — declared, NOT promotable (operator-defined, unbounded) → dropped
      // `source` — promotable but NOT declared → dropped
      declaredLabels: ["alertname", "command_name"],
    });

    const series = await seriesFor(PLUGIN_METRIC_TOTAL_METRIC);
    expect(series).toHaveLength(1);
    expect(series[0]).toContain('alertname="Declared"');
    expect(series[0]).not.toContain("command_name");
    expect(series[0]).not.toContain("NotPromotable");
    expect(series[0]).not.toContain("NotDeclared");
  });

  it("publishes the metric with no promoted labels when the manifest declares none", async () => {
    // Declaring nothing must not suppress the metric — it degrades to
    // aggregate-only, which is still alertable.
    recordPluginMetric({
      ...PLUGIN,
      name: "alertmanager.alert.error",
      value: 1,
      tags: { alertname: "Ignored" },
      declaredLabels: [],
    });

    const series = await seriesFor(PLUGIN_METRIC_TOTAL_METRIC);
    expect(series).toHaveLength(1);
    expect(series[0]).not.toContain("Ignored");
    expect(await seriesFor(PLUGIN_METRIC_DROPPED_METRIC)).toHaveLength(0);
  });
});

describe("recordPluginMetric — cardinality budget", () => {
  it("keeps the metric label when a hostile tag set exhausts the label budget", async () => {
    // THE regression guard for this feature's whole purpose. The first cut of
    // this change collapsed `metric` into "_overflow" here, which silently
    // broke any rule matching metric="alertmanager.alert.error" — a narrower
    // re-run of the PEN-2579 failure mode (a rule watching a series that is
    // not reliably there). Measured at the time: 155 distinct alertnames fired
    // fleet-wide in 7 days against a 100 budget, so this path is the expected
    // steady state, not a tail case.
    const OVER = PLUGIN_METRIC_CARDINALITY_BUDGET + 50;
    for (let i = 0; i < OVER; i += 1) {
      recordPluginMetric({
        ...PLUGIN,
        name: "alertmanager.alert.error",
        value: 1,
        tags: { alertname: `Alert-${i}` },
        declaredLabels: ["alertname"],
      });
    }

    const series = await seriesFor(PLUGIN_METRIC_TOTAL_METRIC);
    // The budget's worth of fully-labelled combinations, plus ONE label-dropped
    // series carrying the same metric name. An exact count is deliberate: an
    // off-by-one in the budget check shows up here and nowhere else.
    expect(series).toHaveLength(PLUGIN_METRIC_CARDINALITY_BUDGET + 1);

    // Nothing collapsed onto the name axis — the name budget was never touched.
    expect(
      series.filter((line) => line.includes(`metric="${PLUGIN_METRIC_OVERFLOW_NAME}"`)),
    ).toHaveLength(0);

    // The degraded write kept its metric label and lost only its alertname, so
    // an alert rule filtering on the metric name still matches it.
    const degraded = series.filter(
      (line) =>
        line.includes('metric="alertmanager.alert.error"') && !line.includes("alertname="),
    );
    expect(degraded).toHaveLength(1);
    // Degraded, not discarded: all 50 over-budget writes are still counted.
    expect(degraded[0]?.trimEnd().endsWith(" 50")).toBe(true);

    const dropped = await seriesFor(PLUGIN_METRIC_DROPPED_METRIC);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toContain('reason="label_budget"');
    expect(dropped[0]?.trimEnd().endsWith(" 50")).toBe(true);
  });

  it("keeps sum-by-metric exact across label-budget overflow", async () => {
    // The property that makes the label axis the right one to degrade: the
    // per-tag breakdown is lost, but the metric's TOTAL is untouched, so a
    // rate() alert on the metric name reads the true rate rather than a
    // truncated one.
    const OVER = PLUGIN_METRIC_CARDINALITY_BUDGET + 37;
    for (let i = 0; i < OVER; i += 1) {
      recordPluginMetric({
        ...PLUGIN,
        name: "alertmanager.alert.error",
        value: 1,
        tags: { alertname: `Alert-${i}` },
        declaredLabels: ["alertname"],
      });
    }

    const total = (await seriesFor(PLUGIN_METRIC_TOTAL_METRIC))
      .filter((line) => line.includes('metric="alertmanager.alert.error"'))
      .reduce((sum, line) => sum + Number(line.trimEnd().split(" ").pop()), 0);
    expect(total).toBe(OVER);
  });

  it("collapses to the overflow series only when the metric NAME budget is exhausted", async () => {
    // The one case where `metric` may collapse: a plugin minting names faster
    // than any rule author could enumerate them. Distinct from the label budget
    // above, and reported under its own reason so the two are never conflated.
    const OVER = PLUGIN_METRIC_NAME_BUDGET + 10;
    for (let i = 0; i < OVER; i += 1) {
      recordPluginMetric({ ...PLUGIN, name: `churn.name_${i}`, value: 1 });
    }

    const series = await seriesFor(PLUGIN_METRIC_TOTAL_METRIC);
    expect(series).toHaveLength(PLUGIN_METRIC_NAME_BUDGET + 1);
    const overflow = series.filter((line) =>
      line.includes(`metric="${PLUGIN_METRIC_OVERFLOW_NAME}"`),
    );
    expect(overflow).toHaveLength(1);
    expect(overflow[0]?.trimEnd().endsWith(" 10")).toBe(true);

    const dropped = await seriesFor(PLUGIN_METRIC_DROPPED_METRIC);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toContain('reason="name_budget"');
  });

  it("budgets each plugin independently", async () => {
    for (let i = 0; i < PLUGIN_METRIC_CARDINALITY_BUDGET; i += 1) {
      recordPluginMetric({
        ...PLUGIN,
        name: "a.metric",
        value: 1,
        tags: { alertname: `A-${i}` },
        declaredLabels: ["alertname"],
      });
    }
    // A second plugin must not inherit the first's exhausted budget.
    recordPluginMetric({
      pluginId: "plugin-uuid-2",
      pluginKey: "other.plugin",
      name: "b.metric",
      value: 1,
      tags: { alertname: "B-0" },
      declaredLabels: ["alertname"],
    });

    const series = await seriesFor(PLUGIN_METRIC_TOTAL_METRIC);
    const other = series.filter((line) => line.includes('plugin_key="other.plugin"'));
    expect(other).toHaveLength(1);
    expect(other[0]).toContain('alertname="B-0"');
    expect(other[0]).not.toContain(PLUGIN_METRIC_OVERFLOW_NAME);
  });

  it("keys the budget ledger injectively, so two combinations cannot share one slot", async () => {
    // Regression guard on the ledger SEPARATOR, not on series identity.
    // prom-client keys a series by the real label map, so identity is never
    // forged. The leak is narrower: under a printable separator these two
    // combinations render to the same ledger key, the second reads as
    // already-seen, and it therefore consumes NO budget slot while still
    // publishing — so every collision buys a free series.
    //
    // Fill the budget to its last slot, then spend that slot on A. B must then
    // find the budget exhausted. If B collides with A in the ledger it will be
    // treated as seen and publish normally, and this assertion fails.
    for (let i = 0; i < PLUGIN_METRIC_CARDINALITY_BUDGET - 1; i += 1) {
      recordPluginMetric({
        ...PLUGIN,
        name: "m",
        value: 1,
        tags: { action: `fill-${i}` },
        declaredLabels: ["action", "alertname"],
      });
    }

    // A: action="x y", alertname="z"   → space-joined "m x y z …"
    recordPluginMetric({
      ...PLUGIN, name: "m", value: 1,
      tags: { action: "x y", alertname: "z" },
      declaredLabels: ["action", "alertname"],
    });
    // B: action="x", alertname="y z"   → space-joined "m x y z …"  (identical)
    recordPluginMetric({
      ...PLUGIN, name: "m", value: 1,
      tags: { action: "x", alertname: "y z" },
      declaredLabels: ["action", "alertname"],
    });

    const dropped = await seriesFor(PLUGIN_METRIC_DROPPED_METRIC);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toContain('reason="label_budget"');
    expect(dropped[0]?.trimEnd().endsWith(" 1")).toBe(true);

    // B degraded to the label-dropped series for "m" rather than collapsing the
    // name — no _overflow, because the name budget was never in play here.
    const series = await seriesFor(PLUGIN_METRIC_TOTAL_METRIC);
    expect(series.filter((l) => l.includes(`metric="${PLUGIN_METRIC_OVERFLOW_NAME}"`)))
      .toHaveLength(0);
    expect(
      series.filter((l) => l.includes('metric="m"') && !l.includes("action=")),
    ).toHaveLength(1);
  });

  it("does not consume a new slot when the same combination repeats", async () => {
    for (let i = 0; i < 5; i += 1) {
      recordPluginMetric({
        ...PLUGIN,
        name: "alertmanager.alert.error",
        value: 1,
        tags: { alertname: "Same" },
        declaredLabels: ["alertname"],
      });
    }

    const series = await seriesFor(PLUGIN_METRIC_TOTAL_METRIC);
    expect(series).toHaveLength(1);
    expect(series[0]?.trimEnd().endsWith(" 5")).toBe(true);
    expect(await seriesFor(PLUGIN_METRIC_DROPPED_METRIC)).toHaveLength(0);
  });
});

describe("recordPluginMetric — never throws", () => {
  it("survives hostile input without raising", () => {
    const hostile: Array<Partial<Parameters<typeof recordPluginMetric>[0]>> = [
      { name: undefined as unknown as string },
      { tags: { alertname: { nested: "object" } } as unknown as Record<string, unknown> },
      { tags: null },
      { declaredLabels: null },
      { value: undefined as unknown as number },
      { pluginId: undefined as unknown as string },
    ];
    for (const patch of hostile) {
      expect(() =>
        recordPluginMetric({
          ...PLUGIN,
          name: "alertmanager.alert.error",
          value: 1,
          ...patch,
        } as Parameters<typeof recordPluginMetric>[0]),
      ).not.toThrow();
    }
  });
});
