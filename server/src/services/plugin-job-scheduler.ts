/**
 * PluginJobScheduler — tick-based scheduler for plugin scheduled jobs.
 *
 * The scheduler is the central coordinator for all plugin cron jobs. It
 * periodically ticks (default every 30 seconds), queries the `plugin_jobs`
 * table for jobs whose `nextRunAt` has passed, dispatches `runJob` RPC calls
 * to the appropriate worker processes, records each execution in the
 * `plugin_job_runs` table, and advances the scheduling pointer.
 *
 * ## Responsibilities
 *
 * 1. **Tick loop** — A `setInterval`-based loop fires every `tickIntervalMs`
 *    (default 30s). Each tick scans for due jobs and dispatches them.
 *
 * 1a. **Per-company fan-out** — A due job dispatches once per company
 *    configured for the plugin (via `listConfigCompanyIds`), each call
 *    carrying its own `{ companyId }` invocation scope, rather than one
 *    process-wide call. A plugin configured by zero companies dispatches
 *    once with no company scope (instance-level job). Before this
 *    (BLO-20957) a plugin configured by more than one company got an
 *    unscoped dispatch and every company-scoped host call the job made was
 *    denied.
 *
 * 2. **Cron parsing & next-run calculation** — Uses the lightweight built-in
 *    cron parser ({@link parseCron}, {@link nextCronTick}) to compute the
 *    `nextRunAt` timestamp after each run or when a new job is registered.
 *
 * 3. **Overlap prevention** — Before dispatching a job, the scheduler checks
 *    for an existing `running` run for the same job. If one exists, the job
 *    is skipped for that tick.
 *
 * 4. **Job run recording** — Every execution creates a `plugin_job_runs` row:
 *    `queued` → `running` → `succeeded` | `failed`. Duration and error are
 *    captured.
 *
 * 5. **Lifecycle integration** — The scheduler exposes `registerPlugin()` and
 *    `unregisterPlugin()` so the host lifecycle manager can wire up job
 *    scheduling when plugins start/stop. On registration, the scheduler
 *    computes `nextRunAt` for all active jobs that don't already have one.
 *
 * @see PLUGIN_SPEC.md §17 — Scheduled Jobs
 * @see ./plugin-job-store.ts — Persistence layer
 * @see ./cron.ts — Cron parsing utilities
 */

