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

// PEN-3907: a cryptographic content digest bound to a name that says so.
//
// A lowercase-hex digest is indistinguishable from a hex-encoded secret by
// entropy alone — both saturate the 4.0 bits/char ceiling that a 16-symbol
// alphabet allows, and `isOpaqueSecretValue` therefore fires on every one.
// Measured: 200/200 random sha256 digests redact. That makes every digest
// REPIN unpushable from an agent seat, and the refusal's advice — derive the
// value at runtime — is unavailable when the literal lives inside a PromQL
// matcher in a `PrometheusRule`, which is exactly where the admission-drift
// detector keeps its expectation pin.
//
// The exemption is deliberately a CONJUNCTION of name and shape, and the name
// half is why this does not contradict the structural-detection rule at the
// top of this file. That rule governs DETECTION: firing on a name is unsound
// because material hides under names nobody enumerated, and the default must
// be to fire. Here the default is unchanged — an unrecognised name still
// fires. The name only narrows an exemption, so the failure mode of a name we
// did not anticipate is a false positive, not a leak.
//
// Shape alone would not be safe: `SECRET_KEY=<64 hex>` is a real credential
// shape (hex-encoded HMAC and framework signing keys are routinely 32 or 64
// hex), and exempting bare hex would pass it. Name alone would not be safe
// either, so both are required.
//
// Note the OCI form `name="sha256:<64hex>"` is already exempt for an unrelated
// reason — `:` is outside the token alphabet in `isOpaqueSecretValue` — and
// `digestExemptionApplies` does not cover it. A test pins that so the two
// paths cannot silently diverge.

/** Lengths of the hex digests this exemption recognises, in characters:
 *  md5/sha1/sha224/sha256/sha384/sha512. Anchored, lowercase only — an
 *  uppercase or mixed-case value is not the canonical form any of the tools
 *  that consume these pins emit, so it stays subject to the entropy test. */
const HEX_DIGEST_RE = /^(?:[0-9a-f]{32}|[0-9a-f]{40}|[0-9a-f]{56}|[0-9a-f]{64}|[0-9a-f]{96}|[0-9a-f]{128})$/;

/** A binding name that declares its value to be a digest rather than a secret:
 *  `sha256`, `image_digest`, `expected-checksum`, `manifest.sha512`.
 *
 *  Anchored at the END so `sha256_signing_key` — a name that merely mentions a
 *  hash — does not qualify. The leading `[_.-]` alternative is mostly belt and
 *  braces: `ASSIGNMENT_RE` captures a name from `[A-Za-z0-9_]` only, so `-`
 *  and `.` already terminate the capture and arrive here pre-trimmed
 *  (`expected-checksum=` captures `checksum`). It is kept so the predicate
 *  stays correct if that capture ever widens. */
const DIGEST_NAME_RE = /(?:^|[_.\-])(?:sha(?:1|224|256|384|512)|md5|digest|checksum)$/i;

/** True when a NAME=VALUE pair is a content digest pin rather than a secret. */
function isContentDigestAssignment(name: string, value: string): boolean {
  return DIGEST_NAME_RE.test(name) && HEX_DIGEST_RE.test(value);
}

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

/** BLO-44747: a word carrying ONE short digit run — `orc8r`, `k8s`, `ipv6`,
 *  `i18n`, `eastus2`. Infrastructure names are built from these, and the
 *  strict form above refused them: the orc8r CDN forward-queue federate job, a
 *  Prometheus scrape-job name already public on onprem-k8s master, made every
 *  agent push touching that file unpublishable. Bounded so it stays a word:
 *  must open with a letter, one digit run of at most 2, and an exonerated value
 *  may carry at most ONE such segment, written in a single case. A UUID stays
 *  opaque — `386c81e8` opens with a digit, `e454` has a 3-digit run.
 *
 *  This DOES widen exoneration for random tokens, and the residual is measured,
 *  not zero (Ally, review 5496550156). A random token often has all-but-one
 *  segment letters-only, and this forgives exactly that one. Single case cuts
 *  base64url-32 from ~70 to ~12 per 100k; fixed-layout keys are closed by the
 *  uniform-length check in isLexicalIdentifier. What remains, through the whole
 *  of isOpaqueSecretValue, 100k random values per shape: base64url-32 ~1e-4,
 *  lower+digit with random separators ~3–5e-4 at 24–28 chars and ~2e-5 at 32,
 *  fixed-layout 4×6 / 5×5 keys and base64url-43 0. Accepted: the alternative was refusing every agent
 *  push touching a file that names an `orc8r` job. */
