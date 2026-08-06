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
 *      verifying signal"). For the last N merged PRs across one or more
 *      repos, fetches each PR's own commit list and applies the same
 *      assertion. A PR's `/commits` entries are pre-squash source commits,
 *      each with exactly one parent unless the branch merged another ref in
 *      (multi-parent → excluded, same merge-commit exception as mode 1).
 *
 * Both modes are read-only: this script never posts, comments, or writes.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const APP_NOREPLY_EMAIL = "290875700+allyblockcast[bot]@users.noreply.github.com";
export const DEFAULT_AUDIT_REPOS = ["Blockcast/trafficcontrol", "Blockcast/paperclip"];
export const DEFAULT_PER_REPO_LIMIT = 20;

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
 * Remote audit mode: last `perRepoLimit` merged PRs in `repo`, each PR's own
 * (pre-squash) commit list. `ghApi` is injected so tests never shell out.
 */
export async function auditRepoCommitAttribution({ repo, perRepoLimit, ghApi }) {
  const prsJson = await ghApi([
    "pr",
    "list",
    "--repo",
    repo,
    "--state",
    "merged",
    "--limit",
    String(perRepoLimit),
    "--json",
    "number,title,mergedAt",
  ]);
  const prs = JSON.parse(prsJson);

  const offenses = [];
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

  return { repo, prsChecked: prs.length, commitsChecked: totalCommits, offenses };
}

async function defaultGhApi(args) {
  return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

export async function runAudit({
  repos = DEFAULT_AUDIT_REPOS,
  perRepoLimit = DEFAULT_PER_REPO_LIMIT,
  ghApi = defaultGhApi,
  log = console.log,
} = {}) {
  const results = [];
  for (const repo of repos) {
    const result = await auditRepoCommitAttribution({ repo, perRepoLimit, ghApi });
    results.push(result);
    log(
      `${repo}: checked ${result.commitsChecked} non-merge commits across ${result.prsChecked} merged PRs — ${result.offenses.length} App-attributed`,
    );
    for (const offense of result.offenses) {
      log(
        `  VIOLATION ${repo}#${offense.prNumber} ${offense.sha.slice(0, 7)} "${offense.message}" — ${offense.authorEmail}`,
      );
    }
  }
  const allOffenses = results.flatMap((r) => r.offenses);
  return { passed: allOffenses.length === 0, results, offenses: allOffenses };
}

function parseArgs(argv) {
  const args = { mode: "local" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--audit-merged") args.mode = "audit";
    else if (arg === "--repos") args.repos = argv[++i]?.split(",").map((r) => r.trim()).filter(Boolean);
    else if (arg === "--per-repo-limit") args.perRepoLimit = Number.parseInt(argv[++i], 10);
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
    const { passed, offenses } = await runAudit({
      repos: args.repos,
      perRepoLimit: args.perRepoLimit,
    });
    if (!passed) {
      console.error(
        `\n${offenses.length} non-merge commit(s) carry the shared App identity (${APP_NOREPLY_EMAIL}) instead of a per-agent author. See BLO-21416 / AGENTS.md §9.`,
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
