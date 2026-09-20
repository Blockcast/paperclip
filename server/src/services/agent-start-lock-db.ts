import { createDbFromPostgresClient, type Db } from "@paperclipai/db";

import { logger } from "../middleware/logger.js";
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
 * ## Where this is applied, and why not in `heartbeatService`
 *
 * At the composition root, in `index.ts`, on the handle returned by `createDb`.
 *
 * It was originally applied inside `heartbeatService`, which was wrong.
 * Installing the wrapper means rebuilding a `Db` from `$client`, and a rebuilt
 * `Db` carries none of the decoration a caller may have layered on the handle
 * it passed — a caller whose `Db` wraps `transaction` got a service that
 * silently ignored the wrapping and talked to the raw client instead. That is a
 * correctness hazard wherever it happens and it is invisible at the call site;
 * two rollback-behaviour tests caught it.
 *
 * Applying it at the root removes the hazard by construction: the wrap happens
 * before any `Db` exists, so there is no decoration to drop, and it happens
 * exactly once rather than once per service handle. Every `heartbeatService` in
 * the process is constructed from that root handle, so the dispatch section is
 * covered exactly as before.
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
 *
 * Also uncovered, and live: **a `cancel()` that does not take cannot be
 * retried.** Upstream's `Query#cancel()` was
 * `this.canceller && (this.canceller(this), this.canceller = null)`;
 * `patches/postgres@3.4.9.patch` keeps that self-disarm exactly — including its
 * order — while returning the canceller's promise, so what this repo ships is
 * `if (!this.canceller) return; …`. Read the patch, not upstream: it is this
 * team's file, and a change there making the handle re-armable would invalidate
 * this paragraph. Either shape disarms on the first call, so every later
 * `query.cancel?.()` returns without dialling — `undefined` patched, `null`
 * unpatched — and does nothing. The dial *is* the canceller, and it is spent.
 *
 * An earlier revision of this module retained in-flight queries in a
 * `WeakMap<AbortSignal, Set<Query>>` and re-issued `cancel()` on each lock tick.
 * That was removed rather than fixed, because it could not work: the branch it
 * was built for (`query.active` — the CancelRequest dial) is exactly the branch
 * that is inert on a second call, while the two branches that do not need it
 * already succeed synchronously (`!query.state` rejects `57014` client-side;
 * `state && !active` defers through `query.cancelled = { resolve, reject }`).
 * Worse than inert, it was misleading: the retained query only leaves the set
 * when it settles, so a wedged section accrued one phantom attempt per tick and
 * logged them as `cancelRetried: N` — reading as "we re-dialled N times", when
 * the truth was "we dialled once and have not tried since".
 *
 * A genuine retry needs a re-armable handle and postgres.js exposes none:
 * `query.state` and `Connection#cancel` are internal, and re-implementing the
 * CancelRequest dial against them would couple this module to driver internals
 * for a failure mode that reports `stalled` either way. So this is reported
 * rather than rescued, like the non-database awaits above — and
 * {@link cancelQuery} logs the failed dial so the operator can tell a cancel
 * that failed from a section that never observed one.
 * `agent-start-lock-db.test.ts` pins the self-disarm against a REAL `Query`
 * (built I/O-free, the way `db-pool-stats.test.ts` guards the other half of
 * this patch), so a future re-addition of a retry has a test that says why it
 * cannot work. A fake `cancel()` is re-armable and would hide exactly that.
 *
 * Also uncovered: **`reserve()` is a pass-through**, so a reserved client
 * obtained inside a section is unwrapped and its statements are uncancellable.
 * Nothing in dispatch reserves today — `routes/issues.ts` is the only caller and
 * it is not on this path — so this is latent rather than live, the same shape as
 * the tagged-template gap below. Wrap the resolved client the way
 * `wrapCallbackArgs` wraps `begin`'s scoped one if that changes.
 *
 * Also uncovered, and unlike the tagged template below this one is **live**:
 * a `begin`/`savepoint` call that hangs *before* it invokes its callback.
 * The wrapper pre-checks `signal.aborted` and then hands off to the real
 * client, but it registers nothing — the promise `begin` returns carries no
 * `cancel()` and so gets no abort listener, and `wrapCallbackArgs` only reaches
 * statements issued through the scoped client *after* the callback runs.
 * Connection acquisition is the instance that matters: `begin` takes a pool
 * slot before it can issue `BEGIN`, and with `max: 10` and no acquire timeout
 * that wait is unbounded — the same pool-exhaustion shape listed as *covered*
 * for `unsafe` above, and one of the two causes PEN-3305's evidence pointed at.
 * The dispatch section reaches this for real (`claimQueuedRun` wraps
 * `lockIssueOwnership` in `db.transaction`), so read the `unsafe` coverage above
 * as being about statements, not about every way this module touches the pool.
 *
 * It is left uncovered because the alternatives are worse, not because it is
 * unreachable. postgres.js returns a plain promise from `begin` with no
 * `cancel()`, so there is no handle to call; racing it against the signal would
 * reject the caller while the underlying reservation still resolves later,
 * leaking a connection and letting the *next* section's work overlap an
 * abandoned transaction — the abandon-rather-than-cancel shortcut this module
 * refuses everywhere else, and the BLO-20396 regression PEN-3328 exists not to
 * reintroduce. So this residue is reported rather than rescued, exactly like the
 * non-database awaits above: the abort is raised and does not land, the section
 * stays held, and `describeAgentStartLockDispatchHealth` reports `stalled`.
 * `agent-start-lock-db.test.ts` pins that behaviour with a `begin` that never
 * settles and never calls its callback.
 *
 * Also uncovered, deliberately: the **tagged-template call form**
 * (``client`select 1` ``). drizzle does not use it — it reaches the database
 * through the three methods named above — so a query issued that way carries no
 * cancellation listener and would be uncancellable inside a section. Nothing in
 * `server/src` issues one against `$client` today, so this is latent rather
 * than live, but a future raw tagged query would be silently exempt from the
 * abort. Route it through `unsafe` (or extend the `apply` trap) if that
 * changes.
 */

