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

/** Spellings of the flag that skips the pre-push hook. */
const NO_VERIFY_FLAGS: ReadonlySet<string> = new Set(["--no-verify", "-n"]);

export interface GitInvocationClassification {
  /** The resolved subcommand, or null when argv carries only global options. */
  subcommand: string | null;
  /** True when this invocation would contact a remote to publish refs. */
  isPush: boolean;
  /** True when the invocation asks git to skip hooks. */
  hasNoVerify: boolean;
  /** Index in argv at which the subcommand was found, or -1. */
  subcommandIndex: number;
}

/**
 * Split argv into git's global options and its subcommand.
 *
 * `resolveAlias` is consulted when the subcommand is not `push` — `git -c
 * alias.yolo=push yolo` is otherwise a complete bypass of this guard, and an
 * alias is cheap to resolve because it is a local config read with no network.
 * Resolution is bounded rather than recursive: git permits an alias to expand to
 * another alias, and an unbounded loop here would be a denial-of-service on a
 * config the agent controls.
 */
export function classifyGitInvocation(
  argv: readonly string[],
  resolveAlias?: (name: string) => string | null,
): GitInvocationClassification {
  let index = 0;
  while (index < argv.length) {
    const token = argv[index]!;
    if (!token.startsWith("-")) break;
    // `--opt=value` carries its own value; `--opt value` and `-c x=y` do not.
    if (VALUE_TAKING_GLOBAL_OPTIONS.has(token)) {
      index += 2;
      continue;
    }
    index += 1;
  }

  if (index >= argv.length) {
    return { subcommand: null, isPush: false, hasNoVerify: false, subcommandIndex: -1 };
  }

  const subcommandIndex = index;
  const subcommand = argv[subcommandIndex]!;
  const rest = argv.slice(subcommandIndex + 1);
  const hasNoVerify = rest.some((token) => NO_VERIFY_FLAGS.has(token));

  let isPush = subcommand === "push";
  if (!isPush && resolveAlias) {
    let name: string | null = subcommand;
    for (let hop = 0; hop < 4 && name && !isPush; hop += 1) {
      const expansion = resolveAlias(name);
      if (!expansion) break;
      // A `!`-prefixed alias is an arbitrary shell command. We cannot parse it,
      // and refusing every one of them would break unrelated tooling, so it is
      // reported as not-a-push and the residual gap is documented on the door.
      if (expansion.startsWith("!")) break;
      const first = expansion.trim().split(/\s+/)[0] ?? "";
      if (first === "push") {
        isPush = true;
        break;
      }
      name = first || null;
    }
  }

  return { subcommand, isPush, hasNoVerify, subcommandIndex };
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
 * Commits that a push would publish for one ref update.
 *
 * For an existing remote ref the range is `remoteSha..localSha`. For a ref the
 * remote does not have, `--not --remotes` excludes everything already published
 * under any remote-tracking ref, which is what keeps a new branch off a shared
 * base from re-reporting the entire history of the repository.
 */
export function commitsForRefUpdate(
  update: PrePushRefUpdate,
  runGit: GitReader,
): string[] {
  if (isNullSha(update.localSha)) return []; // a deletion publishes no content
  const args = isNullSha(update.remoteSha)
    ? ["rev-list", update.localSha, "--not", "--remotes"]
    : ["rev-list", `${update.remoteSha}..${update.localSha}`];
  const output = runGit(args);
  if (output === null) return [];
  return output
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
 */
export function scanCommit(commit: string, runGit: GitReader): GitPushFinding[] {
  const findings: GitPushFinding[] = [];
  const shortCommit = commit.slice(0, 12);
  const subject = (runGit(["log", "-1", "--format=%s", commit]) ?? "").trim();

  const message = runGit(["log", "-1", "--format=%B", commit]);
  if (message) {
    const scrubbed = scrubGitHubEgressText(message);
    if (scrubbed.redacted) {
      findings.push({ commit, shortCommit, subject, where: "message", classes: scrubbed.classes });
    }
  }

  // `--format=` suppresses the commit header so the message is not scanned
  // twice and reported as two findings. `--no-color` keeps escape sequences out
  // of the scrubbed text. `-m` makes merge commits emit a patch at all.
  const patch = runGit(["show", "--format=", "--no-color", "-m", "--unified=0", commit]);
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
