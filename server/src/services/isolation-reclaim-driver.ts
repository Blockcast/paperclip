import type * as k8s from "@kubernetes/client-node";

import { logger as defaultLogger } from "../middleware/logger.js";
import {
  type IsolationReclaimJobManifest,
  type IsolationReclaimJobSpec,
  buildIsolationReclaimJobManifest,
} from "./isolation-reclaim-job.js";
import {
  type ReclaimJobPort,
  type ReclaimRunOutcome,
  runIsolationReclaimJob,
} from "./isolation-reclaim-runner.js";
import {
  DEFAULT_MAX_DELETES_PER_TICK,
  type IsolationReclaimExecutionResult,
  type IsolationReclaimPlan,
  type ReclaimableClaim,
  type WorkspaceUsageLookup,
  buildIsolationReclaimPlan,
} from "./isolation-workspace-reaper.js";

/**
 * Drive one foreign claim through inventory -> plan -> execute (PEN-5151).
 *
 * Everything under this module is a value: `buildIsolationReclaimPlan` decides
 * (#3184), the executor ends collect and unlink (#3186), the report is the wire
 * (#3189), the manifest is the Job (#3194), and `runIsolationReclaimJob` is the
 * one piece that acts without deciding (#3196). This module is the first that
 * does both — it reads a claim's tree through a Job, decides what may go, and
 * launches the Job that removes it.
 *
 * It owns exactly one claim. Enumerating the fleet (`listReclaimableClaims`),
 * scheduling, and the sweep-level counters are a level above, so the sequence
 * below stays assertable against a fake port with no cluster and no database.
 *
 * ## The sequence is one tick, and it never retries itself
 *
 * A plan is only valid for `DEFAULT_MAX_PLAN_AGE_MS` (10 minutes), so the
 * inventory and the execute that acts on it have to be the same tick — a daily
 * cadence that inventoried on one tick and executed on the next would hand the
 * executor a plan a day stale, and it would refuse every entry.
 *
 * In the other direction, nothing here loops. A failed `execute` is **not**
 * re-issued, and the reason is specific rather than general caution: the plan
 * names ids whose directories the failed Job may already have unlinked, so a
 * re-issue cannot tell a successful removal from one that never happened. A
 * `deadline_exceeded` in particular is a reason to re-INVENTORY on the next
 * tick — which is exactly what the next tick does — never to re-send the same
 * ids. The caller gets one outcome per call and decides whether to call again.
 *
 * ## `ok` at the run level is not `ok` at the report level
 *
 * {@link runIsolationReclaimJob} returns `ok: true` when it **recovered a
 * report**, which is a different claim from the report having succeeded: a
 * well-formed `{ ok: false, error }` payload is a successful recovery of a
 * refusal. The executor exits non-zero on every refusal, so this is the normal
 * shape of a correctly-reported failure, not an edge case.
 *
 * Reading only the outer flag is the fail-open mistake this module is most
 * exposed to, and it is not a quiet one on the inventory arm: an `ok: false`
 * report carries no `inventory` array at all, so the plan would be built from
 * `undefined`. Both arms are therefore unwrapped in two steps — recovered, then
 * succeeded — and a refusal gets its own failure kind so an operator sees the
 * executor's own `error` string rather than a generic phase failure.
 *
 * ## An empty plan launches no Job
 *
 * When `eligibleIds` is empty the drive stops at `plan`. That is not a cost
 * optimisation: an `execute` Job mounts the claim and starts a process holding
 * recursive-unlink capability over the whole isolation tree. Doing that for a
 * tick which has already decided nothing is eligible adds blast radius and buys
 * a `requested: 0` report that says what the plan already said.
 *
 * ## One bound, used twice
 *
 * `maxDeletes` is resolved once here and passed to both halves — as
 * `maxEntries` to the planner and as the envelope's `maxDeletes` to the
 * executor. They default to the same constant today, so letting each take its
 * own default would agree by coincidence; if they ever drifted the planner
 * would hand over more ids than the executor would spend, and the truncation
 * would be reported twice (`plan.truncated` and `result.capped`) for one cause,
 * with no way to tell from the outcome which bound bit.
 *
 * ## `planBuiltAtMs` is stamped BEFORE the planner runs
 *
 * The window that timestamp bounds is "database snapshot -> unlink", and the
 * snapshot is taken *inside* `buildIsolationReclaimPlan`. Stamping after it
 * returns would describe the snapshot as newer than it is, which is the
 * fail-open direction — the plan survives its staleness check longer than the
 * evidence behind it is good for. Stamping before describes it as slightly
 * older, which only ever expires a plan early. The difference is one database
 * round-trip, and the direction is the whole reason it is written down.
 *
 * ## `deletionOutcomeUnknown` is propagated, never narrowed
 *
 * The runner derives it from the Job's mode alone, so an `execute` Job created
 * under `dryRun` — which cannot unlink anything — still reports `true` on
 * failure. That over-reports, and it is left alone deliberately: the runner may
 * have **adopted** a Job this drive did not create, and that Job's own dry-run
 * setting is not this drive's. Narrowing the unknown using this call's
 * intention would be reasoning about the wrong Job. `dryRun` is reported beside
 * it instead, so an operator reading an unknown on a preview tick can see why.
 *
 * A thrown error from the port is folded in the same conservative direction. A
 * throw during the `execute` phase is reported with the unknown set, because
 * from outside the runner a failure to create (nothing ran) is indistinguishable
 * from a failure to poll (a pod that may be halfway through the plan).
 *
 * **Every `execute`-phase failure carries the unknown, including a refusal the
 * executor reported itself.** That branch looks narrowable — each cause that
 * reaches it today happens before the unlink loop — but the executor CLI wraps
 * the whole `executeIsolationReclaimPlan` call in one `catch`, so a future throw
 * raised inside the loop would arrive as the same `ok: false` payload. The rule
 * is therefore stated without an exception: nothing in this file narrows an
 * unknown using an invariant of a module it does not own.
 */

