import { describe, expect, it } from "vitest";
import {
  alertMatchesLabelFilter,
  buildIssueDescription,
  buildIssueTitle,
  effectiveAlertStatus,
  extractObservabilityUrls,
  isTerminalSeverity,
  renderDrillInLinks,
  resolveAlertPriority,
  severityToPriority,
} from "../issue-mapping.js";
import type { AlertmanagerAlert } from "../types.js";

const baseAlert = (overrides: Partial<AlertmanagerAlert> = {}): AlertmanagerAlert => ({
  status: "firing",
  labels: {
    alertname: "CiliumPolicyDropsHigh",
    severity: "critical",
    team: "platform",
    node: "pve-3",
  },
  annotations: {
    summary: "261 GB of EGRESS traffic dropped on pve-3 in 21h",
    description: "Sustained policy-denied drops",
    runbook_url: "https://wiki/runbooks/cilium-drops",
  },
  startsAt: "2026-04-29T08:00:00Z",
  endsAt: "0001-01-01T00:00:00Z",
  generatorURL: "http://prometheus-0:9090/graph?g0.expr=foo",
  fingerprint: "9a3b1e4c5f6d7890",
  ...overrides,
});

describe("severityToPriority", () => {
  it("uses default mappings when no override is supplied", () => {
    expect(severityToPriority("critical")).toBe("critical");
    // BLO-20576: `warning` is the fleet's dominant severity and 84.6% of
    // its aged cohort auto-cancelled unattended, so it no longer mints `high`.
    expect(severityToPriority("warning")).toBe("medium");
    expect(severityToPriority("info")).toBe("medium");
    // BLO-27018: `page` and `ticket` are part of the emitted vocabulary, not
    // unknown values. `page` previously appeared in the "unknown severities"
    // case below, which pinned the defect: the fleet's highest-urgency alert
    // was mapped to `medium`.
    expect(severityToPriority("page")).toBe("critical");
    expect(severityToPriority("ticket")).toBe("low");
  });

  it("falls back to medium for unknown severities", () => {
    expect(severityToPriority("nonsense")).toBe("medium");
    expect(severityToPriority(undefined)).toBe("medium");
    expect(severityToPriority("")).toBe("medium");
  });

  it("matches case-insensitively", () => {
    expect(severityToPriority("CRITICAL")).toBe("critical");
    expect(severityToPriority(" Warning ")).toBe("medium");
  });

  it("operator override wins over the default map", () => {
    expect(
      severityToPriority("critical", { critical: "high", warning: "low" }),
    ).toBe("high");
    // Unmapped keys fall through to the default map, not the fallback.
    expect(
      severityToPriority("warning", { critical: "high" }),
    ).toBe("medium");
  });
});

