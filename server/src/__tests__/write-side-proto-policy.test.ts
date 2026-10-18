/**
 * @fileoverview Pins the PEN-4244 decision: a `__proto__` key in a posted plugin `configJson`
 * or agent `adapterConfig` is deliberately PERSISTED, not refused.
 *
 * This is the opposite of `normalizeEnvConfig`'s 422 (PEN-3257), and the asymmetry is
 * intentional. The reasoning lives beside `mergeRecord` in `services/plugin-config-masking.ts`.
 *
 * These tests are a TRIPWIRE, not a feature test. "Persisting is fine" is only true while no
 * downstream consumer re-parents on a stored key — every merge of these records today is a
 * spread (CreateDataProperty, which defines an own property rather than invoking the setter).
 * The pollution assertions below are written to FAIL the moment that stops being true, so the
 * decision is re-opened by a red test rather than by somebody happening to remember this row.
 *
 * Per the PEN-3288/PEN-4240 test traps, every fixture is built from RAW JSON TEXT: `__proto__`
 * in an object literal assigns the prototype instead of creating an own key, and the obvious
 * spelling would pass vacuously. Each fixture also carries an ordinary sibling key that must
 * survive, so a walk that silently dropped everything could not score as a pass.
 */

import { describe, expect, it } from "vitest";
import { stripRedactedEnvBindingsFromAdapterConfig } from "../agent-redaction.js";
import { REDACTED_EVENT_VALUE } from "../redaction.js";
import { mergeMaskedPluginConfig } from "../services/plugin-config-masking.js";
import { validateInstanceConfig } from "../services/plugin-config-validator.js";

/** Parse from raw JSON text so `__proto__` lands as a real OWN data property. */
function fromJson(text: string): Record<string, unknown> {
  return JSON.parse(text) as Record<string, unknown>;
}

const POSTED = '{"__proto__":{"polluted":"yes"},"ordinarySibling":"kept"}';

/** Assert nothing in this test has re-parented a shared prototype. */
function expectNoPrototypePollution(): void {
  expect((Object.prototype as unknown as { polluted?: unknown }).polluted).toBeUndefined();
  expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
}

