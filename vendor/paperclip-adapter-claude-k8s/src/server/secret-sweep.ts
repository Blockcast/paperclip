/**
 * Ownerless-Secret sweep (BLO-21857).
 *
 * Run Secrets (`<jobName>-prompt`, `-env`, `-mcp`) are created *before* the Job
 * exists, then patched with an `ownerReferences` entry pointing at the Job once
 * its UID is known.  Every ordinary success and failure path either sets that
 * owner reference or deletes the Secret explicitly — but a control-plane crash
 * between `createNamespacedSecret` returning and the `ownerReferences` patch
 * landing leaves a Secret with *no* owner.  Kubernetes GC only cascades through
 * recorded owner references, and the Job `ttlSecondsAfterFinished` cascade is no
 * different, so such a Secret is never collected.  Since these Secrets carry
 * credential material (BLO-17973), an orphan is a credential resident in etcd
 * indefinitely, not just litter.
 *
 * This module collects them.  It is deliberately conservative: a Secret is only
 * deleted when *all* of the following hold.
 *
 *   1. It is labelled as ours (`managed-by=paperclip`, `adapter-type=claude_k8s`)
 *      and carries a non-empty `paperclip.io/run-id`.
 *   2. It has zero `ownerReferences` — an owned Secret is normal GC's business.
 *   3. It is older than the age floor, so a Secret created moments before its
 *      Job can never be collected mid-launch.
 *   4. No Job appears to own it, by *either* of two independent checks — the
 *      run-id label, or the `<jobName>-<suffix>` name convention.  Only one has
 *      to say "a Job exists" for the Secret to be left alone.
 *
 * Check 4 is doubled on purpose.  The Secret's run-id label is the *raw* runId
 * (execute.ts), while the Job's is `sanitizeLabelValue(runId)`, which strips
 * characters outside `[a-zA-Z0-9._-]`, truncates to 63 chars, and is omitted
 * entirely when that yields nothing.  Those agree for every Secret that can
 * actually exist — a raw runId that is not already a valid label value would
 * have failed Secret creation — but the equality is an inference about a
 * neighbouring module, not a guarantee this one controls.  The name-based check
 * does not depend on label sanitisation at all, so a future change to either
 * labelling rule degrades this sweep into leaving orphans behind (safe, and
 * visible on the dashboard) rather than deleting live Secrets (not safe).
 */

export const RUN_ID_LABEL = "paperclip.io/run-id";
export const MANAGED_BY_LABEL = "app.kubernetes.io/managed-by";
export const ADAPTER_TYPE_LABEL = "paperclip.io/adapter-type";
export const ADAPTER_TYPE = "claude_k8s";

/** Suffixes appended to `jobName` to name each run Secret (job-manifest.ts). */
export const RUN_SECRET_SUFFIXES = ["-prompt", "-env", "-mcp"] as const;

export const DEFAULT_SWEEP_INTERVAL_SEC = 300;
/**
 * Secret-create and Job-create are adjacent awaits in one call path; the only
 * intervening I/O is the K8s API calls themselves, each bounded by the 15s
 * concurrency-guard timeout.  120s is a wide margin over that worst case.
 */
export const DEFAULT_SWEEP_AGE_FLOOR_SEC = 120;

type LogStream = "stdout" | "stderr";
type LogFn = (stream: LogStream, message: string) => void | Promise<void>;

/**
 * Structural slices of `CoreV1Api` / `BatchV1Api`.  Narrow on purpose: the real
 * clients satisfy these, and tests can supply plain objects.
 */
export interface SecretSweepObjectMeta {
  name?: string;
  labels?: { [key: string]: string };
  ownerReferences?: unknown[];
  creationTimestamp?: Date | string;
  deletionTimestamp?: Date | string;
}

export interface SecretSweepCoreApi {
  listNamespacedSecret(req: { namespace: string; labelSelector?: string }): Promise<{
    items: { metadata?: SecretSweepObjectMeta }[];
  }>;
  deleteNamespacedSecret(req: { name: string; namespace: string }): Promise<unknown>;
}

export interface SecretSweepBatchApi {
  listNamespacedJob(req: { namespace: string; labelSelector?: string }): Promise<{
    items: { metadata?: SecretSweepObjectMeta }[];
  }>;
}

export interface SweepOptions {
  namespace: string;
  coreApi: SecretSweepCoreApi;
  batchApi: SecretSweepBatchApi;
  onLog: LogFn;
  ageFloorMs?: number;
  /**
   * Minimum gap between sweeps, honoured by the gate from `createSweepGate`.
   * Ignored by `sweepOrphanedRunSecrets`, which always sweeps when called.
   */
  intervalMs?: number;
  /** Injectable clock for tests. */
  now?: number;
}

export interface SweepResult {
  /** Names of Secrets successfully deleted. */
  swept: string[];
  /** Names of Secrets examined but deliberately left alone, with the reason. */
  retained: { name: string; reason: "owned" | "too_young" | "job_exists" | "no_run_id" }[];
  /** Names of Secrets we tried and failed to delete (non-fatal). */
  failed: { name: string; error: string }[];
}

/**
 * Recover the Job name that a run Secret belongs to, by stripping the known
 * suffix.  Returns null for a name that does not follow the convention — such a
 * Secret is then judged on the run-id label alone.
 */
