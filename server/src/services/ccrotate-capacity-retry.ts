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
 * Shortest a capacity deferral may park, however short a reset the provider
 * advertises (BLO-28919).
 *
 * ## Why a floor appeared when the attempt cap left
 *
 * `CCROTATE_CAPACITY_MAX_RETRY_ATTEMPTS` was retired as a terminator because
 * `attempts x cadence` couples two independent concerns. But that product was
 * quietly providing a second bound nobody had named: a ceiling on how much
 * *work* one chain can do. {@link CAPACITY_ESCALATION_AFTER_MS} bounds how long
 * a chain lives and says nothing about how many times it hops, and the two come
 * apart precisely where {@link resolveCcrotateCapacityRetry} had a ceiling but
 * no floor — a provider answering `Retry-After: 1` while still exhausted
 * resolved to a ~1s park, leaving the promotion sweep's 10s floor as the only
 * pacing. Across the 187.2h horizon that is ~67k hops per run, and it scales
 * with the cohort: the 484-row population this ticket was filed against would
 * have sustained ~48 row updates/sec on `heartbeat_runs` for the length of an
 * outage. Removing a bound and replacing it with an argument about *rate* left
 * *count* unbounded, which is the same shape as the docblock this ticket fixed.
 *
 * A floor is the right replacement rather than a restored attempt cap: it
 * bounds the hop count as a function of the horizon while keeping cadence and
 * outage tolerance independent, which is the decoupling the retired cap
 * destroyed. Pinned by an invariant test rather than left to arithmetic in a
 * comment.
 *
 * ## Why 60s and not the 5m default poll delay
 *
 * Matching `CCROTATE_CAPACITY_DEFAULT_RETRY_DELAY_MS` (5m) was suggested in
 * review and rejected, because it inverts this module's own thesis. BLO-22860
 * exists to make a capacity park re-probe *earlier* than the provider
 * advertised; a 5m floor would make it sleep *longer* than advertised for
 * everything in the 1s-5m band, including the 90s window this suite documents
 * as a genuine short outage deliberately honoured. Refusing to believe a
 * sub-minute reset is a different claim from refusing to believe a 90s one: a
 * sub-second value is indistinguishable from a broken or absent header, while
 * 90s is ordinary provider guidance and probing before it just hammers.
 *
 * 60s is therefore the largest floor that overrides nothing a provider
 * plausibly means. It bounds a chain at ~11.2k hops over the 187.2h horizon;
 * for the 484-row cohort this ticket was filed against that is ~8 row
 * writes/sec worst case, against ~48/sec unbounded. The remaining headroom is
 * deliberate — this is a bound on pathological work, not a cadence knob, and
 * {@link CCROTATE_CAPACITY_MAX_PARK_MS} remains the only knob that sets cadence.
 */
export const CCROTATE_CAPACITY_MIN_PARK_MS = 60 * 1000;

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
  /**
   * Shortest permitted park. Defaults to {@link CCROTATE_CAPACITY_MIN_PARK_MS};
   * overridable so a test can pin the floor's behaviour without depending on
   * the shipped value.
   */
  minParkMs?: number;
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
  const minParkMs = Math.max(0, input.minParkMs ?? CCROTATE_CAPACITY_MIN_PARK_MS);
  const random = input.random ?? Math.random;

  const advertisedMs = input.resumeAt ? input.resumeAt.getTime() : null;
  // A resume instant already in the past tells us nothing about the future, so
  // it falls back to the default poll delay rather than resolving to `now`.
  const usableAdvertisedMs =
    advertisedMs !== null && Number.isFinite(advertisedMs) && advertisedMs > nowMs ? advertisedMs : null;

  const baseMs = usableAdvertisedMs ?? nowMs + input.defaultRetryDelayMs;
  const ceilingMs = nowMs + maxParkMs;
  // The floor bounds hop *count* the way the retired attempt cap silently did;
  // see CCROTATE_CAPACITY_MIN_PARK_MS. Clamped to the ceiling before it is
  // applied so it can never push a park past `maxParkMs` — the ceiling is the
  // stronger guarantee (a caller may pass a `maxParkMs` below the floor, and
  // tests do), so `resolvedMs <= ceilingMs` must survive adding a floor.
  const floorMs = nowMs + Math.min(minParkMs, maxParkMs);
  const resolvedMs = Math.max(Math.min(baseMs, ceilingMs), floorMs);

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
 * Is this run's `retryNotBefore` floor governed by the capacity park mechanism?
 *
 * PEN-2509 disperses an advertised floor so a cohort sharing one does not
 * resume in lockstep. A capacity floor is deliberately excluded, because its
 * instant is already owned end-to-end by the capacity arithmetic: the resolver
 * arm adds its own positive jitter ({@link CCROTATE_CAPACITY_PARK_JITTER_RATIO})
 * and both arms are bounded by {@link CCROTATE_CAPACITY_MAX_PARK_MS}. Adding a
 * second, independently-sized window on top would stack jitter on the one arm
 * and push the other past a ceiling this module guarantees — re-tuning another
 * mechanism's bound as a side effect of dispersing ours.
 *
 * The measured PEN-2509 herd was `transient_failure` parks converging on a raw
 * advertised instant, which is the path this predicate deliberately leaves
 * dispersible.
 *
 * TWO writers produce a capacity floor and they mark it differently, so testing
 * one marker would silently answer "not capacity" for half of them:
 *
 *  - {@link applyCcrotateCapacityDecision} always writes the chain-origin key.
 *    (`penstockProvider`, `penstockAdvertisedResumeAt` and
 *    `penstockCapacityParkClampedFrom` are all conditional there, so none of
 *    them is a sound marker on its own.)
 *  - the finalize path writes `providerCapacityResetProvenance`, its paired
 *    discriminator for a server-computed reset park.
 *
 * Lives here, beside both markers' contract, so the writers and this reader
 * cannot drift apart.
 */
