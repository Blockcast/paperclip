#!/usr/bin/env node
/**
 * Reject non-merge commits created through the shared GitHub App write path.
 * Grandfathered commits use stable patch-id plus author email because the
 * master merge queue (ruleset 20487141) uses REBASE and rewrites their SHAs.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const APP_NOREPLY_EMAIL = "290875700+allyblockcast[bot]@users.noreply.github.com";
export const DEFAULT_AUDIT_REPOS = ["Blockcast/trafficcontrol", "Blockcast/paperclip"];
export const DEFAULT_AUDIT_SINCE_DAYS = 7;
export const AUDIT_PR_LIST_MAX = 300;
export const COMMITS_API_MAX = 250;
export const ATTRIBUTION_GATE_CUTOFF = "2026-08-09T01:38:20Z";
export const ATTRIBUTION_GATE_CUTOFF_MS = Date.parse(ATTRIBUTION_GATE_CUTOFF);

const grandfatheredPatchIds = [
  "b22bed3ac5812f8ba9b335b597accc2dbd59b9c8", "63b58b5df729db30d26325d3cb3349d6d07750ef",
  "87724aca1ceecc93d9a430029dd92362171650f0", "73661f1e600a5f4b71e993cb2933cea97564009e",
  "03734ab59c8e39175e3b48894516410bc358253b", "47dabdd37f43a48532e94e79d7e9ba2d174e59f2",
  "df1cfbe845b065af254d850764c16cc9b4609815", "ac25b54d4cba6a44781c7dcacb3a4b7d083180cc",
  "3ea4c9dd6345d45b507de15ec005ed3927f314f4", "970a912cae282b129222fa524497f520a4c2fa0e",
  "11d7a79790aa8fc658cb164ce2f2b372e98bce07", "5d1fb094eb82d0f83fcd1f7d47a615936b68f273",
  "e6e8c25ae37b161b062ae67c95970c958f89198a", "437abe8653d01a0dbbae17e8a2ed88477df9d46e",
  "8b7e81fde79203be6342c70c010928f154b1e2a0",
];
/** Compatibility name retained for callers that validate the grandfather set. */
export const GRANDFATHERED_OFFENSE_SHAS = new Set(
  grandfatheredPatchIds.map((patchId) => `${patchId}|${APP_NOREPLY_EMAIL}`),
);

function grandfatherKey(commit) {
  return `${String(commit.patchId ?? "").toLowerCase()}|${commit.authorEmail ?? ""}`;
}

export function findAttributionOffenses(commits, { allowlist } = {}) {
  return commits.filter((commit) => {
    if ((commit.parentCount ?? 1) > 1) return false;
    if (commit.authorEmail !== APP_NOREPLY_EMAIL) return false;
    if (allowlist === undefined) return true;
    return !allowlist.has(grandfatherKey(commit));
  });
}

function patchIdForCommit(repoRoot, sha, execFile = execFileSync) {
  const patch = execFile("git", ["show", "--format=", "--no-ext-diff", "--no-renames", sha], {
    cwd: repoRoot, encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
  });
  const result = execFile("git", ["patch-id", "--stable"], {
    cwd: repoRoot, input: patch, encoding: "utf8",
  });
  return result.trim().split(/\s+/)[0] ?? "";
}

function parseLocalGitLog(rawOutput) {
  return rawOutput.split("\u001e").map((record) => record.trim()).filter(Boolean).map((record) => {
    const [sha, authorEmail, authorDate, subject] = record.split("\u001f");
    return { sha, authorEmail, authorDate, parentCount: 1, message: subject ?? "" };
  });
}

export function findLocalRangeOffenses({ repoRoot, base, head = "HEAD", execFile = execFileSync, allowlist = GRANDFATHERED_OFFENSE_SHAS } = {}) {
  const format = `%H\u001f%ae\u001f%aI\u001f%s\u001e`;
  const raw = execFile("git", ["log", "--no-merges", `--format=${format}`, `${base}..${head}`], {
    cwd: repoRoot, encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
  });
  const commits = parseLocalGitLog(raw).map((commit) => ({
    ...commit, patchId: patchIdForCommit(repoRoot, commit.sha, execFile),
  }));
  return findAttributionOffenses(commits, { allowlist });
}

