import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PLUGIN_ERROR_METRIC,
  PLUGIN_STATUS_COLLECTOR_LAST_SUCCESS_METRIC,
  __resetMetricsForTest,
  renderMetrics,
} from "../services/metrics.js";
import {
  pluginErrorEntriesFromRows,
  startPluginStatusCollector,
} from "../services/plugin-status-metrics.js";

afterEach(() => {
  __resetMetricsForTest();
});


describe("pluginErrorEntriesFromRows", () => {
  it("maps status='error' rows to isError=true and every other status to false", () => {
    expect(
      pluginErrorEntriesFromRows([
        { id: "a", pluginKey: "lucitra.plugin-secrets", status: "error" },
        { id: "b", pluginKey: "example.plugin", status: "ready" },
        { id: "c", pluginKey: "example.plugin-2", status: "disabled" },
      ]),
    ).toEqual([
      { id: "a", pluginKey: "lucitra.plugin-secrets", isError: true },
      { id: "b", pluginKey: "example.plugin", isError: false },
      { id: "c", pluginKey: "example.plugin-2", isError: false },
    ]);
  });
});

describe("startPluginStatusCollector", () => {
  it("publishes the roster from listInstalled on an immediate tick, without waiting for the interval", async () => {
    const listInstalled = vi.fn().mockResolvedValue([
      { id: "a", pluginKey: "lucitra.plugin-secrets", status: "error" },
    ]);
    const stop = startPluginStatusCollector({} as never, {
      listInstalled,
      setInterval: vi.fn().mockReturnValue({ unref: vi.fn() }) as unknown as typeof setInterval,
      clearInterval: vi.fn(),
      now: () => 1_700_000_000_000,
    });
    // The collector's first tick is fired synchronously (fire-and-forget); flush microtasks.
    await Promise.resolve();
    await Promise.resolve();

    expect(listInstalled).toHaveBeenCalledTimes(1);
    const { body } = await renderMetrics();
    expect(body).toContain(
      `${PLUGIN_ERROR_METRIC}{plugin_id="a",plugin_key="lucitra.plugin-secrets"} 1`,
    );
    expect(body).toContain(`${PLUGIN_STATUS_COLLECTOR_LAST_SUCCESS_METRIC} 1700000000`);
    stop();
  });

  it("does not throw when listInstalled rejects", async () => {
    const listInstalled = vi.fn().mockRejectedValue(new Error("db unreachable"));
    const stop = startPluginStatusCollector({} as never, {
      listInstalled,
      setInterval: vi.fn().mockReturnValue({ unref: vi.fn() }) as unknown as typeof setInterval,
      clearInterval: vi.fn(),
    });
    await Promise.resolve();
    await Promise.resolve();
    stop();
  });

  it("BLO-21092 review follow-up: a first-tick failure leaves both paperclip_plugin_error absent and the success gauge at its zero-init, instead of looking like a healthy empty roster", async () => {
    const listInstalled = vi.fn().mockRejectedValue(new Error("db unreachable"));
    const stop = startPluginStatusCollector({} as never, {
      listInstalled,
      setInterval: vi.fn().mockReturnValue({ unref: vi.fn() }) as unknown as typeof setInterval,
      clearInterval: vi.fn(),
      now: () => 1_700_000_000_000,
    });
    await Promise.resolve();
    await Promise.resolve();

    const { body } = await renderMetrics();
    // setPluginErrorStatus was never called, so the gauge has no series at
    // all yet (distinct from "reset to an empty roster", which would also
    // render no series -- the point is the collector's OWN health signal
    // below is what tells them apart).
    expect(body).not.toContain(`${PLUGIN_ERROR_METRIC}{`);
    expect(body).toContain(`${PLUGIN_STATUS_COLLECTOR_LAST_SUCCESS_METRIC} 0`);
    stop();
  });

  it("BLO-21092 review follow-up: a failure after a prior success leaves the success gauge exactly where it was, so staleness is observable while the last-known plugin snapshot keeps serving", async () => {
    let tick = 1_700_000_000_000;
    const listInstalled = vi
      .fn()
      .mockResolvedValueOnce([{ id: "a", pluginKey: "lucitra.plugin-secrets", status: "ready" }])
      .mockRejectedValue(new Error("db unreachable"));
    const scheduled: Array<() => void> = [];
    const stop = startPluginStatusCollector({} as never, {
      listInstalled,
      setInterval: ((fn: () => void) => {
        scheduled.push(fn);
        return { unref: vi.fn() };
      }) as unknown as typeof setInterval,
      clearInterval: vi.fn(),
      now: () => tick,
    });
    await Promise.resolve();
    await Promise.resolve();

    let body = (await renderMetrics()).body;
    expect(body).toContain(
      `${PLUGIN_ERROR_METRIC}{plugin_id="a",plugin_key="lucitra.plugin-secrets"} 0`,
    );
    expect(body).toContain(`${PLUGIN_STATUS_COLLECTOR_LAST_SUCCESS_METRIC} 1700000000`);

    // Advance the clock and fire the interval tick, which now rejects.
    tick = 1_700_000_600_000;
    scheduled[0]?.();
    await Promise.resolve();
    await Promise.resolve();

    body = (await renderMetrics()).body;
    // Stale snapshot keeps serving -- a real prior read, not silence.
    expect(body).toContain(
      `${PLUGIN_ERROR_METRIC}{plugin_id="a",plugin_key="lucitra.plugin-secrets"} 0`,
    );
    // But the success gauge did NOT advance to the new tick time, which is
    // exactly what lets (time() - this) > threshold detect the stall.
    expect(body).toContain(`${PLUGIN_STATUS_COLLECTOR_LAST_SUCCESS_METRIC} 1700000000`);
    stop();
  });
});
