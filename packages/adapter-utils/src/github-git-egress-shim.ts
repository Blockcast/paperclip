// PEN-3156: the THIRD egress door. PEN-2527 put `scrubGitHubEgressText` in front
// of the GitHub CLI and PEN-3152 put it in front of the `github` MCP server. The
// `git` wrapper the Helm seed writes alongside them reaches the same destination
// with the same seat token and, on a push, publishes commit messages and file
// contents — a strict superset of what `create_or_update_file` / `push_files`
// carry — with no scrubber anywhere on the path.
//
// This door cannot be fixed the way the other two were. Both of those rewrite a
// payload in flight, which is available to them precisely because nothing has
// hashed it yet. A commit object is content-addressed: altering a blob or a
// message after the fact changes that commit's SHA and every descendant's,
// breaks any signature over them, and desynchronises the agent's local ref from
// what landed. So the enforcement here is REFUSAL, not redaction — the push is
// stopped and the author is told which commit to amend.
//
// Everything in this module is pure. Git is reached only through the injected
// `runGit` callback, so the classification and scanning rules are testable
// without a repository, a remote, or a network.

import {
  type GitHubEgressScrubClass,
  scrubGitHubEgressText,
} from "./github-egress-scrub.js";

/**
 * Git global options that consume a SEPARATE following token.
 *
 * Getting this set wrong is not cosmetic: it shifts which token is read as the
 * subcommand. `git -c foo=bar push` would classify as a `foo=bar` subcommand
 * and the push would sail past the guard, so this list is the guard's integrity
 * rather than a parsing nicety. The `--opt=value` spelling is self-contained and
 * is handled separately.
 */
const VALUE_TAKING_GLOBAL_OPTIONS: ReadonlySet<string> = new Set([
  "-C",
  "-c",
  "--exec-path",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--super-prefix",
  "--config-env",
  "--attr-source",
]);

/**
 * Spellings of the flag that skips the pre-push hook.
 *
 * `-n` is deliberately NOT here. For `push` it means `--dry-run`, not
 * `--no-verify` (see the subcommand's own `-h` output), and it is harmless
 * twice over: the pre-push hook still runs under it, and a dry run publishes
 * nothing even if it did not. Refusing it would reject a safe command while
 * telling the author something untrue about why.
 */
const NO_VERIFY_FLAGS: ReadonlySet<string> = new Set(["--no-verify"]);

/** The config key whose value decides which directory git reads hooks from. */
const HOOKS_PATH_KEY = "core.hookspath";

/** The config section under which an assignment defines an alias. */
const ALIAS_KEY_PREFIX = "alias.";

/**
 * The environment `--config-env` reads through.
 *
 * Narrower than `NodeJS.ProcessEnv` on purpose: this module is pure, and taking
 * the lookup as data keeps `--config-env` testable without mutating the real
 * environment.
 */
export type GitEgressEnv = Readonly<Record<string, string | undefined>>;

/** The key half of a `<name>=<value>` config assignment, case-folded. */
function assignmentKey(assignment: string): string {
  return (assignment.split("=", 1)[0] ?? "").trim().toLowerCase();
}

/**
 * True when a `<name>=<value>` config assignment targets `core.hooksPath`.
 *
 * The comparison is case-folded because git config keys are case-insensitive in
 * their section and variable names: `-c CORE.HOOKSPATH=...` sets exactly the
 * same key as `-c core.hooksPath=...`, and a case-sensitive check here would see
 * only one of the two spellings. Verified against git 2.47.3.
 */
function isHooksPathAssignment(assignment: string): boolean {
  return assignmentKey(assignment) === HOOKS_PATH_KEY;
}

/**
 * The alias a `<name>=<value>` config assignment defines, or null.
 *
 * Case-folded for the same reason {@link isHooksPathAssignment} is, and
 * measured the same way: against git 2.47.3, `-c alias.YOLO=...` defines the
 * alias `git yolo` runs and `-c ALIAS.zz=...` defines `git zz`, so a
 * case-sensitive match here would see one spelling of three.
 *
 * An assignment carrying no `=` defines nothing. Git rejects `-c alias.b`
 * outright (`missing value for 'alias.b'`, `fatal: unable to parse command-line
 * config`), so there is no boolean-true alias to model.
 */
