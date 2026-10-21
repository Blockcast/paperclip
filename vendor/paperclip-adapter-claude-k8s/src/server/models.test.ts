import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { isBedrockAdapterConfig, listK8sModels, listK8sModelsForConfig } from "./models.js";

describe("listK8sModels", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv.CLAUDE_CODE_USE_BEDROCK = process.env.CLAUDE_CODE_USE_BEDROCK;
    savedEnv.ANTHROPIC_BEDROCK_BASE_URL = process.env.ANTHROPIC_BEDROCK_BASE_URL;
    delete process.env.CLAUDE_CODE_USE_BEDROCK;
    delete process.env.ANTHROPIC_BEDROCK_BASE_URL;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("returns direct API models by default", async () => {
    const models = await listK8sModels();
    expect(new Set(models.map((m) => m.id)).size).toBe(models.length);
    expect(models.some((m) => m.id === "claude-opus-5")).toBe(true);
    expect(models.some((m) => m.id === "claude-opus-5[1m]")).toBe(true);
    expect(models.some((m) => m.id === "claude-fable-5-1[1m]")).toBe(true);
    expect(models.some((m) => m.id === "claude-opus-5-5[1m]")).toBe(true);
    expect(models.some((m) => m.id === "claude-sonnet-5-5[1m]")).toBe(true);
    expect(models.some((m) => m.id === "claude-opus-4-8[1m]")).toBe(true);
    expect(models.some((m) => m.id === "claude-sonnet-5")).toBe(true);
    expect(models.some((m) => m.id === "claude-sonnet-4-6[1m]")).toBe(true);
    expect(models.some((m) => m.id === "claude-opus-4-7")).toBe(true);
    expect(models.some((m) => m.id === "claude-opus-4-6")).toBe(true);
    expect(models.every((m) => !m.id.includes("anthropic."))).toBe(true);
  });

  it("returns Bedrock models when CLAUDE_CODE_USE_BEDROCK=1", async () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = "1";
    const models = await listK8sModels();
    expect(models.some((m) => m.id === "us.anthropic.claude-opus-5")).toBe(true);
    expect(models.some((m) => m.id === "us.anthropic.claude-sonnet-5")).toBe(true);
    expect(models.some((m) => m.id.includes("anthropic."))).toBe(true);
    expect(models.every((m) => !m.id.startsWith("claude-"))).toBe(true);
  });

  it("returns Bedrock models when CLAUDE_CODE_USE_BEDROCK=true", async () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = "true";
    const models = await listK8sModels();
    expect(models.some((m) => m.id.includes("anthropic."))).toBe(true);
  });

  it("returns Bedrock models when ANTHROPIC_BEDROCK_BASE_URL is set", async () => {
    process.env.ANTHROPIC_BEDROCK_BASE_URL = "https://bedrock.us-east-1.amazonaws.com";
    const models = await listK8sModels();
    expect(models.some((m) => m.id.includes("anthropic."))).toBe(true);
  });

  it("ignores blank ANTHROPIC_BEDROCK_BASE_URL", async () => {
    process.env.ANTHROPIC_BEDROCK_BASE_URL = "   ";
    const models = await listK8sModels();
    expect(models.some((m) => m.id === "claude-opus-4-7")).toBe(true);
  });
});

// PEN-4447. Paperclip now refuses a write to `adapterConfig.model` naming an id
// absent from this registry, so these ids are a published contract rather than
// picker contents: dropping one turns an accepted configuration into a 422, and
// adding one silently widens what the API accepts.
describe("listK8sModelsForConfig", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv.CLAUDE_CODE_USE_BEDROCK = process.env.CLAUDE_CODE_USE_BEDROCK;
    savedEnv.ANTHROPIC_BEDROCK_BASE_URL = process.env.ANTHROPIC_BEDROCK_BASE_URL;
    delete process.env.CLAUDE_CODE_USE_BEDROCK;
    delete process.env.ANTHROPIC_BEDROCK_BASE_URL;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("does not register claude-haiku-4-5, whose dated id is the only form here", async () => {
    // The measured near-miss: `claude-haiku-4-5` is registered by the in-tree
    // `claude_local` adapter and reads as the obvious cheap floor. It is not an
    // id this adapter accepts; `claude-haiku-4-6` is.
    const ids = (await listK8sModelsForConfig({})).map((m) => m.id);
    expect(ids).not.toContain("claude-haiku-4-5");
    expect(ids).toContain("claude-haiku-4-5-20251001");
    expect(ids).toContain("claude-haiku-4-6");
  });

  it("matches listK8sModels when the agent declares no env", async () => {
    const forConfig = (await listK8sModelsForConfig({})).map((m) => m.id);
    const listed = (await listK8sModels()).map((m) => m.id);
    expect(forConfig).toEqual(listed);
  });

  it("resolves the Bedrock branch from the agent env, not the server env", async () => {
    const ids = (
      await listK8sModelsForConfig({ env: { CLAUDE_CODE_USE_BEDROCK: "1" } })
    ).map((m) => m.id);
    expect(ids).toContain("us.anthropic.claude-opus-5");
    expect(ids).not.toContain("claude-opus-5");
  });

  it("lets an agent opt OUT of a server-wide Bedrock setting", async () => {
    // adapterConfig.env is layered over the inherited server env in the Job pod
    // (job-manifest layer 4), so a key present with an empty value wins.
    process.env.ANTHROPIC_BEDROCK_BASE_URL = "https://bedrock.us-east-1.amazonaws.com";
    expect(isBedrockAdapterConfig({})).toBe(true);
    expect(isBedrockAdapterConfig({ env: { ANTHROPIC_BEDROCK_BASE_URL: "" } })).toBe(false);
    const ids = (
      await listK8sModelsForConfig({ env: { ANTHROPIC_BEDROCK_BASE_URL: "" } })
    ).map((m) => m.id);
    expect(ids).toContain("claude-opus-5");
  });

  it("inherits the server env for keys the agent does not name", async () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = "1";
    const ids = (await listK8sModelsForConfig({ env: { SOMETHING_ELSE: "x" } })).map((m) => m.id);
    expect(ids).toContain("us.anthropic.claude-opus-5");
  });

  it("treats a non-object env as absent", async () => {
    await expect(listK8sModelsForConfig({ env: "nope" })).resolves.toHaveLength(
      (await listK8sModels()).length,
    );
  });
});
