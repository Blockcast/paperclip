import { describe, expect, it } from "vitest";
import config from "../vitest.config";

// BLO-48145: spawn-heavy suites (env-guard, prompt-cache, runtime-pin) exceed
// vitest's 5 s default on loaded CI runners. Lock the raised timeout in so a
// config cleanup cannot silently bring the merge-queue flake back.
describe("vitest config (BLO-48145)", () => {
  it("keeps the per-test timeout at 30 s or more", () => {
    expect(config.test?.testTimeout).toBeGreaterThanOrEqual(30_000);
  });
});