function aliasAssignment(
  assignment: string,
  options: { fromEnv: boolean; env: GitEgressEnv },
): { name: string; expansion: string } | null {
  const separator = assignment.indexOf("=");
  if (separator < 0) return null;
  const key = assignmentKey(assignment);
  if (!key.startsWith(ALIAS_KEY_PREFIX)) return null;
  const name = key.slice(ALIAS_KEY_PREFIX.length);
  if (!name) return null;
  const raw = assignment.slice(separator + 1);
  // `--config-env` names an environment variable; `-c` carries the value itself.
  const expansion = options.fromEnv ? options.env[raw] : raw;
  return expansion === undefined ? null : { name, expansion };
}

interface GlobalOptionScan {
  /** Index of the first token that is not a global option or its value. */
  subcommandIndex: number;
  /** A caller-supplied `core.hooksPath` override, as spelled, or null. */
  hooksPathOverride: string | null;
  /** Aliases this token run defines, keyed by case-folded name. */
  aliasDefinitions: Map<string, string>;
}

/**
 * Walk git's global options, reporting where the subcommand starts, whether the
 * caller set `core.hooksPath` along the way, and which aliases they defined.
 *
 * All three outputs are security-relevant. Getting the option boundary wrong
 * shifts which token reads as the subcommand, so `git -c foo=bar push` would
 * classify as a `foo=bar` subcommand and sail past the guard. Missing a
 * `core.hooksPath` override lets the caller nominate the hooks directory
 * themselves. Missing an alias DEFINITION is the subtler one and is why
 * `aliasDefinitions` exists at all: an alias defined here is invisible to a
 * separate `git config --get`, so it cannot be looked up after the fact — see
 * {@link classifyGitInvocation}.
 *
 * Only the separate-token `-c <name>=<value>` spelling is modelled because it is
 * the only one git accepts: `-calias.x=push` is rejected with `unknown option`
 * (git 2.47.3), so there is no attached short form to miss.
 */
function scanGlobalOptions(
  tokens: readonly string[],
  env: GitEgressEnv = {},
): GlobalOptionScan {
  let index = 0;
  let hooksPathOverride: string | null = null;
  const aliasDefinitions = new Map<string, string>();
  const define = (assignment: string, fromEnv: boolean) => {
    const alias = aliasAssignment(assignment, { fromEnv, env });
    // Last wins, matching git: `-c alias.d=status -c alias.d=push` runs push.
    if (alias) aliasDefinitions.set(alias.name, alias.expansion);
  };
  while (index < tokens.length) {
    const token = tokens[index]!;
    if (!token.startsWith("-")) break;
    // `--opt=value` carries its own value; `--opt value` and `-c x=y` do not.
    if (VALUE_TAKING_GLOBAL_OPTIONS.has(token)) {
      const value = tokens[index + 1];
      if (value !== undefined && (token === "-c" || token === "--config-env")) {
        if (isHooksPathAssignment(value)) hooksPathOverride ??= `${token} ${value}`;
        define(value, token === "--config-env");
      }
      index += 2;
      continue;
    }
    if (token.startsWith("--config-env=")) {
      const assignment = token.slice("--config-env=".length);
      if (isHooksPathAssignment(assignment)) hooksPathOverride ??= token;
      define(assignment, true);
    }
    index += 1;
  }
  return { subcommandIndex: index, hooksPathOverride, aliasDefinitions };
}

/**
 * The leading global options of an invocation, up to but excluding the
 * subcommand.
 *
 * Exported so the wrapper can resolve aliases under the same effective
 * configuration git itself will use — `-C`, `--git-dir` and friends all select
 * WHICH config files an alias lookup reads, and a bare `git config --get` reads
 * the wrong ones.
 */
export function gitGlobalOptions(argv: readonly string[]): string[] {
  return argv.slice(0, scanGlobalOptions(argv).subcommandIndex);
}

/** A hook bypass carried by an alias expansion rather than by argv. */
export interface GitAliasBypass {
  /** The alias the caller invoked. */
  alias: string;
  /** Its expansion, so the refusal can quote what git would have run. */
  expansion: string;
  /** Which bypass the expansion carries. */
  reason: "no-verify" | "hooks-path";
}

