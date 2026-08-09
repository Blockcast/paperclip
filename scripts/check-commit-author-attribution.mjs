#!/usr/bin/env node
/**
 * check-commit-author-attribution.mjs (BLO-21416)
 *
 * GitHub REST commit-creation endpoints (contents/merge API, MCP
 * `create_or_update_file`/`push_files`) default `commit.author` to the
 * authenticated identity when none is supplied. Every agent pod shares one
 * credential — the `allyblockcast[bot]` GitHub App installation (id
 * 290875700) — so any agent writing via that path gets stamped with the App,
 * not the acting agent. `git push` (git config identity set per-agent) is
 * unaffected. See AGENTS.md §9 and the BLO-21416 issue for the full writeup.
 *
 * Two independent modes, one shared assertion (`findAttributionOffenses`):
 *
 *   1. Local range mode (default; no network; used as a per-PR CI gate).
 *      Reads non-merge commits already present in a local checkout across a
 *      base..head range via `git log --no-merges`. `--no-merges` is the
 *      authoritative merge-commit exclusion here (matches BLO-21416's scope
 *      boundary: merge/squash-merge commits are legitimately App-attributed).
 *
 *   2. `--audit-merged` mode (network via `gh`; the AC's "automated
 *      verifying signal"). Selects PRs by MERGE TIME — every PR merged on or
 *      after `--since` (default 7d) across one or more repos — fetches each
 *      PR's own commit list and applies the same assertion. A PR's `/commits`
 *      entries are pre-squash source commits, each with exactly one parent
 *      unless the branch merged another ref in (multi-parent → excluded, same
 *      merge-commit exception as mode 1).
 *
 *      The window is a claim the tool can prove: it either audits every PR
 *      merged since that date, or reports INCOMPLETE. It deliberately does not
 *      offer a "last N merged PRs" mode — `gh pr list` orders by creation, so
 *      no count-based window can establish which PRs merged most recently.
 *
 * Both modes are read-only: this script never posts, comments, or writes.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const APP_NOREPLY_EMAIL = "290875700+allyblockcast[bot]@users.noreply.github.com";
export const DEFAULT_AUDIT_REPOS = ["Blockcast/trafficcontrol", "Blockcast/paperclip"];

/** Default lookback for `--audit-merged`, in days. */
export const DEFAULT_AUDIT_SINCE_DAYS = 7;

/**
 * The audit selects PRs by MERGE TIME, not by a count.
 *
 * A count-based window cannot be honest here: `gh pr list --state merged`
 * orders by creation, so "the last N merged PRs" is unknowable from the first
 * N (or 5N) rows — a long-running PR created outside the bound can merge most
 * recently and be silently skipped. Filtering on `merged:>=<date>` asks the
 * search API the question we actually mean, and the answer is complete for
 * that window as long as it fits under this cap.
 *
 * If a repo returns exactly this many PRs, the window did not fit and the
 * audit reports INCOMPLETE rather than claiming coverage it cannot prove.
 * Narrow `--since` in that case.
 */
export const AUDIT_PR_LIST_MAX = 300;

/**
 * `GET /pulls/{number}/commits` is hard-capped at 250 entries; `--paginate`
 * cannot reach past it. Beyond the cap the list is silently short, so an
 * offense at commit 251+ would read as a pass. Detect and fail closed instead.
 */
export const COMMITS_API_MAX = 250;

const UNIT_SEPARATOR = "\u001f";
const RECORD_SEPARATOR = "\u001e";

/**
 * Shared assertion: given normalized non-merge-or-merge-tagged commit
 * records, return the ones stamped with the shared App identity.
 * `commits` entries: { sha, authorEmail, parentCount, message, context? }.
 * A `parentCount` of 2+ is a merge commit and is always out of scope,
 * independent of which mode produced the record (defensive — mode 1 already
 * excludes these via `--no-merges`).
 */
export function findAttributionOffenses(commits) {
  return commits.filter(
    (commit) => (commit.parentCount ?? 1) <= 1 && commit.authorEmail === APP_NOREPLY_EMAIL,
  );
}

function parseLocalGitLog(rawOutput) {
  return rawOutput
    .split(RECORD_SEPARATOR)
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [sha, authorEmail, subject] = record.split(UNIT_SEPARATOR);
      return { sha, authorEmail, parentCount: 1, message: subject ?? "" };
    });
}

/**
 * Local mode: non-merge commits in `base..head` of a checked-out repo.
 * `execFileSync` (argv array, no shell) — `base`/`head` are refs/SHAs from
 * trusted CI-provided env, but this avoids any shell-injection surface either way.
 */
