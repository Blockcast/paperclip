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
 *      flight can never have its credentials collected out from under it.  Age
 *      is measured from the later of `creationTimestamp` and the
 *      `paperclip.io/launch-at` annotation, because an adopted Secret keeps the
 *      orphan's `creationTimestamp` (see `LAUNCH_AT_ANNOTATION`).
 *   4. No Job appears to own it, by *either* of two independent checks — the
 *      run-id label, or the `<jobName>-<suffix>` name convention.  Only one has
 *      to say "a Job exists" for the Secret to be left alone.  The name-derived
 *      Job is then re-read directly from the API server immediately before the
 *      delete, so a Job created after the list snapshot still saves its Secret.
 *   5. It is unchanged since it was listed.  The delete carries the listed
 *      `resourceVersion` as a precondition, so the API server refuses it (409)
 *      if anything has written the Secret since the snapshot.
 *
 * Checks 3 and 4 are what make this safe under concurrency, and they are
 * deliberately of different kinds.  4 asks "is there a Job?", which is only ever
 * a snapshot — between any observation and the delete that follows it, a launch
 * can create the Job we just failed to see.  Re-reading narrows that window but
 * cannot close it.  3 closes it from the other side, by refusing to judge any
 * Secret young enough that a launch could still plausibly be working on it.
 *
 * Neither covers adoption, because 3 judges age from the list snapshot.  A
 * different agent's `execute()` can adopt the Secret (merge-PATCH it, refreshing
 * `launch-at`) after the sweep has listed it as old and before the sweep's
 * delete; its Job does not exist yet, so the re-read in 4 still 404s.  The
 * per-agent creation mutex does not serialise the two, since the sweep gate is
 * module-level.  5 closes that at no API cost: any write since the snapshot,
 * the adopt PATCH included, turns the delete into a 409.  That fails in the
 * right direction: the Secret is retained, and the next sweep re-judges it on
 * fresh data.
 *
 * The age floor does that job with nothing but timestamps written once on the
 * object itself, which is why this module has no lease, no renewal timer
 * and no coordination with the launching replica.  An earlier revision stamped a
 * renewable `launch-expires-at` lease on each Secret and raced the Job create
 * against its renewals; that let a cleanup path abort healthy launches and
 * delete Jobs that had already been created, which is a far worse failure than
 * the orphan it was collecting.  A write-once timestamp needs no renewing, is
 * identical from every replica, and survives a crash by construction: a crash
 * leaves it stale, which only makes the Secret *more* collectable, never less.
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
/**
 * ISO-8601 time of the latest launch write to a run Secret, stamped by
 * `createOrAdoptRunSecret` (execute.ts) on both the create and the adopt
 * write.  The age floor needs it because adoption is a merge PATCH, which
 * resets neither `creationTimestamp` nor `ownerReferences`: a retry that adopts
 * an hours-old orphan would otherwise present a Secret that is ownerless, past
 * the floor, and Job-less until its own Job create lands -- every check passing
 * in the wrong direction for a live launch (PR #2325 review).
 */
export const LAUNCH_AT_ANNOTATION = "paperclip.io/launch-at";

/** Suffixes appended to `jobName` to name each run Secret (job-manifest.ts). */
export const RUN_SECRET_SUFFIXES = ["-prompt", "-env", "-mcp"] as const;

export const DEFAULT_SWEEP_INTERVAL_SEC = 300;
/**
 * How long a Secret is immune from the sweep, measured from its latest launch
 * write (see `LAUNCH_AT_ANNOTATION`).  This is the only thing protecting a
 * launch in flight, so it is sized as a bound on "no longer plausibly
 * launching" rather than on the happy path: the three Secret creates and the Job create are bare awaits on the
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
  annotations?: { [key: string]: string };
  ownerReferences?: unknown[];
  creationTimestamp?: Date | string;
  deletionTimestamp?: Date | string;
  /** Opaque write version; the delete's precondition (check 5). */
  resourceVersion?: string;
}

