#!/usr/bin/env node
// BLO-23395: PR #1092 sat evicted from the merge queue for 9h13m unnoticed
// because a `CONFLICTING`/un-stageable rebase evicts a queue entry without a
// failing check, a PR comment, or a check-run -- the only trace is a
// `removed_from_merge_queue` timeline event. This classifies that shape apart
// from the two the queue already surfaces on its own (a failing required
// check; a manual/administrative dequeue), using the same signal the incident
// investigation used: whether the queue ever built a `merge_group` run for
// this PR's head at all.
import { execFileSync } from "node:child_process";

const RUN_LIST_LIMIT = 500;
const WINDOW_BUFFER_MS = 5 * 60 * 1000;
// Ally review #1220 (4th pass): a dequeue event that hasn't replicated to the
// /timeline endpoint yet must not be treated as absent forever -- retry a
// short, bounded number of times before declining to classify. Total added
// latency (15s) is negligible against the 15-minute notification budget and
// the workflow's own 5-minute job timeout.
const DEQUEUE_REPLICATION_RETRIES = 3;
const DEQUEUE_REPLICATION_RETRY_DELAY_MS = 5000;

// PEN-4887: how soon after its head moved a PR must have been enqueued for the
// eviction to read as an admission rejection rather than an un-stageable
// rebase. 2 minutes is deliberately generous against the measured case (4s on
// #3060) and still far below any legitimate enqueue: a PR enqueued because its
// checks went green was necessarily waiting on them for minutes first.
const ADMISSION_FRESH_HEAD_MS = 2 * 60 * 1000;

// Mirrors server/src/services/paperclip-identifiers.ts's PAPERCLIP_IDENTIFIER_PATTERN,
// but case-insensitive: this repo's branch-naming convention is lowercase
// (e.g. `blo-23395-merge-queue-eviction-detector`), and this function's whole
// job is recovering an identifier from that branch name, not just from
// title/body text an agent may have typed in canonical case. Always emits
// the canonical uppercase form so the webhook's case-sensitive extractor
// matches it back out of the comment text this script posts.
// Duplicated (not imported) because this script runs standalone via `node`
// with no build step, outside the server's TS project. Keep the two in sync.
const PAPERCLIP_IDENTIFIER_PATTERN = /\b([a-z][a-z0-9]{1,9}-\d{1,6}(?:\/\d{1,6})*)\b/gi;
const PAPERCLIP_COMPACT_IDENTIFIER_PATTERN = /^([a-z][a-z0-9]{1,9})-(\d{1,6})((?:\/\d{1,6})*)$/i;
// PEN-6137: mirrors the CVE guard in the same module. `CVE-2026-59873` matches
// the pattern above as `CVE-2026` -- the prefix class takes `CVE`, the digits
// take `2026`, and `\b` is satisfied by the following `-`. This script emits
// whatever it extracts into a comment body that the webhook's extractor then
// reads back out, so an unguarded copy here reintroduces the bogus owning
// identifier by the long way round.
const CVE_IDENTIFIER_PATTERN = /^CVE-\d{4}-\d{4,}/i;

function expandPaperclipIdentifierToken(token) {
  const match = token.match(PAPERCLIP_COMPACT_IDENTIFIER_PATTERN);
  if (!match) return [token.toUpperCase()];
  const prefix = match[1].toUpperCase();
  const tailNumbers = (match[3] ?? "").split("/").filter(Boolean);
  return [match[2], ...tailNumbers].map((number) => `${prefix}-${number}`);
}

/**
 * Ally review #1220 (4th pass): the webhook's `issue_comment` handler
 * extracts identifiers from the PR's title/body/comment text, but the
 * `issue_comment` payload carries no branch name -- a PR linked to Paperclip
 * only through its branch (no ticket ref in the title or body) is dropped as
 * `no_paperclip_identifier` and never wakes anyone. Embedding the identifier
 * directly in this comment's own body closes that gap without touching the
 * shared webhook extractor, since `commentBody` is already one of its
 * sources.
 */
export function extractPaperclipIdentifiers(...sources) {
  const found = new Set();
  for (const source of sources) {
    if (!source) continue;
    for (const match of source.matchAll(PAPERCLIP_IDENTIFIER_PATTERN)) {
      if (!match[1]) continue;
      const tokenStart = match.index + (match[0].length - match[1].length);
      if (CVE_IDENTIFIER_PATTERN.test(source.slice(tokenStart))) continue;
      for (const id of expandPaperclipIdentifierToken(match[1])) found.add(id);
    }
  }
  return Array.from(found);
}

/**
 * The merge queue stages a PR onto a synthetic branch named
 * `gh-readonly-queue/<base>/pr-<number>-<sha>` and runs `merge_group` checks
 * against it. The trailing "-" after the PR number is load-bearing: without
 * it, PR 1092 would also match a run staged for PR 10920.
 */
export function mergeQueueHeadBranchPrefix(base, prNumber) {
  return `gh-readonly-queue/${base}/pr-${prNumber}-`;
}

export function filterMergeGroupRunsForPr(runs, { base, prNumber }) {
  const prefix = mergeQueueHeadBranchPrefix(base, prNumber);
  return (runs ?? []).filter(
    (run) => typeof run?.headBranch === "string" && run.headBranch.startsWith(prefix),
  );
}

/**
 * The login of a timeline event's actor, in whichever of the two shapes the
 * caller happens to hold, or `null` when no usable attribution is present.
 *
 * PEN-5592 (Ally review, PR #3399): this exists because the two callers of
 * `selectLatestQueueAttemptWindow` did NOT hold the same shape, and the
 * mismatch was silent and total.
 *   - `ghTimeline` below flattens first, via `--jq '{..., actor: .actor.login}'`,
 *     so it passes a STRING.
 *   - `report-merge-queue-ejection.mjs` reads `GET /issues/{n}/timeline`
 *     through `fetch` and passes the response through untouched. That endpoint
 *     returns `actor` as an OBJECT (`{login, type, ...}`) -- verified live on
 *     #3371, where all four merge-queue events carry `actor` of type object.
 * The old inline `typeof e.actor === "string" ? e.actor : null` therefore read
 * every REST-shaped actor as `null`, `isQueueInitiatedRemoval(null)` answered
 * `true`, and the reporter posted the "job timeout ... re-enqueue the PR"
 * notice exactly as it did before the guard existed.
 *
 * Normalizing HERE rather than at each call site is the structural half of the
 * fix: this is the one chokepoint both callers already pass through, so a third
 * caller cannot reintroduce the drift by forgetting to map. It is idempotent by
 * construction -- a string passes through, an object is unwrapped -- so the
 * flattened and raw shapes are interchangeable at every entry point.
 *
 * Blank and non-string logins collapse to `null`, which is the fail-TOWARD-
 * reporting direction: no attribution means the caller falls back to its
 * pre-attribution verdict rather than suppressing a genuine eviction.
 *
 * @param {string | { login?: unknown } | null | undefined} actor
 * @returns {string | null}
 */
export function timelineActorLogin(actor) {
  const login = typeof actor === "string" ? actor : actor?.login;
  return typeof login === "string" && login.trim().length > 0 ? login : null;
}

/**
 * A PR can enter the merge queue more than once (e.g. a failed attempt gets
 * fixed and manually re-added). Ally review #1220: matching every historical
 * `merge_group` run for this PR number on this base -- rather than just the
 * attempt that just ended -- lets an earlier attempt's outcome leak into
 * today's classification (a prior failure reads as `check_failure` for a
 * later un-stageable eviction, or vice versa). This finds the boundaries of
 * the MOST RECENT enqueue/dequeue pair so the run lookup can be bounded to
 * it.
 *
 * `now` must be captured when this run was triggered (before any
 * merge-race grace-period sleep), not when this function is called. Ally
 * review #1220 (third pass): the detector sleeps up to `graceMs` before
 * reading the timeline; a PR re-added to the queue during that sleep adds a
 * fresh `added_to_merge_queue` event with no run yet. Picking "whatever is
 * latest by the time we wake up" would jump onto that brand-new attempt and
 * misclassify it `conflict_unstageable` instead of classifying the actual
 * dequeue that triggered this run. Filtering enqueue candidates to
 * `at <= now` keeps the window anchored to the attempt that had already
 * ended when the triggering webhook fired.
 *
 * `dequeuedAt` is never fabricated. Ally review #1220 (4th pass): the
 * `/timeline` endpoint can lag behind the `pull_request.dequeued` webhook
 * that triggered this run -- substituting `now` when no removal is observed
 * yet let an active or freshly-requeued attempt with no run be misread as a
 * `conflict_unstageable` eviction that never happened. `dequeuedAt: null`
 * signals "enqueue found, no removal observed yet" so the caller can retry
 * instead of guessing.
 *
 * @param {Array<{ event: string, created_at: string, actor?: string | { login?: unknown } | null }>} timelineEvents
 *   `actor` may arrive flattened (a string) or raw from the REST timeline
 *   (an object); `timelineActorLogin` normalizes both. See PEN-5592.
 * @param {{ now: number }} opts
 * @returns {{ enqueuedAt: string, dequeuedAt: string | null, dequeuedBy: string | null } | null}
 *   `dequeuedBy` is the actor of the removal this window anchored to, and is
 *   load-bearing: it is the sole input to `isQueueInitiatedRemoval`, which is
 *   what separates a genuine eviction from a deliberate hold (PEN-3926).
 *   `null` means no attribution was available, which fails back to the
 *   pre-PEN-3926 `conflict_unstageable` verdict.
 */
