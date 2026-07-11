import { afterEach, describe, expect, it } from "vitest";
import {
  ensureOpenCodeModelConfiguredAndAvailable,
  filterOpenCodeModelsForConfiguredAllowlist,
  listOpenCodeModels,
  requireOpenCodeModelId,
  resetOpenCodeModelsCacheForTests,
} from "./models.js";

describe("openCode models", () => {
  afterEach(() => {
    delete process.env.PAPERCLIP_OPENCODE_COMMAND;
    delete process.env.OPENCODE_ALLOW_ALL_MODELS;
    resetOpenCodeModelsCacheForTests();
  });

  it("returns an empty list when discovery command is unavailable", async () => {
    process.env.PAPERCLIP_OPENCODE_COMMAND = "__paperclip_missing_opencode_command__";
    await expect(listOpenCodeModels()).resolves.toEqual([]);
  });

  it("rejects when model is missing", async () => {
    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({ model: "" }),
    ).rejects.toThrow("OpenCode requires `adapterConfig.model`");
  });

  it("accepts a provider/model id without running discovery", () => {
    expect(requireOpenCodeModelId("openai/gpt-5.2-codex")).toBe("openai/gpt-5.2-codex");
  });

  it("rejects malformed provider/model ids before discovery", () => {
    expect(() => requireOpenCodeModelId("gpt-5.2-codex")).toThrow(
      "OpenCode requires `adapterConfig.model`",
    );
    expect(() => requireOpenCodeModelId("openai/")).toThrow(
      "OpenCode requires `adapterConfig.model`",
    );
  });

  it("rejects when discovery cannot run for configured model", async () => {
    process.env.PAPERCLIP_OPENCODE_COMMAND = "__paperclip_missing_opencode_command__";
    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({
        model: "openai/gpt-5",
      }),
    ).rejects.toThrow("Failed to start command");
  });

  it("skips the availability check when OPENCODE_ALLOW_ALL_MODELS is set in the run env", async () => {
    process.env.PAPERCLIP_OPENCODE_COMMAND = "__paperclip_missing_opencode_command__";
    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({
        model: "anthropic/tensorix/deepseek/deepseek-chat-v3.1",
        env: { OPENCODE_ALLOW_ALL_MODELS: "true" },
      }),
    ).resolves.toEqual([
      { id: "anthropic/tensorix/deepseek/deepseek-chat-v3.1", label: "anthropic/tensorix/deepseek/deepseek-chat-v3.1" },
    ]);
  });

  it("honours OPENCODE_ALLOW_ALL_MODELS from the process env", async () => {
    process.env.PAPERCLIP_OPENCODE_COMMAND = "__paperclip_missing_opencode_command__";
    process.env.OPENCODE_ALLOW_ALL_MODELS = "1";
    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({ model: "anthropic/gateway/some-model" }),
    ).resolves.toEqual([{ id: "anthropic/gateway/some-model", label: "anthropic/gateway/some-model" }]);
  });

  it("still enforces provider/model format when OPENCODE_ALLOW_ALL_MODELS is set", async () => {
    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({
        model: "not-a-valid-id",
        env: { OPENCODE_ALLOW_ALL_MODELS: "true" },
      }),
    ).rejects.toThrow("OpenCode requires `adapterConfig.model`");
  });

  it("filters discovered models when a deployment allowlist is configured", () => {
    expect(
      filterOpenCodeModelsForConfiguredAllowlist(
        [
          { id: "openai/gpt-5.6", label: "openai/gpt-5.6" },
          { id: "openai/gpt-5.6-sol", label: "openai/gpt-5.6-sol" },
          { id: "openai/gpt-5.6-sol-fast", label: "openai/gpt-5.6-sol-fast" },
          { id: "openai/gpt-5.6-terra", label: "openai/gpt-5.6-terra" },
          { id: "openai/gpt-5.6-luna", label: "openai/gpt-5.6-luna" },
          { id: "openai/gpt-5.5", label: "openai/gpt-5.5" },
        ],
        "openai/gpt-5.6-sol, openai/gpt-5.6-terra openai/gpt-5.5",
      ),
    ).toEqual([
      { id: "openai/gpt-5.6-sol", label: "openai/gpt-5.6-sol" },
      { id: "openai/gpt-5.6-terra", label: "openai/gpt-5.6-terra" },
      { id: "openai/gpt-5.5", label: "openai/gpt-5.5" },
    ]);
  });
});
