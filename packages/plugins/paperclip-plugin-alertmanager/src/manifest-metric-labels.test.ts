import { describe, expect, it } from "vitest";

import manifest from "./manifest.js";

/**
 * BLO-32163 — the manifest half of the metric-label promotion gate.
 *
 * A plugin tag becomes a Prometheus label only if it appears in BOTH the
 * platform allow-list (`PLUGIN_METRIC_PROMOTABLE_TAG_KEYS`, pinned in
 * `server/src/__tests__/plugin-metric-exposition.test.ts`) AND this manifest's
 * `metricLabels`. Neither side can see the other at build time, so each pins
 * its own half.
 *
 * Why this is worth a test rather than left to review: dropping a key here
 * degrades *silently*. The metric keeps publishing and the alert rule keeps
 * evaluating — the series simply loses the label, so a wedged-fence page stops
 * naming which aggregate is stuck while still looking healthy on every
 * dashboard. There is no error to notice and no gap in the graph.
 */
describe("alertmanager manifest — promoted metric labels", () => {
  it("declares the labels a wedged-fence page needs to be actionable", () => {
    // `aggregate_key` identifies the specific wedged fence. `alertname` alone
    // cannot: two aggregates of the same rule differing only by
    // dedupe-domain are distinct fences that wedge independently.
    expect(manifest.metricLabels).toContain("aggregate_key");
    // `phase` names which half of the lifecycle is holding — `firing` vs
    // `cancelling` — which is the first thing a responder needs.
    expect(manifest.metricLabels).toContain("phase");
  });

  it("keeps the pre-existing PEN-2799 labels", () => {
    // Regression guard: BLO-32163 added to this list and must not have
    // replaced it.
    for (const key of ["alertname", "severity", "version"]) {
      expect(manifest.metricLabels).toContain(key);
    }
  });

  it("declares the metrics.write capability the labels are meaningless without", () => {
    expect(manifest.capabilities).toContain("metrics.write");
  });
});
