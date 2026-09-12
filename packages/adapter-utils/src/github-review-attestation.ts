// BLO-32844: bind an agent-authored PR review to the pull request it is being
// submitted to, at the last moment before it leaves the pod.
//
// Where this lives, and why it cannot live in server/.
//
// The control plane never posts a review: there is no POST /pulls/{n}/reviews
// anywhere in server/. Agents compose a body and shell out to `gh pr review`
// or `gh api repos/{o}/{r}/pulls/{n}/reviews`, so the egress launcher described
// in github-cli-egress-shim.ts is the only code of ours in front of the call.
// There is no in-process "the post succeeded" moment to hook.
//
// What went wrong, and why GitHub's own metadata cannot detect it.
//
// A review computed against Blockcast/pim-multicast-gateway#2864 was submitted
// to Blockcast/mediamtx#33 (review 5146990033, 2026-09-08T21:04:48Z). GitHub
// stamps `commit_id` from the *target* PR at submission time, so it read
// mediamtx#33's real head: every consumer checking
// `state === "APPROVED" && commit_id === head` saw a correctly approved head.
// The body's `Reviewed head:` marker named 81d63ac9…, which is pim#2864's head
// and resolves nowhere in mediamtx (422). The marker is the only field that
// travels *with the review text*, so it is the only one that can disagree with
// the target — which makes it the sole signal for this class, and makes
// `commit_id` worthless for it.
//
// Two failure directions, one guard.
//
//   - Unreachable marker — fails OPEN. The case above: an APPROVED review of
//     code nobody looked at, carrying a green signal. In a repo where an Ally
//     approval gates merge this admits entirely unreviewed code.
//   - Malformed marker — fails CLOSED. review-gate-action#7 reviews
//     5013561307 and 5013569224 carry a 42-character marker (two characters
//     spliced into a real SHA, `…a072` + `f6` + `f9a9…`). The consumer's
//     REVIEWED_HEAD_ATTESTATION_PATTERN requires exactly [0-9a-f]{40} followed
//     by end of line, so it matches nothing and extractAllyReviewedHeadSha
//     returns null. The review attests no head and can never satisfy the gate
//     at any head, with no in-band recovery.
//
// Both are refused here, before the call leaves the pod, because the costs are
// not symmetric. A refused submission is recoverable: the agent re-reviews and
// posts again. An admitted false approval is not — it is merge-visible the
// instant it lands and only a human dismissal removes it. That asymmetry is
// why every indeterminate outcome below refuses rather than passes.
//
// Detection must be LOOSER than the consumer's grammar; validation STRICTER.
//
// server/src/services/ally-review-detection.ts answers "is there a usable
// attestation?", and it is right to ignore a 42-char marker. A producer asking
// that same question would wave the malformed review straight through, because
// it also sees no attestation. So this module first finds any line that
// *intends* to attest, then demands the token be exactly 40 hex. Intent and
// validity are separate questions on the producing side, and only here.
//
// The two grammars are deliberately not shared: adapter-utils ships to agent
// pods and must not depend on server/. Unifying the Ally review grammar across
// scripts/, server/ and here is tracked as BLO-32512; if that lands, the
// candidate scanner below is the piece to fold in — keeping the loose/strict
// split, which is the part that is easy to lose in a merge.

/** How the target repository was determined, for diagnostics in the refusal. */
export type ReviewTargetSource = "argv-flag" | "argv-url" | "argv-api-path" | "resolved-default";

/**
 * Where the authored review text came from.
 *
 * The distinction between `file` and `json-request-file` is load-bearing.
 * `gh pr review --body-file x.md` and `gh api ... -F body=@x.md` both point at
 * raw Markdown, but `gh api ... --input x.json` points at a whole JSON request
 * payload whose `body` member holds the Markdown — with newlines encoded as
 * `\n` escapes. Scanning that file as Markdown finds no line-anchored
 * attestation at all, reports `absent`, and skips the reachability check, so
 * the JSON form silently bypassed the guard entirely.
 */
export type ReviewBodySource =
  | { kind: "inline"; text: string }
  | { kind: "file"; path: string }
  | { kind: "json-request-file"; path: string };

export interface ReviewSubmission {
  /** "owner/name", or null when argv does not name it (`gh pr review` with no
   *  --repo relies on the checkout's remote, which argv cannot tell us). */
  repo: string | null;
  repoSource: ReviewTargetSource | null;
  /** The pull request number, when argv carries it. */
  pullNumber: number | null;
  /** Inline body text, or a path to read it from. */
  body: ReviewBodySource | null;
}

