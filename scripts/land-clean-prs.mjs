#!/usr/bin/env node

/**
 * Decides which open PRs may be handed to the merge queue, and why each of the
 * rest may not.
 *
 * Nothing currently lands a PR that Ally has already reviewed clean. They sit
 * open until a human notices, which on 2026-09-04 was the third of four
 * measured causes of 101 issues stalled `in_review` for 22-87 days
 * (BLO-32237). This script is the decision; the routine that runs it
 * (BLO-32511) only invokes it and posts the receipt.
 *
 * The classifier is pure and exhaustive: every PR gets exactly one row, and a
 * row is either an action or a named reason for inaction. There is no "no
 * opinion" outcome, because a PR silently absent from the receipt is
 * indistinguishable from one the script never fetched — the fail-open shape
 * `assertPrListComplete` exists to prevent one layer up.
 *
 * Default is a dry run. `--apply` performs the actions.
 *
 * ## The reporting half: approvals that rotted (BLO-33208)
 *
 * The same sweep answers a second question nothing else was asking. An approval
 * is the scarcest signal on a PR — a human read the diff and said yes, at a
 * measured fleet throughput of ~2.4 such actions/day — and it is silently spent
 * when master moves underneath the branch. A conflict is created by a commit on
 * the BASE, so there is no `synchronize`, no `pull_request` event and no check
 * re-run on the PR itself; `mergeStateStatus` is not a check, so it cannot be
 * expressed as a `gateSignals` monitor either. Nothing wakes the assignee, ever.
 *
 * That cohort has been cleaned up by hand four times (BLO-29984, BLO-31321,
 * BLO-32205, BLO-33208) and regrown in the same repos every time, which is why
 * it is folded in here as a standing `approval-rotted` row rather than cleaned
 * up a fifth time. It is REPORTED and never acted on: a deliberate sequencing
 * hold is indistinguishable from a strand on every API surface, and
 * trafficcontrol#1726 was exactly that — "do not merge before magma#1936", a
 * shared proto field-number space that a rebase would have broken.
 *
 * Folded in from the standalone detector in trafficcontrol#1815, which was
 * closed in favour of this: that one needed a repo secret no agent can
 * provision, so its schedule would have been permanently red and its alarm
 * state indistinguishable from its broken state (BLO-33268).
 *
 * ## Why the review verdict is read from the body, not from `commit_id`
 *
 * GitHub rewrites `commit_id` on APPROVED reviews when the head moves, so a
 * review can be recorded against a commit created after it was submitted
 * (measured on #1104, 2026-08-07; see I3 in check-ally-review-consistency.mjs).
 * The body's `Reviewed head:` attestation is the record of which tree was
 * actually read, so `canonicalReviewHead` is the selector here. Using
 * `commit_id` would let a force-push launder a stale review into a current one
 * — and this script's whole output is "merge it", so that failure is fatal.
 *
 * ## Why the *newest* attesting review wins (BLO-32240, Ally 2026-09-07)
 *
 * More than one review may attest the same head. #1418 @958587ad carries two:
 * `5124450619` with 1 Important, then `5125141599` clean 4h45m later, a verdict
 * reconciliation at unchanged head. A classifier that scans all reviews at head
 * and disqualifies on any Important reads that PR as blocked *permanently*,
 * because the superseded review is immortal and the head never moves on its
 * own. So: select the newest attesting operative review by `submitted_at` and
 * judge only that one. This matches the gate's own stated semantics —
 * `gate/ally-comment-findings` describes itself as reading Ally's "most recent"
 * consolidated review for the head.
 *
 * The mirror case is the dangerous one and is tested: older clean, newer
 * blocking must NOT enqueue. A naive "take any clean review at head" passes the
 * first case and fails open on the second.
 *
 * Note this is not in tension with the "exactly one attestation" rule. That
 * rule is about one `Reviewed head:` line per *body* (anti-forgery), enforced
 * by `canonicalReviewHead`; it is not a cap on reviews per head.
 */

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  allyReviewLane,
  assertHeadSha,
  assertPrListComplete,
  canonicalReviewHead,
  hasBlockingFindings,
  hasStillPresentDisposition,
  isAllyAppLogin,
} from "./check-ally-review-consistency.mjs";
// The SAME helper the Ally review-consistency guard adopted for this exact
// failure class (BLO-48423). Shared rather than re-implemented: PEN-5314 asked
// whether the sibling guards duplicate the bare-`gh` pattern, and the answer
// is that one shared retry already exists, so this file joins it instead of
// becoming the third spelling. Importing is safe — that module runs nothing on
// import (`if (isMainModule()) main()`).
import { withRetry } from "./mirror-comment-review-gate-to-merge-group.mjs";

/**
 * An auto-merge request older than this is treated as wedged rather than
 * pending. The merge queue drains in minutes; a request still outstanding
 * overnight means it was armed against a gate that has since become
 * unsatisfiable, and it blocks re-enqueue because `--auto` is already set. 13h
 * clears a normal overnight queue without waiting a second working day.
 */
export const STALE_ENQUEUE_HOURS = 13;

/**
 * How long a head may go without reporting before a hold still standing on it
 * is reported as durable rather than in flight.
 *
 * Note what that is NOT: it is not how long the hold has stood. Nothing cheap
 * dates a hold's onset, and `judgeableAgeHours` explains why the head clock is
 * the right proxy anyway. A row that acquired its hold this fire, on CI that
 * finished yesterday, is reported — correctly, because the question is whether
 * the verdict has been available and unacted-on, not who noticed when.
 *
 * The classifier already names a reason for every PR it does not enqueue, so
 * nothing here is newly discovered — what is missing is DURATION. A row that
 * has read `codeowner-review-requested` for three days and one that acquired
 * the same reason four minutes ago are byte-identical in the receipt, and a
 * fire only ever shows the instant it ran. The tail that results is invisible
 * by construction: measured 2026-10-29 on Blockcast/paperclip, two of the four
 * oldest unlanded PRs carried holds that could not clear on their own (#3051
 * waiting on a code owner since 2026-10-27, #3032 red on the non-required
 * `review` check since 2026-10-26), and nothing anywhere said how long.
 *
 * 13h, matching STALE_ENQUEUE_HOURS and for the same reason: it clears a
 * normal overnight queue without waiting a second working day. It is also ~2x
 * the create->merge spread measured over the 12 most recent merges on that
 * repo the same day (2.2-6.8h), so a hold still standing at this age is past
 * every landing that repo actually performs.
 */
export const STALE_HOLD_HOURS = 13;

/**
 * How many times GitHub may eject the SAME head before the enqueuer stops
 * putting it back.
 *
 * Two, deliberately, and the second one is the whole discriminator.
 *
 * An ejection has three causes and they need opposite responses: an infra
 * flake (retry at the same head), a reproducible assertion (the head must
 * move), and collateral from an entry ahead in the queue (nothing to do). A
 * single ejection cannot tell them apart. Measured on #3089, 2026-10-29: of
 * the four failing jobs on queue head `15e7dcef`, THREE were infrastructure —
 * `mirror` died mid-checkout with `The runner has received a shutdown signal`
 * and took both vendored-adapter jobs with it as `The operation was
 * canceled` — and all three were `success` on the rebuilt heads. Holding on
 * the first ejection would have stranded a healthy PR indefinitely.
 *
 * Re-running IS the retest, so the second ejection at an unchanged head is
 * evidence the first was not a flake. That makes the threshold the cheap
 * substitute for classifying the failure: it needs no log scraping, no job
 * name allowlist and no guess about which runner died, and it degrades in the
 * recoverable direction — one wasted re-enqueue, never a permanent hold.
 *
 * ⛔ Do NOT lower this to 1. That reintroduces exactly the hold this comment
 * rules out, and the cost is paid by the PRs behind it: with
 * `mergingStrategy: ALLGREEN` + `mergeMethod: REBASE` an ejection rebuilds
 * every entry behind it from zero (#3089's 13:48:05Z ejection cost #3085 and
 * #3032 ~43 min each, for a failure in neither).
 */
export const EJECTIONS_BEFORE_HOLD = 2;

export const CODEOWNER_REQUEST_MARKER = "<!-- landing-routine:codeowner-request -->";
export const STALE_ENQUEUE_MARKER = "<!-- landing-routine:stale-enqueue -->";
export const STALE_QUEUED_MARKER = "<!-- landing-routine:stale-queued -->";

/**
 * Marker for the stated-hold comment, keyed by the REASON and not just by the
 * PR.
 *
 * Keying it by PR alone would state the first durable hold a PR ever acquired
 * and stay silent through every later one: a PR that waits on CI, goes green,
 * then sits on a code-owner request would carry a comment naming the CI and
 * nothing naming the owner. Keying by reason costs at most one comment per
 * distinct durable reason per PR, which is bounded by the reason vocabulary
 * (a handful) rather than by the number of fires.
 *
 * The reason is slugged rather than interpolated raw because reasons carry
 * `:` and free text (`cap:10-per-fire`, `mergestate:DIRTY`), and an HTML
 * comment must not be able to carry anything that closes it early.
 */
export const statedHoldMarker = (reason) =>
  `<!-- landing-routine:stated-hold:${String(reason ?? "unknown")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")} -->`;

/** Either label is an explicit human "not this one". */
export const SKIP_LABELS = ["do-not-merge", "review-gate-override"];

/**
 * A blast-radius cap, not a throughput target. A classifier bug that says
 * "enqueue" for the wrong reason costs at most this many PRs per fire, and the
 * receipt names every PR the cap deferred so the truncation is never silent.
 *
 * Per FIRE, not per repo: `classifyAll` is called once per swept repo, so the
 * counter has to carry across those calls via `spent` or the real ceiling is
 * `10 x repos` — the cap quietly scaling with the very knob that makes a
 * classifier bug reach further.
 *
 * What carries is SUCCESSFUL enqueues only (see `sweepRepos`): a row that
 * `markFailure` renamed to `enqueue-failed` costs nothing, because a failed
 * enqueue merged no PR. So the cap bounds PRs landed per fire, which is the
 * guarantee above, and does not bound attempts: a repo whose enqueues all fail
 * leaves the next repo a full budget, up to `10 x repos` doomed calls. Those
 * are no-ops, so that is accepted rather than spending budget on them and
 * starving later repos in the sweep.
 *
 * The daily ceiling this implies, recorded 2026-11-03 (PEN-5397) because
 * nothing else states it: the routine fires four times a day (a six-hourly
 * cron at 45 past, America/LA), so the cap puts the ceiling at 40 NEW
 * enqueues per day. `already-enqueued` rows do not spend a slot.
 *
 * That ceiling has NOT been reached on any day yet measured. This
 * paragraph claimed it had, from 2026-11-03 until this correction on
 * 2026-11-05 (PEN-5397). The mistake was the UNIT -- and it is exactly
 * the one the CAUTION paragraph further down already warns about, so the
 * wrong number sat above its own warning for two days.
 *
 * The figures behind it are not wrong, they are about something else:
 * merged PRs per UTC day over 10-23..11-03 peaked at 52 (11-02), with 44
 * on 10-29 and 40 on 10-30. That is REPO demand. This ceiling governs
 * only the PRs this routine itself enqueues.
 *
 * In the right unit -- fire-aligned enqueues under the routine's own
 * identity, counted once per PR -- the three complete UTC days available:
 *
 *     11-02  17-19 / 40      11-03  14-15 / 40      11-04  26 / 40
 *
 * Peak 26, or 65% of the ceiling. The spread is the two defensible
 * clusterings (a 180s-gap burst, or every bot enqueue inside +0..+20 min
 * of a fire instant); they agree to within 2 and neither approaches 40.
 * Of the EIGHT fires that produced output in that window, exactly ONE
 * reached the cap -- 2026-11-04T08:45Z, 10 PRs in 32s. So the cap does
 * bind, but rarely. Measured 2026-11-05 over the timeline of all 222 PRs
 * touched since 11-01: a different method and a wider population than the
 * 11-04 reading it reproduces.
 *
 * The sweep-sample evidence does not survive either. A classifier sample
 * at 2026-11-03T12:31Z produced 10 `enqueue` + 1 `already-enqueued` + 3
 * `cap:10-per-fire` -- a 14-PR eligible pool against a 10-PR budget --
 * and the pool read at or above the cap on every hourly `landing-sweep`
 * sample from 08:29Z to 12:31Z. Read that as a classification, not a
 * fire: the 14:45Z fire that followed it enqueued 6. A sweep samples an
 * eligible pool that other enqueue paths drain before the fire reaches
 * it. The converse reading is just as necessary and is why a quiet fire
 * is not an incident: at 2026-11-05T02:29Z, 16 min before that morning's
 * fire, the sweep emitted no `enqueue` row at all, and the fire duly
 * enqueued nothing. An empty pool and a failed fire look identical from
 * the enqueue side alone; only a pool reading taken BEFORE the fire tells
 * them apart, so bracket the fire if the answer matters.
 *
 * Where the constraint actually sits today is DOWNSTREAM of this cap, in
 * the merge queue. Measured 2026-11-04T22:49Z: depth 12, the 20:45Z
 * fire's entire 8-PR output still in it two hours later, the head
 * AWAITING_CHECKS for 5h41m, and a trailing-24h drain of 47 merges =
 * 1.96/hr -- against the 1.67/hr a fully-spent 40/day ceiling would
 * require. A budget running at 35-65% is not the binding constraint, and
 * more fires would add entries to the one that is. Price that before
 * buying frequency.
 *
 * CAUTION on that merge-count table: it is repo demand, not ROUTINE demand.
 * This routine is one enqueue path among several. Measured 2026-11-04 over
 * the two complete UTC days 11-02 and 11-03 -- 96 PRs merged, 91 of them
 * carrying an `added_to_merge_queue` event -- 28 were enqueued within 15
 * min of a scheduled fire, and 25 of those sat in a batch tight enough to
 * be one. So 4 x 10 bounds the PRs that DEPEND on this routine, not the
 * repo's throughput, and a merge count overstates what the ceiling governs.
 *
 * Measure the enqueue, then, not the merge -- and make the unit a PULL
 * REQUEST. That is the part that is easy to get wrong, and it was gotten
 * wrong in two directions at once in the version of this paragraph that
 * stood until 2026-11-04:
 *
 *   - `git log` over the default branch counts COMMITS. Squash merge is
 *     disabled on this repo, so an N-commit PR lands N commits carrying
 *     the SAME committer second -- 185 commits for those 96 PRs (1.93x),
 *     46 of them multi-commit, #3238 alone landing 12. A 12-commit PR
 *     therefore fabricates exactly the tight cluster a fire looks like.
 *     The committer date does equal `added_to_merge_queue` to the second,
 *     so `git log` finds candidate instants; it cannot count them.
 *   - `gh pr list --state merged` returns rows newest-CREATED first, so a
 *     `mergedAt` window over a fixed `--limit` truncates silently and
 *     still reads as complete: that window returned 100 / 125 / 125 rows
 *     at limits 100 / 200 / 400. Page until two limits agree.
 *   - `auto_merge_enabled` is the WRONG event, even though `--auto` is
 *     literally what this routine calls. On a queue-enabled base GitHub
 *     enqueues immediately whenever it believes the gates are met, and
 *     `classifyPr` only ever arms `mergestate:CLEAN` rows -- so there is
 *     nothing left to wait for and no auto-merge record is written.
 *     Measured 2026-11-04: 25 such events across 200 PRs and 1 that day,
 *     against 34 bot queue-adds the same day. Censusing it reads a
 *     working routine as a dead one.
 *   - Anchoring the census on MERGED PRs undercounts a fire, because a
 *     fire enqueues PRs that have not merged yet and some never will.
 *     Each burst count below read one lower before 2026-11-05, and this
 *     accounts for two of the four: #3151 was in the 11-02T20:47Z burst
 *     and is still open, and #3242 was in the 14:48Z burst but merged on
 *     11-04, outside the two days that census sampled. The other two
 *     off-by-ones were not traced to a cause -- recorded as unexplained
 *     rather than assumed to share this one. Enumerate by UPDATE, not by
 *     merge.
 *   - A fixed minute-window manufactures cap-bound fires that burst
 *     analysis then falsifies. At +0..+20 min the 11-02T14:45Z fire reads
 *     n=10 and looks capped; its actual burst is 9 enqueues inside 30s,
 *     with the tenth arriving 831s later as a delayed arm. Cluster by
 *     gap first, then check the window -- not the other way round.
 *
 * A fire reads as a tight cluster of bot enqueues a few minutes past the
 * hour, in DESCENDING PR number: 11-02T14:48:38Z n=9, 11-02T20:47:46Z n=6,
 * 11-03T02:50:46Z n=7, 11-03T14:56:06Z n=7, each 22-40s wide at +2.8 to
 * +11.1 min (counts re-measured 2026-11-05; see the merged-anchor bullet
 * above for why each read one lower before). Identity does NOT discriminate -- 77 of the 91 enqueues are
 * `allyblockcast[bot]`, far more than any fire batch, so cluster shape is
 * the only signal. The cap IS reached in practice, just not on either day
 * above: the 2026-11-04T08:45Z fire enqueued exactly 10 in 32s
 * (#3368 down to #3215), against 8 in 31s at 02:45Z the same morning.
 *
 * One thing that per-fire count does NOT tell you: a slot is spent at
 * ENQUEUE, not at merge. Of the 10 that saturated 08:45Z, six merged,
 * three were ejected by the merge queue inside 40 min (#3307, #3352,
 * #3356) and one was still queued an hour later. An ejected PR burns a
 * slot and lands nothing, so the daily ceiling bounds ATTEMPTS, and the
 * yield under it is a second quantity to measure before buying more fires.
 *
 * If that has to be fixed, fix it with fire FREQUENCY, not by raising this
 * number. Raising the cap buys throughput by spending the blast-radius
 * guarantee in the first paragraph, and spends it silently -- nothing about
 * a larger number announces that the safety margin moved. More fires at the
 * same cap leave the PER-FIRE radius at exactly 10 and raise the daily
 * ceiling linearly.
 *
 * They do not leave the per-DAY exposure alone, and the paragraph above
 * claimed they did ("the two concerns stay decoupled") until this
 * correction. The 40 is a second bound in its own right: it caps how many
 * PRs a wrong verdict of ANY kind can land in a day -- a classifier bug, or
 * a head verdict this routine trusted and should not have. Six fires at a
 * cap of 10 is 60, so frequency buys latency by spending THAT bound. It is
 * still the better lever than raising the cap, which spends both bounds at
 * once; it is just not a free one. Price the per-day axis before proposing
 * it, rather than stopping at "per-fire radius unchanged".
 *
 * Proposed and DEFERRED, 2026-11-03 (PEN-5397): the six-hourly cron stays
 * and this constant stays 10. The deferral turned on the per-day axis
 * above, against a condition that is dated and expected to clear, recorded
 * on PEN-5397 rather than here so this comment does not outlive it -- read
 * that row before citing this paragraph as a standing refusal. Re-measure
 * pool-against-budget once PEN-5279 lands; re-propose only if the
 * deferral is still biting.
 *
 * The related REPORTING gap -- that a PR deferred by this cap is visible to
 * neither alarm arm -- is a separate defect owned by PEN-5391, not this
 * constant.
 */
export const MAX_ENQUEUES_PER_FIRE = 10;

/**
 * SKIPPED and NEUTRAL are passes: a path-filtered job and a soft-reporting one
 * both legitimately decline to run. Everything else — including a null
 * conclusion, which is a check still in flight — is not a verdict of success
 * and must not be read as one.
 */
const PASSING_CHECK_STATES = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

/**
 * Contexts that mirror Ally's review verdict rather than reporting CI.
 *
 * These are excluded from the check rule because the review rule below reads
 * the same fact from the authoritative source, and reads it correctly. The
 * statuses do not: measured on #1681 @c57fafa0 (2026-09-13), the newest
 * attesting review is `Critical Issues (0)` / `Important Issues (0)` — clean,
 * two non-blocking Suggestions — while `gate/ally-comment-findings` sits at
 * `failure` claiming "carries an unresolved finding". Same divergence recorded
 * on #1418 (BLO-32514), where the status was stale for over a day against a
 * verdict it no longer described.
 *
 * Counting them as checks would be a permanent false hold: a commit status
 * never moves on its own, so such a PR could never enqueue however clean its
 * review became. That is the same immortal-stale-verdict failure the
 * newest-review rule exists to prevent, arriving through a different door.
 *
 * Deliberately narrow. It matches only the `review/ally-*` and `gate/ally-*`
 * legacy-status namespace. The bare `review` context is the PR-quality gate and
 * is a real check; an Ally-named *check-run* with no identically-named status
 * beside it is the workflow that publishes the status, and is also a real
 * check. Neither is excluded — and that is enforced by `isAllyVerdictStatus`
 * below rather than assumed.
 *
 * The name-only reading was once load-bearing and untyped, on the strength of
 * #1821 @5cc6a70e, where all three Ally rows were `StatusContext`. That
 * measurement is STALE — do not restore a reasoning that depends on it. The
 * gate now publishes a `CheckRun` of the same name too (#1957 @68f3f598), so
 * `__typename` alone leaks the twin through as CI. Typing is still correct and
 * still necessary; it is just no longer sufficient, and the twin case is
 * handled in `withoutAllyVerdictMirrors` below.
 *
 * This removes a duplicate reading, not a gate. `allyVerdictAtHead` still
 * blocks on Critical/Important findings and on a still-present prior
 * disposition, from the newest review that attests the current head.
 */
const ALLY_VERDICT_STATUS_RE = /^(?:review|gate)\/ally-/i;

/**
 * Merge states that mean the PR cannot land as it stands. BLOCKED and BEHIND
 * are deliberately absent: BLOCKED is the normal state of a PR awaiting the
 * code-owner approval we may have just requested, and BEHIND is what the merge
 * queue exists to resolve. gh never merges either outright, so `--auto` arms
 * and waits where auto-merge is available and lands in `enqueue-failed` where
 * it is not.
 *
 * This set is also a merge gate, not only a hold list. `gh pr merge --auto`
 * merges immediately instead of arming when the state is CLEAN, HAS_HOOKS or
 * UNSTABLE (`isImmediatelyMergeable`, cli/cli `pkg/cmd/pr/merge/merge.go`).
 * UNSTABLE is a non-passing status the check rule can miss, because that rule
 * ignores Ally verdict statuses by design, so dropping it here turns a hold
 * into an immediate merge past a red status. A test pins it.
 *
 * UNKNOWN is in this set for a DIFFERENT reason than the other two, and the
 * difference decides how it must be read. DIRTY and UNSTABLE are states —
 * GitHub computed them and they say the PR cannot land. UNKNOWN is not a
 * state: it is GitHub saying it has not computed mergeability yet. Holding on
 * it is correct (never enqueue on an uncomputed state), but the hold must not
 * be TERMINAL — see `resolveMergeState`.
 */
export const UNLANDABLE_MERGE_STATES = new Set(["DIRTY", "UNSTABLE", "UNKNOWN"]);

/**
 * Every value GitHub's `mergeStateStatus` enum can take.
 *
 * Exhaustive on purpose: `readMergeState` maps everything OUTSIDE this set to
 * UNKNOWN, so the set is what makes "unrecognised" a decidable question rather
 * than a guess. Adding a state GitHub later introduces is a deliberate act —
 * until it is added, that state is held rather than merged.
 */
export const KNOWN_MERGE_STATES = new Set([
  "BEHIND",
  "BLOCKED",
  "CLEAN",
  "DIRTY",
  "DRAFT",
  "HAS_HOOKS",
  "UNKNOWN",
  "UNSTABLE",
]);

/**
 * The PR's merge state, as a value `UNLANDABLE_MERGE_STATES` can decide.
 *
 * ⛔ The fail-closed direction is the whole point, and it is load-bearing in a
 * way the obvious `String(x ?? "UNKNOWN").toUpperCase()` is NOT. That spelling
 * defends only `undefined` and `null`, because `??` passes an empty string
 * through — and `""` is not in `UNLANDABLE_MERGE_STATES`, so it falls past
 * every hold and classifies `enqueue` with the reason `mergestate:`. Measured
 * 2026-11-04 against the real classifier (PEN-5442): absent, `undefined` and
 * `null` all held at `skip — mergestate:UNKNOWN`, while `""` ENQUEUED.
 *
 * That matters here because `fetchOpenPrs` now JOINS the merge state on from a
 * second call, so for the first time a row can reach the classifier carrying a
 * state nobody read. A join that defaults a miss to `""` — or to any value
 * outside the enum — would merge it. Rather than rely on every present and
 * future join spelling its default correctly, the classifier refuses to read
 * anything it does not recognise as a state: unknown input is an UNREAD state,
 * and an unread state is never a licence to merge.
 */
export function readMergeState(value) {
  const raw = typeof value === "string" ? value.trim().toUpperCase() : "";
  return KNOWN_MERGE_STATES.has(raw) ? raw : "UNKNOWN";
}

