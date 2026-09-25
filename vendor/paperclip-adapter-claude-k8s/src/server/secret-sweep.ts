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
 *   3. It is older than the age floor, which is sized so that a launch still in
 *      flight can never have its credentials collected out from under it.
 *   4. No Job appears to own it, by *either* of two independent checks — the
 *      run-id label, or the `<jobName>-<suffix>` name convention.  Only one has
 *      to say "a Job exists" for the Secret to be left alone.  The name-derived
 *      Job is then re-read directly from the API server immediately before the
 *      delete, so a Job created after the list snapshot still saves its Secret.
 *
 * Checks 3 and 4 are what make this safe under concurrency, and they are
 * deliberately of different kinds.  4 asks "is there a Job?", which is only ever
 * a snapshot — between any observation and the delete that follows it, a launch
 * can create the Job we just failed to see.  Re-reading narrows that window but
 * cannot close it.  3 closes it from the other side, by refusing to judge any
 * Secret young enough that a launch could still plausibly be working on it.
 *
 * The age floor does that job with nothing but the object's own
 * `creationTimestamp`, which is why this module has no lease, no renewal timer
 * and no coordination with the launching replica.  An earlier revision stamped a
 * renewable `launch-expires-at` lease on each Secret and raced the Job create
 * against its renewals; that let a cleanup path abort healthy launches and
 * delete Jobs that had already been created, which is a far worse failure than
 * the orphan it was collecting.  A creation timestamp needs no renewing, is
 * identical from every replica, and survives a crash by construction.
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
export const MANAGED_BY_VALUE = "paperclip";
export const ADAPTER_TYPE_LABEL = "paperclip.io/adapter-type";
export const ADAPTER_TYPE = "claude_k8s";

/** Suffixes appended to `jobName` to name each run Secret (job-manifest.ts). */
export const RUN_SECRET_SUFFIXES = ["-prompt", "-env", "-mcp"] as const;

export const DEFAULT_SWEEP_INTERVAL_SEC = 300;
/**
 * How long a Secret is immune from the sweep, measured from its own
 * `creationTimestamp`.  This is the only thing protecting a launch in flight, so
 * it is sized as a bound on "no longer plausibly launching" rather than on the
 * happy path: the three Secret creates and the Job create are bare awaits on the
 * K8s API, so nothing in the code bounds the gap between them.  (An earlier
 * revision claimed the 15s concurrency-guard timeout did; that guard wraps only
 * the pre-launch Job lookup in execute.ts, not these calls.)  A launch that has
 * not produced a Job in 15 minutes is wedged, not slow, and its Pod would have
 * been declared unschedulable long before.
 *
 * The cost of the floor being generous is that a genuinely orphaned Secret waits
 * this long before collection, which is immaterial against orphans that
 * currently survive for weeks.
 */
export const DEFAULT_SWEEP_AGE_FLOOR_SEC = 900;
/**
 * Hard lower bound on the effective age floor, applied to whatever the caller
 * supplies.  The floor is the *only* thing protecting a launch in flight, so a
 * config knob must not be able to set it to nothing: `ageFloorMs: 0` would make
 * every Secret a candidate the instant it is created — including the three a
 * live launch has just written and not yet owned, whose Job does not exist yet
 * and so fails both Job checks and the pre-delete re-read (PR #1459 review).
 *
 * Five minutes is far above any plausible Secret-create-to-Job-create gap,
 * including a throttled API server, while still letting an operator tune
 * collection well below the 15-minute default.  Clamping *up* is the right
 * direction for a floor: a too-low value means "collect sooner", never "disable
 * the sweep", and the failure this bound prevents is deleting live credentials.
 */
export const MIN_SWEEP_AGE_FLOOR_SEC = 300;
/**
 * Wall-clock bound on a single sweep, enforced by the gate.
 *
 * The sweep runs inside `execute()`'s per-agent creation mutex, which is
 * released only in a `finally` far below the call site — so a `listNamespacedSecret`
 * that never settles would not merely stall its own run, it would hold that
 * agent's mutex slot for the lifetime of the process and block every subsequent
 * `execute()` for that agent.  Swallowing rejections is not enough: a hang is
 * not a rejection.  That the neighbouring pre-launch Job lookup already carries
 * a 15s timeout is good evidence this API does hang here (PR #1459 review).
 *
 * 15s matches that neighbouring guard.  Abandoning a sweep part-way is safe by
 * construction: deletes already issued stand, and whatever was left is picked up
 * by the next sweep.  Note the asymmetry with the age floor above, which is
 * deliberate rather than an oversight — a too-short timeout fails toward
 * *leaving orphans behind*, which is visible on the dashboard, whereas a
 * too-short age floor fails toward *deleting live credentials*.  Only the latter
 * needs a hard clamp; this one only needs to never be zero.
 */
