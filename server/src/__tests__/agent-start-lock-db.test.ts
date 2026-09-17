import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

import type { Db } from "@paperclipai/db";
import {
  _resetAgentStartLocksForTesting,
  AgentStartLockAbortedError,
  withAgentStartLock,
} from "../services/agent-start-lock.js";
import { withAgentStartLockAbortableDb } from "../services/agent-start-lock-db.js";
import { logger } from "../middleware/logger.js";

/**
 * PEN-3328. `withAgentStartLock` aborts a section that overruns its budget, but
 * an `AbortSignal` only aborts what observes it. These tests cover the thing
 * that observes it: the postgres.js client every database await in the dispatch
 * critical section resolves through.
 *
 * The stand-in below mirrors the three methods drizzle's postgres-js driver
 * actually calls — `unsafe(query, params)`, `begin(fn)`, `savepoint(fn)` — and
 * postgres.js's `Query` contract: a thenable with `cancel()`, plus the
 * mutate-and-return-`this` `values()`/`raw()` that drizzle chains synchronously
 * onto the value `unsafe` returns.
 */

const coalesced = { onCoalesced: () => "coalesced" as const };
const LOCK_HELD_ERROR_MS = 5 * 60_000;

type FakeQuery = Promise<unknown> & {
  cancel: () => void;
  values: () => FakeQuery;
  cancelled: boolean;
};

function makeFakeQuery(settle: "never" | "immediate"): FakeQuery {
  let reject!: (err: unknown) => void;
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>((res, rej) => {
    resolve = res;
    reject = rej;
  }) as FakeQuery;
  if (settle === "immediate") resolve([]);
  promise.cancelled = false;
  promise.cancel = () => {
    promise.cancelled = true;
    // postgres.js rejects a cancelled statement with 57014 whether it was
    // dequeued client-side or killed in the backend. Either way the await the
    // section is sitting on stops being pending, which is the whole mechanism.
    reject(Object.assign(new Error("canceling statement due to user request"), { code: "57014" }));
  };
  promise.values = () => promise;
  return promise;
}

function makeFakeClient(settle: "never" | "immediate" = "never") {
  const issued: FakeQuery[] = [];
  const scopedClientsSeen: unknown[] = [];

  const client = function tagged() {
    throw new Error("tagged template not used in these tests");
  } as unknown as {
    (): never;
    unsafe: (query: string, params?: unknown[]) => FakeQuery;
    begin: (fn: (scoped: unknown) => Promise<unknown>) => Promise<unknown>;
    savepoint: (fn: (scoped: unknown) => Promise<unknown>) => Promise<unknown>;
    options: { parsers: Record<string, unknown>; serializers: Record<string, unknown> };
    issued: FakeQuery[];
    scopedClientsSeen: unknown[];
  };

  client.options = { parsers: {}, serializers: {} };
  client.issued = issued;
  client.scopedClientsSeen = scopedClientsSeen;
  client.unsafe = () => {
    const query = makeFakeQuery(settle);
    // Swallow the cancellation rejection here so an un-awaited fake query does
    // not surface as an unhandled rejection; the assertions read `cancelled`.
    void query.catch(() => {});
    issued.push(query);
    return query;
  };
  // postgres.js hands the callback a *different*, connection-scoped client and
  // drizzle issues the transaction's statements through that one.
  const scoped = (fn: (s: unknown) => Promise<unknown>) => {
    const inner = makeFakeClient(settle);
    scopedClientsSeen.push(inner);
    return fn(inner);
  };
  client.begin = scoped;
  client.savepoint = scoped;
  return client;
}

/** The fake client, dressed as a `Db` the way drizzle exposes `$client`. */
function makeFakeDb(client: ReturnType<typeof makeFakeClient>) {
  return { $client: client } as unknown as Db;
}