export function deriveOwningJobName(secretName: string): string | null {
  for (const suffix of RUN_SECRET_SUFFIXES) {
    if (secretName.endsWith(suffix) && secretName.length > suffix.length) {
      return secretName.slice(0, -suffix.length);
    }
  }
  return null;
}

function toMillis(value: Date | string | undefined): number | null {
  if (!value) return null;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Delete `paperclip.io/run-id`-labelled Secrets in `namespace` that have no
 * owner reference and no surviving Job, and are past the age floor.
 *
 * Never throws for a per-Secret failure; the caller treats the whole sweep as
 * best-effort.
 */
export async function sweepOrphanedRunSecrets(opts: SweepOptions): Promise<SweepResult> {
  const { namespace, coreApi, batchApi, onLog } = opts;
  const ageFloorMs = opts.ageFloorMs ?? DEFAULT_SWEEP_AGE_FLOOR_SEC * 1000;
  const now = opts.now ?? Date.now();
  const result: SweepResult = { swept: [], retained: [], failed: [] };

  const secrets = await coreApi.listNamespacedSecret({
    namespace,
    labelSelector: `${MANAGED_BY_LABEL}=paperclip,${ADAPTER_TYPE_LABEL}=${ADAPTER_TYPE},${RUN_ID_LABEL}`,
  });

  // Candidates first, so the Job list is only fetched when there is something
  // to judge — the common case is zero orphans and zero extra API calls.
  const candidates: { name: string; runId: string; ageMs: number }[] = [];
  for (const secret of secrets.items) {
    const name = secret.metadata?.name;
    if (!name) continue;
    if (secret.metadata?.deletionTimestamp) continue; // already going away
    if ((secret.metadata?.ownerReferences?.length ?? 0) > 0) {
      result.retained.push({ name, reason: "owned" });
      continue;
    }
    const runId = secret.metadata?.labels?.[RUN_ID_LABEL] ?? "";
    if (!runId) {
      // Cannot correlate to a Job with any confidence — leave it. Surfaces on
      // the ownerless-Secret dashboard rather than being deleted on a guess.
      result.retained.push({ name, reason: "no_run_id" });
      continue;
    }
    const createdMs = toMillis(secret.metadata?.creationTimestamp);
    // An unreadable creation timestamp is treated as "too young": we never
    // delete something whose age we cannot establish.
    if (createdMs === null || now - createdMs < ageFloorMs) {
      result.retained.push({ name, reason: "too_young" });
      continue;
    }
    candidates.push({ name, runId, ageMs: now - createdMs });
  }

  if (candidates.length === 0) return result;

  // One list call for the whole sweep rather than one per candidate: a retry
  // storm against the API server is exactly what a cleanup path must not add.
  const jobs = await batchApi.listNamespacedJob({
    namespace,
    labelSelector: `${MANAGED_BY_LABEL}=paperclip,${ADAPTER_TYPE_LABEL}=${ADAPTER_TYPE}`,
  });
  const liveJobRunIds = new Set<string>();
  const liveJobNames = new Set<string>();
  for (const job of jobs.items) {
    const runId = job.metadata?.labels?.[RUN_ID_LABEL];
    if (runId) liveJobRunIds.add(runId);
    const name = job.metadata?.name;
    if (name) liveJobNames.add(name);
  }

  for (const candidate of candidates) {
    const owningJobName = deriveOwningJobName(candidate.name);
    // Either signal claiming a Job exists is enough to leave the Secret alone.
    if (
      liveJobRunIds.has(candidate.runId) ||
      (owningJobName !== null && liveJobNames.has(owningJobName))
    ) {
      result.retained.push({ name: candidate.name, reason: "job_exists" });
      continue;
    }
    try {
      await coreApi.deleteNamespacedSecret({ name: candidate.name, namespace });
      result.swept.push(candidate.name);
      await onLog(
        "stdout",
        `[paperclip] Swept ownerless Secret ${candidate.name} (run-id ${candidate.runId}, age ${Math.round(candidate.ageMs / 1000)}s, no owning Job)\n`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.failed.push({ name: candidate.name, error: message });
      await onLog(
        "stderr",
        `[paperclip] Failed to sweep ownerless Secret ${candidate.name}: ${message}\n`,
      );
    }
  }

  return result;
}

/**
 * Interval gate for the sweep.
 *
 * No adapter lifecycle/timer hook exists to hang a real scheduler on, so the
 * sweep piggybacks on `execute()`.  The returned function runs at most once per
 * `intervalMs` however often it is called, and claims its slot *before*
 * awaiting so concurrent `execute()` calls cannot double-sweep.  Errors are
 * swallowed: a cleanup best-effort must never fail a run.
 */
export function createSweepGate(): (opts: SweepOptions) => Promise<SweepResult | null> {
  let lastSweptAt = 0;
  return async function maybeSweep(opts: SweepOptions): Promise<SweepResult | null> {
    const now = opts.now ?? Date.now();
    const intervalMs = opts.intervalMs ?? DEFAULT_SWEEP_INTERVAL_SEC * 1000;
    if (lastSweptAt !== 0 && now - lastSweptAt < intervalMs) return null;
    lastSweptAt = now;
    try {
      return await sweepOrphanedRunSecrets(opts);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await opts.onLog(
        "stderr",
        `[paperclip] Orphan-secret sweep failed (non-fatal): ${message}\n`,
      );
      return null;
    }
  };
}