/** The postgres.js surface drizzle's postgres-js driver actually calls. */
type CancellableQuery = PromiseLike<unknown> & { cancel?: () => unknown };
type PostgresClient = {
  unsafe: (...args: unknown[]) => CancellableQuery;
  begin?: (...args: unknown[]) => unknown;
  savepoint?: (...args: unknown[]) => unknown;
};

const WRAPPED = Symbol.for("paperclip.agentStartLockAbortableClient");

/**
 * Issue `cancel()` on one in-flight statement, containing both ways it can fail.
 *
 * `cancel()` on an *executing* statement dials a fresh connection to send a
 * PostgreSQL CancelRequest, and that dial can fail. It fails **asynchronously**:
 * `Connection#cancel` (`src/connection.js:145-154`) is `async` and rejects on
 * two paths — `catch (error) { reject(error) }` around `connect()`, and
 * `socket.once('error', reject)` — rejecting the promise `index.js` `cancel(query)`
 * builds. A synchronous `try`/`catch` cannot see any of that.
 *
 * That promise must not be dropped. `server/src/process-crash-guard.ts` handles
 * `unhandledRejection` by logging and then **exiting the worker**, so a failed
 * cancel dial would trade one wedged agent for every agent's in-flight dispatch
 * — strictly worse than the `stalled` report this module otherwise falls back
 * to. Upstream drops it (`Query#cancel()` discards its canceller's return value
 * via a comma expression), so `patches/postgres@3.4.9.patch` returns it instead;
 * this is the handler that makes returning it worth anything.
 *
 * Both failures are swallowed rather than propagated, for the same reason: the
 * caller is already being torn down and has nothing useful to do with a failed
 * cancel. They are logged because a failed dial is the difference between
 * "aborted and recovered" and "aborted and still wedged", and the escalating
 * `error` line in `agent-start-lock.ts` reports only the latter's symptom.
 */