describe("resolveAlertPriority (BLO-20576 per-rule escape hatch)", () => {
  const withLabels = (labels: Record<string, string>) =>
    baseAlert({ labels: { ...baseAlert().labels, ...labels } });

  it("falls through to the severity map when the label is absent", () => {
    expect(resolveAlertPriority(withLabels({ severity: "warning" }))).toEqual({
      priority: "medium",
    });
  });

  it("a rule that needs the old behaviour opts itself back up", () => {
    expect(
      resolveAlertPriority(
        withLabels({ severity: "warning", paperclip_priority: "high" }),
      ).priority,
    ).toBe("high");
  });

  it("the label outranks the operator override map too", () => {
    expect(
      resolveAlertPriority(
        withLabels({ severity: "warning", paperclip_priority: "low" }),
        { warning: "critical" },
      ).priority,
    ).toBe("low");
  });

  it("matches case-insensitively and tolerates surrounding space", () => {
    expect(
      resolveAlertPriority(
        withLabels({ severity: "warning", paperclip_priority: " Critical " }),
      ).priority,
    ).toBe("critical");
  });

  it("ignores a value that is not a real priority rather than failing the delivery", () => {
    // A PrometheusRule is not a trusted surface: an unrecognised value must
    // not reach ctx.issues.create, where it would reject the whole alert.
    for (const bad of ["urgent", "P1", "high;drop table"]) {
      expect(
        resolveAlertPriority(
          withLabels({ severity: "warning", paperclip_priority: bad }),
        ),
      ).toEqual({ priority: "medium", ignoredValue: bad });
    }
  });

  it("reports an ignored label so the caller can warn (a typo is not an absent label)", () => {
    expect(
      resolveAlertPriority(
        withLabels({ severity: "warning", paperclip_priority: "hgih" }),
      ).ignoredValue,
    ).toBe("hgih");
    // An honoured label is not a finding.
    expect(
      resolveAlertPriority(
        withLabels({ severity: "warning", paperclip_priority: "high" }),
      ).ignoredValue,
    ).toBeUndefined();
  });

  it("treats a whitespace-only label as absent, not as a typo", () => {
    // Prometheus drops empty labels, so warning on one is noise about a value
    // nobody set.
    for (const blank of ["", "   "]) {
      expect(
        resolveAlertPriority(
          withLabels({ severity: "warning", paperclip_priority: blank }),
        ),
      ).toEqual({ priority: "medium" });
    }
  });

  it("a non-string label is ignored, not thrown on", () => {
    // `isAlertmanagerPayload` deliberately does not validate label entries, so
    // a YAML `paperclip_priority: 5` arrives as a number despite the declared
    // Record<string, string>. A TypeError here is not a PermanentAlertError:
    // it fails the whole batch and Alertmanager redelivers into the same
    // deterministic crash until the alert is lost.
    for (const [bad, kind] of [
      [5, "number"],
      [true, "boolean"],
      [{}, "object"],
      [["high"], "object"],
    ] as const) {
      const alert = withLabels({ severity: "warning" });
      (alert.labels as Record<string, unknown>).paperclip_priority = bad;
      expect(() => resolveAlertPriority(alert)).not.toThrow();
      expect(resolveAlertPriority(alert)).toEqual({
        priority: "medium",
        ignoredValue: `<non-string ${kind}>`,
      });
    }
  });

  // `paperclip_issue` and `paperclip_dedupe_domain` both accept a label or an
  // annotation. An annotation-only `paperclip_priority` used to fall through as
  // "absent" — no effect, no warn, no metric — on the one surface whose whole
  // point is overriding a default.
  const withAnnotations = (
    labels: Record<string, string>,
    annotations: Record<string, string>,
  ) =>
    baseAlert({
      labels: { ...baseAlert().labels, ...labels },
      annotations: { ...baseAlert().annotations, ...annotations },
    });

  it("honours paperclip_priority set as an annotation, like its sibling escape hatches", () => {
    expect(
      resolveAlertPriority(
        withAnnotations({ severity: "warning" }, { paperclip_priority: "high" }),
      ),
    ).toEqual({ priority: "high" });
  });

  it("reports a junk annotation value instead of treating it as absent", () => {
    expect(
      resolveAlertPriority(
        withAnnotations({ severity: "warning" }, { paperclip_priority: "hgih" }),
      ),
    ).toEqual({ priority: "medium", ignoredValue: "hgih" });
  });

  it("the label wins over the annotation when both are set", () => {
    expect(
      resolveAlertPriority(
        withAnnotations(
          { severity: "warning", paperclip_priority: "low" },
          { paperclip_priority: "critical" },
        ),
      ).priority,
    ).toBe("low");
  });

  it("an absent severity still resolves under the operator's `unknown` key", () => {
    // `severity` is normalized to "unknown" before the map lookup, exactly as
    // the pre-BLO-20576 call site did. Passing the raw label instead would
    // short-circuit on `!severity` and silently stop consulting this override.
    const alert = baseAlert({ labels: { alertname: "X" } });
    expect(resolveAlertPriority(alert, { unknown: "low" }).priority).toBe("low");
    // No such key in the default map, so only the override path changes.
    expect(resolveAlertPriority(alert).priority).toBe("medium");
  });
});

describe("isTerminalSeverity (BLO-24177)", () => {
  it("matches the built-in default terminal severity (none)", () => {
    expect(isTerminalSeverity("none")).toBe(true);
  });

  it("does not match accepted severities by default", () => {
    expect(isTerminalSeverity("critical")).toBe(false);
    expect(isTerminalSeverity("warning")).toBe(false);
    expect(isTerminalSeverity("info")).toBe(false);
    expect(isTerminalSeverity(undefined)).toBe(false);
    expect(isTerminalSeverity("")).toBe(false);
  });

  it("matches case-insensitively and trims whitespace", () => {
    expect(isTerminalSeverity("NONE")).toBe(true);
    expect(isTerminalSeverity(" None ")).toBe(true);
  });
});

describe("buildIssueTitle", () => {
  it("formats per spec §7.1", () => {
    expect(buildIssueTitle(baseAlert())).toBe(
      "[critical] CiliumPolicyDropsHigh · platform",
    );
  });

  it("falls back to node when team is missing", () => {
    const alert = baseAlert({
      labels: {
        alertname: "PodOOMKilled",
        severity: "warning",
        node: "pve-3",
      },
    });
    expect(buildIssueTitle(alert)).toBe("[warning] PodOOMKilled · pve-3");
  });

  it("omits the trailing context when neither team nor node is set", () => {
    const alert = baseAlert({
      labels: { alertname: "Watchdog", severity: "info" },
    });
    expect(buildIssueTitle(alert)).toBe("[info] Watchdog");
  });

  it("falls back to envelope.commonLabels when alert labels are bare", () => {
    const alert = baseAlert({
      labels: { alertname: "GenericAlert", severity: "warning" },
    });
    expect(
      buildIssueTitle(alert, { commonLabels: { team: "networking" } }),
    ).toBe("[warning] GenericAlert · networking");
  });
});

