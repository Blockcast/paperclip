import { describe, it, expect } from "vitest";
import { getConfigSchema } from "./config-schema.js";
import { DEFAULT_CLAUDE_CODE_VERSION } from "./runtime-pin.js";

interface ConfigFieldSchema {
  key: string;
  label: string;
  type: string;
  default?: unknown;
  options?: { label: string; value: string }[];
}

describe("getConfigSchema", () => {
  it("returns a non-empty schema", () => {
    const schema = getConfigSchema();
    expect(schema.fields.length).toBeGreaterThan(0);
  });

  it("does not include platform-provided fields", () => {
    const schema = getConfigSchema();
    const keys = schema.fields.map((f: ConfigFieldSchema) => f.key);
    // These fields are provided by the platform and should not be duplicated
    expect(keys).not.toContain("model");
    expect(keys).not.toContain("effort");
    expect(keys).not.toContain("instructionsFilePath");
    expect(keys).not.toContain("timeoutSec");
    expect(keys).not.toContain("graceSec");
  });

  it("exposes claudeCodeVersion defaulting to the adapter pin", () => {
    const schema = getConfigSchema();
    const field = schema.fields.find((f: ConfigFieldSchema) => f.key === "claudeCodeVersion");
    expect(field).toBeDefined();
    expect(field!.type).toBe("text");
    expect(field!.default).toBe(DEFAULT_CLAUDE_CODE_VERSION);
  });

  it("maxTurnsPerRun defaults to 1000", () => {
    const schema = getConfigSchema();
    const field = schema.fields.find((f: ConfigFieldSchema) => f.key === "maxTurnsPerRun");
    expect(field).toBeDefined();
    expect(field!.type).toBe("number");
    expect(field!.default).toBe(1000);
  });

  // PEN-5017: the gate decides whether the GitHub push credential lands in the
  // agent container or in a sidecar at another uid. Before this it was settable
  // but invisible, so a reviewer could not tell a brokered agent from an
  // unbrokered one without reading the database.
  it("exposes enablePerAgentWorkspaceVolume, defaulting off (PEN-4932/PEN-5120)", () => {
    // The gate reads `config.enablePerAgentWorkspaceVolume` whether or not it is
    // in this schema, so the schema entry is what makes the state of a blast-radius
    // boundary legible to someone looking at the agent rather than at the database.
    // Default MUST stay false: on is a per-agent decision somebody makes, never a
    // fleet-wide one that arrives with a deploy.
    const schema = getConfigSchema();
    const field = schema.fields.find((f: ConfigFieldSchema) => f.key === "enablePerAgentWorkspaceVolume");
    expect(field).toBeDefined();
    expect(field!.type).toBe("toggle");
    expect(field!.default).toBe(false);
  });

  it("exposes enableGitHubPublishBroker, defaulting off", () => {
    const schema = getConfigSchema();
    const field = schema.fields.find((f: ConfigFieldSchema) => f.key === "enableGitHubPublishBroker");
    expect(field).toBeDefined();
    expect(field!.type).toBe("toggle");
    expect(field!.default).toBe(false);
  });

  it("does not expose dangerouslySkipPermissions in UI schema", () => {
    const schema = getConfigSchema();
    const field = schema.fields.find((f: ConfigFieldSchema) => f.key === "dangerouslySkipPermissions");
    expect(field).toBeUndefined();
  });

  it("exposes the Caveman and Ponytail fields", () => {
    const schema = getConfigSchema();
    const fields = new Map(schema.fields.map((field: ConfigFieldSchema) => [field.key, field]));
    expect(fields.get("agentCommand")?.type).toBe("text");
    expect(fields.get("ponytailPluginPath")?.type).toBe("text");
    expect(fields.get("ponytailDefaultMode")?.type).toBe("select");
    expect(fields.get("ponytailDefaultMode")?.options).toEqual([
      { value: "off", label: "Off" },
      { value: "lite", label: "Lite" },
      { value: "full", label: "Full" },
      { value: "ultra", label: "Ultra" },
    ]);
  });

  it("exposes the tool-child memory cap next to the memory limit it derives from (BLO-34477)", () => {
    const schema = getConfigSchema();
    const keys = schema.fields.map((f: ConfigFieldSchema) => f.key);
    const field = schema.fields.find((f: ConfigFieldSchema) => f.key === "resources.limits.toolMemoryKb");
    expect(field?.type).toBe("number");
    expect(field?.hint).toMatch(/half of Memory Limit/);
    expect(field?.hint).toMatch(/0 disables/);
    expect(field?.hint).toMatch(/786432/);
    // The memory hint's examples must not derive a cap under which node cannot start.
    const memory = schema.fields.find((f: ConfigFieldSchema) => f.key === "resources.limits.memory");
    expect(memory?.hint).not.toMatch(/\b(128Mi|512Mi|1Gi)\b/);
    expect(keys.indexOf("resources.limits.toolMemoryKb")).toBe(keys.indexOf("resources.limits.memory") + 1);
  });

  it("reattachOrphanedJobs defaults to true", () => {
    const schema = getConfigSchema();
    const field = schema.fields.find((f: ConfigFieldSchema) => f.key === "reattachOrphanedJobs");
    expect(field).toBeDefined();
    expect(field!.type).toBe("toggle");
    expect(field!.default).toBe(true);
  });

  it("has imagePullPolicy as select with correct options", () => {
    const schema = getConfigSchema();
    const field = schema.fields.find((f: ConfigFieldSchema) => f.key === "imagePullPolicy");
    expect(field).toBeDefined();
    expect(field!.type).toBe("select");
    expect(field!.options).toEqual([
      { label: "IfNotPresent", value: "IfNotPresent" },
      { label: "Always", value: "Always" },
      { label: "Never", value: "Never" },
    ]);
  });
});
