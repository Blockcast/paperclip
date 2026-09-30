import { describe, expect, it, vi } from "vitest";
import plugin from "../worker.js";

// BLO-23143: three `Important` concurrency findings Ally raised on
// Blockcast/paperclip#996 merged to master unaddressed. Each test below is a
// regression for one of them and fails against the pre-fix worker.ts.
//
// The state mock deliberately yields on every `get`, which is what a real
// `ctx.state` backed by an RPC round-trip does. That is the whole point: the
// findings are about interleaving at `await` points, so a synchronous mock
// would hide every one of them.

const stateId = (key: {
  scopeKind: string;
  scopeId: string;
  stateKey: string;
}) => `${key.scopeKind}:${key.scopeId}:${key.stateKey}`;

/** Yield to the macrotask queue so concurrent handlers genuinely interleave. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

interface MkCtxOptions {
  companies?: Array<{ id: string }>;
  companyConfigs?: Record<string, Record<string, unknown>>;
  secrets?: Record<string, string>;
  state?: Record<string, unknown>;
  /** Throw from `ctx.issues.list` for these company ids. */
  failIssuesListFor?: string[];
  /** When set, `ctx.agents.invoke` blocks on this promise. */
  invokeGate?: Promise<void>;
  /** Called on each `ctx.agents.invoke`. */
  onInvoke?: () => void;
  /**
   * Reject a `ctx.state` call. Called for every get/set/delete with the flat
   * state id and the operation, so an outage modelled here is **not**
   * key-selective the way a single-key `vi.fn` override is — which matters,
   * because a real backend outage does not pick keys (BLO-28764).
   */
  stateFailWhen?: (stateKey: string, op: "get" | "set" | "delete") => boolean;
  /**
   * Reject `ctx.metrics.write`. Independent of `stateFailWhen` because a
   * telemetry backend is a different system from the state backend — the whole
   * point of BLO-29663 is that a metrics blip must not reprocess a batch.
   */
  failMetricsWrite?: boolean;
}

const mkCtx = (options: MkCtxOptions = {}) => {
  const {
    companies = [],
    companyConfigs = {},
    secrets = {},
    state = {},
    failIssuesListFor = [],
    invokeGate,
    onInvoke,
    stateFailWhen,
    failMetricsWrite = false,
  } = options;
  const storedState = new Map(Object.entries(state));
  const registeredJobs = new Map<string, (...args: unknown[]) => unknown>();
  // A real host fans an event out to every listener. `cost_event.created` has
  // two (the cost accumulator and the watch-queue producer), so a Map keyed by
  // event type would silently drop one of them.
  const eventHandlers = new Map<
    string,
    Array<(...args: unknown[]) => Promise<unknown>>
  >();
  const postedMessages: Array<{ channel: string }> = [];

  const ctx: any = {
    config: {
      get: vi.fn(async (companyId?: string) => {
        await tick();
        return companyId ? (companyConfigs[companyId] ?? {}) : {};
      }),
    },
    secrets: {
      resolve: vi.fn(async (ref: string) => {
        const value = secrets[ref];
        if (value === undefined) throw new Error(`no such secret: ${ref}`);
        return value;
      }),
    },
    companies: { list: vi.fn(async () => companies) },
    jobs: {
      register: vi.fn((jobKey: string, fn: (...args: unknown[]) => unknown) => {
        registeredJobs.set(jobKey, fn);
      }),
    },
    events: {
      on: vi.fn(
        (eventType: string, fn: (...args: unknown[]) => Promise<unknown>) => {
          const existing = eventHandlers.get(eventType) ?? [];
          existing.push(fn);
          eventHandlers.set(eventType, existing);
        },
      ),
    },
    state: {
      get: vi.fn(async (key: Parameters<typeof stateId>[0]) => {
        await tick();
        if (stateFailWhen?.(stateId(key), "get")) {
          throw new Error(`state backend unavailable: get ${stateId(key)}`);
        }
        return storedState.get(stateId(key)) ?? null;
      }),
      set: vi.fn(async (key: Parameters<typeof stateId>[0], value: unknown) => {
        // Writes are a round-trip too, so the store is not updated the instant
        // a caller decides to write. That gap is precisely where a second
        // reader still sees the stale value — model it, or the mock serializes
        // the handlers by accident and hides the very bug under test.
        await tick();
        if (stateFailWhen?.(stateId(key), "set")) {
          throw new Error(`state backend unavailable: set ${stateId(key)}`);
        }
        storedState.set(stateId(key), value);
      }),
      delete: vi.fn(async (key: Parameters<typeof stateId>[0]) => {
        await tick();
        if (stateFailWhen?.(stateId(key), "delete")) {
          throw new Error(`state backend unavailable: delete ${stateId(key)}`);
        }
        storedState.delete(stateId(key));
      }),
    },
    issues: {
      list: vi.fn(async ({ companyId }: { companyId: string }) => {
        if (failIssuesListFor.includes(companyId)) {
          throw new Error(`simulated host failure for ${companyId}`);
        }
        return [];
      }),
    },
    agents: {
      list: vi.fn(async () => []),
      invoke: vi.fn(async () => {
        onInvoke?.();
        if (invokeGate) await invokeGate;
        return { runId: "run-1" };
      }),
    },
    http: {
      fetch: vi.fn(async (_url: string, init?: { body?: string }) => {
        if (init?.body) {
          try {
            const parsed = JSON.parse(init.body) as { channel?: string };
            if (parsed.channel)
              postedMessages.push({ channel: parsed.channel });
          } catch {
            /* non-JSON bodies are not chat.postMessage calls */
          }
        }
        return {
          status: 200,
          headers: new Headers(),
          json: async () => ({ ok: true, ts: "123.456" }),
        };
      }),
    },
    metrics: {
      write: vi.fn(async () => {
        await tick();
        if (failMetricsWrite) throw new Error("metrics backend unavailable");
      }),
    },
    tools: { register: vi.fn() },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  };
  return { ctx, registeredJobs, eventHandlers, storedState, postedMessages };
};

