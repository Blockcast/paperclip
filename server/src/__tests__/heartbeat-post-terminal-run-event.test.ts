import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRunEvents } from "@paperclipai/db";
import type { AdapterRuntimeEvent } from "@paperclipai/adapter-utils";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.ts";
import {
  getMetricsRegistry,
  HEARTBEAT_POST_TERMINAL_RUN_EVENT_DROPPED_METRIC,
} from "../services/metrics.js";
import { getHeartbeatRunRuntimeStatus } from "../services/heartbeat-run-runtime-status.ts";
import { logger } from "../middleware/logger.js";
import { REDACTED_EVENT_VALUE } from "../redaction.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { cleanupHeartbeatTestState } from "./helpers/cleanup-heartbeat-test-state.js";
import { waitForRunToFinish } from "./helpers/wait-for-run-to-finish.js";

/**
 * 20s was observed to be too tight on a loaded host — a run took ~68s to finish
 * and the poll gave up first, failing on `status === "running"` and reading as a
 * guard bug rather than as a slow machine. The enclosing `it` timeout is 120s and
 * this only polls, so waiting longer costs nothing when the host is healthy.
 */
const RUN_FINISH_TIMEOUT_MS = 90_000;

vi.mock("../telemetry.ts", () => ({ getTelemetryClient: () => ({ track: vi.fn() }) }));

const { heartbeatService } = await import("../services/heartbeat.ts");

const TEST_ADAPTER = "post_terminal_run_event_test";

/**
 * A distinctive, greppable fixture value that must not survive redaction.
 *
 * Named `LEAK_CANARY` rather than anything containing key/token/secret/password/
 * credential **on purpose**: the repo's `secret-scan` rule
 * (`.github/scripts/check-pr-security.mjs`) flags any identifier containing one
 * of those stems that is assigned a quoted literal of 20+ characters. It is a
 * name-and-length rule, not an entropy one — despite the flag reading
 * "High-entropy secret" — so `const LEAK_CANARY = "<long string>"` trips it
 * whatever the value looks like. Renaming keeps this file clean without
 * weakening the assertions or obfuscating the payload keys under test.
 *
 * The rule's separator is `[=:]`, so it matches an **object key** just as
 * readily as an `=` assignment: `{ api_key: "<20+ chars>" }` would trip it too.
 * This file stays clean only because every stem-bearing payload key
 * (`api_key`, `access_token`) is assigned the `LEAK_CANARY` *identifier* rather
 * than a quoted literal. Keep it that way — inlining the string at any of those
 * keys re-plants the false positive this rename removed.
 */
const LEAK_CANARY = "redaction-fixture-value-must-not-reach-the-log";

/**
 * Sum {@link HEARTBEAT_POST_TERMINAL_RUN_EVENT_DROPPED_METRIC} for one terminal
 * status label, or across all statuses when omitted.
 */
async function droppedCount(status?: string): Promise<number> {
  const metric = getMetricsRegistry().getSingleMetric(
    HEARTBEAT_POST_TERMINAL_RUN_EVENT_DROPPED_METRIC,
  );
  if (!metric) return 0;
  const data = (await metric.get()) as {
    values: Array<{ labels: Record<string, string>; value: number }>;
  };
  return data.values
    .filter((entry) => (status ? entry.labels.status === status : true))
    .reduce((sum, entry) => sum + entry.value, 0);
}

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres post-terminal run event tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

/**
 * BLO-32553: `onAdapterEvent` must not append to a run that has already reached a
 * terminal status.
 *
 * `onEvent` is contractually valid only for the duration of `adapter.execute`. An
 * adapter that fires it from a continuation outliving execute() — the orphan-kill
 * path — previously appended to the terminal run. The damage is not only a stray
 * row: `appendRunEvent`'s publish() gates its runtime-status write on the stale
 * in-memory run snapshot ("running"), so a late append also resurrected the
 * runtime status that terminalization had just cleared.
 *
 * These tests hold the adapter's `onEvent` past execute() and fire it after the
 * run is terminal — the exact case the existing suites do not cover, since they
 * assert on-time ordering only.
 */
