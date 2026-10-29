import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import {
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

/**
 * PEN-5006: the `adapter.invoke` existence probe must cost ONE round trip per
 * sweep, not one per running run.
 *
 * `per_run_liveness` is the sub-stage that carries the sweep's super-proportional
 * growth. Over seven same-clock-hour windows (2026-10-22..10-29, 20 m buckets,
 * window fixed effects, common band N in [6,28]) its SHARE of the sweep rises
 * with run population at d log(share)/d log(N) = +0.208 +- 0.045 -- the only
 * sub-stage with a positive reading that is both significant and sign-stable
 * across window sets. Per run it costs 11.6 ms at N in [6,12] against 17.2 ms at
 * N in [18,28].
 *
 * `hasAdapterInvocationEvent` was the only UNCONDITIONAL per-run round trip in
 * that bucket -- the other four liveness probes fire only once a run is already
 * past its grace window -- so it scaled 1:1 with run population while each
 * query's own latency grew with concurrency.
 *
 * Two properties are pinned, and they fail for different reasons:
 *
 *  1. SCALING. The probe count does not grow with run population. Asserted at
 *     two different populations rather than one, because "exactly one query" at
 *     a single population is also what a per-run implementation reports when
 *     that population happens to be one.
 *  2. SAFETY. A run the batch did NOT find is still re-checked individually.
 *     `heartbeat_run_events` is append-only, so a positive batch answer cannot
 *     go stale in the direction that matters, but a negative one can -- a run
 *     may reach `adapter.invoke` while this sweep is still walking the loop.
 *     Dropping that re-check would route a just-started run down the
 *     pre-adapter branch, and property 1 cannot see it: collapsing the `||` to
 *     the Set alone makes the probe count LOWER, so property 1 passes harder.
 */

const listManagedAgentJobsMock = vi.hoisted(() => vi.fn(async (): Promise<unknown[] | null> => []));
const readAgentJobRunStatusByNameMock = vi.hoisted(() => vi.fn(async (): Promise<unknown> => null));
const probeAgentPodActivityMock = vi.hoisted(() => vi.fn(async (): Promise<string> => "idle"));

vi.mock("../services/k8s-job-liveness.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/k8s-job-liveness.js")>();
  return {
    ...actual,
    listManagedAgentJobs: listManagedAgentJobsMock,
    readAgentJobRunStatusByName: readAgentJobRunStatusByNameMock,
    probeAgentPodActivity: probeAgentPodActivityMock,
  };
});

const { heartbeatService } = await import("../services/heartbeat.js");

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping adapter.invoke probe-batching tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

type RecordedQuery = { readonly sql: string; readonly params: readonly unknown[] };

/**
 * Wrap a {@link Db} so every `select(...).from(...)` it is asked for is
 * recorded, as rendered SQL plus bound parameters.
 *
 * Counted at the call the service makes rather than inside the driver, because
 * the driver is not reachable from this workspace -- `postgres` is a dependency
 * of `@paperclipai/db`, not of the server, and importing it here would be an
 * undeclared dependency of exactly the kind PEN-4930 swept out.
 *
 * It is still a ROUND-TRIP count and not a helper call-count: it reads the
 * statement the builder would send, so a refactor that kept one query per run
 * but moved it behind a different helper is caught all the same.
 *
 * Two drizzle behaviours this has to accommodate, both verified against
 * drizzle-orm 0.45.2:
 *   - `select()` returns a builder whose `from()` returns a DIFFERENT object;
 *     that second object is the one that is awaited, so it is the one to watch.
 *   - the chain methods after `from()` (`where`, `limit`, ...) return `this`,
 *     which would escape a naive proxy. Any method returning the raw target is
 *     re-wrapped so the chain stays observed all the way to `then`.
 */
function recordingDb(base: Db, sink: RecordedQuery[]): Db {
  const wrapQuery = (query: object): object => {
    const proxy: object = new Proxy(query, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (property === "then") {
          const rendered = (target as { toSQL?: () => RecordedQuery }).toSQL?.();
          if (rendered) sink.push({ sql: rendered.sql, params: [...rendered.params] });
        }
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          const result = (value as (...a: unknown[]) => unknown).apply(target, args);
          return result === target ? proxy : result;
        };
      },
    });
    return proxy;
  };

  return new Proxy(base, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property !== "select" || typeof value !== "function") {
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      }
      return (...selectArgs: unknown[]) => {
        const builder = (value as (...a: unknown[]) => object).apply(target, selectArgs);
        return new Proxy(builder, {
          get(builderTarget, builderProperty, builderReceiver) {
            const builderValue = Reflect.get(builderTarget, builderProperty, builderReceiver);
            if (builderProperty !== "from" || typeof builderValue !== "function") {
              return typeof builderValue === "function"
                ? (builderValue as (...a: unknown[]) => unknown).bind(builderTarget)
                : builderValue;
            }
            return (...fromArgs: unknown[]) =>
              wrapQuery((builderValue as (...a: unknown[]) => object).apply(builderTarget, fromArgs));
          },
        });
      };
    },
  }) as Db;
}

