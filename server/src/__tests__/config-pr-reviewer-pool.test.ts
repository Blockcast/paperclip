import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";

describe("PAPERCLIP_PR_REVIEWER_AGENT_IDS", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.PAPERCLIP_PR_REVIEWER_AGENT_IDS;
    delete process.env.PAPERCLIP_PR_REVIEWER_AGENT_ID;
    process.env.PAPERCLIP_PUBLIC_URL = "http://localhost:3100";
    process.env.PAPERCLIP_DEPLOYMENT_MODE = "authenticated";
    process.env.PAPERCLIP_DEPLOYMENT_EXPOSURE = "private";
    process.env.PAPERCLIP_AUTH_BASE_URL_MODE = "explicit";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("parses, trims, and deduplicates the plural reviewer pool", () => {
    process.env.PAPERCLIP_PR_REVIEWER_AGENT_IDS =
      "reviewer-a, reviewer-b,reviewer-a, , reviewer-c";

    expect(loadConfig().githubPrReviewerAgentIds).toEqual([
      "reviewer-a",
      "reviewer-b",
      "reviewer-c",
    ]);
  });

  it("prefers the plural reviewer pool when both settings are present", () => {
    process.env.PAPERCLIP_PR_REVIEWER_AGENT_IDS = "reviewer-a,reviewer-b";
    process.env.PAPERCLIP_PR_REVIEWER_AGENT_ID = "legacy-reviewer";

    expect(loadConfig().githubPrReviewerAgentIds).toEqual([
      "reviewer-a",
      "reviewer-b",
    ]);
  });

  it("falls back to the legacy singular reviewer setting", () => {
    process.env.PAPERCLIP_PR_REVIEWER_AGENT_ID = "legacy-reviewer";

    expect(loadConfig().githubPrReviewerAgentIds).toEqual(["legacy-reviewer"]);
  });

  it("defaults to an empty reviewer pool", () => {
    expect(loadConfig().githubPrReviewerAgentIds).toEqual([]);
  });
});