/**
 * How many extra reads to spend resolving an UNKNOWN `mergeStateStatus`, and
 * how long to wait between them.
 *
 * GitHub computes `mergeable`/`mergeStateStatus` lazily. A query against a
 * value some other merge invalidated returns UNKNOWN *and schedules* the
 * background recomputation, so the documented client behaviour is to ask
 * again. The listing read in `fetchOpenPrs` is therefore both the report and
 * the trigger, and the next read is the one that can answer.
 *
 * Measured 2026-10-29 (PEN-5057): three PRs merged between 22:00Z and 22:24Z;
 * the next fire classified #3123/#3112/#3109/#3098 `skip — mergestate:UNKNOWN`
 * while a direct read of each returned CLEAN, and a second fire minutes later
 * — no push, no head move, no base change — classified all four `enqueue`.
 * That is 4 of 4 of the fire's genuine candidates, suppressed. A back-to-back
 * control returned byte-identical verdicts across all 15 open PRs, so the
 * flip was one real UNKNOWN -> CLEAN transition, not read-to-read noise.
 *
 * Three attempts at 2s covers the observed recompute with a worst case of ~6s
 * per affected PR, on a handful of PRs per fire.
 */
const MERGE_STATE_RETRIES = 3;
const MERGE_STATE_RETRY_DELAY_MS = 2000;

/**
 * How long after the newest check reports before an all-green rollup is
 * believed (BLO-33208 bucket-B age floor).
 *
 * Checks register over the seconds-to-minutes following a push, so a rollup
 * read mid-registration is green only because the reds have not arrived yet.
 * `failingChecks` structurally cannot see this: an absent check and a passing
 * one are the same empty set. Measured next door on onprem-k8s#3269, where one
 * head dispatched 4 workflows and the identical tree dispatched 22 once a merge
 * commit could be computed (BLO-32606).
 *
 * 15 minutes, not the 24h the reporting-only detector used: that floor existed
 * to avoid paging a human about a PR mid-CI, and this script acts rather than
 * pages. The enqueue is `--auto`, so GitHub re-gates on required checks anyway
 * and the cost of being wrong is one deferred fire. Calibrate with
 * LAND_CLEAN_PRS_SETTLE_MINUTES if a repo's checks register more slowly.
 */
export const CHECK_SETTLE_MINUTES = 15;

function isDismissedOrPending(review) {
  const state = String(review?.state ?? "").toUpperCase();
  return state === "DISMISSED" || state === "PENDING";
}

function lower(value) {
  return String(value ?? "").toLowerCase();
}

/**
 * The latest state per check, as `[name, state]` pairs.
 *
 * A re-run, or a cancelled-then-superseded run, leaves both attempts hanging
 * off the same head. Reading them all makes a green PR look red (BLO-32733),
 * so the newest row per check wins. `statusCheckRollup` unifies the check-run
 * and legacy commit-status surfaces, which is why this reads one field rather
 * than two endpoints that are each blind to the other.
 *
 * "Per check" means per (surface, name), not per name: the union carries
 * `CheckRun` and `StatusContext` rows in independent namespaces, so keying on
 * the name alone lets a newer green status context shadow an older failing
 * check-run of the same name and enqueue past a red required check. Pairs
 * rather than a Map for the same reason — a Map cannot hold both.
 */
export function latestCheckStates(rollup) {
  const latest = new Map();
  for (const context of rollup ?? []) {
    const name = String(context?.name ?? context?.context ?? "").trim();
    if (name === "") continue;
    const state = String(
      context?.conclusion || context?.state || context?.status || "PENDING",
    ).toUpperCase();
    const at = Date.parse(
      context?.completedAt || context?.startedAt || context?.createdAt || "",
    );
    const stamp = Number.isFinite(at) ? at : 0;
    const key = `${context?.__typename ?? ""}\u0000${name}`;
    const seen = latest.get(key);
    if (!seen || stamp >= seen.stamp) latest.set(key, { name, state, stamp });
  }
  return [...latest.values()].map(({ name, state }) => [name, state]);
}

/**
 * A legacy commit status in the Ally verdict-mirror namespace.
 *
 * Keyed on `__typename`, not on the name alone: `statusCheckRollup` unions
 * `CheckRun` and `StatusContext`, so a name-only predicate would also swallow a
 * genuinely failing *check-run* that happened to carry one of these names —
 * contradicting the comment above and letting a PR enqueue past a red required
 * check. Fails safe: if `__typename` is ever absent the row is treated as a
 * real check, which can only over-hold, never over-enqueue.
 */
function isAllyVerdictStatus(context) {
  return (
    context?.__typename === "StatusContext" &&
    ALLY_VERDICT_STATUS_RE.test(String(context?.context ?? ""))
  );
}

/**
 * The rollup with every Ally verdict mirror removed, on BOTH surfaces.
 *
 * `isAllyVerdictStatus` alone is not enough: the gate now publishes a
 * `CheckRun` carrying the same name as the status, so typing on
 * `StatusContext` strips one copy and reads the other as CI. Measured on
 * #1957 @68f3f598 — `gate/ally-comment-findings` is `FAILURE` on both
 * surfaces, and 9 of the 10 open bot-authored PRs sampled carry the check-run
 * twin. It leaks into both rules: `failingChecks` sees a red required check,
 * and once the status copy is filtered the twin is the newest datable row, so
 * it resets the settle floor too (#1981).
 *
 * A check-run counts as a mirror only while a status of the same name sits
 * beside it in the same rollup — that twin is what proves it is a duplicate
 * reading rather than a real check. This is why the exclusion is not simply
 * untyped: a check-run that merely *starts with* `review/ally-` and has no
 * twin is still a genuine check, which is the reason `__typename` keying
 * exists at all.
 *
 * Direction if the status copy ever stops being published: the orphan
 * check-run is read as CI. A FAILURE orphan over-holds (`checks:FAILURE`); a
 * passing orphan (SUCCESS/NEUTRAL/SKIPPED) counts as a row attesting the head,
 * so the `checks:none` stop does not fire and classification falls through to
 * `review:*`, i.e. it can over-enqueue relative to a mirror-free rollup.
 * Measured at #1957 @7c4a8006: 0 of 14 open bot PRs carry an orphan today;
 * revisit this exclusion (name-only, independent of the twin) if the legacy
 * status is retired.
 */
export function withoutAllyVerdictMirrors(rollup) {
  const twins = new Set(
    (rollup ?? []).filter(isAllyVerdictStatus).map((c) => String(c?.context ?? "").trim()),
  );
  return (rollup ?? []).filter(
    (c) =>
      !isAllyVerdictStatus(c) &&
      !(c?.__typename === "CheckRun" && twins.has(String(c?.name ?? "").trim())),
  );
}

export function failingChecks(rollup) {
  return [...latestCheckStates(withoutAllyVerdictMirrors(rollup))]
    .filter(([, state]) => !PASSING_CHECK_STATES.has(state))
    .map(([name, state]) => `${name}=${state}`);
}

/** Operative Ally App reviews whose body attests this exact head. */
export function attestingAppReviews(reviews, headSha) {
  const head = lower(headSha);
  return (reviews ?? []).filter(
    (review) =>
      allyReviewLane(review?.user) === "app" &&
      !isDismissedOrPending(review) &&
      canonicalReviewHead(review?.body) === head,
  );
}

/**
 * @returns {{verdict: "clean"|"blocking"|"stale-head"|"missing", review: object|null}}
 */
export function allyVerdictAtHead(pr) {
  const attesting = attestingAppReviews(pr?.reviews, pr?.headRefOid);
  if (attesting.length === 0) {
    const hasOperativeAppReview = (pr?.reviews ?? []).some(
      (review) => allyReviewLane(review?.user) === "app" && !isDismissedOrPending(review),
    );
    return { verdict: hasOperativeAppReview ? "stale-head" : "missing", review: null };
  }

  const newest = attesting.reduce((a, b) =>
    (Date.parse(b?.submitted_at ?? "") || 0) >= (Date.parse(a?.submitted_at ?? "") || 0) ? b : a,
  );
  const blocking =
    hasBlockingFindings(newest.body) || hasStillPresentDisposition(newest.body);
  return { verdict: blocking ? "blocking" : "clean", review: newest };
}

/**
 * The GitHub-documented CODEOWNERS locations, in GitHub's own precedence
 * order. The first file that exists is the only one that applies.
 */
export const CODEOWNERS_PATHS = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"];

/** Files past this count mean GitHub truncated the diff listing, not that the PR is small. */
export const MAX_PR_FILES = 3000;

/**
 * `@login` -> `login`, `@org/team` -> `team:team`, so an owner token compares
 * directly against what `unsatisfiedOwners` builds from `reviewRequests`.
 * An email owner normalises to itself and simply never matches a request,
 * which is correct: an email in CODEOWNERS requests nobody.
 */
function normalizeOwner(owner) {
  const raw = String(owner ?? "").replace(/^@/, "");
  const slash = raw.indexOf("/");
  return slash === -1 ? raw : `team:${raw.slice(slash + 1)}`;
}

/**
 * Translates one CODEOWNERS pattern into an anchored RegExp.
 *
 * The syntax is gitignore's, and the two rules that matter here are the ones
 * the repo's own CODEOWNERS relies on and a naive glob gets wrong:
 *
 * - A pattern with NO slash matches at **any depth**. `package.json` owns
 *   `packages/adapters/acpx-local/package.json`, which is exactly why the
 *   checked-in file carries a comment saying so.
 * - A slash anywhere but the end anchors to the repo root. `scripts/release*.sh`
 *   does not reach `scripts/nested/release-x.sh`, because `*` stops at `/`.
 */
export function codeownersPatternToRegExp(pattern) {
  let body = String(pattern ?? "");
  const dirOnly = body.endsWith("/");
  if (dirOnly) body = body.slice(0, -1);
  const rooted = body.startsWith("/");
  if (rooted) body = body.slice(1);
  // A slash anywhere but the end still anchors; only a bare name floats.
  const anchored = rooted || body.includes("/");

  // Scanned rather than chain-replaced. A `.replace` pass that rewrites `*`
  // after having already emitted `.*` for `**` cannot tell its own output from
  // the input, and any lookbehind guarding against that also fires on a
  // legitimate `*` following an escaped literal dot.
  let source = "";
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i];
    if (char === "*") {
      if (body[i + 1] === "*") {
        const atStart = i === 0;
        const slashBefore = body[i - 1] === "/";
        const slashAfter = body[i + 2] === "/";
        const atEnd = i + 2 === body.length;
        if (slashBefore && slashAfter) {
          // `a/**/b` spans zero or more whole segments. The `/` is already emitted.
          source += "(?:.+/)?";
          i += 2;
        } else if (slashBefore && atEnd) {
          source += ".*"; // `a/**` owns everything beneath `a/`
          i += 1;
        } else if (atStart && slashAfter) {
          source = "(?:.*/)?"; // `**/b` floats to any depth
          i += 2;
        } else {
          // gitignore: "other consecutive asterisks are considered regular
          // asterisks". `a**b` is therefore confined to one segment, where
          // `.*` would have crossed `/` and owned paths gitignore does not.
          source += "[^/]*";
          i += 1;
        }
        continue;
      }
      source += "[^/]*";
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    source += char.replace(/[.+^${}()|[\]\\]/, "\\$&");
  }

  const prefix = anchored ? "^" : "^(?:.*/)?";
  // A directory pattern owns its contents; so does a bare name that turns out
  // to be a directory, which is why the non-`dirOnly` tail is optional.
  const suffix = dirOnly ? "/.*$" : "(?:/.*)?$";
  return new RegExp(`${prefix}${source}${suffix}`);
}

/**
 * Drops the trailing comment from one CODEOWNERS line.
 *
 * A `#` escaped as `\#` is a literal `#` belonging to the pattern, not the
 * start of a comment, so a blanket `/#.*$/` strip truncates such a pattern
 * into a different -- and silently wider or narrower -- one.
 */
export function stripCodeownersComment(line) {
  let out = "";
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] === "\\" && line[i + 1] === "#") {
      out += "#"; // escaped, so it is part of the pattern
      i += 1;
      continue;
    }
    if (line[i] === "#") break;
    out += line[i];
  }
  return out.trim();
}

/**
 * Parses CODEOWNERS text into rules in file order. Callers must apply
 * LAST-match-wins, which is GitHub's precedence and the opposite of what a
 * `find`-style first-match loop does.
 */
export function parseCodeowners(text) {
  return String(text ?? "")
    .split("\n")
    .map((line) => stripCodeownersComment(line))
    .filter((line) => line.length > 0)
    .map((line) => line.split(/\s+/))
    .filter((fields) => fields.length > 1)
    .map(([pattern, ...owners]) => ({
      pattern,
      matcher: codeownersPatternToRegExp(pattern),
      owners: owners.map(normalizeOwner).filter((owner) => owner.length > 0),
    }));
}

/**
 * The owner tokens CODEOWNERS assigns to `files`, lowercased.
 *
 * Last match wins PER FILE, then the per-file winners are unioned: a PR
 * touching two differently-owned paths owes both owners.
 */
export function ownersForFiles(files, rules) {
  const owners = new Set();
  for (const file of files ?? []) {
    const path = String(file ?? "");
    let winner = null;
    for (const rule of rules ?? []) if (rule.matcher.test(path)) winner = rule;
    for (const owner of winner?.owners ?? []) owners.add(lower(owner));
  }
  return owners;
}

/**
 * Owner tokens this PR's CURRENT diff actually owes, or `null` when that
 * cannot be determined.
 *
 * `null` is load-bearing and must stay distinguishable from the empty set.
 * This script's output is "merge it", so an unreadable CODEOWNERS or a
 * truncated file list has to fall back to the old, over-holding behaviour —
 * never to "nobody is owed", which would enqueue every held PR at once.
 */
export function impliedOwners(pr) {
  const rules = pr?.codeownerRules;
  const files = pr?.files;
  if (!Array.isArray(rules) || !Array.isArray(files)) return null;
  if (files.length >= MAX_PR_FILES) return null;
  return ownersForFiles(files, rules);
}

/**
 * Requested reviewers with no APPROVED review at the current head, scoped to
 * the ones CODEOWNERS still names for this PR's current file list.
 *
 * D7: GitHub does not enforce CODEOWNERS on this repo, so an outstanding owner
 * request is a real gate that only this script observes. A team request can
 * never be satisfied by a login match and so always counts as outstanding,
 * which is correct — a team has not reviewed until one of its members has.
 *
 * PEN-3474: `reviewRequests` on its own is the WRONG set to hold on, in two
 * measured ways, and both are permanent because nothing ever clears them.
 *
 * 1. **A request GitHub never withdraws.** GitHub auto-requests code owners
 *    when a PR opens and does NOT withdraw the request when a force-push takes
 *    the owned file back out of the diff. #3067 opened touching
 *    `.github/workflows/pr.yml`, was auto-requested to `@kkroo` two seconds
 *    later, then force-pushed down to one file that no rule matches — and this
 *    function still reported `kkroo`, so a green PR held forever on an owner
 *    who owns nothing in it. GraphQL's `asCodeOwner` does not see this either:
 *    it read `true` on #3067 at the same instant, because GitHub stamps it at
 *    request time and never recomputes it.
 * 2. **A request no review can satisfy.** The `allyblockcast` *User* seat
 *    (id 296676656) is a different principal from the `allyblockcast[bot]` App
 *    (id 290875700) that submits every review, so the login never matches; at
 *    the time of filing that pinned 70 of 124 open PRs. CODEOWNERS names only
 *    `@kkroo`, so such a request is not code-owner-derived and is now dropped
 *    by construction.
 *
 * This does NOT weaken a deliberate human hold, because a review request was
 * never the instrument for one: `SKIP_LABELS` and draft state are, both
 * machine-readable and both withdrawable by the human who set them.
 *
 * This matches on `commit_id` rather than a body attestation because a human
 * approval carries no attestation to read. That inherits GitHub's own
 * re-anchoring behaviour on force-push, i.e. it can read a re-anchored stale
 * approval as current. The residual is bounded by `dismiss_stale_reviews_on_push`
 * server-side, and the direction matches what GitHub's own merge gate would do.
 */
export function unsatisfiedOwners(pr) {
  const head = lower(pr?.headRefOid);
  const approved = new Set(
    (pr?.reviews ?? [])
      .filter(
        (review) =>
          String(review?.state ?? "").toUpperCase() === "APPROVED" &&
          lower(review?.commit_id) === head,
      )
      .map((review) => lower(review?.user?.login)),
  );
  const outstanding = (pr?.reviewRequests ?? [])
    .map((request) =>
      request?.login ? String(request.login) : request?.slug ? `team:${request.slug}` : null,
    )
    .filter((who) => who !== null && !approved.has(lower(who)));

  const implied = impliedOwners(pr);
  if (implied === null) return outstanding;
  return outstanding.filter((who) => implied.has(lower(who)));
}

/**
 * APPROVED reviewers on this PR, split into human and bot lanes.
 *
 * Only a human approval consumed a scarce resource — human review throughput on
 * this fleet measures ~2.4 actions/day — so a PR that rotted after a person
 * said yes is categorically more expensive than one carrying a bot approval.
 * Reporting them as one "approved" count overstated BLO-33208's own cohort by
 * ~2.7x, which is why the two lanes stay separate all the way to the receipt.
 *
 * Keyed on the REST `user.type` field and never on a `[bot]` login suffix: the
 * suffix is a naming convention any account may adopt, and identity is what
 * decides whether a person was spent. Head is deliberately not considered — the
 * approval was paid for whether or not the branch has moved since.
 */
export function approvalLanes(pr) {
  const human = new Set();
  const bot = new Set();
  for (const review of pr?.reviews ?? []) {
    if (String(review?.state ?? "").toUpperCase() !== "APPROVED") continue;
    const login = String(review?.user?.login ?? "<unknown>");
    (String(review?.user?.type ?? "") === "Bot" ? bot : human).add(login);
  }
  return { human: [...human].sort(), bot: [...bot].sort() };
}

/** Human lane first: the receipt should lead with the expensive case. */
function approvalNote(pr) {
  const { human, bot } = approvalLanes(pr);
  if (human.length > 0) return `spent human approval: ${human.join(", ")}`;
  if (bot.length > 0) return `bot-only approval: ${bot.join(", ")}`;
  return null;
}

/**
 * When the newest row in this rollup last reported, or `null` when nothing in
 * it carries a parseable timestamp.
 *
 * Shared by the settle floor below and by `judgeableAgeHours`, because the two
 * are the same clock read at opposite ends: the floor refuses a rollup that
 * reported too RECENTLY to be believed, and the stale-hold report names one
 * that has reported nothing SINCE, for long enough that the hold cannot still
 * be in flight. Deriving them from one function is what keeps "the moment this
 * head became judgeable" a single definition rather than two that drift.
 */
export function newestCheckStamp(rollup) {
  const stamps = (rollup ?? [])
    .map((c) => Date.parse(c?.completedAt || c?.startedAt || c?.createdAt || ""))
    .filter((at) => Number.isFinite(at));
  return stamps.length === 0 ? null : Math.max(...stamps);
}

/**
 * Whether an all-green rollup has been green long enough to believe.
 *
 * Two ways it has not. A rollup with zero rows is a stop, not a pass: the two
 * surfaces `statusCheckRollup` unions are each capable of carrying the real
 * verdict, so nothing reporting means nothing has attested this head, which
 * renders identically to every check passing. And a rollup whose newest row is
 * younger than the floor is still registering — see CHECK_SETTLE_MINUTES.
 *
 * A non-empty rollup carrying no parseable timestamp counts as settled, which
 * is the opposite of the empty case on purpose. Undatable rows cannot be shown
 * to be *fresh* either, and a commit status never moves on its own, so holding
 * would be permanent — the same immortal-stale-verdict shape the newest-review
 * rule exists to prevent. Enqueuing early is bounded instead: it only arms
 * `--auto`, which re-gates on required checks server-side.
 */
export function checkSettlement(
  rollup,
  { now = Date.now(), settleMinutes = CHECK_SETTLE_MINUTES } = {},
) {
  if ((rollup ?? []).length === 0) return { settled: false, reason: "none" };
  const newest = newestCheckStamp(rollup);
  if (newest === null) return { settled: true };
  const ageMinutes = (now - newest) / 60_000;
  if (ageMinutes < settleMinutes) {
    return {
      settled: false,
      reason: "settling",
      detail: `newest check reported ${ageMinutes.toFixed(1)}m ago, floor ${settleMinutes}m`,
    };
  }
  return { settled: true };
}

/**
 * The rules decidable from `gh pr list` alone, or null when this PR needs its
 * checks and reviews fetched.
 *
 * Split out because `statusCheckRollup` is expensive: asking for it across all
 * 139 open PRs in one GraphQL call returns 502/504 (measured 2026-09-13 at
 * limits 150, 200 and 500). Deciding the cheap rules first means only the PRs
 * that survive them cost two API calls each, and on a repo where most open PRs
 * are already enqueued or human-authored that is most of them avoided.
 */
export function classifyFromListing(pr, { now = Date.now() } = {}) {
  const row = (action, reason, detail = null) => ({
    number: pr?.number,
    headSha: pr?.headRefOid,
    action,
    reason,
    detail,
  });

  if (!isAllyAppLogin(pr?.author?.login) || pr?.author?.is_bot !== true) {
    return row("skip", "human-author", pr?.author?.login ?? "<unknown>");
  }

  const labels = (pr?.labels ?? []).map((label) => lower(label?.name));
  const optOut = SKIP_LABELS.find((label) => labels.includes(label));
  if (optOut) return row("skip", `label:${optOut}`);

  // Draft is the author's own "not this one", in the same category as the
  // opt-out labels above, and it is the only machine-readable form a deliberate
  // sequencing hold reliably takes. trafficcontrol#1726 is the case: draft,
  // CLEAN, Ally-authored, reviewed clean, and its body reads "Draft, and
  // blocked by design. Do not merge before magma#1936" — the two repos carry a
  // byte-identical proto sharing one field-number space, so landing this half
  // alone is the BLO-29906 breakage. It classified `enqueue` until this rule
  // existed; GitHub would have refused the auto-merge, but relying on that is
  // luck, and it evaporates the moment someone marks the PR ready while the
  // sequencing constraint still holds.
  if (pr?.isDraft === true) return row("skip", "draft");

  // Membership in the merge queue is read BEFORE `autoMergeRequest`, because
  // it is a direct observation of where the PR is right now, while an
  // auto-merge request only says what was asked for earlier. The two are not
  // redundant and neither implies the other: a PR enqueued DIRECTLY — which is
  // what a queue-enabled base produces once checks are green — carries
  // `autoMergeRequest: null`. Verified live 2026-11-02T08:49Z on #3241/#3255
  // at queue positions 3 and 2, and again at 23:4xZ on #3275/#3288/#3268, all
  // five reading `autoMergeRequest: null` while sitting in `MQ_kwDOSc-KOc4AA6vt`.
  //
  // Without this branch such a PR missed `already-enqueued` entirely and
  // re-classified `enqueue` on every fire. `applyRow` then re-issued
  // `gh pr merge --auto`, GitHub answered `! Pull request #N is already queued
  // to merge` at EXIT 0 so nothing threw, and the row stayed `enqueue` — which
  // `sweepRepos` counts against MAX_ENQUEUES_PER_FIRE. Every fire spent cap
  // slots on PRs that needed nothing, and a deep enough queue could consume the
  // whole budget while starving the PRs that did need it (PEN-5279).
  //
  // ⛔ Do not key this on `mergeStateStatus` instead. A queued PR is not a
  // distinct merge state: #3241/#3255 read CLEAN while queued at 09:0xZ and
  // UNKNOWN at 09:2xZ, and #3275/#3288 read UNKNOWN while queued at 23:3xZ.
  // The field flaps under load and answers a different question.
  //
  // ## Precedence, and what it changes
  //
  // Living in `classifyFromListing` puts this AHEAD of every rule in
  // `classifyPr` — the merge-state hold, the check rules, and the code-owner
  // hold. That is deliberate and it matches the `autoMergeRequest` branch
  // directly below, which has always short-circuited those same rules: once
  // GitHub has the PR, this routine has nothing left to decide, and a receipt
  // saying it "holds it here rather than enqueuing it" would be false.
  //
  // Measured consequence, dry run 2026-11-02T23:5xZ against Blockcast/paperclip
  // with a 4-deep queue: #3275 and #3268 moved `codeowner-review-requested` ->
  // `already-enqueued`, and #3288 moved `skip`/`mergestate:UNKNOWN` ->
  // `already-enqueued`. `enqueue` was 3 before and 3 after, so nothing that
  // needed enqueuing stopped being enqueued. Note those three were NOT spending
  // cap slots in that window — other rules were already holding them — so that
  // run is evidence the DETECTION works, not a reproduction of the cap burn.
  // The cap burn is the 09:0xZ observation on #3241/#3255, which needs the
  // queued PR to have no outstanding owner request and a CLEAN merge state.
  if (pr?.mergeQueueEntry) {
    const enqueuedAt = Date.parse(pr.mergeQueueEntry.enqueuedAt ?? "");
    // Same rule as the auto-merge clock below: an unparseable timestamp reads
    // as fresh, which leaves the PR alone.
    const ageHours = Number.isFinite(enqueuedAt) ? (now - enqueuedAt) / 3_600_000 : 0;
    const position = pr.mergeQueueEntry.position;
    const where = Number.isFinite(position) ? `queue position ${position}` : "in merge queue";
    // Bounded by the same threshold as a wedged auto-merge request, and for
    // the same reason — but reported under its OWN action, because the
    // `stale-enqueue` remedy is `gh pr merge --disable-auto`, which on a
    // directly-enqueued PR disarms nothing and would post a comment claiming a
    // disarm that never happened. `gh` exposes no dequeue flag (checked on
    // 2.102.0), so this one states the finding and leaves the queue alone.
    //
    // ⛔ AGE ALONE IS NOT STALENESS HERE, and this is the trap `stale-enqueue`
    // does not have. `enqueuedAt` dates when the PR ENTERED the queue, not how
    // long it has been stuck, so ordinary queue depth crosses the threshold on
    // a PR that is progressing perfectly well — this repo's queue has run 40+
    // entries against a measured 18-34 merges/day, which is comfortably over
    // STALE_ENQUEUE_HOURS of legitimate waiting. Reporting that PR as stale
    // would be wrong in the expensive direction: it is sitting in a position it
    // has already waited for, and the obvious reading of a staleness report is
    // to dequeue and re-enqueue, which forfeits exactly that position.
    //
    // So the verdict also requires the entry to be at the FRONT. Position 1 is
    // the only shape this data can diagnose as not-progressing: a head-of-queue
    // entry is the one GitHub is actively trying to land, so 13h there means
    // something is wedged rather than something is busy. Anything behind it is
    // waiting its turn by design and stays `already-enqueued`.
    //
    // `position` is 1-based (verified live 2026-11-02 on a 4-deep queue). An
    // absent or non-numeric position is NOT treated as the front — unread must
    // not manufacture a finding.
    if (ageHours > STALE_ENQUEUE_HOURS && position === 1) {
      return row("stale-queued", `${where}, enqueued ${ageHours.toFixed(1)}h ago`);
    }
    return row("already-enqueued", `${where}, enqueued ${ageHours.toFixed(1)}h ago`);
  }

  if (pr?.autoMergeRequest) {
    const enabledAt = Date.parse(pr.autoMergeRequest.enabledAt ?? "");
    // An unparseable timestamp must not read as infinitely old: treating it as
    // fresh leaves the PR alone, which is the recoverable direction.
    const ageHours = Number.isFinite(enabledAt) ? (now - enabledAt) / 3_600_000 : 0;
    if (ageHours > STALE_ENQUEUE_HOURS) {
      return row("stale-enqueue", `auto-merge armed ${ageHours.toFixed(1)}h ago`);
    }
    return row("already-enqueued", `auto-merge armed ${ageHours.toFixed(1)}h ago`);
  }

  return null;
}

