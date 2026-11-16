import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmbeddedPostgresStartupDiagnostics } from "./test-embedded-postgres.js";

/**
 * PEN-3381. `startEmbeddedPostgresTestDatabase` has crossed the 120_000 ms `hookTimeout`
 * its callers run under, twice, leaving no record of WHICH phase consumed the time. These
 * pins exist because the instrumentation that answers that is only worth landing if it
 * actually emits -- an instrument that silently writes nothing is indistinguishable, in a
 * job log read two days later, from a start that never excursed.
 *
 * Everything here is driven by an injected clock and vitest's fake timers, so no assertion
 * depends on wall-clock duration. That is deliberate on this row above all others.
 */
function harness(options: { slowPhaseMs?: number; hookTimeoutMs?: number } = {}) {
  let clock = 0;
  const info: string[] = [];
  const warn: string[] = [];
  const diagnostics = createEmbeddedPostgresStartupDiagnostics("pg-test-", {
    slowPhaseMs: options.slowPhaseMs ?? 31_500,
    hookTimeoutMs: options.hookTimeoutMs ?? 120_000,
    now: () => clock,
    info: (line) => info.push(line),
    warn: (line) => warn.push(line),
  });
  const advance = (ms: number) => {
    clock += ms;
    vi.advanceTimersByTime(ms);
  };
  return { diagnostics, info, warn, advance };
}

describe("embedded Postgres startup diagnostics", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports every phase it timed, in order, on a successful start", async () => {
    vi.useFakeTimers();
    const { diagnostics, info, advance } = harness();

    await diagnostics.phase("create-instance", () => advance(400));
    await diagnostics.phase("copy-template", () => advance(1_100));
    const started = await diagnostics.phase("start", async () => {
      advance(900);
      return "ready";
    });
    diagnostics.finish("ok");

    expect(started).toBe("ready");
    expect(info).toHaveLength(1);
    expect(info[0]).toBe(
      "[test-embedded-postgres] pg-test- start ok in 2400 ms -- " +
        "create-instance=400ms copy-template=1100ms start=900ms",
    );
  });

  it("names the in-flight phase while it is slow, and still resolves it", async () => {
    vi.useFakeTimers();
    const { diagnostics, info, warn, advance } = harness();

    await diagnostics.phase("create-instance", () => advance(500));
    diagnostics.note("LOG:  database system is starting up");
    const value = await diagnostics.phase("start", async () => {
      advance(31_500);
      return "started late";
    });
    diagnostics.finish("ok");

    // The watchdog LOGS ONLY. A slow start that would have succeeded still succeeds.
    expect(value).toBe("started late");
    expect(warn).toHaveLength(1);
    expect(warn[0]).toContain("slow start: 32000 ms so far");
    expect(warn[0]).toContain("create-instance=500ms start=31500ms(running)");
    expect(warn[0]).toContain("last server output: LOG:  database system is starting up");
    expect(info[0]).toContain("start ok in 32000 ms");
  });

  it("keeps only the most recent server lines, and ignores empty ones", async () => {
    vi.useFakeTimers();
    const { diagnostics, warn, advance } = harness();

    for (const line of ["one", "two", "three", "four", "five", "six"]) diagnostics.note(line);
    diagnostics.note("   ");
    diagnostics.note(undefined);
    await diagnostics.phase("start", () => advance(31_500));
    diagnostics.finish("ok");

    expect(warn[0]).toContain("last server output: two | three | four | five | six");
    expect(warn[0]).not.toContain("one |");
  });

  it("says so when a slow phase has produced no server output at all", async () => {
    vi.useFakeTimers();
    const { diagnostics, warn, advance } = harness();

    await diagnostics.phase("apply-migrations", () => advance(31_500));
    diagnostics.finish("ok");

    expect(warn[0]).toContain("-- no server output");
  });

  it("stops reporting once the caller's hook budget is spent, even if nobody finishes", () => {
    vi.useFakeTimers();
    // A hook vitest has killed never reaches finish(), so the watchdog has to bound itself.
    const { diagnostics, warn, advance } = harness({ slowPhaseMs: 1_000, hookTimeoutMs: 4_000 });

    void diagnostics.phase("start", () => new Promise(() => {}));
    // Stepped, so the injected clock and the fake timers stay in lockstep.
    for (let elapsed = 0; elapsed < 60_000; elapsed += 1_000) advance(1_000);

    expect(warn).toHaveLength(5); // ceil(4000 / 1000) + 1
    expect(warn.at(-1)).toContain("start=5000ms(running)");
  });

  it("writes one summary line however often finish is called", async () => {
    vi.useFakeTimers();
    const { diagnostics, info, advance } = harness();

    await diagnostics.phase("ensure-template", () => advance(5));
    diagnostics.finish("failed");
    diagnostics.finish("ok");

    expect(info).toHaveLength(1);
    expect(info[0]).toContain("start failed in 5 ms -- ensure-template=5ms");
  });

  it("records nothing but the elapsed when no phase ever started", () => {
    vi.useFakeTimers();
    const { diagnostics, info } = harness();

    diagnostics.finish("failed");

    expect(info[0]).toBe("[test-embedded-postgres] pg-test- start failed in 0 ms -- (no phase started)");
  });
});
