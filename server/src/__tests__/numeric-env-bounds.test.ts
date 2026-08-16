import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_TIMER_DELAY_MS,
  NUMERIC_SETTING_BOUNDS,
  TIMER_SETTING_MS_FACTOR,
  loadConfig,
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
  });

  afterEach(() => {
    process.env = { ...originalEnv };
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
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  const timerKeys = Object.keys(TIMER_SETTING_MS_FACTOR) as (keyof typeof TIMER_SETTING_MS_FACTOR)[];

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

describe("the bare idiom cannot be reintroduced into config.ts (BLO-27641)", () => {
  /**
   * Automates the manual grep from the BLO-27641 acceptance criteria.
   *
   * Without this, the fix is a one-time cleanup of a class that keeps being
   * re-added: at the time of writing two in-flight PRs each introduce a *new*
   * reconciler interval using the same idiom (#1375, #1309). A guard turns the
   * cleanup into an invariant, and points the next author at the helper.
   */
  const ALLOWED_ENV_VARS = new Set([
    // Neither a bound nor a timer delay. An unusable port fails loudly at
    // listen() rather than silently disabling a guard or starting a hot loop.
    "PORT",
  ]);

  it("has no unguarded `Number(process.env.X) ||` outside the allowlist", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(new URL("../config.ts", import.meta.url), "utf8");

    // Strip comments so prose describing the idiom does not trip the guard.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

    const offenders = [...code.matchAll(/Number\(process\.env\.([A-Z_][A-Z0-9_]*)\)\s*\|\|/g)]
      .map((match) => match[1])
      .filter((envVar) => !ALLOWED_ENV_VARS.has(envVar));

    expect(
      offenders,
      `${offenders.join(", ")} use \`Number(process.env.X) || DEFAULT\`, which resolves ` +
        `to Infinity for "Infinity"/"1e999" and overflows a 32-bit timer for any value ` +
        `above ${MAX_TIMER_DELAY_MS}ms. Use resolveNumericSetting() with an entry in ` +
        `NUMERIC_SETTING_BOUNDS instead (and TIMER_SETTING_MS_FACTOR if it is a timer).`,
    ).toEqual([]);
  });
});
