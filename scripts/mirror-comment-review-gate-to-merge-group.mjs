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
 * a shortcut; it is the same posture the gate already takes on the PR head.
 *
 * FAILURE POSTURE, and be precise about it: this script runs as a `merge_group`
 * check, so a non-zero exit ejects the queue entry under `mergingStrategy:
 * ALLGREEN`, and a merge_group run cannot be re-run. Exiting non-zero therefore
 * costs a full re-stage and is never a free "be safe" option. Three classes,
 * and every path lands in exactly one:
 *
 *   1. CANNOT DETERMINE THE CONTEXT (values file unreadable, key present but
 *      unparseable) or CANNOT ADDRESS THE QUEUE HEAD (workflow did not pass the
 *      env vars). No status can be written at all, so there is nothing to fail
 *      open *with*. Fail fast and loudly. Once the context is marked required
 *      this is strictly better than exiting 0: both end in ejection, but this
 *      one ejects in seconds with a named cause instead of after the 6h
 *      `checkResponseTimeout`.
 *   2. KEY GENUINELY ABSENT from the values file. That is how the gate is
 *      switched off, so no-op and exit 0.
 *   3. CONTEXT KNOWN, MIRROR FAILED (transient `gh` 5xx, secondary rate limit,
 *      malformed API JSON, unparseable queue ref). We know what to post under,
 *      so post `success` naming the mirror failure. That turns an ejection into
 *      a visible-but-harmless status, which is the same fail-open posture as
 *      above and keeps the script strictly no worse than today's behaviour.
 *
 * The context name is read from the deployed Helm values rather than hardcoded.
 * This issue was itself stranded for weeks because the context was renamed
 * (`review/ally-comment` -> `gate/ally-comment-findings`, BLO-29711) while prose
 * elsewhere kept naming the retired one, which by then read `success` with a
 * retirement pointer — a reassuring string under the old name. Reading the
 * value the deployment actually ships closes that RENAME drift. It does not by
 * itself close FORMATTING drift, so `readGateContext` accepts every YAML
 * spelling of a one-line scalar and hard-fails on anything it cannot read,
 * rather than degrading to a silent "gate is off" — see its doc comment.
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

/** Raised when the values file names the key but we cannot read its value. */
export class GateContextError extends Error {}

export const GATE_CONTEXT_KEY = "prCommentReviewGateStatusContext";

/**
 * A `#` opens a comment in a YAML plain scalar only at the start or after
 * whitespace, so `gate/a#b` is a legal one-token value rather than a truncation.
 */
function findPlainCommentStart(text) {
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "#") continue;
    if (index === 0 || /\s/.test(text[index - 1])) return index;
  }
  return -1;
}

