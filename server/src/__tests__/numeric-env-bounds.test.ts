import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_TIMER_DELAY_MS,
  NUMERIC_SETTING_BOUNDS,
  TIMER_SETTING_MS_FACTOR,
  loadConfig,
  resetNumericSettingWarnings,
  resolveNumericSetting,
} from "../config.js";

/**
 * BLO-27641. `Math.max(FLOOR, Number(process.env.X) || DEFAULT)` is not the
 * double guard it looks like: `Number("Infinity")` is truthy so `|| DEFAULT`
 * never fires, and `Math.max(FLOOR, Infinity)` is `Infinity`. Every numeric
 * env override in `config.ts` used that idiom.
 *
 * These tests are written to bite in both directions, because a finiteness
 * check alone is insufficient for the timer settings: any delay above
 * `2 ** 31 - 1` ms coerces to 1 ms, which a *finite* 27.7-day value reaches.
 */

/** Config field -> the env var that overrides it. */
const SETTINGS = {
  databaseBackupIntervalMinutes: "PAPERCLIP_DB_BACKUP_INTERVAL_MINUTES",
  databaseBackupRetentionDays: "PAPERCLIP_DB_BACKUP_RETENTION_DAYS",
  prReconcilerIntervalMinutes: "PAPERCLIP_PR_RECONCILER_INTERVAL_MINUTES",
  prReconcilerWindowDays: "PAPERCLIP_PR_RECONCILER_WINDOW_DAYS",
  strandedBlockedIssueReconcilerIntervalMinutes:
    "PAPERCLIP_STRANDED_BLOCKED_ISSUE_RECONCILER_INTERVAL_MINUTES",
  // Added by the ratchet below, not by the original survey: this site landed on
  // master in e73698f7 (2026-08-20), after the eight-site sweep, and reached this
  // branch through a rebase. The `config.ts` offender list going red is what
  // surfaced it — the first live proof the guard bites on a real regression.
  approvalGateReconcilerIntervalMinutes: "PAPERCLIP_APPROVAL_GATE_RECONCILER_INTERVAL_MINUTES",
  heartbeatSchedulerIntervalMs: "HEARTBEAT_SCHEDULER_INTERVAL_MS",
  recoveryActionMaxAttempts: "RECOVERY_ACTION_MAX_ATTEMPTS",
  recoveryActionTimeoutMs: "RECOVERY_ACTION_TIMEOUT_MS",
} as const satisfies Record<keyof typeof NUMERIC_SETTING_BOUNDS, string>;

type SettingKey = keyof typeof SETTINGS;
const SETTING_KEYS = Object.keys(SETTINGS) as SettingKey[];

/**
 * Every input an operator could plausibly get wrong.
 *  - `Infinity` / `+Infinity` / `1e999`: truthy and non-finite — the hole itself.
 *    `1e999` matters separately because it looks finite in a values file.
 *  - `1e308`: finite, so a `Number.isFinite` check alone passes it. Not a bound.
 *  - `40000`: finite AND plausible (minutes/ms confusion) AND still overflows a
 *    32-bit timer at 27.7 days. This is the case a finiteness check misses.
 *  - `-Infinity` / `abc` / `""` / `0` / `-1`: already-invalid input that must
 *    not become a bound either.
 */
const HOSTILE_INPUTS = [
  "Infinity",
  "+Infinity",
  "-Infinity",
  "1e999",
  "1e308",
  "40000",
  "abc",
  "",
  "0",
  "-1",
] as const;

/** Settings whose value comes only from env, so the fallback is unambiguous. */
const ENV_ONLY_SETTINGS = SETTING_KEYS.filter(
  (key) =>
    key !== "databaseBackupIntervalMinutes" && key !== "databaseBackupRetentionDays",
);

