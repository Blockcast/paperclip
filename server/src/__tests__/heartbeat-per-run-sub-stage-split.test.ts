import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
 * PEN-4783: `per_run` must be attributable to a named class of work.
 *
 * `per_run` is one lap over ~700 lines and ~28 awaits in nested branches with
 * no interior dimension, so every sweep-slow episode localized to `per_run` and
 * stopped there -- under at least two DIFFERENT faults. On 2026-10-19 phase A
 * it went x1088 while all six sibling stages stayed within +/-30% of baseline
 * (`list_jobs`, the kube LIST, at x1.04, which is what ruled kube out); on
 * 2026-10-25 a 301.95 s `per_run` mean moved in LOCKSTEP with `list_jobs` x96.6
 * while Postgres moved x5.6, the opposite reading. The label said `per_run`
 * both times, and the responder's runbook had to say localization stops there.
 *
 * Two independent properties are pinned here, and they fail for different
 * reasons, which is why they are separate cases:
 *
 *  1. EXHAUSTIVENESS. The four attributed sub-stages plus `per_run_other` sum
 *     to `per_run` exactly. Without the residual, time in the un-instrumented
 *     glue between the wrapped calls lands in NO bucket, and a responder reads
 *     four small numbers and concludes "nothing is slow" -- a false negative,
 *     strictly worse than the honest dead end this split replaces.
 *  2. ATTRIBUTION. A slow call inside the loop lands in its OWN bucket rather
 *     than in the residual. Property 1 cannot see this: it holds by
 *     construction even if every wrap were deleted, because `per_run_other` is
 *     a complement and would simply absorb the lot.
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
const {
  ORPHAN_REAP_STAGE_SECONDS_METRIC,
  __resetMetricsForTest,
  renderMetrics,
} = await import("../services/metrics.js");

/**
 * The four ATTRIBUTED buckets, in report order. `per_run_other` is deliberately
 * NOT in this list: it is the complement of these four, so including it here
 * would double-count it into its own residual.
 */
const ATTRIBUTED_SUB_STAGES = [
  "per_run_liveness",
  "per_run_finalize",
  "per_run_dispatch",
  "per_run_cleanup",
] as const;

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping per_run sub-stage split tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/**
 * How long the mocked kube probe blocks the loop, in ms. Large enough that it
 * cannot be confused with scheduler noise on a loaded CI box, small enough to
 * keep the case fast.
 */
const SLOW_PROBE_MS = 120;

describeEmbeddedPostgres("per_run sub-stage split (PEN-4783)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-per-run-split-");
    db = createDb(tempDb.connectionString);
  });

  beforeEach(() => {
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
   * One external-lifecycle agent holding one long-stale `running` run that
   * never reached `adapter.invoke`.
   *
   * Pre-adapter and stale is what routes the row through
   * `resolveExternalLifecycleJobLiveness`, and `externalRunId` with an EMPTY
   * managed-job list is what makes that helper fall through to the by-name
   * confirmation -- the mocked call this test times. Both are load-bearing: a
   * row that is merely `running` takes an early `continue` and spends no
   * measurable time in any sub-stage.
   */
  async function seedStalePreAdapterRun() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const staleAt = new Date(Date.now() - 6 * 60 * 60 * 1000);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Agent 0",
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
      createdAt: staleAt,
      startedAt: staleAt,
      updatedAt: staleAt,
    });
    return { companyId, agentId, runId };
  }

  /** Parsed `{stage -> {count, sum}}` for the orphan-reap stage histogram. */
  async function readStageSamples() {
    const { body } = await renderMetrics();
    const read = (suffix: "count" | "sum", stage: string) => {
      const prefix = `${ORPHAN_REAP_STAGE_SECONDS_METRIC}_${suffix}{`;
      const line = body
        .split("\n")
        .find((candidate) => candidate.startsWith(prefix) && candidate.includes(`stage="${stage}"`));
      return line ? Number(line.trim().split(/\s+/).pop()) : null;
    };
    return {
      count: (stage: string) => read("count", stage),
      sum: (stage: string) => read("sum", stage),
    };
  }

  /**
   * Property 1 -- EXHAUSTIVENESS.
   *
   * Asserted as a conjunction rather than split further: "the sub-stages are
   * reported" alone would pass on a tree whose residual silently dropped the
   * unattributed remainder, and "they sum to the parent" alone would pass on a
   * tree that reported nothing but the residual.
   */
  it("reports the four sub-stages and a residual that together account for per_run exactly", async () => {
    await seedStalePreAdapterRun();
    const heartbeat = heartbeatService(db);
    __resetMetricsForTest();

    await heartbeat.reapOrphanedRuns({ suppressDispatchAfterReap: true });

    const stage = await readStageSamples();

    // One sample per sweep for every sub-stage, matching `per_run`'s own
    // granularity. A per-call series would carry agent-shaped cardinality in
    // all but name, and could not be compared against `per_run` directly.
    for (const subStage of [...ATTRIBUTED_SUB_STAGES, "per_run_other"]) {
      expect(stage.count(subStage), `${subStage} sample count`).toBe(1);
    }
    expect(stage.count("per_run")).toBe(1);

    // ...and the aggregate still measures the SAME lap it always did, so every
    // `per_run` series recorded before this split stays comparable. This is
    // what makes the change additive rather than a rename.
    const perRun = stage.sum("per_run");
    const attributed = ATTRIBUTED_SUB_STAGES
      .map((subStage) => stage.sum(subStage) ?? 0)
      .reduce((total, value) => total + value, 0);
    const residual = stage.sum("per_run_other") ?? 0;

    // EXACT, not approximate: the residual is a complement taken at the same
    // instant that closes the lap, so there is no clock read between the two
    // for drift to enter through. `toBeCloseTo` at 6 digits is sub-microsecond
    // and only absorbs float division by 1000.
    expect(attributed + residual).toBeCloseTo(perRun ?? 0, 6);
    expect(residual).toBeGreaterThanOrEqual(0);
  });

  /**
   * Property 2 -- ATTRIBUTION, and the case that actually discriminates.
   *
   * MUTATION-TESTED: dropping the `timePerRunSubStage` wrap from
   * `resolveExternalLifecycleJobLiveness` -- and changing nothing else -- turns
   * this red, because the 120 ms moves out of `per_run_liveness` and into the
   * residual that absorbs whatever the wraps do not claim.
   */
  it("attributes a slow in-loop kube probe to its own sub-stage, not to the residual", async () => {
    await seedStalePreAdapterRun();
    readAgentJobRunStatusByNameMock.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, SLOW_PROBE_MS));
      return null;
    });
    const heartbeat = heartbeatService(db);
    __resetMetricsForTest();

    await heartbeat.reapOrphanedRuns({ suppressDispatchAfterReap: true });

    // The fixture is only meaningful if the row actually reached the probe.
    expect(readAgentJobRunStatusByNameMock).toHaveBeenCalled();

    const stage = await readStageSamples();
    const liveness = stage.sum("per_run_liveness") ?? 0;
    const residual = stage.sum("per_run_other") ?? 0;

    // Floored well under SLOW_PROBE_MS so a slow CI box cannot flake it, while
    // still being unreachable if the probe were unattributed (the residual
    // would hold it and this would read ~0).
    expect(liveness).toBeGreaterThanOrEqual((SLOW_PROBE_MS * 0.5) / 1000);
    // The second half of the discrimination: the time is in `per_run_liveness`
    // INSTEAD of the residual, not merely also in it.
    expect(residual).toBeLessThan(liveness);
  });
});