export function selectLatestQueueAttemptWindow(timelineEvents, { now }) {
  const events = (timelineEvents ?? [])
    .filter((e) => e && typeof e.event === "string" && typeof e.created_at === "string")
    .map((e) => ({
      event: e.event,
      at: new Date(e.created_at).getTime(),
      // PEN-3926: an unattributable actor stays `null` so the classifier can
      // tell "no attribution available" apart from a named actor and fall
      // back to the pre-PEN-3926 verdict. PEN-5592: the shape normalization
      // lives in the shared helper so the flattened (`--jq`) and raw REST
      // callers cannot drift apart again.
      actor: timelineActorLogin(e.actor),
    }))
    .filter((e) => Number.isFinite(e.at))
    .sort((a, b) => a.at - b.at);

  const enqueues = events.filter((e) => e.event === "added_to_merge_queue" && e.at <= now);
  if (enqueues.length === 0) return null;
  const lastEnqueue = enqueues[enqueues.length - 1];

  // The next removal at or after that enqueue -- not the last removal
  // overall, which could belong to a still-later attempt this event hasn't
  // learned about yet, or (defensively) precede the enqueue we picked.
  const dequeueAfter = events.find(
    (e) => e.event === "removed_from_merge_queue" && e.at >= lastEnqueue.at,
  );

  return {
    enqueuedAt: new Date(lastEnqueue.at).toISOString(),
    dequeuedAt: dequeueAfter ? new Date(dequeueAfter.at).toISOString() : null,
    // PEN-3926: who performed the removal this window anchored to. `null`
    // when no removal is observed yet, or when the timeline carried no
    // attributable actor.
    dequeuedBy: dequeueAfter ? dequeueAfter.actor : null,
  };
}

/**
 * Formats a `gh run list --created` range around the attempt window, with a
 * buffer on each side for clock skew between the queue staging a run and the
 * timeline event landing.
 *
 * Ally review #1220 (5th pass): throws rather than silently emitting a
 * 1970-epoch bound. `selectLatestQueueAttemptWindow` can legitimately return
 * `dequeuedAt: null`, and `new Date(null).getTime()` is `0` -- so the old
 * version turned "no removal observed yet" into a range ending in 1970, which
 * matches no runs and reads as a genuine zero-run (`conflict_unstageable`)
 * result. `main` guards this case, but the two are exported independently and
 * a caller that skips the guard must fail loudly, not classify from a bogus
 * window.
 */
export function buildRunSearchWindow({ enqueuedAt, dequeuedAt }, bufferMs = WINDOW_BUFFER_MS) {
  const enqueuedMs = new Date(enqueuedAt).getTime();
  const dequeuedMs = new Date(dequeuedAt).getTime();
  if (!Number.isFinite(enqueuedMs) || !Number.isFinite(dequeuedMs) || dequeuedAt === null) {
    throw new TypeError(
      `buildRunSearchWindow requires a complete attempt window; got enqueuedAt=${JSON.stringify(enqueuedAt)} ` +
        `dequeuedAt=${JSON.stringify(dequeuedAt)}`,
    );
  }
  const since = new Date(enqueuedMs - bufferMs).toISOString();
  const until = new Date(dequeuedMs + bufferMs).toISOString();
  return `${since}..${until}`;
}

/**
 * GitHub attributes a removal the merge queue performed itself to this login.
 * A removal carrying any other actor was performed by a human or an App.
 * (BLO-40351 measured the same split from the other side: over this
 * workflow's full 108-run history, every eviction was attributed to this
 * actor and every successful merge to a human/App, with no actor on both
 * sides. See `.github/workflows/merge-queue-eviction-detector.yml`'s header.)
 */
export const MERGE_QUEUE_REMOVAL_ACTOR = "github-merge-queue[bot]";

/**
 * PEN-3926: fails TOWARD the pre-PEN-3926 verdict. An absent, empty or
 * non-string actor returns `true` (treat as queue-initiated), so a timeline
 * that stops carrying `actor` -- or a caller that does not thread it --
 * classifies exactly as it did before, and this can never make a genuine
 * eviction quieter. Only a positively-identified non-queue actor is allowed
 * to change a verdict.
 *
 * @param {string | null | undefined} dequeueActor
 */
export function isQueueInitiatedRemoval(dequeueActor) {
  if (typeof dequeueActor !== "string") return true;
  const actor = dequeueActor.trim();
  if (actor.length === 0) return true;
  return actor.toLowerCase() === MERGE_QUEUE_REMOVAL_ACTOR.toLowerCase();
}

/**
 * PEN-4887: the third cause of a zero-`merge_group`-run eviction, which the
 * classifier below did not model and reported as an un-stageable rebase.
 *
 * The queue can ADMIT an entry and then eject it because the PR does not meet
 * its merge requirements. That also stages no `merge_group` run, so run count
 * alone cannot tell it apart from a branch the queue could not rebase -- and
 * reporting it as the latter sends the reader to rebase a branch that is zero
 * commits behind its base (measured on #3060: merge base IS `master`'s head).
 *
 * The shape is deterministic, not a marginal race. Landing a STACKED child PR
 * moves the parent's head to the merge commit; enqueuing the parent seconds
 * later enqueues a head on which nothing has run yet. On #3060 the head moved
 * at 07:46:13Z, the enqueue landed at 07:46:17Z (+4s) and the queue ejected it
 * at 07:46:27Z -- while `ci/ally-head-attested` did not succeed until
 * 07:48:37Z, 2m10s after the removal.
 *
 * ## Why this is not the forbidden `mergeable` check
 *
 * It never asks whether the tree merges. It asks two questions about TIME,
 * both answerable from timestamps this script already has or can read
 * SHA-pinned:
 *
 *   1. how long before the enqueue did this PR's head commit appear, and
 *   2. at the instant of removal, had the head's checks finished reporting?
 *
 * A `REBASE`-unstageable eviction reads `mergeable: CLEAN` (the trap at the
 * docblock below) but it does NOT read "head four seconds old": a PR enqueued
 * because its checks went green necessarily waited minutes for them first. So
 * the trap stays closed -- see runbooks/merge-queue-stalled-head.md
 * ("A fourth eviction cause...", BLO-19566/#920).
 *
 * ## Why "zero completed checks" is NOT the test on its own
 *
 * Measured on #3060's head at the 07:46:27Z removal instant: two commit
 * STATUS contexts had already succeeded -- `gate/ally-comment-findings`
 * (07:46:19Z, re-posted 07:46:23Z) and `review/ally-comment` (07:46:21Z,
 * re-posted 07:46:24Z) -- while every CHECK RUN was still unstarted. A bare
 * "nothing has completed" predicate is therefore false on the very case this
 * exists to catch. The fresh-head window is the signal; incompleteness is the
 * corroborating guard, and is phrased existentially ("something had not
 * finished") rather than universally.
 *
 * Counts below are per CONTEXT, not per status post -- see the dedupe comment
 * in the body for why those differ and why it is the dequeue instant, not the
 * read, that the collapse is anchored to.
 *
 * Completion is judged AT THE DEQUEUE INSTANT, not at read time. This script
 * runs minutes later, by which point the head's checks have usually finished;
 * comparing `completedAt <= dequeuedAt` keeps the verdict anchored to what was
 * knowable when the queue ruled.
 *
 * Fails toward the pre-PEN-4887 verdict, the same discipline PEN-3926 applied:
 * returns `null` -- "no usable evidence" -- for a missing check list or any
 * unparseable timestamp, and the caller then classifies exactly as before.
 * This can never make a genuine eviction quieter.
 *
 * @param {{
 *   headChecks?: Array<{
 *     id?: number | string | null,
 *     name?: string | null,
 *     conclusion?: string | null,
 *     completedAt?: string | null,
 *     surface?: string | null,
 *   }> | null,
 *   headCommittedAt?: string | null,
 *   enqueuedAt?: string | null,
 *   dequeuedAt?: string | null,
 *   freshHeadMs?: number,
 * }} input
 * @returns {{
 *   rejected: boolean,
 *   headAgeAtEnqueueMs: number,
 *   completedByDequeue: number,
 *   incompleteAtDequeue: string[],
 *   checkCount: number,
 * } | null} `checkCount`/`completedByDequeue` count distinct contexts, never
 *   status posts; `incompleteAtDequeue` lists the distinct NAMES those
 *   contexts carry, which is what branch protection requires by
 */
