import {
  buildIsolationReclaimJobManifest,
  type IsolationReclaimJobSpec,
} from "./isolation-reclaim-job.js";
import {
  DEFAULT_RECLAIM_STARTUP_GRACE_MS,
  reclaimWaitBudgetMs,
  runIsolationReclaimJob,
  type ReclaimJobPort,
  type ReclaimRunFailureKind,
  type ReclaimRunOutcome,
} from "./isolation-reclaim-runner.js";
import {
  buildIsolationReclaimPlan,
  DEFAULT_MAX_DELETES_PER_TICK,
  type IsolationReclaimExecutionResult,
  type IsolationReclaimPlan,
  type ReclaimableClaim,
  type WorkspaceUsageLookup,
} from "./isolation-workspace-reaper.js";
import { logger as defaultLogger } from "../middleware/logger.js";

/**
 * One foreign claim, inventoried, decided and reclaimed (PEN-5151).
 *
 * Six pieces of the foreign-claim sweep landed before this one, and every one
 * of them decides something in isolation: `listReclaimableClaims` (#3195) names
 * the volumes, `buildIsolationReclaimPlan` (#3184) decides what may go,
 * `collectIsolationWorkspaceInventory` / `executeIsolationReclaimPlan` (#3186)
 * are the executor's two ends, `isolation-reclaim-report.ts` +
 * `cli/isolation-reclaim-executor.ts` (#3189) are the wire, the manifest
 * (#3194) is the pod, and `runIsolationReclaimJob` (#3196) runs one Job and
 * recovers one report. **None of them is the cycle**, and the cycle is where
 * the two Jobs stop being independent: an inventory is only worth taking if a
 * plan is built from it promptly, and a plan is only safe to execute while it
 * is young.
 *
 * This module is that ordering — inventory, plan, execute — for exactly one
 * claim. Enumerating claims, aggregating across them and scheduling the pass
 * are the layer above and deliberately not here, so that the thing below can be
 * tested against a fake port with no scheduler in the picture.
 *
 * ## The defect this module exists to close: two ten-minute budgets that are
 * not the same ten minutes
 *
 * `executeIsolationReclaimPlan` refuses a plan older than `maxPlanAgeMs`,
 * re-checked **per entry inside the unlink loop**, against a `planBuiltAtMs`
 * stamped on the control plane. That bound is the executor's entire safety
 * margin: with no database it cannot re-read `lastUsedAt`, so time is the only
 * thing standing between a resurrected workspace and deletion.
 *
 * Its default is `DEFAULT_MAX_PLAN_AGE_MS` — ten minutes. Sound for the
 * in-process caller it was written against, where the plan is built and spent
 * in the same tick. It is **not** sound across a Job, and the numbers say so
 * without any estimating:
 *
 * - `DEFAULT_RECLAIM_STARTUP_GRACE_MS` is ten minutes, and it exists precisely
 *   because admission, scheduling and the image pull all happen *before*
 *   `activeDeadlineSeconds` starts counting from pod start.
 * - `DEFAULT_RECLAIM_ACTIVE_DEADLINE_SECONDS` is fifteen more, once it does.
 *
 * So a plan carrying the executor's default is stale on arrival on any cluster
 * whose image pull is slower than the margin, and stale *mid-loop* even on one
 * that starts instantly — ten minutes is not long to recursively unlink up to
 * `DEFAULT_MAX_DELETES_PER_TICK` trees on an MDS-metadata-bound filesystem. The
 * failure is quiet in the worst way: the Job succeeds, the report parses, every
 * id comes back as `notAttempted` with `stopReason: "plan_stale"`, and the
 * sweep records a clean pass that reclaimed nothing. Repeat daily and the
 * ≈3.7-month ceiling PEN-5125 accepted arrives exactly on schedule, with a
 * green sweep in front of it.
 *
 * The driver is the only layer that holds both numbers, so it is the only layer
 * that can reconcile them, and it does it by **deriving the plan's lifetime
 * from the wait it is itself willing to grant**: `maxPlanAgeMs` is set to
 * `reclaimWaitBudgetMs(manifest, startupGraceMs)` — startup grace plus the
 * Job's own `activeDeadlineSeconds`, read off the manifest rather than restated.
 * The invariant that buys is worth stating plainly:
 *
 *   **The plan is valid for exactly as long as the driver waits for the Job.**
 *
 * An executor can no longer outlive its plan while the driver still expects a
 * report, and `plan_stale` goes back to meaning what it should — a Job that ran
 * past the budget granted to it — instead of being the ordinary outcome. The
 * gap between the plan being built and the Job being created is not added in,
 * which leaves the bound a shade *stricter* than the wait; that is the
 * conservative direction and is left as is.
 *
 * Note what this does NOT do. It does not widen the resurrection window for
 * free — it makes it honest, and then hands the operator a single knob over it.
 * `activeDeadlineSeconds` now sets both how long the executor may work and how
 * long its verdict is trusted, together, so the two cannot be tuned into
 * disagreement. Shorten it and both shrink. That is the whole reason the value
 * is derived here rather than passed as a second option.
 *
 * ## An empty plan launches no pod
 *
 * `buildIsolationReclaimJobManifest` will happily build an `execute` Job for an
 * empty `eligibleIds`, and running one would be harmless — the executor would
 * report `requested: 0` and exit. It is still refused, because on a steady
 * cluster "nothing is eligible" is the *common* case: a claim whose tree is
 * already reclaimed would otherwise pay a schedule, an image pull and a Job
 * object every single pass, on every claim, forever. The cycle stops at `plan`
 * and says so.
 *
 * ## An inventory failure stops the cycle, and never substitutes
 *
 * There is no fallback inventory. A claim this server cannot walk has exactly
 * one observer, and when that observer fails the honest result is that this
 * claim was not swept this pass — not an empty inventory, which
 * `buildIsolationReclaimPlan` cannot distinguish from a tree with nothing in
 * it, and which would therefore read as a successful no-op pass over a claim
 * that is in fact growing unobserved. That is the same collapse
 * `isolation-reclaim-report.ts` refuses between `malformed` and an empty
 * inventory, enforced one layer up.
 *
 * ## `deletionOutcomeUnknown` is carried, not computed
 *
 * `deletionOutcomeUnknown` on a `ReclaimRunFailure` is the field #3196 exists
 * to get right: an `execute` Job that failed after it could have started may
 * have unlinked an unknown amount. This module propagates it and never reads a
 * failed execute as zero reclaimed. The ceiling PEN-5125 accepted is tracked in
 * reclaimed volume, and a measurement never taken must not enter that series as
 * a zero.
 */

