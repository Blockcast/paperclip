#!/usr/bin/env node
/**
 * Detect open PR heads that carry NO `review` check-run.
 *
 * PEN-6352. `commitperclip PR Review` can end in `startup_failure`. That
 * conclusion publishes NO job, NO annotation and NO check-run, so the `review`
 * verdict is ABSENT at the head rather than red. Every reader that enumerates
 * check-runs -- the lander, a reviewing agent, a human reading the checks tab --
 * then sees a clean, complete set. The only surface carrying the fact is the
 * workflow run's own `conclusion`, which none of those readers consult.
 *
 * Measured 2026-11-09, re-derived from the data's own edges over 300 runs: 22
 * of the 26 `pull_request_target` runs in the 16:02:12Z -> 17:45:43Z window
 * ended `startup_failure` (84.6%), bracketed by 0.0% on both sides (181
 * prior-day runs and 26 post-burst runs). It left 15 open PRs with no `review`
 * verdict and nothing anywhere reporting it, and self-resolved with no action.
 * The cause is UNNAMED: a `startup_failure` has no job and no log to read, so
 * settling it needs Actions admin on the org. An earlier attribution of this
 * burst to a declared GitHub incident was WITHDRAWN -- the burst ended 26m54s
 * before that incident was declared. See PEN-6352.
 *
 * This re-sites the signal onto the check-run surface, where readers already
 * look, instead of asking every reader to learn a new one.
 *
 * Sibling, deliberately not merged with this one: review-gate-sweep.yml
 * backstops a lost Ally REVIEWER WAKE and keys on the absence of an Ally
 * consolidated report. This keys on the absence of a CHECK-RUN published by a
 * different producer (commitperclip-review.yml). Different producer, different
 * failure mode, disjoint predicates.
 *
 * Reads via GraphQL on purpose: it unions the check-run and commit-status
 * surfaces in one response, and the GraphQL budget is separate from the REST
 * core budget -- which this installation measurably exhausts (0/9650 observed
 * 2026-11-09T18:51Z, while GraphQL still had 9371).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const DEFAULT_CHECK_NAME = "review";
/**
 * The name this sweep publishes under. It is read back as well as written: a
 * row we posted is OUR OWN evidence, not a sibling check, so it must be
 * excluded from the sibling-check test, deduplicated rather than re-posted
 * hourly, and RETIRED once the real verdict arrives. A `neutral` row left
 * standing next to a present verdict is read by every latest-per-name reader
 * as "this head is still unproven" -- stale false evidence about a head that
 * is in fact reviewed, which is the exact reader population this exists for.
 */
export const SELF_CHECK_NAME = "review/verdict-present";
/**
 * A head where CI has reported almost nothing is in flight, not missing a
 * verdict. This is the PRIMARY discriminator and it is deliberately not a
 * clock: `Commit.pushedDate` is deprecated and now returns null on every node,
 * and `committedDate` is a lower bound on the push that a rebase moves
 * independently of it -- so an age derived from it flags freshly pushed heads.
 * "Other checks reported here and `review` did not" needs no clock at all.
 */
export const DEFAULT_MIN_SIBLING_CHECKS = 3;
/** Belt-and-braces only; the sibling-check test above does the real work. */
export const DEFAULT_GRACE_MINUTES = 20;

export const PR_PAGE_SIZE = 20;
export const SUITE_PAGE_SIZE = 20;
export const RUN_PAGE_SIZE = 50;

export const QUERY = `
query($o:String!,$r:String!,$cursor:String){
  repository(owner:$o,name:$r){
    pullRequests(states:OPEN,first:${PR_PAGE_SIZE},after:$cursor,orderBy:{field:UPDATED_AT,direction:DESC}){
      pageInfo{hasNextPage endCursor}
      nodes{
        number title isDraft url updatedAt
        author{login}
        commits(last:1){nodes{commit{
          oid committedDate
          checkSuites(first:${SUITE_PAGE_SIZE}){totalCount nodes{
            checkRuns(first:${RUN_PAGE_SIZE}){totalCount nodes{name conclusion status completedAt}}
          }}
          status{contexts{context state createdAt}}
        }}}
      }
    }
  }
}`;

