#!/usr/bin/env node
// Ally-gated heavy CI, R1 unlock (design ally-gated-ci.md §3.5-§3.6, §4.2).
//
// Owner directive 2026-10-07 (~01:55Z): "also actively work to reduce and
// isolate CPU waste from CI. CI is suboptimal across the org as you saw in
// this conversation, with jobs running without new signal on each PR, or
// before ally approved resulting in CI runs that are unecessary."
//
// pr.yml's `ally_verdict` job holds the heavy lanes at a head until a typed,
// head-bound Ally verdict exists there. This script releases them, from
// trusted default-branch code only:
//
//   resolve   which PR and head an event names (dispatch-ally-verdict-ci.yml)
//   unlock    re-run the held pr.yml run's failed jobs, exactly once per head
//   backstop  one GraphQL batch over open PRs; re-fire the manual arm for a
//             head the event arms missed, or for every held head while
//             ALLY_GATED_CI_BYPASS=true (review-gate-sweep.yml)
//
// SCHEDULE-ONLY. Nothing here is merge authority: `verify` still needs every
// heavy lane, so a wrong decision costs CPU or latency, never a merge.
// Dependency-free on purpose: it runs on a bare arc-light checkout.
import { appendFile } from "node:fs/promises";
import { realpathSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { manualTestAuthorized } from './pr-test-request.mjs';

export const ALLY_APP_ID = 3966421;
export const ACTIONS_APP_ID = 15368;
export const COMMENT_FINDINGS_CHECK = "gate/ally-comment-findings";
export const HEAD_ATTESTED_CHECK = "ci/ally-head-attested";
export const LOCK_JOB_NAME = "ally-verdict";
export const PR_WORKFLOW_FILE = "pr.yml";
export const PR_WORKFLOW_NAME = "PR";
export const DISPATCHER_WORKFLOW_FILE = "dispatch-ally-verdict-ci.yml";
export const MAX_BACKSTOP_DISPATCHES = 10;
// Attestation-lag detector (PEN-5538). App 3966421 publishes the attestation
// pair twice per head: NEUTRAL at push time, then SUCCESS a few seconds after
// Ally submits the review. Measured on #3307's four consecutive heads
// (2026-11-04), the post-review pair landed 12s, 12s and 12s after the review
// on three of them -- and never on the fourth, which then sat unmergeable for
// 2h47m with nothing comparing the two timestamps.
//
// The missed publication itself is app 3966421's bug and is NOT fixable here:
// PEN-5545 carries it upstream. This detector is the compensating control
// named there, and it only reports -- releasing the hold is still '/test'.
//
// GRACE is the margin above that observed 12s before a head is called stranded:
// 50x the healthy figure, and two orders of magnitude under the strand. ALARM
// is when the job stops merely reporting and turns this repo's Actions tab red,
// on the same "surface it without a human noticing by hand" principle as the
// sweep's AC4 above it in review-gate-sweep.yml.
export const ATTESTATION_LAG_GRACE_SECONDS = 600;
export const ATTESTATION_LAG_ALARM_SECONDS = 3600;
export const MAX_ATTESTATION_LAG_REPORTED = 20;
// GraphQL `author { login }` returns a Bot node's login WITHOUT the `[bot]`
// suffix REST uses, so both spellings are accepted. The bare `allyblockcast`
// USER seat is a different principal that publishes no attestation, so the
// typename check below -- not this list -- is what excludes it.
export const ALLY_REVIEWER_LOGINS = ["allyblockcast", "allyblockcast[bot]", "app/allyblockcast"];
const FULL_SHA = /^[0-9a-f]{40}$/;
const PR_NUMBER = /^[1-9][0-9]{0,9}$/;
const sameRepo = (a, b) => typeof a === "string" && a.toLowerCase() === String(b).toLowerCase();

// --- pure decisions ----------------------------------------------------------

// Which open, same-repo PRs does a check_run at `headSha` belong to? Lowest
// number first; the backstop covers any second PR sharing the head.
export function pullsForHead(pulls, { headSha, repository, baseRef }) {
  return pulls
    .filter(
      (pull) =>
        pull?.state === "open" &&
        pull?.head?.sha === headSha &&
        sameRepo(pull?.head?.repo?.full_name, repository) &&
        pull?.base?.ref === baseRef,
    )
    .map((pull) => pull.number)
    .sort((a, b) => a - b);
}

// Head re-read: the decision is only ever made at the PR's LIVE head. pr.yml's
// concurrency is `pr-<n>` with cancel-in-progress, so re-running an OLD head's
// run would cancel the live head's run.
export function liveHeadRefusal(pull, { headSha, repository }) {
  if (pull?.state !== "open") return `PR #${pull?.number} is not open`;
  if (!sameRepo(pull?.head?.repo?.full_name, repository)) return `PR #${pull?.number} head is not in ${repository}`;
  if (pull?.head?.sha !== headSha) {
    return `head moved: evaluated ${String(headSha).slice(0, 7)}, live ${String(pull?.head?.sha).slice(0, 7)}`;
  }
  return null;
}

// The run to unlock: the newest (by id) pull_request run of pr.yml at the head,
// on this PR's branch. Another PR sharing the head has its own run and branch.
export function chooseRun(runs, { headSha, headRef, repository }) {
  let newest = null;
  for (const run of runs) {
    if (run?.event !== "pull_request" || run?.head_sha !== headSha || run?.head_branch !== headRef) continue;
    if (!sameRepo(run?.head_repository?.full_name, repository)) continue;
    if (!Number.isSafeInteger(run?.id)) continue;
    if (newest === null || run.id > newest.id) newest = run;
  }
  return newest;
}

// Exactly once per (head, lock): only attempt 1, only once it has completed,
// and only when the hold itself is what failed. Anything else is covered,
// live, or needs a human.
export function rerunDecision(run, lockJobs, manual = false) {
  if (run === null) return { rerun: false, reason: `no pull_request run of ${PR_WORKFLOW_FILE} at this head` };
  if (run.status !== "completed") {
    // Live is only "covered" while the run's own hold has yet to read the
    // verdict. Once it has concluded, the verdict is frozen out of this run;
    // the workflow_run arm re-evaluates it on completion (BLO-45984).
    const lock = lockJobs.find((job) => job?.name === LOCK_JOB_NAME);
    if (typeof lock?.conclusion === "string" && lock.conclusion !== "success") {
      return {
        rerun: false,
        reason:
          `run ${run.id} is ${run.status} but its '${LOCK_JOB_NAME}' job already concluded ${lock.conclusion}, ` +
          `so it cannot see this verdict; deferred to the workflow_run arm when the run completes`,
      };
    }
    return { rerun: false, reason: `run ${run.id} is ${run.status} (attempt ${run.run_attempt}); covered while live` };
  }
  if (manual && ['failure', 'cancelled', 'timed_out'].includes(run.conclusion)) {
    return { rerun: true, reason: `trusted /test retries the failed jobs of run ${run.id}` };
  }
  // PEN-5538 Defect B, and the decision recorded rather than the alternative.
  //
  // The test is on the attempt NUMBER alone: it does not ask whether a positive
  // signal existed when that earlier attempt ran. So an attempt 2 spent while
  // the head was still ineligible -- which could not have released anything, by
  // construction -- permanently moves the head from auto-releasing to hand-only.
  //
  // ⛔ NOT TAKEN: making the disqualification conditional (PEN-5538 §5.2), i.e.
  // declining to count an attempt whose own hold failed because no signal was
  // visible to it. The inference is sound -- a lock that concluded `failure` at
  // attempt N proves attempt N saw no positive signal -- but acting on it is
  // unbounded in exactly the case it is meant to fix. On #3307's `ea8ec0476`
  // the signal was never going to be published at all, so attempt 3 would have
  // failed the hold identically, and so would every attempt after it: one
  // dispatcher event per re-run, with no terminating condition short of a new
  // push. That is a CPU-waste loop, against the owner directive this file opens
  // with, and it would retire invariant I6 ("never a second automatic re-run",
  // ally-verdict-gate.test.mjs) which the exactly-once design rests on.
  //
  // ✅ TAKEN: §5.3 instead -- report the spend at the point of loss (see the
  // `::warning` in unlock() below) and name the recovery that still works, so
  // the cost is visible to whoever pays it. `spent` is reported, not acted on:
  // `rerun` stays false here in every branch.
  if (run.run_attempt !== 1) {
    return {
      rerun: false,
      spent: true,
      reason:
        `run ${run.id} is already at attempt ${run.run_attempt}; the automatic unlock fires only on attempt 1 ` +
        `and was spent there. This head is hand-only from here: comment '/test' on the PR (the trusted manual arm ` +
        `re-runs failed jobs at any attempt), or re-run its failed jobs by hand once Ally's verdict lands. ` +
        `If no verdict is coming, the attestation never published -- see the attestation-lag detector`,
    };
  }
  const locks = lockJobs.filter((job) => job?.name === LOCK_JOB_NAME);
  if (locks.length !== 1) {
    return { rerun: false, reason: `run ${run.id} has ${locks.length} '${LOCK_JOB_NAME}' jobs, expected 1; not a held run` };
  }
  const [lock] = locks;
  if (lock.conclusion === "success") return { rerun: false, reason: `run ${run.id}: heavy lanes already released (covered)` };
  if (lock.conclusion !== "failure") {
    return { rerun: false, reason: `run ${run.id}: '${LOCK_JOB_NAME}' concluded ${lock.conclusion}, not a hold` };
  }
  return { rerun: true, reason: `run ${run.id} attempt 1 holds the heavy lanes; re-running its failed jobs` };
}

const newestByDatabaseId = (nodes) =>
  nodes.reduce((best, node) => (Number.isSafeInteger(node?.databaseId) && (best === null || node.databaseId > best.databaseId) ? node : best), null);

// Same comparison as the shared predicate's bypassEnabled and the
// `vars.ALLY_GATED_CI_BYPASS == 'true'` expressions: case-insensitive, untrimmed.
export function bypassEnabled(value) {
  return typeof value === "string" && value.toLowerCase() === "true";
}

// Backstop pre-filter. COST ONLY, never authority: each candidate re-enters
// through the manual arm, which evaluates the shared predicate and the rerun
// rule above. A false negative waits for the next event; a false positive is
// one refused dispatcher run.
//
// Under the kill switch (`bypass`) the Ally signals are not consulted, because
// the predicate does not consult them either: every held attempt-1 head that
// meets the preconditions is a candidate. Those are the heads held before the
// switch was thrown, which no new push or verdict event would otherwise
// release.
export function selectBackstopCandidates(repositoryNode, repository, { bypass = false } = {}) {
  const base = repositoryNode?.defaultBranchRef?.name;
  const picked = [];
  for (const pr of repositoryNode?.pullRequests?.nodes ?? []) {
    if (pr?.isDraft !== false || pr?.baseRefName !== base) continue;
    if (!sameRepo(pr?.headRepository?.nameWithOwner, repository)) continue;
    const commit = pr?.commits?.nodes?.[0]?.commit;
    if (!commit || commit.oid !== pr.headRefOid) continue;
    if (bypass !== true) {
      const allyRuns = (commit.ally?.nodes ?? []).flatMap((suite) => suite?.checkRuns?.nodes ?? []);
      const findings = newestByDatabaseId(allyRuns.filter((run) => run?.name === COMMENT_FINDINGS_CHECK));
      const attested = newestByDatabaseId(allyRuns.filter((run) => run?.name === HEAD_ATTESTED_CHECK));
      if (findings?.conclusion === "FAILURE") continue;
      if (findings?.conclusion !== "SUCCESS" && attested?.conclusion !== "SUCCESS") continue;
    }
    const prSuites = (commit.actions?.nodes ?? []).filter(
      (suite) => suite?.workflowRun?.event === "pull_request" && suite?.workflowRun?.workflow?.name === PR_WORKFLOW_NAME,
    );
    const newest = prSuites.reduce(
      (best, suite) =>
        Number.isSafeInteger(suite?.workflowRun?.databaseId) &&
        (best === null || suite.workflowRun.databaseId > best.workflowRun.databaseId)
          ? suite
          : best,
      null,
    );
    const locks = newest?.checkRuns?.nodes ?? [];
    // One lock check-run in the suite means attempt 1 (a re-run adds one).
    if (locks.length === 1 && locks[0]?.conclusion === "FAILURE") picked.push(pr.number);
  }
  return picked.sort((a, b) => a - b);
}

export const BACKSTOP_QUERY = `query($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef { name }
    pullRequests(states: OPEN, first: 50, after: $cursor, orderBy: {field: UPDATED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number isDraft headRefOid baseRefName
        headRepository { nameWithOwner }
        commits(last: 1) { nodes { commit {
          oid
          ally: checkSuites(first: 5, filterBy: {appId: ${ALLY_APP_ID}}) {
            nodes { checkRuns(first: 20, filterBy: {checkType: ALL}) { nodes { databaseId name conclusion } } }
          }
          actions: checkSuites(first: 50, filterBy: {appId: ${ACTIONS_APP_ID}}) {
            nodes {
              workflowRun { databaseId event workflow { name } }
              checkRuns(first: 5, filterBy: {checkName: "${LOCK_JOB_NAME}", checkType: ALL}) { nodes { databaseId conclusion } }
            }
          }
        } } }
      }
    }
  }
}`;

// --- attestation-lag detector (PEN-5538) -------------------------------------

const epochMs = (value) => {
  const ms = Date.parse(String(value ?? ""));
  return Number.isFinite(ms) ? ms : null;
};

// Is this review the one app 3966421 reacts to? The App publishes the
// attestation for its OWN review. The same-named USER seat is a separate
// principal whose reviews produce no attestation, so counting it would invent
// a strand on every head a human-equivalent commented on (the mirror of the
// `claude[bot]` false negative recorded in review-gate-sweep.yml).
function isAllyAppReview(review, logins) {
  const login = String(review?.author?.login ?? "").toLowerCase();
  if (!logins.some((candidate) => candidate.toLowerCase() === login)) return false;
  return review?.author?.__typename === "Bot";
}

const newestEpoch = (nodes, pick) =>
  nodes.reduce((best, node) => {
    const ms = epochMs(pick(node));
    return ms !== null && (best === null || ms > best) ? ms : best;
  }, null);

// The one comparison §4 of PEN-5538 found nothing anywhere was making: at a
// PR's LIVE head, is the newest Ally review NEWER than the newest publication
// of the attestation it is supposed to produce?
//
// A finding needs BOTH halves, and the second is what keeps this quiet:
//
//   lag     newest Ally review at the head post-dates the newest
//           `ci/ally-head-attested` publication there by more than `grace`.
//           When nothing was ever published, the lag is measured from the
//           review to `now` instead -- "never" is the worst case, not a skip.
//   no      neither check-run base `decide()` admits is SUCCESS at that head.
//   signal  Without this a head whose attestation DID land late, or landed
//           FAILURE (a real blocking verdict, not a missing one), would be
//           reported as stranded. It also makes the finding set a subset of
//           the heads the hold is actually still holding.
//
// Deliberately mirrors selectBackstopCandidates' predicate rather than
// re-deriving one, so "positive signal" means the same thing in the detector
// and in the thing it detects the absence of. Like that predicate it reads the
// CHECK-RUN plane only and does not consult the `review/ally-complete` commit
// status: review-gate-sweep.yml records that this repo has no producer for it
// (0 of 100 open PRs carried it, measured 2026-08-20), so consulting it here
// would add a request per PR to read a column that is empty by construction.
//
// Pure: every bound arrives as an argument so the thresholds and `now` are
// fixed by the caller and testable without a clock.
export function attestationLagFindings(
  repositoryNode,
  repository,
  { nowMs, graceSeconds = ATTESTATION_LAG_GRACE_SECONDS, reviewerLogins = ALLY_REVIEWER_LOGINS } = {},
) {
  const base = repositoryNode?.defaultBranchRef?.name;
  const graceMs = graceSeconds * 1000;
  const findings = [];
  for (const pr of repositoryNode?.pullRequests?.nodes ?? []) {
    if (pr?.isDraft !== false || pr?.baseRefName !== base) continue;
    if (!sameRepo(pr?.headRepository?.nameWithOwner, repository)) continue;
    const commit = pr?.commits?.nodes?.[0]?.commit;
    // Stale read: the PR pushed while this page was being fetched. The next
    // sweep sees the new head; reporting the old one would name a dead SHA.
    if (!commit || commit.oid !== pr.headRefOid) continue;

    const reviewedAt = newestEpoch(
      (pr?.reviews?.nodes ?? []).filter(
        (review) => review?.commit?.oid === pr.headRefOid && isAllyAppReview(review, reviewerLogins),
      ),
      (review) => review?.submittedAt,
    );
    if (reviewedAt === null) continue;

    const allyRuns = (commit.ally?.nodes ?? []).flatMap((suite) => suite?.checkRuns?.nodes ?? []);
    const attestations = allyRuns.filter((run) => run?.name === HEAD_ATTESTED_CHECK);
    const findingsRuns = allyRuns.filter((run) => run?.name === COMMENT_FINDINGS_CHECK);
    if (attestations.some((run) => run?.conclusion === "SUCCESS")) continue;
    if (findingsRuns.some((run) => run?.conclusion === "SUCCESS")) continue;

    const publishedAt = newestEpoch(attestations, (run) => run?.completedAt ?? run?.startedAt);

    // Two different quantities, and conflating them is the trap. `lag` is the
    // SIGNATURE: review minus newest publication. On a healthy head it is about
    // -12s (the publication follows the review); in this failure it is positive
    // because the newest publication is the push-time NEUTRAL that PRECEDES the
    // review. Note it is a CONSTANT once both timestamps are fixed -- on
    // #3307's `ea8ec0476` it was +234s at minute one and still +234s at minute
    // 167. Thresholding on it would mean picking a number under 234s and
    // racing the healthy 12s path, so it is not what the thresholds read.
    //
    // `stranded` is the SEVERITY: review to now. That is what actually climbs,
    // and it is what both thresholds read. `grace` is therefore doing exactly
    // one job -- absorbing the seconds between a review landing and its
    // attestation landing -- rather than trying to encode how bad a lag is.
    if (publishedAt !== null && publishedAt >= reviewedAt) continue;
    const strandedMs = nowMs - reviewedAt;
    if (strandedMs <= graceMs) continue;

    findings.push({
      number: pr.number,
      head: pr.headRefOid,
      reviewedAt: new Date(reviewedAt).toISOString(),
      publishedAt: publishedAt === null ? null : new Date(publishedAt).toISOString(),
      lagSeconds: publishedAt === null ? null : Math.round((reviewedAt - publishedAt) / 1000),
      strandedSeconds: Math.round(strandedMs / 1000),
      // What the newest publication actually said, so a reader can tell the
      // "stuck on the push-time NEUTRAL" shape apart from "nothing at all".
      conclusion: publishedAt === null ? null : (newestByDatabaseId(attestations)?.conclusion ?? null),
      publications: attestations.length,
    });
  }
  return findings.sort((a, b) => b.strandedSeconds - a.strandedSeconds || a.number - b.number);
}

export const ATTESTATION_LAG_QUERY = `query($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef { name }
    pullRequests(states: OPEN, first: 50, after: $cursor, orderBy: {field: UPDATED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number isDraft headRefOid baseRefName
        headRepository { nameWithOwner }
        reviews(last: 20) { nodes { submittedAt author { login __typename } commit { oid } } }
        commits(last: 1) { nodes { commit {
          oid
          ally: checkSuites(first: 5, filterBy: {appId: ${ALLY_APP_ID}}) {
            nodes { checkRuns(first: 20, filterBy: {checkType: ALL}) { nodes { databaseId name conclusion startedAt completedAt } } }
          }
        } } }
      }
    }
  }
}`;

// --- GitHub I/O ----------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function makeApi({ apiUrl, token, fetchImpl = fetch, attempts = 3, timeoutMs = 20_000 }) {
  async function call(method, path, body) {
    const url = new URL(path, apiUrl).href;
    for (let attempt = 1; ; attempt += 1) {
      let response;
      try {
        response = await fetchImpl(url, {
          method,
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${token}`,
            "X-GitHub-Api-Version": "2022-11-28",
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        if (attempt >= attempts) throw error;
        await sleep(1000 * 2 ** (attempt - 1));
        continue;
      }
      const transient = response.status >= 500 || response.status === 429;
      if (transient && attempt < attempts && method === "GET") {
        await sleep(1000 * 2 ** (attempt - 1));
        continue;
      }
      const text = await response.text();
      if (!response.ok) throw new Error(`GitHub API ${response.status} for ${method} ${new URL(url).pathname}: ${text.slice(0, 300)}`);
      return text === "" ? null : JSON.parse(text);
    }
  }
  return { get: (path) => call("GET", path), post: (path, body) => call("POST", path, body) };
}

async function setOutputs(values) {
  if (!process.env.GITHUB_OUTPUT) return;
  await appendFile(process.env.GITHUB_OUTPUT, Object.entries(values).map(([k, v]) => `${k}=${v}\n`).join(""));
}

async function summary(line) {
  console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${line}\n\n`);
}

function context() {
  const repository = process.env.GITHUB_REPOSITORY ?? "";
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error(`GITHUB_REPOSITORY is not owner/name: ${JSON.stringify(repository)}`);
  const token = process.env.GITHUB_TOKEN ?? "";
  if (token === "") throw new Error("GITHUB_TOKEN is empty");
  return { repository, api: makeApi({ apiUrl: process.env.GITHUB_API_URL || "https://api.github.com", token }) };
}

async function resolve() {
  const { repository, api } = context();
  const event = process.env.EVENT_NAME ?? "";
  if (event === "workflow_dispatch" || event === "issue_comment") {
    const payload = event === 'issue_comment' ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')) : null;
    const number = payload ? String(payload.issue.number) : process.env.INPUT_PR_NUMBER ?? "";
    if (!PR_NUMBER.test(number)) throw new Error(`pr_number is not a PR number: ${JSON.stringify(number)}`);
    const pull = await api.get(`/repos/${repository}/pulls/${number}`);
    const head = String(pull?.head?.sha ?? "");
    if (pull?.state !== "open" || !FULL_SHA.test(head)) {
      await summary(`PR #${number} is not open with a readable head; nothing to unlock.`);
      return setOutputs({ pr_number: "", head_sha: "" });
    }
    return setOutputs({ pr_number: number, head_sha: head });
  }
  if (event === "check_run" || event === "workflow_run") {
    const head = process.env.CHECK_HEAD_SHA ?? "";
    if (!FULL_SHA.test(head)) throw new Error(`${event} head_sha is not a full SHA: ${JSON.stringify(head)}`);
    const baseRef = process.env.DEFAULT_BRANCH ?? "";
    const pulls = await api.get(`/repos/${repository}/commits/${head}/pulls?per_page=100`);
    const numbers = pullsForHead(Array.isArray(pulls) ? pulls : [], { headSha: head, repository, baseRef });
    if (numbers.length === 0) {
      await summary(`No open same-repo PR into ${baseRef} has head ${head}; nothing to unlock.`);
      return setOutputs({ pr_number: "", head_sha: "" });
    }
    if (numbers.length > 1) {
      console.log(`::warning title=ally-verdict dispatch::Head ${head} is shared by PRs ${numbers.join(", ")}; unlocking #${numbers[0]} now, the hourly backstop covers the rest.`);
    }
    return setOutputs({ pr_number: String(numbers[0]), head_sha: head });
  }
  throw new Error(`unsupported event ${JSON.stringify(event)}`);
}

async function unlock() {
  const { repository, api } = context();
  const number = process.env.PR_NUMBER ?? "";
  const headSha = process.env.HEAD_SHA ?? "";
  if (!PR_NUMBER.test(number) || !FULL_SHA.test(headSha)) {
    throw new Error(`need PR_NUMBER and a full HEAD_SHA, got ${JSON.stringify(number)} ${JSON.stringify(headSha)}`);
  }
  const label = `PR #${number} at ${headSha}`;
  const manual = process.env.MANUAL === 'true' && manualTestAuthorized(
    await api.get(`/repos/${repository}/commits/${headSha}/statuses?per_page=100`),
  );
  if (!manual && process.env.ELIGIBLE !== "true") {
    return summary(`${label}: not eligible, heavy lanes stay held: ${process.env.REASON || "no reason reported"}`);
  }
  let pull = await api.get(`/repos/${repository}/pulls/${number}`);
  const moved = liveHeadRefusal(pull, { headSha, repository });
  if (moved) return summary(`${label}: STOP, ${moved}`);
  const runs = await api.get(
    `/repos/${repository}/actions/workflows/${PR_WORKFLOW_FILE}/runs?head_sha=${headSha}&event=pull_request&per_page=100`,
  );
  const run = chooseRun(runs?.workflow_runs ?? [], { headSha, headRef: pull.head.ref, repository });
  const jobs = run === null || run.run_attempt !== 1
    ? []
    : (await api.get(`/repos/${repository}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`))?.jobs ?? [];
  const decision = rerunDecision(run, jobs, manual);
  if (!decision.rerun) return summary(`${label} (${process.env.BASIS}): SKIP, ${decision.reason}`);
  // Re-read the head immediately before the write (design §3.6).
  pull = await api.get(`/repos/${repository}/pulls/${number}`);
  const movedNow = liveHeadRefusal(pull, { headSha, repository });
  if (movedNow) return summary(`${label}: STOP before re-run, ${movedNow}`);
  await api.post(`/repos/${repository}/actions/runs/${run.id}/rerun-failed-jobs`);
  // PEN-5538 §5.3: this re-run moves the run to attempt 2, and rerunDecision
  // refuses every later automatic unlock at this head on the attempt number
  // alone. Said out loud at the moment it is spent, because the cost used to be
  // invisible until someone read the check-run timestamps by hand 2h47m later.
  // Not a failure: the spend is correct here -- a positive signal is present, so
  // this re-run can actually release the hold.
  if (!manual) {
    console.log(
      `::warning title=ally-verdict unlock::${label}: this re-run spends the ONLY automatic unlock for this head ` +
        `(attempt 1 -> 2). If '${LOCK_JOB_NAME}' fails again, no later verdict event can release it: ` +
        `comment '/test' on the PR, or re-run the failed jobs by hand.`,
    );
  }
  return summary(`${label} (${process.env.BASIS}): UNLOCKED, ${decision.reason}: ${run.html_url ?? run.id}`);
}

async function backstop() {
  const { repository, api } = context();
  const [owner, name] = repository.split("/");
  let repositoryNode = null;
  const nodes = [];
  let cursor = null;
  for (let page = 0; page < 4; page += 1) {
    const result = await api.post("/graphql", { query: BACKSTOP_QUERY, variables: { owner, name, cursor } });
    if (result?.errors?.length) throw new Error(`GraphQL: ${JSON.stringify(result.errors).slice(0, 500)}`);
    repositoryNode = result?.data?.repository ?? null;
    nodes.push(...(repositoryNode?.pullRequests?.nodes ?? []));
    const info = repositoryNode?.pullRequests?.pageInfo;
    if (!info?.hasNextPage) break;
    cursor = info.endCursor;
  }
  const bypass = bypassEnabled(process.env.ALLY_GATED_CI_BYPASS ?? "");
  const candidates = selectBackstopCandidates({ ...repositoryNode, pullRequests: { nodes } }, repository, { bypass });
  const base = repositoryNode?.defaultBranchRef?.name;
  if (!base) throw new Error("could not read the default branch");
  const fired = candidates.slice(0, MAX_BACKSTOP_DISPATCHES);
  for (const number of fired) {
    await api.post(`/repos/${repository}/actions/workflows/${DISPATCHER_WORKFLOW_FILE}/dispatches`, {
      ref: base,
      inputs: { pr_number: String(number) },
    });
  }
  const capped = candidates.length > fired.length ? `; ${candidates.length - fired.length} over the cap wait for the next sweep` : "";
  const which = bypass
    ? "ALLY_GATED_CI_BYPASS=true, so every held head qualifies, whatever its Ally signals"
    : "held head(s) with a positive Ally signal";
  return summary(
    `Ally verdict backstop: ${nodes.length} open PR(s) read; ${which}: ` +
      `${candidates.length === 0 ? "none" : candidates.map((n) => `#${n}`).join(", ")}; re-fired the manual arm for ` +
      `${fired.length}${capped}.`,
  );
}

// PEN-5538 Done-when 1. Schedule-driven, like backstop() above and for the
// same reason: the condition it looks for IS a lost event, so it must not
// depend on an event to notice. One batched GraphQL read, no writes at all.
async function attestationLag() {
  const { repository, api } = context();
  const [owner, name] = repository.split("/");
  let repositoryNode = null;
  const nodes = [];
  let cursor = null;
  for (let page = 0; page < 4; page += 1) {
    const result = await api.post("/graphql", { query: ATTESTATION_LAG_QUERY, variables: { owner, name, cursor } });
    if (result?.errors?.length) throw new Error(`GraphQL: ${JSON.stringify(result.errors).slice(0, 500)}`);
    repositoryNode = result?.data?.repository ?? null;
    nodes.push(...(repositoryNode?.pullRequests?.nodes ?? []));
    const info = repositoryNode?.pullRequests?.pageInfo;
    if (!info?.hasNextPage) break;
    cursor = info.endCursor;
  }
  if (!repositoryNode?.defaultBranchRef?.name) throw new Error("could not read the default branch");

  const grace = Number(process.env.ATTESTATION_LAG_GRACE_SECONDS ?? "") || ATTESTATION_LAG_GRACE_SECONDS;
  const alarm = Number(process.env.ATTESTATION_LAG_ALARM_SECONDS ?? "") || ATTESTATION_LAG_ALARM_SECONDS;
  const findings = attestationLagFindings({ ...repositoryNode, pullRequests: { nodes } }, repository, {
    nowMs: Date.now(),
    graceSeconds: grace,
  });

  if (findings.length === 0) {
    return summary(
      `Ally attestation-lag: ${nodes.length} open PR(s) read; no head carries an Ally review older than ${grace}s ` +
        `with no \`${HEAD_ATTESTED_CHECK}\` publication behind it.`,
    );
  }
  for (const f of findings.slice(0, MAX_ATTESTATION_LAG_REPORTED)) {
    const published = f.publishedAt === null
      ? "never published (0 publications)"
      : `newest of ${f.publications} publication(s) is ${f.publishedAt} (${f.conclusion}), ${f.lagSeconds}s BEFORE the review`;
    console.log(
      `::warning title=ally attestation lag::PR #${f.number} head ${f.head.slice(0, 9)}: Ally reviewed at ` +
        `${f.reviewedAt}, ${published}. Stranded ${f.strandedSeconds}s. The heavy lanes stay held at this head ` +
        `and no verdict event is coming -- comment '/test' on the PR to release them.`,
    );
  }
  const worst = findings[0];
  const over = findings.filter((f) => f.strandedSeconds >= alarm);
  await summary(
    `Ally attestation-lag: ${nodes.length} open PR(s) read; **${findings.length}** head(s) carry an Ally review ` +
      `with no attestation behind it. Worst: #${worst.number} at ${worst.head.slice(0, 9)}, stranded ` +
      `${worst.strandedSeconds}s. ${over.length} at or past the ${alarm}s alarm.`,
  );
  // AC4, the same escalation review-gate-sweep.yml's sweep job uses: a stranded
  // head must become visible without a human reading timestamps by hand, and a
  // scheduled job's step summary is not read. Past `alarm` this turns the
  // Actions tab red. Below it the warnings above are the whole report, so a
  // transient few-second race never reddens the tab.
  if (over.length > 0) {
    process.exitCode = 1;
    console.log(
      `::error title=ally attestation lag::${over.length} head(s) past the ${alarm}s alarm: ` +
        `${over.map((f) => `#${f.number}@${f.head.slice(0, 9)} (${f.strandedSeconds}s)`).join(", ")}`,
    );
  }
}

function resolvedPathOrNull(candidate) {
  try {
    return realpathSync(candidate);
  } catch {
    return null;
  }
}

const entrypoint = typeof process.argv[1] === "string" ? resolvedPathOrNull(process.argv[1]) : null;
if (entrypoint !== null && entrypoint === resolvedPathOrNull(fileURLToPath(import.meta.url))) {
  const modes = { resolve, unlock, backstop, "attestation-lag": attestationLag };
  const mode = modes[process.argv[2]];
  if (!mode) {
    console.error(`usage: ally-verdict-ci.mjs ${Object.keys(modes).join("|")}`);
    process.exitCode = 2;
  } else {
    mode().catch((error) => {
      console.log(`::error title=ally-verdict ${process.argv[2]}::${String(error?.message ?? error).replace(/[\r\n]+/g, " ")}`);
      process.exitCode = 1;
    });
  }
}
