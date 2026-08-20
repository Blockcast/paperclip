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
 * long outage still terminates — see {@link CAPACITY_ESCALATION_AFTER_MS} —
 * escalating to an operator-visible issue, which is the outcome we want from a
 * multi-day outage rather than silent frozen work.
 */

/**
 * Longest a capacity deferral may park before re-probing.
 *
 * This is a *cadence* knob and nothing else: how promptly a recovered pool is
 * noticed. It deliberately carries no sizing claim about how long an outage is
 * tolerated — that is {@link CAPACITY_ESCALATION_AFTER_MS}, measured on the
 * wall clock.
 *
 * ## Do not re-derive an outage budget from this constant (BLO-28919)
 *
 * The sentence that used to close this comment — "Paired with
 * CCROTATE_CAPACITY_MAX_RETRY_ATTEMPTS (24) this bounds a non-recovering pool
 * at roughly six hours" — was wrong twice over, and the same mistake in the
 * heartbeat-side docblock is what made a 24x reduction in outage coverage look
 * already-argued for 484 rows. Both errors had one shape: multiplying a
 * re-probe cadence by an attempt count to obtain an outage horizon.
 *
 * That product is not an outage horizon. `attempts x cadence` couples two
 * independently-chosen concerns, so shortening the cadence to notice recovery
 * sooner silently shrinks how long an outage is survived, with no test
 * failing — which is how this class recurred four times. The give-up condition
 * is now wall-clock and the two are independent: change this number freely to
 * tune responsiveness without touching outage coverage.
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

/**
 * When the *current* capacity deferral chain began, ISO-8601. Set once, then
 * carried forward unchanged across every re-defer (BLO-28919).
 *
 * ## This key is deliberately ABSENT from CCROTATE_CAPACITY_DECISION_KEYS
 *
 * Every key in that list is deleted and rewritten on each re-defer, by design:
 * a field describing the *previous* denial must not linger. This key describes
 * the chain rather than any one denial, so it is the one capacity field that
 * must survive that wipe.
 *
 * Adding it to the list would be silently catastrophic rather than merely
 * wrong. {@link resolveCapacityEscalation} measures the give-up horizon from
 * this instant, so a key that is cleared on every hop is re-seeded to `now` on
 * every hop, the elapsed time never grows, the horizon never elapses, and the
 * run parks forever — strictly worse than the 24h backstop this ticket set out
 * to remove. The set-once read below is what prevents that, and it is the only
 * reason the wall-clock horizon terminates at all.
 *
 * Exported so the promotion-time reader names it through this binding rather
 * than repeating the literal. A duplicated key string across two writers is the
 * exact drift BLO-28919 is about, and a typo in one copy would silently restart
 * the clock on every hop.
 */
export const CCROTATE_CAPACITY_FIRST_DEFERRED_AT_KEY = "penstockCapacityFirstDeferredAt";

/**
 * Read a persisted chain origin, accepting ONLY the exact serialization both
 * writers produce (`Date.prototype.toISOString`).
 *
 * Deliberately stricter than `Date.parse`, which is lenient enough to be
 * dangerous here: `Date.parse("2020")` yields a valid instant in 2020, so a
 * truncated or hand-edited value could pin a chain's origin years in the past
 * and force an immediate escalation on the very next hop — the premature-cancel
 * outcome this whole change exists to remove. A bare `Number.isFinite` check on
 * the parse result does not catch it, because the parse succeeds.
 *
 * A round-trip equality test admits exactly what we write and rejects
 * everything else, and rejection is the safe direction (the clock restarts).
 * Shared by the writer and the predicate so the two cannot disagree about what
 * counts as a usable origin — same drift lesson as the rest of this module.
 */
function readCapacityChainOriginIso(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parsedMs = Date.parse(value);
  if (!Number.isFinite(parsedMs)) return null;
  return new Date(parsedMs).toISOString() === value ? value : null;
}

