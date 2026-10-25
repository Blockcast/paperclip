import { describe, expect, it } from "vitest";
import { z } from "zod";
import { optionalNoDefault, partialNoDefaults } from "./zod-compat.js";

describe("zod-3 optional/partial semantics", () => {
  const base = z.object({
    flag: z.boolean().prefault(false),
    tier: z.enum(["a", "b"]).nullable().prefault("a"),
    name: z.string(),
  }).strict();

  it("partialNoDefaults keeps absent keys absent", () => {
    expect(base.partial().parse({})).toEqual({ flag: false, tier: "a" }); // the zod 4 drift
    expect(partialNoDefaults(base).parse({})).toEqual({});
    expect(partialNoDefaults(base).parse({ flag: true, tier: null })).toEqual({ flag: true, tier: null });
  });

  it("partialNoDefaults keeps the object config", () => {
    expect(partialNoDefaults(base).safeParse({ extra: 1 }).success).toBe(false);
  });

  it("optionalNoDefault keeps undefined undefined", () => {
    expect(optionalNoDefault(z.string().prefault("x")).parse(undefined)).toBeUndefined();
    expect(optionalNoDefault(z.string().prefault("x")).parse("y")).toBe("y");
  });
});