describe("numeric env override bounds (BLO-27641)", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    for (const envVar of Object.values(SETTINGS)) delete process.env[envVar];
    process.env.PAPERCLIP_PUBLIC_URL = "http://localhost:3100";
    process.env.PAPERCLIP_DEPLOYMENT_MODE = "authenticated";
    process.env.PAPERCLIP_DEPLOYMENT_EXPOSURE = "private";
    process.env.PAPERCLIP_AUTH_BASE_URL_MODE = "explicit";
    // Feeding hostile input is the point of this suite, so the resulting
    // reject/clamp warnings are expected. Silence them here — they are asserted
    // on their own terms in "resolveNumericSetting reports adjustments" below.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    resetNumericSettingWarnings();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
    resetNumericSettingWarnings();
  });

  describe.each(SETTING_KEYS)("%s", (key) => {
    const envVar = SETTINGS[key];
    const bounds = NUMERIC_SETTING_BOUNDS[key];

    it.each(HOSTILE_INPUTS)(`stays a finite in-range bound for %o`, (input) => {
      process.env[envVar] = input;
      const value = loadConfig()[key];

      // The core AC: no string input can make this non-finite.
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(bounds.min);
      expect(value).toBeLessThanOrEqual(bounds.max);
    });

    it("still honours a valid override unchanged", () => {
      // Midpoint of the legal range, so this is a real override rather than
      // something a clamp could produce by accident.
      const valid = Math.floor((bounds.min + bounds.max) / 2);
      process.env[envVar] = String(valid);
      expect(loadConfig()[key]).toBe(valid);
    });
  });

  it("falls back to the documented default rather than clamping to the ceiling", () => {
    // AC: operator intent stays legible. `Infinity` must not read as "the
    // operator asked for the maximum" in the startup banner.
    for (const key of ENV_ONLY_SETTINGS) {
      process.env[SETTINGS[key]] = "Infinity";
      const bounds = NUMERIC_SETTING_BOUNDS[key];
      expect(loadConfig()[key]).toBe(bounds.fallback);
      expect(loadConfig()[key]).not.toBe(bounds.max);
      delete process.env[SETTINGS[key]];
    }
  });

  it("resolves to the documented default when the override is unset", () => {
    // Guards the robustness fix against becoming a retune.
    const config = loadConfig();
    for (const key of ENV_ONLY_SETTINGS) {
      expect(config[key]).toBe(NUMERIC_SETTING_BOUNDS[key].fallback);
    }
  });
});

describe("timer periods cannot overflow a 32-bit delay (BLO-27641)", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    for (const envVar of Object.values(SETTINGS)) delete process.env[envVar];
    process.env.PAPERCLIP_PUBLIC_URL = "http://localhost:3100";
    process.env.PAPERCLIP_DEPLOYMENT_MODE = "authenticated";
    process.env.PAPERCLIP_DEPLOYMENT_EXPOSURE = "private";
    process.env.PAPERCLIP_AUTH_BASE_URL_MODE = "explicit";
    // Same reason as the suite above: this block drives every hostile input
    // through loadConfig(), so the reject/clamp warnings are expected output
    // rather than signal. Silence them so a real one stays visible.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    resetNumericSettingWarnings();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
    resetNumericSettingWarnings();
  });

  const timerKeys = Object.keys(TIMER_SETTING_MS_FACTOR) as (keyof typeof TIMER_SETTING_MS_FACTOR)[];

  it.each(Object.entries(NUMERIC_SETTING_BOUNDS))(
    "%s declares min <= fallback <= max",
    (_key, bounds) => {
      // The only table error that can change a *resolved value* rather than
      // just a message: `resolveNumericSetting` clamps the fallback too, so a
      // mis-declared default does not throw — it silently resolves to a bound.
      // The "resolves to the documented default" test would catch it, but only
      // for ENV_ONLY_SETTINGS, which deliberately excludes the two settings a
      // config file can also supply. This covers all eight.
      expect(bounds.min).toBeLessThanOrEqual(bounds.fallback);
      expect(bounds.fallback).toBeLessThanOrEqual(bounds.max);
    },
  );

  it("declares a millisecond factor for every setting named like a timer period", () => {
    // TIMER_SETTING_MS_FACTOR is a Partial<>, and the overflow assertion above
    // iterates *its* keys — so a new timer setting added to the bounds table and
    // passed to setInterval, but not added here, is invisible to that invariant
    // and both guards still report green. Heuristic on the naming convention all
    // four current timers follow, which is weaker than a type but is the only
    // thing that can fail when the omission happens.
    const timerLike = Object.keys(NUMERIC_SETTING_BOUNDS).filter((key) =>
      /IntervalM(inutes|s)$/.test(key),
    );
    expect(timerLike.length).toBeGreaterThan(0);
    for (const key of timerLike) {
      expect(
        Object.hasOwn(TIMER_SETTING_MS_FACTOR, key),
        `${key} looks like a timer period but has no TIMER_SETTING_MS_FACTOR entry, so the ` +
          `overflow ceiling is never asserted for it. Add the ms factor (or rename it if it ` +
          `is not a delay).`,
      ).toBe(true);
    }
  });

  it.each(timerKeys)("%s ceiling is itself under the overflow threshold", (key) => {
    // Static check on the declared table: the minute-denominated ceilings are
    // not in the timer's unit, so "10080" being small says nothing on its own.
    const bounds = NUMERIC_SETTING_BOUNDS[key];
    expect(bounds.max * TIMER_SETTING_MS_FACTOR[key]).toBeLessThanOrEqual(MAX_TIMER_DELAY_MS);
  });

  describe.each(timerKeys)("%s", (key) => {
    it.each(HOSTILE_INPUTS)("delay stays a real period for %o", (input) => {
      process.env[SETTINGS[key]] = input;
      const delayMs = loadConfig()[key] * TIMER_SETTING_MS_FACTOR[key];

      // Above this Node emits TimeoutOverflowWarning and sets the duration to
      // 1ms — a hot loop, not "never". `Number.isFinite` alone passes "40000".
      expect(delayMs).toBeLessThanOrEqual(MAX_TIMER_DELAY_MS);
      expect(delayMs).toBeGreaterThan(1);
    });
  });
});

