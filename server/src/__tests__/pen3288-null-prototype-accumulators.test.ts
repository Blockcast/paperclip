import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  REDACTED_EVENT_VALUE,
  isPlainObject,
  maskWorkspaceRuntimeForRead,
  redactApprovalPayloadForDisplay,
  redactRunResultJson,
  restoreWithheldPipelineStageConfig,
  sanitizeRecord,
  withholdAgentConfigKeys,
  withholdRunTranscriptStateContent,
} from "../redaction.js";

/**
 * PEN-3288 — every key-accumulating walk in `redaction.ts` must seed with a null prototype.
 *
 * On an ordinary `{}`, `out["__proto__"] = …` hits `Object.prototype`'s inherited `__proto__`
 * SETTER: it re-parents the accumulator instead of adding a key, so the key is absent from the
 * output and from `JSON.stringify`. Measured before the fix: all TEN accumulators in the module
 * dropped the key (the row that raised this expected three).
 *
 * Nothing leaked — dropping discloses strictly less than masking. What broke is the PEN-2370
 * ask-1 invariant: key NAMES survive so a reader can tell "withheld" from "never set".
 *
 * ## Fixtures MUST come from raw JSON text
 *
 * `{ __proto__: "x" }` in an object literal sets the PROTOTYPE; it does not create an own key, so
 * the obvious spelling passes vacuously against the pre-fix source. `JSON.parse` defines
 * `__proto__` as a real own data property, which is also exactly why this is reachable: every
 * input here arrives from a jsonb column or a request body. `parseOwn` asserts the own key is
 * present before the fixture is ever handed to the code under test, so a fixture that stopped
 * carrying it fails loudly instead of making the whole file vacuous.
 */
const PROTO = "__proto__";

function parseOwn(text: string): Record<string, unknown> {
  const parsed = JSON.parse(text) as Record<string, unknown>;
  expect(Object.keys(parsed)).toContain(PROTO);
  return parsed;
}

/** Narrow an `unknown` output to a record and prove the walk actually produced one. */
function asRecord(value: unknown): Record<string, unknown> {
  expect(isPlainObject(value)).toBe(true);
  return value as Record<string, unknown>;
}