/**
 * The keys above, plus the one that survives them. Exported for the invariant
 * test that pins the exclusion, so the hazard documented above cannot be
 * reintroduced by editing one list and not the other.
 */
export const CCROTATE_CAPACITY_RESULT_KEYS = {
  clearedOnRedefer: CCROTATE_CAPACITY_DECISION_KEYS,
  carriedAcrossRedefer: CCROTATE_CAPACITY_FIRST_DEFERRED_AT_KEY,
} as const;

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
  /**
   * `now`, ISO-8601, used only to seed
   * {@link CCROTATE_CAPACITY_FIRST_DEFERRED_AT_KEY} when this is the first
   * deferral of a chain. Ignored when the row already carries one.
   */
  firstDeferredAtIso: string;
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
  // Set once, then carried forward untouched. See the key's docblock: re-seeding
  // this on each hop would stop the wall-clock horizon from ever elapsing.
  // Read strictly — a corrupt value must not be able to pin the chain's origin
  // in the past and force an immediate escalation, so anything that is not the
  // exact serialization we write is replaced rather than preserved.
  next[CCROTATE_CAPACITY_FIRST_DEFERRED_AT_KEY] =
    readCapacityChainOriginIso(previous[CCROTATE_CAPACITY_FIRST_DEFERRED_AT_KEY]) ??
    decision.firstDeferredAtIso;
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
 * criteria — not to second-guess ordinary provider backoff.
 *
 * ## This value is a backstop, NOT a sizing decision (BLO-28919)
 *
 * The sentence that used to close this comment — "At 24h every retry the fleet
 * actually schedules today is unaffected" — was measured and **falsified** on
 * 2026-08-19. A full parked census (700 runs) found `scheduledRetryReason =
 * "transient_failure"` at p50 4.6h with **p90 == max == exactly 1440.0m**: the
 * ceiling was binding on more than a tenth of the population, so the
 * never-fires safety net had become the modal outcome. 484 of 700 fleet parks
 * sat in that bucket while correctly-gated capacity parks sat at 17.9m — the
 * identical provider error, 96x apart, decided only by which of the two
 * `retryNotBefore` writers had run.
 *
 * The defect was never this number. It was that a *capacity* floor reached this
 * generic backstop at all: the wake-gate writer clamps a capacity reset through
 * {@link resolveCcrotateCapacityRetry} before persisting it, and the finalize
 * writer did not. That is fixed at the writer (heartbeat.ts, where
 * `effectiveRetryNotBefore` is computed), so capacity floors are bounded by
 * CCROTATE_CAPACITY_MAX_PARK_MS and no longer arrive here.
 *
 * Lowering this constant was considered and rejected: it serves every transient
 * family, and shortening it uniformly would retry non-capacity families sooner
 * with no gate to protect them. Keep it as the loose last-resort bound it is —
 * but do NOT re-derive a sizing claim from it, and if a census ever shows it
 * binding again, that is evidence of a new unclamped writer upstream rather
 * than a number that needs tuning. That inference is the one this comment
 * previously got wrong.
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
 * Headroom over the longest recorded outage before a capacity chain gives up.
 *
 * Named rather than folded into the constant below so the judgement is visible:
 * we tolerate an outage half again as long as the worst one on record before
 * deciding a human should look at it.
 */
export const CAPACITY_ESCALATION_HEADROOM_RATIO = 1.5;

