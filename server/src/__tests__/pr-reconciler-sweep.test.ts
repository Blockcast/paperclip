import { describe, it, expect, vi } from "vitest";
import {
  computeReconcilerWindow,
  resolveReconcilerToken,
  runReconcilerSweep,
  type ReconcilerTarget,
  type ReconcileResult,
} from "../services/pr-reconciler-sweep.js";

const zero: ReconcileResult = {
  enumerated: 0,
  linked: 0,
  unlinked: 0,
  enriched: 0,
  workProductsOffered: 0,
};

describe("computeReconcilerWindow", () => {
  it("derives a trailing window of exactly windowDays, until=now", () => {
    const now = new Date("2026-06-05T00:00:00Z");
    const { since, until } = computeReconcilerWindow(now, 21);
    expect(until).toBe(now);
    expect(since.toISOString()).toBe("2026-05-15T00:00:00.000Z");
  });
});

describe("runReconcilerSweep", () => {
  const targets: ReconcilerTarget[] = [
    { companyId: "c1", repoFullName: "Blockcast/a" },
    { companyId: "c1", repoFullName: "Blockcast/b" },
  ];
  const now = new Date("2026-06-05T00:00:00Z");

  it("aggregates per-repo totals and passes the same window to every target", async () => {
    const seenWindows: string[] = [];
    const reconcile = vi.fn(async (_t: ReconcilerTarget, w: { since: Date; until: Date }) => {
      seenWindows.push(`${w.since.toISOString()}..${w.until.toISOString()}`);
      return { enumerated: 5, linked: 3, unlinked: 2, enriched: 1, workProductsOffered: 4 };
    });

    const res = await runReconcilerSweep({ targets, now, windowDays: 21, reconcile });

    expect(res.targets).toBe(2);
    expect(res.ok).toBe(2);
    expect(res.failed).toBe(0);
    expect(res.totals).toEqual({
      enumerated: 10,
      linked: 6,
      unlinked: 4,
      enriched: 2,
      // PEN-6413: repaired work-product rows aggregate like every other total,
      // so an operator can see whether the backfill is doing anything.
      workProductsOffered: 8,
    });
    // Both repos reconciled against one identical window.
    expect(new Set(seenWindows).size).toBe(1);
    expect(reconcile).toHaveBeenCalledTimes(2);
  });

  it("isolates a failing repo: one throw does not abort the rest", async () => {
    const onError = vi.fn();
    const reconcile = vi.fn(async (t: ReconcilerTarget) => {
      if (t.repoFullName === "Blockcast/a") throw new Error("rate limited");
      return { enumerated: 4, linked: 4, unlinked: 0, enriched: 0, workProductsOffered: 0 };
    });

    const res = await runReconcilerSweep({ targets, now, windowDays: 7, reconcile, onError });

    expect(res.ok).toBe(1);
    expect(res.failed).toBe(1);
    expect(res.totals).toEqual({
      enumerated: 4,
      linked: 4,
      unlinked: 0,
      enriched: 0,
      workProductsOffered: 0,
    });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toEqual({ companyId: "c1", repoFullName: "Blockcast/a" });
  });

  it("returns zeros for an empty target set without calling reconcile", async () => {
    const reconcile = vi.fn(async () => zero);
    const res = await runReconcilerSweep({ targets: [], now, windowDays: 21, reconcile });
    expect(res).toMatchObject({ targets: 0, ok: 0, failed: 0, totals: zero });
    expect(reconcile).not.toHaveBeenCalled();
  });
});

describe("resolveReconcilerToken (PEN-6413)", () => {
  it("prefers an explicit env token and never consults the App", async () => {
    const getInstallationToken = vi.fn(async () => "app-token");
    const appCredentialsConfigured = vi.fn(() => true);

    const res = await resolveReconcilerToken({
      envToken: "pat-token",
      appCredentialsConfigured,
      getInstallationToken,
    });

    expect(res).toEqual({ ok: true, token: "pat-token", source: "env" });
    expect(getInstallationToken).not.toHaveBeenCalled();
    expect(appCredentialsConfigured).not.toHaveBeenCalled();
  });

  it("falls back to the App installation token when no env token is set", async () => {
    const res = await resolveReconcilerToken({
      envToken: null,
      appCredentialsConfigured: () => true,
      getInstallationToken: async () => "app-token",
    });

    expect(res).toEqual({ ok: true, token: "app-token", source: "github_app" });
  });

  it("refuses without minting when neither credential source is configured", async () => {
    const getInstallationToken = vi.fn(async () => "app-token");

    const res = await resolveReconcilerToken({
      envToken: null,
      appCredentialsConfigured: () => false,
      getInstallationToken,
    });

    expect(res).toEqual({ ok: false, reason: "no_credentials" });
    expect(getInstallationToken).not.toHaveBeenCalled();
  });

  it("refuses when the App is configured but minting fails", async () => {
    const res = await resolveReconcilerToken({
      envToken: null,
      appCredentialsConfigured: () => true,
      getInstallationToken: async () => null,
    });

    expect(res).toEqual({ ok: false, reason: "github_app_token_unavailable" });
  });

  it("re-asks on every call, so a per-tick caller never reuses an expired token", async () => {
    // The sweep interval defaults to 6h and an installation token lives ~1h, so
    // a resolver that answered once from its own cache would succeed on the
    // startup pass and fail silently on every tick after it.
    let n = 0;
    const getInstallationToken = vi.fn(async () => `app-token-${++n}`);

    const first = await resolveReconcilerToken({
      envToken: null,
      appCredentialsConfigured: () => true,
      getInstallationToken,
    });
    const second = await resolveReconcilerToken({
      envToken: null,
      appCredentialsConfigured: () => true,
      getInstallationToken,
    });

    expect(getInstallationToken).toHaveBeenCalledTimes(2);
    expect(first).toEqual({ ok: true, token: "app-token-1", source: "github_app" });
    expect(second).toEqual({ ok: true, token: "app-token-2", source: "github_app" });
  });
});
