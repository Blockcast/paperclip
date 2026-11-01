#!/usr/bin/env node

/**
 * Measure how much of the comment stream `GET /api/issues/:id/activity` actually
 * records, split by the two variables that determine it (PEN-5158).
 *
 * The fleet reads that endpoint as an audit surface and reasons from its
 * silence. It is not one: `issue.comment_added` is written by the HTTP comment
 * handlers in `server/src/routes/issues.ts`, never by `issues.addComment()`, so
 * coverage is a property of HOW a comment was created. Two independent gaps
 * follow and they must not be averaged into one rate — see `docs/api/activity.md`.
 *
 *   authorType=system  -> 0% coverage, categorical. The producer (reconciler,
 *                         sweep, watchdog, webhook) calls the service directly
 *                         and never reaches a route. Holds even when the
 *                         producer supplied an idempotencyKey.
 *   keyed route path   -> durable. Comment insert and the `comment_activity`
 *                         effect-ledger row commit in one transaction, and a
 *                         reconciler drives the effect to completion.
 *   unkeyed route path -> best-effort. The comment commits first and the
 *                         activity row is an unledgered follow-up, so anything
 *                         that interrupts the window loses it permanently.
 *
 * WHY THIS REPORTS BOTH DIRECTIONS. The failure being tracked is itself an
 * instrument that only ever returns "absent", so a probe that only shouts on a
 * miss is indistinguishable from a probe that is not running. This one always
 * prints the covered counts next to the uncovered ones, and it refuses to
 * return a verdict at all when it has nothing to measure: an empty or
 * below-threshold sample exits NO_SAMPLE (2), never 0. "I looked and it was
 * clean" and "I had nothing to look at" are different answers and are reported
 * differently.
 *
 * The join is `comments[].id <-> activity[? action=="issue.comment_added"]
 * .details.commentId`, restricted to comments created at or after the oldest
 * activity row on the issue. That window matters: an issue whose log predates
 * none of its comments would otherwise score its whole early history as lost.
 *
 * The comment side is PAGED with the `after` cursor. One `?limit=500` request
 * returns the oldest 500 and does not say so, which would bias the sample
 * toward old comments on exactly the long-lived rows most worth measuring.
 *
 * Exit codes:
 *   0  measured, documented contract held
 *   1  measured, contract VIOLATED (see below)
 *   2  could not measure (no sample, or the API refused)
 *
 * A violation is one of:
 *   - a keyed agent/user comment with no activity row  -> the effect ledger,
 *     which is supposed to make that write unloseable, dropped one.
 *   - a system comment WITH an activity row            -> the 0% rule in
 *     docs/api/activity.md is stale and the doc must be rewritten.
 *
 * The unkeyed loss rate is REPORTED, not failed on: it is a known, documented
 * ~2-3% background rate, and failing on it would make this a nag rather than a
 * detector. Pass --max-unkeyed-loss-pct to assert a ceiling in CI.
 *
 * Usage:
 *   node scripts/check-issue-activity-comment-coverage.mjs --issue PEN-1593
 *   node scripts/check-issue-activity-comment-coverage.mjs --limit 120
 *   node scripts/check-issue-activity-comment-coverage.mjs --limit 120 --json
 *
 * Reads PAPERCLIP_API_URL and PAPERCLIP_API_KEY from the environment. The key
 * is never printed, including in error paths.
 */

export const EXIT_OK = 0;
export const EXIT_VIOLATION = 1;
export const EXIT_NO_SAMPLE = 2;

/** Below this many joined comments the sample cannot support a verdict. */
export const DEFAULT_MIN_SAMPLE = 20;

/**
 * Page size for the comment walk. The route clamps `limit` to
 * `MAX_ISSUE_COMMENT_LIMIT` (500, `server/src/routes/issues.ts`), so asking for
 * more silently returns this many and the walk must notice.
 */
export const COMMENTS_PAGE_SIZE = 500;

/** Safety stop for the comment walk. 20 x 500 = 10,000 comments on one issue. */
export const MAX_COMMENT_PAGES = 20;

