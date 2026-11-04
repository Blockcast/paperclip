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
 * That ceiling is now being reached, which it was not when the cap was
 * chosen. Merged PRs per UTC day over 10-23..11-03 peaked at 52 (11-02),
 * with 44 on 10-29 and 40 on 10-30. A single classifier sample at
 * 2026-11-03T12:31Z produced 10 `enqueue` + 1 `already-enqueued` + 3
 * `cap:10-per-fire` -- a 14-PR eligible pool against a 10-PR budget -- and
 * the pool read at or above the cap on every hourly `landing-sweep` sample
 * from 08:29Z to 12:31Z.
 *
 * If that has to be fixed, fix it with fire FREQUENCY, not by raising this
 * number. Raising the cap buys throughput by spending the blast-radius
 * guarantee in the first paragraph, and spends it silently -- nothing about
 * a larger number announces that the safety margin moved. More fires at the
 * same cap leave the per-fire radius at exactly 10 and raise the daily
 * ceiling linearly, so the two concerns stay decoupled.
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
 * `already-enqueued` — bounded already, and by a better clock: a wedged
 * auto-merge request is reported as `stale-enqueue` off its own `enabledAt`
 * after STALE_ENQUEUE_HOURS. Adding it here would name one PR twice.
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
 * having already spent its retries. While a row reads UNKNOWN its state is
 * UNREAD, so claiming "nothing is holding this" about it would be a statement
 * the data does not support — and this cohort's whole content is that claim.
 *
 * The cost is one missed sample, not a blind spot: the condition persists for
 * hours, the sweep is hourly, and `stalledHolds` owns `mergestate:UNKNOWN`
 * outright from STALE_HOLD_HOURS. What is genuinely uncovered is a PR that
 * reads UNKNOWN on every sample between the two thresholds. Stated here
 * rather than papered over, because the fix for it is a better merge-state
 * read, not a looser predicate.
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
  "number,headRefOid,author,labels,isDraft,autoMergeRequest,reviewRequests";

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