export const DEFAULT_SWEEP_TIMEOUT_MS = 15_000;

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
  /**
   * Wall-clock bound on one sweep, honoured by the gate from `createSweepGate`.
   * Ignored by `sweepOrphanedRunSecrets`, which has no timer of its own.
   * A non-positive value falls back to the default rather than disabling the
   * bound — see `DEFAULT_SWEEP_TIMEOUT_MS`.
   */
  timeoutMs?: number;
  /** Injectable clock for tests. */
  now?: number;
}

export interface SweepResult {
  /** Names of Secrets successfully deleted. */
  swept: string[];
  /** Names of Secrets examined but deliberately left alone, with the reason. */
  retained: {
    name: string;
    reason: "owned" | "too_young" | "job_exists" | "no_run_id" | "unverifiable";
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
  // Clamped, not just defaulted: an explicitly-supplied 0 must not disarm the
  // only protection a launch in flight has.  See MIN_SWEEP_AGE_FLOOR_SEC.
  const ageFloorMs = Math.max(
    MIN_SWEEP_AGE_FLOOR_SEC * 1000,
    opts.ageFloorMs ?? DEFAULT_SWEEP_AGE_FLOOR_SEC * 1000,
  );
  // Make the override observable at the moment it happens: an operator or test
  // that deliberately sets a low floor otherwise gets 300s with no signal, and
  // has to infer the clamp from behaviour.
  if (opts.ageFloorMs !== undefined && opts.ageFloorMs < ageFloorMs) {
    await onLog(
      "stderr",
      `[paperclip] Orphan-secret sweep age floor raised from ${opts.ageFloorMs}ms to the ${ageFloorMs}ms minimum\n`,
    );
  }
  const now = opts.now ?? Date.now();
  const result: SweepResult = { swept: [], retained: [], failed: [] };

  const secrets = await coreApi.listNamespacedSecret({
    namespace,
    labelSelector: `${MANAGED_BY_LABEL}=${MANAGED_BY_VALUE},${ADAPTER_TYPE_LABEL}=${ADAPTER_TYPE},${RUN_ID_LABEL}`,
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
    // delete something whose age we cannot establish.  The floor is also the
    // only thing standing between a launch still in flight and the deletion of
    // its credentials, so it is applied before any Job lookup.
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
    labelSelector: `${MANAGED_BY_LABEL}=${MANAGED_BY_VALUE},${ADAPTER_TYPE_LABEL}=${ADAPTER_TYPE}`,
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
 * awaiting so concurrent `execute()` calls cannot double-sweep.
 *
 * It is also where the two ways a cleanup path could damage a run are stopped,
 * and they need different mechanisms: errors are swallowed, and a sweep that
 * never settles is abandoned after `timeoutMs`.  A `catch` cannot do the second
 * job — a hang is not a rejection — and the caller holds a per-agent mutex
 * across this call, so an unbounded wait here is not one slow run but a
 * permanently wedged agent.  See `DEFAULT_SWEEP_TIMEOUT_MS`.
 */
export function createSweepGate(): (opts: SweepOptions) => Promise<SweepResult | null> {
  let lastSweptAt = 0;
  return async function maybeSweep(opts: SweepOptions): Promise<SweepResult | null> {
    const now = opts.now ?? Date.now();
    const intervalMs = opts.intervalMs ?? DEFAULT_SWEEP_INTERVAL_SEC * 1000;
    if (lastSweptAt !== 0 && now - lastSweptAt < intervalMs) return null;
    lastSweptAt = now;
    const timeoutMs =
      opts.timeoutMs !== undefined && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_SWEEP_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Promise.race, so a hung API call is *abandoned*, not cancelled: the
      // underlying request stays pending and is simply no longer awaited. That
      // leaks one pending promise per stuck sweep — bounded by the interval gate
      // to one per `intervalMs` — which is the cheaper of the two failures. The
      // alternative is holding the agent's mutex forever.
      return await Promise.race([
        sweepOrphanedRunSecrets(opts),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`orphan-secret sweep timed out after ${timeoutMs}ms`)),
            timeoutMs,
          );
        }),
      ]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await opts.onLog(
        "stderr",
        `[paperclip] Orphan-secret sweep failed (non-fatal): ${message}\n`,
      );
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}
