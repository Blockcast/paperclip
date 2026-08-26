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
 *   3. Its launch lease (`paperclip.io/launch-expires-at`) has expired, so a
 *      launch still in flight can never have its credentials collected out from
 *      under it.
 *   4. It is older than the age floor.  Redundant for any Secret this adapter
 *      creates — the lease in 3 already covers those — but load-bearing for
 *      Secrets written before the lease existed, which carry no annotation.
 *   5. No Job appears to own it, by *either* of two independent checks — the
 *      run-id label, or the `<jobName>-<suffix>` name convention.  Only one has
 *      to say "a Job exists" for the Secret to be left alone.  The name-derived
 *      Job is then re-read directly from the API server immediately before the
 *      delete, so a Job created after the list snapshot still saves its Secret.
 *
 * Checks 3 and 5 are what make this safe under concurrency, and they are
 * deliberately of different kinds.  5 asks "is there a Job?", which is only ever
 * a snapshot — between any observation and the delete that follows it, a launch
 * can create the Job we just failed to see.  Re-reading narrows that window but
 * cannot close it.  3 instead asks the *launching* replica to say, on the Secret
 * itself, how long it intends to be launching; until that deadline passes no
 * observer may collect the Secret no matter what the Job list says.  Because the
 * claim rides on the object, it holds across control-plane replicas, which a
 * process-local interval gate cannot do.
 *
 * Check 5 is doubled on purpose.  The Secret's run-id label is the *raw* runId
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

/**
 * Set at Secret creation to an RFC 3339 instant by which the launching replica
 * expects to have created the Job and patched the owner reference.  The sweep
 * treats a Secret whose lease has not yet expired as belonging to a live
 * launch.  Riding on the object is the point: it is visible to every replica,
 * needs no shared state, and cannot be invalidated by a stale list snapshot.
 */
export const LAUNCH_LEASE_ANNOTATION = "paperclip.io/launch-expires-at";

/** Suffixes appended to `jobName` to name each run Secret (job-manifest.ts). */
export const RUN_SECRET_SUFFIXES = ["-prompt", "-env", "-mcp"] as const;

export const DEFAULT_SWEEP_INTERVAL_SEC = 300;
/**
 * How long a launch may hold its Secrets before the sweep is allowed to judge
 * them abandoned.  Sized as a bound on "no longer plausibly launching", not on
 * the happy path: the three Secret creates and the Job create are bare awaits
 * on the K8s API, so nothing in the code bounds the gap between them — an
 * earlier revision of this file claimed the 15s concurrency-guard timeout did,
 * but that guard wraps only the pre-launch Job lookup (execute.ts), not these
 * calls.  A launch that has not produced a Job in 15 minutes is wedged, not
 * slow, and its Pod would have been declared unschedulable long before.
 */
export const DEFAULT_LAUNCH_LEASE_SEC = 900;
/**
 * Floor on Secret age, independent of the lease.  Only reachable for Secrets
 * created before `LAUNCH_LEASE_ANNOTATION` existed (which carry no lease and
 * would otherwise be judged on the Job check alone) — for anything this adapter
 * writes now, the longer lease always dominates.
 */
export const DEFAULT_SWEEP_AGE_FLOOR_SEC = 120;

/**
 * The lease instant to stamp on a Secret created at `now`.  Exported so
 * execute.ts and the sweep cannot disagree about the annotation's format.
 */
export function launchLeaseExpiry(now: number, leaseMs?: number): string {
  return new Date(now + (leaseMs ?? DEFAULT_LAUNCH_LEASE_SEC * 1000)).toISOString();
}

type LogStream = "stdout" | "stderr";
type LogFn = (stream: LogStream, message: string) => void | Promise<void>;

/**
 * Structural slices of `CoreV1Api` / `BatchV1Api`.  Narrow on purpose: the real
 * clients satisfy these, and tests can supply plain objects.
 */
export interface SecretSweepObjectMeta {
  name?: string;
  labels?: { [key: string]: string };
  annotations?: { [key: string]: string };
  ownerReferences?: unknown[];
  creationTimestamp?: Date | string;
  deletionTimestamp?: Date | string;
}

export interface SecretSweepCoreApi {
  listNamespacedSecret(req: { namespace: string; labelSelector?: string }): Promise<{
    items: { metadata?: SecretSweepObjectMeta }[];
  }>;
  deleteNamespacedSecret(req: { name: string; namespace: string }): Promise<unknown>;
  patchNamespacedSecret?(req: { name: string; namespace: string; body: unknown }): Promise<unknown>;
}

export interface LaunchLeaseTarget {
  name: string;
  namespace: string;
}

/**
 * Keep launch leases alive while the launching process is still able to create
 * the Job. A timestamp by itself is not a coordination boundary: an uncancelled
 * K8s request can outlive it. Renewing on the Secret makes the claim visible to
 * every replica, while a process crash naturally stops renewals and lets the
 * sweep collect the orphan.
 */
