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


/** A run of this many NAME=VALUE lines reads as an environment dump regardless
 *  of which variables it holds. Five is low enough to catch the interpolation
 *  that caused PEN-2526 and high enough that a changelog listing a couple of
 *  config defaults passes through untouched.
 *
 *  This count is the ONLY layer covering short, low-entropy, human-chosen
 *  secrets in bulk: every value below HIGH_ENTROPY_MIN_LENGTH is invisible to
 *  `isOpaqueSecretValue`, so once a run is not recognised nothing else fires.
 *  PEN-6123 measured that no value-shape test can narrow this rule without
 *  admitting a matched secret generator outright — config and hand-chosen
 *  secrets are drawn from one lexical space — so the rule stays value-blind
 *  and the run count carries the whole decision.
 *
 *  What the count ranges over is therefore load-bearing, and it is NOT "lines
 *  of the file": see ENVIRONMENT_DUMP_MAX_INERT_GAP. */
export const ENVIRONMENT_DUMP_MIN_RUN = 5;

/** How many consecutive INERT lines — blank, or a `#` comment — may sit
 *  between two assignments without breaking the run.
 *
 *  PEN-6127: at 0, which is what shipped until 2026-11-08, the run had to be
 *  physically adjacent, and ONE interleaved comment or blank line defeated the
 *  rule completely. Measured: a sectioned `.env` carrying nine values, three of
 *  them short passwords, grouped under `# database` / `# redis` / `# smtp`,
 *  PASSED — while the same nine values contiguous were REFUSED. Byte-identical
 *  content; the only difference was layout. That made the single most natural
 *  edit an author reaches for — and which reads as ordinary good style — a
 *  complete bypass of the one rule that covers this class.
 *
 *  Two is not a fitted constant. It is the width of a stanza break in a
 *  sectioned `.env`: one blank line, then one comment naming the next stanza.
 *  Three recovers nothing further on the measured corpora; one leaves the
 *  headline bypass open, because blank-then-comment is two lines.
 *
 *  ⚠ A line that is neither an assignment nor inert — any line of actual code —
 *  still breaks the run, at every setting. That is what keeps a shell script
 *  whose constants are separated by real statements out of the rule.
 *
 *  ⚠ And state the bound honestly, because the comment this replaced did not:
 *  this is a LAYOUT rule, and a layout rule is defeated by layout. Three blank
 *  lines between stanzas still passes. It is calibrated against dumps that
 *  tools and people actually emit — contiguous `env` output, and the sectioned
 *  `.env` above — NOT against an author working to evade the door, who has
 *  easier paths than reformatting. It raises the cost of an ACCIDENT; it is not
 *  a barrier to a determined bypass and must not be described as one.
 *
 *  ⚠ Widening this is a behaviour change, not a tuning knob: the tests pin the
 *  bound against LITERAL layouts, not against this constant, precisely so that
 *  raising it turns them red rather than moving with it. */
export const ENVIRONMENT_DUMP_MAX_INERT_GAP = 2;

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

// A line carrying no content of its own: blank, or a `#` comment.
//
// `#` only, deliberately. Widening to `//`, `;` or `--` was measured to change
// nothing on either corpus (165 and 35 refused files, identical sets), and each
// of them is a CODE prefix somewhere that matters here — `--set foo=bar \` is a
// Helm continuation line, and onprem-k8s is full of them. Equal measured cost
// means the narrowest option is free, so take it. `#` is also the comment
// marker of every format this rule is actually about: `.env`, shell, YAML.
const ENV_INERT_LINE = String.raw`^[ \t]*(?:#[^\r\n]*)?$`;

// Assignment, then its line ending, then up to MAX_INERT_GAP inert lines.
// Anything else between two assignments ends the run.
const ENV_RUN_SEPARATOR =
  `\\r?\\n(?:${ENV_INERT_LINE}\\r?\\n){0,${ENVIRONMENT_DUMP_MAX_INERT_GAP}}`;

const ENVIRONMENT_DUMP_RE = new RegExp(
  `(?:${ENV_ASSIGNMENT_LINE}${ENV_RUN_SEPARATOR}){${ENVIRONMENT_DUMP_MIN_RUN - 1},}${ENV_ASSIGNMENT_LINE}`,
  "gm",
);

// PEN-6123: this rule admits NO value-shape exemption, and the attempt to give
// it one is recorded here so it is not retried from scratch.
//
// A "zero-entropy value" clause was written and reviewed on PR #3545: a run was
// to be exempted when EVERY value in it provably could not hold a secret —
// empty, a shell expansion, a number with a unit, or a boolean keyword. It was
// withdrawn before merge. Measured over the 142 files in Blockcast/onprem-k8s
// this rule refuses today:
//
//   clause as first written                              cleared 28 of 142
//   same clause, once the unsound arms were removed      cleared  3 of 142
//
// The gap is the whole story. 25 of those 28 files were cleared by the arms
// that accept a value merely because it STARTS with `$` or a backtick, and
// those arms do not mean what the clause claimed. `${DB_PASSWORD:-hunter22}`
// puts its default IN the blob; so does `$(echo dragon417)` and
// `` `echo admin:hunter22` ``. All four were verified exempt under the clause
// and refused without it — a regression the clause introduced, not a residual.
//
// Narrowing the expansion arm to a bare reference does not rescue it either:
// `$ecretP4ss` is a password that is lexically identical to a variable
// reference, so no regex over the value can tell a reference from a literal
// that happens to start with `$`. And the numeric arm accepts an unbounded
// digit run, which is a PIN. Ports and PINs are both 4-6 digits, so a length
// bound cannot separate them.
//
// What remains after removing every unsound arm clears 3 of 142 — about 2% of
// the false-positive load — in exchange for a corpus file, a value parser and
// a standing bypass surface on the one rule that catches short, low-entropy,
// human-chosen secrets in bulk. That is not a trade worth making, so the rule
// stays value-blind and the threshold is justified on its own terms instead.
//
// The underlying reason is the same one that defeated the four wider shapes
// measured on the same corpus — `contains a space` (63/142, defeated by a
// passphrase), `contains a slash` (43/142, by `/srv/keys/dragon417`),
// `contains a colon` (35/142, by `admin:hunter22`), `lowercase dashed
// identifier` (44/142, by `dragon-4471`), each at a 100% admission rate
// against a matched generator. Human-chosen secrets and hand-written config
// are drawn from one lexical space; no value-shape allowlist separates them.