export function classifyAdmissionEvidence({
  headChecks = null,
  headCommittedAt = null,
  enqueuedAt = null,
  dequeuedAt = null,
  freshHeadMs = ADMISSION_FRESH_HEAD_MS,
} = {}) {
  if (!Array.isArray(headChecks)) return null;
  const headMs = Date.parse(headCommittedAt ?? "");
  const enqueuedMs = Date.parse(enqueuedAt ?? "");
  const dequeuedMs = Date.parse(dequeuedAt ?? "");
  if (!Number.isFinite(headMs) || !Number.isFinite(enqueuedMs) || !Number.isFinite(dequeuedMs)) return null;

  const headAgeAtEnqueueMs = enqueuedMs - headMs;
  // A head that post-dates the enqueue belongs to a LATER push than the attempt
  // this window anchored to, so these checks describe a different head. Decline
  // rather than reason about evidence that is not the queue's.
  if (headAgeAtEnqueueMs < 0) return null;

  // PEN-4887 (Ally review, 2nd pass): `GET commits/{sha}/statuses` returns the
  // full status HISTORY -- one row per post -- not the latest state per
  // context. Measured on #3060's head `87a87dc0`: `gate/ally-comment-findings`
  // and `review/ally-comment` each carry FOUR rows (07:46:19Z/07:46:23Z, then
  // re-posted at 07:48:30Z/07:48:35Z). Classifying row by row counted posts
  // rather than contexts, and listed both of those contexts under "not
  // complete at removal" on the strength of their 07:48 re-posts -- though
  // both had succeeded before the 07:46:27Z removal. The cause line is this
  // notice's whole deliverable, so it must not name a finished check as
  // unfinished.
  //
  // Collapse to one row per context first, keeping the latest row AT OR BEFORE
  // `dequeuedAt`. That anchor is why the combined endpoint
  // (`commits/{sha}/status`, `.statuses[]`) is not the fix: its "latest" is
  // the latest OVERALL, which on #3060 is the 07:48:35Z re-post -- after the
  // removal -- so both contexts would still read as incomplete. Only the
  // history carries the time axis this needs.
  /** @type {Map<string, {name: string, surface: string, at: number, terminal: boolean}>} */
  const byContext = new Map();
  for (const check of headChecks) {
    const rawName = typeof check?.name === "string" ? check.name.trim() : "";
    const name = rawName.length > 0 ? rawName : "<unnamed>";
    // The two surfaces have DIFFERENT identity semantics, so each is keyed the
    // way its own API reports it.
    //
    // A check run and a commit status can carry the same name, and on #3060's
    // head two of them do: `gate/ally-comment-findings` is a status that
    // succeeded at 07:46:23Z, before the removal, AND a check run that did not
    // conclude until 07:48:35Z, after it. They are separate contexts, so they
    // are never collapsed into each other -- doing so would let the green
    // status hide the unfinished check run, the fail-OPEN direction.
    //
    // Within `/check-runs` a name is ALSO not an identity: `filter=latest`
    // (the default) already yields the newest run per check run, so two rows
    // sharing a name are two genuinely distinct runs -- separate lanes, or
    // `pull_request` and `pull_request_target` publishing the same name.
    // Measured on this script's own head `de82d2d`: `review` appears twice,
    // check runs 122712076437 and 122711949261, in different check suites.
    // Collapsing those by name would let a finished lane stand in for an
    // in-flight sibling (`completedAt: null`, skipped below) and drop it from
    // the cause line. So check runs key on their run `id` and nothing is
    // collapsed; only STATUSES collapse by name, because only `/statuses`
    // returns a history whose rows share one context.
    const surface = typeof check?.surface === "string" ? check.surface : "";
    const identity = check?.id === undefined || check?.id === null ? name : String(check.id);
    const key = `${surface}\u0000${identity}`;
    if (!byContext.has(key)) byContext.set(key, { name, surface, at: -Infinity, terminal: false });
    const at = Date.parse(check?.completedAt ?? "");
    // A row posted after the dequeue says nothing about what the queue could
    // see. The context stays unreported unless an earlier row reported it.
    if (!Number.isFinite(at) || at > dequeuedMs) continue;
    // A commit status is reported in one shot, so `pending` carries a
    // timestamp like any other state. Without this it would count as a
    // completion and weaken the guard in the fail-open direction.
    const terminal = String(check?.conclusion ?? "").toLowerCase() !== "pending";
    const best = byContext.get(key);
    // Latest row wins. On an identical timestamp the TERMINAL row wins, which
    // counts the context as completed and so makes `rejected` LESS likely --
    // the same fail-toward-the-old-verdict direction as everything else here.
    if (at > best.at || (at === best.at && terminal && !best.terminal)) {
      best.at = at;
      best.terminal = terminal;
    }
  }

  // Where one name exists on both surfaces, say which is which. The notice
  // prints these verbatim, and an unqualified name listed as unfinished beside
  // an identically-named one that finished reads exactly like the defect this
  // dedupe fixes. Unambiguous names stay bare.
  const surfacesPerName = new Map();
  for (const { name, surface } of byContext.values()) {
    if (!surfacesPerName.has(name)) surfacesPerName.set(name, new Set());
    surfacesPerName.get(name).add(surface);
  }
  const label = ({ name, surface }) =>
    surface.length > 0 && surfacesPerName.get(name).size > 1
      ? `${name} (${surface === "check_run" ? "check run" : surface})`
      : name;

  // COUNTS are per context; NAMES are the distinct required contexts those
  // counts refer to, and the two can legitimately differ -- two `review` lanes
  // that both failed to finish are two contexts but one unmet requirement, and
  // branch protection requires by NAME. Printing the same name twice would
  // read as the duplicate-row defect this collapse exists to fix, so the name
  // list is de-duplicated for display while `checkCount` and
  // `completedByDequeue` keep counting contexts.
  //
  // Only the INCOMPLETE names are collected. The notice reports completions as
  // a bare count ("2 of 28 ... had completed") and names only what was unmet,
  // so a matching set of completed names would be built on every call and read
  // by nobody.
  let completedContexts = 0;
  let incompleteContexts = 0;
  const incomplete = new Set();
  for (const context of byContext.values()) {
    if (context.terminal) completedContexts += 1;
    else {
      incompleteContexts += 1;
      incomplete.add(label(context));
    }
  }

  return {
    // `incompleteContexts > 0` and `incomplete.size > 0` are equivalent here --
    // a name is added exactly when a context is counted -- so the choice is
    // about intent, not behaviour: the guard is "some CONTEXT had not finished
    // reporting", and the de-duplicated name list is a display concern.
    rejected: headAgeAtEnqueueMs <= freshHeadMs && incompleteContexts > 0,
    headAgeAtEnqueueMs,
    completedByDequeue: completedContexts,
    incompleteAtDequeue: [...incomplete],
    checkCount: byContext.size,
  };
}

/**
 * PEN-6460: the sentinel `ghRunHasFailedJob` returns when it could not read a
 * run's job list at all. It is deliberately a string and not `null`/`false`:
 * the BLO-51600 probe answered `false` on a read failure, which is the same
 * value a genuinely clean run produces, so "I could not look" and "I looked
 * and nothing failed" were indistinguishable and both landed on `manual` --
 * a verdict that names a person as the cause.
 */
export const HAS_FAILED_JOB_UNKNOWN = "unknown";

/**
 * PEN-6460: GitHub states why it removed an entry from the merge queue, on
 * the timeline's `RemovedFromMergeQueueEvent.reason`. Everything else this
 * module classifies from is an inference -- run counts, run conclusions, the
 * removal actor -- and #3591 (2026-11-10T22:41:30Z) is the case where every
 * inference was false and the report was right: `reason: "failed_checks"`
 * against a `merge_group` run that read `cancelled`, reported to its reader
 * as a "manual / administrative dequeue" with an instruction to go and find
 * whoever dequeued it. Nobody had.
 *
 * NOTE -- the field is REST-INVISIBLE. `GET /repos/:o/:r/issues/:n/timeline`
 * returns a `removed_from_merge_queue` event with keys
 * `[actor, commit_id, commit_url, created_at, event, id, node_id,
 * performed_via_github_app, url]` and NO `reason` -- measured first-party on
 * #3591, 2026-11-10. Only the GraphQL node carries it, which is why
 * `ghDequeueReason` below is the single GraphQL call in an otherwise
 * REST-only script. Do not "simplify" it back onto the REST timeline the rest
 * of this module reads; the field is simply not there.
 *
 * NOTE -- and do not take the ACTOR from that GraphQL node while you are there:
 * GraphQL renders it `github-merge-queue` where REST renders
 * `github-merge-queue[bot]`, and `MERGE_QUEUE_REMOVAL_ACTOR` -- the sole
 * input to `isQueueInitiatedRemoval` -- is the REST spelling. Swapping the
 * source would silently make every queue-initiated removal look
 * human-initiated. Both spellings measured on #3591.
 *
 * `reason` is a nullable `String` in the schema, NOT an enum, so its value
 * space is not introspectable and this map is necessarily a sample. Measured
 * on `Blockcast/paperclip` 2026-11-10 over the 60 most-recently-updated PRs,
 * 29 removals: `failed_checks` 15, `merged` 7, `merge_conflict` 6, `manual`
 * 1. An unrecognised or absent reason maps to `null` and changes nothing --
 * the inference ladder runs exactly as it did before.
 */
