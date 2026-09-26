import { describe, it, expect } from "vitest";
import {
  ROUTINE_DESCRIPTION_MAX_BYTES,
  createRoutineSchema,
  updateRoutineSchema,
} from "../validators/routine.js";

const utf8Bytes = (value: string) => new TextEncoder().encode(value).length;
const base = { title: "Scan for open PR unreviewed HEADs" };

describe("routine description byte cap", () => {
  it("accepts a body just under the cap", () => {
    const description = "a".repeat(ROUTINE_DESCRIPTION_MAX_BYTES - 1);
    expect(createRoutineSchema.safeParse({ ...base, description }).success).toBe(true);
  });

  it("rejects a body one byte over the cap", () => {
    const description = "a".repeat(ROUTINE_DESCRIPTION_MAX_BYTES + 1);
    const result = createRoutineSchema.safeParse({ ...base, description });
    expect(result.success).toBe(false);
    // The writer must be able to act without re-measuring: the error names both numbers.
    const message = result.success ? "" : result.error.issues[0]?.message ?? "";
    expect(message).toContain(String(ROUTINE_DESCRIPTION_MAX_BYTES + 1));
    expect(message).toContain(String(ROUTINE_DESCRIPTION_MAX_BYTES));
  });

  // The assertion that matters. A naive z.string().max(130_000) counts UTF-16 code units, so
  // this body measures 80_000 to it and passes -- while being ~160_000 bytes on the wire and
  // fatal to the pod. This is the real shape: these bodies are full of emoji.
  it("rejects an emoji body that is under the cap in UTF-16 code units but over it in bytes", () => {
    const description = "\u{1F6D1}".repeat(40_000);
    expect(description.length).toBeLessThan(ROUTINE_DESCRIPTION_MAX_BYTES);
    expect(utf8Bytes(description)).toBeGreaterThan(ROUTINE_DESCRIPTION_MAX_BYTES);
    expect(createRoutineSchema.safeParse({ ...base, description }).success).toBe(false);
  });

  // Asserted, not inferred from `.partial()`.
  it("rejects the same body on update", () => {
    const description = "a".repeat(ROUTINE_DESCRIPTION_MAX_BYTES + 1);
    expect(updateRoutineSchema.safeParse({ description }).success).toBe(false);
  });

  it("still allows description to be omitted or null", () => {
    expect(createRoutineSchema.safeParse({ ...base }).success).toBe(true);
    expect(createRoutineSchema.safeParse({ ...base, description: null }).success).toBe(true);
  });
});
