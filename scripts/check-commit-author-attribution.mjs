#!/usr/bin/env node
/**
 * check-commit-author-attribution.mjs (BLO-21416)
 *
 * GitHub REST commit-creation endpoints (contents/merge API, MCP
 * `create_or_update_file`/`push_files`) default `commit.author` to the
 * authenticated identity when none is supplied. Every agent pod shares one
 * credential — the `allyblockcast[bot]` GitHub App installation (id
 * 290875700) — so any agent writing via that path gets stamped with the App,
 * not the acting agent. `git push` reads `user.name`/`user.email` from the
 * checkout's local git config instead, so it is NOT subject to this
 * server-side default — but that only produces a correctly-attributed commit
 * if the checkout's local config actually holds a per-agent identity. A
 * 2026-08-10 sweep of 71 checkouts (BLO-23894) found 11 with local config
 * stamped to the shared App identity and 18 with no local identity set at
 * all, so `git push` failing this gate is a live, not just historical,
 * failure mode — check `git config user.email` in the checkout before
 * assuming the write path is the cause. See AGENTS.md §9 and the BLO-21416
 * issue for the full writeup.
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
 *
 * ## Grandfathered pre-cutoff commits are SHA-pinned, not date-cut (BLO-23894)
 *
 * The local-range gate (mode 1, the one that actually blocks a PR) clears a
 * commit if its full SHA is in `GRANDFATHERED_OFFENSE_SHAS` — an explicit,
 * enumerated allowlist of the specific pre-existing App-attributed commits
 * that predate the gate itself (`e7162b906` / `3fa6e41d8`, landed
 * `ATTRIBUTION_GATE_CUTOFF`). Those commits cannot be brought into
 * compliance: the App stamp already erased the acting agent's identity, so
 * there is no correct author to rewrite them to, and guessing one would
 * write a false attribution — the exact harm this gate exists to prevent.
 * Squashing or force-pushing to "fix" one is worse still: it relabels other
 * contributors' correctly-attributed commits, or rewrites/orphans history
 * that predates the rule.
 *
 * This grandfathering used to key on `authorDate < cutoff` instead of a SHA
 * allowlist. That was reverted: `authorDate` is caller-controlled
 * (`GIT_AUTHOR_DATE`, `git commit --date`) on the `git push` write path this
 * gate also has to police (see AGENTS.md §9 — 11-of-71 sampled checkouts
 * already carry a misconfigured local identity), so a date cutoff can be
 * defeated by backdating a brand-new, otherwise-non-compliant commit straight
 * past the gate. A commit's SHA is not caller-choosable in the same way — it
 * is a hash of the commit's own content, parent, and metadata — so pinning by
 * SHA is immune to that forgery. The allowlist is finite and was built by
 * enumerating every commit meeting the App-identity/non-merge/pre-cutoff
 * predicate across every open `Blockcast/paperclip` PR as of the audit below;
 * it is not a standing exemption; it does not grow.
 *
 * Trade-off, stated rather than hidden: an ordinary GitHub "Update branch"
 * (a merge, which is what this repo's queue uses — verified via PR #1265's
 * own `mergeStateStatus`) leaves the original commit's SHA untouched, so a
 * grandfathered PR stays clear across it. An explicit local `git rebase`
 * instead *rewrites* the commit (new parent → new commit hash even if the
 * diff is byte-identical), which would drop it off the allowlist and re-trip
 * the gate. That failure mode is fail-closed (blocks, doesn't silently pass)
 * and the fix is cheap and forgery-free: add the new SHA to the allowlist.
 * It was accepted over keeping any date-keyed fallback, which would
 * reopen the exact backdating hole this change closes.
 *
 * `--audit-merged` mode deliberately does NOT apply this allowlist — it is
 * advisory only (never blocks a merge) and stays a complete historical
 * record, including pre-cutoff violations, so `findAttributionOffenses` only
 * filters by allowlist when a caller opts in via `{ allowlist }`.
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

/**
 * The moment this gate itself became knowable: when `e7162b906` /
 * `3fa6e41d8` landed on master (committer date of the latter — both were
 * merged in the same rebase-merge). Retained for provenance and as the
 * predicate used to build `GRANDFATHERED_OFFENSE_SHAS` below — it is no
 * longer read at enforcement time (see "Grandfathered pre-cutoff commits are
 * SHA-pinned, not date-cut" in the module docblock, BLO-23894).
 */
export const ATTRIBUTION_GATE_CUTOFF = "2026-08-09T01:38:20Z";
export const ATTRIBUTION_GATE_CUTOFF_MS = Date.parse(ATTRIBUTION_GATE_CUTOFF);

/**
 * Explicit, enumerated allowlist of pre-cutoff App-attributed non-merge
 * commits (BLO-23894). Built by scanning every commit on every OPEN
 * `Blockcast/paperclip` PR (168 as of 2026-08-11, via
 * `GET /pulls/{n}/commits` per PR) for the same predicate `policy` enforces
 * — App-authored, non-merge, `authorDate < ATTRIBUTION_GATE_CUTOFF` — a
 * superset of the ≥13-PR sample in BLO-23894's own blast-radius scan (which
 * covered only the 100 most-recently-created open PRs and so missed #927,
 * #1019, #1036, and #1049, all outside that window). Two commits found in
 * the same scan were deliberately EXCLUDED because their `authorDate` is
 * *after* the cutoff (PR #1125 `aafae6d5b`, PR #1220 `d656a840b`/`28bee6a6c`)
 * — those are live, real violations the gate is correctly enforcing on, not
 * grandfather candidates; their authors need to fix them via `git push` from
 * a correctly-configured checkout per AGENTS.md §9.
 *
 * This list only ever needs new entries for commits that predate the cutoff
 * above (a closed, non-growing condition) or for a grandfathered commit
 * whose SHA changed because it was rebased rather than merge-updated (see
 * the docblock trade-off) — never for an ordinary new PR.
 */