/** Fan an event out to every registered listener, as the host does. */
const emit = (
  eventHandlers: Map<string, Array<(...a: unknown[]) => Promise<unknown>>>,
  eventType: string,
  companyId: string,
  payload: Record<string, unknown> = {},
) =>
  Promise.all(
    (eventHandlers.get(eventType) ?? []).map((fn) =>
      fn({ eventType, companyId, entityId: "entity-1", payload }),
    ),
  );

const watchQueueKey = (companyId: string) =>
  `company:${companyId}:recent-watch-events`;

describe("daily-digest per-company isolation (BLO-23143 finding 1)", () => {
  it("still posts for later companies when an earlier company throws", async () => {
    // Two tenants, first one's host call fails. Pre-fix the throw escapes the
    // `for (const company of companies)` loop, so company-b — and every tenant
    // after it — silently loses its digest.
    const { ctx, registeredJobs, postedMessages } = mkCtx({
      companies: [{ id: "isolation-a" }, { id: "isolation-b" }],
      companyConfigs: {
        "isolation-a": {
          slackTokenRef: "tok",
          enableDailyDigest: true,
          defaultChannelId: "C-A",
        },
        "isolation-b": {
          slackTokenRef: "tok",
          enableDailyDigest: true,
          defaultChannelId: "C-B",
        },
      },
      secrets: { tok: "xoxb-token" },
      failIssuesListFor: ["isolation-a"],
    });

    await plugin.definition.setup(ctx);
    const digest = registeredJobs.get("daily-digest");
    expect(digest).toBeTypeOf("function");

    // The job as a whole must survive one tenant's failure.
    await expect(digest!()).resolves.toBeUndefined();

    // company-b got its digest despite company-a blowing up first.
    expect(postedMessages.map((m) => m.channel)).toContain("C-B");
    // ...and the failure was surfaced rather than swallowed silently.
    expect(ctx.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("Daily digest failed for company"),
      expect.objectContaining({ companyId: "isolation-a" }),
    );
  });
});

