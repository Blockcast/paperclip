/**
 * Resolves when a `ccrotate_capacity` deferral should next re-probe provider
 * capacity (BLO-23438).
 *
 * Kept in its own module rather than in `heartbeat.ts` deliberately: several
 * suites `vi.doMock` the heartbeat module wholesale, which nulls named exports
 * added to it later, so a pure predicate placed there fails in ways that read
 * like logic bugs.
 *
 * ## Why a ceiling exists
 *
 * The park horizon used to be whatever penstock advertised, verbatim:
 *
 *     scheduledRetryAt = gateResult.resumeAt ?? now + DEFAULT_RETRY_DELAY_MS
 *
 * On 2026-08-08 penstock answered a `claude-sonnet-5[1m]` capacity denial with
 * `retry_after_seconds: 449933` (~5.2 days), so ~76 runs were parked to
 * 2026-08-14T02:59:59Z. By 2026-08-09T00:54Z the same endpoint reported
 * `state: "available"` with 4/6 healthy routes — the horizon was stale within
 * hours, but nothing re-probed, because the promotion-time capacity re-check
 * only runs once `scheduledRetryAt <= now`. That path can therefore only ever
 * *extend* a park, never shorten it.
 *
 * Two things made that worse than a slow retry. `scheduled_retry` is a
 * coalescible status and the coalesce merge does not reset `scheduledRetryAt`,
 * so every subsequent wake on the same task key was absorbed into the parked
 * run and inherited its horizon — the issue became unwakeable by any trigger.
 * And identical advertised horizons produce identical timestamps, so the whole
 * cohort would have released in the same instant, into the dependency whose
 * degradation created the cohort.
 *
 * So we clamp: honour the advertised reset when it is near, and otherwise
 * re-probe at the ceiling. Re-probing is a single cached GET, and a genuinely
 * long outage still terminates — CCROTATE_CAPACITY_MAX_RETRY_ATTEMPTS re-defers
 * then escalate to an operator-visible issue, which is the outcome we want from
 * a multi-day outage rather than silent frozen work.
 */

/**
 * Longest a capacity deferral may park before re-probing. Paired with
 * CCROTATE_CAPACITY_MAX_RETRY_ATTEMPTS (24) this bounds a non-recovering pool at
 * roughly six hours of polling before it escalates for operator attention.
 */
export const CCROTATE_CAPACITY_MAX_PARK_MS = 15 * 60 * 1000;

/**
 * Jitter as a fraction of the resolved delay. Spreads a cohort that was denied
 * against one advertised reset so it does not re-enter the provider in lockstep.
 * Applied additively (never earlier than the resolved instant) so jitter cannot
 * pull a retry in front of a reset the provider actually asked us to wait for.
 */
export const CCROTATE_CAPACITY_PARK_JITTER_RATIO = 0.2;

export interface CcrotateCapacityRetryInput {
  /** `resumeAt` as advertised by the provider, or null when it gave none. */
  resumeAt: Date | null;
  now: Date;
  /** Fallback delay when the provider advertised no usable resume instant. */
  defaultRetryDelayMs: number;
  maxParkMs?: number;
  /** Injectable for tests; defaults to Math.random. */
  random?: () => number;
}

export interface CcrotateCapacityRetryPlan {
  /** When the run should next re-probe capacity. */
  retryAt: Date;
  /**
   * The advertised horizon we declined to honour, ISO-8601, or null when the
   * advertised value was used as-is. Persisted so a clamped park is legible
   * from the run row without reading this code.
   */
  clampedFromIso: string | null;
  /** Whole seconds the provider asked us to wait, when it advertised a future reset. */
  advertisedDelaySeconds: number | null;
}

/**
 * Choose the earliest defensible re-probe instant for a capacity deferral.
 *
 * Returns the advertised reset when it falls inside the ceiling, and the
 * ceiling otherwise, plus positive jitter in both cases.
 */