export type ReviewAttestation =
  /** No line intends to attest. Nothing for this guard to check. */
  | { kind: "absent" }
  /** Exactly one attesting line, token is exactly 40 lowercase hex, and the
   *  line ends after it. */
  | { kind: "well-formed"; sha: string }
  /** Exactly one attesting line that the consumer will not accept. The
   *  fail-closed defect: `detail` says which way it is broken. */
  | { kind: "malformed"; raw: string; detail: "not-a-sha" | "trailing-content" }
  /** Several attesting lines. The consumer requires exactly one and returns
   *  null otherwise, so this is the malformed case by another route. */
  | { kind: "ambiguous"; raw: string[] };

/** Whether a SHA names a commit in a given repository. `indeterminate` covers
 *  every outcome that is neither a definite yes nor a definite no — a network
 *  failure, a 5xx, an auth problem. It is treated as a refusal by the caller;
 *  see the asymmetry note in the module header. */
export type CommitReachability = "reachable" | "unreachable" | "indeterminate";

export interface ReviewAttestationGuardIo {
  /** Read an authored body file. May throw; the caller turns that into a refusal. */
  readText(path: string): string;
  resolveCommitReachability(repo: string, sha: string): Promise<CommitReachability>;
  /** The repo `gh` itself would target when argv names none. */
  resolveDefaultRepo(): Promise<string | null>;
}

export interface ReviewAttestationRefusal {
  /** Stable machine-readable cause, for logs and tests. */
  reason:
    | "malformed-attestation"
    | "ambiguous-attestation"
    | "unreachable-attestation"
    | "unresolved-target"
    | "unreadable-body"
    | "unparsable-request-body";
  message: string;
}

// -- argv parsing ------------------------------------------------------------

/** `gh pr review` spells --body-file as -F. That collides with `gh api`'s
 *  typed --field, so the two forms must be parsed separately rather than by one
 *  shared flag table. */
const PR_REVIEW_BODY_FILE_FLAGS = new Set(["--body-file", "-F"]);
const PR_REVIEW_BODY_INLINE_FLAGS = new Set(["--body", "-b"]);
const REPO_FLAGS = new Set(["--repo", "-R"]);

/** Flags on `gh pr review` that consume the following argv element. Needed so
 *  a flag's value is never mistaken for the positional PR argument. */
const PR_REVIEW_VALUE_FLAGS = new Set([
  "--body-file",
  "-F",
  "--body",
  "-b",
  "--repo",
  "-R",
]);

const PR_URL_PATTERN = /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/(\d+)(?:[/?#].*)?$/;
const API_REVIEWS_PATH_PATTERN = /^\/?repos\/([^/]+\/[^/]+)\/pulls\/(\d+)\/reviews\/?$/;

function splitFused(arg: string): { flag: string; value: string } | null {
  const long = /^(--[a-z-]+)=([\s\S]*)$/.exec(arg);
  if (long) return { flag: long[1]!, value: long[2]! };
  // Short flags accept a fused value: -Rowner/name, -F/tmp/body.md.
  const short = /^(-[A-Za-z])(.+)$/.exec(arg);
  if (short) {
    const value = short[2]!.startsWith("=") ? short[2]!.slice(1) : short[2]!;
    return { flag: short[1]!, value };
  }
  return null;
}

/**
 * Recognise a pull-request review submission in a `gh` argv.
 *
 * Returns null for everything else, including `gh pr comment` and read-only
 * calls, so a non-review invocation is never delayed by this guard.
 */
export function parseReviewSubmission(argv: readonly string[]): ReviewSubmission | null {
  if (argv[0] === "pr" && argv[1] === "review") return parsePrReview(argv.slice(2));
  if (argv[0] === "api") return parseApiReview(argv.slice(1));
  return null;
}

function parsePrReview(rest: readonly string[]): ReviewSubmission {
  const submission: ReviewSubmission = {
    repo: null,
    repoSource: null,
    pullNumber: null,
    body: null,
  };

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]!;

    const fused = splitFused(arg);
    if (fused) {
      if (REPO_FLAGS.has(fused.flag)) {
        submission.repo = fused.value;
        submission.repoSource = "argv-flag";
      } else if (PR_REVIEW_BODY_FILE_FLAGS.has(fused.flag)) {
        submission.body = { kind: "file", path: fused.value };
      } else if (PR_REVIEW_BODY_INLINE_FLAGS.has(fused.flag)) {
        submission.body = { kind: "inline", text: fused.value };
      }
      continue;
    }

    if (PR_REVIEW_VALUE_FLAGS.has(arg)) {
      const value = rest[i + 1];
      if (value !== undefined) {
        if (REPO_FLAGS.has(arg)) {
          submission.repo = value;
          submission.repoSource = "argv-flag";
        } else if (PR_REVIEW_BODY_FILE_FLAGS.has(arg)) {
          submission.body = { kind: "file", path: value };
        } else {
          submission.body = { kind: "inline", text: value };
        }
        i += 1;
      }
      continue;
    }

    if (arg.startsWith("-")) continue;

    // First bare positional is the PR selector: a number, a URL, or a branch.
    // A branch name carries no number and is left null — the caller then falls
    // back to gh's own default-repo resolution for reachability.
    if (submission.pullNumber === null && submission.repoSource !== "argv-url") {
      const url = PR_URL_PATTERN.exec(arg);
      if (url) {
        submission.repo = url[1]!;
        submission.repoSource = "argv-url";
        submission.pullNumber = Number(url[2]!);
        continue;
      }
      if (/^\d+$/.test(arg)) submission.pullNumber = Number(arg);
    }
  }

  return submission;
}