describe("cost accumulator atomicity (BLO-23143 finding 3)", () => {
  it("loses no increments when cost events arrive concurrently", async () => {
    const companyId = "cost-race-co";
    const { ctx, eventHandlers, storedState } = mkCtx({
      companies: [{ id: companyId }],
      companyConfigs: {
        [companyId]: { slackTokenRef: "tok", enableDailyDigest: true },
      },
      secrets: { tok: "xoxb-token" },
    });

    await plugin.definition.setup(ctx);

    // Five events, each $1, delivered together — the shape of a busy company.
    // Pre-fix every handler reads the same total across its `await` and the
    // last `set` wins, so the digest reports $1 instead of $5.
    const EVENTS = 5;
    await Promise.all(
      Array.from({ length: EVENTS }, () =>
        emit(eventHandlers, "cost_event.created", companyId, {
          cost: 1,
          agentName: "agent-x",
        }),
      ),
    );

    const dateKey = new Date().toISOString().slice(0, 10);
    expect(storedState.get(`company:${companyId}:daily-cost-${dateKey}`)).toBe(
      EVENTS,
    );
    expect(
      storedState.get(`company:${companyId}:daily-agent-costs-${dateKey}`),
    ).toEqual({ "agent-x": EVENTS });
  });
});

describe("watch-event queue integrity (BLO-23143 finding 2)", () => {
  it("keeps every event when appends race each other", async () => {
    const companyId = "watch-append-co";
    const { ctx, eventHandlers, storedState } = mkCtx({
      companies: [{ id: companyId }],
      companyConfigs: { [companyId]: { slackTokenRef: "tok" } },
      secrets: { tok: "xoxb-token" },
    });

    await plugin.definition.setup(ctx);

    // Two watchable events for one company, concurrently. Pre-fix both read
    // the same array and the second `set` overwrites the first — one event
    // vanishes with no error anywhere.
    await Promise.all([
      emit(eventHandlers, "issue.created", companyId, { id: "issue-1" }),
      emit(eventHandlers, "issue.updated", companyId, { id: "issue-2" }),
    ]);

    const queue = storedState.get(watchQueueKey(companyId)) as Array<{
      eventType: string;
    }>;
    expect(queue.map((e) => e.eventType).sort()).toEqual([
      "issue.created",
      "issue.updated",
    ]);
  });

  it("does not destroy events that arrive while the drain is processing", async () => {
    const companyId = "watch-drain-co";
    let releaseInvoke!: () => void;
    const invokeGate = new Promise<void>((resolve) => {
      releaseInvoke = resolve;
    });
    let invoked!: () => void;
    const invokeStarted = new Promise<void>((resolve) => {
      invoked = resolve;
    });

    const { ctx, registeredJobs, eventHandlers, storedState } = mkCtx({
      companies: [{ id: companyId }],
      companyConfigs: { [companyId]: { slackTokenRef: "tok" } },
      secrets: { tok: "xoxb-token" },
      invokeGate,
      onInvoke: invoked,
      state: {
        // One registered watch so the drain does real work...
        "instance:global:global-watches-list": [
          {
            id: "watch-1",
            companyId,
            eventPattern: "issue.created",
            prompt: "look at {{id}}",
            agentId: "agent-1",
            channelId: "C-WATCH",
            createdAt: new Date().toISOString(),
            triggerCount: 0,
          },
        ],
        // ...against one already-queued event.
        [watchQueueKey(companyId)]: [
          { eventType: "issue.created", payload: { id: "issue-early" } },
        ],
      },
    });

    await plugin.definition.setup(ctx);
    const checkWatchesJob = registeredJobs.get("check-watches");
    expect(checkWatchesJob).toBeTypeOf("function");

    // Start the drain and let it get as far as invoking the watch's agent.
    const jobPromise = checkWatchesJob!();
    await invokeStarted;

    // A new event lands mid-processing — exactly the window in which the
    // pre-fix `await checkWatches(...)` then `set([])` sequence wipes it.
    await emit(eventHandlers, "issue.created", companyId, { id: "issue-late" });

    releaseInvoke();
    await jobPromise;

    const queue = (storedState.get(watchQueueKey(companyId)) ?? []) as Array<{
      payload: { id?: string };
    }>;
    expect(queue.map((e) => e.payload.id)).toEqual(["issue-late"]);
  });

  it("re-queues the drained batch when processing fails", async () => {
    // Draining before processing (the fix above) means a failure mid-flight
    // would drop the batch, where the old read-then-clear order left it in
    // place. Losing events on error instead of on success is not a fix, so
    // the batch must come back.
    //
    // Note checkWatches swallows per-watch failures itself, so the error has
    // to come from something it does NOT catch — here the watch-registry read.
    const companyId = "watch-retry-co";
    const { ctx, registeredJobs, storedState } = mkCtx({
      companies: [{ id: companyId }],
      companyConfigs: { [companyId]: { slackTokenRef: "tok" } },
      secrets: { tok: "xoxb-token" },
      state: {
        [watchQueueKey(companyId)]: [
          { eventType: "issue.created", payload: { id: "issue-doomed" } },
        ],
      },
    });

    await plugin.definition.setup(ctx);

    // Fail only the watch-registry read, and only after setup. The re-queue
    // path itself still needs a working store.
    const realGet = ctx.state.get;
    ctx.state.get = vi.fn(async (key: Parameters<typeof stateId>[0]) => {
      if (stateId(key) === "instance:global:global-watches-list") {
        throw new Error("state backend unavailable");
      }
      return realGet(key);
    });

    await expect(
      registeredJobs.get("check-watches")!(),
    ).resolves.toBeUndefined();

    const queue = (storedState.get(watchQueueKey(companyId)) ?? []) as Array<{
      payload: { id?: string };
    }>;
    expect(queue.map((e) => e.payload.id)).toEqual(["issue-doomed"]);
    expect(ctx.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("re-queued"),
      expect.objectContaining({ companyId }),
    );
  });
});