export interface GitInvocationClassification {
  /** The resolved subcommand, or null when argv carries only global options. */
  subcommand: string | null;
  /** True when this invocation would contact a remote to publish refs. */
  isPush: boolean;
  /** True when the invocation asks git to skip hooks. */
  hasNoVerify: boolean;
  /** Index in argv at which the subcommand was found, or -1. */
  subcommandIndex: number;
  /**
   * A caller-supplied `core.hooksPath` override among argv's global options.
   *
   * Injecting the guard last already beats this one (git takes the LAST `-c`
   * for a key), but it is reported so the wrapper can refuse it explicitly
   * rather than silently discarding what the caller asked for.
   */
  hooksPathOverride: string | null;
  /**
   * A bypass inside an alias expansion. Unlike the argv case this CANNOT be
   * beaten by injection: git expands the alias after the command line, so the
   * expansion's own `-c core.hooksPath=` or `--no-verify` wins.
   */
  aliasBypass: GitAliasBypass | null;
  /**
   * A `!`-prefixed shell alias reached while resolving the subcommand.
   *
   * Set whether or not the chain reached a push, because for a shell alias that
   * question is unanswerable: the expansion is arbitrary shell, and deciding
   * whether it publishes would mean parsing it. The wrapper refuses on this
   * rather than guessing. See `classifyGitInvocation` for why passing it through
   * is not an option.
   */
  shellAlias: GitShellAlias | null;
}

export interface GitShellAlias {
  /** The alias the caller invoked. */
  alias: string;
  /** Its expansion, so the refusal can quote what git would have run. */
  expansion: string;
}

/**
 * Split argv into git's global options and its subcommand.
 *
 * Aliases are resolved when the subcommand is not `push` — `git -c
 * alias.yolo=push yolo` is otherwise a complete bypass of this guard.
 * Resolution has two sources, and the order between them is the fix for a
 * measured hole:
 *
 *  1. Aliases the invocation DEFINES ITSELF, via `-c alias.x=...` or
 *     `--config-env=alias.x=VAR`. These come first because git resolves them
 *     first, and because they are invisible to any lookup made in a separate
 *     process: `git -c alias.yolo='push --no-verify' yolo` pushes, while a
 *     plain `git config --get alias.yolo` beside it exits 1 with no output.
 *     Asking `resolveAlias` alone therefore returns nothing, `yolo` classifies
 *     as not-a-push, and the argv is handed to git untouched — which then
 *     expands the alias and skips the hook. Measured end to end against git
 *     2.47.3: the push landed on the remote with the hook never running.
 *  2. `resolveAlias`, for aliases that live in config files. Cheap: a local
 *     config read with no network.
 *
 * Definitions accumulate ACROSS hops, because an expansion's own global options
 * define aliases too — `alias.outer = -c alias.inner=push inner` reaches a push
 * in git 2.47.3, so dropping the inner definition would lose the chain.
 *
 * Resolution is bounded rather than recursive: git permits an alias to expand to
 * another alias, and an unbounded loop here would be a denial-of-service on a
 * config the agent controls.
 *
 * An expansion is parsed with the same global-option scan as argv, not by
 * reading its first word. `alias.sneaky = -c core.hooksPath=/tmp/empty push`
 * expands to a push whose first word is `-c`, so a first-word test classifies it
 * as not-a-push and the guard is never injected at all — measured as a working
 * bypass against git 2.47.3.
 */
