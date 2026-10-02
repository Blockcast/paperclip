import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import {
  APP_NOREPLY_EMAIL,
  auditRepoCommitAttribution,
  AUDIT_PR_LIST_MAX,
  COMMITS_API_MAX,
  findAttributionOffenses,
  findLocalRangeOffenses,
  GRANDFATHERED_OFFENSE_SHAS,
  resolveSince,
  runAudit,
  sortByMergedAtDesc,
} from "./check-commit-author-attribution.mjs";

function patchKey(repoRoot, sha, email = APP_NOREPLY_EMAIL) {
  const patch = execFileSync("git", ["show", "--format=", sha], { cwd: repoRoot, encoding: "utf8" });
  const patchId = execFileSync("git", ["patch-id", "--stable"], { cwd: repoRoot, input: patch, encoding: "utf8" }).trim().split(/\s+/)[0];
  return `${patchId}|${email}`;
}

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

// The graphify-reindex bot is a scheduled knowledge-graph refresh on
// origin/bot/graphify-reindex. It pushes under
// `graphify-reindex (allyblockcast) <allyblockcast[bot]@users.noreply.github.com>`
// — the BARE App spelling, which since BLO-26647 this gate DOES match. It is
// exempt as a non-agent process, but only name-plus-path: both halves of a git
// author are caller-controlled, so a name-only exemption would be a one-line
// bypass of the whole gate.
//
// Before BLO-26647 this test asserted the same `[]` for the wrong reason — the
// narrow `!==` matcher simply never reached the bare email, so the exemption
// was accidental and 15 real offenses shared the ride. If these start failing,
// the bot's author name or output paths changed: update
// NON_AGENT_PROCESS_EXEMPTIONS to match, do NOT re-add a `head_ref` branch
// exemption (a fork bypass — `head_ref` carries no repository identity — and
// empty on `merge_group`, so it would false-reject the whole queue).
const GRAPHIFY_COMMIT = {
  sha: "206d6edaf",
  authorEmail: "allyblockcast[bot]@users.noreply.github.com",
  authorName: "graphify-reindex (allyblockcast)",
  parentCount: 1,
  message: "chore(graphify): refresh knowledge graphs",
  paths: ["server/src/graphify-out/graph.json", "server/src/graphify-out/GRAPH_REPORT.md"],
};

test("findAttributionOffenses exempts the graphify-reindex bot inside its own output paths", () => {
  assert.deepEqual(findAttributionOffenses([GRAPHIFY_COMMIT]), []);
});

test("findAttributionOffenses still flags a commit wearing the graphify name outside graphify-out (forged-name bypass)", () => {
  // The bypass Ally flagged on PR #1350: set user.name to the bot's name,
  // keep the bare email, and the gate waves any commit through. The path pin
  // is what makes the forgery worthless — it can only ever smuggle generated
  // graph data, never work.
  const forged = { ...GRAPHIFY_COMMIT, sha: "forged1", paths: ["server/src/services/issues.ts"] };
  assert.equal(findAttributionOffenses([forged]).length, 1);

  // A single out-of-scope path among otherwise-legitimate ones is enough.
  const mixed = {
    ...GRAPHIFY_COMMIT,
    sha: "forged2",
    paths: ["server/src/graphify-out/graph.json", ".github/workflows/pr.yml"],
  };
  assert.equal(findAttributionOffenses([mixed]).length, 1);

  // A forger can create a NEW `graphify-out/` directory anywhere, so the scope
  // must be anchored to the real output dir, not match the name at any depth.
  for (const forgedPath of ["server/src/services/graphify-out/pwn.ts", "docs/x/graphify-out/deploy.sh", "graphify-out/x.json"]) {
    const nested = { ...GRAPHIFY_COMMIT, sha: "forged3", paths: [forgedPath] };
    assert.equal(findAttributionOffenses([nested]).length, 1, forgedPath);
  }
});

test("findAttributionOffenses fails closed on the graphify name when no paths are known", () => {
  // `--audit-merged` has no cheap path source, so it supplies none. Exempting
  // on the strength of a forgeable name alone is exactly the hole; reporting
  // the commit instead is the safe direction for an advisory mode.
  const { paths: _paths, ...noPaths } = GRAPHIFY_COMMIT;
  assert.equal(findAttributionOffenses([noPaths]).length, 1);
  assert.equal(findAttributionOffenses([{ ...GRAPHIFY_COMMIT, paths: [] }]).length, 1);
});