// BLO-28764: the re-queue added above is itself unguarded `ctx.state` I/O, and
// `checkWatches` swallows every per-watch failure internally — so the only
// throws that reach it come from the watch-registry state calls. It therefore
// runs almost exclusively when the state backend is unhealthy, and "recover by
// writing to the backend that just failed" rethrows on exactly those occasions.
//
// The test above is green for the wrong reason: its mock rejects only the key
// `instance:global:global-watches-list`, so the re-queue always finds a working
// store. A real outage is not key-selective. These two use `stateFailWhen`,
// which sees every key.
describe("check-watches state-outage resilience (BLO-28764)", () => {
  const watchFor = (companyId: string) => ({
    id: `watch-${companyId}`,
    companyId,
    eventPattern: "issue.created",
    prompt: "look at {{id}}",
    agentId: "agent-1",
    channelId: `C-${companyId}`,
    createdAt: new Date().toISOString(),
    triggerCount: 0,
  });

  it("keeps the drained batch and processes later companies when a tenant's state backend is down", async () => {
    // Outage across *every* key of company-a — get and set alike. The drain's
    // `set([])` fails with the rest, so the batch is never actually removed and
    // nothing is lost. What the pre-change shape gets wrong is the blast radius:
    // the rejection escapes the per-company loop, so the whole job rejects and
    // company-b is denied its watch notifications for the tick.
    const { ctx, registeredJobs, storedState, postedMessages } = mkCtx({
      companies: [{ id: "outage-a" }, { id: "outage-b" }],
      companyConfigs: {
        "outage-a": { slackTokenRef: "tok" },
        "outage-b": { slackTokenRef: "tok" },
      },
      secrets: { tok: "xoxb-token" },
      state: {
        "instance:global:global-watches-list": [watchFor("outage-b")],
        [watchQueueKey("outage-a")]: [
          { eventType: "issue.created", payload: { id: "issue-a" } },
        ],
        [watchQueueKey("outage-b")]: [
          { eventType: "issue.created", payload: { id: "issue-b" } },
        ],
      },
      stateFailWhen: (key) => key.startsWith("company:outage-a:"),
    });

    await plugin.definition.setup(ctx);
    await expect(
      registeredJobs.get("check-watches")!(),
    ).resolves.toBeUndefined();

    // Criterion 1: the events queued at drain time are still queued.
    expect(
      (storedState.get(watchQueueKey("outage-a")) as Array<{
        payload: { id?: string };
      }>).map((e) => e.payload.id),
    ).toEqual(["issue-a"]);
    // Criterion 2: the later tenant was not skipped.
    expect(postedMessages.map((m) => m.channel)).toContain("C-outage-b");
    expect(ctx.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("continuing with remaining companies"),
      expect.objectContaining({ companyId: "outage-a" }),
    );
  });

  it("logs the unrecoverable batch and keeps going when the backend dies after the swap", async () => {
    // The narrow window Ally described: the backend is healthy enough to
    // complete the atomic swap, then refuses everything. The batch is already
    // out of the queue and cannot be written back to a store that is rejecting
    // writes — it is genuinely unrecoverable. Pre-change that rejection escapes
    // the loop and the batch vanishes with no log at all; the requirement here
    // is that it is named out loud and that company-b still gets its tick.
    let swapped = false;
    let requeueRefused = false;
    const { ctx, registeredJobs, storedState, postedMessages } = mkCtx({
      companies: [{ id: "midtick-a" }, { id: "midtick-b" }],
      companyConfigs: {
        "midtick-a": { slackTokenRef: "tok" },
        "midtick-b": { slackTokenRef: "tok" },
      },
      secrets: { tok: "xoxb-token" },
      state: {
        "instance:global:global-watches-list": [watchFor("midtick-b")],
        [watchQueueKey("midtick-a")]: [
          { eventType: "issue.created", payload: { id: "issue-doomed" } },
        ],
        [watchQueueKey("midtick-b")]: [
          { eventType: "issue.created", payload: { id: "issue-b" } },
        ],
      },
      stateFailWhen: (key, op) => {
        // Let the swap's reset land, then open the outage.
        if (!swapped) {
          if (key === watchQueueKey("midtick-a") && op === "set")
            swapped = true;
          return false;
        }
        // Refuse until the re-queue read has been turned away — the partition
        // heals after that, so company-b's tick is unaffected.
        if (requeueRefused) return false;
        if (key === watchQueueKey("midtick-a") && op === "get")
          requeueRefused = true;
        return true;
      },
    });

    await plugin.definition.setup(ctx);
    await expect(
      registeredJobs.get("check-watches")!(),
    ).resolves.toBeUndefined();

    // The honest residual, asserted rather than glossed: this batch is lost.
    expect(storedState.get(watchQueueKey("midtick-a"))).toEqual([]);
    // Criterion 4: lost loudly, with the company id and the size of the loss.
    expect(ctx.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("could not be re-queued"),
      expect.objectContaining({
        companyId: "midtick-a",
        droppedEventCount: 1,
      }),
    );
    // Criterion 2: and the next tenant still ran.
    expect(postedMessages.map((m) => m.channel)).toContain("C-midtick-b");
  });
});