describe("extractObservabilityUrls", () => {
  it("pulls reserved annotation keys plus generatorURL", () => {
    const alert = baseAlert({
      annotations: {
        dashboard_url: "https://grafana/d/xyz",
        trace_url: "https://grafana/explore",
        runbook_url: "https://runbooks/x",
        // Not in the allowlist — must NOT show up in result.
        random_url: "https://attacker/",
      },
    });
    const urls = extractObservabilityUrls(alert);
    expect(urls).toEqual({
      dashboard_url: "https://grafana/d/xyz",
      trace_url: "https://grafana/explore",
      runbook_url: "https://runbooks/x",
      generator_url: "http://prometheus-0:9090/graph?g0.expr=foo",
    });
  });

  it("returns an empty object when nothing is set", () => {
    const alert = baseAlert({
      annotations: {},
      generatorURL: undefined,
    });
    expect(extractObservabilityUrls(alert)).toEqual({});
  });
});

describe("renderDrillInLinks", () => {
  it("renders a markdown list under a `### Drill in` header", () => {
    const rendered = renderDrillInLinks({
      dashboard_url: "https://grafana/d/xyz",
      profile_url: "https://pyroscope/x",
      generator_url: "https://prom/graph",
    });
    expect(rendered).toBe(
      [
        "### Drill in",
        "- [Dashboard](https://grafana/d/xyz)",
        "- [Pyroscope flamegraph](https://pyroscope/x)",
        "- [Source query in Prometheus](https://prom/graph)",
      ].join("\n"),
    );
  });

  it("returns empty string when there's nothing to render", () => {
    expect(renderDrillInLinks({})).toBe("");
  });

  it("preserves the canonical key order regardless of input ordering", () => {
    const rendered = renderDrillInLinks({
      generator_url: "g",
      dashboard_url: "d",
      runbook_url: "r",
    });
    const expectedOrder = ["Dashboard", "Runbook", "Source query in Prometheus"];
    for (let i = 0; i < expectedOrder.length - 1; i++) {
      const cur = rendered.indexOf(expectedOrder[i]!);
      const next = rendered.indexOf(expectedOrder[i + 1]!);
      expect(cur).toBeGreaterThanOrEqual(0);
      expect(next).toBeGreaterThan(cur);
    }
  });
});

describe("buildIssueDescription", () => {
  it("includes summary, description, metadata block, labels table, and drill-in links", () => {
    const alert = baseAlert({
      annotations: {
        summary: "Lots of drops",
        description: "Egress drops sustained",
        runbook_url: "https://runbooks/x",
        dashboard_url: "https://grafana/d/y",
      },
    });
    const body = buildIssueDescription(alert);
    expect(body).toContain("**Summary**: Lots of drops");
    expect(body).toContain("Egress drops sustained");
    expect(body).toContain("**Started**: 2026-04-29T08:00:00Z");
    expect(body).toContain("**Severity**: critical");
    expect(body).toContain("**Source**: http://prometheus-0:9090/graph?g0.expr=foo");
    expect(body).toContain("**Runbook**: https://runbooks/x");
    expect(body).toContain("### Labels");
    expect(body).toContain("| alertname | CiliumPolicyDropsHigh |");
    expect(body).toContain("### Drill in");
    expect(body).toContain("[Dashboard](https://grafana/d/y)");
    expect(body).toContain("[Runbook](https://runbooks/x)");
  });

  it("renders cleanly when annotations are empty", () => {
    const alert = baseAlert({ annotations: {} });
    const body = buildIssueDescription(alert);
    expect(body).toContain("**Summary**: CiliumPolicyDropsHigh");
    expect(body).toContain("**Runbook**: —");
    // No drill-in section header when there's nothing to render apart from
    // generator_url — but generator_url IS present here, so the section
    // should appear with just that one entry.
    expect(body).toContain("### Drill in");
    expect(body).toContain("[Source query in Prometheus]");
  });
});

describe("alertMatchesLabelFilter", () => {
  it("accepts when filter is empty / unset", () => {
    expect(alertMatchesLabelFilter(baseAlert(), undefined)).toBe(true);
    expect(alertMatchesLabelFilter(baseAlert(), {})).toBe(true);
  });

  it("requires every filter pair to match exactly", () => {
    const alert = baseAlert({
      labels: { alertname: "X", severity: "info", paperclip: "true" },
    });
    expect(alertMatchesLabelFilter(alert, { paperclip: "true" })).toBe(true);
    expect(alertMatchesLabelFilter(alert, { paperclip: "false" })).toBe(false);
    expect(
      alertMatchesLabelFilter(alert, { paperclip: "true", severity: "info" }),
    ).toBe(true);
    expect(
      alertMatchesLabelFilter(alert, { paperclip: "true", severity: "warning" }),
    ).toBe(false);
  });
});

describe("effectiveAlertStatus", () => {
  it("prefers the per-alert status", () => {
    expect(
      effectiveAlertStatus(baseAlert({ status: "resolved" }), { status: "firing" }),
    ).toBe("resolved");
  });
});
