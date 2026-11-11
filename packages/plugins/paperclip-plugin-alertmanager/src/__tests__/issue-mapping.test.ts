import { describe, expect, it } from "vitest";
import { ISSUE_PRIORITIES } from "@paperclipai/shared";
import {
  alertMatchesLabelFilter,
  buildAggregateIssueDescription,
  buildIssueDescription,
  MACHINE_RENDERED_NOTICE,
  buildIssueTitle,
  effectiveAlertStatus,
  extractObservabilityUrls,
  isTerminalSeverity,
  renderDrillInLinks,
  resolveAlertPriority,
  severityToPriority,
} from "../issue-mapping.js";
import {
  AGENT_NOTES_MARKER,
  composeDescription,
} from "../description-notes.js";
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

  it("never returns a prototype value for a severity named after one", () => {
    // Both maps are plain objects, so indexing reaches Object.prototype. Only
    // `constructor` and `__proto__` survive the toLowerCase() — `toString`,
    // the value the review cited, lowercases to `tostring` and never matched —
    // and both used to come back as `function Object` / `[object Object]` and
    // reach ctx.issues.create as a priority.
    //
    // Asserted as membership rather than === "medium" so it fails on the
    // unfixed code rather than on a change to the fallback value.
    for (const severity of ["constructor", "__proto__", "Constructor", " __proto__ "]) {
      for (const override of [undefined, { nothing: "low" as const }]) {
        expect(ISSUE_PRIORITIES).toContain(severityToPriority(severity, override));
      }
    }
    // Same hole on the override map, which is operator-supplied config.
    expect(
      ISSUE_PRIORITIES,
    ).toContain(severityToPriority("constructor", { critical: "high" }));
  });

  it("rejects an operator override value that is not a priority", () => {
    // manifest.ts declares an enum for severityToPriority, but that schema is
    // config-UI documentation, not a runtime gate on what reaches here.
    const rogue = { warning: "urgent" } as unknown as Record<
      string,
      "critical" | "high" | "medium" | "low"
    >;
    expect(ISSUE_PRIORITIES).toContain(severityToPriority("warning", rogue));
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

  it("bounds and flattens the ignored value before it reaches a log line", () => {
    // webhook-handler.ts interpolates ignoredValue straight into a warn. A
    // newline forges log records; an unbounded value bloats them.
    const forged = "hgih\ncritical: all systems nominal\r\n  trailing";
    const ignored = resolveAlertPriority(
      withLabels({ severity: "warning", paperclip_priority: forged }),
    ).ignoredValue;
    expect(ignored).toBeDefined();
    expect(ignored).not.toMatch(/[\r\n]/);
    expect(ignored!.length).toBeLessThanOrEqual(64);

    const long = "x".repeat(500);
    const bounded = resolveAlertPriority(
      withLabels({ severity: "warning", paperclip_priority: long }),
    ).ignoredValue;
    expect(bounded!.length).toBeLessThanOrEqual(64);
    // Truncation is visible, so a support reader does not mistake the stand-in
    // for the whole value the rule author actually set.
    expect(bounded!.endsWith("…")).toBe(true);

    // A value already short and single-line is echoed verbatim — the existing
    // expectations above depend on that.
    expect(
      resolveAlertPriority(
        withLabels({ severity: "warning", paperclip_priority: "high;drop table" }),
      ).ignoredValue,
    ).toBe("high;drop table");
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

  /**
   * PEN-6404 -- the body has to say it is not a record surface, at the top.
   *
   * Every firing delivery replaces this column wholesale and never reads what
   * it replaces, so an agent recording a constraint here loses it inside the
   * hour (measured on PEN-6292: ten revisions, one distinct hash, 40-65 min
   * apart). No in-run check can see it -- the write succeeds, the same-run
   * re-read succeeds, and the overwrite lands after the run has ended -- which
   * is why the warning has to travel in the artifact rather than be left to a
   * reader who already believes the description is the record.
   *
   * Pinned on POSITION, not only presence. The directive it mirrors tells a
   * reader to decide at depth 0, so a notice that drifts below the labels
   * table is reaching them after they have decided; and the aggregate renderer
   * appends its members table after this body, so last-position would be
   * mid-document on exactly the rows that are hardest to read.
   */
  it("leads the body with the machine-rendered notice, ahead of the summary", () => {
    const body = buildIssueDescription(baseAlert());

    expect(body.startsWith(MACHINE_RENDERED_NOTICE)).toBe(true);
    expect(body.indexOf(MACHINE_RENDERED_NOTICE)).toBeLessThan(body.indexOf("**Summary**"));
  });

  /**
   * The notice is only useful if it names somewhere else to write. A version
   * trimmed to "machine-generated" tells a reader their text is doomed and
   * leaves them nowhere to put it, which is the state this row was filed from.
   *
   * The negative is the review finding, pinned. The first draft offered this
   * row's own `monitorNotes` as the second carrier, which swaps one silently
   * destroyed field for another on a different clock: the same plugin cancels
   * the row when its alert resolves, the monitor is cleared as undeliverable
   * and the notes go with it -- 13 of 13 measured destructions, every one
   * paired with the plugin's own cancel (runbook Rule 2). A monitor that has
   * to outlive the alert belongs on a row of the reader's own.
   */
  it("routes to a carrier that survives, and never to this row's monitor", () => {
    // Positive first: a notice that only forbids leaves the reader nowhere to write.
    expect(MACHINE_RENDERED_NOTICE).toContain("COMMENT on this row");
    expect(MACHINE_RENDERED_NOTICE).toContain(
      "runbooks/alertmanager-alert-row-status-volatility.md",
    );

    expect(MACHINE_RENDERED_NOTICE).not.toContain("monitorNotes");
  });

  /**
   * This string renders into every alert row of every company that installs
   * the plugin, so it may carry nothing true of only one of them.
   *
   * The delivery spacing is a property of each install's Alertmanager route
   * (`group_interval`/`repeat_interval`) and not of this code -- the runbook
   * measures it here and says in as many words not to quote the figure as a
   * property of anything. An issue key resolves in exactly one company's
   * identifier space and is a dead reference everywhere else. The runbook
   * path is in this repo and reads the same from anywhere.
   */
  it("carries no per-install spacing figure and no company-scoped issue key", () => {
    expect(MACHINE_RENDERED_NOTICE).not.toMatch(/\d+\s*-\s*\d+\s*min/);
    expect(MACHINE_RENDERED_NOTICE).not.toMatch(/\b[A-Z]{2,}-\d+\b/);
  });

  /**
   * PEN-6404 / PEN-6218. The notice is rendered as the FIRST section of the
   * re-rendered head; `composeDescription` then appends the notes banner and
   * marker BELOW it. So the two strings always ship in the same body, and a
   * notice scoped to the whole description contradicts the banner outright --
   * the body would open by saying every write is destroyed and close by saying
   * writes below the line are kept.
   *
   * This is pinned on the COMPOSED body rather than on the constant, because
   * that is the only place the contradiction exists. Asserting the constant
   * alone is what let the first draft through: every assertion on
   * MACHINE_RENDERED_NOTICE passed, and the defect was in how it reads beside
   * a string from another module.
   */
  it("does not contradict the preserved-notes banner it ships beside", () => {
    const composed = composeDescription(buildIssueDescription(baseAlert()), null);

    // Both halves really are present, or the rest of this test is vacuous.
    expect(composed).toContain(MACHINE_RENDERED_NOTICE);
    expect(composed).toContain(AGENT_NOTES_MARKER);
    expect(composed).toContain("preserved across syncs");

    // The notice must scope its claim to its own section, never to the body.
    expect(MACHINE_RENDERED_NOTICE).toContain("This section is machine-generated");
    expect(MACHINE_RENDERED_NOTICE).not.toContain("This description is machine-generated");
    expect(MACHINE_RENDERED_NOTICE).not.toContain("Anything written here is destroyed");

    // And it must route to the preserved region rather than deny one exists.
    expect(MACHINE_RENDERED_NOTICE).toContain("BELOW the notes marker");

    // The notice sits above the marker, i.e. inside the half that is replaced.
    expect(composed.indexOf(MACHINE_RENDERED_NOTICE)).toBeLessThan(
      composed.indexOf(AGENT_NOTES_MARKER),
    );
  });

  /**
   * The aggregate renderer composes `[body, members table]`, so a notice
   * appended to the single-subject body would sit between them. Position is
   * asserted against the members heading specifically, because that is the
   * only thing that can get in front of it.
   */
  it("keeps the notice first on an aggregate body, ahead of the members table", () => {
    const body = buildAggregateIssueDescription([
      { fingerprint: "aaaa", alert: baseAlert() },
      { fingerprint: "bbbb", alert: baseAlert({ startsAt: "2026-04-29T09:00:00Z" }) },
    ]);

    expect(body).not.toBeNull();
    expect(body!.startsWith(MACHINE_RENDERED_NOTICE)).toBe(true);
    expect(body!.indexOf("### Active members")).toBeGreaterThan(
      body!.indexOf(MACHINE_RENDERED_NOTICE),
    );
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