export const MERGE_QUEUE_DEQUEUE_REASON_CAUSES = Object.freeze({
  merged: "merged",
  failed_checks: "check_failure",
  merge_conflict: "conflict_unstageable",
  manual: "manual",
});

/**
 * @param {string | null | undefined} reason
 * @returns {"merged" | "check_failure" | "conflict_unstageable" | "manual" | null}
 */
export function causeFromDequeueReason(reason) {
  if (typeof reason !== "string") return null;
  const key = reason.trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(MERGE_QUEUE_DEQUEUE_REASON_CAUSES, key)
    ? MERGE_QUEUE_DEQUEUE_REASON_CAUSES[key]
    : null;
}

/**
 * Picks the removal this run's attempt window anchored to, out of every
 * `RemovedFromMergeQueueEvent` on the PR. A PR can be enqueued and evicted
 * many times -- #3591 carried three queue attempts on 2026-11-10 alone -- so
 * taking "the last removal" would read a different attempt's reason onto this
 * one, which is the exact failure `selectLatestQueueAttemptWindow` exists to
 * avoid on the REST side.
 *
 * Matched at SECOND resolution rather than on the raw strings: the two
 * surfaces render the same instant independently (`created_at` vs
 * `createdAt`) and a sub-second difference must not silently drop the
 * enhancement. Two removals on one PR inside one second is not a shape this
 * queue produces.
 *
 * @param {Array<{ createdAt?: string, reason?: string | null }>} removalEvents
 * @param {string | null} dequeuedAt
 * @returns {string | null} the raw reason string, lower-cased, or `null`
 */
