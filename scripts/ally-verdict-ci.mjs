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
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const ALLY_APP_ID = 3966421;
export const ACTIONS_APP_ID = 15368;
export const COMMENT_FINDINGS_CHECK = "gate/ally-comment-findings";
export const HEAD_ATTESTED_CHECK = "ci/ally-head-attested";
export const LOCK_JOB_NAME = "ally-verdict";
export const PR_WORKFLOW_FILE = "pr.yml";
export const PR_WORKFLOW_NAME = "PR";
export const DISPATCHER_WORKFLOW_FILE = "dispatch-ally-verdict-ci.yml";
export const MAX_BACKSTOP_DISPATCHES = 10;
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
export function rerunDecision(run, lockJobs) {
  if (run === null) return { rerun: false, reason: `no pull_request run of ${PR_WORKFLOW_FILE} at this head` };
  if (run.status !== "completed") {
    return { rerun: false, reason: `run ${run.id} is ${run.status} (attempt ${run.run_attempt}); covered while live` };
  }
  if (run.run_attempt !== 1) {
    return {
      rerun: false,
      reason:
        `run ${run.id} is already at attempt ${run.run_attempt}; the automatic unlock fires only on attempt 1. ` +
        `After Ally's verdict at this head, re-run its failed jobs by hand`,
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
  if (event === "workflow_dispatch") {
    const number = process.env.INPUT_PR_NUMBER ?? "";
    if (!PR_NUMBER.test(number)) throw new Error(`pr_number is not a PR number: ${JSON.stringify(number)}`);
    const pull = await api.get(`/repos/${repository}/pulls/${number}`);
    const head = String(pull?.head?.sha ?? "");
    if (pull?.state !== "open" || !FULL_SHA.test(head)) {
      await summary(`PR #${number} is not open with a readable head; nothing to unlock.`);
      return setOutputs({ pr_number: "", head_sha: "" });
    }
    return setOutputs({ pr_number: number, head_sha: head });
  }
  if (event === "check_run") {
    const head = process.env.CHECK_HEAD_SHA ?? "";
    if (!FULL_SHA.test(head)) throw new Error(`check_run head_sha is not a full SHA: ${JSON.stringify(head)}`);
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
  if (process.env.ELIGIBLE !== "true") {
    return summary(`${label}: not eligible, heavy lanes stay held: ${process.env.REASON || "no reason reported"}`);
  }
  let pull = await api.get(`/repos/${repository}/pulls/${number}`);
  const moved = liveHeadRefusal(pull, { headSha, repository });
  if (moved) return summary(`${label}: STOP, ${moved}`);
  const runs = await api.get(
    `/repos/${repository}/actions/workflows/${PR_WORKFLOW_FILE}/runs?head_sha=${headSha}&event=pull_request&per_page=100`,
  );
  const run = chooseRun(runs?.workflow_runs ?? [], { headSha, headRef: pull.head.ref, repository });
  const jobs = run === null || run.status !== "completed" || run.run_attempt !== 1
    ? []
    : (await api.get(`/repos/${repository}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`))?.jobs ?? [];
  const decision = rerunDecision(run, jobs);
  if (!decision.rerun) return summary(`${label} (${process.env.BASIS}): SKIP, ${decision.reason}`);
  // Re-read the head immediately before the write (design §3.6).
  pull = await api.get(`/repos/${repository}/pulls/${number}`);
  const movedNow = liveHeadRefusal(pull, { headSha, repository });
  if (movedNow) return summary(`${label}: STOP before re-run, ${movedNow}`);
  await api.post(`/repos/${repository}/actions/runs/${run.id}/rerun-failed-jobs`);
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

function resolvedPathOrNull(candidate) {
  try {
    return realpathSync(candidate);
  } catch {
    return null;
  }
}

const entrypoint = typeof process.argv[1] === "string" ? resolvedPathOrNull(process.argv[1]) : null;
if (entrypoint !== null && entrypoint === resolvedPathOrNull(fileURLToPath(import.meta.url))) {
  const modes = { resolve, unlock, backstop };
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