// BLO-29663: the re-queue above was documented as "a deliberate at-most-once
// choice". It was not — it was at-least-once, on a path that spends money.
//
// `checkWatches` only reaches `setAllWatches` and `ctx.metrics.write` when
// `triggered > 0`, i.e. once `agents.invoke` and `postMessage` have already
// committed. Both sat outside the per-watch try/catch, so a rejection from
// either arrived at the re-queue with the side effects already done and the
// next tick paid for them again. A telemetry write failure alone was enough.
//
// The fix makes `checkWatches` distinguish pre- from post-delivery failure, so
// the re-queue fires only when nothing was delivered. Both directions below.
describe("check-watches delivery guarantee (BLO-29663)", () => {
  const watchFor = (companyId: string) => ({
    id: `watch-${companyId}`,
    companyId,
    eventPattern: "issue.created",
    prompt: "look at {{id}}",
    agentId: "agent-1",
    channelId: `C-${companyId}`,
    createdAt: new Date().toISOString(),
    triggerCount: 0,
  });

  const mkWatchCtx = (companyId: string, extra: MkCtxOptions = {}) =>
    mkCtx({
      companies: [{ id: companyId }],
      companyConfigs: { [companyId]: { slackTokenRef: "tok" } },
      secrets: { tok: "xoxb-token" },
      state: {
        "instance:global:global-watches-list": [watchFor(companyId)],
        [watchQueueKey(companyId)]: [
          { eventType: "issue.created", payload: { id: "issue-paid-for" } },
        ],
      },
      ...extra,
    });

  it("does not reprocess the batch when only the metrics write fails", async () => {
    // A telemetry blip is the cheapest possible failure and used to have the
    // most expensive consequence: the whole batch re-queued, and every agent in
    // it invoked a second time on the next tick.
    const companyId = "metrics-blip-co";
    const { ctx, registeredJobs, storedState, postedMessages } = mkWatchCtx(
      companyId,
      { failMetricsWrite: true },
    );

    await plugin.definition.setup(ctx);
    const job = registeredJobs.get("check-watches")!;
    await expect(job()).resolves.toBeUndefined();

    // The delivery itself happened, exactly once.
    expect(ctx.agents.invoke).toHaveBeenCalledTimes(1);
    expect(postedMessages.map((m) => m.channel)).toEqual([`C-${companyId}`]);
    // The batch is consumed: a telemetry failure is not a reason to retry it.
    expect(storedState.get(watchQueueKey(companyId))).toEqual([]);
    // ...and the dropped sample is visible without being escalated.
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("watch-trigger metric"),
      expect.objectContaining({ companyId }),
    );

    // The consequence that actually costs money: a second tick must not pay
    // for the same watch again. Pre-fix this reaches 2.
    await expect(job()).resolves.toBeUndefined();
    expect(ctx.agents.invoke).toHaveBeenCalledTimes(1);
  });

  it("does not re-queue when the registry write fails after delivery", async () => {
    // The post-delivery shape: agents invoked, Slack posted, then the
    // watch-registry write fails. Re-queueing here buys back the undelivered
    // tail at the price of duplicating everything already delivered.
    const companyId = "post-delivery-co";
    const { ctx, registeredJobs, storedState } = mkWatchCtx(companyId, {
      stateFailWhen: (key, op) =>
        key === "instance:global:global-watches-list" && op === "set",
    });

    await plugin.definition.setup(ctx);
    const job = registeredJobs.get("check-watches")!;
    await expect(job()).resolves.toBeUndefined();

    expect(ctx.agents.invoke).toHaveBeenCalledTimes(1);
    // Not re-queued — and the loss is named out loud rather than implied.
    expect(storedState.get(watchQueueKey(companyId))).toEqual([]);
    expect(ctx.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("avoid duplicate agent invocations"),
      expect.objectContaining({
        companyId,
        deliveredCount: 1,
        droppedEventCount: 1,
      }),
    );

    await expect(job()).resolves.toBeUndefined();
    expect(ctx.agents.invoke).toHaveBeenCalledTimes(1);
  });

  it("still re-queues when the failure precedes any delivery", async () => {
    // The counter-direction, and the reason this is a distinction rather than
    // just "stop re-queueing": the registry *read* fails, so nothing was
    // invoked or posted. That batch is safe to retry and must be.
    const companyId = "pre-delivery-co";
    const { ctx, registeredJobs, storedState, postedMessages } = mkWatchCtx(
      companyId,
      {
        stateFailWhen: (key, op) =>
          key === "instance:global:global-watches-list" && op === "get",
      },
    );

    await plugin.definition.setup(ctx);
    await expect(
      registeredJobs.get("check-watches")!(),
    ).resolves.toBeUndefined();

    // Nothing was delivered...
    expect(ctx.agents.invoke).not.toHaveBeenCalled();
    expect(postedMessages).toEqual([]);
    // ...so the batch is still there to be retried.
    expect(
      (storedState.get(watchQueueKey(companyId)) as Array<{
        payload: { id?: string };
      }>).map((e) => e.payload.id),
    ).toEqual(["issue-paid-for"]);
    expect(ctx.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("re-queued"),
      expect.objectContaining({ companyId }),
    );
  });
});
