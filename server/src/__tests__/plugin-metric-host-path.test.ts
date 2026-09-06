import { afterEach, describe, expect, it, vi } from "vitest";
import { buildHostServices } from "../services/plugin-host-services.js";
import {
  PLUGIN_METRIC_DROPPED_METRIC,
  PLUGIN_METRIC_TOTAL_METRIC,
  __resetMetricsForTest,
  renderMetrics,
} from "../services/metrics.js";

/**
 * PEN-2799 — the host wiring, not the algorithm.
 *
 * `plugin-metric-exposition.test.ts` calls `recordPluginMetric` directly, which
 * proves the exposition logic but leaves the seam that actually failed
 * unpinned: before this PR, `ctx.metrics.write` wrote a `plugin_logs` row and
 * nothing else. Deleting the `recordPluginMetric({...})` call from
 * `plugin-host-services.ts` would restore that exact PEN-2581 condition with
 * every other test still green.
 *
 * So this drives the real path a plugin uses — `buildHostServices(...)` ->
 * `services.metrics.write(...)` — and asserts against rendered exposition text.
 * It pins three things that are individually easy to regress:
 *
 *  1. the call site exists at all (delete it and this fails);
 *  2. `options.manifest.metricLabels` reaches `declaredLabels`, which was inert
 *     until the manifest field landed and would go inert again if unthreaded;
 *  3. the *untruncated* name is handed to `recordPluginMetric`, so an over-long
 *     name is counted as a `bad_name` drop rather than silently masquerading as
 *     a valid shorter one.
 */

afterEach(() => {
  __resetMetricsForTest();
  vi.restoreAllMocks();
});

function createEventBusStub() {
  return {
    forPlugin() {
      return { emit: vi.fn(), subscribe: vi.fn(), clear: vi.fn() };
    },
  };
}

const PLUGIN_ID = "plugin-uuid-1";
const PLUGIN_KEY = "paperclip-plugin-alertmanager";

/**
 * Build host services the way `app.ts` does, with a manifest. The db is a stub:
 * `metrics.write` buffers its `plugin_logs` row and only flushes at
 * LOG_BUFFER_FLUSH_SIZE, so a single write never reaches it.
 */
function hostServices(metricLabels: string[] | undefined) {
  return buildHostServices(
    {} as never,
    PLUGIN_ID,
    PLUGIN_KEY,
    createEventBusStub() as never,
    undefined,
    undefined,
    { manifest: (metricLabels ? { metricLabels } : {}) as never },
  );
}

async function seriesFor(metricName: string): Promise<string[]> {
  const { body } = await renderMetrics();
  return body
    .split("\n")
    .filter((line) => line.startsWith(`${metricName}{`) || line === metricName);
}

describe("ctx.metrics.write -> Prometheus (host path)", () => {
  it("publishes a real series, carrying a manifest-declared label", async () => {
    const services = hostServices(["alertname"]);
    try {
      await services.metrics.write({
        name: "alertmanager.alert.error",
        value: 1,
        tags: { alertname: "PaperclipAgentHeartbeatStale" },
      } as never);
    } finally {
      services.dispose();
    }

    const series = await seriesFor(PLUGIN_METRIC_TOTAL_METRIC);
    expect(series).toHaveLength(1);
    expect(series[0]).toContain('metric="alertmanager.alert.error"');
    expect(series[0]).toContain(`plugin_key="${PLUGIN_KEY}"`);
    // The manifest -> declaredLabels thread. Undeclared, this label is absent.
    expect(series[0]).toContain('alertname="PaperclipAgentHeartbeatStale"');
    expect(series[0]?.trimEnd().endsWith(" 1")).toBe(true);
  });

  it("omits a promotable tag the manifest does not declare", async () => {
    // Same write, no `metricLabels`: the series must still exist (the plugin
    // gets aggregate-only telemetry) but must not carry the tag as a label.
    const services = hostServices(undefined);
    try {
      await services.metrics.write({
        name: "alertmanager.alert.error",
        value: 1,
        tags: { alertname: "PaperclipAgentHeartbeatStale" },
      } as never);
    } finally {
      services.dispose();
    }

    const series = await seriesFor(PLUGIN_METRIC_TOTAL_METRIC);
    expect(series).toHaveLength(1);
    expect(series[0]).toContain('metric="alertmanager.alert.error"');
    expect(series[0]).not.toContain("PaperclipAgentHeartbeatStale");
  });

  it("counts an over-long name as a drop, not as a truncated series", async () => {
    // The log path truncates to MAX_METRIC_NAME_LENGTH; recordPluginMetric must
    // receive the untruncated name so its own bound rejects it. If the caller
    // ever passes the pre-truncated copy, this publishes a series instead.
    //
    // Asserted via the DROP counter, not merely the absence of a series: an
    // absence assertion is also satisfied by the call site being deleted
    // outright, which would make this test pass for the wrong reason.
    const services = hostServices(["alertname"]);
    try {
      await services.metrics.write({
        name: `alertmanager.${"x".repeat(200)}`,
        value: 1,
      } as never);
    } finally {
      services.dispose();
    }

    expect(await seriesFor(PLUGIN_METRIC_TOTAL_METRIC)).toHaveLength(0);
    const dropped = await seriesFor(PLUGIN_METRIC_DROPPED_METRIC);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toContain('reason="bad_name"');
  });
});
