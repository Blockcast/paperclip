import { execFile } from "node:child_process";
import { basename, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_MIGRATIONS_PATH = "packages/db/src/migrations";

export type MigrationImmutabilityOptions = {
  /** Where to run git. Defaults to the repo root containing this file. */
  repoDir?: string;
  /** Migrations folder, relative to the repo root. */
  migrationsPath?: string;
  /**
   * Remote to fetch the released branch from when it is not already present.
   * Set to `null` to never fetch (used by the tests).
   */
  remote?: string | null;
  /** Released branch whose migration bytes are frozen. */
  branch?: string;
};

/**
 * Why nothing was checked. Only `no-work-tree` is benign — `pnpm build` runs
 * this inside the Docker image, which has no `.git` (`.dockerignore:1`). The
 * other two mean we ARE in a work tree and simply could not compare, which is
 * the false-green this guard exists to prevent, so they must fail rather than
 * skip. `main()` branches on this tag, not on the prose in `reason`.
 */
export type UncheckedCause = "no-work-tree" | "no-base" | "diff-failed";

export type MigrationImmutabilityResult =
  /** No comparable base was available, so nothing was checked. */
  | { checked: false; cause: UncheckedCause; reason: string }
  | { checked: true; baseRef: string; offenders: string[] };

async function git(repoDir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: repoDir, maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

async function tryGit(repoDir: string, args: string[]): Promise<string | null> {
  try {
    return await git(repoDir, args);
  } catch {
    return null;
  }
}

/**
 * The commit whose migration bytes are already applied somewhere.
 *
 * `origin/master` when the checkout has it. CI does not: the jobs that run
 * `check:migrations` (`build`, via `pnpm build`) check out with the default
 * `fetch-depth: 1`, so only the PR merge commit is present and no remote
 * branch resolves. A one-commit fetch of the released branch covers that
 * without unshallowing the checkout.
 */
async function resolveBaseRef(
  repoDir: string,
  remote: string | null,
  branch: string,
): Promise<{ ref: string } | { reason: string }> {
  for (const candidate of [`refs/remotes/${remote ?? "origin"}/${branch}`, `refs/heads/${branch}`]) {
    if ((await tryGit(repoDir, ["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`])) !== null) {
      return { ref: candidate };
    }
  }

  if (remote === null) return { reason: `no local ${branch} ref and fetching is disabled` };

  // `--depth=1` only when the checkout is ALREADY shallow. On a full clone it
  // writes `.git/shallow` and permanently truncates the developer's history —
  // measured 3 commits -> 1, breaking `log`/`blame`/`bisect` until someone
  // works out they need `git fetch --unshallow`. This path is reached from
  // `pnpm typecheck`/`build`/`generate`/`migrate`, so the blast radius is a
  // routine command, and the damage is silent and persistent. Ordinary clones
  // never get here (they resolve `origin/master` above); single-branch clones
  // and pruned-`master` checkouts do. CI is already shallow at `fetch-depth: 1`,
  // so it keeps the flag and its behaviour is unchanged.
  //
  // `!== null`, not truthiness: `git fetch` reports everything on stderr and
  // exits 0 with EMPTY stdout, so a truthy test reads every success as failure
  // and silently disables the guard in exactly the CI job it exists for.
  const isShallow = (await tryGit(repoDir, ["rev-parse", "--is-shallow-repository"]))?.trim() === "true";
  const depth = isShallow ? ["--depth=1"] : [];
  if ((await tryGit(repoDir, ["fetch", "--no-tags", ...depth, remote, branch])) !== null) {
    return { ref: "FETCH_HEAD" };
  }

  return { reason: `no local ${branch} ref and \`git fetch ${remote} ${branch}\` failed` };
}

/**
 * Migration files whose bytes differ from the released branch.
 *
 * Deliberately a plain two-dot diff against the branch tip rather than a
 * merge-base diff: the CI checkout is shallow, so there is no shared history
 * to compute a merge base from. The cost is that a migration added on the
 * released branch after this branch forked reads as a deletion, which is why
 * only `M` counts as an offence — a `D` here is far more often "my branch is
 * behind" than "someone deleted an applied migration".
 *
 * ponytail: deletion of an applied migration is therefore unguarded. It is a
 * different (quieter) failure — the file leaves `listMigrationFiles()` instead
 * of going pending — and catching it needs a merge base, i.e. a deeper
 * checkout in the `build` job. Add that if a deletion ever happens.
 */
export async function checkMigrationImmutability(
  options: MigrationImmutabilityOptions = {},
): Promise<MigrationImmutabilityResult> {
  const startDir = options.repoDir ?? dirname(fileURLToPath(import.meta.url));
  const migrationsPath = options.migrationsPath ?? DEFAULT_MIGRATIONS_PATH;
  const remote = options.remote === undefined ? "origin" : options.remote;
  const branch = options.branch ?? "master";

  const toplevel = (await tryGit(startDir, ["rev-parse", "--show-toplevel"]))?.trim();
  if (!toplevel) {
    return { checked: false, cause: "no-work-tree", reason: `${startDir} is not inside a git work tree` };
  }

  const base = await resolveBaseRef(toplevel, remote, branch);
  if ("reason" in base) return { checked: false, cause: "no-base", reason: base.reason };

  const diff = await tryGit(toplevel, [
    "diff",
    "--name-status",
    "--no-renames",
    base.ref,
    "--",
    migrationsPath,
  ]);
  if (diff === null) {
    return { checked: false, cause: "diff-failed", reason: `\`git diff ${base.ref}\` failed` };
  }

  // Only `.sql` directly in the migrations folder. `meta/_journal.json` is
  // bookkeeping and is supposed to change; nested paths are not migrations.
  const migrationSql = new RegExp(`^${migrationsPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/[^/]+\\.sql$`);

  const offenders = diff
    .split("\n")
    .map((line) => line.split("\t"))
    .filter(([status, file]) => status === "M" && file && migrationSql.test(file))
    .map(([, file]) => file);

  return { checked: true, baseRef: base.ref, offenders };
}

export function formatOffenders(offenders: string[], baseRef: string): string {
  return (
    `Applied migration(s) edited: ${offenders.join(", ")}.\n` +
    `These files already exist on ${baseRef}, so every already-migrated database has ` +
    `applied them and recorded the sha256 of their ORIGINAL bytes in ` +
    `drizzle.__drizzle_migrations. On the stock drizzle schema that table has no ` +
    `\`name\` column, so ` +
    `loadAppliedMigrations() reconstructs the applied set by hashing each file's CURRENT ` +
    `content (mapHashesToMigrationFiles). Changing even a comment or a blank line changes ` +
    `the hash, the stored row resolves to nothing, and the migration reads as PENDING ` +
    `forever — re-running on every deploy preflight. Worse, ` +
    `reconcilePendingMigrationHistory() bails with \`break\`, not \`continue\`, on the first ` +
    `migration it cannot prove was already applied, so history repair dies for every ` +
    `migration ordered after this one too.\n` +
    `Revert the file and put the change in a new migration instead.`
  );
}

export async function main(options: MigrationImmutabilityOptions = {}) {
  const result = await checkMigrationImmutability(options);

  if (!result.checked) {
    // Only the Docker case is benign: `pnpm build` runs this inside the image,
    // which has no `.git`. Loud on stderr so a job that quietly stops checking
    // is visible in the log rather than passing as a green guard.
    if (result.cause === "no-work-tree") {
      console.error(`${basename(process.argv[1])}: skipped — ${result.reason}`);
      return;
    }
    // We are in a work tree and could not compare. In CI that is exactly the
    // load-bearing path — `build` checks out at the default `fetch-depth: 1`,
    // so the fetch at resolveBaseRef() is the only way a base exists, and a
    // transient failure there used to exit 0 and silently disable the guard.
    throw new Error(`could not verify migration immutability — ${result.reason}`);
  }

  if (result.offenders.length > 0) throw new Error(formatOffenders(result.offenders, result.baseRef));
}

const isDirectRun =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  try {
    await main();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`${basename(process.argv[1])}: ${detail}`);
    process.exitCode = 1;
  }
}
