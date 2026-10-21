import { describe, it, expect } from "vitest";
import { createServerAdapter } from "./index.js";
import { buildModelProfiles } from "../index.js";

// BLO-32843: the server applies `cheap` only if the adapter publishes it.
describe("opencode_k8s model profiles", () => {
  it("publishes a cheap profile on a model this adapter lists", () => {
    const adapter = createServerAdapter() as { modelProfiles?: Array<{ key: string; adapterConfig: Record<string, unknown> }>; models?: Array<{ id: string }> };
    const cheap = buildModelProfiles({}).find((p) => p.key === "cheap");
    expect(adapter.modelProfiles?.some((p) => p.key === "cheap")).toBe(true);
    expect(adapter.models?.map((m) => m.id)).toContain(cheap?.adapterConfig.model);
  });

  it("honours PAPERCLIP_OPENCODE_CHEAP_MODEL", () => {
    const [cheap] = buildModelProfiles({ PAPERCLIP_OPENCODE_CHEAP_MODEL: " anthropic/claude-sonnet-5-5 " });
    expect(cheap.adapterConfig).toEqual({ model: "anthropic/claude-sonnet-5-5" });
  });
});
