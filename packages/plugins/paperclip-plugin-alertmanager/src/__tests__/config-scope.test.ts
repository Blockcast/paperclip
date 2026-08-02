/**
 * Per-company config/token resolution tests.
 *
 * Regression cover for BLO-20049: on a multi-company instance the host hands
 * the worker an EMPTY bootstrap config, so a token snapshotted during
 * `setup()` is null and every Alertmanager delivery is rejected 502
 * `unauthorized`. Saving config re-hydrated the in-memory token, which is why
 * the fault looked fixed until the next worker restart silently undid it.
 *
 * Mock-context pattern mirrors `worker.test.ts`.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  CompanyScopeUnavailableError,
  isEmptyConfig,
  resolveCompanyScope,
  resolveWebhookToken,
} from "../config-scope.js";
import type { AlertmanagerPluginConfig } from "../types.js";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  getCredentialHealth,
  recordCredentialResolution,
  resetCredentialHealth,
} from "../credential-health.js";

const COMPANY_A = "aaced805-3491-4ee5-9b14-cdf70cb81d47";
const TOKEN = "a".repeat(64);
const SECRET_REF = "6ec73a80-dead-beef-0000-000000000001";

const mkCtx = (overrides: {
  configByCompany?: Record<string, Record<string, unknown>>;
  resolveSecret?: (ref: unknown, opts?: unknown) => Promise<string>;
} = {}) => {
  const mocks = {
    config: {
      get: vi.fn(async (companyId?: string) =>
        companyId ? (overrides.configByCompany?.[companyId] ?? {}) : {},
      ),
    },
    secrets: {
      resolve: vi.fn(
        overrides.resolveSecret ??
          (async () => {
            throw new Error("no secret provider configured in this test");
          }),
      ),
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
  // Cast contained to test code; the mocks cover the surface these helpers touch.
  return { ctx: mocks as unknown as PluginContext, mocks };
};

const inlineConfig = (): AlertmanagerPluginConfig =>
  ({ defaultCompanyId: COMPANY_A, webhookToken: TOKEN }) as AlertmanagerPluginConfig;

beforeEach(() => {
  vi.clearAllMocks();
  // Module-level map shared across cases; several scope-resolution failures
  // now record into it, so leaking state between tests would be a false pass.
  resetCredentialHealth();
});

describe("isEmptyConfig", () => {
  it("treats the host's multi-company bootstrap payload as empty", () => {
    expect(isEmptyConfig({})).toBe(true);
    expect(isEmptyConfig(null)).toBe(true);
    expect(isEmptyConfig(undefined)).toBe(true);
    expect(isEmptyConfig({ webhookToken: TOKEN })).toBe(false);
  });
});

describe("resolveWebhookToken", () => {
  it("returns the inline dev-mode token when no ref is set", async () => {
    const { ctx, mocks } = mkCtx();
    await expect(resolveWebhookToken(ctx, inlineConfig(), COMPANY_A)).resolves.toBe(TOKEN);
    expect(mocks.secrets.resolve).not.toHaveBeenCalled();
  });

  it("fails closed for secret refs without consuming secret-resolution capacity", async () => {
    const { ctx, mocks } = mkCtx({ resolveSecret: async () => TOKEN });
    const config = { webhookTokenRef: SECRET_REF } as AlertmanagerPluginConfig;

    await expect(resolveWebhookToken(ctx, config, COMPANY_A)).rejects.toThrow(
      CompanyScopeUnavailableError,
    );
    expect(mocks.secrets.resolve).not.toHaveBeenCalled();
    expect(mocks.logger.error).toHaveBeenCalled();
  });

  it("uses an inline token without touching a configured ref", async () => {
    const { ctx, mocks } = mkCtx({
      resolveSecret: async () => {
        throw new Error("secret provider must not be reached from public auth");
      },
    });
    const config = {
      webhookToken: TOKEN,
      webhookTokenRef: SECRET_REF,
    } as AlertmanagerPluginConfig;

    await expect(resolveWebhookToken(ctx, config, COMPANY_A)).resolves.toBe(TOKEN);
    expect(mocks.secrets.resolve).not.toHaveBeenCalled();
  });

  it("propagates unsupported secret-ref config out of resolveCompanyScope without resolving it", async () => {
    // Secret refs require host-side verification before the worker is invoked.
    // Resolving them here lets unauthenticated public requests spend the
    // shared per-company secret-resolution budget before bearer verification.
    const { ctx, mocks } = mkCtx({
      configByCompany: {
        [COMPANY_A]: { defaultCompanyId: COMPANY_A, webhookTokenRef: SECRET_REF },
      },
      resolveSecret: async () => {
        throw new Error("secret provider unavailable (503)");
      },
    });

    await expect(resolveCompanyScope(ctx, COMPANY_A)).rejects.toThrow(
      CompanyScopeUnavailableError,
    );
    expect(mocks.secrets.resolve).not.toHaveBeenCalled();
  });

  it("warns and returns null when neither token nor ref is configured", async () => {
    // Unchanged, and deliberately so: "no credential is configured" IS a
    // determinate answer, so rejecting the delivery is correct.
    const { ctx, mocks } = mkCtx();
    await expect(
      resolveWebhookToken(ctx, {} as AlertmanagerPluginConfig, COMPANY_A),
    ).resolves.toBeNull();
    expect(mocks.logger.warn).toHaveBeenCalled();
  });
});

describe("resolveCompanyScope", () => {
  const COMPANY_B = "b1d3f3d3-adc9-48af-beb1-013a18368d84";

  it("BLO-20049: resolves the delivering company's token even when setup() snapshotted nothing", async () => {
    // Exactly the production shape: the host always gives setup() an empty
    // config, so there is nothing cached and the read must stand on its own.
    const { ctx, mocks } = mkCtx({
      configByCompany: { [COMPANY_A]: { defaultCompanyId: COMPANY_A, webhookToken: TOKEN } },
    });

    const scope = await resolveCompanyScope(ctx, COMPANY_A);

    expect(scope).not.toBeNull();
    expect(scope?.token).toBe(TOKEN);
    expect(scope?.config.defaultCompanyId).toBe(COMPANY_A);
    expect(mocks.config.get).toHaveBeenCalledWith(COMPANY_A);
  });

  it("keeps companies isolated — one company's token is not served to another", async () => {
    const otherToken = "b".repeat(64);
    const { ctx } = mkCtx({
      configByCompany: {
        [COMPANY_A]: { webhookToken: TOKEN },
        [COMPANY_B]: { webhookToken: otherToken },
      },
    });

    const a = await resolveCompanyScope(ctx, COMPANY_A);
    const b = await resolveCompanyScope(ctx, COMPANY_B);

    expect(a?.token).toBe(TOKEN);
    expect(b?.token).toBe(otherToken);
  });

  it("BLO-20467: a company with no stored config throws so the delivery fails, never served another tenant's token", async () => {
    // Company B has no config row. The worker globals may well hold company A's
    // config, because onConfigChanged fires per company without saying which —
    // so the only safe answer for B is "no scope", not "A's scope".
    //
    // It throws rather than returning null: returning normally would make the
    // host record the delivery `success` and answer 200, so Alertmanager would
    // never retry and the alert would be destroyed rather than delayed until an
    // operator adds B's config.
    const { ctx, mocks } = mkCtx({
      configByCompany: { [COMPANY_A]: { defaultCompanyId: COMPANY_A, webhookToken: TOKEN } },
    });

    await expect(resolveCompanyScope(ctx, COMPANY_B)).rejects.toThrow(
      CompanyScopeUnavailableError,
    );
    expect(mocks.logger.error).toHaveBeenCalled();
  });

  it("BLO-20467: a config-read failure throws so Alertmanager retries, never served another tenant's token", async () => {
    const { ctx, mocks } = mkCtx({
      configByCompany: { [COMPANY_A]: { defaultCompanyId: COMPANY_A, webhookToken: TOKEN } },
    });
    mocks.config.get.mockRejectedValueOnce(new Error("db down"));

    await expect(resolveCompanyScope(ctx, COMPANY_B)).rejects.toThrow(
      CompanyScopeUnavailableError,
    );
    expect(mocks.logger.error).toHaveBeenCalled();
  });

  it("BLO-20467: a delivery with no companyId is dropped rather than guessing a tenant", async () => {
    const { ctx, mocks } = mkCtx({
      configByCompany: { [COMPANY_A]: { webhookToken: TOKEN } },
    });

    // Dropped, not thrown: unlike a config failure, no retry can supply a
    // companyId, so failing the delivery would only produce a retry loop.
    await expect(
      resolveCompanyScope(ctx, undefined as unknown as string),
    ).resolves.toBeNull();
    expect(mocks.config.get).not.toHaveBeenCalled();
    expect(mocks.logger.error).toHaveBeenCalled();
  });

  it("merges route/owner defaults into the per-company config", async () => {
    const { ctx } = mkCtx({
      configByCompany: { [COMPANY_A]: { webhookToken: TOKEN } },
    });

    const scope = await resolveCompanyScope(ctx, COMPANY_A);

    expect(scope?.config.ownerMap).toBeDefined();
    expect(Object.keys(scope?.config.issueRouteMap ?? {}).length).toBeGreaterThan(0);
  });

  it("BLO-20467: adopts the delivering company as defaultCompanyId when the row omits it", async () => {
    // Without this the delivery authenticates fine and then every firing alert
    // hits webhook-handler's `defaultCompanyId not configured` guard and
    // no-ops — while the host still records success and answers 200, so
    // Alertmanager never retries and the alert is destroyed, not delayed.
    const { ctx } = mkCtx({
      configByCompany: { [COMPANY_A]: { webhookToken: TOKEN } },
    });

    const scope = await resolveCompanyScope(ctx, COMPANY_A);

    expect(scope?.config.defaultCompanyId).toBe(COMPANY_A);
  });

  it("BLO-20467: refuses to file one company's alerts under another company's id", async () => {
    // `defaultCompanyId` is an operator-typed string inside company A's own
    // row; the delivering company is the host's authenticated choice. If A's
    // row names B, the issue calls target a tenant outside this invocation's
    // scope, the host denies them, and handleWebhook's per-alert catch
    // swallows the denial — a 200 with no issue anywhere. Fail loudly instead.
    const { ctx, mocks } = mkCtx({
      configByCompany: {
        [COMPANY_A]: { defaultCompanyId: COMPANY_B, webhookToken: TOKEN },
      },
    });

    await expect(resolveCompanyScope(ctx, COMPANY_A)).rejects.toThrow(
      CompanyScopeUnavailableError,
    );
    expect(mocks.logger.error).toHaveBeenCalled();
  });
});

describe("credential health from the scope-resolution path (BLO-20572)", () => {
  const COMPANY_B = "b1d3f3d3-adc9-48af-beb1-013a18368d84";

  // `resolveCompanyScope` has exits that throw BEFORE `handleWebhook` runs, so
  // the recorder inside the handler never sees them. Recording only there left
  // `onHealth()` answering `ok` for a company rejecting 100% of deliveries —
  // exactly the silent-outage class this signal exists to end.

  it("goes degraded when a company's webhookTokenRef cannot be used", async () => {
    const { ctx } = mkCtx({
      configByCompany: {
        [COMPANY_A]: { defaultCompanyId: COMPANY_A, webhookTokenRef: SECRET_REF },
      },
    });
    expect(getCredentialHealth()).toEqual({ status: "ok" });

    await expect(resolveCompanyScope(ctx, COMPANY_A)).rejects.toThrow(
      CompanyScopeUnavailableError,
    );

    const health = getCredentialHealth();
    expect(health.status).toBe("degraded");
    expect(health.message).toContain(COMPANY_A);
    expect(health.details).toEqual({ companyIds: [COMPANY_A] });
  });

  it("never exposes the secret ref or a resolved value in health output", async () => {
    const { ctx } = mkCtx({
      configByCompany: {
        [COMPANY_A]: {
          defaultCompanyId: COMPANY_A,
          webhookTokenRef: SECRET_REF,
        },
      },
      resolveSecret: async () => TOKEN,
    });

    await expect(resolveCompanyScope(ctx, COMPANY_A)).rejects.toThrow(
      CompanyScopeUnavailableError,
    );

    // Assert it is actually reporting the fault first, so this cannot pass
    // vacuously against an empty (all-ok) health payload.
    const health = getCredentialHealth();
    expect(health.status).toBe("degraded");
    const serialized = JSON.stringify(health);
    expect(serialized).not.toContain(SECRET_REF);
    expect(serialized).not.toContain(TOKEN);
  });

  it("goes degraded when a company has no stored config at all", async () => {
    // Neither webhookToken nor webhookTokenRef — the literal AC condition.
    const { ctx } = mkCtx({
      configByCompany: {
        [COMPANY_A]: { defaultCompanyId: COMPANY_A, webhookToken: TOKEN },
      },
    });

    await expect(resolveCompanyScope(ctx, COMPANY_B)).rejects.toThrow(
      CompanyScopeUnavailableError,
    );

    expect(getCredentialHealth().details).toEqual({ companyIds: [COMPANY_B] });
  });

  it("stays ok on a transient config-read failure, so infra noise cannot flap health", async () => {
    // Deliberate: a config-RPC blip may not hold on retry. Flapping the health
    // surface on it would train operators to ignore the signal.
    const { ctx, mocks } = mkCtx({
      configByCompany: {
        [COMPANY_A]: { defaultCompanyId: COMPANY_A, webhookToken: TOKEN },
      },
    });
    mocks.config.get.mockRejectedValueOnce(new Error("db down"));

    await expect(resolveCompanyScope(ctx, COMPANY_A)).rejects.toThrow(
      CompanyScopeUnavailableError,
    );

    expect(getCredentialHealth()).toEqual({ status: "ok" });
  });

  it("stays ok for a routing-only mismatch, which is not a credential fault", async () => {
    const { ctx } = mkCtx({
      configByCompany: {
        [COMPANY_A]: { defaultCompanyId: COMPANY_B, webhookToken: TOKEN },
      },
    });

    await expect(resolveCompanyScope(ctx, COMPANY_A)).rejects.toThrow(
      CompanyScopeUnavailableError,
    );

    // Company A has a perfectly good token; saying otherwise would misreport it.
    expect(getCredentialHealth()).toEqual({ status: "ok" });
  });

  it("recovers once the company's credential is fixed, with no restart", async () => {
    const { ctx } = mkCtx({
      configByCompany: {
        [COMPANY_A]: { defaultCompanyId: COMPANY_A, webhookTokenRef: SECRET_REF },
      },
    });
    await expect(resolveCompanyScope(ctx, COMPANY_A)).rejects.toThrow(
      CompanyScopeUnavailableError,
    );
    expect(getCredentialHealth().status).toBe("degraded");

    // Operator swaps the ref for an inline token; the next delivery resolves a
    // scope and `handleWebhook` records the success that clears the fault.
    const fixed = mkCtx({
      configByCompany: {
        [COMPANY_A]: { defaultCompanyId: COMPANY_A, webhookToken: TOKEN },
      },
    });
    const scope = await resolveCompanyScope(fixed.ctx, COMPANY_A);
    expect(scope?.token).toBe(TOKEN);
    recordCredentialResolution(COMPANY_A, scope?.token ?? null);

    expect(getCredentialHealth()).toEqual({ status: "ok" });
  });
});
