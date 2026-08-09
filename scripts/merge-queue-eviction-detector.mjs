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
 * @param {{ merged: boolean, mergeGroupRuns: Array<{ conclusion: string | null }> }} input
 * @returns {"merged" | "conflict_unstageable" | "check_failure" | "manual"}
 */
export function classifyMergeQueueEviction({ merged, mergeGroupRuns }) {
  if (merged) return "merged";
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

function ghMergeGroupRuns(repo) {
  const out = run([
    "gh", "run", "list",
    "--repo", repo,
    "--event", "merge_group",
    "--limit", "500",
    "--json", "databaseId,headBranch,status,conclusion,createdAt",
  ]);
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
      "(0 runs found), so no check failure exists to explain it. The branch could not be staged against a " +
      "moving base. See `runbooks/merge-queue-stalled-head.md` (\"Silent eviction: un-stageable rebase\").",
    check_failure:
      "**failing required check** -- a `merge_group` run was created for this PR's head and concluded failing.",
    manual:
      "**manual / administrative dequeue** -- a `merge_group` run was created for this PR's head and did not " +
      "fail, so this was likely a deliberate dequeue (see `runbooks/merge-queue-stalled-head.md`'s stalled-head " +
      "procedure) rather than an automatic eviction.",
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

  const allRuns = ghMergeGroupRuns(repo);
  const mergeGroupRuns = filterMergeGroupRunsForPr(allRuns, { base: pr.baseRefName, prNumber });
  const classification = classifyMergeQueueEviction({ merged: pr.merged, mergeGroupRuns });

  const result = {
    repo,
    prNumber,
    base: pr.baseRefName,
    merged: pr.merged,
    mergedAt: pr.mergedAt ?? null,
    classification,
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