/**
 * Decide how to continue a keyset walk of `GET /issues/:id/comments?order=asc`.
 *
 * Paging at all is the point: a single `?limit=500` request on an issue with
 * more than 500 comments returns the OLDEST 500 and says nothing about it. That
 * cannot produce a false violation here (the logged-id set is drawn from the
 * unlimited activity endpoint, so it stays a superset), but it silently biases
 * the sample toward old comments — and a silent prefix presented as a whole
 * reading is the exact failure mode this probe was written to expose. A probe
 * that commits that error while measuring it is not worth much.
 *
 * Termination is decided on BOTH a short page and a page that contributes no
 * new ids, rather than on the cursor contract alone. `after` is documented as
 * strictly exclusive in both orders (PEN-4458), but a deployment predating that
 * fix returns the anchor again at the head of every ascending page, which turns
 * a cursor walk into an infinite loop that never adds a row. Deduping on `id`
 * makes the walk correct under both behaviours instead of trusting the one.
 *
 * Pure so the walk's stopping rules are testable without a live deployment.
 *
 * @param {Array<{id?: string}>} page    rows from the latest request
 * @param {Set<string>} seenIds          ids already collected by this walk
 * @param {number} pageSize              the limit that was requested
 * @returns {{fresh: Array, done: boolean, reason: string|null, cursor: string|null}}
 */
export function planNextCommentsPage(page, seenIds, pageSize = COMMENTS_PAGE_SIZE) {
  const fresh = page.filter((row) => row?.id && !seenIds.has(row.id));
  // A short page means the server had nothing more to give.
  if (page.length < pageSize) return { fresh, done: true, reason: "short_page", cursor: null };
  // A full page of rows we already hold = an inclusive-cursor server. Stop.
  if (fresh.length === 0) return { fresh, done: true, reason: "no_new_rows", cursor: null };
  const cursor = page[page.length - 1]?.id ?? null;
  // No id to anchor on: continuing would re-request the same page forever.
  if (!cursor) return { fresh, done: true, reason: "no_cursor", cursor: null };
  return { fresh, done: false, reason: null, cursor };
}

/**
 * Classify one comment against the set of commentIds the activity log covers.
 * Split out so the test can exercise the matrix without a live deployment.
 */
export function classifyComment(comment, loggedCommentIds) {
  const authorType = comment.authorType ?? "unknown";
  const path = comment.idempotencyKey ? "keyed" : "unkeyed";
  const logged = loggedCommentIds.has(comment.id);
  return { authorType, path, logged };
}

/**
 * Fold classified comments into the report. `logged` and `unlogged` are both
 * carried for every cell so the output can state coverage positively.
 */
export function summarize(comments, loggedCommentIds) {
  const cells = new Map();
  for (const comment of comments) {
    const { authorType, path, logged } = classifyComment(comment, loggedCommentIds);
    const key = `${authorType}/${path}`;
    const cell = cells.get(key) ?? { authorType, path, logged: 0, unlogged: 0 };
    if (logged) cell.logged += 1;
    else cell.unlogged += 1;
    cells.set(key, cell);
  }
  return [...cells.values()].sort((a, b) =>
    a.authorType.localeCompare(b.authorType) || a.path.localeCompare(b.path));
}

/**
 * Apply the documented contract to a summary.
 *
 * Returns the violations only — the caller decides the exit code, because
 * "no violations" is a verdict this function must not be able to emit on an
 * empty summary. See `decide`.
 */
export function findViolations(summary) {
  const violations = [];
  for (const cell of summary) {
    const routeAuthored = cell.authorType === "agent" || cell.authorType === "user";
    if (routeAuthored && cell.path === "keyed" && cell.unlogged > 0) {
      violations.push({
        kind: "keyed_comment_unlogged",
        detail: `${cell.unlogged} keyed ${cell.authorType} comment(s) have no issue.comment_added row; `
          + "the effect ledger is supposed to make that write unloseable.",
        cell,
      });
    }
    if (cell.authorType === "system" && cell.logged > 0) {
      violations.push({
        kind: "system_comment_logged",
        detail: `${cell.logged} system comment(s) DO have an issue.comment_added row; `
          + "the 0% rule in docs/api/activity.md is stale and must be rewritten.",
        cell,
      });
    }
  }
  return violations;
}

