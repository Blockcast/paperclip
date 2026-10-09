// PEN-2527: structural scrub for agent-authored text on its way OUT to GitHub.
//
// Direction matters. packages/mcp-gateway/src/response-scrub.ts sanitises tool
// responses on the way IN (tool -> agent). This is the opposite leg
// (agent -> public internet) and shares no code with it deliberately: the
// inbound scrubber parses known upstream payload shapes, whereas everything
// here has to survive arbitrary prose written by a model.
//
// Detection is STRUCTURAL, never name-based. A scrubber tuned to variable
// names redacts the word "GITHUB_APP_PRIVATE_KEY" out of an incident runbook
// while happily passing the key itself when it appears under a name nobody
// enumerated. The platform's own approval-payload scanner does exactly that,
// and it is why the PEN-2526 rotation checklist rendered unreadable. So we key
// on the shape of the material: a PEM envelope, a credential in a URI, a JWT
// that actually decodes, a vendor key prefix, a run of environment
// assignments, or a high-entropy value bound to a name.
//
// Fail closed. Anything matching a material shape is redacted even when we
// cannot say which secret it is; a false positive costs a reviewer one glance
// at a marker, a false negative costs a fleet rotation.

/** Classes of material this module removes. The marker names the class so a
 *  reviewer can tell a scrub from a truncation. */
export type GitHubEgressScrubClass =
  | "private-key-block"
  | "credentialed-uri"
  | "jwt"
  | "vendor-key"
  | "environment-dump"
  | "high-entropy-assignment";

export interface GitHubEgressScrubResult {
  /** Scrubbed text. Byte-identical to the input when nothing matched. */
  text: string;
  /** True when any detector fired. */
  redacted: boolean;
  /** Which classes fired, deduped, in a stable order. */
  classes: GitHubEgressScrubClass[];
}

export function redactionMarker(cls: GitHubEgressScrubClass): string {
  return `[paperclip-egress-scrub redacted: ${cls}]`;
}

/** Matches an already-emitted marker, so a later detector that subsumes an
 *  earlier one can carry its marker through instead of erasing it. */
const NESTED_MARKER_RE = /\[paperclip-egress-scrub redacted: [a-z-]+\]/g;


/** A run of this many consecutive NAME=VALUE lines reads as an environment
 *  dump regardless of which variables it holds. Five is low enough to catch
 *  the interpolation that caused PEN-2526 and high enough that a changelog
 *  listing a couple of config defaults passes through untouched. */
export const ENVIRONMENT_DUMP_MIN_RUN = 5;

/** Minimum length before an assignment's value is entropy-tested. Short values
 *  are ordinary config (`LOG_LEVEL=debug`); long random ones are not. */
const HIGH_ENTROPY_MIN_LENGTH = 24;

/** Bits per character. Random base64url sits near 5.5-6.0, hex near 4.0,
 *  English prose and dotted paths well below 3.5. */
const HIGH_ENTROPY_MIN_BITS_PER_CHAR = 3.5;

// -- detectors ---------------------------------------------------------------

// Whole PEM envelope. `[\s\S]*?` because the body is newline-separated base64.
const PEM_BLOCK_RE =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;

// An envelope whose END never arrives — a dump truncated by a length cap, or a
// key pasted into prose that ran out. Fail closed: take the rest of the text.
const PEM_BLOCK_UNTERMINATED_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*$/;