const MIXED_LEXICAL_SEGMENT_RE = /^(?=.{2,8}$)(?:[a-z]+[0-9]{1,2}[a-z]*|[A-Z]+[0-9]{1,2}[A-Z]*)$/;

/** Longest segment an identifier may carry and still be exonerated. This is
 *  identifier HEADROOM, not a security bound: 16 random lowercase letters is
 *  already ~75 bits, so a segment at the limit is a usable secret on its own.
 *  Chosen with room over the longest segment real identifiers use —
 *  `multicast` and `transport` are 9, `authentication` is 14.
 *
 *  None of the length bounds here closes the rule; see isLexicalIdentifier for
 *  what actually keeps random tokens out. */
const LEXICAL_SEGMENT_MAX_LENGTH = 16;

/** Segments longer than this count as "long", and an exonerated value may hold
 *  at most one. Without it the per-segment cap admits any NUMBER of ~75-bit
 *  segments — two random 16-letter words joined by a hyphen (~150 bits) passed.
 *  Real identifiers carry at most one long word: the longest segment of
 *  `draft-ramadan-moq-multicast-00` and `draft-ietf-moq-transport-14` is 9.
 *
 *  This bounds LONG segments only. It says nothing about how many segments of
 *  this length or less a value carries, so on its own it left exonerated
 *  entropy unbounded: 16 × 10 random letters (~750 bits) passed. The total is
 *  capped separately, by LEXICAL_IDENTIFIER_MAX_CONTENT_LENGTH. */
const LEXICAL_LONG_SEGMENT_LENGTH = 10;

/** Ceiling on the summed length of an exonerated value's segments, separators
 *  excluded. Derived from the regression set, not from an entropy budget: the
 *  longest real identifier there, `draft-ramadan-moq-multicast-00`, sums to 26
 *  (`draft-ietf-moq-transport-14` to 23, the `-fec-`/`-mmt-` drafts to 20), and
 *  this is 26 rounded up to the next whole LEXICAL_LONG_SEGMENT_LENGTH — three
 *  long-segment widths, 30. So 4 × 10 random letters and above go back to
 *  refused. It narrows the rule rather than closing it: 3 × 10 sums to exactly
 *  30 (~141 bits) and is still exonerated. */
const LEXICAL_IDENTIFIER_MAX_CONTENT_LENGTH = 3 * LEXICAL_LONG_SEGMENT_LENGTH;

