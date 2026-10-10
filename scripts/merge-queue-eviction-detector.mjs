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
      if (match[1]) for (const id of expandPaperclipIdentifierToken(match[1])) found.add(id);
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
 * @param {Array<{ event: string, created_at: string }>} timelineEvents
 * @param {{ now: number }} opts
 * @returns {{ enqueuedAt: string, dequeuedAt: string | null } | null}
 */
export function selectLatestQueueAttemptWindow(timelineEvents, { now }) {
  const events = (timelineEvents ?? [])
    .filter((e) => e && typeof e.event === "string" && typeof e.created_at === "string")
    .map((e) => ({
      event: e.event,
      at: new Date(e.created_at).getTime(),
      // PEN-3926: absent/non-string actor stays `null` so the classifier can
      // tell "no attribution available" apart from a named actor and fall
      // back to the pre-PEN-3926 verdict.
      actor: typeof e.actor === "string" && e.actor.trim().length > 0 ? e.actor : null,
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
  return actor.toLowerCase() === MERGE_QUEUE_REMOVAL_ACTOR;
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
 * @param {{
 *   merged: boolean,
 *   mergeGroupRuns: Array<{ conclusion: string | null }>,
 *   truncated?: boolean,
 *   dequeueActor?: string | null,
 * }} input
 * @returns {"merged" | "conflict_unstageable" | "check_failure" | "manual" | "unknown"}
 */
export function classifyMergeQueueEviction({
  merged,
  mergeGroupRuns,
  truncated = false,
  dequeueActor = null,
}) {
  if (merged) return "merged";
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
  if (!mergeGroupRuns || mergeGroupRuns.length === 0) {
    return isQueueInitiatedRemoval(dequeueActor) ? "conflict_unstageable" : "manual";
  }
  if (mergeGroupRuns.some((run) => run?.conclusion === "failure")) return "check_failure";
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
}) {
  // PEN-3926: `manual` is now reachable with ZERO runs (a dequeue that beat
  // the queue to staging), so its cause line can no longer assert that a run
  // was created. When the removal carries an attributable actor, name it and
  // say plainly that the branch is probably fine; otherwise emit the original
  // run-count-based wording verbatim, which is still exactly right for the
  // path that reaches `manual` through a non-failing run.
  const namedManualActor = !isQueueInitiatedRemoval(dequeueActor) ? String(dequeueActor).trim() : null;
  const manualCause = namedManualActor
    ? `**manual / administrative dequeue** -- \`${namedManualActor}\` removed this PR from the queue, rather ` +
      "than the queue evicting it. This was a deliberate dequeue, and a deliberately held branch is usually " +
      "perfectly mergeable -- do **not** rebase it on the strength of this notice. Confirm with whoever " +
      "dequeued it before re-adding (see `runbooks/merge-queue-stalled-head.md`'s stalled-head procedure)."
    : "**manual / administrative dequeue** -- a `merge_group` run was created for this PR's head and did not " +
      "fail, so this was likely a deliberate dequeue (see `runbooks/merge-queue-stalled-head.md`'s stalled-head " +
      "procedure) rather than an automatic eviction.";
  const causeLine = {
    conflict_unstageable:
      "**conflict / un-stageable rebase** -- the queue never created a `merge_group` run for this PR's head " +
      "during this queue attempt (0 runs found), so no check failure exists to explain it. The branch could " +
      "not be staged against a moving base. See `runbooks/merge-queue-stalled-head.md` (\"Silent eviction: " +
      "un-stageable rebase\").",
    check_failure:
      "**failing required check** -- a `merge_group` run was created for this PR's head and concluded failing.",
    manual: manualCause,
    unknown:
      "**undetermined** -- the `merge_group` run lookup for this PR's queue attempt hit its sample cap with no " +
      "match, so an incomplete sample can't be told apart from a genuine zero. Diagnose manually via " +
      "`runbooks/merge-queue-stalled-head.md` before assuming a conflict.",
  }[classification];
  return [
    MERGE_QUEUE_EVICTION_MARKER,
    `PR #${prNumber} was removed from the \`${base}\` merge queue and is **not merged**.`,
    "",
    `Cause: ${causeLine}`,
    "",
    `(${mergeGroupRunCount} \`merge_group\` run(s) found for this PR's queue head at ${repo}.)`,
    "",
    // PEN-3926: a `manual` notice must not lead with "rebase onto the current
    // base". That instruction is what made the false notices harmful -- it is
    // an action against a clean branch under a deliberate hold, and both a
    // human reader and an automated lander can act on it.
    classification === "manual"
      ? "Re-add this PR to the merge queue once whoever dequeued it confirms the hold is over."
      : "Re-add this PR to the merge queue once the underlying issue is resolved (rebase onto the current base " +
        "for an un-stageable eviction; fix the failing check; or confirm with whoever dequeued it manually).",
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

  const mergeGroupRuns = filterMergeGroupRunsForPr(allRuns, { base: pr.baseRefName, prNumber });
  const classification = classifyMergeQueueEviction({
    merged: pr.merged,
    mergeGroupRuns,
    truncated,
    dequeueActor: attemptWindow.dequeuedBy,
  });

  const result = {
    repo,
    prNumber,
    base: pr.baseRefName,
    merged: pr.merged,
    mergedAt: pr.mergedAt ?? null,
    classification,
    truncated,
    attemptWindow,
    mergeGroupRunCount: mergeGroupRuns.length,
    mergeGroupRuns,
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