export function isCapacityGovernedRetryFloor(resultJson: unknown): boolean {
  if (typeof resultJson !== "object" || resultJson === null) return false;
  const row = resultJson as Record<string, unknown>;
  if (readCapacityChainOriginIso(row[CCROTATE_CAPACITY_FIRST_DEFERRED_AT_KEY]) !== null) return true;
  const provenance = row.providerCapacityResetProvenance;
  return typeof provenance === "object" && provenance !== null;
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
  //
  // Read strictly, and in BOTH directions. A corrupt value must not pin the
  // origin in the past and force an immediate escalation, so anything that is
  // not the exact serialization we write is replaced. A *future* value must not
  // be preserved either: `resolveCapacityEscalation` treats a future origin as
  // clock skew and restarts the clock at `now`, but that correction only takes
  // effect if it is what gets persisted. Preferring `previous` unconditionally
  // wrote the future instant straight back, so every hop recomputed
  // `elapsedMs = 0` and the chain could not escalate until wall clock passed the
  // stored instant — the park-forever outcome the key's docblock exists to
  // prevent, reached from the one direction the round-trip check admits.
  //
  // `decision.firstDeferredAtIso` is the resolver's verdict (the echoed origin
  // when the stored one was usable, else `now`), so comparing against it applies
  // the resolver's own `<= now` rule without duplicating it or taking a clock as
  // a parameter. The preserve is kept rather than replaced by a bare assignment
  // so a future caller that forgets to run the resolver still carries the chain
  // forward instead of silently restarting it on every hop.
  const storedOriginIso = readCapacityChainOriginIso(
    previous[CCROTATE_CAPACITY_FIRST_DEFERRED_AT_KEY],
  );
  // Both call sites pass a value the resolver produced, so this always parses.
  // Guarded anyway because the failure would be silent and in the wrong
  // direction: a bare `stored <= Date.parse(...)` comparison against NaN is
  // false, which would discard a perfectly good stored origin and restart the
  // chain on every hop.
  const decisionOriginMs = Date.parse(decision.firstDeferredAtIso);
  const keepStored =
    storedOriginIso !== null &&
    (!Number.isFinite(decisionOriginMs) || Date.parse(storedOriginIso) <= decisionOriginMs);
  next[CCROTATE_CAPACITY_FIRST_DEFERRED_AT_KEY] = keepStored
    ? storedOriginIso
    : decision.firstDeferredAtIso;
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
 * The restart is only *computed* here; it takes effect because
 * {@link applyCcrotateCapacityDecision} persists this `firstDeferredAtIso` in
 * preference to a stored origin later than it. Until BLO-28919 that writer
 * preferred the stored value unconditionally, so this function's future-instant
 * fail-open was computed on every hop and discarded on every hop, and the chain
 * parked until wall clock passed the skewed instant. Anyone checking the skew
 * behaviour needs both halves: a reader who stops at this docblock concludes the
 * system is covered, which is the same trap as the "roughly six hours" sentence
 * this ticket removed.
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

/**
 * Jitter as a fraction of the remaining delay, applied to a `transient_failure`
 * retry floor. Mirrors {@link CCROTATE_CAPACITY_PARK_JITTER_RATIO}, which serves
 * the same purpose on the capacity path.
 */
export const TRANSIENT_RETRY_FLOOR_JITTER_RATIO = 0.2;

/**
 * Ceiling on the jitter window for a transient retry floor (PEN-2509).
 *
 * The ratio alone is the wrong control at this scale. A capacity park is capped
 * at CCROTATE_CAPACITY_MAX_PARK_MS (15m), so 0.2 there spreads a cohort over at
 * most 3 minutes. A `transient_failure` floor is routinely 4-5h out and bounded
 * only by MAX_TRANSIENT_RETRY_HORIZON_MS (24h), where the same ratio would add
 * up to 4.8h to a wait that is already the fleet's slowest — trading a herd for
 * a stall, which is not the trade this fixes.
 *
 * 5 minutes is derived from what the herd actually collides with rather than
 * picked for roundness. PEN-2499 measured the upstream flapping 0%<->100% with
 * 26% of *5-minute* samples serving zero requests, so a cohort dispersed across
 * one such sample window straddles more than one flap state instead of sharing
 * a single verdict. That is the entire failure mode: 25 runs resuming inside
 * 1.1s in a zero-serving trough all fail, and all re-park together.
 *
 * Cost is bounded and small — worst case 5 minutes added to a multi-hour park
 * (<2% of a 4.8h floor). Spread across a 25-run cohort it is ~12s of mean
 * spacing, which is four orders of magnitude more dispersion than the 0ms
 * spread measured on 2026-08-24 and enough that no two runs share a second.
 */
export const TRANSIENT_RETRY_FLOOR_JITTER_MAX_MS = 5 * 60 * 1000;

/**
 * Spread a cohort of runs that share one `transient_failure` retry floor.
 *
 * `scheduleBoundedRetryForRun` treats `retryNotBefore` as a floor and, when it
 * is later than the computed backoff, adopts it *verbatim* as `dueAt`. Because
 * that floor is an absolute provider instant, every run holding the same one
 * lands on the same millisecond — and because it is routinely 4-5h out while
 * the largest backoff hop is 2h, the floor wins whenever it is present. Both
 * observed symptoms follow from that single substitution: retries converge to a
 * shared instant, and they stop varying with attempt count (the attempt-scaled
 * curve is exactly what the floor discards). Measured 2026-08-24: 25 runs / 5
 * agents / attempts 2-11 at 0ms spread; 2026-08-25: 23 runs / 7 agents /
 * attempts 1-12 inside 1.1s.
 *
 * Jitter is **additive only**, for the same reason the capacity path's is (see
 * {@link CCROTATE_CAPACITY_PARK_JITTER_RATIO}): the floor means "not before",
 * so pulling a retry in front of it would probe a reset the provider asked us
 * to wait for. Delaying past it is always permitted. That asymmetry is why this
 * is the correct fix and a *shorter horizon* is not — a shorter horizon moves
 * the herd without dispersing it, and risks probing early.
 *
 * Applied to every floor including `provider_quota`, whose floor is deliberately
 * never clamped: forward-only jitter cannot violate a contractual boundary, and
 * a quota cohort herds on a shared reset exactly like any other.
 */
export function jitterTransientRetryFloor(input: {
  dueAt: Date;
  now: Date;
  random?: () => number;
  jitterRatio?: number;
  maxJitterMs?: number;
}): { dueAt: Date; jitterMs: number } {
  const random = input.random ?? Math.random;
  const ratio = Math.max(0, input.jitterRatio ?? TRANSIENT_RETRY_FLOOR_JITTER_RATIO);
  const maxJitterMs = Math.max(0, input.maxJitterMs ?? TRANSIENT_RETRY_FLOOR_JITTER_MAX_MS);
  // Proportional to the delay still to be served, so a floor already in the
  // past (or one moments away) is not pushed out by a window sized for a
  // multi-hour park.
  const delayMs = Math.max(0, input.dueAt.getTime() - input.now.getTime());
  const windowMs = Math.min(delayMs * ratio, maxJitterMs);
  // A non-finite draw must degrade to "no jitter", not to an Invalid Date.
  // `Math.min(1, Math.max(0, NaN))` is NaN, so clamping alone does not survive
  // a NaN — it propagates through to `new Date(floor + NaN)`, whose getTime()
  // is NaN, and that would be persisted as `scheduledRetryAt`. Failing to 0
  // yields the floor verbatim, which is the safe direction: the floor is the
  // one instant we already know we are allowed to resume at.
  const rawSample = random();
  const sample = Number.isFinite(rawSample) ? Math.min(1, Math.max(0, rawSample)) : 0;
  const jitterMs = Math.floor(sample * windowMs);
  return { dueAt: new Date(input.dueAt.getTime() + jitterMs), jitterMs };
}