export const GRANDFATHERED_OFFENSE_SHAS = new Set([
  // #927
  "28291ce01869d6b523d79fd63a4a57eb408c8bb0",
  "eb9e6f9ea1f0c3f2a01c98ae5157edeb274788ad",
  "ead90a12af947358733d788113043f7df9354827",
  "863da8a2b9ce15e42391f7e9e17e931c60e74e98",
  // #962
  "7c689686ac5a365f3282ef4b33859ff15cf99282",
  "17532d7f1f62c8823c18091e3b617f9cebcd4a51",
  // #1019
  "ef6251ee65fdc6e05a171c0b30f4dccf2d1ce4ab",
  // #1036
  "8fc0eb49261df104755c502224444d70e1ccae74",
  // #1049
  "42bfd84996c855f153b669d903053a3cd13d9668",
  "3345ee7829130ef8c7a167a4a106a655f426c42b",
  // #1091
  "d0cd0fb16ef8cc9ab25710c521833733dae291ea",
  // #1126
  "cb120b0e334ebb8d2d318d0a3d7cf37a161fce97",
  // #1133 and #1148 share this commit (stacked branches)
  "96203de637f5c7b33807b09a27e4cf7b8d00d6e5",
  // #1138
  "ef139fad81017ff0d1c595e2096ad6ec84ee94f1",
  // #1148
  "447fd5e91c1ab8112b6f986c340bc1ca4c23cdb9",
  // #1155
  "dd81c36c96528d60f40e19e426a922e4299d8214",
  "96985884ec0772b84390517a567f0e770ce49038",
  // #1161
  "b54c3bc2635b5b8e5836c4959734d854a24cae88",
  // #1165
  "d3e6ea9fc7ed472ff3c4cb9448b3144298827fc2",
]);

const UNIT_SEPARATOR = "\u001f";
const RECORD_SEPARATOR = "\u001e";

/**
 * Shared assertion: given normalized non-merge-or-merge-tagged commit
 * records, return the ones stamped with the shared App identity.
 * `commits` entries: { sha, authorEmail, authorDate, parentCount, message,
 * context? }. A `parentCount` of 2+ is a merge commit and is always out of
 * scope, independent of which mode produced the record (defensive — mode 1
 * already excludes these via `--no-merges`).
 *
 * `allowlist`, if given (a `Set` of full 40-char lowercase SHAs), additionally
 * clears any commit whose `sha` is a member — BLO-23894's grandfather clause,
 * SHA-pinned rather than date-keyed so it cannot be defeated by a caller
 * backdating `authorDate`. `sha` is matched case-insensitively (lowercased
 * before comparison) since callers may not normalize case; a missing `sha`
 * cannot match and stays an offense. Omitting `allowlist` preserves the
 * historical, unfiltered assertion; `--audit-merged` relies on that default
 * so it keeps reporting pre-cutoff violations as advisory record.
 */
export function findAttributionOffenses(commits, { allowlist } = {}) {
  return commits.filter((commit) => {
    if ((commit.parentCount ?? 1) > 1) return false;
    if (commit.authorEmail !== APP_NOREPLY_EMAIL) return false;
    if (allowlist === undefined) return true;
    return !allowlist.has(String(commit.sha ?? "").toLowerCase());
  });
}

function parseLocalGitLog(rawOutput) {
  return rawOutput
    .split(RECORD_SEPARATOR)
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [sha, authorEmail, authorDate, subject] = record.split(UNIT_SEPARATOR);
      return { sha, authorEmail, authorDate, parentCount: 1, message: subject ?? "" };
    });
}

/**
 * Local mode: non-merge commits in `base..head` of a checked-out repo.
 * `execFileSync` (argv array, no shell) — `base`/`head` are refs/SHAs from
 * trusted CI-provided env, but this avoids any shell-injection surface either way.
 * Applies the BLO-23894 grandfather allowlist by default — this is the gate
 * that actually blocks a PR, so pre-cutoff, allowlisted commits are out of
 * scope.
 */
export function findLocalRangeOffenses({
  repoRoot,
  base,
  head,
  execFile = execFileSync,
  allowlist = GRANDFATHERED_OFFENSE_SHAS,
} = {}) {
  const format = `%H${UNIT_SEPARATOR}%ae${UNIT_SEPARATOR}%aI${UNIT_SEPARATOR}%s${RECORD_SEPARATOR}`;
  const rawOutput = execFile(
    "git",
    ["log", "--no-merges", `--format=${format}`, `${base}..${head}`],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  const commits = parseLocalGitLog(rawOutput);
  return findAttributionOffenses(commits, { allowlist });
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
      authorDate: commit.commit?.author?.date ?? null,
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
      "\nThis means either the commit was created via the GitHub REST/MCP write path (contents API, merge API, or `create_or_update_file`/`push_files`, which always stamps the shared App credential), OR it was made with `git push` from a checkout whose local git config itself holds the App identity — run `git config user.email` in this checkout to tell which. The first case: use `git push` instead. The second case: `git push` will not fix it until the checkout's local `user.email`/`user.name` is set to your own per-agent identity (BLO-23894 found this local-config gap on 11 of 71 sampled checkouts). See AGENTS.md §9 (BLO-21416).\n\nIf this commit genuinely predates the gate (authored before ATTRIBUTION_GATE_CUTOFF, e.g. it was already open and reviewed before the rule existed, or it's a grandfathered PR that got rebased and changed SHA) it is unfixable in place — file against BLO-23894's owner to add its SHA to GRANDFATHERED_OFFENSE_SHAS rather than rewriting history.",
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