export function classifyGitInvocation(
  argv: readonly string[],
  resolveAlias?: (name: string) => string | null,
  env: GitEgressEnv = {},
): GitInvocationClassification {
  const globals = scanGlobalOptions(argv, env);

  if (globals.subcommandIndex >= argv.length) {
    return {
      subcommand: null,
      isPush: false,
      hasNoVerify: false,
      subcommandIndex: -1,
      hooksPathOverride: globals.hooksPathOverride,
      aliasBypass: null,
      shellAlias: null,
    };
  }

  const subcommandIndex = globals.subcommandIndex;
  const subcommand = argv[subcommandIndex]!;
  const rest = argv.slice(subcommandIndex + 1);
  const hasNoVerify = rest.some((token) => NO_VERIFY_FLAGS.has(token));

  let isPush = subcommand === "push";
  // Accumulated across hops, then kept only if the chain reaches a push: a
  // bypass on an alias that never publishes anything is not this guard's
  // business, and refusing it would break unrelated tooling.
  let pendingBypass: GitAliasBypass | null = null;
  let shellAlias: GitShellAlias | null = null;

  if (!isPush) {
    const definitions = new Map(globals.aliasDefinitions);
    // Command-line definitions beat config files, as they do in git.
    const lookup = (name: string): string | null =>
      definitions.get(name.toLowerCase()) ?? resolveAlias?.(name) ?? null;

    let name: string | null = subcommand;
    for (let hop = 0; hop < 4 && name && !isPush; hop += 1) {
      const expansion = lookup(name);
      if (!expansion) break;
      // A `!`-prefixed alias is an arbitrary shell command, and it is the one
      // expansion that escapes this guard completely — so it is recorded for
      // refusal rather than passed through.
      //
      // Passing it through used to be justified on the theory that a bare `git`
      // inside the expansion would re-enter the wrapper through PATH. Measured
      // against git 2.47.3, that is false: git PREPENDS its exec-path to PATH
      // for the shell it spawns, and `/usr/lib/git-core` ships a complete `git`
      // binary. So inside a shell alias, a bare `git push` resolves to
      // /usr/lib/git-core/git — the real one — and neither the wrapper nor the
      // hook is reached. No absolute path is needed for the bypass; the alias
      // supplies it. That makes this the dangerous shape: an ordinary-looking
      // `git <name>` that silently is not guarded.
      //
      // Refusal is the only sound response. Deciding whether the expansion
      // publishes would mean parsing arbitrary shell, and a textual test for
      // `push` is defeated by any indirection. Refusing every shell alias is
      // the conservative direction, and it is cheap: no shell alias is defined
      // in any config the agent image ships.
      if (expansion.startsWith("!")) {
        shellAlias = { alias: name, expansion };
        break;
      }

      const tokens = expansion.trim().split(/\s+/).filter((token) => token.length > 0);
      const expansionGlobals = scanGlobalOptions(tokens, env);
      for (const [alias, value] of expansionGlobals.aliasDefinitions) {
        definitions.set(alias, value);
      }
      if (!pendingBypass && expansionGlobals.hooksPathOverride) {
        pendingBypass = { alias: name, expansion, reason: "hooks-path" };
      }

      const expanded: string | null = tokens[expansionGlobals.subcommandIndex] ?? null;
      const expandedRest = tokens.slice(expansionGlobals.subcommandIndex + 1);
      if (!pendingBypass && expandedRest.some((token) => NO_VERIFY_FLAGS.has(token))) {
        pendingBypass = { alias: name, expansion, reason: "no-verify" };
      }

      if (expanded === "push") {
        isPush = true;
        break;
      }
      name = expanded;
    }
  }

  return {
    subcommand,
    isPush,
    hasNoVerify,
    subcommandIndex,
    hooksPathOverride: globals.hooksPathOverride,
    aliasBypass: isPush ? pendingBypass : null,
    shellAlias,
  };
}

export interface PrePushRefUpdate {
  localRef: string;
  localSha: string;
  remoteRef: string;
  remoteSha: string;
}

/** git's all-zero sha, used for "this ref does not exist on the remote yet". */
const NULL_SHA_RE = /^0{40,64}$/;

export function isNullSha(sha: string): boolean {
  return NULL_SHA_RE.test(sha);
}

/**
 * Parse the pre-push hook's stdin: one `<local ref> <local sha> <remote ref>
 * <remote sha>` line per ref being updated.
 *
 * Using git's own computation rather than re-deriving the range from argv is
 * deliberate — refspec resolution, `push.default`, and tracking configuration
 * are git's to interpret, and a second implementation of them would disagree
 * with the push that is actually about to happen.
 */
export function parsePrePushInput(input: string): PrePushRefUpdate[] {
  const updates: PrePushRefUpdate[] = [];
  for (const rawLine of input.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 4) continue;
    updates.push({
      localRef: parts[0]!,
      localSha: parts[1]!,
      remoteRef: parts[2]!,
      remoteSha: parts[3]!,
    });
  }
  return updates;
}

export interface GitPushFinding {
  /** Full sha of the commit carrying the material. */
  commit: string;
  /** Abbreviated sha, for the message. */
  shortCommit: string;
  /** Commit subject, so the author can recognise it without looking it up. */
  subject: string;
  /** Where in the commit the material sits. */
  where: "message" | "content";
  /** Which scrub classes fired. */
  classes: GitHubEgressScrubClass[];
}

