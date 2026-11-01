import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

/**
 * BLO-51107: one per-run reap call past ORPHAN_REAP_SLOW_PER_RUN_CALL_MS (10 s)
 * must log a line naming the run and the call. The buckets only name the stage,
 * so without this line a sweep held >300 s by one run cannot be attributed.
 *
 * `readAgentJobRunStatusByName` is the slow call because it runs for every
 * started external-lifecycle run when the job list comes back empty, healthy or
 * not. Its mock advances `Date.now` -- the clock `timePerRun` reads -- so the
 * test does not sleep.
 */

const readAgentJobRunStatusByNameMock = vi.hoisted(() => vi.fn(async (): Promise<unknown> => null));

vi.mock("../services/k8s-job-liveness.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/k8s-job-liveness.js")>();
  return {
    ...actual,
    listManagedAgentJobs: vi.fn(async () => []),
    probeAgentPodActivity: vi.fn(async () => "idle"),
    // Named wrapper: the log's `call` field is the wrapped function's `.name`,
    // and a bare vi.fn() would report "spy".
    readAgentJobRunStatusByName: function readAgentJobRunStatusByName(...args: unknown[]) {
      return (readAgentJobRunStatusByNameMock as (...a: unknown[]) => Promise<unknown>)(...args);
    },
  };
});

const { heartbeatService } = await import("../services/heartbeat.js");
const { logger } = await import("../middleware/logger.js");

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const SLOW_CALL_MESSAGE = "reapOrphanedRuns: slow per-run call";

describeEmbeddedPostgres("orphan-reap slow per-run call log (BLO-51107)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let clockOffsetMs = 0;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("orphan-reap-slow-call-");
    db = createDb(tempDb.connectionString);
  });

  beforeEach(() => {
    clockOffsetMs = 0;
    const realNow = Date.now.bind(Date);
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + clockOffsetMs);
    readAgentJobRunStatusByNameMock.mockReset();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedStartedRun(): Promise<string> {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const now = new Date();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Agent",
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
    await db.insert(heartbeatRunEvents).values({
      companyId,
      runId,
      agentId,
      seq: 1,
      eventType: "adapter.invoke",
      message: "invoked",
    });
    return runId;
  }

  function slowCallLogs(warn: ReturnType<typeof vi.spyOn>) {
    return warn.mock.calls
      .filter((call: unknown[]) => call[1] === SLOW_CALL_MESSAGE)
      .map((call: unknown[]) => call[0] as Record<string, unknown>);
  }

  it("names the run and the call when one per-run call runs past the threshold", async () => {
    const warn = vi.spyOn(logger, "warn");
    readAgentJobRunStatusByNameMock.mockImplementation(async () => {
      clockOffsetMs += 11_000;
      return null;
    });
    const runId = await seedStartedRun();

    await heartbeatService(db).reapOrphanedRuns({ suppressDispatchAfterReap: true });

    expect(readAgentJobRunStatusByNameMock).toHaveBeenCalled();
    expect(slowCallLogs(warn)).toEqual([
      expect.objectContaining({
        runId,
        bucket: "liveness",
        call: "readAgentJobRunStatusByName",
        elapsedMs: expect.any(Number),
      }),
    ]);
    expect(slowCallLogs(warn)[0]!.elapsedMs).toBeGreaterThanOrEqual(11_000);
  });

  // Control: the same sweep with a fast call logs nothing, so the line above is
  // caused by the slow call and not emitted unconditionally.
  it("logs nothing when every per-run call is fast", async () => {
    const warn = vi.spyOn(logger, "warn");
    readAgentJobRunStatusByNameMock.mockResolvedValue(null);
    await seedStartedRun();

    await heartbeatService(db).reapOrphanedRuns({ suppressDispatchAfterReap: true });

    expect(readAgentJobRunStatusByNameMock).toHaveBeenCalled();
    expect(slowCallLogs(warn)).toEqual([]);
  });
});