export function createLaunchLeaseHeartbeat(args: {
  coreApi: Pick<SecretSweepCoreApi, "patchNamespacedSecret">;
  leaseMs: number;
  onError?: (err: unknown) => void | Promise<void>;
}): {
  add(target: LaunchLeaseTarget): void;
  markCreated(target: LaunchLeaseTarget): void;
  assertLaunchSafe(): Promise<void>;
  stop(): void;
} {
  const targets = new Map<string, LaunchLeaseTarget>();
  const intervalMs = Math.max(1_000, Math.floor(args.leaseMs / 3));
  const requestTimeoutMs = Math.max(1_000, Math.min(intervalMs - 1, 10_000));
  // Track requests per Secret. A hung patch for one target must not suppress
  // renewals for the other targets or later timer ticks.
  const renewing = new Map<string, symbol>();
  const created = new Set<string>();
  const renewTarget = async (target: LaunchLeaseTarget): Promise<boolean> => {
    if (typeof args.coreApi.patchNamespacedSecret !== "function") return true;
    const key = `${target.namespace}/${target.name}`;
    if (renewing.has(key)) return false;
    const renewalToken = Symbol(key);
    renewing.set(key, renewalToken);
    const request = Promise.resolve(args.coreApi.patchNamespacedSecret({
      name: target.name,
      namespace: target.namespace,
      body: { metadata: { annotations: { [LAUNCH_LEASE_ANNOTATION]: launchLeaseExpiry(Date.now(), args.leaseMs) } } },
    }));
    request.catch(() => undefined);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        request,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error(`lease renewal timed out after ${requestTimeoutMs}ms`)), requestTimeoutMs);
        }),
      ]);
      return true;
    } catch (err) {
      await args.onError?.(err);
      return false;
    } finally {
      if (timeout) clearTimeout(timeout);
      if (renewing.get(key) === renewalToken) renewing.delete(key);
    }
  };
  const renew = async () => {
    if (targets.size === 0 || typeof args.coreApi.patchNamespacedSecret !== "function") return;
    await Promise.all([...targets.values()].map((target) => renewTarget(target)));
  };
  const timer = setInterval(() => { void renew(); }, intervalMs);
  timer.unref?.();
  return {
    add(target) { targets.set(`${target.namespace}/${target.name}`, target); },
    markCreated(target) { created.add(`${target.namespace}/${target.name}`); },
    async assertLaunchSafe() {
      for (const key of created) {
        const target = targets.get(key);
        if (!target) continue;
        if (!(await renewTarget(target))) throw new Error(`launch lease renewal failed for ${key}`);
      }
    },
    stop() { clearInterval(timer); targets.clear(); created.clear(); renewing.clear(); },
  };
}

export interface SecretSweepBatchApi {
  listNamespacedJob(req: { namespace: string; labelSelector?: string }): Promise<{
    items: { metadata?: SecretSweepObjectMeta }[];
  }>;
  /**
   * Point read used to re-confirm absence immediately before a delete.  Rejects
   * when the Job does not exist; the sweep treats *any* rejection as "cannot
   * prove it is gone" and keeps the Secret.
   */
  readNamespacedJob(req: { name: string; namespace: string }): Promise<unknown>;
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
  retained: {
    name: string;
    reason: "owned" | "too_young" | "launch_in_flight" | "job_exists" | "no_run_id" | "unverifiable";
  }[];
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

/** HTTP status carried by a rejected `@kubernetes/client-node` request, if any. */
function errorStatusCode(err: unknown): number | null {
  if (typeof err !== "object" || err === null) return null;
  for (const key of ["code", "statusCode", "status"] as const) {
    const value = (err as Record<string, unknown>)[key];
    if (typeof value === "number") return value;
  }
  const body = (err as { body?: unknown }).body;
  if (typeof body === "object" && body !== null) {
    const code = (body as { code?: unknown }).code;
    if (typeof code === "number") return code;
  }
  return null;
}

/**
 * True only when the API server positively reports the Job as gone (404).  A
 * successful read means it is back and its Secret must be kept; any other error
 * — throttling, timeout, RBAC, a client that predates `readNamespacedJob` —
 * means we do not know, and not knowing is not grounds for deleting a
 * credential.  Both of those return false.
 */
async function confirmJobAbsent(args: {
  batchApi: SecretSweepBatchApi;
  namespace: string;
  name: string;
}): Promise<boolean> {
  const { batchApi, namespace, name } = args;
  if (typeof batchApi.readNamespacedJob !== "function") return false;
  try {
    await batchApi.readNamespacedJob({ name, namespace });
    return false;
  } catch (err) {
    return errorStatusCode(err) === 404;
  }
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
    // A lease still in the future means a replica — possibly not this one — is
    // mid-launch and expects to own this Secret shortly.  An unparseable lease
    // is honoured as "in flight" rather than ignored: the failure mode of
    // waiting is a delayed cleanup, the failure mode of guessing is deleting a
    // live credential.  A missing lease falls through to the Job checks, which
    // is how pre-lease orphans still get collected.
    const lease = secret.metadata?.annotations?.[LAUNCH_LEASE_ANNOTATION];
    if (lease !== undefined) {
      const leaseMs = toMillis(lease);
      if (leaseMs === null || now < leaseMs) {
        result.retained.push({ name, reason: "launch_in_flight" });
        continue;
      }
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
    // The list above is a snapshot; a Job created since is exactly the case we
    // must not delete through.  Re-read the one Job this Secret names, so the
    // extra call is paid once per actual orphan rather than per Secret.  A read
    // that resolves *or* fails for any reason other than a definite 404 leaves
    // the Secret alone — absence has to be proven, not assumed.  A name we
    // cannot map to a Job at all is unprovable by construction, so it is
    // retained and left to the dashboard rather than deleted on the snapshot.
    if (owningJobName === null) {
      result.retained.push({ name: candidate.name, reason: "unverifiable" });
      continue;
    }
    const stillAbsent = await confirmJobAbsent({
      batchApi,
      namespace,
      name: owningJobName,
    });
    if (!stillAbsent) {
      result.retained.push({ name: candidate.name, reason: "unverifiable" });
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