/**
 * Timeline events that mean "the head moved", newest wins.
 *
 * `removed_from_merge_queue` carries `commit_id: null` (verified on #3089's
 * three merge-queue events, 2026-10-29), so an ejection cannot be attributed
 * to a sha directly. It has to be dated against the head instead, and these
 * are the events that date a head: `committed` for an ordinary push,
 * `head_ref_force_pushed` for a rebase or amend. Anything older than the
 * newest of them happened to a head that no longer exists.
 *
 * The two shapes are disjoint, both read live on 2026-10-29: `committed`
 * carries `sha` and `committer.date` with a null `created_at`, while
 * `head_ref_force_pushed` carries `commit_id` and `created_at` with a null
 * `sha`. So the sha of the commit an event attests lives under a different
 * key per kind, and both have to be read.
 *
 * `headSha` narrows the stamps to events attesting THAT commit. Without it
 * the newest commit anywhere on the timeline dates the head even when it is
 * not the head: #3089 carries six `committed` events of which exactly one is
 * `d4f8aa38`, and an abandoned commit dated after the head drags the stamp
 * forward and silently drops real ejections. That is the fail-OPEN direction,
 * and under-counting is the expensive one — it costs every entry in the queue
 * a rebuild, where over-counting costs one deferred enqueue.
 *
 * ⚠ When `headSha` is given but NOTHING on the timeline attests it, this
 * falls back to the unnarrowed newest stamp rather than reporting null.
 * Null would count every historical ejection and hold the PR, and no push
 * could clear it, because a push that produces no attesting event never will
 * — a PERMANENT hold on exactly the PRs whose timeline is odd, which is the
 * stranding `EJECTIONS_BEFORE_HOLD` exists to rule out. The fallback is this
 * function's pre-PEN-5028 behaviour byte for byte, so narrowing can only ever
 * happen on positive evidence about the head.
 *
 * ponytail: every stamp here is a COMMIT time, never a push time, and the
 * REST timeline records no push time for a non-force push. A commit created
 * BEFORE an ejection but pushed AFTER it therefore dates the new head earlier
 * than that ejection, and `ejectionsAtHead` counts it against a head that was
 * never in the queue. Narrowing to `headSha` does not reach this ordering —
 * the head's own `committer.date` is the stamp — so it is a ceiling, not a
 * bug to be found later. Closing it needs a push time from a source other
 * than this timeline. Pinned by the `commit-before-ejection, push-after`
 * test, and the residual leans toward a hold the next push clears.
 *
 * Returns `null` when the timeline carries neither kind — which is the
 * unreadable case, not the "head is infinitely old" case, and
 * `ejectionsAtHead` treats it as such.
 */
export function headMovedAt(timeline, headSha = null) {
  const events = (Array.isArray(timeline) ? timeline : []).filter(
    (event) => event?.event === "committed" || event?.event === "head_ref_force_pushed",
  );
  // `committed` is a raw git object: it carries `committer.date`, not the
  // `created_at` every issue-event has. Reading only `created_at` would drop
  // every ordinary push and leave force-pushes as the sole clock.
  const stampsOf = (list) =>
    list
      .map((event) => Date.parse(event?.created_at ?? event?.committer?.date ?? ""))
      .filter((ms) => Number.isFinite(ms));
  const head = lower(headSha);
  const attesting =
    head === ""
      ? []
      : events.filter((event) => lower(event?.sha) === head || lower(event?.commit_id) === head);
  // Unparseable stamps on the attesting events fall back too: an attesting
  // event nobody can date is no more informative than no attesting event.
  const narrowed = stampsOf(attesting);
  const stamps = narrowed.length ? narrowed : stampsOf(events);
  return stamps.length ? Math.max(...stamps) : null;
}

/**
 * How many times GitHub ejected this PR at its CURRENT head, and whether it is
 * sitting out of the queue right now.
 *
 * Counts only ejections newer than `headMovedAt`, which is what makes the hold
 * self-clearing with no state to store and nothing to expire: a push whose
 * commit was CREATED after the ejections resets the count to zero.
 *
 * ⚠ That reset is NOT unconditional, and the exception is not reachable from
 * this timeline. `headMovedAt` dates a head by commit time, so a commit
 * created BEFORE an ejection but pushed AFTER it dates the new head earlier
 * than that ejection and carries it onto a head that has never been in the
 * queue. For that one push ordering the effective threshold is
 * `EJECTIONS_BEFORE_HOLD - 1`. This sentence used to read "a push resets the
 * count to zero" flatly, which is the sentence a future reader would trust;
 * it was wrong for this ordering (PEN-5028). See the ponytail note on
 * `headMovedAt` for why no narrowing fixes it. The residual leans toward a
 * hold, which the NEXT push — or a manual re-enqueue, which sets `requeued`
 * and bypasses the rule outright — clears.
 *
 * ⚠ An ejection with NO datable head is counted. The alternative — ignore what
 * you cannot date — fails open into the re-enqueue loop this exists to stop,
 * on precisely the PRs whose timeline is odd. Over-counting costs a hold the
 * next push clears; under-counting costs every entry in the queue a rebuild.
 *
 * `requeued` is read separately from the count because the two answer
 * different questions: the count asks whether this head keeps failing, and
 * `requeued` asks whether acting now would double-enqueue. `classifyPr` needs
 * both — a PR already back in the queue is not a candidate whatever its count.
 */
export function ejectionsAtHead(timeline, headSha = null) {
  const events = (Array.isArray(timeline) ? timeline : []).filter(
    (event) =>
      event?.event === "removed_from_merge_queue" || event?.event === "added_to_merge_queue",
  );
  const movedAt = headMovedAt(timeline, headSha);
  const atHead = events.filter((event) => {
    if (movedAt === null) return true;
    const at = Date.parse(event?.created_at ?? "");
    return !Number.isFinite(at) || at >= movedAt;
  });
  const removals = atHead.filter((event) => event.event === "removed_from_merge_queue");
  const newest = (list) =>
    list.reduce((max, event) => {
      const at = Date.parse(event?.created_at ?? "");
      return Number.isFinite(at) && at > max ? at : max;
    }, -Infinity);
  const lastRemoved = newest(removals);
  const lastAdded = newest(atHead.filter((event) => event.event === "added_to_merge_queue"));
  return {
    count: removals.length,
    // Strictly greater, and the tie is broken toward the HOLD on purpose.
    // Timeline stamps have one-second resolution, so an add and a removal in
    // the same second are genuinely unordered — nothing here can tell which
    // happened first, and I have not measured which GitHub emits first. The
    // two directions are not symmetric: calling a tie `requeued` suppresses
    // the hold and re-enters the loop this rule exists to stop, while calling
    // it held costs one deferred enqueue that the next fire takes. Pinned by
    // the `same second` test; do not relax to `>=`.
    requeued: lastAdded > lastRemoved,
    lastRemovedAt: Number.isFinite(lastRemoved) ? lastRemoved : null,
  };
}

/**
 * One row per PR. Rules are ordered so that the reason reported is the one a
 * human would act on first: an explicit opt-out beats a red check, and a red
 * check beats a missing review, because fixing the review would not help.
 *
 * DIRTY is decided ahead of the check rules, and that ordering is load-bearing
 * rather than cosmetic. GitHub cannot evaluate a `paths:` filter on a PR whose
 * merge commit will not compute, so on a conflicted PR every path-filtered
 * workflow is silently never dispatched — no run, no check-run, no "expected"
 * row. The surviving checks then read green and mean nothing (BLO-32606,
 * measured on onprem-k8s#3269). Reading them first would report `checks:` as
 * the reason, or worse read the remnant as a pass; the conflict is both the
 * true cause and the only actionable one.
 */
export function classifyPr(pr, { now = Date.now(), settleMinutes = CHECK_SETTLE_MINUTES } = {}) {
  const fromListing = classifyFromListing(pr, { now });
  if (fromListing) return fromListing;

  const row = (action, reason, detail = null) => ({
    number: pr?.number,
    headSha: pr?.headRefOid,
    action,
    reason,
    detail,
  });

  const mergeState = readMergeState(pr?.mergeStateStatus);
  if (mergeState === "DIRTY") {
    // An approval already paid for here is the BLO-33208 priority cohort: the
    // work is finished and reviewed, master moved underneath it, and no GitHub
    // event fires because the conflicting commit landed on the BASE. Given its
    // own action so the receipt tally carries the count rather than burying it
    // among every other `skip`.
    const spent = approvalNote(pr);
    if (spent) return row("approval-rotted", "mergestate:DIRTY", spent);
    return row("skip", "mergestate:DIRTY");
  }

  // One filtered set for BOTH check rules. `failingChecks` strips the Ally
  // verdict mirrors on the stated grounds that they are not CI checks; handing
  // `checkSettlement` the raw rollup made the two rules disagree about what a
  // check is, in both directions. Fail-open: a rollup carrying only mirror rows
  // is non-empty, so the `checks:none` stop never fired on a head no CI had
  // attested. Fail-closed: `Math.max` over the unfiltered stamps let a mirror
  // row posted minutes ago reset the settle clock on CI that finished hours
  // ago — and since the normal ordering is CI -> review -> mirror, that fired
  // routinely.
  const checks = withoutAllyVerdictMirrors(pr?.statusCheckRollup);

  const failing = failingChecks(checks);
  if (failing.length > 0) {
    // `pop`, not `[1]`: `failingChecks` formats each entry as `name=STATE` and
    // a check NAME may itself contain `=`. Measured on this repo 2026-11-02,
    // `Worktree install (NODE_ENV=production)=QUEUED` split to the reason
    // `checks:production)`. That was survivable while the reason was a receipt
    // column; `stateHold` now puts it in a sentence on the PR ("is not
    // enqueuing this PR: `checks:production)`"), and it also keys that
    // comment's marker, so a mis-split reason is both unreadable and a
    // slug nobody can predict. The state is the LAST field by construction.
    return row("skip", `checks:${failing[0].split("=").pop()}`, failing.join(", "));
  }

  const settlement = checkSettlement(checks, { now, settleMinutes });
  if (!settlement.settled) return row("skip", `checks:${settlement.reason}`, settlement.detail);

  const { verdict } = allyVerdictAtHead(pr);
  if (verdict !== "clean") return row("skip", `review:${verdict}`);

  const owners = unsatisfiedOwners(pr);
  if (owners.length > 0) {
    return row("codeowner-review-requested", "owner-approval-pending", owners.join(", "));
  }

  if (UNLANDABLE_MERGE_STATES.has(mergeState)) return row("skip", `mergestate:${mergeState}`);

  // LAST, and that position is the point. Every rule above reads the PR HEAD;
  // GitHub does not merge the PR head. On a REBASE/ALLGREEN queue it builds a
  // rebased queue head — a different commit — and that is the one whose
  // required `verify` decides. The two disagree systematically, and the PR
  // side is the one that looks green: when GitHub ejects, it deletes the
  // `gh-readonly-queue/...` branch, so the failing check runs stay attached to
  // a commit no PR-level query reaches and `mergeStateStatus` reverts to
  // CLEAN. After an ejection the PR reads not merely green but FRESHLY green.
  //
  // So this cannot be folded into the check rules above — there is nothing in
  // the rollup for them to see. Measured on #3089, 2026-10-29: `verify` was
  // `success` on PR head `d4f8aa38` and `failure` on queue head `15e7dcef` at
  // the same instant, and `classifyPr` returned `skip — checks:settling,
  // failing=[]` on a PR GitHub had ejected 20 minutes earlier. It re-enqueued
  // the unchanged head at 14:08:50Z, 21 minutes after a receipt on the PR had
  // named the failing jobs.
  //
  // ⚠ The repo already DETECTS this twice — `report-merge-queue-ejection.yml`
  // posted the failing job names at 13:48:01Z and
  // `merge-queue-eviction-detector.yml` posted "Cause: failing required check"
  // at 13:52:22Z, both correct and both on time. Neither was an input to the
  // enqueue decision. This rule is the wiring, not a new detector.
  const ejections = ejectionsAtHead(pr?.timeline, pr?.headRefOid);
  if (!ejections.requeued && ejections.count >= EJECTIONS_BEFORE_HOLD) {
    return row(
      "skip",
      "ejected-at-current-head",
      // Not "rerun the queue build": an ejection DELETES the
      // `gh-readonly-queue/...` branch — this rule's own premise — so there is
      // no queue build left to rerun and naming one sends a human to a dead
      // ref. The two things that actually clear this row are a push, and a
      // manual re-enqueue (which sets `requeued`, bypassing the rule).
      `GitHub ejected this head ${ejections.count}x; push a fix, or re-enqueue manually if the failure was infra`,
    );
  }

  return row("enqueue", `mergestate:${mergeState}`);
}

/** Classifies every PR and applies the per-fire enqueue cap. */
export function classifyAll(
  prs,
  {
    now = Date.now(),
    maxEnqueues = MAX_ENQUEUES_PER_FIRE,
    settleMinutes = CHECK_SETTLE_MINUTES,
    spent = 0,
  } = {},
) {
  const rows = (prs ?? []).map((pr) => classifyPr(pr, { now, settleMinutes }));
  // The cap is spent OLDEST PR FIRST (BLO-51664). `gh pr list` returns newest
  // first, so allocating in listing order handed every fire's budget to the
  // newest arrivals while older landable PRs were deferred fire after fire —
  // starvation, not a one-off miss. Ascending PR number is the age proxy;
  // output order is unchanged.
  const winners = new Set(
    rows
      .map((row, i) => ({ row, i, n: prs[i]?.number ?? Infinity }))
      .filter(({ row }) => row.action === "enqueue")
      .sort((a, b) => a.n - b.n)
      .slice(0, Math.max(0, maxEnqueues - spent))
      .map(({ i }) => i),
  );
  return rows.map((row, i) =>
    row.action !== "enqueue" || winners.has(i)
      ? row
      : { ...row, action: "skip", reason: `cap:${maxEnqueues}-per-fire` },
  );
}

/**
 * A gh failure that means the whole fire is untrustworthy rather than this one
 * PR being awkward. Continuing past exhausted rate limits or bad credentials
 * would produce a receipt whose `skip:` rows are indistinguishable from real
 * verdicts, so the fire aborts and says so.
 */
export function isFatalGhError(message) {
  return /rate limit|bad credentials|HTTP 40[13]|could not read (?:Username|Password)/i.test(
    String(message ?? ""),
  );
}

/**
 * A `gh` failure that is specifically "this path does not exist".
 *
 * Deliberately narrow: `gh api` always spells the status as `(HTTP 404)`, and
 * a caller that falls through on anything looser would treat an outage as an
 * absence. Everything it cannot positively identify reads as unknown.
 */
export function isNotFoundGhError(message) {
  return /HTTP 404/i.test(String(message ?? ""));
}

export function renderReceipt(rows) {
  const lines = [
    "| PR | action | reason | detail |",
    "| --- | --- | --- | --- |",
    ...(rows ?? []).map(
      (r) => `| #${r.number} | \`${r.action}\` | \`${r.reason}\` | ${r.detail ?? ""} |`,
    ),
  ];
  const tally = new Map();
  for (const r of rows ?? []) tally.set(r.action, (tally.get(r.action) ?? 0) + 1);
  lines.push(
    "",
    [...tally].sort().map(([action, count]) => `${action}: ${count}`).join(" · ") ||
      "no open PRs",
  );
  return lines.join("\n");
}

/**
 * Hold reasons that are a deliberate "not this one" rather than a strand.
 *
 * A draft PR open for a fortnight, a `do-not-merge` label and a human-authored
 * PR are all states someone CHOSE, and the landing routine has no standing to
 * age them. Reporting them would also swamp the cohort: those three rows are
 * the common case on a busy repo, so a detector that counted them would be
 * read once and then ignored, which is the failure mode of every alarm that
 * fires on its own normal operation.
 *
 * `cap:` is here for that last reason rather than the first. It is not a
 * choice, it is `classifyAll` rewriting an over-budget `enqueue` into a skip —
 * a PR the NEXT fire takes. It ages like a strand because the budget is spent
 * on PRs whose CI finished more recently, so the deferred rows are precisely
 * the ones with the oldest check stamps. Aging it would fire this report
 * hardest exactly when the queue is deepest and the routine is working
 * normally.
 *
 * Its exclusion here is unchanged, but it is no longer a blind spot: the
 * persistent case — deferred for budget while NEVER having been offered a
 * queue slot — is owned by `capStarved`, which discriminates on the PR's own
 * timeline rather than on this clock. See its comment for why that is the
 * only safe way to see a cap deferral (PEN-5391).
 */
const DELIBERATE_HOLD_REASON_RE = /^(?:human-author|draft|label:|cap:)/;

/** Rows that are an action or a self-clearing wait, not a hold to be aged. */
const NON_HOLD_ACTIONS = new Set([
  "enqueue",
  "already-enqueued",
  // Has its own standing cohort (`reportRotted`) with its own semantics; aging
  // it here would report the same PR twice under two different names.
  "approval-rotted",
  // A wedged auto-merge request is already reported AS a staleness finding by
  // `classifyFromListing`, which has a better clock for it than this one: the
  // request's own `enabledAt`.
  "stale-enqueue",
  // PEN-5430. A notify-only repo's clean PR is held by POLICY — we do not land
  // there — and that hold never clears. Aging it would park every clean PR in
  // the repo in the stale-hold cohort permanently and, on `--apply`, comment
  // on each one saying the routine is not enqueuing it. True, useless, and
  // forever.
  "notify-only",
  // Same argument, different clock: a PR wedged in the merge queue is reported
  // by `classifyFromListing` off the queue entry's own `enqueuedAt`.
  "stale-queued",
]);

/**
 * Hours since this PR's head last became judgeable, or `null` when nothing
 * dates it.
 *
 * ## Why this clock and not the PR's age
 *
 * Creation time is the obvious choice and it is WRONG, in the direction that
 * costs most: it manufactures findings. Measured 2026-10-29 on
 * Blockcast/paperclip, #3089 and #3085 were 9.2h and 9.8h old against a
 * 2.2-6.8h create->merge spread, which reads as a flagrant strand. Both had
 * moved their heads that morning (08:05Z, 07:03Z) and their CI had finished
 * minutes before the measurement (09:27Z, 09:01Z) — they had been judgeable
 * for 2.3h and 2.7h, comfortably INSIDE the window, and both classified
 * `enqueue` at the next read. A creation clock names them; this one does not.
 *
 * That is not a tuning difference. A PR's age is the age of its oldest
 * abandoned attempt, and every push resets what the classifier is actually
 * looking at: the rollup, the review attestation and the merge state are all
 * properties of the CURRENT head. The honest question is "how long has this
 * verdict been available and unchanged", and the newest check stamp is the
 * only cheap answer to it — `checkSettlement` already computes it for the
 * settle floor, so this costs no extra API call.
 *
 * Uses the mirror-filtered rollup for the same reason `failingChecks` does: an
 * Ally verdict mirror posted after CI finished would otherwise reset this
 * clock on a hold that has not moved (the #1981 shape).
 */
export function judgeableAgeHours(pr, { now = Date.now() } = {}) {
  const newest = newestCheckStamp(withoutAllyVerdictMirrors(pr?.statusCheckRollup));
  return newest === null ? null : (now - newest) / 3_600_000;
}

/**
 * The held PRs whose hold has outlived the window in which this repo lands
 * anything, as `{ number, reason, ageHours }`.
 *
 * `ageHours` is `null` when the PR could not be dated, and such a row is
 * REPORTED rather than dropped. Dropping it is the §4l shape — an instrument
 * that cannot see something reporting clean — and the undatable case is
 * exactly the one worth hearing about, because a held PR whose rollup carries
 * no timestamp at all is a PR on which nothing ever ran.
 *
 * Takes both arrays rather than a field on the row because the row shape is
 * the receipt's contract and several callers deep-compare it; joining on
 * `number` keeps the classifier pure and this report additive.
 */
export function stalledHolds(prs, rows, { now = Date.now(), staleHours = STALE_HOLD_HOURS } = {}) {
  const byNumber = new Map((prs ?? []).map((pr) => [pr?.number, pr]));
  const held = [];
  for (const row of rows ?? []) {
    if (NON_HOLD_ACTIONS.has(row?.action)) continue;
    if (DELIBERATE_HOLD_REASON_RE.test(String(row?.reason ?? ""))) continue;
    const ageHours = judgeableAgeHours(byNumber.get(row?.number), { now });
    if (ageHours !== null && ageHours < staleHours) continue;
    held.push({ number: row?.number, reason: row?.reason, ageHours });
  }
  return held;
}

/** The stale-hold block for one repo's receipt, or "" when there is none. */
export function renderStalledHolds(repo, held, { staleHours = STALE_HOLD_HOURS } = {}) {
  if ((held ?? []).length === 0) return "";
  const line = ({ number, reason, ageHours }) =>
    `  ${repo}#${number} — \`${reason}\`, ` +
    (ageHours === null ? "age unknown (no dated check on this head)" : `${ageHours.toFixed(1)}h`);
  return (
    `stale-hold (judgeable >${staleHours}h, still held) — ${held.length}:\n` +
    held.map(line).join("\n") +
    "\nThe age is time since this head last reported, not time the hold has " +
    "stood — a hold acquired this fire on old CI still counts. Each row " +
    "already carries its reason above; what is new is that the reason has " +
    "stopped being a wait. Act on it or say why it stands."
  );
}

