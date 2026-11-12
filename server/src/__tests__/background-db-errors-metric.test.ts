import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { runWithTransientDbRetry, TRANSIENT_DB_SQLSTATES } from "../lib/db-retry.js";
import {
  BACKGROUND_DB_ERRORS_METRIC,
  BACKGROUND_DB_SQLSTATE_OTHER,
  BACKGROUND_DB_SQLSTATES,
  BACKGROUND_DB_WRITER_TABLES,
  BACKGROUND_DB_WRITERS,
  __resetMetricsForTest,
  getMetricsRegistry,
  normalizeBackgroundDbSqlstate,
  recordBackgroundDbError,
} from "../services/metrics.js";

/**
 * PEN-6581. `paperclip_http_transient_db_responses_total` is written on the
 * HTTP response path, so a `57014` or `55P03` raised by a writer holding no
 * request is counted by nothing -- and in PEN-5019's October class-D census
 * that was 14 of 26 events on `heartbeat_runs` alone, with the `pg_stat` route
 * closed by ruling and the database log reaching back only as far as its tail
 * happened to.
 *
 * These tests pin the three properties that make this a census rather than an
 * anecdote: the grid is readable at ZERO before any error (so an empty read is
 * never indistinguishable from a healthy one), the SQLSTATE survives the
 * drizzle `cause` wrapper that hides it, and every error EVENT is counted --
 * including the ones a retry is not going to follow, which is where the
 * obvious `onRetry` wiring would have silently undercounted.
 */

type Series = { value: number; labels: Record<string, string | number> };

async function seriesOf(metricName: string): Promise<Series[]> {
  const metric = getMetricsRegistry().getSingleMetric(metricName);
  if (!metric) return [];
  const snapshot = (await metric.get()) as { values: Series[] };
  return snapshot.values;
}

async function countOf(labels: Record<string, string>): Promise<number> {
  const values = await seriesOf(BACKGROUND_DB_ERRORS_METRIC);
  return values
    .filter((s) => Object.entries(labels).every(([k, v]) => String(s.labels[k]) === v))
    .reduce((sum, s) => sum + s.value, 0);
}

/** A bare pg driver error, as `findPgError` recognizes it. */
const pgError = (code: string): Error & { code: string } =>
  Object.assign(new Error(`db failed (${code})`), { code });

/**
 * The shape drizzle actually throws: the message is the failed query and the
 * real PostgreSQL error -- SQLSTATE included -- hangs off `.cause`.
 */
const drizzleError = (code: string): Error =>
  new Error("Failed query: update \"heartbeat_runs\" ...", { cause: pgError(code) });

beforeEach(() => {
  __resetMetricsForTest();
});

describe("paperclip_background_db_errors_total zero-initialization", () => {
  /**
   * Done-when 2. The failure this guards is specific: a counter born on its
   * first error is absent while quiet AND absent during a total outage, so an
   * empty Prometheus read is indistinguishable from "healthy" -- it fails in
   * the no-signal-reads-as-pass direction.
   *
   * Note the assertion is on series PRESENCE, not on a count being 0. A sum
   * over a metric that does not exist is also 0, so asserting the value alone
   * would pass just as happily against the very defect this test exists to
   * catch.
   */
  it("publishes every writer x sqlstate series at 0 before any error is recorded", async () => {
    const values = await seriesOf(BACKGROUND_DB_ERRORS_METRIC);

    const expected = new Set<string>();
    for (const [writer, table] of Object.entries(BACKGROUND_DB_WRITER_TABLES)) {
      for (const sqlstate of BACKGROUND_DB_SQLSTATES) {
        expected.add(`${writer}|${table}|${sqlstate}`);
      }
    }

    const present = new Set(
      values.map((s) => `${s.labels.writer}|${s.labels.table}|${s.labels.sqlstate}`),
    );

    expect(present).toEqual(expected);
    expect(values.length).toBe(expected.size);
    for (const s of values) expect(s.value).toBe(0);
  });

  /**
   * The zero-init grid is what makes `count by (writer) (...)` the counter's
   * coverage list, so the grid must be the writers and nothing else -- a
   * writer present in the grid but wired at no call site publishes a
   * permanently-0 series that reads as a healthy writer rather than an
   * uninstrumented one, which is strictly worse than being absent.
   */
  it("enumerates exactly the sqlstates the retry classifier knows, plus the other bucket", () => {
    expect(new Set(BACKGROUND_DB_SQLSTATES)).toEqual(
      new Set([...TRANSIENT_DB_SQLSTATES, BACKGROUND_DB_SQLSTATE_OTHER]),
    );
    expect(BACKGROUND_DB_WRITERS).toEqual(Object.keys(BACKGROUND_DB_WRITER_TABLES));
  });

  it("wires every writer in the coverage grid to a real call site", () => {
    // The grid is a promise about coverage; this is the only cheap check that
    // the promise is kept. A writer added here but never recorded anywhere
    // publishes a permanent 0 that reads as "this writer never fails".
    const heartbeat = readFileSync(
      fileURLToPath(new URL("../services/heartbeat.ts", import.meta.url)),
      "utf8",
    );
    for (const writer of BACKGROUND_DB_WRITERS) {
      expect(heartbeat, `writer ${writer} is in the grid but wired at no call site`)
        .toContain(`writer: "${writer}"`);
    }
  });
});

