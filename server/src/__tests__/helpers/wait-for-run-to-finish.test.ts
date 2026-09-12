import { describe, expect, it } from "vitest";
import type { heartbeatService } from "../../services/heartbeat.ts";
import { waitForRunToFinish } from "./wait-for-run-to-finish.js";

type Heartbeat = ReturnType<typeof heartbeatService>;

const stubHeartbeat = (status: string) =>
  ({ getRun: async () => ({ id: "run-1", status }) }) as unknown as Heartbeat;

describe("waitForRunToFinish", () => {
  it("throws a labelled timeout instead of returning a non-terminal run", async () => {
    await expect(waitForRunToFinish(stubHeartbeat("running"), "run-1", 100)).rejects.toThrow(
      /run run-1 did not reach a terminal status within 100ms.*last status: running/,
    );
  });

  it("throws when the run never appears", async () => {
    const missing = { getRun: async () => undefined } as unknown as Heartbeat;
    await expect(waitForRunToFinish(missing, "run-1", 100)).rejects.toThrow(/last status: missing/);
  });

  it("returns a run that reaches a terminal status", async () => {
    const run = await waitForRunToFinish(stubHeartbeat("succeeded"), "run-1", 100);
    expect(run?.status).toBe("succeeded");
  });
});