/**
 * Recognise `gh api repos/{o}/{r}/pulls/{n}/reviews -X POST`.
 *
 * A GET against the same path is a read and must pass through untouched — the
 * idempotency check in Ally's own workflow issues exactly that call, so
 * treating every `.../reviews` path as a submission would guard the read and
 * double the cost of every review.
 */
function parseApiReview(rest: readonly string[]): ReviewSubmission | null {
  let path: string | null = null;
  let method: string | null = null;
  let body: ReviewBodySource | null = null;

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]!;

    const fused = splitFused(arg);
    if (fused) {
      if (fused.flag === "--method" || fused.flag === "-X") method = fused.value;
      else if (fused.flag === "--input") body = { kind: "json-request-file", path: fused.value };
      else if (isFieldFlag(fused.flag)) {
        const parsed = parseBodyField(fused.value);
        if (parsed) body = parsed;
      }
      continue;
    }

    if (arg === "--method" || arg === "-X") {
      const value = rest[i + 1];
      if (value !== undefined) {
        method = value;
        i += 1;
      }
      continue;
    }
    if (arg === "--input") {
      const value = rest[i + 1];
      if (value !== undefined) {
        body = { kind: "json-request-file", path: value };
        i += 1;
      }
      continue;
    }
    if (isFieldFlag(arg)) {
      const value = rest[i + 1];
      if (value !== undefined) {
        const parsed = parseBodyField(value);
        if (parsed) body = parsed;
        i += 1;
      }
      continue;
    }

    if (!arg.startsWith("-") && path === null) path = arg;
  }

  if (path === null) return null;
  const match = API_REVIEWS_PATH_PATTERN.exec(path);
  if (!match) return null;
  // `gh api` defaults to GET; a body-bearing field flag implies POST the same
  // way gh itself infers it.
  const isWrite = method !== null ? method.toUpperCase() !== "GET" : body !== null;
  if (!isWrite) return null;

  return {
    repo: match[1]!,
    repoSource: "argv-api-path",
    pullNumber: Number(match[2]!),
    body,
  };
}

function isFieldFlag(flag: string): boolean {
  return flag === "-f" || flag === "-F" || flag === "--field" || flag === "--raw-field";
}

/** Pull the review text out of a `key=value` field expression. Only the `body`
 *  key carries the authored review; `event` and `commit_id` are metadata. */
function parseBodyField(expression: string): ReviewBodySource | null {
  const equals = expression.indexOf("=");
  if (equals < 0) return null;
  if (expression.slice(0, equals) !== "body") return null;
  const value = expression.slice(equals + 1);
  if (value.startsWith("@") && value.length > 1) return { kind: "file", path: value.slice(1) };
  return { kind: "inline", text: value };
}

// -- attestation scanning ----------------------------------------------------

// Mirrors ally-review-detection.ts. A fenced span is quoted content, not this
// review's own attestation: a review *of this guard* quotes `Reviewed head:`
// lines in prose, and flagging those would refuse honest reviews of exactly
// the code that does the refusing. Lines are blanked rather than removed so
// the line anchors below keep pointing at the same text.
const FENCE_DELIMITER_PATTERN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE_PATTERN = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