export function findLocalRangeOffenses({ repoRoot, base, head, execFile = execFileSync } = {}) {
  const format = `%H${UNIT_SEPARATOR}%ae${UNIT_SEPARATOR}%s${RECORD_SEPARATOR}`;
  const rawOutput = execFile(
    "git",
    ["log", "--no-merges", `--format=${format}`, `${base}..${head}`],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  const commits = parseLocalGitLog(rawOutput);
  return findAttributionOffenses(commits);
}

/**
 * Normalize `--since` to the `YYYY-MM-DD` form the search qualifier takes.
 * Accepts `<N>d` (relative) or an explicit `YYYY-MM-DD`.
 */
export function resolveSince(value, nowMs = Date.now()) {
  const raw = String(value ?? `${DEFAULT_AUDIT_SINCE_DAYS}d`).trim();
  const relative = /^(\d+)d$/.exec(raw);
  if (relative) {
    return new Date(nowMs - Number(relative[1]) * 86_400_000).toISOString().slice(0, 10);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new Error(`--since expects YYYY-MM-DD or <N>d, got ${JSON.stringify(raw)}`);
  }
  return raw;
}

/**
 * Newest merge first. Entries without a parseable `mergedAt` are dropped
 * rather than sorted to an arbitrary position — `gh` only omits it for PRs
 * that are not actually merged.
 */
export function sortByMergedAtDesc(prs) {
  return prs
    .map((pr) => ({ pr, mergedMs: Date.parse(pr.mergedAt ?? "") }))
    .filter((entry) => Number.isFinite(entry.mergedMs))
    .sort((a, b) => b.mergedMs - a.mergedMs)
    .map((entry) => entry.pr);
}

/**
 * Remote audit mode: every PR in `repo` merged on or after `since`, each PR's
 * own (pre-squash) commit list. `ghApi` is injected so tests never shell out.
 *
 * Two incompleteness signals travel with the result, both distinct from
 * "audited and clean":
 *   - `windowTruncated` — the merge-time window exceeded AUDIT_PR_LIST_MAX, so
 *     some merged PRs in it were never examined.
 *   - `truncated` — a PR's commit list hit COMMITS_API_MAX, so that PR was
 *     only partially examined.
 */
export async function auditRepoCommitAttribution({ repo, since, ghApi }) {
  const prsJson = await ghApi([
    "pr",
    "list",
    "--repo",
    repo,
    "--state",
    "merged",
    "--search",
    `merged:>=${since}`,
    "--limit",
    String(AUDIT_PR_LIST_MAX),
    "--json",
    "number,title,mergedAt",
  ]);
  const rawPrs = JSON.parse(prsJson);
  const windowTruncated = rawPrs.length >= AUDIT_PR_LIST_MAX;
  const prs = sortByMergedAtDesc(rawPrs);

  const offenses = [];
  const truncated = [];
  let totalCommits = 0;
  for (const pr of prs) {
    const commitsJson = await ghApi([
      "api",
      `repos/${repo}/pulls/${pr.number}/commits`,
      "--paginate",
    ]);
    // `gh api --paginate` concatenates each page's JSON array back-to-back
    // rather than merging them into one array — split on the page boundary.
    const commits = commitsJson
      .trim()
      .split(/(?<=])\s*(?=\[)/)
      .flatMap((page) => (page ? JSON.parse(page) : []));
    totalCommits += commits.length;
    if (commits.length >= COMMITS_API_MAX) {
      truncated.push({ repo, prNumber: pr.number, prTitle: pr.title, commitsSeen: commits.length });
    }
    const normalized = commits.map((commit) => ({
      sha: commit.sha,
      authorEmail: commit.commit?.author?.email ?? null,
      parentCount: commit.parents?.length ?? 1,
      message: (commit.commit?.message ?? "").split("\n")[0],
    }));
    for (const offense of findAttributionOffenses(normalized)) {
      offenses.push({ ...offense, repo, prNumber: pr.number, prTitle: pr.title });
    }
  }

  return {
    repo,
    since,
    prsChecked: prs.length,
    commitsChecked: totalCommits,
    offenses,
    truncated,
    windowTruncated,
    oldestMergedAt: prs.at(-1)?.mergedAt ?? null,
    newestMergedAt: prs[0]?.mergedAt ?? null,
  };
}

async function defaultGhApi(args) {
  return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

export async function runAudit({
  repos = DEFAULT_AUDIT_REPOS,
  since,
  ghApi = defaultGhApi,
  log = console.log,
} = {}) {
  const window = resolveSince(since);
  const results = [];
  for (const repo of repos) {
    const result = await auditRepoCommitAttribution({ repo, since: window, ghApi });
    results.push(result);
    const covered = result.oldestMergedAt
      ? `${result.oldestMergedAt} .. ${result.newestMergedAt}`
      : "no merged PRs in window";
    log(
      `${repo}: checked ${result.commitsChecked} non-merge commits across ${result.prsChecked} PRs merged since ${window} (${covered}) — ${result.offenses.length} App-attributed`,
    );
    for (const offense of result.offenses) {
      log(
        `  VIOLATION ${repo}#${offense.prNumber} ${offense.sha.slice(0, 7)} "${offense.message}" — ${offense.authorEmail}`,
      );
    }
    if (result.windowTruncated) {
      log(
        `  INCOMPLETE ${repo} — the window since ${window} contains at least ${AUDIT_PR_LIST_MAX} merged PRs, which is the fetch cap; merged PRs beyond it were NOT audited. Narrow --since.`,
      );
    }
    for (const partial of result.truncated) {
      log(
        `  INCOMPLETE ${repo}#${partial.prNumber} "${partial.prTitle}" — commit list hit the ${COMMITS_API_MAX}-entry API cap; commits past it were NOT audited`,
      );
    }
  }
  const allOffenses = results.flatMap((r) => r.offenses);
  const allTruncated = results.flatMap((r) => r.truncated);
  const windowTruncated = results.filter((r) => r.windowTruncated);
  return {
    passed: allOffenses.length === 0 && allTruncated.length === 0 && windowTruncated.length === 0,
    since: window,
    results,
    offenses: allOffenses,
    truncated: allTruncated,
    windowTruncated,
  };
}

function parseArgs(argv) {
  const args = { mode: "local" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--audit-merged") args.mode = "audit";
    else if (arg === "--repos") args.repos = argv[++i]?.split(",").map((r) => r.trim()).filter(Boolean);
    else if (arg === "--since") args.since = argv[++i];
    else if (arg === "--base") args.base = argv[++i];
    else if (arg === "--head") args.head = argv[++i];
  }
  return args;
}

function isMainModule() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.mode === "audit") {
    const { passed, offenses, truncated, windowTruncated, since } = await runAudit({
      repos: args.repos,
      since: args.since,
    });
    // Name which failure mode fired: an offense is a real violation, a
    // truncated result is an audit that could not complete. Reporting the
    // latter as the former would send someone hunting a commit the audit
    // never actually saw.
    if (offenses.length > 0) {
      console.error(
        `\n${offenses.length} non-merge commit(s) carry the shared App identity (${APP_NOREPLY_EMAIL}) instead of a per-agent author. See BLO-21416 / AGENTS.md §9.`,
      );
    }
    if (windowTruncated.length > 0) {
      console.error(
        `\n${windowTruncated.length} repo(s) had more than ${AUDIT_PR_LIST_MAX} PRs merged since ${since}, so the window could not be audited in full. Re-run with a narrower --since. This is an incomplete audit, not a clean one.`,
      );
    }
    if (truncated.length > 0) {
      console.error(
        `\n${truncated.length} PR(s) could not be fully audited: their commit list hit the ${COMMITS_API_MAX}-entry cap on GET /pulls/{number}/commits, so a violation past that point would be invisible. This is an incomplete audit, not a clean one.`,
      );
    }
    process.exit(passed ? 0 : 1);
  }

  const base = args.base ?? process.env.PR_BASE_SHA;
  const head = args.head ?? process.env.PR_HEAD_SHA ?? "HEAD";
  if (!base) {
    console.error("ERROR: --base (or PR_BASE_SHA) is required in local mode.");
    process.exit(2);
  }
  const offenses = findLocalRangeOffenses({ repoRoot: process.cwd(), base, head });
  if (offenses.length > 0) {
    console.error(
      `ERROR: ${offenses.length} commit(s) in ${base}..${head} carry the shared allyblockcast[bot] App identity instead of a per-agent author:\n`,
    );
    for (const offense of offenses) {
      console.error(`  ${offense.sha.slice(0, 7)} "${offense.message}" — ${offense.authorEmail}`);
    }
    console.error(
      "\nThis means the commit was created via the GitHub REST/MCP write path (contents API, merge API, or `create_or_update_file`/`push_files`), which always stamps the shared App credential — never `git push`. Use `git push` for repo commits; see AGENTS.md §9 (BLO-21416).",
    );
    process.exit(1);
  }
  console.log("  ✓  No commits in range carry the shared allyblockcast[bot] App identity.");
  process.exit(0);
}

if (isMainModule()) {
  main().catch((error) => {
    console.error(error.message ?? error);
    process.exit(1);
  });
}