/** Reads git. Returns stdout, or null when the command failed. */
export type GitReader = (args: string[]) => string | null;

/**
 * A git read the scanner needed in order to reach a verdict did not succeed.
 *
 * This exists so an unreadable repository cannot be mistaken for a clean one.
 * Every read below decides either WHICH commits the push would publish or WHAT
 * is inside one, so a failure leaves the scanner with no evidence — and "no
 * evidence of credential-shaped material" is not the same statement as "no
 * credential-shaped material". Treating the two as equivalent turns any git
 * error, including a `maxBuffer` overflow on a large diff, into a silent pass
 * at exactly the moment the push is biggest.
 */
export class GitEgressScanError extends Error {
  constructor(
    readonly command: readonly string[],
    readonly commit?: string,
  ) {
    super(
      `\`git ${command.join(" ")}\` failed, so ${
        commit ? `commit ${commit.slice(0, 12)}` : "the set of commits this push would publish"
      } could not be read`,
    );
    this.name = "GitEgressScanError";
  }
}

/** Run a read the verdict depends on, refusing rather than guessing on failure. */
function readGit(runGit: GitReader, args: string[], commit?: string): string {
  const output = runGit(args);
  if (output === null) throw new GitEgressScanError(args, commit);
  return output;
}

/**
 * Commits that a push would publish for one ref update.
 *
 * For an existing remote ref the range is `remoteSha..localSha`. For a ref the
 * remote does not have, `--not --remotes` excludes everything already published
 * under any remote-tracking ref, which is what keeps a new branch off a shared
 * base from re-reporting the entire history of the repository.
 *
 * Throws {@link GitEgressScanError} if `rev-list` fails: without its output the
 * scanner does not know what the push contains, and an empty list would read as
 * "nothing to check" and pass.
 */
export function commitsForRefUpdate(
  update: PrePushRefUpdate,
  runGit: GitReader,
): string[] {
  if (isNullSha(update.localSha)) return []; // a deletion publishes no content
  const args = isNullSha(update.remoteSha)
    ? ["rev-list", update.localSha, "--not", "--remotes"]
    : ["rev-list", `${update.remoteSha}..${update.localSha}`];
  return readGit(runGit, args)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Reduce a unified diff to just the content it ADDS, with the `+` markers
 * removed.
 *
 * This is load-bearing, not tidying. `scrubGitHubEgressText`'s environment-dump
 * detector anchors each assignment to the start of a line
 * (`^[ \t]*[A-Z][A-Z0-9_]{2,}=`), and every added line in a patch arrives
 * prefixed with `+`. Scanning raw `git show` output would therefore be blind to
 * an environment dump — which is the exact class that caused PEN-2526, the
 * exposure this whole control descends from. Stripping the marker restores the
 * anchor.
 *
 * Only added lines are kept. Context and removed lines are, by definition,
 * already on the remote; reporting them would refuse a push for material the
 * author cannot remove by amending anything in this range. `+++` file headers
 * are dropped so a path is not mistaken for content.
 */
export function addedLinesFromPatch(patch: string): string {
  const added: string[] = [];
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++")) continue;
    if (line.startsWith("+")) added.push(line.slice(1));
  }
  return added.join("\n");
}

/**
 * Scan one commit's message and its introduced content.
 *
 * Both legs matter and they fail differently: PEN-2526 was an environment dump
 * interpolated into prose, which here would land in a commit MESSAGE, while the
 * file-content leg is what makes this door a superset of the MCP write tools.
 *
 * Content is scanned as the commit's own patch rather than as full file bodies,
 * so the finding is attributable to the commit that introduced the material and
 * the remedy is a rewrite of that commit. Material already present on the remote
 * is out of scope here by construction: it has already been published, and
 * re-reporting it would make every push refuse with nothing the author can do.
 *
 * Every read throws {@link GitEgressScanError} on failure rather than being
 * skipped. An unreadable message or patch is an unscanned commit, and letting it
 * through would mean the guard reports clean on precisely the commits it could
 * not inspect. Note this is distinct from an EMPTY read: git exits zero with no
 * output for a commit with an empty message or no diff, and that genuinely is
 * nothing to scan.
 */
