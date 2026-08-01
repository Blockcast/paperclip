/**
 * BLO-20467 — a config change must restart this worker.
 *
 * The escalation sweep's company scope is `bootstrapCompanyId`, computed once
 * per worker spawn and frozen into `WorkerStartOptions`. Nothing inside the
 * worker can refresh it, so `onConfigChanged` deliberately fails with
 * METHOD_NOT_IMPLEMENTED to reach the host's existing restart fallback.
 *
 * Two layers of cover here, because neither alone is worth much:
 *
 *  1. The wiring — `worker.ts` really does raise that code. Asserted against
 *     the actual plugin definition, not a stand-in, by stubbing the SDK's
 *     `startWorkerRpcHost` (which `worker.ts` calls at import time) so the
 *     module can be imported at all.
 *  2. The consequence — a host that behaves as `routes/plugins.ts` +
 *     `plugin-lifecycle.ts` + `plugin-loader.ts` do ends up with a sweep scope
 *     matching the config, across every cardinality transition. Modelled here
 *     rather than asserted end-to-end because those are server-side modules
 *     this package cannot import; the model's fidelity rests on the line
 *     references in `configChangedRequiresRestart`'s doc comment.
 *
 * Every transition is asserted twice — once against a worker that raises the
 * code and once against one that returns successfully, which is precisely what
 * this hook used to do. The second arm is the mutation check: if it also
 * reached the right scope, these assertions would not be testing the fix.
 */

import { describe, expect, it, vi } from "vitest";
import {
  configChangedRequiresRestart,
  resolveSweepScope,
} from "../config-scope.js";
import type { PluginContext } from "@paperclipai/plugin-sdk";

const COMPANY_A = "aaced805-3491-4ee5-9b14-cdf70cb81d47";
const COMPANY_B = "bbbbbbbb-3491-4ee5-9b14-cdf70cb81d47";

/** `PLUGIN_RPC_ERROR_CODES.METHOD_NOT_IMPLEMENTED` (sdk/src/protocol.ts). */
const METHOD_NOT_IMPLEMENTED = -32004;
/** `PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED`. */
const INVOCATION_SCOPE_DENIED = -32005;

// ---------------------------------------------------------------------------
// 1. The wiring: worker.ts raises the code
// ---------------------------------------------------------------------------

describe("worker.onConfigChanged", () => {
  it("fails with METHOD_NOT_IMPLEMENTED so the host restarts the worker", async () => {
    // worker.ts calls startWorkerRpcHost() at import time, which would take
    // over process stdio. Stub just that export; everything else stays real.
    vi.doMock("@paperclipai/plugin-sdk", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@paperclipai/plugin-sdk")>()),
      startWorkerRpcHost: vi.fn(),
    }));
    const { plugin } = await import("../worker.js");

    const onConfigChanged = plugin.definition.onConfigChanged;
    // Deleting the hook would NOT have the same effect: the SDK's
    // handleConfigChanged returns successfully when no handler is defined, so
    // the host sees a success and never restarts. It must be raised here.
    expect(onConfigChanged).toBeDefined();

    await expect(onConfigChanged!({})).rejects.toMatchObject({
      code: METHOD_NOT_IMPLEMENTED,
    });

    vi.doUnmock("@paperclipai/plugin-sdk");
  });

  it("builds the signal in the shape the host matches on", () => {
    const err = configChangedRequiresRestart();
    expect(err).toBeInstanceOf(Error);
    // routes/plugins.ts compares `rpcErr.code` numerically after the worker
    // manager re-raises it as a JsonRpcCallError; a string would not match.
    expect(typeof err.code).toBe("number");
    expect(err.code).toBe(METHOD_NOT_IMPLEMENTED);
  });
});

// ---------------------------------------------------------------------------
// 2. The consequence: a host modelled on the real one converges
// ---------------------------------------------------------------------------

type ConfigChangedHook = () => Promise<void>;

/**
 * A host modelled on the three server modules that decide sweep scope.
 *
 * - `plugin-loader.ts` step 4: `bootstrapCompanyId` is the single configured
 *   company, or undefined when the count is 0 or >1. Computed at spawn only.
 * - `plugin-worker-manager.ts` `deriveCallInvocationScope`: a `runJob` tick is
 *   scoped to that frozen value; without one, company-scoped calls are denied.
 * - `routes/plugins.ts`: persist the config, call `configChanged`, and restart
 *   the worker when that call comes back METHOD_NOT_IMPLEMENTED.
 *
 * `initialCompanies` are configured *before* the worker spawns, which is how a
 * worker legitimately comes up already scoped to one tenant.
 */
