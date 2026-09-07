#!/usr/bin/env node

/**
 * Writes the comment-shaped review gate's verdict onto the merge-queue
 * candidate commit (BLO-26602).
 *
 * WHY THIS EXISTS. The gate itself lives in
 * `server/src/services/pr-comment-review-gate.ts` and posts its verdict as a
 * commit status on the PULL REQUEST head, driven by `pull_request`
 * opened/reopened/synchronize, `pull_request_review`, and Ally's
 * `issue_comment`. A merge-queue ref (`gh-readonly-queue/<base>/pr-<n>-<sha>`)
 * generates NONE of those events, and `merge_group` appears zero times in the
 * whole server — so nothing has ever written this context on a queue head.
 * Measured 2026-08-19: zero legacy statuses on 5/5 sampled merge_group heads.
 *
 * That absence is what makes marking the context `required` unsafe today. This
 * repo's queue runs `mergingStrategy: ALLGREEN` with
 * `checkResponseTimeout: 21600` (6h), so a required context with no writer on
 * the queue ref does not fail fast — every entry waits the full six hours,
 * times out, and is ejected. A merge_group run cannot be re-run, so each
 * ejection costs a full re-stage. This script is the missing writer.
 *
 * THE ONE INVARIANT THAT MATTERS: this never emits `pending`. A `pending`
 * required status on a queue ref reproduces exactly the 6h-timeout stall the
 * script exists to prevent, so any verdict that is not decisively blocking is
 * mirrored as `success`. The gate is fail-open by construction and deliberately
 * so — it observes only the comment surface, and a PR reviewed through a formal
 * `pull_request_review` legitimately has no comment to find. Reporting
 * non-success on absence would deadlock every formally-reviewed PR, which is
 * the route BLO-29711 considered and rejected. Fail-open here is therefore not
 * a shortcut; it is the same posture the gate already takes on the PR head, and
 * it keeps this script strictly no worse than today's behaviour.
 *
 * The context name is read from the deployed Helm values rather than hardcoded.
 * This issue was itself stranded for weeks because the context was renamed
 * (`review/ally-comment` -> `gate/ally-comment-findings`, BLO-29711) while prose
 * elsewhere kept naming the retired one, which by then read `success` with a
 * retirement pointer — a reassuring string under the old name. Reading the
 * value the deployment actually ships makes that class of drift impossible
 * here.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** GitHub truncates commit-status descriptions past 140 characters. */
const MAX_DESCRIPTION = 140;

const VALUES_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../deploy/helm/paperclip/values.blockcast.yaml",
);

/**
 * GitHub always formats a queue ref as
 * `refs/heads/gh-readonly-queue/<base>/pr-<number>-<sha>`. The base branch may
 * itself contain slashes, so anchor on the trailing `pr-<number>-<sha>` rather
 * than splitting on `/`.
 */
export function parsePrNumberFromQueueRef(headRef) {
  if (typeof headRef !== "string") return null;
  const match = /\/pr-(\d+)-[0-9a-f]{7,40}$/.exec(headRef.trim());
  return match ? Number(match[1]) : null;
}

/** Reads `githubApp.prCommentReviewGateStatusContext` out of the Helm values. */
export function readGateContext(valuesText) {
  if (typeof valuesText !== "string") return "";
  const match = /^\s*prCommentReviewGateStatusContext:\s*"([^"]*)"\s*$/m.exec(valuesText);
  return match ? match[1].trim() : "";
}

/**
 * `repos/{o}/{r}/statuses/{sha}` returns every historical write, newest-first
 * in practice but not contractually sorted, and the combined-status endpoint
 * would collapse history we may want to reason about. Take the newest write for
 * the context explicitly.
 */
export function selectLatestStatus(statuses, context) {
  if (!Array.isArray(statuses) || !context) return null;
  const matching = statuses.filter((s) => s && s.context === context);
  if (matching.length === 0) return null;
  return matching.reduce((newest, candidate) =>
    String(candidate.updated_at ?? "") > String(newest.updated_at ?? "") ? candidate : newest,
  );
}

