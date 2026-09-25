import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

import type { Db } from "@paperclipai/db";
import { createDb } from "@paperclipai/db";
import {
  _resetAgentStartLocksForTesting,
  AgentStartLockAbortedError,
  describeAgentStartLockDispatchHealth,
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
const LOCK_ABORT_MS = 4 * 60 * 60_000;
const LOCK_HELD_WARN_MS = 30_000;

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

    await vi.advanceTimersByTimeAsync(LOCK_ABORT_MS + 1_000);

    expect(client.issued[0]!.cancelled).toBe(true);
    await expect(held).rejects.toMatchObject({ code: "57014" });
  });

  // The negative control for the retry mechanism that is deliberately ABSENT.
  //
  // An earlier revision retained in-flight queries and re-issued `cancel()` on
  // each lock tick. It could not work, and this is why: postgres.js's
  // `Query#cancel()` nulls its own canceller, so the second call reaches
  // nothing. A fake `cancel()` is re-armable and hid that — this test uses a
  // REAL `Query`, built I/O-free (`unsafe` only constructs; dispatch is lazy
  // until the first `then`), so it fails if the assumption ever changes.
  it("cannot be re-cancelled: postgres.js `Query#cancel()` disarms itself (PEN-3328 review)", async () => {
    // postgres.js connects lazily and `unsafe` only constructs — dispatch waits
    // for the first `then` — so this opens no socket. Same pattern as
    // `db-pool-stats.test.ts`, which guards the other half of this patch.
    const db = createDb("postgres://unused:unused@127.0.0.1:1/unused");
    const client = (db as unknown as { $client: { unsafe: (q: string) => unknown } }).$client;
    const query = client.unsafe("select 1") as {
      cancel: () => unknown;
      canceller?: unknown;
    };
    // Attach through the BASE `then`: `Query` overrides `then`/`catch` to call
    // `handle()`, which would dispatch the statement and dial 127.0.0.1:1.
    // `Promise.prototype.then` bypasses the override, so this only marks the
    // 57014 rejection below as handled.
    void Promise.prototype.then.call(query as PromiseLike<unknown>, () => {}, () => {});

    expect(typeof query.canceller).toBe("function");

    // First cancel: real work. It takes the `!query.state` branch — the
    // statement never executed — which rejects it 57014 client-side.
    const first = query.cancel();
    // And it returns the canceller's promise rather than discarding it, which
    // is what `patches/postgres@3.4.9.patch` adds so `cancelQuery` can attach a
    // rejection handler. If that patch stops applying, this goes red.
    expect(typeof (first as PromiseLike<unknown> | undefined)?.then).toBe("function");

    // Second cancel: inert. The canceller is spent, so there is no re-dial to
    // be had and a retry loop would only ever count phantom attempts.
    expect(query.canceller).toBeNull();
    expect(query.cancel()).toBeUndefined();
  });

  // The other half of the same finding: the dial fails ASYNCHRONOUSLY, so a
  // synchronous try/catch cannot contain it. `process-crash-guard.ts` handles
  // `unhandledRejection` by exiting the worker, so an uncontained one here
  // would trade a single wedged agent for every agent's in-flight dispatch.
  it("contains an asynchronously failing cancel dial rather than letting it reach the crash guard", async () => {
    vi.useFakeTimers();
    vi.spyOn(logger, "warn").mockImplementation(() => logger);
    vi.spyOn(logger, "error").mockImplementation(() => logger);

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);

    try {
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

      // The patched `Query#cancel()` returns the canceller's promise, and that
      // promise rejects when the CancelRequest connection cannot be opened.
      const query = client.issued[0]!;
      const dialFailure = new Error("connect ECONNREFUSED (cancel request)");
      query.cancel = () => Promise.reject(dialFailure) as unknown as void;

      await vi.advanceTimersByTimeAsync(LOCK_ABORT_MS + 1_000);

      // Give the rejection every chance to be reported as unhandled.
      vi.useRealTimers();
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      expect(unhandled).toEqual([]);
      // And the failure is not merely swallowed — it is reported, because a
      // dial that failed is the difference between "aborted and recovered" and
      // "aborted and still wedged".
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: dialFailure }),
        expect.stringContaining("failed to dial"),
      );
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
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
    await vi.advanceTimersByTimeAsync(LOCK_ABORT_MS + 1_000);
    await expect(held).rejects.toThrow("section done");

    expect(secondAttempt).toBeInstanceOf(AgentStartLockAbortedError);
    // Pins this file's hand-copied LOCK_ABORT_MS to the source constant: the
    // error message embeds the real limit. Without it, a drift between the two
    // would make every `advanceTimersByTimeAsync(LOCK_ABORT_MS + 1_000)` above
    // stop reaching the boundary it names while the suite stayed green.
    expect((secondAttempt as AgentStartLockAbortedError).message).toContain(
      `limit ${LOCK_ABORT_MS / 1000}s`,
    );
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

    await vi.advanceTimersByTimeAsync(LOCK_ABORT_MS + 1_000);

    expect(inner.issued[0]!.cancelled).toBe(true);
    await expect(held).rejects.toMatchObject({ code: "57014" });
  });

  it("does NOT rescue a `begin` that hangs before its callback, and stays mutually exclusive while stalled", async () => {
    vi.useFakeTimers();
    vi.spyOn(logger, "warn").mockImplementation(() => logger);
    vi.spyOn(logger, "error").mockImplementation(() => logger);
    const agentId = randomUUID();
    const client = makeFakeClient("never");

    // The gap this pins: `begin` takes a pool slot BEFORE it can issue `BEGIN`
    // or invoke its callback, and with `max: 10` and no acquire timeout that
    // wait is unbounded. The wrapper pre-checks `signal.aborted` and then hands
    // off, registering no listener and no in-flight entry, so nothing observes
    // the abort. Modelled by a `begin` that never settles and never calls back —
    // the existing transactional test cannot reach this, because its `begin`
    // invokes the callback synchronously.
    let callbackRan = false;
    client.begin = () => {
      return new Promise<unknown>(() => {}); // acquisition that never completes
    };
    const db = withAgentStartLockAbortableDb(makeFakeDb(client));
    const wrapped = (db as Db & { $client: typeof client }).$client;

    const held = withAgentStartLock(
      agentId,
      async () =>
        wrapped.begin(async () => {
          callbackRan = true;
          return undefined;
        }),
      coalesced,
    );
    let settled = false;
    void held.then(() => { settled = true; }, () => { settled = true; });

    await vi.advanceTimersByTimeAsync(LOCK_ABORT_MS + 1_000);

    // The honest assertion. The abort was raised and did not land: no statement
    // was ever issued to cancel, so the section is still sitting on the
    // acquisition. If a future change makes this path genuinely cancellable,
    // this expectation is the one that must be rewritten.
    expect(callbackRan).toBe(false);
    expect(client.issued).toHaveLength(0);
    expect(settled).toBe(false);

    // Reported rather than rescued — the residue is visible, which is what
    // separates this from the silent wedge PEN-3305 measured.
    expect(describeAgentStartLockDispatchHealth(agentId)).toMatchObject({ status: "stalled" });

    // And the property that must survive the gap: an unrescued section still
    // holds its lock, so a follow-up folds into it rather than running
    // alongside. Deliberately NOT awaited — a lock-free caller returns the
    // coalesced follow-up, which is chained onto a section that never settles,
    // so awaiting it would hang the test rather than assert anything. That the
    // follow-up's `fn` never runs is the BLO-20396 regression check.
    let followUpRan = false;
    const follow = withAgentStartLock(agentId, async () => {
      followUpRan = true;
      return "ran-concurrently";
    }, coalesced);
    void follow.catch(() => {});
    await vi.advanceTimersByTimeAsync(LOCK_ABORT_MS);
    expect(followUpRan).toBe(false);
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

  it("keeps pass-through methods reference-stable across property reads", () => {
    // `fn.bind()` mints a new function every call, so binding inside the proxy's
    // `get` trap would make `client.end !== client.end`. Nothing in drizzle
    // compares these by identity today, which is exactly why a regression here
    // would be silent — anything that stored one to remove or compare later
    // would quietly operate on a different function than the one it kept.
    const client = makeFakeClient("immediate");
    const db = withAgentStartLockAbortableDb(makeFakeDb(client));
    const wrapped = (db as Db & { $client: typeof client }).$client;

    expect(wrapped.begin).toBe(wrapped.begin);
    expect(wrapped.savepoint).toBe(wrapped.savepoint);
    expect(wrapped.unsafe).toBe(wrapped.unsafe);
  });
});
