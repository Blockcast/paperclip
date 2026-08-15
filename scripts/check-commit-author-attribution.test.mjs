import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import {
  APP_NOREPLY_EMAIL,
  APP_NOREPLY_EMAIL_PATTERN,
  auditRepoCommitAttribution,
  AUDIT_PR_LIST_MAX,
  COMMITS_API_MAX,
  findAttributionOffenses,
  findLocalRangeOffenses,
  GRANDFATHERED_OFFENSE_SHAS,
  NON_AGENT_PROCESS_AUTHOR_NAMES,
  resolveSince,
  runAudit,
  sortByMergedAtDesc,
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
  // `graphify-reindex (allyblockcast) <allyblockcast[bot]@users.noreply.github.com>`
  // (real branch: origin/bot/graphify-reindex, e.g. 09d69ca8d). That email is
  // the exact bare form the App itself also uses (BLO-26647 — see the module
  // docblock: several genuine agent commits share this same bare email under
  // author names like "CTO" and plain "allyblockcast[bot]"), so email alone
  // cannot tell them apart. The author NAME is what distinguishes this one
  // known non-agent process — NON_AGENT_PROCESS_AUTHOR_NAMES — from a real
  // offense.
  //
  // This is why pr.yml carries no `bot/graphify-reindex` branch exemption — an
  // exemption there would have been a fork bypass (`github.head_ref` says
  // nothing about which repository the branch lives in) and a merge-queue
  // false-reject (`head_ref` is empty on `merge_group`), guarding against a
  // rejection that does not occur. If this test starts failing because the
  // bot's author name changed, update NON_AGENT_PROCESS_AUTHOR_NAMES to match
  // — do not re-add a branch-based exemption.
  const offenses = findAttributionOffenses([
    {
      sha: "35340799",
      authorName: "graphify-reindex (allyblockcast)",
      authorEmail: "allyblockcast[bot]@users.noreply.github.com",
      parentCount: 1,
      message: "chore(graphify): refresh knowledge graphs",
    },
  ]);
  assert.deepEqual(offenses, []);
});

test("findAttributionOffenses flags the bare allyblockcast[bot] email when the author name is NOT the graphify-reindex exemption (BLO-26647)", () => {
  // Same email as the test above, different author name — this is the shape
  // of the 18 commits BLO-26647 found escaping the old exact-match gate
  // (author names "CTO", "Staff Engineer", plain "allyblockcast[bot]").
  const offenses = findAttributionOffenses([
    {
      sha: "6c0e9c336f1457c0006bacbcdace1d343cd7f7ef",
      authorName: "allyblockcast[bot]",
      authorEmail: "allyblockcast[bot]@users.noreply.github.com",
      parentCount: 1,
      message: "ci: push refresh-lockfile through the commitperclip App token",
    },
  ]);
  assert.equal(offenses.length, 1);
});

test("findAttributionOffenses flags a wrong/unresolvable numeric prefix on the allyblockcast[bot] local part (BLO-26647 — 220200645 is not a legitimate second installation)", () => {
  // d41030016 (BLO-26647): GET /repos/.../commits/{sha} returns NO `author`
  // object at all for this id — it does not resolve to any GitHub account,
  // App or user. Not a second installation to name and exempt; a malformed
  // stamp that erases attribution at least as badly as the real App, so the
  // any-digits prefix in APP_NOREPLY_EMAIL_PATTERN deliberately catches it.
  const offenses = findAttributionOffenses([
    {
      sha: "d41030016524cb606438ed8132742eebcca2fa91",
      authorName: "allyblockcast[bot]",
      authorEmail: "220200645+allyblockcast[bot]@users.noreply.github.com",
      parentCount: 1,
      message: "fix(sweep): validate thresholds and delimit the untrusted issue region",
    },
  ]);
  assert.equal(offenses.length, 1);
});

test("findAttributionOffenses does NOT flag allyblockcast@users.noreply.github.com (no [bot]) — a different, real, resolvable identity (BLO-26647)", () => {
  // 7fb261047 / c367f99fe: GET /repos/.../commits/{sha} resolves this exact
  // bare, no-[bot] email to author.login "allyblockcast", id 296676656 — a
  // distinct GitHub account from the App (allyblockcast[bot], id 290875700)
  // this gate is chartered to catch. Deliberately out of scope; see the
  // module docblock for why silently matching it would misattribute it to
  // the wrong installation.
  const offenses = findAttributionOffenses([
    {
      sha: "7fb26104f77382811c3aa3a2d540a5a89869e091",
      authorName: "allyblockcast",
      authorEmail: "allyblockcast@users.noreply.github.com",
      parentCount: 1,
      message: "fix: reject empty payload.title on approval create (BLO-21032)",
    },
    {
      sha: "c367f99fef176dd9786b61f9c003463892104b62",
      authorName: "PlatformSREEngineer (Ally)",
      authorEmail: "allyblockcast@users.noreply.github.com",
      parentCount: 1,
      message: "fix(ci): verify patch content hash, not just path, in lockfile-overrides guard",
    },
  ]);
  assert.deepEqual(offenses, []);
});