/**
 * Label carrying the agent a reclaim Job's claim belongs to.
 *
 * Attribution only — the mode and the claim are the Job's own labels, set by
 * the manifest builder and not overridable from here.
 */
export const RECLAIM_JOB_AGENT_LABEL = "paperclip.io/reclaim-agent";

/**
 * Kubernetes' label-VALUE rule, which is the constraint this module actually
 * depends on: an invalid value is rejected at `createJob`, by the API server,
 * as a throw that escapes this function and ends the pass.
 *
 * `listReclaimableClaims` applies the adapter's near-identical agent-id rule,
 * but only on the arm that DERIVES a claim name from the id. An
 * `agent_workspace_claim` row names its claim in config and carries `agentId`
 * through unchecked, so an id over 63 characters or opening with `-` reaches
 * here intact. Agent ids are uuids and neither path is reachable today; this
 * is a backstop, held for the same reason that module holds its own —
 * "attribution is lost" is a tolerable outcome for one Job, and "the sweep
 * stopped at the fourth claim" is not.
 */
const LABEL_SAFE_VALUE = /^[a-zA-Z0-9]([a-zA-Z0-9._-]*[a-zA-Z0-9])?$/;

function agentLabelFor(agentId: string | null): Record<string, string> | undefined {
  if (!agentId || agentId.length > 63 || !LABEL_SAFE_VALUE.test(agentId)) return undefined;
  return { [RECLAIM_JOB_AGENT_LABEL]: agentId };
}

/**
 * The furthest stage that actually RAN, which is not always the furthest stage
 * that could have.
 *
 * An empty inventory reports `"inventory"`, not `"plan"`: the decision was
 * skipped rather than taken, and `plan` is correspondingly `null`. Reporting
 * `"plan"` there would say a decision happened and then hand back no decision.
 * `"plan"` with `halted: "nothing_eligible"` is the different thing — a plan
 * that ran and found nothing.
 */
export type ReclaimCycleStage = "inventory" | "plan" | "execute";

/**
 * Why a cycle stopped before executing, when nothing went wrong.
 *
 * Kept apart from {@link ReclaimCycleFailure} because neither of these wants an
 * operator: they are the two shapes of a healthy pass over a claim with nothing
 * to do.
 */
export type ReclaimCycleHaltReason =
  /** The claim's tree is empty, or holds nothing this server can name. */
  | "inventory_empty"
  /** The inventory had entries; none was idle enough to remove. */
  | "nothing_eligible";

