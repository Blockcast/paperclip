import { describe, expect, it, vi } from "vitest";
import {
  isTransientDbError,
  runWithTransientDbRetry,
  TRANSIENT_DB_SQLSTATES,
} from "../lib/db-retry.js";

const pgError = (code: string): Error & { code: string } =>
  Object.assign(new Error(`pg error ${code}`), { code });

// Deterministic backoff: zero-wait sleep + fixed random so delay math is exact.
const noWait = () => Promise.resolve();
const noJitter = () => 0;

describe("isTransientDbError", () => {
  it("recognizes each transient SQLSTATE", () => {
    for (const code of TRANSIENT_DB_SQLSTATES) {
      expect(isTransientDbError(pgError(code))).toBe(true);
    }
  });

  it("rejects non-transient errors and non-errors", () => {
    expect(isTransientDbError(pgError("23505"))).toBe(false); // unique_violation
    expect(isTransientDbError(new Error("no code"))).toBe(false);
    expect(isTransientDbError(null)).toBe(false);
    expect(isTransientDbError(undefined)).toBe(false);
    expect(isTransientDbError({ code: 40001 })).toBe(false); // numeric, not string
  });
});

describe("runWithTransientDbRetry", () => {
  it("returns immediately when fn succeeds on the first try", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const onRetry = vi.fn();
    await expect(
      runWithTransientDbRetry(fn, { onRetry, sleep: noWait, random: noJitter }),
    ).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("retries a transient failure then returns the eventual success", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(pgError("40P01"))
      .mockResolvedValue("recovered");
    const onRetry = vi.fn();
    await expect(
      runWithTransientDbRetry(fn, { onRetry, sleep: noWait, random: noJitter }),
    ).resolves.toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith({ attempt: 1, error: expect.objectContaining({ code: "40P01" }) });
  });

  it("retries lock_timeout (55P03) and statement_timeout (57014)", async () => {
    for (const code of ["55P03", "57014"]) {
      const fn = vi.fn().mockRejectedValueOnce(pgError(code)).mockResolvedValue("ok");
      await expect(
        runWithTransientDbRetry(fn, { sleep: noWait, random: noJitter }),
      ).resolves.toBe("ok");
      expect(fn).toHaveBeenCalledTimes(2);
    }
  });

  it("rethrows a non-transient error immediately without retrying", async () => {
    const err = pgError("23505");
    const fn = vi.fn().mockRejectedValue(err);
    const onRetry = vi.fn();
    await expect(
      runWithTransientDbRetry(fn, { onRetry, sleep: noWait, random: noJitter }),
    ).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("rethrows the transient error after exhausting maxAttempts", async () => {
    const err = pgError("40P01");
    const fn = vi.fn().mockRejectedValue(err);
    const onRetry = vi.fn();
    await expect(
      runWithTransientDbRetry(fn, {
        maxAttempts: 3,
        onRetry,
        sleep: noWait,
        random: noJitter,
      }),
    ).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(3);
    // onRetry fires before each retry, never on the terminal failure.
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it("applies jittered incremental backoff via the injected sleep", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(pgError("40P01"))
      .mockRejectedValueOnce(pgError("40P01"))
      .mockResolvedValue("ok");
    const sleep = vi.fn().mockResolvedValue(undefined);
    await runWithTransientDbRetry(fn, {
      baseDelayMs: 10,
      jitterMs: 100,
      random: () => 0.5, // fixed jitter = 50
      sleep,
    });
    // delay = baseDelayMs * attempt + random()*jitterMs → 10*1+50, 10*2+50.
    expect(sleep).toHaveBeenNthCalledWith(1, 60);
    expect(sleep).toHaveBeenNthCalledWith(2, 70);
  });
});