describe("recordBackgroundDbError", () => {
  it("counts a transient SQLSTATE under its writer and that writer's table", async () => {
    expect(recordBackgroundDbError({
      writer: "heartbeat_run_status",
      error: pgError("57014"),
    })).toBe("57014");

    expect(await countOf({ writer: "heartbeat_run_status", sqlstate: "57014" })).toBe(1);
    expect(await countOf({ table: "heartbeat_runs", sqlstate: "57014" })).toBe(1);
    // Derived, not passed: the writer alone decides the table.
    expect(await countOf({ writer: "heartbeat_run_status", table: "documents" })).toBe(0);
  });

  it("recovers the SQLSTATE from the drizzle cause chain that hides it", async () => {
    // The trap this recorder exists to close: the obvious call-site idiom
    // `(error as { code?: string }).code` reads `undefined` on exactly the
    // errors that matter, bucketing every real class-D event as `other`.
    expect(recordBackgroundDbError({
      writer: "heartbeat_run_status_guarded",
      error: drizzleError("55P03"),
    })).toBe("55P03");

    expect(await countOf({ writer: "heartbeat_run_status_guarded", sqlstate: "55P03" })).toBe(1);
    expect(await countOf({ sqlstate: BACKGROUND_DB_SQLSTATE_OTHER })).toBe(0);
  });

  it("buckets a non-transient SQLSTATE into a reachable other, unlike the HTTP sibling", async () => {
    // These call sites are not gated on the transient set, so `other` here is
    // a genuine mixed bucket rather than an unreachable cardinality guard.
    expect(recordBackgroundDbError({
      writer: "issue_continuation_summary",
      error: pgError("23505"),
    })).toBe(BACKGROUND_DB_SQLSTATE_OTHER);

    expect(await countOf({
      writer: "issue_continuation_summary",
      table: "documents",
      sqlstate: BACKGROUND_DB_SQLSTATE_OTHER,
    })).toBe(1);
  });

  it("counts nothing when the error carries no SQLSTATE", async () => {
    // The continuation-summary call site sits in a catch that takes every
    // throw, so a non-database fault must not reach a SQLSTATE census.
    expect(recordBackgroundDbError({
      writer: "issue_continuation_summary",
      error: new TypeError("not a database error"),
    })).toBeNull();
    expect(recordBackgroundDbError({
      writer: "issue_continuation_summary",
      error: null,
    })).toBeNull();

    const values = await seriesOf(BACKGROUND_DB_ERRORS_METRIC);
    expect(values.every((s) => s.value === 0)).toBe(true);
  });

  it("bounds the sqlstate label to the allow-list", () => {
    expect(normalizeBackgroundDbSqlstate("57014")).toBe("57014");
    expect(normalizeBackgroundDbSqlstate("not-a-sqlstate")).toBe(BACKGROUND_DB_SQLSTATE_OTHER);
    expect(normalizeBackgroundDbSqlstate(null)).toBe(BACKGROUND_DB_SQLSTATE_OTHER);
    expect(normalizeBackgroundDbSqlstate(undefined)).toBe(BACKGROUND_DB_SQLSTATE_OTHER);
  });
});