describe("agent start lock database cancellation seam (PEN-3328)", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    _resetAgentStartLocksForTesting();
  });

  it("cancels the statement a wedged section is awaiting, so the section rejects", async () => {
    vi.useFakeTimers();
    vi.spyOn(logger, "warn").mockImplementation(() => logger);
    vi.spyOn(logger, "error").mockImplementation(() => logger);
    const client = makeFakeClient("never");
    const db = withAgentStartLockAbortableDb(makeFakeDb(client));
    const wrapped = (db as Db & { $client: typeof client }).$client;

    const held = withAgentStartLock(
      randomUUID(),
      // Stands in for any of the section's database awaits: a statement that
      // never comes back, which before PEN-3328 wedged the agent permanently.
      async () => wrapped.unsafe("select 1"),
      coalesced,
    );
    void held.catch(() => {});
    await vi.advanceTimersByTimeAsync(0);

    expect(client.issued).toHaveLength(1);
    expect(client.issued[0]!.cancelled).toBe(false);

    await vi.advanceTimersByTimeAsync(LOCK_HELD_ERROR_MS + 1_000);

    expect(client.issued[0]!.cancelled).toBe(true);
    await expect(held).rejects.toMatchObject({ code: "57014" });
  });

  it("re-issues the cancel on later ticks when the first attempt fails to take", async () => {
    vi.useFakeTimers();
    vi.spyOn(logger, "warn").mockImplementation(() => logger);
    vi.spyOn(logger, "error").mockImplementation(() => logger);
    const client = makeFakeClient("never");
    const db = withAgentStartLockAbortableDb(makeFakeDb(client));
    const wrapped = (db as Db & { $client: typeof client }).$client;

    const held = withAgentStartLock(
      randomUUID(),
      async () => wrapped.unsafe("select 1"),
      coalesced,
    );
    void held.catch(() => {});
    await vi.advanceTimersByTimeAsync(0);

    // Stand in for the real failure mode this retry exists for: `cancel()` on
    // an EXECUTING statement dials a fresh connection, and that dial can fail.
    // The query then stays pending with the abort already spent — before the
    // retry, that was a permanent wedge, because the signal fires its listeners
    // once and they detach.
    const query = client.issued[0]!;
    let attempts = 0;
    const realCancel = query.cancel;
    query.cancel = () => {
      attempts += 1;
      // Fail the first two attempts, then let one through.
      if (attempts < 3) throw new Error("could not connect to cancel the query");
      realCancel();
    };

    await vi.advanceTimersByTimeAsync(LOCK_HELD_ERROR_MS + 1_000);
    // First attempt happened and threw; the section is still wedged, and
    // crucially the lock is still HELD — a failed cancel must never be mistaken
    // for a release.
    expect(attempts).toBe(1);
    expect(query.cancelled).toBe(false);

    // Each subsequent error tick tries again rather than giving up.
    await vi.advanceTimersByTimeAsync(LOCK_HELD_ERROR_MS);
    expect(attempts).toBe(2);
    expect(query.cancelled).toBe(false);

    await vi.advanceTimersByTimeAsync(LOCK_HELD_ERROR_MS);
    expect(attempts).toBe(3);
    expect(query.cancelled).toBe(true);
    await expect(held).rejects.toMatchObject({ code: "57014" });
  });

  it("refuses to issue a new statement once the section is aborted", async () => {
    vi.useFakeTimers();
    vi.spyOn(logger, "warn").mockImplementation(() => logger);
    vi.spyOn(logger, "error").mockImplementation(() => logger);
    const client = makeFakeClient("never");
    const db = withAgentStartLockAbortableDb(makeFakeDb(client));
    const wrapped = (db as Db & { $client: typeof client }).$client;

    let secondAttempt: unknown = null;
    const held = withAgentStartLock(
      randomUUID(),
      async () => {
        try {
          await wrapped.unsafe("select 1");
        } catch {
          // The section keeps going after its first statement is cancelled.
          // Issuing the next one must fail immediately rather than taking a
          // pool slot the wedged agent's recovery needs.
          try {
            wrapped.unsafe("select 2");
          } catch (err) {
            secondAttempt = err;
          }
        }
        throw new Error("section done");
      },
      coalesced,
    );
    void held.catch(() => {});
    await vi.advanceTimersByTimeAsync(LOCK_HELD_ERROR_MS + 1_000);
    await expect(held).rejects.toThrow("section done");

    expect(secondAttempt).toBeInstanceOf(AgentStartLockAbortedError);
    // Exactly one statement was ever issued — the refused one never reached the
    // client.
    expect(client.issued).toHaveLength(1);
  });

  it("makes transactional statements cancellable too, not just top-level ones", async () => {
    vi.useFakeTimers();
    vi.spyOn(logger, "warn").mockImplementation(() => logger);
    vi.spyOn(logger, "error").mockImplementation(() => logger);
    const client = makeFakeClient("never");
    const db = withAgentStartLockAbortableDb(makeFakeDb(client));
    const wrapped = (db as Db & { $client: typeof client }).$client;

    // This is the `lockIssueOwnership` shape: an advisory-lock acquisition
    // inside a transaction, issued through the connection-scoped client that
    // `begin` passes to its callback. An unwrapped inner client would leave
    // exactly that statement uncancellable.
    const held = withAgentStartLock(
      randomUUID(),
      async () =>
        wrapped.begin(async (scoped) =>
          (scoped as ReturnType<typeof makeFakeClient>).unsafe("select pg_advisory_xact_lock(1)")),
      coalesced,
    );
    void held.catch(() => {});
    await vi.advanceTimersByTimeAsync(0);

    const inner = client.scopedClientsSeen[0] as ReturnType<typeof makeFakeClient>;
    expect(inner.issued).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(LOCK_HELD_ERROR_MS + 1_000);

    expect(inner.issued[0]!.cancelled).toBe(true);
    await expect(held).rejects.toMatchObject({ code: "57014" });
  });

  it("is a pass-through outside a dispatch section", async () => {
    const client = makeFakeClient("immediate");
    const db = withAgentStartLockAbortableDb(makeFakeDb(client));
    const wrapped = (db as Db & { $client: typeof client }).$client;

    // No section on this async path ⇒ no signal ⇒ no listeners, no refusals.
    // Every other caller in the process takes this path, so it must be inert.
    await expect(wrapped.unsafe("select 1")).resolves.toEqual([]);
    expect(client.issued[0]!.cancelled).toBe(false);
  });

  it("returns the handle unchanged when it is not a postgres.js client", () => {
    // Test doubles and `drizzle.mock()` have no usable `$client`. Failing open
    // is deliberate: dispatching without the wrapper beats refusing to start.
    const plain = { select: () => undefined } as unknown as Db;
    expect(withAgentStartLockAbortableDb(plain)).toBe(plain);
  });
});
