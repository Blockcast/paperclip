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
 *  the form that carried the PEN-2526 review body: `gh pr review --body-file`.
 *  `gh api --input` is the generic request-body equivalent. */
const FILE_TEXT_FLAGS = new Set(["--body-file", "--notes-file", "--input"]);

/** `gh api` fields are request payload values. Scrub every field, rather than
 *  only the conventional `body` key: nested issue/PR/comment payloads and
 *  tenant-specific text fields can all reach a public GitHub endpoint. */
const FIELD_FLAGS = new Set(["--raw-field", "-f", "--field", "-F"]);
const TYPED_FIELD_FLAGS = new Set(["--field", "-F"]);

export interface GitHubCliScrubIo {
  /** Read a request-text file. Throw if unreadable — the caller decides the policy. */
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
 * Return true when a GitHub CLI text/request flag asks `gh` to read from
 * stdin. This covers `gh api --input -` and typed `gh api --field key=@-` in
 * addition to the review/PR `--body-file -` form.
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
    const fused = splitLongOption(arg);
    if (fused) {
      const { flag, value } = fused;
      if (FILE_TEXT_FLAGS.has(flag) && value === "-") return true;
      if (FIELD_FLAGS.has(flag) && typedFieldUsesStdin(flag, value)) return true;
      continue;
    }

    const shortFused = splitShortFieldOption(arg);
    if (shortFused && typedFieldUsesStdin(shortFused.flag, shortFused.value)) return true;

    const next = argv[i + 1];
    if (FILE_TEXT_FLAGS.has(arg) && next === "-") return true;
    if (FIELD_FLAGS.has(arg) && next !== undefined && typedFieldUsesStdin(arg, next)) return true;
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

    // Long options such as `--body=<text>`, `--input=<path>`, and
    // `--raw-field=body=<text>` carry their value in the same argv element.
    const fused = splitLongOption(arg);
    if (fused) {
      const { flag, value } = fused;
      if (INLINE_TEXT_FLAGS.has(flag)) {
        const scrubbed = scrubGitHubEgressText(value);
        if (scrubbed.redacted) {
          out[i] = `${flag}=${scrubbed.text}`;
          record(scrubbed.classes);
        }
        continue;
      }
      if (FILE_TEXT_FLAGS.has(flag)) {
        const rewritten = scrubTextFile(value, io, record);
        if (rewritten !== null) out[i] = `${flag}=${rewritten}`;
        continue;
      }
      if (FIELD_FLAGS.has(flag)) {
        const rewritten = scrubField(value, TYPED_FIELD_FLAGS.has(flag), io, record);
        if (rewritten !== value) out[i] = `${flag}=${rewritten}`;
        continue;
      }
      continue;
    }

    // The short `-fbody=...` / `-Fbody=...` spellings are accepted by gh too.
    // Preserve whether the original used `-f=...` or `-f...` when clean.
    const shortFused = splitShortFieldOption(arg);
    if (shortFused) {
      const rewritten = scrubField(shortFused.value, shortFused.typed, io, record);
      if (rewritten !== shortFused.value) {
        out[i] = `${shortFused.flag}${shortFused.separator}${rewritten}`;
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
      const rewritten = scrubTextFile(next, io, record);
      if (rewritten !== null) out[i + 1] = rewritten;
      i += 1;
      continue;
    }

    if (FIELD_FLAGS.has(arg)) {
      const rewritten = scrubField(next, TYPED_FIELD_FLAGS.has(arg), io, record);
      out[i + 1] = rewritten;
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
 * Scrub a text file, returning a replacement path, or null to leave argv alone.
 *
 * `-` means "read stdin"; the runtime rejects that form before `gh` starts.
 * This helper is only called after that check, so it is not a path and must
 * not be opened here.
 */
function scrubTextFile(
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

function splitLongOption(arg: string): { flag: string; value: string } | null {
  const match = /^(--[a-z-]+)=([\s\S]*)$/.exec(arg);
  if (!match) return null;
  return { flag: match[1] as string, value: match[2] as string };
}

function splitShortFieldOption(arg: string): {
  flag: "-f" | "-F";
  value: string;
  separator: "" | "=";
  typed: boolean;
} | null {
  if ((arg.startsWith("-f") || arg.startsWith("-F")) && arg.length > 2) {
    const flag = arg.slice(0, 2) as "-f" | "-F";
    const separator = arg[2] === "=" ? "=" : "";
    const value = arg.slice(separator === "=" ? 3 : 2);
    return { flag, value, separator, typed: flag === "-F" };
  }
  return null;
}

function typedFieldUsesStdin(flag: string, expression: string): boolean {
  if (!TYPED_FIELD_FLAGS.has(flag)) return false;
  const equals = expression.indexOf("=");
  return equals >= 0 && expression.slice(equals + 1) === "@-";
}

/** Scrub a `key=value` field expression. Typed fields additionally support
 *  `key=@file`; rewrite a credential-bearing file to a private temp copy so
 *  gh cannot read the original unsanitized contents. */
function scrubField(
  expression: string,
  typed: boolean,
  io: GitHubCliScrubIo,
  record: (classes: readonly GitHubEgressScrubClass[]) => void,
): string {
  const equals = expression.indexOf("=");
  if (equals < 0) return expression;

  const key = expression.slice(0, equals);
  const value = expression.slice(equals + 1);
  if (typed && value.startsWith("@") && value.length > 1) {
    const rewritten = scrubTextFile(value.slice(1), io, record);
    if (rewritten !== null) return `${key}=@${rewritten}`;
    return expression;
  }

  const scrubbed = scrubGitHubEgressText(value);
  if (!scrubbed.redacted) return expression;
  record(scrubbed.classes);
  return `${key}=${scrubbed.text}`;
}