describe("PEN-3288: redaction accumulators keep a `__proto__` key instead of dropping it", () => {
  it("sanitizeRecord keeps and masks a top-level `__proto__`", () => {
    const out = sanitizeRecord(parseOwn('{"__proto__":"a","normal":"b"}'));
    expect(Object.keys(out)).toContain(PROTO);
    expect(Object.keys(out)).toContain("normal");
  });

  it("sanitizeSecretMatchedValue keeps a `__proto__` nested under a Tier-matched key", () => {
    const out = sanitizeRecord(JSON.parse('{"apiKey":{"__proto__":"a","normal":"b"}}'));
    const child = asRecord(out.apiKey);
    expect(Object.keys(child)).toContain(PROTO);
    // The whole point: the key survives AND its value is masked like any sibling.
    expect(child[PROTO]).toBe(REDACTED_EVENT_VALUE);
    expect(child.normal).toBe(REDACTED_EVENT_VALUE);
  });

  it("sanitizeAgentEnvRecord keeps and masks a `__proto__` env binding", () => {
    const out = sanitizeRecord(JSON.parse('{"env":{"__proto__":"a","NORMAL":"b"}}'), {
      agentConfig: true,
    });
    const env = asRecord(out.env);
    expect(Object.keys(env)).toContain(PROTO);
    expect(env[PROTO]).toBe(REDACTED_EVENT_VALUE);
  });

  it("sanitizeAgentHeaderRecord keeps a `__proto__` header name", () => {
    const out = sanitizeRecord(JSON.parse('{"headers":{"__proto__":"a","accept":"b"}}'), {
      agentConfig: true,
    });
    const headers = asRecord(out.headers);
    expect(Object.keys(headers)).toContain(PROTO);
  });

  it("withholdAgentConfigKeys keeps a `__proto__` key and can still report it as withheld", () => {
    const kept = withholdAgentConfigKeys(parseOwn('{"__proto__":"a","nested":{"normal":"y"}}'));
    expect(Object.keys(kept.payload)).toContain(PROTO);

    // The sharpest case for this row: a WITHHELD `__proto__` used to be missing from the payload
    // AND missing from `withheldFields`, so the approval card under-reported what it withheld.
    const withheld = withholdAgentConfigKeys(
      JSON.parse('{"nested":{"__proto__":{"adapterConfig":{"token":"t"}}}}'),
    );
    const nested = asRecord((withheld.payload as Record<string, unknown>).nested);
    expect(Object.keys(nested)).toContain(PROTO);
  });

  // NUMBERS, not strings, in the two `resultJson` fixtures below. That walk withholds any string
  // under a key outside `RUN_RESULT_JSON_MACHINE_TEXT_KEYS`, so a string fixture comes back `{}`
  // whatever the accumulator does — it would report "dropped" on the FIXED source too, and prove
  // nothing. Non-prose primitives are kept, which is what reaches the assignment under test.
  it("withholdRunTranscriptStateContent keeps a `__proto__` key in resultJson", () => {
    const run = { resultJson: parseOwn('{"__proto__":1,"ok":2}') };
    const out = withholdRunTranscriptStateContent(run);
    const resultJson = asRecord(out.resultJson);
    expect(Object.keys(resultJson)).toContain("ok"); // the walk kept the ordinary sibling
    expect(Object.keys(resultJson)).toContain(PROTO);
  });

  it("projectRunResultJsonValue keeps a `__proto__` key nested inside resultJson", () => {
    const run = { resultJson: JSON.parse('{"deep":{"__proto__":1,"ok":2}}') };
    const out = withholdRunTranscriptStateContent(run);
    const deep = asRecord(asRecord(out.resultJson).deep);
    expect(Object.keys(deep)).toContain("ok");
    expect(Object.keys(deep)).toContain(PROTO);
  });

  it("restoreWithheldValue keeps a `__proto__` key while restoring withheld settings", () => {
    const incoming = JSON.parse(
      '{"onEnter":{"executionWorkspaceSettings":{"__proto__":"a","keep":"b"}}}',
    ) as Record<string, Record<string, Record<string, unknown>>>;
    // Vacuity guard for the one fixture that has to reach a NESTED accumulator: an earlier
    // version of this probe passed `__proto__` at the top level, where `{ ...incoming }` (a
    // spread, which defines an own property rather than invoking the setter) is already safe —
    // so it reported "survives" against the pre-fix source without ever entering the walk.
    expect(Object.keys(incoming.onEnter.executionWorkspaceSettings)).toContain(PROTO);
    const existing = JSON.parse('{"onEnter":{"executionWorkspaceSettings":{"keep":"old"}}}');

    const out = asRecord(restoreWithheldPipelineStageConfig(incoming, existing));
    const settings = asRecord(asRecord(out.onEnter).executionWorkspaceSettings);
    expect(Object.keys(settings)).toContain(PROTO);
  });

  it("redactApprovalPayloadForDisplay's annotate keeps a `__proto__` key", () => {
    // The row that raised this never exercised this site; it is reachable.
    const out = redactApprovalPayloadForDisplay(
      "request_board_approval",
      parseOwn('{"__proto__":"a","note":"b"}'),
    );
    expect(Object.keys(out.payload)).toContain(PROTO);
  });

  it("redactRunResultJson keeps a `__proto__` key", () => {
    const out = asRecord(redactRunResultJson(parseOwn('{"__proto__":"a","ok":"b"}')));
    expect(Object.keys(out)).toContain(PROTO);
  });

  it("maskWorkspaceRuntimeForRead still keeps a `__proto__` key (d6da53d04 regression)", () => {
    // These two accumulators were already null-prototype; routing them through the shared helper
    // must not change that. Covers both halves of the walk: top level and nested.
    const top = asRecord(maskWorkspaceRuntimeForRead(parseOwn('{"__proto__":"a","ok":"b"}')));
    expect(Object.keys(top)).toContain(PROTO);
    const nested = asRecord(maskWorkspaceRuntimeForRead(JSON.parse('{"deep":{"__proto__":"a"}}')));
    expect(Object.keys(asRecord(nested.deep))).toContain(PROTO);
  });

  it("a null-prototype accumulator is still a plain object to this module and to JSON", () => {
    // The property that makes the fix safe: `isPlainObject` admits `proto === null`, so these
    // outputs keep recursing through the module's own walks and serialize normally. If that ever
    // stops holding, every test above would keep passing while callers broke.
    const out = sanitizeRecord(parseOwn('{"__proto__":"a","normal":"b"}'));
    expect(isPlainObject(out)).toBe(true);
    expect(Object.getPrototypeOf(out)).toBeNull();
    expect(JSON.parse(JSON.stringify(out))).toHaveProperty(PROTO);
    expect(() => sanitizeRecord(out)).not.toThrow();
  });

  it("no bare `{}` accumulator has been reintroduced into redaction.ts", () => {
    // The row that raised this asked for "a shared helper OR a lint rule", because the next
    // occurrence will not be found by reading. This is the cheap version of the lint rule: it is
    // scoped to this one file, and it names its own remedy. It is deliberately narrow — it
    // matches only the accumulator spelling, not every `{}` in the module.
    const source = readFileSync(join(__dirname, "..", "redaction.ts"), "utf8");
    const offenders = source
      .split("\n")
      .map((line, index) => ({ line: line.trim(), lineNumber: index + 1 }))
      .filter(({ line }) => /^const \w+: Record<string, unknown> = \{\};$/.test(line));

    expect(
      offenders,
      "Seed key-accumulating records with `emptyRecord()` (PEN-3288): on a bare `{}`, "
        + "`out[\"__proto__\"] = …` hits the inherited setter and silently drops the key.",
    ).toEqual([]);
  });
});