/**
 * How long a PR may classify `enqueue` — the routine's own "nothing is holding
 * this" — and still be open before it is reported as stranded rather than as
 * about to land.
 *
 * ## Why a second cohort, when `stalledHolds` already ages the receipt
 *
 * `stalledHolds` enumerates REASONS FOR INACTION and ages them. A row that
 * reads `enqueue` has no such reason, so it is in `NON_HOLD_ACTIONS` and is
 * structurally invisible to it — correctly, for the fire that acts on it.
 * The invisibility is wrong only for a row that reads `enqueue` fire after
 * fire and never lands, and nothing in this repo could see that case.
 *
 * Measured 2026-11-02T09:0xZ on Blockcast/paperclip (PEN-5263, sharpened by
 * Devops on PEN-5260): a dry run classified #3241 and #3255 `enqueue`, and
 * the stale-hold block printed 8 rows — none of them these two. #3241's head
 * landed 2026-11-01T23:51:30Z and Ally returned a clean verdict against it at
 * 00:05:01Z; **21 PRs merged to `master` past it** while it sat eligible. It
 * appeared in no report anywhere, because it was not held.
 *
 * ## Why this clock, and why six hours
 *
 * `judgeableAgeHours` — the same clock as `stalledHolds`, for the same reason
 * (see its comment). The threshold is the part that differs, and it is
 * deliberately SHORTER than `STALE_HOLD_HOURS`.
 *
 * `STALE_HOLD_HOURS` is 13 because a hold waits on a human and 13h clears an
 * overnight queue. This cohort's defining property is that it waits on NOBODY:
 * the classifier has already said yes. So the only thing it can be waiting on
 * is the routine itself, and the right scale is the routine's own cadence.
 * Measured over the 30 most recent merges to `master` (2026-11-01T18:20Z →
 * 2026-11-02T08:41Z): median gap ~20 min, longest 144.8 min. Six hours is
 * ~2.5x the worst observed gap, so a row still eligible at that age has been
 * passed over by several fires that demonstrably merged other PRs — which is
 * the measured shape of the defect, not a slow afternoon.
 *
 * It is a detection threshold, never a deadline: a PR landing in ten minutes
 * is the normal case and is reported nowhere.
 */
export const UNLANDED_ELIGIBLE_HOURS = 6;

/**
 * The PRs the classifier said yes to and that are still open well past the
 * window in which this repo lands anything, as `{ number, reason, ageHours }`.
 *
 * ## What is deliberately NOT in this cohort
 *
 * `already-enqueued` — bounded already, and by a better clock, in BOTH of the
 * two ways a PR reaches that verdict. A wedged auto-merge request is reported
 * as `stale-enqueue` off its own `enabledAt`; a PR wedged in the merge queue
 * is reported as `stale-queued` off its queue entry's `enqueuedAt`. Both fire
 * after STALE_ENQUEUE_HOURS, and adding either here would name one PR twice.
 *
 * ⚠ That second clock is why this carve-out is sound, and it did not exist
 * before PEN-5279. Until then `already-enqueued` was reachable ONLY through
 * `autoMergeRequest`, so a DIRECTLY-enqueued PR — the normal product of a
 * queue-enabled base — never classified `already-enqueued` at all. Reading
 * queue membership closes that; do not reintroduce it by making
 * `already-enqueued` depend on `autoMergeRequest` again.
 *
 * ⛔ CORRECTED 2026-11-05 (PEN-5536). This paragraph used to say that such a
 * PR "classified `enqueue`, which is exactly this cohort's predicate, so a PR
 * sitting healthily in the queue was INSIDE this detector", held under the bar
 * on #3241 by "Luck, not design." THAT READING IS WRONG, and it matters
 * because it invites the next reader to derive a coverage claim from it — to
 * conclude that PEN-5279 REMOVED an accidental alarm that something now has to
 * restore. Nothing was removed.
 *
 * The mechanism, not luck: `UNKNOWN` is a member of UNLANDABLE_MERGE_STATES,
 * so a PR reading UNKNOWN returns `skip`/`mergestate:UNKNOWN` and never
 * reaches the `enqueue` arm at all. Measured 2026-11-04, a PR in the merge
 * queue reads UNKNOWN for its ENTIRE time queued (3 of 3 queued vs 0 of 3 not
 * queued, across the 08:29Z/09:28Z/10:28Z sweeps), and all six sampled PRs
 * read CLEAN only BEFORE being queued. So the window in which a queued PR can
 * classify `enqueue` is the brief one at the head of its queue time, and by
 * the time it could age past UNLANDED_ELIGIBLE_HOURS it is reading UNKNOWN and
 * classifying `skip`. The two clocks point in opposite directions, and the
 * accidental alarm was never reachable for a genuinely wedged head.
 *
 * The consequence is the load-bearing one: a wedged front-of-queue entry was
 * red to NOBODY before PEN-5279 and still red to nobody after it. PEN-5536's
 * `queued` cohort is therefore a hole being closed for the first time — a
 * strictly additive change to the alarm, not a restoration.
 *
 * `enqueue-failed` — `markFailure` renames the action, which drops it out of
 * `NON_HOLD_ACTIONS`, so `stalledHolds` already ages it. Covered.
 *
 * `cap:N-per-fire` — still excluded here, and `stalledHolds` still excludes it
 * by reason, for an argument that is unchanged: the deferred rows are selected
 * for old check stamps (the budget is spent on PRs that reported more
 * recently), so this clock is biased against them at any threshold, and aging
 * them would fire hardest exactly when the queue is deepest and the routine is
 * working. Do not close the gap by widening this predicate.
 *
 * ⚠ What HAS changed is the premise that made the resulting blind spot
 * acceptable. This paragraph used to read "accepted because starvation is not
 * reachable at today's figures — the cap is MAX_ENQUEUES_PER_FIRE per fire
 * against a measured 18-34 merges/day — and it wants its own detector with its
 * own clock if it ever becomes so." That precondition FAILED, measured
 * 2026-11-03 (PEN-5391): merges to `master` ran 27 on Nov 1, **51 on Nov 2**
 * and ~45/day on Nov 3, above the band; and the cap was SATURATED on 4 of 4
 * consecutive hourly samples (10 of 10 `enqueue` rows at 08:29Z, 09:27Z,
 * 10:28Z, 11:28Z), deferring 4-6 PRs each time. It had already produced a
 * silent miss: at 11:28Z the sweep went red naming 6 PRs and #3306 was not
 * among them, after 12h CLEAN and never once queued.
 *
 * So the detector that paragraph asked for now exists — `capStarved`, with its
 * own clock (CAP_STARVED_HOURS) and, crucially, its own DISCRIMINATOR, which
 * is not an age test at all. See its comment. Both predicates here stayed
 * exactly as they were.
 *
 * ## A sampling gap, measured rather than assumed
 *
 * `mergeStateStatus: UNKNOWN` is deliberately NOT claimed here. GitHub
 * computes mergeability lazily and a CLEAN row flaps to UNKNOWN under load:
 * measured 2026-11-02, #3241 and #3255 classified `enqueue`/`mergestate:CLEAN`
 * at 09:0xZ and `skip`/`mergestate:UNKNOWN` at 09:2xZ, with `resolveMergeState`
 * having already spent its retries — and, measured 2026-11-04, a PR IN THE
 * MERGE QUEUE reads UNKNOWN for its entire time queued (3 of 3 queued vs 0 of
 * 3 not queued, across the 08:29Z/09:28Z/10:28Z sweeps). That one is not a
 * flap and does not settle, so `resolveMergeState` exhausts its retries on it
 * every fire. While a row reads UNKNOWN its state is UNREAD, so claiming
 * "nothing is holding this" about it would be a statement the data does not
 * support — and this cohort's whole content is that claim.
 *
 * The cost is one missed sample, not a blind spot: the condition persists for
 * hours, the sweep is hourly, and PEN-5279 classifies a queued PR
 * `already-enqueued` before the merge state is read, so the queue-induced case
 * no longer reaches either detector. What is genuinely uncovered is a PR that
 * reads UNKNOWN on every sample between the two thresholds. Stated here
 * rather than papered over, because the fix for it is a better merge-state
 * read, not a looser predicate.
 *
 * ⛔ Note what the superseded reading of that paragraph got wrong, because it
 * is the kind of error that reads as reassurance: it said "`stalledHolds` owns
 * `mergestate:UNKNOWN` outright from STALE_HOLD_HOURS". `stalledHolds` does
 * not feed `alarmExitCode`, so it never owned anything in the ALARM sense —
 * it prints. It printed "act on it" about #3281 fifteen minutes before that PR
 * merged.
 *
 * An undatable row (`ageHours === null`) is REPORTED, matching `stalledHolds`
 * and for the same §4l reason: an instrument that cannot see something must
 * not report clean. The case is narrow — it needs a rollup that is non-empty
 * but carries no timestamp on any entry — and a row that persists in it is a
 * true finding twice over, because nothing landed it AND nothing dated it.
 */
export function unlandedEligible(
  prs,
  rows,
  { now = Date.now(), staleHours = UNLANDED_ELIGIBLE_HOURS } = {},
) {
  const byNumber = new Map((prs ?? []).map((pr) => [pr?.number, pr]));
  const stranded = [];
  for (const row of rows ?? []) {
    if (row?.action !== "enqueue") continue;
    const ageHours = judgeableAgeHours(byNumber.get(row?.number), { now });
    if (ageHours !== null && ageHours < staleHours) continue;
    stranded.push({ number: row?.number, reason: row?.reason, ageHours });
  }
  return stranded;
}

/** The unlanded-eligible block for one repo's receipt, or "" when there is none. */
export function renderUnlandedEligible(
  repo,
  stranded,
  { staleHours = UNLANDED_ELIGIBLE_HOURS } = {},
) {
  if ((stranded ?? []).length === 0) return "";
  const line = ({ number, reason, ageHours }) =>
    `  ${repo}#${number} — \`${reason}\`, ` +
    (ageHours === null ? "age unknown (no dated check on this head)" : `${ageHours.toFixed(1)}h`);
  return (
    `unlanded-eligible (judgeable >${staleHours}h, nothing holding it) — ${stranded.length}:\n` +
    stranded.map(line).join("\n") +
    "\nThese carry no hold at all — the classifier said enqueue. So the thing " +
    "that has not happened is the landing itself, not a decision about it. " +
    "Check that the routine is firing and that its enqueues are succeeding " +
    "before looking at the PRs."
  );
}

/**
 * How long a PR may sit cap-deferred, having never once been offered a queue
 * slot, before it is reported as starved rather than as waiting its turn.
 *
 * ## Why a third cohort, and why the other two cannot have it
 *
 * `classifyAll` rewrites an over-budget `enqueue` into `skip`/`cap:`, which
 * puts the row outside BOTH existing detectors — `stalledHolds` excludes
 * `cap:` by reason (DELIBERATE_HOLD_REASON_RE), `unlandedEligible` excludes it
 * by action. That residual is stated on `unlandedEligible` and it was correct
 * while it held. It no longer holds; see the correction there.
 *
 * Neither predicate may simply be widened, and the reason is the same for
 * both: the cap spends its budget on PRs that reported more recently, so the
 * deferred set is SELECTED for old check stamps. An age test over `cap:` rows
 * alone therefore fires hardest exactly when the queue is deepest and the
 * routine is working hardest — an alarm on normal operation, which is the
 * failure mode every cohort in this file is written to avoid.
 *
 * ## What makes this cohort safe where a widened predicate is not
 *
 * The age test is not the discriminator here; `everOfferedQueueSlot` is. A PR
 * deferred by one saturated fire is normal and lands on a later one — and the
 * moment it does, GitHub writes `added_to_merge_queue` to its timeline and the
 * PR leaves this cohort permanently, whatever its check stamps say. What
 * remains is only the PR that has gone its entire judgeable life without the
 * routine ever offering it a slot, which is starvation and not depth.
 *
 * That also answers "where does the across-fire state live". It lives in the
 * PR's own timeline, which is already fetched with `--paginate` for the
 * ejection rule, so this cohort costs no API call and needs no durable store
 * shared between fires.
 *
 * ## What BLO-51664 changed, and what it did not (measured 2026-11-04)
 *
 * `classifyAll` now spends the cap OLDEST PR FIRST. That narrows WHICH PRs
 * this cohort can name; it does not make it vacuous, and the difference is a
 * reachability question that one healthy sample cannot settle. Oldest-first
 * bounds how long a PR stays deferred only if the PRs that WIN the slots then
 * leave. When they do not, the budget is pinned and everything newer starves
 * structurally rather than transiently.
 *
 * Worked member, same day: #3215 spent 21.2h judgeable with zero
 * `added_to_merge_queue` and zero `auto_merge_enabled` events in its entire
 * timeline, deferred `cap:10-per-fire` at every saturated sweep. That is
 * `everOfferedQueueSlot === false` past CAP_STARVED_HOURS exactly — reached
 * under oldest-first allocation, not before it. (It was enqueued on the
 * 08:45Z fire of 2026-11-04 and left the cohort; the point is the day it
 * spent inside it with no detector able to name it.)
 *
 * So do not read a quiet queue as evidence this cohort is now unreachable,
 * and do not replace `everOfferedQueueSlot` with an age test on the grounds
 * that the starved set is now always young. On 2026-11-04T07:28Z it was
 * (#3376 #3375 #3374 #3372, the newest band); at 11:28Z the day before it was
 * not. The discriminator is the absence of an offered slot, which is true of
 * both.
 *
 * ## Why twelve hours
 *
 * Measured 2026-11-03 over the 30 most recent merges to `master`
 * (#3274 - #3326, created 2026-11-02T10:49Z - 2026-11-03T06:18Z): every one
 * of the 30 reached the queue, and the wait from CREATION to the first
 * `added_to_merge_queue` ran min 3.9h, median 6.3h, p90 10.0h, max 11.7h.
 *
 * That is a strictly LOOSER clock than this one — a head's newest check stamp
 * is never earlier than the PR's creation, so judgeable age at first enqueue
 * is at most the figure above. Twelve hours is therefore past the worst
 * observed first-slot wait measured on a clock that over-states it, which is
 * the conservative direction: this cohort would have named none of those 30.
 *
 * Deliberately longer than UNLANDED_ELIGIBLE_HOURS (6). A row reading
 * `enqueue` waits on nobody, so the routine's own cadence bounds it. A `cap:`
 * row is waiting on a budget that genuinely refills, so it is owed the full
 * span in which this repo demonstrably hands out first slots.
 */
export const CAP_STARVED_HOURS = 12;

/** Rows `classifyAll` deferred for budget, as opposed to any other skip. */
const CAP_DEFERRAL_REASON_RE = /^cap:/;

/**
 * Timeline events that mean the routine has, at some point, offered this PR a
 * queue slot. `added_to_merge_queue` is the queue-enabled path and
 * `auto_merge_enabled` the arming that precedes it; either one is proof.
 *
 * `removed_from_merge_queue` is deliberately NOT here. An ejected PR was
 * served and bounced, which is the opposite of starved, and it is already
 * carried by `added_to_merge_queue` on the same timeline (6 of 6 merged PRs
 * sampled 2026-11-03 showed the pair). Reading the ejection as evidence in its
 * own right would add nothing and would invite the inverse error.
 */
const QUEUE_OFFER_EVENTS = new Set(["added_to_merge_queue", "auto_merge_enabled"]);

/**
 * Whether this PR has ever been offered a queue slot: `true`, `false`, or
 * `null` when the timeline was not read.
 *
 * ## `null` is not `false`, and conflating them is the expensive direction
 *
 * `fetchOpenPrs` hydrates `timeline` only for PRs that survive
 * `classifyFromListing`, which is exactly the set that can reach `cap:` — so
 * in this script the datum is always present for the rows `capStarved`
 * examines. The three-valued return exists for the day that stops being true:
 * an absent timeline read as `false` would make EVERY cap-deferred row look
 * starved at once, turning this detector into noise on its first fire and
 * costing the alarm its credibility across all three cohorts.
 *
 * Verified live 2026-11-03 before this cohort was written, because a predicate
 * over an event that never appears is vacuous and reports clean forever: 6 of
 * 6 recently merged PRs carried `added_to_merge_queue`, and the two PRs then
 * sitting cap-deferred (#3306, #3215) carried no queue event at all.
 */
export function everOfferedQueueSlot(timeline) {
  if (!Array.isArray(timeline)) return null;
  return timeline.some((event) => QUEUE_OFFER_EVENTS.has(event?.event));
}

/**
 * The PRs the classifier said yes to, that the per-fire cap deferred, and that
 * the routine has never once offered a queue slot, as
 * `{ number, reason, ageHours }`.
 *
 * ## What is deliberately NOT in this cohort
 *
 * A cap-deferred PR that HAS been queued before — however long ago, and
 * whether it merged from there or was ejected. It is not starved: the routine
 * reached it. An ejected head has its own rule (`ejected-at-current-head`) and
 * its own clock, and claiming it here would name one PR twice under two
 * mechanisms that disagree about what is wrong with it.
 *
 * A PR whose timeline was not read (`everOfferedQueueSlot === null`). This
 * cohort's entire claim is "nothing has ever offered this a slot", and an
 * unread timeline cannot support it — the same posture `unlandedEligible`
 * takes toward `mergestate:UNKNOWN`. Note this is the OPPOSITE call to the
 * undatable-clock case below, and deliberately so: the clock REFINES a finding
 * that stands without it, while the timeline IS the finding.
 *
 * An undatable row (`ageHours === null`) is REPORTED, matching both sibling
 * cohorts and for the same §4l reason: an instrument that cannot see something
 * must not report clean. A cap-deferred PR that has never been queued and
 * whose head carries no dated check is a true finding twice over.
 *
 * ⚠ A row whose PR is MISSING from `prs` is dropped, where both siblings keep
 * it. That is the unread-timeline rule above rather than a different §4l
 * posture — no PR means no timeline — but it IS a divergence, so it is named
 * here and pinned by a test rather than left to be discovered. Unreachable in
 * this script, where rows and PRs come from one fetch.
 */
export function capStarved(prs, rows, { now = Date.now(), staleHours = CAP_STARVED_HOURS } = {}) {
  const byNumber = new Map((prs ?? []).map((pr) => [pr?.number, pr]));
  const starved = [];
  for (const row of rows ?? []) {
    if (row?.action !== "skip") continue;
    if (!CAP_DEFERRAL_REASON_RE.test(String(row?.reason ?? ""))) continue;
    if (everOfferedQueueSlot(byNumber.get(row?.number)?.timeline) !== false) continue;
    const ageHours = judgeableAgeHours(byNumber.get(row?.number), { now });
    if (ageHours !== null && ageHours < staleHours) continue;
    starved.push({ number: row?.number, reason: row?.reason, ageHours });
  }
  return starved;
}

/** The cap-starved block for one repo's receipt, or "" when there is none. */
export function renderCapStarved(repo, starved, { staleHours = CAP_STARVED_HOURS } = {}) {
  if ((starved ?? []).length === 0) return "";
  const line = ({ number, reason, ageHours }) =>
    `  ${repo}#${number} — \`${reason}\`, ` +
    (ageHours === null ? "age unknown (no dated check on this head)" : `${ageHours.toFixed(1)}h`);
  return (
    `cap-starved (judgeable >${staleHours}h, never once queued) — ${starved.length}:\n` +
    starved.map(line).join("\n") +
    "\nThese are eligible and were deferred for budget, not for a reason — and " +
    "unlike the usual cap deferral they have never been offered a slot at all. " +
    "So demand is outrunning MAX_ENQUEUES_PER_FIRE rather than queueing behind " +
    "it. Raising throughput is the fix; re-running the routine is not."
  );
}

/**
 * The remedy paragraph for a hold whose failing check is the bare `review`
 * context, or `""` for every other hold.
 *
 * ## Why this one check earns a bespoke sentence
 *
 * `checks:FAILURE` reads as "a check is red, go fix the code", and for this
 * check that is wrong in a way that costs days. The bare `review` context is
 * `commitperclip PR Review` — the PR-QUALITY gate, not CI and not a code
 * finding. Measured on this repo 2026-11-02, `#3032` sat red on it from
 * 10-26 and `#3238` from 08:02:16Z, both clearable by their own author in
 * about two minutes, both costed as unclearable because the hold did not say
 * so. `commitperclip-review.yml`'s own header records four more of the same
 * shape sitting 7h, 10h, ~21h and ~7h (`#1328`, `#1359`, `#1696`, `#1873`).
 *
 * ## Why the sentence does NOT say "edit the description, no push required"
 *
 * That is the natural one-liner and it is true of only HALF the gate.
 * `run-quality-gates.mjs` fails the check on SIX gates, and they split on
 * what they read:
 *
 *   - body/title only — `checkTemplate`, `checkLinkedIssue`,
 *     `checkDedupSearch`. These do clear on an edit with no head move, which
 *     is why the workflow subscribes to `edited` at all (BLO-26636).
 *   - the diff itself — `checkTestCoverage(files)`, `checkLockfile(files)`,
 *     `checkCommitTrailers(commits)`. An edit RE-RUNS these and they fail
 *     again identically, because a description edit changes neither files nor
 *     commits. A missing commit trailer is only fixable by rewriting the
 *     commit — exactly the push the one-liner says is unnecessary.
 *
 * So the sentence names the split and points at the gate's own comment, which
 * is the only thing that knows which of the six actually failed. Telling an
 * author "no push required" on a trailer failure would send them round the
 * edit loop indefinitely — a worse hold than the generic one it replaces.
 *
 * Matched on the EXACT check name. `failingChecks` formats entries as
 * `name=STATE`, and this repo also publishes `security-review` and
 * `gate/ally-comment-findings`; a substring test would claim the quality-gate
 * remedy for a red security review, which has no such remedy.
 */
export function reviewGateRemedy(detail) {
  const failed = String(detail ?? "")
    .split(",")
    .map((entry) => entry.trim().split("=").slice(0, -1).join("=").trim());
  if (!failed.includes("review")) return "";
  return (
    `The red check is \`review\` — this repo's PR-quality gate ` +
    `(\`commitperclip PR Review\`), which is not CI and not a code finding. It fails on six ` +
    `gates that split in two. Three read only the PR body and title (template sections, ` +
    `linked issue, dedup search) and clear on a description or title EDIT, with no push and ` +
    `no head move — the workflow listens for \`edited\` precisely so that fix re-runs it. ` +
    `The other three read the diff (test coverage, lockfile, commit trailers); an edit ` +
    `re-runs those unchanged and they fail again, so they need a push. The gate's own ` +
    `comment on this PR names which ones failed — read that before choosing.\n\n`
  );
}

/**
 * The sentence a durable hold gets on its own PR.
 *
 * ## Why only the DURABLE holds, when PEN-5263 asked for every decline
 *
 * "Every landing decline states its reason on the PR" is the right goal and
 * the literal reading is self-defeating. Measured on this repo 2026-11-02, one
 * fire declined 31 of 33 open PRs, 20 of them on `checks:QUEUED` or
 * `checks:IN_PROGRESS` — states that clear in minutes without anyone reading
 * anything. Commenting on each, each fire, buries the two comments that matter
 * under hundreds that do not, and the end state of an alarm that fires on its
 * own normal operation is that nobody reads it. That failure is already
 * recorded twice in this file (`DELIBERATE_HOLD_REASON_RE`, `reportRotted`).
 *
 * So the line is drawn where the existing detectors already draw it: a decline
 * is stated on the PR once it has stopped being a wait — once `stalledHolds`
 * or `unlandedEligible` names it. Both are aged on `judgeableAgeHours`, so a
 * transient decline is never stated and a durable one always is. `#3102`'s
 * code-owner comment is the template and is unchanged; this generalises it to
 * every reason that outlives its window, rather than the two that happened to
 * have a bespoke comment.
 *
 * `commentOnce` makes it idempotent, and `statedHoldMarker` keys it by reason,
 * so the ceiling is one comment per PR per distinct durable reason — not one
 * per fire.
 *
 * The two bespoke `applyRow` comments are not duplicated here, and that is
 * ENFORCED by `BESPOKE_COMMENT_ACTIONS` in the caller rather than assumed. It
 * reads like it should fall out of the cohorts and it does not:
 * `stale-enqueue` is excluded for free (`NON_HOLD_ACTIONS`), but
 * `codeowner-review-requested` is in neither that set nor
 * `DELIBERATE_HOLD_REASON_RE`, so it reaches `stalledHolds` and would collect
 * a second comment under `stated-hold:owner-approval-pending` beside its
 * `CODEOWNER_REQUEST_MARKER` one. Both say the PR is held on an owner; only
 * the bespoke one names the owner, and it is posted on the first fire rather
 * than after STALE_HOLD_HOURS. The skip is in the caller because this
 * function takes a `{ number, reason, ageHours }` row and the discriminator
 * is the `action`, which that shape deliberately does not carry.
 */
export function stateHold(repo, { number, reason, ageHours, detail }, run = gh) {
  const age =
    ageHours === null || ageHours === undefined
      ? "an unknown time (no dated check on this head)"
      : `${ageHours.toFixed(1)}h`;
  return commentOnce(
    repo,
    number,
    statedHoldMarker(reason),
    `The landing routine is not enqueuing this PR: \`${reason}\`.\n\n` +
      `This head last reported ${age} ago, so the reason has stopped being a wait and is ` +
      `stated here rather than left in the routine's receipt. Clear it, or say on this PR why ` +
      `it stands.\n\n` +
      reviewGateRemedy(detail) +
      `Posted once per reason, not once per fire — the routine will not repeat this.`,
    run,
  );
}

const PR_LIST_FIELDS =
  // `baseRefName` is here for the merge-queue lookup: a queue belongs to a
  // branch, so the PRs have to be grouped by base before it can be read.
  //
  // `mergeStateStatus` is deliberately NOT here: PEN-5442 moved it to
  // `fetchMergeStates` below, because a 100-item `gh pr list` page carrying
  // it 502s on a repo with >=100 open PRs. The merge-queue branch does not
  // need it anyway — see the ⛔ note in `classifyFromListing`.
  "number,headRefOid,author,labels,isDraft,autoMergeRequest,reviewRequests,baseRefName";

