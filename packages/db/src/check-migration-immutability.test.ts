import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { checkMigrationImmutability, formatOffenders, main } from "./check-migration-immutability.js";

const execFileAsync = promisify(execFile);

// Every case shells out to git several times. The default 10s hook timeout is
// not enough to build the fixture repo (~20 subprocesses) on a slow filesystem,
// and a guard test that goes red at random is a guard nobody trusts.
vi.setConfig({ hookTimeout: 120_000, testTimeout: 60_000 });

const MIGRATIONS = "packages/db/src/migrations";

/**
 * `remote: null` keeps every case offline — the fetch fallback only exists for
 * CI's shallow checkout and would otherwise reach the network from a test.
 */
const OFFLINE = { migrationsPath: MIGRATIONS, remote: null } as const;

let repo: string;

async function git(...args: string[]) {
  await execFileAsync("git", args, { cwd: repo });
}

async function write(relative: string, content: string) {
  const path = join(repo, relative);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content, "utf8");
}

async function commit(message: string) {
  await git("add", "-A");
  await git("commit", "-m", message);
}

async function offendersOn(branch: string): Promise<string[]> {
  await git("checkout", branch);
  const result = await checkMigrationImmutability({ ...OFFLINE, repoDir: repo });
  if (!result.checked) throw new Error(`expected a checked result, got: ${result.reason}`);
  return result.offenders;
}

beforeAll(async () => {
  repo = await mkdtemp(join(tmpdir(), "migration-immutability-"));
  await git("init", "-b", "master");
  await git("config", "user.email", "test@example.com");
  await git("config", "user.name", "test");

  await write(
    `${MIGRATIONS}/0001_alpha.sql`,
    "-- original header\nCREATE TABLE alpha (id serial PRIMARY KEY);\n",
  );
  await write(`${MIGRATIONS}/meta/_journal.json`, JSON.stringify({ entries: [{ idx: 0, tag: "0001_alpha" }] }));
  await write("packages/db/src/client.ts", "export const x = 1;\n");
  await commit("release 0001");

  // `master` is deliberately deeper than one commit, and these are load-bearing
  // — do not flatten them. The shallow-arm case below discriminates on how much
  // of `master` the fetch pulled down, and against a single-commit `master`
  // that count is 1 with or without `--depth=1` (measured), i.e. the case would
  // pass on broken code. Nothing here touches migrations, so every other case
  // is indifferent; the branches below all fork from this deepened tip.
  for (const rev of [2, 3]) {
    await write("packages/db/src/client.ts", `export const x = 1; // rev ${rev}\n`);
    await commit(`unrelated history ${rev}`);
  }

  // AC 1: a comments-only edit to a migration that is already on master.
  await git("checkout", "-b", "comment-edit");
  await write(
    `${MIGRATIONS}/0001_alpha.sql`,
    "-- reworded header\nCREATE TABLE alpha (id serial PRIMARY KEY);\n",
  );
  await commit("reword a comment");

  // AC 2a: a new migration plus its journal entry.
  await git("checkout", "master");
  await git("checkout", "-b", "new-migration");
  await write(`${MIGRATIONS}/0002_beta.sql`, "CREATE TABLE beta (id serial PRIMARY KEY);\n");
  await write(
    `${MIGRATIONS}/meta/_journal.json`,
    JSON.stringify({ entries: [{ idx: 0, tag: "0001_alpha" }, { idx: 1, tag: "0002_beta" }] }),
  );
  await commit("add 0002");

  // AC 2b: an edit that touches no migration.
  await git("checkout", "master");
  await git("checkout", "-b", "unrelated-edit");
  await write("packages/db/src/client.ts", "export const x = 2;\n");
  await commit("touch client");

  await git("checkout", "master");
});

afterAll(async () => {
  if (repo) await rm(repo, { recursive: true, force: true });
});

