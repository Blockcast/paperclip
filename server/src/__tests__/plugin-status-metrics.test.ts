import { afterEach, describe, expect, it, vi } from "vitest";
import { PLUGIN_ERROR_METRIC, __resetMetricsForTest, renderMetrics } from "../services/metrics.js";
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
    });
    // The collector's first tick is fired synchronously (fire-and-forget); flush microtasks.
    await Promise.resolve();
    await Promise.resolve();

    expect(listInstalled).toHaveBeenCalledTimes(1);
    const { body } = await renderMetrics();
    expect(body).toContain(
      `${PLUGIN_ERROR_METRIC}{plugin_id="a",plugin_key="lucitra.plugin-secrets"} 1`,
    );
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
});