/**
 * How long a provider may be continuously unavailable before a capacity park
 * stops re-deferring and escalates to an operator (BLO-28919).
 *
 * ## Why this is wall-clock and not an attempt count
 *
 * This replaces `CCROTATE_CAPACITY_MAX_RETRY_ATTEMPTS`, whose product with
 * {@link CCROTATE_CAPACITY_MAX_PARK_MS} was the real give-up horizon and was
 * wrong by ~15x: its docblock reasoned at a "4h maximum hop" that matched no
 * constant in the tree, concluding "48 attempts cover ~7.5 days" where
 * 48 x 15m is **12h**. Both windows on record (BLO-22844 at 124.8h, BLO-23438
 * at ~5.2 days) fell outside that, so they would have hard-exhausted — which
 * `heartbeat.ts` itself calls "strictly worse than the uncapped park this issue
 * set out to fix", because a GitHub delivery cancelled here is lost for real
 * rather than merely late.
 *
 * The defect was structural, not arithmetic. `attempts x cadence` multiplies two
 * concerns that are chosen independently — how promptly recovery is noticed, and
 * how long an outage is survived — so tightening the cadence silently shrinks
 * outage coverage with no test failing. That coupling is why this class has now
 * recurred four times (BLO-22860, BLO-23525, BLO-24011, BLO-28919). Measuring
 * the give-up condition on the wall clock decouples them permanently: the
 * cadence constant can move without anyone re-deriving this one.
 *
 * Raising the attempt count instead (to ~500, as suggested in review) was
 * considered and rejected: it restores coverage only while the cadence stays at
 * 15m, so it re-arms the same trap for the next person who shortens a hop.
 *
 * Unbounded re-probing is not a concern this bound needs to carry. A hop cannot
 * be faster than the promotion sweep, which is floored at 10s by config
 * (`heartbeatSchedulerIntervalMs`, `server/src/config.ts`), and each hop is a
 * cached availability GET plus one row update — not a paid dispatch. So the
 * attempt counter is kept for observability only and no longer terminates
 * anything.
 */
export const CAPACITY_ESCALATION_AFTER_MS = Math.ceil(
  LONGEST_RECORDED_PROVIDER_CAPACITY_WINDOW_MS * CAPACITY_ESCALATION_HEADROOM_RATIO,
);

export interface CapacityEscalationPlan {
  /**
   * The instant this chain began, ISO-8601. Echoes the persisted value when the
   * row carried a usable one, and is `now` when this is the first hop or the
   * stored value was unusable. Callers persist this verbatim.
   */
  firstDeferredAtIso: string;
  /** True once the provider has been unavailable for longer than the horizon. */
  exhausted: boolean;
  /** How long the pool has been continuously unavailable, clamped at >= 0. */
  elapsedMs: number;
  escalateAfterMs: number;
}

/**
 * Decide whether a capacity chain has outlived {@link CAPACITY_ESCALATION_AFTER_MS}.
 *
 * Fails open in every ambiguous case — absent, non-string, unparseable, or a
 * future instant (clock skew between writers) all restart the clock at `now`
 * rather than escalating. A premature escalation cancels the run and loses the
 * delivery, whereas a restarted clock costs at most one extra horizon of cheap
 * re-probing, so the asymmetry decides the direction.
 *
 * Note this makes rows parked before the key existed start their clock at their
 * first re-defer after deploy rather than at their original park. That is
 * intentional: it is the safe direction, and it self-heals within one hop.
 */
export function resolveCapacityEscalation(input: {
  firstDeferredAtIso: unknown;
  now: Date;
  escalateAfterMs?: number;
}): CapacityEscalationPlan {
  const escalateAfterMs = Math.max(1, input.escalateAfterMs ?? CAPACITY_ESCALATION_AFTER_MS);
  const nowMs = input.now.getTime();
  const storedIso = readCapacityChainOriginIso(input.firstDeferredAtIso);
  const storedMs = storedIso === null ? Number.NaN : Date.parse(storedIso);
  const usableMs = Number.isFinite(storedMs) && storedMs <= nowMs ? storedMs : null;

  if (usableMs === null) {
    return {
      firstDeferredAtIso: input.now.toISOString(),
      exhausted: false,
      elapsedMs: 0,
      escalateAfterMs,
    };
  }

  const elapsedMs = nowMs - usableMs;
  return {
    firstDeferredAtIso: new Date(usableMs).toISOString(),
    exhausted: elapsedMs > escalateAfterMs,
    elapsedMs,
    escalateAfterMs,
  };
}

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
