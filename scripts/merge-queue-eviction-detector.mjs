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
 * @param {Array<{ event: string, created_at: string }>} timelineEvents
 * @param {{ now: number }} opts
 * @returns {{ enqueuedAt: string, dequeuedAt: string } | null}
 */
export function selectLatestQueueAttemptWindow(timelineEvents, { now }) {
  const events = (timelineEvents ?? [])
    .filter((e) => e && typeof e.event === "string" && typeof e.created_at === "string")
    .map((e) => ({ event: e.event, at: new Date(e.created_at).getTime() }))
    .filter((e) => Number.isFinite(e.at))
    .sort((a, b) => a.at - b.at);

  const enqueues = events.filter((e) => e.event === "added_to_merge_queue");
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
    dequeuedAt: dequeueAfter ? new Date(dequeueAfter.at).toISOString() : new Date(now).toISOString(),
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
    "--json", "number,state,mergedAt,baseRefName,headRefOid,title,url",
  ]);
  const raw = JSON.parse(out);
  return { ...raw, merged: raw.state === "MERGED" };
}

function ghTimeline(repo, prNumber) {
  // `--slurp` wraps each page's array into an outer array so pagination
  // doesn't produce back-to-back top-level arrays that JSON.parse can't
  // handle in one call. Available since gh 2.32.0, well below the oldest
  // fleet version this script already assumes (2.46.0, see ghPrView above).
  const out = run(["gh", "api", `repos/${repo}/issues/${prNumber}/timeline`, "--paginate", "--slurp"]);
  const pages = JSON.parse(out);
  return pages.flat();
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

function buildEvictionCommentBody({ repo, prNumber, classification, mergeGroupRunCount, base }) {
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
  ].join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repo = args.repo;
  const prNumber = Number(args.pr);
  if (!repo || !Number.isFinite(prNumber)) {
    console.error(
      "usage: merge-queue-eviction-detector.mjs --repo <owner/repo> --pr <number> " +
        "[--comment true] [--grace-ms 60000]",
    );
    process.exitCode = 2;
    return;
  }

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

  const timeline = ghTimeline(repo, prNumber);
  const attemptWindow = selectLatestQueueAttemptWindow(timeline, { now: Date.now() });

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
    const body = buildEvictionCommentBody({
      repo,
      prNumber,
      classification,
      mergeGroupRunCount: mergeGroupRuns.length,
      base: pr.baseRefName,
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