/**
 * Why a cycle failed.
 *
 * `ReclaimRunFailureKind` covers everything that can go wrong once a Job
 * exists. `plan_unshippable` is the one failure that happens before one does:
 * the plan is too large for the environment variable that carries it
 * (`MAX_RECLAIM_PLAN_ENV_BYTES`), which `buildIsolationReclaimJobManifest`
 * reports by throwing.
 */
export type ReclaimCycleFailureKind = ReclaimRunFailureKind | "plan_unshippable";

export interface ReclaimCycleFailure {
  stage: ReclaimCycleStage;
  kind: ReclaimCycleFailureKind;
  detail: string;
}

export interface ReclaimCycleResult {
  claimName: string;
  agentId: string | null;
  source: ReclaimableClaim["source"];
  /** The last stage that completed; see {@link ReclaimCycleStage}. */
  stage: ReclaimCycleStage;
  /** Entries the executor reported, or `null` when the inventory Job produced no report. */
  inventorySize: number | null;
  plan: IsolationReclaimPlan | null;
  /** `null` when no `execute` Job ran — either halted, or the Job produced no report. */
  execution: IsolationReclaimExecutionResult | null;
  halted: ReclaimCycleHaltReason | null;
  failure: ReclaimCycleFailure | null;
  /**
   * An `execute` Job may have unlinked an unknown amount. Never read this
   * result's absent `execution` as zero reclaimed when this is true.
   */
  deletionOutcomeUnknown: boolean;
  /** The lifetime granted to this pass's plan; see the header. */
  planAgeBudgetMs: number;
  /** Set when a run attached to a Job it did not create. */
  adoptedInventory: boolean;
  adoptedExecute: boolean;
}

/** Everything about the pod that is deployment shape rather than this cycle's decision. */
export interface ReclaimCycleJobDefaults {
  serviceAccountName?: string;
  imagePullPolicy?: string;
  imagePullSecrets?: IsolationReclaimJobSpec["imagePullSecrets"];
  nodeSelector?: Record<string, string>;
  tolerations?: IsolationReclaimJobSpec["tolerations"];
  activeDeadlineSeconds?: number;
  ttlSecondsAfterFinished?: number;
}

export interface RunIsolationReclaimCycleOptions {
  claim: ReclaimableClaim;
  namespace: string;
  /** The server's own image — the executor ships in it. */
  image: string;
  /**
   * Distinguishes this pass's Jobs from the next pass's, and is deliberately
   * the caller's to choose: a repeated id adopts the running Job (an idempotent
   * re-entry), a fresh one starts a new attempt. The cycle uses one id for both
   * modes; `reclaimJobName` already separates them by prefix, so the two cannot
   * collide with each other.
   *
   * ⚠ MINT A FRESH ID PER PASS. Reusing one across passes is safe for deletion
   * and wrong for accounting, and the scheduler above is the thing that has to
   * know it. A finished `execute` Job lingers for its TTL
   * (`DEFAULT_RECLAIM_TTL_SECONDS`, an hour), so a second pass under the same
   * id does not create a Job — it ADOPTS the old one and reads the report of
   * the plan that Job ran, while the plan this pass just built is never shipped
   * at all. Nothing extra is unlinked, but the pass reports the previous plan's
   * counters as its own, and its own eligible ids silently go unreclaimed until
   * a pass with a new id offers them again.
   */
  invocationId: string;
  lookupWorkspaceUsage: WorkspaceUsageLookup;
  maxAgeDays: number;
  /** Per-pass bound on directories offered. Defaults to `DEFAULT_MAX_DELETES_PER_TICK`. */
  maxEntries?: number;
  /** Plan and launch as normal; the executor classifies and unlinks nothing. */
  dryRun?: boolean;
  port: ReclaimJobPort;
  jobDefaults?: ReclaimCycleJobDefaults;
  startupGraceMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  logger?: typeof defaultLogger;
}

/**
 * Inventory one foreign claim, decide, and reclaim what the decision allows.
 *
 * Returns a value for every outcome a single claim can produce — including a
 * plan too large to ship, which the manifest builder reports by throwing. A
 * sweep over many claims must be able to treat one claim's trouble as that
 * claim's result rather than as the end of the pass.
 *
 * Two things still throw, both deliberately. The port is the caller's, so its
 * faults are the caller's to classify. And a manifest that cannot be built from
 * deployment-wide inputs — an empty image or namespace, an invocationId too
 * long for a Job name — is a deploy bug identical on every claim; see the
 * comment on the execute build for why only one of the two is caught.
 */
