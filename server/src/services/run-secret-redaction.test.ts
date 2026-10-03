import { describe, expect, it } from "vitest";
import { sanitizeRunLogChunkForStorage } from "./log-chunk-sanitizer.js";
import {
  RUN_SECRET_MASK,
  buildRunSecretRedactionPlan,
  isRedactableSecretValue,
} from "./run-secret-redaction.js";

/**
 * BLO-39715 — run-scoped secret VALUE redaction on transcript egress.
 *
 * Every fixture below is INVENTED. None is a real credential, and none was copied out of a
 * transcript, a log, or a cluster.
 *
 * These fixtures are deliberately chosen to be invisible to the existing scrub: the run-log
 * sanitizer is overwhelmingly name-anchored, so a bare high-entropy value with no
 * secret-shaped carrier beside it survives it. That is the gap this control closes, and it is
 * why each mechanism below presents the value WITHOUT a `KEY=` style carrier wherever the
 * real-world disclosure did the same.
 */

const NO_CURRENT_USER_REDACTION = { enabled: false } as const;

/** 24 chars, 4 character classes — unconditionally redactable, and name-anchor-invisible. */
const SECRET = "Kf9!xQm2vTz7-Rb4Lw8pNc6D";

const PLAN = buildRunSecretRedactionPlan({ TO_DB_PASS: SECRET }, ["TO_DB_PASS"]);

function sanitize(chunk: string) {
  return sanitizeRunLogChunkForStorage(chunk, NO_CURRENT_USER_REDACTION, undefined, PLAN.needles);
}

describe("BLO-39715: mechanism independence", () => {
  /**
   * The three routes in this issue's own table. An input-side guard has to enumerate every
   * way a byte reaches stdout; these are three that it demonstrably did not, each by a
   * different mechanism. Value-anchored redaction needs no such enumeration, so all three
   * must fall to the same single control.
   */

  it("(a) redacts a value echoed from an env var", () => {
    const sanitized = sanitize(`$ echo "$TO_DB_PASS"\n${SECRET}\n`);

    expect(sanitized).not.toContain(SECRET);
    expect(sanitized).toContain(RUN_SECRET_MASK);
  });

  it("(b) redacts a value read out of a projected Secret file", () => {
    // The 2026-10-02 disclosure: the guard blocked `env | grep`, so the work moved to a file
    // read — a surface the guard does not inspect at all.
    const sanitized = sanitize(`$ cat /var/run/secrets/envdir/TO_DB_PASS\n${SECRET}`);

    expect(sanitized).not.toContain(SECRET);
  });

  it("(c) redacts a value embedded mid-string inside a libpq DSN", () => {
    // The value is an argument here, not a dump — the 2026-10-03 shape.
    const sanitized = sanitize(
      `psql "host=db.internal port=5432 user=traffic_ops password=${SECRET} dbname=to" -c 'select 1'`,
    );

    expect(sanitized).not.toContain(SECRET);
    // The surrounding connection string must survive: a transcript that loses its context is
    // not a debugging artifact, which is the whole reason this control has a threshold.
    expect(sanitized).toContain("host=db.internal");
    expect(sanitized).toContain("dbname=to");
  });

  it("redacts the JSON-escaped form, because agent stdout is itself stream-JSON", () => {
    // A secret containing a quote or backslash reaches the chunk already escaped. A literal
    // match on the plaintext misses it SILENTLY — the same failure shape as the 2026-08-06
    // `sed` mask that was keyed on the wrong variable name.
    const quoted = 'Ab3"cD4\\eF5!gH6?jK7#mN8';
    const plan = buildRunSecretRedactionPlan({ PGPASSWORD: quoted }, ["PGPASSWORD"]);
    const escaped = JSON.stringify(quoted).slice(1, -1);

    expect(escaped).not.toEqual(quoted); // guard: the fixture must actually exercise escaping

    const chunk = `{"type":"tool_result","content":"connected with ${escaped}"}`;
    const sanitized = sanitizeRunLogChunkForStorage(
      chunk,
      NO_CURRENT_USER_REDACTION,
      undefined,
      plan.needles,
    );

    expect(sanitized).not.toContain(escaped);
  });
});

describe("BLO-39715: the threshold, and what it declines to cover", () => {
  it("redacts any value at or above 16 chars whatever its shape", () => {
    expect(isRedactableSecretValue("abcdefghijklmnop")).toBe(true); // 16, one class
  });

  it("redacts a realistic mixed-class password in the ambiguous band", () => {
    expect(isRedactableSecretValue("Tr0ub4dor&3")).toBe(true); // 11, 4 classes
  });

  it("spares ordinary single-class tokens that collide with transcript vocabulary", () => {
    // Redacting every occurrence of these would not make a transcript safer, it would make it
    // unreadable — and an unreadable transcript gets replaced by some channel with no
    // redaction at all.
    for (const ordinary of ["postgres", "localhost", "password"]) {
      expect(isRedactableSecretValue(ordinary)).toBe(false);
    }
  });

  it("never redacts below 8 chars", () => {
    expect(isRedactableSecretValue("true")).toBe(false);
    expect(isRedactableSecretValue("Ab3!")).toBe(false);
  });

  it("reports every uncovered value by KEY NAME and never leaks the value itself", () => {
    // This is what stops the control being trivially defeated by choosing a short secret: the
    // gap becomes a visible, attributable finding fixed by rotation, not an invisible hole.
    const plan = buildRunSecretRedactionPlan(
      { SHORT_PASS: "abc", PG_USER: "postgres", REAL_TOKEN: SECRET },
      ["SHORT_PASS", "PG_USER", "REAL_TOKEN"],
    );

    expect(plan.uncoveredKeys).toEqual(["PG_USER", "SHORT_PASS"]);
    expect(plan.needles).toContain(SECRET);
    expect(JSON.stringify(plan.uncoveredKeys)).not.toContain("abc");
    expect(JSON.stringify(plan.uncoveredKeys)).not.toContain("postgres");
  });

  it("orders needles longest-first so a secret that is a prefix of another is not half-exposed", () => {
    const shortSecret = "Qw3!rTy9Zx2@Vb5";
    const longSecret = `${shortSecret}Nm8$Kp1`;
    const plan = buildRunSecretRedactionPlan(
      { A_TOKEN: shortSecret, B_TOKEN: longSecret },
      ["A_TOKEN", "B_TOKEN"],
    );

    expect(plan.needles[0]).toEqual(longSecret);

    const sanitized = sanitizeRunLogChunkForStorage(
      `value=${longSecret}`,
      NO_CURRENT_USER_REDACTION,
      undefined,
      plan.needles,
    );
    expect(sanitized).not.toContain(shortSecret);
  });
});

describe("BLO-39715: the control is inert when it has nothing to do", () => {
  it("leaves output untouched when the run has no resolved secrets", () => {
    const chunk = "the deploy then failed because the node was cordoned";
    expect(sanitizeRunLogChunkForStorage(chunk, NO_CURRENT_USER_REDACTION, undefined, [])).toEqual(
      chunk,
    );
  });

  it("does not mangle a transcript that merely resembles a secret", () => {
    const chunk = "retrying with backoff=true user=postgres host=localhost";
    expect(sanitize(chunk)).toEqual(chunk);
  });
});
