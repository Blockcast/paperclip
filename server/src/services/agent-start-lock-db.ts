import { createDbFromPostgresClient, type Db } from "@paperclipai/db";

import { currentAgentStartLockSignal } from "./agent-start-lock.js";

/**
 * Make the queued-run dispatch critical section's database work cancellable
 * (PEN-3328).
 *
 * `withAgentStartLock` gives each section an `AbortSignal` and aborts it once
 * the section has held the lock past its budget. That signal only does
 * something if an await observes it, and this module is what makes the awaits
 * that matter observe it.
 *
 * ## Why the postgres.js client, and not the 35 awaits
 *
 * The section is one closure in `heartbeat.ts` spanning ~1200 lines. Its direct
 * body holds seven `db.select(...)` calls and twenty calls to helpers defined
 * elsewhere in that file, each resolving the same lexically captured `db` from
 * `heartbeatService(db)`. Threading an `AbortSignal` to all of them would touch
 * most of a 38k-line file and would still miss whatever the next helper does.
 *
 * Every one of those paths converges on the same three methods, because
 * drizzle's postgres-js driver reaches the database through exactly three:
 * `client.unsafe(query, params)` for statements, `client.begin(fn)` for
 * transactions, and `client.savepoint(fn)` for nested ones
 * (`drizzle-orm/postgres-js/session.js`). Wrapping the client covers all of
 * them at once, in one place, with no change to any call site.
 *
 * ## Why this cancels rather than abandons
 *
 * Abandoning a pending await and moving on is the forbidden shortcut — it is
 * how BLO-20396 turned the lock into a concurrency amplifier. Nothing here
 * abandons anything. postgres.js `Query#cancel()` is a real cancellation at
 * both layers where a dispatch await can hang (verified against postgres 3.4.9,
 * `src/index.js` `cancel()`):
 *
 *   - **Queued for a pool slot** (`!query.state`) — the pool is `max: 10` with
 *     no acquire timeout, so postgres.js queues a statement forever when every
 *     connection is busy. `cancel()` removes it from that queue and rejects it
 *     `57014`, entirely client-side. No statement was ever sent, so there is
 *     nothing left running to collide with the next section.
 *   - **Executing on a connection** (`query.active`) — `cancel()` opens a
 *     PostgreSQL CancelRequest connection and kills the backend statement. That
 *     covers a statement blocked acquiring a lock, which is the shape PEN-3305
 *     found most consistent with the evidence (connections permanently `active`
 *     with nothing queued). The statement dies in the server; a transaction
 *     around it rolls back.
 *
 * Either way the promise rejects, the rejection propagates out through `fn`,
 * and the lock is released by the `finally` that was already in
 * `runExclusively`. The next section starts only after that, because
 * `runExclusively` never stops awaiting `execution`.
 *
 * ## What it does not cover
 *
 * Awaits that are not database work. The Kubernetes call in the section
 * (`hasActiveJobForAgent`) carries its own timeout, but an unbounded socket or
 * an in-process promise that never settles would still wedge the section. That
 * residue is reported, not rescued: the escalating `error` log and
 * `paperclip_agent_start_lock_held_seconds` from PEN-3305 remain the detector,
 * and `describeAgentStartLockDispatchHealth` reports `stalled` rather than
 * `aborted` when a requested abort does not land.
 */

/** The postgres.js surface drizzle's postgres-js driver actually calls. */
type CancellableQuery = PromiseLike<unknown> & { cancel?: () => unknown };
type PostgresClient = {
  unsafe: (...args: unknown[]) => CancellableQuery;
  begin?: (...args: unknown[]) => unknown;
  savepoint?: (...args: unknown[]) => unknown;
};

const WRAPPED = Symbol.for("paperclip.agentStartLockAbortableClient");

function isPostgresClient(value: unknown): value is PostgresClient {
  return typeof value === "function"
    && typeof (value as unknown as PostgresClient).unsafe === "function";
}

/**
 * The reason an aborted section's signal carries, as an `Error`.
 *
 * `AbortController#abort(reason)` accepts anything, so normalize here rather
 * than letting a non-`Error` reason escape into a rejection and lose its stack.
 */
function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason;
  return new Error(typeof reason === "string" ? reason : "Agent start lock section aborted");
}

/**
 * Wrap one postgres.js client so statements issued inside an aborted (or
 * aborting) dispatch section are cancelled.
 *
 * Reentrant by design: `begin`/`savepoint` hand their callback a *different*,
 * connection-scoped client, and drizzle issues the transaction's statements
 * through that one — so an unwrapped inner client would make every transactional
 * statement, including the advisory-lock acquisition in `lockIssueOwnership`,
 * silently uncancellable. Each nested client is wrapped by the same factory.
 */
