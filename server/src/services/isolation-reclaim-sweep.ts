import type { Db } from "@paperclipai/db";
import { logger as defaultLogger } from "../middleware/logger.js";
import {
  type DriveIsolationReclaimOptions,
  type ReclaimClaimOutcome,
  type ReclaimClaimTemplate,
  driveIsolationReclaim,
} from "./isolation-reclaim-driver.js";
import type { ReclaimJobPort } from "./isolation-reclaim-runner.js";
import { recordIsolationReclaimSweep } from "./metrics.js";
import {
  type ReclaimableClaim,
  type WorkspaceUsageLookup,
  createDbWorkspaceUsageLookup,
  listReclaimableClaims,
} from "./isolation-workspace-reaper.js";

/**
 * The fleet loop over foreign claims, and the thing that schedules it (PEN-5151).
 *
 * `driveIsolationReclaim` takes one claim from inventory to unlink. This asks
 * which claims there are, drives them, and adds up what came back. It is the
 * last layer: with this wired, a per-agent or operator claim the server cannot
 * walk is swept by the same `{home, session}` allowlist and the same
 * `lastUsedAt` predicate the mounted sweep uses.
 *
 * ## Claims are driven one at a time
 *
 * Not for simplicity. Deletion on this filesystem is MDS-metadata-bound, which
 * is the whole reason `DEFAULT_MAX_DELETES_PER_TICK` exists — and every claim's
 * executor is another unlink source against the **same** MDS. Driving N claims
 * concurrently multiplies the per-tick bound by N and quietly removes the
 * protection it was there to give. Sequential drives also keep the number of
 * concurrent reclaim pods at one, which matters because each holds a
 * `ReadWriteMany` mount for its whole wait.
 *
 * ## The per-tick bound needs a rotation, or the tail never gets swept
 *
 * A drive is up to two Jobs, each with a wait budget of its
 * `activeDeadlineSeconds` plus a startup grace — on the defaults, roughly 25
 * minutes apiece. So a fleet of any size outruns a daily tick, and
 * `maxClaimsPerTick` is how that is kept bounded rather than left to the
 * scheduler's in-flight guard to truncate arbitrarily.
 *
 * Taking the first N every tick would then sweep the same head forever and
 * never reach the tail — the same starvation the plan builder avoids by
 * ordering oldest-idle first. There is no equivalent signal here (nothing is
 * known about a claim before it is inventoried), so the rotation is positional:
 * claims are sorted by name, the tick starts after the last claim the previous
 * tick reached, and wraps. `cursor` is returned rather than held here so this
 * function stays pure in the way that matters — two calls with the same inputs
 * do the same thing — and the scheduler owns the one piece of state.
 *
 * ## `reclaimed` is a LOWER BOUND, and says so
 *
 * Every failure outcome can carry `deletionOutcomeUnknown`, which must never be
 * summed as a zero: "reclaimed 0" is a measurement that was never taken, and it
 * is the exact number the ≈3.7-month per-agent ceiling is tracked by. So the
 * total is reported beside `unknownOutcomeClaims` and the derived
 * `reclaimedIsLowerBound`, rather than as a bare figure an operator would read
 * as complete.
 *
 * ## What aborts a sweep, and what does not
 *
 * A failing drive does not: it is one claim's outcome among several, and
 * stopping would let one unreachable claim mask every other claim's growth.
 * `listReclaimableClaims` failing **does** abort, because a partial claim list
 * is indistinguishable from a shorter fleet — the sweep would report success
 * over a population it never saw, which is the failure mode the mounted sweep's
 * `scanned` identity exists to prevent.
 */

/** Claims per tick. See the header: a drive is two Jobs and a pair of waits. */
export const DEFAULT_MAX_CLAIMS_PER_TICK = 8;