/** Total comments the summary was built from. */
export function sampleSize(summary) {
  return summary.reduce((n, c) => n + c.logged + c.unlogged, 0);
}

/** Unkeyed agent/user loss, as a percentage, or null when nothing was sampled. */
export function unkeyedLossPct(summary) {
  let total = 0;
  let lost = 0;
  for (const cell of summary) {
    if (cell.authorType !== "agent" && cell.authorType !== "user") continue;
    if (cell.path !== "unkeyed") continue;
    total += cell.logged + cell.unlogged;
    lost += cell.unlogged;
  }
  return total === 0 ? null : (100 * lost) / total;
}

/**
 * The whole point of the probe: turn a summary into an answer that can come
 * back three ways, never conflating "clean" with "unmeasured".
 */
export function decide(summary, options = {}) {
  const minSample = options.minSample ?? DEFAULT_MIN_SAMPLE;
  const size = sampleSize(summary);
  if (size < minSample) {
    return {
      code: EXIT_NO_SAMPLE,
      verdict: "NO_SAMPLE",
      reason: `joined ${size} comment(s), need >= ${minSample} to support a verdict`,
      violations: [],
    };
  }
  const violations = findViolations(summary);
  if (violations.length > 0) {
    return { code: EXIT_VIOLATION, verdict: "VIOLATION", reason: null, violations };
  }
  const loss = unkeyedLossPct(summary);
  const ceiling = options.maxUnkeyedLossPct;
  // A ceiling that arrived as NaN (a typo'd flag) must not read as "no ceiling".
  // Silently disabling an assertion on malformed input is the same failure this
  // probe exists to catch, so refuse the run instead of passing it.
  if (ceiling !== undefined && !Number.isFinite(ceiling)) {
    return {
      code: EXIT_NO_SAMPLE,
      verdict: "NO_SAMPLE",
      reason: `--max-unkeyed-loss-pct is not a finite number (${String(ceiling)})`,
      violations: [],
    };
  }
  if (typeof ceiling === "number" && loss !== null && loss > ceiling) {
    return {
      code: EXIT_VIOLATION,
      verdict: "VIOLATION",
      reason: `unkeyed loss ${loss.toFixed(2)}% exceeds --max-unkeyed-loss-pct ${ceiling}`,
      violations: [],
    };
  }
  return { code: EXIT_OK, verdict: "OK", reason: null, violations: [] };
}

/* c8 ignore start -- live-deployment I/O, exercised by hand not in unit tests */

