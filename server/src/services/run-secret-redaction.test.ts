import { describe, expect, it } from "vitest";
import { MAX_PERSISTED_LOG_CHUNK_CHARS, sanitizeRunLogChunkForStorage } from "./log-chunk-sanitizer.js";
import {
  RUN_SECRET_CARRY_MAX_HOLD_CHARS,
  ALWAYS_REDACT_MIN_LENGTH,
  RUN_REDACTION_CANARY_ENV_KEY,
  RUN_SECRET_MASK,
  buildRunSecretRedactionPlan,
  createRunRedactionCanaryValue,
  createRunSecretBoundaryCarry,
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

const PLAN = buildRunSecretRedactionPlan({ env: { TO_DB_PASS: SECRET } }, ["TO_DB_PASS"]);

function sanitize(chunk: string) {
  return sanitizeRunLogChunkForStorage(chunk, NO_CURRENT_USER_REDACTION, PLAN.needles);
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
    const plan = buildRunSecretRedactionPlan({ env: { PGPASSWORD: quoted } }, ["PGPASSWORD"]);
    const escaped = JSON.stringify(quoted).slice(1, -1);

    expect(escaped).not.toEqual(quoted); // guard: the fixture must actually exercise escaping

    const chunk = `{"type":"tool_result","content":"connected with ${escaped}"}`;
    const sanitized = sanitizeRunLogChunkForStorage(
      chunk,
      NO_CURRENT_USER_REDACTION,
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

  it("spares a separator-bearing identifier in the band, which `-`/`_`-as-symbol would redact", () => {
    // The negative case the band's two-class discriminator was missing: every other spared
    // value here is single-class on length alone, so they pass whatever the symbol class is.
    // These are in the 8-15 band and are only spared because `_` and `-` do not count — they
    // are transcript vocabulary (a DB user, a cluster name) exactly as `postgres` is.
    for (const identifier of ["traffic_ops", "blockcast-prod", "paperclip_api"]) {
      expect(identifier.length).toBeGreaterThanOrEqual(8);
      expect(identifier.length).toBeLessThan(16);
      expect(isRedactableSecretValue(identifier)).toBe(false);
    }
    // ...without sparing a real password of the same length and band.
    expect(isRedactableSecretValue("Tr0ub4dor&3")).toBe(true);
  });

  it("never redacts below 8 chars", () => {
    expect(isRedactableSecretValue("true")).toBe(false);
    expect(isRedactableSecretValue("Ab3!")).toBe(false);
  });

  it("reports every uncovered value by KEY NAME and never leaks the value itself", () => {
    // This is what stops the control being trivially defeated by choosing a short secret: the
    // gap becomes a visible, attributable finding fixed by rotation, not an invisible hole.
    const plan = buildRunSecretRedactionPlan(
      { env: { SHORT_PASS: "abc", PG_USER: "postgres", REAL_TOKEN: SECRET } },
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
      { env: { A_TOKEN: shortSecret, B_TOKEN: longSecret } },
      ["A_TOKEN", "B_TOKEN"],
    );

    // Assert the INVARIANT, not a literal position: encoding variants are longer than their
    // plaintext and legitimately sort ahead of it, so pinning `needles[0]` would pin an
    // implementation detail. What must hold is that the longer plaintext is replaced before
    // the shorter one it contains.
    expect(plan.needles.indexOf(longSecret)).toBeLessThan(plan.needles.indexOf(shortSecret));
    expect(plan.needles).toEqual([...plan.needles].sort((a, b) => b.length - a.length));

    const sanitized = sanitizeRunLogChunkForStorage(
      `value=${longSecret}`,
      NO_CURRENT_USER_REDACTION,
      plan.needles,
    );
    expect(sanitized).not.toContain(shortSecret);
  });
});

describe("BLO-39715: the control is inert when it has nothing to do", () => {
  it("leaves output untouched when the run has no resolved secrets", () => {
    const chunk = "the deploy then failed because the node was cordoned";
    expect(sanitizeRunLogChunkForStorage(chunk, NO_CURRENT_USER_REDACTION, [])).toEqual(
      chunk,
    );
  });

  it("does not mangle a transcript that merely resembles a secret", () => {
    const chunk = "retrying with backoff=true user=postgres host=localhost";
    expect(sanitize(chunk)).toEqual(chunk);
  });
});

describe("BLO-39715: secretKeys is a mixed namespace", () => {
  /**
   * `resolveAdapterConfigForRuntime` puts two different kinds of key into one `Set`:
   * env-binding keys, whose value lands in `resolved.env[key]`, and adapter top-level schema
   * secret fields (`meta.secret === true`, plus `FALLBACK_ADAPTER_SCHEMA_SECRET_FIELDS`),
   * whose value lands in `resolved[key]`. Reading only the env map dropped the second class
   * on BOTH paths — not redacted and not reported — which is the one failure this module's
   * contract forbids outright.
   */

  it("covers an adapter top-level schema secret field, not just env bindings", () => {
    const plan = buildRunSecretRedactionPlan(
      { adapterType: "hermes_gateway", apiKey: SECRET, env: {} },
      ["apiKey"],
    );

    expect(plan.needles).toContain(SECRET);
    expect(plan.uncoveredKeys).toEqual([]);
    expect(plan.unresolvedKeys).toEqual([]);
  });

  it("covers both namespaces in one plan", () => {
    const topLevel = "Zx8@Qw1!Nm4%Vb7Kp0Rt3";
    const plan = buildRunSecretRedactionPlan(
      { apiKey: topLevel, env: { TO_DB_PASS: SECRET } },
      ["apiKey", "TO_DB_PASS"],
    );

    expect(plan.needles).toContain(SECRET);
    expect(plan.needles).toContain(topLevel);
  });

  it("covers BOTH values when one key is shadowed across namespaces", () => {
    // A precedence rule (env wins, or top level wins) would make one of these a needle and
    // leave the other neither redacted nor reported — an invisible hole with no key name to
    // attribute it to, which is exactly what `unresolvedKeys` exists to make impossible.
    const shadowed = "Zx8@Qw1!Nm4%Vb7Kp0Rt3";
    expect(shadowed).not.toEqual(SECRET);
    const plan = buildRunSecretRedactionPlan(
      { TO_DB_PASS: shadowed, env: { TO_DB_PASS: SECRET } },
      ["TO_DB_PASS"],
    );

    expect(plan.needles).toContain(SECRET);
    expect(plan.needles).toContain(shadowed);
    expect(plan.unresolvedKeys).toEqual([]);
  });

  it("REPORTS a secret key whose value is in neither namespace rather than dropping it", () => {
    // "too short to replace literally" and "declared secret but not locatable" are different
    // findings with different remedies — rotate the credential vs fix this module — so they
    // must not share a bucket. Silence here is the shape the whole control exists to refuse.
    const plan = buildRunSecretRedactionPlan({ env: { TO_DB_PASS: SECRET } }, [
      "TO_DB_PASS",
      "MCP_HEADER_TOKEN",
    ]);

    expect(plan.unresolvedKeys).toEqual(["MCP_HEADER_TOKEN"]);
    expect(plan.uncoveredKeys).toEqual([]);
    expect(plan.needles).toContain(SECRET);
  });

  it("does not report an empty value as unresolved — it is located and discloses nothing", () => {
    const plan = buildRunSecretRedactionPlan({ env: { OPTIONAL_TOKEN: "" } }, ["OPTIONAL_TOKEN"]);

    expect(plan.unresolvedKeys).toEqual([]);
    expect(plan.uncoveredKeys).toEqual([]);
    expect(plan.needles).toEqual([]);
  });
});

describe("BLO-39715: encoding variants", () => {
  it("redacts the percent-encoded form where no URI carrier anchors the existing scrub", () => {
    // The sibling of the JSON-escaped case, but scoped honestly. The URI-form DSN
    // (`postgres://user:p%40ss@host`) is NOT the gap: the pre-existing credentialed-URI scrub
    // already replaces that whole userinfo segment with no dictionary at all — asserted below
    // so this stays true if that scrub changes. The residue is the encoded value standing
    // alone, where nothing name-anchored has anything to anchor on.
    const pw = "Ab3@cD4!eF5#gH6$jK7%mN8";
    const encoded = encodeURIComponent(pw);
    const plan = buildRunSecretRedactionPlan({ env: { PGPASSWORD: pw } }, ["PGPASSWORD"]);

    expect(encoded).not.toEqual(pw); // guard: the fixture must actually exercise encoding
    expect(plan.needles).toContain(encoded);

    // Control: with NO needles the bare encoded value survives the existing scrub entirely,
    // which is what makes the assertion below a test of this change rather than of that one.
    const carrierless = `decoded payload ${encoded} end`;
    expect(
      sanitizeRunLogChunkForStorage(carrierless, NO_CURRENT_USER_REDACTION, []),
    ).toContain(encoded);

    const sanitized = sanitizeRunLogChunkForStorage(
      carrierless,
      NO_CURRENT_USER_REDACTION,
      plan.needles,
    );
    expect(sanitized).not.toContain(encoded);
    expect(sanitized).toContain("decoded payload");
  });

  it("does not throw on a value encodeURIComponent cannot encode", () => {
    // A lone surrogate raises URIError. A malformed secret must not be able to abort run setup.
    const loneSurrogate = `Ab3!cD4\uD800eF5#gH6$jK7`;

    expect(() =>
      buildRunSecretRedactionPlan({ env: { ODD_TOKEN: loneSurrogate } }, ["ODD_TOKEN"]),
    ).not.toThrow();
    expect(
      buildRunSecretRedactionPlan({ env: { ODD_TOKEN: loneSurrogate } }, ["ODD_TOKEN"]).needles,
    ).toContain(loneSurrogate);
  });
});

describe("BLO-39715: chunk-boundary splits", () => {
  /**
   * Run-log chunks are not token-aligned on any adapter path, so a secret can be cut in
   * half by an arbitrary boundary. Before the carry, neither half contained the needle, so
   * neither was redacted and the reassembled transcript held the plaintext — a silent miss
   * that `uncoveredKeys`/`unresolvedKeys` cannot see, because the key resolved fine.
   */
  function drain(carry: ReturnType<typeof createRunSecretBoundaryCarry>, stream: string, chunks: string[]) {
    const out = chunks.map((chunk) => sanitize(carry.take(stream, chunk)));
    out.push(sanitize(carry.take(stream, "", { flush: true })));
    return out.join("");
  }

  it("redacts a secret split across two successive chunks", () => {
    const cut = 10;
    const head = `writing ${SECRET.slice(0, cut)}`;
    const tail = `${SECRET.slice(cut)} to config\n`;

    // The premise: each half alone is invisible to a literal match.
    expect(sanitize(head)).toContain(SECRET.slice(0, cut));
    expect(sanitize(tail)).toContain(SECRET.slice(cut));

    const transcript = drain(createRunSecretBoundaryCarry(PLAN.needles), "stdout", [head, tail]);
    expect(transcript).not.toContain(SECRET);
    expect(transcript).toContain(RUN_SECRET_MASK);
    // The surrounding output is preserved, not eaten by the carry.
    expect(transcript).toContain("writing ");
    expect(transcript).toContain(" to config");
  });

  it("redacts a secret split one character at a time", () => {
    const chunks = [...`prefix ${SECRET} suffix\n`];
    const transcript = drain(createRunSecretBoundaryCarry(PLAN.needles), "stdout", chunks);
    expect(transcript).not.toContain(SECRET);
    expect(transcript).toContain(RUN_SECRET_MASK);
    expect(transcript).toContain("prefix ");
    expect(transcript).toContain("suffix");
  });

  it("does not lose the trailing held-back characters — the flush is required", () => {
    const carry = createRunSecretBoundaryCarry(PLAN.needles);
    expect(carry.holdbackChars).toBe(SECRET.length - 1);

    // Without the flush the tail is still withheld: this is what makes the flush load-bearing
    // rather than tidy-up, and why dropping it would trade a leak for silent truncation.
    const withheld = carry.take("stdout", "trailing-marker\n");
    expect(withheld).not.toContain("trailing-marker");

    expect(carry.take("stdout", "", { flush: true })).toContain("trailing-marker\n");
  });

  it("keeps streams independent so stdout bytes cannot surface in stderr", () => {
    const carry = createRunSecretBoundaryCarry(PLAN.needles);
    carry.take("stdout", "OUT-ONLY");
    expect(carry.take("stderr", "", { flush: true })).toBe("");
    expect(carry.take("stdout", "", { flush: true })).toBe("OUT-ONLY");
  });

  it("leaves a needle split ACROSS streams unmatched rather than joining the streams", () => {
    // Ally (paperclip#2213, Suggestion): the case above proves the carry's keys are separate,
    // not the property the comment claims. Pinned here because the cheap wrong implementation
    // — one shared buffer — would pass that case and silently concatenate two transcripts.
    // Half a secret in each stream is correctly NOT redacted: neither stream ever contains the
    // value, and masking on a cross-stream join would corrupt bytes the other stream owns.
    const carry = createRunSecretBoundaryCarry(PLAN.needles);
    const head = SECRET.slice(0, 12);
    const tail = SECRET.slice(12);

    carry.take("stdout", head);
    carry.take("stderr", tail);
    const out = carry.take("stdout", "", { flush: true });
    const err = carry.take("stderr", "", { flush: true });

    expect(out).toBe(head);
    expect(err).toBe(tail);
    expect(out + err).toBe(SECRET);
  });

  it("emits whole lines only, so per-line classifiers still match what arrived", () => {
    // Ally (paperclip#2213, Critical): the heartbeat excerpt filter and run-liveness anchor
    // per line. Splitting at `len - holdbackChars` emitted every keepalive with its head or
    // tail missing, so none matched and each one reached the useful-output check.
    const lines = [15, 30, 45, 60, 75].map(
      (s) => `[paperclip] keepalive: claude_k8s job ac-x still running (${s}s since last output)\n`,
    );
    const carry = createRunSecretBoundaryCarry(PLAN.needles);
    const emitted = lines.map((line) => carry.take("stdout", line));
    emitted.push(carry.take("stdout", "", { flush: true }));

    expect(carry.holdbackChars).toBeGreaterThan(0);
    expect(emitted.join("")).toBe(lines.join(""));
    const nonEmpty = emitted.filter(Boolean);
    expect(nonEmpty.length).toBeGreaterThan(1);
    for (const out of nonEmpty) {
      for (const line of out.split(/(?<=\n)/)) expect(lines).toContain(line);
    }
  });

  it("holds an unterminated line until its newline is past the window, or the flush", () => {
    const carry = createRunSecretBoundaryCarry(PLAN.needles);
    const longLine = "x".repeat(carry.holdbackChars * 3);
    // No newline yet, so nothing is released even though the window is long full.
    expect(carry.take("stdout", longLine)).toBe("");
    // The newline is released once at least `holdbackChars` follow it.
    const next = "n".repeat(carry.holdbackChars);
    expect(carry.take("stdout", ` done\n${next}`)).toBe(`${longLine} done\n`);
    expect(carry.take("stdout", "", { flush: true })).toBe(next);
  });

  it("bounds the hold when a stream never emits a newline", () => {
    // Ally (paperclip#2213, Important): `\r` progress output has no newline and stderr has no
    // keepalive, so an unbounded line hold kept the whole stream in memory and persisted nothing.
    const carry = createRunSecretBoundaryCarry(PLAN.needles);
    const chunk = `${"x".repeat(200)}\r`;
    const count = Math.ceil((RUN_SECRET_CARRY_MAX_HOLD_CHARS * 3) / chunk.length);
    let emitted = "";
    for (let i = 0; i < count; i += 1) emitted += carry.take("stderr", chunk);
    const held = carry.take("stderr", "", { flush: true });

    expect(emitted.length).toBeGreaterThan(0);
    expect(held.length).toBeLessThanOrEqual(RUN_SECRET_CARRY_MAX_HOLD_CHARS + carry.holdbackChars);
    expect(emitted + held).toBe(chunk.repeat(count));
  });

  it("caps the hold at one persisted chunk", () => {
    expect(RUN_SECRET_CARRY_MAX_HOLD_CHARS).toBe(MAX_PERSISTED_LOG_CHUNK_CHARS);
  });

  it("is an identity function when there is nothing to redact", () => {
    // A run with no secrets must be byte-for-byte unchanged and pay no streaming latency.
    const carry = createRunSecretBoundaryCarry([]);
    expect(carry.holdbackChars).toBe(0);
    expect(carry.take("stdout", "immediate\n")).toBe("immediate\n");
  });

  it("sizes the window off the longest needle regardless of input order", () => {
    // `buildRunSecretRedactionPlan` sorts longest-first, but this helper is exported; an
    // unsorted caller must not silently get a too-short window.
    expect(createRunSecretBoundaryCarry(["ab", "abcdef"]).holdbackChars).toBe(5);
    expect(createRunSecretBoundaryCarry(["abcdef", "ab"]).holdbackChars).toBe(5);
  });
});

describe("per-run redaction canary", () => {
  // The canary exists only so the deployed redactor can be PROVEN live from inside a run.
  // Its format is therefore load-bearing in a way nothing else in this module is: it is the
  // one needle whose value this code chooses, so it is the one that can be silently demoted
  // below the threshold by an edit that looks like tidying up. Pinned here rather than left
  // to inspection.

  it("mints a value the plan accepts as a needle", () => {
    const value = createRunRedactionCanaryValue();
    const plan = buildRunSecretRedactionPlan(
      { env: { [RUN_REDACTION_CANARY_ENV_KEY]: value } },
      [RUN_REDACTION_CANARY_ENV_KEY],
    );
    // All three assertions, not just the first: a value SHORT enough to be rejected lands in
    // `uncoveredKeys` with an empty needle list, which is a quiet pass for any test that only
    // checks `isRedactableSecretValue` in isolation.
    expect(isRedactableSecretValue(value)).toBe(true);
    expect(plan.needles).toContain(value);
    expect(plan.uncoveredKeys).toEqual([]);
    expect(plan.unresolvedKeys).toEqual([]);
    // And in the UNCONDITIONAL band, not merely accepted. Checked because the weaker
    // assertions above do not discriminate: a mutant canary of `canary-1` is 8 chars and
    // two classes, so it clears `isRedactableSecretValue` and every line above still
    // passes — while being short enough to collide with ordinary transcript text and mask
    // it. The probe must never sit in the 8-15 ambiguous band where acceptance depends on
    // which characters a UUID happened to produce.
    expect(value.length).toBeGreaterThanOrEqual(ALWAYS_REDACT_MIN_LENGTH);
  });

  it("is fresh per run", () => {
    // Reused across runs it would be a standing cross-run identifier rather than a probe, and
    // a stale copy quoted in one transcript would mask unrelated text in another.
    expect(createRunRedactionCanaryValue()).not.toBe(createRunRedactionCanaryValue());
  });

  it("is redacted through each of the three observed disclosure mechanisms", () => {
    const value = createRunRedactionCanaryValue();
    const plan = buildRunSecretRedactionPlan(
      { env: { [RUN_REDACTION_CANARY_ENV_KEY]: value } },
      [RUN_REDACTION_CANARY_ENV_KEY],
    );
    const cases = [
      // (a) echoed from an env var, with no secret-shaped carrier beside it.
      `${value}\n`,
      // (b) read out of a projected Secret volume — bare file contents.
      `+ cat /var/run/secrets/envdir/CANARY\n${value}\n`,
      // (c) embedded mid-string inside a libpq DSN. Written in the `key=value` form the
      // fixtures above use rather than as a credentialed connection URI: the egress
      // scanner refuses to publish that shape even when the credential is a template
      // expression, and a suppression would be a worse answer than the shape change.
      `psql "host=db.internal port=5432 user=traffic_ops password=${value} dbname=to"\n`,
    ];
    for (const text of cases) {
      const sanitized = sanitizeRunLogChunkForStorage(
        text,
        NO_CURRENT_USER_REDACTION,
        plan.needles,
      );
      expect(sanitized).not.toContain(value);
      expect(sanitized).toContain(RUN_SECRET_MASK);
    }
  });
});
