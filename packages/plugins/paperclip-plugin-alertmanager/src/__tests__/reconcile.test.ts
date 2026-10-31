import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { AlertStateRecord, AlertmanagerPluginConfig } from "../types.js";

const handleWebhook = vi.fn(async () => ({ accepted: 1 }));
const states = new Map<string, Partial<AlertStateRecord>>();
vi.mock("../webhook-handler.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../webhook-handler.js")>();
  return {
    ...actual,
    handleWebhook: (...args: unknown[]) => handleWebhook(...(args as [])),
    readAlertState: async (_ctx: unknown, _company: string, fp: string) => ({
      ref: {},
      record: states.get(fp) ?? null,
    }),
  };
});

const { reconcileActiveAlerts, RECONCILE_MAX_PER_PASS } = await import("../reconcile.js");
const { isAlertmanagerPayload } = await import("../webhook-handler.js");

const NOW = new Date("2026-10-12T12:00:00Z");
const OLD = "2026-10-12T11:00:00Z"; // past the grace window
const config: AlertmanagerPluginConfig = {
  defaultCompanyId: "company-1",
  alertmanagerApiUrl: "http://am:9093/",
  reconcileReceivers: ["paperclip"],
};

function amAlert(fp: string, over: Record<string, unknown> = {}) {
  return {
    fingerprint: fp,
    labels: { alertname: `A-${fp}`, severity: "warning" },
    annotations: {},
    startsAt: OLD,
    endsAt: "2026-10-12T12:30:00Z",
    receivers: [{ name: "paperclip" }],
    status: { state: "active", silencedBy: [], inhibitedBy: [] },
    ...over,
  };
}

const ctx = {
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  metrics: { write: vi.fn(async () => {}), observe: vi.fn(async () => {}) },
  // No tracked member rows: these cases cover the firing backfill only. The
  // lost-resolve pass is exercised end to end in reconcile-lost-resolve.test.ts.
  db: { namespace: "ns", query: vi.fn(async () => []) },
} as unknown as PluginContext;

let served: unknown[] = [];
beforeEach(() => {
  handleWebhook.mockClear();
  states.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(served), { status: 200 })),
  );
});
afterEach(() => vi.unstubAllGlobals());

function submitted(): string[] {
  if (handleWebhook.mock.calls.length === 0) return [];
  const input = (handleWebhook.mock.calls[0] as unknown[])[3] as { parsedBody: { alerts: { fingerprint: string }[] } };
  return input.parsedBody.alerts.map((a) => a.fingerprint);
}

describe("reconcileActiveAlerts (BLO-44820)", () => {
  it("backfills an untracked alert routed to this company, through the push path", async () => {
    served = [amAlert("lost")];
    const result = await reconcileActiveAlerts(ctx, config, NOW);
    expect(result.backfilled).toEqual(["lost"]);
    const [, , authenticated, input] = handleWebhook.mock.calls[0] as unknown as [
      unknown, unknown, boolean, { endpointKey: string; parsedBody: unknown },
    ];
    expect(authenticated).toBe(true);
    expect(input.endpointKey).toBe("alertmanager");
    // The synthetic payload must pass the same shape gate a real delivery does,
    // or handleWebhook drops it as malformed and the backfill is a silent no-op.
    expect(isAlertmanagerPayload(input.parsedBody)).toBe(true);
  });

  it("dedupes on the fingerprint state row (originId) — a tracked alert is not resubmitted", async () => {
    served = [amAlert("tracked")];
    states.set("tracked", { resolvedAt: null });
    expect((await reconcileActiveAlerts(ctx, config, NOW)).backfilled).toEqual([]);
    expect(handleWebhook).not.toHaveBeenCalled();
  });

  it("re-submits a re-fire whose delivery was lost, but not a resolve newer than the occurrence", async () => {
    served = [amAlert("refired"), amAlert("ahead")];
    states.set("refired", { resolvedAt: "2026-10-12T10:00:00Z" });
    states.set("ahead", { resolvedAt: "2026-10-12T11:30:00Z" });
    await reconcileActiveAlerts(ctx, config, NOW);
    expect(submitted()).toEqual(["refired"]);
  });

  it("skips other receivers, young alerts, opt-outs, filtered and below-floor alerts", async () => {
    served = [
      amAlert("other-tenant", { receivers: [{ name: "paperclip-penstock" }] }),
      amAlert("young", { startsAt: "2026-10-12T11:55:00Z" }),
      amAlert("opted-out", { labels: { alertname: "X", paperclip_issue: "false" } }),
      amAlert("info", { labels: { alertname: "Y", severity: "info" } }),
      amAlert("filtered", { labels: { alertname: "Z", team: "other" } }),
      amAlert("keep"),
    ];
    const result = await reconcileActiveAlerts(ctx, { ...config, acceptOnlyLabels: { team: "platform" } }, NOW);
    // `keep` has no team label, so the label filter removes it too.
    expect(result.backfilled).toEqual([]);
    expect(result.routed).toBe(5);
    await reconcileActiveAlerts(ctx, config, NOW);
    expect(submitted()).toEqual(["filtered", "keep"]);
  });

  it("does not backfill a silenced or inhibited alert, which Alertmanager never notifies", async () => {
    served = [amAlert("silenced", { status: { state: "suppressed", silencedBy: ["s1"], inhibitedBy: [] } })];
    expect((await reconcileActiveAlerts(ctx, config, NOW)).backfilled).toEqual([]);
  });

  it("caps a backlog per pass so recovery is not a burst", async () => {
    served = Array.from({ length: RECONCILE_MAX_PER_PASS + 10 }, (_, i) => amAlert(`fp-${i}`));
    expect((await reconcileActiveAlerts(ctx, config, NOW)).backfilled).toHaveLength(RECONCILE_MAX_PER_PASS);
  });

  it("is off without reconcileReceivers, and never reads Alertmanager", async () => {
    const result = await reconcileActiveAlerts(ctx, { ...config, reconcileReceivers: [] }, NOW);
    expect(result.skipped).toMatch(/reconcileReceivers/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("falls back to the host PAPERCLIP_ALERTMANAGER_API_URL default like the escalation ladder (BLO-40673)", async () => {
    vi.stubEnv("PAPERCLIP_ALERTMANAGER_API_URL", "http://am-env:9093/");
    try {
      served = [amAlert("lost")];
      const result = await reconcileActiveAlerts(ctx, { ...config, alertmanagerApiUrl: undefined }, NOW);
      expect(result.backfilled).toEqual(["lost"]);
      expect(String((fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0])).toMatch(/^http:\/\/am-env:9093\/api\/v2\/alerts/);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("fails the run on an unreadable Alertmanager instead of reporting nothing missing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 503 })));
    await expect(reconcileActiveAlerts(ctx, config, NOW)).rejects.toThrow(/503/);
  });
});