function gh(args) {
  return ghWithRateLimitRetry(args);
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
  return rows.map((row) => {
    assertHeadSha(row, repo);
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
    const joined = { ...row, mergeStateStatus: states.get(row?.number) ?? "UNKNOWN" };
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
const BESPOKE_COMMENT_ACTIONS = new Set(["codeowner-review-requested", "stale-enqueue"]);

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

export function runRepo(
  repo,
  apply,
  settleMinutes,
  spent,
  rotted,
  stranded = [],
  starved = [],
  {
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
  } = {},
) {
  // PEN-5391. This signature has now grown a positional twice, and BOTH times
  // a caller's options bag silently bound to the NEW positional instead:
  // BLO-51665's rate-limit test (slot 6 -> `stranded`) and PEN-5430's
  // `repoRunner` spread (slot 7 -> `starved`). Neither threw. `fetch` simply
  // fell back to the real `fetchOpenPrs`, so the test issued a LIVE GraphQL
  // call and asserted against whatever GitHub returned — green, and testing
  // nothing. The cost is not hypothetical: `landing-sweep.yml` runs this
  // suite before the hourly sweep, so a wedged arity takes the sweep with it.
  //
  // So reject the shape rather than trusting the next inserter to notice. An
  // options bag is a plain object and `starved` is an array; a mis-bound
  // caller dies here, loudly, naming the slot, instead of quietly going live.
  if (!Array.isArray(starved)) {
    throw new TypeError(
      "runRepo: `starved` (7th positional) must be an array — received " +
        `${starved === null ? "null" : typeof starved}. A caller passing its ` +
        "options bag in slot 7 is the usual cause; the bag is slot 8.",
    );
  }
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
        process.exit(1);
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
export const repoRunner =
  (
    apply,
    settleMinutes,
    rotted,
    stranded = [],
    run = runRepo,
    notify = new Set(),
    // PEN-5442. Repos this fire could not read, by the same
    // collected-by-reference convention as `rotted`/`stranded`: `main` reports
    // it after the sweep and `alarmExitCode` reads it. A CONSTRUCTOR argument
    // ONLY: `unreadable` is never threaded into the per-repo vector, because
    // the condition it records — the repo could not be listed — is observed
    // out here, where the throw is caught, and is never visible inside
    // `runRepo`.
    unreadable = [],
    // PEN-5391. The cap-starved cohort, same collected-by-reference
    // convention. APPENDED as the 8th rather than inserted, so PEN-5442's
    // `unreadable` keeps the 7th and `run`/`notify` do not move: every
    // existing positional call site stays correct by construction, which is
    // what made the PEN-5442 shape safe and is worth preserving rather than
    // re-earning. Unlike `unreadable` this one IS threaded through to
    // `runRepo` — a cap deferral is observed per PR inside the sweep
    // (`starved.push` sits beside `stranded.push`), not out here.
    starved = [],
  ) =>
  (repo, spent) => {
    // Spread rather than an unconditional trailing argument, so a fire with
    // no notify list calls `runRepo` with exactly the positionals it needs and
    // no `undefined` in the bag's slot.
    //
    // PEN-5391 moved `runRepo`'s options bag from slot 7 to slot 8, because
    // `starved` is now `runRepo`'s 7th positional. Note this is `runRepo`'s
    // numbering, NOT `repoRunner`'s — `starved` is `repoRunner`'s 8th
    // constructor argument, and the two vectors are different lengths. Reading
    // one function's slot number as the other's is exactly how this collision
    // was first miscounted.
    //
    // Both of this file's last two parameter insertions bound a caller's
    // options bag to the new positional in silence (BLO-51665's rate-limit
    // test, then this spread), so `runRepo` opens with an
    // `Array.isArray(starved)` throw naming the slot, which fails the suite
    // rather than letting a third one through.
    const options = notify.has(repo) ? [{ landable: false }] : [];
    let rows;
    try {
      rows = run(repo, apply, settleMinutes, spent, rotted, stranded, starved, ...options);
    } catch (error) {
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
 * The exit code for an alarm run: 1 when any repo carried an unlanded-eligible
 * or a cap-starved PR, 0 otherwise.
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
 * repo that went unread makes the alarm red on its own.
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
 */
export function alarmExitCode(stranded, unreadable = [], starved = []) {
  return (stranded ?? []).length > 0 ||
    (unreadable ?? []).length > 0 ||
    (starved ?? []).length > 0
    ? 1
    : 0;
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

  // `finally`, because the cohort is the expensive half of the output and the
  // likeliest thrower is `fetchOpenPrs` — outside `runRepo`'s try, one list
  // call plus two per undecided PR, multiplied by the repo count, and in a dry
  // run the only `gh` traffic there is. The explicit call before `process.exit`
  // in `runRepo` stays: `exit` does not unwind, so this block never runs there.
  // PEN-5430: two lists, one sweep. `notify` is the set the fire may comment
  // in and must not land in; `targetRepos()` is unchanged, so an unset
  // LAND_CLEAN_PRS_NOTIFY_REPO leaves behaviour exactly as it was.
  const notify = new Set(notifyRepos());
  try {
    sweepRepos(
      sweepOrder(targetRepos(), [...notify]),
      repoRunner(apply, settleMinutes, rotted, stranded, runRepo, notify, unreadable, starved),
    );
  } finally {
    reportRotted(rotted);
    reportUnreadable(unreadable);
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
  if (alarm) process.exit(alarmExitCode(stranded, unreadable, starved));
}

export function isMainModule(argvPath = process.argv[1], moduleUrl = import.meta.url) {
  return Boolean(argvPath) && resolve(argvPath) === fileURLToPath(moduleUrl);
}

if (isMainModule()) {
  main();
}