test("APP_NOREPLY_EMAIL_PATTERN matches every BLO-26647 spelling except the no-[bot] form", () => {
  assert.match(APP_NOREPLY_EMAIL, APP_NOREPLY_EMAIL_PATTERN);
  assert.match("allyblockcast[bot]@users.noreply.github.com", APP_NOREPLY_EMAIL_PATTERN);
  assert.match("220200645+allyblockcast[bot]@users.noreply.github.com", APP_NOREPLY_EMAIL_PATTERN);
  assert.doesNotMatch("allyblockcast@users.noreply.github.com", APP_NOREPLY_EMAIL_PATTERN);
});

test("NON_AGENT_PROCESS_AUTHOR_NAMES carries the one known graphify-reindex exemption", () => {
  assert.ok(NON_AGENT_PROCESS_AUTHOR_NAMES.has("graphify-reindex (allyblockcast)"));
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

test("findAttributionOffenses with an allowlist clears an App-attributed commit whose sha is a member (BLO-23894)", () => {
  const offenses = findAttributionOffenses(
    [
      {
        sha: "962aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        authorEmail: APP_NOREPLY_EMAIL,
        authorDate: "2026-08-05T16:46:12Z",
        parentCount: 1,
        message: "pre-cutoff API write",
      },
    ],
    { allowlist: new Set(["962aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]) },
  );
  assert.deepEqual(offenses, []);
});

test("findAttributionOffenses with an allowlist still flags an App-attributed commit whose sha is NOT a member, even if authored long ago (fail closed on unenumerated history)", () => {
  const offenses = findAttributionOffenses(
    [
      {
        sha: "notpinnedaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        authorEmail: APP_NOREPLY_EMAIL,
        authorDate: "2020-01-01T00:00:00Z",
        parentCount: 1,
        message: "old but unenumerated API write",
      },
    ],
    { allowlist: new Set(["962aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]) },
  );
  assert.equal(offenses.length, 1);
});

test("findAttributionOffenses with an allowlist is immune to a backdated authorDate on a non-allowlisted sha (BLO-23894 — this is the forgery the date-cutoff design allowed)", () => {
  const offenses = findAttributionOffenses(
    [
      {
        sha: "forgedaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        authorEmail: APP_NOREPLY_EMAIL,
        // Backdated via GIT_AUTHOR_DATE to well before the cutoff, but this
        // sha was never enumerated — the allowlist does not care what the
        // caller-controlled authorDate says.
        authorDate: "2020-01-01T00:00:00Z",
        parentCount: 1,
        message: "freshly authored, backdated to dodge the old date cutoff",
      },
    ],
    { allowlist: GRANDFATHERED_OFFENSE_SHAS },
  );
  assert.equal(offenses.length, 1);
});

test("findAttributionOffenses without an allowlist ignores sha membership entirely (audit mode stays historical)", () => {
  const offenses = findAttributionOffenses([
    {
      sha: [...GRANDFATHERED_OFFENSE_SHAS][0],
      authorEmail: APP_NOREPLY_EMAIL,
      authorDate: "2026-08-05T16:46:12Z",
      parentCount: 1,
      message: "pre-cutoff API write",
    },
  ]);
  assert.equal(offenses.length, 1);
});

test("findAttributionOffenses with an allowlist fails closed on a missing sha", () => {
  const offenses = findAttributionOffenses(
    [{ authorEmail: APP_NOREPLY_EMAIL, parentCount: 1, message: "no sha" }],
    { allowlist: GRANDFATHERED_OFFENSE_SHAS },
  );
  assert.equal(offenses.length, 1);
});

test("GRANDFATHERED_OFFENSE_SHAS is a non-empty set of full 40-char lowercase hex shas", () => {
  assert.ok(GRANDFATHERED_OFFENSE_SHAS.size > 0);
  for (const sha of GRANDFATHERED_OFFENSE_SHAS) {
    assert.match(sha, /^[0-9a-f]{40}$/, `${sha} is not a full lowercase sha`);
  }
});

test("GRANDFATHERED_OFFENSE_SHAS includes the #1076 bare-variant grandfather (BLO-26647)", () => {
  assert.ok(GRANDFATHERED_OFFENSE_SHAS.has("6e7440da271f5df50de35ec8bfeed5afaf70f168"));
});

test("findLocalRangeOffenses reads author name from the real git range, flagging a bare-email commit under a non-exempt name (BLO-26647)", () => {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), "attribution-test-bare-"));
  try {
    const git = (args) => execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" });
    git(["init", "-q"]);
    git(["config", "user.name", "Test"]);
    git(["config", "user.email", "base@example.com"]);
    git(["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "base", "-q"]);
    const base = git(["rev-parse", "HEAD"]).trim();

    // Bare form, no numeric prefix — the write path BLO-26647 found several
    // agent commits actually landing under (author names "CTO", "Staff
    // Engineer", plain "allyblockcast[bot]").
    git(["config", "user.name", "allyblockcast[bot]"]);
    git(["config", "user.email", "allyblockcast[bot]@users.noreply.github.com"]);
    git(["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "bare-email api-path commit", "-q"]);
    const head = git(["rev-parse", "HEAD"]).trim();

    const offenses = findLocalRangeOffenses({ repoRoot, base, head, allowlist: new Set() });
    assert.equal(offenses.length, 1);
    assert.equal(offenses[0].message, "bare-email api-path commit");
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("findLocalRangeOffenses exempts the same bare email under the graphify-reindex author name (BLO-26647)", () => {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), "attribution-test-graphify-"));
  try {
    const git = (args) => execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" });
    git(["init", "-q"]);
    git(["config", "user.name", "Test"]);
    git(["config", "user.email", "base@example.com"]);
    git(["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "base", "-q"]);
    const base = git(["rev-parse", "HEAD"]).trim();

    git(["config", "user.name", "graphify-reindex (allyblockcast)"]);
    git(["config", "user.email", "allyblockcast[bot]@users.noreply.github.com"]);
    git(["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "chore(graphify): refresh knowledge graphs", "-q"]);
    const head = git(["rev-parse", "HEAD"]).trim();

    assert.deepEqual(findLocalRangeOffenses({ repoRoot, base, head, allowlist: new Set() }), []);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
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

test("findLocalRangeOffenses grandfathers an App-attributed commit whose sha is explicitly allowlisted (BLO-23894)", () => {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), "attribution-test-allowlist-"));
  try {
    const git = (args, env) =>
      execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", env: { ...process.env, ...env } });
    git(["init", "-q"]);
    git(["config", "user.name", "Test"]);
    git(["config", "user.email", "base@example.com"]);
    git(["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "base", "-q"]);
    const base = git(["rev-parse", "HEAD"]).trim();

    git(["config", "user.email", APP_NOREPLY_EMAIL]);
    git(["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "pre-cutoff api-path commit", "-q"], {
      GIT_AUTHOR_DATE: "2026-08-05T16:46:12Z",
      GIT_COMMITTER_DATE: "2026-08-06T01:15:46Z",
    });
    const head = git(["rev-parse", "HEAD"]).trim();

    // Real PR #962 shape (BLO-23894): App-stamped author, rebased in by a
    // human hours later — the offense is unsatisfiable, so its sha is pinned.
    assert.deepEqual(findLocalRangeOffenses({ repoRoot, base, head, allowlist: new Set([head]) }), []);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("findLocalRangeOffenses still flags an App-attributed commit whose sha is not allowlisted, regardless of a backdated authorDate (BLO-23894 — closes the date-forgery hole)", () => {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), "attribution-test-not-allowlisted-"));
  try {
    const git = (args, env) =>
      execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", env: { ...process.env, ...env } });
    git(["init", "-q"]);
    git(["config", "user.name", "Test"]);
    git(["config", "user.email", "base@example.com"]);
    git(["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "base", "-q"]);
    const base = git(["rev-parse", "HEAD"]).trim();

    git(["config", "user.email", APP_NOREPLY_EMAIL]);
    // Backdated to well before the cutoff — under the old date-cutoff design
    // this alone would have cleared the gate. It must not, now.
    git(["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "backdated api-path commit", "-q"], {
      GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z",
    });
    const head = git(["rev-parse", "HEAD"]).trim();

    const offenses = findLocalRangeOffenses({ repoRoot, base, head, allowlist: new Set() });
    assert.equal(offenses.length, 1);
    assert.equal(offenses[0].message, "backdated api-path commit");
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("findLocalRangeOffenses keeps grandfathering a pinned commit across an ordinary merge-based branch update (PR #1265 review)", () => {
  // Pins the trade-off documented on findAttributionOffenses: SHA-pinning
  // survives the "Update branch" merge this repo's queue actually uses
  // (verified via PR #1265's own mergeStateStatus) because a merge leaves
  // the original commit's sha untouched.
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), "attribution-test-allowlist-merge-"));
  try {
    const git = (args, env) =>
      execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", env: { ...process.env, ...env } });
    git(["init", "-q", "-b", "main"]);
    git(["config", "user.name", "Test"]);
    git(["config", "user.email", "base@example.com"]);
    git(["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "base", "-q"]);
    const base = git(["rev-parse", "HEAD"]).trim();

    git(["checkout", "-q", "-b", "feature"]);
    git(["config", "user.email", APP_NOREPLY_EMAIL]);
    git(["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "pre-cutoff api-path commit", "-q"], {
      GIT_AUTHOR_DATE: "2026-08-05T16:46:12Z",
      GIT_COMMITTER_DATE: "2026-08-06T01:15:46Z",
    });
    const pinnedSha = git(["rev-parse", "HEAD"]).trim();

    // Base moves forward after the cutoff; the feature branch is updated via
    // a merge (GitHub's default "Update branch"), not a rebase.
    git(["checkout", "-q", "main"]);
    git(["config", "user.email", "base@example.com"]);
    git(["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "unrelated main work", "-q"]);
    git(["checkout", "-q", "feature"]);
    git(["-c", "commit.gpgsign=false", "merge", "--no-ff", "-m", "Merge branch main into feature", "main", "-q"]);
    const head = git(["rev-parse", "HEAD"]).trim();

    // The pinned commit's own sha is unchanged by the merge — still present
    // in the range alongside the unrelated main-branch commit pulled in.
    const shasInRange = git(["log", "--no-merges", "--format=%H", `${base}..${head}`]).trim().split("\n");
    assert.ok(shasInRange.includes(pinnedSha));

    assert.deepEqual(
      findLocalRangeOffenses({ repoRoot, base, head, allowlist: new Set([pinnedSha]) }).map((o) => o.message),
      [],
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("findLocalRangeOffenses does NOT carry a pinned grandfather through an explicit git rebase — the rewritten commit needs its new sha added (documented trade-off, BLO-23894)", () => {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), "attribution-test-allowlist-rebase-"));
  try {
    const git = (args, env) =>
      execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", env: { ...process.env, ...env } });
    git(["init", "-q", "-b", "main"]);
    git(["config", "user.name", "Test"]);
    git(["config", "user.email", "base@example.com"]);
    git(["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "base", "-q"]);
    const base = git(["rev-parse", "HEAD"]).trim();

    git(["checkout", "-q", "-b", "feature"]);
    git(["config", "user.email", APP_NOREPLY_EMAIL]);
    git(["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "pre-cutoff api-path commit", "-q"], {
      GIT_AUTHOR_DATE: "2026-08-05T16:46:12Z",
      GIT_COMMITTER_DATE: "2026-08-06T01:15:46Z",
    });
    const pinnedSha = git(["rev-parse", "HEAD"]).trim();

    git(["checkout", "-q", "main"]);
    git(["config", "user.email", "base@example.com"]);
    git(["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "unrelated main work", "-q"]);
    git(["checkout", "-q", "feature"]);
    git(["-c", "commit.gpgsign=false", "rebase", "main", "-q"]);
    const rebasedHead = git(["rev-parse", "HEAD"]).trim();

    // Rebase rewrites the commit: new sha, even though the diff is identical.
    assert.notEqual(rebasedHead, pinnedSha);

    // The original pin no longer matches — fails closed rather than silently
    // passing.
    assert.equal(
      findLocalRangeOffenses({ repoRoot, base, head: rebasedHead, allowlist: new Set([pinnedSha]) }).length,
      1,
    );

    // The fix is cheap and forgery-free: add the new sha.
    assert.deepEqual(
      findLocalRangeOffenses({ repoRoot, base, head: rebasedHead, allowlist: new Set([rebasedHead]) }),
      [],
    );
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
    since: "2026-08-01",
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

  const result = await auditRepoCommitAttribution({ repo: "Blockcast/example", since: "2026-08-01", ghApi: fakeGhApi });
  assert.equal(result.commitsChecked, 2);
  assert.equal(result.offenses.length, 1);
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
    since: "2026-08-01",
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
    since: "2026-08-01",
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

test("resolveSince converts a relative <N>d window to a YYYY-MM-DD date", () => {
  const nowMs = Date.parse("2026-08-09T00:00:00Z");
  assert.equal(resolveSince("7d", nowMs), "2026-08-02");
  assert.equal(resolveSince(undefined, nowMs), "2026-08-02"); // default 7d
  assert.equal(resolveSince("2026-07-01", nowMs), "2026-07-01");
});

test("resolveSince rejects a window it cannot turn into a search qualifier", () => {
  assert.throws(() => resolveSince("last week"), /--since expects/);
  assert.throws(() => resolveSince("2026-8-1"), /--since expects/);
});

test("sortByMergedAtDesc orders newest-merged first and drops unparseable entries", () => {
  const sorted = sortByMergedAtDesc([
    { number: 1051, mergedAt: "2026-08-05T10:00:00Z" },
    { number: 2, mergedAt: "not-a-date" },
    { number: 1034, mergedAt: "2026-08-06T10:00:00Z" },
    { number: 1, mergedAt: null },
  ]);
  assert.deepEqual(
    sorted.map((pr) => pr.number),
    [1034, 1051],
  );
});

test("auditRepoCommitAttribution selects PRs by merge time, not by a creation-ordered count", async () => {
  // The bug this replaces: `gh pr list --state merged --limit N` orders by
  // creation, so "the last N merged PRs" is unknowable from the first N rows.
  // Asking `merged:>=<date>` is a question the API can answer completely.
  let listArgs = null;
  const fakeGhApi = async (args) => {
    if (args[0] === "pr" && args[1] === "list") {
      listArgs = args;
      return JSON.stringify([{ number: 1034, title: "merged latest", mergedAt: "2026-08-06T10:00:00Z" }]);
    }
    return JSON.stringify([]);
  };

  const result = await auditRepoCommitAttribution({
    repo: "Blockcast/example",
    since: "2026-08-01",
    ghApi: fakeGhApi,
  });

  assert.ok(listArgs.includes("--search"), "must filter by merge time");
  assert.equal(listArgs[listArgs.indexOf("--search") + 1], "merged:>=2026-08-01");
  assert.equal(listArgs[listArgs.indexOf("--limit") + 1], String(AUDIT_PR_LIST_MAX));
  assert.equal(result.windowTruncated, false);
  assert.equal(result.newestMergedAt, "2026-08-06T10:00:00Z");
});

test("runAudit fails closed when the merge-time window exceeds the fetch cap", async () => {
  // Coverage it cannot prove must not be reported as coverage. A full page
  // means there may be merged PRs in the window we never looked at.
  const cappedList = JSON.stringify(
    Array.from({ length: AUDIT_PR_LIST_MAX }, (_, index) => ({
      number: index + 1,
      title: `pr ${index + 1}`,
      mergedAt: "2026-08-06T10:00:00Z",
    })),
  );
  const logged = [];

  const outcome = await runAudit({
    repos: ["Blockcast/example"],
    since: "2026-01-01",
    log: (line) => logged.push(line),
    ghApi: async (args) =>
      args[0] === "pr" && args[1] === "list" ? cappedList : JSON.stringify([]),
  });

  assert.equal(outcome.passed, false);
  assert.deepEqual(outcome.offenses, []);
  assert.equal(outcome.windowTruncated.length, 1);
  assert.ok(logged.some((line) => line.includes("INCOMPLETE") && line.includes("Narrow --since")));
  assert.ok(!logged.some((line) => line.includes("VIOLATION")));
});

test("runAudit reports the merge window it actually covered", async () => {
  const logged = [];
  await runAudit({
    repos: ["Blockcast/example"],
    since: "2026-08-01",
    log: (line) => logged.push(line),
    ghApi: async (args) =>
      args[0] === "pr" && args[1] === "list"
        ? JSON.stringify([
            { number: 9, title: "older", mergedAt: "2026-08-02T00:00:00Z" },
            { number: 10, title: "newer", mergedAt: "2026-08-06T00:00:00Z" },
          ])
        : JSON.stringify([]),
  });

  const summary = logged[0];
  assert.ok(summary.includes("merged since 2026-08-01"));
  assert.ok(summary.includes("2026-08-02T00:00:00Z .. 2026-08-06T00:00:00Z"));
});

test("runAudit passes when every PR is fully audited and clean", async () => {
  const outcome = await runAudit({
    repos: ["Blockcast/example"],
    since: "2026-08-01",
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
