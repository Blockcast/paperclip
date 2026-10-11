#!/usr/bin/env node
// Ally verdict dispatch predicate: may heavy CI start at this pull request head now?
//
// SCHEDULE-ONLY. This decides WHEN a consumer's heavy lanes start, never
// WHETHER they are required, and it is never merge authority. Required-ness
// comes only from each consumer's own fail-closed aggregator on its default
// branch, so a missing, late, forged or mutated signal here can start heavy CI
// early (a CPU cost) or late (latency); it cannot make a gate pass. Do not make
// this a required status, and do not read its output as review evidence.
//
// Why it exists (owner directive, 2026-10-07): "also actively work to reduce
// and isolate CPU waste from CI. CI is suboptimal across the org as you saw in
// this conversation, with jobs running without new signal on each PR, or before
// ally approved resulting in CI runs that are unecessary."
//
//   eligible(PR, H) = preconditions(PR, H)
//                     AND NOT (A in {failure, error} OR B == failure)
//                     AND (A == success OR B == success OR S == success)
//
//   A  commit status  review/ally-complete        creator github-actions[bot]
//   B  check-run      gate/ally-comment-findings  app.id 3966421
//   S  check-run      ci/ally-head-attested       app.id 3966421 (schedule-only)
//
// Each signal is read at the exact 40-hex head and is the NEWEST BY ID, never
// "any success": pim #3583's head carried a failing B check-run and then a
// passing one. B and S drop every other app before selecting. A selects across
// ALL creators (GitHub's effective state for the context) and is positive only
// when that newest row is a github-actions[bot] success, so another creator can
// take the positive away or block, never clear. B is read only as a
// check-run. Its same-named commit status reports success for `not_evaluated`
// (recorded on pim #3669), so it is fail-open and never read.
//
// ALLY_GATED_CI_BYPASS=true replaces everything after the preconditions with
// true: the kill switch for an Ally or Paperclip outage. Carry-forward (opt-in)
// admits a clean two-parent merge of default-branch history into a PR on the
// default branch whose net PR diff hashes like a verdict-clean first parent's;
// see carryForward below.
import { execFile, spawn } from "node:child_process";
import { appendFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const ALLY_APP_ID = 3966421;
export const ALLY_COMPLETE_CONTEXT = "review/ally-complete";
export const COMMENT_FINDINGS_CHECK = "gate/ally-comment-findings";
export const HEAD_ATTESTED_CHECK = "ci/ally-head-attested";
// Login alone would do (a User login cannot contain brackets), but all three
// recorded fields are bound so a near-miss on any of them is refused.
export const ACTIONS_BOT = Object.freeze({ login: "github-actions[bot]", id: 41898282, type: "Bot" });
export const BASES = Object.freeze(["ally-complete", "comment-findings-clean", "head-attested", "carry-forward", "bypass"]);

const FULL_SHA = /^[0-9a-f]{40}$/;
// A list longer than this is refused rather than read truncated: a newest-by-id
// answer from a partial list is a guess.
const MAX_PAGES = 10;
const MAX_RATE_LIMIT_WAIT_MS = 60_000;

class InputError extends Error {}

// --- signal selection (pure) ------------------------------------------------

export function newestById(items) {
  let newest = null;
  for (const item of items) {
    if (!Number.isSafeInteger(item?.id) || item.id <= 0) {
      throw new Error(`cannot order a signal by id: ${JSON.stringify(item?.id)}`);
    }
    if (newest === null || item.id > newest.id) newest = item;
  }
  return newest;
}

function isActionsBot(creator) {
  return (
    creator?.login === ACTIONS_BOT.login && creator?.id === ACTIONS_BOT.id && creator?.type === ACTIONS_BOT.type
  );
}

// A: the newest review/ally-complete status from ANY creator, which is what
// GitHub itself reports for the context. Only a success written by
// github-actions[bot] is positive (`bound: false` marks any other writer);
// failure and error block whoever wrote them. The reconcile sweep writes its
// fail-closed corrections (pending, failure) through `status-github-token`, an
// App token: filtering creators BEFORE selection would discard such a
// correction and read the superseded success, dispatching at a head the gate
// marked failing. So a lookalike can delay heavy CI, never start it.
export function readAllyComplete(statuses) {
  const newest = newestById(statuses.filter((row) => row?.context === ALLY_COMPLETE_CONTEXT));
  if (newest === null) return { state: "absent", id: null };
  const state = String(newest.state);
  if (isActionsBot(newest.creator)) return { state, id: newest.id };
  const creator = `${newest.creator?.login ?? "unknown"} (${newest.creator?.id ?? "?"})`;
  return { state, id: newest.id, bound: false, creator };
}

// B or S: the newest same-named check-run at `headSha` from app 3966421.
export function readAllyCheck(checkRuns, name, headSha) {
  const newest = newestById(
    checkRuns.filter((run) => run?.name === name && run?.app?.id === ALLY_APP_ID && run?.head_sha === headSha),
  );
  if (newest === null) return { state: "absent", id: null };
  return { state: newest.status === "completed" ? String(newest.conclusion) : "in_progress", id: newest.id };
}

function describeSignal(name, signal) {
  const details = [];
  if (signal.id !== null) details.push(`id ${signal.id}`);
  if (signal.bound === false) details.push(`written by ${signal.creator}, not ${ACTIONS_BOT.login}`);
  return `${name}=${signal.state}${details.length === 0 ? "" : ` (${details.join(", ")})`}`;
}

export function decide({ allyComplete, commentFindings, headAttested }) {
  const named = [
    describeSignal(ALLY_COMPLETE_CONTEXT, allyComplete),
    describeSignal(COMMENT_FINDINGS_CHECK, commentFindings),
    describeSignal(HEAD_ATTESTED_CHECK, headAttested),
  ];
  const blocking = [];
  if (allyComplete.state === "failure" || allyComplete.state === "error") blocking.push(named[0]);
  if (commentFindings.state === "failure") blocking.push(named[1]);
  if (blocking.length > 0) {
    return { eligible: false, blocked: true, basis: "", reason: `blocked by ${blocking.join(", ")}` };
  }
  const basis =
    allyComplete.state === "success" && allyComplete.bound !== false
      ? "ally-complete"
      : commentFindings.state === "success"
        ? "comment-findings-clean"
        : headAttested.state === "success"
          ? "head-attested"
          : "";
  if (basis === "") {
    return { eligible: false, blocked: false, basis, reason: `no positive Ally signal: ${named.join(", ")}` };
  }
  return { eligible: true, blocked: false, basis, reason: `${basis}: ${named.join(", ")}` };
}

export function preconditionRefusal(pull, { repository, headSha }) {
  const number = pull?.number;
  if (pull?.state !== "open") return `PR #${number} is not open (state ${JSON.stringify(pull?.state)})`;
  if (pull.draft === true) return `PR #${number} is a draft`;
  if (pull.draft !== false) return `PR #${number} draft flag is unreadable (${JSON.stringify(pull.draft)})`;
  const headRepo = pull.head?.repo?.full_name;
  if (typeof headRepo !== "string" || headRepo.toLowerCase() !== String(repository).toLowerCase()) {
    return `PR #${number} head is not in ${repository} (fork or deleted head repository: ${JSON.stringify(headRepo ?? null)})`;
  }
  const live = pull.head?.sha;
  if (typeof live !== "string" || !FULL_SHA.test(live)) return `PR #${number} live head is not a full SHA`;
  if (headSha && live !== headSha) {
    return `PR #${number} head moved: evaluated ${headSha.slice(0, 7)}, live ${live.slice(0, 7)}`;
  }
  return null;
}

// Case-insensitive like the `vars.ALLY_GATED_CI_BYPASS == 'true'` conjuncts in
// consumer YAML, so one repository variable means one thing everywhere. Not
// trimmed, for the same reason: an expression does not trim either.
export function bypassEnabled(value) {
  return typeof value === "string" && value.toLowerCase() === "true";
}

// --- GitHub reads -----------------------------------------------------------

// Named for the validator's indirect env-read scan (scripts/validate-action-manifest.mjs),
// which pairs every env name read here with the manifest's step env.
function positiveNumberEnv(name, fallback) {
  const value = Number(process.env[name] ?? "");
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isTransientResponse(response) {
  const rateLimited =
    response.status === 429 ||
    (response.status === 403 &&
      (response.headers.get("retry-after") !== null || response.headers.get("x-ratelimit-remaining") === "0"));
  return rateLimited || response.status >= 500;
}

function waitMilliseconds(response, attempt, backoffSeconds) {
  const retryAfter = Number(response?.headers.get("retry-after") ?? "");
  if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1000;
  const reset = Number(response?.headers.get("x-ratelimit-reset") ?? "");
  if (Number.isFinite(reset) && reset > 0) return Math.max(0, reset * 1000 - Date.now()) + 1000;
  return backoffSeconds * 1000 * 2 ** (attempt - 1) * (0.5 + Math.random());
}

function makeApi({ apiUrl, token, repository }) {
  const origin = new URL(apiUrl).origin;
  const maxAttempts = Math.floor(positiveNumberEnv("REQUEST_MAX_ATTEMPTS", 3));
  const timeoutMs = positiveNumberEnv("REQUEST_TIMEOUT_SECONDS", 20) * 1000;
  const backoffSeconds = positiveNumberEnv("REQUEST_BACKOFF_SECONDS", 1);

  async function get(url) {
    for (let attempt = 1; ; attempt += 1) {
      let response = null;
      try {
        response = await fetch(url, {
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${token}`,
            "X-GitHub-Api-Version": "2022-11-28",
          },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        // undici reports a network failure as a TypeError WITH a cause; one
        // without a cause is a programming fault and is not retried.
        const transient = (error instanceof TypeError && error.cause !== undefined) || error?.name === "TimeoutError";
        if (!transient || attempt >= maxAttempts) throw error;
      }
      if (response !== null) {
        if (response.ok) return { body: await response.json(), link: response.headers.get("link") };
        if (!isTransientResponse(response) || attempt >= maxAttempts) {
          throw new Error(`GitHub API ${response.status} for ${new URL(url).pathname}`);
        }
      }
      const wait = waitMilliseconds(response, attempt, backoffSeconds);
      if (wait > MAX_RATE_LIMIT_WAIT_MS) throw new Error(`GitHub API wait of ${Math.ceil(wait / 1000)}s exceeds the retry cap`);
      console.log(`retrying ${new URL(url).pathname} after attempt ${attempt}/${maxAttempts} in ${Math.ceil(wait)}ms`);
      await sleep(wait);
    }
  }

  // Follows Link rel="next" on the API's own origin only, up to MAX_PAGES.
  async function getAll(path, rowsOf) {
    let url = new URL(path, apiUrl).href;
    const rows = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const { body, link } = await get(url);
      rows.push(...rowsOf(body));
      const next = /<([^>]+)>;\s*rel="next"/.exec(link ?? "")?.[1];
      if (!next) return rows;
      if (new URL(next).origin !== origin) throw new Error(`refusing a pagination link off ${origin}`);
      url = next;
    }
    throw new Error(`${path.split("?")[0]} has more than ${MAX_PAGES} pages; refusing to read a truncated list`);
  }

  const repo = `/repos/${repository}`;
  return {
    pull: async (number) => (await get(new URL(`${repo}/pulls/${number}`, apiUrl).href)).body,
    statuses: (sha) => getAll(`${repo}/commits/${sha}/statuses?per_page=100`, (body) => body),
    checkRuns: (sha, name) =>
      getAll(
        `${repo}/commits/${sha}/check-runs?check_name=${encodeURIComponent(name)}&filter=all&per_page=100`,
        (body) => body.check_runs ?? [],
      ),
  };
}

async function readSignals(api, sha) {
  const [statuses, findings, attested] = await Promise.all([
    api.statuses(sha),
    api.checkRuns(sha, COMMENT_FINDINGS_CHECK),
    api.checkRuns(sha, HEAD_ATTESTED_CHECK),
  ]);
  return {
    allyComplete: readAllyComplete(statuses),
    commentFindings: readAllyCheck(findings, COMMENT_FINDINGS_CHECK, sha),
    headAttested: readAllyCheck(attested, HEAD_ATTESTED_CHECK, sha),
  };
}

// --- carry-forward ------------------------------------------------------------
//
// carry(PR, H') holds iff, on git objects:
//   0. the PR's base IS the repository's default branch. The PR author picks
//      (and can retarget) the base, so "base history" vouches for nothing on
//      any other branch: a stacked or retargeted base can merge content no
//      review saw while the net PR diff stays identical;
//   1. H' has exactly two parents (P1, P2): octopus and single-parent refuse;
//   2. P1 itself is eligible on its own signals (no live-head precondition);
//   3. P2 is default-branch history (`merge-base --is-ancestor P2 <base>`);
//   4. the net PR diff hashes identically across the update:
//        diff(merge-base(P1, P2), P1) and diff(merge-base(H', base), H')
//      share a `git patch-id --verbatim`. `--verbatim` keeps whitespace, so an
//      indentation-only rewrite (YAML, Python) refuses. It also selects the
//      stable (file-order independent) algorithm: git rejects `--stable
//      --verbatim` together ("cannot be used together", git 2.50), because
//      verbatim mode is stable mode without whitespace stripping;
//   5. H' is exactly git's own clean merge of P1 and P2: `git merge-tree
//      --write-tree P1 P2` exits 0 (no conflict) and its tree is H'^{tree}.
//      The patch-id ignores hunk line numbers, so a merge that moves the PR's
//      hunk to identical context elsewhere in a file hashes alike; this
//      refuses it, and refuses every conflict resolution.
// It only schedules: the review gate still needs its own review at H'.
// Context lines are hashed too, so a base edit within three lines of a PR hunk
// also refuses, which is the safe direction (wait for a verdict).

async function gitOut(args, options = {}) {
  const { stdout } = await execFileAsync("git", args, {
    maxBuffer: 16 * 1024 * 1024,
    timeout: 300_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    ...options,
  });
  return stdout.trim();
}

async function isAncestor(ancestor, descendant) {
  try {
    await gitOut(["merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch (error) {
    if (error.code === 1) return false;
    throw error;
  }
}

async function soleMergeBase(a, b) {
  const bases = (await gitOut(["merge-base", "--all", a, b])).split("\n").filter(Boolean);
  return bases.length === 1 ? bases[0] : null;
}

// The tree of git's own merge of `ours` and `theirs`, or null when it conflicts.
async function cleanMergeTree(ours, theirs) {
  let out;
  try {
    out = await gitOut(["merge-tree", "--write-tree", "--no-messages", ours, theirs]);
  } catch (error) {
    if (error.code === 1) return null;
    throw error;
  }
  const tree = out.split("\n")[0];
  if (!FULL_SHA.test(tree)) throw new Error(`unparseable git merge-tree output for ${ours} and ${theirs}`);
  return tree;
}

// `git diff <from> <to> | git patch-id --verbatim`, streamed so a
// large diff is never buffered whole. Returns the patch-id, or "" for no diff.
function patchId(from, to) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
    const diff = spawn(
      "git",
      ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "--full-index", from, to],
      { env, stdio: ["ignore", "pipe", "pipe"] },
    );
    const id = spawn("git", ["patch-id", "--verbatim"], { env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let errors = "";
    const failures = [];
    diff.stdout.pipe(id.stdin);
    diff.stderr.on("data", (chunk) => (errors += chunk));
    id.stderr.on("data", (chunk) => (errors += chunk));
    id.stdout.on("data", (chunk) => (out += chunk));
    const exited = (child, label) =>
      new Promise((done) =>
        child.on("close", (code) => {
          if (code !== 0) failures.push(`${label} exited ${code}`);
          done();
        }),
      );
    diff.on("error", reject);
    id.on("error", reject);
    Promise.all([exited(diff, "git diff"), exited(id, "git patch-id")]).then(() => {
      if (failures.length > 0) reject(new Error(`${failures.join(", ")}: ${errors.trim()}`));
      else resolve(out.trim().split(/\s+/)[0] ?? "");
    });
  });
}

export async function carryForward({ api, pull, head }) {
  const base = String(pull.base?.ref ?? "");
  if (base === "" || base.startsWith("-")) throw new Error(`unusable base ref ${JSON.stringify(base)}`);
  const defaultBranch = pull.base?.repo?.default_branch;
  if (typeof defaultBranch !== "string" || defaultBranch === "") {
    return {
      holds: false,
      reason: `the repository's default branch is unreadable (${JSON.stringify(defaultBranch ?? null)}); only a PR into it carries a verdict`,
    };
  }
  if (base !== defaultBranch) {
    return {
      holds: false,
      reason: `base ${base} is not the default branch ${defaultBranch}; only default-branch history vouches for a merged parent`,
    };
  }
  await gitOut(["check-ref-format", `refs/heads/${base}`]);
  if ((await gitOut(["rev-parse", "--is-shallow-repository"])) !== "false") {
    throw new Error("carry-forward needs full history; the checkout is shallow (use fetch-depth: 0)");
  }
  const headRef = "refs/verdict-dispatch/head";
  const baseRef = "refs/verdict-dispatch/base";
  await gitOut([
    "fetch",
    "--no-tags",
    "--no-recurse-submodules",
    "--quiet",
    "origin",
    `+${head}:${headRef}`,
    `+refs/heads/${base}:${baseRef}`,
  ]);
  if ((await gitOut(["rev-parse", "--verify", `${headRef}^{commit}`])) !== head) {
    throw new Error(`fetched head does not resolve to ${head}`);
  }
  const parents = (await gitOut(["rev-list", "--parents", "-n", "1", head])).split(" ").slice(1);
  if (parents.length !== 2) {
    const shape = parents.length > 2 ? "octopus merge" : "rebase-style or ordinary update";
    return { holds: false, reason: `${head.slice(0, 7)} has ${parents.length} parent${parents.length === 1 ? "" : "s"} (${shape}); only a two-parent base merge carries a verdict` };
  }
  const [p1, p2] = parents;
  if (!parents.every((sha) => FULL_SHA.test(sha))) throw new Error(`unparseable parents of ${head}`);
  const prior = decide(await readSignals(api, p1));
  if (!prior.eligible) {
    return { holds: false, reason: `first parent ${p1.slice(0, 7)} is not verdict-clean (${prior.reason})` };
  }
  if (!(await isAncestor(p2, baseRef))) {
    return { holds: false, reason: `second parent ${p2.slice(0, 7)} is not ${base} history` };
  }
  const before = await soleMergeBase(p1, p2);
  const after = await soleMergeBase(head, baseRef);
  if (before === null || after === null) {
    return { holds: false, reason: "merge bases are ambiguous (criss-cross history)" };
  }
  const [idBefore, idAfter] = [await patchId(before, p1), await patchId(after, head)];
  if (idBefore === "" || idAfter === "") return { holds: false, reason: "net PR diff is empty; nothing to compare" };
  if (idBefore !== idAfter) {
    return { holds: false, reason: `net PR diff changed across the merge (patch-id ${idBefore.slice(0, 12)} != ${idAfter.slice(0, 12)})` };
  }
  const merged = await cleanMergeTree(p1, p2);
  if (merged === null) {
    return { holds: false, reason: `${p1.slice(0, 7)} and ${p2.slice(0, 7)} conflict; a conflict resolution never carries a verdict` };
  }
  const tree = await gitOut(["rev-parse", "--verify", `${head}^{tree}`]);
  if (tree !== merged) {
    return {
      holds: false,
      reason: `${head.slice(0, 7)} is not the clean automatic merge of its parents (tree ${tree.slice(0, 12)} != ${merged.slice(0, 12)})`,
    };
  }
  return {
    holds: true,
    reason:
      `clean base merge of ${p2.slice(0, 7)} into ${p1.slice(0, 7)} leaves the net PR diff unchanged ` +
      `(patch-id ${idBefore.slice(0, 12)}); ${p1.slice(0, 7)} was ${prior.basis}`,
  };
}

// --- entrypoint ---------------------------------------------------------------

// Every env read below names its variable literally, so the manifest validator can
// hold this list and the action step's env block to the same set.
function readConfig() {
  const repository = process.env.GITHUB_REPOSITORY ?? "";
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) {
    throw new InputError(`GITHUB_REPOSITORY is not owner/name: ${JSON.stringify(repository)}`);
  }
  const number = process.env.VERDICT_DISPATCH_PULL_NUMBER ?? "";
  if (!/^[1-9][0-9]{0,9}$/.test(number)) throw new InputError(`pull-number is not a PR number: ${JSON.stringify(number)}`);
  const headSha = process.env.VERDICT_DISPATCH_HEAD_SHA ?? "";
  if (headSha !== "" && !FULL_SHA.test(headSha)) {
    throw new InputError(`head-sha must be a full lowercase 40-hex SHA: ${JSON.stringify(headSha)}`);
  }
  const bypass = process.env.ALLY_GATED_CI_BYPASS ?? "";
  const carry = process.env.VERDICT_DISPATCH_CARRY_FORWARD ?? "";
  for (const [name, value] of [
    ["ALLY_GATED_CI_BYPASS", bypass],
    ["carry-forward", carry],
  ]) {
    if (value !== "" && !["true", "false"].includes(value.toLowerCase())) {
      console.log(`${name}: ignoring unrecognised value ${JSON.stringify(value)}; treating it as unset.`);
    }
  }
  const token = process.env.GITHUB_TOKEN ?? "";
  if (token === "") throw new InputError("github-token is empty");
  return {
    apiUrl: process.env.GITHUB_API_URL || "https://api.github.com",
    token,
    repository,
    number,
    headSha,
    bypass: bypassEnabled(bypass),
    carry: bypassEnabled(carry),
  };
}

async function evaluate(config) {
  const api = makeApi(config);
  const pull = await api.pull(config.number);
  const refusal = preconditionRefusal(pull, config);
  const live = typeof pull?.head?.sha === "string" && FULL_SHA.test(pull.head.sha) ? pull.head.sha : "";
  const head = config.headSha || live;
  if (refusal) return { eligible: false, basis: "", head, reason: refusal };
  if (config.bypass) {
    return { eligible: true, basis: "bypass", head, reason: "ALLY_GATED_CI_BYPASS=true: heavy CI per push; enforcement unchanged" };
  }
  const decision = decide(await readSignals(api, head));
  if (decision.eligible || decision.blocked || !config.carry) {
    return { eligible: decision.eligible, basis: decision.basis, head, reason: decision.reason };
  }
  const carried = await carryForward({ api, pull, head });
  return carried.holds
    ? { eligible: true, basis: "carry-forward", head, reason: carried.reason }
    : { eligible: false, basis: "", head, reason: `${decision.reason}; carry-forward refused: ${carried.reason}` };
}

const oneLine = (text) => String(text).replace(/[\r\n]+/g, " ").slice(0, 1000);

async function main() {
  let result = { eligible: false, basis: "", head: "", reason: "" };
  let number = "";
  try {
    const config = readConfig();
    number = config.number;
    result.head = config.headSha;
    result = await evaluate(config);
  } catch (error) {
    result = { ...result, eligible: false, basis: "", reason: `error: ${error instanceof Error ? error.message : error}` };
    process.exitCode = 1;
  }
  const reason = oneLine(result.reason);
  const verdict = result.eligible ? `eligible (${result.basis})` : "not eligible";
  console.log(`verdict-dispatch: PR #${number || "?"} at ${result.head || "?"}: ${verdict}: ${reason}`);
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(
      process.env.GITHUB_OUTPUT,
      `eligible=${result.eligible}\nbasis=${result.basis}\nhead=${result.head}\nreason=${reason}\n`,
    );
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `### Ally verdict dispatch\n\nPR #${number || "?"} at \`${result.head || "?"}\`: **${verdict}**\n\n${reason}\n`,
    );
  }
}

// Same entrypoint guard as scripts/require-ally-review.mjs: both sides
// realpath'd, so importing this module (the tests, the wiring checker) never
// runs main(), and running it under --preserve-symlinks-main still does.
function resolvedPathOrNull(candidate) {
  try {
    return realpathSync(candidate);
  } catch {
    return null;
  }
}

const entrypointPath = typeof process.argv[1] === "string" ? resolvedPathOrNull(process.argv[1]) : null;
const modulePath = resolvedPathOrNull(fileURLToPath(import.meta.url));
if (entrypointPath !== null && modulePath !== null && entrypointPath === modulePath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