export function resolveCcrotateCapacityRetry(
  input: CcrotateCapacityRetryInput,
): CcrotateCapacityRetryPlan {
  const nowMs = input.now.getTime();
  const maxParkMs = Math.max(1, input.maxParkMs ?? CCROTATE_CAPACITY_MAX_PARK_MS);
  const random = input.random ?? Math.random;

  const advertisedMs = input.resumeAt ? input.resumeAt.getTime() : null;
  // A resume instant already in the past tells us nothing about the future, so
  // it falls back to the default poll delay rather than resolving to `now`.
  const usableAdvertisedMs =
    advertisedMs !== null && Number.isFinite(advertisedMs) && advertisedMs > nowMs ? advertisedMs : null;

  const baseMs = usableAdvertisedMs ?? nowMs + input.defaultRetryDelayMs;
  const ceilingMs = nowMs + maxParkMs;
  const resolvedMs = Math.min(baseMs, ceilingMs);

  const delayMs = Math.max(resolvedMs - nowMs, 0);
  const jitterMs = Math.floor(random() * delayMs * CCROTATE_CAPACITY_PARK_JITTER_RATIO);

  return {
    retryAt: new Date(resolvedMs + jitterMs),
    clampedFromIso:
      usableAdvertisedMs !== null && usableAdvertisedMs > ceilingMs
        ? new Date(usableAdvertisedMs).toISOString()
        : null,
    advertisedDelaySeconds:
      usableAdvertisedMs !== null ? Math.ceil((usableAdvertisedMs - nowMs) / 1000) : null,
  };
}

/**
 * Every `resultJson` key that describes *which* capacity denial parked a run
 * (BLO-24011). Enumerated so a re-defer can clear the previous decision wholesale
 * before writing the current one: a key that is absent from the new decision must
 * disappear rather than linger with the old gate's value.
 */
const CCROTATE_CAPACITY_DECISION_KEYS = [
  "retryNotBefore",
  "transientRetryNotBefore",
  "penstockProvider",
  "penstockModel",
  "penstockReason",
  "penstockRetryAfterSeconds",
  "penstockAdvertisedResumeAt",
  "penstockCapacityParkClampedFrom",
] as const;

export interface CcrotateCapacityDecision {
  /** The clamped instant the run will actually re-probe at. */
  retryAtIso: string;
  provider?: string | null;
  model?: string | null;
  reason?: string | null;
  retryAfterSeconds?: number | null;
  /** What the provider advertised on *this* denial, ISO-8601, or null. */
  advertisedResumeAtIso: string | null;
  /** The advertised horizon this decision declined to honour, or null. */
  clampedFromIso: string | null;
}

/**
 * Project a capacity denial onto a run's `resultJson` (BLO-24011).
 *
 * A `ccrotate_capacity` park is re-decided every time the run comes due and the
 * pool is still exhausted, but the promotion-time re-defer used to update only
 * `scheduledRetryAttempt`/`scheduledRetryAt` — leaving every descriptive field
 * behind from the *first* denial. That is how the incident row came to read
 * `penstockRetryAfterSeconds: 3834` and `retryNotBefore: 08:00Z` beside a
 * `scheduledRetryAt` four days out: two different gate decisions, one row, and
 * no way to tell from the row that the 3834s figure had been superseded.
 *
 * Both writers go through here so the two can no longer drift, and so a reader
 * can trust that every `penstock*` field describes the park the row currently
 * holds.
 */
export function applyCcrotateCapacityDecision(
  previous: Record<string, unknown>,
  decision: CcrotateCapacityDecision,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...previous };
  for (const key of CCROTATE_CAPACITY_DECISION_KEYS) {
    delete next[key];
  }
  next.errorFamily = "rate_limit_exhausted";
  // `retryNotBefore` is a *floor* consumed by scheduleBoundedRetryForRun, so it
  // carries the clamped instant. The provider's own claim lives under
  // `penstockAdvertisedResumeAt`, where nothing reschedules off it.
  next.retryNotBefore = decision.retryAtIso;
  next.transientRetryNotBefore = decision.retryAtIso;
  if (decision.provider != null) next.penstockProvider = decision.provider;
  if (decision.model != null) next.penstockModel = decision.model;
  if (decision.reason != null) next.penstockReason = decision.reason;
  if (decision.retryAfterSeconds != null) {
    next.penstockRetryAfterSeconds = decision.retryAfterSeconds;
  }
  if (decision.advertisedResumeAtIso !== null) {
    next.penstockAdvertisedResumeAt = decision.advertisedResumeAtIso;
  }
  if (decision.clampedFromIso !== null) {
    next.penstockCapacityParkClampedFrom = decision.clampedFromIso;
  }
  return next;
}

/**
 * Ceiling for a `retryNotBefore` floor supplied by a finalized run (BLO-23438).
 *
 * Deliberately far looser than CCROTATE_CAPACITY_MAX_PARK_MS. This bounds the
 * *general* bounded-retry scheduler, which serves every transient family, so the
 * goal is only to remove the pathological horizon named in the acceptance
 * criteria — not to second-guess ordinary provider backoff. At 24h every retry
 * the fleet actually schedules today is unaffected.
 */
