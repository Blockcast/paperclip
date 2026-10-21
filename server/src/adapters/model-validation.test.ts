import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetClaudeModelsCacheForTests } from "@paperclipai/adapter-claude-local/server";
import type { AdapterModel, ServerAdapterModule } from "@paperclipai/adapter-utils";
import {
  findServerAdapter,
  registerServerAdapter,
  unregisterServerAdapter,
  waitForExternalAdapters,
} from "./registry.js";
import {
  ALLOW_UNLISTED_ADAPTER_MODELS_ENV,
  describeUnregisteredModel,
  findUnregisteredAdapterModel,
  findUnregisteredModel,
} from "./model-validation.js";

vi.mock("acpx/runtime", () => ({
  createAcpRuntime: vi.fn(),
  createAgentRegistry: vi.fn(),
  createRuntimeStore: vi.fn(),
  isAcpRuntimeError: vi.fn(() => false),
}));

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const K8S_ADAPTER_SOURCE = resolve(
  REPO_ROOT,
  "vendor/paperclip-adapter-claude-k8s/src/index.ts",
);

/**
 * Read a model list out of the VENDORED claude_k8s adapter source.
 *
 * `claude_k8s` is an external adapter: it is loaded from the bundled-adapters
 * directory at runtime and is not registered in this process, so a server test
 * has to stand one up. Deriving the ids from the vendored source instead of
 * retyping them is what keeps this test from going vacuous — a fixture list
 * would keep asserting a cross-adapter divergence long after the two registries
 * were reconciled, which is exactly the failure (reading the wrong registry)
 * that PEN-4447 is about.
 */
function readVendoredModelIds(constName: string): string[] {
  const source = readFileSync(K8S_ADAPTER_SOURCE, "utf8");
  const block = new RegExp(`const ${constName}: AdapterModel\\[\\] = \\[([\\s\\S]*?)\\n\\];`).exec(source);
  if (!block) throw new Error(`${constName} not found in ${K8S_ADAPTER_SOURCE}`);
  const ids = Array.from(block[1].matchAll(/\bid:\s*"([^"]+)"/g)).map((m) => m[1]);
  // Pin the parse itself. A regex that silently matched nothing would make
  // every assertion below pass against an empty registry.
  if (ids.length < 5) throw new Error(`parsed only ${ids.length} ids from ${constName}`);
  return ids;
}

const K8S_DIRECT_MODEL_IDS = readVendoredModelIds("DIRECT_MODELS");
const K8S_BEDROCK_MODEL_IDS = readVendoredModelIds("BEDROCK_MODELS");

const CLI_ALIASES = ["opus", "sonnet", "haiku", "opusplan"];

function isBedrockStub(adapterConfig: Record<string, unknown>): boolean {
  const env =
    typeof adapterConfig.env === "object" && adapterConfig.env !== null
      ? (adapterConfig.env as Record<string, unknown>)
      : {};
  return env.CLAUDE_CODE_USE_BEDROCK === "1";
}

function asModels(ids: string[]): AdapterModel[] {
  return ids.map((id) => ({ id, label: id }));
}

/**
 * Stand-in for the vendored `claude_k8s` server module, carrying the same two
 * capability declarations and the same Direct/Bedrock branch keyed off the
 * agent's own env. The lists are the vendored ones.
 */
function claudeK8sStub(overrides: Partial<ServerAdapterModule> = {}): ServerAdapterModule {
  return {
    type: "claude_k8s",
    execute: vi.fn(),
    testEnvironment: vi.fn(),
    models: asModels(K8S_DIRECT_MODEL_IDS),
    listModels: async () => asModels(K8S_DIRECT_MODEL_IDS),
    listModelsForConfig: async (adapterConfig: Record<string, unknown>) =>
      asModels([
        ...(isBedrockStub(adapterConfig) ? K8S_BEDROCK_MODEL_IDS : K8S_DIRECT_MODEL_IDS),
        ...CLI_ALIASES,
      ]),
    acceptsModelForConfig: (model: string, adapterConfig: Record<string, unknown>) =>
      isBedrockStub(adapterConfig) && /^(\w+\.)?anthropic\.|^arn:aws:bedrock:/.test(model),
    modelRegistryIsClosed: true,
    ...overrides,
  } as ServerAdapterModule;
}