/** Statements that probe `heartbeat_run_events` for the `adapter.invoke` type. */
function adapterInvokeProbes(queries: readonly RecordedQuery[]): RecordedQuery[] {
  return queries.filter(
    (query) =>
      query.sql.includes("heartbeat_run_events") &&
      query.params.some((param) => param === "adapter.invoke"),
  );
}

describeEmbeddedPostgres("orphan-reap adapter.invoke probe batching (PEN-5006)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let recorded: RecordedQuery[] = [];
  let observedDb!: Db;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("orphan-reap-invoke-probe-");
    db = createDb(tempDb.connectionString);
    observedDb = recordingDb(db, recorded);
  });

  beforeEach(() => {
    recorded.length = 0;
    listManagedAgentJobsMock.mockReset();
    listManagedAgentJobsMock.mockResolvedValue([]);
    readAgentJobRunStatusByNameMock.mockReset();
    readAgentJobRunStatusByNameMock.mockResolvedValue(null);
    probeAgentPodActivityMock.mockReset();
    probeAgentPodActivityMock.mockResolvedValue("idle");
  });

  afterEach(async () => {
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  /**
   * `runCount` healthy external-lifecycle runs, each carrying `adapter.invoke`
   * unless `withInvokeEvent` says otherwise.
   *
   * Healthy and recent on purpose: a stale row reaches the finalize path, which
   * probes `adapter.invoke` again for its own `job_failed` / `job_missing`
   * diagnostics and would contaminate the count. The unconditional liveness
   * probe runs for every external-lifecycle row regardless of staleness, so a
   * healthy fleet still exercises the call site under test.
   */
  async function seedStartedRuns(runCount: number, options: { withInvokeEvent?: boolean } = {}) {
    const withInvokeEvent = options.withInvokeEvent ?? true;
    const companyId = randomUUID();
    const now = new Date();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    for (let index = 0; index < runCount; index += 1) {
      const agentId = randomUUID();
      const runId = randomUUID();
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: `Agent ${index}`,
        role: "engineer",
        status: "running",
        adapterType: "claude_k8s",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        status: "running",
        externalRunId: `agent-${agentId.slice(0, 8)}-run`,
        createdAt: now,
        startedAt: now,
        updatedAt: now,
        lastOutputAt: now,
        lastUsefulActionAt: now,
      });
      if (withInvokeEvent) {
        await db.insert(heartbeatRunEvents).values({
          companyId,
          runId,
          agentId,
          seq: 1,
          eventType: "adapter.invoke",
          message: "invoked",
        });
      }
    }
  }

  async function clearFleet() {
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  }

  /**
   * Property 1 -- SCALING.
   *
   * Six runs and one run must cost the same number of probes. The absolute
   * value matters less than the invariance: a per-run implementation reports
   * `runCount`, so it is the two populations that separate O(1) from O(N).
   */
  it("probes adapter.invoke once per sweep regardless of how many runs are active", async () => {
    const heartbeat = heartbeatService(observedDb);

    await seedStartedRuns(1);
    await heartbeat.reapOrphanedRuns({ suppressDispatchAfterReap: true });
    const queriesForOneRun = [...recorded];

    await clearFleet();
    recorded.length = 0;

    await seedStartedRuns(6);
    await heartbeat.reapOrphanedRuns({ suppressDispatchAfterReap: true });
    const queriesForSixRuns = [...recorded];

    // Positive control for the instrument itself. Without it a proxy that
    // silently stopped observing -- a drizzle upgrade changing what `from()`
    // returns, say -- would report zero probes at every population and pass
    // both assertions below while measuring nothing.
    expect(
      queriesForSixRuns.some((query) => query.sql.includes("heartbeat_runs")),
      "recording proxy observed no heartbeat_runs read; the instrument is broken, not the code",
    ).toBe(true);

    expect(adapterInvokeProbes(queriesForOneRun)).toHaveLength(1);
    expect(adapterInvokeProbes(queriesForSixRuns)).toHaveLength(1);
  });

  /**
   * Property 2 -- SAFETY.
   *
   * A run with no `adapter.invoke` row is a batch MISS, and a miss is the one
   * answer that can be stale, so it must still be confirmed individually: the
   * batch plus one re-check per un-invoked run.
   */
  it("still re-checks individually for a run the batch did not find", async () => {
    const heartbeat = heartbeatService(observedDb);

    await seedStartedRuns(2, { withInvokeEvent: false });
    await heartbeat.reapOrphanedRuns({ suppressDispatchAfterReap: true });

    // Asserted as a floor as well as a ceiling: `toBeGreaterThan(1)` alone
    // would also pass on an implementation that re-checked every run, which is
    // the defect this change removes.
    expect(adapterInvokeProbes(recorded)).toHaveLength(3);
  });
});
