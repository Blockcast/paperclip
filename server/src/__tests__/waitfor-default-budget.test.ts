import { describe, expect, it, vi } from "vitest";

// Pins the `vi.waitFor` default-timeout lift installed by
// `src/__tests__/setup-supertest.ts`. Without that lift the default is
// vitest's own hard-coded 1s (`timeout = 1e3` in @vitest/runner), which is not
// reachable from vitest.config.ts and so was missed by the BLO-17026 lift of
// testTimeout/hookTimeout/teardownTimeout onto the shared ARC pool.
//
// These assertions exist because the lift has no other guard: it lives in a
// setup file, nothing else observes it, and a tidy-up that drops it would
// silently restore a 1s budget to ~140 synchronisation waits across the
// server suite (PEN-3381).
describe("vi.waitFor default budget", () => {
  it("resolves a synchronisation wait that outlives vitest's stock 1s default", async () => {
    // 1_200ms is deliberately just past the stock default: a timer cannot fire
    // EARLY, so contention can only lengthen this, and the lifted 5s budget
    // leaves ~3.8s of slack before this pin would itself become load-sensitive.
    let settled = false;
    const timer = setTimeout(() => { settled = true; }, 1_200);
    try {
      await vi.waitFor(() => expect(settled).toBe(true));
    } finally {
      clearTimeout(timer);
    }
    expect(settled).toBe(true);
  }, 60_000);

  it("still honours an explicit per-call timeout, so a real bound is not widened", async () => {
    const startedAt = Date.now();
    await expect(vi.waitFor(() => expect(false).toBe(true), { timeout: 150 })).rejects.toThrow();
    // Would be ~5_000 if the lift clobbered the caller's own option. This bound only has
    // to separate ~150 from ~5_000, so it is a discriminator and not a latency claim:
    // keep it well clear of 5_000 but far enough above 150 that a loaded ARC runner
    // cannot trip it, which is the exact failure mode this file exists to remove.
    expect(Date.now() - startedAt).toBeLessThan(4_000);
  }, 60_000);
});
