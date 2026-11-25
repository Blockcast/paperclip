import { describe, expect, it, vi } from "vitest";
import { readRuntimePrompt } from "./runtime-prompt.js";

describe("readRuntimePrompt", () => {
  it("consumes the staged row so a second read cannot replay it", async () => {
    const returning = vi
      .fn()
      .mockResolvedValueOnce([{ prompt: Buffer.from("rendered prompt") }])
      .mockResolvedValueOnce([]);
    const where = vi.fn(() => ({ returning }));
    const db = {
      delete: vi.fn(() => ({ where })),
      select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({})) })) })),
    };

    const identity = { runId: "run-1", companyId: "company-1", agentId: "agent-1" };
    await expect(readRuntimePrompt(db as never, identity)).resolves.toEqual(Buffer.from("rendered prompt"));
    await expect(readRuntimePrompt(db as never, identity)).resolves.toBeNull();
    expect(db.delete).toHaveBeenCalledTimes(2);
    expect(returning).toHaveBeenCalledTimes(2);
  });
});
