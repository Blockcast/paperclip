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

/** BLO-33171: request fields that carry REPOSITORY FILE BYTES rather than
 *  authored prose. `content` is GitHub's field name for file bytes on every
 *  endpoint that writes them — `POST /git/blobs`, `PUT /repos/{o}/{r}/contents/{path}`,
 *  the `tree[].content` entries of `POST /git/trees`, and gist files.
 *
 *  These are never scrubbed IN PLACE. A scrub rewrites the bytes that get
 *  committed, so a credential-shaped string literal in source — say the input
 *  fixture of a redaction regression test — is silently replaced and the commit
 *  still looks deliberate on review. That is how #1542 landed with 9 `sk-`
 *  literals eaten and the diff reading as an intentional test weakening.
 *
 *  Exempting them from the scrubber is NOT the fix: a blob in a public repo is
 *  exactly as public as a PR comment, so an exemption is a credential
 *  exfiltration bypass on the highest-bandwidth path. Corruption is loud on
 *  review; a leak is silent forever. So: pass through byte-exact when nothing
 *  fires, and REFUSE the call when something does.
 *
 *  Keying on the field NAME does not violate this module's "structural, never
 *  name-based" doctrine (github-egress-scrub.ts:9). That doctrine forbids
 *  inferring whether a VALUE IS SECRET from its name. Identifying the ROLE of a
 *  request field is a different question, answered by a fixed GitHub API
 *  schema rather than by model-authored prose.
 *
 *  Deliberately endpoint-AGNOSTIC: the rule keys on the field, not on the URL.
 *  An endpoint allowlist would have to enumerate every GitHub API that writes
 *  bytes, and the cost of the two mistakes is asymmetric — an endpoint missing
 *  from the list silently corrupts (the #1542 failure), whereas an unrelated
 *  API that happens to use `content` for prose gets a loud refusal the operator
 *  can see and route around. Fail toward the visible error. */
const CONTENT_FIELD_KEYS = new Set(["content"]);

/** Report order for scrub classes: severity-ish, stable across calls. */
const CLASS_ORDER: readonly GitHubEgressScrubClass[] = [
  "private-key-block",
  "credentialed-uri",
  "jwt",
  "vendor-key",
  "environment-dump",
  "high-entropy-assignment",
];

const orderedClasses = (fired: ReadonlySet<GitHubEgressScrubClass>): GitHubEgressScrubClass[] =>
  CLASS_ORDER.filter((cls) => fired.has(cls));

export interface GitHubCliScrubIo {
  /** Read a request-text file. Throw if unreadable — the caller decides the policy. */
  readText(path: string): string;
  /** Persist scrubbed content somewhere `gh` can read it; return the new path. */
  writeTempText(contents: string): string;
}

/** A content-bearing field that tripped a detector. The caller refuses the
 *  invocation; this carries what the operator needs to fix it. */
export interface GitHubCliContentRefusal {
  /** The request field, or the `--input` flag whose body carried one. */
  field: string;
  /** Path, when the bytes came from a file rather than inline argv. */
  path: string | null;
  classes: GitHubEgressScrubClass[];
}

export interface GitHubCliScrubResult {
  argv: string[];
  redacted: boolean;
  classes: GitHubEgressScrubClass[];
  /** Non-empty when the invocation must be refused rather than run. */
  refusals: GitHubCliContentRefusal[];
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
  const refusals: GitHubCliContentRefusal[] = [];

  const record = (classes: readonly GitHubEgressScrubClass[]) => {
    for (const cls of classes) fired.add(cls);
  };
  const refuse = (refusal: GitHubCliContentRefusal) => {
    refusals.push(refusal);
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
        const rewritten = scrubTextFile(value, flag, io, record, refuse);
        if (rewritten !== null) out[i] = `${flag}=${rewritten}`;
        continue;
      }
      if (FIELD_FLAGS.has(flag)) {
        const rewritten = scrubField(value, TYPED_FIELD_FLAGS.has(flag), io, record, refuse);
        if (rewritten !== value) out[i] = `${flag}=${rewritten}`;
        continue;
      }
      continue;
    }

    // The short `-fbody=...` / `-Fbody=...` spellings are accepted by gh too.
    // Preserve whether the original used `-f=...` or `-f...` when clean.
    const shortFused = splitShortFieldOption(arg);
    if (shortFused) {
      const rewritten = scrubField(shortFused.value, shortFused.typed, io, record, refuse);
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
      const rewritten = scrubTextFile(next, arg, io, record, refuse);
      if (rewritten !== null) out[i + 1] = rewritten;
      i += 1;
      continue;
    }

    if (FIELD_FLAGS.has(arg)) {
      const rewritten = scrubField(next, TYPED_FIELD_FLAGS.has(arg), io, record, refuse);
      out[i + 1] = rewritten;
      i += 1;
    }
  }

  return {
    argv: out,
    redacted: fired.size > 0,
    classes: orderedClasses(fired),
    refusals,
  };
}