function wrapClient<T extends object>(client: T): T {
  if (!isPostgresClient(client)) return client;
  if ((client as { [WRAPPED]?: boolean })[WRAPPED]) return client;

  const wrapCallbackArgs = (args: unknown[]): unknown[] =>
    args.map((arg) =>
      typeof arg === "function"
        // postgres.js accepts `begin(fn)` and `begin(options, fn)`, and passes
        // the scoped client as the callback's first argument in both shapes.
        ? (scoped: object, ...rest: unknown[]) =>
          (arg as (...a: unknown[]) => unknown)(wrapClient(scoped), ...rest)
        : arg);

  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === WRAPPED) return true;
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;

      if (prop === "unsafe") {
        return function unsafe(this: unknown, ...args: unknown[]) {
          const signal = currentAgentStartLockSignal();
          // Outside a dispatch section there is no signal and this wrapper is a
          // pass-through — which is the case for essentially all traffic.
          if (!signal) return (value as (...a: unknown[]) => unknown).apply(target, args);
          // Already aborted: refuse to start. Issuing the statement first and
          // cancelling it immediately would burn a pool slot the wedged agent's
          // recovery needs, and the rejection is identical either way.
          //
          // Throwing synchronously rather than returning a rejected thenable is
          // deliberate. Not every drizzle entry point is async —
          // `PostgresJsSession.query`/`queryObjects` return
          // `client.unsafe(...).values()` straight out of a sync method, and
          // `transaction` returns `client.begin(...)` the same way — so a
          // rejected thenable would have to also carry `.values()`/`.raw()` to
          // keep those chains intact, and would risk an unhandled rejection if
          // any caller discarded it. A synchronous throw needs neither: every
          // one of those paths is reached from inside the section's `async`
          // closure, so the throw becomes a rejection of `fn`, which is exactly
          // the outcome the lock is waiting for.
          if (signal.aborted) throw abortReason(signal);

          const query = (value as (...a: unknown[]) => CancellableQuery).apply(target, args);
          if (typeof query.cancel !== "function") return query;

          const onAbort = () => {
            // `cancel()` is best-effort by nature — for an executing statement
            // it dials a fresh connection, which can itself fail. Swallowing is
            // correct: the caller is already being torn down, and throwing from
            // an abort listener would surface as an unhandled rejection with
            // less information than the abort reason the section will see.
            try {
              query.cancel?.();
            } catch {
              /* best-effort */
            }
          };
          signal.addEventListener("abort", onAbort, { once: true });
          // Drop the listener when the statement settles, so a long section
          // issuing many statements does not accumulate them on one signal.
          //
          // Touching `.then()` here is safe despite postgres.js's Query
          // executing lazily on first `then`: `Query#handle()` defers the actual
          // dispatch by a microtask (`await 1`), and drizzle's
          // `client.unsafe(...).values()` runs synchronously on the value we
          // return. So `values()`/`raw()` still land before the statement is
          // built. (`Query[Symbol.species]` is `Promise`, so this branch is a
          // plain promise and cannot be mistaken for the query itself.)
          const detach = () => signal.removeEventListener("abort", onAbort);
          void Promise.resolve(query).then(detach, detach);
          return query;
        };
      }

      if (prop === "begin" || prop === "savepoint") {
        return function scoped(this: unknown, ...args: unknown[]) {
          const signal = currentAgentStartLockSignal();
          if (signal?.aborted) throw abortReason(signal);
          return (value as (...a: unknown[]) => unknown).apply(target, wrapCallbackArgs(args));
        };
      }

      // Everything else — `options`, `poolStats`, `end`, `reserve`, the tagged
      // template call — passes straight through to the real client.
      return value.bind(target);
    },
    apply(target, thisArg, args) {
      return Reflect.apply(target as unknown as (...a: unknown[]) => unknown, thisArg, args);
    },
  });
}

/**
 * Memoized per input handle.
 *
 * `heartbeatService` is constructed once per route/service factory, and there
 * are seven of those — all from the same `Db`. Without this, each would build
 * its own drizzle instance, and `drizzle()` runs
 * `extractTablesRelationalConfig` over the entire schema every time. Reusing
 * one wrapper per handle keeps that cost at one and keeps `db` reference-stable
 * across services built from the same handle, which matters because
 * `heartbeat.ts` compares an executor against `db` by identity
 * (`appendRunEvent`'s publish guard).
 */
const wrappedDbByHandle = new WeakMap<object, Db>();

/**
 * Return a `Db` whose statements are cancellable by the current dispatch
 * section's abort signal, or the input unchanged when that is not possible.
 *
 * Falls back to `db` whenever `$client` is absent or is not a postgres.js
 * handle — test doubles and `drizzle.mock()` both hit that path. Failing open
 * is the right default here: the wrapper is a liveness improvement, and a
 * process that refused to start because it could not install one would be a
 * strictly worse outcome than one that dispatches without it. The same
 * `$client` access pattern is already load-bearing in
 * `routes/issues.ts` (`withReservedCreateIssueAdvisoryDb`) and
 * `scrape-metrics-collector.ts` (`refreshDbPoolMetrics`).
 */
export function withAgentStartLockAbortableDb(db: Db): Db {
  const client = (db as Db & { $client?: unknown }).$client;
  if (!isPostgresClient(client)) return db;
  const cached = wrappedDbByHandle.get(db as object);
  if (cached) return cached;
  const wrapped = wrapClient(client as object);
  if (wrapped === client) return db;
  const wrappedDb = createDbFromPostgresClient(
    wrapped as Parameters<typeof createDbFromPostgresClient>[0],
  );
  wrappedDbByHandle.set(db as object, wrappedDb);
  return wrappedDb;
}