/** Cluster-shaped inputs shared by both of a drive's Jobs. */
export interface ReclaimClaimTemplate {
  namespace: string;
  /** The server's own image — the executor ships inside it. */
  image: string;
  serviceAccountName?: string;
  imagePullPolicy?: string;
  imagePullSecrets?: k8s.V1LocalObjectReference[];
  nodeSelector?: Record<string, string>;
  tolerations?: k8s.V1Toleration[];
  activeDeadlineSeconds?: number;
  ttlSecondsAfterFinished?: number;
}

/**
 * Why a drive stopped short.
 *
 * Separate kinds rather than one `failed`, on the runner's precedent: each
 * names a different thing to go and look at, and two of them are not about the
 * cluster at all. `*_manifest_refused` is this process refusing to build a Job
 * — a bad invocation id, or a plan too large for the environment ceiling — so
 * nothing was created and nothing can have run.
 */
export type ReclaimClaimFailureKind =
  /** The inventory manifest could not be built. No Job was created. */
  | "inventory_manifest_refused"
  /** The inventory Job produced no report. See `ReclaimRunFailureKind` in `detail`. */
  | "inventory_run_failed"
  /** The inventory report was recovered and says the executor refused. */
  | "inventory_refused"
  /** The planner threw — in practice the workspace-usage query. */
  | "plan_failed"
  /** The execute manifest could not be built, in practice the plan env ceiling. */
  | "execute_manifest_refused"
  /** The execute Job produced no report. */
  | "execute_run_failed"
  /** The execute report was recovered and says the executor refused. */
  | "execute_refused";

/** The furthest stage a drive reached. */
export type ReclaimClaimPhase = "inventory" | "plan" | "execute";

export interface ReclaimClaimOutcome {
  claimName: string;
  agentId: string | null;
  source: ReclaimableClaim["source"];
  /** Where the drive stopped. `plan` on success means nothing was eligible. */
  phase: ReclaimClaimPhase;
  ok: boolean;
  failureKind: ReclaimClaimFailureKind | null;
  detail: string | null;
  /** Non-null once an inventory report was recovered and succeeded. */
  plan: IsolationReclaimPlan | null;
  /** Non-null once an execute report was recovered and succeeded. */
  result: IsolationReclaimExecutionResult | null;
  /**
   * True when the drive stopped at `plan` because `eligibleIds` was empty.
   * Distinct from a failure at `plan`: this is the ordinary quiet tick.
   */
  nothingEligible: boolean;
  dryRun: boolean;
  /** True when a run attached to a Job it did not create; see the header. */
  adoptedInventory: boolean;
  adoptedExecute: boolean;
  /** Never read as "reclaimed nothing". See the header. */
  deletionOutcomeUnknown: boolean;
  inventoryJobName: string | null;
  executeJobName: string | null;
}