/**
 * Scrub a text file, returning a replacement path, or null to leave argv alone.
 *
 * `-` means "read stdin"; the runtime rejects that form before `gh` starts.
 * This helper is only called after that check, so it is not a path and must
 * not be opened here.
 *
 * `gh api --input` is a whole request body rather than a prose document, so a
 * body that carries file bytes under a `content` key is handled per-value:
 * see splitRequestBody.
 */
function scrubTextFile(
  path: string,
  field: string,
  io: GitHubCliScrubIo,
  record: (classes: readonly GitHubEgressScrubClass[]) => void,
  refuse: (refusal: GitHubCliContentRefusal) => void,
): string | null {
  if (path === "-") return null;

  const contents = io.readText(path);

  if (field === "--input") {
    const split = splitRequestBody(contents);
    if (split) {
      if (split.contentClasses.length > 0) {
        refuse({ field, path, classes: split.contentClasses });
        return null;
      }
      if (split.proseClasses.length === 0) return null;
      record(split.proseClasses);
      return io.writeTempText(split.body);
    }
  }

  const scrubbed = scrubGitHubEgressText(contents);
  if (!scrubbed.redacted) return null;

  record(scrubbed.classes);
  return io.writeTempText(scrubbed.text);
}

/**
 * Split a `gh api --input` request body into content-role and prose values.
 *
 * Returns null when the body is not JSON carrying repository bytes; the caller
 * then treats the whole document as prose, which is the pre-BLO-33171 path.
 *
 * Every detector match is attributed to the VALUE it fired in. Refusing on
 * any-hit-anywhere would block the documented `contents/{path}` write path
 * whenever a credential-shaped string sits in the `message` beside clean
 * bytes — and that prose is exactly what the scrubber should be rewriting.
 * So content values are checked but never rewritten, and prose values beside
 * them are scrubbed as usual.
 *
 * Matching runs on the DECODED string rather than the raw JSON text, so an
 * escaped `sk-…` literal is still caught and no match can straddle a
 * string boundary into an adjacent field.
 */
function splitRequestBody(body: string): {
  body: string;
  contentClasses: GitHubEgressScrubClass[];
  proseClasses: GitHubEgressScrubClass[];
} | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }

  let sawContent = false;
  const contentFired = new Set<GitHubEgressScrubClass>();
  const proseFired = new Set<GitHubEgressScrubClass>();

  const walk = (node: unknown): unknown => {
    // A string reaching walk() came from an ARRAY element (object properties
    // are handled by key in the loop below, which is the only place a
    // content-role key can be recognised). An array element has no key, so it
    // is prose by construction and is always scrubbed.
    if (typeof node === "string") {
      const scrubbed = scrubGitHubEgressText(node);
      for (const cls of scrubbed.classes) proseFired.add(cls);
      return scrubbed.text;
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node === null || typeof node !== "object") return node;

    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      if (typeof value !== "string") {
        out[key] = walk(value);
        continue;
      }
      const scrubbed = scrubGitHubEgressText(value);
      if (CONTENT_FIELD_KEYS.has(key)) {
        sawContent = true;
        for (const cls of scrubbed.classes) contentFired.add(cls);
        out[key] = value; // byte-exact, always — refuse instead of rewriting
        continue;
      }
      for (const cls of scrubbed.classes) proseFired.add(cls);
      out[key] = scrubbed.text;
    }
    return out;
  };

  const rewritten = walk(parsed);
  if (!sawContent) return null;

  return {
    body: JSON.stringify(rewritten),
    contentClasses: orderedClasses(contentFired),
    proseClasses: orderedClasses(proseFired),
  };
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
 *  gh cannot read the original unsanitized contents.
 *
 *  A repository-content key is never rewritten: it passes through byte-exact,
 *  or the invocation is refused. See CONTENT_FIELD_KEYS. */
function scrubField(
  expression: string,
  typed: boolean,
  io: GitHubCliScrubIo,
  record: (classes: readonly GitHubEgressScrubClass[]) => void,
  refuse: (refusal: GitHubCliContentRefusal) => void,
): string {
  const equals = expression.indexOf("=");
  if (equals < 0) return expression;

  const key = expression.slice(0, equals);
  const value = expression.slice(equals + 1);
  const isContent = CONTENT_FIELD_KEYS.has(key);

  if (typed && value.startsWith("@") && value.length > 1) {
    const filePath = value.slice(1);
    if (isContent) {
      // The whole file IS the committed bytes.
      const scrubbed = scrubGitHubEgressText(io.readText(filePath));
      if (scrubbed.redacted) refuse({ field: key, path: filePath, classes: scrubbed.classes });
      return expression;
    }
    const rewritten = scrubTextFile(filePath, key, io, record, refuse);
    if (rewritten !== null) return `${key}=@${rewritten}`;
    return expression;
  }

  const scrubbed = scrubGitHubEgressText(value);
  if (!scrubbed.redacted) return expression;
  if (isContent) {
    refuse({ field: key, path: null, classes: scrubbed.classes });
    return expression;
  }
  record(scrubbed.classes);
  return `${key}=${scrubbed.text}`;
}