/**
 * BLO-41262: a separator-delimited run of short words is an identifier, not a
 * credential, and per-character entropy cannot tell the two apart.
 * `draft-ramadan-moq-multicast-00` scores 3.74 bits/char — above the floor —
 * so an RFC-XML `<seriesInfo … value='draft-…'/>` element read as
 * credential-shaped, and every `.md` IETF draft in Blockcast/moqcast-draft
 * became unwritable through `gh api .../git/blobs` while the push path was down.
 *
 * The discriminator is structure, not vocabulary (no word list to drift): a
 * credential is ONE opaque run, so a value is exonerated only when every
 * separator-delimited segment is itself a plain word or number (BLO-44747: or,
 * for at most one segment, MIXED_LEXICAL_SEGMENT_RE), none exceeds
 * LEXICAL_SEGMENT_MAX_LENGTH, at most one exceeds LEXICAL_LONG_SEGMENT_LENGTH,
 * AND the segments sum to at most LEXICAL_IDENTIFIER_MAX_CONTENT_LENGTH. Each
 * conjunct carries weight — `release-Candidate-<20 letters>` is refused on the
 * length of its tail, two 11-letter words on the long-segment count, and four
 * 10-letter words on the summed length.
 *
 * These are bounds on SHAPE, not on entropy, and they do not close the rule:
 * 3 × 10 random letters (~141 bits) is still exonerated. What keeps random
 * tokens out is that generators do not emit homogeneous letter-or-digit runs.
 * Measured through the whole of isOpaqueSecretValue over 20k random values per
 * shape (Ally, review 5476147384): 0/20000 alnum-40, 1/20000 base64url-43 and
 * 1/20000 alnum-24 pass, and each of those passes is the entropy floor, not
 * this rule; re-measured with the summed-length cap in place, 0/20000 of each.
 * Those figures predate the mixed-segment branch and hold for the all-plain
 * path only; that branch's own residual is on MIXED_LEXICAL_SEGMENT_RE.
 * A UUID stays opaque, because `386c81e8` is neither a word nor a number.
 */
function isLexicalIdentifier(value: string): boolean {
  const segments = value.split(/[-._]/);
  if (segments.length < 2) return false;
  const longSegments = segments.filter((s) => s.length > LEXICAL_LONG_SEGMENT_LENGTH).length;
  if (longSegments > 1) return false;
  const contentLength = segments.reduce((sum, s) => sum + s.length, 0);
  if (contentLength > LEXICAL_IDENTIFIER_MAX_CONTENT_LENGTH) return false;
  if (segments.some((s) => s.length > LEXICAL_SEGMENT_MAX_LENGTH)) return false;
  const nonPlain = segments.filter((s) => !LEXICAL_SEGMENT_RE.test(s));
  if (nonPlain.length === 0) return true;
  if (nonPlain.length !== 1 || !MIXED_LEXICAL_SEGMENT_RE.test(nonPlain[0]!)) return false;
  // Generated keys use a fixed layout (`xxxxxx-xxxxxx-xxxxxx-xxxxxx`); real
  // identifiers are words of varying length. Without this, ~0.4% of random
  // 4×6 lower+digit keys carry exactly one admissible mixed segment.
  return new Set(segments.map((s) => s.length)).size > 1;
}

