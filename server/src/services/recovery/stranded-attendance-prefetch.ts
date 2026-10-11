/**
 * Windowed, TTL-bounded batching of the stranded sweep's per-candidate attendance
 * preflight (PEN-3636).
 *
 * ## What it replaces
 *
 * `reconcileStrandedCandidate` opens with two attendance questions, asked once per
 * candidate:
 *
 *   - `hasActiveExecutionPath` — a live/queued run, or a deferred execution wake
 *     (2 queries, issued concurrently)
 *   - `hasPendingWakeInteraction` — an unanswered wake card (1 query, after them)
 *
 * Three queries in two serialized steps, and the candidate loop itself is strictly
 * sequential (`for … await`) — so on a measured pass of ~1,890 candidates that is
 * ~5,670 queries in ~3,780 round-trip waits. The two phases together were measured at
 * **31.9% of one pass** including `prologue.getLatestIssueRun`, which this change
 * deliberately leaves alone (see "Follow-ups" below).
 *
 * ⭐ Round-trip COUNT is the lever, and this is measured rather than assumed. PEN-3636
 * Done-when #2's fork settled it on 2026-10-02 off the `pg_heartbeat_runs_access`
 * collector: across 18 minutes lying entirely inside one in-flight pass, `seq_scan`
 * delta was **+0** on `heartbeat_runs` while its own `idx_scan` climbed **+84,937**.
 * The lookups are index seeks, so the ~110 ms mean round-trip is QUEUEING, not
 * execution — no index can remove it and only asking fewer times can.
 *
 * ⛔ What this does NOT claim, stated because the row has a standing correction about
 * exactly this: the sweep's slow mode is **ambient database latency, not round-trip
 * count**. Measured 2026-10-10 over 106 passes split into terciles by per-candidate
 * cost (fast 116 ms, slow 318 ms): every phase moves together at ~3× on *identical*
 * call counts, and the single out-of-loop `candidateQuery` — one query, outside the
 * per-candidate loop entirely — is itself 2.8× slower in the same passes. Batching
 * multiplies down both modes and is worth doing; it cannot remove the tail. Anyone
 * costing this change against the 51-minute passes will over-promise.
 *
 * ## Why a WINDOW rather than a memo
 *
 * The two sibling optimisations in this directory (`createActivePauseHoldPrefilter`,
 * `createAgentRosterMemo`) are memos keyed by **company**, because the question they
 * ask cannot differ between two candidates of the same company. These two questions are
 * keyed by **issue**, so every candidate has a distinct answer and a memo saves nothing.
 * What is available instead is that the answers for many issues can be fetched in one
 * query, and the candidate list is already materialized and ordered — so a window of
 * upcoming candidates can be loaded ahead of the loop reaching them.
 *
 * ⛔ A whole-pass pre-pass was the obvious shape and is deliberately NOT built. It
 * would make the attendance answer for the LAST candidate as stale as the pass is long
 * — up to 51 minutes at the measured maximum — on precisely the guard that stops the
 * sweep escalating an issue out from under a run that started after the pass began.
 * That is unbounded staleness in the harmful direction, and it is the one trade this
 * file's existing optimisations were careful never to make. The window exists so the
 * bound is a TTL rather than a pass duration, which is the same property that made
 * those two acceptable.
 *
 * ## The freshness trade
 *
 * Both predicates are used only to SKIP a candidate, so the two directions are not
 * symmetric:
 *
 *   - stale window says "attended" when the run has since died ⇒ the candidate is
 *     skipped and recovered on the next pass. A **deferral**. Safe.
 *   - stale window says "unattended" when a run has since started ⇒ the sweep proceeds
 *     to judge an issue that now has a live execution path. This is the harmful
 *     direction: it can end in an escalation, which is a mutation rather than a
 *     deferral.
 *
 * ⚠️ The harmful direction is real and is accepted at ≤ `ttlMs`. Three things bound it,
 * and the first two are the reason this is a widening rather than a new exposure:
 *
 * 1. **The race already exists at master.** The live read happens at the top of the
 *    candidate and the mutation happens many awaits later, so today's window is
 *    "the rest of this candidate's processing", not zero. This widens that window by at
 *    most `ttlMs`; it does not open one.
 * 2. **The dominant case is already refused in-transaction.** A `todo` candidate picked
 *    up mid-sweep moves to `in_progress`, and `escalateStrandedAssignedIssue` re-reads
 *    the row `FOR UPDATE` inside the transaction that holds `lockIssueOwnership`,
 *    returning null when `fresh.status` has moved off `previousStatus`. The residual is
 *    an `in_progress` candidate that acquires a continuation run without a status
 *    change.
 * 3. `ttlMs` is bounded independently of pass duration, so a 51-minute pass cannot
 *    widen it.
 *
 * ⛔ A stronger mitigation was designed and is deliberately NOT built here, recorded so
 * the omission is a choice rather than an oversight: re-read `hasActiveExecutionPath`
 * live **inside** `escalateStrandedAssignedIssue`'s transaction, after
 * `lockIssueOwnership`. That would be strictly SAFER than master — under the per-issue
 * advisory lock a concurrent checkout cannot interleave at all — and it is cheap,
 * because it costs one round-trip per *escalation* (4 acted rows in the measured pass)
 * rather than one per candidate. It is omitted here only because it needs the
 * prologue's `agentId` threaded through that function's signature to keep the
 * review-participant arm agent-scoped, and widening the predicate to "any agent"
 * instead would change refusal behaviour beyond this change's subject.
 *
 * ## Two properties of the bookkeeping worth knowing before reading `stats()`
 *
 * ⚠️ **`loadedAt` is stamped BEFORE the await**, so a window load slower than `ttlMs` is
 * born expired. That direction is the conservative one — a window is never treated as
 * fresher than the data it holds — but it has the same reporting consequence the roster
 * memo documents: on a database degraded enough that a window load exceeds `ttlMs`,
 * every window expires on arrival, the prefetch falls to one load per candidate, and
 * `prefetchHits` collapses toward zero. That reads **identically to "the sweep stopped
 * passing its prefetch"**. Disambiguate with `liveReads`: wired-but-degraded still
 * climbs it once per candidate, unwired leaves both at 0.
 *
 * ⚠️ **Only one window is held at a time.** Retained memory is bounded by `windowSize`,
 * not by candidate count, and a window is dropped the moment the next one loads. The
 * loop visits candidates in the order the window was built from, so a backward lookup
 * cannot occur under the sweep's own usage; one would simply reload.
 *
 * ## Follow-ups, recorded so they are not rediscovered
 *
 * - **Three sibling sweeps in `recovery/service.ts` still pay the per-candidate cost**
 *   — the stranded-blocked reconciler, the orphan-blocker sweep and the expired-wake
 *   horizon sweep each call `hasActiveExecutionPath` (and two of them
 *   `hasPendingWakeInteraction`) inside their own candidate loops. Each already has a
 *   materialized, ordered candidate list, so each can take a prefetch the same way this
 *   one does. Left out here to keep the change to one call site; the same follow-up the
 *   pause-hold prefilter records for its own four siblings.
 * - **`prologue.getLatestIssueRun` is the fourth per-candidate round-trip** and is
 *   deliberately NOT batched here. It is *evidence* fed to the classifiers rather than
 *   an attendance predicate used only to skip, so its staleness argument is a different
 *   one and belongs in its own change. Batching it also needs `DISTINCT ON` rather than
 *   a set membership test — a different query shape, well supported by migration 0204's
 *   `(company_id, (context_snapshot ->> 'issueId'), created_at DESC, id DESC)` index,
 *   but not the same review.
 */

