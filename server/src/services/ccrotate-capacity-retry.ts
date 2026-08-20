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
 * CCROTATE_CAPACITY_MAX_RETRY_ATTEMPTS this bounds a non-recovering pool before
 * it escalates for operator attention; the coverage ceiling that pair buys is
 * named and derived at {@link CCROTATE_CAPACITY_MAX_COVERAGE_MS} below rather
 * than restated here, so shortening this cap cannot silently shorten the
 * coverage *ceiling* without growing the attempt count to match.
 *
 * Note the limit of that guarantee: this is a ceiling on each hop, not the hop
 * length. {@link resolveCcrotateCapacityRetry} resolves to
 * `min(advertised, default, cap)`, so a shorter cap is caught by the derivation
 * while a shorter *actual* hop is not observable from these constants at all.
 */
export const CCROTATE_CAPACITY_MAX_PARK_MS = 15 * 60 * 1000;

/**
 * Ceiling on how long the capacity re-probe loop keeps polling before it gives
 * up and escalates. `CCROTATE_CAPACITY_MAX_RETRY_ATTEMPTS` is derived from this
 * and {@link CCROTATE_CAPACITY_MAX_PARK_MS}, so the pair cannot drift the way
 * TRANSIENT_HORIZON_CLAMP_MIN_ATTEMPTS was introduced to stop (BLO-23525).
 *
 * ## This is a best case, not a floor
 *
 * `attempts x cap` is an **upper bound** on wall-clock coverage, not the
 * coverage. {@link resolveCcrotateCapacityRetry} resolves every hop to
 * `min(advertised, now + defaultRetryDelayMs, now + cap)`, so the 12h below is
 * only reached when *every* hop is clamped at the cap. Real coverage is
 * `Σ(actual hops)` and routinely far less:
 *
 *   - With no usable advertised reset the hop is
 *     `CCROTATE_CAPACITY_DEFAULT_RETRY_DELAY_MS` (5m), not the 15m cap — so the
 *     no-advisory path, which is the common one, buys **~4h, not 12h**.
 *   - Against a provider advertising 60s resets, 48 attempts buy ~48 minutes.
 *
 * ({@link CCROTATE_CAPACITY_PARK_JITTER_RATIO} adds up to 20% on top of each
 * resolved hop, so this is not a strict bound in the other direction either. It
 * is the pre-jitter ceiling, which is the figure the attempt count derives from.)
 *
 * Naming it a ceiling rather than "intended coverage" is deliberate: an
 * invariant asserted in prose that the code does not enforce is the exact
 * failure mode this constant exists to kill, and a floor is not enforceable
 * from here — nothing in these constants can see the advertised resets that
 * actually determine hop length.
 *
 * The value is the coverage ceiling already shipping today (48 attempts x 15m),
 * named rather than changed. Two docblocks previously derived the attempt count
 * from numbers that match no constant in the tree, and they contradicted each
 * other:
 *
 *   - heartbeat.ts reasoned at a "4h maximum hop" (no such constant; the hop cap
 *     is the 15m above) and concluded "48 attempts cover ~7.5 days".
 *   - this file reasoned at "(24) ... roughly six hours" — correct when the
 *     attempt count was 24, stale since BLO-22860 raised it to 48.
 *
 * Neither described the shipped pair. Deriving from one named figure makes the
 * arithmetic checkable and puts any future change to coverage in one place.
 *
 * They also disagree on whether exhaustion is the *goal* or a *failure*:
 * this file's header calls escalating after exhaustion "the outcome we want
 * from a multi-day outage rather than silent frozen work", while heartbeat.ts
 * calls hard exhaustion "strictly worse than the uncapped park this issue set
 * out to fix". Both are shipped, and they cannot both be the intent.
 *
 * OPEN DECISION (not resolved here, deliberately): 12h of coverage ceiling is
 * far short of {@link LONGEST_RECORDED_PROVIDER_CAPACITY_WINDOW_MS} (124.8h),
 * which would need ~500 attempts at this cap — and further short once the
 * best-case caveat above is applied. Whether to buy that coverage, or to accept
 * exhaustion and escalate, is the same question the two docblocks answer
 * differently — an operator/product call, not one to settle by picking a
 * constant. This change makes the shortfall explicit and leaves the number
 * alone; {@link ccrotateCapacityCoverageShortfallMs} reports the gap.
 */
export const CCROTATE_CAPACITY_MAX_COVERAGE_MS = 12 * 60 * 60 * 1000;

/**
 * Hard ceiling on the derived attempt count — the **load** half of the coupling
 * that {@link CCROTATE_CAPACITY_MAX_COVERAGE_MS} is the coverage half of.
 *
 * Deriving attempts as `ceil(coverage / cap)` fixes one failure mode and opens
 * its mirror. Before, shortening the park cap silently *lost* coverage; with a
 * bare derivation, shortening it silently *multiplies* probe volume, because
 * the attempt count is an unbounded function of the cap: 48 at 15m, 96 at 7.5m,
 * 144 at 5m, 720 at 1m, 1440 at 30s. Every attempt is a due-run sweep plus a DB
 * re-defer write on the run row (`applyCcrotateCapacityDecision`), aimed at a
 * provider that is by definition already refusing traffic — so the mirror is
 * not benign, and at fleet scale it is the more expensive of the two.
 *
 * This is a chosen policy number, not a derived one, and is stated as such: it
 * is 2x the shipped derivation, so halving the park cap still resolves purely
 * from coverage and this does not bind. Shorten the cap past that and the clamp
 * takes effect and the coverage guard in
 * `__tests__/ccrotate-capacity-coverage-coupling.test.ts` goes red — which is
 * the intended outcome, because "this cap and this coverage target are jointly
 * infeasible" is a decision for a human, not something to absorb silently in
 * either direction.
 */
export const CCROTATE_CAPACITY_ATTEMPT_HARD_CEILING = 96;

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
 * How far {@link CCROTATE_CAPACITY_MAX_COVERAGE_MS} falls short of the longest
 * capacity outage on record, in ms (0 when it covers it).
 *
 * ## The returned number is a LOWER bound on the real gap
 *
 * It subtracts the coverage *ceiling*, and actual coverage is `Σ(actual hops)`
 * where each hop is `min(advertised, default, cap)` — so the true exposure is
 * **at least** this and typically larger. On the no-advisory path (5m hops,
 * ~4h of real coverage) the gap against a 124.8h outage is ~120.8h, not the
 * ~112.8h reported here. Read it as "the gap is no smaller than this".
 *
 * Reporting the gap rather than closing it is deliberate — see the OPEN
 * DECISION on the coverage constant. Deliberately diagnostic-only: this exists
 * so the shortfall is a value something can assert on, instead of a subtraction
 * nobody performs. It has no production consumer by design, and the coupling
 * suite is its only caller.
 */
export function ccrotateCapacityCoverageShortfallMs(): number {
  return Math.max(0, LONGEST_RECORDED_PROVIDER_CAPACITY_WINDOW_MS - CCROTATE_CAPACITY_MAX_COVERAGE_MS);
}

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
