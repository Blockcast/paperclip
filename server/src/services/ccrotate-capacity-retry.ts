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
