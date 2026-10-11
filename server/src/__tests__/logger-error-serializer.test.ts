import pino from "pino";
import { describe, expect, it } from "vitest";
import { logger } from "../middleware/logger.js";

// BLO-29133: pino applies its Error serializer to the `err` key only. Roughly
// 35 call sites in this repo log `{ error }`, and an Error's `message`/`stack`
// are non-enumerable -- so every one of those lines rendered the diagnostic as
// an empty object. The reaper's "external-runtime reservation Job identity
// mismatch" line was the worst case: ~300 ERROR lines per 3h in production,
// none of which said which guard had tripped.
describe("logger error serialization", () => {
  const serializers = (logger as unknown as Record<symbol, Record<string, (value: unknown) => unknown>>)[
    pino.symbols.serializersSym
  ];

  it("serializes a bare `error` key through pino's Error serializer", () => {
    const serialized = serializers.error(new Error("boom")) as {
      type?: string;
      message?: string;
      stack?: string;
    };
    expect(serialized.message).toBe("boom");
    expect(serialized.stack).toContain("boom");
  });

  it("keeps pino's default `err` serializer after the merge", () => {
    expect(typeof serializers.err).toBe("function");
  });

  it("passes non-Error values through untouched", () => {
    expect(serializers.error("already a string")).toBe("already a string");
  });
});