describe("PEN-4244: write-side `__proto__` policy", () => {
  it("the fixture carries a real own `__proto__` key (vacuity guard)", () => {
    const posted = fromJson(POSTED);
    expect(Object.keys(posted)).toEqual(["__proto__", "ordinarySibling"]);
    expect(Object.getPrototypeOf(posted)).toBe(Object.prototype);
  });

  describe("plugin configJson", () => {
    it("persists the key through the masked-config merge instead of dropping or refusing it", () => {
      const merged = mergeMaskedPluginConfig(fromJson(POSTED), fromJson('{"ordinarySibling":"old"}'));

      expect(Object.keys(merged.configJson)).toContain("__proto__");
      expect(merged.configJson.ordinarySibling).toBe("kept");
      expect(merged.unresolvedMaskPaths).toEqual([]);
    });

    it("persisting does not re-parent the merged record or pollute `Object.prototype`", () => {
      const merged = mergeMaskedPluginConfig(fromJson(POSTED), fromJson("{}"));

      expect(Object.getPrototypeOf(merged.configJson)).toBe(Object.prototype);
      expectNoPrototypePollution();
    });

    it("survives the jsonb round-trip as an own key, still without polluting", () => {
      const merged = mergeMaskedPluginConfig(fromJson(POSTED), fromJson("{}"));

      // `JSON.stringify` -> jsonb column -> `JSON.parse` on the way back out.
      const reloaded = JSON.parse(JSON.stringify(merged.configJson)) as Record<string, unknown>;

      expect(Object.keys(reloaded)).toContain("__proto__");
      expect(Object.getPrototypeOf(reloaded)).toBe(Object.prototype);
      expectNoPrototypePollution();
    });

    it("the downstream consumer shape — a spread merge — copies the key without re-parenting", () => {
      // Every merge of a stored config/adapterConfig downstream is a spread. Spread uses
      // CreateDataProperty, so it defines an own `__proto__`; this is the property the
      // "persisting is fine" decision rests on. If a consumer ever switches to `[[Set]]`
      // (a bare `out[key] = value`, or `Object.assign`), this is the assertion that goes red.
      const reloaded = JSON.parse(
        JSON.stringify(mergeMaskedPluginConfig(fromJson(POSTED), fromJson("{}")).configJson),
      ) as Record<string, unknown>;

      const spread = { ...reloaded };

      expect(Object.keys(spread)).toContain("__proto__");
      expect(Object.getPrototypeOf(spread)).toBe(Object.prototype);
      expectNoPrototypePollution();
    });
  });

  describe("agent adapterConfig", () => {
    // `stripRedactedEnvBindingsFromAdapterConfig` SHORT-CIRCUITS on
    // `containsRedactedAdapterValue`: a payload with no sentinel in it is returned byte-identical
    // and the restore walk never executes. A fixture without one therefore never reaches the
    // accumulator under test and scores a pass against a broken implementation -- the exact
    // "fixture fails to reach the site" trap PEN-4240's row warns about, and the reason these
    // fixtures carry a masked value. (Found by mutation: an earlier version of this test
    // SURVIVED reverting `assignRecordKey` here.) The sentinel is interpolated from the exported
    // constant rather than spelled out, so a change to its text cannot silently disarm this.
    const postedWithSentinel = () =>
      fromJson(
        `{"__proto__":{"polluted":"yes"},"ordinarySibling":"kept","maskedField":${JSON.stringify(
          REDACTED_EVENT_VALUE,
        )}}`,
      );
    const storedAdapterConfig = () => fromJson('{"ordinarySibling":"old","maskedField":"prior"}');

    it("persists the key through the adapter-value restore instead of dropping or refusing it", () => {
      const restored = stripRedactedEnvBindingsFromAdapterConfig(
        postedWithSentinel(),
        storedAdapterConfig(),
      );

      // Proof the walk really ran: the masked field was restored from the stored value.
      expect(restored.maskedField).toBe("prior");

      expect(Object.keys(restored)).toContain("__proto__");
      expect(restored.ordinarySibling).toBe("kept");
      expect(Object.getPrototypeOf(restored)).toBe(Object.prototype);
      expectNoPrototypePollution();
    });

    it("persists a process-variable key named `__proto__` through the sentinel-cleaning accumulator", () => {
      const restored = stripRedactedEnvBindingsFromAdapterConfig(
        fromJson('{"env":{"__proto__":"literal-value","ORDINARY_VAR":"kept"}}'),
        fromJson('{"env":{"ORDINARY_VAR":"old"}}'),
      );
      const bindings = restored.env as Record<string, unknown>;

      expect(Object.keys(bindings)).toContain("__proto__");
      expect(bindings.ORDINARY_VAR).toBe("kept");
      expect(Object.getPrototypeOf(bindings)).toBe(Object.prototype);
      expectNoPrototypePollution();
    });
  });

  describe("a plugin that wants the key refused already has the mechanism", () => {
    const strictSchema = {
      type: "object",
      properties: { ordinarySibling: { type: "string" } },
      additionalProperties: false,
    };

    it("`additionalProperties: false` makes Ajv reject it", () => {
      const result = validateInstanceConfig(fromJson(POSTED), strictSchema);

      expect(result.valid).toBe(false);
      expect(result.errors?.[0]?.message).toContain("must NOT have additional properties");
    });

    it("a permissive schema accepts it — no blanket refusal was added", () => {
      // This assertion is deliberately load-bearing: it records that NOT refusing is a decision.
      // Introducing a blanket `__proto__` refusal has to come and edit this test on purpose.
      const result = validateInstanceConfig(fromJson(POSTED), {
        type: "object",
        properties: { ordinarySibling: { type: "string" } },
      });

      expect(result.valid).toBe(true);
    });

    it("the strict-schema refusal is not vacuous — an ordinary config passes the same schema", () => {
      const result = validateInstanceConfig(fromJson('{"ordinarySibling":"kept"}'), strictSchema);

      expect(result.valid).toBe(true);
    });
  });
});
