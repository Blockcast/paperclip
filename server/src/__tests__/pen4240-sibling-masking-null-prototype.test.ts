import { SQL, is } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  REDACTED_ENV_SENTINEL,
  redactAgentSecrets,
  restoreRedactedAdapterValue,
  stripRedactedEnvBindingsFromAdapterConfig,
} from "../agent-redaction.js";
import { REDACTED_EVENT_VALUE } from "../redaction.js";
import { redactCurrentUserValue } from "../log-redaction.js";
import { redactSensitive } from "../middleware/redact-sensitive.js";
import {
  createFeedbackRedactionState,
  sanitizeFeedbackValue,
} from "../services/feedback-redaction.js";
import {
  maskPluginConfigJson,
  mergeMaskedPluginConfig,
  redactSecretValuesDeep,
} from "../services/plugin-config-masking.js";

/**
 * PEN-4240 — the five sibling masking modules must not DROP a `__proto__` key.
 *
 * `out[key] = …` on a `{}` accumulator hits `Object.prototype`'s inherited
 * `__proto__` setter and re-parents the accumulator instead of adding the key,
 * so the key vanishes from the output and from `JSON.stringify`. That breaks
 * the PEN-2370 ask-1 invariant this boundary exists to provide: key NAMES
 * survive so a reader can tell "withheld" from "never set".
 *
 * Every one of the ten accumulators was MEASURED to drop the key against the
 * pre-fix source; see the issue for the per-site table.
 */

/**
 * Fixtures MUST come from raw JSON text. `{ __proto__: x }` in an object
 * literal assigns the PROTOTYPE instead of creating an own key, so the obvious
 * spelling passes vacuously against the pre-fix source.
 */
function fromJson(text: string): Record<string, unknown> {
  const parsed = JSON.parse(text) as Record<string, unknown>;
  // Vacuity guard: prove the fixture really carries the own key before the call.
  expect(Object.keys(parsed)).toContain("__proto__");
  return parsed;
}

/**
 * The assertion every case shares.
 *
 * `sibling` is an ordinary key the SAME walk must emit. A fixture that fails to
 * reach the accumulator would otherwise report a clean "key absent" and pass
 * against the fixed source as happily as against the broken one — the trap that
 * mis-scored two sites on PEN-3288. Asserting the sibling first turns "did not
 * reach" into a distinct, loud failure.
 *
 * The `JSON.parse(JSON.stringify(...))` round-trip is the terminal predicate:
 * these outputs become HTTP response bodies and jsonb columns, and a key that
 * does not survive serialization never reached the reader regardless of what
 * `Object.keys` says.
 */
function expectKeyPreserved(out: unknown, sibling: string) {
  expect(out).toBeTruthy();
  const rec = out as Record<string, unknown>;
  // Reach control first: if this fails the fixture never hit the accumulator.
  expect(Object.keys(rec)).toContain(sibling);
  expect(Object.keys(rec)).toContain("__proto__");
  expect(Object.keys(JSON.parse(JSON.stringify(rec)) as object)).toContain("__proto__");
  return rec;
}