export function resolveSince(value, nowMs = Date.now()) {
  const raw = String(value ?? `${DEFAULT_AUDIT_SINCE_DAYS}d`).trim();
  const relative = /^(\d+)d$/.exec(raw);
  if (relative) return new Date(nowMs - Number(relative[1]) * 86_400_000).toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw new Error(`--since expects YYYY-MM-DD or <N>d, got ${JSON.stringify(raw)}`);
  return raw;
}

export function sortByMergedAtDesc(prs) {
  return prs.map((pr) => ({ pr, mergedMs: Date.parse(pr.mergedAt ?? "") }))
    .filter(({ mergedMs }) => Number.isFinite(mergedMs)).sort((a, b) => b.mergedMs - a.mergedMs).map(({ pr }) => pr);
}

export async function auditRepoCommitAttribution({ repo, since, ghApi }) {
  const rawPrs = JSON.parse(await ghApi(["pr", "list", "--repo", repo, "--state", "merged", "--search", `merged:>=${since}`, "--limit", String(AUDIT_PR_LIST_MAX), "--json", "number,title,mergedAt"]));
  const prs = sortByMergedAtDesc(rawPrs); const offenses = []; const truncated = []; let commitsChecked = 0;
  for (const pr of prs) {
    const commits = (await ghApi(["api", `repos/${repo}/pulls/${pr.number}/commits`, "--paginate"])).trim()
      .split(/(?<=])\s*(?=\[)/).flatMap((page) => page ? JSON.parse(page) : []);
    commitsChecked += commits.length;
    if (commits.length >= COMMITS_API_MAX) truncated.push({ repo, prNumber: pr.number, prTitle: pr.title, commitsSeen: commits.length });
    for (const offense of findAttributionOffenses(commits.map((commit) => ({ sha: commit.sha, authorEmail: commit.commit?.author?.email ?? null, parentCount: commit.parents?.length ?? 1, message: (commit.commit?.message ?? "").split("\n")[0] }))) ) {
      offenses.push({ ...offense, repo, prNumber: pr.number, prTitle: pr.title });
    }
  }
  return { repo, since, prsChecked: prs.length, commitsChecked, offenses, truncated, windowTruncated: rawPrs.length >= AUDIT_PR_LIST_MAX, oldestMergedAt: prs.at(-1)?.mergedAt ?? null, newestMergedAt: prs[0]?.mergedAt ?? null };
}

async function defaultGhApi(args) { return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }); }
export async function runAudit({ repos = DEFAULT_AUDIT_REPOS, since, ghApi = defaultGhApi, log = console.log } = {}) {
  const window = resolveSince(since); const results = [];
  for (const repo of repos) {
    const result = await auditRepoCommitAttribution({ repo, since: window, ghApi }); results.push(result);
    log(`${repo}: checked ${result.commitsChecked} commits across ${result.prsChecked} PRs merged since ${window} — ${result.offenses.length} App-attributed`);
  }
  const offenses = results.flatMap((result) => result.offenses); const truncated = results.flatMap((result) => result.truncated); const windowTruncated = results.filter((result) => result.windowTruncated);
  return { passed: offenses.length === 0 && truncated.length === 0 && windowTruncated.length === 0, since: window, results, offenses, truncated, windowTruncated };
}

function isMainModule() { return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url); }
if (isMainModule()) {
  const args = process.argv.slice(2); const value = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
  if (args.includes("--audit-merged")) {
    runAudit({ repos: value("--repos")?.split(","), since: value("--since") }).then(({ passed }) => process.exit(passed ? 0 : 1)).catch((error) => { console.error(error.message ?? error); process.exit(1); });
  } else {
    const base = value("--base") ?? process.env.PR_BASE_SHA; const head = value("--head") ?? process.env.PR_HEAD_SHA ?? "HEAD";
    if (!base) { console.error("ERROR: --base (or PR_BASE_SHA) is required in local mode."); process.exit(2); }
    const offenses = findLocalRangeOffenses({ repoRoot: process.cwd(), base, head });
    if (offenses.length) { console.error(`ERROR: ${offenses.length} commit(s) carry the shared App identity.`); process.exit(1); }
    console.log("  ✓  No commits in range carry the shared allyblockcast[bot] App identity.");
  }
}