function parseScalar(rest, lineNumber) {
  const where = `${GATE_CONTEXT_KEY} on line ${lineNumber} of the Helm values`;

  const doubleQuoted = /^[ \t]*"((?:[^"\\]|\\.)*)"[ \t]*(?:#.*)?$/.exec(rest);
  if (doubleQuoted) {
    return doubleQuoted[1].replace(/\\(["\\/nt])/g, (_, ch) => (ch === "n" ? "\n" : ch === "t" ? "\t" : ch)).trim();
  }

  const singleQuoted = /^[ \t]*'((?:[^']|'')*)'[ \t]*(?:#.*)?$/.exec(rest);
  if (singleQuoted) return singleQuoted[1].replace(/''/g, "'").trim();

  const commentStart = findPlainCommentStart(rest);
  const plain = (commentStart >= 0 ? rest.slice(0, commentStart) : rest).trim();

  // `key:` with nothing after it is YAML null. That is a legal way to spell
  // "unset", but it is also what a half-finished edit and a next-line scalar
  // both look like from here, and guessing wrong silently disables the gate.
  if (plain === "") {
    throw new GateContextError(`${where} has no value on the same line. Write \`${GATE_CONTEXT_KEY}: ""\` to switch the gate off.`);
  }
  // Flow collections, anchors, aliases, tags and block scalars are all valid
  // YAML and none of them is a status context. Refuse rather than mangle.
  if (/^[|>&*![{]/.test(plain)) {
    throw new GateContextError(`${where} is not a plain scalar (got \`${plain}\`).`);
  }
  if (/["']/.test(plain)) {
    throw new GateContextError(`${where} has unbalanced quotes (got \`${plain}\`).`);
  }
  return plain;
}

/**
 * Reads `githubApp.prCommentReviewGateStatusContext` out of the Helm values.
 *
 * Returns `{ present, context }`. `present: false` means the key is absent,
 * which is how the gate is switched off; `context: ""` means it is present and
 * deliberately empty, which means the same thing. Throws `GateContextError`
 * when the key IS present but its value cannot be read.
 *
 * That last distinction is the whole point of this function, and the earlier
 * single-regex version did not make it. It matched only a double-quoted,
 * comment-free, same-line value, so single-quoted, unquoted, and
 * `"..." # trailing comment` spellings — all valid YAML, and all things a
 * routine reformat of a deploy file produces — returned "" and were routed to
 * the deliberate no-op branch. "Switched off" and "I could not read this" are
 * not the same fact and must not share an encoding: once the context is marked
 * required, the second one silently reproduces the 6h `checkResponseTimeout`
 * ejection this script exists to prevent, with a reassuring log line and no
 * failure signal.
 *
 * The risk is not hypothetical. `prReviewGateStatusContext` is UNQUOTED a few
 * dozen lines below this key in the same file, so the unquoted spelling is
 * already house style here; and this key's neighbour
 * `prCommentReviewGateRetiredStatusContexts` is exactly the kind of entry that
 * attracts an explanatory trailing comment.
 *
 * Two occurrences are ambiguous — one of them is presumably under a different
 * parent mapping — so that is an error too rather than a first-match guess.
 */
export function readGateContext(valuesText) {
  if (typeof valuesText !== "string") {
    throw new GateContextError("Helm values were not readable as text.");
  }

  const keyPattern = new RegExp(`^\\s*${GATE_CONTEXT_KEY}:(.*)$`);
  const hits = [];
  valuesText.split("\n").forEach((line, index) => {
    const match = keyPattern.exec(line);
    if (match) hits.push({ lineNumber: index + 1, rest: match[1] });
  });

  if (hits.length === 0) return { present: false, context: "" };
  if (hits.length > 1) {
    throw new GateContextError(
      `${GATE_CONTEXT_KEY} appears ${hits.length} times in the Helm values (lines ${hits.map((h) => h.lineNumber).join(", ")}); refusing to guess which one the deployment ships.`,
    );
  }

  return { present: true, context: parseScalar(hits[0].rest, hits[0].lineNumber) };
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
 * so the only two states this MAPPING may produce are "fail fast" and "let it
 * through". (That is a claim about the mapping, not about the process: the
 * script can still exit non-zero on the class-1 failures listed in the header,
 * where no status can be written at all.)
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

/**
 * Class-3 outcome from the file header: the context is known but the mirror
 * itself could not run. Passing open under the real context turns what would
 * otherwise be an ejection into a visible status a human can act on, which is
 * the same fail-open posture the gate takes everywhere else.
 */
export function failOpenVerdict(error) {
  const reason = String(error?.message ?? error ?? "unknown error").split("\n")[0];
  return {
    state: "success",
    description: truncate(`Gate mirror failed (${reason}); passing open. See the merge-queue job log.`),
  };
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

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * The one call with no fail-open available: if we cannot post, we cannot
 * announce that we cannot post. Retry the transient shapes (`gh` 5xx, secondary
 * rate limit) before giving up, since giving up costs a re-stage.
 */
function postStatus({ repo, sha, context, verdict, attempts = 3 }) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      execFileSync(
        "gh",
        [
          "api",
          "-X",
          "POST",
          `repos/${repo}/statuses/${sha}`,
          "-f",
          `state=${verdict.state}`,
          "-f",
          `context=${context}`,
          "-f",
          `description=${verdict.description}`,
        ],
        { encoding: "utf8", stdio: ["ignore", "ignore", "inherit"] },
      );
      return;
    } catch (error) {
      if (attempt >= attempts) throw error;
      console.log(`::warning::Posting ${context} on ${sha.slice(0, 8)} failed (attempt ${attempt}/${attempts}); retrying.`);
      sleepSync(2000 * attempt);
    }
  }
}