export interface SecretSweepCoreApi {
  listNamespacedSecret(req: { namespace: string; labelSelector?: string }): Promise<{
    items: { metadata?: SecretSweepObjectMeta }[];
  }>;
  deleteNamespacedSecret(req: {
    name: string;
    namespace: string;
    body?: { preconditions?: { resourceVersion?: string } };
  }): Promise<unknown>;
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
    reason: "owned" | "too_young" | "job_exists" | "no_run_id" | "unnamed" | "unverifiable" | "changed";
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

/**
 * When this Secret was last claimed by a launch: the later of its creation and
 * its `LAUNCH_AT_ANNOTATION`.  Null -- judged "too young" -- when either is
 * present but unreadable; we never delete something whose age we cannot
 * establish.  An absent annotation (a Secret from an older adapter build) falls
 * back to `creationTimestamp` alone.
 */
function launchBasisMillis(meta: SecretSweepObjectMeta | undefined): number | null {
  const createdMs = toMillis(meta?.creationTimestamp);
  if (createdMs === null) return null;
  const launchAt = meta?.annotations?.[LAUNCH_AT_ANNOTATION];
  if (launchAt === undefined) return createdMs;
  const launchMs = toMillis(launchAt);
  return launchMs === null ? null : Math.max(createdMs, launchMs);
}

/**
 * Emit a log line that can never throw.  `onLog` streams to the control plane,
 * so a transient rejection is plausible, and this module's contract is that
 * cleanup never fails a run.  try/await rather than `.catch()`, because a
 * `LogFn` may return no promise at all.
 */
async function logQuietly(onLog: LogFn, stream: LogStream, message: string): Promise<void> {
  try {
    await onLog(stream, message);
  } catch {
    // The log sink is gone; there is nowhere left to report that it is gone.
  }
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
  //
  // isFinite, not `??`: Math.max is NaN-transparent, so a NaN floor would make
  // `now - createdMs < ageFloorMs` false for every Secret and disarm the age
  // check completely -- the exact failure the clamp exists to prevent, reached
  // through a different door than an explicit 0.  The execute.ts call site
  // cannot produce NaN (asNumber filters it), but this function is exported
  // with `ageFloorMs?: number`, so the clamp must not depend on a guarantee
  // held in another module.  Infinity is rejected for the same reason.
  //
  // The highest-consequence value isFinite rejects is `undefined`, and that is
  // why `!Number.isNaN(opts.ageFloorMs)` is NOT an equivalent simplification:
  // Number.isNaN(undefined) is false (unlike global isNaN), so undefined would
  // pass through to Math.max(300000, undefined) -> NaN -> age check disarmed
  // on the DEFAULT path, and live Secrets get deleted.  The old `?? DEFAULT`
  // handled undefined structurally; isFinite now carries that job implicitly.
  const ageFloorMs = Math.max(
    MIN_SWEEP_AGE_FLOOR_SEC * 1000,
    Number.isFinite(opts.ageFloorMs)
      ? (opts.ageFloorMs as number)
      : DEFAULT_SWEEP_AGE_FLOOR_SEC * 1000,
  );
  // Make the override observable at the moment it happens: an operator or test
  // that deliberately sets a low floor otherwise gets 300s with no signal, and
  // has to infer the clamp from behaviour.  `!==` rather than `<` so a rejected
  // non-finite floor is reported too -- `NaN < x` is false and would be silent.
  // "overridden", not "raised": `!==` covers the lowering too (Infinity yields
  // the 900000 default, which went DOWN), so the verb has to cover both.
  if (opts.ageFloorMs !== undefined && opts.ageFloorMs !== ageFloorMs) {
    await logQuietly(
      onLog,
      "stderr",
      `[paperclip] Orphan-secret sweep age floor overridden to ${ageFloorMs}ms (requested ${opts.ageFloorMs})\n`,
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
  const candidates: { name: string; runId: string; ageMs: number; resourceVersion?: string }[] = [];
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
    const launchedMs = launchBasisMillis(secret.metadata);
    // An unreadable timestamp is treated as "too young": we never delete
    // something whose age we cannot establish.  The floor is also the only
    // thing standing between a launch still in flight and the deletion of its
    // credentials, so it is applied before any Job lookup.
    if (launchedMs === null || now - launchedMs < ageFloorMs) {
      result.retained.push({ name, reason: "too_young" });
      continue;
    }
    candidates.push({
      name,
      runId,
      ageMs: now - launchedMs,
      resourceVersion: secret.metadata?.resourceVersion,
    });
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
    // That is naming-convention drift, not API trouble, so it has its own
    // reason: the two want different operator responses.
    if (owningJobName === null) {
      result.retained.push({ name: candidate.name, reason: "unnamed" });
      continue;
    }
    // Check 5 needs the snapshot's write version.  Every real list item carries
    // one; a delete that cannot be made conditional is a delete on the
    // snapshot alone, so a listing without it retains.
    if (!candidate.resourceVersion) {
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
      await coreApi.deleteNamespacedSecret({
        name: candidate.name,
        namespace,
        body: { preconditions: { resourceVersion: candidate.resourceVersion } },
      });
      result.swept.push(candidate.name);
      await logQuietly(
        onLog,
        "stdout",
        `[paperclip] Swept ownerless Secret ${candidate.name} (run-id ${candidate.runId}, age ${Math.round(candidate.ageMs / 1000)}s, no owning Job)\n`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (errorStatusCode(err) === 409) {
        // The precondition held: something wrote this Secret after the list,
        // most likely an adopting launch.  Retain, not fail.
        result.retained.push({ name: candidate.name, reason: "changed" });
        await logQuietly(
          onLog,
          "stdout",
          `[paperclip] Kept Secret ${candidate.name}: it changed after the sweep listed it (delete precondition failed); the next sweep re-judges it\n`,
        );
        continue;
      }
      result.failed.push({ name: candidate.name, error: message });
      await logQuietly(
        onLog,
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
      // Deliberately not awaited.  This line is outside the race above, and
      // `onLog` streams to the control plane: a sink that never settles is the
      // same hang the timeout exists for, and awaiting it here would hold the
      // per-agent mutex for the process lifetime all the same.  `logQuietly`
      // never rejects, so nothing is left unhandled; a hung sink leaks one
      // pending promise per failed sweep, bounded by the interval gate.
      void logQuietly(
        opts.onLog,
        "stderr",
        `[paperclip] Orphan-secret sweep failed (non-fatal): ${message}\n`,
      );
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}