/**
 * Collapse a head's check surface to one row per NAME, newest attempt winning,
 * unioned across check-runs and commit statuses.
 *
 * Returns `unreadable: true` rather than an empty map whenever the response
 * could not be shown to be complete. Two shapes mean "unproven", and both are
 * byte-indistinguishable from "clean" if you do not look for them:
 *
 *   - `nodes: null` with a positive `totalCount`. A GraphQL
 *     RESOURCE_LIMITS_EXCEEDED error nulls the field and leaves the count,
 *     while `data` stays populated. Measured on this repo at a 50x50x100
 *     fan-out: 343 path-scoped errors, every `checkRuns.nodes` null. (`gh`
 *     exits NON-ZERO on any `errors[]`, path-scoped ones included -- see
 *     `fetchPage`, which is why the body has to be recovered from the
 *     rejection rather than read off a successful exit.)
 *   - `totalCount` greater than the number of nodes returned: silent truncation.
 *
 * Either one, read as an empty set, reports EVERY PR as missing its verdict --
 * a repo-wide false CI outage. Absence is only absence when the read was whole.
 */
export function collapseHeadChecks(commit) {
  const suites = commit?.checkSuites?.nodes;
  if (!Array.isArray(suites)) return { byName: new Map(), unreadable: true };

  let unreadable = commit.checkSuites.totalCount > suites.length;
  const byName = new Map();

  for (const suite of suites) {
    const runs = suite?.checkRuns?.nodes;
    if (!Array.isArray(runs)) {
      unreadable = true;
      continue;
    }
    if (suite.checkRuns.totalCount > runs.length) unreadable = true;
    for (const run of runs) {
      // One check NAME can have several attempts at one head; a merge gate
      // reads the latest per name. A flat scan is a history, not a state.
      const previous = byName.get(run.name);
      const key = run.completedAt ?? "";
      if (!previous || key >= previous.key) byName.set(run.name, { key, run });
    }
  }

  for (const context of commit?.status?.contexts ?? []) {
    if (byName.has(context.context)) continue;
    byName.set(context.context, {
      key: context.createdAt ?? "",
      run: { name: context.context, conclusion: context.state, status: "COMPLETED" },
    });
  }

  return { byName, unreadable };
}

/**
 * Classify one pull request. Returns `{ verdict, reason?, finding?, resolution? }`
 * where verdict is "present" | "missing" | "resolved" | "skipped".
 *
 * "resolved" is the retirement arm: the watched verdict is present AND this
 * sweep's own `neutral` row is still standing at that head. The row published
 * while the verdict was absent does not expire on its own, and under the
 * latest-per-name collapse every merge gate performs it keeps reading as
 * "nothing measured this head" long after something did. So the detector has
 * to clear its own marker; nothing else will.
 */
export function classifyPullRequest(pr, options = {}) {
  const {
    checkName = DEFAULT_CHECK_NAME,
    selfCheckName = SELF_CHECK_NAME,
    minSiblingChecks = DEFAULT_MIN_SIBLING_CHECKS,
    graceMinutes = DEFAULT_GRACE_MINUTES,
    now = Date.now(),
  } = options;

  const commit = pr?.commits?.nodes?.[0]?.commit;
  if (!commit) return { verdict: "skipped", reason: "no head commit returned" };

  const { byName, unreadable } = collapseHeadChecks(commit);
  if (unreadable) {
    return { verdict: "skipped", reason: "head check surface incomplete; UNPROVEN, not clean" };
  }

  // Our own row is evidence we wrote. Counting it as a sibling check would let
  // the detector bootstrap its own in-flight test one head at a time.
  const siblingCount = [...byName.keys()].filter((name) => name !== selfCheckName).length;
  const own = byName.get(selfCheckName);
  const ownIsOpenFinding = Boolean(own) && String(own.run.conclusion ?? "").toUpperCase() === "NEUTRAL";

  const identity = {
    number: pr.number,
    url: pr.url,
    head: commit.oid,
    author: pr.author?.login ?? "unknown",
    isDraft: pr.isDraft,
    checkNamesPresent: siblingCount,
  };

  if (byName.has(checkName)) {
    if (!ownIsOpenFinding) return { verdict: "present" };
    return { verdict: "resolved", resolution: identity };
  }

  if (siblingCount < minSiblingChecks) {
    return { verdict: "skipped", reason: `only ${siblingCount} check(s) at head; CI has not reported yet` };
  }

  const ageMinutes = commit.committedDate
    ? Math.round((now - Date.parse(commit.committedDate)) / 60000)
    : Number.POSITIVE_INFINITY;
  if (ageMinutes < graceMinutes) {
    return { verdict: "skipped", reason: `head ${ageMinutes}m old, inside ${graceMinutes}m grace` };
  }

  return {
    verdict: "missing",
    finding: {
      ...identity,
      headAgeMinutes: Number.isFinite(ageMinutes) ? ageMinutes : null,
      // Already reported at this head: keep it in the report, do not post a
      // second identical row. Without this the head gains one row per hour.
      alreadyPublished: ownIsOpenFinding,
    },
  };
}