function withoutFencedCodeBlocks(body: string): string {
  if (!body.includes("```") && !body.includes("~~~")) return body;
  const lines = body.split("\n");
  let open: { char: string; length: number } | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (open) {
      const close = FENCE_CLOSE_PATTERN.exec(line);
      const closes = close && close[1]![0] === open.char && close[1]!.length >= open.length;
      lines[i] = "";
      if (closes) open = null;
      continue;
    }
    const fence = FENCE_DELIMITER_PATTERN.exec(line);
    if (fence && !(fence[1]![0] === "`" && fence[2]!.includes("`"))) {
      open = { char: fence[1]![0]!, length: fence[1]!.length };
      lines[i] = "";
    }
  }
  return lines.join("\n");
}

// CommonMark starts an indented code block at four columns, and a tab always
// reaches column four. Both are excluded, matching the consumer.
const NOT_INDENTED_CODE = String.raw`(?! *\t)(?! {4})`;
const MARKDOWN_EMPHASIS_RUN = "[*_`]{0,3}";

// The loose half of the loose/strict split. This captures whatever token
// follows the label — 40 hex, 42 hex, a short SHA, a placeholder — because the
// producer's question is "did this body try to attest?", not "did it succeed?".
// The token run excludes emphasis characters so a backticked SHA yields the
// SHA rather than the delimiters.
//
// Group 2 deliberately captures the REST OF THE LINE. Validating only the
// token is not enough: the consumer requires the line to end after optional
// delimiters and whitespace, so `Reviewed head: <40-hex> and some prose` has a
// perfectly good token and still matches the consumer's pattern nowhere. That
// shape would attest no head and livelock the gate, which is the exact defect
// this guard exists to refuse — so the whole line has to be checked, not just
// the token it contains.
const ATTESTATION_CANDIDATE_PATTERN = new RegExp(
  `(?:^|\\n)${NOT_INDENTED_CODE} {0,3}${MARKDOWN_EMPHASIS_RUN}[ \\t]{0,3}reviewed head:[ \\t]*` +
    `${MARKDOWN_EMPHASIS_RUN}([^\\s*_\`]*)([^\\n]*)`,
  "gi",
);

/** Exactly 40 lowercase hex, and nothing else. */
const WELL_FORMED_SHA_PATTERN = /^[0-9a-f]{40}$/;

// What the consumer tolerates after the SHA, and nothing more: an unbalanced
// emphasis run and trailing whitespace, then end of line. Mirrors the tail of
// REVIEWED_HEAD_ATTESTATION_PATTERN in ally-review-detection.ts.
const ACCEPTED_ATTESTATION_TRAILER_PATTERN = /^[*_`]{0,3}[ \t]*[*_`]{0,3}[ \t]*$/;

/**
 * Classify a review body's `Reviewed head:` attestation.
 *
 * Case-insensitive on the label and on the SHA, matching the consumer, which
 * lowercases what it extracts.
 */
export function inspectReviewAttestation(body: string): ReviewAttestation {
  const emitted = withoutFencedCodeBlocks(body);
  const candidates = Array.from(emitted.matchAll(ATTESTATION_CANDIDATE_PATTERN), (match) => ({
    token: match[1] ?? "",
    trailer: match[2] ?? "",
  }));

  if (candidates.length === 0) return { kind: "absent" };
  if (candidates.length > 1) {
    return { kind: "ambiguous", raw: candidates.map((candidate) => candidate.token) };
  }

  const { token, trailer } = candidates[0]!;
  const normalized = token.toLowerCase();
  if (!WELL_FORMED_SHA_PATTERN.test(normalized)) {
    return { kind: "malformed", raw: token, detail: "not-a-sha" };
  }
  if (!ACCEPTED_ATTESTATION_TRAILER_PATTERN.test(trailer)) {
    return { kind: "malformed", raw: `${token}${trailer}`, detail: "trailing-content" };
  }
  return { kind: "well-formed", sha: normalized };
}

// -- the guard ---------------------------------------------------------------

/**
 * Pull the authored Markdown out of a `gh api --input` request payload.
 *
 * `no-body` is a legitimate shape, not an error: `{"event":"APPROVE"}` is a
 * valid review submission that carries no comment and therefore attests
 * nothing. `unparsable` covers a file that is not a JSON object, or whose
 * `body` member is present but not a string — the request would be rejected by
 * GitHub anyway, and refusing costs nothing while guessing could let an
 * unverified attestation through in a shape nobody anticipated.
 */
