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
    .map((e) => ({ event: e.event, at: new Date(e.created_at).getTime() }))
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
  };
}

/**
 * Formats a `gh run list --created` range around the attempt window, with a
 * buffer on each side for clock skew between the queue staging a run and the
 * timeline event landing.
 */
export function buildRunSearchWindow({ enqueuedAt, dequeuedAt }, bufferMs = WINDOW_BUFFER_MS) {
  const since = new Date(new Date(enqueuedAt).getTime() - bufferMs).toISOString();
  const until = new Date(new Date(dequeuedAt).getTime() + bufferMs).toISOString();
  return `${since}..${until}`;
}

/**
 * @param {{
 *   merged: boolean,
 *   mergeGroupRuns: Array<{ conclusion: string | null }>,
 *   truncated?: boolean,
 * }} input
 * @returns {"merged" | "conflict_unstageable" | "check_failure" | "manual" | "unknown"}
 */
export function classifyMergeQueueEviction({ merged, mergeGroupRuns, truncated = false }) {
  if (merged) return "merged";
  // Ally review #1220: a `gh run list` sample that hit its cap is not proof
  // of absence. Only trust "zero runs found" -> conflict_unstageable when
  // the sample is known-complete; otherwise say so explicitly rather than
  // guessing wrong with confidence.
  if (truncated && (!mergeGroupRuns || mergeGroupRuns.length === 0)) return "unknown";
  // The queue never staged this PR at all -- GitHub could not construct a
  // merge_group run for it (un-stageable rebase, dirty tree). This is the
  // BLO-23395 shape: no failing check exists to explain the eviction because
  // no check ever ran.
  if (!mergeGroupRuns || mergeGroupRuns.length === 0) return "conflict_unstageable";
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
  const out = run([
    "gh", "api", `repos/${repo}/issues/${prNumber}/timeline`,
    "--paginate", "--jq", ".[] | {event, created_at}",
  ]);
  return out
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

function ghMergeGroupRuns(repo, createdRange) {
  const args = [
    "gh", "run", "list",
    "--repo", repo,
    "--event", "merge_group",
    "--limit", String(RUN_LIST_LIMIT),
    "--json", "databaseId,headBranch,status,conclusion,createdAt",
  ];
  // Ally review #1220: bounding by the specific queue attempt's time window
  // (rather than an unbounded newest-500 sample) is what keeps this correct
  // on a busy repo -- the run this PR actually cares about can't fall off
  // the end of a window it's known to have run inside.
  if (createdRange) args.push("--created", createdRange);
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

function buildEvictionCommentBody({ repo, prNumber, classification, mergeGroupRunCount, base, identifiers }) {
  const causeLine = {
    conflict_unstageable:
      "**conflict / un-stageable rebase** -- the queue never created a `merge_group` run for this PR's head " +
      "during this queue attempt (0 runs found), so no check failure exists to explain it. The branch could " +
      "not be staged against a moving base. See `runbooks/merge-queue-stalled-head.md` (\"Silent eviction: " +
      "un-stageable rebase\").",
    check_failure:
      "**failing required check** -- a `merge_group` run was created for this PR's head and concluded failing.",
    manual:
      "**manual / administrative dequeue** -- a `merge_group` run was created for this PR's head and did not " +
      "fail, so this was likely a deliberate dequeue (see `runbooks/merge-queue-stalled-head.md`'s stalled-head " +
      "procedure) rather than an automatic eviction.",
    unknown:
      "**undetermined** -- the `merge_group` run lookup for this PR's queue attempt hit its sample cap with no " +
      "match, so an incomplete sample can't be told apart from a genuine zero. Diagnose manually via " +
      "`runbooks/merge-queue-stalled-head.md` before assuming a conflict.",
  }[classification];
  return [
    "<!-- paperclip:merge-queue-eviction -->",
    `PR #${prNumber} was removed from the \`${base}\` merge queue and is **not merged**.`,
    "",
    `Cause: ${causeLine}`,
    "",
    `(${mergeGroupRunCount} \`merge_group\` run(s) found for this PR's queue head at ${repo}.)`,
    "",
    "Re-add this PR to the merge queue once the underlying issue is resolved (rebase onto the current base for " +
      "an un-stageable eviction; fix the failing check; or confirm with whoever dequeued it manually).",
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
  for (
    let attempt = 0;
    attemptWindow && attemptWindow.dequeuedAt === null && attempt < DEQUEUE_REPLICATION_RETRIES;
    attempt += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, DEQUEUE_REPLICATION_RETRY_DELAY_MS));
    attemptWindow = selectLatestQueueAttemptWindow(ghTimeline(repo, prNumber), { now: triggeredAt });
  }
  if (attemptWindow && attemptWindow.dequeuedAt === null) {
    console.error(
      `${repo}#${prNumber}'s queue attempt enqueued at ${attemptWindow.enqueuedAt} still has no observed ` +
        `removed_from_merge_queue event after ${DEQUEUE_REPLICATION_RETRIES} retries; declining to classify ` +
        "rather than risk a false eviction notice. Re-run manually once the timeline has caught up.",
    );
    return;
  }

  let allRuns;
  if (attemptWindow) {
    allRuns = ghMergeGroupRuns(repo, buildRunSearchWindow(attemptWindow));
  } else {
    // No added_to_merge_queue event on this PR's timeline at all -- can't
    // bound the search to a specific attempt. Fall back to an unbounded
    // (but still capped) lookup; hitting the cap here is treated as
    // truncation below, same as the windowed path.
    console.error(
      `warning: no added_to_merge_queue event found on ${repo}#${prNumber}'s timeline; ` +
        "falling back to an unbounded merge_group run lookup",
    );
    allRuns = ghMergeGroupRuns(repo, null);
  }
  const truncated = allRuns.length >= RUN_LIST_LIMIT;

  const mergeGroupRuns = filterMergeGroupRunsForPr(allRuns, { base: pr.baseRefName, prNumber });
  const classification = classifyMergeQueueEviction({ merged: pr.merged, mergeGroupRuns, truncated });

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