/**
 * Default staleness bound.
 *
 * Deliberately the same 5 s as `DEFAULT_ACTIVE_PAUSE_HOLD_PREFILTER_TTL_MS` and
 * `DEFAULT_AGENT_ROSTER_MEMO_TTL_MS`, and for the same reason: the window — not the
 * number of round-trips saved — is the only thing a reviewer has to accept, and the
 * argument for 5 s has already been made and accepted twice in this directory. Kept as
 * its own constant rather than imported from either so the three can diverge if one of
 * their freshness arguments ever changes; they are the same number by agreement, not by
 * dependency.
 */
export const DEFAULT_STRANDED_ATTENDANCE_PREFETCH_TTL_MS = 5_000;

/**
 * Default number of upcoming candidates fetched per window.
 *
 * ⚠️ This is the *weaker* of the two bounds and is not the freshness argument — `ttlMs`
 * is. At the 2026-10-10 measured median of 173 ms per candidate a window expires after
 * roughly 29 candidates, so the TTL binds first and a larger size would mostly fetch
 * ids the window never reaches. 64 is chosen to sit just above that so the TTL stays
 * the binding constraint on a healthy database while a single window still covers a
 * useful run of candidates when the database is fast.
 *
 * Sizing a window costs one array slice and widens one `IN (...)` list; it does not add
 * round-trips. The failure mode of choosing it too large is wasted ids in a predicate,
 * not staleness.
 */