describe("resolveNumericSetting", () => {
  const bounds = { fallback: 60, min: 1, max: 100 };

  it("prefers the first usable candidate, preserving the old || chain", () => {
    // An unusable env value must still defer to a configured file value rather
    // than jumping straight to the default.
    expect(resolveNumericSetting(["Infinity", 42], bounds)).toBe(42);
    expect(resolveNumericSetting(["abc", 42], bounds)).toBe(42);
    expect(resolveNumericSetting([undefined, 42], bounds)).toBe(42);
    expect(resolveNumericSetting(["", 42], bounds)).toBe(42);
    expect(resolveNumericSetting(["7", 42], bounds)).toBe(7);
  });

  it("clamps a usable candidate into range", () => {
    expect(resolveNumericSetting(["1000"], bounds)).toBe(100);
    expect(resolveNumericSetting(["0.5"], bounds)).toBe(1);
  });

  it("rejects non-finite and non-positive candidates", () => {
    for (const bad of ["Infinity", "+Infinity", "-Infinity", "1e999", "abc", "0", "-1", ""]) {
      expect(resolveNumericSetting([bad], bounds)).toBe(60);
    }
    // JSON.parse yields Infinity for an overflowing literal, so a config file
    // can carry a non-finite number even though JSON has no Infinity token.
    expect(resolveNumericSetting([JSON.parse("1e999") as number], bounds)).toBe(60);
  });

  it("clamps the fallback too, so a bad default cannot escape the bounds", () => {
    expect(resolveNumericSetting([], { fallback: 1e309, min: 1, max: 100 })).toBe(100);
  });
});

/**
 * A clamp of a *finite* override is the one adjustment that produces no signal
 * on its own: the startup banner prints the post-clamp number, so
 * `PAPERCLIP_DB_BACKUP_RETENTION_DAYS=7300` and `=3650` are indistinguishable
 * once resolved — and the first of those silently shortens retention. The
 * warning is what makes the adjustment visible to the operator who caused it.
 */
