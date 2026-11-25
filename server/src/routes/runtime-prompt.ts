import type { Db } from "@paperclipai/db";
import { Router } from "express";
import { notFound } from "../errors.js";
import { readRuntimePrompt } from "../services/runtime-prompt.js";

export function runtimePromptRoutes(db: Db) {
  const router = Router();

  router.get("/heartbeat-runs/:runId/runtime-prompt", async (req, res) => {
    const { runId } = req.params;
    const actor = req.actor;
    res.set("Cache-Control", "no-store");
    if (
      actor.type !== "agent" ||
      actor.source !== "agent_jwt" ||
      actor.runId !== runId ||
      !actor.agentId ||
      !actor.companyId
    ) {
      throw notFound("Runtime prompt not found");
    }

    const prompt = await readRuntimePrompt(db, { runId, agentId: actor.agentId, companyId: actor.companyId });
    if (prompt === null) throw notFound("Runtime prompt not found");
    res.type("text/plain; charset=utf-8").set("X-Content-Type-Options", "nosniff").end(prompt);
  });

  return router;
}