export const DEFAULT_STRANDED_ATTENDANCE_PREFETCH_WINDOW = 64;

/**
 * Round-trips this prefetch took versus answered from a loaded window, over its own
 * lifetime.
 *
 * PEN-3636: without this the saving is a projection. The sweep's funnel reports what
 * the pass *did*, never what it *cost*. `liveReads` counts **window loads**, each of
 * which issues the loader's queries once; at master the same work cost three
 * round-trips per candidate.
 *
 * `windowExpiries` separates the two reasons a window is replaced — exhausted (the loop
 * walked off its end, the intended case) versus expired (the TTL bound, which on a
 * healthy database should be the minority). A pass where `windowExpiries` approaches
 * `liveReads` is reporting a slow database, not a mis-sized window.
 */
export type StrandedAttendancePrefetchStats = {
  liveReads: number;
  prefetchHits: number;
  windowExpiries: number;
  idsLoaded: number;
};

/**
 * One issue's attendance evidence, as the loader found it.
 *
 * `any` is NOT redundant with `agentIds.size > 0`. Both source columns
 * (`heartbeat_runs.agent_id`, `agent_wakeup_requests.agent_id`) are `notNull` today, so
 * the two agree — but if either ever became nullable, a null-agent row would be absent
 * from the set while still satisfying the unfiltered predicate, and the unfiltered
 * answer would silently read false. Carrying the row-presence flag separately makes
 * that unrepresentable instead of latent.
 */
export type IssueAttendanceEvidence = {
  /** At least one execution-path row exists for this issue, whatever its agent. */
  any: boolean;
  /** The non-null agent ids on those rows. */
  agentIds: ReadonlySet<string>;
};

export type StrandedAttendanceWindow = {
  executionPath: ReadonlyMap<string, IssueAttendanceEvidence>;
  pendingWakeInteractionIssueIds: ReadonlySet<string>;
};

/**
 * Bulk form of the two preflight reads, for one company and one window of issue ids.
 *
 * ⚠️ Injected rather than implemented here so the SQL can live immediately beside the
 * single-issue `hasActiveExecutionPath` / `hasPendingWakeInteraction` it must stay
 * equivalent to. Drift between a batched query and the single-issue one it replaces is
 * the main hazard of this change, and adjacency is the control available for it;
 * `stranded-attendance-prefetch.test.ts` pins the windowing, and
 * `recovery-stranded-attendance-batch.test.ts` pins the equivalence against the live
 * predicates.
 */
export type StrandedAttendanceWindowLoader = (
  companyId: string,
  issueIds: readonly string[],
) => Promise<StrandedAttendanceWindow>;

export type StrandedAttendancePrefetch = {
  /**
   * Equivalent to `hasActiveExecutionPath(companyId, issueId, agentId)`, within `ttlMs`.
   *
   * A falsy `agentId` reproduces the unfiltered predicate (any run OR any deferred
   * wake); a non-empty `agentId` reproduces the agent-scoped one, because the loader
   * returns the union of agent ids from both sources and membership in that union is
   * exactly "(run by this agent) OR (wake by this agent)".
   */
  hasActiveExecutionPath(companyId: string, issueId: string, agentId: string | null): Promise<boolean>;
  hasPendingWakeInteraction(companyId: string, issueId: string): Promise<boolean>;
  stats(): StrandedAttendancePrefetchStats;
};

/**
 * Scope one of these to a single pass and construct it there; a module-level instance
 * would leak answers across requests and across companies' lifetimes.
 *
 * `candidates` must be the pass's candidate list **in the order the loop will visit
 * it** — the window is built forward from the requested candidate's position, so an
 * order mismatch degrades the hit rate without affecting correctness.
 */