export const MAX_TRANSIENT_RETRY_HORIZON_MS = 24 * 60 * 60 * 1000;

/**
 * Longest provider capacity outage on record (BLO-22844), used only to derive
 * {@link TRANSIENT_HORIZON_CLAMP_MIN_ATTEMPTS} below. Do not widen this ad hoc
 * when a longer outage is observed without re-deriving the attempt count that
 * depends on it — that decoupling is exactly BLO-23525's failure mode.
 */
export const LONGEST_RECORDED_PROVIDER_CAPACITY_WINDOW_MS = 124.8 * 60 * 60 * 1000;

/**
 * Minimum attempt count for any bounded-retry family whose `retryNotBefore`
 * floor gets clamped by {@link clampTransientRetryHorizon} (BLO-23525).
 *
 * A cap without a matching attempt ceiling just moves the exhaustion trap:
 * `scheduleBoundedRetryForRun`'s generic transient-upstream ceiling is 4
 * attempts, sized for ordinary exponential backoff (2m/10m/30m/2h) with no
 * floor in play. Once a floor is clamped to `MAX_TRANSIENT_RETRY_HORIZON_MS`
 * per attempt, 4 attempts cover only 96h — short of the 124.8h outage BLO-22844
 * recorded, so a run would still be stranded 28.8h before the provider
 * actually recovered. This is the smallest attempt count whose product with
 * the cap does not fall short, derived rather than hand-picked so the two
 * cannot drift apart silently again.
 */
export const TRANSIENT_HORIZON_CLAMP_MIN_ATTEMPTS = Math.ceil(
  LONGEST_RECORDED_PROVIDER_CAPACITY_WINDOW_MS / MAX_TRANSIENT_RETRY_HORIZON_MS,
);

/**
 * Clamp a provider-advertised retry floor so a finalized run cannot park past
 * the horizon ceiling.
 *
 * `scheduleBoundedRetryForRun` treats `retryNotBefore` as a floor and pushes
 * `dueAt` out to it whenever it is later than the computed backoff — with no
 * upper bound. That is a second, independent route to the multi-day park this
 * ticket is about: the in-run k8s ccrotate path (BLO-18278) deliberately breaks
 * out of its own 10-minute retry loop and finalizes the run carrying the
 * advertised reset, expecting this scheduler to honour it verbatim. A capacity
 * reset that is stale or fabricated therefore freezes the run here even when the
 * capacity-gate path is clamped.
 *
 * Clamping only shortens a wait, so the worst case is an early re-probe that
 * defers again — which is the behaviour we want from a horizon we cannot trust.
 */
export function clampTransientRetryHorizon(input: {
  retryNotBefore: Date;
  now: Date;
  maxHorizonMs?: number;
}): { dueAt: Date; clampedFromIso: string | null } {
  const maxHorizonMs = Math.max(1, input.maxHorizonMs ?? MAX_TRANSIENT_RETRY_HORIZON_MS);
  const ceilingMs = input.now.getTime() + maxHorizonMs;
  if (input.retryNotBefore.getTime() <= ceilingMs) {
    return { dueAt: input.retryNotBefore, clampedFromIso: null };
  }
  return { dueAt: new Date(ceilingMs), clampedFromIso: input.retryNotBefore.toISOString() };
}

/**
 * p95 of `startedAt - scheduledRetryAt` for this fleet, used only to derive
 * {@link MIN_USEFUL_RETRY_MARGIN_MS} below. Re-derive that constant rather than
 * editing this one in isolation — decoupling a cap from the measurement it was
 * sized against is BLO-23525's failure mode, repeated.
 *
 * Measured 2026-08-19T23:06-23:22Z over a fixed 5.4h span, 13 agents (BLO-28863
 * findings). Two statistics were available and they disagree, so the choice
 * matters:
 *
 * - Rows carrying both `scheduledRetryAt` and `startedAt` (n=197): median
 *   `4m30s`, p95 **`42m04s`**, max `2h39m32s`, 44% late by >10m.
 * - Rows still parked and overdue at the snapshot (`paperclipListParkedAgents`,
 *   40/40 overdue): `overdueMs` spanning **55-71 min**, all with `retryInMs: 0`.
 *
 * The first is survivor-biased *downward*: it can only measure retries that
 * eventually dispatched, and every row still stuck in the queue is excluded
 * precisely because it is the latest. The second is right-censored — those rows
 * had already waited 55-71 min and had not started, so their eventual lateness
 * is a lower bound, not a value. Taking the survivor p95 (42m) would therefore
 * under-size the margin against the failure mode that matters, so this uses the
 * top of the censored band. Sizing this too small strands the retry after the
 * window, which is the BLO-28785 loss this whole change exists to prevent.
 */