describe("adapter model write validation (PEN-4447)", () => {
  // This process may itself have loaded a real bundled `claude_k8s` adapter,
  // asynchronously. Let that settle before overriding the type, and put the
  // loaded module back afterwards, so neither direction of the race decides
  // what these assertions run against.
  let previousK8sAdapter: ServerAdapterModule | null = null;

  beforeEach(async () => {
    await waitForExternalAdapters();
    previousK8sAdapter = findServerAdapter("claude_k8s");
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.ANTHROPIC_BEDROCK_BASE_URL;
    delete process.env.CLAUDE_CODE_USE_BEDROCK;
    delete process.env.PAPERCLIP_ADAPTER_MODELS;
    delete process.env[ALLOW_UNLISTED_ADAPTER_MODELS_ENV];
    resetClaudeModelsCacheForTests();
    registerServerAdapter(claudeK8sStub());
  });

  afterEach(() => {
    unregisterServerAdapter("claude_k8s");
    if (previousK8sAdapter) registerServerAdapter(previousK8sAdapter);
    delete process.env.PAPERCLIP_ADAPTER_MODELS;
    delete process.env[ALLOW_UNLISTED_ADAPTER_MODELS_ENV];
    resetClaudeModelsCacheForTests();
  });

  describe("cross-adapter divergence", () => {
    it("refuses claude-haiku-4-5 for claude_k8s and accepts it for claude_local", async () => {
      // The near-miss this row was filed on. `claude-haiku-4-5` was proposed as
      // a safe blind write BECAUSE it looked like the cheapest registered id;
      // it is registered by claude_local and absent from claude_k8s, so on a
      // claude_k8s lane that write is the one that kills the pod.
      const refused = await findUnregisteredAdapterModel("claude_k8s", {
        model: "claude-haiku-4-5",
      });
      expect(refused).not.toBeNull();
      expect(refused?.model).toBe("claude-haiku-4-5");

      const accepted = await findUnregisteredAdapterModel("claude_local", {
        model: "claude-haiku-4-5",
      });
      expect(accepted).toBeNull();
    });

    it("accepts the id claude_k8s does register, and refuses it for claude_local", async () => {
      // The reverse direction, so the test above cannot pass merely because
      // claude_k8s refuses everything. `claude-haiku-4-6` is the actual cheap
      // floor on claude_k8s and is not a claude_local id at all.
      await expect(
        findUnregisteredAdapterModel("claude_k8s", { model: "claude-haiku-4-6" }),
      ).resolves.toBeNull();
      await expect(
        findUnregisteredAdapterModel("claude_local", { model: "claude-haiku-4-6" }),
      ).resolves.not.toBeNull();
    });

    it("accepts an id both adapters register", async () => {
      await expect(
        findUnregisteredAdapterModel("claude_k8s", { model: "claude-opus-5" }),
      ).resolves.toBeNull();
      await expect(
        findUnregisteredAdapterModel("claude_local", { model: "claude-opus-5" }),
      ).resolves.toBeNull();
    });

    it("names the valid set in the refusal", async () => {
      const refused = await findUnregisteredAdapterModel("claude_k8s", {
        model: "claude-haiku-4-5",
      });
      expect(refused).not.toBeNull();
      const message = describeUnregisteredModel(refused!);
      expect(message).toContain('Unknown model "claude-haiku-4-5"');
      expect(message).toContain("claude_k8s");
      expect(message).toContain("claude-haiku-4-6");
    });
  });

  describe("Bedrock branch", () => {
    it("validates a Bedrock lane against the Bedrock registry", async () => {
      const config = { model: K8S_BEDROCK_MODEL_IDS[0], env: { CLAUDE_CODE_USE_BEDROCK: "1" } };
      await expect(findUnregisteredAdapterModel("claude_k8s", config)).resolves.toBeNull();
    });

    it("refuses a direct id on a Bedrock lane", async () => {
      const refused = await findUnregisteredAdapterModel("claude_k8s", {
        model: "claude-opus-5",
        env: { CLAUDE_CODE_USE_BEDROCK: "1" },
      });
      expect(refused).not.toBeNull();
      expect(refused?.validModelIds).toEqual(expect.arrayContaining(K8S_BEDROCK_MODEL_IDS));
      expect(refused?.validModelIds).not.toContain("claude-opus-5");
    });

    it("refuses a Bedrock id on a direct lane", async () => {
      await expect(
        findUnregisteredAdapterModel("claude_k8s", { model: K8S_BEDROCK_MODEL_IDS[0] }),
      ).resolves.not.toBeNull();
    });
  });

  describe("fail-open arms", () => {
    it("accepts anything for an adapter that has not declared a closed registry", async () => {
      unregisterServerAdapter("claude_k8s");
      registerServerAdapter(claudeK8sStub({ modelRegistryIsClosed: undefined }));
      await expect(
        findUnregisteredAdapterModel("claude_k8s", { model: "not-a-model-at-all" }),
      ).resolves.toBeNull();
    });

    it("accepts anything for an adapter type this process has not loaded", async () => {
      await expect(
        findUnregisteredAdapterModel("some_unloaded_adapter", { model: "not-a-model-at-all" }),
      ).resolves.toBeNull();
    });

    it("accepts a config that sets no model", async () => {
      await expect(findUnregisteredAdapterModel("claude_k8s", {})).resolves.toBeNull();
      await expect(
        findUnregisteredAdapterModel("claude_k8s", { model: "   " }),
      ).resolves.toBeNull();
      await expect(
        findUnregisteredAdapterModel("claude_k8s", { model: 42 }),
      ).resolves.toBeNull();
    });

    it("accepts an id an operator declared in PAPERCLIP_ADAPTER_MODELS", async () => {
      // The narrow escape hatch: a model the provider has shipped and the
      // adapter has not listed yet should not need a release to configure.
      process.env.PAPERCLIP_ADAPTER_MODELS = JSON.stringify({
        claude_k8s: [{ id: "claude-unreleased-9", label: "Unreleased 9" }],
      });
      await expect(
        findUnregisteredAdapterModel("claude_k8s", { model: "claude-unreleased-9" }),
      ).resolves.toBeNull();
      // ...and the declaration REPLACES the registry rather than extending it,
      // which is the pre-existing `listAdapterModels` precedence.
      await expect(
        findUnregisteredAdapterModel("claude_k8s", { model: "claude-opus-5" }),
      ).resolves.not.toBeNull();
    });

    it("accepts anything when the fleet-wide override is set", async () => {
      process.env[ALLOW_UNLISTED_ADAPTER_MODELS_ENV] = "1";
      await expect(
        findUnregisteredAdapterModel("claude_k8s", { model: "not-a-model-at-all" }),
      ).resolves.toBeNull();
    });
  });


  // Ally's Important finding on #2901: a closed registry has to admit every id
  // the runtime accepts, not every id the picker shows. Both shapes below boot
  // fine today and were refused by the first cut.
  describe("ids no picker list carries", () => {
    it("accepts a CLI alias", async () => {
      for (const alias of CLI_ALIASES) {
        await expect(
          findUnregisteredAdapterModel("claude_k8s", { model: alias }),
        ).resolves.toBeNull();
      }
    });

    it("accepts a Bedrock inference profile in any region, and an ARN", async () => {
      const bedrockEnv = { CLAUDE_CODE_USE_BEDROCK: "1" };
      for (const model of [
        "eu.anthropic.claude-opus-5",
        "apac.anthropic.claude-sonnet-5",
        "anthropic.claude-opus-5",
        "arn:aws:bedrock:us-east-1:123456789012:inference-profile/custom",
      ]) {
        await expect(
          findUnregisteredAdapterModel("claude_k8s", { model, env: bedrockEnv }),
        ).resolves.toBeNull();
      }
    });

    it("still refuses a Bedrock-shaped id on a direct lane", async () => {
      // The predicate widens admission, it does not disable the Direct/Bedrock
      // distinction — that id is a real mistake on a lane with no Bedrock env.
      await expect(
        findUnregisteredAdapterModel("claude_k8s", { model: "eu.anthropic.claude-opus-5" }),
      ).resolves.not.toBeNull();
    });

    it("still refuses a plausible non-id", async () => {
      await expect(
        findUnregisteredAdapterModel("claude_k8s", { model: "opus-5" }),
      ).resolves.not.toBeNull();
    });
  });

  // Only what the write INTRODUCES is judged, so a registry that has since
  // narrowed cannot wedge an agent out of unrelated repairs.
  describe("already-stored ids", () => {
    it("tolerates an unregistered model the agent already carries", async () => {
      await expect(
        findUnregisteredAdapterModel(
          "claude_k8s",
          { model: "claude-haiku-4-5", cwd: "/new/path" },
          { adapterType: "claude_k8s", adapterConfig: { model: "claude-haiku-4-5" } },
        ),
      ).resolves.toBeNull();
    });

    it("refuses a CHANGE to another unregistered model", async () => {
      await expect(
        findUnregisteredAdapterModel(
          "claude_k8s",
          { model: "claude-mythos-5" },
          { adapterType: "claude_k8s", adapterConfig: { model: "claude-haiku-4-5" } },
        ),
      ).resolves.not.toBeNull();
    });

    it("refuses re-pointing the agent at an adapter that does not register the stored model", async () => {
      // The string did not change; the PAIR did, and that is the introduction.
      await expect(
        findUnregisteredAdapterModel(
          "claude_k8s",
          { model: "claude-haiku-4-5" },
          { adapterType: "claude_local", adapterConfig: { model: "claude-haiku-4-5" } },
        ),
      ).resolves.not.toBeNull();
    });

    it("treats a create (no previous) as introducing everything", async () => {
      await expect(
        findUnregisteredAdapterModel("claude_k8s", { model: "claude-haiku-4-5" }, null),
      ).resolves.not.toBeNull();
    });
  });

  describe("findUnregisteredModel", () => {
    const registry = [{ id: "a" }, { id: "b" }];

    it("trims before comparing", () => {
      expect(
        findUnregisteredModel({
          adapterType: "t",
          model: "  a  ",
          registry,
          registryIsClosed: true,
          env: {},
        }),
      ).toBeNull();
    });

    it("is case sensitive", () => {
      expect(
        findUnregisteredModel({
          adapterType: "t",
          model: "A",
          registry,
          registryIsClosed: true,
          env: {},
        }),
      ).not.toBeNull();
    });

    it("does not enforce against an empty registry", () => {
      expect(
        findUnregisteredModel({
          adapterType: "t",
          model: "a",
          registry: [],
          registryIsClosed: true,
          env: {},
        }),
      ).toBeNull();
    });

    it("truncates a long valid set in the message but reports the full count", () => {
      const long = Array.from({ length: 60 }, (_, i) => ({ id: `m${i}` }));
      const finding = findUnregisteredModel({
        adapterType: "t",
        model: "nope",
        registry: long,
        registryIsClosed: true,
        env: {},
      });
      expect(finding?.validModelIds).toHaveLength(60);
      expect(describeUnregisteredModel(finding!)).toContain("+20 more");
    });
  });
});