/**
 * Open PRs per page when reading merge states.
 *
 * ⛔ This is the fix, and it is a PAGE size, not a limit. `gh pr list` pages at
 * 100 regardless of `--limit`, so on a repo with >=100 open PRs it issues a
 * 100-item page — and a 100-item page carrying `mergeStateStatus` is what
 * GitHub 502s on. Measured 2026-11-04 against Blockcast/penstock-llm-proxy-core
 * at 153 open PRs (PEN-5442):
 *
 *   all 8 fields, one call (what this replaced)        0/3 OK
 *   7 fields, no mergeStateStatus, `gh pr list`        5/5 OK
 *   number+mergeStateStatus, `gh pr list` (100-page)  10/13 OK
 *   all 8 fields, GraphQL, 50-item page                4/5 OK
 *   number+mergeStateStatus, GraphQL, 25-item page     6/6 OK
 *   number+mergeStateStatus, GraphQL, 10-item page     6/6 OK
 *
 * Note the third row: splitting the call is NOT sufficient on its own. The
 * merge-state half still rides a 100-item page through `gh pr list` and still
 * fails about a quarter of the time. Controlling the page size is the part
 * that works, and `gh pr list` has no flag for it — hence the raw query.
 *
 * 25 over 10 only to spend 7 round trips instead of 16; both measured clean.
 */
export const MERGE_STATE_PAGE_SIZE = 25;

/**
 * Open PRs with their merge state, by number.
 *
 * ⛔ Hand-rolled GraphQL, which this file warns against elsewhere — that
 * warning is about `statusCheckRollup`, whose `contexts(first: 100)` truncates
 * SILENTLY and drops required checks. It does not transfer here: this query
 * selects two scalars and reaches no nested connection, so there is no inner
 * page to truncate. The outer connection is paginated by `--paginate` against
 * `pageInfo`, and `fetchOpenPrs` cross-checks the result against the listing
 * anyway. Everything with a shape worth getting wrong — `author.is_bot`,
 * `labels`, `reviewRequests` — is deliberately left to `gh pr list`, which
 * owns that mapping. Widening this query to those fields would put the
 * fail-open direction (an unread `reviewRequests` reads as "no owner is
 * waiting") behind a hand-written type mapping. Do not.
 */