describe("checkMigrationImmutability", () => {
  it("fails a comments-only edit to a migration already on master", async () => {
    expect(await offendersOn("comment-edit")).toEqual([`${MIGRATIONS}/0001_alpha.sql`]);
  });

  it("passes a new migration added with a new journal entry", async () => {
    expect(await offendersOn("new-migration")).toEqual([]);
  });

  it("passes an edit to a non-migration file", async () => {
    expect(await offendersOn("unrelated-edit")).toEqual([]);
  });

  it("passes when the migrations folder is untouched", async () => {
    expect(await offendersOn("master")).toEqual([]);
  });

  it("catches an uncommitted edit, so the author sees it before pushing", async () => {
    await git("checkout", "master");
    await write(
      `${MIGRATIONS}/0001_alpha.sql`,
      "-- original header\n\nCREATE TABLE alpha (id serial PRIMARY KEY);\n",
    );
    try {
      const result = await checkMigrationImmutability({ ...OFFLINE, repoDir: repo });
      expect(result).toMatchObject({ checked: true, offenders: [`${MIGRATIONS}/0001_alpha.sql`] });
    } finally {
      await git("checkout", "--", MIGRATIONS);
    }
  });

  it("ignores meta/_journal.json, which is meant to change", async () => {
    await git("checkout", "master");
    await write(`${MIGRATIONS}/meta/_journal.json`, JSON.stringify({ entries: [] }));
    try {
      expect(await offendersOn("master")).toEqual([]);
    } finally {
      await git("checkout", "--", MIGRATIONS);
    }
  });

  it("leaves a full clone full — `--depth=1` only when already shallow", async () => {
    // BLO-36745 review: `fetch --depth=1` writes `.git/shallow` even when the
    // repo was not shallow, permanently truncating history (measured 3 commits
    // -> 1) and breaking log/blame/bisect until `git fetch --unshallow`. The
    // path is reached from a routine `pnpm typecheck`/`build`, so the damage is
    // silent. CI is already shallow and keeps the flag; this pins the other arm.
    const consumer = await mkdtemp(join(tmpdir(), "migration-immutability-full-"));
    const isShallow = async () =>
      (
        await execFileAsync("git", ["rev-parse", "--is-shallow-repository"], { cwd: consumer })
      ).stdout.trim();
    try {
      await execFileAsync("git", ["clone", "--branch", "comment-edit", repo, consumer]);
      await execFileAsync("git", ["update-ref", "-d", "refs/remotes/origin/master"], { cwd: consumer });
      expect(await isShallow()).toBe("false"); // precondition: the arm under test

      const result = await checkMigrationImmutability({
        repoDir: consumer,
        migrationsPath: MIGRATIONS,
        remote: "origin",
        branch: "master",
      });

      // The guard must still work...
      expect(result).toMatchObject({ checked: true, baseRef: "FETCH_HEAD" });
      // ...without having shallowed the checkout to do it.
      expect(await isShallow()).toBe("false");
    } finally {
      await rm(consumer, { recursive: true, force: true });
    }
  });

  it("fetches only one commit into an already-shallow checkout — the CI shape", async () => {
    // The other arm of the same branch. `git fetch` without `--depth` does not
    // unshallow, so `is-shallow` reads `true` either way and every other case
    // in this file stays green with `const depth = []` substituted at
    // check-migration-immutability.ts:87 — a surviving mutation, confirmed.
    // The only observable difference is how much of `master` came down, and on
    // CI's `fetch-depth: 1` checkout that is one commit versus the whole
    // branch, on `typecheck`/`build`/`generate`/`migrate` alike (BLO-36817).
    //
    // `file://`, NOT a local path: `git clone --depth=1 <path>` prints
    // "--depth is ignored in local clones" and hands back a FULL repo, which
    // would silently re-test the case above. The `is-shallow` precondition is
    // what turns that into a loud failure instead of a false green.
    const consumer = await mkdtemp(join(tmpdir(), "migration-immutability-shallow-"));
    const inConsumer = async (...args: string[]) =>
      (await execFileAsync("git", args, { cwd: consumer })).stdout.trim();
    try {
      await execFileAsync("git", [
        "clone",
        "--depth=1",
        "--branch",
        "comment-edit",
        pathToFileURL(repo).href,
        consumer,
      ]);
      expect(await inConsumer("rev-parse", "--is-shallow-repository")).toBe("true");
      await inConsumer("update-ref", "-d", "refs/remotes/origin/master");

      const result = await checkMigrationImmutability({
        repoDir: consumer,
        migrationsPath: MIGRATIONS,
        remote: "origin",
        branch: "master",
      });

      // The guard must still work...
      expect(result).toMatchObject({ checked: true, baseRef: "FETCH_HEAD" });
      // ...having fetched one commit, not all of `master`.
      expect(await inConsumer("rev-list", "--count", "FETCH_HEAD")).toBe("1");
    } finally {
      await rm(consumer, { recursive: true, force: true });
    }
  });

  it("fetches the released branch when no local ref exists — the CI shape", async () => {
    // The jobs that run `check:migrations` check out with the default
    // `fetch-depth: 1`, so `origin/master` is absent and the fetch fallback is
    // the only path. Exercised against a local clone so it stays offline.
    // This case exists because the offline cases above cannot reach that code:
    // its first version mistook `git fetch`'s empty stdout for a failure and
    // skipped silently in CI while every other test stayed green.
    const consumer = await mkdtemp(join(tmpdir(), "migration-immutability-ci-"));
    try {
      await execFileAsync("git", ["clone", "--branch", "comment-edit", repo, consumer]);
      await execFileAsync("git", ["update-ref", "-d", "refs/remotes/origin/master"], { cwd: consumer });

      const result = await checkMigrationImmutability({
        repoDir: consumer,
        migrationsPath: MIGRATIONS,
        remote: "origin",
        branch: "master",
      });
      expect(result).toMatchObject({
        checked: true,
        baseRef: "FETCH_HEAD",
        offenders: [`${MIGRATIONS}/0001_alpha.sql`],
      });
    } finally {
      await rm(consumer, { recursive: true, force: true });
    }
  });

  it("reports unchecked rather than throwing when there is no git work tree", async () => {
    const outside = await mkdtemp(join(tmpdir(), "not-a-repo-"));
    try {
      const result = await checkMigrationImmutability({ ...OFFLINE, repoDir: outside });
      // A bare `tmpdir()` can itself sit inside someone's repo; either way the
      // point is that it degrades to a reason instead of throwing.
      if (result.checked) expect(result.offenders).toEqual([]);
      else expect(result.reason).toMatch(/git work tree|master ref/);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

/**
 * `main()` is where the two `checked: false` causes are told apart, and until
 * BLO-36745's review it was the only behaviour here with no test. Collapsing
 * them made a failed `git fetch` exit 0 — a silently disabled guard on the one
 * path CI actually takes, since `build` checks out at `fetch-depth: 1` and the
 * fetch is therefore load-bearing on every run.
 */
describe("main", () => {
  it("throws when it is in a work tree but cannot resolve a base", async () => {
    // The CI shape, reproduced offline: a real work tree whose base ref does
    // not resolve. Exiting 0 here is the false green the guard exists to stop.
    await expect(
      main({ ...OFFLINE, repoDir: repo, branch: "no-such-released-branch" }),
    ).rejects.toThrow(/could not verify migration immutability/);
  });

  it("throws, naming the file, when an applied migration was edited", async () => {
    await git("checkout", "comment-edit");
    try {
      await expect(main({ ...OFFLINE, repoDir: repo })).rejects.toThrow(
        new RegExp(`${MIGRATIONS}/0001_alpha\\.sql`),
      );
    } finally {
      await git("checkout", "master");
    }
  });

  it("resolves when the base is resolvable and no migration was edited", async () => {
    await git("checkout", "master");
    await expect(main({ ...OFFLINE, repoDir: repo })).resolves.toBeUndefined();
  });

  it("resolves, not throws, for no-work-tree — the Docker path `pnpm build` takes", async () => {
    // The asymmetric branch in `main()`: `no-work-tree` soft-skips, the other
    // two causes throw. Without this case, flipping that `if` to `if (false)`
    // leaves the whole file green while `pnpm build` starts failing inside the
    // image (`.dockerignore:1` strips `.git`, so the guard cannot run there).
    //
    // A BARE repo, not a bare tmpdir: `tmpdir()` can itself sit inside a
    // checkout, which would make this `no-base` and throw for the wrong reason
    // — that ambiguity is why the sibling `checkMigrationImmutability` case is
    // deliberately lenient. A bare repo's `.git` shadows any ancestor, so
    // `rev-parse --show-toplevel` fails as "must be run in a work tree"
    // everywhere this suite runs.
    const outside = await mkdtemp(join(tmpdir(), "bare-no-work-tree-"));
    try {
      await execFileAsync("git", ["init", "--bare", "."], { cwd: outside });
      await expect(main({ ...OFFLINE, repoDir: outside })).resolves.toBeUndefined();
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe("formatOffenders", () => {
  it("names the file and both halves of the failure", () => {
    const message = formatOffenders([`${MIGRATIONS}/0001_alpha.sql`], "refs/remotes/origin/master");
    expect(message).toContain(`${MIGRATIONS}/0001_alpha.sql`);
    expect(message).toContain("PENDING");
    expect(message).toContain("reconcilePendingMigrationHistory");
    expect(message).toContain("break");
  });
});