/**
 * Maps the PR-head verdict onto the state this script writes on the queue head.
 *
 * `failure` and `error` both block, and both mean the gate reached a blocking
 * conclusion, so they mirror as `failure`. EVERYTHING else — including a
 * missing status and, defensively, `pending` — mirrors as `success`. See the
 * no-`pending` invariant in the file header: a queue ref has no second chance,
 * so the only two outcomes this may produce are "fail fast" and "let it
 * through".
 */
export function mirrorVerdict(status, { prNumber, prHeadSha } = {}) {
  const shortSha = typeof prHeadSha === "string" ? prHeadSha.slice(0, 8) : "unknown";
  const prLabel = prNumber ? `#${prNumber}` : "the source PR";

  if (!status) {
    return {
      state: "success",
      description: truncate(
        `No gate verdict on ${prLabel} head ${shortSha}; passing open (gate is fail-open on absence).`,
      ),
    };
  }

  const blocking = status.state === "failure" || status.state === "error";
  if (blocking) {
    return {
      state: "failure",
      description: truncate(
        status.description || `Comment-review gate reported ${status.state} on ${prLabel} head ${shortSha}.`,
      ),
    };
  }

  if (status.state !== "success") {
    return {
      state: "success",
      description: truncate(
        `Gate was '${status.state}' on ${prLabel} head ${shortSha}; passing open rather than stalling the queue.`,
      ),
    };
  }

  return {
    state: "success",
    description: truncate(status.description || `Comment-review gate clean on ${prLabel} head ${shortSha}.`),
  };
}

export function truncate(text, limit = MAX_DESCRIPTION) {
  const value = String(text ?? "");
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

export function isMainModule(argvPath = process.argv[1], moduleUrl = import.meta.url) {
  return Boolean(argvPath) && resolve(argvPath) === fileURLToPath(moduleUrl);
}

function ghRaw(args) {
  return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }).trim();
}

function gh(args) {
  return JSON.parse(ghRaw(args));
}

function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  const headRef = process.env.MERGE_GROUP_HEAD_REF;
  const headSha = process.env.MERGE_GROUP_HEAD_SHA;

  if (!repo || !headRef || !headSha) {
    console.error("::error::GITHUB_REPOSITORY, MERGE_GROUP_HEAD_REF and MERGE_GROUP_HEAD_SHA are all required.");
    process.exit(1);
  }

  const context = readGateContext(readFileSync(VALUES_PATH, "utf8"));
  if (!context) {
    // An empty context is how the gate is switched off (values.yaml ships "").
    // Writing nothing is the correct no-op; writing a placeholder would create
    // a status the repo would then have to live with, since commit statuses
    // cannot be deleted.
    console.log("Comment-review gate context is empty in Helm values; nothing to mirror.");
    return;
  }

  const prNumber = parsePrNumberFromQueueRef(headRef);
  if (!prNumber) {
    console.error(`::error::Could not parse a PR number out of merge_group head_ref: ${headRef}`);
    process.exit(1);
  }

  const prHeadSha = ghRaw(["api", `repos/${repo}/pulls/${prNumber}`, "--jq", ".head.sha"]);
  if (!/^[0-9a-f]{40}$/.test(prHeadSha)) {
    console.error(`::error::Unexpected head SHA for PR #${prNumber}: ${prHeadSha}`);
    process.exit(1);
  }

  const statuses = gh(["api", `repos/${repo}/statuses/${prHeadSha}`, "--paginate"]);
  const verdict = mirrorVerdict(selectLatestStatus(statuses, context), { prNumber, prHeadSha });

  execFileSync(
    "gh",
    [
      "api",
      "-X",
      "POST",
      `repos/${repo}/statuses/${headSha}`,
      "-f",
      `state=${verdict.state}`,
      "-f",
      `context=${context}`,
      "-f",
      `description=${verdict.description}`,
    ],
    { encoding: "utf8", stdio: ["ignore", "ignore", "inherit"] },
  );

  console.log(
    `Mirrored ${context}=${verdict.state} from PR #${prNumber} head ${prHeadSha.slice(0, 8)} onto queue head ${headSha.slice(0, 8)}: ${verdict.description}`,
  );
}

if (isMainModule()) main();