function cancelQuery(query: CancellableQuery, agentId: string | undefined): void {
  let pending: unknown;
  try {
    pending = query.cancel?.();
  } catch (error) {
    logger.warn({ err: error, agentId }, "agent start lock: cancelling a wedged statement threw");
    return;
  }
  // Present only with `patches/postgres@3.4.9.patch` applied. An unpatched
  // driver returns `null` on every path — armed or not, the comma expression's
  // value is the `this.canceller = null` assignment — so there is nothing to
  // attach to and nothing we can do. `isPromiseLike` rejects both shapes
  // identically, which is why the module still works with the patch dropped.
  if (!isPromiseLike(pending)) return;
  void Promise.resolve(pending).catch((error: unknown) => {
    logger.warn(
      { err: error, agentId },
      "agent start lock: the cancel request for a wedged statement failed to dial; "
      + "the section stays held and will report `stalled`",
    );
  });
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as { then?: unknown } | null | undefined)?.then === "function";
}

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
 * Which agent's section raised the abort, for log correlation only.
 *
 * `AgentStartLockAbortedError` carries `agentId`; read it structurally rather
 * than importing the class, so an abort raised with any other reason degrades
 * to `undefined` instead of throwing on the log path.
 */
function abortedAgentId(signal: AbortSignal): string | undefined {
  const agentId: unknown = (signal.reason as { agentId?: unknown } | null | undefined)?.agentId;
  return typeof agentId === "string" ? agentId : undefined;
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

  // Method wrappers, memoized per property. Every branch below builds a fresh
  // function — a closure for the three intercepted methods, a `bind` for the
  // pass-throughs — so without this cache `client.end !== client.end` and
  // likewise for `unsafe`/`begin`/`savepoint`. Nothing in drizzle compares
  // these by identity today, which is precisely why a regression would be
  // silent: anything that stored one to remove or compare later would quietly
  // hold a different function than the one it kept. Caching removes the hazard
  // and the per-access allocation together.
  //
  // Keyed by `prop` only, which is sound because the trap closes over one
  // `target`: a wrapper is a pure function of (target, prop, target[prop]), and
  // `target` is fixed for the life of this proxy. The third term is load-bearing
  // rather than pedantry — the cached closure captures `value` at build time, so
  // a method REASSIGNED on the client after its first read would stay masked by
  // the cache. Unreachable today: postgres.js assigns `unsafe`/`begin`/
  // `savepoint`/`end` once in `Postgres()` and never rebinds them.
  const methodByProp = new Map<PropertyKey, unknown>();

  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === WRAPPED) return true;
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;

      const memoized = methodByProp.get(prop);
      if (memoized !== undefined) return memoized;
      const built = buildMethod(target, prop, value as (...a: unknown[]) => unknown);
      methodByProp.set(prop, built);
      return built;
    },
    apply(target, thisArg, args) {
      return Reflect.apply(target as unknown as (...a: unknown[]) => unknown, thisArg, args);
    },
  });

  function buildMethod(target: T, prop: PropertyKey, value: (...a: unknown[]) => unknown): unknown {
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

        const onAbort = () => cancelQuery(query, abortedAgentId(signal));
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
        // NOTE: this is a pre-check, not cancellation. Once the real call is
        // under way nothing here can interrupt it — `begin` returns a plain
        // promise with no `cancel()`, and `wrapCallbackArgs` only takes effect
        // when the callback is invoked, i.e. after a pool slot is already held.
        // A hang in that acquisition is therefore uncancellable, and that is a
        // live gap rather than a theoretical one. See "What it does not cover"
        // in the module header for why racing it would be worse than leaving
        // it, and `agent-start-lock-db.test.ts` for the test that pins it.
        return (value as (...a: unknown[]) => unknown).apply(target, wrapCallbackArgs(args));
      };
    }

    // Everything else — `options`, `poolStats`, `end`, `reserve`, the tagged
    // template call — passes straight through to the real client.
    return value.bind(target);
  }
}

/**
 * Memoized per input handle, so calling this twice on one handle yields the
 * same `Db` rather than a second drizzle instance. `drizzle()` runs
 * `extractTablesRelationalConfig` over the whole schema on every construction,
 * and reference stability matters because `heartbeat.ts` compares an executor
 * against `db` by identity (`appendRunEvent`'s publish guard).
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