// scheme://user:pass@host. Requires a colon-separated credential pair before
// the @, so `git@github.com` (SSH, no secret) and a bare `https://host/path`
// are both left alone.
const CREDENTIALED_URI_RE =
  /\b[a-z][a-z0-9+.\-]*:\/\/[^\s/@:]+:[^\s/@]*@[^\s<>"')\]]+/gi;

// Three base64url segments. Candidate only — confirmed by decoding the header.
const JWT_CANDIDATE_RE = /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;

// Vendor prefixes are load-bearing on their own: the prefix plus a long opaque
// tail is a token by construction, whatever it is called.
const VENDOR_KEY_RE = new RegExp(
  [
    String.raw`\bgh[pousr]_[A-Za-z0-9_]{20,}\b`, // GitHub PAT / OAuth / server / refresh
    String.raw`\bgithub_pat_[A-Za-z0-9_]{20,}\b`, // GitHub fine-grained PAT
    String.raw`\bpsk_[A-Za-z0-9_-]{16,}\b`, // Paperclip service key
    String.raw`\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}\b`, // OpenAI / Anthropic
    String.raw`\bxox[baprs]-[A-Za-z0-9-]{10,}\b`, // Slack
    String.raw`\bglpat-[A-Za-z0-9_-]{16,}\b`, // GitLab
    String.raw`\bAKIA[0-9A-Z]{16}\b`, // AWS access key id
    String.raw`\bAIza[0-9A-Za-z_-]{30,}\b`, // Google API key
    String.raw`\bdop_v1_[a-f0-9]{32,}\b`, // DigitalOcean
    String.raw`\bnpm_[A-Za-z0-9]{30,}\b`, // npm
  ].join("|"),
  "g",
);

// A single environment assignment line, anchored to line start under /m.
const ENV_ASSIGNMENT_LINE = String.raw`^[ \t]*[A-Z][A-Z0-9_]{2,}=[^\r\n]*$`;

const ENVIRONMENT_DUMP_RE = new RegExp(
  `(?:${ENV_ASSIGNMENT_LINE}\\r?\\n){${ENVIRONMENT_DUMP_MIN_RUN - 1},}${ENV_ASSIGNMENT_LINE}`,
  "gm",
);

// NAME=VALUE where the value is long and opaque. This is the fail-closed net
// under the count threshold: one interpolated secret is not a "dump" but is
// still a secret. Structural — it tests the value, not the name.
const ASSIGNMENT_RE = /\b([A-Za-z_][A-Za-z0-9_]{2,})=(["']?)([^\s"'`\r\n]{16,})\2/g;

function shannonEntropyBitsPerChar(value: string): number {
  if (value.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/** A segment is "lexical" when it is a plain word or a plain number — the
 *  shape hyphenated identifiers are built from, and the shape a random token's
 *  segments essentially never take, because a token mixes letters with digits
 *  inside each run. */
const LEXICAL_SEGMENT_RE = /^(?:[A-Za-z]+|[0-9]+)$/;

/** Longest segment an identifier may carry and still be exonerated. Above
 *  this a single segment is long enough to be a credential on its own: 16
 *  random lowercase letters is ~75 bits. Chosen with room over the longest
 *  segment real identifiers use — `multicast` and `transport` are 9,
 *  `authentication` is 14. */
const LEXICAL_SEGMENT_MAX_LENGTH = 16;

/**
 * BLO-41262: a separator-delimited run of short words is an identifier, not a
 * credential, and per-character entropy cannot tell the two apart.
 * `draft-ramadan-moq-multicast-00` scores 3.74 bits/char — above the floor —
 * so an RFC-XML `<seriesInfo … value='draft-…'/>` element read as
 * credential-shaped, and every `.md` IETF draft in Blockcast/moqcast-draft
 * became unwritable through `gh api .../git/blobs` while git push was down.
 *
 * The discriminator is structure, not vocabulary (no word list to drift): a
 * credential is ONE opaque run, so a value is exonerated only when every
 * separator-delimited segment is itself a plain word or number AND none is
 * long enough to be a token on its own. Both conjuncts carry weight —
 * `release-Candidate-<20 letters>` has lexical segments and is still refused
 * on the length of its tail.
 *
 * Measured against 20k random values per shape: 0/20000 base64url-43,
 * 0/20000 alnum-40 and 0/20000 hex-40 are exonerated by this rule. A UUID
 * stays opaque, because `386c81e8` is neither a word nor a number.
 */
function isLexicalIdentifier(value: string): boolean {
  const segments = value.split(/[-._]/);
  if (segments.length < 2) return false;
  return segments.every(
    (segment) =>
      segment.length <= LEXICAL_SEGMENT_MAX_LENGTH && LEXICAL_SEGMENT_RE.test(segment),
  );
}

/** A value is "opaque" when it is long, drawn from a token alphabet, is not a
 *  hyphenated identifier, and has high per-character entropy. Deliberately
 *  narrow: applied only to assignment values, never to bare words. A 40-char
 *  git SHA scores ~4.0 bits/char and would be redacted out of ordinary review
 *  prose if this ran unbound. */
function isOpaqueSecretValue(value: string): boolean {
  if (value.length < HIGH_ENTROPY_MIN_LENGTH) return false;
  if (!/^[A-Za-z0-9+/=_.\-]+$/.test(value)) return false;
  // Needs mixed classes; `----------------------------` and `aaaa...` are not secrets.
  const classes = [/[a-z]/, /[A-Z0-9]/].filter((re) => re.test(value)).length;
  if (classes < 2) return false;
  if (isLexicalIdentifier(value)) return false;
  return shannonEntropyBitsPerChar(value) >= HIGH_ENTROPY_MIN_BITS_PER_CHAR;
}

function decodeBase64Url(segment: string): string | null {
  try {
    const padded = segment.replace(/-/g, "+").replace(/_/g, "/");
    return Buffer.from(padded, "base64").toString("utf8");
  } catch {
    return null;
  }
}

/** True when the first segment decodes to a JSON object carrying `alg`. This
 *  is what separates a JWT from a dotted version string or a filename. */
function isJwt(candidate: string): boolean {
  const header = candidate.split(".")[0];
  const decoded = decodeBase64Url(header);
  if (!decoded) return false;
  try {
    const parsed = JSON.parse(decoded) as unknown;
    return typeof parsed === "object" && parsed !== null && "alg" in parsed;
  } catch {
    return false;
  }
}

/**
 * Remove credential-shaped material from agent-authored text bound for GitHub.
 *
 * Returns the input string unchanged (byte-exact) when no detector fires, so
 * ordinary review prose is never reformatted.
 */
export function scrubGitHubEgressText(input: string): GitHubEgressScrubResult {
  if (typeof input !== "string" || input.length === 0) {
    return { text: input, redacted: false, classes: [] };
  }

  const fired = new Set<GitHubEgressScrubClass>();
  let text = input;

  const apply = (re: RegExp, cls: GitHubEgressScrubClass, replacer?: (m: string) => string) => {
    text = text.replace(re, (match) => {
      const replacement = replacer ? replacer(match) : redactionMarker(cls);
      if (replacement === match) return match;
      fired.add(cls);
      return replacement;
    });
  };

  // PEM first: its base64 body would otherwise trip the JWT and entropy
  // detectors and produce a shredded, unreadable envelope instead of one marker.
  apply(PEM_BLOCK_RE, "private-key-block");
  if (/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(text)) {
    apply(PEM_BLOCK_UNTERMINATED_RE, "private-key-block");
  }

  // Environment runs before single assignments so a dump collapses to one
  // marker rather than N.
  //
  // A run can swallow a line whose value was already replaced above — an
  // interpolated dump routinely carries a PEM under some *_PRIVATE_KEY name.
  // Carry those nested markers through, or the result claims to have removed a
  // private key while showing no marker for it, and a reviewer greps for the
  // class in vain. The invariant is: every class reported in `classes` has a
  // visible marker in `text`.
  text = text.replace(ENVIRONMENT_DUMP_RE, (match) => {
    const nested = [...new Set(match.match(NESTED_MARKER_RE) ?? [])];
    fired.add("environment-dump");
    return [redactionMarker("environment-dump"), ...nested].join(" ");
  });


  apply(CREDENTIALED_URI_RE, "credentialed-uri");

  apply(JWT_CANDIDATE_RE, "jwt", (match) =>
    isJwt(match) ? redactionMarker("jwt") : match,
  );

  apply(VENDOR_KEY_RE, "vendor-key");

  // Redact only the value; the name is often the point of the sentence and is
  // not itself sensitive.
  text = text.replace(ASSIGNMENT_RE, (match, name: string, quote: string, value: string) => {
    if (!isOpaqueSecretValue(value)) return match;
    fired.add("high-entropy-assignment");
    return `${name}=${quote}${redactionMarker("high-entropy-assignment")}${quote}`;
  });

  const order: GitHubEgressScrubClass[] = [
    "private-key-block",
    "credentialed-uri",
    "jwt",
    "vendor-key",
    "environment-dump",
    "high-entropy-assignment",
  ];

  return {
    text,
    redacted: fired.size > 0,
    classes: order.filter((cls) => fired.has(cls)),
  };
}

/** One line of a refused value, and what fired on it. */
export interface GitHubEgressMatchLocation {
  /** 1-based line number within the value that was scanned. */
  line: number;
  classes: GitHubEgressScrubClass[];
  /**
   * The line AS SCRUBBED, truncated.
   *
   * Safe to print by construction, and that is the whole reason it is the
   * scrubbed line rather than the matched substring BLO-41262's acceptance
   * criterion asked for: echoing the raw match sends the material into agent
   * stderr and from there into run logs and whatever the agent pastes when it
   * reports the refusal — PEN-2526's shape, reached from inside the control
   * built to prevent it. The marker sits where the material was, so the
   * surrounding bytes still identify the line unambiguously.
   */
  excerpt: string;
}

/** Longest excerpt reported. Long enough to carry an XML element or an
 *  assignment with its context, short enough that a minified line cannot turn
 *  a refusal into a page of output. */
const EXCERPT_MAX_LENGTH = 200;

/**
 * Locate, per line, what `scrubGitHubEgressText` fired on.
 *
 * BLO-41262: a content refusal named only the field and the class, so finding
 * the offending line in a 3000-line draft took ~12 API calls of manual
 * bisection. This runs the same detectors line by line, so the refusal can say
 * where.
 *
 * Only called on the refusal path, which is already failing, so the per-line
 * re-scan costs nothing in the common case.
 *
 * A class that only fires ACROSS lines — `environment-dump` needs a run of
 * five — has no single line and is absent here. The caller reports those
 * classes without a location rather than attributing them to a line.
 */
export function locateGitHubEgressMatches(input: string): GitHubEgressMatchLocation[] {
  if (typeof input !== "string" || input.length === 0) return [];

  const located: GitHubEgressMatchLocation[] = [];
  const lines = input.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string;
    const scrubbed = scrubGitHubEgressText(line);
    if (!scrubbed.redacted) continue;
    const excerpt =
      scrubbed.text.length > EXCERPT_MAX_LENGTH
        ? `${scrubbed.text.slice(0, EXCERPT_MAX_LENGTH)}…`
        : scrubbed.text;
    located.push({ line: i + 1, classes: scrubbed.classes, excerpt });
  }
  return located;
}