export function createStrandedAttendancePrefetch(
  loader: StrandedAttendanceWindowLoader,
  candidates: readonly { id: string; companyId: string }[],
  opts: { ttlMs?: number; windowSize?: number; now?: () => number } = {},
): StrandedAttendancePrefetch {
  const ttlMs = opts.ttlMs ?? DEFAULT_STRANDED_ATTENDANCE_PREFETCH_TTL_MS;
  const windowSize = Math.max(1, opts.windowSize ?? DEFAULT_STRANDED_ATTENDANCE_PREFETCH_WINDOW);
  const now = opts.now ?? Date.now;

  // Built once. Without it, locating a candidate's position would be a linear scan per
  // lookup — O(candidates²) over a pass, which is the kind of in-process cost this row
  // has already had to rule out once by measurement.
  const positionById = new Map<string, number>();
  for (const [index, candidate] of candidates.entries()) {
    if (!positionById.has(candidate.id)) positionById.set(candidate.id, index);
  }

  let loaded: {
    companyId: string;
    loadedAt: number;
    ids: Set<string>;
    window: StrandedAttendanceWindow;
  } | null = null;
  let liveReads = 0;
  let prefetchHits = 0;
  let windowExpiries = 0;
  let idsLoaded = 0;

  /**
   * The ids to fetch alongside `issueId`: the next `windowSize` candidates of the SAME
   * company, starting at this one.
   *
   * Company-scoped because the loader's queries are, and because the candidate query
   * already orders by `companyId` — so a company owns a contiguous run and stopping at
   * its boundary costs at most one short window per company rather than splitting the
   * pass. An id absent from `positionById` (not a candidate of this pass) falls back to
   * a window of one, which is exactly master's behaviour for that call.
   */
  function windowIdsFor(companyId: string, issueId: string): string[] {
    const start = positionById.get(issueId);
    if (start === undefined) return [issueId];
    const ids: string[] = [];
    for (let i = start; i < candidates.length && ids.length < windowSize; i += 1) {
      const candidate = candidates[i];
      if (candidate.companyId !== companyId) break;
      ids.push(candidate.id);
    }
    // `issueId` is at `start` by construction, but a caller passing a `companyId` that
    // disagrees with the candidate row would otherwise get a window that does not
    // contain the id it asked about — and then every lookup would miss and reload.
    return ids.length > 0 ? ids : [issueId];
  }

  async function windowFor(companyId: string, issueId: string): Promise<StrandedAttendanceWindow> {
    const readAt = now();
    if (loaded && loaded.companyId === companyId && loaded.ids.has(issueId)) {
      if (readAt - loaded.loadedAt < ttlMs) {
        prefetchHits += 1;
        return loaded.window;
      }
      windowExpiries += 1;
    }
    const ids = windowIdsFor(companyId, issueId);
    // Counted here, BEFORE the await, so a load that throws is still booked as a
    // round-trip taken. Counting on return would silently flatter the saving on exactly
    // the passes where the database is in trouble — the reading would improve as the
    // system degraded. Same rule as the pause-hold prefilter and the roster memo.
    liveReads += 1;
    idsLoaded += ids.length;
    // Dropped before the await, not after it. ⚠️ Stated honestly: no sequence the sweep
    // can produce today depends on this. A reload is reached only by a window miss or by
    // an expiry, and in both of those the previous window would be rejected on its own
    // terms anyway. It is here because the alternative — leaving a superseded window
    // addressable across an await that may never return — is the kind of state a future
    // caller (a concurrent sweep, a retry wrapper) would be able to observe, and the
    // cost of excluding it now is one assignment.
    loaded = null;
    const window = await loader(companyId, ids);
    loaded = { companyId, loadedAt: readAt, ids: new Set(ids), window };
    return window;
  }

  return {
    async hasActiveExecutionPath(companyId, issueId, agentId) {
      const window = await windowFor(companyId, issueId);
      const evidence = window.executionPath.get(issueId);
      if (!evidence) return false;
      // Truthiness, not `=== null`, to match the single-issue form exactly: it selects
      // the unfiltered predicate with `agentId ? eq(...) : sql`true``, so an empty-string
      // agent id falls to the unfiltered branch there. Unreachable from today's sweep
      // (the candidate returns early on a falsy agent id), and matched anyway so the two
      // cannot disagree on an input one of them has an opinion about.
      return agentId ? evidence.agentIds.has(agentId) : evidence.any;
    },
    async hasPendingWakeInteraction(companyId, issueId) {
      const window = await windowFor(companyId, issueId);
      return window.pendingWakeInteractionIssueIds.has(issueId);
    },
    stats() {
      return { liveReads, prefetchHits, windowExpiries, idsLoaded };
    },
  };
}