export interface DriveIsolationReclaimOptions {
  claim: ReclaimableClaim;
  template: ReclaimClaimTemplate;
  port: ReclaimJobPort;
  lookupWorkspaceUsage: WorkspaceUsageLookup;
  /** Idle threshold, shared verbatim with the mounted sweep. */
  maxAgeDays: number;
  /**
   * Distinguishes this tick's Jobs from the next tick's. One value covers both
   * phases: `reclaimJobName` prefixes the mode, so `inventory` and `execute`
   * cannot collide under one id. A repeated id is a deliberate adoption.
   */
  invocationId: string;
  /** One bound for the planner and the executor both; see the header. */
  maxDeletes?: number;
  maxPlanAgeMs?: number;
  dryRun?: boolean;
  startupGraceMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
  logger?: typeof defaultLogger;
  /** Seam: the acting half, so the sequence is testable without a cluster. */
  runJob?: (options: {
    manifest: IsolationReclaimJobManifest;
    port: ReclaimJobPort;
    startupGraceMs?: number;
    pollIntervalMs?: number;
  }) => Promise<ReclaimRunOutcome>;
}

export async function driveIsolationReclaim(
  options: DriveIsolationReclaimOptions,
): Promise<ReclaimClaimOutcome> {
  const {
    claim,
    template,
    port,
    lookupWorkspaceUsage,
    maxAgeDays,
    invocationId,
    maxPlanAgeMs,
    startupGraceMs,
    pollIntervalMs,
    now = Date.now,
    logger: log = defaultLogger,
    runJob = runIsolationReclaimJob,
  } = options;
  const dryRun = options.dryRun === true;
  // Resolved once. See the header: two defaults that agree by coincidence are
  // two bounds that can drift.
  const maxDeletes = options.maxDeletes ?? DEFAULT_MAX_DELETES_PER_TICK;

  const base: ReclaimClaimOutcome = {
    claimName: claim.claimName,
    agentId: claim.agentId,
    source: claim.source,
    phase: "inventory",
    ok: false,
    failureKind: null,
    detail: null,
    plan: null,
    result: null,
    nothingEligible: false,
    dryRun,
    adoptedInventory: false,
    adoptedExecute: false,
    deletionOutcomeUnknown: false,
    inventoryJobName: null,
    executeJobName: null,
  };

  const jobSpec = (
    mode: "inventory" | "execute",
    plan?: IsolationReclaimJobSpec["plan"],
  ): IsolationReclaimJobSpec => ({
    ...template,
    mode,
    claimName: claim.claimName,
    invocationId,
    ...(plan ? { plan } : {}),
  });

  // ---- inventory -----------------------------------------------------------

  let inventoryManifest: IsolationReclaimJobManifest;
  try {
    inventoryManifest = buildIsolationReclaimJobManifest(jobSpec("inventory"));
  } catch (error) {
    return { ...base, failureKind: "inventory_manifest_refused", detail: messageOf(error) };
  }
  base.inventoryJobName = inventoryManifest.jobName;

  let inventoryRun: ReclaimRunOutcome;
  try {
    inventoryRun = await runJob({
      manifest: inventoryManifest,
      port,
      startupGraceMs,
      pollIntervalMs,
    });
  } catch (error) {
    // An inventory Job unlinks nothing, so a throw here cannot have deleted
    // anything regardless of which port call raised it.
    return { ...base, failureKind: "inventory_run_failed", detail: messageOf(error) };
  }

  if (!inventoryRun.ok) {
    return {
      ...base,
      failureKind: "inventory_run_failed",
      detail: `${inventoryRun.kind}: ${inventoryRun.detail}`,
      adoptedInventory: inventoryRun.adopted,
    };
  }
  base.adoptedInventory = inventoryRun.adopted;

  // Step two of the unwrap. The run recovered a report; the report may still be
  // the executor refusing, and on that branch there is no `inventory` array to
  // read. See the header.
  const inventoryReport = inventoryRun.report;
  if (!inventoryReport.ok) {
    return { ...base, failureKind: "inventory_refused", detail: inventoryReport.error };
  }
  // Narrowed by the runner's own mode check, which refuses a report whose kind
  // disagrees with the Job's; restated so this module does not depend on that
  // being true elsewhere.
  if (inventoryReport.kind !== "inventory") {
    return {
      ...base,
      failureKind: "inventory_run_failed",
      detail: `inventory Job reported kind ${inventoryReport.kind}`,
    };
  }

  // ---- plan ----------------------------------------------------------------

  base.phase = "plan";
  // Stamped BEFORE the planner's database read, never after it. See the header:
  // the only direction this can be wrong in safely is "older than it is".
  const planBuiltAtMs = now();
  let plan: IsolationReclaimPlan;
  try {
    plan = await buildIsolationReclaimPlan({
      inventory: inventoryReport.inventory,
      lookupWorkspaceUsage,
      maxAgeDays,
      maxEntries: maxDeletes,
      now,
    });
  } catch (error) {
    return { ...base, failureKind: "plan_failed", detail: messageOf(error) };
  }
  base.plan = plan;

  if (plan.eligibleIds.length === 0) {
    // The ordinary quiet tick. No Job: see the header.
    return { ...base, ok: true, nothingEligible: true };
  }

  // ---- execute -------------------------------------------------------------

  base.phase = "execute";
  let executeManifest: IsolationReclaimJobManifest;
  try {
    executeManifest = buildIsolationReclaimJobManifest(
      jobSpec("execute", {
        planBuiltAtMs,
        eligibleIds: plan.eligibleIds,
        maxDeletes,
        ...(maxPlanAgeMs === undefined ? {} : { maxPlanAgeMs }),
        ...(dryRun ? { dryRun: true } : {}),
      }),
    );
  } catch (error) {
    // Refused before any Job existed, so the outcome is a known zero.
    return { ...base, failureKind: "execute_manifest_refused", detail: messageOf(error) };
  }
  base.executeJobName = executeManifest.jobName;

  let executeRun: ReclaimRunOutcome;
  try {
    executeRun = await runJob({
      manifest: executeManifest,
      port,
      startupGraceMs,
      pollIntervalMs,
    });
  } catch (error) {
    // Conservative by design: from out here a create that never happened and a
    // poll over a pod halfway through the plan look the same. See the header.
    return {
      ...base,
      failureKind: "execute_run_failed",
      detail: messageOf(error),
      deletionOutcomeUnknown: true,
    };
  }

  if (!executeRun.ok) {
    return {
      ...base,
      failureKind: "execute_run_failed",
      detail: `${executeRun.kind}: ${executeRun.detail}`,
      adoptedExecute: executeRun.adopted,
      deletionOutcomeUnknown: executeRun.deletionOutcomeUnknown,
    };
  }
  base.adoptedExecute = executeRun.adopted;

  const executeReport = executeRun.report;
  if (!executeReport.ok) {
    // A refusal the executor reported itself, and still an unknown. Today every
    // cause reaches this branch before the unlink loop — a `--root` that cannot
    // be read, a plan env that will not parse; a stale or unusable plan does not
    // even come back `ok: false`, it comes back as a successful result carrying
    // `stopReason`. But the executor CLI wraps the whole
    // `executeIsolationReclaimPlan` call in one `catch` that emits `ok: false`,
    // so a throw raised INSIDE the loop, after some `fs.rm` calls, would arrive
    // here indistinguishable from a pre-loop refusal.
    //
    // Narrowing here would rest on an invariant of another module that nothing
    // enforces, and it is the only branch in this file that would. The cost of
    // not narrowing is bounded and cheap: two pre-loop causes reported as
    // unknown rather than as a known zero. The cost of narrowing wrongly is the
    // measurement that was never taken. (Ally, review of #3198.)
    return {
      ...base,
      failureKind: "execute_refused",
      detail: executeReport.error,
      deletionOutcomeUnknown: true,
    };
  }
  if (executeReport.kind !== "execute") {
    return {
      ...base,
      failureKind: "execute_run_failed",
      detail: `execute Job reported kind ${executeReport.kind}`,
      deletionOutcomeUnknown: true,
    };
  }

  log.info(
    {
      claim: claim.claimName,
      agentId: claim.agentId,
      source: claim.source,
      jobName: executeManifest.jobName,
      adopted: executeRun.adopted,
      dryRun,
      requested: executeReport.result.requested,
      deleted: executeReport.result.deleted,
      wouldDelete: executeReport.result.wouldDelete,
      stopReason: executeReport.result.stopReason,
    },
    "isolation reclaim drive complete",
  );

  return { ...base, ok: true, result: executeReport.result };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