describe("PEN-4240: sibling masking modules preserve a `__proto__` key", () => {
  describe("agent-redaction.ts", () => {
    it("masks a stored env binding named `__proto__` instead of dropping it", () => {
      const agent = {
        adapterConfig: JSON.parse('{"env":{"__proto__":"shh","NORMAL":"v"}}') as Record<string, unknown>,
      };
      expect(Object.keys(agent.adapterConfig.env as object)).toContain("__proto__");

      const env = (redactAgentSecrets(agent).adapterConfig as Record<string, unknown>).env;

      const rec = expectKeyPreserved(env, "NORMAL");
      // Masked, not merely present: the whole point is that it is withheld the
      // same way every sibling binding is.
      expect(rec.__proto__).toBe(REDACTED_ENV_SENTINEL);
      expect(rec.NORMAL).toBe(REDACTED_ENV_SENTINEL);
    });

    it("restores an adapterConfig key named `__proto__` on the write round-trip", () => {
      const incoming = fromJson(
        '{"__proto__":"caller-chosen","keep":"new","masked":"__REDACTED_EVENT_VALUE__"}',
      );

      const restored = restoreRedactedAdapterValue(incoming, { masked: "stored" });

      const rec = expectKeyPreserved(restored, "keep");
      expect(rec.__proto__).toBe("caller-chosen");
    });

    /**
     * This is the sharpest case on the write side.
     *
     * `routes/agents.ts` runs this helper BEFORE `normalizeEnvConfig`, and
     * PEN-3257 made `normalizeEnvConfig` refuse an env key named `__proto__`
     * with a 422 — precisely so a silently-dropped binding stops being a `200`
     * for a write that did nothing. While this accumulator dropped the key, the
     * refusal could never fire on the agent PATCH path: the key was gone before
     * the validator saw it. Preserving it here is what makes PEN-3257's 422
     * reachable.
     */
    it("carries a posted env key named `__proto__` through to the validator", () => {
      const incoming = {
        env: JSON.parse(
          '{"__proto__":{"type":"plain","value":"x"},"NORMAL":{"type":"plain","value":"y"}}',
        ) as Record<string, unknown>,
      };
      expect(Object.keys(incoming.env)).toContain("__proto__");

      const cleaned = stripRedactedEnvBindingsFromAdapterConfig(incoming, null);

      expectKeyPreserved(cleaned.env, "NORMAL");
    });
  });

  describe("services/plugin-config-masking.ts", () => {
    it("masks a stored plugin-config key named `__proto__`", () => {
      const masked = maskPluginConfigJson(fromJson('{"__proto__":"a","normal":"b"}'), null);
      expectKeyPreserved(masked, "normal");
    });

    it("deep-redacts a payload key named `__proto__`", () => {
      const out = redactSecretValuesDeep(fromJson('{"__proto__":"a","normal":"b"}'), ["s3cr3t"]);
      expectKeyPreserved(out, "normal");
    });

    it("merges a posted config key named `__proto__` instead of dropping it", () => {
      const merged = mergeMaskedPluginConfig(
        fromJson('{"__proto__":"a","normal":"b"}'),
        { normal: "old" },
        null,
      );
      expect(merged.unresolvedMaskPaths).toEqual([]);
      expectKeyPreserved(merged.configJson, "normal");
    });
  });

  describe("middleware/redact-sensitive.ts", () => {
    /**
     * This module's own header states the invariant: it preserves "structure and
     * key names so a 4xx log still records *which* variables were set". It runs
     * on `req.body` / `req.params` / `req.query` in `http-log-policy.ts`, so the
     * key name is chosen by whoever sent the request.
     */
    it("masks a request-body key named `__proto__` beneath a credential container", () => {
      const body = { env: JSON.parse('{"__proto__":"a","NORMAL":"b"}') as Record<string, unknown> };
      expect(Object.keys(body.env)).toContain("__proto__");

      const out = redactSensitive(body) as Record<string, unknown>;

      const rec = expectKeyPreserved(out.env, "NORMAL");
      expect(rec.__proto__).toBe("[REDACTED]");
      expect(rec.NORMAL).toBe("[REDACTED]");
    });

    it("keeps a top-level request key named `__proto__`", () => {
      const out = redactSensitive(fromJson('{"__proto__":"a","normal":"b"}'));
      expectKeyPreserved(out, "normal");
    });
  });

  describe("log-redaction.ts", () => {
    /**
     * `activity-log.ts` composes `sanitizeRecord` (redaction.ts) with this walk.
     * While this accumulator dropped the key, fixing `sanitizeRecord` alone
     * (PEN-3288) would not have restored the invariant on that path — the key
     * survived the first walk and was dropped by the second.
     */
    it("keeps an activity-detail key named `__proto__`", () => {
      const out = redactCurrentUserValue(fromJson('{"__proto__":"a","normal":"b"}'), {
        enabled: true,
        userNames: ["alice"],
      });
      expectKeyPreserved(out, "normal");
    });
  });

  describe("services/feedback-redaction.ts", () => {
    /**
     * The one site of the ten that cannot be pinned behaviourally.
     *
     * `sanitizeFeedbackValue` runs `sanitizeRecord` (redaction.ts) over the
     * record BEFORE this walk, and on the current source `sanitizeRecord` drops
     * a `__proto__` key at every depth — measured: top-level, nested and inside
     * an array all come back as `["normal"]`. So this accumulator cannot receive
     * the key today, and a behavioural assertion would pass against the pre-fix
     * source too.
     *
     * It is guarded anyway, and pinned STRUCTURALLY instead: the walk must keep
     * emitting ordinary `Object.prototype` records (see the shared prototype pin
     * below for why that matters), so that PEN-3288 landing in `redaction.ts`
     * cannot silently re-open the defect here the moment the key starts
     * arriving.
     */
    it("recurses without changing the record's prototype", () => {
      const state = createFeedbackRedactionState();

      const out = sanitizeFeedbackValue(
        JSON.parse('{"normal":"b","nested":{"inner":"c"}}'),
        state,
        "root",
        1000,
      );

      // Reach control: a fixture that never hit the accumulator would report the
      // right prototype for the wrong reason.
      expect(Object.keys(out as object)).toContain("normal");
      expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
      expect(Object.getPrototypeOf((out as Record<string, unknown>).nested)).toBe(Object.prototype);
      expect(JSON.parse(JSON.stringify(out))).toEqual({ normal: "b", nested: { inner: "c" } });
    });
  });

  /**
   * ## The pin that earns its place
   *
   * There are two ways to stop `out["__proto__"] = …` hitting the inherited setter: seed the
   * accumulator `Object.create(null)`, or define the key. Every behavioural assertion above
   * passes under BOTH, so none of them can tell the two apart — and they are not
   * interchangeable. A null prototype changes the output's TYPE, and these outputs do not stay
   * inside their module:
   *
   *   `redactCurrentUserValue` is the last transform applied to `activity_log.details` in
   *   `services/activity-log.ts` `logActivity`, which hands it straight to drizzle `.values()`.
   *   `mapUpdateSet` calls drizzle's `is()` on every top-level value, and `is()` reads
   *   `Object.getPrototypeOf(value).constructor` unguarded.
   *
   * Measured, not argued: seeding these ten accumulators `Object.create(null)` turned ALL SIX
   * server shards red with 343 `TypeError: Cannot read properties of null (reading
   * 'constructor')` on shard 1 alone, in tests with nothing to do with masking.
   *
   * So these two cases are the ones that fail on a reseed, and they call the REAL `is()` rather
   * than asserting a prototype identity that only stands in for it.
   */
  describe("the masked output stays a plain object for its consumers", () => {
    it("survives drizzle's `is()`, which `logActivity` runs on every value it inserts", () => {
      const details = redactCurrentUserValue(
        fromJson('{"__proto__":"a","normal":"b"}'),
        { enabled: false },
      );

      // Reach control + the behaviour this module exists for.
      expectKeyPreserved(details, "normal");
      // The terminal predicate: this is the exact call `activity-log.ts` makes on the way to
      // the `activity_log.details` column. `is(Object.create(null), SQL)` THROWS here.
      expect(() => is(details, SQL)).not.toThrow();
      expect(is(details, SQL)).toBe(false);
    });

    it("keeps `Object.prototype` on every sibling walk", () => {
      // Cheap breadth over the remaining modules: a reseed of any one of them fails here even
      // where that module's own output never reaches an ORM today.
      expect(Object.getPrototypeOf(redactSensitive(fromJson('{"__proto__":"a","normal":"b"}'))))
        .toBe(Object.prototype);
      expect(Object.getPrototypeOf(maskPluginConfigJson(fromJson('{"__proto__":"a","normal":"b"}'), null)))
        .toBe(Object.prototype);
      expect(Object.getPrototypeOf(redactSecretValuesDeep(fromJson('{"__proto__":"a","normal":"b"}'), ["s3cr3t"])))
        .toBe(Object.prototype);
      expect(
        Object.getPrototypeOf(
          restoreRedactedAdapterValue(fromJson('{"__proto__":"x","keep":"new"}'), { keep: "old" }),
        ),
      ).toBe(Object.prototype);
    });
  });

  /**
   * The READ half of the same hazard, and it needs its own remedy (PEN-4240).
   *
   * Once an incoming `__proto__` key SURVIVES the write-side fix above, a bare
   * `existingRecord[key]` lookup resolves it up the chain to `Object.prototype` — which is not
   * `undefined`, so the "was anything stored here?" guard reads it as "yes" and restores a
   * WITHHELD sentinel to `Object.prototype`, which persists as `{}`.
   *
   * This test fails on a source that fixes only the write side, which is why it is here: the
   * write-side fix is what makes it reachable.
   */
  it("does not restore a withheld `__proto__` value out of `Object.prototype`", () => {
    // Raw JSON text so `__proto__` lands as an own key, with the sentinel interpolated from
    // the constant rather than spelled out, so a change to it cannot silently un-reach this.
    const incoming = fromJson(
      `{"__proto__":"${REDACTED_EVENT_VALUE}","keep":"${REDACTED_EVENT_VALUE}"}`,
    );

    // Nothing was ever stored under `__proto__`; `keep` was.
    const restored = restoreRedactedAdapterValue(incoming, { keep: "real" }) as Record<
      string,
      unknown
    >;

    // Reach control: the sibling proves the walk ran and the sentinel path was taken.
    expect(restored.keep).toBe("real");
    // The withheld key has no stored value, so it must be OMITTED outright — not "restored"
    // to the prototype object, which is what a bare `existingRecord["__proto__"]` yields.
    expect(Object.keys(restored)).not.toContain("__proto__");
    expect(JSON.parse(JSON.stringify(restored))).toEqual({ keep: "real" });
  });
});