export function fetchMergeStates(repo, { run = gh, pageSize = MERGE_STATE_PAGE_SIZE } = {}) {
  const [owner, name] = String(repo).split("/");
  const query = `query($owner:String!,$name:String!,$first:Int!,$endCursor:String){
  repository(owner:$owner,name:$name){
    pullRequests(states:OPEN,first:$first,after:$endCursor){
      pageInfo{hasNextPage endCursor}
      nodes{ number mergeStateStatus }
    }
  }
}`;
  const out = run([
    "api",
    "graphql",
    "--paginate",
    "-F",
    `owner=${owner}`,
    "-F",
    `name=${name}`,
    "-F",
    `first=${pageSize}`,
    "--jq",
    ".data.repository.pullRequests.nodes[] | {number, mergeStateStatus}",
    "-f",
    `query=${query}`,
  ]);
  const states = new Map();
  for (const line of String(out).split("\n")) {
    if (!line.trim()) continue;
    const node = JSON.parse(line);
    // `readMergeState` here as well as in the classifier: this map is the
    // join's input, and normalising at the boundary means a malformed node
    // enters as UNKNOWN rather than as a string the classifier has to defend
    // against later.
    states.set(node?.number, readMergeState(node?.mergeStateStatus));
  }
  return states;
}
function execGh(args) {
  return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

/** Longest rate-limit reset one fire will wait out before aborting (BLO-51665). */
export const RATE_LIMIT_MAX_WAIT_MS = 120_000;

/**
 * Milliseconds until the rate-limit bucket `args` draws from resets, read from
 * a probe's own `X-Ratelimit-*` response headers; `0` when the bucket already
 * has headroom again, `null` when the headers could not be read.
 *
 * ⛔ Not `/rate_limit`: on this installation its body AND its headers report a
 * bucket ordinary calls do not draw from (BLO-37855), so it reads healthy
 * during exactly the throttle this exists to wait out. `gh api -i` prints the
 * headers on stdout even when the probe itself is refused, which is the case
 * that matters. `gh pr …` and `gh api graphql` draw from the GraphQL bucket,
 * every other `gh api` path from core, so the probe matches the failing call.
 */
export function rateLimitWaitMs(args, { exec = execGh, now = Date.now } = {}) {
  const graphql = args[0] !== "api" || args[1] === "graphql";
  const probe = graphql
    ? ["api", "-i", "graphql", "-f", "query={viewer{login}}"]
    : ["api", "-i", "meta"];
  let out;
  try {
    out = exec(probe);
  } catch (error) {
    out = `${error?.stdout ?? ""}\n${error?.stderr ?? ""}`;
  }
  const header = (name) => {
    const match = new RegExp(`^x-ratelimit-${name}:\\s*(\\d+)`, "im").exec(String(out));
    return match ? Number(match[1]) : null;
  };
  const remaining = header("remaining");
  if (remaining === null) return null;
  if (remaining > 0) return 0;
  const reset = header("reset");
  return reset === null ? null : Math.max(0, reset * 1000 - now()) + 5_000;
}

/**
 * Runs `gh`, waiting out ONE rate-limit refusal whose reset is near (BLO-51665).
 *
 * A 403 that clears in 22s used to abort the whole fire and cost six hours of
 * landings. The deliberate abort for a real exhaustion is kept: a reset beyond
 * RATE_LIMIT_MAX_WAIT_MS, unreadable headers, or a second refusal all rethrow
 * the original error into `isFatalGhError`. Retrying a refused write is safe —
 * a 403 applied nothing.
 */
export function ghWithRateLimitRetry(
  args,
  { exec = execGh, sleep = sleepSync, waitMs = rateLimitWaitMs } = {},
) {
  try {
    return exec(args);
  } catch (error) {
    if (!/rate limit/i.test(String(error?.stderr ?? error?.message ?? ""))) throw error;
    const wait = waitMs(args, { exec });
    if (wait === null || wait > RATE_LIMIT_MAX_WAIT_MS) throw error;
    sleep(wait);
    return exec(args);
  }
}

/**
 * How many times a transient read is attempted, and the backoff step between
 * attempts (PEN-5314).
 *
 * `withRetry` waits `delayMs * attempt`, so 3 attempts spend 2s then 4s — a
 * bounded, growing backoff with a 6s ceiling per call. Deliberately NOT the
 * rate-limit path's wait: that one reads a RESET TIMESTAMP off a probe
 * (`rateLimitWaitMs`), and a 5xx has no reset timestamp to read, so routing a
 * 502 through it yields either `sleep(0)` — an instant retry into an API that
 * is mid-5xx — or `null`, which rethrows. The two waits answer different
 * questions and cannot share an implementation.
 *
 * 3/2s matches the Ally guard's config, which is the one measured to work on
 * this failure class, rather than a second set of numbers to reason about.
 *
 * ⚠ It NESTS. `resolveMergeState` already spends up to MERGE_STATE_RETRIES
 * reads of its own and swallows a throw as "still unknown", so a sustained
 * 5xx costs it 3 x 6s per undecided PR rather than 6s. That is bounded and
 * acceptable: the storm that would make it expensive fails `fetchOpenPrs`
 * first and aborts the fire in ~6s, while the intermittent case this exists
 * for usually succeeds on attempt 2. The job's `timeout-minutes: 15` is the
 * backstop — and note a timeout kills the process, so it reports neither this
 * module's exit codes nor a verdict; that state is only readable at the
 * workflow level.
 */
export const TRANSIENT_RETRY_ATTEMPTS = 3;
export const TRANSIENT_RETRY_DELAY_MS = 2_000;

/** The `gh` failure text, from whichever field carries it. */
export function ghErrorMessage(error) {
  return error?.stderr?.toString() || error?.message || String(error);
}

/**
 * A `gh` failure that is GitHub being briefly unavailable rather than an
 * answer (PEN-5314).
 *
 * Narrow on purpose. `500` is excluded: GitHub returns it for a malformed or
 * too-expensive GraphQL query, which retrying cannot fix and which would spend
 * the whole backoff on every fire. `502/503/504` are the shapes measured on
 * this call — `fetchOpenPrs` 502'd on 3 of 3 attempts against a 153-PR repo
 * (PEN-5442) and the hourly Ally guard saw 502/504 on 10 of 40 runs
 * (BLO-48423).
 *
 * `isFatalGhError` is subtracted so the DELIBERATE abort can never be retried
 * away: an exhausted rate limit or bad credentials must still end the fire.
 * The two classes do not overlap today (`HTTP 40[13]` vs `HTTP 50[234]`); the
 * subtraction keeps that true if either predicate is ever widened.
 */
export function isTransientGhError(message) {
  const text = String(message ?? "");
  if (isFatalGhError(text)) return false;
  return (
    /HTTP 50[234]\b/i.test(text) ||
    /\b(?:Bad Gateway|Service Unavailable|Gateway Time-?out)\b/i.test(text)
  );
}

/** `gh api` flags that turn a default GET into a POST. */
const GH_API_BODY_FLAGS = new Set(["-f", "-F", "--field", "--raw-field", "--input"]);
/** `gh pr` subcommands that only read. */
const GH_PR_READ_SUBCOMMANDS = new Set(["list", "view", "diff", "checks", "status"]);

/**
 * Whether this invocation is a read that is safe to repeat (PEN-5314).
 *
 * ⛔ This gate is the reason the retry is not simply `withRetry(gh)`. The Ally
 * guard CAN wrap every call blindly because every call it makes is a read.
 * This file is not that: it runs `pr merge --auto` and `pr comment`, and a 5xx
 * can be returned AFTER the mutation was applied — so a blind retry risks
 * arming auto-merge twice or double-posting a comment. The existing rate-limit
 * retry is safe for writes for a reason that does NOT transfer here: a 403
 * applied nothing, a 502 may have applied everything.
 *
 * A POSITIVE allowlist, so anything it cannot identify is left unretried and
 * behaves exactly as it does today. That direction also keeps
 * `fetchCodeownerRules` cheap: it walks CODEOWNERS_PATHS EXPECTING 404s, and a
 * blind retry would pay 6s of backoff on every expected miss.
 */
export function isIdempotentGhRead(args) {
  const argv = (Array.isArray(args) ? args : []).map((arg) => String(arg));
  if (argv.length === 0) return false;
  if (argv[0] === "pr") return GH_PR_READ_SUBCOMMANDS.has(argv[1]);
  if (argv[0] !== "api") return false;

  // An explicit method is the whole answer, whatever else is on the line.
  const method = argv.findIndex((arg) => arg === "-X" || arg === "--method");
  if (method !== -1) return ["GET", "HEAD"].includes((argv[method + 1] ?? "").toUpperCase());

  // GraphQL is POSTed even to read, so the body flags below cannot classify
  // it; the query text can. A `mutation` keyword anywhere in the invocation
  // disqualifies it. Bounded to the endpoint slot so a REST path that merely
  // contains the word cannot reach this branch.
  if (argv.indexOf("graphql") === 1 || argv.indexOf("graphql") === 2) {
    return !argv.some((arg) => /\bmutation\b/i.test(arg));
  }

  // Plain `gh api <path>` is a GET until a body flag makes it a POST.
  return !argv.some((arg) => GH_API_BODY_FLAGS.has(arg));
}

/**
 * Runs `gh`, waiting out a near-reset rate limit (BLO-51665) and retrying a
 * transient 5xx on an idempotent read (PEN-5314).
 *
 * A write gets `attempts: 1`, so it takes the inner rate-limit behaviour and
 * nothing else — no added latency, no repeated mutation.
 */
export function ghWithTransientRetry(
  args,
  {
    exec = ghWithRateLimitRetry,
    retry = withRetry,
    attempts = TRANSIENT_RETRY_ATTEMPTS,
    delayMs = TRANSIENT_RETRY_DELAY_MS,
  } = {},
) {
  return retry(`gh ${args.slice(0, 2).join(" ")}`, () => exec(args), {
    attempts: isIdempotentGhRead(args) ? attempts : 1,
    delayMs,
    shouldRetry: (error) => isTransientGhError(ghErrorMessage(error)),
  });
}

function gh(args) {
  return ghWithTransientRetry(args);
}

/**
 * The repo's CODEOWNERS rules, or `null` when none could be read.
 *
 * `null` must stay distinguishable from `[]`: a repo with no CODEOWNERS owes
 * nobody, while a repo whose CODEOWNERS could not be fetched is unknown, and
 * `impliedOwners` falls back to over-holding on the second. Reading it from
 * the DEFAULT branch rather than the PR head is deliberate — a PR must not be
 * able to edit its own ownership rules into a weaker hold.
 */
export function fetchCodeownerRules(repo, run = gh) {
  for (const path of CODEOWNERS_PATHS) {
    let response;
    try {
      response = JSON.parse(run(["api", `repos/${repo}/contents/${path}`]));
    } catch (error) {
      // ONLY "this location has no CODEOWNERS" may try the next one. A 5xx, a
      // 403 or a transport failure on a HIGHER-precedence path must not fall
      // through and silently adopt a lower-precedence file's rules, so
      // anything not positively identified as a 404 is unreadable => `null`.
      if (isNotFoundGhError(error?.stderr?.toString() || error?.message || String(error))) {
        continue;
      }
      return null;
    }
    const { content, encoding } = response ?? {};
    // A directory at this path answers with an array and no `content`; that is
    // not a CODEOWNERS file, so the next location still applies.
    if (typeof content !== "string") continue;
    // Blobs over 1 MB are not inlined: the API answers `content: ""` with
    // `encoding: "none"`. That decodes to `""` and parses to `[]` -- the
    // "measured, nobody is owed" value -- which would drop every outstanding
    // request and release every held PR at once. It is unread, not empty.
    if (encoding !== "base64") return null;
    return parseCodeowners(Buffer.from(content, "base64").toString("utf8"));
  }
  return null;
}

/** How many queue entries one page asks for. GitHub caps `first` at 100. */
const MERGE_QUEUE_PAGE = 100;

/** A bound on the paging loop, so a broken cursor cannot spin forever. */
const MERGE_QUEUE_MAX_PAGES = 10;

/**
 * The merge queue for one base branch as `Map<prNumber, entry>`, or `null`
 * when it could not be read.
 *
 * `null` must stay distinguishable from an empty Map, and the two fail in
 * opposite directions. An empty Map is the measured "nothing is queued on this
 * branch", and it is the common case — `mergeQueue(branch:)` answers `null`
 * for a branch with no queue configured at all, which is also an empty queue
 * for our purposes. `null` here means UNREAD, and the caller degrades to the
 * pre-PEN-5279 behaviour: the PR classifies `enqueue`, `applyRow` re-issues an
 * enqueue that GitHub no-ops at exit 0, and a cap slot is spent. That is
 * wasteful and it is exactly what this function exists to stop — but it is the
 * direction that cannot stall a PR.
 *
 * ⛔ The opposite direction is the one to protect. Claiming a PR IS queued when
 * it is not classifies it `already-enqueued`, which is in `NON_HOLD_ACTIONS`
 * and is excluded from `unlandedEligible` — so the PR would never be enqueued
 * and no detector in this script would age it. A read that is uncertain must
 * return `null`, never a Map that is missing entries.
 *
 * That is why an exhausted page budget returns `null` rather than the pages it
 * did collect: a truncated queue is a Map whose absent entries are
 * indistinguishable from "not queued", which is precisely the fail-closed
 * claim above.
 */
export function fetchMergeQueueEntries(repo, branch, run = gh) {
  const [owner, name] = String(repo ?? "").split("/");
  if (!owner || !name || !branch) return null;

  const entries = new Map();
  let cursor = null;
  for (let page = 0; page < MERGE_QUEUE_MAX_PAGES; page += 1) {
    let response;
    try {
      response = JSON.parse(
        run([
          "api",
          "graphql",
          "-f",
          `query=query($owner:String!,$name:String!,$branch:String!,$cursor:String){
            repository(owner:$owner,name:$name){
              mergeQueue(branch:$branch){
                entries(first:${MERGE_QUEUE_PAGE},after:$cursor){
                  pageInfo{ hasNextPage endCursor }
                  nodes{ position state enqueuedAt pullRequest{ number } }
                }
              }
            }
          }`,
          "-f",
          `owner=${owner}`,
          "-f",
          `name=${name}`,
          "-f",
          `branch=${branch}`,
          ...(cursor ? ["-f", `cursor=${cursor}`] : []),
        ]),
      );
    } catch {
      return null;
    }

    // A GraphQL 200 can still carry errors with a null payload; that is an
    // unread queue, not an empty one.
    if (Array.isArray(response?.errors) && response.errors.length > 0) return null;

    const queue = response?.data?.repository?.mergeQueue;
    // No queue configured on this branch. Measured, not unread: every PR on
    // this base is genuinely not sitting in a queue.
    if (queue == null) return entries;

    const connection = queue?.entries;
    if (connection == null) return null;

    for (const node of connection?.nodes ?? []) {
      const number = node?.pullRequest?.number;
      if (!Number.isFinite(number)) continue;
      entries.set(number, {
        position: node?.position,
        state: node?.state,
        enqueuedAt: node?.enqueuedAt,
      });
    }

    if (connection?.pageInfo?.hasNextPage !== true) return entries;
    cursor = connection?.pageInfo?.endCursor;
    // `hasNextPage` with no cursor to follow is a truncated read.
    if (!cursor) return null;
  }
  // Page budget exhausted with more pages outstanding: see the docblock.
  return null;
}

/** Changed paths for one PR, or `null` if the listing failed or GitHub truncated it. */
export function fetchPrFiles(repo, number, run = gh) {
  try {
    const files = JSON.parse(
      run(["api", `repos/${repo}/pulls/${number}/files`, "--paginate"]),
    ).map((file) => file?.filename);
    return files.length >= MAX_PR_FILES ? null : files;
  } catch {
    return null;
  }
}

/**
 * Lists open PRs, then hydrates checks and reviews only for the ones the cheap
 * rules could not decide. `statusCheckRollup` is deliberately absent from the
 * list query — including it makes GitHub time out across this repo's open PR
 * count — so it is fetched per PR alongside the REST reviews.
 *
 * Reviews come from REST rather than `gh pr view --json reviews` because the
 * identity rules pin immutable REST account IDs, which the GraphQL shape does
 * not carry. A login string alone is not review evidence (I5).
 */
export function fetchOpenPrs(repo, { run = gh, mergeStates = fetchMergeStates } = {}) {
  const rows = JSON.parse(
    run(["pr", "list", "--repo", repo, "--state", "open", "--limit", "500", "--json", PR_LIST_FIELDS]),
  );
  assertPrListComplete(rows, repo, 500);
  // The second half of the split (PEN-5442, see MERGE_STATE_PAGE_SIZE). Read
  // BEFORE the listing is joined so a failure here fails the whole read rather
  // than yielding a listing with every merge state missing — which, absent
  // `readMergeState`, is the shape that would enqueue.
  const states = mergeStates(repo, { run });
  // One fetch per repo, not per PR: the rules are a property of the base branch.
  const codeownerRules = fetchCodeownerRules(repo, run);

  // One merge-queue read per DISTINCT BASE, not per PR: a queue belongs to a
  // branch, so every PR targeting that branch is answered by the same read.
  // On this fleet that is one extra GraphQL call per repo in the normal case.
  //
  // This is hydrated BEFORE `classifyFromListing` is consulted, unlike
  // `codeownerRules` and the per-PR fetches below, because queue membership is
  // one of the cheap rules — it DECIDES whether a PR needs the expensive
  // hydration at all, rather than refining a verdict afterwards. A queued PR
  // short-circuits to `already-enqueued` and pays nothing further.
  const queueByBase = new Map();
  const mergeQueueEntryFor = (row) => {
    const base = row?.baseRefName;
    if (!base) return null;
    if (!queueByBase.has(base)) queueByBase.set(base, fetchMergeQueueEntries(repo, base, run));
    // `null` is an unread queue, and must not read as "this PR is not queued"
    // in a way that could ever be mistaken for a measurement — but the verdict
    // it produces is the same `null` entry the pre-PEN-5279 code implied, so
    // the degradation is to the old behaviour and nothing worse.
    return queueByBase.get(base)?.get(row?.number) ?? null;
  };

  return rows.map((listed) => {
    assertHeadSha(listed, repo);
    // ⛔ The join, and the `??` is load-bearing in the fail-CLOSED direction.
    //
    // The two calls are not atomic: a PR open for the listing can merge, or be
    // closed, before the merge-state read — so a number present in `rows` with
    // no entry in `states` is the EXPECTED race, not a bug. It must resolve to
    // a hold. `"UNKNOWN"` is the literal that does that (it is in
    // `UNLANDABLE_MERGE_STATES`), and `readMergeState` is what makes any other
    // spelling of "nothing here" — `undefined`, `null`, `""` — resolve the
    // same way instead of falling through to `enqueue`.
    //
    // Do NOT "improve" this to a default that looks landable, and do not drop
    // the row: dropping it would hide a PR from the receipt and from the
    // unlanded-eligible detector, which is how a strand becomes invisible.
    // The cost of the hold is one cycle; the next fire reads it again.
    //
    // `mergeQueueEntry` rides the same join. It is independent of
    // `mergeStateStatus` and must stay so — a queued PR has been observed at
    // CLEAN and at UNKNOWN, so neither value identifies one.
    const joined = {
      ...listed,
      mergeStateStatus: states.get(listed?.number) ?? "UNKNOWN",
      mergeQueueEntry: mergeQueueEntryFor(listed),
    };
    if (classifyFromListing(joined)) return joined;
    return {
      ...joined,
      // Only PRs that survived `classifyFromListing` can still enqueue, so an
      // unresolved UNKNOWN can only change a verdict here — the same rule that
      // scopes `files`, `reviews` and `timeline` below.
      // An UNKNOWN from the join is resolved by exactly the same per-PR
      // re-read that has always resolved an UNKNOWN from GitHub, so a row
      // that lost its state to the race above is repaired here rather than
      // waiting a whole cycle — and when the re-read fails it stays UNKNOWN
      // and stays held. Spent only on rows that survived `classifyFromListing`,
      // i.e. the ones that could still enqueue.
      mergeStateStatus: resolveMergeState(repo, joined.number, joined.mergeStateStatus, { run }),
      codeownerRules,
      // Only PRs that actually carry a request can be scoped by ownership, so
      // the extra call is spent only where it can change a verdict.
      files: (joined.reviewRequests ?? []).length > 0 ? fetchPrFiles(repo, joined.number, run) : [],
      // No `--paginate` here, and none is needed: `gh pr view` does not accept
      // the flag because it paginates the rollup's `contexts` connection
      // itself. Measured 2026-11-02 on gh 2.102.0 against
      // Blockcast/penstock-llm-proxy-core#3034 — `contexts.totalCount` 142,
      // 142 entries returned, `review/ally-complete` among them; 0 of 30 PRs
      // sampled on that repo came back short, six of them over the 100-context
      // cap (101-142). The `--paginate` two lines below is load-bearing; its
      // absence here is not the same omission.
      //
      // ⛔ Do not "fix" this into a hand-rolled GraphQL query.
      // `contexts(first: 100)` is where the cap actually bites, and it bites
      // silently: a head with more than 100 contexts returns exactly 100 with
      // nothing marking the read as a prefix. On this fleet
      // `review/ally-complete` has been observed falling off that end, and it
      // is REQUIRED. Losing a required context reads as absent and holds a
      // ready PR; the same truncated read drops a FAILING context just as
      // silently, and in a routine whose action is `enqueue` that direction
      // merges.
      statusCheckRollup: JSON.parse(
        run(["pr", "view", String(joined.number), "--repo", repo, "--json", "statusCheckRollup"]),
      ).statusCheckRollup,
      reviews: JSON.parse(run(["api", `repos/${repo}/pulls/${joined.number}/reviews`, "--paginate"])),
      // The merge-queue ejection history, for the `ejected-at-current-head`
      // rule. Spent only on PRs that already survived `classifyFromListing`,
      // i.e. the ones that could still enqueue — on this repo a handful of the
      // open set, each already paying three calls.
      //
      // ⛔ `--paginate` is load-bearing. GitHub's default page size is 30 and
      // the events this reads are the NEWEST on the timeline, so a single-page
      // fetch drops exactly them on any PR with a normal amount of discussion
      // and reports `count: 0` — a confident all-clear, in the fail-open
      // direction.
      timeline: JSON.parse(
        run(["api", `repos/${repo}/issues/${joined.number}/timeline`, "--paginate"]),
      ),
    };
  });
}

/**
 * Blocks the calling thread for `ms`. This script is synchronous end to end
 * (`execFileSync` throughout), so the retry delay has to be too.
 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * The PR's `mergeStateStatus`, re-read while GitHub reports UNKNOWN.
 *
 * Returns the first computed value, or UNKNOWN if every attempt is spent —
 * in which case the `UNLANDABLE_MERGE_STATES` hold stands exactly as before.
 * ⛔ That fail-closed end is the contract, not a fallback: this function
 * resolves an *unread* state, it does not retry until the answer looks good.
 * A PR that resolves UNKNOWN -> DIRTY is held on DIRTY, and a test pins it.
 *
 * A read that throws is treated as "still unknown" rather than fatal. The
 * caller already holds a usable classification; losing the whole fire over an
 * optional refinement would be a worse failure than the one this fixes.
 */
export function resolveMergeState(repo, number, current, options = {}) {
  const {
    run = gh,
    sleep = sleepSync,
    retries = MERGE_STATE_RETRIES,
    delayMs = MERGE_STATE_RETRY_DELAY_MS,
  } = options;
  // Spend nothing on a PR whose state GitHub already computed. This is the
  // overwhelmingly common case and it must stay free.
  if (readMergeState(current) !== "UNKNOWN") return current;

  for (let attempt = 0; attempt < retries; attempt += 1) {
    // Sleep FIRST. The read that reported UNKNOWN is what scheduled the
    // recomputation, so an immediate re-read asks before there is an answer
    // and burns an attempt.
    sleep(delayMs);
    let next;
    try {
      next = JSON.parse(
        run(["pr", "view", String(number), "--repo", repo, "--json", "mergeStateStatus"]),
      )?.mergeStateStatus;
    } catch {
      continue;
    }
    if (readMergeState(next) !== "UNKNOWN") return next;
  }
  return current;
}

/** Posts `body` unless a comment carrying `marker` is already on the PR. */
function commentOnce(repo, number, marker, body, run = gh) {
  const existing = JSON.parse(
    run(["api", `repos/${repo}/issues/${number}/comments`, "--paginate"]),
  );
  if (existing.some((comment) => String(comment?.body ?? "").includes(marker))) return "already-posted";
  run(["pr", "comment", String(number), "--repo", repo, "--body", `${marker}\n${body}`]);
  return "posted";
}

/**
 * The head SHA this PR carries RIGHT NOW, read at apply time.
 *
 * PEN-4887: `fetchOpenPrs` snapshots every open PR once per fire, and a head
 * can move between that snapshot and the enqueue. The case that made this
 * expensive is not a rare race — it is the deterministic consequence of
 * landing a STACKED child PR: merging the child into the parent's branch
 * replaces the parent's head with the merge commit, on which nothing has run
 * yet. Measured on Blockcast/paperclip#3060 (2026-10-28): head moved at
 * 07:46:13Z, enqueued at 07:46:17Z, ejected by the queue at 07:46:27Z, while
 * `ci/ally-head-attested` did not succeed until 07:48:37Z — 2m10s after the
 * removal, with `policy` gating the heavy matrix behind it for ~6 minutes more.
 *
 * Every gate in `classifyPr` — the settle floor, `checks:none`, the Ally
 * verdict at head, the owner set — was evaluated against the OLD head and says
 * nothing about the new one. Re-reading the SHA is what makes those verdicts
 * mean what the receipt claims they mean.
 *
 * `--auto` is not a substitute. On a queue-enabled base GitHub enqueues
 * immediately whenever it believes the requirements are met, and right after a
 * head moves that belief is briefly stale: #3060 carries an
 * `added_to_merge_queue` event with no `auto_merge_enabled` beside it.
 */
export function liveHeadSha(repo, number, run = gh) {
  const raw = JSON.parse(
    run(["pr", "view", String(number), "--repo", repo, "--json", "headRefOid"]),
  )?.headRefOid;
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

/**
 * This PR's merge-queue entry right now, or `null` if it is not queued or the
 * read failed.
 *
 * A second, single-PR read of what `fetchMergeQueueEntries` already answered in
 * bulk, taken immediately before the enqueue for the same check-then-act reason
 * as `liveHeadSha`: the bulk read happens once at the top of the fire, and
 * something else — a human, or a classic auto-merge request firing — can enqueue
 * the PR in between. Without this, that race re-issues an enqueue GitHub no-ops
 * at exit 0, and the row still reads `enqueue` and still spends a cap slot
 * (PEN-5279, done-when 4).
 *
 * ⛔ `null` on failure is deliberate and it is the SAFE direction here, which is
 * the opposite of `fetchMergeQueueEntries`'s contract — read that one's docblock
 * before assuming they should match. There, `null` means "unread" and suppresses
 * a verdict. Here, `null` means "go ahead and enqueue", so an unreadable queue
 * degrades to the pre-PEN-5279 behaviour: one wasted no-op and one wasted cap
 * slot, on one fire. Failing the other way would hold a PR that nothing has
 * enqueued.
 */
export function liveMergeQueueEntry(repo, number, run = gh) {
  const [owner, name] = String(repo ?? "").split("/");
  if (!owner || !name) return null;
  try {
    const response = JSON.parse(
      run([
        "api",
        "graphql",
        "-f",
        `query=query($owner:String!,$name:String!,$number:Int!){
          repository(owner:$owner,name:$name){
            pullRequest(number:$number){ mergeQueueEntry{ position state enqueuedAt } }
          }
        }`,
        "-f",
        `owner=${owner}`,
        "-f",
        `name=${name}`,
        "-F",
        `number=${number}`,
      ]),
    );
    if (Array.isArray(response?.errors) && response.errors.length > 0) return null;
    return response?.data?.repository?.pullRequest?.mergeQueueEntry ?? null;
  } catch {
    return null;
  }
}

const short = (sha) => (typeof sha === "string" ? sha.slice(0, 7) : String(sha));

/**
 * `--rebase` is mandatory, not cosmetic. `gh pr merge --auto` only infers a
 * merge method when the PR's BASE BRANCH has a merge queue — `isMergeQueueEnabled`
 * is a property of the base ref, not of this PR's mergeability. A PR stacked on
 * a feature branch therefore falls back to classic auto-merge, and with all
 * three merge methods enabled on this repo `gh` refuses non-interactively with
 * "--merge, --rebase, or --squash required". That refusal landed in `detail`
 * while the row still reported `enqueue`, so #2020 read as enqueued across 9
 * consecutive fires having armed nothing (BLO-36804).
 *
 * Safe on the queue path: measured 2026-09-26 against a queue-enabled base, `gh`
 * prints "The merge strategy for master is set by the merge queue", exits 0, and
 * the queue's own REBASE wins — the flag is discarded, not honoured. So this
 * cannot change what already-working rows do. `--rebase` names that same method
 * and keeps stacked branches free of merge commits, which is what keeps them
 * rebaseable for the queue later (BLO-22300).
 *
 * NECESSARY BUT NOT SUFFICIENT, and deliberately so. Past `gh`'s client-side
 * check, GitHub still refuses auto-merge on a base with no protection rules:
 * "Protected branch rules not configured for this branch
 * (enablePullRequestAutoMerge)", measured the same day on #1906. Such a PR is
 * unenqueueable however clean it is. The classifier does NOT try to predict
 * that — whether a base is protected, queue-enabled, or neither is per-repo
 * server state, and this script is about to sweep repos whose default branch is
 * not even `master` (multicast is `main`). Modelling it here would mean a wrong
 * model silently skipping a whole repo, which is worse than the bug being fixed.
 * GitHub is the authority; we attempt, it rules, and `markFailure` puts the
 * verdict in the receipt's action column where it is visible.
 *
 * ## `--auto` does not always mean auto
 *
 * `gh` drops the auto-merge request and performs an IMMEDIATE merge when the PR
 * is already mergeable and the base has no queue to wait for — `--auto` is a
 * request to wait for gates, and a PR with no outstanding gates has nothing to
 * wait for. Measured 2026-09-26: this exact call landed #2020 on the spot,
 * `parents=1`, no `auto_merge_enabled` event. Supplying the method therefore
 * converts a permanently-failing no-op into a real merge for clean PRs on
 * unprotected bases.
 *
 * That is accepted on purpose: on such a base there is no queue to land through,
 * so merging IS landing, and this classifier is the gate — Ally clean at head,
 * every check green, owner approvals satisfied, mergestate CLEAN, capped at
 * MAX_ENQUEUES_PER_FIRE per fire. A queue-enabled base is unaffected, because
 * the queue path is chosen before the mergeability test. But the outcome string
 * must not claim "armed" for a merge that already happened — this whole defect
 * was a receipt reporting an action it had not taken.
 *
 * ⚠ "A queue-enabled base is unaffected" scopes THIS paragraph's subject — the
 * `--auto` immediate-merge behaviour on an unprotected base — and nothing
 * else. It is NOT a statement that queued PRs are handled correctly in
 * general, and it was misread that way once (PEN-5279): detecting that a PR is
 * ALREADY in the queue is a separate rule living in `classifyFromListing`, off
 * `mergeQueueEntry`. Before that rule existed, a queued PR arrived here every
 * fire and this function re-issued its enqueue, which GitHub no-ops at exit 0.
 *
 * ponytail: that costs one doomed call per stacked PR per fire on an
 * unprotected base. Acceptable because it self-heals the moment the base is
 * protected or the PR is retargeted, and it needs no per-repo config. If the
 * noise ever matters, skip rows whose base is unprotected — one
 * `gh api repos/{repo}/branches/{base}` per distinct base, not per PR.
 */
export function applyRow(repo, row, run = gh) {
  if (row.action === "enqueue") {
    // PEN-4887: fail CLOSED on anything but a proven-unchanged head. An
    // unreadable or absent SHA is not permission to enqueue — it means we
    // cannot show the classification still applies, and the row simply
    // re-classifies on the next fire. The throw is caught by `runRepo` and
    // recorded as `enqueue-failed`, which is both visible in the receipt and
    // correctly excluded from the per-fire cap: no queue slot was spent.
    const live = liveHeadSha(repo, row.number, run);
    if (!row.headSha || !live || live !== row.headSha) {
      throw new Error(
        `head moved since classification (${short(row.headSha)} -> ${short(live)}); not enqueued — ` +
          "every check and review verdict in this row describes the previous head",
      );
    }
    // Ally review, 2nd pass: the re-read above narrows the window but is still
    // check-then-act — the head can move between `pr view` and `pr merge`.
    // `--match-head-commit` closes it on GitHub's side: the request carries the
    // SHA every gate in this row was evaluated against, and GitHub refuses the
    // merge outright if the head no longer matches. The re-read is kept in
    // front of it rather than replaced, because it is what produces the
    // attributable `enqueue-failed` message naming both SHAs; this flag's
    // refusal surfaces as a generic `gh` failure, which is the right backstop
    // but the poorer receipt.
    //
    // Verified against the live API on #3063 (2026-10-28) with a deliberately
    // non-matching SHA: GitHub answered `expected head oid does not match the
    // current head oid (enablePullRequestAutoMerge)` and auto-merge was NOT
    // armed. So the flag composes with `--auto` and is enforced server-side on
    // the auto-merge path, not just on an immediate merge.
    // Last check before acting: the bulk queue read happened at the top of the
    // fire and something else may have enqueued this PR since. GitHub answers a
    // re-enqueue with `! Pull request #N is already queued to merge` at EXIT 0,
    // so `run` does not throw, the row stays `enqueue`, and `sweepRepos` spends
    // a MAX_ENQUEUES_PER_FIRE slot on a PR that needed nothing (PEN-5279).
    //
    // ⚠ What the rename does and does not recover. THIS repo's slot is already
    // spent: `classifyAll` decrements the budget at CLASSIFICATION time, before
    // `applyRow` runs, so a row that raced into the queue after the bulk read
    // has already consumed one of this repo's MAX_ENQUEUES_PER_FIRE. The rename
    // corrects the CROSS-repo carry in `sweepRepos` (which re-counts `enqueue`
    // rows after apply to seed the next repo) and keeps the row out of
    // `unlandedEligible`. The in-repo slot is not refunded, and that is
    // accepted: the race is narrow, the bulk read handles the systematic case,
    // and re-running the cap mid-fire would be a larger change than the defect
    // justifies.
    //
    // Detecting the no-op from gh's message instead would be guesswork about
    // which stream it writes to; this asks GitHub directly.
    const queued = liveMergeQueueEntry(repo, row.number, run);
    if (queued) {
      row.action = "already-enqueued";
      const position = queued?.position;
      row.detail = [
        row.detail,
        Number.isFinite(position)
          ? `already at queue position ${position}; not re-enqueued`
          : "already in the merge queue; not re-enqueued",
      ]
        .filter(Boolean)
        .join(" — ");
      return null;
    }

    run([
      "pr", "merge", String(row.number), "--repo", repo,
      "--auto", "--rebase", "--match-head-commit", row.headSha,
    ]);
    // Deliberately not "armed": this call queues, arms, or merges outright
    // depending on the base, and the receipt must not name the one it guessed.
    return "merge requested";
  }
  if (row.action === "stale-enqueue") {
    run(["pr", "merge", String(row.number), "--repo", repo, "--disable-auto"]);
    return commentOnce(
      repo,
      row.number,
      STALE_ENQUEUE_MARKER,
      `Auto-merge had been armed for over ${STALE_ENQUEUE_HOURS}h without landing, so the landing ` +
        `routine disarmed it. It will re-arm on the next fire once this PR classifies clean.`,
      run,
    );
  }
  if (row.action === "stale-queued") {
    // Comment only. The auto-merge sibling above disarms the request it is
    // complaining about, but there is no equivalent here: `gh` exposes no
    // dequeue flag (2.102.0), and ejecting a PR from the queue by hand is a
    // destructive act on shared state that this routine has no standing to
    // take unasked. State the finding and leave the queue alone.
    return commentOnce(
      repo,
      row.number,
      STALE_QUEUED_MARKER,
      `This PR has been at the FRONT of the merge queue for over ${STALE_ENQUEUE_HOURS}h without ` +
        `landing (${row.detail}). Head-of-queue is the position GitHub is actively trying to ` +
        `land from, so this is reported as wedged rather than waiting — likely a required check ` +
        `on the queue branch that never reported.\n\n` +
        `⚠ Deliberately NOT recommending a dequeue-and-re-enqueue: that forfeits this PR's place ` +
        `at the front of the queue, and if the cause is a check that will eventually report, it ` +
        `costs the whole wait again. Diagnose the queue branch first.\n\n` +
        `The landing routine does not remove PRs from the queue and has taken no action here. ` +
        `Posted once, not once per fire — the routine will not repeat this.`,
      run,
    );
  }
  if (row.action === "codeowner-review-requested") {
    return codeownerRequestComment(repo, row, run, LAND_REPO_HOLD_REASON);
  }
  return null;
}

/**
 * Why a LAND repo's clean PR is being held rather than enqueued: the routine
 * would land it, and is declining because CODEOWNERS is advisory here and
 * enqueuing would merge past an owner who was asked to look.
 */
const LAND_REPO_HOLD_REASON =
  "GitHub does not enforce CODEOWNERS on this repository, so the landing routine holds it here " +
  "rather than enqueuing it.";

/**
 * Why a NOTIFY-ONLY repo's clean PR is being held: because this routine does
 * not land anything here at all.
 *
 * The reason MUST be passed in rather than shared, and the land-repo sentence
 * is actively false in the repo this notify list was built for. Measured on
 * `Blockcast/penstock-llm-proxy-core`#2959 (2026-11-03): `mergeStateStatus:
 * BLOCKED`, `reviewDecision: REVIEW_REQUIRED`, `.github/CODEOWNERS` reading
 * `* @Blockcast/onprem-k8s-ally-reviewer @kkroo`. GitHub enforces the owner
 * review there. Posting "GitHub does not enforce CODEOWNERS on this
 * repository" would tell the one human the notification exists to reach that
 * their review is unenforced — and `commentOnce` dedupes on the marker, so
 * that sentence would be permanent per PR and unreplaceable without changing
 * the marker. (Ally review, PR #3365.)
 */
const NOTIFY_ONLY_HOLD_REASON =
  "This routine does not land pull requests in this repository — it only reports holds — so " +
  "nothing here will merge it. It is waiting on the requested review.";

/**
 * The code-owner notification, lifted out of `applyRow` so that
 * `applyRowNotifyOnly` can post it WITHOUT sharing a function body with
 * `gh pr merge`. That separation is the whole structural claim of PEN-5430:
 * the notify-only path is not a flag checked inside the lander, it is a
 * different applier with no reachable merge call to get wrong.
 *
 * `holdReason` is a required argument rather than a default, so adding a third
 * applier cannot inherit a sentence that is untrue in its repo by forgetting
 * to override one.
 */
function codeownerRequestComment(repo, row, run, holdReason) {
  return commentOnce(
    repo,
    row.number,
    CODEOWNER_REQUEST_MARKER,
    `This PR is clean at its current head but still has an outstanding code-owner review ` +
      `request (${row.detail}). ${holdReason}`,
    run,
  );
}

/**
 * The applier for a NOTIFY-ONLY repo: it posts the code-owner notification and
 * can do nothing else.
 *
 * PEN-5430. `targetRepos()` used to answer two unrelated questions with one
 * list — "where do we notify a human-gated hold" and "where do we arm
 * `gh pr merge --auto`" — so adding a repo in order to get the first silently
 * bought the second. `Blockcast/penstock-llm-proxy-core` wants the
 * notification and must never get the arming: it is PR-gated and human-owned,
 * and agent PRs there land only on a human's click.
 *
 * Note what this function does NOT contain: any call to `run(["pr", "merge",
 * ...])`. A notify-only repo is incapable of enqueuing because the code that
 * enqueues is not on its path, not because a classifier declined to ask for
 * it. `runRepo` additionally demotes the merge-shaped actions before this is
 * ever called (`demoteMergeActions`), so the guarantee is doubled: nothing
 * reaches here reading `enqueue`, and nothing here could act on it if it did.
 */
export function applyRowNotifyOnly(repo, row, run = gh) {
  if (row?.action === "codeowner-review-requested") {
    return codeownerRequestComment(repo, row, run, NOTIFY_ONLY_HOLD_REASON);
  }
  return null;
}

/**
 * Which applier a repo gets. A named function rather than a ternary buried in
 * `runRepo`'s parameter defaults, so the choice is assertable on its own.
 *
 * That is not a style preference. The two guards protecting a notify-only repo
 * — this selection and `demoteMergeActions` — are REDUNDANT by construction:
 * the demotion renames every merge-shaped row before any applier sees it, so
 * after it has run both appliers behave identically on every action that
 * exists. No stub can therefore tell them apart through `runRepo`, and an edit
 * reverting this selection to `applyRow` passed the entire suite when the
 * choice lived in a default expression. Hoisting it here makes the edit
 * visible to a test.
 *
 * The redundancy is deliberate and both halves are kept: the demotion is
 * required for reasons that have nothing to do with safety (the enqueue cap,
 * the `--alarm` cohort, the receipt tally — see its own comment), and this
 * selection is what makes "a notify-only repo cannot merge" true even if the
 * demotion is one day bypassed or a new merge-shaped action is added without
 * being added to MERGE_MUTATING_ACTIONS.
 */
export function applierFor(landable) {
  return landable ? applyRow : applyRowNotifyOnly;
}

/** The action a merge-shaped row becomes in a notify-only repo. */
export const NOTIFY_ONLY_ACTION = "notify-only";

/**
 * The actions `applyRow` serves by MUTATING MERGE STATE — `enqueue` arms
 * auto-merge, `stale-enqueue` disarms it. Both are refused in a notify-only
 * repo: we are a guest there, and disarming a human's auto-merge is as much
 * not-ours-to-do as arming one.
 */
const MERGE_MUTATING_ACTIONS = new Set(["enqueue", "stale-enqueue"]);

/**
 * Rewrites the merge-shaped rows of a notify-only repo to `notify-only`, in
 * place, before anything reads them.
 *
 * This is not cosmetic, and it is not the structural guard either (that is
 * `applyRowNotifyOnly`). It exists because three separate readers key on the
 * literal action `enqueue` and all three would be WRONG about a notify-only
 * repo if the row kept that name:
 *
 *   - `sweepRepos` tallies `enqueue` rows as spend against
 *     MAX_ENQUEUES_PER_FIRE. A notify-only repo arms nothing, so counting its
 *     clean PRs would let it starve the repos that actually land — a repo
 *     added for NOTIFICATIONS silently throttling the lander is the same
 *     class of coupling this whole row exists to remove.
 *   - `unlandedEligible` reports a long-lived `enqueue` row as stranded and
 *     `--alarm` exits non-zero on it. A clean PR in a notify-only repo is not
 *     stranded; it is held by policy, and alarming on it would turn the
 *     detector permanently red for working as designed.
 *   - `renderReceipt` tallies by action, so the fire would print `enqueue: N`
 *     for a repo in which it enqueued nothing — the #2020 shape, a receipt
 *     naming an action nobody took.
 *
 * `notify-only` joins NON_HOLD_ACTIONS for a fourth reason: `stalledHolds`
 * would otherwise age every clean PR in the repo into the stale-hold cohort
 * forever, since the "hold" never clears by design.
 */
export function demoteMergeActions(rows) {
  for (const row of rows ?? []) {
    if (!MERGE_MUTATING_ACTIONS.has(row?.action)) continue;
    const suppressed = row.action;
    row.action = NOTIFY_ONLY_ACTION;
    row.detail = [
      row.detail,
      `notify-only repo: would have \`${suppressed}\`, but this fire does not touch merge state here`,
    ]
      .filter(Boolean)
      .join(" — ");
  }
  return rows;
}

/**
 * Repos this fire covers. Comma-separated, because the rot this detects is not
 * repo-local: the DIRTY-after-approval cohort has been cleaned up by hand four
 * times (BLO-29984 multicast, BLO-31321 trafficcontrol, BLO-32205 onprem-k8s,
 * BLO-33208) and regrown in the same repos every time. A single-repo sweep is
 * how the other two stay unobserved between cleanups.
 *
 * ## That paragraph is the intent, and no caller delivers it today
 *
 * It has been read as a description of what runs. It is not. Every fire
 * covers exactly one repo, for two unrelated reasons:
 *
 * - `--alarm` (`.github/workflows/landing-sweep.yml`, step "Alarm on PRs that
 *   have been landable for hours and are still open") pins
 *   `LAND_CLEAN_PRS_REPO` to the workflow's own repository, which can never be
 *   a comma-separated list. Un-pinning it alone would not widen the sweep
 *   either; that step's env block records why.
 * - `--apply` (the landing routine, which runs outside Actions) covers
 *   `Blockcast/paperclip` only. Established by its own output rather than by
 *   its configuration, which is not readable from this repository: sampled
 *   `Blockcast/paperclip` PRs held on a code-owner review each carry exactly
 *   one `CODEOWNER_REQUEST_MARKER` comment, while the
 *   `Blockcast/penstock-llm-proxy-core` PRs under the identical hold carry
 *   none. PEN-5423 holds the dated per-PR counts.
 *
 * So the comma-separation is reachable, but only by whoever configures the
 * `--apply` routine — not by anything in this repository.
 *
 * This list is the LAND list, and since PEN-5430 that is all it is. A repo
 * named here has `gh pr merge --auto` armed on its clean PRs. To get a repo's
 * code-owner holds NOTIFIED without that, name it in `notifyRepos()` below —
 * the two questions used to share this one list, which made widening it for a
 * notification a policy change wearing a config edit's clothes.
 */
export function targetRepos(value = process.env.LAND_CLEAN_PRS_REPO) {
  return parseRepoList(value, ["Blockcast/paperclip"]);
}

/**
 * Repos this fire NOTIFIES but must never land in. Comma-separated, defaulting
 * to EMPTY — the notify list is opt-in, and an unset variable must leave the
 * routine behaving exactly as it did before PEN-5430.
 *
 * ## Why this is a second list and not another entry in the first one
 *
 * `targetRepos()` answers two unrelated questions at once: where do we post
 * `CODEOWNER_REQUEST_MARKER` when a PR's only remaining gate is a human, and
 * where do we arm `gh pr merge --auto` on a clean one. Adding a repo for the
 * first silently buys the second, which is a policy change wearing a config
 * edit's clothes.
 *
 * `Blockcast/penstock-llm-proxy-core` is the case that forced the split. It is
 * PR-gated and human-owned: agent PRs there land on a human's click and on
 * nothing else. It wants the notification badly — PEN-1942 ("DO NOT CLOSE:
 * prod has NO backup") sat green on an unnotified single human reviewer from
 * 2026-10-29 — and must not acquire an autolander as the price of getting it.
 *
 * ## A repo in BOTH lists is notify-only
 *
 * The restrictive reading wins, deliberately. A repo is in the notify list
 * precisely to say "do not land here", so honouring that over an overlapping
 * grant fails in the safe direction: the worst case is that nothing lands
 * somewhere it could have, which the receipt shows plainly as `notify-only`
 * rows. The opposite precedence makes a typo arm an autolander, which is the
 * failure this row exists to make unreachable.
 */
export function notifyRepos(value = process.env.LAND_CLEAN_PRS_NOTIFY_REPO) {
  return parseRepoList(value, []);
}

function parseRepoList(value, fallback) {
  const repos = String(value ?? "")
    .split(",")
    .map((repo) => repo.trim())
    .filter(Boolean);
  return repos.length > 0 ? repos : fallback;
}

/**
 * The repos one fire visits, land-list first, deduplicated.
 *
 * Land-first is not arbitrary: `sweepRepos` carries the enqueue spend forward
 * in list order, so visiting the repos that can actually spend it first keeps
 * MAX_ENQUEUES_PER_FIRE meaning what it says. (Notify-only repos spend nothing
 * — `demoteMergeActions` sees to that — so this is belt-and-braces rather than
 * load-bearing today. It stops being free the moment anything else is counted
 * per repo in list order.)
 */
export function sweepOrder(targets, notifies) {
  const order = [];
  const seen = new Set();
  for (const repo of [...(targets ?? []), ...(notifies ?? [])]) {
    if (seen.has(repo)) continue;
    seen.add(repo);
    order.push(repo);
  }
  return order;
}

/**
 * The settling floor, from the environment, refusing anything that is not a
 * real number of minutes.
 *
 * `Number("15m")` is `NaN`, and `ageMinutes < NaN` is `false`, so an
 * unparseable value used to report every rollup as settled — the guard
 * disarming itself in the fail-OPEN direction, silently. `15m` is the likely
 * bad input, invited by the "15 minutes" phrasing and by the `floor 15m` the
 * detail string prints back. Blank is unset, not zero, for the same reason:
 * `Number("")` is `0`, which is finite and would disable the floor.
 *
 * Same rule `classifyFromListing` already applies to an unparseable
 * `autoMergeRequest.enabledAt`, which refuses to let a bad timestamp read as
 * infinitely old.
 */
export function settleMinutesFrom(value = process.env.LAND_CLEAN_PRS_SETTLE_MINUTES) {
  const raw = String(value ?? "").trim();
  const parsed = Number(raw);
  if (raw === "" || !Number.isFinite(parsed) || parsed < 0) return CHECK_SETTLE_MINUTES;
  return parsed;
}

/**
 * Records a non-fatal apply failure in the `action` column, not just `detail`.
 * `renderReceipt` tallies by action, so a failure left only in free text is
 * invisible to the summary line — which is how #2020 reported `enqueue` for 25
 * hours while arming nothing.
 *
 * Renaming the action also drops the row out of `sweepRepos`'s `spent` tally,
 * which counts `enqueue` rows against the per-fire cap. That is the wanted
 * reading: a failed enqueue consumed no queue slot.
 */
export function markFailure(row, message) {
  row.action = `${row.action}-failed`;
  row.detail = [row.detail, `failed: ${String(message).trim().split("\n")[0]}`]
    .filter(Boolean)
    .join(" — ");
  return row;
}

/**
 * Actions that already state their own reason on the PR, from `applyRow`, at
 * the moment of the hold rather than from the age report. `stateHold` must
 * skip them or the PR carries two comments saying the same thing under two
 * markers.
 *
 * `codeowner-review-requested` is the live case: it is not in
 * `NON_HOLD_ACTIONS` and its reason does not match `DELIBERATE_HOLD_REASON_RE`,
 * so it reaches `stalledHolds` and would pick up a second comment under
 * `stated-hold:owner-approval-pending` beside its `CODEOWNER_REQUEST_MARKER`
 * one. The bespoke comment is the better of the two — it names the owner — and
 * it is posted on the FIRST fire rather than after STALE_HOLD_HOURS, so the
 * duplicate adds a worse sentence, later.
 *
 * The row stays in the stale-hold REPORT: the receipt is for a human reading
 * the fire, and a code-owner hold that has outlived its window belongs there.
 * It is only the PR comment that is suppressed.
 */
const BESPOKE_COMMENT_ACTIONS = new Set(["codeowner-review-requested", "stale-enqueue", "stale-queued"]);

/**
 * The order the apply loop walks `rows` in: every `enqueue` row first, oldest
 * PR first, then every other row in its `rows` position.
 *
 * ## This is DELIBERATELY not the order of `rows`, and the difference must survive
 *
 * `rows` is the RECEIPT. It comes back in `gh pr list` order (newest first) and
 * `classifyAll` keeps it that way on purpose, so one fire's receipt diffs
 * against the last one's. That stability is pinned by its own test and is not
 * negotiable. This function therefore reorders the ITERATION and leaves the
 * array alone — it returns the same row OBJECTS, so the in-place `row.action`
 * and `row.detail` writes the loop makes still land in the receipt, in receipt
 * order. An edit that "fixes the inconsistency" by sorting `rows` instead
 * breaks the receipt; an edit that drops this call restores the defect below.
 *
 * ## Why the apply order has to differ at all (PEN-5503)
 *
 * The loop can DIE PARTWAY. Every `applyRow` call can throw something
 * `isFatalGhError` calls untrustworthy, and that exits the process, so a row's
 * position in the apply order decides whether a fire that dies reaches it.
 *
 * Before BLO-51664 the cap was spent newest-first, so the winners were a
 * contiguous PREFIX of the newest-first listing and were applied FIRST; a
 * truncation killed rows already headed for `cap:N-per-fire`, which cost
 * nothing. Spending the cap oldest-first moved the winner block to a contiguous
 * SUFFIX — so an abort began dropping exactly the oldest PRs that fix exists
 * to protect. Measured on the 2026-11-04 08:45Z fire: the ten winners were
 * applied in one descending burst ending at the oldest, #3215, 32s in.
 *
 * ## Why ALL enqueues, and not merely the winners among themselves
 *
 * Permuting the winners into age order inside their existing slots satisfies
 * the letter of that and leaves most of the exposure standing: `applyRow`
 * mutates remote state for `codeowner-review-requested` too, and those rows are
 * interleaved among the winners by PR number. Same fire, in apply order: 18
 * abort-capable calls to reach the last winner, 8 of them notifications. So the
 * hoist is over the whole `enqueue` cohort, for three reasons:
 *
 *   - The two actions are not equally expensive to lose. A deferred
 *     notification is `commentOnce`-deduped: it arrives 6h late and still posts
 *     exactly once. A deferred `enqueue` costs 6h AND re-presents as fresh
 *     demand against a cap that is spent at enqueue rather than at merge.
 *   - The deferrable work is itself an abort CAUSE. `commentOnce` reads the
 *     PR's whole comment list with `--paginate` before deciding whether to
 *     post, so those rows burn paginated rate limit ahead of the scarce action
 *     — and an exhausted rate limit is one of the things `isFatalGhError`
 *     fires on.
 *   - It shortens the classification-to-enqueue window, which can only reduce
 *     the `head moved since classification` refusals of PEN-4887.
 *
 * Nothing orders against the hoist: one PR yields one row, so a `stale-enqueue`
 * disarm and an `enqueue` are never the same PR, and `stalledHolds` reads
 * `rows` after the loop. In a notify-only repo `demoteMergeActions` has already
 * renamed every `enqueue`, so this is an identity there.
 *
 * Ascending PR number is the age proxy, the same key `classifyAll` allocates
 * on; a row with no usable number sorts last, and ties keep `rows` order.
 */
export function applyOrder(rows) {
  const indexed = (rows ?? []).map((row, i) => ({ row, i }));
  const age = ({ row }) => row?.number ?? Infinity;
  const enqueues = indexed
    .filter(({ row }) => row?.action === "enqueue")
    .sort((a, b) => age(a) - age(b) || a.i - b.i);
  const rest = indexed.filter(({ row }) => row?.action !== "enqueue");
  return [...enqueues, ...rest].map(({ row }) => row);
}

/**
 * A fault in how this file's own functions were CALLED, as opposed to a fault
 * in what they were called about. Extends `TypeError`, so anything catching
 * broadly keeps the familial meaning, but carries its own IDENTITY — because
 * the frame that has to tell a wiring fault from a read failure can then ask
 * what this file declared about itself rather than guess from an error's
 * species.
 *
 * Why identity and not `instanceof TypeError`, measured 2026-11-04.
 * `fetchOpenPrs` runs inside `runRepo` and `JSON.parse`s `gh pr list` output
 * before calling `.map` on it, so with the `run` seam returning a well-formed
 * NON-array payload it raises a bare `TypeError` that `isFatalGhError` does
 * not match: `rows.map is not a function` for an object or a string,
 * `Cannot read properties of null (reading 'map')` for null. That is a genuine
 * per-repo read failure and PEN-5442's exact subject — the repo is skipped and
 * every other repo keeps its verdicts. A blanket `TypeError` rethrow would
 * turn it into an unhandled throw that ends the whole fire, since `sweepRepos`
 * has no catch and `main`'s try/`finally` has none either. That is PEN-5442's
 * closing sentence reinstated as a regression, inside a commit whose purpose
 * is adding a control.
 */
export class WiringError extends TypeError {}

/** Every option `runRepo` knows. */
const RUN_REPO_KEYS = new Set([
  "repo",
  "apply",
  "settleMinutes",
  "spent",
  "rotted",
  "stranded",
  "starved",
  "queued",
  "fetch",
  "classify",
  "landable",
  "applyOne",
  "applyRun",
  "state",
]);

/** Every option `repoRunner` knows. */
const REPO_RUNNER_KEYS = new Set([
  "apply",
  "settleMinutes",
  "rotted",
  "stranded",
  "run",
  "notify",
  "unreadable",
  "starved",
  "queued",
]);

/**
 * The by-reference cohorts, which carry NO default on either bag.
 *
 * `rotted` is cited rather than introduced: it is the first by-reference
 * out-param in both signatures and it has never carried a default in either,
 * while all three later cohorts acquired one. So this is not a new rule — it
 * is this file's original practice, abandoned once per cohort without anyone
 * deciding to.
 */
const RUN_REPO_REQUIRED_KEYS = ["rotted", "stranded", "starved", "queued"];
const REPO_RUNNER_REQUIRED_KEYS = ["rotted", "stranded", "unreadable", "starved", "queued"];

/**
 * ⛔ TWO throws, not one, because a typo and an omission are different faults
 * and NEITHER check can see the other's.
 *
 * Unknown-key rejection catches a typo, which has two halves — a key that
 * should not be there and a key that should. Required-key rejection catches an
 * omission, which has only one. A dropped `starved:` — or a future call site
 * that never learns a cohort exists — binds nothing, the callee's own default
 * would supply a fresh array, the callee pushes into THAT, the caller's
 * collector stays empty, the alarm sums zero and the suite is green. Byte
 * identical silence to the typo case, and completely invisible to the
 * unknown-key check.
 *
 * ⚠ THIS HAZARD IS PRE-EXISTING, not introduced by the bag. An omitted
 * trailing positional took `[]` just as silently before this conversion. What
 * the bag changes is the hazard's REACH — an interior key can be dropped where
 * an interior positional cannot — and its frequency. It does not create it.
 *
 * ⚠ What these guards do NOT cover, stated because the guard they replace had
 * a comment that overstated its own reach. They check the SHAPE of the call,
 * never its meaning: passing `stranded` where `starved` belongs is two known,
 * present keys and sails through, as does passing an array that some other
 * frame is not reading. They also say nothing about `repo`, `apply`,
 * `settleMinutes` or `spent`, which are ordinary inputs rather than
 * by-reference out-params — an omission there is loud on its own, which is why
 * the required set is the cohorts and not every key without a default.
 */
function assertBag(fn, bag, known, required) {
  if (bag === null || typeof bag !== "object" || Array.isArray(bag)) {
    const got = bag === null ? "null" : Array.isArray(bag) ? "an array" : typeof bag;
    throw new WiringError(
      `${fn}: expected a named options object — received ${got}. This signature ` +
        "takes ONE bag and has no positional form; see the conversion note on `repoRunner`.",
    );
  }
  for (const key of Object.keys(bag)) {
    if (known.has(key)) continue;
    throw new WiringError(
      `${fn}: unknown option \`${key}\`. Known options: ${[...known].join(", ")}.`,
    );
  }
  for (const key of required) {
    if (key in bag) continue;
    throw new WiringError(
      `${fn}: missing required option \`${key}\`. The by-reference cohorts carry no ` +
        "default on purpose: a dropped key collects into an array the caller never reads, " +
        "which reads downstream as an empty cohort and therefore as health.",
    );
  }
}

export function runRepo(options) {
  // PEN-5536. ONE named bag, no positional form. This signature grew a
  // positional twice and BOTH times a caller's options bag bound silently to
  // the NEW positional instead — BLO-51665's rate-limit test (slot 6 ->
  // `stranded`) and PEN-5430's `repoRunner` spread (slot 7 -> `starved`).
  // Neither threw: `fetch` simply fell back to the real `fetchOpenPrs`, so the
  // test issued a LIVE GraphQL call and asserted against whatever GitHub
  // returned — green, and testing nothing. The cost was never hypothetical,
  // because `landing-sweep.yml` runs this suite before the hourly sweep, so a
  // wedged arity takes the sweep with it.
  //
  // A bag removes the failure mode rather than detecting it a third time:
  // there is no slot for a value to land in by accident, so there is nothing
  // for the next inserter to have to notice.
  assertBag("runRepo", options, RUN_REPO_KEYS, RUN_REPO_REQUIRED_KEYS);
  const {
    repo,
    apply,
    settleMinutes,
    spent,
    // No defaults, and `assertBag` requires them. See RUN_REPO_REQUIRED_KEYS.
    rotted,
    stranded,
    starved,
    queued,
    // Defaults are retained on the injectable SEAMS below, because supplying a
    // real implementation when a test did not ask for one is exactly what a
    // seam default is for.
    fetch = fetchOpenPrs,
    classify = classifyAll,
    // PEN-5430. `false` for a notify-only repo. Note the applier DEFAULT is
    // derived from it rather than branched on inside the applier: in a
    // notify-only repo `applyRow` is never referenced at all, so there is no
    // in-function flag for a later edit to get wrong.
    landable = true,
    applyOne = applierFor(landable),
    // The `gh` seam handed to whichever applier was selected above, so a test
    // can assert over the invocations that applier makes without replacing it
    // (which would stop testing the selection).
    applyRun = gh,
    state = stateHold,
  } = options;
  let prs;
  try {
    prs = fetch(repo);
  } catch (error) {
    // BLO-51665: a throw here used to leave the receipt EMPTY, so nobody could
    // tell which repo the fire died in or why. Say it on stdout, then rethrow.
    //
    // PEN-5442: the rethrow no longer necessarily ends the fire — `repoRunner`
    // decides that, and skips this repo unless the error is one
    // `isFatalGhError` calls untrustworthy. The message is worded for both
    // outcomes, because this frame does not know which it will get.
    const message = error?.stderr?.toString() || error?.message || String(error);
    console.log(`## ${repo}\n\nCould not collect PRs: ${message.trim().split("\n")[0]}`);
    throw error;
  }
  // The per-fire cap is applied INSIDE `classifyAll`, which rewrites an
  // `enqueue` past the ceiling to `skip`/`cap:N-per-fire` before
  // `demoteMergeActions` can see it. In a notify-only repo that prints a
  // throttle which cannot apply there — the repo spends no budget and arms
  // nothing — and it would do so routinely: once the land repos spend the cap,
  // or once the notify repo holds more than MAX_ENQUEUES_PER_FIRE clean PRs.
  // Opting out of the cap here is what makes `sweepOrder`'s "notify-only repos
  // spend nothing" literally true rather than nearly true. (Ally review,
  // PR #3365.)
  const budget = landable ? { spent } : { spent: 0, maxEnqueues: Infinity };
  const rows = classify(prs, { settleMinutes, ...budget });
  // Before the apply loop, before the receipt, and before `sweepRepos` reads
  // the returned rows — every consumer of `enqueue` must see the demoted name.
  if (!landable) demoteMergeActions(rows);

  for (const row of rows) {
    if (row.action === "approval-rotted") rotted.push(`${repo}#${row.number} (${row.detail})`);
  }

  // ⚠ APPLY ORDER IS NOT RECEIPT ORDER, ON PURPOSE. `rows` stays in listing
  // order for the receipt; `applyOrder` hoists the scarce `enqueue` work to the
  // front, oldest first, so a fire that dies partway has already spent the cap
  // on the oldest PRs rather than on whatever the listing happened to put
  // first. Read its doc comment before collapsing the two orders back together.
  for (const row of applyOrder(rows)) {
    if (!apply) continue;
    try {
      const outcome = applyOne(repo, row, applyRun);
      if (outcome) row.detail = [row.detail, outcome].filter(Boolean).join(" — ");
    } catch (error) {
      const message = error?.stderr?.toString() || error?.message || String(error);
      if (isFatalGhError(message)) {
        row.action = "aborted";
        row.detail = message.trim().split("\n")[0];
        console.log(`## ${repo}\n\n${renderReceipt(rows)}`);
        // Print the priority cohort before dying: it is the expensive half of
        // the output, and the repos that already completed earned it.
        reportRotted(rotted);
        console.error(`\nAborted the fire: ${row.detail}`);
        // PEN-5314: this abort is a TRANSPORT failure (exhausted rate limit,
        // bad credentials), not a verdict, so it spends the unmeasured code
        // rather than the alarm's `1`. `stranded` is not passed: this path is
        // reachable only under `--apply`, which `main` refuses to combine with
        // `--alarm`, so there is no alarm cohort in flight to report.
        process.exit(EXIT_UNMEASURED);
      }
      markFailure(row, message);
    }
  }

  // After the apply loop, so a row this fire just enqueued (or just renamed to
  // `enqueue-failed`) is aged on what it ENDED as, not on the classification
  // it entered with.
  const held = stalledHolds(prs, rows);
  const stalled = renderStalledHolds(repo, held);
  // Disjoint from `stalled` by construction: that block reports rows with a
  // reason for inaction, this one rows with none. A PR can never be in both.
  //
  // DRY RUNS ONLY, and this is the same post-apply meaning flip that `main`
  // refuses `--alarm` + `--apply` over — it just reaches further than that
  // refusal covers. After the loop above, a row still reading `enqueue` is
  // not "nothing took this in UNLANDED_ELIGIBLE_HOURS"; it is "this fire took
  // it, seconds ago". There is no third case: every `enqueue` row entered
  // `applyRow`, which leaves the action alone on success, renames it to
  // `enqueue-failed` on a non-fatal throw (and `stalledHolds` owns it from
  // there), and exits the process on a fatal one. Capped rows never reach
  // here at all — `classifyAll` rewrites them to `skip`/`cap:`.
  //
  // So in an applying run this cohort is a tautology over the rows just acted
  // on, and acting on it was actively wrong: `stateHold` posted "The landing
  // routine is not enqueuing this PR" on PRs the same fire had just enqueued,
  // permanently, because `commentOnce` never repeats. The trigger is ordinary
  // rather than exotic — any PR whose CI finished more than
  // UNLANDED_ELIGIBLE_HOURS before its review or owner approval arrived is
  // eligible on the very fire that first enqueues it.
  //
  // Nothing is lost by the cut. The cohort's subject is "fires are not
  // enqueuing this", which an applying fire has just disproved for every row
  // it holds, and the persistent case is owned by the hourly `--alarm`
  // detector that cannot apply by construction.
  const eligible = apply ? [] : unlandedEligible(prs, rows);
  for (const row of eligible) stranded.push(`${repo}#${row.number}`);

  // Same `apply ? [] :` cut as the cohort above, for a reason that is
  // adjacent but not identical. There the post-apply flip makes the claim
  // FALSE; here it makes it UNSOUND to measure. An applying fire has just
  // spent the budget this cohort reasons about, and `applyRow` enqueues
  // without re-reading any timeline, so a row deferred by that very spend
  // would be scored against a snapshot taken before it. The hourly
  // `--alarm` fire, which cannot apply by construction, is the one that
  // owns this measurement — and it is also the one whose cap is a pure
  // simulation, so its `cap:` rows mean "demand exceeds the budget right
  // now" rather than "this fire ran out", which is exactly the question.
  const capped = apply ? [] : capStarved(prs, rows);
  for (const row of capped) starved.push(`${repo}#${row.number}`);

  // PEN-5536. The wedged-front-of-queue cohort. No `capStarved`-style helper
  // and no clock of its own: `classifyPr` has already applied BOTH halves of
  // the predicate (`position === 1` strictly, and `enqueuedAt` older than
  // STALE_ENQUEUE_HOURS), so the finding IS the row and this only collects it.
  // Nothing here may re-derive or relax it.
  //
  // ⚠ NO `apply ? [] :` CUT, unlike both cohorts above, and the asymmetry is
  // deliberate. Theirs exists because applying FLIPS the meaning of the row
  // they read: an `enqueue` row after the apply loop means "this fire just
  // took it", and a `cap:` row is scored against a budget the same fire just
  // spent. `stale-queued` has no such flip — `applyRow` only comments on it,
  // because `gh` exposes no dequeue flag — so the row reads identically before
  // and after, and the finding is equally true in both modes. (`main` refuses
  // `--alarm` with `--apply` anyway, so an applying fire never reads this.)
  //
  // ⛔ SCOPED TO LAND REPOS, answering PEN-5536 §6 deliberately rather than by
  // default. In a notify-only repo this routine enqueues nothing, so a wedged
  // queue there was queued by somebody else: still a true finding, but not a
  // statement about THIS routine, and the blast-radius argument that justifies
  // alarming evaporates with it — none of the PRs stuck behind that head were
  // ones this fire would have landed. What would remain is a shared hourly
  // schedule turned red at an on-call who cannot clear it, which is the
  // specific way alarms stop being read. `demoteMergeActions` already makes
  // exactly this argument for `stranded`: "a clean PR in a notify-only repo is
  // not stranded; it is held by policy, and alarming on it would turn the
  // detector permanently red for working as designed." Cited rather than
  // restated, because two statements of one dividing line are how they drift.
  //
  // Gated HERE, on `landable`, rather than by adding `stale-queued` to
  // MERGE_MUTATING_ACTIONS. That set files an action as something this routine
  // MUTATES, and `stale-queued` mutates nothing — `gh` exposes no dequeue
  // flag, so the row only ever states a finding. It would also be the wrong
  // instrument: `demoteMergeActions` RENAMES the row to `notify-only` before
  // every consumer reads it, which would erase the finding from that repo's
  // RECEIPT as well. Not alarming on a guest repo's wedged queue is the
  // decision; refusing to print it is not. `landable` is the same key one hop
  // down from `notifyRepos()`, and already gates the `stated-hold:*` writes
  // below.
  //
  // ⚠ Correcting the premise this scoping was ruled on, because the ruling's
  // wording invites a widening that would be wrong. PEN-5536 §4 said to "keep
  // the comment unscoped" since "commenting is the one thing a notify-only
  // repo exists to permit". The PR comment is indeed untouched by this change
  // — but in a notify-only repo it never happened in the first place:
  // `applierFor(false)` selects `applyRowNotifyOnly`, which returns `null` for
  // every action except `codeowner-review-requested`. The code-owner
  // notification is the ONLY write this routine makes in a guest repo, by
  // design and for a stated reason (narrowest write surface worth asking a
  // human to grant). So the instruction is satisfied vacuously, and nobody
  // should "restore" a `stale-queued` comment there: that would WIDEN the
  // write surface in a repo we are a guest in, which is the opposite of what
  // §4 was protecting.
  //
  // ⚠ This is the file's FIRST cohort scoping that is a visible check rather
  // than a consequence of `demoteMergeActions`' rename, so nothing else
  // enforces it: the mutation-detecting test PAIR in the suite (alarms in a
  // land repo, silent in a notify-only one) is what makes deleting this `if`
  // red rather than free. `unreadable` is deliberately NOT scoped, for the
  // record — "I could not read this repo" is a statement about the routine
  // whether or not it lands there — so "scope every cohort" would be wrong
  // and this needed an argument rather than a convention.
  if (landable) {
    for (const row of rows) {
      if (row.action === "stale-queued") queued.push(`${repo}#${row.number}`);
    }
  }

  // Stated on the PR, not just in this receipt — and only on `--apply`, since
  // it is a write. A failure here is recorded against the row and never
  // aborts: the report above is the load-bearing output, and losing it
  // because one comment POST failed would trade the whole fire's visibility
  // for one PR's. `isFatalGhError` is deliberately NOT consulted — a rate
  // limit reached while commenting has already let the reads through, so the
  // receipt is trustworthy and worth printing.
  //
  // `landable` gates this too (PEN-5430): in a notify-only repo the ONLY write
  // this routine makes is the code-owner notification. A `stated-hold:*`
  // comment there would be the routine explaining its own inaction in a repo
  // where its inaction is the policy — and we are a guest in that repo, so the
  // narrowest possible write surface is the one worth asking a human to grant.
  if (apply && landable) {
    const byNumber = new Map(rows.map((row) => [row?.number, row]));
    for (const row of held) {
      const classified = byNumber.get(row?.number);
      if (BESPOKE_COMMENT_ACTIONS.has(classified?.action)) continue;
      try {
        // `detail` is attached HERE rather than carried on the `stalledHolds`
        // row: that row shape is the receipt's contract and several tests
        // deep-compare it, so widening it to serve one comment would break
        // callers that have nothing to do with commenting. The join is the
        // same `byNumber` lookup the skip above already does.
        //
        // Absent detail leaves the object IDENTICAL rather than adding
        // `detail: undefined`. `deepStrictEqual` counts a present key holding
        // `undefined` as a difference, so spreading unconditionally would
        // break every existing deep-compare of this row for no gain — there
        // is nothing for `reviewGateRemedy` to read in that case anyway.
        const detail = classified?.detail;
        state(repo, detail === undefined || detail === null ? row : { ...row, detail });
      } catch (error) {
        const message = error?.stderr?.toString() || error?.message || String(error);
        console.error(
          `  (could not state the hold on ${repo}#${row.number}: ${message.trim().split("\n")[0]})`,
        );
      }
    }
  }
  const blocks = [
    renderReceipt(rows),
    stalled,
    renderUnlandedEligible(repo, eligible),
    renderCapStarved(repo, capped),
  ];
  console.log(`## ${repo}\n\n${blocks.filter(Boolean).join("\n\n")}`);
  return rows;
}

/**
 * Runs each repo with the enqueues already spent this fire, so the cap is per
 * fire (see MAX_ENQUEUES_PER_FIRE). Only rows still reading `enqueue` after
 * apply are spent; `enqueue-failed` is not. Extracted from `main` so the carry
 * and that reading are tested directly rather than by a copy of the loop.
 */
export function sweepRepos(repos, runOne) {
  let spent = 0;
  for (const repo of repos) {
    const rows = runOne(repo, spent);
    spent += rows.filter((row) => row.action === "enqueue").length;
  }
  return spent;
}

/**
 * `main`'s per-repo step for `sweepRepos`: hands the carried spend to
 * `runRepo`. Hoisted so a test can pin that carry (a literal `0` here makes
 * the cap per repo again) without running `main`. `run` is a test seam.
 */
export const repoRunner = (options) => {
  // PEN-5536. ONE named bag, same conversion and same reason as `runRepo`
  // above — see its note for the two silent mis-bindings that motivated it.
  //
  // ⚠ FORWARD OBLIGATION, replacing the standing instruction this commit
  // spends (CTO, 2026-11-04, PEN-5391 / PEN-5386: *"Before a FIFTH cohort is
  // added here, convert `repoRunner` and `runRepo` from positional vectors to
  // named options objects"*). That conversion has now happened, and leaving
  // the instruction in place would send the next author to perform it again.
  //
  // What replaces it: the bag is now the shape. Any edit that moves a PINNED
  // CALL SITE's syntax must re-anchor that probe in the same commit and keep
  // its mutation control live — the control is the only thing that identifies
  // WHICH occurrence the probe matched, and a probe that has quietly
  // retargeted to a declaration still passes. See the call-site probes in
  // `land-clean-prs.test.mjs`.
  assertBag("repoRunner", options, REPO_RUNNER_KEYS, REPO_RUNNER_REQUIRED_KEYS);
  const {
    apply,
    settleMinutes,
    // No defaults, and `assertBag` requires them. `unreadable` (PEN-5442) is a
    // CONSTRUCTOR-only cohort: it is never threaded into `runRepo`, because
    // the condition it records — the repo could not be listed — is observed
    // out here, where the throw is caught, and is never visible inside
    // `runRepo`. `starved` (PEN-5391) IS threaded through, because a cap
    // deferral is observed per PR inside the sweep.
    rotted,
    stranded,
    unreadable,
    starved,
    queued,
    // Seams keep their defaults.
    run = runRepo,
    notify = new Set(),
  } = options;
  return (repo, spent) => {
    // Spread rather than an unconditional key, so a fire with no notify list
    // hands `runRepo` exactly the options it needs and lets `landable` take
    // its own default, instead of passing an explicit `undefined` that the
    // destructuring default would have to absorb.
    const scope = notify.has(repo) ? { landable: false } : {};
    let rows;
    try {
      rows = run({
        repo,
        apply,
        settleMinutes,
        spent,
        rotted,
        stranded,
        starved,
        queued,
        ...scope,
      });
    } catch (error) {
      // ⛔ PEN-5536, and it is FIRST on purpose: a wiring fault is never
      // recorded as a repo-readability fact. `assertBag`'s throws travel
      // through this very catch, and `isFatalGhError` is a regex over
      // rate-limit / bad-credential / HTTP 401 / HTTP 403 / credential-prompt
      // messages that a shape fault matches none of — so without this line a
      // mis-wired call is pushed to `unreadable` and printed as "it could not
      // be listed". That is wrong twice: a wiring fault is repo-INDEPENDENT,
      // so every repo in the sweep takes the same throw and the hourly
      // `--alarm` detector goes red naming an apparent GitHub outage, while
      // the `45 */6` applying routine prints the same list and exits 0 —
      // green rather than silent, and a green routine's log reaches nobody.
      //
      // A guard is only as loud as the catch above it. Neither half of this
      // control is complete alone.
      if (error instanceof WiringError) throw error;
      // PEN-5442: one unreadable repo used to end the WHOLE fire. `fetchOpenPrs`
      // is the first thing `runRepo` does and its throw escaped `runRepo`'s
      // try, `sweepRepos` had no catch, and `main` wrapped the sweep in
      // try/`finally` with no catch either — so a repo the routine merely
      // could not list took every other repo down with it. That it did not
      // cost anything yet was ordering luck: `sweepOrder` happens to sweep the
      // land repos first, so their rows were already printed.
      //
      // Measured 2026-11-04, Blockcast/penstock-llm-proxy-core at 153 open
      // PRs: the single list call 502'd on 3 of 3 attempts. A repo that cannot
      // be read is a repo with no verdicts — which is a reason to say so and
      // move on, not a reason to discard the verdicts of the repos that CAN be
      // read.
      const message = error?.stderr?.toString() || error?.message || String(error);
      const first = message.trim().split("\n")[0];
      // `isFatalGhError` keeps its meaning exactly: exhausted rate limits or
      // bad credentials make the WHOLE fire untrustworthy, not just this repo,
      // because every subsequent `skip:` row would be indistinguishable from a
      // real verdict. Those still end the fire.
      if (isFatalGhError(first)) throw error;
      unreadable.push(`${repo} (${first})`);
      console.log(`Skipped ${repo}: it could not be listed. The rest of the fire continues.\n`);
      // No rows, so `sweepRepos` carries no spend for this repo — correct, it
      // enqueued nothing.
      return [];
    }
    console.log("");
    return rows;
  };
};

/**
 * Names the repos this fire skipped, in every run mode.
 *
 * Printed from `main`'s `finally` beside `reportRotted` so it survives a later
 * abort, and unconditionally rather than only under `--alarm`: a dry run that
 * silently covered one repo fewer than the reader assumes is the same wrong
 * conclusion, just without an exit code to carry it.
 */
function reportUnreadable(unreadable) {
  if ((unreadable ?? []).length === 0) return;
  console.log(
    `\nunreadable repos (PEN-5442) — ${unreadable.length}:\n` +
      unreadable.map((repo) => `  ${repo}`).join("\n") +
      "\nThis fire asserts nothing about these: no receipt, no holds, no " +
      "unlanded-eligible cohort. Everything above covers the other repos only.",
  );
}

function reportRotted(rotted) {
  if (rotted.length === 0) return;
  // Reported, never acted on. A deliberate hold is invisible on every API
  // surface — trafficcontrol#1726 read exactly like a strand while its body
  // said "do not merge before magma#1936", a shared proto field-number space.
  // So: read the PR body before rebasing anything here.
  console.log(
    `approval-rotted (BLO-33208 priority cohort) — ${rotted.length}:\n` +
      rotted.map((row) => `  ${row}`).join("\n") +
      "\nRead each PR body before rebasing: a deliberate sequencing hold is " +
      "indistinguishable from a strand on every API surface.",
  );
}

/**
 * The exit code for a fire that could not finish measuring (PEN-5314).
 *
 * ⛔ THE POINT IS THAT IT IS NOT 1. Every other outcome this script can reach
 * already spends 0, 1 or 2:
 *
 *   0  measured, nothing wrong                    `alarmExitCode`
 *   1  measured, a PR is stranded or starved      `alarmExitCode`
 *   2  `--alarm` + `--apply` misuse               `main`
 *   3  COULD NOT MEASURE                          `main` AND `alarmExitCode`
 *
 * ⚠ `3` is spent from TWO places, and they are the same claim at two scales:
 * `main` when the sweep itself threw, and `alarmExitCode` when the sweep
 * finished but PEN-5442's `unreadable` cohort is the only non-empty one. Both
 * mean "this run did not look at everything, so do not read it as health".
 *
 * That second site exists because the per-repo catch landed AFTER the first
 * draft of this constant and quietly took the headline case back: a transient
 * 5xx exhausting `fetchOpenPrs`'s retries is not fatal, so `repoRunner` catches
 * it, pushes the repo onto `unreadable` and returns `[]` — and `alarmExitCode`
 * then spent `1` for it. The dominant "GitHub 502'd" case was spelled as a
 * stranded cohort again, which is the exact defect this constant was added to
 * remove. A table that disagrees with the code is worse than no table, because
 * a workflow `if:` gets written against the table.
 *
 * Before this existed, an abort exited 1 — the node default for an uncaught
 * throw, and the same integer `alarmExitCode` spends to report a real stranded
 * cohort. So a red landing-sweep meant either "PRs have been landable for
 * {UNLANDED_ELIGIBLE_HOURS}h and nothing took them" or "GitHub 502'd and this
 * run never classified a single PR", with nothing in the exit code to tell
 * them apart. That is the same unmeasured-state-encoded-as-a-measured-state
 * defect as PEN-5158 and PEN-4458.
 *
 * 3 rather than 2 because 2 is taken, and the collision would only be found
 * after a workflow `if:` had been written against it.
 */
export const EXIT_UNMEASURED = 3;

/**
 * Says, on stderr, that the fire stopped before it finished — and reports
 * whatever alarming cohorts it HAD computed (PEN-5314).
 *
 * Reporting the partial cohorts is deliberate: "I could not finish, and here is
 * what I found before I stopped" is strictly more useful than either half. It
 * is explicitly NOT a verdict, and the text says so, because the rows below it
 * are a prefix of the real answer and a reader must not treat a short list as
 * a complete one.
 *
 * ⛔ EVERY alarming cohort, not just the first. `stranded` and `starved` are
 * both collected by reference as the sweep runs, so each is a genuine prefix
 * of its own answer; reporting one and not the other makes the summary quietly
 * untrue for the arm it omits, in a run whose whole claim is "here is what I
 * had". `unreadable` is deliberately NOT here — it is printed unconditionally
 * by `reportUnreadable` from `main`'s `finally`, which runs before this.
 */
export function reportUnmeasured(
  error,
  stranded = [],
  // ⛔ `starved` rides in the OPTIONS BAG, not in a third positional slot.
  // Both of this file's last two parameter insertions bound an existing
  // caller's options bag to the new positional in silence (BLO-51665's
  // rate-limit test, then PEN-5391's spread), which is why `runRepo` now opens
  // with an `Array.isArray` throw. A key cannot collide with a bag, so this
  // insertion cannot repeat that — every existing two- and three-argument
  // caller keeps its exact meaning.
  { alarm = false, starved = [], queued = [], log = console.error } = {},
) {
  const message = ghErrorMessage(error).trim().split("\n")[0];
  log(
    `\nDID NOT MEASURE: the sweep stopped before every repo was classified — ${message}\n` +
      `Exiting ${EXIT_UNMEASURED}, which is NOT the alarm code. This run makes no claim ` +
      "about whether any PR is stranded; it never finished looking.",
  );
  // One line is the right amount of a `gh` failure and the wrong amount of a
  // programming error: for the latter the first line is the least useful part
  // of what Node would otherwise have printed, and the frames are the whole
  // diagnosis. `ghErrorMessage` prefers `stderr`, so its ABSENCE is the tell
  // that this throw did not come from a subprocess.
  if (!error?.stderr && error?.stack) log(error.stack);
  if (!alarm) return;
  // Every alarming cohort collected so far, not just the first one. These are
  // gathered by reference as the sweep runs, so each is a genuine prefix of
  // its real answer; omitting one makes "here is what I found before I
  // stopped" quietly untrue for that cohort.
  const partial = [
    ["unlanded-eligible", stranded ?? []],
    ["cap-starved", starved ?? []],
    ["stale-queued", queued ?? []],
  ].filter(([, cohort]) => cohort.length > 0);
  if (partial.length === 0) {
    log(
      "No unlanded-eligible, cap-starved or stale-queued PR had been found when the sweep " +
        "stopped — but " +
        "the repos after the failure were never read, so this is an empty PREFIX, not an " +
        "all-clear.",
    );
    return;
  }
  for (const [label, cohort] of partial) {
    log(
      `Partial ${label} cohort found before stopping (${cohort.length}, ` +
        `possibly incomplete) — ${cohort.join(", ")}.`,
    );
  }
}

/**
 * The exit code for an alarm run that COMPLETED: 1 when any repo carried an
 * unlanded-eligible or a cap-starved PR, 0 otherwise. A run that could not
 * finish does not reach this — it spends `EXIT_UNMEASURED` instead.
 *
 * Separated from `main` so the AC4 contract — go visibly red rather than
 * relying on someone noticing by hand — is pinned by a test rather than by
 * reading the shape of `main`.
 *
 * ⛔ EVERY term here must be able to go red ON ITS OWN, and each is a separate
 * parameter rather than one widened array so that a caller cannot satisfy the
 * contract by passing the wrong cohort in the right slot. The three are
 * independent conditions with different remedies, and dropping any one of them
 * during a future merge compiles, passes every test that calls this function
 * directly, and silently retires an alarm arm — which is why
 * `pins all three alarm terms at main's call site` reads the call site itself.
 *
 * ⛔ `unreadable` is a term for a reason, and it is the whole reason skipping
 * an unreadable repo is safe. Before PEN-5442 an unreadable repo CRASHED the
 * fire, which at least exited non-zero. Skipping it instead would, on its own,
 * convert that noisy failure into `0` — "no PR has been landable and ignored
 * for UNLANDED_ELIGIBLE_HOURS" asserted over a repo this fire never read. That
 * is the fail-OPEN direction and it is exactly the shape of silent all-clear
 * this detector exists to rule out, so the skip and this term ship together: a
 * repo that went unread goes NON-ZERO on its own.
 *
 * ⚠ It goes non-zero as `EXIT_UNMEASURED`, not as `1`, and the distinction is
 * the entire point of PEN-5314 rather than a tidier spelling of it. `1` is a
 * MEASURED claim — "this fire looked, and found a PR nobody landed". An
 * unreadable repo is the opposite claim: this fire did not look. Spending `1`
 * for it rebuilt the exact ambiguity `EXIT_UNMEASURED` was added to remove,
 * and it did so for the DOMINANT case, since a transient 5xx that outlives its
 * retries arrives here rather than at `main`'s `sweepError` branch.
 *
 * The fail-open guard above is untouched by that change and does not depend on
 * which integer is spent: `EXIT_UNMEASURED` is non-zero, so the step still
 * fails and the schedule still goes red. `landing-sweep.yml` reads zero vs
 * non-zero and nothing finer.
 *
 * ⛔ PRECEDENCE, when more than one cohort is non-empty: a measured alarm wins.
 * `stranded`/`starved` are complete verdicts over the repos that WERE read —
 * the per-repo catch is per-repo, so the others ran in full — and a real PR to
 * act on outranks a report about transport. `1` surfaces that; the `unreadable`
 * ALARM block still names the skipped repos, so nothing is lost by it. This is
 * the one asymmetry with `main`'s `sweepError` path, which spends
 * `EXIT_UNMEASURED` even with a non-empty `stranded` — correctly, because there
 * the sweep ABORTED, so that cohort is a prefix rather than a verdict.
 *
 * `starved` (PEN-5391) is a THIRD argument rather than a widening of either
 * existing one because the cohorts are reported separately and have different
 * remedies, and because every existing caller then keeps its meaning
 * unchanged. Both optional arguments default to the quiet value for the same
 * reason: a caller that does not know about a cohort cannot be made red by it.
 *
 * ⚠ The stale-hold block is deliberately still NOT here. It is printed, not
 * alarmed, and that asymmetry predates this cohort: a stale hold names a
 * decision someone owes, which a red schedule cannot make them take. The
 * alarming cohorts instead assert that NOTHING is owed and the landing has
 * not happened anyway, which is a statement about the routine itself.
 *
 * ## Why `queued` alarms where the stale-hold block still does not (PEN-5536)
 *
 * `queued` is a FOURTH argument for the same reasons `starved` was a third —
 * separate report, separate remedy, every existing caller unchanged — but it
 * is the first cohort to be promoted INTO this function rather than written
 * alarming, so the test above is the thing it had to pass.
 *
 * It passes the first half outright. A PR at the front of the merge queue for
 * over STALE_ENQUEUE_HOURS is green, approved, and GitHub has accepted it:
 * NOBODY has been asked for anything, so there is no decision a red could fail
 * to compel. The comment this routine posts names the likely cause itself — a
 * required check on the queue branch that never reported — which is an
 * infrastructure fault, not an owed judgement.
 *
 * It passes the second half through the queue's SERIALIZATION, which is the
 * mechanism and is measured rather than asserted. On 2026-11-05 the `master`
 * queue held eight entries behind a slow front entry for 3h42m with ZERO
 * queue merges in that window, and position 2 read MERGEABLE throughout — a
 * ready entry that is not merging is the discriminator, because it is the head
 * holding it rather than its own checks. So a wedged head blocks an unbounded
 * set of PRs, each of which `unlandedEligible` carves out as
 * `already-enqueued` BY DESIGN. One wedged head silences the alarm for all of
 * them, which makes this the most expensive thing the sweep can miss.
 *
 * Two honest limits on that measurement, carried rather than hidden:
 *
 *   - The front entry was slow, NOT proven wedged — its merge-group jobs were
 *     still starting. What is measured is the serialization, which is the
 *     mechanism by which a wedged head would stall everything behind it. That
 *     licenses the reasoning; it is not an instance of the fault.
 *   - The observed relief valve was humans admin-merging AROUND the queue (2
 *     of the 2 merges to `master` in that window had no queue events at all).
 *     That makes the stall invisible to `master` throughput, so anything
 *     reasoning from "commits are still landing" concludes the queue is
 *     healthy. The fault is actively masked, which strengthens the case for
 *     alarming rather than weakening it.
 *
 * False-positive risk is what makes the promotion safe: `classifyPr` already
 * requires `position === 1` strictly, explicitly refuses to read an absent or
 * non-numeric position as the front, and puts STALE_ENQUEUE_HOURS on top.
 * GitHub ejects queue entries whose checks time out, so a 13h front-of-queue
 * entry means the queue is not even ejecting — pathological by construction
 * rather than merely slow.
 *
 * ⚠ CALIBRATION, recorded here so it has a durable home rather than dying in
 * a ticket: the 2026-11-05 front-stall above ran 3h42m against a threshold of
 * 13h, so this cohort would not have fired once on it — the second live
 * instance in two days to sit under the bar. The threshold is deliberately
 * UNCHANGED by the commit that added this cohort. If the distance turns out
 * to matter it is a separate question against a separate measurement, and it
 * should be answered by one.
 */
export function alarmExitCode(stranded, unreadable = [], starved = [], queued = []) {
  // MEASURED alarms first. A stranded or cap-starved PR is a thing to act on,
  // and `1` is the code that says so. A wedged front-of-queue entry joins them
  // (PEN-5536): it is measured, it is a statement about the routine, and it is
  // the one finding whose blast radius is other PRs rather than itself. An
  // unreadable repo standing beside any of them does not soften that verdict
  // and must not mask it — the `ALARM:` block still names the skipped repos
  // either way.
  if ((stranded ?? []).length > 0 || (starved ?? []).length > 0 || (queued ?? []).length > 0) {
    return 1;
  }
  // Nothing measured went wrong AND a repo went unread. That is definitionally
  // "could not measure" by this file's own words — `reportUnreadable` prints
  // "This fire asserts nothing about these" — so it spends EXIT_UNMEASURED
  // rather than borrowing the stranded cohort's integer.
  if ((unreadable ?? []).length > 0) return EXIT_UNMEASURED;
  return 0;
}

function main() {
  const apply = process.argv.includes("--apply");
  const alarm = process.argv.includes("--alarm");
  // Refused rather than merged, because the two readings of a post-apply
  // `enqueue` row are opposite: in an alarm run it means "nothing took this in
  // UNLANDED_ELIGIBLE_HOURS", in an applying run it means "this fire is taking
  // it right now". A combined mode would report the fire that RESCUED a PR as
  // the fire that stranded it.
  if (alarm && apply) {
    console.error("--alarm is a dry-run detector; it cannot be combined with --apply");
    process.exit(2);
  }
  const settleMinutes = settleMinutesFrom();
  const rotted = [];
  const stranded = [];
  const unreadable = [];
  const starved = [];
  const queued = [];

  // `finally`, because the cohort is the expensive half of the output and the
  // likeliest thrower is `fetchOpenPrs` — outside `runRepo`'s try, one list
  // call plus two per undecided PR, multiplied by the repo count, and in a dry
  // run the only `gh` traffic there is. The explicit call before `process.exit`
  // in `runRepo` stays: `exit` does not unwind, so this block never runs there.
  // PEN-5430: two lists, one sweep. `notify` is the set the fire may comment
  // in and must not land in; `targetRepos()` is unchanged, so an unset
  // LAND_CLEAN_PRS_NOTIFY_REPO leaves behaviour exactly as it was.
  const notify = new Set(notifyRepos());
  // PEN-5314. Captured rather than exited on, because `process.exit` does NOT
  // unwind: exiting from the catch would skip the `finally` and lose the
  // priority cohort that the repos already swept had earned. So the `finally`
  // runs first, then the unmeasured report, then the exit.
  let sweepError = null;
  try {
    sweepRepos(
      sweepOrder(targetRepos(), [...notify]),
      repoRunner({
        apply,
        settleMinutes,
        rotted,
        stranded,
        run: runRepo,
        notify,
        unreadable,
        starved,
        queued,
      }),
    );
  } catch (error) {
    sweepError = error;
  } finally {
    reportRotted(rotted);
    reportUnreadable(unreadable);
  }

  if (sweepError) {
    // ⛔ Fails CLOSED, and this is the direction that matters: the run exits
    // non-zero and says it measured nothing. It must never fall through to the
    // `alarm` block below, because reaching `alarmExitCode` with an empty
    // `stranded` would spend 0 — a confident all-clear printed over repos that
    // were never read. That is precisely the fail-open shape
    // `assertPrListComplete` exists to prevent one layer down.
    reportUnmeasured(sweepError, stranded, { alarm, starved, queued });
    process.exit(EXIT_UNMEASURED);
  }

  if (!apply) console.log("\n(dry run — pass --apply to act)");

  if (alarm && unreadable.length > 0) {
    console.error(
      `\nALARM: ${unreadable.length} repo(s) could not be listed, so this run asserts ` +
        `NOTHING about them — ${unreadable.join(", ")}.\n` +
        "The sweep continued and the repos below were read normally; these were not.",
    );
  }
  if (alarm && stranded.length > 0) {
    console.error(
      `\nALARM: ${stranded.length} PR(s) have been landable for over ` +
        `${UNLANDED_ELIGIBLE_HOURS}h and are still open — ${stranded.join(", ")}.\n` +
        "Nothing is holding them, so the landing routine is what has not run. " +
        "See the unlanded-eligible block above.",
    );
  }
  if (alarm && starved.length > 0) {
    console.error(
      `\nALARM: ${starved.length} PR(s) have been eligible for over ` +
        `${CAP_STARVED_HOURS}h and the per-fire cap has never once offered them ` +
        `a queue slot — ${starved.join(", ")}.\n` +
        "Nothing is holding them either; demand is simply outrunning " +
        `MAX_ENQUEUES_PER_FIRE (${MAX_ENQUEUES_PER_FIRE}). Re-running the routine will not ` +
        "reach them. See the cap-starved block above.",
    );
  }
  if (alarm && queued.length > 0) {
    console.error(
      `\nALARM: ${queued.length} PR(s) have been at the FRONT of a merge queue for over ` +
        `${STALE_ENQUEUE_HOURS}h — ${queued.join(", ")}.\n` +
        "Nothing is being asked of anyone: they are green, approved and already accepted by " +
        "GitHub. The queue is head-serialized, so EVERY entry behind one of these is blocked " +
        "and is reported nowhere — the landing routine carves a queued PR out of its own " +
        "unlanded-eligible cohort by design. The usual cause is a required check on the queue " +
        "branch that never reported. Land repos only; see the cohort's comment in `runRepo`.",
    );
  }
  if (alarm) process.exit(alarmExitCode(stranded, unreadable, starved, queued));
}

export function isMainModule(argvPath = process.argv[1], moduleUrl = import.meta.url) {
  return Boolean(argvPath) && resolve(argvPath) === fileURLToPath(moduleUrl);
}

if (isMainModule()) {
  main();
}