/**
 * Recover the response body from a `gh api graphql` invocation that may have
 * exited non-zero.
 *
 * MEASURED 2026-11-09, and it is the whole reason this helper exists: `gh`
 * exits NON-ZERO whenever the response carries any `errors[]`, PATH-SCOPED
 * ONES INCLUDED, while still printing a complete `data` to stdout. A
 * `RESOURCE_LIMITS_EXCEEDED` on one nested field is a partial result -- the
 * case this sweep is built to notice and report as UNPROVEN -- and it arrives
 * as a rejected promise, not a return value. Reading only the resolved path
 * puts every partial-result branch downstream of a throw, i.e. unreachable.
 *
 *   gh api graphql -f query='{repository(owner:"Blockcast",name:"paperclip"){
 *     a:issue(number:1){number} b:issue(number:999999999){number}}}'
 *   -> rc=1, stdout={"data":{...},"errors":[{"type":"NOT_FOUND","path":[...]}]}
 *
 * So: take stdout from either outcome, and only re-throw the original error
 * when there is no parseable body to work with -- a genuine transport,
 * auth or rate-limit failure, where failing loudly is correct.
 */
export async function readGraphqlBody(runner, args) {
  let stdout;
  try {
    ({ stdout } = await runner("gh", args));
  } catch (error) {
    stdout = error?.stdout;
    if (typeof stdout !== "string" || stdout.trim() === "") throw error;
    let recovered;
    try {
      recovered = JSON.parse(stdout);
    } catch {
      throw error;
    }
    // A body with no `data` carries no result to salvage; the non-zero exit is
    // the honest verdict and must stay fatal.
    if (recovered?.data == null) throw error;
    return recovered;
  }
  return JSON.parse(stdout);
}

async function fetchPage({ owner, repo, cursor, runner }) {
  const args = ["api", "graphql", "-F", `o=${owner}`, "-F", `r=${repo}`, "-f", `query=${QUERY}`];
  if (cursor) args.push("-F", `cursor=${cursor}`);
  // Never pipe a GraphQL response through `--jq`: one path-scoped error makes
  // `gh` print nothing and exit non-zero while `data` is complete, which reads
  // as a total transport failure over a response that is entirely in hand.
  const body = await readGraphqlBody(runner, args);
  const errors = body.errors ?? [];
  const fatal = errors.filter((error) => !Array.isArray(error.path));
  if (fatal.length) throw new Error(`GraphQL: ${fatal.map((error) => error.message).join("; ")}`);
  return { page: body.data.repository.pullRequests, errorTypes: errors.map((error) => error.type ?? "partial") };
}

export async function sweep({ owner, repo, checkName, runner }) {
  const findings = [];
  const resolutions = [];
  const skipped = [];
  const partialErrorTypes = new Set();
  let cursor = null;
  let scanned = 0;

  do {
    const { page, errorTypes } = await fetchPage({ owner, repo, cursor, runner });
    for (const type of errorTypes) partialErrorTypes.add(type);
    for (const pr of page.nodes) {
      scanned += 1;
      const result = classifyPullRequest(pr, { checkName });
      if (result.verdict === "missing") findings.push(result.finding);
      else if (result.verdict === "resolved") resolutions.push(result.resolution);
      else if (result.verdict === "skipped") skipped.push({ number: pr.number, reason: result.reason });
    }
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);

  const byNumber = (a, b) => a.number - b.number;
  return {
    owner,
    repo,
    checkName,
    selfCheckName: SELF_CHECK_NAME,
    scanned,
    findings: findings.sort(byNumber),
    resolutions: resolutions.sort(byNumber),
    skipped: skipped.sort(byNumber),
    partialErrorTypes: [...partialErrorTypes],
    measuredAt: new Date().toISOString(),
  };
}

const invokedDirectly = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  const report = await sweep({
    owner: process.env.SWEEP_OWNER ?? "Blockcast",
    repo: process.env.SWEEP_REPO ?? "paperclip",
    checkName: process.env.SWEEP_CHECK_NAME || DEFAULT_CHECK_NAME,
    runner: (file, args) => execFileAsync(file, args, { maxBuffer: 64 * 1024 * 1024 }),
  });
  console.log(JSON.stringify(report, null, 2));
}
