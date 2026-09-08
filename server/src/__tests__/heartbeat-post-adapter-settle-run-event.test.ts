import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRunEvents } from "@paperclipai/db";
import type { AdapterRuntimeEvent } from "@paperclipai/adapter-utils";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.ts";
import { getHeartbeatRunRuntimeStatus } from "../services/heartbeat-run-runtime-status.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { cleanupHeartbeatTestState } from "./helpers/cleanup-heartbeat-test-state.js";

vi.mock("../telemetry.ts", () => ({ getTelemetryClient: () => ({ track: vi.fn() }) }));

const { heartbeatService } = await import("../services/heartbeat.ts");

const TEST_ADAPTER = "post_adapter_settle_event_test";

async function waitForRunToFinish(
  heartbeat: ReturnType<typeof heartbeatService>,
  runId: string,
  timeoutMs = 20_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (run && !["queued", "running"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return await heartbeat.getRun(runId);
}

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres post-adapter-settle run event tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

/**
 * PEN-3093 item 1, wiring level.
 *
 * `heartbeat-adapter-event-marker.test.ts` pins the two decisions as pure
 * functions: what the payload becomes, and whether the runtime-status write is
 * allowed. Neither can prove those functions are actually REACHED -- a correct
 * predicate that `appendRunEvent` never consults is a green unit suite and a
 * live defect, which is precisely how the runtime-status resurrection survived
 * the first round of this PR.
 *
 * So this file drives a real run to a terminal status and then fires the late
 * event the genuine-orphan path emits, holding the adapter's `onEvent` past
 * `execute()` the way a detached grace timer does. Three properties, none of
 * which a unit test can witness:
 *
 *  1. the event is KEPT -- it is truthful evidence of a leaked process tree,
 *     and losing it was the original defect (BLO-32477);
 *  2. it does not resurrect the runtime status terminalization cleared;
 *  3. it does not land on a sequence another row already holds. By the time it
 *     arrives the outcome pipeline has appended its own lifecycle events with
 *     `nextRunEventSeq` (`max(seq) + 1`), so this invocation's `seq` counter is
 *     stale-low; there is no unique constraint on `(run_id, seq)` to make a
 *     collision loud (BLO-19722).
 */
describeEmbeddedPostgres("post-adapter-settle adapter run events (PEN-3093)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let capturedOnEvent: ((event: AdapterRuntimeEvent) => Promise<void>) | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-post-adapter-settle-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);

    registerServerAdapter({
      type: TEST_ADAPTER,
      execute: async (ctx: { onEvent?: (event: AdapterRuntimeEvent) => Promise<void> }) => {
        // Hold the callback past execute() the way the timeout grace timer does.
        capturedOnEvent = ctx.onEvent ?? null;
        // One on-time event, so the marker assertions have a negative control
        // written by the same code path.
        await ctx.onEvent?.({
          eventType: "adapter.process.lifecycle",
          stream: "system",
          level: "info",
          message: "claude_local process spawned",
          payload: { stage: "spawned" },
        });
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          errorMessage: null,
          // Non-empty so the run is not reclassified EMPTY_RESULT.
          resultJson: { subtype: "success", is_error: false, result: "ok" },
          summary: "done",
          provider: "test",
          model: "test-model",
        };
      },
      testEnvironment: async () => ({
        adapterType: TEST_ADAPTER,
        status: "pass" as const,
        checks: [],
        testedAt: new Date().toISOString(),
      }),
    } as unknown as Parameters<typeof registerServerAdapter>[0]);
  }, 180_000);

  afterEach(async () => {
    capturedOnEvent = null;
    await cleanupHeartbeatTestState(db, heartbeat, {
      errorLabel: "post-adapter-settle run event cleanup",
      drainTimeoutMs: 30_000,
    });
  });

  afterAll(async () => {
    unregisterServerAdapter(TEST_ADAPTER);
    await tempDb?.cleanup();
  });

  async function seedAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `PostSettle ${agentId.slice(0, 8)}`,
      role: "engineer",
      status: "idle",
      adapterType: TEST_ADAPTER,
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    return { companyId, agentId };
  }

  function readEvents(runId: string) {
    return db
      .select({
        seq: heartbeatRunEvents.seq,
        eventType: heartbeatRunEvents.eventType,
        message: heartbeatRunEvents.message,
        payload: heartbeatRunEvents.payload,
      })
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, runId))
      .orderBy(asc(heartbeatRunEvents.seq));
  }

  /**
   * Reaching a terminal status does not mean the run has stopped appending: the
   * outcome pipeline writes its own lifecycle events afterwards. Without
   * waiting for that to quiesce, a "one row was added" assertion silently
   * measures a trailing lifecycle append instead of the late event -- which
   * makes it flaky in both directions, and would let the seq assertions below
   * pass or fail on scheduling rather than on the code under test.
   *
   * `quiesced` is returned rather than kept private because the timeout arm
   * cannot honour the contract: on a host slow enough never to observe two
   * equal-length reads it yields a baseline that is explicitly NOT quiescent.
   * Returning those rows bare would push that failure downstream, where it
   * resurfaces as a confusing seq or count comparison rather than as what it
   * is. Callers assert `quiesced` first, so exhausting the deadline fails as
   * "the helper never settled".
   */
  async function readEventsOnceQuiet(runId: string, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    let previous = await readEvents(runId);
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      const current = await readEvents(runId);
      if (current.length === previous.length) return { events: current, quiesced: true };
      previous = current;
    }
    return { events: previous, quiesced: false };
  }

  it(
    "keeps a post-settle kill_signal, marks it, and does not republish the run as live",
    async () => {
      const { agentId } = await seedAgent();

      const run = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
      expect(run).not.toBeNull();
      const finished = await waitForRunToFinish(heartbeat, run!.id);
      expect(finished?.status).toBe("succeeded");

      const { events: before, quiesced } = await readEventsOnceQuiet(run!.id);
      // Assert settlement before using the baseline: every assertion below is
      // relative to it, so a non-quiescent read would misattribute a trailing
      // append to the code under test.
      expect(quiesced).toBe(true);
      // Negative control: the on-time event went through the same shaping call
      // and carries no marker.
      const onTime = before.find((event) => event.message === "claude_local process spawned");
      expect(onTime).toBeDefined();
      expect(onTime!.payload).not.toHaveProperty("postAdapterSettle");

      // Terminalization cleared the runtime status. Establish that before
      // firing the late event, so a later `null` cannot be read as "the status
      // was never set in the first place".
      expect(getHeartbeatRunRuntimeStatus(run!.id)).toBeNull();

      expect(capturedOnEvent).toBeTypeOf("function");
      await capturedOnEvent!({
        eventType: "adapter.process.lifecycle",
        stream: "system",
        level: "warn",
        message: "claude_local process kill_signal",
        payload: { stage: "kill_signal", signal: "SIGKILL" },
      });

      const after = await readEvents(run!.id);

      // (1) The evidence is kept, exactly once. Asserted on the late event
      // itself rather than on `after.length`: quiescence is established by two
      // equal-length reads, which is the best signal available but still
      // cannot rule out a further trailing outcome-pipeline append -- two
      // equal reads can straddle a gap between two of them. So even with
      // `quiesced` asserted above, an exact total count would fail on
      // scheduling rather than on a regression. Uniqueness of the marked event
      // is the property this actually needs and it cannot be broken by a later
      // append.
      const lateMatches = after.filter((event) => event.message === "claude_local process kill_signal");
      expect(lateMatches).toHaveLength(1);
      expect(after.length).toBeGreaterThanOrEqual(before.length + 1);
      const late = lateMatches[0];
      expect(late).toBeDefined();
      expect(late!.payload).toMatchObject({
        stage: "kill_signal",
        signal: "SIGKILL",
        postAdapterSettle: true,
      });
      expect(typeof (late!.payload as Record<string, unknown>).adapterSettledAt).toBe("string");

      // (2) It did not resurrect the live-progress entry.
      expect(getHeartbeatRunRuntimeStatus(run!.id)).toBeNull();

      // (3) It did not land on a sequence another row already holds, and it
      // sorted after the finished run's stream rather than into the middle of
      // it. Compared against the maximum `before` sequence, not against
      // `max(after)`: a trailing outcome-pipeline append landing after this
      // event would legitimately take a higher number, which would fail a
      // `max(after)` assertion without the defect being present. "Above
      // everything that already existed" is the property that matters, and it
      // is the one the stale closure counter violated.
      const seqs = after.map((event) => event.seq);
      expect(new Set(seqs).size).toBe(seqs.length);
      expect(late!.seq).toBeGreaterThan(Math.max(...before.map((event) => event.seq)));
    },
    180_000,
  );

  it(
    "still persists on-time events in order, so the late-event branch adds no regression",
    async () => {
      const { agentId } = await seedAgent();

      const run = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
      expect(run).not.toBeNull();
      const finished = await waitForRunToFinish(heartbeat, run!.id);
      expect(finished?.status).toBe("succeeded");

      const { events, quiesced } = await readEventsOnceQuiet(run!.id);
      expect(quiesced).toBe(true);
      const onTime = events.filter((event) => event.message === "claude_local process spawned");
      expect(onTime).toHaveLength(1);

      const seqs = events.map((event) => event.seq);
      expect(seqs).toEqual([...seqs].sort((left, right) => left - right));
      expect(new Set(seqs).size).toBe(seqs.length);
    },
    180_000,
  );
});