describe("runWithTransientDbRetry onError", () => {
  const noWait = () => Promise.resolve();
  const noJitter = () => 0;

  /**
   * This is why the hook is `onError` and not `onRetry`. `onRetry` is silent
   * on the error that is not replayed, which is precisely the event a failure
   * census must not miss: the final attempt of an exhausted sequence, and
   * every non-transient error. Wiring the counter to `onRetry` would
   * undercount by one event per failing operation, and would miss a
   * single-attempt failure entirely -- in the direction that reads as health.
   */
  it("fires on the final transient failure, where onRetry stays silent", async () => {
    const onError = vi.fn();
    const onRetry = vi.fn();
    const fn = vi.fn().mockRejectedValue(pgError("57014"));

    await expect(
      runWithTransientDbRetry(fn, {
        maxAttempts: 3,
        onError,
        onRetry,
        sleep: noWait,
        random: noJitter,
      }),
    ).rejects.toMatchObject({ code: "57014" });

    expect(onError).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onError.mock.calls.map(([info]) => info.willRetry)).toEqual([true, true, false]);
  });

  it("fires on a non-transient error that is rethrown unretried", async () => {
    const onError = vi.fn();
    const onRetry = vi.fn();
    const fn = vi.fn().mockRejectedValue(pgError("23505"));

    await expect(
      runWithTransientDbRetry(fn, { onError, onRetry, sleep: noWait, random: noJitter }),
    ).rejects.toMatchObject({ code: "23505" });

    expect(fn).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0].willRetry).toBe(false);
  });

  /**
   * The counter records error EVENTS, not failed operations. An error a replay
   * then wins is counted, which is what makes it comparable to the `STATEMENT:`
   * records PEN-5019's class-D census was built from -- those are every
   * cancelled statement, successful replay or not.
   */
  it("counts an error the retry then wins, so the operation succeeds at a non-zero count", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(drizzleError("40P01"))
      .mockResolvedValueOnce("ok");

    await expect(
      runWithTransientDbRetry(fn, {
        onError: ({ error }) =>
          recordBackgroundDbError({ writer: "heartbeat_run_status", error }),
        sleep: noWait,
        random: noJitter,
      }),
    ).resolves.toBe("ok");

    expect(await countOf({ writer: "heartbeat_run_status", sqlstate: "40P01" })).toBe(1);
  });

  it("leaves the no-error path untouched", async () => {
    const onError = vi.fn();
    await expect(
      runWithTransientDbRetry(() => Promise.resolve("ok"), { onError }),
    ).resolves.toBe("ok");
    expect(onError).not.toHaveBeenCalled();
  });
});

describe("onError cannot break the write it observes", () => {
  const noWait = () => Promise.resolve();
  const noJitter = () => 0;

  /**
   * The hook runs between a caught database error and the rethrow, on the very
   * finalize writes `db-retry`'s header says must not throw: an unhandled one
   * there "leaves the run stuck in `running` forever and the agent never
   * dispatches its next work". A counter added to measure that outage must not
   * be able to cause it.
   */
  it("swallows a throwing onError and still rethrows the database error", async () => {
    const boom = () => {
      throw new Error("metrics registry is broken");
    };
    await expect(
      runWithTransientDbRetry(() => Promise.reject(pgError("23505")), {
        onError: boom,
        sleep: noWait,
        random: noJitter,
      }),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("still retries and still resolves when onError throws on a transient error", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(pgError("40P01"))
      .mockResolvedValueOnce("ok");
    await expect(
      runWithTransientDbRetry(fn, {
        onError: () => {
          throw new Error("metrics registry is broken");
        },
        sleep: noWait,
        random: noJitter,
      }),
    ).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("leaves onRetry's existing throw behaviour unchanged", async () => {
    // Scope check: the swallow is deliberately scoped to the new hook, so a
    // caller relying on onRetry's prior behaviour is not silently altered.
    await expect(
      runWithTransientDbRetry(() => Promise.reject(pgError("40P01")), {
        onRetry: () => {
          throw new Error("onRetry blew up");
        },
        sleep: noWait,
        random: noJitter,
      }),
    ).rejects.toThrow("onRetry blew up");
  });
});
