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
  resolveSweepScope,
  resolveWebhookToken,
} from "../config-scope.js";
import type { AlertmanagerPluginConfig } from "../types.js";
import type { PluginContext } from "@paperclipai/plugin-sdk";

const COMPANY_A = "aaced805-3491-4ee5-9b14-cdf70cb81d47";
const TOKEN = "a".repeat(64);
const SECRET_REF = { type: "secret_ref" as const, secretId: "6ec73a80-dead-beef-0000-000000000001" };

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
    const { ctx } = mkCtx();
    await expect(resolveWebhookToken(ctx, inlineConfig(), COMPANY_A)).resolves.toBe(TOKEN);
  });

  it("resolves a secret ref scoped to the delivering company", async () => {
    const { ctx, mocks } = mkCtx({ resolveSecret: async () => TOKEN });
    const config = { webhookTokenRef: SECRET_REF } as unknown as AlertmanagerPluginConfig;

    await expect(resolveWebhookToken(ctx, config, COMPANY_A)).resolves.toBe(TOKEN);
    expect(mocks.secrets.resolve).toHaveBeenCalledWith(SECRET_REF, { companyId: COMPANY_A });
  });

  it("fails closed (null, no throw) when the ref cannot be resolved", async () => {
    const { ctx, mocks } = mkCtx({
      resolveSecret: async () => {
        throw new Error('Invalid secret reference for plugin. Use { type: "secret_ref", secretId }');
      },
    });
    const config = { webhookTokenRef: "bare-uuid-string" } as unknown as AlertmanagerPluginConfig;

    await expect(resolveWebhookToken(ctx, config, COMPANY_A)).resolves.toBeNull();
    expect(mocks.logger.error).toHaveBeenCalled();
  });

  it("warns and returns null when neither token nor ref is configured", async () => {
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
});

/**
 * BLO-20467 — the escalation sweep's tenant scope must come from the HOST's
 * per-invocation scope, never from a module global fed by `onConfigChanged`.
 *
 * The distinction these pin down:
 *  - unscoped `ctx.config.get()` inside a job tick is an RPC the host answers
 *    from `deriveCallInvocationScope`, which supplies `bootstrapCompanyId` only
 *    when exactly one company has the plugin configured;
 *  - with two or more, the tick has no scope and the host denies every
 *    company-scoped call, so the sweep must stop deliberately rather than walk
 *    into a guaranteed error per tick.
 */
describe("BLO-20467 escalation sweep scope resolution", () => {
  const sweepCtx = (configGet: () => Promise<unknown>) => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    return {
      ctx: { config: { get: vi.fn(configGet) }, logger } as unknown as PluginContext,
      logger,
    };
  };

  const scopeDenied = () => Object.assign(new Error("company context is required"), {
    code: -32005, // PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED
    name: "JsonRpcCallError",
  });

  it("reads the host-scoped company's live config on a single-company instance", async () => {
    // No onConfigChanged has fired — this is the state a freshly restarted
    // worker is in, and the sweep must work anyway.
    const { ctx } = sweepCtx(async () => ({ defaultCompanyId: COMPANY_A, autoCloseOnResolve: true }));
    const config = await resolveSweepScope(ctx);
    expect(config?.defaultCompanyId).toBe(COMPANY_A);
    // defaults merged in, so the sweep gets the same shape the webhook path does
    expect(config?.issueRouteMap).toBeDefined();
    expect(ctx.config.get).toHaveBeenCalledWith();
  });

  it("skips deterministically when the host denies scope (multi-company instance)", async () => {
    const { ctx, logger } = sweepCtx(async () => { throw scopeDenied(); });
    await expect(resolveSweepScope(ctx)).resolves.toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("BLO-20595"));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("more than one company"));
  });

  it("recognises a scope denial surfaced as a bare InvocationScopeDeniedError", async () => {
    // Direct (non-RPC) handler path: no numeric code, only the error name.
    const { ctx, logger } = sweepCtx(async () => {
      throw Object.assign(new Error("company context is required"), { name: "InvocationScopeDeniedError" });
    });
    await expect(resolveSweepScope(ctx)).resolves.toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("BLO-20595"));
  });

  it("distinguishes an ordinary config failure from a scope denial", async () => {
    // A transient RPC failure is an error, not the documented multi-company
    // limitation — logging it as the latter would send an operator to the wrong
    // issue.
    const { ctx, logger } = sweepCtx(async () => { throw new Error("connection reset"); });
    await expect(resolveSweepScope(ctx)).resolves.toBeNull();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("connection reset"));
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("skips when the scoped company has no stored config, or none naming a company", async () => {
    const empty = sweepCtx(async () => ({}));
    await expect(resolveSweepScope(empty.ctx)).resolves.toBeNull();
    expect(empty.logger.warn).toHaveBeenCalledWith(expect.stringContaining("no stored plugin config"));

    const noCompany = sweepCtx(async () => ({ autoCloseOnResolve: true }));
    await expect(resolveSweepScope(noCompany.ctx)).resolves.toBeNull();
    expect(noCompany.logger.warn).toHaveBeenCalledWith(expect.stringContaining("defaultCompanyId is not set"));
  });
});
