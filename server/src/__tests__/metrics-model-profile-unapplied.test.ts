import { describe, expect, it } from "vitest";
import { MODEL_PROFILE_UNAPPLIED_METRIC, recordModelProfileUnapplied, renderMetrics } from "../services/metrics.js";

// BLO-32843: a requested-but-unapplied profile must be alertable, not only a run field.
describe("recordModelProfileUnapplied", () => {
  it("exports the counter with adapter/requested/reason labels", async () => {
    recordModelProfileUnapplied({ adapter: "claude_k8s", requested: "cheap", reason: "adapter_profile_not_supported" });
    const { body } = await renderMetrics();
    expect(body).toMatch(
      new RegExp(
        `${MODEL_PROFILE_UNAPPLIED_METRIC}[^\\n]*adapter="claude_k8s"[^\\n]*reason="adapter_profile_not_supported"[^\\n]*requested="cheap"[^\\n]* 1`,
      ),
    );
  });
});
