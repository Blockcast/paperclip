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
 *  measured on BLO-46448, now reachable under one more exact name. */
const CAMEL_CASE_VALUE_NAMES = new Set(["alertname", "kind"]);

/** PEN-3920 (D5): names whose values take the snake_case identifier shape.
 *  Separate from CAMEL_CASE_VALUE_NAMES because the shapes differ; the
 *  name-anchored trade is the same one. */
const SNAKE_CASE_VALUE_NAMES = new Set(["job"]);

/** Digit runs in a value, for the bound above. */
function digitRunCount(value: string): number {
  return (value.match(/\d+/g) ?? []).length;
}

/** BLO-46892: a git commit pin, `rev=<40 lowercase hex>`, as Nix flake inputs
 *  write it (`git+ssh://...?ref=main&rev=<sha>`). A flake input must be a
 *  literal URL, so there is no way to keep the SHA out of the pushed blob, and
 *  every pin bump was refused. Exact name AND exact shape, as above: a 40-hex
 *  value under any other name, or a non-hex value under `rev`, stays subject
 *  to the entropy test. */
const GIT_COMMIT_SHA_RE = /^[0-9a-f]{40}$/;

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
/** PEN-4438 (D7): names whose values take the Kubernetes object-name shape.
 *  BLO-49591 added `namespace` (a DNS-1123 label, e.g. a preview namespace
 *  carrying an issue number) and `node` / `host_name` (a node name, as
 *  kube-state-metrics and node-exporter label it). Same shape, same
 *  conjuncts; a credential-shaped value under these names is still refused.
 *  BLO-49668 added `job_name` (kube-state-metrics' Job object name, i.e.
 *  `<cronjob>-<scheduled-time>`). */
const K8S_OBJECT_NAME_VALUE_NAMES = new Set([
  "cronjob",
  "host_name",
  "instance",
  "job_name",
  "name",
  "namespace",
  "node",
  "pod",
]);

/** True when a value is a Kubernetes object name or in-cluster DNS name. */
function isKubernetesObjectName(value: string): boolean {
  if (value.length > K8S_NAME_MAX_LENGTH) return false;
  const labels = value.split(".");
  if (labels.length > K8S_NAME_MAX_LABELS) return false;
  let wordMass = 0;
  let generatedSegments = 0;
  let generatedMass = 0;
  for (const label of labels) {
    if (!K8S_DNS_LABEL_RE.test(label)) return false;
    for (const segment of label.split("-")) {
      if (/^[a-z]+$/.test(segment)) {
        wordMass += segment.length;
        continue;
      }
      if (/^[0-9]+$/.test(segment)) continue;
      if (segment.length > K8S_NAME_MAX_GENERATED_LENGTH) return false;
      generatedSegments += 1;
      generatedMass += segment.length;
    }
  }
  return (
    wordMass >= K8S_NAME_MIN_WORD_MASS &&
    generatedSegments <= K8S_NAME_MAX_GENERATED_SEGMENTS &&
    generatedMass <= K8S_NAME_MAX_GENERATED_MASS
  );
}

/** True when a NAME=VALUE pair is a content digest pin rather than a secret. */
function isContentDigestAssignment(name: string, value: string): boolean {
  if (name === "patch_hash" && PNPM_PATCH_HASH_RE.test(value)) return true;
  if (digitRunCount(value) <= ALERT_NAME_MAX_DIGIT_RUNS) {
    if (CAMEL_CASE_VALUE_NAMES.has(name) && ALERT_NAME_RE.test(value)) return true;
    if (SNAKE_CASE_VALUE_NAMES.has(name) && JOB_NAME_RE.test(value)) return true;
  }
  if (K8S_OBJECT_NAME_VALUE_NAMES.has(name) && isKubernetesObjectName(value)) return true;
  if (name === "rev" && GIT_COMMIT_SHA_RE.test(value)) return true;
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
 * For scale: `isLexicalIdentifier` carries 2.96e-3 to 3.57e-3 name-free today,
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

  // Redact only the value; the name is often the point of the sentence and is
  // not itself sensitive.
  text = text.replace(ASSIGNMENT_RE, (match, name: string, quote: string, value: string) => {
    if (isContentDigestAssignment(name, value)) return match;
    if (!isOpaqueSecretValue(value)) return match;
    fired.add("high-entropy-assignment");
    return `${name}=${quote}${redactionMarker("high-entropy-assignment")}`;
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
