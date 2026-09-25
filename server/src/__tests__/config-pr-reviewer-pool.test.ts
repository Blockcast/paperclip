import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";

describe("PAPERCLIP_PR_REVIEWER_AGENT_IDS", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.PAPERCLIP_PR_REVIEWER_AGENT_IDS;
    delete process.env.PAPERCLIP_PR_REVIEWER_AGENT_ID;
    delete process.env.PAPERCLIP_GITHUB_REVIEW_GATE_CAPTURE_ENABLED;
    delete process.env.PAPERCLIP_GITHUB_REVIEW_GATE_ENABLED;
    delete process.env.PAPERCLIP_GITHUB_REVIEW_GATE_REPOSITORIES;
    delete process.env.PAPERCLIP_GITHUB_REVIEW_GATE_EXPECTED_APP_ID;
    delete process.env.PAPERCLIP_GITHUB_REVIEW_GATE_EXPECTED_INSTALLATION_ID;
    delete process.env.PAPERCLIP_PR_REVIEW_GATE_STATUS_CONTEXT;
    delete process.env.GITHUB_WEBHOOK_SECRET;
    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_APP_INSTALLATION_ID;
    delete process.env.GITHUB_APP_PRIVATE_KEY;
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

  it("parses, trims, and deduplicates review-gate repositories", () => {
    process.env.PAPERCLIP_GITHUB_REVIEW_GATE_REPOSITORIES =
      "Blockcast/penstock-llm-proxy-core, Blockcast/paperclip,Blockcast/penstock-llm-proxy-core, ";

    expect(loadConfig().githubReviewGateRepositories).toEqual([
      "Blockcast/penstock-llm-proxy-core",
      "Blockcast/paperclip",
    ]);
  });

  it("keeps the signed review-gate authority disabled by default", () => {
    expect(loadConfig()).toMatchObject({
      githubReviewGateCaptureEnabled: false,
      githubReviewGateEnabled: false,
      githubReviewGateRepositories: [],
    });
  });

  it("stages durable capture without activating review-gate authority", () => {
    process.env.PAPERCLIP_GITHUB_REVIEW_GATE_CAPTURE_ENABLED = "true";
    process.env.PAPERCLIP_GITHUB_REVIEW_GATE_REPOSITORIES = "Blockcast/penstock-llm-proxy-core";
    process.env.PAPERCLIP_GITHUB_REVIEW_GATE_EXPECTED_APP_ID = "3966421";
    process.env.PAPERCLIP_GITHUB_REVIEW_GATE_EXPECTED_INSTALLATION_ID = "138085375";
    process.env.PAPERCLIP_PR_REVIEW_GATE_STATUS_CONTEXT = "review/ally-complete";
    process.env.GITHUB_WEBHOOK_SECRET = "webhook-secret";

    expect(loadConfig()).toMatchObject({
      githubReviewGateCaptureEnabled: true,
      githubReviewGateEnabled: false,
    });
  });

  it("enables signed review-gate authority only after durable capture", () => {
    process.env.PAPERCLIP_GITHUB_REVIEW_GATE_CAPTURE_ENABLED = "true";
    process.env.PAPERCLIP_GITHUB_REVIEW_GATE_ENABLED = "true";
    process.env.PAPERCLIP_GITHUB_REVIEW_GATE_REPOSITORIES = "Blockcast/penstock-llm-proxy-core";
    process.env.PAPERCLIP_GITHUB_REVIEW_GATE_EXPECTED_APP_ID = "3966421";
    process.env.PAPERCLIP_GITHUB_REVIEW_GATE_EXPECTED_INSTALLATION_ID = "138085375";
    process.env.PAPERCLIP_PR_REVIEW_GATE_STATUS_CONTEXT = "review/ally-complete";
    process.env.GITHUB_WEBHOOK_SECRET = "webhook-secret";
    process.env.GITHUB_APP_ID = "3966421";
    process.env.GITHUB_APP_INSTALLATION_ID = "138085375";
    process.env.GITHUB_APP_PRIVATE_KEY = "private-key";

    expect(loadConfig().githubReviewGateEnabled).toBe(true);
  });

  it("rejects authority before capture and incomplete or mismatched configuration", () => {
    process.env.PAPERCLIP_GITHUB_REVIEW_GATE_ENABLED = "true";
    expect(() => loadConfig()).toThrow(/requires durable capture/);

    process.env.PAPERCLIP_GITHUB_REVIEW_GATE_CAPTURE_ENABLED = "true";
    expect(() => loadConfig()).toThrow(/capture is enabled but missing/);

    process.env.PAPERCLIP_GITHUB_REVIEW_GATE_REPOSITORIES = "Blockcast/penstock-llm-proxy-core";
    process.env.PAPERCLIP_GITHUB_REVIEW_GATE_EXPECTED_APP_ID = "3966421";
    process.env.PAPERCLIP_GITHUB_REVIEW_GATE_EXPECTED_INSTALLATION_ID = "138085375";
    process.env.PAPERCLIP_PR_REVIEW_GATE_STATUS_CONTEXT = "review/ally-complete";
    process.env.GITHUB_WEBHOOK_SECRET = "webhook-secret";
    process.env.GITHUB_APP_ID = "9999999";
    process.env.GITHUB_APP_INSTALLATION_ID = "138085375";
    process.env.GITHUB_APP_PRIVATE_KEY = "private-key";
    expect(() => loadConfig()).toThrow(/do not match the pinned App authority/);
  });

  it("loads the deployment-pinned review-gate producer identity", () => {
    process.env.PAPERCLIP_GITHUB_REVIEW_GATE_EXPECTED_APP_ID = " 3966421 ";
    process.env.PAPERCLIP_GITHUB_REVIEW_GATE_EXPECTED_INSTALLATION_ID = " 138085375 ";

    expect(loadConfig()).toMatchObject({
      githubReviewGateExpectedAppId: "3966421",
      githubReviewGateExpectedInstallationId: "138085375",
    });
  });
});
