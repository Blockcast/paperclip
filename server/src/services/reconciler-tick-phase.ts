import type { WorkerSingletonStartPhase } from "./worker-singleton-supervisor.js";

/**
 * Chosen tick phases for the lease-supervised reconcilers that read GitHub
 * (PEN-6750).
 *
 * ## Why these loops have a phase at all
 *
 * Every lease-supervised singleton is armed as
 * `superviseLeased(name, () => { tickNow(); setInterval(tick, intervalMs); })`,
 * so before PEN-6750 its phase was inherited from whatever minute the leader
 * pod happened to start, and re-rolled on every deploy. Every one of these
 * intervals divides or is a multiple of an hour, so that one accident fixed the
 * minute-of-hour of every subsequent tick, forever, and fixed it identically
 * for every sibling armed in the same boot. The two 360-minute GitHub readers
 * therefore fired at the same instant and never drifted apart.
 *
 * ## Why the minute matters
 *
 * The GitHub REST budget on the shard these sweeps read is steeply monotone
 * WITHIN each rate-limit window, so the inherited minute decided whether a
 * sweep had thousands of calls or none. Measured on
 * `paperclip_github_rate_limit_remaining{route="repos/commits/check-runs"}`
 * (co-shard with `pulls/:n`) at a fixed minute-of-hour across 25 consecutive
 * hours, 2026-11-15T04:20Z to 2026-11-16T04:20Z:
 *
 * | sampled at | floor over 25 h                                   |
 * |------------|---------------------------------------------------|
 * | `:20`      | 6,415 (`max` across instances) / 5,914 (`min`)    |
 * | `:40`      | 1,828 (`max`)                                     |
 * | `:50`–`:09`| 0, reached in 5 separate runs in the last 7 h     |
 *
 * The floor is robust to the aggregation choice — the pessimistic `min` floor
 * is the higher one — so the band is not an artefact of a flattering
 * aggregate. The window resets at roughly `:07` and drains towards it.
 *
 * ## What this does NOT claim
 *
 * - NOT that these reconcilers cause the exhaustion. A window draining to zero
 *   just before its reset is explained by the reset boundary alone, whoever is
 *   doing the draining, and a 2026-11-16 03:07→03:58 window drained from 9,664
 *   to 0 with no reconciler tick anywhere near it. Phase is chosen here because
 *   it is the one lever that acts on the budget curve REGARDLESS of who drains
 *   it, not because the herd is the proven cause.
 * - NOT that these minutes stay right. The reset point is GitHub's rolling
 *   hour, not a wall-clock hour, so it drifts; a wall-clock phase does not
 *   track it. These values are a measured choice with a stated measurement
 *   date, and they want re-measuring, not trusting. The self-correcting
 *   alternative — scheduling against the live `X-RateLimit-Reset` — would
 *   couple a generic singleton supervisor to GitHub and is deliberately not
 *   taken here.
 * - NOT that a 10-minute loop can dodge the exhausted band at all. It cannot:
 *   a loop that ticks six times an hour puts two of those ticks inside any
 *   20-minute window. For those two the phase buys stagger against each other
 *   and nothing else, and `reconciler-tick-phase.test.ts` asserts exactly that
 *   rather than letting the comment drift.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** A phase that fires at `minute` past every hour. */
export function hourlyAtMinute(minute: number): WorkerSingletonStartPhase {
  return { periodMs: HOUR_MS, offsetMs: minute * MINUTE_MS };
}

/** A phase that fires `offsetMinutes` into every `periodMinutes` window. */
export function everyMinutesAtOffset(
  periodMinutes: number,
  offsetMinutes: number,
): WorkerSingletonStartPhase {
  return { periodMs: periodMinutes * MINUTE_MS, offsetMs: offsetMinutes * MINUTE_MS };
}

/**
 * The minute-of-hour band in which the measurement above found headroom in all
 * 25 hours, and the richer sub-band the hourly sweeps are aimed at. Exported so
 * the test asserts the choices against the measurement rather than against a
 * second copy of the numbers.
 */
export const MEASURED_HEADROOM_BAND_MINUTES = { first: 10, last: 49 } as const;
export const MEASURED_RICH_BAND_MINUTES = { first: 15, last: 25 } as const;

/**
 * `merged-pr-reconciler`, 360 min. The heaviest GitHub reader of the four: up
 * to two REST calls per open PR per repo. Aimed at the middle of the rich band.
 */
export const MERGED_PR_RECONCILER_TICK_PHASE = hourlyAtMinute(17);

/**
 * `pr-review-state-reconciler`, 360 min. Also inside the rich band, and
 * deliberately NOT the same minute as `merged-pr-reconciler`: both are
 * 360-minute loops armed in the same boot, so sharing a minute means sharing
 * every tick instant for the life of the process.
 */
export const PR_REVIEW_STATE_RECONCILER_TICK_PHASE = hourlyAtMinute(23);

/**
 * `approval-gate-reconciler`, 10 min. Phase-aligned to its own 10-minute grid:
 * six ticks an hour cannot avoid the exhausted band, so this buys stagger
 * against its 10-minute sibling and against the two hourly sweeps, not budget.
 */
export const APPROVAL_GATE_RECONCILER_TICK_PHASE = everyMinutesAtOffset(10, 2);

/** `terminal-gate-reconciler`, 10 min. Staggered against the approval gate. */
export const TERMINAL_GATE_RECONCILER_TICK_PHASE = everyMinutesAtOffset(10, 5);