test("findAttributionOffenses flags every observed spelling of the App noreply address (BLO-26647)", () => {
  // Measured on origin/master, non-merge commits since 2026-07-01: at filing
  // (2026-08-12) 192 carried the id-prefixed form and were caught, 15 carried a
  // variant and were not; re-measured 2026-10-02 the split was 194 against 288.
  // Each of these resolves via GET /repos/{owner}/{repo}/commits/{sha} to the
  // same installation (id 290875700) as the id-prefixed form — or, for the two
  // wrong-prefix forms, to no account at all, which erases the author harder.
  const spellings = [
    APP_NOREPLY_EMAIL,
    "allyblockcast[bot]@users.noreply.github.com", // 6c0e9c336 — author.id 290875700
    "220200645+allyblockcast[bot]@users.noreply.github.com", // d41030016 — resolves to nothing
    "218837398+allyblockcast[bot]@users.noreply.github.com", // 8afd2b4c0 — resolves to nothing
    "ALLYBLOCKCAST[BOT]@Users.NoReply.GitHub.com", // casing is not a write path this gate may miss
    "290875700+allyblockcast[bot]+agent@users.noreply.github.com", // subaddressed
  ];
  for (const authorEmail of spellings) {
    const offenses = findAttributionOffenses([
      { sha: "a", authorEmail, authorName: "CTO", parentCount: 1, message: "api write" },
    ]);
    assert.equal(offenses.length, 1, `${authorEmail} should be an offense`);
  }
});

test("findAttributionOffenses does NOT flag the no-[bot] allyblockcast account (id 296676656)", () => {
  // A different, real GitHub account — not installation 290875700, which is
  // the only identity this gate is chartered to catch. Matching it would
  // misattribute it to the wrong installation. See the module docblock.
  const offenses = findAttributionOffenses([
    {
      sha: "7fb261047",
      authorEmail: "allyblockcast@users.noreply.github.com",
      authorName: "PlatformSREEngineer (Ally)",
      parentCount: 1,
      message: "git push",
    },
  ]);
  assert.deepEqual(offenses, []);
});

test("findAttributionOffenses matches the grandfather allowlist case-insensitively on email", () => {
  // The matcher accepts mixed case, so the allowlist key must normalize it too
  // — otherwise widening the matcher would silently eject an allowlisted
  // commit that happened to be stamped in a different case.
  const patchId = "102821942f40ec00b8ad6caef30fdcf06d3d10a2";
  const key = `${patchId}|allyblockcast[bot]@users.noreply.github.com`;
  const commit = {
    sha: "cace65cf3",
    authorEmail: "AllyBlockcast[Bot]@users.noreply.github.com",
    authorName: "allyblockcast[bot]",
    parentCount: 1,
    patchId,
    message: "fix(issues): stable enumeration",
  };
  assert.deepEqual(findAttributionOffenses([commit], { allowlist: new Set([key]) }), []);
});

