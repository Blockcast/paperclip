import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockReadRuntimePrompt = vi.hoisted(() => vi.fn());

vi.mock("../services/runtime-prompt.js", () => ({
  readRuntimePrompt: mockReadRuntimePrompt,
}));

const { runtimePromptRoutes } = await import("./runtime-prompt.js");

function createApp(actor: Record<string, unknown>) {
  const app = express();
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", runtimePromptRoutes({} as never));
  app.use((error: { status?: number; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.status ?? 500).send(error.message ?? "error");
  });
  return app;
}

describe("runtime prompt route", () => {
  beforeEach(() => mockReadRuntimePrompt.mockReset());

  it("returns the private prompt only to the exact signed run actor", async () => {
    mockReadRuntimePrompt.mockResolvedValue(Buffer.from("rendered prompt"));
    const response = await request(createApp({
      type: "agent",
      source: "agent_jwt",
      runId: "run-1",
      agentId: "agent-1",
      companyId: "company-1",
    })).get("/api/heartbeat-runs/run-1/runtime-prompt");

    expect(response.status).toBe(200);
    expect(response.text).toBe("rendered prompt");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(mockReadRuntimePrompt).toHaveBeenCalledWith(
      {},
      { runId: "run-1", agentId: "agent-1", companyId: "company-1" },
    );
  });

  it("does not serve the one-shot prompt a second time", async () => {
    mockReadRuntimePrompt
      .mockResolvedValueOnce(Buffer.from("rendered prompt"))
      .mockResolvedValueOnce(null);
    const app = createApp({
      type: "agent",
      source: "agent_jwt",
      runId: "run-1",
      agentId: "agent-1",
      companyId: "company-1",
    });
    expect((await request(app).get("/api/heartbeat-runs/run-1/runtime-prompt")).status).toBe(200);
    expect((await request(app).get("/api/heartbeat-runs/run-1/runtime-prompt")).status).toBe(404);
  });

  it.each([
    { type: "agent", source: "agent_jwt", runId: "run-2", agentId: "agent-1", companyId: "company-1" },
    { type: "agent", source: "agent_api_key", runId: "run-1", agentId: "agent-1", companyId: "company-1" },
    { type: "user", source: "session", runId: "run-1", agentId: "agent-1", companyId: "company-1" },
  ])("hides a prompt from an actor that is not the exact signed run", async (actor) => {
    const response = await request(createApp(actor)).get("/api/heartbeat-runs/run-1/runtime-prompt");
    expect(response.status).toBe(404);
    expect(mockReadRuntimePrompt).not.toHaveBeenCalled();
  });

  it("returns 404 after the prompt expires or is already consumed", async () => {
    mockReadRuntimePrompt.mockResolvedValue(null);
    const response = await request(createApp({
      type: "agent",
      source: "agent_jwt",
      runId: "run-1",
      agentId: "agent-1",
      companyId: "company-1",
    })).get("/api/heartbeat-runs/run-1/runtime-prompt");
    expect(response.status).toBe(404);
  });
});