/** Character classes a value must draw from at least two of, before the entropy
 *  test is allowed to run. `----------------------------` and `aaaa...` are
 *  not secrets, and counting classes is the cheap guard that says so.
 *
 *  PEN-3932: uppercase and digits are SEPARATE classes. They used to be one
 *  (`[A-Z0-9]`), which collapsed the very distinction the count exists to
 *  draw. A value from `A-Z` and `0-9` alone scored ONE class and returned
 *  before `shannonEntropyBitsPerChar` ever ran, so it was unreachable by this
 *  rule at any length and any randomness. That is not a narrow shape:
 *  canonical base32 is `A-Z2-7`, so TOTP/HOTP seeds, recovery codes and
 *  base32-encoded keys are uppercase by construction, as is hex from any tool
 *  that uppercases. Measured on the shipped detector: 0/200 random 40-char
 *  base32 seeds redacted against 200/200 for the same bytes lowercased — the
 *  lowercase arm being the positive control that proves case alone, not
 *  entropy or length or alphabet, was doing the discriminating.
 *
 *  Splitting the class ADDS exactly one set and removes nothing: values with
 *  no lowercase, at least one uppercase and at least one digit. Every other
 *  value scores identically under both forms (22k random values over 11
 *  alphabets: 0 divergences from that prediction, 0 values losing coverage).
 *  That bound is why this does not make PEN-3920 worse — its corpus is
 *  mixed-case and already scored two classes, so it is untouched.
 *
 *  The cost was measured, not assumed. Across 8069 distinct real `NAME=VALUE`
 *  values in Blockcast/paperclip and Blockcast/penstock-llm-proxy-core, 0
 *  newly fire: `isLexicalIdentifier` already absorbs the SCREAMING_SNAKE
 *  constants that would otherwise be the whole cost. On a synthetic
 *  adversarial set of 12 such constants, 3 fire, and all 3 carry a segment
 *  mixing letters and digits (`..._V2`, `AZURE_EASTUS2_...`) which
 *  `isLexicalIdentifier` cannot exonerate. Do NOT widen LEXICAL_SEGMENT_RE to
 *  reach them: homogeneous letter-or-digit runs are precisely what keeps
 *  random tokens OUT of that exemption, so loosening it trades a bounded false
 *  positive for a false negative. That residual belongs to PEN-3920.
 *  (BLO-44747 since admits ONE such segment per value under a bounded shape —
 *  see MIXED_LEXICAL_SEGMENT_RE; it leaves this regex untouched.)
 *
 *  Deliberately still out of reach: a single-case LETTERS-ONLY value scores
 *  one class under this form too, in both cases, so it never reaches the
 *  entropy test. For an uppercase credential that means a base32 seed which
 *  happens to draw no digit at all — 0.69% of 24-char seeds and 0.026% of
 *  40-char ones (200k trials each). Closing it means dropping this gate
 *  entirely, which admits a further 181 values from the same real corpus,
 *  mostly paths and branch slugs (`DATA_DIR=./data/release-smoke-canary`).
 *  The trade was measured and declined; it is recorded on PEN-3932. */
function classIndex(value: string): number {
  return [/[a-z]/, /[A-Z]/, /[0-9]/].filter((re) => re.test(value)).length;
}

/**
 * BLO-41153: a fully-qualified gRPC method path is a wire identifier, not a
 * credential, and `isLexicalIdentifier` cannot reach it.
 *
 * `/magma.orc8r.Bootstrapper/GetChallenge`, bound to a `method` key, scores
 * 4.05 bits/char and is refused. (Every mention of that binding in this file
 * and its tests keeps a space around the `=`, or builds the pair at runtime:
 * written out contiguously it is the very material the unfixed rule refuses,
 * so the fix for the false positive could not be pushed past the false
 * positive. Same convention as the PEN-3907 and BLO-41262 fixtures.)
 *
 * It fails the lexical exemption three separate ways, so loosening that
 * rule's constants is not the fix: `/` is not one of its separators,
 * `orc8r` is neither a plain word nor a plain number, `Bootstrapper` and
 * `GetChallenge` are two segments over LEXICAL_LONG_SEGMENT_LENGTH, and the
 * segments sum to 34 against a cap of 30. Each of those bounds is load-bearing
 * against random letter runs and must stay where it is.
 *
 * So this is a separate shape rather than a widened one, and it is anchored so
 * tightly that no credential ENCODING can reach it: the value must be
 * slash-rooted, carry at least one `.` inside the package, then exactly one
 * more `/`, with every run starting with a letter and holding only
 * `[A-Za-z0-9]`. base64url has no `.` and no `/`; standard base64 and hex have
 * no `.` either. A JWT has dots but no slash, and decodes under its own
 * detector first.
 *
 * The dot is the conjunct carrying the security argument, and it is the one to
 * leave alone: without it a standard-base64 secret beginning with `/` — 1 in
 * 64 of them — walks through. The letter-initial runs are shape hygiene after
 * that, mirroring proto identifier rules; each is pinned by a failing mutation
 * in the test file so the narrowing is not merely a comment.
 *
 * Shape alone, with no name conjunction — unlike `isContentDigestAssignment`,
 * where bare hex IS a real credential shape (`SECRET_KEY=<64 hex>`) and the
 * name has to carry half the decision. Nothing of this shape is a credential,
 * and a name list would drift: the same path is bound to `method`, `rpc`,
 * `grpc_method` and `full_method` across the fleet's runbooks and alert rules,
 * and the first name nobody enumerated reproduces this false positive.
 *
 * The trailing method is optional because a grep pattern legitimately stops at
 * the service — `grep -c 'method = /magma.orc8r.Bootstrapper/'` (modulo the
 * spacing convention above) is BLO-41153's own verifying signal, and under the
 * unfixed rule the runbook documenting that command could not be pushed.
 */