export function scanCommit(commit: string, runGit: GitReader): GitPushFinding[] {
  const findings: GitPushFinding[] = [];
  const shortCommit = commit.slice(0, 12);
  const subject = readGit(runGit, ["log", "-1", "--format=%s", commit], commit).trim();

  const message = readGit(runGit, ["log", "-1", "--format=%B", commit], commit);
  if (message) {
    const scrubbed = scrubGitHubEgressText(message);
    if (scrubbed.redacted) {
      findings.push({ commit, shortCommit, subject, where: "message", classes: scrubbed.classes });
    }
  }

  // `--format=` suppresses the commit header so the message is not scanned
  // twice and reported as two findings. `--no-color` keeps escape sequences out
  // of the scrubbed text. `-m` makes merge commits emit a patch at all.
  const patch = readGit(
    runGit,
    ["show", "--format=", "--no-color", "-m", "--unified=0", commit],
    commit,
  );
  if (patch) {
    const scrubbed = scrubGitHubEgressText(addedLinesFromPatch(patch));
    if (scrubbed.redacted) {
      findings.push({ commit, shortCommit, subject, where: "content", classes: scrubbed.classes });
    }
  }

  return findings;
}

export function scanPrePushUpdates(
  updates: readonly PrePushRefUpdate[],
  runGit: GitReader,
): GitPushFinding[] {
  const findings: GitPushFinding[] = [];
  const seen = new Set<string>();
  for (const update of updates) {
    for (const commit of commitsForRefUpdate(update, runGit)) {
      // A commit reachable from two pushed refs is one problem, not two.
      if (seen.has(commit)) continue;
      seen.add(commit);
      findings.push(...scanCommit(commit, runGit));
    }
  }
  return findings;
}

/**
 * The refusal text.
 *
 * It names the commit and the class because a bare rejection is not actionable:
 * the author cannot amend what they cannot locate. The oldest offending commit
 * is called out separately because that is the one an interactive rebase has to
 * reach, and it is the single most common thing to get wrong when the material
 * is several commits back.
 */
export function formatRefusal(findings: readonly GitPushFinding[]): string {
  const lines: string[] = [
    "paperclip-github-egress: refusing to publish — credential-shaped material found in commits this push would make public.",
    "",
    "Commit objects are content-addressed, so this cannot be redacted in flight the way an issue comment or a pull-request body is; the commit itself has to change.",
    "",
  ];

  for (const finding of findings) {
    const where = finding.where === "message" ? "commit message" : "file content";
    lines.push(
      `  ${finding.shortCommit}  ${where}: ${finding.classes.join(", ")}${finding.subject ? `  (${finding.subject})` : ""}`,
    );
  }

  const oldest = findings.length > 0 ? findings[findings.length - 1]! : null;
  lines.push("");
  if (oldest && findings.length === 1) {
    lines.push("To fix: remove the material, then `git commit --amend` if it is the tip commit,");
    lines.push(`or \`git rebase -i ${oldest.shortCommit}~1\` to reach it if it is not.`);
  } else if (oldest) {
    lines.push(
      `To fix: remove the material from each commit above. The oldest is ${oldest.shortCommit}, so \`git rebase -i ${oldest.shortCommit}~1\` reaches all of them.`,
    );
  }
  lines.push("");
  lines.push(
    "If this is a false positive on a test fixture, derive the value at runtime instead of embedding a literal — that is what the existing fixtures in this repository do, and it closes the finding permanently rather than suppressing it.",
  );

  return lines.join("\n");
}

/**
 * The refusal text for a scan that could not be completed.
 *
 * Deliberately distinct from {@link formatRefusal}: nothing was found, so
 * telling the author to amend a commit would send them looking for material
 * that may not exist. What they need to know is that this is a refusal rather
 * than a detection, and what to do about the read that failed.
 */
export function formatScanFailure(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return [
    "paperclip-github-egress: refusing to publish — the credential scan could not be completed.",
    "",
    `  ${detail}`,
    "",
    "This is a refusal, not a detection: nothing was found because nothing could be read.",
    "A scan that cannot inspect the commits it is meant to check cannot report them clean,",
    "so the push is stopped rather than allowed through unscanned.",
    "",
    "If git cannot read the repository, fix that and re-run. If the push is very large, the",
    "read may have exceeded the scanner's buffer — push in smaller batches.",
  ].join("\n");
}
