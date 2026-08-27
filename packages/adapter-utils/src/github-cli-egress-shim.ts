// PEN-2527: the egress choke point for agent-authored text bound for GitHub.
//
// Where the choke point is, and why it is here.
//
// Agent-authored review bodies, PR bodies and comments never touch server/
// TypeScript. Agents shell out to `gh`, which the runtime replaces with a
// wrapper (deploy/helm/paperclip/templates/statefulset.yaml) that execs this
// runtime before the image's `/usr/bin/gh` token wrapper. That generated
// launcher is the single interposition point in front of the GitHub CLI in the
// sandbox, so it is where a scrub has to live. There is no HTTP layer of ours
// to hook: the calls leave the pod from `gh` itself.
//
// This module holds the pure part — argv in, argv out — so the shell shim
// stays a few lines and every rule below is unit-testable without a sandbox.

import {
  type GitHubEgressScrubClass,
  scrubGitHubEgressText,
} from "./github-egress-scrub.js";

/** Flags whose value is agent-authored text carried inline in argv. */
const INLINE_TEXT_FLAGS = new Set([
  "--body",
  "-b",
  "--title",
  "-t",
  "--message",
  "-m",
  "--notes",
  "--subject",
]);

/** Flags whose value is a path to a file holding agent-authored text. This is
 *  the form that carried the PEN-2526 review body: `gh pr review --body-file`. */
const FILE_TEXT_FLAGS = new Set(["--body-file", "--notes-file"]);

export interface GitHubCliScrubIo {
  /** Read a body file. Throw if unreadable — the caller decides the policy. */
  readText(path: string): string;
  /** Persist scrubbed content somewhere `gh` can read it; return the new path. */
  writeTempText(contents: string): string;
}

export interface GitHubCliScrubResult {
  argv: string[];
  redacted: boolean;
  classes: GitHubEgressScrubClass[];
}

/**
 * Return true when a GitHub CLI text-file flag asks `gh` to read from stdin.
 *
 * The runtime wrapper rejects this form before starting `gh`: stdin is an
 * agent-authored egress channel too, but a child process cannot be safely
 * scrubbed after it has already consumed the stream. Keeping this predicate
 * next to the argv rewrite prevents the shell wrapper and the pure transform
 * from drifting on which flags carry authored text.
 */
export function hasGitHubCliStdinTextFile(argv: readonly string[]): boolean {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    const fused = /^(--[a-z-]+)=([\s\S]*)$/.exec(arg);
    if (fused) {
      const [, flag, value] = fused as unknown as [string, string, string];
      if (FILE_TEXT_FLAGS.has(flag) && value === "-") return true;
      continue;
    }
    if (FILE_TEXT_FLAGS.has(arg) && argv[i + 1] === "-") return true;
  }
  return false;
}

/**
 * Rewrite a `gh` argv so every agent-authored text value has been scrubbed.
 *
 * Returns the original argv array contents unchanged when nothing matched, so
 * an invocation carrying no credential-shaped material is passed through
 * byte-for-byte.
 */
export function scrubGitHubCliInvocation(
  argv: readonly string[],
  io: GitHubCliScrubIo,
): GitHubCliScrubResult {
  const out = [...argv];
  const fired = new Set<GitHubEgressScrubClass>();

  const record = (classes: readonly GitHubEgressScrubClass[]) => {
    for (const cls of classes) fired.add(cls);
  };

  for (let i = 0; i < out.length; i += 1) {
    const arg = out[i] as string;

    // `--body=<text>` — value fused to the flag.
    const fused = /^(--[a-z-]+)=([\s\S]*)$/.exec(arg);
    if (fused) {
      const [, flag, value] = fused as unknown as [string, string, string];
      if (INLINE_TEXT_FLAGS.has(flag)) {
        const scrubbed = scrubGitHubEgressText(value);
        if (scrubbed.redacted) {
          out[i] = `${flag}=${scrubbed.text}`;
          record(scrubbed.classes);
        }
        continue;
      }
      if (FILE_TEXT_FLAGS.has(flag)) {
        const rewritten = scrubBodyFile(value, io, record);
        if (rewritten !== null) out[i] = `${flag}=${rewritten}`;
        continue;
      }
      continue;
    }

    const next = out[i + 1];
    if (next === undefined) continue;

    if (INLINE_TEXT_FLAGS.has(arg)) {
      const scrubbed = scrubGitHubEgressText(next);
      if (scrubbed.redacted) {
        out[i + 1] = scrubbed.text;
        record(scrubbed.classes);
      }
      i += 1;
      continue;
    }

    if (FILE_TEXT_FLAGS.has(arg)) {
      const rewritten = scrubBodyFile(next, io, record);
      if (rewritten !== null) out[i + 1] = rewritten;
      i += 1;
    }
  }

  const order: GitHubEgressScrubClass[] = [
    "private-key-block",
    "credentialed-uri",
    "jwt",
    "vendor-key",
    "environment-dump",
    "high-entropy-assignment",
  ];

  return {
    argv: out,
    redacted: fired.size > 0,
    classes: order.filter((cls) => fired.has(cls)),
  };
}

/**
 * Scrub a body file, returning a replacement path, or null to leave argv alone.
 *
 * `-` means "read stdin"; the runtime rejects that form before `gh` starts, so
 * it is not a path and must not be opened here.
 */
function scrubBodyFile(
  path: string,
  io: GitHubCliScrubIo,
  record: (classes: readonly GitHubEgressScrubClass[]) => void,
): string | null {
  if (path === "-") return null;

  const contents = io.readText(path);
  const scrubbed = scrubGitHubEgressText(contents);
  if (!scrubbed.redacted) return null;

  record(scrubbed.classes);
  return io.writeTempText(scrubbed.text);
}