describe("resolveNumericSetting reports adjustments (BLO-27641)", () => {
  const bounds = { fallback: 60, min: 10, max: 100 };

  /** Fresh spy + fresh dedupe state, so each case counts only its own output. */
  function captureWarnings() {
    resetNumericSettingWarnings();
    return vi.spyOn(console, "warn").mockImplementation(() => {});
  }

  afterEach(() => {
    vi.restoreAllMocks();
    resetNumericSettingWarnings();
  });

  it("warns when a finite override is clamped, naming both values", () => {
    const warn = captureWarnings();
    expect(resolveNumericSetting(["730"], bounds, "prReconcilerWindowDays")).toBe(100);
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain("prReconcilerWindowDays");
    expect(message).toContain("730");
    expect(message).toContain("100");
  });

  it("warns when an override is rejected as unusable", () => {
    const warn = captureWarnings();
    expect(resolveNumericSetting(["Infinity"], bounds, "recoveryActionTimeoutMs")).toBe(60);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("Infinity");
  });

  it("names a non-finite *number* candidate rather than rendering it as null", () => {
    // The string "Infinity" above is the variant that always worked. This is
    // the one that did not: `JSON.stringify(Infinity)` is the string `null`, so
    // the branch that exists to report a non-finite override was the one branch
    // unable to name it — telling the operator to look for a literal `null`
    // that is not in their file. Reachable from the config-file source, which
    // is exactly where the operator has the least other signal about the key.
    const warn = captureWarnings();
    const fromConfigFile = JSON.parse("1e999") as number;
    expect(fromConfigFile).toBe(Infinity);
    expect(resolveNumericSetting([fromConfigFile], bounds, "databaseBackupIntervalMinutes")).toBe(
      60,
    );
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain("Infinity");
    expect(message).not.toContain("null");
  });

  it("still quotes a string candidate, so a bad string stays distinct from a number", () => {
    // The fix must not flatten the two sources together: quoting is the only
    // thing that says whether the bad value came from an env var or a JSON number.
    const warn = captureWarnings();
    expect(resolveNumericSetting(["abc"], bounds, "prReconcilerWindowDays")).toBe(60);
    expect(String(warn.mock.calls[0]?.[0])).toContain('"abc"');
  });

  it("stays silent when the override is honoured verbatim, or absent", () => {
    const warn = captureWarnings();
    expect(resolveNumericSetting(["50"], bounds, "heartbeatSchedulerIntervalMs")).toBe(50);
    // No candidate supplied is the default case, not operator error.
    expect(resolveNumericSetting([undefined, ""], bounds, "heartbeatSchedulerIntervalMs")).toBe(60);
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns once per setting, not once per loadConfig() call", () => {
    const warn = captureWarnings();
    for (let i = 0; i < 5; i++) {
      resolveNumericSetting(["730"], bounds, "prReconcilerWindowDays");
    }
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("stays silent when no setting name is supplied", () => {
    const warn = captureWarnings();
    expect(resolveNumericSetting(["730"], bounds)).toBe(100);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("the bare idiom cannot be reintroduced (BLO-27641)", () => {
  /**
   * Automates the manual grep from the BLO-27641 acceptance criteria.
   *
   * Without this, the fix is a one-time cleanup of a class that keeps being
   * re-added: at the time of writing two in-flight PRs each introduce a *new*
   * reconciler interval using the same idiom (#1375, #1309). A guard turns the
   * cleanup into an invariant, and points the next author at the helper.
   */
  /**
   * Matches the *coercion*, not any particular spelling of the fallback around
   * it, because every shape below resolves `"Infinity"` to `Infinity`:
   *
   *  - **fallback outside the call** — `Number(process.env.X) || D`,
   *    `parseInt(process.env.X, 10) ?? D`. `Number("Infinity")` is truthy, so
   *    the fallback never fires.
   *  - **fallback inside the call** — `Number(process.env.X ?? "3")`. The
   *    default only substitutes for an *unset* var; an explicitly hostile value
   *    is passed straight through to `Number`.
   *  - **no fallback at all** — `Math.max(1, Number(process.env.X))`, or a bare
   *    `Number(process.env.X)`. `Math.max(1, Number("Infinity"))` is `Infinity`:
   *    the identical defect, one token *shorter* than the form the acceptance
   *    criteria grep for. Dropping `|| D` while keeping the floor is a plausible
   *    edit on any of the eight call sites this ticket just fixed, so requiring
   *    a fallback operator would leave the guard blind to the likeliest
   *    regression.
   *
   * The inside form is not hypothetical: it is the spelling live in
   * `services/k8s-job-liveness.ts` today (see SCANNED_SOURCES below for the
   * exact set), which makes it the variant the next author is most likely to
   * reach for.
   *
   * The cost of matching the fallback-free shape is that a deliberate
   * `Number(process.env.X)` one-off now needs an allowlist entry. That is the
   * right default: there is no safe bare coercion of an env var to a bound or a
   * delay, so an exemption should have to state its reasoning.
   */
  const BARE_NUMERIC_ENV_IDIOM =
    /(?:Number|parseInt|parseFloat)\(\s*process\.env(?:\.([A-Z_][A-Z0-9_]*)|\[\s*["'`]([A-Z_][A-Z0-9_]*)["'`]\s*\])/g;

  /**
   * Strip comments so prose describing the idiom does not trip the guard.
   *
   * Trailing comments count. Stripping only *line-leading* `//` (`/^\s*\/\/.*$/gm`)
   * left `const x = 1; // Number(process.env.X) || 5 is the old idiom` matching,
   * which turns CI red for prose — a false positive, and a live authoring hazard
   * in exactly these two files, which discuss the idiom at length.
   *
   * The `[^:]` guard keeps `https://…` in a string literal from swallowing the
   * rest of its line, which would be a false *negative* for any real idiom
   * sharing that line.
   */
  function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  }

  function findBareNumericEnvIdioms(
    source: string,
    allowedEnvVars: ReadonlySet<string> = new Set(),
  ): string[] {
    return [...stripComments(source).matchAll(BARE_NUMERIC_ENV_IDIOM)]
      .map((match) => match[1] ?? match[2])
      .filter((envVar): envVar is string => envVar !== undefined && !allowedEnvVars.has(envVar));
  }

  /**
   * Without these two tables the guard below is unfalsifiable: it asserts only
   * that *today's* `config.ts` is clean, which a regex matching nothing would
   * also satisfy. That is precisely the defect class this ticket exists to kill
   * — a guard that reports green on a case it never evaluated — so the detector
   * is pinned against input it must catch and input it must not.
   */
  it.each([
    ["fallback outside, ||", 'Number(process.env.SOME_VAR) || 5'],
    ["fallback outside, ??", 'Number(process.env.SOME_VAR) ?? 5'],
    ["parseInt", 'parseInt(process.env.SOME_VAR, 10) || 5'],
    ["parseFloat", 'parseFloat(process.env.SOME_VAR) || 1.5'],
    ["bracket access", 'Number(process.env["SOME_VAR"]) || 5'],
    ["fallback inside, ??", 'Number(process.env.SOME_VAR ?? "3")'],
    ["fallback inside, ||", 'Number(process.env.SOME_VAR || "3")'],
    ["bracket + inside ??", 'Number(process.env["SOME_VAR"] ?? "3")'],
    // No fallback operator at all. `Math.max(1, Number("Infinity"))` is
    // `Infinity`, so the floor alone is not a guard — this is the shape the
    // eight fixed call sites collapse to if a later edit drops `|| DEFAULT`.
    ["no fallback, floored", "Math.max(1, Number(process.env.SOME_VAR))"],
    ["no fallback, bare", "const ms = Number(process.env.SOME_VAR);"],
    ["no fallback, bracket", 'const ms = Number(process.env["SOME_VAR"]);'],
  ])("detects the idiom spelled as %s", (_label, snippet) => {
    expect(findBareNumericEnvIdioms(snippet)).toEqual(["SOME_VAR"]);
  });

  it.each([
    ["the helper", "resolveNumericSetting([process.env.SOME_VAR], NUMERIC_SETTING_BOUNDS.x)"],
    ["a boolean read", 'process.env.SOME_VAR === "true"'],
    ["a plain string read", "const raw = process.env.SOME_VAR;"],
    ["prose in a line-leading comment", "// Number(process.env.SOME_VAR) || 5 is the old idiom"],
    // A trailing comment is the form these two files actually use when they
    // discuss the idiom, and it is the one that used to escape the strip.
    [
      "prose in a trailing comment",
      "const x = 1; // Number(process.env.SOME_VAR) || 5 is the old idiom",
    ],
    ["prose in a block comment", "/* Number(process.env.SOME_VAR) || 5 is the old idiom */"],
  ])("does not flag %s", (_label, snippet) => {
    expect(findBareNumericEnvIdioms(snippet)).toEqual([]);
  });

  it("still flags a real idiom sharing a line with a URL literal", () => {
    // The `[^:]` guard in stripComments must not let `//` inside a URL swallow
    // the rest of the line — that would be a false negative, the failure mode
    // that matters more than the false positive it exists to prevent.
    expect(
      findBareNumericEnvIdioms('const u = "https://x.io"; const n = Number(process.env.SOME_VAR);'),
    ).toEqual(["SOME_VAR"]);
  });

  it("applies the per-file allowlist rather than a global one", () => {
    const snippet = "Number(process.env.PORT) || 3100";
    expect(findBareNumericEnvIdioms(snippet, new Set(["PORT"]))).toEqual([]);
    // Same read, a file that does not exempt PORT: still an offender. This is
    // what keeps the exemption attached to the reasoning that justifies it.
    expect(findBareNumericEnvIdioms(snippet)).toEqual(["PORT"]);
  });

  /**
   * The files this guard scans, each with the offenders already live in it.
   *
   * `config.ts` is what BLO-27641 cleans, so its list is empty and must stay
   * empty. `k8s-job-liveness.ts` is deliberately *not* fixed here — that is
   * BLO-28664 — but it is scanned anyway, because a detector that demonstrably
   * catches five live instances while pointed only at a file where it catches
   * zero leaves the class unguarded in the one place we know it is live. Listing
   * the known offenders instead of skipping the file makes this a ratchet: a
   * *sixth* instance turns the guard red, and the count is executable rather
   * than a prose number that silently rots (it already had — this list was
   * described as "three sites" when the detector matched five).
   *
   * Both directions are intentional. Fixing a site under BLO-28664 also turns
   * this red, which is the prompt to delete it from the list.
   *
   * `allowedEnvVars` is per-file for the same reason `knownOffenders` is: an
   * exemption is only ever justified by facts about the file it sits in. `PORT`
   * is exempt in `config.ts` because *that file's* two reads both end at
   * `listen()`; the same read elsewhere would carry none of that reasoning. A
   * global allowlist would silently widen as BLO-28664 extends this scan to
   * `server/src/**`.
   */
  const SCANNED_SOURCES: {
    readonly path: string;
    readonly knownOffenders: readonly string[];
    readonly allowedEnvVars: readonly string[];
  }[] = [
    {
      path: "../config.ts",
      knownOffenders: [],
      allowedEnvVars: [
        // Neither a bound nor a timer delay. An unusable port fails loudly at
        // listen() rather than silently disabling a guard or starting a hot
        // loop. PORT is read twice in this file — at the `port` field and again
        // to interpolate `linearOAuthRedirectUri` — but the second site is
        // covered by the first: `PORT=Infinity` builds a nonsense redirect URI
        // and then still dies at bind, so the failure stays loud rather than
        // becoming a silent misconfig.
        "PORT",
      ],
    },
    {
      // Tracked in BLO-28664. All five are the `Number(process.env.X ?? "D")`
      // spelling. Consequences at Infinity, which are not uniform:
      //  - JOB_LIVENESS_TIMEOUT_MS: AbortSignal.timeout() throws RangeError, so
      //    every k8s API call fails — loud, unlike the rest.
      //  - STALE_JOB_DELETE_CONFIRM_ATTEMPTS: `attempt < Infinity` never
      //    terminates, so the "fail closed" delete-confirm budget is absent.
      //  - STALE_JOB_DELETE_CONFIRM_DELAY_MS: a setTimeout delay, so it takes
      //    the 1ms overflow coercion — which with the unbounded attempts above
      //    is a hot loop against the k8s API, not a slow retry.
      //  - FAILURE_LOG_TAIL_LINES / _MAX_BYTES: `length > Infinity` is always
      //    false, so the transcript is never truncated.
      path: "../services/k8s-job-liveness.ts",
      knownOffenders: [
        "PAPERCLIP_K8S_JOB_LIVENESS_TIMEOUT_MS",
        "PAPERCLIP_K8S_STALE_JOB_DELETE_CONFIRM_ATTEMPTS",
        "PAPERCLIP_K8S_STALE_JOB_DELETE_CONFIRM_DELAY_MS",
        "PAPERCLIP_K8S_FAILURE_LOG_TAIL_LINES",
        "PAPERCLIP_K8S_FAILURE_LOG_TAIL_MAX_BYTES",
      ],
      // No read in this file has a reason to be exempt.
      allowedEnvVars: [],
    },
  ];

  it.each(SCANNED_SOURCES)("$path has exactly its known numeric-env offenders", async (entry) => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(new URL(entry.path, import.meta.url), "utf8");
    const offenders = findBareNumericEnvIdioms(source, new Set(entry.allowedEnvVars));

    expect(
      [...offenders].sort(),
      `${entry.path}: expected exactly [${entry.knownOffenders.join(", ")}] but found ` +
        `[${offenders.join(", ")}]. A NEW name here coerces an env var with ` +
        `Number()/parseInt()/parseFloat(), which resolves to Infinity for ` +
        `"Infinity"/"1e999" and overflows a 32-bit timer for any value above ` +
        `${MAX_TIMER_DELAY_MS}ms. Neither a \`|| DEFAULT\` fallback nor a ` +
        `\`Math.max(FLOOR, …)\` floor prevents either — use resolveNumericSetting() with an ` +
        `entry in NUMERIC_SETTING_BOUNDS instead (and TIMER_SETTING_MS_FACTOR if it is a ` +
        `timer). A MISSING name means you fixed one under BLO-28664: delete it from ` +
        `knownOffenders.`,
    ).toEqual([...entry.knownOffenders].sort());
  });
});
