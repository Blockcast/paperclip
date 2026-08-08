import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  APP_NOREPLY_EMAIL,
  auditRepoCommitAttribution,
  AUDIT_OVERFETCH_FACTOR,
  COMMITS_API_MAX,
  findAttributionOffenses,
  findLocalRangeOffenses,
  runAudit,
  selectRecentlyMergedPrs,
} from "./check-commit-author-attribution.mjs";

test("findAttributionOffenses flags a non-merge commit stamped with the shared App identity", () => {
  const offenses = findAttributionOffenses([
    { sha: "a", authorEmail: APP_NOREPLY_EMAIL, parentCount: 1, message: "api write" },
  ]);
  assert.equal(offenses.length, 1);
  assert.equal(offenses[0].sha, "a");
});

test("findAttributionOffenses ignores a per-agent author email", () => {
  const offenses = findAttributionOffenses([
    { sha: "a", authorEmail: "platformsreengineer@paperclip.blockcast.net", parentCount: 1, message: "git push" },
  ]);
  assert.deepEqual(offenses, []);
});

test("findAttributionOffenses ignores the graphify-reindex bot's git-push identity", () => {
  // The graphify-reindex bot commits via `git push` under
  // `graphify-reindex (allyblockcast) <allyblockcast[bot]@users.noreply.github.com>`,
  // which is NOT the REST write-path stamp this gate matches (that one carries
  // the numeric App-user prefix, `290875700+...`). Verified against the real
  // PRs Blockcast/paperclip#789 and #944: both pass this gate unmodified.
  //
  // This is why pr.yml carries no `bot/graphify-reindex` branch exemption — an
  // exemption there would have been a fork bypass (`github.head_ref` says
  // nothing about which repository the branch lives in) and a merge-queue
  // false-reject (`head_ref` is empty on `merge_group`), guarding against a
  // rejection that does not occur. If this test starts failing, the bot has
  // moved onto the REST write path: fix the bot, do not re-add an exemption.
  const offenses = findAttributionOffenses([
    {
      sha: "35340799",
      authorEmail: "allyblockcast[bot]@users.noreply.github.com",
      parentCount: 1,
      message: "chore(graphify): refresh knowledge graphs",
    },
  ]);
  assert.deepEqual(offenses, []);
});

test("findAttributionOffenses excludes merge commits even when App-attributed (scope boundary)", () => {
  const offenses = findAttributionOffenses([
    { sha: "a", authorEmail: APP_NOREPLY_EMAIL, parentCount: 2, message: "Merge pull request #1" },
  ]);
  assert.deepEqual(offenses, []);
});

test("findAttributionOffenses defaults an absent parentCount to 1 (non-merge)", () => {
  const offenses = findAttributionOffenses([{ sha: "a", authorEmail: APP_NOREPLY_EMAIL, message: "no parentCount field" }]);
  assert.equal(offenses.length, 1);
});