/*
 * BLO-45350: the method run is bounded to `[A-Z][A-Za-z]*` — proto method
 * style, UpperCamelCase with no digits. The package and service runs above
 * only have to start with a letter, so without this a value shaped
 * `/a.b/<opaque token>` was exonerated whole: any base62 token starting with a
 * letter fit the old method run. Excluding digits is what does the work — a
 * random 32-char base62 token starts uppercase AND draws no digit in ~0.2% of
 * cases, against 100% of letter-initial ones before. Shape rather than entropy
 * on purpose: real long method names (`GetGatewayDeviceInfoAndStatus`, 4.0
 * bits/char) clear the 3.5 threshold on their own.
 */
const GRPC_METHOD_PATH_RE =
  /^\/[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)+\/(?:[A-Z][A-Za-z]*)?$/;

/** A value is "opaque" when it is long, drawn from a token alphabet and from
 *  at least two character classes, is not a hyphenated identifier, and has
 *  high per-character entropy. Deliberately narrow: applied only to
 *  assignment values, never to bare words. A 40-char git SHA scores ~4.0
 *  bits/char and would be redacted out of ordinary review prose if this ran
 *  unbound. */
function isOpaqueSecretValue(value: string): boolean {
  if (value.length < HIGH_ENTROPY_MIN_LENGTH) return false;
  if (!/^[A-Za-z0-9+/=_.\-]+$/.test(value)) return false;
  if (classIndex(value) < 2) return false;
  if (isLexicalIdentifier(value)) return false;
  if (GRPC_METHOD_PATH_RE.test(value)) return false;
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
    if (isContentDigestAssignment(name, value)) return match;
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
   * Safe to print for SINGLE-LINE classes, and that is the whole reason it is the
   * scrubbed line rather than the matched substring BLO-41262's acceptance
   * criterion asked for: echoing the raw match sends the material into agent
   * stderr and from there into run logs and whatever the agent pastes when it
   * reports the refusal — PEN-2526's shape, reached from inside the control
   * built to prevent it. The marker sits where the material was, so the
   * surrounding bytes still identify the line unambiguously.
   */
  excerpt: string;
}

/** Classes that suppress a REGION of the text rather than a match: a run of
 *  environment assignments, or a PEM envelope (an unterminated one takes
 *  everything to end of input). A per-line re-scan cannot reproduce that, so
 *  when one fires no line is attributed at all — see
 *  `locateGitHubEgressMatches`. */
export const GITHUB_EGRESS_REGION_CLASSES: readonly GitHubEgressScrubClass[] = [
  "private-key-block",
  "environment-dump",
];

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
 * A class that suppresses a REGION — `environment-dump` (a run of five
 * assignments) or `private-key-block` — has no single line, and worse, the
 * lines underneath it are only protected by the whole-text pass: re-scanned
 * one at a time, a line inside a dump that fires for its own reason would be
 * echoed with only its own match removed, carrying the short assignments the
 * dump rule exists to catch. So when any region class fires on the whole
 * value this returns no locations at all, and the caller reports the classes
 * without line attribution.
 */
export function locateGitHubEgressMatches(input: string): GitHubEgressMatchLocation[] {
  if (typeof input !== "string" || input.length === 0) return [];
  const whole = scrubGitHubEgressText(input);
  if (whole.classes.some((cls) => GITHUB_EGRESS_REGION_CLASSES.includes(cls))) return [];

  const located: GitHubEgressMatchLocation[] = [];
  const lines = input.split(/\r?\n/);
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