export async function runIsolationReclaimCycle(
  options: RunIsolationReclaimCycleOptions,
): Promise<ReclaimCycleResult> {
  const log = options.logger ?? defaultLogger;
  const now = options.now ?? Date.now;
  const startupGraceMs = options.startupGraceMs ?? DEFAULT_RECLAIM_STARTUP_GRACE_MS;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_DELETES_PER_TICK;
  const { claim } = options;

  const base = {
    claimName: claim.claimName,
    agentId: claim.agentId,
    source: claim.source,
    inventorySize: null,
    plan: null,
    execution: null,
    halted: null,
    failure: null,
    deletionOutcomeUnknown: false,
    adoptedInventory: false,
    adoptedExecute: false,
  } satisfies Omit<ReclaimCycleResult, "stage" | "planAgeBudgetMs">;

  const sharedSpec = {
    claimName: claim.claimName,
    namespace: options.namespace,
    image: options.image,
    invocationId: options.invocationId,
    ...options.jobDefaults,
    // The agent this claim belongs to, when it is knowable, so an operator
    // reading `kubectl get jobs` can attribute a pod without a database.
    // `environment_claim` rows have no agent by construction, and an absent
    // label is the honest record of that — an empty value would be a label a
    // selector matches. See `LABEL_SAFE_VALUE` for the other way this comes
    // back `undefined`.
    extraLabels: agentLabelFor(claim.agentId),
  } satisfies Partial<IsolationReclaimJobSpec>;

  const inventoryManifest = buildIsolationReclaimJobManifest({
    ...sharedSpec,
    mode: "inventory",
  });
  // The plan's lifetime, and the number this whole module is for. Read off the
  // manifest's own `activeDeadlineSeconds` (plus the startup grace) rather than
  // restated, so an operator who raises the deadline for a large claim gets a
  // plan that stays valid for the longer Job they just authorized. Both modes
  // are built from `sharedSpec`, so the inventory manifest's deadline is the
  // execute manifest's deadline. See the header.
  const planAgeBudgetMs = reclaimWaitBudgetMs(inventoryManifest, startupGraceMs);

  const runOptions = {
    port: options.port,
    startupGraceMs,
    pollIntervalMs: options.pollIntervalMs,
    now: options.now,
    sleep: options.sleep,
  };

  const inventoryRun: ReclaimRunOutcome = await runIsolationReclaimJob({
    ...runOptions,
    manifest: inventoryManifest,
  });

  if (!inventoryRun.ok) {
    log.warn(
      {
        claimName: claim.claimName,
        agentId: claim.agentId,
        source: claim.source,
        jobName: inventoryRun.jobName,
        kind: inventoryRun.kind,
        detail: inventoryRun.detail,
      },
      "isolation reclaim cycle took no inventory of a foreign claim; it was not swept this pass",
    );
    return {
      ...base,
      stage: "inventory",
      planAgeBudgetMs,
      adoptedInventory: inventoryRun.adopted,
      failure: {
        stage: "inventory",
        kind: inventoryRun.kind,
        detail: inventoryRun.detail,
      },
    };
  }

  const report = inventoryRun.report;
  if (report.kind !== "inventory" || !report.ok) {
    // `runIsolationReclaimJob` already refuses a report for the other mode, so
    // reaching here means an `ok: false` inventory — the executor ran and
    // declined to answer, which is a refusal to report rather than an empty
    // tree. Kept distinct from a transport fault for the same reason the
    // transport keeps `malformed` apart from an empty inventory.
    const detail = report.ok ? `unexpected report kind ${report.kind}` : report.error;
    log.warn(
      { claimName: claim.claimName, jobName: inventoryRun.jobName, detail },
      "isolation reclaim inventory executor refused to report; the claim was not swept this pass",
    );
    return {
      ...base,
      stage: "inventory",
      planAgeBudgetMs,
      adoptedInventory: inventoryRun.adopted,
      failure: { stage: "inventory", kind: "report_malformed", detail },
    };
  }

  const { inventory } = report;
  const withInventory = {
    ...base,
    inventorySize: inventory.length,
    adoptedInventory: inventoryRun.adopted,
  };

  if (inventory.length === 0) {
    // Stage stays at `inventory`: no decision was taken, so none is reported.
    return { ...withInventory, stage: "inventory", planAgeBudgetMs, halted: "inventory_empty" };
  }

  // Stamped BEFORE the decision rather than after it. The plan's verdict is
  // only as fresh as the database read inside `buildIsolationReclaimPlan`, and
  // that read happens after this instant — so a stamp taken here can only
  // over-state the plan's age. Over-stating fails toward `plan_stale`, which
  // retains a directory; under-stating would extend the window in which a
  // resurrection goes unseen. Only one of those is the safe direction.
  const planBuiltAtMs = now();
  const plan = await buildIsolationReclaimPlan({
    inventory,
    lookupWorkspaceUsage: options.lookupWorkspaceUsage,
    maxAgeDays: options.maxAgeDays,
    maxEntries,
    now: options.now,
  });

  const withPlan = { ...withInventory, plan };

  if (plan.eligibleIds.length === 0) {
    return { ...withPlan, stage: "plan", planAgeBudgetMs, halted: "nothing_eligible" };
  }

  // Guarded, where the inventory manifest above deliberately is not, and the
  // asymmetry is about blast radius rather than caution.
  //
  // Every throw the inventory build can raise — an empty image or namespace, an
  // invocationId too long to fit a Job name — is deployment-wide: it is the
  // same for every claim, so it is a deploy bug, and letting it escape is how
  // an operator finds out at once instead of reading N identical per-claim
  // failures that look like cluster trouble.
  //
  // The execute build adds one throw that is NOT deployment-wide. The plan is
  // carried in a single env var under `MAX_RECLAIM_PLAN_ENV_BYTES`, and whether
  // it fits depends on `eligibleIds.length` — which is a property of THIS
  // claim's backlog. An operator who raises `maxEntries` past roughly 1700 gets
  // a throw on whichever claim happens to be the most overdue, and without this
  // guard that one claim would end the whole pass, leaving every claim after it
  // in the enumeration unswept for reasons nothing records.
  let executeManifest;
  try {
    executeManifest = buildIsolationReclaimJobManifest({
      ...sharedSpec,
      mode: "execute",
      plan: {
        planBuiltAtMs,
        eligibleIds: plan.eligibleIds,
        maxDeletes: maxEntries,
        maxPlanAgeMs: planAgeBudgetMs,
        dryRun: options.dryRun === true,
      },
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    log.error(
      {
        claimName: claim.claimName,
        agentId: claim.agentId,
        planned: plan.eligibleIds.length,
        maxEntries,
        detail,
      },
      "isolation reclaim cycle could not ship the plan it built; this claim was not reclaimed " +
        "this pass and maxEntries is too high for the plan transport",
    );
    return {
      ...withPlan,
      stage: "plan",
      planAgeBudgetMs,
      failure: { stage: "plan", kind: "plan_unshippable", detail },
    };
  }

  const executeRun = await runIsolationReclaimJob({
    ...runOptions,
    manifest: executeManifest,
  });

  if (!executeRun.ok) {
    log.error(
      {
        claimName: claim.claimName,
        agentId: claim.agentId,
        jobName: executeRun.jobName,
        kind: executeRun.kind,
        detail: executeRun.detail,
        planned: plan.eligibleIds.length,
        deletionOutcomeUnknown: executeRun.deletionOutcomeUnknown,
      },
      "isolation reclaim execute Job produced no report; what it unlinked is unknown, not zero",
    );
    return {
      ...withPlan,
      stage: "execute",
      planAgeBudgetMs,
      adoptedExecute: executeRun.adopted,
      deletionOutcomeUnknown: executeRun.deletionOutcomeUnknown,
      failure: { stage: "execute", kind: executeRun.kind, detail: executeRun.detail },
    };
  }

  const executeReport = executeRun.report;
  if (executeReport.kind !== "execute" || !executeReport.ok) {
    const detail = executeReport.ok
      ? `unexpected report kind ${executeReport.kind}`
      : executeReport.error;
    log.error(
      { claimName: claim.claimName, jobName: executeRun.jobName, detail },
      "isolation reclaim execute executor refused to report; what it unlinked is unknown, not zero",
    );
    return {
      ...withPlan,
      stage: "execute",
      planAgeBudgetMs,
      adoptedExecute: executeRun.adopted,
      // An `ok: false` execute report is written by the executor itself, which
      // reports and then exits non-zero on every refusal — including refusals
      // taken after the unlink loop began. Unknown, for the same reason a
      // transport failure is.
      deletionOutcomeUnknown: true,
      failure: { stage: "execute", kind: "report_malformed", detail },
    };
  }

  return {
    ...withPlan,
    stage: "execute",
    planAgeBudgetMs,
    adoptedExecute: executeRun.adopted,
    execution: executeReport.result,
    // Reported in full. `stopReason` carries the executor's own verdict, and
    // `plan_stale` here now means the Job outran the budget this cycle granted
    // it rather than the default colliding with the startup grace.
    deletionOutcomeUnknown: false,
  };
}