/** Everything between "we know the context" and "we know the verdict". */
function determineVerdict({ repo, headRef, context }) {
  const prNumber = parsePrNumberFromQueueRef(headRef);
  if (!prNumber) {
    throw new Error(`could not parse a PR number out of merge_group head_ref ${headRef}`);
  }

  const prHeadSha = ghRaw(["api", `repos/${repo}/pulls/${prNumber}`, "--jq", ".head.sha"]);
  if (!/^[0-9a-f]{40}$/.test(prHeadSha)) {
    throw new Error(`unexpected head SHA for PR #${prNumber}: ${prHeadSha}`);
  }

  const statuses = gh(["api", `repos/${repo}/statuses/${prHeadSha}`, "--paginate"]);
  return {
    prNumber,
    prHeadSha,
    verdict: mirrorVerdict(selectLatestStatus(statuses, context), { prNumber, prHeadSha }),
  };
}

function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  const headRef = process.env.MERGE_GROUP_HEAD_REF;
  const headSha = process.env.MERGE_GROUP_HEAD_SHA;

  // Class 1: without these we cannot address the queue head, so there is no
  // status to fail open with. Fail fast rather than after the 6h timeout.
  if (!repo || !headRef || !headSha) {
    console.error("::error::GITHUB_REPOSITORY, MERGE_GROUP_HEAD_REF and MERGE_GROUP_HEAD_SHA are all required.");
    process.exit(1);
  }

  let resolved;
  try {
    resolved = readGateContext(readFileSync(VALUES_PATH, "utf8"));
  } catch (error) {
    // Class 1 again: the values file is gone, or names the key in a spelling we
    // refuse to guess at. Either way we do not know what context to post under.
    console.error(`::error::Cannot determine the comment-review gate context from ${VALUES_PATH}: ${error.message}`);
    process.exit(1);
  }

  if (!resolved.present || !resolved.context) {
    // Class 2. An absent or deliberately-empty key is how the gate is switched
    // off; writing nothing is the correct no-op. Writing a placeholder would
    // create a status the repo would then have to live with, since commit
    // statuses cannot be deleted.
    console.log("Comment-review gate context is not set in Helm values; nothing to mirror.");
    return;
  }

  const { context } = resolved;
  let outcome;
  try {
    outcome = determineVerdict({ repo, headRef, context });
  } catch (error) {
    // Class 3: context known, mirror failed. Say so under the real context.
    console.log(`::warning::Could not determine a gate verdict: ${error.message}`);
    outcome = { verdict: failOpenVerdict(error) };
  }

  try {
    postStatus({ repo, sha: headSha, context, verdict: outcome.verdict });
  } catch (error) {
    console.error(`::error::Could not post ${context} on queue head ${headSha.slice(0, 8)}: ${error.message}`);
    process.exit(1);
  }

  const source = outcome.prNumber
    ? `from PR #${outcome.prNumber} head ${outcome.prHeadSha.slice(0, 8)} `
    : "";
  console.log(
    `Mirrored ${context}=${outcome.verdict.state} ${source}onto queue head ${headSha.slice(0, 8)}: ${outcome.verdict.description}`,
  );
}

if (isMainModule()) main();