function parseArgs(argv) {
  const args = { limit: 60, json: false, issue: null, company: null, minSample: DEFAULT_MIN_SAMPLE, maxUnkeyedLossPct: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--issue") args.issue = argv[++i];
    else if (a === "--company") args.company = argv[++i];
    else if (a === "--limit") args.limit = Number(argv[++i]);
    else if (a === "--min-sample") args.minSample = Number(argv[++i]);
    else if (a === "--max-unkeyed-loss-pct") args.maxUnkeyedLossPct = Number(argv[++i]);
    else if (a === "--json") args.json = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const base = process.env.PAPERCLIP_API_URL?.replace(/\/$/, "");
  const key = process.env.PAPERCLIP_API_KEY;
  if (!base || !key) {
    console.error("PAPERCLIP_API_URL and PAPERCLIP_API_KEY must be set");
    process.exit(EXIT_NO_SAMPLE);
  }
  const headers = { Authorization: `Bearer ${key}` };
  // Never let a failure echo the URL with credentials attached.
  const get = async (path) => {
    const res = await fetch(`${base}${path}`, { headers });
    if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
    return res.json();
  };
  const asArray = (body) => Array.isArray(body) ? body : (body.comments ?? body.issues ?? body.data ?? []);

  let targets;
  if (args.issue) {
    targets = [{ id: args.issue, identifier: args.issue }];
  } else {
    const companyId = args.company ?? process.env.PAPERCLIP_COMPANY_ID;
    if (!companyId) {
      console.error("--company or PAPERCLIP_COMPANY_ID is required when --issue is not given");
      process.exit(EXIT_NO_SAMPLE);
    }
    targets = asArray(await get(`/api/companies/${companyId}/issues?limit=500`)).slice(0, args.limit);
  }

  // Walks every page rather than taking the first 500, and reports it when the
  // page cap stops it short -- a truncated read is unproven, never clean.
  const fetchAllComments = async (issueId) => {
    const seen = new Set();
    const all = [];
    let cursor = null;
    for (let pages = 0; pages < MAX_COMMENT_PAGES; pages++) {
      const query = `limit=${COMMENTS_PAGE_SIZE}&order=asc${cursor ? `&after=${encodeURIComponent(cursor)}` : ""}`;
      const page = asArray(await get(`/api/issues/${issueId}/comments?${query}`));
      const step = planNextCommentsPage(page, seen, COMMENTS_PAGE_SIZE);
      for (const comment of step.fresh) {
        seen.add(comment.id);
        all.push(comment);
      }
      if (step.done) return { comments: all, truncated: false };
      cursor = step.cursor;
    }
    return { comments: all, truncated: true };
  };

  const sampledComments = [];
  const loggedCommentIds = new Set();
  const truncatedIssues = [];
  let reachable = 0;
  for (const target of targets) {
    let comments;
    let activity;
    try {
      const walked = await fetchAllComments(target.id);
      comments = walked.comments;
      if (walked.truncated) truncatedIssues.push(target.identifier ?? target.id);
      activity = asArray(await get(`/api/issues/${target.id}/activity`));
    } catch (err) {
      console.error(`skipped ${target.identifier ?? target.id}: ${err.message}`);
      continue;
    }
    if (activity.length === 0 || comments.length === 0) continue;
    reachable += 1;
    for (const row of activity) {
      if (row.action !== "issue.comment_added") continue;
      if (row?.details?.commentId) loggedCommentIds.add(row.details.commentId);
    }
    const coverageOpensAt = Math.min(...activity.map((row) => +new Date(row.createdAt)));
    for (const comment of comments) {
      if (+new Date(comment.createdAt) < coverageOpensAt) continue;
      sampledComments.push(comment);
    }
  }

  const summary = summarize(sampledComments, loggedCommentIds);
  const decision = decide(summary, { minSample: args.minSample, maxUnkeyedLossPct: args.maxUnkeyedLossPct });
  const loss = unkeyedLossPct(summary);
  const report = {
    issuesReachable: reachable,
    truncatedIssues,
    sample: sampleSize(summary),
    unkeyedLossPct: loss === null ? null : Number(loss.toFixed(3)),
    cells: summary,
    verdict: decision.verdict,
    reason: decision.reason,
    violations: decision.violations,
  };

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`issues reachable: ${reachable}   comments joined: ${report.sample}`);
    console.table(summary.map((c) => ({
      authorType: c.authorType,
      path: c.path,
      logged: c.logged,
      unlogged: c.unlogged,
      coverage: `${((100 * c.logged) / (c.logged + c.unlogged)).toFixed(1)}%`,
    })));
    console.log(`unkeyed agent/user loss: ${loss === null ? "n/a" : `${loss.toFixed(2)}%`}`);
    if (truncatedIssues.length > 0) {
      console.log(`  ! sample TRUNCATED on ${truncatedIssues.length} issue(s) at the ${MAX_COMMENT_PAGES}-page cap: ${truncatedIssues.join(", ")}`);
    }
    console.log(`verdict: ${decision.verdict}${decision.reason ? ` (${decision.reason})` : ""}`);
    for (const v of decision.violations) console.log(`  ! ${v.kind}: ${v.detail}`);
  }
  process.exit(decision.code);
}

const invokedDirectly = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(EXIT_NO_SAMPLE);
  });
}
/* c8 ignore stop */