function decodeJsonRequestBody(
  raw: string,
): { kind: "text"; text: string } | { kind: "no-body" } | { kind: "unparsable" } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "unparsable" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { kind: "unparsable" };
  }
  const body = (parsed as Record<string, unknown>).body;
  if (typeof body === "string") return { kind: "text", text: body };
  if (body === undefined) return { kind: "no-body" };
  return { kind: "unparsable" };
}

/**
 * Decide whether a `gh` invocation may post its review.
 *
 * Returns null to allow. A non-null refusal must abort the invocation: the
 * point of the guard is that the review never reaches GitHub.
 *
 * Only fires when argv is a review submission *and* the body carries an
 * attestation. A review with no `Reviewed head:` line is passed through — an
 * approval carrying no attestation is a different defect, already reported by
 * invariant I2d in scripts/check-ally-review-consistency.mjs, and refusing it
 * here would block every non-Ally agent's ordinary `gh pr review` too.
 */
export async function evaluateReviewSubmission(
  argv: readonly string[],
  io: ReviewAttestationGuardIo,
): Promise<ReviewAttestationRefusal | null> {
  const submission = parseReviewSubmission(argv);
  if (!submission || !submission.body) return null;

  let text: string;
  if (submission.body.kind === "inline") {
    text = submission.body.text;
  } else {
    // `-` is stdin, which the runtime rejects before reaching here.
    if (submission.body.path === "-") return null;
    let raw: string;
    try {
      raw = io.readText(submission.body.path);
    } catch {
      return {
        reason: "unreadable-body",
        message: `cannot read review body ${submission.body.path}; refusing to post a review whose attestation cannot be checked`,
      };
    }

    if (submission.body.kind === "json-request-file") {
      const decoded = decodeJsonRequestBody(raw);
      if (decoded.kind === "unparsable") {
        return {
          reason: "unparsable-request-body",
          message: attestationRefusalMessage(
            `${submission.body.path} is not a JSON object with a string "body"`,
            "The review text cannot be located, so its attestation cannot be checked.",
          ),
        };
      }
      // A review with no comment body attests nothing; nothing to check.
      if (decoded.kind === "no-body") return null;
      text = decoded.text;
    } else {
      text = raw;
    }
  }

  const attestation = inspectReviewAttestation(text);
  if (attestation.kind === "absent") return null;

  if (attestation.kind === "malformed") {
    const detail =
      attestation.detail === "not-a-sha"
        ? `"Reviewed head: ${attestation.raw}" is not a 40-character hex commit SHA ` +
          `(${attestation.raw.length} characters)`
        : `the attestation line does not end after the SHA: ` +
          `"Reviewed head: ${attestation.raw}"`;
    return {
      reason: "malformed-attestation",
      message: attestationRefusalMessage(
        detail,
        "A malformed attestation can never match any head, so the review would be " +
          "permanently unable to satisfy the review gate.",
      ),
    };
  }

  if (attestation.kind === "ambiguous") {
    return {
      reason: "ambiguous-attestation",
      message: attestationRefusalMessage(
        `the body carries ${attestation.raw.length} "Reviewed head:" attestations (${attestation.raw.join(", ")})`,
        "Consumers require exactly one attestation and treat several as none, so " +
          "the review would attest no head at all.",
      ),
    };
  }

  const repo = submission.repo ?? (await io.resolveDefaultRepo());
  if (!repo) {
    return {
      reason: "unresolved-target",
      message: attestationRefusalMessage(
        "the target repository could not be determined from argv or from the checkout",
        "The attestation cannot be checked against a repository that is not known.",
      ),
    };
  }

  const reachability = await io.resolveCommitReachability(repo, attestation.sha);
  if (reachability === "reachable") return null;

  // Reachable-but-not-head is deliberately allowed: reviewing a prior head is
  // legitimate and normal, and the gate's own staleness rules handle it. The
  // question here is only whether this review belongs to this repository.
  const detail =
    reachability === "unreachable"
      ? `commit ${attestation.sha} does not exist in ${repo}`
      : `could not confirm commit ${attestation.sha} exists in ${repo}`;
  return {
    reason: "unreachable-attestation",
    message: attestationRefusalMessage(
      detail,
      reachability === "unreachable"
        ? "The review was computed against a different repository or a commit that " +
            "has since been rewritten, so it does not describe this pull request."
        : "Refusing rather than guessing: an unverifiable approval is not recoverable, " +
            "a refused one is — re-run the review.",
    ),
  };
}

function attestationRefusalMessage(detail: string, why: string): string {
  return `refusing to submit PR review: ${detail}. ${why}`;
}