// NAME=VALUE where the value is long and opaque. This is the fail-closed net
// under the count threshold: one interpolated secret is not a "dump" but is
// still a secret. Structural — it tests the value, not the name.
//
// BLO-43580: the value capture is the token alphabet, NOT "anything up to
// whitespace". The old `[^\s"'`]` capture was greedy to end of line, so one
// out-of-alphabet joiner (`?`, `&`, `,`, `;`, `(`, `|`, `#`, …) made the
// whole run fail the alphabet gate then in isOpaqueSecretValue — and because the
// regex had already CONSUMED that run, a nested `key=<secret>` inside it was
// never offered to the detector at all. Stopping the capture at the first
// out-of-alphabet character leaves the rest of the line to be scanned.
//
// No closing-quote backreference either: a quote is consumed only on the way
// in, and the replacer leaves whatever follows the value in place. Requiring
// the closing quote let `x="<secret>?…"` escape the same way.
//
// This capture IS the alphabet gate: isOpaqueSecretValue used to re-test the
// value against the same class, which can no longer fail, so it was removed.
//
// PEN-6162: the `=` is LITERAL AND ADJACENT. There is no `\s*` on either side,
// so `NAME = "<value>"` is not matched at all — at any value, any length, any
// entropy. That is the standard formatting of every mainstream `=`-binding
// language, so an opaque secret hardcoded to prettier, PEP8 or gofmt spacing
// passes this net. Measured 2026-11-08 against the shipped detector, one
// synthetic 32-char value: the TypeScript, Python and Go spaced forms all pass
// and the same bytes unspaced fire, so spacing alone is the discriminator.
//
// The gap is DELIBERATE AND DATED, not an oversight, and it is accepted only
// until the two gates below clear. Its scope is narrow because the other five
// classes do not share it — each was measured in spaced form: vendor-key, jwt,
// credentialed-uri and private-key-block all redact, and environment-dump is
// unspaced by construction. What is left is exactly an opaque secret with no
// recognisable vendor prefix (an HMAC or signing key, a session key, a
// generated password, a base64 blob) written as a quoted literal in source.
//
// Widening to `[ \t]*=[ \t]*` is the change a reader reaches for first, and it
// is REFUSED on measured cost. Over this repo at 3fe0df7e3 — 5,043 tracked
// .ts/.tsx/.js/.mjs/.py/.go/.yaml/.yml/.md files, 2,054,755 lines, each
// candidate rewritten to the unspaced form and run back through this detector —
// it fires on 8,989 lines that pass today: 4.375 per 1k, against the 68 lines
// `high-entropy-assignment` refuses across the whole corpus — a 132x increase
// in the population of THIS rule.
//
// Beware the other baseline. 358 is every egress class COMBINED (vendor-key
// 156, credentialed-uri 95, high-entropy-assignment 68, private-key-block 34,
// jwt 5); comparing a widening of one rule against the total understates it by
// ~5x. Both figures re-measured at 4962a9c78 and reproduce exactly.
//
// Essentially all of the 8,989 are `const x =
// someLongCamelCaseCallee(...)`: the capture stops at the first out-of-alphabet
// character, so an ordinary >=24-char camelCase callee IS a two-class,
// no-separator, high-entropy token and `isLexicalIdentifier` cannot exonerate
// it. On a push-BLOCKING door that is unshippable.
//
// The affordable variant requires a CLOSED quoted string literal on the spaced
// arm — a hardcoded secret is a literal, `someCallee(` is not. Measured the
// same way: 325 new lines, 0.158 per 1k, 27x fewer than the naive widening —
// though still ~4.8x the 68 lines this rule refuses today, which is the honest
// framing of its headroom. It
// has NOT landed, and two things gate it, both tracked on PEN-6162:
//   - the 325 are the PEN-3920 family arriving through a new door — alert-name
//     constants, 40-hex commit and UUID fixtures, migration filenames,
//     `this.name = "SomeError"`, and ~72 lowerCamelCase metadata-key constants
//     (`paperclipK8sIsolationRetryAt`) that no existing exemption reaches,
//     since ALERT_NAME_RE is UpperCamelCase and name-anchored to
//     `alertname`/`kind`. That exemption work is the bulk of the change.
//   - PEN-6163. Every module-level alert-name constant in every guard script in
//     the fleet is exempt TODAY ONLY because of this whitespace gap, so landing
//     the spaced arm turns that row's single kwarg into a whole population.
//
// If the spaced arm does land, the two arms will NOT be equivalent: requiring
// the closing quote is precisely the narrowing BLO-43580 removed above, and it
// is defensible on a separate additive branch only because a secret in spaced
// source is a literal by construction. Tidying them together reopens
// BLO-43580. `github-egress-scrub.test.ts` pins the gap in both directions, so
// a widening cannot land silently.
//
// Not reached by any of the above: `:` is not `=`. `name: "<opaque>"` — YAML,
// JSON, a Kubernetes Secret `stringData` block — never matches this net at any
// spacing, which is a separate and wider gap tracked on PEN-6167. Measured
// 2026-11-08: removing the space from `webhook_secret: "<v>"` changes nothing,
// while the same line with `=` fires. So the operator is the variable there,
// not the spacing, and the spaced `=` arm above would close none of it.
//
// PEN-6167 DISPOSITION, 2026-11-08: the colon gap is ACCEPTED, and no
// operator-level widening of this regex is pursued. Not deferred for want of
// measurement — priced at 4962a9c78 over the same corpus, so the numbers live
// here next to the regex rather than only on the row. "closes" counts the
// seven colon-bound forms PEN-6167 reports as passing today:
//
//   arm                                        closes   new lines refused
//   `[=:]` — one character, still adjacent      1 / 7     +2,301   (33.8x)
//   `[ \t]*:[ \t]*`, bare key, any value        4 / 7    +17,933  (264x)
//   ...bare key, closed quoted literal          3 / 7       +775   (11.4x)
//   ...quoted key tolerated, any value          7 / 7    +18,035  (265x)
//   ...quoted key tolerated, quoted literal     6 / 7       +804   (11.8x)
//
// The `[=:]` row was measured by patching that one character into a copy of
// the shipped detector; the rest by the candidate-rewriting method described
// above. Three things in that table decide it:
//
//  - The one-character change is a TRAP, not a cheap win. `[=:]` is still
//    ADJACENT, so it reaches only `webhook_secret:"<v>"` — the one spelling
//    nobody writes. Every realistic form (`key: "<v>"`, a stringData block,
//    any JSON) stays blind, so it buys the appearance of a fix. And 86% of
//    what it DOES newly refuse is ordinary URLs — 1,969 of 2,301 — because
//    `https` is a name, `:` the operator and `//github.com/...` sits inside
//    the value alphabet. `:` is the URI scheme separator before it is a
//    binding operator, and a credentialed URI already has its own class.
//  - Only the quoted-key arms reach the JSON forms, and they cost ~11.8x the
//    entire current population of this rule on a push-BLOCKING door.
//  - The residual is not an enumerable exemption family the way PEN-3920's
//    alert names were. It is ordinary structured-data syntax: TypeScript type
//    annotations, AWS `Sid:` values, UUID fixtures, file paths, and JS
//    ternaries read as bindings (`alertname: fired ? 'A' : 'B'`) — which lands
//    on the alert-posting scripts and manufactures more of PEN-6163.
//
// SCOPE of what is accepted, measured and not inferred: vendor-key, jwt,
// credentialed-uri and private-key-block were each exercised in colon form and
// all four redact. What passes is exactly an opaque secret with NO recognisable
// vendor prefix — an HMAC or signing key, a session key, a generated password,
// a base64 blob — bound with `:` in YAML, JSON or a Secret manifest. The right
// control for that population is a repo-level secret scanner that reads `:`
// natively, not a wider regex on this door; Blockcast/paperclip runs none
// today, which is PEN-6170. Revisit this disposition if that population stops
// being covered elsewhere, or if the quoted-key residual becomes enumerable.
//
// PEN-6255: the capture begins at a binding NAME, so the gap is one axis wider
// than either the spacing (PEN-6162) or the operator (PEN-6167). Both of those
// still have a binder to widen toward. A value with NO BINDER AT ALL is never
// a candidate here, at any length, any entropy, any quoting, in any language —
// so no operator-level change reaches it, and a reader who sees both of those
// arms land must not read the generic net as general afterwards.
//
// Measured 2026-11-09 through the shim's own call shape
// (`addedLinesFromPatch` then `scrubGitHubEgressText`), one synthetic 32-char
// opaque value with no vendor prefix per row: a Python tuple element, a YAML
// sequence item, a positional argument, a JSON array element, a Go slice
// literal and a bare `return` all pass byte-exact, while `apiSecret="<v>"` on
// the SAME bytes redacts. The exemption is purely structural — the value
// clears the shape and entropy floors either way — and it is not a judgement
// that material written this way is safe.
//
// The repo-level scanner named above only covers this population if the rule
// it ships is TOKEN-shaped. Measured the same run: gitleaks 8.28.0's default
// `generic-api-key` is name-anchored too and misses all six forms, with the
// `apiSecret` control and two name-free liveness controls (`github-pat` on a
// bare tuple element, `private-key` on a PEM) firing alongside.
const ASSIGNMENT_RE = /\b([A-Za-z_][A-Za-z0-9_]{2,})=(["']?)([A-Za-z0-9+/=_.\-]{16,})/g;

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
// reason — `:` is outside the token alphabet ASSIGNMENT_RE captures — and
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

/** BLO-43580: pnpm's `patch_hash` — a base32 md5 of a patch file, 26 chars
 *  of `[a-z2-7]` — as written into pnpm-lock.yaml inside a version specifier:
 *  `postgres@3.4.9(patch_hash=<26>)`. It used to pass only because the old
 *  greedy capture swallowed the trailing `)` and failed the alphabet gate;
 *  once the capture stopped at `)` every dependency bump that re-wrote such a
 *  line became unpushable. Exact name AND exact shape, same reasoning as the
 *  hex digest pin above: neither half is safe alone. */
const PNPM_PATCH_HASH_RE = /^[a-z2-7]{26}$/;

/** BLO-46448: an Alertmanager/Prometheus alert name — `VaultTLSProbeUnreachable`
 *  — in an `amtool silence add` matcher, as written into the alert rules' own
 *  runbook text on onprem-k8s. It scores 3.94 bits/char, and every agent push
 *  touching a rules file carrying that line was refused.
 *
 *  UpperCamelCase words, optionally with an acronym run of up to 5 capitals
 *  before the next word (`TLS`, `API`). Name-anchored on purpose, like the
 *  patch_hash pin: shape alone was measured and declined. Through the entropy
 *  floor, 500k random values per shape, the bare shape passes ~22% of
 *  mixed-case letters-only tokens; adding lowercase-run and acronym bounds
 *  still left ~1.4e-3 at 24 chars, above this file's accepted band.
 *
 *  PEN-3920 (D4): each word may carry a trailing digit run of at most 2, and
 *  the value at most ALERT_NAME_MAX_DIGIT_RUNS runs overall. The digit tail is
 *  on the ACRONYM branch too, with the lookahead re-anchored after it — without
 *  that, `V6` and `HTTP2` have no lowercase run to attach to and the rule
 *  reaches neither of the measured names. A lowercase tail after a digit run
 *  was measured and DECLINED: ~1.6x the residual to buy one corpus member.
 *
 *  THE RESIDUAL THIS ANCHOR CARRIES — the number a future reader widening this
 *  rule needs most (PEN-3920 section 6.5). Under an anchored name this shape
 *  exonerates 2.33e-1 of random mixed-case LETTERS-ONLY tokens at 24 chars.
 *  That is not a typo and it is not closed by the digit bound: a letters-only
 *  token has no digits to bound, so D4 leaves that column unchanged. What
 *  makes it acceptable is the name anchor and nothing else (PEN-3920 section
 *  4): this file guards ACCIDENTAL disclosure, and an accidental leak does not
 *  choose its binding name — the name comes from whatever code interpolated
 *  the value. Widen the SHAPE here if the measurement supports it; do not
 *  widen the NAME set without re-reading that section, and never move this
 *  shape into a name-free rule. For scale, on digit-bearing alphabets D4 moves
 *  the residual from 4.01e-3 to 1.81e-2 (base62 at 24 chars). */
const ALERT_NAME_RE = /^(?:[A-Z][a-z]+\d{0,2}|[A-Z]{1,5}\d{0,2}(?=[A-Z][a-z]))+$/;

/** PEN-3920 (D4): how many digit runs a name-anchored identifier may carry.
 *  The per-word bound above caps each run at 2 characters but says nothing
 *  about how MANY runs a value holds, so without this a value alternating
 *  short letter runs with 2-digit runs stays exonerated. Two is what the
 *  measured corpus needs (`Vlan1...V6...` carries exactly two). */
const ALERT_NAME_MAX_DIGIT_RUNS = 2;

/** PEN-3920 (D5): a Prometheus `job` label value — lowercase snake_case words,
 *  each optionally carrying a trailing digit run of at most 2, at least two
 *  segments. Routed through the NAME anchor, deliberately, rather than through
 *  isLexicalIdentifier: that rule is name-free, so raising its mixed-segment
 *  cap to reach this value was measured at a consistent 4x widening under every
 *  binding name in the fleet, and is REFUSED (PEN-3920 section 6.3).
 *
 *  Residual: lower than the CamelCase row above, because the alphabet is one
 *  case and the separator is mandatory — a random lowercase token carries no
 *  underscore, so it fails the two-segment floor before any other conjunct is
 *  reached. The digit-run cap applies here too.
 *
 *  The digit run is a TAIL only, matching the shape D4 approved and measured.
 *  So a word carrying an INTERIOR digit (`orc8r`, `i18n`) does not match here
 *  — deliberately. Those are already reached by isLexicalIdentifier via
 *  MIXED_LEXICAL_SEGMENT_RE, which admits one such segment under any name;
 *  what this rule adds is the case that rule refuses, a value carrying TWO
 *  mixed segments (`vlan1` and `v6`). Widening the tail to `[a-z]*` was
 *  declined for the CamelCase rule on measurement and is not taken here on
 *  the same caution — it has not been measured for this alphabet. */
const JOB_NAME_RE = /^[a-z]+\d{0,2}(?:_[a-z]+\d{0,2})+$/;

/** BLO-47509: a Kubernetes kind — `ValidatingAdmissionPolicy` — in a PromQL
 *  label selector or a kubectl example, as onprem-k8s rule tests write it.
 *  Kinds are the same UpperCamelCase shape as alert names, so this reuses
 *  ALERT_NAME_RE under the same name-anchored trade: the residual is the one
 *  measured on BLO-46448, now reachable under one more exact name.
 *
 *  PEN-6163 added the onprem-k8s lockstep guard tests' assertion kwarg: a
 *  guard test asserts that a script prints a given alert name, and the alert
 *  name is the literal it has to spell out. Same shape, same trade, one more
 *  exact name.
 *
 *  ⚠️ This one is a WEAKER name anchor than the two above, and the difference
 *  is recorded rather than smoothed over. `alertname` and `kind` are TYPED
 *  bindings: the name itself constrains what the value may legitimately be, so
 *  the name and the shape agree. The assertion kwarg is UNTYPED — it means
 *  only "whatever this test expects to find in some output", which puts no
 *  constraint of its own on the value. So here the SHAPE anchor carries the
 *  whole trade and the name anchor only narrows where it applies.
 *
 *  What makes that acceptable is that the shape anchor is the half that was
 *  measured, and it is unchanged. Residual under this name, 200k random values
 *  per cell against the shipped rule, at 24 / 32 / 40 chars:
 *
 *    letters-only, mixed case ..... 2.28e-1 / 2.22e-1 / 2.14e-1
 *    base62 ....................... 1.80e-2 / 6.37e-3 / 2.14e-3
 *    base64url .................... 7.32e-3 / 1.92e-3 / 5.05e-4
 *    lowercase hex ................ 0 / 0 / 0   (0 of 600k)
 *
 *  The base62 column reproduces the 1.81e-2 D4 already records above, which is
 *  the cross-check that this is the same measurement and not a new one. The
 *  letters-only column is the adversarial worst case and is the number to
 *  quote when arguing against this exemption; it is also the alphabet no key,
 *  token or digest is issued in. The alphabets an ACCIDENTAL paste actually
 *  arrives in are the lower three, and hex — the shape of every digest and
 *  most generated secrets here — is exonerated at zero.
 *
 *  ⛔ Do NOT generalise this to a `want_*` prefix or a `*_SELECTOR` suffix.
 *  That is the `/Id$/` cleanup declined for UUID_VALUE_NAMES below, in the
 *  same shape: a pattern would exonerate `want_token`, `want_secret` and
 *  `API_KEY_SELECTOR`, where an UpperCamelCase value may genuinely be the
 *  credential. Exact names, one at a time, each on a measured false positive.
 *  A test pins those as still refused so the generalisation cannot land
 *  silently. */
const CAMEL_CASE_VALUE_NAMES = new Set(["alertname", "kind", "want_in_output"]);

/** PEN-3920 (D5): names whose values take the snake_case identifier shape.
 *  Separate from CAMEL_CASE_VALUE_NAMES because the shapes differ; the
 *  name-anchored trade is the same one. */
const SNAKE_CASE_VALUE_NAMES = new Set(["job"]);

/** BLO-51639: a blackbox-exporter module name in a `module="…"` matcher —
 *  `dns_amtrelay_pool_answer_shred197_v6` — as onprem-k8s probe rule tests
 *  write it. Same snake_case shape as JOB_NAME_RE, but the digit tail is up to
 *  3: module names carry a 3-digit source suffix (`cast192`, `shred197`), which
 *  `job`'s 2-digit tail refuses. Kept under its own name rather than widening
 *  `job`. Measured through the entropy floor, 200k random [a-z0-9_] tokens per
 *  length: 3.86e-4 / 3.00e-5 / 5.00e-6 at 24 / 32 / 40 chars, against `job`'s
 *  3.46e-4 / 2.50e-5 / 0 — about 1.1x the residual already accepted there.
 *  The digit-run cap still applies. */
const BLACKBOX_MODULE_RE = /^[a-z]+\d{0,3}(?:_[a-z]+\d{0,3})+$/;

/** PEN-6152: a Paperclip error-code label value, as a PromQL matcher in a
 *  runbook, an alert rule or a dashboard JSON has to spell it — the value is
 *  a fixed constant emitted by paperclip-api, so the refusal's standard advice
 *  (derive it at runtime) is unavailable, and no allowlist exists by design
 *  (docs/security/PEN-3920-egress-entropy-identifier-decision.md).
 *
 *  Measured false positive: ONE value out of the 140 distinct error codes in
 *  this repo. A code is refused only when it clears HIGH_ENTROPY_MIN_LENGTH,
 *  draws two character classes (so it must carry a digit — a digit-free
 *  snake_case value scores one class and never reaches the entropy test), and
 *  carries TWO segments over LEXICAL_LONG_SEGMENT_LENGTH. The fleet's codes
 *  are `<subsystem>_<what failed>`, and the subsystem prefix is where the
 *  digit lives, so this combination is a property of the naming convention
 *  rather than an accident.
 *
 *  Routed through the NAME anchor, deliberately. The one conjunct standing in
 *  the way is `isLexicalIdentifier`'s long-segment count, and relaxing it
 *  there is REFUSED on measurement: `longSegments > 2` exonerates 20000/20000
 *  random mixed-case letters-only tokens at every two-word split from 11+13 to
 *  15+15 (24–30 characters, ~137 bits), under EVERY binding name in the fleet,
 *  against 0/20000 today. That is the 23%-leaky shape PEN-3920 D1 already
 *  declined, at 100%. Keying the relaxation on equal-length segments does not
 *  rescue it: it blocks only the uniform column (15+15) and leaves 11+13,
 *  12+14, 14+16 and 16+14 at 20000/20000.
 *
 *  SHAPE: the union of whatever `job` admits and `isLexicalIdentifier`'s own
 *  segment grammar with ONE aggregate cap lifted — `longSegments > 1`, the
 *  conjunct this row exists to get past. The other aggregate cap is NOT
 *  lifted: LEXICAL_IDENTIFIER_MAX_CONTENT_LENGTH is re-imposed, at a value
 *  sized to this population, as ERROR_CODE_MAX_CONTENT_LENGTH below. The
 *  per-segment bound LEXICAL_SEGMENT_MAX_LENGTH is a shape bound and is also
 *  KEPT, so a single opaque run cannot hide between underscores. Written as a
 *  union with JOB_NAME_RE so non-regression against the `job` shape is a
 *  property of the code and needs no corpus.
 *
 *  Residual, 200k random `[a-z0-9_]` tokens per length through the whole door,
 *  one token set paired across every arm: 1033 / 32 / 1 per 200k at 24 / 32 /
 *  40 characters, against `job`'s 956 / 28 / 1 on the same tokens — 1.08x /
 *  1.14x / 1.0x, the band BLO-51639 already accepted for `module` (~1.1x).
 *  Nothing moves under any other name: the disjunct below is gated on the
 *  exact name, and the measured `val` column is unchanged to the count.
 *
 *  ⚠ That residual is measured over a population that CANNOT CONTAIN the worst
 *  shape, and must not be read as bounding it. A random `[a-z0-9_]` token of
 *  any length carries many digit runs, so ALERT_NAME_MAX_DIGIT_RUNS refuses it
 *  before this rule is consulted; the shape that gets through is PURE LOWERCASE
 *  LETTERS under one digit-bearing prefix, which that alphabet draws with
 *  negligible probability. Measured separately, through the whole door, 200
 *  values per width: `k8s_` + N random 16-letter segments, refused 0/200 at
 *  every N from 1 to 8 — up to 139 characters, ~602 bits — while the same
 *  values are refused 200/200 under a bare name from N=3 and 188/200 under
 *  `job` at N=2. ERROR_CODE_MAX_CONTENT_LENGTH is what bounds that arm.
 *
 *  ⛔ The digit-run cap above still applies and is load-bearing, but it bounds
 *  only the MIXED segments: a mixed segment must carry a digit run, so
 *  ALERT_NAME_MAX_DIGIT_RUNS bounds how many of THOSE a value may hold. It
 *  says nothing about PLAIN segments, which carry no digit run at all and were
 *  therefore unbounded in both count and total length until the content cap
 *  below was added. Do not move this call out from under the digit-run gate,
 *  and do not read that gate as an aggregate entropy bound. And do not add a
 *  second name on the strength of this one —
 *  `errorCode`, `reason` and `code` are NOT here, because no false positive has
 *  been measured under them. Exact names, one at a time, each on a measured
 *  case; see UUID_VALUE_NAMES for why the obvious generalisation is the change
 *  to decline. */
const ERROR_CODE_VALUE_NAMES = new Set(["error_code"]);

/** PEN-6152: aggregate bound on the segment-grammar arm below, standing in for
 *  the LEXICAL_IDENTIFIER_MAX_CONTENT_LENGTH that arm lifts. Sized to the live
 *  population rather than guessed: 153 distinct error codes in this repo, p50
 *  21, p90 30, p99 36, longest 38 (`routine_execution_duplicate_suppressed`),
 *  most segments 6. 48 clears the longest by ten characters — about one more
 *  word — and bounds the plain-segment tail measured above.
 *
 *  Chosen on the failure DIRECTIONS, not on the headroom alone: a code that
 *  outgrows this cap is REFUSED, which is loud, lands on the author at push
 *  time and is recoverable by widening a number here; an uncapped exoneration
 *  is SILENT and nothing ever reports it. Prefer the loud direction. */
const ERROR_CODE_MAX_CONTENT_LENGTH = 48;

function isErrorCodeValue(value: string): boolean {
  if (JOB_NAME_RE.test(value)) return true;
  if (value.length > ERROR_CODE_MAX_CONTENT_LENGTH) return false;
  if (!/^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(value)) return false;
  const segments = value.split("_");
  if (segments.some((s) => s.length > LEXICAL_SEGMENT_MAX_LENGTH)) return false;
  return segments.every((s) => LEXICAL_SEGMENT_RE.test(s) || MIXED_LEXICAL_SEGMENT_RE.test(s));
}

/** BLO-50225: an orc8r network id — a canonical lowercase UUID — spelled out
 *  in a Prometheus label matcher (`networkID="…"`), which cannot derive it at
 *  runtime. A UUID is opaque by design and stays refused under every other
 *  name; this exempts exactly the 8-4-4-4-12 hex layout under exactly these
 *  names, so a non-UUID token under one of them is still refused.
 *
 *  PEN-5406 added `companyId`: a Paperclip company id, written into a control
 *  plane URL and into the issue prose that cites one. Same terms — an exact
 *  name, on a measured false positive.
 *
 *  ⛔ Do NOT generalise this to a `/Id$/` pattern. It reads as the obvious
 *  cleanup and is precisely the change to decline: it would exonerate
 *  `sessionId`, `tokenId`, `apiKeyId` and `secretId`, and a UUID genuinely IS
 *  the credential wherever session ids or API keys are issued as UUIDs. Exact
 *  names, one at a time, each on a measured false positive. A test pins those
 *  four as still refused so the generalisation cannot land silently. */
const UUID_VALUE_NAMES = new Set(["companyId", "networkID"]);
const CANONICAL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Digit runs in a value, for the bound above. */
function digitRunCount(value: string): number {
  return (value.match(/\d+/g) ?? []).length;
}

/** BLO-46892: a git commit pin, `rev=<40 lowercase hex>`, as Nix flake inputs
 *  write it (`git+ssh://...?ref=main&rev=<sha>`). A flake input must be a
 *  literal URL, so there is no way to keep the SHA out of the pushed blob, and
 *  every pin bump was refused. Exact name AND exact shape: a 40-hex value
 *  under an unanchored name, or a non-hex value under an anchored one, stays
 *  subject to the entropy test. */
const GIT_COMMIT_SHA_RE = /^[0-9a-f]{40}$/;

/** PEN-5406: the names a git object id is actually bound to. BLO-46892
 *  anchored the shape to the single literal `rev`, which is the Nix spelling
 *  and almost nothing else's: a commit SHA refused under `ref=`, `sha=`,
 *  `commit=`, `head=` and `headRefOid=` — the GitHub REST query parameter, the
 *  GraphQL field, and the shell assignment that every workflow and review
 *  attestation writes. `DIGEST_NAME_RE` does not reach them either; it
 *  requires a bit-length suffix (`sha256`, `sha1`), so even `commit_sha`
 *  refused.
 *
 *  Measured against the shipped detector, 20k uniform 40-hex values: 95.3%
 *  refuse under an unanchored name. So this is a real and near-universal false
 *  positive, not a tail case — but note it is the ENTROPY FLOOR doing that
 *  work, not the shape, and the remaining 4.7% already passed under every
 *  name. The name set is widened; `GIT_COMMIT_SHA_RE` and the floor are not.
 *
 *  The residual is stated precisely, and the shape argument for it is NOT
 *  sound: a legacy GitHub personal access token is exactly 40 lowercase hex
 *  with no prefix, and `VENDOR_KEY_RE` keys on `ghp_` / `github_pat_` / `sk-`
 *  / `xox*` / `glpat-`, so it does not see one. For that token the entropy
 *  rule is the only net, and under these names it is now off. What makes the
 *  residual acceptable is the NAME half alone: no credential is plausibly
 *  pasted under `ref=` or `headRefOid=`. It would not be acceptable as a
 *  shape-only exemption, and must not be widened into one. */
const GIT_OBJECT_NAME_VALUE_NAMES = new Set([
  "base",
  "baseRefOid",
  "base_sha",
  "commit",
  "commit_sha",
  "head",
  "headRefOid",
  "head_sha",
  "oid",
  "ref",
  "rev",
  "sha",
]);

/** PEN-4438 (D7): a Kubernetes object name, or an in-cluster DNS name, as a
 *  `PrometheusRule` label matcher writes it — `pod`, `name`, `instance`,
 *  `cronjob`. Kubernetes appends GENERATED segments to the names it creates
 *  (a ReplicaSet's pod-template-hash, a pod's 5-character suffix, a CronJob
 *  run's epoch index), and `isLexicalIdentifier` admits at most ONE segment
 *  that mixes letters and digits, under a 2-digit run and a summed-content cap
 *  of 30. Every k8s-generated name of any size fails at least one of those, so
 *  a PromQL expression pinning a pod or a service was unpushable.
 *
 *  Name-anchored, like the CamelCase and snake_case rules above and for the
 *  reason PEN-3920 section 4 states: this file guards ACCIDENTAL disclosure,
 *  and an accidental leak does not choose its binding name. The alternative —
 *  relaxing `isLexicalIdentifier`'s caps, which is where these values fail —
 *  is name-FREE and so reaches every binding name in the fleet. That is the
 *  trade PEN-4425 measured at 4x and REFUSED, and it is refused again here.
 *
 *  THE SHAPE, and why each conjunct is load-bearing. A value is admitted when
 *  it is a DNS-1123 subdomain (lowercase alnum, `-` inside a label, `.`
 *  between labels) whose hyphen-separated segments split into:
 *
 *   - WORD segments, letters only. Their summed length must reach
 *     K8S_NAME_MIN_WORD_MASS. This single conjunct does nearly all the work:
 *     without it the rule exonerates 3.5e-2 of random segmented lowercase
 *     tokens, with it 2.9e-3 to 9.9e-3 (table below). It is also what keeps
 *     real credential FORMATS out — none carries 16 characters of lowercase
 *     letter runs: `sk-ant-api03-…` musters 5, `xoxb-…` 4, `sk_live_…` 6.
 *   - NUMBER segments, digits only. Free — a digit run carries no alphabet.
 *   - GENERATED segments, anything else. At most
 *     K8S_NAME_MAX_GENERATED_SEGMENTS of them, each at most
 *     K8S_NAME_MAX_GENERATED_LENGTH, summing to at most
 *     K8S_NAME_MAX_GENERATED_MASS. This is the opaque mass the rule admits.
 *
 *  THE RESIDUAL. 200,000 random values per family, fraction NEWLY exonerated
 *  under one of the four anchored names (varying-length segment generators —
 *  PEN-4425 records that fixed-length ones make a cap look free because the
 *  uniform-length check in `isLexicalIdentifier` absorbs the difference):
 *
 *    base62 @24/@32, base64url @24/@43, base32 @32, lowercase hex @32/@40,
 *    mixed-case letters @24, UUID v4 layout ......................... 0 each
 *    base36, 4-6 varying groups of 2-8, `-` ...................... 9.54e-3
 *    base36, 3-5 varying groups of 3-7, `-` ...................... 5.39e-3
 *    base36, 2-4 varying groups of 4-10, `-` ..................... 2.93e-3
 *    base36, 3-4 varying groups of 3-9, `.` ...................... 2.96e-3
 *    k8s suffix alphabet, 3-5 varying groups of 3-9, `-` ......... 9.85e-3
 *
 *  THE k8s SUFFIX ALPHABET IS `bcdfghjklmnpqrstvwxz2456789` — 20 consonants
 *  and 7 digits, vowels and ambiguous glyphs removed. It is
 *  `k8s.io/apimachinery/pkg/util/rand`'s `alphanums`, which is what the
 *  apiserver draws a generated name suffix from. Recorded here because it
 *  appears nowhere in this repository, so the row above was the one published
 *  figure that could not be reproduced from the tree alone — PEN-3920 6.5 now
 *  requires that every published residual generator can be, and that a
 *  borrowed alphabet names its source.
 *
 *  ⛔ PEN-5828: THE ROW ABOVE IS A FAMILY AVERAGE over 3/4/5 groups, whose
 *  bins are not equally reachable — measured population 0.161 / 0.793 / 0.988,
 *  the low bin starved by the same HIGH_ENTROPY_MIN_LENGTH floor that starves
 *  `isGitRefName`'s. Per shape the worst is FIVE groups at 1.99e-2, 95% CI
 *  [1.92e-2, 2.06e-2] on 2988 of 150,000 trials; 2.02e-2 [1.94e-2, 2.09e-2]
 *  against the population denominator. Dilution 2.06x. The mixture itself
 *  re-measures at 9.68e-3 against the 9.85e-3 published, so that figure is
 *  sound — it is the SHAPE it averages over that was missing.
 *
 *  ⚠ MEASURE THIS UNDER AN ANCHORED NAME THAT IS NOT `pod`. `pod` additionally
 *  carries `isGeneratedPodName` (PEN-5921), so anchoring a re-measurement
 *  there reports the UNION of two rules and not this one: the same sweep reads
 *  1.43e-2 under `pod` against 9.68e-3 under `instance`, and the whole gap is
 *  the other rule. The populations are identical either way, so nothing in the
 *  output says which rule you measured.
 *
 *  Every FLAT token family is zero: a credential is one opaque run, and one
 *  run reaches neither the word mass nor the segment floor. Also measured: 28
 *  real credential formats (GitHub PAT classic and fine-grained, Slack, Stripe,
 *  AWS id and secret, Google, Anthropic, OpenAI, Vault, GitLab, npm, Grafana,
 *  JWT, base32 TOTP seed, k8s bootstrap token, UUID, raw hex and base64 blobs),
 *  20,000 synthesized samples each — 0 of 560,000 newly exonerated.
 *
 *  What this DOES admit, stated plainly because the number is large: a value
 *  built as real dictionary words glued to an opaque tail — `<16+ chars of
 *  words>-<8-10 opaque>` — is exonerated at ~5e-1. That shape is not separable
 *  from a genuine k8s name by structure, because a genuine k8s name IS words
 *  plus a generated suffix; no further conjunct closes it. It is a DELIBERATE
 *  construction, which PEN-3920 section 4 and PEN-3183 put outside this
 *  control's threat model, and the opaque mass it admits — at most 16
 *  lowercase-alnum characters, ~83 bits — is LESS than the ~141 bits
 *  `isLexicalIdentifier` already exonerates under EVERY name (three 10-letter
 *  random segments, hyphenated, is clean today). The name anchor is what
 *  carries this rule; the shape alone was never going to.
 *
 *  THE CORPUS. 556 distinct `pod` values, 145 `name`, 58 `instance`, 39
 *  `cronjob` across Blockcast/onprem-k8s, Blockcast/paperclip and
 *  Blockcast/penstock-llm-proxy-core: 262 are refused today and this rule
 *  exonerates 204 of them, every one an ordinary Kubernetes name. Loosening
 *  to 3 generated segments and a mass of 21 — the corpus maxima — buys three
 *  more values, so the caps sit at the knee.
 *  Held against the same corpus, the four-name anchor withholds this shape
 *  from 23 other binding names that would gain it under a name-free rule,
 *  among them `uid`, `evidence`, `claim` and `RULE_ID`.
 *
 *  Do not widen the NAME set without re-reading PEN-3920 section 4, and never
 *  move this shape into a name-free rule. */
const K8S_DNS_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
/** Longest value admitted. The longest real name in the corpus above is 61. */
const K8S_NAME_MAX_LENGTH = 64;
/** Dot-separated labels. A Service address reaches five —
 *  `<service>.<namespace>.svc.cluster.local` — and that is the corpus maximum. */
const K8S_NAME_MAX_LABELS = 5;
/** Summed length of the letters-only segments. 16 is the conjunct that holds
 *  this rule: the corpus minimum is 16 exactly (a CronJob self-test name
 *  musters 17), so there is one character of headroom and raising it to 18
 *  would drop that value. */
const K8S_NAME_MIN_WORD_MASS = 16;
/** A pod carries two generated segments — the ReplicaSet's pod-template-hash
 *  and its own suffix — and nothing in the corpus needs a third under the
 *  mass bound below. */
const K8S_NAME_MAX_GENERATED_SEGMENTS = 2;
/** Widest generated segment: a pod-template-hash is up to 10 characters. */
const K8S_NAME_MAX_GENERATED_LENGTH = 10;
/** Total opaque mass. This is the entropy budget the rule spends; see the
 *  residual note above for what it buys and what it costs. */
const K8S_NAME_MAX_GENERATED_MASS = 16;
/** PEN-5921: the alphabet Kubernetes itself draws generated segments from —
 *  `alphanums` in k8s.io/apimachinery/pkg/util/rand, used by `rand.String`
 *  for a pod's suffix and by `rand.SafeEncodeString` for a ReplicaSet's
 *  pod-template-hash. It is deliberately VOWEL-FREE and also drops `0`, `1`,
 *  `3` and `y`, so it is 27 symbols wide rather than base36's 36. That is
 *  what makes it a real conjunct and not decoration: a hex or base36 payload
 *  only wears it by accident at (11/16)^15 and (27/36)^15 respectively.
 *  Measured on a live 1054-pod cluster: 1215/1470 generated segments conform,
 *  and every non-conformer is an ARC runner name embedding UUID fragments,
 *  which this rule declines on word mass anyway. */
const K8S_GENERATED_SEGMENT_RE = /^[bcdfghjklmnpqrstvwxz2456789]+$/;
/** A pod's own suffix is exactly this wide — `randomLength` in
 *  k8s.io/apiserver/pkg/storage/names. Fixed, not a range. */
const K8S_POD_SUFFIX_LENGTH = 5;
/** A pod-template-hash as `rand.SafeEncodeString` emits it. The upper bound is
 *  K8S_NAME_MAX_GENERATED_LENGTH; the lower one is what keeps a short opaque
 *  run from standing in for a hash.
 *
 *  ⚠ PEN-5921: 8 is OUR floor, not the emitter's minimum, and the sentence
 *  above was read as claiming otherwise. `ComputeHash` ends in
 *  `rand.SafeEncodeString(fmt.Sprint(hasher.Sum32()))`; `fmt.Sprint` of a
 *  uint32 is its DECIMAL form, 1-10 digits, and SafeEncodeString is
 *  length-preserving, so the width emitted IS that digit count. 10^7/2^32 of
 *  hash values — about 1 in 429 — are 7 characters or fewer, and those pods
 *  stay refused by this bound. Direction is over-redaction, not a leak: the
 *  push fails closed and the author sees a false positive. The bound stays
 *  anyway, because lowering it lets any short opaque run stand in for a hash,
 *  which is the whole thing it exists to stop. A live 1045-pod corpus carried
 *  no sub-8 hash, which at p = 0.0023 over ~1470 generated segments is the
 *  expected outcome (P(none) ~ 3%), so the arithmetic is the authority here
 *  and the corpus is weak evidence either way. */
const K8S_POD_TEMPLATE_HASH_MIN_LENGTH = 8;
/** Word mass demanded of a name admitted by the LAYOUT rule below. Half the
 *  general floor, and the price this rule pays; see the residual note. */
const K8S_GENERATED_LAYOUT_MIN_WORD_MASS = 8;
/** Widest MID-NAME generated segment admitted without the alphabet conjunct.
 *  A segment that is neither the suffix nor the pod-template-hash is part of
 *  the service name a human chose — `ipv6`, `e2e`, `orc8r` — and those are
 *  short. Measured across the 89 live names this rule frees: every mid-name
 *  generated segment is either <= 5 characters or already conforms to the k8s
 *  alphabet, so this cap costs nothing and stops a 10-character unconstrained
 *  run from riding along behind a word. */
const K8S_INLINE_GENERATED_MAX_LENGTH = 5;
/** PEN-6046: how much MID-NAME opaque mass the layout rule admits once the
 *  pod-template-hash and the 5-character suffix are taken out of the budget.
 *  One segment of at most K8S_LAYOUT_MAX_INLINE_MASS characters: that is what
 *  a version or product token inside a chosen service name looks like —
 *  `orc8r`, `v6`, `k8s`, `ds74`. Measured on a live 1045-pod cluster, raising
 *  either bound frees no further name, so the caps sit at the knee. */
const K8S_LAYOUT_MAX_INLINE_SEGMENTS = 1;
const K8S_LAYOUT_MAX_INLINE_MASS = 5;
/** PEN-4438 (D7): names whose values take the Kubernetes object-name shape.
 *  BLO-49591 added `namespace` (a DNS-1123 label, e.g. a preview namespace
 *  carrying an issue number) and `node` / `host_name` (a node name, as
 *  kube-state-metrics and node-exporter label it). Same shape, same
 *  conjuncts; a credential-shaped value under these names is still refused.
 *  BLO-49668 added `job_name` (kube-state-metrics' Job object name, i.e.
 *  `<cronjob>-<scheduled-time>`). BLO-56073 added `anchor` / `target`: an
 *  xml2rfc section anchor and the `<xref target=...>` naming it are kebab-case
 *  slugs of the same shape (`test-vectors-bc-provenance-version-2`). */
const K8S_OBJECT_NAME_VALUE_NAMES = new Set([
  "anchor",
  "cronjob",
  "host_name",
  "instance",
  "job_name",
  "name",
  "namespace",
  "node",
  "pod",
  "target",
]);

/** BLO-56073: an Internet-Draft name, as xml2rfc binds it in
 *  `<seriesInfo name="Internet-Draft" value="draft-...-01"/>` and
 *  `<rfc docName="draft-...-02">`. The literal
 *  `draft-` prefix, kebab-case words and a two-digit revision are the I-D
 *  naming rule; `value` is too generic a name to take the Kubernetes rule. */
const INTERNET_DRAFT_NAME_VALUE_NAMES = new Set(["docName", "value"]);
const INTERNET_DRAFT_NAME_RE = /^draft-[a-z0-9]+(?:-[a-z0-9]+)+-\d{2}$/;

interface K8sNameParts {
  /** Every hyphen-separated segment, in order, across every dot-label. */
  segments: string[];
  wordMass: number;
  generatedSegments: number;
  generatedMass: number;
}

/** Split a value into the segment classes the rules below score, or null when
 *  it is not a DNS-1123 subdomain within the structural caps at all. Shared so
 *  that the layout rule cannot drift from the general rule's shape gate.
 *
 *  PEN-6046: this is the STRUCTURE only. The generated-segment budget lives in
 *  `k8sNameParts` below, because the two rules price it differently — see
 *  `k8sGeneratedLayoutBudgetOk`. Everything that decides whether a value is a
 *  Kubernetes name AT ALL, and how its segments classify, stays here so that
 *  neither rule can drift from the other on the part that is not a trade. */
function k8sNameSegments(value: string): K8sNameParts | null {
  if (value.length > K8S_NAME_MAX_LENGTH) return null;
  const labels = value.split(".");
  if (labels.length > K8S_NAME_MAX_LABELS) return null;
  const segments: string[] = [];
  let wordMass = 0;
  let generatedSegments = 0;
  let generatedMass = 0;
  for (const label of labels) {
    if (!K8S_DNS_LABEL_RE.test(label)) return null;
    for (const segment of label.split("-")) {
      segments.push(segment);
      if (/^[a-z]+$/.test(segment)) {
        wordMass += segment.length;
        continue;
      }
      if (/^[0-9]+$/.test(segment)) continue;
      if (segment.length > K8S_NAME_MAX_GENERATED_LENGTH) return null;
      generatedSegments += 1;
      generatedMass += segment.length;
    }
  }
  return { segments, wordMass, generatedSegments, generatedMass };
}

/** The structure above, plus the GENERAL rule's generated-segment budget. */
function k8sNameParts(value: string): K8sNameParts | null {
  const parts = k8sNameSegments(value);
  if (parts === null) return null;
  if (parts.generatedSegments > K8S_NAME_MAX_GENERATED_SEGMENTS) return null;
  if (parts.generatedMass > K8S_NAME_MAX_GENERATED_MASS) return null;
  return parts;
}

/** True when a value is a Kubernetes object name or in-cluster DNS name. */
function isKubernetesObjectName(value: string): boolean {
  const parts = k8sNameParts(value);
  return parts !== null && parts.wordMass >= K8S_NAME_MIN_WORD_MASS;
}

/** PEN-5921: true when a value wears the layout a Kubernetes POD CONTROLLER
 *  emits, as opposed to merely scoring enough word mass to look like one.
 *
 *  WHY A SECOND RULE RATHER THAN A LOWER FLOOR. The general rule above prices
 *  admission in word mass, and a generated pod name spends its length on the
 *  pod-template-hash and the 5-character suffix — so a SHORT service name
 *  cannot reach the floor however real it is. `llm-proxy-7d4f9bc85x-k2mnp`
 *  musters 8 and is refused while the 40-character
 *  `penstock-llm-proxy-core-7d4f9bc85x-k2mnp` passes: length is not the
 *  discriminator in either direction. Measured against a live 1054-pod
 *  cluster, the shipped rule refuses 209 of them under `pod=`; this rule
 *  frees 89 and newly blocks none.
 *
 *  Re-measured 2026-11-07 (PEN-6046) on an independent 1045-name snapshot of
 *  the same cluster, every name through the WHOLE pipeline as `pod="<name>"`:
 *  pre-PEN-5921 refuses 200 (19.1%), this rule takes it to 110 (10.5%), and
 *  k8sGeneratedLayoutBudgetOk below takes it to 51 (4.9%). Neither step
 *  newly blocks a name.
 *
 *  Lowering K8S_NAME_MIN_WORD_MASS to 12 was the obvious knob and is REFUSED.
 *  It is name-free in effect — it reaches all eight anchored names — and it
 *  multiplies the escape rate of exactly the shape real API keys take:
 *  measured per 100k random tokens wearing a hyphenated layout, 10 -> 767 for
 *  hex and 3876 -> 22518 for base36. It unblocks 73 of the 209 live names and
 *  buys that with a 5.8x residual on the family that matters.
 *
 *  THE SHAPE. On top of every conjunct the general rule already applies, a
 *  value is admitted here when its trailing segments are the two layouts a
 *  controller actually emits —
 *
 *    <words>-<pod-template-hash 8-10>-<suffix 5>   Deployment / ReplicaSet
 *    <words>-<suffix 5>                            DaemonSet / Job / bare pod
 *
 *  — the suffix and the pod-template-hash are drawn from
 *  K8S_GENERATED_SEGMENT_RE, any wider mid-name generated segment is too
 *  (K8S_INLINE_GENERATED_MAX_LENGTH), and the word mass reaches
 *  K8S_GENERATED_LAYOUT_MIN_WORD_MASS.
 *
 *  What the two POSITIONAL segments cost is priced separately, in
 *  k8sGeneratedLayoutBudgetOk — read that next. PEN-6046 measured that the
 *  general rule's budget, applied to them, refused most real Deployment pods
 *  BEFORE any conjunct listed here was consulted.
 *
 *  Both alphabet conjuncts are FREE on the live cluster: they cost zero real
 *  names out of the 89 this rule frees, and they are what keep the rule from
 *  being a blanket exemption for its own layout. Measured per 100k random
 *  tokens through the WHOLE pipeline under `pod=`, shipped -> patched:
 *
 *    <w8>-<hash10 hex>-<suffix5 hex> ............... 3697 -> 4105
 *    <w8>-<hash10 base36>-<suffix5 base36> ......... 3807 -> 5127
 *    <w8>-<10 base36>-<word>-<suffix5 k8s> ........ 25138 -> 29259
 *    flat base36 @32 / hex @40 / 3-5 groups ....... unchanged
 *
 *  Without the mid-name conjunct that third row reads 99895: a 10-character
 *  unconstrained run sitting behind a trailing word wears the layout without
 *  paying for it, and that is the hole the cap closes.
 *
 *  THE RESIDUAL, stated plainly because it is large and it is the price.
 *  A value DELIBERATELY built as `<8+ letters>-<10>-<5>` with both opaque
 *  runs drawn from the k8s alphabet is exonerated BY CONSTRUCTION — 99873
 *  per 100k, essentially everything that wears the shape. The alphabet
 *  conjuncts buy nothing against an author who CHOOSES that alphabet; they
 *  buy the rows above only against ACCIDENTAL disclosure, which is the threat
 *  this file guards (PEN-3920 section 4, PEN-3183) and the reason the trade
 *  is accepted. The opaque mass admitted is unchanged at
 *  K8S_NAME_MAX_GENERATED_MASS: worst case 10 characters over the 27-symbol
 *  alphabet plus a 5-character suffix, ~71 bits — BELOW the ~83 bits the
 *  general rule already admits at word mass 16, and well below the ~141 bits
 *  `isLexicalIdentifier` exonerates under every name in the fleet.
 *
 *  ⛔ PEN-6046. This paragraph used to end `This rule does NOT raise the
 *  opaque-mass ceiling; it lowers the word-mass PRICE from 16 to 8`. True of
 *  this rule as PEN-5921 shipped it, FALSE once k8sGeneratedLayoutBudgetOk
 *  is in the path: the ceiling moves to ~97 bits. It is replaced rather than
 *  footnoted, because a reader who skims a stated design property and stops
 *  has already acted on it. The current ceiling is stated on that function.
 *
 *  WHAT IT DELIBERATELY DOES NOT FIX. A hand-written synthetic name such as
 *  `penstock-gateway-rs1-pod1` (word mass 15, one short of the general floor)
 *  stays refused: `rs1` and `pod1` are not segments any controller emits.
 *  That is a fixture author's choice and a fixture author can rename it,
 *  whereas an operator cannot rename a real pod — so the asymmetry is
 *  deliberate, and closing it would require the floor change refused above.
 *
 *  Anchored to `pod` alone. Do not widen the name set without re-reading
 *  PEN-3920 section 4, and never move this shape into a name-free rule. */
function isGeneratedPodName(value: string): boolean {
  const parts = k8sNameSegments(value);
  if (parts === null) return false;
  if (parts.wordMass < K8S_GENERATED_LAYOUT_MIN_WORD_MASS) return false;
  const { segments } = parts;
  if (segments.length < 2) return false;
  const suffix = segments[segments.length - 1]!;
  if (suffix.length !== K8S_POD_SUFFIX_LENGTH) return false;
  if (!K8S_GENERATED_SEGMENT_RE.test(suffix)) return false;
  // A digits-only run is a StatefulSet ordinal, never a generated suffix; the
  // general rule already treats it as free and must keep sole ownership of it.
  if (/^[0-9]+$/.test(suffix)) return false;
  // Every generated segment BEFORE the suffix is part of the chosen service
  // name unless it is the pod-template-hash checked below. Short ones are
  // admitted as-is; anything wider must look like something a controller
  // emitted, so an opaque run cannot hide mid-name behind a trailing word.
  for (const segment of segments.slice(0, -1)) {
    if (/^[a-z]+$/.test(segment) || /^[0-9]+$/.test(segment)) continue;
    if (segment.length <= K8S_INLINE_GENERATED_MAX_LENGTH) continue;
    if (!K8S_GENERATED_SEGMENT_RE.test(segment)) return false;
  }
  const preceding = segments[segments.length - 2]!;
  if (/^[a-z]+$/.test(preceding) || /^[0-9]+$/.test(preceding)) {
    // <words>-<suffix 5>: DaemonSet, Job, or a bare pod with generateName.
    // Only ONE positional segment is identified here, and at that width the
    // mid-name budget CANNOT reach past the general one, so this call is the
    // general budget and nothing more: path 2 admits at most
    // K8S_LAYOUT_MAX_INLINE_SEGMENTS mid-name segments massing
    // K8S_LAYOUT_MAX_INLINE_MASS, plus the suffix — 2 segments and 10
    // characters against the general rule's 2 and 16, so every value path 2
    // admits here path 1 has already admitted. The call is kept rather than
    // inlined so both branches price themselves the same way, but it buys no
    // relaxation: a DaemonSet-layout pod is freed by this rule's word-mass
    // floor, never by its budget. PEN-6046 review (#3521), pinned by
    // "does not let the daemonset branch relax the general budget".
    return k8sGeneratedLayoutBudgetOk(parts, 1);
  }
  // <words>-<pod-template-hash>-<suffix 5>. Two positional segments.
  if (preceding.length < K8S_POD_TEMPLATE_HASH_MIN_LENGTH) return false;
  if (preceding.length > K8S_NAME_MAX_GENERATED_LENGTH) return false;
  if (!K8S_GENERATED_SEGMENT_RE.test(preceding)) return false;
  return k8sGeneratedLayoutBudgetOk(parts, 2);
}

/** PEN-6046: the entropy budget the LAYOUT rule spends. Two paths, and the
 *  disjunction is deliberate and load-bearing: path 1 IS the general rule's
 *  budget, so this function can only ever ADMIT MORE than the budget shipped
 *  in #3514 — never less. That is a structural guarantee, not a measurement,
 *  and it is why the relaxation below cannot introduce a new false positive.
 *
 *  `positional` is the number of trailing segments the caller has already
 *  identified BY POSITION and pinned to K8S_GENERATED_SEGMENT_RE and to a
 *  fixed width: the suffix alone, or the pod-template-hash and the suffix.
 *
 *  WHY PATH 2 EXISTS. The general budget charges the hash and the suffix like
 *  any other opaque segment, and a real Deployment pod spends 2 of its 2
 *  permitted generated segments and 15 of its 16 permitted characters on
 *  them. One more mixed letter/digit segment anywhere in the service name —
 *  an ordinary version or product token — therefore exhausts the budget
 *  before any conjunct of the layout rule is consulted. Path 2 takes the two
 *  segments the LAYOUT has already identified out of the budget and prices
 *  only what is left, which is the part of the name a human chose.
 *
 *  WHAT WAS ACTUALLY REFUSING THESE NAMES. PEN-6046 was filed reporting the
 *  MASS cap (K8S_NAME_MAX_GENERATED_MASS) as the binding conjunct. Measured
 *  here by tagging each refusal site in this file rather than by
 *  reimplementing it, the SEGMENT-COUNT cap is the one that fires first on
 *  94 of the 101 names the shared gate refused, and the mass cap alone binds
 *  on exactly ONE. Exempting the positional segments from the mass cap only
 *  — the candidate as filed — would therefore have freed one name. Path 2
 *  exempts them from BOTH, which is why it frees 59.
 *
 *  THE CEILING, THEN AND NOW — this is the price, and it is a real one.
 *  PEN-5921 admitted at most a 10-character pod-template-hash and a
 *  5-character suffix, both over the 27-symbol K8S_GENERATED_SEGMENT_RE
 *  alphabet: 15 characters, ~71 bits. Path 2 adds up to
 *  K8S_LAYOUT_MAX_INLINE_MASS mid-name characters which are NOT
 *  alphabet-constrained (they are below K8S_INLINE_GENERATED_MAX_LENGTH, so
 *  they are admitted as-is): 20 characters, ~97 bits. That is a genuine rise
 *  and the sentence on isGeneratedPodName denying one has been withdrawn.
 *  It remains below the ~141 bits `isLexicalIdentifier` exonerates under
 *  EVERY binding name in the fleet, which is the comparison that decided it.
 *
 *  Measured per 100k random tokens through the WHOLE pipeline under `pod=`,
 *  each family drawn from its OWN seeded stream so a figure here reproduces
 *  on its own, PEN-5921 -> with this budget:
 *
 *    <w8>-<hash10 hex>-<suf5 hex> .................. 1174 ->  1174
 *    <w8>-<hash10 b36>-<suf5 b36> ................. 13182 -> 13182
 *    <w8>-<5 b36>-<hash10 b36>-<suf5 b36> ......... 20551 -> 21325
 *    <w8>-<6 b36>-<hash10 k8s>-<suf5 k8s> ......... 27972 -> 27972
 *    <w8>-<5 b36>-<hash10 k8s>-<suf5 k8s> ......... 40855 -> 99843
 *    <w8>-<5 k8s>-<hash10 k8s>-<suf5 k8s> ......... 42462 -> 99838
 *    flat b36 @32 / hex @40 / b62 @24 / groups .... unchanged
 *
 *  Row 4 is the cap doing its work: one character over
 *  K8S_LAYOUT_MAX_INLINE_MASS and path 2 declines. Rows 5 and 6 are the
 *  price, and they are the by-construction case PEN-5921 already accepted —
 *  an author who CHOOSES the k8s alphabet for both trailing runs now also
 *  gets the mid-name allowance. Rows 1-3 are the ACCIDENTAL shapes this file
 *  actually guards (PEN-3920 section 4, PEN-3183), and there the budget
 *  costs between nothing and 1.04x.
 *
 *  THE RESIDUAL. 51 of the 1045 live names stay refused, and the shared
 *  shape gate is no longer what refuses most of them: 35 fail the layout
 *  rule's own word-mass floor (`orc8r-accessd-…` musters 7, because `orc8r`
 *  scores as generated and not as a word), 9 carry a segment wider than
 *  K8S_NAME_MAX_GENERATED_LENGTH, 5 end in an 8-character `-listener`
 *  rather than a suffix, and 2 carry a mid-name segment outside the
 *  alphabet. The agent-container pods (`ac-<uuid>-<uuid>-…`) are in the
 *  first group and are genuinely uuid-dense; nothing short of the refused
 *  floor change reaches them. */
function k8sGeneratedLayoutBudgetOk(parts: K8sNameParts, positional: number): boolean {
  if (
    parts.generatedSegments <= K8S_NAME_MAX_GENERATED_SEGMENTS &&
    parts.generatedMass <= K8S_NAME_MAX_GENERATED_MASS
  ) {
    return true;
  }
  let inlineSegments = 0;
  let inlineMass = 0;
  for (const segment of parts.segments.slice(0, parts.segments.length - positional)) {
    if (/^[a-z]+$/.test(segment) || /^[0-9]+$/.test(segment)) continue;
    inlineSegments += 1;
    inlineMass += segment.length;
  }
  return (
    inlineSegments <= K8S_LAYOUT_MAX_INLINE_SEGMENTS &&
    inlineMass <= K8S_LAYOUT_MAX_INLINE_MASS
  );
}

/** True when a NAME=VALUE pair is a content digest pin rather than a secret. */
function isContentDigestAssignment(name: string, value: string): boolean {
  if (name === "patch_hash" && PNPM_PATCH_HASH_RE.test(value)) return true;
  if (digitRunCount(value) <= ALERT_NAME_MAX_DIGIT_RUNS) {
    if (CAMEL_CASE_VALUE_NAMES.has(name) && ALERT_NAME_RE.test(value)) return true;
    if (SNAKE_CASE_VALUE_NAMES.has(name) && JOB_NAME_RE.test(value)) return true;
    if (name === "module" && BLACKBOX_MODULE_RE.test(value)) return true;
    if (ERROR_CODE_VALUE_NAMES.has(name) && isErrorCodeValue(value)) return true;
  }
  if (K8S_OBJECT_NAME_VALUE_NAMES.has(name) && isKubernetesObjectName(value)) return true;
  if (INTERNET_DRAFT_NAME_VALUE_NAMES.has(name) && INTERNET_DRAFT_NAME_RE.test(value) && isKubernetesObjectName(value)) return true;
  if (name === "pod" && isGeneratedPodName(value)) return true;
  if (GIT_OBJECT_NAME_VALUE_NAMES.has(name) && GIT_COMMIT_SHA_RE.test(value)) return true;
  if (UUID_VALUE_NAMES.has(name) && CANONICAL_UUID_RE.test(value)) return true;
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

/**
 * PEN-4637: an absolute POSIX path is a filesystem location, not a credential,
 * and neither `isLexicalIdentifier` nor `GRPC_METHOD_PATH_RE` can reach one.
 *
 * `isLexicalIdentifier` splits on `[-._]` only, so a path's `/` separators
 * leave one oversized segment and it bails on LEXICAL_SEGMENT_MAX_LENGTH;
 * `GRPC_METHOD_PATH_RE` wants a dotted package then exactly one more `/`. So
 * every path long enough to clear HIGH_ENTROPY_MIN_LENGTH and carrying two
 * character classes is refused — and "derive it at runtime" is unavailable
 * when the literal is a PromQL label matcher, a systemd `ExecStart`, or a
 * runbook command a reader has to be able to paste.
 *
 * SHAPE ALONE, WITH NO NAME CONJUNCTION — and that is a deliberate departure
 * from the CamelCase / snake_case / Kubernetes rules above, so it needs the
 * argument PEN-3920 section 4 demands. That section says to widen under a
 * name anchor and never under a name-free rule. The anchor is UNAVAILABLE
 * here, measured rather than assumed: across Blockcast/paperclip,
 * Blockcast/onprem-k8s and Blockcast/penstock-llm-proxy-core, 782 assignments
 * bind a slash-rooted value under 250 distinct names, and the 69 values
 * refused today sit under 52 of them. Those names are not a vocabulary anyone
 * could enumerate — `new`, `prev`, `src`, `raw`, `href`, `CAP`, `MAP`, `DLL`,
 * `SDF`, `backup`, `override` — and the next one nobody listed reproduces the
 * false positive. That is the same drift `GRPC_METHOD_PATH_RE` records for
 * `method` / `rpc` / `grpc_method` / `full_method`, one order of magnitude
 * worse. PEN-4637 was filed asking only for `config`; `config` is not even
 * among the 52.
 *
 * So the SHAPE has to carry the whole decision, which means this rule may
 * admit NO opaque mass at all — unlike the Kubernetes rule above, which spends
 * a 16-character opaque budget it can afford because its name anchor is doing
 * the other half. Every run here must be a word, a number, or a tightly
 * bounded word-with-digits. A path carrying a uuid, a pod-template hash or a
 * disk serial stays REFUSED, deliberately: that is 17 of the 69, and it is the
 * class where a path is most likely to be carrying something that should not
 * be published anyway — the refusal that produced PEN-4637 was exactly that
 * case, a per-seat home holding another company's execution-workspace uuid.
 *
 * THE CONJUNCTS, and what each one holds.
 *
 *  - Slash-rooted, at least POSIX_PATH_MIN_SEGMENTS segments. This is the
 *    gate, and it is why no credential ENCODING reaches this rule: the value
 *    must begin with `/` and carry an interior `/`. Of the alphabets a secret
 *    is drawn from, only standard base64 emits `/` at all, at 1 character in
 *    64. base64url, base62, base32, hex and every vendor prefix cannot produce
 *    the first character, let alone the second.
 *  - Every run — the text between `/`, `-`, `_` and `.` — must be lowercase,
 *    uppercase, digits, CamelCase of at most POSIX_PATH_MAX_CAMEL_WORDS words,
 *    or a bounded mixed run. The CASE conjunct is the one that does the work
 *    against a chopped token, and it has two halves, each measured by removing
 *    it: an unbounded CamelCase run leaves mixed-case letters chopped into
 *    16-character runs exonerated at 1.31e-1 (the 2.3e-1 shape residual
 *    PEN-3920 section 3 measured, reappearing per-run) against 0 with the word
 *    cap, and dropping POSIX_PATH_CAMEL_RUN_MIN_LENGTH takes 4-character runs
 *    from 0 to 1.1e-3.
 *  - POSIX_PATH_MAX_MIXED_RUNS bounds how many runs may mix letters and
 *    digits. Measured over all 421 shape-matching slash-rooted values in the
 *    three repos the maximum is exactly 2, and this is the conjunct that
 *    closes the chopped-token families: it takes a random base36 token sliced
 *    into 4-character runs from 9.8e-3 to the figure in the table below.
 *  - POSIX_PATH_MAX_RUNS and POSIX_PATH_MAX_CONTENT_LENGTH bound the total
 *    admitted mass, as LEXICAL_IDENTIFIER_MAX_CONTENT_LENGTH does for
 *    `isLexicalIdentifier`. The corpus maxima are 16 runs and 93 characters;
 *    the run cap sits on that maximum and the content cap three above it.
 *    They are headroom bounds, not entropy bounds.
 *
 * THE RESIDUAL. 250,000 random values per family unless noted, fraction NEWLY
 * exonerated — values the detector refuses today that this rule admits.
 * Varying generators per PEN-4425's measurement trap.
 *
 *   Every flat token family, bare AND slash-prefixed: base64url, base62,
 *   base36, base32, hex upper and lower, mixed-case letters, alphanumeric, at
 *   24 / 32 / 43 / 64 characters; UUID v4; and a standard base64 blob filtered
 *   to those carrying two or more interior slashes .................... 0 each
 *
 *   29 real credential formats — GitHub PAT classic, fine-grained and OAuth,
 *   Slack bot, Stripe live and restricted, AWS key id and secret, Google API,
 *   Anthropic, OpenAI key and project key, Vault, GitLab PAT, npm, Grafana,
 *   JWT, base32 TOTP seed, Kubernetes bootstrap token, DigitalOcean, Paperclip
 *   service key, Azure SAS, UUID, raw hex and base64 blobs — each measured
 *   bare and slash-prefixed ........................................... 0 each
 *
 *   Standard base64, the ONLY real credential alphabet that emits `/` at all
 *   and therefore the only one that can reach this rule, 3,000,000 samples:
 *     24 characters, leading slash FORCED ............................ 3.0e-6
 *     24 characters, as generated .................................... 0
 *     32 / 43 / 64 characters, forced and as generated ............... 0 each
 *
 *   Synthetic "chopped token" families — a random token sliced into equal runs
 *   by `/`, the only other construction that reaches this rule:
 *     base36 / lowercase-alnum, 4- 6- and 8-character runs ... 4.0e-5–7.2e-5
 *     mixed-case letters, 6- and 8-character runs ........... 8.0e-6–3.2e-5
 *     mixed-case letters or base62, 4-character runs ................. 0
 *
 * For scale: `isLexicalIdentifier` carries 2.91e-3 to 3.57e-3 name-free today,
 * and the name-ANCHORED Kubernetes rule above carries up to 9.85e-3. The worst
 * family here is 7.2e-5, roughly forty times below the name-free exemption
 * this file already ships.
 *
 * WHAT IT ADMITS, stated plainly. A deliberately constructed value — a secret
 * sliced into short slash-separated runs, each one case-homogeneous — is
 * admitted at the rate in the last block. No encoder emits that; producing it
 * means setting out to, which PEN-3920 section 4 and PEN-3183 put outside this
 * control's threat model. The honest statement of the bound is that this rule
 * admits more total WORD mass than any other exemption in this file (96
 * characters against `isLexicalIdentifier`'s 30) and zero OPAQUE mass, where
 * the Kubernetes rule admits 16. Those move in opposite directions on purpose:
 * word mass is what a path is made of, opaque mass is what a secret is made
 * of, and only the second is an entropy budget.
 *
 * COVERAGE. 52 of the 69 refused values, across 42 distinct binding names. The
 * 17 left all carry a segment this rule calls opaque — a uuid, a disk serial,
 * a pod-template hash, an 8-hex chart digest — or a run whose digits the
 * mixed-run bound does not admit (`st2059`, `v1alpha1`). PEN-3920 section
 * 10.4.1 measures the `v1alpha1` widening and DECLINES it: 2-3x on the chopped
 * families to buy four values of one shape.
 *
 * Do not relax the case conjunct, the mixed-run cap, or the leading-slash
 * requirement without re-measuring: each of the three is pinned by a failing
 * mutation in the test file, because each one is load-bearing on its own.
 */
/** Cheap early-out before the split work, NOT a security bound and not
 *  reachable: POSIX_PATH_MAX_RUNS runs summing to POSIX_PATH_MAX_CONTENT_LENGTH
 *  admit at most 96 content characters, 15 interior separators, the leading
 *  slash and one trailing separator — 113. A test pins that arithmetic so a
 *  future reader does not mistake this for the bound that holds the rule.
 *  The longest real path in the corpus is 109. */
const POSIX_PATH_MAX_LENGTH = 128;
/** A credential needs an interior `/` as well as a leading one to reach here. */
const POSIX_PATH_MIN_SEGMENTS = 2;
/** Longest single run. Matches LEXICAL_SEGMENT_MAX_LENGTH; corpus maximum 12. */
const POSIX_PATH_MAX_RUN_LENGTH = 16;
/** Longest digits-only run. A date-stamped or epoch-suffixed path is the
 *  reason this is not smaller; digits carry one character class, so a run of
 *  them cannot reach the entropy test alone. */
const POSIX_PATH_MAX_DIGIT_RUN = 12;
/** Words a CamelCase run may carry, counting an acronym's capitals
 *  individually (`PaperclipAI` is three). Unbounded, this run shape is the
 *  2.3e-1 hole PEN-3920 section 3 measured; the corpus needs exactly 3. */
const POSIX_PATH_MAX_CAMEL_WORDS = 3;
/** Shortest CamelCase run. `Users` is the corpus minimum at exactly 5, and 6
 *  drops nine real values, so this sits on the knee. It is the conjunct that
 *  closes the mixed-case chopped-token family: a 4-character run of random
 *  mixed-case letters is CamelCase-shaped about a third of the time, and a
 *  token sliced into such runs was exonerated at 1.1e-3 without this bound
 *  and at 0 with it. A single capital followed by one letter is not a word. */
const POSIX_PATH_CAMEL_RUN_MIN_LENGTH = 5;
/** Longest run that may mix letters and digits (`armv7`, `vlan33`, `v2`). */
const POSIX_PATH_MIXED_RUN_MAX_LENGTH = 8;
/** Digits such a run may carry, as ALERT_NAME_RE bounds its own. */
const POSIX_PATH_MIXED_RUN_MAX_DIGITS = 2;
/** How many runs in one value may mix letters and digits. The corpus maximum
 *  over all 421 shape-matching values is exactly 2, and this is the conjunct
 *  that closes the chopped-token families. */
const POSIX_PATH_MAX_MIXED_RUNS = 2;
/** Runs one value may carry. Corpus maximum 16. */
const POSIX_PATH_MAX_RUNS = 16;
/** Summed run length, separators excluded. Corpus maximum 93. */
const POSIX_PATH_MAX_CONTENT_LENGTH = 96;

/** Capitalised words and acronym runs: `Users`, `PaperclipAI`, `MegaRAID`. */
const POSIX_PATH_CAMEL_RUN_RE = /^(?:[A-Z][a-z]+|[A-Z]{1,5})+$/;
/** Single-case and letter-initial: `armv7`, `v2`, `PVE2`. How many digits the
 *  run may carry, and in how many groups, is checked separately — the single
 *  group is what keeps `v1alpha1` out (PEN-3920 section 10.4.1). */
const POSIX_PATH_MIXED_RUN_RE = /^(?:[a-z][a-z0-9]*|[A-Z][A-Z0-9]*)$/;

/** True when a run between path separators is a word, a number, or a bounded
 *  word-with-digits — never anything opaque. */
function isPosixPathRun(run: string): boolean {
  if (run.length === 0 || run.length > POSIX_PATH_MAX_RUN_LENGTH) return false;
  if (/^[0-9]+$/.test(run)) return run.length <= POSIX_PATH_MAX_DIGIT_RUN;
  if (/^[a-z]+$/.test(run) || /^[A-Z]+$/.test(run)) return true;
  if (run.length >= POSIX_PATH_CAMEL_RUN_MIN_LENGTH && POSIX_PATH_CAMEL_RUN_RE.test(run)) {
    return (run.match(/[A-Z][a-z]*/g) ?? []).length <= POSIX_PATH_MAX_CAMEL_WORDS;
  }
  if (run.length < 2 || run.length > POSIX_PATH_MIXED_RUN_MAX_LENGTH) return false;
  if (!POSIX_PATH_MIXED_RUN_RE.test(run)) return false;
  const digits = run.match(/[0-9]+/g) ?? [];
  return digits.length === 1 && digits[0]!.length <= POSIX_PATH_MIXED_RUN_MAX_DIGITS;
}

/** True when a value is an absolute POSIX path built entirely of words. */
function isPosixPathValue(value: string): boolean {
  if (value.length < 2 || value.length > POSIX_PATH_MAX_LENGTH) return false;
  if (!value.startsWith("/")) return false;
  let body = value.slice(1);
  // ASSIGNMENT_RE's capture stops at the first character outside the token
  // alphabet, so a path interpolated with `$(…)` or `${…}` arrives here as a
  // prefix ending in its own separator. One trailing separator is tolerated;
  // an interior empty segment is not.
  if (/[-._/]$/.test(body)) body = body.slice(0, -1);
  const segments = body.split("/");
  if (segments.length < POSIX_PATH_MIN_SEGMENTS) return false;
  let runCount = 0;
  let contentLength = 0;
  let mixedRuns = 0;
  for (const segment of segments) {
    if (segment === "") return false;
    // A dotfile segment opens with `.`; `/paperclip/.gitconfig` is the case
    // PEN-4402 pins inside an `absent(...)` matcher.
    const named = segment.startsWith(".") ? segment.slice(1) : segment;
    if (named === "") return false;
    for (const run of named.split(/[-._]/)) {
      if (!isPosixPathRun(run)) return false;
      runCount += 1;
      contentLength += run.length;
      if (runCount > POSIX_PATH_MAX_RUNS) return false;
      if (contentLength > POSIX_PATH_MAX_CONTENT_LENGTH) return false;
      if (/[0-9]/.test(run) && /[A-Za-z]/.test(run)) {
        mixedRuns += 1;
        if (mixedRuns > POSIX_PATH_MAX_MIXED_RUNS) return false;
      }
    }
  }
  return true;
}

/** PEN-5734: `--force-with-lease=<ref>:<expected-oid>`, the ONLY force-push
 *  form the PEN-4869 git-egress guard accepts. A bare `--force-with-lease`
 *  reads its expected OID from `refs/remotes/origin/<branch>`, so any
 *  intervening `git fetch` makes the lease pass vacuously; that guard refuses
 *  the bare form and demands this one.
 *
 *  Which made the mandated form unpublishable. `ASSIGNMENT_RE` captures a name
 *  from `[A-Za-z0-9_]`, so the `-` in `--force-with-lease=` terminates it and
 *  the captured name is `lease`; `:` is outside the value alphabet, so the
 *  captured value is the REF half alone. A branch name long enough to clear
 *  the entropy floor was therefore redacted out of the middle of the command,
 *  leaving a marker where the ref had been and `:<oid>` still trailing it — a
 *  non-command — in a PR body whose write reported success. The fleet's own
 *  guard mandates the form, so "derive it at runtime" is unavailable: the
 *  point of a pinned lease is that the expected OID is a literal written down
 *  ahead of time.
 *
 *  TWO HALVES, TWO INDEPENDENT BOUNDS — never the composite as a whole. The
 *  value is a git ref and a git object name joined by `:`, and each half is
 *  exonerated on its own shape under this one binding name. Nothing here
 *  admits an opaque `<ref>:<token>` as a unit: an opaque left half is still
 *  refused by the entropy test it falls through to, and an opaque right half
 *  is now refused by a rule that did not previously exist. That is the
 *  BLO-45350 / BLO-45605 lesson recorded in
 *  `docs/security/PEN-3920-egress-entropy-identifier-decision.md` §10 applied
 *  before the fact: there, two runs of a composite were bounded and the third
 *  exonerated an arbitrary token in the gap.
 *
 *  THE RIGHT HALF IS A TIGHTENING, NOT AN EXEMPTION. Because `:` ends
 *  `ASSIGNMENT_RE`'s capture, everything after it was never offered to any
 *  detector. Measured on the shipped scrubber, a lease naming a 32-character
 *  base64url token as its expectation published that token BYTE-EXACT while
 *  redacting the harmless branch name beside it — this binding scrubbed the
 *  public half and passed the opaque one. `FORCE_WITH_LEASE_EXPECTATION_RE`
 *  and its pass in `scrubGitHubEgressText` close that.
 *
 *  THE ANCHOR IS THE LITERAL FLAG, not the captured name. Exonerating the name
 *  `lease` would also reach `lease=`, `--lease=` and `my_lease=`, none of
 *  which any control mandates. `isForceWithLeaseBinding` therefore re-reads
 *  the bytes immediately before the match and requires `--force-with-` there,
 *  so the anchor is exactly `--force-with-lease`. Same doctrine as every other
 *  name anchor in this file (PEN-3920 §4): detection stays structural and an
 *  unrecognised name still fires; the name only narrows an exemption, so a
 *  name nobody anticipated costs a false positive, never a leak. */
const FORCE_WITH_LEASE_NAME = "lease";
const FORCE_WITH_LEASE_NAME_PREFIX = "--force-with-";

/** True when an `ASSIGNMENT_RE` match is the `--force-with-lease=` binding
 *  rather than some other name ending in `lease`. `offset` points at the NAME,
 *  because that pattern opens with `\b(`, so the rest of the flag is exactly
 *  the bytes immediately before it. */
function isForceWithLeaseBinding(name: string, whole: string, offset: number): boolean {
  if (name !== FORCE_WITH_LEASE_NAME) return false;
  const start = offset - FORCE_WITH_LEASE_NAME_PREFIX.length;
  if (start < 0) return false;
  return whole.slice(start, offset) === FORCE_WITH_LEASE_NAME_PREFIX;
}

/** Longest ref admitted. git imposes no limit of its own; the longest branch
 *  name in the three repositories' histories is 68 characters. */
const GIT_REF_MAX_LENGTH = 128;
/** Slash-separated components. `refs/remotes/origin/<branch>` is four, which
 *  is also the corpus maximum: over 1192 branch names in Blockcast/paperclip's
 *  history the distribution is 263 at one component, 914 at two, 3 at three
 *  and 12 at four. So this sits exactly on the maximum with nothing to spare,
 *  and it is a real bound rather than headroom — `/` is the separator the
 *  chopped-token families use to reach a word-only rule, and capping it is
 *  what takes `lower-alnum chopped by '/'` out of the top of the residual
 *  table below. */
const GIT_REF_MAX_COMPONENTS = 4;
/** Summed length of the letters-only runs. THIS IS THE CONJUNCT THAT HOLDS THE
 *  RULE, exactly as `K8S_NAME_MIN_WORD_MASS` holds the Kubernetes one, and the
 *  numbers are in `isGitRefName`'s residual table: without it the chopped-token
 *  families reach 8.5e-3, with it 2.33e-3.
 *
 *  It is also what keeps real credential FORMATS out, which no other conjunct
 *  here does — none musters fourteen characters of letter runs: `sk-ant-api03-…`
 *  has 5, `xoxb-…` 4, `sk_live_…` 6, a Kubernetes bootstrap token's
 *  `<6>.<16>` has 0 unless both halves draw no digit.
 *
 *  Set at the KNEE ON RESIDUAL — NOT one below the corpus minimum, which is
 *  the convention this file uses elsewhere and which would put it at 10. Ten
 *  is not free. Over 1192 distinct branch names in Blockcast/paperclip's
 *  history, 847 are refused inside a lease by the shipped detector; a floor of
 *  10 publishes 518 of those 847 and carries 7.25e-3, 14 publishes 511 and
 *  carries 2.33e-3, 16 publishes 502 and carries 2.30e-3. So 14 buys a 3x
 *  reduction in residual for seven real branches out of 518, and 16 buys
 *  nothing further while costing nine more. Full table: PEN-3920 12.3.
 *
 *  DO NOT LOWER THIS TO 10 on the strength of the corpus minimum alone — that
 *  is the 7.25e-3 row above, about 3x the shipped residual. A failing mutation
 *  pins 14. */
const GIT_REF_MIN_WORD_MASS = 14;

/**
 * True when a value is a git ref name built entirely of words.
 *
 * ZERO OPAQUE MASS, deliberately, and that is what carries the rule. Every run
 * between `/`, `-`, `_` and `.` must satisfy `isPosixPathRun` — a word, a
 * number, or a tightly bounded word-with-digits — so there is no budget here
 * for a generated segment at all, unlike `isKubernetesObjectName`, which
 * spends sixteen characters of one. Same trade `isPosixPathValue` takes, for
 * the same reason: a credential is one opaque run, and one opaque run reaches
 * neither shape.
 *
 * The git-specific refusals (`..`, a leading `.` on a component, a `.lock`
 * tail, an empty component) are `git check-ref-format`'s rules rather than
 * security bounds — a value git would reject is not a ref, and saying so keeps
 * the predicate honest about what it claims to recognise. What holds the rule
 * is the per-run shape above plus the run and content caps borrowed from the
 * POSIX path rule.
 *
 * The rest of what `check-ref-format` forbids — `~`, `^`, `?`, `*`, `[`,
 * backslash, whitespace — needs no test here: none is in the alphabet that
 * reaches this predicate, because `ASSIGNMENT_RE`'s capture and
 * `FORCE_WITH_LEASE_EXPECTATION_RE` both stop at the first character outside
 * the token alphabet. A ref carrying one arrives TRUNCATED, which can only
 * narrow what is exonerated.
 *
 * THE RESIDUAL, measured as this file's family requires — 200,000 random
 * values per family, fraction NEWLY exonerated under the `--force-with-lease`
 * anchor, i.e. values the shipped detector refuses that this rule admits.
 * Reproduce with `scripts/measure-force-with-lease-residual.mjs`; the full
 * table and the knee analysis are in PEN-3920 §12.3. (§11.3 until PEN-6152
 * inserted D9 ahead of this section — a cross-reference, not a figure, but it
 * now resolves to a different rule's refusal analysis.)
 *
 *   base64url, base62, base36, base32, hex upper and lower, mixed-case
 *   letters, alphanumeric, at 24 / 32 / 43 / 64 characters .......... 0 each
 *   UUID v4 layout .................................................. 0
 *   24 real credential formats (GitHub PAT classic, fine-grained and
 *   OAuth, Slack, Stripe live and restricted, AWS key id and secret,
 *   Google, Anthropic, OpenAI key and project key, Vault, GitLab,
 *   npm, Grafana, base32 TOTP seed, DigitalOcean, Paperclip service
 *   key, raw hex and base64 blobs), bare and `release/`-prefixed .... 0 each
 *   Kubernetes bootstrap token (`<6>.<16>`), `release/`-prefixed .... 1.80e-3
 *   Synthetic "chopped token" families — a random token sliced into
 *   equal runs by `/` or `-`, the only construction that reaches a
 *   word-only rule: base36 and lowercase-alnum at 4 / 6 / 8-char
 *   runs, mixed-case letters at 4 / 6 / 8 ............ 7.5e-5 to 2.33e-3
 *
 * Worst family 2.33e-3 (mixed-case letters chopped by `/` into ~6-character
 * runs). It is NOT zero, and the flat-token zeros are the uninteresting half
 * of that: a flat token is one opaque run and cannot reach a word-only rule at
 * all. The number to watch is the chopped-token column, and the two conjuncts
 * holding it are GIT_REF_MIN_WORD_MASS and GIT_REF_MAX_COMPONENTS — without
 * them the same families measure 8.5e-3.
 *
 * ⛔ PEN-5828: EVERY FIGURE ABOVE IS A FAMILY AVERAGE OVER AN UNEVENLY
 * REACHABLE MIXTURE, and the worst reachable SHAPE is what PEN-3920 6.5 now
 * requires. The generator drew its component count at random per trial, and
 * for the worst family two of the three bins contribute exactly zero — one
 * below HIGH_ENTROPY_MIN_LENGTH so the detector never fired, one refused by
 * GIT_REF_MAX_COMPONENTS — so 2.33e-3 is the hot bin divided by three. Per
 * shape, mixed-case letters chopped by `/` into ~6-character runs at FOUR
 * components measures 6.88e-3, 95% CI [6.65e-3, 7.11e-3], pooled 3439 over
 * 500,000 trials across five independent runs and three seats; 6.96e-3
 * against the population denominator. Dilution 3.000x, exact rather than
 * approximate. Nothing newly REFUSED anywhere: 0 across every cell.
 *
 * ⛔ AND THE GRID WAS BLIND TO ITS OWN HOT REGION. Two of its three chopped
 * alphabets were BYTE-IDENTICAL (`base36` and `lower-alnum` were both
 * lowercase+digits), so it sampled two letter densities, not three: 72% and
 * 100%. The residual peaks BETWEEN them. Replacing the duplicate with base32
 * (`A-Z234567`, 81% letters — enough digits to escape `isLexicalIdentifier`'s
 * exoneration and so stay IN population, enough letters to clear the word-mass
 * floor) measures a worst shape of 4.40e-2 at `/` ~6-char runs x4 — 6.3x the
 * figure above, and reachable by a REAL base32 credential: an RFC 4648 TOTP
 * seed chopped the same way measures 4.33e-2, against 0/50,000 for the same
 * seed in its native flat form.
 *
 * ⚠ THAT IS A NUMBER, NOT A DECISION, AND NO CONSTANT MOVED FOR IT. The
 * threat-model verdict below is unchanged — a flat credential of any alphabet
 * still measures 0, and reaching 4.40e-2 still means deliberately slicing a
 * secret across slashes. What it does change is the comparison that used to
 * close this comment, which is withdrawn:
 *
 *     WITHDRAWN PEN-5828: "For scale, `isLexicalIdentifier` carries 2.96e-3 to
 *     WITHDRAWN PEN-5828: 3.57e-3 NAME-FREE today, and the name-anchored
 *     WITHDRAWN PEN-5828: Kubernetes rule up to 9.85e-3 under an anchor of
 *     WITHDRAWN PEN-5828: eight common label names. This sits below both,
 *     WITHDRAWN PEN-5828: under an anchor of one literal flag."
 *
 * It compared a family average here against family averages there, and BOTH
 * reference figures are themselves diluted mixtures (PEN-3920 6.3 and 9.4).
 * Like-for-like, worst shape against worst shape and on the SAME population
 * denominator: `isLexicalIdentifier` carries 6.21e-3 [5.46e-3, 6.95e-3] and
 * `isKubernetesObjectName` 2.02e-2 [1.94e-2, 2.09e-2]. Against those, the
 * three originally-published alphabets put this rule WITHIN MEASUREMENT ERROR
 * of `isLexicalIdentifier` (6.96e-3) and ~2.9x below the Kubernetes rule — 65%
 * headroom, not the ~30% a diluted 9.85e-3 implies — while base32 puts it
 * ~2.2x ABOVE the Kubernetes rule. Whether the floor should move on that
 * evidence is NOT decided here, and no constant moved for it: the corpus half
 * of that trade — what a higher floor costs in real branch names — is
 * unmeasured, and a residual table alone cannot settle a floor. See PEN-5828
 * and PEN-3920 12.3a.
 *
 * ⛔ Do NOT write an ORDERING against `isLexicalIdentifier` in either
 * direction, and do NOT write a ratio. The sign is not established and it is
 * not a question of sample size: the two operands sit on very different
 * population fractions (0.99 here against 0.43 there), so the comparison
 * INVERTS with the denominator — 1.12x on the population denominator, 1.76x
 * the other way. An ordering becomes available only if both operands are
 * restated on one denominator at one evidential standard. "Within measurement
 * error" is the whole claim. The Kubernetes half IS ordering-safe: no
 * plausible correction to it closes a 2.9x gap.
 *
 * WHAT IT ADMITS, stated plainly. A deliberately constructed value — a secret
 * chopped into short case-homogeneous word-shaped runs and spelled as a branch
 * name — is admitted, up to the word mass `POSIX_PATH_MAX_CONTENT_LENGTH`
 * allows. No encoder emits that; producing it means setting out to, which
 * PEN-3920 §4 and PEN-3183 put outside this control's threat model. The one
 * non-zero credential row above is the honest edge of that: a Kubernetes
 * bootstrap token whose two halves both happen to draw no digit is word-shaped
 * by accident rather than by construction.
 */
function isGitRefName(value: string): boolean {
  if (value.length === 0 || value.length > GIT_REF_MAX_LENGTH) return false;
  if (value.startsWith("/") || value.endsWith("/")) return false;
  if (value.includes("..") || value.endsWith(".lock")) return false;
  const components = value.split("/");
  if (components.length > GIT_REF_MAX_COMPONENTS) return false;
  let runCount = 0;
  let contentLength = 0;
  let mixedRuns = 0;
  let wordMass = 0;
  for (const component of components) {
    if (component === "" || component.startsWith(".")) return false;
    for (const run of component.split(/[-._]/)) {
      if (!isPosixPathRun(run)) return false;
      runCount += 1;
      contentLength += run.length;
      if (runCount > POSIX_PATH_MAX_RUNS) return false;
      if (contentLength > POSIX_PATH_MAX_CONTENT_LENGTH) return false;
      if (/^[A-Za-z]+$/.test(run)) wordMass += run.length;
      else if (/[0-9]/.test(run) && /[A-Za-z]/.test(run)) {
        mixedRuns += 1;
        if (mixedRuns > POSIX_PATH_MAX_MIXED_RUNS) return false;
      }
    }
  }
  return wordMass >= GIT_REF_MIN_WORD_MASS;
}

/** The expected-OID half of a pinned lease: a git object name, full or
 *  abbreviated. 7 is git's own minimum unambiguous abbreviation and 64 covers
 *  a sha256 OID, so this spans every form `--force-with-lease` takes as a
 *  literal. Lowercase only, like `GIT_COMMIT_SHA_RE` and `HEX_DIGEST_RE`: an
 *  uppercase OID is not a form git plumbing emits, so it stays subject to the
 *  entropy test.
 *
 *  The residual is the one `GIT_OBJECT_NAME_VALUE_NAMES` already states and
 *  accepts, reached under one more binding name: a legacy GitHub personal
 *  access token is exactly 40 lowercase hex with no prefix, and
 *  `VENDOR_KEY_RE` does not see one. What makes it acceptable is the NAME half
 *  alone — nothing but a git object name is plausibly written after
 *  `--force-with-lease=<ref>:` — and it must never be widened into a
 *  shape-only rule. Note too that the direction of travel on this half is
 *  TIGHTENING: before PEN-5734 nothing tested it at all. */
const LEASE_EXPECTED_OID_RE = /^[0-9a-f]{7,64}$/;

/** The `--force-with-lease=` binding together with its expectation half.
 *
 *  Group 1 is everything through the `:` — flag, optional opening quote, ref —
 *  and is replayed verbatim, so this pass can only ever rewrite what follows
 *  the colon. The ref half is left for `ASSIGNMENT_RE` to adjudicate exactly
 *  as it does today, which is what keeps the two bounds independent.
 *
 *  Group 2 is the expectation. `.` is admitted only BETWEEN token runs, never
 *  as a tail: `ASSIGNMENT_RE`'s alphabet includes `.`, and borrowing it whole
 *  would swallow the full stop ending a sentence, turn a clean 40-hex OID into
 *  a 41-character non-OID, and redact the very value this rule exists to let
 *  through.
 *
 *  `:` IS IN GROUP 2'S ALPHABET, so the expectation runs to the end of the
 *  token and not merely to the next colon. Ally caught the narrower form
 *  (review 5797006954): with `:` excluded, `--force-with-lease=<ref>:sha256:<32-char
 *  token>` captured only `sha256`, which is not an OID and not opaque, so the
 *  pass returned the match untouched and the token published BYTE-EXACT —
 *  measured, not reasoned. Group 1 still stops at the FIRST colon, so the ref
 *  half is unaffected and the two bounds stay independent.
 *
 *  Admitting `:` here cannot widen exoneration, which is the only property
 *  that matters for the residual: the sole exonerating predicate is
 *  `LEASE_EXPECTED_OID_RE`, and `^[0-9a-f]{7,64}$` rejects every string
 *  containing a colon. So this strictly ENLARGES what is offered to
 *  `isOpaqueSecretValue` and can never let a value through that the narrower
 *  alphabet refused — the expectation-slot residual stays 0 by construction
 *  rather than by measurement.
 *
 *  `:` IS A SEPARATOR, NOT A MEMBER: it must be FOLLOWED by at least one
 *  alphabet character, exactly as `.` already is. A dangling colon is
 *  therefore not swallowed. Ally caught the cost of the member form (review
 *  5798756712): with `:` a plain member, prose such as
 *  `--force-with-lease=<ref>:<oid>: then …` captured `<oid>:`, which
 *  `LEASE_EXPECTED_OID_RE` rejects, so a VALID pinned OID was redacted —
 *  PEN-5734's own defect in miniature, reintroduced by its own fix. That
 *  failed closed, but failing closed on the mandated form is the thing this
 *  binding exists to prevent.
 *
 *  THE SEPARATOR MUST BE `:*` / `[.:]+`, NOT `[.:]`, AND THAT IS A LEAK BOUND
 *  RATHER THAN A STYLE CHOICE. A single-separator form (`[.:]`) admits exactly
 *  one colon before each alphabet run, so a DOUBLED colon ends the capture and
 *  the tail is never offered to the detector: `<ref>::<token>` did not match at
 *  all, and `<ref>:<oid>::<token>` captured only `<oid>` — which this predicate
 *  EXONERATES — publishing the token BYTE-EXACT in both cases. Ally measured it
 *  (review 5798876353) and I reproduced all three variants before changing
 *  anything. The leading `:*` lets the capture start on a run of colons, and
 *  `[.:]+` lets any run of separators sit between two alphabet runs, so no
 *  amount of colon-stuffing can push material past the end of the match.
 *
 *  SO THE CORRECT STATEMENT OF THE PROPERTY IS NARROWER THAN THE PARAGRAPH
 *  ABOVE CLAIMS, and the earlier wording is what hid this: "cannot widen
 *  exoneration" is true and remains true — exoneration is `^[0-9a-f]{7,64}$`,
 *  which no colon-bearing string can satisfy — but it says nothing about
 *  material that never enters the MATCH in the first place. A value the regex
 *  does not reach is not exonerated; it is simply never examined, and it
 *  publishes. Monotonic exoneration is NOT the same property as total capture,
 *  and only the second one closes an escape. Judge a change here on BOTH. */
const FORCE_WITH_LEASE_EXPECTATION_RE =
  /(--force-with-lease=["']?[^\s"'`:]*:)(:*[A-Za-z0-9+/=_-]+(?:[.:]+[A-Za-z0-9+/=_-]+)*)/g;

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
 *  must open with a letter, carry ONE digit run (at most 2 digits here; see
 *  the PEN-4939 paragraph below, which admits 3-5 when they TERMINATE the
 *  segment behind two letters), and an exonerated value may carry at most ONE
 *  such segment, written in a single case. A UUID stays opaque: `386c81e8`
 *  opens with a digit, and `e454` has only a single letter ahead of its
 *  digits, so it satisfies neither branch. ⚠ The digit-run width alone is NOT
 *  what holds the UUID invariant — the leading-letter count is. Do not reason
 *  from "digit run <= 2" when editing either branch.
 *
 *  This DOES widen exoneration for random tokens, and the residual is measured,
 *  not zero (Ally, review 5496550156). A random token often has all-but-one
 *  segment letters-only, and this forgives exactly that one. Single case cuts
 *  base64url-32 from ~70 to ~12 per 100k; fixed-layout keys are closed by the
 *  uniform-length check in isLexicalIdentifier. What remains, through the whole
 *  of isOpaqueSecretValue, 100k random values per shape: base64url-32 ~1e-4,
 *  lower+digit with random separators ~3–5e-4 at 24–28 chars and ~2e-5 at 32,
 *  fixed-layout 4×6 / 5×5 keys and base64url-43 0. Accepted: the alternative was refusing every agent
 *  push touching a file that names an `orc8r` job.
 *
 *  PEN-4939: the last two alternatives add a WORD FOLLOWED BY A TICKET NUMBER
 *  — `pen3261`, `blo49591`. The digit-run cap above is 2, and every identifier
 *  in this fleet that names an issue carries 4 (`PEN-####`) or 5 (`BLO-#####`),
 *  so the shape our own naming convention produces was the one shape this rule
 *  could never exonerate. Measured: a 24-char probe-object name built from a
 *  ticket number refused, the same name with the digits spelled as a separate
 *  segment passed, and the two differ only in a hyphen. That taught authors to
 *  shorten names until the door opened, which is the failure mode that gets a
 *  control switched off.
 *
 *  Kept narrow so the documented invariants above still hold. The digits must
 *  TERMINATE the segment and be preceded by at least TWO letters, so `e454` —
 *  named above as the reason a UUID stays opaque — is still refused, as are
 *  `386c81e8`, `9a1a` and `5f22`. Simply widening the existing alternatives to
 *  `[0-9]{1,4}` would have admitted `e454` and broken that invariant.
 *
 *  Residual, same method as above, 100k random values per shape through the
 *  whole of isOpaqueSecretValue: base64url-32, base64url-43, alnum-24,
 *  alnum-40, lower+digit-24/32 and fixed-layout 4×6 / 5×5 keys all UNCHANGED
 *  to the count. The only movement is lower+digit with random separators —
 *  2166→2181 per 100k at 24 chars, 532→540 at 28, 203→207 at 32. */
const MIXED_LEXICAL_SEGMENT_RE =
  /^(?=.{2,8}$)(?:[a-z]+[0-9]{1,2}[a-z]*|[A-Z]+[0-9]{1,2}[A-Z]*|[a-z]{2,}[0-9]{3,5}|[A-Z]{2,}[0-9]{3,5})$/;

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
 *
 * ⛔ PEN-5828: THE NAME-FREE RESIDUAL THIS RULE IS QUOTED AT ACROSS THE FILE —
 * "2.91e-3 to 3.57e-3" — IS A BRACKET OVER THREE FAMILY AVERAGES, each itself
 * a mixture over 4-6 (or 4-5) groups whose bins are not equally reachable;
 * measured population runs 0.43 / 0.89 / 0.99, the low bin starved by
 * HIGH_ENTROPY_MIN_LENGTH. Per shape, the worst is 3-7 characters at FOUR
 * groups: 6.21e-3, 95% CI [5.46e-3, 6.95e-3], on 266 of 42,870 in-population
 * draws. Baseline is this predicate neutered in a copy of this module, so
 * "newly exonerated" means exonerated BY THIS RULE and not by something else.
 * Re-measured mixtures 2.45e-3 / 2.89e-3 / 3.27e-3 against the published
 * 2.96e-3 / 2.91e-3 / 3.57e-3 — the published figures reproduce; it is the
 * SHAPE they average over that was missing. PEN-3920 6.3 and 6.5.
 *
 * ⚠ The denominator is load-bearing when this figure is used "for scale"
 * against another rule. On the population denominator the worst shape is
 * 6.21e-3; on a raw trial denominator it is 3.90e-3, because the hot bin runs
 * a population of only 0.43. Quote which one, or a comparison built on it
 * inherits a factor of 1.6 nobody can see.
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
/*
 * BLO-45605: the same exoneration lived on in the other two runs, which only
 * had to start with a letter — `/<token>.b/` and `/a.<token>/` passed whole.
 * The service (the last dotted run) is now `[A-Z][A-Za-z]*[0-9]*`: proto
 * service style, with digits allowed only as a tail for `Service303`. Package
 * runs cannot take a shape bound — proto packages are lowercase and `orc8r`
 * carries an interior digit — so each is capped at 16 characters instead,
 * under the 24-character entropy floor; magma's longest is `configurator`
 * (12). Both bounds hold the magma rpc corpus exactly where it was; the test
 * file replays it.
 */
const GRPC_METHOD_PATH_RE =
  /^\/(?:[A-Za-z][A-Za-z0-9]{0,15}\.)+[A-Z][A-Za-z]*[0-9]*\/(?:[A-Z][A-Za-z]*)?$/;

/** A value is "opaque" when it is long (its token alphabet is guaranteed by
 *  ASSIGNMENT_RE's capture), is drawn from at least two character classes,
 *  is not a hyphenated identifier, and has high per-character entropy.
 *  Deliberately narrow: applied only to assignment values, never to bare
 *  words. A 40-char git SHA scores ~4.0 bits/char and would be redacted out
 *  of ordinary review prose if this ran unbound. */
function isOpaqueSecretValue(value: string): boolean {
  if (value.length < HIGH_ENTROPY_MIN_LENGTH) return false;
  if (classIndex(value) < 2) return false;
  if (isLexicalIdentifier(value)) return false;
  if (GRPC_METHOD_PATH_RE.test(value)) return false;
  if (isPosixPathValue(value)) return false;
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

  // PEN-5734: the expectation half of `--force-with-lease=<ref>:<oid>`, which
  // no other detector can reach. `:` is outside ASSIGNMENT_RE's value
  // alphabet, so the capture stops at it and everything after the colon was
  // never offered to any rule — this binding redacted the public branch name
  // and published whatever sat in the expectation slot byte-exact.
  //
  // Runs BEFORE ASSIGNMENT_RE so the two halves are adjudicated in a fixed
  // order and the ref half below sees the text this pass leaves. It must run
  // after the vendor-key and JWT passes for the opposite reason: a marker they
  // emitted contains spaces, which this pattern stops at, so a half already
  // redacted by a more specific class is not re-examined and its marker is
  // carried through untouched — the file's invariant that every class in
  // `classes` keeps a visible marker in `text`.
  text = text.replace(
    FORCE_WITH_LEASE_EXPECTATION_RE,
    (match, binding: string, expectation: string) => {
      if (LEASE_EXPECTED_OID_RE.test(expectation)) return match;
      if (!isOpaqueSecretValue(expectation)) return match;
      fired.add("high-entropy-assignment");
      return `${binding}${redactionMarker("high-entropy-assignment")}`;
    },
  );

  // Redact only the value; the name is often the point of the sentence and is
  // not itself sensitive.
  text = text.replace(
    ASSIGNMENT_RE,
    (match, name: string, quote: string, value: string, offset: number, whole: string) => {
      // PEN-5734: the ref half of a pinned lease. Checked before
      // isContentDigestAssignment rather than inside it because the anchor is
      // the literal flag `--force-with-lease`, which only the surrounding
      // bytes can establish — the name this pattern captures is bare `lease`.
      if (isForceWithLeaseBinding(name, whole, offset) && isGitRefName(value)) return match;
      if (isContentDigestAssignment(name, value)) return match;
      if (!isOpaqueSecretValue(value)) return match;
      fired.add("high-entropy-assignment");
      return `${name}=${quote}${redactionMarker("high-entropy-assignment")}`;
    },
  );

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
 *
 * PEN-6255: an empty return is therefore NOT evidence that the input is clean,
 * and this must never be used to clear a line. `scrubGitHubEgressText` is the
 * only verdict — it is what the push door itself calls
 * (`github-git-egress-shim.ts`), and this runs only after that has already
 * refused. A PEM is the live example: `scrub` reports `private-key-block`
 * while this returns nothing at all, by the region rule above. Two
 * line-by-line sweeps of this detector were built on this function and were
 * fail-open on private keys for exactly that reason; neither sample happened
 * to contain one, so both read clean. A test pins the divergence so the two
 * cannot silently converge and make the warning stale.
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