test("GRANDFATHERED_OFFENSE_SHAS registers the pre-cutoff bare-spelling cohort BLO-26647 exposes", () => {
  // Widening the matcher newly reaches these. All are pre-ATTRIBUTION_GATE_CUTOFF
  // and sat on open PRs on 2026-09-29, so without registration this change
  // would retro-break them — the exact failure BLO-23894 exists to prevent.
  const bare = "allyblockcast[bot]@users.noreply.github.com";
  for (const patchId of [
    "3203ee89e7bbeef3cc7d34bc3fa0a84e26788387", // #1076 6e7440da2 — this issue's named AC
    "102821942f40ec00b8ad6caef30fdcf06d3d10a2", // #1140
    "6f68b4dc6658bff45a895cf4b917e64af4f76e9e", // #1183
    "4e5c4ab103c22ab8aa27ab6563219bb80061e00b", // #891
    "c9ceb199c4c43b8ed690e53f16c699fb5fd8a343", // #891
    "6300049f135f0bda6f93cf2966563efe708328ed", // #929
  ]) {
    assert.ok(
      GRANDFATHERED_OFFENSE_SHAS.has(`${patchId}|${bare}`),
      `${patchId} must stay registered or its PR retro-breaks`,
    );
  }

  // The POST-cutoff one found in the same scan is deliberately absent: it is a
  // live violation, and grandfathering it would reopen the gate it trips.
  assert.ok(
    !GRANDFATHERED_OFFENSE_SHAS.has(`0f54e7c58624243b66149833ec3d5f7cd9947879|${bare}`),
    "#1278 7d8070c83 is post-cutoff and must NOT be grandfathered",
  );

  // Two dead entries removed in BLO-26647 — their PRs landed by re-attribution,
  // so the patches they keyed exist on no ref. Verified against all 13
  // App-attributed commits across all 142 open PRs before removal.
  for (const deadKey of [
    `b22bed3ac5812f8ba9b335b597accc2dbd59b9c8|${APP_NOREPLY_EMAIL}`,
    `437abe8653d01a0dbbae17e8a2ed88477df9d46e|${APP_NOREPLY_EMAIL}`,
  ]) {
    assert.ok(!GRANDFATHERED_OFFENSE_SHAS.has(deadKey), `${deadKey} is dead and should stay removed`);
  }
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

test("findAttributionOffenses with an allowlist clears an App-attributed commit whose patch and author are registered (BLO-23894)", () => {
  const offenses = findAttributionOffenses(
    [
      {
        patchId: "962aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        authorEmail: APP_NOREPLY_EMAIL,
        authorDate: "2026-08-05T16:46:12Z",
        parentCount: 1,
        message: "pre-cutoff API write",
      },
    ],
    { allowlist: new Set([`962aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa|${APP_NOREPLY_EMAIL}`]) },
  );
  assert.deepEqual(offenses, []);
});

test("findAttributionOffenses with an allowlist still flags an App-attributed commit whose sha is NOT a member, even if authored long ago (fail closed on unenumerated history)", () => {
  const offenses = findAttributionOffenses(
    [
      {
        patchId: "notpinnedaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        authorEmail: APP_NOREPLY_EMAIL,
        authorDate: "2020-01-01T00:00:00Z",
        parentCount: 1,
        message: "old but unenumerated API write",
      },
    ],
    { allowlist: new Set([`962aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa|${APP_NOREPLY_EMAIL}`]) },
  );
  assert.equal(offenses.length, 1);
});

test("findAttributionOffenses with an allowlist is immune to a backdated authorDate on a non-allowlisted sha (BLO-23894 — this is the forgery the date-cutoff design allowed)", () => {
  const offenses = findAttributionOffenses(
    [
      {
        patchId: "forgedaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
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
      patchId: [...GRANDFATHERED_OFFENSE_SHAS][0].split("|")[0],
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
    assert.match(sha, /^[0-9a-f]{40}\|.+@.+$/, `${sha} is not a patch-id plus author key`);
  }
});

/**
 * Pin a fixture commit's identity in the ENVIRONMENT, not via `git config`.
 *
 * Every agent run carries a per-run `GIT_AUTHOR_*`/`GIT_COMMITTER_*` overlay
 * (`applyAgentGitIdentityToRuntimeConfig`, BLO-29050) that outranks the local,
 * global and system config files. A fixture that selects its author with
 * `git config user.email <x>` therefore commits as the *acting agent* instead
 * of `<x>`, so no fixture below can produce an App-attributed commit at all.
 *
 * That failed silently in the worst possible pattern: the four tests asserting
 * an offense IS found failed, while the two asserting NO offense is found
 * passed for the wrong reason — verified by mutation, they stayed green in a
 * pod with grandfathering entirely disabled. And none of it is visible in CI,
 * where GitHub runners carry no overlay and `git config` still decides.
 * Setting the identity in the environment is correct in both places, so each
 * `git` helper below defaults every invocation to `base@example.com` and takes
 * a per-call override; nothing here relies on `git config` for identity.
 */
function asAuthor(email, name = "Test") {
  return {
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
  };
}

test("findLocalRangeOffenses reads non-merge commits from a real git range and flags App-attributed ones", () => {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), "attribution-test-"));
  try {
    const git = (args, env) =>
      execFileSync("git", args, {
        cwd: repoRoot,
        encoding: "utf8",
        env: { ...process.env, ...asAuthor("base@example.com"), ...env },
      });
    git(["init", "-q"]);
    git(["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "base", "-q"], asAuthor("base@example.com"));
    const base = git(["rev-parse", "HEAD"]).trim();

    git(
      ["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "agent commit", "-q"],
      asAuthor("platformsreengineer@paperclip.blockcast.net"),
    );

    git(
      ["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "api-path commit", "-q"],
      asAuthor(APP_NOREPLY_EMAIL),
    );
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
    const git = (args, env) =>
      execFileSync("git", args, {
        cwd: repoRoot,
        encoding: "utf8",
        env: { ...process.env, ...asAuthor("base@example.com"), ...env },
      });
    const asApp = asAuthor(APP_NOREPLY_EMAIL);
    git(["init", "-q", "-b", "main"]);
    git(["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "base", "-q"], asApp);
    const base = git(["rev-parse", "HEAD"]).trim();

    git(["checkout", "-q", "-b", "feature"]);
    git(["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "feature work", "-q"], asApp);
    git(["checkout", "-q", "main"]);
    git(["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "unrelated main work", "-q"], asApp);
    git(["-c", "commit.gpgsign=false", "merge", "--no-ff", "-m", "Merge branch feature", "feature", "-q"], asApp);
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
      execFileSync("git", args, {
        cwd: repoRoot,
        encoding: "utf8",
        env: { ...process.env, ...asAuthor("base@example.com"), ...env },
      });
    git(["init", "-q"]);
    git(["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "base", "-q"], asAuthor("base@example.com"));
    const base = git(["rev-parse", "HEAD"]).trim();

    git(["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "pre-cutoff api-path commit", "-q"], {
      ...asAuthor(APP_NOREPLY_EMAIL),
      GIT_AUTHOR_DATE: "2026-08-05T16:46:12Z",
      GIT_COMMITTER_DATE: "2026-08-06T01:15:46Z",
    });
    const head = git(["rev-parse", "HEAD"]).trim();

    // Real PR #962 shape (BLO-23894): register stable patch-id plus author.
    assert.deepEqual(findLocalRangeOffenses({ repoRoot, base, head, allowlist: new Set([patchKey(repoRoot, head)]) }), []);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("findLocalRangeOffenses still flags an App-attributed commit whose sha is not allowlisted, regardless of a backdated authorDate (BLO-23894 — closes the date-forgery hole)", () => {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), "attribution-test-not-allowlisted-"));
  try {
    const git = (args, env) =>
      execFileSync("git", args, {
        cwd: repoRoot,
        encoding: "utf8",
        env: { ...process.env, ...asAuthor("base@example.com"), ...env },
      });
    git(["init", "-q"]);
    git(["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "base", "-q"], asAuthor("base@example.com"));
    const base = git(["rev-parse", "HEAD"]).trim();

    // Backdated to well before the cutoff — under the old date-cutoff design
    // this alone would have cleared the gate. It must not, now.
    git(["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "backdated api-path commit", "-q"], {
      ...asAuthor(APP_NOREPLY_EMAIL),
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

test("findLocalRangeOffenses keeps grandfathering a registered patch across a merge-based branch update", () => {
  // Pins the trade-off documented on findAttributionOffenses: SHA-pinning
  // survives the "Update branch" merge this repo's queue actually uses
  // (verified via PR #1265's own mergeStateStatus) because a merge leaves
  // the original commit's sha untouched.
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), "attribution-test-allowlist-merge-"));
  try {
    const git = (args, env) =>
      execFileSync("git", args, {
        cwd: repoRoot,
        encoding: "utf8",
        env: { ...process.env, ...asAuthor("base@example.com"), ...env },
      });
    git(["init", "-q", "-b", "main"]);
    git(["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "base", "-q"], asAuthor("base@example.com"));
    const base = git(["rev-parse", "HEAD"]).trim();

    git(["checkout", "-q", "-b", "feature"]);
    git(["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "pre-cutoff api-path commit", "-q"], {
      ...asAuthor(APP_NOREPLY_EMAIL),
      GIT_AUTHOR_DATE: "2026-08-05T16:46:12Z",
      GIT_COMMITTER_DATE: "2026-08-06T01:15:46Z",
    });
    const pinnedSha = git(["rev-parse", "HEAD"]).trim();

    // Base moves forward after the cutoff; the feature branch is updated via a merge.
    git(["checkout", "-q", "main"]);
    git(
      ["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "unrelated main work", "-q"],
      asAuthor("base@example.com"),
    );
    git(["checkout", "-q", "feature"]);
    git(
      ["-c", "commit.gpgsign=false", "merge", "--no-ff", "-m", "Merge branch main into feature", "main", "-q"],
      asAuthor("base@example.com"),
    );
    const head = git(["rev-parse", "HEAD"]).trim();

    // The pinned commit's own sha is unchanged by the merge — still present
    // in the range alongside the unrelated main-branch commit pulled in.
    const shasInRange = git(["log", "--no-merges", "--format=%H", `${base}..${head}`]).trim().split("\n");
    assert.ok(shasInRange.includes(pinnedSha));

    assert.deepEqual(
      findLocalRangeOffenses({ repoRoot, base, head, allowlist: new Set([patchKey(repoRoot, pinnedSha)]) }).map((o) => o.message),
      [],
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("findLocalRangeOffenses carries a registered grandfather through a rebase (BLO-27142)", () => {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), "attribution-test-allowlist-rebase-"));
  try {
    const git = (args, env) =>
      execFileSync("git", args, {
        cwd: repoRoot,
        encoding: "utf8",
        env: { ...process.env, ...asAuthor("base@example.com"), ...env },
      });
    git(["init", "-q", "-b", "main"]);
    git(["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "base", "-q"], asAuthor("base@example.com"));
    const base = git(["rev-parse", "HEAD"]).trim();

    git(["checkout", "-q", "-b", "feature"]);
    git(["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "pre-cutoff api-path commit", "-q"], {
      ...asAuthor(APP_NOREPLY_EMAIL),
      GIT_AUTHOR_DATE: "2026-08-05T16:46:12Z",
      GIT_COMMITTER_DATE: "2026-08-06T01:15:46Z",
    });
    const pinnedSha = git(["rev-parse", "HEAD"]).trim();

    git(["checkout", "-q", "main"]);
    git(
      ["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "unrelated main work", "-q"],
      asAuthor("base@example.com"),
    );
    git(["checkout", "-q", "feature"]);
    git(["-c", "commit.gpgsign=false", "rebase", "main", "-q"]);
    const rebasedHead = git(["rev-parse", "HEAD"]).trim();

    // Rebase rewrites the commit: new sha, even though the diff is identical.
    assert.notEqual(rebasedHead, pinnedSha);

    // Raw SHA matching is deliberately not accepted.
    assert.equal(
      findLocalRangeOffenses({ repoRoot, base, head: rebasedHead, allowlist: new Set([pinnedSha]) }).length,
      1,
    );

    // The stable patch-id survives the queue's rebase.
    assert.deepEqual(
      findLocalRangeOffenses({ repoRoot, base, head: rebasedHead, allowlist: new Set([patchKey(repoRoot, rebasedHead)]) }),
      [],
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("findLocalRangeOffenses reads real paths, so the graphify exemption holds in-scope and fails out-of-scope (BLO-26647)", () => {
  // The end-to-end proof that `paths` is actually plumbed from git. Every pure
  // `findAttributionOffenses` case above can pass on a hand-built record while
  // `findLocalRangeOffenses` never populates `paths` at all — in which case the
  // exemption fails closed and every real graphify PR breaks. This test is what
  // notices.
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), "attribution-test-graphify-"));
  try {
    const git = (args, overrides) =>
      execFileSync("git", args, {
        cwd: repoRoot,
        encoding: "utf8",
        env: { ...process.env, ...asAuthor("base@example.com"), ...overrides },
      });
    const commitFile = (relPath, body, overrides) => {
      mkdirSync(path.join(repoRoot, path.dirname(relPath)), { recursive: true });
      writeFileSync(path.join(repoRoot, relPath), body);
      git(["add", relPath]);
      git(["-c", "commit.gpgsign=false", "commit", "-m", `touch ${relPath}`, "-q"], overrides);
      return git(["rev-parse", "HEAD"]).trim();
    };

    git(["init", "-q", "-b", "main"]);
    git(["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "base", "-q"], asAuthor("base@example.com"));
    const base = git(["rev-parse", "HEAD"]).trim();

    const bot = asAuthor("allyblockcast[bot]@users.noreply.github.com", "graphify-reindex (allyblockcast)");

    // In scope: the bot's own generated output.
    const inScope = commitFile("server/src/graphify-out/graph.json", '{"nodes":[]}\n', bot);
    assert.deepEqual(findLocalRangeOffenses({ repoRoot, base, head: inScope }), []);

    // In scope with a non-ASCII name: git quotes these by default
    // ("server/src/graphify-out/\303\251.json"), which the anchored scope
    // would reject. Proves `pathsForCommit` reads them unquoted.
    const nonAscii = commitFile("server/src/graphify-out/\u00e9.json", "{}\n", bot);
    assert.deepEqual(findLocalRangeOffenses({ repoRoot, base: inScope, head: nonAscii }), []);

    // Out of scope: same name, same email, real source file. Still an offense.
    const outOfScope = commitFile("server/src/services/issues.ts", "export const x = 1;\n", bot);
    const offenses = findLocalRangeOffenses({ repoRoot, base: nonAscii, head: outOfScope });
    assert.equal(offenses.length, 1);
    assert.equal(offenses[0].sha, outOfScope);
    assert.deepEqual(offenses[0].paths, ["server/src/services/issues.ts"]);

    // Out of scope: a forger-created `graphify-out/` below a source dir.
    const nested = commitFile("server/src/services/graphify-out/pwn.ts", "export const y = 1;\n", bot);
    const nestedOffenses = findLocalRangeOffenses({ repoRoot, base: outOfScope, head: nested });
    assert.equal(nestedOffenses.length, 1);
    assert.deepEqual(nestedOffenses[0].paths, ["server/src/services/graphify-out/pwn.ts"]);
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
