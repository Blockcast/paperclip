import { describe, it, expect } from "vitest";
import { createServerAdapter } from "./index.js";

// BLO-32843: the server applies `cheap` only if the adapter publishes it.
describe("claude_k8s model profiles", () => {
  it("publishes a cheap profile on a model this adapter lists", () => {
    const adapter = createServerAdapter() as { modelProfiles?: Array<{ key: string; adapterConfig: Record<string, unknown> }>; models?: Array<{ id: string }> };
    const cheap = adapter.modelProfiles?.find((p) => p.key === "cheap");
    expect(cheap).toBeDefined();
    expect(adapter.models?.map((m) => m.id)).toContain(cheap?.adapterConfig.model);
    expect(cheap?.adapterConfig.effort).toBe("low");
  });
});