const mkHost = (onConfigChanged: ConfigChangedHook, initialCompanies: string[] = []) => {
  const configRows = new Map<string, Record<string, unknown>>();
  for (const id of initialCompanies) {
    configRows.set(id, { defaultCompanyId: id, autoCloseOnResolve: true });
  }
  let bootstrapCompanyId: string | undefined;
  let restarts = 0;

  // plugin-loader.ts step 4 — runs on every worker spawn, and only then.
  const spawnWorker = () => {
    const configured = [...configRows.keys()];
    bootstrapCompanyId = configured.length === 1 ? configured[0] : undefined;
  };

  // routes/plugins.ts: config is persisted first and unconditionally; only the
  // worker notification is conditional.
  const notifyWorker = async () => {
    try {
      await onConfigChanged();
    } catch (err) {
      if ((err as { code?: number }).code === METHOD_NOT_IMPLEMENTED) {
        restarts += 1;
        spawnWorker(); // lifecycle.restartWorker → activateReadyPlugin → loader
      }
      // Other RPC errors are non-fatal for the config save, as in the route.
    }
  };

  const saveConfig = async (companyId: string) => {
    configRows.set(companyId, { defaultCompanyId: companyId, autoCloseOnResolve: true });
    await notifyWorker();
  };

  const deleteConfig = async (companyId: string) => {
    configRows.delete(companyId);
    await notifyWorker();
  };

  /** The PluginContext a scheduled `check-alert-escalations` tick sees. */
  const tickCtx = () =>
    ({
      config: {
        get: vi.fn(async (companyId?: string) => {
          const scope = companyId ?? bootstrapCompanyId;
          if (!scope) {
            throw Object.assign(new Error("company context is required"), {
              code: INVOCATION_SCOPE_DENIED,
              name: "JsonRpcCallError",
            });
          }
          return configRows.get(scope) ?? {};
        }),
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }) as unknown as PluginContext;

  spawnWorker();
  return {
    saveConfig,
    deleteConfig,
    tickCtx,
    restartCount: () => restarts,
    scope: () => bootstrapCompanyId,
  };
};

/** What this worker does now. */
const restartingWorker: ConfigChangedHook = async () => {
  throw configChangedRequiresRestart();
};
/** What it did before this fix: a successful no-op, which suppresses the restart. */
const noopWorker: ConfigChangedHook = async () => {};

describe("BLO-20467 sweep scope tracks configured-company transitions", () => {
  describe("0 -> 1 (first company configures the plugin)", () => {
    it("restarting worker: the new company's ladders start advancing", async () => {
      const host = mkHost(restartingWorker);
      // Nothing configured: the sweep has no scope and correctly stands down.
      expect(await resolveSweepScope(host.tickCtx())).toBeNull();

      await host.saveConfig(COMPANY_A);

      expect(host.restartCount()).toBe(1);
      expect(host.scope()).toBe(COMPANY_A);
      expect((await resolveSweepScope(host.tickCtx()))?.defaultCompanyId).toBe(COMPANY_A);
    });

    it("no-op worker: the sweep stays dark until an unrelated restart", async () => {
      const host = mkHost(noopWorker);
      await host.saveConfig(COMPANY_A);

      expect(host.restartCount()).toBe(0);
      // Config is stored and the sweep could run — but scope is still the
      // activation-time undefined, so no ladder advances for anyone.
      expect(host.scope()).toBeUndefined();
      expect(await resolveSweepScope(host.tickCtx())).toBeNull();
    });
  });

  describe("1 -> 2 (a second company configures the plugin)", () => {
    it("restarting worker: the sweep stands down rather than serving one of two", async () => {
      const host = mkHost(restartingWorker, [COMPANY_A]);
      expect(host.scope()).toBe(COMPANY_A);

      await host.saveConfig(COMPANY_B);

      expect(host.restartCount()).toBe(1);
      expect(host.scope()).toBeUndefined();
      // Multi-company escalation is not possible yet (BLO-20595); standing down
      // is the defined behaviour, and it is reached only because scope was
      // recomputed against the second config row.
      expect(await resolveSweepScope(host.tickCtx())).toBeNull();
    });

    it("no-op worker: the sweep keeps running as company A alone", async () => {
      const host = mkHost(noopWorker, [COMPANY_A]);

      await host.saveConfig(COMPANY_B);

      // The dangerous transition: scope is still what activation froze, so the
      // sweep keeps succeeding against one tenant while two are configured,
      // instead of standing down the way a freshly spawned worker would.
      expect(host.restartCount()).toBe(0);
      expect(host.scope()).toBe(COMPANY_A);
      expect((await resolveSweepScope(host.tickCtx()))?.defaultCompanyId).toBe(COMPANY_A);
    });
  });

  describe("2 -> 1 (one of two companies removes its config)", () => {
    it("restarting worker: the remaining company's ladders resume", async () => {
      const host = mkHost(restartingWorker, [COMPANY_A, COMPANY_B]);
      expect(host.scope()).toBeUndefined();
      expect(await resolveSweepScope(host.tickCtx())).toBeNull();

      await host.deleteConfig(COMPANY_B);

      expect(host.restartCount()).toBe(1);
      expect((await resolveSweepScope(host.tickCtx()))?.defaultCompanyId).toBe(COMPANY_A);
    });

    it("no-op worker: the surviving company stays dark", async () => {
      const host = mkHost(noopWorker, [COMPANY_A, COMPANY_B]);

      await host.deleteConfig(COMPANY_B);

      expect(host.restartCount()).toBe(0);
      // Company A is now the only configured tenant and could be swept, but
      // scope is still the undefined that two config rows produced at spawn.
      expect(host.scope()).toBeUndefined();
      expect(await resolveSweepScope(host.tickCtx())).toBeNull();
    });
  });
});