export const DISPATCH_LATENESS_P95_MS = 71 * 60 * 1000;

/**
 * Median heartbeat run duration over the same 2026-08-19 sample (p95 `26m49s`).
 * A retry has to do more than *start* before the window closes — it has to have
 * time to finish the window's work — so the margin carries one median run on top
 * of the lateness it must survive.
 */
export const MEDIAN_HEARTBEAT_RUN_DURATION_MS = (7 * 60 + 41) * 1000;

/**
 * Lead time subtracted from a windowed retry's deadline before it is considered
 * useful (BLO-28863, CTO ruling on PR #1434).
 *
 * Derived, not hand-picked, following this file's precedent for
 * {@link TRANSIENT_HORIZON_CLAMP_MIN_ATTEMPTS}: a retry is worth scheduling only
 * if it can be expected to *start* despite this fleet's dispatch lateness and
 * still have time to do the window's work. At the 2026-08-19 measurement that
 * is `71m + 7m41s = 78m41s`.
 *
 * This is re-tunable and expected to shrink: it is a function of how late the
 * fleet dispatches, not a policy preference. Once BLO-28863 defect 1 meets its
 * acceptance criterion of p95 <= 5 min, the same formula yields ~12m40s. Do not
 * edit the total directly — re-measure the two inputs above.
 *
 * Be clear-eyed about the consequence at today's value: a 6h routine that fails
 * inside the last ~79 min of a window will *always* abandon. That is the
 * intended contract — the routine's next scheduled fire owns that work — but it
 * does mean the `clamp` branch is mostly an abandon-machine until defect 1
 * lands, and it is strictly better than today's behaviour of scheduling the
 * retry anyway, stranding it, and burning a run slot and an attempt en route.
 */
export const MIN_USEFUL_RETRY_MARGIN_MS =
  DISPATCH_LATENESS_P95_MS + MEDIAN_HEARTBEAT_RUN_DURATION_MS;