test("findLocalRangeOffenses reads non-merge commits from a real git range and flags App-attributed ones", () => {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), "attribution-test-"));
  try {
    const git = (args) => execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" });
    git(["init", "-q"]);
    git(["config", "user.name", "Test"]);
    git(["config", "user.email", "base@example.com"]);
    git(["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "base", "-q"]);
    const base = git(["rev-parse", "HEAD"]).trim();

    git(["config", "user.email", "platformsreengineer@paperclip.blockcast.net"]);
    git(["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "agent commit", "-q"]);

    git(["config", "user.email", APP_NOREPLY_EMAIL]);
    git(["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "api-path commit", "-q"]);
    const head = git(["rev-parse", "HEAD"]).trim();

    const offenses = findLocalRangeOffenses({ repoRoot, base, head });
    assert.equal(offenses.length, 1);
    assert.equal(offenses[0].message, "api-path commit");
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("findLocalRangeOffenses excludes merge commits via --no-merges", () => {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), "attribution-test-merge-"));
  try {
    const git = (args) => execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" });
    git(["init", "-q", "-b", "main"]);
    git(["config", "user.name", "Test"]);
    git(["config", "user.email", APP_NOREPLY_EMAIL]);
    git(["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "base", "-q"]);
    const base = git(["rev-parse", "HEAD"]).trim();

    git(["checkout", "-q", "-b", "feature"]);
    git(["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "feature work", "-q"]);
    git(["checkout", "-q", "main"]);
    git(["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "unrelated main work", "-q"]);
    git(["-c", "commit.gpgsign=false", "merge", "--no-ff", "-m", "Merge branch feature", "feature", "-q"]);
    const head = git(["rev-parse", "HEAD"]).trim();

    const offenses = findLocalRangeOffenses({ repoRoot, base, head });
    // Both non-merge commits are App-attributed, the merge commit itself is
    // excluded by --no-merges regardless of its own author.
    assert.equal(offenses.length, 2);
    assert.ok(offenses.every((o) => o.message !== "Merge branch feature"));
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("auditRepoCommitAttribution flags App-attributed commits across the injected PR's own commit list", async () => {
  const commitsPage = JSON.stringify([
    {
      sha: "a".repeat(40),
      parents: [{ sha: "base" }],
      commit: { author: { email: APP_NOREPLY_EMAIL }, message: "api write\n" },
    },
    {
      sha: "b".repeat(40),
      parents: [{ sha: "a".repeat(40) }],
      commit: { author: { email: "platformsreengineer@paperclip.blockcast.net" }, message: "git push\n" },
    },
    {
      sha: "c".repeat(40),
      parents: [{ sha: "b".repeat(40) }, { sha: "x".repeat(40) }],
      commit: { author: { email: APP_NOREPLY_EMAIL }, message: "Merge branch main into feature\n" },
    },
  ]);

  const fakeGhApi = async (args) => {
    if (args[0] === "pr" && args[1] === "list") {
      return JSON.stringify([{ number: 42, title: "example PR", mergedAt: "2026-01-01" }]);
    }
    if (args[0] === "api") return commitsPage;
    throw new Error(`unexpected gh invocation: ${args.join(" ")}`);
  };

  const result = await auditRepoCommitAttribution({
    repo: "Blockcast/example",
    perRepoLimit: 5,
    ghApi: fakeGhApi,
  });

  assert.equal(result.prsChecked, 1);
  assert.equal(result.commitsChecked, 3);
  assert.equal(result.offenses.length, 1);
  assert.equal(result.offenses[0].prNumber, 42);
  assert.equal(result.offenses[0].message, "api write");
});

test("auditRepoCommitAttribution joins multiple --paginate pages", async () => {
  const page1 = JSON.stringify([
    { sha: "a".repeat(40), parents: [{ sha: "z" }], commit: { author: { email: APP_NOREPLY_EMAIL }, message: "one\n" } },
  ]);
  const page2 = JSON.stringify([
    { sha: "b".repeat(40), parents: [{ sha: "a".repeat(40) }], commit: { author: { email: "x@paperclip.blockcast.net" }, message: "two\n" } },
  ]);

  const fakeGhApi = async (args) => {
    if (args[0] === "pr" && args[1] === "list") {
      return JSON.stringify([{ number: 7, title: "paged PR", mergedAt: "2026-01-01" }]);
    }
    return page1 + page2;
  };

  const result = await auditRepoCommitAttribution({ repo: "Blockcast/example", perRepoLimit: 1, ghApi: fakeGhApi });
  assert.equal(result.commitsChecked, 2);
  assert.equal(result.offenses.length, 1);
});

test("selectRecentlyMergedPrs orders by merge time, not by gh's creation-time order", () => {
  // `gh pr list --state merged` sorts by creation, so a long-running PR merged
  // later can appear behind a short one merged earlier. Mirrors the real case
  // Ally found: #1034 (merged Aug 6) sitting behind #1051 (merged Aug 5).
  const selected = selectRecentlyMergedPrs(
    [
      { number: 1051, mergedAt: "2026-08-05T10:00:00Z" },
      { number: 1034, mergedAt: "2026-08-06T10:00:00Z" },
      { number: 900, mergedAt: "2026-07-01T10:00:00Z" },
    ],
    2,
  );
  assert.deepEqual(
    selected.map((pr) => pr.number),
    [1034, 1051],
  );
});

test("selectRecentlyMergedPrs drops entries with a missing or unparseable mergedAt", () => {
  const selected = selectRecentlyMergedPrs(
    [
      { number: 1, mergedAt: null },
      { number: 2, mergedAt: "not-a-date" },
      { number: 3, mergedAt: "2026-08-06T10:00:00Z" },
    ],
    5,
  );
  assert.deepEqual(
    selected.map((pr) => pr.number),
    [3],
  );
});

test("auditRepoCommitAttribution over-fetches the PR list, then audits only the newest-merged window", async () => {
  let requestedLimit = null;
  const auditedPrNumbers = [];
  const fakeGhApi = async (args) => {
    if (args[0] === "pr" && args[1] === "list") {
      requestedLimit = Number(args[args.indexOf("--limit") + 1]);
      return JSON.stringify([
        { number: 1051, title: "merged earlier", mergedAt: "2026-08-05T10:00:00Z" },
        { number: 1034, title: "merged latest", mergedAt: "2026-08-06T10:00:00Z" },
      ]);
    }
    auditedPrNumbers.push(Number(args[1].match(/pulls\/(\d+)\/commits/)[1]));
    return JSON.stringify([]);
  };

  const result = await auditRepoCommitAttribution({
    repo: "Blockcast/example",
    perRepoLimit: 1,
    ghApi: fakeGhApi,
  });

  assert.equal(requestedLimit, AUDIT_OVERFETCH_FACTOR);
  assert.equal(result.prsChecked, 1);
  assert.deepEqual(auditedPrNumbers, [1034]);
});

test("auditRepoCommitAttribution reports a commit list that hit the 250-entry API cap", async () => {
  const cappedPage = JSON.stringify(
    Array.from({ length: COMMITS_API_MAX }, (_, index) => ({
      sha: String(index).padStart(40, "0"),
      parents: [{ sha: "prev" }],
      commit: { author: { email: "agent@paperclip.blockcast.net" }, message: `commit ${index}\n` },
    })),
  );

  const fakeGhApi = async (args) => {
    if (args[0] === "pr" && args[1] === "list") {
      return JSON.stringify([{ number: 99, title: "huge PR", mergedAt: "2026-08-06T10:00:00Z" }]);
    }
    return cappedPage;
  };

  const result = await auditRepoCommitAttribution({
    repo: "Blockcast/example",
    perRepoLimit: 1,
    ghApi: fakeGhApi,
  });

  // No offense is visible, but the audit did not see the whole PR.
  assert.deepEqual(result.offenses, []);
  assert.equal(result.truncated.length, 1);
  assert.equal(result.truncated[0].prNumber, 99);
});

test("runAudit fails closed on a truncated commit list even with zero offenses", async () => {
  const cappedPage = JSON.stringify(
    Array.from({ length: COMMITS_API_MAX }, (_, index) => ({
      sha: String(index).padStart(40, "0"),
      parents: [{ sha: "prev" }],
      commit: { author: { email: "agent@paperclip.blockcast.net" }, message: `commit ${index}\n` },
    })),
  );
  const logged = [];

  const outcome = await runAudit({
    repos: ["Blockcast/example"],
    perRepoLimit: 1,
    log: (line) => logged.push(line),
    ghApi: async (args) => {
      if (args[0] === "pr" && args[1] === "list") {
        return JSON.stringify([{ number: 99, title: "huge PR", mergedAt: "2026-08-06T10:00:00Z" }]);
      }
      return cappedPage;
    },
  });

  assert.equal(outcome.passed, false);
  assert.equal(outcome.offenses.length, 0);
  assert.equal(outcome.truncated.length, 1);
  // The operator must be able to tell "incomplete audit" from "violation found".
  assert.ok(logged.some((line) => line.includes("INCOMPLETE")));
  assert.ok(!logged.some((line) => line.includes("VIOLATION")));
});

test("runAudit passes when every PR is fully audited and clean", async () => {
  const outcome = await runAudit({
    repos: ["Blockcast/example"],
    perRepoLimit: 1,
    log: () => {},
    ghApi: async (args) => {
      if (args[0] === "pr" && args[1] === "list") {
        return JSON.stringify([{ number: 5, title: "small PR", mergedAt: "2026-08-06T10:00:00Z" }]);
      }
      return JSON.stringify([
        {
          sha: "a".repeat(40),
          parents: [{ sha: "prev" }],
          commit: { author: { email: "agent@paperclip.blockcast.net" }, message: "git push\n" },
        },
      ]);
    },
  });

  assert.equal(outcome.passed, true);
  assert.deepEqual(outcome.truncated, []);
});