export function selectDequeueReasonAt(removalEvents, dequeuedAt) {
  if (typeof dequeuedAt !== "string") return null;
  const target = new Date(dequeuedAt).getTime();
  if (!Number.isFinite(target)) return null;
  const targetSecond = Math.floor(target / 1000);
  const match = (removalEvents ?? []).find((event) => {
    const at = new Date(event?.createdAt).getTime();
    return Number.isFinite(at) && Math.floor(at / 1000) === targetSecond;
  });
  const reason = match?.reason;
  if (typeof reason !== "string") return null;
  const trimmed = reason.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Deliberately takes no `mergeable`/`mergeStateStatus` input. On a `REBASE`
 * merge queue (this repo's configuration: `mergeMethod: REBASE`), a PR can
 * read `mergeable: CLEAN` throughout an eviction -- the final tree merges
 * fine -- while one of its individual commits fails to *replay* onto a
 * `master` that has moved on, which is exactly what evicts it. Classifying
 * from `merge_group` run count sidesteps that trap entirely: a `REBASE`-
 * unstageable eviction produces zero runs, same as a plain-conflict
 * eviction, so both correctly resolve to `conflict_unstageable` without
 * this function ever needing to know which one occurred. See
 * runbooks/merge-queue-stalled-head.md ("A fourth eviction cause...",
 * BLO-19566/#920) before adding a `mergeable`-based check here.
 *
 * PEN-3926 adds `dequeueActor`, which is NOT that forbidden check: it reads
 * who performed the removal, not whether the tree merges. The prohibition
 * above stands -- a `REBASE`-unstageable eviction still reads `CLEAN`, and
 * nothing here consults `mergeable`. The actor is a different signal, and
 * the only one that separates "the queue could not stage this" from "a
 * person took it out on purpose", both of which produce zero runs.
 *
 * PEN-4887 adds `admissionEvidence`, which is NOT that forbidden check either:
 * it reads how old the head was when the queue admitted it and whether that
 * head's checks had finished reporting by the removal, never whether the tree
 * merges. See `classifyAdmissionEvidence` above for why the trap stays closed.
 *
 * PEN-6460 adds `dequeueReason`, which is NOT that forbidden check either:
 * it is GitHub's own stated reason for the removal, read off the timeline's
 * `RemovedFromMergeQueueEvent`, and says nothing about whether the tree
 * merges. It is the only input here that is a REPORT rather than an
 * inference -- every other signal in this function is reconstructed from run
 * counts, run conclusions and actors. See `causeFromDequeueReason` for the
 * measured value space and for why it is not trusted in the zero-run branch.
 *
 * @param {{
 *   merged: boolean,
 *   mergeGroupRuns: Array<{ conclusion: string | null, hasFailedJob?: boolean | "unknown" }>,
 *   truncated?: boolean,
 *   dequeueActor?: string | null,
 *   dequeueReason?: string | null,
 *   admissionEvidence?: ReturnType<typeof classifyAdmissionEvidence>,
 * }} input
 * @returns {"merged" | "conflict_unstageable" | "requirements_unmet" | "check_failure" | "manual" | "unknown"}
 */
export function classifyMergeQueueEviction({
  merged,
  mergeGroupRuns,
  truncated = false,
  dequeueActor = null,
  dequeueReason = null,
  admissionEvidence = null,
}) {
  const reasonCause = causeFromDequeueReason(dequeueReason);
  if (merged) return "merged";
  // PEN-6460: `reason: "merged"` is the queue saying it removed the entry
  // BECAUSE it merged the PR. `pr.merged` is read from a different surface
  // and can still be lagging after the grace window, and when it is, every
  // branch below produces an eviction notice for a PR that landed. Measured
  // 2026-11-10 over 29 removals on this repo: 7 carried this reason and all
  // 7 were successful merges.
  if (reasonCause === "merged") return "merged";
  // Ally review #1220: a `gh run list` sample that hit its cap is not proof
  // of absence. Only trust "zero runs found" -> conflict_unstageable when
  // the sample is known-complete; otherwise say so explicitly rather than
  // guessing wrong with confidence.
  if (truncated && (!mergeGroupRuns || mergeGroupRuns.length === 0)) return "unknown";
  // The queue never staged this PR at all. Zero runs has TWO causes, and
  // run count alone cannot separate them:
  //
  //   - GitHub could not construct a merge_group run for it (un-stageable
  //     rebase, dirty tree) -- the BLO-23395 shape, where no failing check
  //     exists to explain the eviction because no check ever ran; or
  //   - someone removed the PR from the queue BEFORE the queue got as far as
  //     staging a run -- a deliberate hold, on a branch that is typically
  //     perfectly mergeable.
  //
  // PEN-3926: reporting the second as the first told readers of 4 of 5
  // removals on #2331 to "rebase onto the current base" against a branch
  // that read `mergeable: MERGEABLE`/`CLEAN` throughout, each within minutes
  // of its author announcing the hold on the thread. The removal actor is
  // the discriminator; absent one, this keeps the pre-PEN-3926 verdict.
  //
  // PEN-4887: and a THIRD cause the two above do not cover -- the queue
  // admitted the entry and ejected it because the PR did not meet its merge
  // requirements, which also stages no run. Deterministic after a stacked
  // child lands into its parent's branch: the parent's head becomes the merge
  // commit and is enqueued seconds later, before anything has run on it.
  // `admissionEvidence.rejected` is only ever `true` on positive evidence, so
  // an absent or unusable read falls through to the verdict above.
  //
  // PEN-6460 deliberately does NOT consult `dequeueReason` in this branch,
  // and the omission is the point. GitHub's vocabulary is coarser than this
  // ladder: a PEN-4887 admission rejection IS a removal for checks that did
  // not pass, so `reason: "failed_checks"` is the expected report for it --
  // and answering `check_failure` there would retire `requirements_unmet`,
  // whose whole value is telling the reader to wait for the head's checks or
  // arm auto-merge instead of hunting a failing one. `reason` is a REPORT and
  // is therefore authoritative about what it says; it is not more specific
  // than a classification built from three other signals. Reinstate it here
  // only with a measured specimen of a zero-run eviction whose reason
  // contradicts the ladder.
  if (!mergeGroupRuns || mergeGroupRuns.length === 0) {
    if (!isQueueInitiatedRemoval(dequeueActor)) return "manual";
    if (admissionEvidence?.rejected === true) return "requirements_unmet";
    return "conflict_unstageable";
  }
  // PEN-6460: GitHub's own reason outranks every inference below it, because
  // the inferences reconstruct from run conclusions what this field states
  // outright. Measured on #3591 (2026-11-10T22:41:30Z): the removal carried
  // `reason: "failed_checks"` while the run read `cancelled`, so both
  // disjuncts below were false and this eviction was reported as a manual
  // dequeue -- sending its reader to find a person who did not exist.
  if (reasonCause === "check_failure") return "check_failure";
  // BLO-51600: the orphan sweeper cancels a run once a job has failed, so a
  // `cancelled` run carrying a failed job is a check failure, not a dequeue.
  if (mergeGroupRuns.some((run) => run?.conclusion === "failure" || run?.hasFailedJob === true)) {
    return "check_failure";
  }
  if (reasonCause === "conflict_unstageable") return "conflict_unstageable";
  if (reasonCause === "manual") return "manual";
  // PEN-6460: a `cancelled` run whose job list could not be read is NOT
  // evidence that no job failed -- before this, `ghRunHasFailedJob` returned
  // `false` on a read failure and that answer fell straight through to
  // `manual`, which asserts a person dequeued the PR. An unreadable probe now
  // says so. This arm is reached only after the two positive-evidence checks
  // above, so a run that demonstrably failed is still `check_failure`.
  if (mergeGroupRuns.some((run) => run?.hasFailedJob === HAS_FAILED_JOB_UNKNOWN)) {
    return "unknown";
  }
  // A merge_group run exists and did not fail, yet the PR was evicted
  // unmerged: an administrative/manual dequeue (see
  // runbooks/merge-queue-stalled-head.md's stalled-head procedure) or a
  // GitHub-side timeout on a non-terminal run.
  return "manual";
}

function run(args) {
  return execFileSync(args[0], args.slice(1), { encoding: "utf8" });
}

function ghPrView(repo, prNumber) {
  const out = run([
    "gh", "pr", "view", String(prNumber),
    "--repo", repo,
    // Not "merged": that boolean field isn't available on every gh CLI
    // version in the fleet (confirmed absent on 2.46.0, present on newer
    // releases). `state === "MERGED"` is the same fact via a field every
    // version exposes.
    "--json", "number,state,mergedAt,baseRefName,headRefName,headRefOid,title,body,url",
  ]);
  const raw = JSON.parse(out);
  return { ...raw, merged: raw.state === "MERGED" };
}

function ghTimeline(repo, prNumber) {
  // `--paginate --slurp` would be the obvious way to merge pages into one
  // array, but `--slurp` is NOT available on every gh CLI version in the
  // fleet -- confirmed absent on 2.46.0 (`unknown flag: --slurp`), which is
  // the version this script otherwise already assumes as a floor (see
  // ghPrView above). `--jq '.[] | {...}'` has been supported for far
  // longer and, combined with `--paginate`, emits one flattened element per
  // output line across every page -- no outer-array wrapping needed, and
  // NDJSON-style line splitting works identically on any gh version.
  // PEN-3926: `actor` is fetched, not just `{event, created_at}`. GitHub
  // attributes a queue-initiated removal to `github-merge-queue[bot]` and a
  // deliberate dequeue to the human or App that performed it -- the one
  // signal that tells a genuine eviction apart from a hold. It is read from
  // the timeline rather than from `github.event.sender.login` because the
  // timeline actor belongs to the specific `removed_from_merge_queue` event
  // this run anchored its window to, and is also present on
  // `workflow_dispatch` replay, which carries no webhook sender at all.
  const out = run([
    "gh", "api", `repos/${repo}/issues/${prNumber}/timeline`,
    "--paginate", "--jq", ".[] | {event, created_at, actor: .actor.login}",
  ]);
  return out
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

function parseNdjson(out) {
  return out
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

/**
 * Tag every row with the check surface it came from. Applied here rather than
 * in the `--jq` expression so the tag is a property of THIS function, visible
 * through the `exec` seam and independent of what the API or jq returns.
 */
const taggedWith = (surface) => (rows) => rows.map((row) => ({ ...row, surface }));

/**
 * PEN-4887: both check surfaces for ONE commit, SHA-pinned.
 *
 * Reading only `/check-runs` would be wrong in the direction that matters.
 * `gate/ally-comment-findings` and `review/ally-comment` are commit STATUSES,
 * not check runs (verified on #3060's head `87a87dc0` and on this script's
 * own head: those two are the entire status surface). BOTH had succeeded
 * before the 07:46:27Z removal, and NO check run had -- the earliest,
 * `security-review`, concluded at 07:46:52Z. So every pre-removal completion
 * on that head was invisible to `/check-runs`. Omitting the status surface
 * would report "nothing completed" for heads where something had, which is
 * the fail-open direction for the guard in `classifyAdmissionEvidence`.
 *
 * Each entry is tagged with the surface it came from. The two surfaces are
 * separate namespaces in branch protection, so a check run and a status
 * context that happen to share a name must not be collapsed into one when
 * `classifyAdmissionEvidence` dedupes. This is also the surface that returns
 * HISTORY rather than current state -- `/statuses` yields one row per post --
 * which is deliberately left for that function to collapse, because only it
 * knows the dequeue instant the collapse has to be anchored to.
 *
 * Returns `null` on any read failure rather than an empty array: an empty
 * array is positive evidence ("this head carries no checks") and would let a
 * transient API error classify, while `null` means "no evidence" and falls
 * back to the pre-PEN-4887 verdict. Never throws -- a failure to gather
 * optional corroboration must not cost the notice entirely.
 */
export function ghHeadChecks(repo, sha, exec = run) {
  if (typeof sha !== "string" || sha.length === 0) return null;
  try {
    const checkRuns = taggedWith("check_run")(
      parseNdjson(
        exec([
          "gh", "api", `repos/${repo}/commits/${sha}/check-runs?per_page=100`,
          "--paginate", "--jq",
          ".check_runs[] | {id, name, conclusion, completedAt: .completed_at}",
        ]),
      ),
    );
    const statuses = taggedWith("status")(
      parseNdjson(
        exec([
          "gh", "api", `repos/${repo}/commits/${sha}/statuses?per_page=100`,
          // No `id`: a status row's id is per POST, so keying on it would
          // defeat the history collapse that is the whole point. Statuses are
          // identified by their context name.
          "--paginate", "--jq", ".[] | {name: .context, conclusion: .state, completedAt: .updated_at}",
        ]),
      ),
    );
    return [...checkRuns, ...statuses];
  } catch (error) {
    console.error(`could not read head checks for ${repo}@${sha}: ${error?.message ?? error}`);
    return null;
  }
}

/**
 * The committer date of the PR's head commit -- when this head came into
 * existence, which is what makes "enqueued 4 seconds after the head moved"
 * measurable. Committer, not author: a rebased or cherry-picked commit keeps
 * its original AUTHOR date, which would read as hours old and silently defeat
 * the fresh-head window. `null` on any failure (see `ghHeadChecks`).
 */
function ghHeadCommittedAt(repo, sha) {
  if (typeof sha !== "string" || sha.length === 0) return null;
  try {
    return run(["gh", "api", `repos/${repo}/commits/${sha}`, "--jq", ".commit.committer.date"]).trim() || null;
  } catch (error) {
    console.error(`could not read head commit date for ${repo}@${sha}: ${error?.message ?? error}`);
    return null;
  }
}

function ghMergeGroupRuns(repo, createdRange) {
  // Ally review #1220: bounding by the specific queue attempt's time window
  // (rather than an unbounded newest-500 sample) is what keeps this correct
  // on a busy repo -- the run this PR actually cares about can't fall off
  // the end of a window it's known to have run inside.
  //
  // Ally review #1220 (5th pass): the range is REQUIRED, not optional. An
  // unbounded lookup can surface a previous queue attempt's runs, which
  // `filterMergeGroupRunsForPr` cannot tell apart from this attempt's (it
  // filters on PR number, not on time), so it reports another attempt's
  // outcome as this eviction's cause. `main` declines to classify rather
  // than fall back to one; keep that the only behaviour by refusing here
  // too, so the unbounded path cannot be reintroduced by a caller passing
  // nothing.
  if (typeof createdRange !== "string" || createdRange.length === 0) {
    throw new TypeError("ghMergeGroupRuns requires a bounded --created range");
  }
  const args = [
    "gh", "run", "list",
    "--repo", repo,
    "--event", "merge_group",
    "--limit", String(RUN_LIST_LIMIT),
    "--json", "databaseId,headBranch,status,conclusion,createdAt",
    "--created", createdRange,
  ];
  const out = run(args);
  return JSON.parse(out);
}

// BLO-51600: jobs whose failure reds pr.yml's `verify` -- its `lane_job_names`
// plus `policy` and `ally-verdict`. `e2e` / `Canary Dry Run` are NOT here: they
// sit outside `verify.needs`, so their failure cannot fail the queue. Must match
// GATING_JOBS in .github/scripts/sweep-orphaned-merge-group-runs.sh; both are
// pinned to pr.yml by tests.
export const MERGE_GROUP_GATING_JOBS = [
  "Helm chart",
  "Typecheck + Release Registry",
  "General tests",
  "Worktree install (NODE_ENV=production)",
  "OpenCode Responses replay",
  "k8s-ro seed transport cold start",
  "Build",
  "Vendored claude_k8s adapter",
  "Vendored opencode_k8s adapter",
  "policy",
  "ally-verdict",
];

export function isGatingJobName(name) {
  return MERGE_GROUP_GATING_JOBS.some((g) => name === g || name.startsWith(`${g} (`));
}

/**
 * PEN-6460: the job names whose FAILURE witnesses that a gating job did not
 * pass. Strictly wider than `MERGE_GROUP_GATING_JOBS`, which stays pinned
 * byte-for-byte to pr.yml and to GATING_JOBS in
 * .github/scripts/sweep-orphaned-merge-group-runs.sh and must not grow for
 * this -- the sweeper's question ("may I cancel this run?") is not this
 * module's question ("did a required check fail?").
 *
 * `verify` is added because it is pr.yml's required aggregate over exactly
 * the ten gating jobs, declared `if: always() && !cancelled()`. That guard is
 * what makes it a DISCRIMINATOR rather than another name on a list:
 *
 *   - a gating job killed by its own `timeout-minutes` does not cancel the
 *     RUN, so `!cancelled()` holds, `verify` runs, sees a cancelled need and
 *     concludes `failure`;
 *   - a run cancelled from outside (the orphan sweeper, or a dequeue) makes
 *     `cancelled()` true, so `verify` never runs and concludes `cancelled`.
 *
 * Measured first-party 2026-11-10 on both arms: run 42910342037 (#3591, the
 * PEN-6460 case) -- `Build` `cancelled` after 25.4m against its
 * `timeout-minutes: 25`, `verify` FAILURE; run 42900870003 (#3586, control)
 * -- `General tests (workspaces-a)` `failure`, eleven jobs cancelled by the
 * sweeper, `verify` CANCELLED.
 *
 * NOTE -- this is why the jq below still admits only `failure`/`timed_out`
 * and NOT `cancelled`, which looks like the obvious fix and is a fail-open in
 * the opposite direction: a dequeue cancels the run, so EVERY gating job in a
 * genuinely manual dequeue reads `cancelled` (eleven of them in the control
 * above) and admitting that conclusion by name would report every manual
 * dequeue as a check failure. The step list does not rescue it either --
 * measured on both runs, the interrupted step reads `cancelled` in the
 * timeout case exactly as it does in the external-cancel case, so steps
 * discriminate nothing. `verify`'s conclusion is the signal that does.
 */
export const MERGE_GROUP_FAILURE_WITNESS_JOBS = [...MERGE_GROUP_GATING_JOBS, "verify"];

export function isFailureWitnessJobName(name) {
  return MERGE_GROUP_FAILURE_WITNESS_JOBS.some((g) => name === g || name.startsWith(`${g} (`));
}

/**
 * BLO-51600: one call per CANCELLED run only.
 *
 * PEN-6460: returns `HAS_FAILED_JOB_UNKNOWN` on a read failure, where it used
 * to return `false`. `false` is also what a genuinely clean run returns, so
 * an unreadable probe was indistinguishable from a clean one and fell
 * through to `manual` -- a verdict that asserts a person dequeued the PR.
 * This surface is the first to go dark under an exhausted REST `core`
 * bucket, which is exactly when a confident wrong answer is most likely.
 *
 * @returns {boolean | typeof HAS_FAILED_JOB_UNKNOWN}
 */
export function ghRunHasFailedJob(repo, runId, exec = run) {
  let out;
  try {
    out = exec([
      "gh", "api", `repos/${repo}/actions/runs/${runId}/jobs?per_page=100`,
      '--jq', '.jobs[]|select(.conclusion=="failure" or .conclusion=="timed_out")|.name',
    ]);
  } catch {
    return HAS_FAILED_JOB_UNKNOWN;
  }
  return out.split("\n").some((name) => isFailureWitnessJobName(name.trim()));
}

/**
 * PEN-6460: the one GraphQL call in this module. See
 * `MERGE_QUEUE_DEQUEUE_REASON_CAUSES` for why the REST timeline the rest of
 * the script reads cannot answer this, and for the measured value space.
 *
 * Fails to `null` on any error, which restores the pre-PEN-6460 behaviour
 * exactly: the inference ladder runs untouched. That direction is deliberate
 * -- this read must never be able to manufacture a verdict it did not get.
 */
export const DEQUEUE_REASON_QUERY = `query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      timelineItems(last:50, itemTypes:[REMOVED_FROM_MERGE_QUEUE_EVENT]){
        nodes{ ... on RemovedFromMergeQueueEvent { createdAt reason } }
      }
    }
  }
}`;

export function ghDequeueReason(repo, prNumber, dequeuedAt, exec = run) {
  const [owner, name] = String(repo ?? "").split("/");
  if (!owner || !name) return null;
  try {
    const out = exec([
      "gh", "api", "graphql",
      "-f", `query=${DEQUEUE_REASON_QUERY}`,
      "-F", `owner=${owner}`,
      "-F", `name=${name}`,
      "-F", `number=${prNumber}`,
      "--jq", ".data.repository.pullRequest.timelineItems.nodes[] | {createdAt, reason}",
    ]);
    return selectDequeueReasonAt(parseNdjson(out), dequeuedAt);
  } catch {
    return null;
  }
}

// PEN-5530: `isInMergeQueue` / `mergeQueueEntry` are GraphQL-only -- `gh pr
// view` has no such field (it errors with the field list), and
// `mergeStateStatus` does NOT report queue membership: measured 2026-11-11 on
// two PRs sitting at queue positions 1 and 2, both read `UNKNOWN`, and it has
// separately been measured `CLEAN` on a queued PR -- neither value carries the
// fact. Anything that branches on queue membership has to come through here.
export const QUEUE_MEMBERSHIP_QUERY = `query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      isInMergeQueue
      mergeQueueEntry{ position enqueuedAt }
    }
  }
}`;

// Returns `{inQueue, position, enqueuedAt}` on a successful read, or `null`
// when the read failed for ANY reason. The tri-state is load-bearing and the
// null arm must never collapse into `inQueue: false`: `false` is a positive
// claim that this PR is out of the queue, and the notice drops its re-add
// instruction on the strength of the opposite claim. A 403, an exhausted REST
// quota, a schema error and a PR that does not resolve all arrive here as an
// absent or non-boolean `isInMergeQueue`, so membership is asserted only when
// GitHub actually said a boolean.
export function ghQueueMembership(repo, prNumber, exec = run) {
  const [owner, name] = String(repo ?? "").split("/");
  if (!owner || !name) return null;
  try {
    const out = exec([
      "gh", "api", "graphql",
      "-f", `query=${QUEUE_MEMBERSHIP_QUERY}`,
      "-F", `owner=${owner}`,
      "-F", `name=${name}`,
      "-F", `number=${prNumber}`,
      "--jq",
      ".data.repository.pullRequest | {inQueue: .isInMergeQueue, " +
        "position: .mergeQueueEntry.position, enqueuedAt: .mergeQueueEntry.enqueuedAt}",
    ]);
    const rows = parseNdjson(out);
    const row = rows.length > 0 ? rows[rows.length - 1] : null;
    if (typeof row?.inQueue !== "boolean") return null;
    return {
      inQueue: row.inQueue,
      position: Number.isFinite(row.position) ? row.position : null,
      enqueuedAt: typeof row.enqueuedAt === "string" && row.enqueuedAt.trim().length > 0 ? row.enqueuedAt : null,
    };
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      args[key] = "true";
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

// Must stay byte-identical to MERGE_QUEUE_EVICTION_MARKER in
// server/src/routes/github-webhook.ts, which gates the whole feature on
// `body.startsWith(...)` at byte 0. Drift on either side silently disables
// eviction wakes with both suites green -- the same silent-loss class
// BLO-23395 exists to close -- so the coupling is asserted in
// scripts/__tests__/merge-queue-eviction-detector.test.mjs rather than left
// to two hand-maintained literals.
export const MERGE_QUEUE_EVICTION_MARKER = "<!-- paperclip:merge-queue-eviction -->";

export function buildEvictionCommentBody({
  repo,
  prNumber,
  classification,
  mergeGroupRunCount,
  base,
  identifiers,
  dequeueActor = null,
  dequeueReason = null,
  unknownReason = "truncated_sample",
  admissionEvidence = null,
  queueMembership = null,
}) {
  const [repoOwner = "", repoName = ""] = String(repo ?? "").split("/");
  // PEN-3926: `manual` is now reachable with ZERO runs (a dequeue that beat
  // the queue to staging), so its cause line can no longer assert that a run
  // was created. The branch below is keyed on the ACTOR, not on the run
  // count: whenever the removal carries an attributable actor we name it and
  // say plainly that the branch is probably fine -- including on the older
  // path into `manual` (a run existed and did not fail), where naming the
  // remover is strictly more useful than asserting the run, and the run count
  // is printed on its own line regardless. The original run-count-based
  // wording is emitted verbatim only when no actor is attributable, which is
  // the one case where there is nothing better to say.
  const namedManualActor = !isQueueInitiatedRemoval(dequeueActor) ? String(dequeueActor).trim() : null;
  const manualCause = namedManualActor
    ? `**manual / administrative dequeue** -- \`${namedManualActor}\` removed this PR from the queue, rather ` +
      "than the queue evicting it. This was a deliberate dequeue, and a deliberately held branch is usually " +
      "perfectly mergeable -- do **not** rebase it on the strength of this notice. Confirm with whoever " +
      "dequeued it before re-adding (see `runbooks/merge-queue-stalled-head.md`'s stalled-head procedure)."
    : "**manual / administrative dequeue** -- a `merge_group` run was created for this PR's head and did not " +
      "fail, so this was likely a deliberate dequeue (see `runbooks/merge-queue-stalled-head.md`'s stalled-head " +
      "procedure) rather than an automatic eviction.";
  // PEN-4887: names what was actually unmet -- the head's age when the queue
  // admitted it, and the checks that had not finished reporting by the removal
  // -- instead of asserting a rebase problem. Falls back to the shape of the
  // claim without the numbers if a caller supplies the classification with no
  // evidence, so this can never print `undefined` at a reader.
  const unmetNames = (admissionEvidence?.incompleteAtDequeue ?? []).slice(0, 8);
  const unmetOverflow = (admissionEvidence?.incompleteAtDequeue ?? []).length - unmetNames.length;
  const headAge = Number.isFinite(admissionEvidence?.headAgeAtEnqueueMs)
    ? `${Math.max(0, Math.round(admissionEvidence.headAgeAtEnqueueMs / 1000))}s`
    : "seconds";
  const requirementsUnmetCause =
    "**merge requirements not met at admission** -- the queue admitted this PR and ejected it without staging " +
    `a \`merge_group\` run. This PR's head was **${headAge} old** when it was enqueued` +
    (admissionEvidence
      ? `, and at the instant of removal ${admissionEvidence.completedByDequeue} of ` +
        `${admissionEvidence.checkCount} check(s) on it had completed`
      : "") +
    ". Branch protection could not have been satisfied on a head whose checks had not finished reporting, so the " +
    "queue refused it at admission. This is **not** an un-stageable rebase and rebasing will not help -- the " +
    "branch is typically zero commits behind its base." +
    (unmetNames.length > 0
      ? ` Not complete at removal: ${unmetNames.map((name) => `\`${name}\``).join(", ")}` +
        `${unmetOverflow > 0 ? ` (+${unmetOverflow} more)` : ""}.`
      : "") +
    " Landing a stacked child PR into this branch is the usual cause: it moves this head, and enqueuing seconds " +
    "later enqueues a head on which nothing has run. Arm auto-merge instead -- GitHub enqueues only once the " +
    "requirements are actually met.";
  const causeLine = {
    requirements_unmet: requirementsUnmetCause,
    conflict_unstageable:
      "**conflict / un-stageable rebase** -- the queue never created a `merge_group` run for this PR's head " +
      "during this queue attempt (0 runs found), so no check failure exists to explain it. The branch could " +
      "not be staged against a moving base. See `runbooks/merge-queue-stalled-head.md` (\"Silent eviction: " +
      "un-stageable rebase\").",
    // PEN-6460: the run itself does NOT have to read `failure`. A gating job
    // killed by its own `timeout-minutes` budget is recorded by GitHub as
    // `cancelled`, and so is a run the orphan sweeper cancelled after a job
    // failed -- both are failing required checks, and saying "concluded
    // failing" sent readers of the cancelled shape looking for a red run that
    // does not exist.
    // PEN-5530 (Done-when 5): the old wording said a required check "on" the
    // `merge_group` run did not pass. GitHub's `reason: failed_checks` does
    // not entail that -- it says a required check for the queue head failed,
    // not which producer posted it, and a required context can be written at
    // the queue head by something that is not a `merge_group` workflow. That
    // a run EXISTS is still entailed and is still stated: the zero-run branch
    // of `classifyMergeQueueEviction` returns before this classification is
    // reachable, so `check_failure` implies at least one run. Measured latent
    // on this repo -- 47 `failed_checks` removals 2026-11-04..11, and on 47
    // of 47 the failing check was a job inside a run the reader could open --
    // so this is a precision fix, not a live misdirection.
    check_failure:
      "**failing required check** -- a required check for this PR's queue head did not pass. A `merge_group` run " +
      "was created for this head, and the failing check is normally a job inside it -- start there. The run " +
      "itself may read `cancelled` rather than `failure`: a gating job killed by its own `timeout-minutes` " +
      "budget is recorded as `cancelled`, and the orphan sweeper cancels a run once a gating job has failed. " +
      "Look for the job that did not finish clean, not for a red run. If every run is clean, the failing " +
      "required check was posted at the queue head by something other than a `merge_group` run -- read the " +
      "head's check list directly.",
    manual: manualCause,
    // PEN-6460: `unknown` now has two causes and they need different words.
    // The notice must not assert a manual dequeue when the truth is that a
    // probe could not read -- naming a cause nobody can act on is the defect
    // this whole row is about.
    unknown:
      unknownReason === "unreadable_jobs"
        ? "**undetermined** -- a `merge_group` run for this PR's head ended `cancelled` and its job list could " +
          "not be read, so a check failure the sweeper cancelled cannot be told apart from a deliberate " +
          "dequeue. This is usually an exhausted GitHub REST quota rather than anything about this PR: open " +
          "the run's jobs by hand, or re-run this workflow once the quota resets, before acting."
        : "**undetermined** -- the `merge_group` run lookup for this PR's queue attempt hit its sample cap " +
          "with no match, so an incomplete sample can't be told apart from a genuine zero. Diagnose manually " +
          "via `runbooks/merge-queue-stalled-head.md` before assuming a conflict.",
  }[classification];
  // PEN-5530: the action line used to be written WITHOUT reading whether the
  // PR is already back in the queue. Measured on #3215 (2026-11-04): removed
  // at 12:23:33Z, re-enqueued at 12:23:41Z (+8s), and this notice posted at
  // 12:25:13Z telling its reader to "confirm the hold is over" and re-add a
  // PR that was by then at queue position 1 with a `merge_group` build 80s
  // into its run. Re-adding or rebasing there EJECTS the live entry and voids
  // that build, so the instruction was not merely stale -- acting on it was
  // destructive.
  //
  // Applied to EVERY classification, not only `manual` as the row originally
  // scoped it: every branch below ends in a re-add instruction, and the harm
  // is a property of the CURRENT queue state, never of why the PR left the
  // queue.
  //
  // `queueMembership === null` is a THIRD state and must not collapse into
  // `inQueue: false`. `false` is a positive claim that this PR is out of the
  // queue, and it is what licenses printing the re-add instruction; a failed
  // read is not entitled to make either claim, so it falls through to the
  // pre-PEN-5530 wording and says plainly that it could not look.
  const backInQueue = queueMembership?.inQueue === true;
  const requeuedAt = typeof queueMembership?.enqueuedAt === "string" ? queueMembership.enqueuedAt : null;
  const queuePosition = Number.isFinite(queueMembership?.position) ? queueMembership.position : null;
  const membershipLine = backInQueue
    ? `Queue status when this notice was written: **back in the \`${base}\` merge queue**` +
      (requeuedAt ? `, re-added at ${requeuedAt}` : "") +
      (queuePosition !== null ? ` (GitHub-reported position ${queuePosition})` : "") +
      "."
    : queueMembership?.inQueue === false
      ? `Queue status when this notice was written: not in the \`${base}\` merge queue.`
      : "Queue status when this notice was written: **could not be read** -- check it yourself before acting.";
  // PEN-5530 (the #3591 bound): a write-time membership read is necessary and
  // NOT sufficient. Measured 2026-11-10 on #3591 the notice was accurate for
  // 4m40s and the reader acted ~8 minutes later, by which time the PR had
  // been back in the queue for ~8 minutes. Membership is a CYCLIC value, so
  // every statement this notice makes about it is a dated reading with a
  // short half-life. The only part that survives reader latency is telling
  // the reader to take the reading again, and naming the one field that
  // reports it -- `gh pr view` has no `isInMergeQueue`, and
  // `mergeStateStatus` does not report membership.
  const reReadLines = [
    "",
    "That queue status is a reading taken when this notice was posted, **not a standing fact** -- a PR can be " +
      "re-added or evicted again at any time and this comment will not change. Re-read it immediately before " +
      "you act:",
    "",
    "```",
    `gh api graphql -f query='{repository(owner:"${repoOwner}",name:"${repoName}")` +
      `{pullRequest(number:${prNumber}){isInMergeQueue mergeQueueEntry{position state enqueuedAt}}}}'`,
    "```",
  ];
  const actionLine = backInQueue
    ? "**No queue action is required right now: this PR is already back in the merge queue.** Do **not** re-add " +
      "it and do **not** rebase it on the strength of this notice -- either would eject the live entry and void " +
      "the `merge_group` run building on it. The cause above explains the EARLIER removal and is still worth " +
      "reading; act on it only if this new attempt fails the same way."
    : classification === "manual"
      ? "Re-add this PR to the merge queue once whoever dequeued it confirms the hold is over."
      : classification === "requirements_unmet"
        ? "Wait for this head's required checks to complete, then re-add -- or arm auto-merge (`gh pr merge " +
          "--auto --rebase`) and let GitHub enqueue it when the requirements are met. Do not rebase on the " +
          "strength of this notice."
        : "Re-add this PR to the merge queue once the underlying issue is resolved (rebase onto the current base " +
          "for an un-stageable eviction; fix the failing check; or confirm with whoever dequeued it manually).";
  return [
    MERGE_QUEUE_EVICTION_MARKER,
    `PR #${prNumber} was removed from the \`${base}\` merge queue and is **not merged**.`,
    "",
    `Cause: ${causeLine}`,
    "",
    `(${mergeGroupRunCount} \`merge_group\` run(s) found for this PR's queue head at ${repo}.` +
      // PEN-6460: GitHub's own word for the removal, printed verbatim beside
      // the inferred cause so a reader can see the two agree -- or, when a
      // future reason value this module does not yet map shows up, see that
      // the cause line was inferred without it.
      (typeof dequeueReason === "string" && dequeueReason.trim().length > 0
        ? ` GitHub's stated removal reason: \`${dequeueReason.trim()}\`.`
        : "") +
      ")",
    "",
    membershipLine,
    "",
    // PEN-3926: a `manual` notice must not lead with "rebase onto the current
    // base". That instruction is what made the false notices harmful -- it is
    // an action against a clean branch under a deliberate hold, and both a
    // human reader and an automated lander can act on it.
    // PEN-4887: `requirements_unmet` joins `manual` in getting its own closing
    // line. The generic one leads with "rebase onto the current base", which is
    // precisely the no-op this class was being mislabelled into.
    // PEN-5530: and none of them is emitted at all when the PR is already back
    // in the queue -- see `actionLine` above.
    actionLine,
    ...reReadLines,
    // Ally review #1220 (4th pass): embedded so the webhook's issue_comment
    // handler (which has no branch name to fall back on) can still route the
    // wake for a PR linked to Paperclip only through its branch.
    ...(identifiers && identifiers.length > 0 ? ["", `Linked issue: ${identifiers.join(", ")}`] : []),
  ].join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repo = args.repo;
  const prNumber = Number(args.pr);
  if (!repo || !Number.isFinite(prNumber)) {
    console.error(
      "usage: merge-queue-eviction-detector.mjs --repo <owner/repo> --pr <number> " +
        "[--comment true] [--grace-ms 60000] [--triggered-at <ISO timestamp>]",
    );
    process.exitCode = 2;
    return;
  }

  // Ally review #1220 (4th pass): `Date.now()` here is when the runner
  // actually started this script -- not when GitHub emitted
  // `pull_request.dequeued`. If the job is queued waiting for a runner
  // (this fleet has had real capacity incidents that delay job start --
  // BLO-25481/BLO-24992/BLO-25596) and the PR is re-enqueued during that
  // wait, a `Date.now()` anchor would treat that fresh, run-less re-enqueue
  // as eligible and misclassify it `conflict_unstageable`. `--triggered-at`
  // carries the workflow run's own creation timestamp (set by the workflow
  // right after checkout, from `gh api .../actions/runs/<run_id>`), which
  // reflects when the webhook was received, not when a runner became free.
  // Falls back to `Date.now()` for manual `workflow_dispatch` replay, which
  // has no run-creation timestamp to anchor to and isn't racing a live queue.
  const triggeredAtArg = args["triggered-at"];
  const parsedTriggeredAt = triggeredAtArg ? Date.parse(triggeredAtArg) : NaN;
  const triggeredAt = Number.isFinite(parsedTriggeredAt) ? parsedTriggeredAt : Date.now();

  let pr = ghPrView(repo, prNumber);
  if (!pr.merged) {
    // Guard against the race where `dequeued` fires for the queue's own
    // successful merge and this job starts before `merged` has landed.
    const graceMs = Number(args["grace-ms"] ?? 60000);
    if (graceMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, graceMs));
      pr = ghPrView(repo, prNumber);
    }
  }

  let attemptWindow = selectLatestQueueAttemptWindow(ghTimeline(repo, prNumber), { now: triggeredAt });
  // Ally review #1220 (4th pass): `dequeuedAt: null` means the enqueue we
  // anchored to has no observed removal yet -- the /timeline endpoint may
  // simply not have replicated the dequeue that triggered this run. Retry a
  // few times before declining to classify; never fabricate a timestamp.
  //
  // Ally review #1220 (5th pass): the retry must also cover a missing
  // *enqueue* (`attemptWindow === null`), not just a missing removal. Timeline
  // replication lag is one event stream, so the same lag that hides the
  // dequeue can hide the `added_to_merge_queue` that preceded it. The old
  // condition was `attemptWindow && attemptWindow.dequeuedAt === null`, which
  // is false on entry when the window is null -- so a real `dequeued` trigger
  // with a lagging timeline skipped both the retry and the guard below and
  // fell through to an UNBOUNDED `merge_group` lookup. A previous queue
  // attempt's runs then matched `filterMergeGroupRunsForPr`'s PR-number
  // filter, and an un-stageable eviction was reported as `check_failure` or
  // `manual` -- exactly the cross-attempt contamination the windowed path was
  // introduced to fix.
  for (
    let attempt = 0;
    attempt < DEQUEUE_REPLICATION_RETRIES && (attemptWindow === null || attemptWindow.dequeuedAt === null);
    attempt += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, DEQUEUE_REPLICATION_RETRY_DELAY_MS));
    attemptWindow = selectLatestQueueAttemptWindow(ghTimeline(repo, prNumber), { now: triggeredAt });
  }
  if (attemptWindow === null) {
    // No `added_to_merge_queue` event ever became visible, so there is no
    // attempt to bound the run lookup to. Declining is the only sound
    // outcome: classifying from an unbounded lookup would draw on whichever
    // earlier attempt's runs happen to still be in range and report a cause
    // that belongs to a different attempt. A missed notification is
    // recoverable (re-run the workflow manually once the timeline catches
    // up); a confidently wrong cause is not.
    console.error(
      `${repo}#${prNumber} has no observed added_to_merge_queue event after ${DEQUEUE_REPLICATION_RETRIES} retries; ` +
        "declining to classify rather than classifying from an unbounded lookup that could report a previous " +
        "attempt's outcome. Re-run manually once the timeline has caught up.",
    );
    return;
  }
  if (attemptWindow.dequeuedAt === null) {
    console.error(
      `${repo}#${prNumber}'s queue attempt enqueued at ${attemptWindow.enqueuedAt} still has no observed ` +
        `removed_from_merge_queue event after ${DEQUEUE_REPLICATION_RETRIES} retries; declining to classify ` +
        "rather than risk a false eviction notice. Re-run manually once the timeline has caught up.",
    );
    return;
  }

  const allRuns = ghMergeGroupRuns(repo, buildRunSearchWindow(attemptWindow));
  const truncated = allRuns.length >= RUN_LIST_LIMIT;

  const mergeGroupRuns = filterMergeGroupRunsForPr(allRuns, { base: pr.baseRefName, prNumber }).map((r) =>
    r.conclusion === "cancelled" ? { ...r, hasFailedJob: ghRunHasFailedJob(repo, r.databaseId) } : r,
  );
  // PEN-4887: only gathered when there is a zero-run eviction to explain. The
  // other classifications are decided by run outcome and cannot be changed by
  // this evidence, so paying three API calls for them would be waste.
  const admissionEvidence =
    !pr.merged && mergeGroupRuns.length === 0
      ? classifyAdmissionEvidence({
          headChecks: ghHeadChecks(repo, pr.headRefOid),
          headCommittedAt: ghHeadCommittedAt(repo, pr.headRefOid),
          enqueuedAt: attemptWindow.enqueuedAt,
          dequeuedAt: attemptWindow.dequeuedAt,
        })
      : null;
  // PEN-6460: GitHub's own stated reason for THIS attempt's removal. One
  // GraphQL call, unconditional -- unlike `admissionEvidence` it can change
  // any verdict, including the run-outcome ones, which is the whole point.
  const dequeueReason = ghDequeueReason(repo, prNumber, attemptWindow.dequeuedAt);
  const classification = classifyMergeQueueEviction({
    merged: pr.merged,
    mergeGroupRuns,
    truncated,
    dequeueActor: attemptWindow.dequeuedBy,
    dequeueReason,
    admissionEvidence,
  });
  const unknownReason = mergeGroupRuns.some((r) => r?.hasFailedJob === HAS_FAILED_JOB_UNKNOWN)
    ? "unreadable_jobs"
    : "truncated_sample";

  // PEN-5530: read LAST, immediately before the notice is built, because
  // queue membership is cyclic and every second between the read and the
  // write is staleness the reader inherits. Deliberately NOT passed to
  // `classifyMergeQueueEviction`: the classification explains why the PR left
  // the queue, which is history and cannot be changed by what the queue looks
  // like now. Only the ACTION line depends on the present state.
  const queueMembership = ghQueueMembership(repo, prNumber);
  const result = {
    repo,
    prNumber,
    base: pr.baseRefName,
    merged: pr.merged,
    mergedAt: pr.mergedAt ?? null,
    classification,
    truncated,
    attemptWindow,
    dequeueReason,
    queueMembership,
    mergeGroupRunCount: mergeGroupRuns.length,
    mergeGroupRuns,
    admissionEvidence,
  };
  console.log(JSON.stringify(result, null, 2));

  if (classification !== "merged" && args.comment === "true") {
    const identifiers = extractPaperclipIdentifiers(pr.headRefName, pr.title, pr.body);
    const body = buildEvictionCommentBody({
      repo,
      prNumber,
      classification,
      mergeGroupRunCount: mergeGroupRuns.length,
      base: pr.baseRefName,
      identifiers,
      dequeueActor: attemptWindow.dequeuedBy,
      dequeueReason,
      unknownReason,
      admissionEvidence,
      queueMembership,
    });
    run(["gh", "pr", "comment", String(prNumber), "--repo", repo, "--body", body]);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
