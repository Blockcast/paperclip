/**
 * Ally review of PR #1145, finding 3 — manual and retry dispatches did not
 * carry `job.companyId`, so the guard added by this PR returned *before*
 * running the sweep while the scheduler recorded the run as `succeeded`. A
 * "run now" that reports success having done nothing is precisely the
 * silent-no-op failure mode BLO-20957 exists to kill.
 *
 * The host-side half of that fix (manual/retry now fan out per company and
 * stamp the scope) is covered in
 * `server/src/__tests__/plugin-job-scheduler.test.ts`. This file covers the
 * worker-side half Ally asked for explicitly: given a dispatch that *does*
 * carry a company, the registered handler must actually execute the sweep —
 * not merely return successfully.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginContext, PluginJobContext } from "@paperclipai/plugin-sdk";

// `worker.ts` calls `startWorkerRpcHost` at import time; stub it so importing
// the module doesn't try to stand up a real RPC host under vitest.
vi.mock("@paperclipai/plugin-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/plugin-sdk")>();
  return { ...actual, startWorkerRpcHost: vi.fn() };
});

type SweepConfig = { defaultCompanyId: string };

const runAlertEscalationSweep =
  vi.fn<(ctx: unknown, config: SweepConfig) => Promise<void>>(async () => {});
vi.mock("../escalation.js", () => ({
  runAlertEscalationSweep: (ctx: unknown, config: SweepConfig) =>
    runAlertEscalationSweep(ctx, config),
}));

const resolveEscalationSweepConfig =
  vi.fn<(ctx: unknown, companyId: string) => Promise<SweepConfig | null>>();
vi.mock("../config-scope.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config-scope.js")>();
  return {
    ...actual,
    resolveEscalationSweepConfig: (ctx: unknown, companyId: string) =>
      resolveEscalationSweepConfig(ctx, companyId),
  };
});

const { plugin } = await import("../worker.js");

type JobHandler = (job: PluginJobContext) => Promise<void>;

function mkCtx() {
  const registered = new Map<string, JobHandler>();
  const warn = vi.fn();
  const ctx = {
    logger: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() },
    jobs: {
      register: vi.fn((key: string, handler: JobHandler) => {
        registered.set(key, handler);
      }),
    },
    config: { get: vi.fn(async () => ({})) },
  } as unknown as PluginContext;

  return { ctx, registered, warn };
}

async function setupAndGetSweepHandler() {
  const { ctx, registered, warn } = mkCtx();
  // `definePlugin` returns `{ definition }` — NOT a plugin with a top-level
  // `setup`. Called without the `.definition` hop (and with `?.`), this
  // silently does nothing and every assertion below passes vacuously.
  const setup = plugin.definition.setup;
  if (!setup) throw new Error("plugin defines no setup()");
  await setup(ctx);
  const handler = registered.get("check-alert-escalations");
  if (!handler) throw new Error("check-alert-escalations was never registered");
  return { handler, warn, ctx };
}

describe("alertmanager check-alert-escalations job scope (BLO-20957 review)", () => {
  beforeEach(() => {
    runAlertEscalationSweep.mockClear();
    resolveEscalationSweepConfig.mockReset();
  });

  it("runs the sweep when the dispatch carries a company scope", async () => {
    const config = { defaultCompanyId: "company-a" };
    resolveEscalationSweepConfig.mockResolvedValue(config);

    const { handler } = await setupAndGetSweepHandler();
    await handler({ companyId: "company-a" } as unknown as PluginJobContext);

    // The whole point of finding 3: the sweep must EXECUTE, not merely
    // return successfully.
    expect(runAlertEscalationSweep).toHaveBeenCalledTimes(1);
    expect(runAlertEscalationSweep.mock.calls[0]?.[1]).toBe(config);
    expect(resolveEscalationSweepConfig).toHaveBeenCalledWith(
      expect.anything(),
      "company-a",
    );
  });

  it("resolves each company's own config on its own dispatch", async () => {
    resolveEscalationSweepConfig.mockImplementation(
      async (_ctx: unknown, companyId: string) => ({
        defaultCompanyId: companyId,
      }),
    );

    const { handler } = await setupAndGetSweepHandler();
    await handler({ companyId: "company-a" } as unknown as PluginJobContext);
    await handler({ companyId: "company-b" } as unknown as PluginJobContext);

    expect(runAlertEscalationSweep).toHaveBeenCalledTimes(2);
    expect(
      runAlertEscalationSweep.mock.calls.map(
        (call) => call[1].defaultCompanyId,
      ),
    ).toEqual(["company-a", "company-b"]);
  });

  it("skips with a warn — never a silent success — when no scope is carried", async () => {
    const { handler, warn } = await setupAndGetSweepHandler();
    await handler({ companyId: null } as unknown as PluginJobContext);

    expect(runAlertEscalationSweep).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("no company scope"),
    );
  });

  it("skips with a warn when the company has no stored config", async () => {
    resolveEscalationSweepConfig.mockResolvedValue(null);

    const { handler, warn } = await setupAndGetSweepHandler();
    await handler({ companyId: "company-a" } as unknown as PluginJobContext);

    expect(runAlertEscalationSweep).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("company-a"));
  });
});