import { and, eq, lte, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { pluginJobs, pluginJobRuns } from "@paperclipai/db";
import type { PluginJobRunTrigger } from "@paperclipai/shared";
import type { PluginJobStore } from "./plugin-job-store.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";
import { parseCron, nextCronTick, validateCron } from "./cron.js";
import { logger } from "../middleware/logger.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default interval between scheduler ticks (30 seconds). */
const DEFAULT_TICK_INTERVAL_MS = 30_000;

/** Default timeout for a runJob RPC call (5 minutes). */
const DEFAULT_JOB_TIMEOUT_MS = 5 * 60 * 1_000;

/** Maximum number of concurrent job executions across all plugins. */
const DEFAULT_MAX_CONCURRENT_JOBS = 10;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Options for creating a PluginJobScheduler.
 */
export interface PluginJobSchedulerOptions {
  /** Drizzle database instance. */
  db: Db;
  /** Persistence layer for jobs and runs. */
  jobStore: PluginJobStore;
  /** Worker process manager for RPC calls. */
  workerManager: PluginWorkerManager;
  /**
   * Enumerate the companies with saved configuration for a plugin. Scheduled
   * dispatch calls this once per due job and fans out to one `runJob` call
   * per configured company, each with its own host-issued invocation scope,
   * instead of a single process-wide dispatch that only ever worked for
   * exactly one configured company (BLO-20957).
   */
  listConfigCompanyIds: (pluginId: string) => Promise<string[]>;
  /** Interval between scheduler ticks in ms (default: 30s). */
  tickIntervalMs?: number;
  /** Timeout for individual job RPC calls in ms (default: 5min). */
  jobTimeoutMs?: number;
  /** Maximum number of concurrent job executions (default: 10). */
  maxConcurrentJobs?: number;
}

/**
 * Result of a manual job trigger.
 */
export interface TriggerJobResult {
  /**
   * The first created run ID.
   *
   * Retained for callers that predate the BLO-20957 per-company fan-out and
   * only ever expected one run. Prefer {@link TriggerJobResult.runIds}, which
   * is the complete set — a manual trigger on a plugin configured by six
   * companies now creates six runs, and this field names only one of them.
   */
  runId: string;
  /** Every run created by this trigger — one per company scope dispatched. */
  runIds: string[];
  /** The job ID that was triggered. */
  jobId: string;
}

/**
 * Diagnostic information about the scheduler.
 */
export interface SchedulerDiagnostics {
  /** Whether the tick loop is running. */
  running: boolean;
  /** Number of jobs currently executing. */
  activeJobCount: number;
  /** Set of job IDs currently in-flight. */
  activeJobIds: string[];
  /** Total number of ticks executed since start. */
  tickCount: number;
  /** Timestamp of the last tick (ISO 8601). */
  lastTickAt: string | null;
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

/**
 * The public interface of the job scheduler.
 */
export interface PluginJobScheduler {
  /**
   * Start the scheduler tick loop.
   *
   * Safe to call multiple times — subsequent calls are no-ops.
   */
  start(): void;

  /**
   * Stop the scheduler tick loop.
   *
   * In-flight job runs are NOT cancelled — they are allowed to finish
   * naturally. The tick loop simply stops firing.
   */
  stop(): void;

  /**
   * Register a plugin with the scheduler.
   *
   * Computes `nextRunAt` for all active jobs that are missing it. This is
   * typically called after a plugin's worker process starts and
   * `syncJobDeclarations()` has been called.
   *
   * @param pluginId - UUID of the plugin
   */
  registerPlugin(pluginId: string): Promise<void>;

  /**
   * Unregister a plugin from the scheduler.
   *
   * Cancels any in-flight runs for the plugin and removes tracking state.
   *
   * @param pluginId - UUID of the plugin
   */
  unregisterPlugin(pluginId: string): Promise<void>;

  /**
   * Manually trigger a specific job (outside of the cron schedule).
   *
   * Creates a run with `trigger: "manual"` and dispatches immediately,
   * respecting the overlap prevention check.
   *
   * @param jobId - UUID of the job to trigger
   * @param trigger - What triggered this run (default: "manual")
   * @returns The created run info
   * @throws {Error} if the job is not found, not active, or already running
   */
  triggerJob(jobId: string, trigger?: "manual" | "retry"): Promise<TriggerJobResult>;

  /**
   * Run a single scheduler tick immediately (for testing).
   *
   * @internal
   */
  tick(): Promise<void>;

  /**
   * Get diagnostic information about the scheduler state.
   */
  diagnostics(): SchedulerDiagnostics;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Create a new PluginJobScheduler.
 *
 * @example
 * ```ts
 * const scheduler = createPluginJobScheduler({
 *   db,
 *   jobStore,
 *   workerManager,
 *   listConfigCompanyIds: (pluginId) => pluginRegistry.listConfigCompanyIds(pluginId),
 * });
 *
 * // Start the tick loop
 * scheduler.start();
 *
 * // When a plugin comes online, register it
 * await scheduler.registerPlugin(pluginId);
 *
 * // Manually trigger a job
 * const { runId } = await scheduler.triggerJob(jobId);
 *
 * // On server shutdown
 * scheduler.stop();
 * ```
 */
export function createPluginJobScheduler(
  options: PluginJobSchedulerOptions,
): PluginJobScheduler {
  const {
    db,
    jobStore,
    workerManager,
    listConfigCompanyIds,
    tickIntervalMs = DEFAULT_TICK_INTERVAL_MS,
    jobTimeoutMs = DEFAULT_JOB_TIMEOUT_MS,
    maxConcurrentJobs = DEFAULT_MAX_CONCURRENT_JOBS,
  } = options;

  const log = logger.child({ service: "plugin-job-scheduler" });

  // -----------------------------------------------------------------------
  // State
  // -----------------------------------------------------------------------

  /** Timer handle for the tick loop. */
  let tickTimer: ReturnType<typeof setInterval> | null = null;

  /** Whether the scheduler is running. */
  let running = false;

  /** Set of job IDs currently being executed (for overlap prevention). */
  const activeJobs = new Set<string>();

  /** Total number of ticks since start. */
  let tickCount = 0;

  /** Timestamp of the last tick. */
  let lastTickAt: Date | null = null;

  /** Guard against concurrent tick execution. */
  let tickInProgress = false;

  // -----------------------------------------------------------------------
  // Core: tick
  // -----------------------------------------------------------------------

  /**
   * A single scheduler tick. Queries for due jobs and dispatches them.
   */
  async function tick(): Promise<void> {
    // Prevent overlapping ticks (in case a tick takes longer than the interval)
    if (tickInProgress) {
      log.debug("skipping tick — previous tick still in progress");
      return;
    }

    tickInProgress = true;
    tickCount++;
    lastTickAt = new Date();

    try {
      const now = new Date();

      // Query for jobs whose nextRunAt has passed and are active.
      // We include jobs with null nextRunAt since they may have just been
      // registered and need their first run calculated.
      const dueJobs = await db
        .select()
        .from(pluginJobs)
        .where(
          and(
            eq(pluginJobs.status, "active"),
            lte(pluginJobs.nextRunAt, now),
          ),
        );

      if (dueJobs.length === 0) {
        return;
      }

      log.debug({ count: dueJobs.length }, "found due jobs");

      // Dispatch each due job (respecting concurrency limits)
      const dispatches: Promise<void>[] = [];

      for (const job of dueJobs) {
        // Concurrency limit
        if (activeJobs.size >= maxConcurrentJobs) {
          log.warn(
            { maxConcurrentJobs, activeJobCount: activeJobs.size },
            "max concurrent jobs reached, deferring remaining jobs",
          );
          break;
        }

        // Overlap prevention: skip if this job is already running
        if (activeJobs.has(job.id)) {
          log.debug(
            { jobId: job.id, jobKey: job.jobKey, pluginId: job.pluginId },
            "skipping job — already running (overlap prevention)",
          );
          continue;
        }

        // Check if the worker is available
        if (!workerManager.isRunning(job.pluginId)) {
          log.debug(
            { jobId: job.id, pluginId: job.pluginId },
            "skipping job — worker not running",
          );
          continue;
        }

        // Validate cron expression before dispatching
        if (!job.schedule) {
          log.warn(
            { jobId: job.id, jobKey: job.jobKey },
            "skipping job — no schedule defined",
          );
          continue;
        }

        dispatches.push(dispatchJob(job));
      }

      if (dispatches.length > 0) {
        await Promise.allSettled(dispatches);
      }
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err.message : String(err) },
        "scheduler tick error",
      );
    } finally {
      tickInProgress = false;
    }
  }

  // -----------------------------------------------------------------------
  // Core: dispatch a single job
  // -----------------------------------------------------------------------

  /**
   * Dispatch a single due job — fan out to one company-scoped `runJob` call
   * per company configured for the plugin, then advance the schedule
   * pointer once the whole fan-out settles.
   *
   * Before BLO-20957 this made exactly one process-wide `runJob` call, which
   * only ever carried a company invocation scope when the plugin happened to
   * have exactly one configured company (`bootstrapCompanyId`). Any plugin
   * configured by more than one company got an unscoped dispatch, and every
   * company-scoped host call the job made (`ctx.issues.list`,
   * `ctx.config.get(companyId)`, ...) was denied with "company context is
   * required" — silently, because the RPC still "succeeded" up to that
   * denial and the failure only showed up as an ERROR log line.
   */
  async function dispatchJob(
    job: typeof pluginJobs.$inferSelect,
  ): Promise<void> {
    const { id: jobId, pluginId, jobKey } = job;
    const jobLog = log.child({ jobId, pluginId, jobKey });

    // Mark as active (overlap prevention) for the whole job across every
    // company dispatch, so a slow fan-out can't let the next tick pile a
    // second dispatch for the same job on top.
    activeJobs.add(jobId);

    try {
      let companyIds: string[];
      try {
        companyIds = await listConfigCompanyIds(pluginId);
      } catch (err) {
        // Fail CLOSED. Treating an enumeration error as "zero configured
        // companies" would fall through to a single unscoped dispatch, and
        // for a worker like alertmanager that dispatch returns normally
        // without doing any work — so a registry/DB outage would silently
        // skip every tenant while recording `succeeded`, feeding the health
        // signal the exact opposite of the truth. Record a failed run
        // instead: the schedule pointer still advances in `finally` (so the
        // job recovers on its own once the registry is healthy) but the
        // failure is visible to `listJobsWithFailureStreak` and pages if it
        // persists. The unscoped fallback below is reserved strictly for a
        // *successful* empty enumeration.
        const errorMessage = err instanceof Error ? err.message : String(err);
        jobLog.error(
          { err: errorMessage },
          "failed to enumerate configured companies for scheduled dispatch — failing closed, not dispatching",
        );
        await recordEnumerationFailure(job, errorMessage);
        return;
      }

      const dispatches = companyIds.length > 0
        ? companyIds.map((companyId) => dispatchJobRun(job, companyId, "schedule"))
        : [dispatchJobRun(job, null, "schedule")];

      await Promise.allSettled(dispatches);
    } finally {
      // Remove from active set
      activeJobs.delete(jobId);

      // Always advance the schedule pointer (even on failure)
      try {
        await advanceSchedulePointer(job);
      } catch (err) {
        jobLog.error(
          { err: err instanceof Error ? err.message : String(err) },
          "failed to advance schedule pointer",
        );
      }
    }
  }

  /**
   * Record a `failed` run for a tick that could not even determine which
   * companies to dispatch to.
   *
   * Without this the fail-closed path in {@link dispatchJob} would be
   * *invisible*: no run row at all means no failure for the streak detector
   * to see, so a registry outage would look exactly like a job that simply
   * wasn't due. The run is deliberately instance-scoped (`companyId: null`)
   * because the whole point is that the company set is unknown.
   *
   * Best-effort: if we cannot even write the run row (the same outage may
   * well be a DB outage), log and move on rather than throwing out of the
   * dispatch path and skipping the schedule-pointer advance.
   */
  async function recordEnumerationFailure(
    job: typeof pluginJobs.$inferSelect,
    errorMessage: string,
  ): Promise<void> {
    const jobLog = log.child({
      jobId: job.id,
      pluginId: job.pluginId,
      jobKey: job.jobKey,
    });
    try {
      const run = await jobStore.createRun({
        jobId: job.id,
        pluginId: job.pluginId,
        trigger: "schedule",
        companyId: null,
      });
      await jobStore.completeRun(run.id, {
        status: "failed",
        error: `Failed to enumerate configured companies: ${errorMessage}`,
        durationMs: 0,
      });
    } catch (err) {
      jobLog.error(
        { err: err instanceof Error ? err.message : String(err) },
        "failed to record company-enumeration failure run",
      );
    }
  }

  /**
   * Run one company-scoped (or instance-scoped, when `companyId` is `null`)
   * dispatch of `job`: create its own run record, call the worker with that
   * company stamped onto `job.companyId`, and record the result. Failures
   * are caught and recorded here, never rethrown, so one company's failure
   * in a fan-out cannot cancel the others (`Promise.allSettled` in
   * {@link dispatchJob} would already isolate them, but recording must not
   * depend on that).
   */
  async function dispatchJobRun(
    job: typeof pluginJobs.$inferSelect,
    companyId: string | null,
    trigger: PluginJobRunTrigger,
  ): Promise<void> {
    const { id: jobId, pluginId, jobKey } = job;
    const jobLog = log.child({ jobId, pluginId, jobKey, companyId });

    let runId: string | undefined;
    const startedAt = Date.now();

    try {
      // 1. Create run record, scoped to this company
      const run = await jobStore.createRun({
        jobId,
        pluginId,
        trigger,
        companyId,
      });
      runId = run.id;

      jobLog.info({ runId }, "dispatching scheduled job");

      // 2. Mark run as running
      await jobStore.markRunning(runId);

      // 3. Call worker via RPC, with this company as the invocation scope
      await workerManager.call(
        pluginId,
        "runJob",
        {
          job: {
            jobKey,
            runId,
            trigger,
            scheduledAt: (job.nextRunAt ?? new Date()).toISOString(),
            companyId,
          },
        },
        jobTimeoutMs,
      );

      // 4. Mark run as succeeded
      const durationMs = Date.now() - startedAt;
      await jobStore.completeRun(runId, {
        status: "succeeded",
        durationMs,
      });

      jobLog.info({ runId, durationMs }, "job completed successfully");
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      const errorMessage = err instanceof Error ? err.message : String(err);

      jobLog.error(
        { runId, durationMs, err: errorMessage },
        "job execution failed",
      );

      // Record the failure
      if (runId) {
        try {
          await jobStore.completeRun(runId, {
            status: "failed",
            error: errorMessage,
            durationMs,
          });
        } catch (completeErr) {
          jobLog.error(
            {
              runId,
              err: completeErr instanceof Error ? completeErr.message : String(completeErr),
            },
            "failed to record job failure",
          );
        }
      }
    }
  }

  // -----------------------------------------------------------------------
  // Core: manual trigger
  // -----------------------------------------------------------------------

  async function triggerJob(
    jobId: string,
    trigger: "manual" | "retry" = "manual",
  ): Promise<TriggerJobResult> {
    const job = await jobStore.getJobById(jobId);
    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }

    if (job.status !== "active") {
      throw new Error(
        `Job "${job.jobKey}" is not active (status: ${job.status})`,
      );
    }

    // Overlap prevention
    if (activeJobs.has(jobId)) {
      throw new Error(
        `Job "${job.jobKey}" is already running — cannot trigger while in progress`,
      );
    }

    // Also check DB for running runs (defensive — covers multi-instance)
    const existingRuns = await db
      .select()
      .from(pluginJobRuns)
      .where(
        and(
          eq(pluginJobRuns.jobId, jobId),
          eq(pluginJobRuns.status, "running"),
        ),
      );

    if (existingRuns.length > 0) {
      throw new Error(
        `Job "${job.jobKey}" already has a running execution — cannot trigger while in progress`,
      );
    }

    // Check worker availability
    if (!workerManager.isRunning(job.pluginId)) {
      throw new Error(
        `Worker for plugin "${job.pluginId}" is not running — cannot trigger job`,
      );
    }

    // Fan out per configured company, exactly like the scheduled path
    // (BLO-20957). Before this, a manual "run now" created a single run with
    // no `companyId`, so every worker that requires a company scope — which
    // is now the norm — returned early without doing any work while the run
    // was recorded as `succeeded`. A "run now" that reports success and does
    // nothing is worse than one that fails.
    let companyIds: string[];
    try {
      companyIds = await listConfigCompanyIds(job.pluginId);
    } catch (err) {
      // Fail closed, and loudly: this path is synchronous to an operator
      // clicking "run now", so surfacing the error beats dispatching an
      // unscoped no-op that looks like it worked.
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Cannot trigger job "${job.jobKey}": failed to enumerate configured companies: ${message}`,
      );
    }

    // A *successful* empty enumeration still gets one instance-scoped run —
    // some plugins legitimately have no company config and their jobs do
    // instance-wide work.
    const scopes: Array<string | null> =
      companyIds.length > 0 ? [...companyIds] : [null];

    // Create every run row up front so the caller gets the full set back
    // before dispatch begins.
    const runs = await Promise.all(
      scopes.map((companyId) =>
        jobStore.createRun({
          jobId,
          pluginId: job.pluginId,
          trigger,
          companyId,
        }),
      ),
    );

    const dispatchTargets = runs.map((run, index) => ({
      runId: run.id,
      companyId: scopes[index] ?? null,
    }));

    // Dispatch in background — don't block the caller
    void dispatchManualRuns(job, dispatchTargets, trigger);

    return {
      runId: runs[0]!.id,
      runIds: runs.map((run) => run.id),
      jobId,
    };
  }

  /**
   * Dispatch every run of a manual/retry fan-out, holding the job's
   * overlap-prevention slot for the whole set.
   *
   * `activeJobs` is added/removed once around the entire fan-out rather than
   * per run: the entries are keyed by `jobId`, so per-run bookkeeping would
   * let the first run to finish clear the slot while its siblings are still
   * executing, and the next tick could then pile a second dispatch on top.
   */
  async function dispatchManualRuns(
    job: typeof pluginJobs.$inferSelect,
    targets: Array<{ runId: string; companyId: string | null }>,
    trigger: "manual" | "retry",
  ): Promise<void> {
    activeJobs.add(job.id);
    try {
      await Promise.allSettled(
        targets.map((target) =>
          dispatchManualRun(job, target.runId, target.companyId, trigger),
        ),
      );
    } finally {
      activeJobs.delete(job.id);
    }
  }

  /**
   * Dispatch a single manually triggered job run, scoped to one company
   * (or instance-scoped when `companyId` is `null`).
   *
   * Overlap prevention is handled by the caller
   * ({@link dispatchManualRuns}), which holds the job's slot across the
   * whole fan-out.
   */
  async function dispatchManualRun(
    job: typeof pluginJobs.$inferSelect,
    runId: string,
    companyId: string | null,
    trigger: "manual" | "retry",
  ): Promise<void> {
    const { id: jobId, pluginId, jobKey } = job;
    const jobLog = log.child({
      jobId,
      pluginId,
      jobKey,
      runId,
      trigger,
      companyId,
    });

    const startedAt = Date.now();

    try {
      await jobStore.markRunning(runId);

      await workerManager.call(
        pluginId,
        "runJob",
        {
          job: {
            jobKey,
            runId,
            trigger,
            scheduledAt: new Date().toISOString(),
            // Stamp the company so the worker's job context carries a real
            // scope. Without this the handler's `job.companyId` guard trips
            // and the run is recorded `succeeded` having done nothing
            // (BLO-20957).
            companyId,
          },
        },
        jobTimeoutMs,
      );

      const durationMs = Date.now() - startedAt;
      await jobStore.completeRun(runId, {
        status: "succeeded",
        durationMs,
      });

      jobLog.info({ durationMs }, "manual job completed successfully");
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      const errorMessage = err instanceof Error ? err.message : String(err);
      jobLog.error({ durationMs, err: errorMessage }, "manual job failed");

      try {
        await jobStore.completeRun(runId, {
          status: "failed",
          error: errorMessage,
          durationMs,
        });
      } catch (completeErr) {
        jobLog.error(
          {
            err: completeErr instanceof Error ? completeErr.message : String(completeErr),
          },
          "failed to record manual job failure",
        );
      }
    }
  }

  // -----------------------------------------------------------------------
  // Schedule pointer management
  // -----------------------------------------------------------------------

  /**
   * Advance the `lastRunAt` and `nextRunAt` timestamps on a job after a run.
   */
  async function advanceSchedulePointer(
    job: typeof pluginJobs.$inferSelect,
  ): Promise<void> {
    const now = new Date();
    let nextRunAt: Date | null = null;

    if (job.schedule) {
      const validationError = validateCron(job.schedule);
      if (validationError) {
        log.warn(
          { jobId: job.id, schedule: job.schedule, error: validationError },
          "invalid cron schedule — cannot compute next run",
        );
      } else {
        const cron = parseCron(job.schedule);
        nextRunAt = nextCronTick(cron, now);
      }
    }

    await jobStore.updateRunTimestamps(job.id, now, nextRunAt);
  }

  /**
   * Ensure all active jobs for a plugin have a `nextRunAt` value.
   * Called when a plugin is registered with the scheduler.
   */
  async function ensureNextRunTimestamps(pluginId: string): Promise<void> {
    const jobs = await jobStore.listJobs(pluginId, "active");

    for (const job of jobs) {
      // Skip jobs that already have a valid nextRunAt in the future
      if (job.nextRunAt && job.nextRunAt.getTime() > Date.now()) {
        continue;
      }

      // Skip jobs without a schedule
      if (!job.schedule) {
        continue;
      }

      const validationError = validateCron(job.schedule);
      if (validationError) {
        log.warn(
          { jobId: job.id, jobKey: job.jobKey, schedule: job.schedule, error: validationError },
          "skipping job with invalid cron schedule",
        );
        continue;
      }

      const cron = parseCron(job.schedule);
      const nextRunAt = nextCronTick(cron, new Date());

      if (nextRunAt) {
        await jobStore.updateRunTimestamps(
          job.id,
          job.lastRunAt ?? new Date(0),
          nextRunAt,
        );
        log.debug(
          { jobId: job.id, jobKey: job.jobKey, nextRunAt: nextRunAt.toISOString() },
          "computed nextRunAt for job",
        );
      }
    }
  }

  // -----------------------------------------------------------------------
  // Plugin registration
  // -----------------------------------------------------------------------

  async function registerPlugin(pluginId: string): Promise<void> {
    log.info({ pluginId }, "registering plugin with job scheduler");
    await ensureNextRunTimestamps(pluginId);
  }

  async function unregisterPlugin(pluginId: string): Promise<void> {
    log.info({ pluginId }, "unregistering plugin from job scheduler");

    // Cancel any in-flight run records for this plugin that are still
    // queued or running. Active jobs in-memory will finish naturally.
    try {
      const runningRuns = await db
        .select()
        .from(pluginJobRuns)
        .where(
          and(
            eq(pluginJobRuns.pluginId, pluginId),
            or(
              eq(pluginJobRuns.status, "running"),
              eq(pluginJobRuns.status, "queued"),
            ),
          ),
        );

      for (const run of runningRuns) {
        await jobStore.completeRun(run.id, {
          status: "cancelled",
          error: "Plugin unregistered",
          durationMs: run.startedAt
            ? Date.now() - run.startedAt.getTime()
            : null,
        });
      }
    } catch (err) {
      log.error(
        {
          pluginId,
          err: err instanceof Error ? err.message : String(err),
        },
        "error cancelling in-flight runs during unregister",
      );
    }

    // Remove any active tracking for jobs owned by this plugin
    const jobs = await jobStore.listJobs(pluginId);
    for (const job of jobs) {
      activeJobs.delete(job.id);
    }
  }

  // -----------------------------------------------------------------------
  // Lifecycle: start / stop
  // -----------------------------------------------------------------------

  function start(): void {
    if (running) {
      log.debug("scheduler already running");
      return;
    }

    running = true;
    tickTimer = setInterval(() => {
      void tick();
    }, tickIntervalMs);

    log.info(
      { tickIntervalMs, maxConcurrentJobs },
      "plugin job scheduler started",
    );
  }

  function stop(): void {
    // Always clear the timer defensively, even if `running` is already false,
    // to prevent leaked interval timers.
    if (tickTimer !== null) {
      clearInterval(tickTimer);
      tickTimer = null;
    }

    if (!running) return;
    running = false;

    log.info(
      { activeJobCount: activeJobs.size },
      "plugin job scheduler stopped",
    );
  }

  // -----------------------------------------------------------------------
  // Diagnostics
  // -----------------------------------------------------------------------

  function diagnostics(): SchedulerDiagnostics {
    return {
      running,
      activeJobCount: activeJobs.size,
      activeJobIds: [...activeJobs],
      tickCount,
      lastTickAt: lastTickAt?.toISOString() ?? null,
    };
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  return {
    start,
    stop,
    registerPlugin,
    unregisterPlugin,
    triggerJob,
    tick,
    diagnostics,
  };
}