/** ISO-8601 for a Date, or null when it is not a valid instant. */
function finiteIsoOrNull(value: Date): string | null {
  const ms = value.getTime();
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * Decide a retry due time for work owned by a *periodic* routine (BLO-28863).
 *
 * {@link clampTransientRetryHorizon} bounds the pathological multi-day park, but
 * it is period-unaware by design: its ceiling is a flat
 * MAX_TRANSIENT_RETRY_HORIZON_MS and its own suite asserts that a 23h floor is
 * "ordinary provider backoff" to be left untouched. That assumption holds for
 * unbounded work and breaks for a windowed routine. Measured 2026-08-19: the
 * 6-hourly agent-health routine lost the `00:00Z-06:00Z` window because its
 * retry was scheduled past the window close, and 70% of `transient_failure`
 * retries were pinned 3-5h out to the provider's advertised reset — inside the
 * 24h ceiling, so the existing clamp never fired.
 *
 * A retry that can only wake after its window closes is worth *less* than no
 * retry: it cannot do the window's work, but it still consumes one of the
 * owning agent's `maxConcurrentRuns` slots and one attempt, delaying every
 * other queued retry behind it. So the contract here is deliberately
 * abandon-rather-than-strand: if the due time cannot land inside the owning
 * period with {@link MIN_USEFUL_RETRY_MARGIN_MS} to spare, report `abandon` and
 * let the routine's next scheduled fire own the work.
 *
 * ## Why the deadline instant itself is not a valid target
 *
 * The first cut of this function clamped to the deadline exactly, which made
 * `abandon` unreachable for the only case it existed to serve: `marginMs` was
 * measured as `deadline - failedAt`, so it was positive for every failure
 * inside an open window, and the clamped target's own usable margin was zero by
 * construction. Reproduced over every failure minute of an open 6h window,
 * 360/360 cases clamped to the close and none abandoned. This fleet dispatches
 * late by design-relevant amounts (see {@link DISPATCH_LATENESS_P95_MS}), and
 * BLO-28785 was lost by a retry that dispatched **39.7s** after its window shut,
 * so a wake scheduled *at* the close is not marginal — it is guaranteed late.
 * The lead time is what makes `abandon` reachable and the `clamp` target real.
 *
 * ## Clamping below a provider-advertised floor is intended
 *
 * `dueAt` is frequently `penstockAdvertisedResumeAt` — a floor the provider
 * asked us to respect — and a clamp can land before it. That is the same trade
 * {@link clampTransientRetryHorizon} already makes and documents: clamping only
 * ever shortens a wait, so the worst case is an early re-probe that defers
 * again, which is a single cached GET. Crucially it converges rather than
 * looping: each re-probe re-enters this decision against a window that has less
 * margin left, so the sequence terminates in `abandon` rather than in a strand.
 *
 * Returns a decision rather than a Date so the caller must handle `abandon`
 * explicitly; silently substituting a clamped Date is how a stranded retry
 * would come back as a same-shaped bug. `abandon` deliberately reports
 * `rejectedDueAtIso` rather than `clampedFromIso` so a uniform logger cannot
 * report a clamp that never happened.
 *
 * Takes no `now`: the dispatch-path caller has a fresh `failedAt` by
 * construction, since it is scheduling the retry for the failure it just
 * finalized. Widening the signature for a caller that does not exist would be
 * speculative — revisit if a re-decide path ever needs to re-evaluate an
 * already-parked row, where `failedAt` and `now` genuinely diverge.
 */
export function resolveRoutineScopedRetry(input: {
  /** Provider-advertised or backoff-computed due time under consideration. */
  dueAt: Date;
  /** Failure instant the period budget is measured from. */
  failedAt: Date;
  /** Period of the routine that owns the work, in ms. */
  routinePeriodMs: number;
  /**
   * Hard deadline of the specific window being served, when known. Tighter than
   * the period whenever the failure happened mid-window, which is the common
   * case — a failure 5h into a 6h window has 1h of budget, not 6h.
   */
  windowClosesAt?: Date | null;
  /**
   * Override for {@link MIN_USEFUL_RETRY_MARGIN_MS}. Exists so tests can pin a
   * decision boundary without re-writing when the measured constant is re-tuned.
   */
  minUsefulMarginMs?: number;
}):
  | { decision: "honour"; dueAt: Date; clampedFromIso: null }
  | { decision: "clamp"; dueAt: Date; clampedFromIso: string }
  | { decision: "abandon"; dueAt: null; rejectedDueAtIso: string | null; reason: string } {
  const dueAtMs = input.dueAt.getTime();
  const failedAtMs = input.failedAt.getTime();
  const windowClosesAtMs = input.windowClosesAt ? input.windowClosesAt.getTime() : null;
  const marginMs = input.minUsefulMarginMs ?? MIN_USEFUL_RETRY_MARGIN_MS;

  // Fail closed on anything non-finite. `Math.max(1, NaN)` is `NaN`, not 1, and
  // every comparison against `NaN` is false — so an unguarded non-finite period
  // fell past both branches below and returned a `clamp` decision carrying an
  // `Invalid Date`, which a caller trusting the discriminant would persist
  // straight into `scheduledRetryAt`. The period arrives from routine config
  // rather than from this module, so it is not ours to assume well-formed.
  // `resolveCcrotateCapacityRetry` above already guards this shape.
  if (
    !Number.isFinite(dueAtMs) ||
    !Number.isFinite(failedAtMs) ||
    !Number.isFinite(input.routinePeriodMs) ||
    input.routinePeriodMs <= 0 ||
    !Number.isFinite(marginMs) ||
    marginMs < 0 ||
    (windowClosesAtMs !== null && !Number.isFinite(windowClosesAtMs))
  ) {
    return {
      decision: "abandon",
      dueAt: null,
      rejectedDueAtIso: finiteIsoOrNull(input.dueAt),
      reason: "retry inputs were not finite, so no due time could be trusted",
    };
  }

  const periodDeadlineMs = failedAtMs + input.routinePeriodMs;
  const deadlineMs =
    windowClosesAtMs !== null ? Math.min(periodDeadlineMs, windowClosesAtMs) : periodDeadlineMs;

  // The latest instant a retry can be due and still be expected to start, and
  // finish, before the deadline.
  const targetMs = deadlineMs - marginMs;

  if (targetMs <= failedAtMs) {
    return {
      decision: "abandon",
      dueAt: null,
      rejectedDueAtIso: input.dueAt.toISOString(),
      reason:
        deadlineMs <= failedAtMs
          ? "owning window had already closed at the failure instant"
          : "too little of the owning window remained to dispatch a useful retry",
    };
  }

  if (dueAtMs <= targetMs) {
    return { decision: "honour", dueAt: input.dueAt, clampedFromIso: null };
  }

  return {
    decision: "clamp",
    dueAt: new Date(targetMs),
    clampedFromIso: input.dueAt.toISOString(),
  };
}
