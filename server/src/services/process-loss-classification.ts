/**
 * BLO-16181: durable classification of a `process_lost` mint by the reaper.
 *
 * `reapOrphanedRuns`'s fallback mint stamps errorCode="process_lost" with only a
 * human-readable string, discarding whether a backing k8s Job was ever created
 * and what state it was in. That erased the single most useful discriminator for
 * the fleet-wide process_lost instability (BLO-12292) and for reattach
 * feasibility (BLO-12564): a run whose Job never got a name is unreattachable,
 * while a run whose Job ran and vanished may be. This pure classifier turns the
 * signals the reap loop already holds -- with NO extra kube round-trip -- into a
 * stable bucket persisted on `resultJson.processLoss.classification`, which the
 * BLO-16184 monitor groups on to finish the root-cause split.
 *
 * NOTE on pod exit codes: runs that reach the fallback mint have no inspectable
 * pod (pre-adapter before any Job, a Job absent from the live snapshot, or kube
 * unavailable), so pod-level terminated.{reason,exitCode} is not available at
 * reap time. A confirmed exact-name 404 for a started run is finalized upstream
 * as errorCode `job_missing`, never process_lost, so it does not reach here.
 * Capturing pod exit codes belongs to a death-time mechanism (informer/watch),
 * not this reap-time path.
 */

export type ProcessLossJobLiveness = "alive" | "dead" | "unknown" | null;

export type ProcessLossClassification =
  /** Pre-adapter reap and no Job name was ever persisted -> Job most likely never created. */
  | "pre_adapter_job_unstamped"
  /** Pre-adapter reap with a persisted Job name whose liveness resolved dead/absent. */
  | "pre_adapter_job_stamped"
  /** Pre-adapter reap with a persisted Job name but kube could not confirm state. */
  | "pre_adapter_kube_unknown"
  /** Post-adapter reap; Job absent from the live snapshot or kube unavailable + silent. */
  | "started_job_absent"
  /** Non-external-lifecycle (local child-process) adapter reaped as process_lost. */
  | "local";

export interface ProcessLossSignals {
  /** Adapter runs its lifecycle as an external k8s Job (claude_k8s / opencode_k8s). */
  externalLifecycleRun: boolean;
  /** Reaped before the adapter emitted adapter.invoke (setup/provisioning phase). */
  preAdapter: boolean;
  /** A backing Job name was persisted to heartbeat_runs.external_run_id. */
  externalRunIdStamped: boolean;
  /** Pre-adapter Job liveness the loop already resolved ("dead"/"unknown"/null). */
  preAdapterJobLiveness: ProcessLossJobLiveness;
}

/**
 * Bucket a process_lost reap from the signals available at mint time. Ordering
 * matters: stamped-ness is kube-independent (an unstamped run never recorded a
 * Job name regardless of whether kube is reachable), so it is checked before the
 * liveness nuance, which is only meaningful once a Job name exists.
 *
 * Precondition: at the reaper's process_lost mint, `preAdapterJobLiveness` is
 * never "alive" -- the reap loop `continue`s on a live Job well before the mint,
 * so a live pre-adapter run cannot be process_lost here. A post-adapter run that
 * reaches the mint is always a Job that was absent from the live snapshot (or
 * kube was unavailable) and then went silent; the exact-name-404 case is instead
 * finalized upstream as errorCode `job_missing`, never process_lost, so there is
 * no distinct "confirmed missing" bucket at this mint.
 */
export function classifyProcessLoss(signals: ProcessLossSignals): ProcessLossClassification {
  if (!signals.externalLifecycleRun) return "local";
  if (signals.preAdapter) {
    if (!signals.externalRunIdStamped) return "pre_adapter_job_unstamped";
    if (signals.preAdapterJobLiveness === "unknown") return "pre_adapter_kube_unknown";
    return "pre_adapter_job_stamped";
  }
  return "started_job_absent";
}

export interface ProcessLossCapture {
  externalLifecycleRun: boolean;
  preAdapter?: boolean;
  externalRunIdStamped?: boolean;
  externalRunId?: string | null;
  preAdapterJobLiveness?: ProcessLossJobLiveness;
  classification: ProcessLossClassification;
}

/**
 * Build the `resultJson.processLoss` block persisted at the reaper's process_lost
 * mint. Local (non-external) reaps get a minimal marker so the monitor can
 * exclude them from the external-lifecycle denominator without a schema join.
 */
export function buildProcessLossCapture(input: {
  externalLifecycleRun: boolean;
  preAdapter: boolean;
  externalRunId: string | null | undefined;
  preAdapterJobLiveness: ProcessLossJobLiveness;
}): ProcessLossCapture {
  if (!input.externalLifecycleRun) {
    return { externalLifecycleRun: false, classification: "local" };
  }
  const externalRunId = input.externalRunId?.trim() || null;
  const externalRunIdStamped = externalRunId !== null;
  const signals: ProcessLossSignals = {
    externalLifecycleRun: true,
    preAdapter: input.preAdapter,
    externalRunIdStamped,
    preAdapterJobLiveness: input.preAdapterJobLiveness,
  };
  return {
    externalLifecycleRun: true,
    preAdapter: input.preAdapter,
    externalRunIdStamped,
    externalRunId,
    preAdapterJobLiveness: input.preAdapterJobLiveness,
    classification: classifyProcessLoss(signals),
  };
}