export interface IsolationReclaimSweepResult {
  /** Claims `listReclaimableClaims` named. */
  claimsFound: number;
  /** Claims actually driven this tick, bounded by `maxClaimsPerTick`. */
  claimsDriven: number;
  /** Named but past the bound. Picked up by the next tick via `cursor`. */
  claimsDeferred: number;
  /** Drives that returned `ok`. Includes the quiet "nothing eligible" tick. */
  claimsOk: number;
  claimsFailed: number;
  /**
   * Directories unlinked, summed across claims. A LOWER BOUND whenever
   * `unknownOutcomeClaims` is non-zero; see the header.
   */
  reclaimed: number;
  /** Directories that would have been unlinked, under `dryRun`. */
  wouldReclaim: number;
  /** Claims whose drive may have deleted an unknown amount. */
  unknownOutcomeClaims: number;
  /**
   * True when `reclaimed` cannot be read as a total. Redundant with
   * `unknownOutcomeClaims` by construction, and kept for the same reason the
   * plan keeps `truncated` beside `droppedByBound`: one boolean an operator can
   * alert on without arithmetic.
   */
  reclaimedIsLowerBound: boolean;
  /**
   * The last claim name this tick reached, or `null` when no claim was driven.
   * Hand it back as `startAfterClaimName` to resume after it.
   */
  cursor: string | null;
  outcomes: ReclaimClaimOutcome[];
}

export interface IsolationReclaimSweepOptions {
  template: ReclaimClaimTemplate;
  port: ReclaimJobPort;
  /**
   * The claim this deployment itself mounts, excluded from the sweep.
   *
   * REQUIRED, and `null` is a deliberate "this deployment holds no claim to
   * exclude" rather than a shrug — `listReclaimableClaims` takes the same
   * position, because failing open here means launching `rm -rf` against the
   * volume the mounted sweep is already walking.
   */
  selfClaimName: string | null;
  /** Idle threshold, shared verbatim with the mounted sweep. */
  maxAgeDays: number;
  /** One per tick. Job names prefix the mode and embed the claim, so it is safe to share. */
  invocationId: string;
  lookupWorkspaceUsage?: WorkspaceUsageLookup;
  maxClaimsPerTick?: number;
  maxDeletes?: number;
  maxPlanAgeMs?: number;
  dryRun?: boolean;
  /** Resume point from the previous tick's `cursor`. */
  startAfterClaimName?: string | null;
  startupGraceMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
  logger?: typeof defaultLogger;
  /** Seam: the per-claim drive, so the loop is testable without a cluster. */
  drive?: (options: DriveIsolationReclaimOptions) => Promise<ReclaimClaimOutcome>;
  /** Seam: claim enumeration, so the loop is testable without a database. */
  listClaims?: (selfClaimName: string | null) => Promise<ReclaimableClaim[]>;
}

/**
 * Order the claims for one tick: sorted by name, rotated to start after
 * `startAfterClaimName`.
 *
 * Exported for its own test. The rotation is the part that is easy to get
 * subtly wrong — a resume point that is no longer in the list (the agent opted
 * back out) must not restart from the head, or the tail starves exactly as it
 * would with no rotation at all. The successor is found by name order rather
 * than by index, so a departed cursor resumes at whatever now sits where it
 * was.
 */
export function orderClaimsForTick(
  claims: ReadonlyArray<ReclaimableClaim>,
  startAfterClaimName: string | null,
): ReclaimableClaim[] {
  const sorted = [...claims].sort((a, b) => (a.claimName < b.claimName ? -1 : a.claimName > b.claimName ? 1 : 0));
  if (!startAfterClaimName || sorted.length === 0) return sorted;
  // First claim strictly after the cursor by name. Two cases collapse into the
  // same answer and both must return the WHOLE list, not an empty one: `0`
  // means every claim already sorts after the cursor, and `-1` means none does
  // — the cursor was the last name, or has left the fleet entirely — which is
  // the wrap back to the head. Returning `[]` for the wrap would stop the
  // rotation dead for good, since the cursor only ever advances.
  const index = sorted.findIndex((claim) => claim.claimName > startAfterClaimName);
  if (index <= 0) return sorted;
  return [...sorted.slice(index), ...sorted.slice(0, index)];
}

