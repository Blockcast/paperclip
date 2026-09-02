// The adapter's model list is hand-maintained: every new Claude release is
// three near-identical lines edited by hand across two files. That shape makes
// mechanical mistakes easy and invisible — a duplicated id silently shadows an
// entry in the picker, a `[1m]` variant whose base model was never added (or
// was later removed) offers a context window for a model that isn't listed,
// and a Bedrock id that doesn't follow the `us.anthropic.` prefix is simply
// never recognised by `isBedrockModelId`.
//
// None of this validates that a model ID actually RESOLVES upstream — nothing
// local can, and that check belongs to whoever has API access. What this pins
// is internal consistency, which is the part a reviewer cannot eyeball
// reliably once the list is 20+ entries long.

import { describe, expect, it } from "vitest";

import { models } from "../index.js";
import { isBedrockModelId } from "./models.js";

describe("claude_local model list", () => {
  it("has no duplicate ids", () => {
    const ids = models.map((m) => m.id);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    expect(dupes).toEqual([]);
  });

  it("gives every model a non-empty label", () => {
    const unlabelled = models.filter((m) => !m.label || !m.label.trim());
    expect(unlabelled.map((m) => m.id)).toEqual([]);
  });

  it("backs every [1m] variant with its base model", () => {
    // A 1M entry is a context-window variant, not a distinct model. Listing one
    // whose base is absent offers a configuration the adapter cannot otherwise
    // name — the failure is silent, since the picker renders both independently.
    const ids = new Set(models.map((m) => m.id));
    const orphans = models
      .map((m) => m.id)
      .filter((id) => id.endsWith("[1m]"))
      .filter((id) => !ids.has(id.slice(0, -"[1m]".length)));
    expect(orphans).toEqual([]);
  });

  it("recognises its own Bedrock ids", () => {
    // Guards the prefix contract from the other side: if a Bedrock entry is
    // added without the `us.anthropic.` form, isBedrockModelId returns false
    // and the model routes as if it were direct-API.
    const bedrock = models.map((m) => m.id).filter((id) => id.startsWith("us.anthropic."));
    for (const id of bedrock) {
      expect(isBedrockModelId(id), `${id} must be recognised as a Bedrock id`).toBe(true);
    }
  });
});
