import { describe, expect, it, vi } from "vitest";
import {
  describeDbError,
  isDbError,
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

  it("recognizes transient SQLSTATEs wrapped by higher-level database errors", () => {
    expect(isTransientDbError(new Error("Failed query", { cause: pgError("40P01") }))).toBe(true);
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

// BLO-19085: a drizzle write failure carries the useful half of the diagnosis
// on `.cause` and the useless half — every bind param — inlined in `message`.
// Two real `heartbeat_runs.error` values were 605,891 and 338,507 characters of
// inlined agent stdout, neither naming the SQLSTATE that caused them.
describe("describeDbError", () => {
  const drizzleWrapper = (cause?: unknown) =>
    new Error(
      `Failed query: update "heartbeat_runs" set "status" = $1, "result_json" = $2 where ("heartbeat_runs"."id" = $3 and "heartbeat_runs"."status" = $4) returning "id"\nparams: running,${"x".repeat(600_000)},abc,running`,
      cause ? { cause } : undefined,
    );

  it("keeps the SQLSTATE and drops the inlined bind params", () => {
    const huge = drizzleWrapper(
      Object.assign(new Error("unsupported Unicode escape sequence"), { code: "22P05" }),
    );
    expect(huge.message.length).toBeGreaterThan(600_000);

    const described = describeDbError(huge, "run finalization db write failed");

    expect(described).toContain("run finalization db write failed");
    expect(described).toContain("SQLSTATE 22P05");
    expect(described).toContain("unsupported Unicode escape sequence");
    expect(described).toContain('update "heartbeat_runs"');
    expect(described).toContain("(bind params omitted)");
    // The whole point: the params never reach the column.
    expect(described).not.toContain("xxxxx");
    expect(described.length).toBeLessThan(1_000);
  });

  it("surfaces pg detail, constraint and relation when present", () => {
    const described = describeDbError(
      drizzleWrapper(
        Object.assign(new Error("duplicate key value violates unique constraint"), {
          code: "23505",
          detail: "Key (id)=(abc) already exists.",
          constraint: "heartbeat_runs_pkey",
          table: "heartbeat_runs",
          column: "id",
        }),
      ),
    );
    expect(described).toContain("detail: Key (id)=(abc) already exists.");
    expect(described).toContain("constraint: heartbeat_runs_pkey");
    expect(described).toContain("relation: heartbeat_runs.id");
  });

  it("normalizes and bounds oversized PostgreSQL fields", () => {
    const described = describeDbError(
      drizzleWrapper(
        Object.assign(new Error("duplicate\nkey value violates\nunique constraint"), {
          code: "23505",
          detail: `Key (result_json)=(${("stdout-line\n").repeat(2_000)}) already exists.`,
          constraint: `heartbeat_runs_${"constraint_".repeat(200)}pkey`,
          table: "heartbeat_runs",
          column: "result_json",
        }),
      ),
      "run finalization db write failed",
    );

    expect(described).toContain("SQLSTATE 23505");
    expect(described).toContain("detail: Key (result_json)=");
    expect(described).toContain("constraint: heartbeat_runs_constraint_");
    expect(described).toContain("relation: heartbeat_runs.result_json");
    expect(described).not.toContain("\n");
    expect(described.length).toBeLessThan(1_000);
  });

  it("still truncates a Failed query wrapper that has no attached cause", () => {
    const described = describeDbError(drizzleWrapper());
    expect(described).not.toContain("xxxxx");
    expect(described).toContain("(bind params omitted)");
    expect(described.length).toBeLessThan(1_000);
  });

  it("passes through a non-database error message, bounded", () => {
    expect(describeDbError(new Error("boom"))).toBe("boom");
    expect(describeDbError(new Error("z".repeat(5_000))).length).toBeLessThan(500);
  });

  it("never returns an empty string", () => {
    expect(describeDbError(null)).toBe("unknown database error");
    expect(describeDbError(undefined)).toBe("unknown database error");
    expect(describeDbError(new Error(""))).toBe("unknown database error");
  });
});

describe("isDbError", () => {
  it("recognizes pg-coded errors and drizzle wrappers, and rejects the rest", () => {
    expect(isDbError(pgError("22P05"))).toBe(true);
    expect(isDbError(new Error("Failed query: select 1"))).toBe(true);
    expect(isDbError(new Error("Failed query", { cause: pgError("40P01") }))).toBe(true);
    expect(isDbError(new Error("adapter exploded"))).toBe(false);
    expect(isDbError(null)).toBe(false);
  });

  it("does not mistake a Node syscall error code for a SQLSTATE", () => {
    // `code` is the same field name; require a PostgreSQL SQLSTATE class so
    // five-character syscall codes are not relabeled as database writes.
    expect(isDbError(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }))).toBe(
      false,
    );
    expect(isDbError(Object.assign(new Error("broken pipe"), { code: "EPIPE" }))).toBe(false);
    expect(isDbError(Object.assign(new Error("permission denied"), { code: "EPERM" }))).toBe(false);
  });
});