export async function sweepIsolationReclaim(
  db: Db,
  options: IsolationReclaimSweepOptions,
): Promise<IsolationReclaimSweepResult> {
  const log = options.logger ?? defaultLogger;
  const maxClaimsPerTick = options.maxClaimsPerTick ?? DEFAULT_MAX_CLAIMS_PER_TICK;
  const lookupWorkspaceUsage = options.lookupWorkspaceUsage ?? createDbWorkspaceUsageLookup(db);
  const listClaims =
    options.listClaims ?? ((selfClaimName: string | null) => listReclaimableClaims(db, selfClaimName));
  const drive = options.drive ?? driveIsolationReclaim;

  // Deliberately NOT caught. See the header: a partial list reads as a shorter
  // fleet, and the sweep would report success over a population it never saw.
  const claims = await listClaims(options.selfClaimName);

  const ordered = orderClaimsForTick(claims, options.startAfterClaimName ?? null);
  const selected = ordered.slice(0, Math.max(0, maxClaimsPerTick));

  const result: IsolationReclaimSweepResult = {
    claimsFound: claims.length,
    claimsDriven: 0,
    claimsDeferred: ordered.length - selected.length,
    claimsOk: 0,
    claimsFailed: 0,
    reclaimed: 0,
    wouldReclaim: 0,
    unknownOutcomeClaims: 0,
    reclaimedIsLowerBound: false,
    cursor: null,
    outcomes: [],
  };

  for (const claim of selected) {
    // Sequential by design; see the header on the MDS bound.
    let outcome: ReclaimClaimOutcome;
    try {
      outcome = await drive({
        claim,
        template: options.template,
        port: options.port,
        lookupWorkspaceUsage,
        maxAgeDays: options.maxAgeDays,
        invocationId: options.invocationId,
        maxDeletes: options.maxDeletes,
        maxPlanAgeMs: options.maxPlanAgeMs,
        dryRun: options.dryRun,
        startupGraceMs: options.startupGraceMs,
        pollIntervalMs: options.pollIntervalMs,
        now: options.now,
        logger: log,
      });
    } catch (error) {
      // The drive is written to return a value for every outcome, so reaching
      // here is a defect rather than a cluster fault. Recorded against the
      // claim and the sweep continues: one claim's bug must not stop the
      // others, and the unknown is set because a drive that threw past its own
      // handling may have got as far as launching an execute Job.
      log.error(
        { err: error, claim: claim.claimName },
        "isolation reclaim drive threw past its own error handling",
      );
      outcome = {
        claimName: claim.claimName,
        agentId: claim.agentId,
        source: claim.source,
        phase: "execute",
        ok: false,
        failureKind: "execute_run_failed",
        detail: error instanceof Error ? error.message : String(error),
        plan: null,
        result: null,
        nothingEligible: false,
        dryRun: options.dryRun === true,
        adoptedInventory: false,
        adoptedExecute: false,
        deletionOutcomeUnknown: true,
        inventoryJobName: null,
        executeJobName: null,
      };
    }

    result.outcomes.push(outcome);
    result.claimsDriven += 1;
    // Set per claim. Equivalent to assigning `selected[last]` after the loop
    // today — nothing inside it can throw, since the drive is wrapped — so this
    // is not load-bearing now and is not claimed to be. It is the form that
    // stays correct if the loop ever gains an early exit (a time budget, a
    // circuit breaker), where a post-loop assignment would record claims the
    // tick never reached and skip them on the next one.
    result.cursor = claim.claimName;
    if (outcome.ok) result.claimsOk += 1;
    else result.claimsFailed += 1;
    if (outcome.deletionOutcomeUnknown) result.unknownOutcomeClaims += 1;
    result.reclaimed += outcome.result?.deleted ?? 0;
    result.wouldReclaim += outcome.result?.wouldDelete ?? 0;
  }

  result.reclaimedIsLowerBound = result.unknownOutcomeClaims > 0;

  log.info(
    {
      claimsFound: result.claimsFound,
      claimsDriven: result.claimsDriven,
      claimsDeferred: result.claimsDeferred,
      claimsFailed: result.claimsFailed,
      reclaimed: result.reclaimed,
      wouldReclaim: result.wouldReclaim,
      unknownOutcomeClaims: result.unknownOutcomeClaims,
      reclaimedIsLowerBound: result.reclaimedIsLowerBound,
      cursor: result.cursor,
      dryRun: options.dryRun === true,
    },
    "isolation reclaim sweep complete",
  );

  // After the log line and before the return, so a metrics fault cannot cost
  // the log line -- the recorder swallows its own errors, but the ordering
  // makes that belt-and-braces rather than load-bearing.
  //
  // Reached only on the completion path. The claim-list failure above throws
  // past this deliberately: it records no sweep, which is correct, because no
  // claim was assessed. That shows up as the liveness gauge going stale rather
  // than as a sweep with an unhappy label, and those are the same fact.
  recordIsolationReclaimSweep(result, {
    dryRun: options.dryRun === true,
    now: options.now ?? Date.now,
  });

  return result;
}