describeEmbeddedPostgres("post-terminal adapter run events (BLO-32553)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let capturedOnEvent: ((event: AdapterRuntimeEvent) => Promise<void>) | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-post-terminal-event-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);

    registerServerAdapter({
      type: TEST_ADAPTER,
      execute: async (ctx: { onEvent?: (event: AdapterRuntimeEvent) => Promise<void> }) => {
        // Hold the callback past execute() the way a detached kill timer would.
        capturedOnEvent = ctx.onEvent ?? null;
        // One on-time event, so the no-regression assertion has something to pin.
        await ctx.onEvent?.({
          eventType: "test.on_time",
          stream: "system",
          level: "info",
          message: "delivered while the adapter was still executing",
          payload: { ontime: true },
        });
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          errorMessage: null,
          // Non-empty so the run is not reclassified EMPTY_RESULT by isEmptyResult().
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
  }, 120_000);

  afterEach(async () => {
    capturedOnEvent = null;
    await cleanupHeartbeatTestState(db, heartbeat, {
      errorLabel: "post-terminal run event cleanup",
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
      name: `PostTerminal ${agentId.slice(0, 8)}`,
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
      })
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, runId))
      .orderBy(asc(heartbeatRunEvents.seq));
  }

  /**
   * Snapshot the run's events once the run has stopped producing them.
   *
   * `waitForRunToFinish` polls the run's *status*, but finalization writes that
   * status **before** appending the terminal `lifecycle` event ("run succeeded")
   * — `setRunStatus` then `appendRunEvent` in heartbeat.ts's finalize path. So a
   * snapshot taken the instant the status flips can race the run's own last
   * legitimate events, which makes the "event list unchanged" assertions below
   * flaky rather than wrong: they would report a late-arriving *on-time* event
   * as though the guard had let the late one through.
   *
   * Settles on quiescence rather than on one named event type, so the on-time
   * anchor below is read after the run's own last legitimate event.
   *
   * NOTE: quiescence bounds the *run's* emissions, not the server's terminal
   * bookkeeping. `heartbeat.ts` appends "run scratch cleaned" from the scratch
   * cleanup path (`heartbeat.ts:30649`), gated on
   * `isHeartbeatRunTerminalStatus` — i.e. post-terminal is that event's
   * precondition, not a violation of it — and it lands whenever filesystem
   * cleanup finishes, which is unbounded relative to any quiet window. So do
   * NOT build "the event list is unchanged" assertions on this helper; use
   * {@link expectNoAdapterEventAppended}, which asserts the invariant the
   * guard actually provides.
   */
  async function snapshotSettledEvents(
    runId: string,
    { quietMs = 500, timeoutMs = 20_000 } = {},
  ) {
    const deadline = Date.now() + timeoutMs;
    let previousCount = -1;
    let stableSince = Date.now();
    for (;;) {
      const events = await readEvents(runId);
      if (events.length !== previousCount) {
        previousCount = events.length;
        stableSince = Date.now();
      } else if (Date.now() - stableSince >= quietMs) {
        return events;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `run ${runId} was still appending events after ${timeoutMs}ms (${events.length} so far)`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  /**
   * Assert the guard's actual contract: no *adapter-sourced* event reached the
   * terminal run, and nothing already recorded was mutated or reordered.
   *
   * Deliberately not `expect(after).toEqual(before)`. That asserts the run's
   * event list never grows post-terminalization, which is a stronger invariant
   * than this codebase holds and than the guard claims: the server's own
   * cleanup path legitimately appends "run scratch cleaned" *because* the run
   * is terminal (see {@link snapshotSettledEvents}). Whole-list equality
   * therefore fails on a correct guard whenever filesystem cleanup happens to
   * finish inside the assertion window — which is what red-lit
   * `General tests (server 1/4)` at head `7e89048` with a spurious `seq: 5`
   * "run scratch cleaned" row. The distinction is trusted producer (the
   * server's ordered finalize path) vs untrusted one (an out-of-band adapter
   * continuation); only the latter is what `onAdapterEvent` guards.
   */
  function expectNoAdapterEventAppended(
    before: Awaited<ReturnType<typeof readEvents>>,
    after: Awaited<ReturnType<typeof readEvents>>,
  ) {
    // Nothing already recorded was rewritten, dropped, or reordered. A prefix
    // check is sound because `readEvents` orders by `seq` and seq only ever
    // increases, so a legitimate late append can land at the tail and nowhere
    // else.
    expect(after.slice(0, before.length)).toEqual(before);
    // The exact late row we fired must be absent — named explicitly so a
    // failure here reads as "the guard leaked" rather than as a diff.
    expect(after.map((e) => e.eventType)).not.toContain("adapter.process.lifecycle");
    // And no adapter-sourced row of ANY type exists, since the guard is
    // event-type agnostic. Sound because TEST_ADAPTER's execute() emits exactly
    // one event (`test.on_time`) and never calls `onMeta` — so the server's own
    // `adapter.invoke` row (heartbeat.ts:28663) is never written here either,
    // and any `adapter.*` row would have to be a leak. If you teach the fake
    // adapter to call `onMeta`, this assertion needs the expected rows excluded
    // rather than deleting it.
    expect(after.filter((e) => e.eventType.startsWith("adapter."))).toEqual([]);
  }

  it(
    "drops a kill_signal delivered after the run reached a terminal status, and counts it",
    async () => {
      const { agentId } = await seedAgent();

      const run = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
      expect(run).not.toBeNull();
      const finished = await waitForRunToFinish(heartbeat, run!.id, RUN_FINISH_TIMEOUT_MS);
      expect(finished?.status).toBe("succeeded");

      // The on-time event persisted — this is the AC-3 no-regression anchor.
      // Snapshot only once the run has stopped emitting, so a late *on-time*
      // event cannot be misread below as the guard letting the late one through.
      const before = await snapshotSettledEvents(run!.id);
      expect(before.map((e) => e.eventType)).toContain("test.on_time");

      expect(capturedOnEvent).toBeTypeOf("function");
      const droppedBefore = await droppedCount("succeeded");

      // Fire the late, TRUTHFUL event the orphan path would emit, in the shape
      // the real producer uses: #1279's `emitLifecycle({stage:"kill_signal"})`
      // reaches the server as `adapter.process.lifecycle` with the stage on the
      // payload (claude-local `onProcessLifecycle`, execute.ts:1082-1100), not
      // as a bare `kill_signal` event type. The guard is deliberately
      // event-type agnostic, but the test should exercise the real shape.
      //
      // It must not throw: a rejected late event has to stay distinguishable at
      // the adapter callsite from a transport error, which does throw.
      await expect(
        capturedOnEvent!({
          eventType: "adapter.process.lifecycle",
          stream: "system",
          level: "warn",
          message: "claude_local process kill_signal",
          payload: { stage: "kill_signal", signal: "SIGKILL", processGroupId: 4242 },
        }),
      ).resolves.toBeUndefined();

      // The terminal run gained no adapter-sourced event, and its existing
      // rows are untouched.
      expectNoAdapterEventAppended(before, await readEvents(run!.id));

      // ...but the evidence is not lost: the drop was counted.
      expect(await droppedCount("succeeded")).toBe(droppedBefore + 1);

      // And the runtime status terminalization cleared was not resurrected.
      expect(getHeartbeatRunRuntimeStatus(run!.id)).toBeNull();
    },
    120_000,
  );

  it(
    "sanitizes the dropped event's message and payload before logging them",
    async () => {
      const { agentId } = await seedAgent();

      const run = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
      expect(run).not.toBeNull();
      const finished = await waitForRunToFinish(heartbeat, run!.id, RUN_FINISH_TIMEOUT_MS);
      expect(finished?.status).toBe("succeeded");
      expect(capturedOnEvent).toBeTypeOf("function");

      const warnSpy = vi.spyOn(logger, "warn");
      try {
        await expect(
          capturedOnEvent!({
            eventType: "adapter.process.lifecycle",
            stream: "system",
            level: "warn",
            message: "claude_local process kill_signal",
            payload: {
              stage: "kill_signal",
              signal: "SIGKILL",
              api_key: LEAK_CANARY,
              nested: { access_token: LEAK_CANARY },
            },
          }),
        ).resolves.toBeUndefined();

        const dropCall = warnSpy.mock.calls.find(
          (call) => typeof call[1] === "string" && call[1].includes("BLO-32553"),
        );
        expect(dropCall, "the drop path must emit its logger.warn").toBeDefined();

        const logged = dropCall![0] as { payload: Record<string, unknown> | null };

        // The secret-bearing keys are masked exactly as the storage path would
        // mask them. This is the regression this test exists for: the drop log is
        // the substitute for the row that is not written, so it must not be a
        // *less* redacted substitute.
        expect(logged.payload).toMatchObject({
          stage: "kill_signal",
          signal: "SIGKILL",
          api_key: REDACTED_EVENT_VALUE,
          nested: { access_token: REDACTED_EVENT_VALUE },
        });

        // Belt and braces: the raw credential must not survive anywhere in the
        // logged object, at any depth or under any key we did not think to assert.
        expect(JSON.stringify(dropCall![0])).not.toContain(LEAK_CANARY);
      } finally {
        warnSpy.mockRestore();
      }
    },
    120_000,
  );

  it(
    "drops the event and counts it under \"unknown\" when the status read itself fails",
    async () => {
      const { agentId } = await seedAgent();

      const run = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
      expect(run).not.toBeNull();
      const finished = await waitForRunToFinish(heartbeat, run!.id, RUN_FINISH_TIMEOUT_MS);
      expect(finished?.status).toBe("succeeded");
      expect(capturedOnEvent).toBeTypeOf("function");

      const before = await snapshotSettledEvents(run!.id);
      const unknownBefore = await droppedCount("unknown");
      const succeededBefore = await droppedCount("succeeded");

      // Force `readTerminalRunStatus` to throw. This is the only branch that
      // produces the "unknown" label, and — being a failure path guarding a
      // failure path — it is the one place a silent regression would not show
      // up in any other assertion here.
      //
      // Safe because the window is empty, NOT because the shape is selective:
      // the flag is set immediately before the late event and the first match
      // disarms it, and no other work runs in between. The shape check is only
      // a cheap narrowing — `select({ status })` is not unique to the guard
      // (heartbeat.ts has 7 single-key `{ status }` selects: :15625 the guard's
      // own, plus :16656, :20469, :26262, :30205, :32039, :33257). If you ever
      // add concurrent work to this window, this spy WILL hit the wrong query;
      // key it on the run id, don't just tighten the field list.
      let armed = true;
      const originalSelect = db.select.bind(db);
      const selectSpy = vi
        .spyOn(db, "select")
        .mockImplementation(((fields?: Record<string, unknown>) => {
          const isTerminalStatusRead =
            !!fields
            && typeof fields === "object"
            && Object.keys(fields).length === 1
            && "status" in fields;
          if (armed && isTerminalStatusRead) {
            armed = false;
            throw new Error("simulated status read failure");
          }
          return fields === undefined
            ? originalSelect()
            : originalSelect(fields as never);
        }) as never);

      try {
        // Still must not throw: the caller is a detached continuation, so an
        // escaping rejection would be an unhandled one.
        await expect(
          capturedOnEvent!({
            eventType: "adapter.process.lifecycle",
            stream: "system",
            level: "warn",
            message: "claude_local process kill_signal",
            payload: { stage: "kill_signal", signal: "SIGKILL" },
          }),
        ).resolves.toBeUndefined();
      } finally {
        selectSpy.mockRestore();
      }

      expect(armed, "the simulated failure must actually have fired").toBe(false);

      // Unverifiable status is treated as a drop, not as "not terminal".
      expectNoAdapterEventAppended(before, await readEvents(run!.id));
      // Counted under "unknown", so a read failure stays distinguishable from a
      // confirmed post-terminal drop rather than being folded into it.
      expect(await droppedCount("unknown")).toBe(unknownBefore + 1);
      expect(await droppedCount("succeeded")).toBe(succeededBefore);
      expect(getHeartbeatRunRuntimeStatus(run!.id)).toBeNull();
    },
    120_000,
  );

  it(
    "still persists on-time events in order, so the guard adds no on-path regression",
    async () => {
      const { agentId } = await seedAgent();

      const run = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
      expect(run).not.toBeNull();
      const finished = await waitForRunToFinish(heartbeat, run!.id, RUN_FINISH_TIMEOUT_MS);
      expect(finished?.status).toBe("succeeded");

      // Settled, so the ordering assertion covers the run's whole event stream
      // including the terminal lifecycle row, not just the prefix that had
      // landed by the time the status flipped.
      const events = await snapshotSettledEvents(run!.id);
      const onTime = events.filter((e) => e.eventType === "test.on_time");
      expect(onTime).toHaveLength(1);
      expect(onTime[0]!.message).toBe("delivered while the adapter was still executing");

      // Sequence numbers remain strictly increasing across the whole run.
      const seqs = events.map((e) => e.seq);
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
      expect(new Set(seqs).size).toBe(seqs.length);
    },
    120_000,
  );
});
