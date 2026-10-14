import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { alertStateRef } from "../constants.js";
import { runCoverageCheck } from "../coverage.js";
import type { AlertmanagerPluginConfig, AlertStateRecord } from "../types.js";

/** BLO-40673 AC4 — active Alertmanager alert with no open tracking row. */

const COMPANY = "company-1";
const NOW = new Date("2026-10-13T18:15:00Z"); // on a 15-minute boundary
const config: AlertmanagerPluginConfig = { defaultCompanyId: COMPANY, alertmanagerApiUrl: "http://am:9093" };
const AGG = 'alert-aggregate:v1:["Synthetic",null]';

const amAlert = (fingerprint: string, severity = "critical") => ({
  fingerprint,
  labels: { alertname: "Synthetic", severity },
  annotations: {},
  startsAt: "2026-10-13T17:00:00Z",
  endsAt: "0001-01-01T00:00:00Z",
  status: { state: "active" },
});

const record = (overrides: Partial<AlertStateRecord> = {}): AlertStateRecord => ({
  paperclipIssueId: "issue-1",
  paperclipCompanyId: COMPANY,
  aggregateKey: AGG,
  assigneeUserId: null,
  assigneeAgentId: null,
  alertname: "Synthetic",
  severity: "critical",
  firstSeenAt: "2026-10-01T00:00:00Z",
  lastFiredAt: "2026-10-13T17:00:00Z",
  resolvedAt: "2026-10-12T00:00:00Z",
  pluginClosedAt: "2026-10-12T00:00:00Z",
  ...overrides,
});

function harness(opts: {
  records?: Record<string, AlertStateRecord>;
  issues?: Record<string, { id: string; status: string }>;
  openAggregate?: boolean;
}) {
  const write = vi.fn(async () => {});
  const ctx = {
    state: {
      get: vi.fn(async (ref: ReturnType<typeof alertStateRef>) =>
        Object.entries(opts.records ?? {}).find(([fp]) => alertStateRef(COMPANY, fp).stateKey === ref.stateKey)?.[1] ?? null),
    },
    issues: {
      get: vi.fn(async (id: string) => opts.issues?.[id] ?? null),
      list: vi.fn(async (q: { originFingerprint?: string }) =>
        opts.openAggregate && q.originFingerprint === AGG ? [{ id: "winner", status: "todo" }] : []),
    },
    metrics: { write },
    logger: { warn: vi.fn(), info: vi.fn() },
  } as unknown as PluginContext;
  return { ctx, write };
}

const uncoveredCalls = (write: ReturnType<typeof vi.fn>) =>
  write.mock.calls.filter(([name]) => name === "alertmanager.coverage.uncovered");

describe("runCoverageCheck (BLO-40673 AC4)", () => {
  it("flags an active alert whose plugin-closed row is cancelled and has no aggregate winner", async () => {
    const { ctx, write } = harness({
      records: { fp1: record() },
      issues: { "issue-1": { id: "issue-1", status: "cancelled" } },
    });
    await runCoverageCheck(ctx, config, NOW, async () => [amAlert("fp1")]);
    expect(uncoveredCalls(write)).toEqual([
      ["alertmanager.coverage.uncovered", 1, { alertname: "Synthetic", severity: "critical" }],
    ]);
    expect(write).toHaveBeenCalledWith("alertmanager.coverage.checked", 1);
  });

  it("counts a missing tracked issue as uncovered", async () => {
    const { ctx, write } = harness({ records: { fp1: record() } });
    await runCoverageCheck(ctx, config, NOW, async () => [amAlert("fp1")]);
    expect(uncoveredCalls(write)).toHaveLength(1);
  });

  it("exempts an operator close still inside its suppression window", async () => {
    const { ctx, write } = harness({
      records: { fp1: record({ pluginClosedAt: null, operatorSuppressedAt: "2026-10-13T18:00:00Z" }) },
      issues: { "issue-1": { id: "issue-1", status: "cancelled" } },
    });
    await runCoverageCheck(ctx, { ...config, operatorSuppressionHours: 24 }, NOW, async () => [amAlert("fp1")]);
    expect(uncoveredCalls(write)).toHaveLength(0);
    expect(write).toHaveBeenCalledWith("alertmanager.coverage.checked", 1);
  });

  it("treats an open aggregate winner as coverage even when the member's own row is closed", async () => {
    const { ctx, write } = harness({
      records: { fp1: record() },
      issues: { "issue-1": { id: "issue-1", status: "cancelled" } },
      openAggregate: true,
    });
    await runCoverageCheck(ctx, config, NOW, async () => [amAlert("fp1")]);
    expect(uncoveredCalls(write)).toHaveLength(0);
  });

  it("exempts open rows, unfiled fingerprints, and terminal severities", async () => {
    const { ctx, write } = harness({
      records: { open: record(), terminal: record({ paperclipIssueId: "gone" }) },
      issues: { "issue-1": { id: "issue-1", status: "todo" } },
    });
    await runCoverageCheck(ctx, config, NOW, async () => [
      amAlert("open"),
      amAlert("never-filed"),
      amAlert("terminal", "none"),
    ]);
    expect(uncoveredCalls(write)).toHaveLength(0);
  });

  it("emits nothing at all when the Alertmanager read fails, so failure reads as missing data", async () => {
    const { ctx, write } = harness({});
    await runCoverageCheck(ctx, config, NOW, async () => null);
    expect(write).not.toHaveBeenCalled();
  });

  it("emits nothing when a classification throws, rather than under-reporting", async () => {
    const { ctx, write } = harness({});
    (ctx.state.get as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("scope expired"));
    await runCoverageCheck(ctx, config, NOW, async () => [amAlert("fp1")]);
    expect(write).not.toHaveBeenCalled();
  });

  it("only runs on the 15-minute boundary", async () => {
    const read = vi.fn(async () => []);
    const { ctx } = harness({});
    await runCoverageCheck(ctx, config, new Date("2026-10-13T18:16:00Z"), read);
    expect(read).not.toHaveBeenCalled();
  });
});