export type IsolationReclaimSweepScheduler = {
  setInterval: (callback: () => void, intervalMs: number) => ReturnType<typeof setInterval>;
  clearInterval: (timer: ReturnType<typeof setInterval>) => void;
};

const defaultScheduler: IsolationReclaimSweepScheduler = { setInterval, clearInterval };

/**
 * Tick the sweep on an interval, carrying the rotation cursor across ticks.
 *
 * Mirrors `startIsolationWorkspaceReaper`, including the in-flight guard: a
 * sweep that outruns its interval must not stack concurrent passes, which here
 * would mean two ticks driving the same claim under two invocation ids.
 *
 * The invocation id is generated per tick rather than taken as an option,
 * because a repeated id is an adoption and a scheduler that reused one would
 * silently re-attach to the previous tick's Jobs instead of starting new ones.
 * It is kept SHORT on purpose: `reclaimJobName` truncates the CLAIM to fit 63
 * characters, so every character spent on the invocation id is one taken off
 * the claim, and two claims truncated to a shared prefix collide on one Job
 * name. At the length below the claim keeps enough of its uuid that a collision
 * needs twenty matching hex digits.
 */
export function startIsolationReclaimSweep(
  db: Db,
  intervalMs: number,
  options: Omit<IsolationReclaimSweepOptions, "invocationId" | "startAfterClaimName">,
  scheduler: IsolationReclaimSweepScheduler = defaultScheduler,
): () => void {
  const log = options.logger ?? defaultLogger;
  const now = options.now ?? Date.now;
  // Built once: the lookup holds no per-tick state.
  const lookupWorkspaceUsage = options.lookupWorkspaceUsage ?? createDbWorkspaceUsageLookup(db);
  let cursor: string | null = null;
  let inFlight: Promise<void> | null = null;

  const runTick = () => {
    if (inFlight) return;
    inFlight = sweepIsolationReclaim(db, {
      ...options,
      lookupWorkspaceUsage,
      invocationId: nextInvocationId(now()),
      startAfterClaimName: cursor,
    })
      .then((result) => {
        // Only advanced on a tick that drove something. A tick that found no
        // claims leaves the cursor where it was, so the rotation does not skip
        // whatever comes next when claims reappear.
        if (result.cursor !== null) cursor = result.cursor;
      })
      .catch((err) => {
        log.error({ err }, "isolation reclaim sweep failed");
      })
      .finally(() => {
        inFlight = null;
      });
  };

  runTick();
  const timer = scheduler.setInterval(runTick, intervalMs);
  return () => scheduler.clearInterval(timer);
}

/**
 * A short, per-tick invocation id: minutes since epoch in base36, plus four
 * random characters.
 *
 * Eight to nine characters total. The time component makes a Job name readable
 * back to the tick that created it; the random suffix keeps two deployments
 * ticking in the same minute from adopting each other's Jobs.
 */
export function nextInvocationId(nowMs: number): string {
  const minutes = Math.floor(nowMs / 60_000).toString(36);
  const suffix = Math.floor(Math.random() * 36 ** 4)
    .toString(36)
    .padStart(4, "0");
  return `${minutes}${suffix}`;
}
