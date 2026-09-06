/**
 * GitHub webhook receiver — drives paperclip issue wakes from GitHub
 * events so a long-running CI cycle, PR review, PR comment, or PR/branch event
 * doesn't sit silently while the agent that owns the linked issue
 * waits for its next 5-min heartbeat-timer tick.
 *
 * 2026-05-06 BLO-3182 RCA:
 *   - The user explicitly called out "issues should respond to linear
 *     comments or github hooks. particularly CI job completion since
 *     that takes a long time" -- a build that takes 8 minutes followed
 *     by a 5-minute heartbeat tick means a 13-minute round-trip just
 *     to react to a CI failure.
 *   - Production agents run on `claude_k8s` / `opencode_k8s`; the wake
 *     plumbing here calls `heartbeatService(db).wakeup(...)` which is
 *     adapter-agnostic.
 *
 * Issue identification: GitHub events don't carry paperclip issue
 * IDs. We extract the paperclip identifier (e.g. `BLO-3182`) from the
 * PR's head_branch (`fix/BLO-3182-foo`), title, or body. The match
 * against `issues.identifier` is exact.
 *
 * HMAC verification uses GitHub's `x-hub-signature-256` header
 * (`sha256=<hex>`) with timing-safe compare against
 * `GITHUB_WEBHOOK_SECRET`. Rejects all events when the secret isn't
 * configured -- safer to refuse silently than to accept unsigned
 * requests masquerading as GitHub.
 */
import { Router } from "express";
import crypto from "node:crypto";
import {
  type Db,
  POSTGRES_POOL_MAX,
  agents,
  agentWakeupRequests,
  companies,
  heartbeatRuns,
  issueComments,
  issueWorkProducts,
  issues,
} from "@paperclipai/db";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { heartbeatService, type HeartbeatServiceOptions } from "../services/heartbeat.js";
import {
  evaluateAgentInvokability,
  type AgentOrgRow,
} from "../services/agent-invokability.js";
import { issueService } from "../services/issues.js";
import {
  GITHUB_DEPENDABOT_ALERT_ORIGIN_KIND,
  GITHUB_DEPENDABOT_WEBHOOK_DIAGNOSTIC_ORIGIN_KIND,
  findOpenDependabotAlertIssue,
  findTerminalDependabotAlertIssues,
  recordDependabotWebhookDiagnostic,
  resolveDependabotIssueAssigneeId,
} from "../services/dependabot-alert-issues.js";
import { logger } from "../middleware/logger.js";
import { HttpError } from "../errors.js";
import { redactSensitiveText } from "../redaction.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import {
  extractPaperclipIdentifiers,
  resolveOwningPaperclipIdentifiers,
  type OwningIdentifierResolution,
} from "../services/paperclip-identifiers.js";
import {
  githubFetchPrHeadSha,
  githubReviewerIdentityMatches,
  githubListIssueCommentBodies,
  githubPostIssueComment,
} from "../services/github-app-auth.js";
import {
  hasActionablePrReviewFeedback,
  hasAllyConsolidatedReviewHeading,
} from "../services/ally-review-detection.js";
import { runPrCommentReviewGateCheck } from "../services/pr-comment-review-gate.js";
import { enqueueGithubCommitStatusDelivery } from "../services/github-status-delivery-outbox.js";
import { recoveryService } from "../services/recovery/service.js";
import {
  GITHUB_SUPPRESSION_CAUSE_REVIEWER_LOCK_CONTENDED,
  recordGithubReviewRequestDelivery,
  recordGithubReviewRequestSuppressed,
  recordGithubReviewPosted,
  recordGithubWorkflowRunConclusion,
  type GithubReviewSurface,
} from "../services/metrics.js";
import {
  recordMergedPullRequest,
  enrichAuthoredLocForRow,
  type RecordMergedPullRequestInput,
} from "../services/issue-pull-requests.js";
import { getAgentOrgChainHealth, type AgentEligibilityAgent } from "@paperclipai/shared";
import { workProductService } from "../services/work-products.js";
import {
  buildPullRequestWorkProductFields,
  PULL_REQUEST_WORK_PRODUCT_METADATA_SOURCE,
  PULL_REQUEST_WORK_PRODUCT_SOURCE_TRUST_ACTOR_ID,
  pullRequestExternalId,
} from "../services/pull-request-work-products.js";
import { matchesTaskKey, normalizePrReviewRepoFullName } from "../services/pr-review-duplicate-issue-guard.js";
import {
  activateGithubReviewGateDelivery,
  enqueueGithubReviewGateDelivery,
  type GithubReviewGateAuthorityConfig,
} from "../services/github-review-gate-authority.js";

type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type PrReviewerSelectionDb = Pick<Db | DbTransaction, "select">;

// Keep lock contention well below GitHub's webhook timeout. If this bounded
// serialization layer times out, return a retryable error rather than dispatch
// outside the lock and violate the issue-create duplicate guard. The winner
// holds one pooled connection while heartbeat commits through another;
// createDb's default pool satisfies the required minimum of two.
const PR_REVIEWER_TASK_LOCK_TIMEOUT_MS = 2_000;
const PR_REVIEWER_TASK_LOCK_RETRY_MS = 25;
const ACTIVE_PR_REVIEWER_RUN_STATUSES = ["queued", "running", "scheduled_retry"] as const;

class PrReviewerTaskLockTimeoutError extends Error {
  constructor() {
    super("timed out acquiring PR reviewer task assignment lock");
    this.name = "PrReviewerTaskLockTimeoutError";
  }
}

class PrReviewerTaskLockContentionError extends HttpError {
  constructor() {
    super(503, "PR reviewer dispatch is contended; retry this webhook delivery", {
      code: "pr_reviewer_dispatch_contended",
    });
    this.name = "PrReviewerTaskLockContentionError";
  }
}

export interface GithubWebhookConfig {
  /**
   * Shared secret configured on the GitHub webhook. When null/empty,
   * the route 503s every request -- production must always set this.
   * Test fixtures that exercise the route in isolation supply a
   * known value and craft signed payloads.
   */
  webhookSecret: string | null;
  pluginWorkerManager?: PluginWorkerManager;
  /**
   * Agent IDs that receive additional wakes on PR-shaped events. New reviews
   * are assigned to the least-loaded invokable reviewer. The singular option is
   * retained for callers that have not migrated to the pool configuration.
   *
   * Review-driving events are
   * (`pull_request.opened`, `pull_request.reopened`,
   * `pull_request.ready_for_review`, `pull_request_review.submitted`). Drives automated PR review. The
   * reviewer wake fires independently of the issue-assignee wake and
   * does NOT require the PR branch/title/body to reference a paperclip
   * identifier. When null, only the legacy issue-assignee wake fires.
   */
  prReviewerAgentIds?: readonly string[] | null;
  prReviewerAgentId?: string | null;
  /**
   * GitHub login for the automated PR reviewer bot. Used to recognize
   * comment-mode review output, which arrives as issue_comment.created rather
   * than pull_request_review.submitted.
   */
  prReviewerBotLogin?: string | null;
  /**
   * Resolve the current PR head for issue-comment review events. GitHub's
   * `issue_comment` payload omits `pull_request.head.sha`, but reviewer
   * evidence is valid only for the exact head that was reviewed. Production
   * uses the GitHub App lookup; route tests can provide a deterministic seam.
   */
  resolvePrReviewHeadSha?: typeof githubFetchPrHeadSha;
  /**
   * Optional seam for the comment-review status gate. Production uses the
   * service implementation; route tests supply a local recorder so webhook
   * behavior is verified without contacting GitHub.
   */
  runPrCommentReviewGateCheck?: typeof runPrCommentReviewGateCheck;
  /**
   * Absolute public origin of this Paperclip deployment (PAPERCLIP_PUBLIC_URL),
   * used to build the absolute issue URL posted back onto PRs (BLO-13353). When
   * null, the PR→issue back-link is skipped (no absolute URL can be formed).
   */
  publicBaseUrl?: string | null;
  /**
   * Gate for the PR→issue back-link comment (BLO-13353). Defaults to enabled;
   * set false to disable. Self-gates off anyway when publicBaseUrl is unset or
   * GitHub App creds are absent.
   */
  postIssueBackLink?: boolean;
  /**
   * Number of actionable self-review reopen cycles on a single PR before the
   * webhook escalates up the chain of command instead of re-waking the author
   * (BLO-13353 (b)). Defaults to 3.
   */
  selfReviewEscalationThreshold?: number;
  /**
   * Agent ID that receives a wake for new/reintroduced/reopened Dependabot
   * alerts (`dependabot_alert` events) at or above `dependabotMinSeverity`.
   * The designated remediation agent bumps the dependency (or shepherds the
   * Dependabot PR) and shepherds the fix through CI. When null, dependabot
   * events are acked and ignored.
   */
  dependabotAgentId?: string | null;
  /**
   * Severity floor for dependabot wakes (GitHub severity scale). Alerts
   * below the floor are acked without a wake. Defaults to "high" so a batch
   * advisory drop of moderate/low findings doesn't fan out into dozens of
   * agent runs.
   */
  dependabotMinSeverity?: "low" | "medium" | "high" | "critical";
  /**
   * Optional signed-webhook authority for an App-owned required review status.
   * The route durably records revocation intent before processing the existing
   * webhook effects, so cancelling a workflow cannot preserve authorization.
   */
  reviewGateAuthority?: GithubReviewGateAuthorityConfig | null;
  /**
   * Dispatch ownership and test overrides for heartbeat wakes. Split-tier
   * production forwards its node role so API handlers enqueue for the worker.
   */
  heartbeatOptions?: Pick<
    HeartbeatServiceOptions,
    "paperclipNodeRole" | "penstockAvailabilityGate" | "skipQueuedRunDispatch"
  >;
}

// Identifier extraction (`extractPaperclipIdentifiers`) lives in
// ../services/paperclip-identifiers.js so the forward-capture webhook and the
// PR↔issue linkage/backfill service share one author-agnostic extractor.

// GitHub event names that should drive a wake. Anything not in this
// set is acked with 200 + "ignored" so retries don't pile up.
const WAKE_DRIVING_EVENTS = new Set([
  "check_run",
  "check_suite",
  "dependabot_alert",
  "issue_comment",
  "workflow_run",
  "pull_request_review",
  "pull_request",
]);

// Operators use this as a Paperclip-level reviewer alias in GitHub PR
// comments. It is intentionally parsed from the comment body instead of
// relying on GitHub account mention resolution; there may not be a real
// GitHub user named "ally".
const PR_REVIEWER_COMMENT_MENTION_PATTERN =
  /(^|[^\w])@(?:ally|allyblockcast|blockcast-ci-packages)(?![-\w])/i;

function hasPrReviewerRequestMention(body: string | null | undefined): boolean {
  return typeof body === "string" && PR_REVIEWER_COMMENT_MENTION_PATTERN.test(body);
}

// A DELIBERATE request addresses the reviewer by the bare `@ally` alias — the
// form the agent instructions tell agents to write. The pattern above also
// matches `@allyblockcast[bot]`, which is how the commitperclip template gate
// greets the bot account ("Hey @allyblockcast[bot]! Before this PR can be
// reviewed...") — the very body that drove the #583 loop. Those are correct
// suppressions, not lost handoffs, and they repeat: a sweep on 2026-07-31
// found 7 on Blockcast/paperclip#812 and 3 on #820. Reporting them would bury
// the real signal, so the drop report (BLO-18273) keys on the bare alias only.
//
// `(?![-\w])` is what excludes the longer login: for `@allyblockcast[bot]` the
// character after `@ally` is `b`, a word char, so this cannot match — whereas
// the pattern above backtracks to its `allyblockcast` alternative and does.
const PR_REVIEWER_BARE_ALIAS_MENTION_PATTERN = /(^|[^\w])@ally(?![-\w])/i;

function hasPrReviewerBareAliasMention(body: string | null | undefined): boolean {
  return typeof body === "string" && PR_REVIEWER_BARE_ALIAS_MENTION_PATTERN.test(body);
}

const DEFAULT_PR_REVIEWER_BOT_LOGIN = "allyblockcast[bot]";

function normalizeGithubLogin(login: string): string {
  return login
    .trim()
    .toLowerCase()
    .replace(/^@/, "")
    .replace(/^app\//, "")
    .replace(/\[bot\]$/, "")
    .trim();
}

function isConfiguredPrReviewerAuthor(
  login: string | null | undefined,
  configuredLogin: string | null | undefined,
): boolean {
  if (!login) return false;
  const normalizedLogin = normalizeGithubLogin(login);
  if (!normalizedLogin) return false;
  const configured = normalizeGithubLogin(configuredLogin || DEFAULT_PR_REVIEWER_BOT_LOGIN);
  if (configured && normalizedLogin === configured) return true;
  return normalizedLogin === "ally" || normalizedLogin === "allyblockcast" || normalizedLogin === "blockcast-ci-packages";
}

function hasAllyConsolidatedReviewHeader(body: string | null | undefined): boolean {
  return typeof body === "string" && /\bAlly\s*(?:—|-|:)\s*Consolidated\s+PR\s+Review\b/i.test(body);
}

// Explicit "a Paperclip agent is asking for review" marker (BLO-18865).
//
// Agents post PR comments through the Paperclip GitHub App, so their comment
// author login IS the reviewer bot's own login (allyblockcast[bot]).
// Author login therefore cannot separate "agent requesting a review" from
// "the reviewer bot's own output", and the author-scoped guard below dropped
// every agent-issued @ally request — leaving agents with no comment-based and
// no push-based way to get a re-review (observed on Blockcast/paperclip#814:
// two pushes and two @ally comments produced nothing over 2h19m).
//
// The marker restores that path. Two properties keep the #583 self-refire
// loop dead, and both matter — do not relax either without re-reading the
// guard comment at the reviewerRequest assignment:
//
//   1. ANCHORED TO LITERAL BYTE 0 of the body — not "the first non-whitespace
//      character". The loop in #583 was driven by bot-authored bodies that
//      mention the alias *somewhere* — a salutation, or the bot's own reply
//      quoting the alias as an example. A marker Ally merely quotes back while
//      explaining a request it is answering lands mid-body, so it cannot
//      re-arm the trigger.
//
//      Allowing leading whitespace would reopen exactly that hole: four spaces
//      at the start of a Markdown body is an indented CODE BLOCK, i.e. the
//      canonical way a reviewer renders "here is the marker you should use".
//      `    <!-- paperclip:review-request -->\n    @ally review` is a quoted
//      example, but with `^\s*` it satisfies both this pattern and the alias
//      mention, and each such comment carries a fresh comment-scoped
//      idempotency key — a self-refire loop with no dedup backstop. So: no
//      `\s*` prefix, ever. A real requester controls its own body and can put
//      the marker first.
//   2. NEVER on Ally's own review output. A body whose consolidated-review
//      header stands on its own line is not a request regardless of any marker,
//      so Ally echoing the marker into its own review verdict still enqueues
//      nothing. See hasAllyConsolidatedReviewHeading for why this is matched
//      on the heading shape rather than anywhere in the body.
//
// Trailing attributes are allowed (e.g. `<!-- paperclip:review-request
// agent=cto -->`) so the marker can carry provenance without a parser change.
// The token must be followed by whitespace or the closing `-->` so that a
// longer lookalike token (`paperclip:review-request-something`) is not a match.
const PR_REVIEWER_AGENT_REQUEST_MARKER_PATTERN =
  /^<!--[ \t]*paperclip:review-request(?:[ \t][^>]*)?[ \t]*-->/i;

function hasPrReviewerAgentRequestMarker(body: string | null | undefined): boolean {
  return typeof body === "string" && PR_REVIEWER_AGENT_REQUEST_MARKER_PATTERN.test(body);
}

// BLO-23395: posted by .github/workflows/merge-queue-eviction-detector.yml
// (scripts/merge-queue-eviction-detector.mjs) via the default GITHUB_TOKEN
// whenever a PR is removed from the merge queue without being merged. Gated
// on the exact github-actions[bot] login below (not just the marker) so an
// arbitrary commenter cannot spoof a merge-queue-eviction wake.
const MERGE_QUEUE_EVICTION_MARKER = "<!-- paperclip:merge-queue-eviction -->";
const MERGE_QUEUE_EVICTION_BOT_LOGIN = "github-actions[bot]";

function hasMergeQueueEvictionMarker(body: string | null | undefined): boolean {
  return typeof body === "string" && body.trimStart().startsWith(MERGE_QUEUE_EVICTION_MARKER);
}

// BLO-23059: Claude Code Review posts its "this integration is paused/disabled"
// org-settings notice as a FORMAL pull_request_review (state COMMENTED, commit_id
// = current head), not as a plain comment. Measured 2026-08-07:
// `org:Blockcast "Claude Code Review is paused for this repository" type:pr` →
// 98 hits across Network-Operator-Portal, magma, multicast, trafficcontrol and
// others, and every sampled one is a review object rather than a comment.
//
// A review object with a prNumber drives BOTH wakes in this handler — the
// reviewer counter-review pass (shouldFirePrReviewerWake) and the PR-author wake
// (the `isPrWake` fallback, which fires regardless of
// isActionableReviewFeedbackContext). The author wake renders the prRole:"author"
// directive, "a reviewer just posted findings on YOUR pull request … push a
// follow-up commit addressing them". There are no findings: the body is addressed
// to a GitHub org admin. So the directive asserts something false, and an agent
// that trusts it over the body is pushed toward inventing a change to "address"
// or reporting that it addressed feedback it never received.
//
// The existing body heuristic does NOT catch this and is not the right tool:
// hasActionablePrReviewFeedback already returns false here (verified against the
// verbatim body of review 4887250738 on Network-Operator-Portal#657), which is
// exactly why only the findings-shaped comment is skipped while both wakes still
// fire. Suppression has to drop the EVENT, which is what returning null does.
//
// Deliberately a NAMED-INSTANCE filter, not a general "findings-free review"
// heuristic. The obvious risk in suppressing at the webhook is eating a
// legitimately terse review ("LGTM", "one nit inline"), and a findings-free rule
// would do precisely that. All three conditions below must hold, so a short
// human review is never a candidate:
//
//   1. The author is a Claude Code Review App identity — BOTH a `[bot]`-suffixed
//      login AND a GitHub-reported user type of "Bot". A human (or another bot)
//      quoting the notice text — in a review that discusses this very issue — is
//      not suppressed.
//   2. The body carries the notice's own heading AND its paused/disabled
//      sentence. Matched against the RAW body, before clampReviewBody, so a long
//      body cannot fail the match by truncation.
//   3. The body has no actionable findings. Belt-and-braces: if claude[bot] ever
//      ships a review that both carries the notice and flags something, the
//      findings win and the event is delivered.
//
// Every failure mode of this predicate is fail-OPEN — an unmatched notice simply
// wakes as it does today. If Anthropic reworks the notice text, we regress to the
// current behaviour rather than silently dropping real reviews.
//
// The `[bot]` suffix is REQUIRED, not optional (Ally review on #1255). GitHub
// reserves the bracketed suffix for App identities and forbids `[`/`]` in user
// logins, so requiring it already excludes the `claude` and `claude-code` User
// accounts — both of which exist as ordinary registerable logins, and either of
// which could review a PR quoting this notice (this repo's own PRs discuss it).
// The user-type gate below is the independent second half of that narrowing: it
// comes from GitHub rather than from our own spelling of the login, so an
// alternate future service login is only ever suppressed once GitHub itself has
// confirmed it is Bot-typed.
const CLAUDE_CODE_REVIEW_BOT_LOGIN_PATTERN = /^claude(?:-code)?\[bot\]$/i;
const CLAUDE_CODE_REVIEW_NOTICE_HEADING_PATTERN = /^[ \t]*#{1,6}[ \t]*Claude Code Review[ \t]*$/im;
const CLAUDE_CODE_REVIEW_NOTICE_SENTENCE_PATTERN =
  /\bClaude Code Review is (?:paused|disabled) for this repository\b/i;

function isClaudeCodeReviewServiceNotice(
  rawBody: string | null | undefined,
  state: string | null | undefined,
  authorLogin: string | null | undefined,
  authorType: string | null | undefined,
): boolean {
  // A service notice is always COMMENTED. An APPROVED or CHANGES_REQUESTED
  // review carries a merge-gate signal that must reach the author regardless of
  // what its body says.
  if (state?.trim().toLowerCase() !== "commented") return false;
  if (typeof authorLogin !== "string") return false;
  if (!CLAUDE_CODE_REVIEW_BOT_LOGIN_PATTERN.test(authorLogin.trim())) return false;
  // GitHub's own classification of the account, independent of how the login is
  // spelled. Absent or non-Bot => fail open and deliver the event.
  if (typeof authorType !== "string" || authorType.trim().toLowerCase() !== "bot") return false;
  if (typeof rawBody !== "string") return false;
  if (!CLAUDE_CODE_REVIEW_NOTICE_HEADING_PATTERN.test(rawBody)) return false;
  if (!CLAUDE_CODE_REVIEW_NOTICE_SENTENCE_PATTERN.test(rawBody)) return false;
  return !hasActionablePrReviewFeedback(rawBody, state);
}

function isActionablePrReviewComment(
  body: string | null | undefined,
  authorLogin: string | null | undefined,
  configuredReviewerLogin: string | null | undefined,
): boolean {
  if (!hasActionablePrReviewFeedback(body)) return false;
  return isConfiguredPrReviewerAuthor(authorLogin, configuredReviewerLogin) || hasAllyConsolidatedReviewHeader(body);
}

/**
 * Detect that this delivery IS a review the reviewer identity just published
 * (BLO-27608), for {@link recordGithubReviewPosted}.
 *
 * Deliberately independent of `resolveEventContext`. That resolver answers "does
 * this event need a wake", and its answer is `null` for most of what we need to
 * count here: a CLEAN comment-shaped review is neither a review REQUEST nor
 * actionable FEEDBACK (`isActionablePrReviewComment` requires findings), so it
 * falls out as no context at all, and the reviewer's own formal review is
 * dropped downstream as a self-echo (BLO-15799). Both of those are correct wake
 * decisions and both would silently zero this counter — the reviewer's own
 * output is precisely the artifact whose absence we are trying to alert on. So
 * this reads the signed payload directly and shares no control flow with the
 * wake path.
 *
 * Returns `null` for anything that is not a freshly-published reviewer review.
 */
function resolvePostedReviewObservation(
  eventName: string,
  payload: Record<string, unknown>,
  configuredReviewerLogin: string | null | undefined,
): { repoFullName: string | null; prNumber: number | null; surface: GithubReviewSurface } | null {
  const repository = payload.repository as Record<string, unknown> | undefined;
  const repoFullName = readStringField(repository, "full_name");
  const action = payload.action as string | undefined;

  if (eventName === "pull_request_review") {
    // Only `submitted` publishes a review; `edited`/`dismissed` mutate one that
    // was already counted when it landed.
    if (action !== "submitted") return null;
    const review = payload.review as Record<string, unknown> | undefined;
    const reviewUser = review?.user as Record<string, unknown> | undefined;
    if (!isConfiguredPrReviewerAuthor(readStringField(reviewUser, "login"), configuredReviewerLogin)) {
      return null;
    }
    const pr = payload.pull_request as Record<string, unknown> | undefined;
    const prNumberRaw = pr?.number;
    return {
      repoFullName,
      prNumber: typeof prNumberRaw === "number" ? prNumberRaw : null,
      surface: "formal",
    };
  }

  if (eventName === "issue_comment") {
    if (action !== "created") return null;
    const issue = payload.issue as Record<string, unknown> | undefined;
    // `issue_comment` fires for plain issues too; only a PR carries this key.
    if (!issue?.pull_request) return null;
    const comment = payload.comment as Record<string, unknown> | undefined;
    const commentUser = comment?.user as Record<string, unknown> | undefined;
    if (!isConfiguredPrReviewerAuthor(readStringField(commentUser, "login"), configuredReviewerLogin)) {
      return null;
    }
    const commentBody = readStringField(comment, "body");
    // The heading is what separates a published review from the reviewer
    // identity's other PR comments — the control plane's own back-link comment
    // (githubPostIssueComment) and an agent's review REQUEST are both authored
    // under this same login and must not be counted as review output.
    if (!hasAllyConsolidatedReviewHeading(commentBody)) return null;
    // BLO-21618: a marker-prefixed agent request may legitimately quote a
    // heading-shaped line while asking for a fresh pass. The marker is anchored
    // to literal byte 0 and Ally's own output opens with the heading, so marker
    // presence cleanly excludes the request case without touching real reviews.
    if (hasPrReviewerAgentRequestMarker(commentBody)) return null;
    const prNumberRaw = issue.number;
    return {
      repoFullName,
      prNumber: typeof prNumberRaw === "number" ? prNumberRaw : null,
      surface: "comment",
    };
  }

  return null;
}

function timingSafeStringEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function verifyGithubSignature(
  rawBody: Buffer,
  signatureHeader: string | null | undefined,
  secret: string,
): boolean {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return false;
  const expected =
    "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  return timingSafeStringEq(signatureHeader, expected);
}

function readStringField(record: Record<string, unknown> | undefined, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function githubPrUrl(repoFullName: string | null, prNumber: number | null, explicitUrl?: string | null): string | null {
  if (explicitUrl) return explicitUrl;
  if (!repoFullName || prNumber === null) return null;
  return `https://github.com/${repoFullName}/pull/${prNumber}`;
}

// BLO-21078 AC3: a `cancelled` workflow_run conclusion is not, by itself,
// evidence of an infrastructure kill -- this repo's `pr.yml` sets
// `concurrency.cancel-in-progress: true`, so a routine force-push produces
// the exact same conclusion (and, per the issue's own investigation, the
// exact same "every lane dies at one instant" shape). The mass-cancellation
// alert can only be trustworthy if it excludes that benign case, and doing
// so needs no GitHub API call: every workflow_run delivery (not just
// `completed`) carries `head_branch` and the run's own `created_at`, so we
// can track "the newest run id seen for this branch" purely from the
// sequence of webhook deliveries already arriving, then ask -- at the
// moment an older run finishes `cancelled` -- whether a newer run for the
// same branch already existed by then. If so, GitHub's own
// `cancel-in-progress` explains the cancellation and it is not incident
// signal.
const MAX_TRACKED_WORKFLOW_RUN_BRANCHES = 500;
const recentWorkflowRunsByBranch = new Map<string, { runId: number; createdAt: number }>();

function workflowRunBranchKey(repoFullName: string, headBranch: string): string {
  return `${repoFullName}#${headBranch}`;
}

function recordWorkflowRunSighting(
  repoFullName: string | null,
  headBranch: string | null,
  runId: number | null,
  createdAt: number,
): void {
  if (!repoFullName || !headBranch || runId === null || !Number.isFinite(createdAt)) return;
  const key = workflowRunBranchKey(repoFullName, headBranch);
  const existing = recentWorkflowRunsByBranch.get(key);
  // Guards against both a genuinely older re-delivery and this same run's
  // own later webhooks (its `requested`/`in_progress`/`completed` actions
  // share one `created_at`, so a strict `>` never lets a run evict a
  // strictly newer sibling that already superseded it).
  if (existing && existing.createdAt >= createdAt) return;
  // Delete-then-set so the key moves to the end for LRU-style eviction below.
  recentWorkflowRunsByBranch.delete(key);
  recentWorkflowRunsByBranch.set(key, { runId, createdAt });
  while (recentWorkflowRunsByBranch.size > MAX_TRACKED_WORKFLOW_RUN_BRANCHES) {
    const oldestKey = recentWorkflowRunsByBranch.keys().next().value;
    if (oldestKey === undefined) break;
    recentWorkflowRunsByBranch.delete(oldestKey);
  }
}

/**
 * Whether a `cancelled` conclusion for (repoFullName, headBranch, runId) is
 * explained by a newer run on the same branch that already existed by the
 * time this one finished (`updatedAt`) -- i.e. ordinary `cancel-in-progress`
 * supersession rather than an unexplained kill.
 */
function classifyWorkflowRunSupersession(
  repoFullName: string | null,
  headBranch: string | null,
  runId: number | null,
  updatedAt: number,
): "superseded" | "none" {
  if (!repoFullName || !headBranch || runId === null || !Number.isFinite(updatedAt)) return "none";
  const latest = recentWorkflowRunsByBranch.get(workflowRunBranchKey(repoFullName, headBranch));
  if (!latest || latest.runId === runId) return "none";
  return latest.createdAt <= updatedAt ? "superseded" : "none";
}

export function __resetWorkflowRunSupersessionTrackingForTest(): void {
  recentWorkflowRunsByBranch.clear();
}

export const __test_recordWorkflowRunSighting = recordWorkflowRunSighting;
export const __test_classifyWorkflowRunSupersession = classifyWorkflowRunSupersession;

type PrCommentReviewGateWebhookTrigger = {
  repoFullName: string;
  prNumber: number;
  headSha?: string;
  prUrl: string | null;
};

/**
 * Select webhook deliveries that can change the comment-shaped Ally gate.
 * This deliberately reads the signed raw payload rather than the wake context:
 * it must work for PRs without Paperclip identifiers and for a clean review
 * that clears a prior failure.
 */
function resolvePrCommentReviewGateWebhookTrigger(
  eventName: string,
  payload: Record<string, unknown>,
  configuredReviewerLogin: string | null | undefined,
): PrCommentReviewGateWebhookTrigger | null {
  const repository = payload.repository as Record<string, unknown> | undefined;
  const repoFullName = readStringField(repository, "full_name");
  if (!repoFullName) return null;

  if (eventName === "issue_comment") {
    if (payload.action !== "created") return null;
    const issue = payload.issue as Record<string, unknown> | undefined;
    const pullRequestMarker = issue?.pull_request as Record<string, unknown> | undefined;
    const comment = payload.comment as Record<string, unknown> | undefined;
    const commentUser = comment?.user as Record<string, unknown> | undefined;
    const prNumber = typeof issue?.number === "number" ? issue.number : null;
    if (
      !issue ||
      !pullRequestMarker ||
      prNumber === null ||
      !githubReviewerIdentityMatches(
        readStringField(commentUser, "login") ?? "",
        configuredReviewerLogin || DEFAULT_PR_REVIEWER_BOT_LOGIN,
      ) ||
      !hasAllyConsolidatedReviewHeading(readStringField(comment, "body"))
    ) {
      return null;
    }
    return {
      repoFullName,
      prNumber,
      prUrl: githubPrUrl(repoFullName, prNumber, readStringField(issue, "html_url")),
    };
  }

  // The formal-review surface, which is the one Ally actually uses: 33 of 33
  // consolidated reviews measured in this repo arrived as reviews-API objects
  // and none as issue comments (see pr-comment-review-gate.ts). Without this
  // branch the gate only ever ran on `issue_comment` and at push time — and
  // push time is the one instant at which a review of that head cannot yet
  // exist — so the reviews half of the both-surfaces read added by #1464 was
  // structurally unreachable and every verdict the gate ever published was a
  // green "not evaluated" (BLO-29853: 30/30 recent merges, 9/10 of them on
  // heads that demonstrably had been reviewed).
  if (eventName === "pull_request_review") {
    // All three mutating actions, because the trigger's only job is to answer
    // "could the evaluator now compute something different?" — and it is not
    // this function's job to guess what. `executeCommentReviewGateCheck` never
    // reads this payload: it re-lists both surfaces live and recomputes from
    // the whole history. So the predicate is the reviewer's identity and the
    // fact that their review set changed, nothing about *this* review's body.
    //
    // `dismissed` is included because `githubListPrReviewsWithTimestamps`
    // (github-app-auth.ts:688) drops `DISMISSED` reviews before the evaluator
    // sees them. Dismissing a blocking review therefore does change the
    // verdict, and excluding it here would strand the old `failure` on the PR
    // indefinitely. An earlier revision of this branch excluded `dismissed` on
    // the reasoning that "dismissal leaves the body untouched" — true, and
    // irrelevant, because the reader filters on `state`, not body.
    if (payload.action !== "submitted" && payload.action !== "edited" && payload.action !== "dismissed") {
      return null;
    }
    const review = payload.review as Record<string, unknown> | undefined;
    const reviewUser = review?.user as Record<string, unknown> | undefined;
    const reviewedPr = payload.pull_request as Record<string, unknown> | undefined;
    const reviewedPrNumber = typeof reviewedPr?.number === "number" ? reviewedPr.number : null;
    // Deliberately no consolidated-heading check. Gating dispatch on this
    // payload's body cannot see the body it *replaced*: editing a blocking
    // consolidated review into an ordinary comment would return null here and
    // leave the old `failure` standing forever. The evaluator decides what
    // attests; this function only decides when to ask it.
    if (
      reviewedPrNumber === null ||
      !githubReviewerIdentityMatches(
        readStringField(reviewUser, "login") ?? "",
        configuredReviewerLogin || DEFAULT_PR_REVIEWER_BOT_LOGIN,
      )
    ) {
      return null;
    }
    // No `headSha`, deliberately — let the gate resolve the live head rather
    // than trusting `review.commit_id` or this payload's snapshot. A review can
    // be submitted against a head the branch has already moved past, and a
    // status written to a non-head commit is invisible to branch protection.
    // Resolving live also lets the carried-finding path (BLO-29711) see that
    // the new head is unattested, which passing the stale sha would defeat.
    // Matches the `issue_comment` branch above.
    return {
      repoFullName,
      prNumber: reviewedPrNumber,
      prUrl: githubPrUrl(repoFullName, reviewedPrNumber, readStringField(reviewedPr, "html_url")),
    };
  }

  if (eventName !== "pull_request") return null;
  const action = payload.action;
  if (action !== "opened" && action !== "reopened" && action !== "synchronize") return null;
  const pr = payload.pull_request as Record<string, unknown> | undefined;
  const head = pr?.head as Record<string, unknown> | undefined;
  const prNumber = typeof pr?.number === "number" ? pr.number : null;
  const headSha = readStringField(head, "sha");
  if (prNumber === null || !headSha) return null;
  return {
    repoFullName,
    prNumber,
    headSha,
    prUrl: githubPrUrl(repoFullName, prNumber, readStringField(pr, "html_url")),
  };
}

// PR→issue back-link (BLO-13353, #973 symptom-1). A hidden marker makes the
// one-time post idempotent across redeliveries/reopens: if any existing PR
// comment carries it, we never post again.
const PR_ISSUE_BACKLINK_MARKER = "<!-- paperclip-issue-backlink -->";

function backLinkAbsoluteUrl(publicBaseUrl: string, issuePrefix: string, identifier: string): string {
  const base = publicBaseUrl.replace(/\/+$/, "");
  const prefix = issuePrefix.trim() || "company";
  return `${base}/${encodeURIComponent(prefix)}/issues/${encodeURIComponent(identifier)}`;
}

function buildIssueBackLinkBody(
  publicBaseUrl: string,
  entries: Array<{ identifier: string; issuePrefix: string }>,
): string {
  const lines = entries.map(
    (e) => `🔗 Paperclip issue: [${e.identifier}](${backLinkAbsoluteUrl(publicBaseUrl, e.issuePrefix, e.identifier)})`,
  );
  return `${PR_ISSUE_BACKLINK_MARKER}\n${lines.join("\n")}`;
}

function commentsContainBackLinkMarker(bodies: string[]): boolean {
  return bodies.some((b) => b.includes(PR_ISSUE_BACKLINK_MARKER));
}

// Self-review PR non-convergence escalation (BLO-13353 (b)).
const DEFAULT_SELF_REVIEW_ESCALATION_THRESHOLD = 3;

// Self-review = the PR was authored by the reviewer bot itself, so the bot's
// "review" is a self-review that can't formally request changes. Detected by
// comparing the signed-webhook PR author login to the configured reviewer bot.
function isSelfReviewedPr(context: ResolvedEventContext, reviewerBotLogin: string | null): boolean {
  if (!reviewerBotLogin) return false;
  const author = context.prAuthorLogin;
  if (!author) return false;
  return normalizeGithubLogin(author) === normalizeGithubLogin(reviewerBotLogin);
}

// Count prior actionable-feedback reopen cycles on this (issue, PR). Each call to
// reopenInReviewIssueForActionablePrFeedback inserts one github_pr_review_feedback
// system comment, so this is how many times the PR has been bounced to the author.
async function countPrReviewFeedbackCycles(
  db: Db,
  issueId: string,
  repoFullName: string | null,
  prNumber: number,
): Promise<number> {
  const repoPredicate = repoFullName
    ? sql`(${issueComments.metadata}->>'repoFullName' = ${repoFullName} OR ${issueComments.metadata}->>'repoFullName' IS NULL)`
    : sql`${issueComments.metadata}->>'repoFullName' IS NULL`;
  const rows = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(issueComments)
    .where(
      and(
        eq(issueComments.issueId, issueId),
        sql`${issueComments.metadata}->>'kind' = 'github_pr_review_feedback'`,
        repoPredicate,
        sql`${issueComments.metadata}->>'prNumber' = ${String(prNumber)}`,
      ),
    );
  return rows[0]?.c ?? 0;
}

interface ResolvedEventContext {
  identifiers: string[];
  // BLO-20886: the identifier(s) that OWN this PR (branch/title/labeled
  // Fixes:/Closes:/Refs: line), as opposed to `identifiers` which is every
  // BLO-#### mentioned anywhere, including an informational `Related:` list.
  // Only wakeReasons that drive an author-directed ("prRole: author") wake
  // consult this -- see resolveOwningPaperclipIdentifiers for the rule.
  owningIdentifiers?: string[];
  wakeReason: string;
  prNumber: number | null;
  repoFullName: string | null;
  prTitle?: string | null;
  prUrl?: string | null;
  eventUrl?: string | null;
  headSha?: string | null;
  prPreviousHeadSha?: string | null;
  // pull_request_review.submitted only — drives the author-facing directive
  // so the assignee wake's prompt carries the reviewer's findings without
  // needing a separate `gh pr view` shellout.
  reviewBody?: string | null;
  // Classification must use the raw review body. reviewBody is deliberately
  // clamped for heartbeat context size, but a findings heading can occur
  // after the clamp boundary (as in frr#61 review 4968003838).
  reviewHasActionableFeedback?: boolean;
  reviewState?: string | null;
  // pull_request_review.submitted only — the numeric GitHub review id.
  // Preferred over reviewUrl for the feedback-comment dedupe key (BLO-19497):
  // it is a stable, explicit (pr, review_id) pair rather than an opaque URL.
  reviewId?: number | null;
  reviewAuthorLogin?: string | null;
  reviewUrl?: string | null;
  // BLO-9293: PR author login (pull_request.user.login / issue.user.login on a
  // PR comment). Surfaced to the reviewer wake context so the reviewer-output
  // gate can confirm an intentional self-review skip is on a genuinely
  // bot-authored PR. Distinct from reviewAuthorLogin (the review *event* author).
  prAuthorLogin?: string | null;
  // pull_request events only. Drafts are not reviewable until GitHub emits
  // ready_for_review, so opened/reopened/synchronize must not consume a
  // reviewer slot while this is true.
  prDraft?: boolean;
  // issue_comment.created only -- drives reviewer reruns requested by
  // an operator via "@ally" in a PR comment.
  commentId?: number | null;
  commentBody?: string | null;
  commentAuthorLogin?: string | null;
  commentUrl?: string | null;
  // pull_request.closed only — merged-PR forward-capture (BLO-9117). Drives the
  // issue_pull_requests persist + authored-LOC enrichment. Author is
  // deliberately NOT captured: the link keys on the BLO- ref, never the author.
  prMerged?: boolean;
  prMergedAt?: string | null;
  prUpdatedAt?: string | null;
  prAdditions?: number | null;
  prDeletions?: number | null;
  prBranch?: string | null;
  prBody?: string | null;
  // pull_request events only. The raw GitHub `action`, retained so the
  // work-product upsert (BLO-19566) can describe the PR's state without
  // reverse-mapping it out of wakeReason.
  prAction?: string | null;
}

// Cap review body in contextSnapshot so the heartbeat-run row stays small.
// Author directive renders the truncation marker so the author knows to
// fetch the full body via `gh pr view`.
const REVIEW_BODY_MAX_BYTES = 4096;

/**
 * PEN-2370 (door #7): scrub an externally-authored GitHub body before it is
 * mirrored into Paperclip. Null-preserving so call sites keep their
 * `string | null` contract.
 */
function redactExternalBody(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  return redactSensitiveText(value);
}

function clampReviewBody(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  // PEN-2370 (door #7): this is the single normalization choke point for every
  // externally-authored review/comment body that gets mirrored into an
  // `authorType: "system"` issue comment, so it is where scrubbing belongs --
  // patching the individual comment builders would leave the next mirror site
  // to rediscover the problem.
  //
  // Redact BEFORE clamping, never after -- and on BOTH branches. Every rule in
  // `redactSensitiveText` is anchored on a terminator that sits to the *right*
  // of the secret: `URI_CREDENTIAL_RE` needs the trailing `@`, the env-dump
  // rules need the line end. Truncation deletes exactly that terminator while
  // leaving the head of the value visible, so a clamp-then-redact ordering does
  // not merely miss the secret -- it destroys the pattern that would have
  // caught it. The result is a body that carries a partial credential *and* a
  // `…(truncated)` marker implying the scrubber ran: a fail-open that reads as
  // coverage, which is the failure mode this ticket exists to stop.
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  // One redaction pass over the FULL body, before any length decision.
  const redacted = redactSensitiveText(trimmed);
  if (Buffer.byteLength(redacted, "utf8") <= REVIEW_BODY_MAX_BYTES) return redacted;
  // Byte-length truncation so UTF-8 multibyte characters don't split.
  const buf = Buffer.from(redacted, "utf8");
  let cut = buf.subarray(0, REVIEW_BODY_MAX_BYTES).toString("utf8");
  // `toString("utf8")` replaces split surrogates with U+FFFD; strip a
  // trailing replacement char to avoid a visible glyph in the directive.
  if (cut.endsWith("�")) cut = cut.slice(0, -1);
  return `${cut}\n…(truncated)`;
}

/**
 * Resolve a webhook payload into the routing context, guaranteeing the
 * invariant that every resolved OWNER is also a wake candidate.
 *
 * `identifiers` (every ref the PR mentions anywhere) and `owningIdentifiers`
 * (the ones that actually own it) are extracted by different rules, and the
 * owning tiers are deliberately more permissive in one place: tier 3
 * uppercases the branch, because real branches are lowercase
 * (`sre/blo-20886-...`) and PAPERCLIP_IDENTIFIER_PATTERN is uppercase-only.
 * The broad set does not. So a PR whose ONLY ref is a lowercase branch --
 * `fix/blo-20886-only`, nothing in title or body -- resolved an owner while
 * `identifiers` came back empty, and the route then dropped the delivery at
 * the `no_paperclip_identifier` gate before the owner could be used. Even past
 * that gate the owner was unreachable: author wakes are computed as
 * `matched.filter(m => owning.includes(m.identifier))`, and `matched` derives
 * from `identifiers`, so an owner missing from the broad set silently yields
 * no candidates. Both failures land on the wake this module exists to deliver.
 *
 * The union is taken here, once, rather than in each event branch so the
 * invariant cannot be missed by a case added later.
 *
 * Deliberately NOT fixed by uppercasing the branch inside the broad
 * extraction: that would also fold stale branch refs into `identifiers` for
 * PRs whose branch and title disagree (#909's branch says `blo-20049` while
 * title and body both name BLO-20467, the issue it actually fixes -- 8 such
 * disagreements across the 175 PRs measured for the tier ordering). Those refs
 * are exactly what the tier ranking exists to keep OUT of ownership; widening
 * the broad set with them would spread that noise to every other consumer to
 * fix a gate problem. Unioning the resolved owners adds the one identifier the
 * tiers already decided was authoritative, and nothing else.
 */
function resolveEventContext(
  eventName: string,
  payload: Record<string, unknown>,
  options: Parameters<typeof resolveEventContextRaw>[2] = {},
): ResolvedEventContext | null {
  const context = resolveEventContextRaw(eventName, payload, options);
  if (!context) return null;
  const owning = context.owningIdentifiers ?? [];
  if (owning.length === 0) return context;
  const identifiers = new Set(context.identifiers);
  for (const identifier of owning) identifiers.add(identifier);
  if (identifiers.size === context.identifiers.length) return context;
  return { ...context, identifiers: Array.from(identifiers) };
}

function resolveEventContextRaw(
  eventName: string,
  payload: Record<string, unknown>,
  options: {
    prReviewerBotLogin?: string | null;
    // Invoked when a review request was RECOGNIZED as one but deliberately
    // dropped, so the caller can make the suppression observable (BLO-18273).
    // A callback rather than a logger call inline keeps this function pure and
    // lets the suppression be asserted directly in tests.
    onSuppressedReviewRequest?: (info: {
      repoFullName: string | null;
      prNumber: number | null;
      commentId: number | null;
      commentAuthorLogin: string | null;
      commentUrl: string | null;
      // BLO-21618: two distinct drops share this callback. "missing_marker" is
      // the original BLO-18273 case (bare alias, no marker at all).
      // "marker_disqualified_by_heading" is a marker-bearing agent request
      // whose body ALSO happens to contain a standalone Ally-consolidated-
      // review-heading line (see hasAllyConsolidatedReviewHeading) — the same
      // exclusion that correctly silences Ally's own review echoes also
      // silences this genuine request, and until now did so with zero trace.
      reason: "missing_marker" | "marker_disqualified_by_heading";
    }) => void;
    // BLO-23059: invoked when a pull_request_review.submitted delivery was
    // dropped as a Claude Code Review service notice. Separate from
    // onSuppressedReviewRequest because the two describe different objects — a
    // review has no comment id and its own html_url — and because a dropped
    // review kills BOTH the reviewer and the author wake, where a dropped
    // request only ever suppressed the reviewer one. Same rationale for the
    // callback shape: keeps resolveEventContext pure and lets the suppression be
    // asserted directly rather than through a log spy.
    onSuppressedReviewSubmission?: (info: {
      repoFullName: string | null;
      prNumber: number | null;
      reviewAuthorLogin: string | null;
      reviewState: string | null;
      reviewUrl: string | null;
    }) => void;
  } = {},
): ResolvedEventContext | null {
  const repository = payload.repository as Record<string, unknown> | undefined;
  const repoFullName = (repository?.full_name as string | undefined) ?? null;

  const collectFromPullRequest = (pr: Record<string, unknown> | undefined) => {
    if (!pr) {
      return {
        ids: [] as string[],
        owning: { owning: [] } as OwningIdentifierResolution,
        number: null as number | null,
        title: null as string | null,
        url: null as string | null,
        headSha: null as string | null,
        authorLogin: null as string | null,
      };
    }
    const head = pr.head as Record<string, unknown> | undefined;
    const branch = head?.ref as string | undefined;
    const title = pr.title as string | undefined;
    const body = pr.body as string | undefined;
    const number = (pr.number as number | undefined) ?? null;
    // BLO-9293: PR author login (`pull_request.user.login`). Drives the reviewer
    // self-review-skip gate — NOT the merged-PR issue↔PR link below, which
    // deliberately keys only on the BLO- ref. A distinct, signed-webhook-sourced
    // fact the reviewer run's free-text "self-review" claim is anchored against.
    const user = pr.user as Record<string, unknown> | undefined;
    return {
      ids: extractPaperclipIdentifiers(branch, title, body),
      owning: resolveOwningPaperclipIdentifiers({ branch, title, body }),
      number,
      title: title ?? null,
      url: githubPrUrl(repoFullName, number, readStringField(pr, "html_url")),
      headSha: readStringField(head, "sha"),
      authorLogin: (user?.login as string | undefined) ?? null,
    };
  };

  switch (eventName) {
    case "check_run": {
      const action = payload.action as string | undefined;
      const checkRun = payload.check_run as Record<string, unknown> | undefined;
      // Only wake on terminal events, not on every status flip during the run.
      if (action !== "completed" || !checkRun) return null;
      const pullRequests = (checkRun.pull_requests as Record<string, unknown>[] | undefined) ?? [];
      const allIds = new Set<string>();
      let firstNumber: number | null = null;
      let firstPrUrl: string | null = null;
      for (const pr of pullRequests) {
        const head = pr.head as Record<string, unknown> | undefined;
        const branch = head?.ref as string | undefined;
        for (const id of extractPaperclipIdentifiers(branch)) allIds.add(id);
        const num = pr.number as number | undefined;
        if (firstNumber === null && typeof num === "number") firstNumber = num;
        if (!firstPrUrl) firstPrUrl = githubPrUrl(repoFullName, firstNumber, readStringField(pr, "html_url"));
      }
      const headBranch = checkRun.head_branch as string | undefined;
      for (const id of extractPaperclipIdentifiers(headBranch)) allIds.add(id);
      return {
        identifiers: Array.from(allIds),
        wakeReason: "github_check_completed",
        prNumber: firstNumber,
        repoFullName,
        prUrl: githubPrUrl(repoFullName, firstNumber, firstPrUrl),
        eventUrl: readStringField(checkRun, "html_url"),
        headSha: readStringField(checkRun, "head_sha"),
      };
    }
    case "check_suite": {
      const action = payload.action as string | undefined;
      const checkSuite = payload.check_suite as Record<string, unknown> | undefined;
      if (action !== "completed" || !checkSuite) return null;
      const pullRequests = (checkSuite.pull_requests as Record<string, unknown>[] | undefined) ?? [];
      const allIds = new Set<string>();
      let firstNumber: number | null = null;
      let firstPrUrl: string | null = null;
      for (const pr of pullRequests) {
        const head = pr.head as Record<string, unknown> | undefined;
        const branch = head?.ref as string | undefined;
        for (const id of extractPaperclipIdentifiers(branch)) allIds.add(id);
        const num = pr.number as number | undefined;
        if (firstNumber === null && typeof num === "number") firstNumber = num;
        if (!firstPrUrl) firstPrUrl = githubPrUrl(repoFullName, firstNumber, readStringField(pr, "html_url"));
      }
      const headBranch = checkSuite.head_branch as string | undefined;
      for (const id of extractPaperclipIdentifiers(headBranch)) allIds.add(id);
      return {
        identifiers: Array.from(allIds),
        wakeReason: "github_check_suite_completed",
        prNumber: firstNumber,
        repoFullName,
        prUrl: githubPrUrl(repoFullName, firstNumber, firstPrUrl),
        eventUrl: readStringField(checkSuite, "html_url") ?? readStringField(checkSuite, "url"),
        headSha: readStringField(checkSuite, "head_sha"),
      };
    }
    case "workflow_run": {
      const action = payload.action as string | undefined;
      const workflowRun = payload.workflow_run as Record<string, unknown> | undefined;
      if (action !== "completed" || !workflowRun) return null;
      const pullRequests = (workflowRun.pull_requests as Record<string, unknown>[] | undefined) ?? [];
      const allIds = new Set<string>();
      let firstNumber: number | null = null;
      let firstPrUrl: string | null = null;
      for (const pr of pullRequests) {
        const head = pr.head as Record<string, unknown> | undefined;
        const branch = head?.ref as string | undefined;
        for (const id of extractPaperclipIdentifiers(branch)) allIds.add(id);
        const num = pr.number as number | undefined;
        if (firstNumber === null && typeof num === "number") firstNumber = num;
        if (!firstPrUrl) firstPrUrl = githubPrUrl(repoFullName, firstNumber, readStringField(pr, "html_url"));
      }
      const headBranch = workflowRun.head_branch as string | undefined;
      for (const id of extractPaperclipIdentifiers(headBranch)) allIds.add(id);
      return {
        identifiers: Array.from(allIds),
        wakeReason: "github_workflow_completed",
        prNumber: firstNumber,
        repoFullName,
        prTitle: readStringField(workflowRun, "display_title"),
        prUrl: githubPrUrl(repoFullName, firstNumber, firstPrUrl),
        eventUrl: readStringField(workflowRun, "html_url"),
        headSha: readStringField(workflowRun, "head_sha"),
      };
    }
    case "issue_comment": {
      const action = payload.action as string | undefined;
      if (action !== "created") return null;
      const issue = payload.issue as Record<string, unknown> | undefined;
      const pullRequestMarker = issue?.pull_request as Record<string, unknown> | undefined;
      // GitHub sends issue_comment for both issues and PRs. Only PR comments
      // can request Ally PR review.
      if (!issue || !pullRequestMarker) return null;
      const comment = payload.comment as Record<string, unknown> | undefined;
      const commentBody = comment?.body as string | undefined;
      const commentUser = comment?.user as Record<string, unknown> | undefined;
      const commentAuthorLogin = (commentUser?.login as string | undefined) ?? null;
      // A comment authored BY the reviewer bot itself can never be a
      // request FOR review -- it can only be a false-positive match on the
      // mention pattern (e.g. a template-completion nudge that greets the
      // bot by its own handle, or the bot's own reply quoting the alias as
      // a backtick-quoted example while explaining something). Without
      // this guard those self-authored matches re-fire
      // github_pr_review_requested indefinitely: observed live on
      // Blockcast/paperclip#583, where the commitperclip gate's own nudge
      // comment and then this bot's own explanatory reply each re-woke the
      // review cycle in turn.
      const commentAuthorIsReviewerBot = isConfiguredPrReviewerAuthor(
        commentAuthorLogin,
        options.prReviewerBotLogin,
      );
      // BLO-18865: the author-scoped guard above also caught every Paperclip
      // AGENT asking for a review, because agent PR comments are posted
      // through the GitHub App under the reviewer bot's own login. An explicit,
      // start-of-body marker re-opens that path for agents while keeping the
      // #583 loop closed — see PR_REVIEWER_AGENT_REQUEST_MARKER_PATTERN for why
      // the anchoring and the review-header exclusion are both load-bearing.
      const agentReviewRequest =
        commentAuthorIsReviewerBot &&
        hasPrReviewerAgentRequestMarker(commentBody) &&
        !hasAllyConsolidatedReviewHeading(commentBody);
      const reviewerRequest =
        (!commentAuthorIsReviewerBot || agentReviewRequest) &&
        hasPrReviewerRequestMention(commentBody);
      const reviewFeedback = isActionablePrReviewComment(
        commentBody,
        commentAuthorLogin,
        options.prReviewerBotLogin,
      );
      // BLO-18273: the drop above is the one failure mode in this file that is
      // completely invisible. A markerless agent request matches the @ally
      // mention, fails the author guard, is not review feedback either, and
      // falls out of here as `null` — no context, no wake, and (until this
      // callback) not one log line. The requesting agent believes it handed
      // off and ends its run, so the PR waits forever. Report it instead.
      //
      // Scoped narrowly so it stays a signal rather than noise: only a
      // reviewer-bot-authored body that addresses Ally by the BARE `@ally`
      // alias, carries no valid marker, and is NOT the reviewer's own
      // consolidated review output. See PR_REVIEWER_BARE_ALIAS_MENTION_PATTERN
      // for why the bare alias (and not the general mention pattern) is the
      // discriminator: the general one also matches the commitperclip gate's
      // `@allyblockcast[bot]` nudge, whose suppression is correct.
      // BLO-21618: a SECOND invisible drop, sitting right next to the one
      // above. `agentReviewRequest` requires `!hasAllyConsolidatedReviewHeading`
      // so Ally's own posted reviews (which legitimately carry both the bare
      // alias AND the heading) never re-arm the #583 loop — see the guard
      // comment on `agentReviewRequest`. But that same exclusion also disarms
      // a genuine marker-prefixed agent request whose body happens to contain
      // a standalone heading-shaped line (e.g. quoting/describing a prior
      // Ally review while asking for a fresh pass). That request had the
      // marker AND the mention — everything the marker path exists to
      // recognize — and still fell out of here as silent `null`, because the
      // ORIGINAL suppression report (below) deliberately excludes
      // heading-bearing bodies too (to avoid reporting Ally's routine, marker-
      // less reviews as "suppressed requests"). Marker presence is the
      // discriminator that makes the two cases distinguishable: Ally's own
      // output is never marker-prefixed (the marker must be the literal first
      // byte, and Ally's output opens with the heading), so gating on the
      // marker here cannot fire on a genuine self-echo.
      const markerRequestDisqualifiedByHeading =
        commentAuthorIsReviewerBot &&
        hasPrReviewerAgentRequestMarker(commentBody) &&
        hasAllyConsolidatedReviewHeading(commentBody) &&
        hasPrReviewerRequestMention(commentBody);
      if (!reviewerRequest && !reviewFeedback) {
        if (
          commentAuthorIsReviewerBot &&
          hasPrReviewerBareAliasMention(commentBody) &&
          !hasAllyConsolidatedReviewHeading(commentBody)
        ) {
          options.onSuppressedReviewRequest?.({
            repoFullName,
            prNumber: (issue.number as number | undefined) ?? null,
            commentId: (comment?.id as number | undefined) ?? null,
            commentAuthorLogin,
            commentUrl: readStringField(comment, "html_url"),
            reason: "missing_marker",
          });
        } else if (markerRequestDisqualifiedByHeading) {
          options.onSuppressedReviewRequest?.({
            repoFullName,
            prNumber: (issue.number as number | undefined) ?? null,
            commentId: (comment?.id as number | undefined) ?? null,
            commentAuthorLogin,
            commentUrl: readStringField(comment, "html_url"),
            reason: "marker_disqualified_by_heading",
          });
        }
      }
      // BLO-23395: a merge-queue eviction notice is its own actionable
      // signal, independent of the reviewer-request/feedback detection above
      // (it is not authored by the reviewer bot at all).
      const mergeQueueEvictionNotice =
        commentAuthorLogin === MERGE_QUEUE_EVICTION_BOT_LOGIN && hasMergeQueueEvictionMarker(commentBody);
      if (!reviewerRequest && !reviewFeedback && !mergeQueueEvictionNotice) return null;
      // BLO-9293: on a PR's issue_comment payload, `issue.user.login` is the PR
      // author (the comment author is `comment.user.login`, captured separately).
      const issueUser = issue.user as Record<string, unknown> | undefined;
      const prNumber = (issue.number as number | undefined) ?? null;
      const prUrl = githubPrUrl(repoFullName, prNumber, readStringField(issue, "html_url"));
      const commentUrl = readStringField(comment, "html_url");
      const issueTitle = issue.title as string | undefined;
      const issueBody = issue.body as string | undefined;
      // Owning resolution deliberately excludes commentBody: the comment is
      // the @ally ASK that triggered this event, not an ownership claim about
      // the PR (see resolveOwningPaperclipIdentifiers). No branch tier here
      // either -- issue_comment payloads don't carry pull_request.head.ref --
      // so this path relies on title, a closing-keyword body line, or (BLO-21312)
      // a non-closing house-reference body line (Issue:/Paperclip task:/etc.).
      const owning = resolveOwningPaperclipIdentifiers({ title: issueTitle, body: issueBody });
      return {
        // BLO-23267: identifiers used to MATCH a Paperclip issue must come
        // only from the PR's own title/body (`issue.title`/`issue.body` here
        // -- GitHub's issue_comment payload calls the PR "issue"), never from
        // the free-text comment body. paperclip-identifiers.ts's own operator
        // guard says PR->issue attribution keys on branch/title/body and
        // nothing else; commentBody used to be folded in here too, which let
        // an identifier mentioned only in REVIEW PROSE (e.g. a reviewer
        // narrating an unrelated incident as background) attribute a
        // Changes-Requested wake to that unrelated issue. Live case: Ally's
        // comment on Blockcast/paperclip#1125 narrated the BLO-20775 stall as
        // motivation, and the substring match alone fired a wake on
        // BLO-20775 even though #1125 has nothing to do with it -- its own
        // linked issue (BLO-19497) is carried correctly via issue.body/title.
        // commentBody is still returned below for display/logging, just not
        // fed into matching.
        identifiers: extractPaperclipIdentifiers(
          issue.title as string | undefined,
          issue.body as string | undefined,
        ),
        owningIdentifiers: owning.owning,
        wakeReason: mergeQueueEvictionNotice
          ? "github_pr_merge_queue_evicted"
          : reviewerRequest
            ? "github_pr_review_requested"
            : "github_pr_review_feedback",
        prNumber,
        repoFullName,
        prTitle: issueTitle ?? null,
        prUrl,
        eventUrl: commentUrl ?? prUrl,
        commentId: (comment?.id as number | undefined) ?? null,
        commentBody: clampReviewBody(commentBody),
        commentAuthorLogin,
        prAuthorLogin: (issueUser?.login as string | undefined) ?? null,
        commentUrl,
      };
    }
    case "pull_request_review": {
      const action = payload.action as string | undefined;
      // Only "submitted" advances state; "edited"/"dismissed" don't usually
      // need a wake.
      if (action !== "submitted") return null;
      const pr = payload.pull_request as Record<string, unknown> | undefined;
      const collected = collectFromPullRequest(pr);
      const review = payload.review as Record<string, unknown> | undefined;
      const rawReviewBody = (review?.body as string | null | undefined) ?? null;
      const reviewBody = clampReviewBody(rawReviewBody);
      const reviewState = (review?.state as string | undefined) ?? null;
      const reviewUser = review?.user as Record<string, unknown> | undefined;
      const reviewAuthorLogin = (reviewUser?.login as string | undefined) ?? null;
      const reviewAuthorType = (reviewUser?.type as string | undefined) ?? null;
      const reviewUrl = readStringField(review, "html_url");
      const reviewIdRaw = review?.id;
      const reviewId = typeof reviewIdRaw === "number" ? reviewIdRaw : null;
      // Review finding (PR #1125): `review.commit_id` is the exact,
      // immutable commit this review was submitted against. Falling back to
      // `pull_request.head.sha` (collected.headSha) is only correct if the
      // branch hasn't advanced between the review being submitted and this
      // webhook being processed -- otherwise the "Reviewed head SHA" line
      // this drives labels feedback against a commit the reviewer never saw,
      // defeating the stale-review signal it exists to provide.
      const reviewCommitId = readStringField(review, "commit_id");
      // BLO-23059: drop the Claude Code Review paused/disabled org-settings
      // notice before it becomes a wake. See isClaudeCodeReviewServiceNotice for
      // why this is dropped at the event rather than filtered at either wake
      // site, and for the three conditions that keep a terse human review safe.
      if (isClaudeCodeReviewServiceNotice(rawReviewBody, reviewState, reviewAuthorLogin, reviewAuthorType)) {
        options.onSuppressedReviewSubmission?.({
          repoFullName,
          prNumber: collected.number,
          reviewAuthorLogin,
          reviewState,
          reviewUrl,
        });
        return null;
      }
      return {
        identifiers: collected.ids,
        owningIdentifiers: collected.owning.owning,
        wakeReason: "github_pr_review_submitted",
        prNumber: collected.number,
        repoFullName,
        prTitle: collected.title,
        prUrl: collected.url,
        eventUrl: reviewUrl ?? collected.url,
        headSha: reviewCommitId ?? collected.headSha,
        prAuthorLogin: collected.authorLogin,
        reviewBody,
        reviewHasActionableFeedback: hasActionablePrReviewFeedback(rawReviewBody, reviewState),
        reviewState,
        reviewId,
        reviewAuthorLogin,
        reviewUrl,
      };
    }
    case "pull_request": {
      const action = payload.action as string | undefined;
      // Wake on the events that change reviewer expectations: opened (CI
      // starts), reopened (manual retry / renewed review signal),
      // ready_for_review (draft -> ready), converted_to_draft (ready -> draft),
      // synchronize (author pushed a fixup after an earlier review), closed
      // (merged or abandoned).
      //
      // synchronize fires once per push. We don't fan out one reviewer run per
      // push: queued reviewer runs are coalesced by the PR-scoped task key, and
      // GitHub redeliveries dedup by delivery-scoped idempotency. A running
      // reviewer already snapshotted an older head, so the first synchronize
      // that arrives while it runs gets its own queued follow-up.
      // See shouldFirePrReviewerWake / buildPrReviewerTaskKey /
      // buildPrReviewerWakeIdempotencyKey.
      if (
        action !== "opened" &&
        action !== "reopened" &&
        action !== "ready_for_review" &&
        action !== "converted_to_draft" &&
        action !== "synchronize" &&
        action !== "closed"
      ) return null;
      const pr = payload.pull_request as Record<string, unknown> | undefined;
      const collected = collectFromPullRequest(pr);
      const reasonByAction: Record<string, string> = {
        opened: "github_pr_opened",
        reopened: "github_pr_reopened",
        ready_for_review: "github_pr_ready_for_review",
        converted_to_draft: "github_pr_converted_to_draft",
        synchronize: "github_pr_synchronized",
        closed: "github_pr_closed",
      };
      const head = pr?.head as Record<string, unknown> | undefined;
      const merged = pr?.merged === true;
      return {
        identifiers: collected.ids,
        owningIdentifiers: collected.owning.owning,
        wakeReason: reasonByAction[action] ?? "github_pull_request",
        prNumber: collected.number,
        repoFullName,
        prTitle: collected.title,
        prUrl: collected.url,
        eventUrl: collected.url,
        headSha: collected.headSha,
        prPreviousHeadSha: readStringField(payload, "before"),
        prAuthorLogin: collected.authorLogin,
        prDraft: pr?.draft === true,
        // Merge metadata for forward-capture. additions/deletions are present
        // on the pull_request payload; per-file authored-LOC needs a follow-up
        // pulls/{n}/files fetch (enrichment), so it is not read here.
        prMerged: action === "closed" ? merged : undefined,
        prMergedAt: readStringField(pr, "merged_at"),
        prUpdatedAt: readStringField(pr, "updated_at"),
        prAdditions: typeof pr?.additions === "number" ? (pr.additions as number) : null,
        prDeletions: typeof pr?.deletions === "number" ? (pr.deletions as number) : null,
        prBranch: (head?.ref as string | undefined) ?? null,
        // PEN-2370: externally-authored, same exposure shape as reviewBody /
        // commentBody. It bypasses clampReviewBody, so it needs the scrub here.
        prBody: redactExternalBody(pr?.body as string | undefined),
        prAction: action,
      };
    }
    default:
      return null;
  }
}

// Dependabot remediation wake. GitHub severity scale, weakest -> strongest.
const DEPENDABOT_SEVERITY_RANK: Record<string, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

type DependabotAlertContext = {
  action: "created" | "reintroduced" | "reopened" | "fixed" | "dismissed" | "auto_dismissed";
  alertNumber: number;
  severity: string;
  packageName: string | null;
  ecosystem: string | null;
  manifestPath: string | null;
  ghsaId: string | null;
  cveId: string | null;
  summary: string | null;
  vulnerableRange: string | null;
  patchedVersion: string | null;
  alertUrl: string | null;
  dismissalReason: string | null;
  dismissalComment: string | null;
};

// created: brand-new advisory match; reintroduced: a previously-fixed alert
// came back (regression); reopened: a human reversed a dismissal. The
// terminal actions (fixed / dismissed / auto_dismissed) need no work. Exported
// as a standalone predicate (rather than folded into resolveDependabotAlertContext)
// so the webhook route can tell "not actionable" (silently ignore) apart from
// "actionable but the payload didn't parse" (durable diagnostic, BLO-16319).
function isActionableDependabotAlertAction(
  action: string | undefined,
): action is "created" | "reintroduced" | "reopened" {
  return action === "created" || action === "reintroduced" || action === "reopened";
}

function isTerminalDependabotAlertAction(
  action: string | undefined,
): action is "fixed" | "dismissed" | "auto_dismissed" {
  return action === "fixed" || action === "dismissed" || action === "auto_dismissed";
}

function resolveDependabotAlertContext(
  payload: Record<string, unknown>,
): DependabotAlertContext | null {
  const action = payload.action as string | undefined;
  if (!isActionableDependabotAlertAction(action) && !isTerminalDependabotAlertAction(action)) return null;
  const alert = payload.alert as Record<string, unknown> | undefined;
  if (!alert || typeof alert.number !== "number") return null;
  const advisory = alert.security_advisory as Record<string, unknown> | undefined;
  const vulnerability = alert.security_vulnerability as Record<string, unknown> | undefined;
  const dependency = alert.dependency as Record<string, unknown> | undefined;
  const pkg = (vulnerability?.package ?? dependency?.package) as Record<string, unknown> | undefined;
  const firstPatched = vulnerability?.first_patched_version as Record<string, unknown> | undefined;
  const dismissalReason =
    typeof alert.dismissed_reason === "string" && alert.dismissed_reason.trim()
      ? alert.dismissed_reason.trim()
      : null;
  const dismissalComment =
    typeof alert.dismissed_comment === "string" && alert.dismissed_comment.trim()
      ? alert.dismissed_comment.trim()
      : null;
  const severity =
    typeof vulnerability?.severity === "string"
      ? vulnerability.severity
      : typeof advisory?.severity === "string"
        ? advisory.severity
        : "unknown";
  return {
    action,
    alertNumber: alert.number as number,
    severity,
    packageName: (pkg?.name as string | undefined) ?? null,
    ecosystem: (pkg?.ecosystem as string | undefined) ?? null,
    manifestPath: (dependency?.manifest_path as string | undefined) ?? null,
    ghsaId: (advisory?.ghsa_id as string | undefined) ?? null,
    cveId: (advisory?.cve_id as string | undefined) ?? null,
    summary: (advisory?.summary as string | undefined) ?? null,
    vulnerableRange: (vulnerability?.vulnerable_version_range as string | undefined) ?? null,
    patchedVersion: (firstPatched?.identifier as string | undefined) ?? null,
    alertUrl: (alert.html_url as string | undefined) ?? null,
    dismissalReason,
    dismissalComment,
  };
}

// BLO-16319: the dependabot wake used to fire with rich alert data buried in
// contextSnapshot fields that nothing ever rendered into the agent's prompt —
// no Paperclip issue meant no PAPERCLIP_TASK_ID, no `getIssueExecutionContext`
// lookup, and no task markdown, so the agent woke with an empty task and fell
// back to whatever workspace its last session happened to leave behind. Every
// actionable alert now gets (or reuses) a real, assigned Paperclip issue whose
// title/description carry every field GitHub gave us, and the wake sets
// contextSnapshot.issueId so the existing issue-wake plumbing takes over.
// GITHUB_DEPENDABOT_ALERT_ORIGIN_KIND / GITHUB_DEPENDABOT_WEBHOOK_DIAGNOSTIC_ORIGIN_KIND
// and the diagnostic-issue helper live in dependabot-alert-issues.ts (BLO-16446:
// shared with heartbeat.ts's stale-wake backfill).

const DEPENDABOT_SEVERITY_TO_ISSUE_PRIORITY: Record<string, "critical" | "high" | "medium" | "low"> = {
  critical: "critical",
  high: "high",
  medium: "medium",
  low: "low",
};

async function getAgentCompanyId(db: Db, agentId: string): Promise<string | null> {
  return db
    .select({ companyId: agents.companyId })
    .from(agents)
    .where(eq(agents.id, agentId))
    .then((rows) => rows[0]?.companyId ?? null);
}

function buildDependabotAlertIssueBody(input: {
  repoFullName: string;
  alert: DependabotAlertContext;
}): string {
  const { repoFullName, alert } = input;
  const advisory = [alert.ghsaId, alert.cveId].filter(Boolean).join(" / ") || "unknown";
  const alertUrl = alert.alertUrl ?? `https://github.com/${repoFullName}/security/dependabot/${alert.alertNumber}`;
  return [
    `A Dependabot security alert (\`${alert.action}\`) fired on \`${repoFullName}\`.`,
    "",
    "## Alert",
    `- Repository: \`${repoFullName}\``,
    `- Alert number: #${alert.alertNumber}`,
    `- Alert URL: ${alertUrl}`,
    `- Severity: ${alert.severity}`,
    `- Package: ${alert.packageName ?? "unknown"}${alert.ecosystem ? ` (${alert.ecosystem})` : ""}`,
    `- Manifest path: ${alert.manifestPath ?? "unknown"}`,
    `- Advisory: ${advisory}`,
    `- Vulnerable range: ${alert.vulnerableRange ?? "unknown"}`,
    `- Patched version: ${alert.patchedVersion ?? "unknown"}`,
    ...(alert.summary ? ["", alert.summary] : []),
    "",
    "## Acceptance criteria",
    `- Remediation path: the default-branch manifest${alert.manifestPath ? ` \`${alert.manifestPath}\`` : ""} in \`${repoFullName}\` resolves ${alert.packageName ?? "the dependency"} at ${alert.patchedVersion ?? "a patched version"} or newer, outside the vulnerable range ${alert.vulnerableRange ?? "reported above"}, and the evidence cites advisory ${advisory}. A GitHub alert-state receipt is sufficient but not required.`,
    `- Dismissal path: a documented dismissal reason is recorded, and either a terminal dismissal webhook receipt on this issue or direct terminal-state observation from GitHub shows the alert is dismissed for advisory ${advisory}.`,
    "",
    "## Verifying signal",
    "Any ONE of the following is sufficient and complete evidence. You do not need all of them, and none of them is mandatory on its own:",
    `1. The default-branch manifest${alert.manifestPath ? ` \`${alert.manifestPath}\`` : ""} in \`${repoFullName}\` resolves ${alert.packageName ?? "the dependency"} at ${alert.patchedVersion ?? "a patched version"} or newer, outside the vulnerable range ${alert.vulnerableRange ?? "reported above"}, with advisory ${advisory} cited in the evidence.`,
    `2. ${alertUrl} shows \`state: fixed\` for advisory ${advisory}.`,
    `3. A documented dismissal reason is recorded, and either a terminal dismissal webhook receipt on this issue or ${alertUrl} shows \`state: dismissed\` for advisory ${advisory}.`,
    "",
    "Branch 1 is fully agent-executable through the repository contents API and is the expected path. Do NOT require a screenshot of the alert page, and do NOT treat an authenticated-UI observation as the only admissible evidence: branches 2 and 3 are alternatives to branch 1, never prerequisites for it.",
    "",
    "## Note on the Dependabot Alerts REST API (operational, not evidentiary)",
    "Every field under **Alert** above comes from this delivery's GitHub webhook payload. Do NOT call the GitHub Dependabot Alerts REST API to re-derive them: some repositories return `403 Dependabot alerts are disabled for this repository` on that endpoint even though the webhook still fires. Treat that 403 as expected and work from this issue instead of chasing the API.",
    "",
    "This note is scoped to re-deriving the metadata fields above. It is NOT an evidentiary standard: it does not restrict which **Verifying signal** branch you may use, and it does not forbid the repository contents API. It does rule out one specific query as state evidence -- see the next section.",
    "",
    "## Alert state may be unreadable, and the unreadable case LOOKS LIKE ZERO",
    "Branches 2 and 3 can each be satisfied two ways, and only one of the two needs a credential. **A terminal dismissal webhook receipt already on this issue is sufficient evidence on its own.** The receipt is pushed to us by the HMAC-verified Dependabot delivery, not polled, so producing it needs no permission, no token and no API call. If one is already on this issue, use it and close: nothing in this section applies to you, and you must NOT escalate on the grounds that you lack a permission.",
    "",
    "Observing terminal state *by querying GitHub directly* is the other way, and that read needs the `Dependabot alerts` repository permission (GitHub App) or the `security_events` scope (classic PAT). When no credential available to you holds it, the two read paths fail in **different** ways and only one fails loudly:",
    `- REST \`GET /repos/${repoFullName}/dependabot/alerts/${alert.alertNumber}\` returns a visible \`403\`: \`Resource not accessible by integration\` for an App installation, \`You are not authorized to perform this operation.\` for a PAT missing the scope. Both differ from the \`Dependabot alerts are disabled for this repository\` variant above -- these mean the credential lacks the permission, not that the repository has the feature switched off.`,
    "- GraphQL `repository.vulnerabilityAlerts` returns **`totalCount: 0` with no `errors` block**: an unerrored empty connection, indistinguishable from a repository that genuinely has no alerts. Zero across `[OPEN, FIXED, DISMISSED, AUTO_DISMISSED]` on a repository that demonstrably has alerts is the signature of the permission gap.",
    "",
    "So do NOT use `vulnerabilityAlerts` as terminal-state evidence, and do NOT close this issue on a zero it returns. An absence-shaped answer from a permission-gated source means UNKNOWN, never NONE. Closing on that zero is a silent false-green on security work.",
    "",
    "## When branch 1 is unsatisfiable (phantom alerts)",
    `If the manifest named above no longer exists on the default branch there is no code change to make and branch 1 cannot be satisfied. Confirm with \`GET /repos/${repoFullName}/contents/${alert.manifestPath ?? "{manifest_path}"}\` returning \`404\`, then:`,
    `1. Establish whether a patched version is what the repository actually resolves, via \`GET /repos/${repoFullName}/dependency-graph/sbom\`. That endpoint needs only \`contents: read\`, so it answers when the alerts API does not, and it is repository-wide rather than per-manifest -- which is exactly what the phantom case needs. Compare the **minimum** resolved version across every entry for ${alert.packageName ?? "the dependency"} against the vulnerable range, never the common case: a summary over hundreds of packages hides a single outlier, and the outlier is the whole question.`,
    `2. Read the SBOM's limits before you conclude anything from it. It is generated from the **same GitHub dependency graph that generates these alerts**, so it cannot distinguish a live dependency from a phantom one -- a stale entry appears in both, which is *why* the alert keeps firing. Use it to establish that a patched version is present; never to establish that a vulnerable one is real. SBOM metadata will not settle that for you: \`filesAnalyzed\` is \`false\` and \`downloadLocation\` is \`NOASSERTION\` for essentially every entry, so neither field discriminates. The only reliable check is whether a tracked file on the default branch pins the version at all (\`GET /search/code?q=<version>+repo:${repoFullName}\`, plus the manifests themselves). An entry no tracked file pins is a phantom.`,
    "3. Escalate to a repository admin instead of treating it as code work, and say on this issue that you are doing so. Only an admin can rebuild the repository's dependency graph (the durable fix when a deleted manifest keeps getting re-indexed) or dismiss the alert in the GitHub UI. Do NOT close this issue as a substitute for dismissal, and do NOT poll for a state change: neither action moves alert state, and a dismissal an agent cannot perform will not happen on a timer.",
  ].join("\n");
}

function isUniqueDependabotAlertConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    code?: string;
    constraint?: string;
    constraint_name?: string;
    message?: string;
    cause?: unknown;
  };
  const direct =
    typeof candidate.code === "string" ||
    typeof candidate.constraint === "string" ||
    typeof candidate.constraint_name === "string"
      ? candidate
      : candidate.cause && typeof candidate.cause === "object"
        ? (candidate.cause as typeof candidate)
        : null;
  if (!direct) return false;
  return (
    direct.code === "23505" &&
    (direct.constraint === "issues_active_dependabot_alert_uq" ||
      direct.constraint_name === "issues_active_dependabot_alert_uq" ||
      (typeof direct.message === "string" && direct.message.includes("issues_active_dependabot_alert_uq")))
  );
}

// BLO-28981: a re-fire arriving for an alert whose previous cycle was already
// adjudicated and closed. The body is deliberately short -- the reopened row
// already carries the previous cycle's comments and receipts, which is the
// whole point of reopening rather than filing a fresh row. What it must add is
// (a) that this is a *repeat*, not a first sighting, (b) which delivery
// re-fired it, and (c) pointers to any earlier sibling rows that predate the
// reopen behaviour, so the full adjudication chain is reachable from the one
// surviving row.
function buildDependabotRefireComment(input: {
  repoFullName: string;
  alert: DependabotAlertContext;
  deliveryId: string | null;
  reopenedFromStatus: string;
  priorAdjudications: { identifier: string | null; status: string; completedAt: Date | null }[];
}): string {
  const alertUrl =
    input.alert.alertUrl ??
    `https://github.com/${input.repoFullName}/security/dependabot/${input.alert.alertNumber}`;
  const priorLines = input.priorAdjudications.length
    ? [
        "",
        `## Earlier rows for this same alert (${input.priorAdjudications.length})`,
        ...input.priorAdjudications.map((prior) => {
          const closedAt = prior.completedAt ? prior.completedAt.toISOString() : "close time not recorded";
          return `- ${prior.identifier ?? "(no identifier)"} — \`${prior.status}\`, ${closedAt}`;
        }),
        "",
        "Read those before re-investigating: this alert has been adjudicated before, and the previous conclusion very likely still applies.",
      ]
    : [];
  return [
    `[github-dependabot-refire] GitHub re-fired this alert (\`${input.alert.action}\`) after it was closed as \`${input.reopenedFromStatus}\`.`,
    "",
    "This issue was **reopened in place** rather than refiled, so every comment above is the prior adjudication of this same alert.",
    `- Repository: \`${input.repoFullName}\``,
    `- Alert: [#${input.alert.alertNumber}](${alertUrl})`,
    `- Action: \`${input.alert.action}\``,
    `- Severity: ${input.alert.severity}`,
    // The reopened row keeps the PREVIOUS cycle's title and description, so if
    // the advisory moved between cycles those quote stale values. Carrying the
    // current range/patched version here is what corrects them.
    `- Vulnerable range: ${input.alert.vulnerableRange ?? "not provided in the webhook payload"}`,
    `- Patched version: ${input.alert.patchedVersion ?? "not provided in the webhook payload"}`,
    `- GitHub delivery: \`${input.deliveryId ?? "unavailable"}\``,
    ...priorLines,
    "",
    "If the earlier adjudication still holds, close this issue again citing it — do not repeat the investigation. If the dependency genuinely regressed, remediate as normal.",
  ].join("\n");
}

// BLO-28981: a re-fire arriving for an alert whose newest row was `cancelled`.
// Cancelling an alert issue is a deliberate human act meaning "stop
// re-adjudicating this" -- the exact lever BLO-28864's phantom `fbinternal`
// alerts need. So the row is left cancelled and NOT re-queued; this comment is
// the audit trail that the re-fire arrived and was deliberately suppressed,
// rather than lost.
function buildDependabotSuppressedRefireComment(input: {
  repoFullName: string;
  alert: DependabotAlertContext;
  deliveryId: string | null;
  cancelledAt: Date | null;
}): string {
  const alertUrl =
    input.alert.alertUrl ??
    `https://github.com/${input.repoFullName}/security/dependabot/${input.alert.alertNumber}`;
  const cancelledAt = input.cancelledAt ? input.cancelledAt.toISOString() : "cancel time not recorded";
  return [
    `[github-dependabot-refire-suppressed] GitHub re-fired this alert (\`${input.alert.action}\`), and it was **not** re-queued.`,
    "",
    `This issue was cancelled (${cancelledAt}), which this intake treats as a standing decision to stop re-adjudicating this alert. No new issue was filed and no agent was woken.`,
    `- Repository: \`${input.repoFullName}\``,
    `- Alert: [#${input.alert.alertNumber}](${alertUrl})`,
    `- Action: \`${input.alert.action}\``,
    `- Severity: ${input.alert.severity}`,
    `- Vulnerable range: ${input.alert.vulnerableRange ?? "not provided in the webhook payload"}`,
    `- Patched version: ${input.alert.patchedVersion ?? "not provided in the webhook payload"}`,
    `- GitHub delivery: \`${input.deliveryId ?? "unavailable"}\``,
    "",
    "To start taking this alert again, move this issue out of `cancelled` (or close it as `done` instead) — the next re-fire will then reopen it normally.",
  ].join("\n");
}

// Finds the open issue for this alert (originId is the stable
// `github-dependabot:<repo>#<alertNumber>` key), or creates one. A
// `reintroduced`/`reopened` redelivery for an alert that already has an open
// issue reuses it rather than spawning a duplicate remediation run — the
// Release Engineer sees one issue per alert to comment on and dedupe against,
// per BLO-16319's verifying signal.
//
// BLO-28981: when there is no open issue but the same originId has already
// been adjudicated and closed, reopen the most recent terminal row instead of
// minting a fresh one. `issues_active_dependabot_alert_uq` only constrains
// non-terminal rows, so nothing stopped the intake from stacking a new
// full-weight issue per re-fire cycle (measured: 24 rows across 8 originIds on
// `Blockcast/magma`). Reopening keeps exactly one row per alert forever and,
// more importantly, keeps the prior adjudication attached to it — the next
// agent to pick it up reads why this was closed last time instead of starting
// cold. The wake still fires against the returned issue id, so a dependency
// that was genuinely fixed and then regressed still reaches an assignee; this
// changes which row the signal lands on, never whether it lands.
//
// `cancelled` is treated differently from `done`: see the suppression branch
// below.
async function resolveDependabotAlertIssue(
  db: Db,
  input: {
    companyId: string;
    assigneeAgentId: string;
    originId: string;
    repoFullName: string;
    alert: DependabotAlertContext;
    deliveryId: string | null;
  },
): Promise<{
  id: string;
  identifier: string | null;
  reused: boolean;
  reopened: boolean;
  suppressed: boolean;
}> {
  const existing = await findOpenDependabotAlertIssue(db, input.companyId, input.originId);
  if (existing)
    return {
      id: existing.id,
      identifier: existing.identifier,
      reused: true,
      reopened: false,
      suppressed: false,
    };

  const priorTerminal = await findTerminalDependabotAlertIssues(db, input.companyId, input.originId);
  const newestTerminal = priorTerminal[0] ?? null;

  // A cancelled newest row is a standing "stop re-adjudicating this" decision,
  // so honour it instead of resurrecting the row. Reopening a cancelled issue
  // would also null out `cancelledAt`, destroying the only field-level record
  // that the cancellation ever happened -- and since the row is then reused
  // forever, there would be no suppression lever left anywhere in the intake.
  // The re-fire is still recorded on the row so a suppressed delivery is
  // auditable rather than silently dropped. Note this makes `cancelled` load
  // bearing: anything that auto-cancels an alert issue silences that alert
  // until a human moves it out of `cancelled`.
  if (newestTerminal?.status === "cancelled") {
    await recordSuppressedDependabotRefire(db, {
      companyId: input.companyId,
      originId: input.originId,
      repoFullName: input.repoFullName,
      alert: input.alert,
      deliveryId: input.deliveryId,
      target: newestTerminal,
    });
    return {
      id: newestTerminal.id,
      identifier: newestTerminal.identifier,
      reused: true,
      reopened: false,
      suppressed: true,
    };
  }

  const reopenTarget = newestTerminal;
  if (reopenTarget) {
    const reopened = await reopenTerminalDependabotAlertIssue(db, {
      ...input,
      target: reopenTarget,
      priorAdjudications: priorTerminal.slice(1),
    });
    if (reopened) return reopened;
    // Lost the reopen race to a concurrent delivery (or the row moved out of a
    // terminal status between the read and the write). Whichever writer won
    // left an open row behind; reuse it rather than falling through to create
    // a duplicate.
    const raced = await findOpenDependabotAlertIssue(db, input.companyId, input.originId);
    if (raced)
      return { id: raced.id, identifier: raced.identifier, reused: true, reopened: false, suppressed: false };
  }

  const assigneeAgentId = await resolveDependabotIssueAssigneeId(db, input.companyId, input.assigneeAgentId);
  const priority = DEPENDABOT_SEVERITY_TO_ISSUE_PRIORITY[input.alert.severity] ?? "medium";
  const title = `Dependabot ${input.alert.severity} alert: ${input.alert.packageName ?? "unknown package"} in ${input.repoFullName}#${input.alert.alertNumber}`;
  const description = buildDependabotAlertIssueBody({ repoFullName: input.repoFullName, alert: input.alert });

  try {
    const created = await issueService(db).create(input.companyId, {
      title,
      description,
      status: "todo",
      priority,
      assigneeAgentId,
      originKind: GITHUB_DEPENDABOT_ALERT_ORIGIN_KIND,
      originId: input.originId,
      originFingerprint: input.originId,
    });
    return { id: created.id, identifier: created.identifier, reused: false, reopened: false, suppressed: false };
  } catch (error) {
    if (!isUniqueDependabotAlertConflict(error)) throw error;
    const raced = await findOpenDependabotAlertIssue(db, input.companyId, input.originId);
    if (raced)
      return { id: raced.id, identifier: raced.identifier, reused: true, reopened: false, suppressed: false };
    throw error;
  }
}

// Records a suppressed re-fire on an already-cancelled alert row. No UPDATE:
// the row stays cancelled, keeps its `cancelledAt`, and stays out of the
// queue. Idempotent on the delivery id via the same
// `issue_comments_issue_system_idempotency_idx` the reopen notice uses, so a
// replay does not stack notices.
async function recordSuppressedDependabotRefire(
  db: Db,
  input: {
    companyId: string;
    originId: string;
    repoFullName: string;
    alert: DependabotAlertContext;
    deliveryId: string | null;
    target: { id: string; cancelledAt: Date | null };
  },
): Promise<void> {
  const externalKey = `${input.originId}:refire-suppressed:${input.deliveryId ?? input.alert.action}`;
  await db
    .insert(issueComments)
    .values({
      companyId: input.companyId,
      issueId: input.target.id,
      authorType: "system",
      idempotencyKey: externalKey,
      body: buildDependabotSuppressedRefireComment({
        repoFullName: input.repoFullName,
        alert: input.alert,
        deliveryId: input.deliveryId,
        cancelledAt: input.target.cancelledAt,
      }),
      metadata: {
        kind: "github_dependabot_refire_suppressed",
        source: "github",
        externalKey,
        repoFullName: input.repoFullName,
        alertNumber: input.alert.alertNumber,
        action: input.alert.action,
        deliveryId: input.deliveryId,
      } as never,
    })
    .onConflictDoNothing();
}

// Reopens a closed Dependabot alert row and records why, atomically. Returns
// null when the row was no longer terminal at write time — the UPDATE's own
// WHERE re-checks the status against the latest row version, so a concurrent
// delivery that already reopened it cannot be double-applied (the same
// optimistic-concurrency shape reopenInReviewIssueForActionablePrFeedback uses
// for its `in_review` guard). Also returns null on a unique-constraint loss:
// the UPDATE moves the row INTO `issues_active_dependabot_alert_uq`'s scope,
// so if a concurrent writer made a different row active in the read→write
// window, Postgres raises rather than updating zero rows. Both losses land on
// the caller's `findOpenDependabotAlertIssue` fallback, which is the same
// idiom the create path at the bottom of resolveDependabotAlertIssue uses.
//
// `done` only, never `cancelled`: see the suppression branch in
// resolveDependabotAlertIssue.
async function reopenTerminalDependabotAlertIssue(
  db: Db,
  input: {
    companyId: string;
    assigneeAgentId: string;
    originId: string;
    repoFullName: string;
    alert: DependabotAlertContext;
    deliveryId: string | null;
    target: { id: string; identifier: string | null; status: string };
    priorAdjudications: { identifier: string | null; status: string; completedAt: Date | null }[];
  },
): Promise<{
  id: string;
  identifier: string | null;
  reused: boolean;
  reopened: boolean;
  suppressed: boolean;
} | null> {
  const assigneeAgentId = await resolveDependabotIssueAssigneeId(db, input.companyId, input.assigneeAgentId);
  const priority = DEPENDABOT_SEVERITY_TO_ISSUE_PRIORITY[input.alert.severity] ?? "medium";
  const now = new Date();
  const externalKey = `${input.originId}:refire:${input.deliveryId ?? input.alert.action}`;
  const body = buildDependabotRefireComment({
    repoFullName: input.repoFullName,
    alert: input.alert,
    deliveryId: input.deliveryId,
    reopenedFromStatus: input.target.status,
    priorAdjudications: input.priorAdjudications,
  });

  return db
    .transaction(async (tx) => {
      const updated = await tx
        .update(issues)
        .set({
          status: "todo",
          priority,
          assigneeAgentId,
          assigneeUserId: null,
          // The row is being handed back to the queue: any execution lock left
          // over from the run that closed it would otherwise make the reopened
          // issue look checked-out by a run that has long since finished.
          checkoutRunId: null,
          executionRunId: null,
          executionAgentNameKey: null,
          executionLockedAt: null,
          completedAt: null,
          // `cancelledAt` is deliberately NOT cleared here: this UPDATE only
          // ever matches `done` rows, so there is nothing to clear, and a
          // cancelled row must keep its timestamp (see the suppression branch).
          //
          // `executionState` is likewise left alone, unlike the
          // reopenInReviewIssueForActionablePrFeedback precedent this borrows
          // its concurrency shape from. That path recomputes it via
          // markExecutionStateChangesRequested because it reopens issues that
          // are mid-review-stage; alert issues are created with no
          // `executionPolicy`, so there is no stage progress to reset. If
          // stages are ever attached to alert issues, this needs to reset them
          // or the prior cycle's progress carries into the new one
          // pre-satisfied.
          updatedAt: now,
        })
        .where(and(eq(issues.id, input.target.id), eq(issues.status, "done")))
        .returning({ id: issues.id, identifier: issues.identifier })
        .then((rows) => rows[0] ?? null);
      if (!updated) return null;

    // Idempotent on the delivery id, so a GitHub replay of the same re-fire
    // does not stack duplicate notices on the reopened row.
    await tx
      .insert(issueComments)
      .values({
        companyId: input.companyId,
        issueId: input.target.id,
        authorType: "system",
        idempotencyKey: externalKey,
        body,
        metadata: {
          kind: "github_dependabot_refire",
          source: "github",
          externalKey,
          repoFullName: input.repoFullName,
          alertNumber: input.alert.alertNumber,
          action: input.alert.action,
          deliveryId: input.deliveryId,
          reopenedFromStatus: input.target.status,
          priorAdjudicationIdentifiers: input.priorAdjudications.map((prior) => prior.identifier),
        } as never,
      })
      .onConflictDoNothing();

      return { id: updated.id, identifier: updated.identifier, reused: true, reopened: true, suppressed: false };
    })
    .catch((error) => {
      // The UPDATE moves this row into `issues_active_dependabot_alert_uq`'s
      // scope. A concurrent writer that made a different row active in the
      // read→write window makes Postgres raise here rather than update zero
      // rows, so a raced delivery would otherwise unwind to the outer handler
      // and be dropped with only a log. Fall back the same way a zero-row
      // update does: the caller re-reads the open row.
      if (!isUniqueDependabotAlertConflict(error)) throw error;
      return null;
    });
}

function buildDependabotTerminalReceipt(input: {
  repoFullName: string;
  alert: DependabotAlertContext;
  deliveryId: string | null;
}): string {
  const alertUrl =
    input.alert.alertUrl ??
    `https://github.com/${input.repoFullName}/security/dependabot/${input.alert.alertNumber}`;
  const dismissalEvidence =
    input.alert.action === "dismissed" || input.alert.action === "auto_dismissed"
      ? [
          `- Dismissal reason: ${input.alert.dismissalReason ? JSON.stringify(input.alert.dismissalReason) : "not provided in the webhook payload"}`,
          ...(input.alert.dismissalComment
            ? [`- Dismissal comment: ${JSON.stringify(input.alert.dismissalComment)}`]
            : []),
        ]
      : [];
  return [
    "[github-dependabot-receipt] Terminal Dependabot state received through the HMAC-verified GitHub webhook.",
    `- Repository: \`${input.repoFullName}\``,
    `- Alert: [#${input.alert.alertNumber}](${alertUrl})`,
    `- Action: \`${input.alert.action}\``,
    ...dismissalEvidence,
    `- GitHub delivery: \`${input.deliveryId ?? "unavailable"}\``,
    "- Evidence path: delivered `dependabot_alert` webhook; no Dependabot REST or GraphQL query was used.",
  ].join("\n");
}

async function recordDependabotTerminalReceipt(
  db: Db,
  input: {
    companyId: string;
    assigneeAgentId: string;
    originId: string;
    repoFullName: string;
    alert: DependabotAlertContext;
    deliveryId: string | null;
  },
): Promise<void> {
  const hasCompleteTerminalEvidence =
    input.alert.action === "fixed" || Boolean(input.alert.dismissalReason);
  let issue = await findOpenDependabotAlertIssue(db, input.companyId, input.originId);
  if (!issue) {
    issue = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, input.companyId),
          eq(issues.originKind, GITHUB_DEPENDABOT_ALERT_ORIGIN_KIND),
          eq(issues.originId, input.originId),
          isNull(issues.hiddenAt),
        ),
      )
      .orderBy(desc(issues.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }
  const receiptBody = buildDependabotTerminalReceipt(input);

  if (!issue && !hasCompleteTerminalEvidence) {
    await recordDependabotWebhookDiagnostic(db, {
      companyId: input.companyId,
      assigneeAgentId: input.assigneeAgentId,
      event: "dependabot_alert",
      deliveryId: input.deliveryId,
      action: input.alert.action,
      repoFullName: input.repoFullName,
      reason: `Terminal Dependabot ${input.alert.action} delivery for alert #${input.alert.alertNumber} did not include a documented dismissal reason, so it was recorded as a diagnostic instead of reserving the active alert issue key.\n\n${receiptBody}`,
      alertNumber: input.alert.alertNumber,
    });
    return;
  }

  if (!issue) {
    const assigneeAgentId = await resolveDependabotIssueAssigneeId(db, input.companyId, input.assigneeAgentId);
    issue = await issueService(db).create(input.companyId, {
      title: `Dependabot terminal receipt: ${input.repoFullName}#${input.alert.alertNumber} ${input.alert.action}`,
      description: [
        receiptBody,
        "",
        "## Acceptance criteria",
        ...(input.alert.action === "fixed"
          ? [`- Dependabot alert #${input.alert.alertNumber} is recorded as fixed from a permitted webhook delivery.`]
          : [`- Dependabot alert #${input.alert.alertNumber} has a documented dismissal reason from a permitted webhook delivery.`]),
        "",
        "## Verifying signal",
        `- GitHub delivery \`${input.deliveryId ?? "unavailable"}\` and its terminal evidence are preserved in the system comment on this issue.`,
      ].join("\n"),
      status: hasCompleteTerminalEvidence ? "done" : "todo",
      priority: DEPENDABOT_SEVERITY_TO_ISSUE_PRIORITY[input.alert.severity] ?? "medium",
      assigneeAgentId,
      originKind: GITHUB_DEPENDABOT_ALERT_ORIGIN_KIND,
      originId: input.originId,
      originFingerprint: input.originId,
    });
  }

  const externalKey = `${input.originId}:${input.alert.action}:${input.deliveryId ?? "no-delivery"}`;
  // BLO-19037: this used to be a read-then-insert (SELECT for an existing
  // receipt, then INSERT if none was found) which is a check-then-write race
  // across paperclip-api's replicas -- two concurrent deliveries of the same
  // event can both observe "no existing receipt" before either writes.
  // idempotencyKey rides the already-deployed partial unique index
  // (issue_comments_issue_system_idempotency_idx on issueId+idempotencyKey,
  // scoped to system comments) so the insert is a single atomic upsert:
  // ON CONFLICT DO NOTHING makes the external key authoritative in the
  // database rather than in application logic, independent of replica count.
  //
  // BLO-19037 review follow-up: the migration that introduced
  // idempotency_key left historical receipt comments nullable. Those rows
  // still carry metadata.externalKey, so preserve one metadata-key lookup
  // before the atomic insert or the first replay after deploy creates a
  // duplicate that the partial unique index cannot see.
  const legacyReceipt = await db
    .select({ id: issueComments.id })
    .from(issueComments)
    .where(and(
      eq(issueComments.companyId, input.companyId),
      eq(issueComments.issueId, issue.id),
      eq(issueComments.authorType, "system"),
      isNull(issueComments.idempotencyKey),
      isNull(issueComments.deletedAt),
      sql`${issueComments.metadata}->>'kind' = 'github_dependabot_terminal_receipt'`,
      sql`${issueComments.metadata}->>'externalKey' = ${externalKey}`,
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  if (!legacyReceipt) {
    await db
      .insert(issueComments)
      .values({
        companyId: input.companyId,
        issueId: issue.id,
        authorType: "system",
        idempotencyKey: externalKey,
        body: receiptBody,
        metadata: {
          kind: "github_dependabot_terminal_receipt",
          source: "github",
          externalKey,
          repoFullName: input.repoFullName,
          alertNumber: input.alert.alertNumber,
          action: input.alert.action,
          deliveryId: input.deliveryId,
          dismissalReason: input.alert.dismissalReason,
          dismissalComment: input.alert.dismissalComment,
        } as never,
      })
      .onConflictDoNothing();
  }

  // `cancelled` is excluded, not just `done`. The fallback lookup above has no
  // status filter, so it can resolve a deliberately-cancelled row -- and
  // `cancelled` -> `done` is a lateral move between two terminal states that
  // buys nothing while nulling `cancelledAt` (services/issues.ts clears it on
  // any status change away from `cancelled`). That would defeat the suppression
  // branch in resolveDependabotAlertIssue through a different door: once the
  // row reads `done`, every later re-fire takes the reopen path and wakes an
  // assignee again, with no field-level record the alert was ever cancelled.
  // The receipt comment above still lands on the row, so the terminal delivery
  // stays auditable.
  if (hasCompleteTerminalEvidence && issue.status !== "done" && issue.status !== "cancelled") {
    await issueService(db).update(issue.id, { status: "done" });
  }
}

// Records a durable diagnostic when a `dependabot_alert` delivery can't be
// resolved into a scoped alert (malformed/missing `alert` fields, or no
// `repository.full_name`) for an otherwise-actionable action -- see
// dependabot-alert-issues.ts's recordDependabotWebhookDiagnostic (imported
// above), shared with heartbeat.ts's BLO-16446 stale-wake backfill.

// BLO-15799: self-echo guard for the reviewer wake. The reviewer posts its
// review through the configured bot identity (allyblockcast[bot]; historically
// blockcast-ci-packages[bot]) and GitHub then delivers a
// pull_request_review.submitted webhook FOR THAT VERY REVIEW. Without this
// guard the echo re-woke the reviewer into a full run (K8s pod spin-up, ~$0.74
// of API spend, 1-3 minutes of the single maxConcurrentRuns slot) that only
// ever exited as an "already reviewed this head" no-op — during PR bursts the
// reviewer looked stuck. Scope is deliberately narrow: only the
// github_pr_review_submitted reason, and only when the review's author IS the
// reviewer's own posting identity (via isConfiguredPrReviewerAuthor, the same
// identity source the issue_comment mention guard uses). Human reviews and
// other bots' reviews still drive the counter-review wake, and the
// author-assignee wake is untouched — the reviewer's actionable findings still
// reopen and wake the PR author.
function isReviewerSelfEchoReview(
  context: ResolvedEventContext,
  configuredReviewerLogin: string | null | undefined,
): boolean {
  if (context.wakeReason !== "github_pr_review_submitted") return false;
  return isConfiguredPrReviewerAuthor(context.reviewAuthorLogin, configuredReviewerLogin);
}

function shouldFirePrReviewerWake(context: ResolvedEventContext | null): context is ResolvedEventContext & { prNumber: number } {
  if (!context || !context.wakeReason || typeof context.prNumber !== "number") return false;
  // A draft PR is work in progress: suppress the AUTOMATIC reasons (opened,
  // synchronize, reopened, review_submitted) so pushes to a draft don't spend a
  // review pass per commit. Draft PRs are consequently never reviewed until
  // they are marked ready — the agent instructions say so plainly (BLO-18865).
  //
  // github_pr_review_requested is exempt because it is an EXPLICIT ask, not
  // churn: draft state should not silently swallow someone (or some agent)
  // asking for review. Note this exemption is belt-and-braces today — the
  // issue_comment branch of resolveEventContext does not populate prDraft, so
  // comment-driven requests never reach the draft check. It is here so that
  // populating prDraft on that branch later cannot silently re-strand agents,
  // and it is covered by a direct predicate test.
  if (
    context.prDraft &&
    context.wakeReason !== "github_pr_ready_for_review" &&
    context.wakeReason !== "github_pr_review_requested"
  ) return false;
  return new Set([
    "github_pr_opened",
    "github_pr_reopened",
    "github_pr_ready_for_review",
    "github_pr_synchronized",
    "github_pr_review_requested",
    "github_pr_review_submitted",
  ]).has(context.wakeReason);
}

// A wake idempotency key is either REQUEST-scoped or STABLE, and the two want
// opposite treatment of terminal statuses (see idempotentWakeStatuses):
//
//   request — the suffix carries a per-event identity (GitHub comment id or
//     delivery id). The key can only recur if GitHub redelivers THAT event, so
//     a terminal success/cancellation must dedup: replaying it would redo work
//     that already happened.
//   stable  — the suffix is just repo+pr+reason, so a genuinely NEW event
//     reuses the key. A terminal status must NOT dedup, or the first completed
//     wake would block every later event of that reason on that PR forever.
type WakeIdempotencyScope = "request" | "stable";

// Computes the key suffix and its scope together so the two can never drift —
// getting `scope` wrong while the suffix stays right is exactly the bug that
// makes terminal-status dedup either too aggressive or useless. The reviewer
// and PR-author paths delivery-scope different reason sets, so each passes its
// own; `github_pr_review_requested` is comment-scoped on both.
//
// A suffix that had to fall back to `unknown` (no comment id AND no delivery
// id) is reported as `stable`, not `request`: two DISTINCT events would then
// collide on one key, and terminal dedup would drop the second for good. Only
// a suffix that actually carries per-event identity earns the request rule.
function wakeIdempotencySuffix(
  context: ResolvedEventContext,
  deliveryId: string | null,
  deliveryScopedReasons: ReadonlySet<string>,
): { suffix: string; scope: WakeIdempotencyScope } {
  const scopeFor = (identity: string | number | null): WakeIdempotencyScope =>
    identity === null || identity === "" ? "stable" : "request";
  if (context.wakeReason === "github_pr_review_requested") {
    const identity = context.commentId ?? deliveryId ?? null;
    return {
      suffix: `${context.wakeReason}:comment:${identity ?? "unknown"}`,
      scope: scopeFor(identity),
    };
  }
  if (context.wakeReason && deliveryScopedReasons.has(context.wakeReason)) {
    return {
      suffix: `${context.wakeReason}:delivery:${deliveryId ?? "unknown"}`,
      scope: scopeFor(deliveryId),
    };
  }
  return { suffix: context.wakeReason ?? "unknown", scope: "stable" };
}

const REVIEWER_DELIVERY_SCOPED_WAKE_REASONS: ReadonlySet<string> = new Set([
  "github_pr_ready_for_review",
  "github_pr_synchronized",
]);

// The PR-author wake keeps repo+pr+reason keys for everything except the
// comment-scoped @ally request; widening it is a separate behavior change.
const AUTHOR_DELIVERY_SCOPED_WAKE_REASONS: ReadonlySet<string> = new Set();

function prReviewerWakeIdempotencyScope(
  context: ResolvedEventContext,
  deliveryId: string | null,
): WakeIdempotencyScope {
  return wakeIdempotencySuffix(context, deliveryId, REVIEWER_DELIVERY_SCOPED_WAKE_REASONS).scope;
}

function buildPrReviewerWakeIdempotencyKey(
  context: ResolvedEventContext & { prNumber: number },
  deliveryId: string | null,
) {
  // Phase one of the casing transition keeps writes readable by old pods.
  // Compatibility reads and dual locks must deploy everywhere before a later
  // release can safely normalize persisted keys.
  const repo = context.repoFullName ?? "unknown";
  if (typeof context.prNumber !== "number") {
    logger.error(
      {
        deliveryId,
        repoFullName: context.repoFullName,
        wakeReason: context.wakeReason,
        prNumber: context.prNumber,
      },
      "github webhook reviewer wake idempotency key missing PR number",
    );
    throw new Error("PR reviewer wake idempotency key requires prNumber");
  }
  // @ally comment requests are scoped to the GitHub comment id so a later
  // explicit re-review comment can wake Ally again.
  //
  // github_pr_ready_for_review and github_pr_synchronized are scoped to the
  // delivery id for the same reason (BLO-18953). Each draft->ready toggle and
  // each push is a fresh request for the current head. Keying either on
  // repo+pr+reason alone made it self-poisoning: `coalesced` is an
  // IDEMPOTENT_REVIEWER_WAKE_STATUS and is terminal (the row is inserted with
  // finishedAt already set and never transitions), so once ONE event was
  // coalesced, every future event of that reason on that PR was dropped at this
  // precheck forever. Observed on Blockcast/paperclip#822 and on synchronize
  // pushes that arrived during an older-head running review. GitHub reuses the
  // delivery id when it retries a delivery, so genuine redeliveries still
  // dedup.
  //
  // Every other reason keys on repo+prNumber+reason alone. This deliberately
  // omits head sha and delivery id so the idempotency precheck can skip
  // duplicate in-flight wake requests for the same PR+reason. For those STABLE
  // keys `completed` is intentionally NOT an idempotent status (see
  // IDEMPOTENT_REVIEWER_WAKE_STATUSES), so a fixup pushed AFTER a review
  // finishes still enqueues a fresh reviewer wake rather than being blocked by
  // the earlier completed review. Request-scoped keys get the opposite rule via
  // idempotentWakeStatuses. Active run coalescing is controlled by
  // buildPrReviewerTaskKey plus enqueueWakeup's same-task-scope logic.
  const { suffix } = wakeIdempotencySuffix(
    context,
    deliveryId,
    REVIEWER_DELIVERY_SCOPED_WAKE_REASONS,
  );
  return `pr_review:${repo}:${context.prNumber}:${suffix}`;
}

// Deliberately PR-scoped, with no head sha: this key also scopes the reviewer
// affinity lookup (findInvokablePrReviewerForTask), the withPrReviewerTaskLock
// serialization, and the cancel-queued-runs-on-close sweep, all of which must
// stay stable across heads for one PR. Head-awareness for review requests lives
// in heartbeat's coalescing decision instead (BLO-18953).
function buildPrReviewerTaskKey(context: ResolvedEventContext & { prNumber: number }) {
  // Keep the legacy spelling during the compatibility rollout. New pods can
  // read either spelling; pre-normalization pods can only read this one.
  const repo = context.repoFullName ?? "unknown";
  return `pr_review:${repo}:${context.prNumber}`;
}

/**
 * Advisory-lock namespaces to hold while dispatching one PR's reviewer wake.
 *
 * The lock id is `hashtextextended(taskKey, 0)`, so changing the *spelling* of
 * the task key changes the namespace. Phase one keeps writing the raw,
 * mixed-case `repoFullName` so old readers can still see new rows, but
 * compatibility-aware pods lock both that namespace and the future normalized
 * namespace. A later release can switch producers only after every pod can read
 * and lock both spellings.
 *
 * Hold BOTH namespaces until no pre-normalization pod remains. Sorted, so
 * every caller acquires the pair in one order and two peers contending for the
 * same PR cannot livelock each other by grabbing opposite halves. Retire this
 * alongside the `lower()` legs in pr-review-duplicate-issue-guard.
 */
function buildPrReviewerTaskLockKeys(
  context: ResolvedEventContext & { prNumber: number },
): string[] {
  const legacyCasing = buildPrReviewerTaskKey(context);
  const normalized =
    `pr_review:${normalizePrReviewRepoFullName(context.repoFullName ?? "unknown")}` +
    `:${context.prNumber}`;
  return [...new Set([normalized, legacyCasing])].sort();
}

type PrReviewerWakeupOptions = NonNullable<Parameters<ReturnType<typeof heartbeatService>["wakeup"]>[1]> & {
  payload: Record<string, unknown> & { taskKey: string };
  contextSnapshot: Record<string, unknown> & { taskKey: string };
  idempotencyKey: string;
};

function buildPrReviewerWakeupOptions(
  context: ResolvedEventContext & { prNumber: number },
  eventName: string,
  deliveryId: string | null,
): PrReviewerWakeupOptions {
  const reviewerTaskKey = buildPrReviewerTaskKey(context);
  const idempotencyKey = buildPrReviewerWakeIdempotencyKey(context, deliveryId);

  return {
    source: "automation",
    triggerDetail: "system",
    reason: context.wakeReason,
    payload: {
      taskKey: reviewerTaskKey,
      source: "github",
      event: eventName,
      deliveryId,
      prNumber: context.prNumber,
      repoFullName: context.repoFullName,
      prUrl: context.prUrl,
      eventUrl: context.eventUrl,
      headSha: context.headSha,
      paperclipIdentifiers: context.identifiers,
      commentId: context.commentId,
      commentAuthorLogin: context.commentAuthorLogin,
      reviewKind: "pr_review",
    },
    contextSnapshot: {
      taskKey: reviewerTaskKey,
      wakeReason: context.wakeReason,
      wakeSource: "automation",
      wakeTriggerDetail: "system",
      commentSource: "github",
      githubEvent: eventName,
      githubDeliveryId: deliveryId,
      githubPrNumber: context.prNumber,
      githubRepoFullName: context.repoFullName,
      ...githubContextMetadata(context),
      ...(context.commentId ? { githubCommentId: context.commentId } : {}),
      ...(context.commentAuthorLogin
        ? { githubPrReviewRequestAuthorLogin: context.commentAuthorLogin }
        : {}),
      ...(context.commentBody ? { githubPrReviewRequestBody: context.commentBody } : {}),
      reviewKind: "pr_review",
      prRole: "reviewer",
    },
    // Open/ready/review-submitted events stay one wake per PR+reason.
    // @ally comment requests are scoped to the GitHub comment id so a
    // later explicit re-review comment can wake Ally again.
    idempotencyKey,
  };
}

function configuredPrReviewerAgentIds(config: GithubWebhookConfig): string[] {
  return [
    ...new Set(
      [...(config.prReviewerAgentIds ?? []), config.prReviewerAgentId ?? ""]
        .map((agentId) => agentId.trim())
        .filter(Boolean),
    ),
  ];
}

async function selectPrReviewerAgentId(
  db: PrReviewerSelectionDb,
  invokableAgentIds: readonly string[],
  taskKey: string,
): Promise<string | null> {
  if (invokableAgentIds.length === 0) return null;

  const loadRows = await db
    .select({ agentId: heartbeatRuns.agentId, count: sql<number>`count(*)::int` })
    .from(heartbeatRuns)
    .where(
      and(
        inArray(heartbeatRuns.agentId, [...invokableAgentIds]),
        inArray(heartbeatRuns.status, [...ACTIVE_PR_REVIEWER_RUN_STATUSES]),
      ),
    )
    .groupBy(heartbeatRuns.agentId);
  const loadByAgent = new Map(
    loadRows.map((row) => [row.agentId, Number(row.count)]),
  );
  const minimumLoad = Math.min(
    ...invokableAgentIds.map((agentId) => loadByAgent.get(agentId) ?? 0),
  );
  const leastLoadedAgentIds = invokableAgentIds.filter(
    (agentId) => (loadByAgent.get(agentId) ?? 0) === minimumLoad,
  );

  // Concurrent webhook deliveries can observe the same load snapshot. A
  // task-scoped tie-break spreads those PRs instead of biasing every tie to
  // the first configured reviewer, while duplicate events for one PR still
  // select the same reviewer and coalesce under that agent's task lock.
  const tieBreak = crypto.createHash("sha256").update(taskKey).digest().readUInt32BE(0);
  return leastLoadedAgentIds[tieBreak % leastLoadedAgentIds.length] ?? null;
}

async function findInvokablePrReviewerForTask(
  db: PrReviewerSelectionDb,
  invokableAgentIds: readonly string[],
  taskKey: string,
): Promise<string | null> {
  if (invokableAgentIds.length === 0) return null;

  return db
    .select({ agentId: heartbeatRuns.agentId })
    .from(heartbeatRuns)
    .where(
      and(
        inArray(heartbeatRuns.agentId, [...invokableAgentIds]),
        inArray(heartbeatRuns.status, [...ACTIVE_PR_REVIEWER_RUN_STATUSES]),
        matchesTaskKey(heartbeatRuns.contextTaskKey, taskKey),
      ),
    )
    .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id))
    .limit(1)
    .then((rows) => rows[0]?.agentId ?? null);
}

interface PrReviewerEligibility {
  invokableAgentIds: string[];
  transientlyUnavailable: boolean;
}

/**
 * Keep reviewer routing on the same invokability contract as ordinary
 * heartbeat dispatch. In particular, `error` is still invokable when the
 * reporting chain is healthy; paused/terminated/pending agents and invalid
 * chains remain excluded. A healthy paused reviewer is tracked separately as
 * transiently unavailable so the request can use the bounded availability
 * retry without turning terminal configuration errors into six hours of
 * polling. The webhook runs this under its PR lock, so a single company-scoped
 * snapshot is sufficient for the selection decision.
 */
async function resolvePrReviewerEligibility(
  db: PrReviewerSelectionDb,
  configuredAgentIds: readonly string[],
): Promise<PrReviewerEligibility> {
  if (configuredAgentIds.length === 0) {
    return { invokableAgentIds: [], transientlyUnavailable: false };
  }

  const configuredRows: AgentOrgRow[] = await db
    .select({
      id: agents.id,
      companyId: agents.companyId,
      name: agents.name,
      reportsTo: agents.reportsTo,
      status: agents.status,
    })
    .from(agents)
    .where(inArray(agents.id, [...configuredAgentIds]));
  if (configuredRows.length === 0) {
    return { invokableAgentIds: [], transientlyUnavailable: false };
  }

  const companyIds = [...new Set(configuredRows.map((row) => row.companyId))];
  const companyRows: AgentOrgRow[] = await db
    .select({
      id: agents.id,
      companyId: agents.companyId,
      name: agents.name,
      reportsTo: agents.reportsTo,
      status: agents.status,
    })
    .from(agents)
    .where(inArray(agents.companyId, companyIds));
  const rowsByCompany = new Map<string, AgentOrgRow[]>();
  for (const row of companyRows) {
    const rows = rowsByCompany.get(row.companyId) ?? [];
    rows.push(row);
    rowsByCompany.set(row.companyId, rows);
  }
  const configuredById = new Map(configuredRows.map((row) => [row.id, row]));
  let transientlyUnavailable = false;
  const invokableAgentIds = configuredAgentIds.filter((agentId) => {
    const agent = configuredById.get(agentId);
    if (!agent) return false;
    const invokability = evaluateAgentInvokability(
      agent,
      rowsByCompany.get(agent.companyId) ?? [],
    );
    if (invokability.invokable) return true;
    const orgChainHealth = getAgentOrgChainHealth({
      agent,
      agents: rowsByCompany.get(agent.companyId) ?? [],
    });
    if (
      invokability.reason === "paused" &&
      orgChainHealth?.status === "healthy"
    ) {
      transientlyUnavailable = true;
    }
    return false;
  });
  return { invokableAgentIds, transientlyUnavailable };
}

async function withPrReviewerTaskLock<T>(
  db: Db,
  taskKeys: readonly string[],
  action: (tx: DbTransaction) => Promise<T>,
): Promise<T> {
  const deadline = Date.now() + PR_REVIEWER_TASK_LOCK_TIMEOUT_MS;
  // Sorted at the call site (buildPrReviewerTaskLockKeys); re-sorted here so a
  // future caller passing an unordered pair still cannot invert the order.
  const lockKeys = [...new Set(taskKeys)].sort();
  if (lockKeys.length === 0) throw new Error("PR reviewer task lock requires at least one key");

  while (true) {
    // Do not block a pooled connection while another request owns the lock:
    // the winner needs a second connection for heartbeat's enqueue transaction.
    const outcome = await db.transaction(async (tx) => {
      // All-or-nothing: the locks are xact-scoped, so returning early releases
      // whichever prefix we did acquire when this transaction ends. Partial
      // ownership never escapes the retry loop.
      for (const lockKey of lockKeys) {
        const rows = await tx.execute(
          sql`select pg_try_advisory_xact_lock(hashtextextended(${lockKey}, 0)) as acquired`,
        );
        const row = Array.isArray(rows) ? rows[0] : null;
        if (
          !row ||
          typeof row !== "object" ||
          (row as Record<string, unknown>).acquired !== true
        ) {
          return { acquired: false as const };
        }
      }
      return { acquired: true as const, value: await action(tx) };
    });
    if (outcome.acquired) return outcome.value;
    if (Date.now() >= deadline) {
      throw new PrReviewerTaskLockTimeoutError();
    }
    await new Promise((resolve) => setTimeout(resolve, PR_REVIEWER_TASK_LOCK_RETRY_MS));
  }
}

/**
 * Cap on concurrent PR-reviewer wake attempts (BLO-21995).
 *
 * A lock winner holds its lock-owning transaction's pooled connection while
 * `heartbeat.wakeup()` checks out a *second* one for its own enqueue
 * transaction. Deliveries for distinct PRs never contend on the advisory lock,
 * so nothing throttled how many could be mid-flight at once: with a
 * 10-connection pool, 11+ simultaneous distinct-PR deliveries each took a
 * connection and then waited forever for one that only a peer could release.
 * Reproduced as a hard deadlock — 12 concurrent deliveries hung past a 60s
 * test timeout rather than completing.
 *
 * The bound is *derived* from {@link POSTGRES_POOL_MAX} rather than asserted in
 * prose, so shrinking the pool shrinks the bound with it instead of silently
 * reintroducing the deadlock. Each winner needs 2 connections, and we leave at
 * least one spare for the retry poller and the rest of the API tier sharing
 * this pool — hence `floor(max / 2) - 1`. Excess deliveries queue in-process
 * for a few milliseconds each; the critical section is two statements plus the
 * enqueue, so even a large burst drains far inside GitHub's webhook timeout.
 *
 * This is a bound, not the structural fix. Doing the enqueue on the lock's own
 * connection would remove the second checkout entirely, but `enqueueWakeup`
 * opens its own transaction and threading one through it is a much wider
 * change to the wake path — deliberately left for structural review rather
 * than folded in here.
 *
 * Exported for test: the invariant that matters is `2 * bound < poolMax`, and
 * pinning it as a property of the derivation covers pool sizes no integration
 * test could practically stand up.
 */
export function derivePrReviewerWakeMaxConcurrency(poolMax: number): number {
  return Math.max(1, Math.floor(poolMax / 2) - 1);
}

const PR_REVIEWER_WAKE_MAX_CONCURRENCY = derivePrReviewerWakeMaxConcurrency(POSTGRES_POOL_MAX);
let prReviewerWakeInFlight = 0;
const prReviewerWakeWaiters: Array<() => void> = [];

async function acquirePrReviewerWakeSlot(): Promise<void> {
  if (prReviewerWakeInFlight < PR_REVIEWER_WAKE_MAX_CONCURRENCY) {
    prReviewerWakeInFlight += 1;
    return;
  }
  // The releaser hands its slot straight to the next waiter without touching
  // the counter, so a slot can never be double-claimed by a waiter that wakes
  // concurrently with a fresh caller.
  await new Promise<void>((resolve) => prReviewerWakeWaiters.push(resolve));
}

function releasePrReviewerWakeSlot(): void {
  const next = prReviewerWakeWaiters.shift();
  if (next) {
    next();
    return;
  }
  prReviewerWakeInFlight -= 1;
}

/**
 * Outcome of one PR-reviewer wake attempt. Every branch except `queued` is a
 * terminal no-op for this delivery: replaying it would not change the result,
 * so the retry worker retires the durable record rather than re-arming it.
 */
type PrReviewerWakeOutcome = "queued" | "duplicate" | "no_reviewer" | "declined";

/**
 * Assign a reviewer for one PR event and enqueue its wake, serialized on the
 * PR scope.
 *
 * Extracted from the webhook route (BLO-21995) so the durable retry worker can
 * replay a delivery through *exactly* this path. That sharing is what makes the
 * retry safe: reacquiring the same PR-scope advisory lock here means a replay
 * races concurrent live deliveries under the same mutual exclusion as the
 * original, so it cannot assign a second reviewer to a PR that already has one.
 * Re-running the idempotency probe under that lock is what keeps a replay (or a
 * GitHub redelivery of the same event) to exactly one wake.
 *
 * Throws {@link PrReviewerTaskLockTimeoutError} when the PR scope stays
 * contended for the whole timeout; the caller owns durability from there.
 */
async function attemptPrReviewerWake(params: {
  db: Db;
  config: GithubWebhookConfig;
  context: ResolvedEventContext & { prNumber: number };
  eventName: string;
  deliveryId: string | null;
  reviewerAgentIds: readonly string[];
}): Promise<PrReviewerWakeOutcome> {
  const { db, config, context, eventName, deliveryId, reviewerAgentIds } = params;
  const heartbeat = heartbeatService(db, {
    pluginWorkerManager: config.pluginWorkerManager,
    ...config.heartbeatOptions,
  });
  const reviewerWakeupOptions = buildPrReviewerWakeupOptions(context, eventName, deliveryId);
  const reviewerTaskKey = reviewerWakeupOptions.payload.taskKey;
  const idempotencyKey = reviewerWakeupOptions.idempotencyKey;
  // taskKey scopes active-run coalescing; idempotencyKey scopes duplicate
  // request rows for the same PR+reason before enqueueing.
  // Request-scoped keys also dedup terminal completed/cancelled rows, so a
  // GitHub redelivery of one event cannot re-run work that already ran or
  // was retired by converted_to_draft (BLO-18953).
  const idempotentStatuses = idempotentWakeStatuses(
    prReviewerWakeIdempotencyScope(context, deliveryId),
  );
  // Bound *before* taking the advisory lock: waiting for a slot must not itself
  // hold a pooled connection, or the queue would recreate the exhaustion it
  // exists to prevent.
  await acquirePrReviewerWakeSlot();
  try {
    return await withPrReviewerTaskLock(db, buildPrReviewerTaskLockKeys(context), async (tx) => {
      // The wake insert commits through heartbeat's own transaction. Keep
      // this transaction-scoped lock held until that commit is visible so
      // concurrent first events for one PR re-check affinity instead of
      // assigning the same task to different reviewers.
      const existingWake = await tx
        .select({ id: agentWakeupRequests.id, status: agentWakeupRequests.status })
        .from(agentWakeupRequests)
        .where(
          and(
            inArray(agentWakeupRequests.agentId, [...reviewerAgentIds]),
            // Case-insensitive on the repo segment, for the same reason the
            // task-key lookups are. Phase one retains legacy-spelled writes
            // for old-reader safety, but normalized rows may already exist
            // from a canary or interrupted rollout. Byte-exact equality
            // would make those rows invisible and let a redelivery queue a
            // duplicate — worst when the original run is terminal and task
            // coalescing has nothing live to catch it. Reviewer keys are
            // `pr_review:<repo>:<n>:<suffix>`, so they carry the shared
            // predicate's `pr_review:` prefix; the suffix segments (wake
            // reason, numeric comment id, GitHub delivery uuid) are already
            // lowercase, so folding case cannot merge two distinct requests.
            matchesTaskKey(agentWakeupRequests.idempotencyKey, idempotencyKey),
            inArray(agentWakeupRequests.status, idempotentStatuses),
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (existingWake) {
        logger.info(
          {
            existingWakeId: existingWake.id,
            existingWakeStatus: existingWake.status,
            idempotencyKey,
            event: eventName,
            deliveryId,
            wakeReason: context.wakeReason,
            prNumber: context.prNumber,
            repoFullName: context.repoFullName,
          },
          "github webhook reviewer wake skipped: duplicate idempotency key",
        );
        return "duplicate";
      }

      const reviewerEligibility = await resolvePrReviewerEligibility(tx, reviewerAgentIds);
      const reviewerAgentId =
        (await findInvokablePrReviewerForTask(
          tx,
          reviewerEligibility.invokableAgentIds,
          reviewerTaskKey,
        )) ??
        (await selectPrReviewerAgentId(
          tx,
          reviewerEligibility.invokableAgentIds,
          reviewerTaskKey,
        ));
      if (!reviewerAgentId) {
        logger.warn(
          {
            configuredReviewerCount: reviewerAgentIds.length,
            event: eventName,
            prNumber: context.prNumber,
            repoFullName: context.repoFullName,
            transientlyUnavailable: reviewerEligibility.transientlyUnavailable,
          },
          "github webhook reviewer wake skipped: no configured reviewer is invokable",
        );
        if (reviewerEligibility.transientlyUnavailable) {
          throw new PrReviewerUnavailableError();
        }
        return "no_reviewer";
      }

      // BLO-18859: every suppression gate is behind us and a reviewer is
      // resolved, so this delivery is now committed to producing a wake.
      // Counting `received` here (rather than at signature verification)
      // makes `received - queued` a measure of real loss between intent and
      // durability — deduped/self-echo/no-reviewer deliveries are correct
      // no-ops and would otherwise swamp that gap in steady state.
      recordGithubReviewRequestDelivery({ state: "received", reason: context.wakeReason });

      const wakeResult = await heartbeat.wakeup(reviewerAgentId, reviewerWakeupOptions);
      // A truthy result means the durable agent_wakeup_requests row is
      // committed AND a run was enqueued/coalesced; from here the wake
      // survives this process dying. Any transient dispatch failure inside
      // wakeup() has already been retried and counted as `retried` by
      // wakeupWithDispatchRetry, so this only fires on real durability.
      //
      // A `null` result is NOT a success: enqueueWakeup resolves null
      // (without throwing) when a scheduling gate declines the wake — it
      // writes a status="skipped" row and no run. Counting that as `queued`
      // reported a healthy received+queued funnel for a review that never
      // ran, hiding exactly the BLO-18847 symptom this counter exists to
      // surface. No reconciler pass re-arms a skipped row, so it is
      // terminal for this delivery.
      if (wakeResult) {
        recordGithubReviewRequestDelivery({ state: "queued", reason: context.wakeReason });
        return "queued";
      }
      // The terminal `suppressed` increment is NOT emitted here: the wake
      // path owns it, because only `enqueueWakeup` knows which gate
      // declined and the suppression metric's `cause` label needs that. The
      // same applies to an HttpError refusal, which never reaches this line
      // at all — it propagates to the caller's catch, and counting it here
      // would have been impossible (BLO-18859 review follow-up).
      logger.warn(
        {
          agentId: reviewerAgentId,
          event: eventName,
          githubDeliveryId: deliveryId,
          prNumber: context.prNumber,
          repoFullName: context.repoFullName,
          wakeReason: context.wakeReason,
        },
        "github webhook reviewer wake did not queue a run; a gate declined it "
          + "(check agent_wakeup_requests for the skipped row's reason) or the "
          + "provider-capacity gate deferred it to a scheduled_retry run",
      );
      return "declined";
    });
  } finally {
    releasePrReviewerWakeSlot();
  }
}

/**
 * Durable-retry states for a PR-reviewer wake that never reached heartbeat
 * because its PR scope stayed contended (BLO-21995).
 *
 * These deliberately sit OUTSIDE {@link IDEMPOTENT_REVIEWER_WAKE_STATUSES}: a
 * pending retry record must not satisfy the idempotency probe, or the replay
 * would treat its own record as an already-delivered wake and retire itself
 * without ever waking anyone. Exactly-once is enforced the other way round —
 * the replay re-runs the probe under the PR lock, so whichever of {live
 * delivery, replay} gets there second sees the first one's `queued` row and
 * stands down.
 */
const PR_REVIEWER_CONTENDED_STATUS = "pr_reviewer_dispatch_contended";
const PR_REVIEWER_CONTENDED_RECOVERED_STATUS = "pr_reviewer_dispatch_recovered";
const PR_REVIEWER_CONTENDED_SUPERSEDED_STATUS = "pr_reviewer_dispatch_superseded";
const PR_REVIEWER_CONTENDED_EXHAUSTED_STATUS = "pr_reviewer_dispatch_exhausted";

/**
 * Contention is transient by construction — the competing delivery holds the
 * scope only for its own wake — so the first re-attempt is seconds away, not
 * minutes. The tail is long enough to outlast a slow heartbeat enqueue without
 * spinning.
 */
const PR_REVIEWER_CONTENDED_BACKOFF_MS = [5_000, 15_000, 60_000, 300_000];
const PR_REVIEWER_CONTENDED_MAX_ATTEMPTS = PR_REVIEWER_CONTENDED_BACKOFF_MS.length;

/**
 * Reviewer *availability* is bounded separately from lock contention
 * (BLO-21995).
 *
 * The ladder above is sized for a competing delivery holding the PR scope —
 * milliseconds — and totals ~380s. Reviewer downtime is a different
 * distribution entirely: a rolling restart, a pause for a config push, or a
 * budget top-up routinely exceeds 6 minutes. Charging those to the contention
 * budget would dead-letter a sanctioned review request for the ordinary
 * operation of deploying the reviewer.
 *
 * So availability re-arms on its own slower ladder and is bounded by
 * wall-clock rather than by attempt count — the question is "has the reviewer
 * been gone too long to still be worth waking for this PR", which is a
 * duration, not a number of polls.
 */
const PR_REVIEWER_UNAVAILABLE_BACKOFF_MS = [30_000, 120_000, 300_000, 900_000];
const PR_REVIEWER_UNAVAILABLE_MAX_WAIT_MS = 6 * 60 * 60 * 1_000;

/**
 * Raised when a replay finds no invokable reviewer (BLO-21995).
 *
 * Deliberately NOT an {@link HttpError}: that class means "a business rule
 * refused this and will keep refusing", which retires the record. Reviewer
 * availability is the opposite — a transient condition the durable record
 * exists to outlive — so this rides the transient re-arm path.
 *
 * It is bounded by {@link PR_REVIEWER_UNAVAILABLE_MAX_WAIT_MS} rather than by
 * the lock-contention attempt budget: charging a reviewer restart to a ladder
 * sized for a held advisory lock would dead-letter a sanctioned request for the
 * ordinary act of deploying the reviewer.
 */
class PrReviewerUnavailableError extends Error {
  constructor() {
    super("no configured reviewer is currently active for this PR");
    this.name = "PrReviewerUnavailableError";
  }
}

/** Replay input persisted on a contended record; `buildPrReviewerWakeupOptions` is a pure function of these. */
interface ContendedPrReviewerReplay {
  attempts: number;
  /**
   * Wall-clock anchor for the *availability* wait, held separately from
   * `attempts` so a reviewer outage cannot burn the lock-contention budget
   * (BLO-21995). Null until the first `no_reviewer` replay; cleared again if
   * the reviewer comes back and the replay fails for some other reason.
   */
  unavailableSince: string | null;
  /**
   * Position on the availability ladder. Separate from `attempts` for the same
   * reason, and needed on its own so the availability backoff actually
   * escalates — indexing the ladder with the frozen `attempts` would poll at
   * the first rung forever.
   */
  availabilityAttempts: number;
  nextAttemptAt: string;
  eventName: string;
  deliveryId: string | null;
  taskKey: string;
  context: ResolvedEventContext & { prNumber: number };
}

type PrReviewerRetryCause = "contention" | "unavailable";

/**
 * Persist a PR-reviewer wake that lost its scope lock, so a worker can replay
 * it (BLO-21995).
 *
 * Before this, a contended delivery answered HTTP 200 with
 * `reviewerWakeFired: false` and nothing written — and because GitHub only
 * redelivers deliveries it recorded as *failed*, a 200 put the event beyond
 * reach of even manual redelivery. The wake was gone.
 *
 * The reviewer stored here is provisional and is NOT the assignment decision:
 * it exists to satisfy the row's `agent_id`, and the replay re-resolves the
 * reviewer under the PR lock (affinity first), so a concurrent winner's choice
 * takes precedence. Nothing downstream reads this column as authoritative.
 *
 * Because it is only an FK anchor, reviewer *availability* is deliberately not
 * a precondition for recording. A reviewer that is paused or mid-restart at
 * this instant is a transient condition, and the contended delivery outlives
 * it; refusing to persist would turn a seconds-long blip into a permanently
 * lost review request — the exact loss this function exists to prevent.
 *
 * Returns true when a durable record exists for this delivery (including one a
 * concurrent redelivery already wrote). False means nothing will ever retry it,
 * and the caller must fail the delivery so GitHub keeps it redeliverable.
 */
async function persistContendedPrReviewerWake(params: {
  db: Db;
  context: ResolvedEventContext & { prNumber: number };
  eventName: string;
  deliveryId: string | null;
  reviewerAgentIds: readonly string[];
  taskKey: string;
  cause?: PrReviewerRetryCause;
}): Promise<boolean> {
  const {
    db,
    context,
    eventName,
    deliveryId,
    reviewerAgentIds,
    taskKey,
    cause = "contention",
  } = params;
  const wakeupOptions = buildPrReviewerWakeupOptions(context, eventName, deliveryId);
  const idempotencyKey = wakeupOptions.idempotencyKey;

  // Prefer a reviewer that is actually invokable so the provisional pick is
  // usually the one the replay lands on anyway, but fall back to any
  // *configured* reviewer row: the column is an FK anchor, not a decision.
  const reviewerEligibility = await resolvePrReviewerEligibility(db, reviewerAgentIds);
  const provisionalAgentId =
    (await findInvokablePrReviewerForTask(
      db,
      reviewerEligibility.invokableAgentIds,
      taskKey,
    )) ??
    (await selectPrReviewerAgentId(
      db,
      reviewerEligibility.invokableAgentIds,
      taskKey,
    )) ??
    (await db
      .select({ id: agents.id })
      .from(agents)
      .where(inArray(agents.id, [...reviewerAgentIds]))
      .limit(1)
      .then((rows) => rows[0]?.id ?? null));
  if (!provisionalAgentId) {
    // Not "no reviewer is available" — "no configured reviewer exists as an
    // agent row at all", so there is no company to file the record under and
    // no FK target. Genuinely unrecordable; the caller 503s instead.
    logger.error(
      { taskKey, deliveryId, event: eventName, repoFullName: context.repoFullName },
      "github webhook reviewer wake lost to lock contention and no configured reviewer row exists to record it against",
    );
    return false;
  }
  const provisionalAgent = await db
    .select({ companyId: agents.companyId })
    .from(agents)
    .where(eq(agents.id, provisionalAgentId))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!provisionalAgent) return false;

  const replay: ContendedPrReviewerReplay = {
    attempts: 0,
    // An initial no-reviewer outcome is already an availability observation,
    // so start its wall clock and ladder here. Contention records keep the
    // clock dormant until a replay first observes the reviewer unavailable.
    unavailableSince: cause === "unavailable" ? new Date().toISOString() : null,
    availabilityAttempts: cause === "unavailable" ? 1 : 0,
    // Never null: a record the due-ness filter can't select is stranded
    // silently, the failure mode the provider-capacity path guards with its
    // own default delay.
    nextAttemptAt: new Date(
      Date.now() +
        (cause === "unavailable"
          ? PR_REVIEWER_UNAVAILABLE_BACKOFF_MS[0]
          : PR_REVIEWER_CONTENDED_BACKOFF_MS[0]),
    ).toISOString(),
    eventName,
    deliveryId,
    taskKey,
    context,
  };
  // One retry record per delivery, claimed atomically. A plain
  // select-then-insert races: two simultaneous redeliveries of the same
  // x-github-delivery id would both observe no row and both write one. The
  // duplicate cannot produce a second reviewer wake (the PR-scope advisory lock
  // still serializes the replays), but it would over-count the
  // `deferred`/`retried` funnel and double the reconciler's work.
  //
  // Serialized on an advisory lock rather than a unique index because
  // `agent_wakeup_requests` is one of the largest tables in the schema and
  // drizzle runs migrations transactionally, so the index could not be built
  // CONCURRENTLY — it would hold ACCESS EXCLUSIVE across a full heap scan and
  // stall the very wake path this change exists to protect.
  //
  // This lock shares the single-bigint advisory space with the PR-scope lock
  // (both hash through `hashtextextended(k, 0)`), so the distinct string prefix
  // does NOT give it a separate key space — separation rests on 64-bit
  // collision improbability, not on construction. That is fine here: there is
  // no lock-ordering hazard either way, because the PR-scope lock has already
  // been released by the time this one is taken.
  const claimKey = `pr_reviewer_contended_retry:${idempotencyKey}`;
  const recorded = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${claimKey}, 0))`);
    const existing = await tx
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.idempotencyKey, idempotencyKey),
          eq(agentWakeupRequests.status, PR_REVIEWER_CONTENDED_STATUS),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (existing) return false;
    await tx.insert(agentWakeupRequests).values({
      companyId: provisionalAgent.companyId,
      agentId: provisionalAgentId,
      source: wakeupOptions.source ?? "automation",
      triggerDetail: wakeupOptions.triggerDetail ?? null,
      reason: wakeupOptions.reason ?? null,
      payload: { ...wakeupOptions.payload, prReviewerContendedRetry: replay },
      status: PR_REVIEWER_CONTENDED_STATUS,
      idempotencyKey,
    });
    return true;
  });
  if (!recorded) {
    // A concurrent redelivery of this same delivery id already recorded it.
    // Still durable, so the caller must not 503 and invite a third replay.
    logger.info(
      { taskKey, deliveryId, event: eventName, idempotencyKey },
      "deferred PR-reviewer wake already recorded by a concurrent delivery (BLO-21995)",
    );
    return true;
  }

  // `received` marks intent-to-wake, which a contended delivery genuinely has —
  // it got past every suppression gate and only lost a race. Pairing it with
  // `deferred` keeps the funnel's "durably recorded, not yet dispatched" arm
  // honest, exactly as the provider-capacity deferral does.
  recordGithubReviewRequestDelivery({ state: "received", reason: context.wakeReason });
  recordGithubReviewRequestDelivery({ state: "deferred", reason: context.wakeReason });
  logger.warn(
    {
      taskKey,
      deliveryId,
      event: eventName,
      prNumber: context.prNumber,
      repoFullName: context.repoFullName,
      wakeReason: context.wakeReason,
      idempotencyKey,
      provisionalAgentId,
      nextAttemptAt: replay.nextAttemptAt,
      retryCause: cause,
    },
    cause === "unavailable"
      ? "github webhook reviewer wake deferred: configured reviewer temporarily unavailable, durable retry recorded"
      : "github webhook reviewer wake deferred: PR scope contended, durable retry recorded (BLO-21995)",
  );
  return true;
}

export interface ContendedPrReviewerWakeReconciliation {
  recovered: number;
  superseded: number;
  exhausted: number;
  stillContended: number;
}

/**
 * Parse a persisted replay record, validating the fields the replay actually
 * consumes rather than just the ones it indexes on.
 *
 * Records outlive a deploy (an availability wait can span hours), so a version
 * that adds a required context field will meet rows written by the previous
 * one. Anything missing here must fail the parse — where the caller retires the
 * row as `superseded` — rather than reaching `buildPrReviewerWakeupOptions` and
 * producing a wake addressed to `undefined`, or a metric labelled with it.
 */
function parseContendedReplay(payload: unknown): ContendedPrReviewerReplay | null {
  if (!payload || typeof payload !== "object") return null;
  const replay = (payload as Record<string, unknown>).prReviewerContendedRetry;
  if (!replay || typeof replay !== "object") return null;
  const candidate = replay as Partial<ContendedPrReviewerReplay>;
  if (!candidate.context || typeof candidate.context !== "object") return null;
  if (typeof candidate.context.prNumber !== "number") return null;
  // Consumed by buildPrReviewerWakeupOptions and by the delivery metric's
  // `reason` label respectively.
  if (typeof candidate.context.repoFullName !== "string") return null;
  if (typeof candidate.context.wakeReason !== "string") return null;
  if (typeof candidate.taskKey !== "string" || typeof candidate.eventName !== "string") return null;
  if (typeof candidate.nextAttemptAt !== "string") return null;
  // Must round-trip, not merely be a string: the due-ness query treats a
  // non-castable value as NULL (= due), so a row that got here with garbage
  // would otherwise replay on every pass forever instead of being retired.
  if (Number.isNaN(Date.parse(candidate.nextAttemptAt))) return null;
  if (
    candidate.unavailableSince !== null &&
    candidate.unavailableSince !== undefined &&
    (typeof candidate.unavailableSince !== "string" ||
      Number.isNaN(Date.parse(candidate.unavailableSince)))
  ) {
    return null;
  }
  if (
    candidate.attempts !== undefined &&
    (typeof candidate.attempts !== "number" ||
      !Number.isFinite(candidate.attempts) ||
      candidate.attempts < 0)
  ) {
    return null;
  }
  if (
    candidate.availabilityAttempts !== undefined &&
    (typeof candidate.availabilityAttempts !== "number" ||
      !Number.isFinite(candidate.availabilityAttempts) ||
      candidate.availabilityAttempts < 0)
  ) {
    return null;
  }
  return {
    attempts: typeof candidate.attempts === "number" ? candidate.attempts : 0,
    unavailableSince:
      typeof candidate.unavailableSince === "string" ? candidate.unavailableSince : null,
    availabilityAttempts:
      typeof candidate.availabilityAttempts === "number" ? candidate.availabilityAttempts : 0,
    nextAttemptAt: candidate.nextAttemptAt,
    eventName: candidate.eventName,
    deliveryId: typeof candidate.deliveryId === "string" ? candidate.deliveryId : null,
    taskKey: candidate.taskKey,
    context: candidate.context as ResolvedEventContext & { prNumber: number },
  };
}

/**
 * Replay PR-reviewer wakes that lost their scope lock (BLO-21995).
 *
 * Runs on the heartbeat scheduler tick. Each due record is replayed through
 * {@link attemptPrReviewerWake}, which reacquires the PR-scope advisory lock —
 * so a replay is serialized against live deliveries for the same PR and cannot
 * assign a second reviewer.
 *
 * Two schedulers may pick up the same record concurrently; that is safe rather
 * than merely tolerated. Both replays contend for the one PR lock, and the
 * loser's idempotency probe finds the winner's `queued` row and returns
 * `duplicate`. The terminal UPDATE is additionally guarded on the row still
 * being `contended`, so the outcome recorded is whichever transition landed
 * first rather than a clobber.
 */
export async function reconcileContendedPrReviewerWakes(
  db: Db,
  config: GithubWebhookConfig,
  now: Date = new Date(),
): Promise<ContendedPrReviewerWakeReconciliation> {
  const result: ContendedPrReviewerWakeReconciliation = {
    recovered: 0,
    superseded: 0,
    exhausted: 0,
    stillContended: 0,
  };
  const reviewerAgentIds = configuredPrReviewerAgentIds(config);
  if (reviewerAgentIds.length === 0) return result;

  // Filter and order by due-ness, not requestedAt: under a backlog, older rows
  // whose backoff has escalated further out would otherwise fill the batch and
  // starve rows that are due right now (the BLO-14395 review lesson).
  //
  // The cast is guarded because it runs over *every* candidate row: a single
  // record whose `nextAttemptAt` is not timestamp-castable would abort the
  // whole query and strand every other due retry behind it. Shape-checking
  // first yields NULL for such a row instead, and NULL is treated as due and
  // sorted first, so the row is drained on the next pass (`parseContendedReplay`
  // rejects it and it retires as `superseded`) rather than silently stuck.
  const nextAttemptAtText = sql`(${agentWakeupRequests.payload} -> 'prReviewerContendedRetry' ->> 'nextAttemptAt')`;
  const nextAttemptAtExpr = sql`(CASE WHEN ${nextAttemptAtText} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ]' THEN ${nextAttemptAtText}::timestamptz END)`;
  const dueRows = await db
    .select()
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.status, PR_REVIEWER_CONTENDED_STATUS),
        sql`(${nextAttemptAtExpr} IS NULL OR ${nextAttemptAtExpr} <= ${now.toISOString()}::timestamptz)`,
      ),
    )
    .orderBy(sql`${nextAttemptAtExpr} ASC NULLS FIRST`)
    .limit(50);

  for (const row of dueRows) {
    const replay = parseContendedReplay(row.payload);
    if (!replay) {
      await retireContendedRow(db, row.id, PR_REVIEWER_CONTENDED_SUPERSEDED_STATUS, "unparseable retry record");
      result.superseded += 1;
      continue;
    }
    const attempts = replay.attempts + 1;
    // Counted up-front so a pass that throws somewhere unexpected still shows
    // as an attempt rather than looking like it never ran.
    recordGithubReviewRequestDelivery({ state: "retried", reason: replay.context.wakeReason });

    try {
      const outcome = await attemptPrReviewerWake({
        db,
        config,
        context: replay.context,
        eventName: replay.eventName,
        deliveryId: replay.deliveryId,
        reviewerAgentIds,
      });
      if (outcome === "queued") {
        await retireContendedRow(db, row.id, PR_REVIEWER_CONTENDED_RECOVERED_STATUS, null);
        result.recovered += 1;
        logger.info(
          { taskKey: replay.taskKey, deliveryId: replay.deliveryId, attempts },
          "contended PR-reviewer wake recovered by durable retry (BLO-21995)",
        );
        continue;
      }
      if (outcome === "no_reviewer") {
        // `attemptPrReviewerWake` throws PrReviewerUnavailableError itself
        // when it sees a healthy paused reviewer. Reaching this branch means
        // every configured reviewer is in a terminal policy/configuration
        // state (terminated, pending approval, invalid chain, unknown status,
        // or missing), so retrying cannot change the answer. Retire the
        // contention record without emitting a dead-letter alert for a request
        // the configured policy has deliberately refused.
        await retireContendedRow(
          db,
          row.id,
          PR_REVIEWER_CONTENDED_SUPERSEDED_STATUS,
          "no configured reviewer is invokable",
        );
        result.superseded += 1;
        continue;
      }
      // duplicate / declined are terminal for this delivery: replaying cannot
      // change either. `duplicate` is the expected outcome when the delivery
      // that won the original race did the work.
      await retireContendedRow(db, row.id, PR_REVIEWER_CONTENDED_SUPERSEDED_STATUS, outcome);
      result.superseded += 1;
    } catch (err) {
      const contended = err instanceof PrReviewerTaskLockTimeoutError;
      // An HttpError is a business-rule refusal (the agent got paused, the
      // company went inactive): the underlying condition resolved into a
      // durable decline, not a transient failure. Retrying it four times
      // cannot change the answer, and letting it reach the exhaustion branch
      // would emit a `dead_lettered` that pages for a delivery nothing was
      // ever going to accept. Mirrors how the generic dispatch reconciler
      // treats the same class.
      if (err instanceof HttpError) {
        await retireContendedRow(
          db,
          row.id,
          PR_REVIEWER_CONTENDED_SUPERSEDED_STATUS,
          err.message,
        );
        result.superseded += 1;
        logger.info(
          { err, taskKey: replay.taskKey, deliveryId: replay.deliveryId },
          "contended PR-reviewer wake superseded: replay refused by a business rule (BLO-21995)",
        );
        continue;
      }
      const unavailable = err instanceof PrReviewerUnavailableError;
      // Reviewer downtime does not consume the lock-contention budget: it
      // re-arms on its own ladder and is bounded by how long the reviewer has
      // been gone, not by how many times we have looked (BLO-21995).
      const unavailableSince = unavailable
        ? (replay.unavailableSince ?? now.toISOString())
        : null;
      const unavailableForMs = unavailableSince
        ? now.getTime() - new Date(unavailableSince).getTime()
        : 0;
      const budgetExhausted = unavailable
        ? unavailableForMs >= PR_REVIEWER_UNAVAILABLE_MAX_WAIT_MS
        : attempts >= PR_REVIEWER_CONTENDED_MAX_ATTEMPTS;
      if (budgetExhausted) {
        await retireContendedRow(
          db,
          row.id,
          PR_REVIEWER_CONTENDED_EXHAUSTED_STATUS,
          err instanceof Error ? err.message : String(err),
        );
        // Terminal and queryable/alertable — the one outcome where a sanctioned
        // review request really is dropped, so it must never be silent.
        recordGithubReviewRequestDelivery({ state: "dead_lettered", reason: replay.context.wakeReason });
        result.exhausted += 1;
        logger.error(
          {
            err,
            taskKey: replay.taskKey,
            deliveryId: replay.deliveryId,
            attempts,
            wakeupRequestId: row.id,
            ...(unavailable ? { unavailableForMs, unavailableSince } : {}),
          },
          // NOT "redeliver from GitHub": the contended delivery answered 200
          // precisely so GitHub would not retain it, and GitHub only offers
          // redelivery for deliveries it recorded as failed. There is no
          // GitHub-side replay to perform. The full replay payload is still on
          // this row, so the recovery is in-process — flip the status back and
          // the next reconcile pass picks it up unchanged.
          "contended PR-reviewer wake exhausted its durable retries; recover in-process by resetting " +
            `agent_wakeup_requests.status from '${PR_REVIEWER_CONTENDED_EXHAUSTED_STATUS}' to ` +
            `'${PR_REVIEWER_CONTENDED_STATUS}' for this id (BLO-21995)`,
        );
        continue;
      }
      const backoffMs = unavailable
        ? (PR_REVIEWER_UNAVAILABLE_BACKOFF_MS[replay.availabilityAttempts] ??
          PR_REVIEWER_UNAVAILABLE_BACKOFF_MS.at(-1)!)
        : (PR_REVIEWER_CONTENDED_BACKOFF_MS[attempts] ?? PR_REVIEWER_CONTENDED_BACKOFF_MS.at(-1)!);
      await db
        .update(agentWakeupRequests)
        .set({
          payload: {
            ...(row.payload ?? {}),
            prReviewerContendedRetry: {
              ...replay,
              // An availability wait must not spend the contention budget, or
              // a reviewer restart dead-letters the request after ~6 minutes.
              attempts: unavailable ? replay.attempts : attempts,
              unavailableSince,
              // Walks the availability ladder while the reviewer is gone, and
              // resets once it comes back so a later outage starts over at the
              // short rung rather than inheriting the previous one's tail.
              availabilityAttempts: unavailable ? replay.availabilityAttempts + 1 : 0,
              nextAttemptAt: new Date(now.getTime() + backoffMs).toISOString(),
            },
          },
          error: err instanceof Error ? err.message : String(err),
          updatedAt: now,
        })
        .where(
          and(
            eq(agentWakeupRequests.id, row.id),
            eq(agentWakeupRequests.status, PR_REVIEWER_CONTENDED_STATUS),
          ),
        );
      result.stillContended += 1;
      if (!contended) {
        logger.warn(
          { err, taskKey: replay.taskKey, deliveryId: replay.deliveryId, attempts },
          "contended PR-reviewer wake retry failed; re-armed (BLO-21995)",
        );
      }
    }
  }

  return result;
}

async function retireContendedRow(
  db: Db,
  id: string,
  status: string,
  error: string | null,
): Promise<void> {
  await db
    .update(agentWakeupRequests)
    .set({ status, error, finishedAt: new Date(), updatedAt: new Date() })
    .where(
      and(eq(agentWakeupRequests.id, id), eq(agentWakeupRequests.status, PR_REVIEWER_CONTENDED_STATUS)),
    );
}

function prFeedbackBody(context: ResolvedEventContext): string | null {
  return context.reviewBody ?? context.commentBody ?? null;
}

function prFeedbackAuthorLogin(context: ResolvedEventContext): string | null {
  return context.reviewAuthorLogin ?? context.commentAuthorLogin ?? null;
}

function isActionableReviewFeedbackContext(context: ResolvedEventContext): boolean {
  if (context.wakeReason === "github_pr_review_feedback") return true;
  if (context.wakeReason !== "github_pr_review_submitted") return false;
  if (context.reviewHasActionableFeedback !== undefined) return context.reviewHasActionableFeedback;
  return hasActionablePrReviewFeedback(context.reviewBody, context.reviewState);
}

function buildPrFeedbackExternalKey(context: ResolvedEventContext, deliveryId: string | null): string | null {
  if (context.commentId) return `github_issue_comment:${context.commentId}`;
  // BLO-19497: an explicit (repo, pr, review_id) key rather than the opaque
  // reviewUrl -- easier to reason about/test, and immune to GitHub ever
  // reshaping review URLs. Falls back to reviewUrl for older/synthetic
  // contexts that don't carry a numeric review id.
  if (context.reviewId !== null && context.reviewId !== undefined) {
    const repo = context.repoFullName ?? "unknown";
    const pr = context.prNumber ?? "unknown";
    return `github_pr_review_id:${repo}:${pr}:${context.reviewId}`;
  }
  if (context.reviewUrl) return `github_pr_review:${context.reviewUrl}`;
  if (context.eventUrl) return `github_event:${context.eventUrl}`;
  if (deliveryId) return `github_delivery:${deliveryId}`;
  return null;
}

function buildPrAuthorWakeIdempotencyKey(
  issueId: string,
  context: ResolvedEventContext,
  deliveryId: string | null,
): string {
  const repo = context.repoFullName ?? "unknown";
  const pr = context.prNumber ?? "unknown";
  const externalKey = buildPrFeedbackExternalKey(context, deliveryId);
  const suffix = externalKey ?? context.wakeReason;
  return `pr_review_author:${issueId}:${repo}:${pr}:${context.wakeReason}:${suffix}`;
}

function readReturnAssigneeAgentId(executionState: unknown): string | null {
  if (!executionState || typeof executionState !== "object") return null;
  const state = executionState as Record<string, unknown>;
  const returnAssignee = state.returnAssignee;
  if (!returnAssignee || typeof returnAssignee !== "object") return null;
  const principal = returnAssignee as Record<string, unknown>;
  return principal.type === "agent" && typeof principal.agentId === "string" ? principal.agentId : null;
}

function markExecutionStateChangesRequested(executionState: unknown): Record<string, unknown> | null {
  if (!executionState || typeof executionState !== "object") return null;
  const state = executionState as Record<string, unknown>;
  if (state.status !== "pending" && state.status !== "changes_requested") return null;
  return {
    ...state,
    status: "changes_requested",
    reviewRequest: null,
    lastDecisionOutcome: "changes_requested",
  };
}

function fencedText(value: string): string {
  const longestBacktickRun = Math.max(2, ...Array.from(value.matchAll(/`+/g), (match) => match[0].length));
  const fence = "`".repeat(longestBacktickRun + 1);
  return [fence + "text", value, fence].join("\n");
}

// BLO-19067: the heading and the directive under it are the highest-salience
// text in the wake this comment produces, so they must agree with the review's
// actual state. They used to be hardcoded to the changes-requested case while
// the `- State:` line two rows down rendered the truth, so an APPROVED review
// arrived titled "## Changes Requested" and told the author to "push a
// follow-up implementation pass". An author that trusts the heading pushes a
// no-op commit, which invalidates the approval it just earned and restarts CI
// (a 2.2h suite on Network-Operator-Portal) — a loop costing hours per lap.
//
// A missing/unknown state keeps the changes-requested wording: those arrive via
// the body-text heuristic on an `issue_comment` review (no formal state), which
// only classifies as actionable when the body carries findings.
function prReviewFeedbackHeadline(reviewState: string | null): { heading: string; directive: string } {
  switch (reviewState?.trim().toLowerCase().replace(/-/g, "_")) {
    case "approved":
      return {
        heading: "## Review Approved",
        // Deliberately not a flat "no changes required": a review can APPROVE
        // and still leave notes that trip the actionable-body heuristic. This
        // wording is correct in both cases and forbids the no-op push either way.
        directive:
          "The review approved this PR — no implementation pass is required by the review state. "
          + "Act on the notes below only if they identify a real defect; do not push a no-op or invented "
          + "commit, since any new push invalidates this approval and restarts CI. "
          + "Otherwise proceed to merge once required checks pass.",
      };
    case "commented":
      return {
        heading: "## Review Comments",
        directive:
          "A reviewer left comments without approving or requesting changes. Read them and address the "
          + "ones that are correct with a follow-up commit; reply on the PR with rationale where they are "
          + "wrong or out of scope. Do not push a commit just to acknowledge them.",
      };
    default:
      return {
        heading: "## Changes Requested",
        directive: "GitHub review feedback requires another implementation pass.",
      };
  }
}

function buildPrReviewFeedbackComment(context: ResolvedEventContext): string {
  const sourceUrl = context.eventUrl ?? context.reviewUrl ?? context.commentUrl ?? context.prUrl;
  const reviewer = prFeedbackAuthorLogin(context);
  const body = prFeedbackBody(context);
  const { heading, directive } = prReviewFeedbackHeadline(context.reviewState ?? null);
  const lines = [
    heading,
    "",
    directive,
    "",
    ...(context.repoFullName && context.prNumber !== null
      ? [`- PR: ${context.repoFullName}#${context.prNumber}`]
      : []),
    ...(sourceUrl ? [`- Source: ${sourceUrl}`] : []),
    ...(reviewer ? [`- Reviewer: ${reviewer}`] : []),
    ...(context.reviewState ? [`- State: ${context.reviewState}`] : []),
    // BLO-19497 AC: record the reviewed head SHA so a reader can tell a
    // stale review (against an older push) from a current one.
    ...(context.headSha ? [`- Reviewed head SHA: \`${context.headSha}\``] : []),
  ];
  if (body) {
    lines.push("", "Review body:", "", fencedText(body));
  }
  return lines.join("\n");
}

type MatchedGithubIssue = {
  id: string;
  companyId: string;
  identifier: string | null;
  assigneeAgentId: string | null;
  status: string;
  executionState: Record<string, unknown> | null;
  // BLO-19497: needed to detect a monitor left `triggered` with no scheduled
  // re-check -- the "assignee has no live wake path" signal AC #5 escalates
  // on. See isIssueMonitorTriggered.
  monitorNextCheckAt: Date | null;
  monitorLastTriggeredAt: Date | null;
  monitorAttemptCount: number;
};

async function hasExistingWakeWithIdempotencyKey(
  db: Db,
  agentId: string,
  idempotencyKey: string,
): Promise<boolean> {
  const existing = await db
    .select({ id: agentWakeupRequests.id })
    .from(agentWakeupRequests)
    .where(and(eq(agentWakeupRequests.agentId, agentId), eq(agentWakeupRequests.idempotencyKey, idempotencyKey)))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  return Boolean(existing);
}

// BLO-19497: writes the github_pr_review_feedback comment for EVERY distinct
// actionable review, independent of the issue's current status. Before this
// fix the whole function -- comment write included -- short-circuited unless
// `issue.status === "in_review"`. Review #1 flips status to `in_progress` as
// part of its own reopen (below), so review #2+ on the same PR always found
// `status !== "in_review"` and produced ZERO comment, forever, regardless of
// how many more (distinct head_sha, review_id) reviews landed. The comment
// write must not depend on a status transition that its own predecessor
// already consumed.
//
// The reopen/reassign-to-author behavior (flipping `in_review` -> `in_progress`
// and handing the issue back to the assignee) is still status-gated -- that
// part legitimately only applies once, when the issue is parked in `in_review`
// waiting on this review's outcome. If the issue already moved on (author is
// back in_progress, or it's blocked/todo/etc.), the comment is still the full
// notification; there is nothing to "reopen".
async function reopenInReviewIssueForActionablePrFeedback(
  db: Db,
  issue: MatchedGithubIssue,
  context: ResolvedEventContext,
  deliveryId: string | null,
): Promise<{ reopened: boolean; commentId: string | null; commentInserted: boolean; assigneeAgentId: string | null }> {
  const returnAssigneeAgentId = readReturnAssigneeAgentId(issue.executionState);
  const effectiveAssigneeAgentId = returnAssigneeAgentId ?? issue.assigneeAgentId;

  const externalKey = buildPrFeedbackExternalKey(context, deliveryId);
  const now = new Date();
  const result = await db.transaction(async (tx) => {
    // Review finding (PR #1125, discovered while fixing the escalation
    // comment's own read-then-insert below): this was a SELECT-by-externalKey
    // then INSERT-if-none-found -- the same check-then-write race. Two
    // concurrent redeliveries of the same review can both observe "no
    // existing feedback comment" before either commits, posting the same
    // review's feedback twice -- and each racer's insert mints its own row
    // id, so `commentId` (which escalateUnseenBlockingReviewFeedback keys its
    // own dedup on) is no longer stable across the race either. Set
    // idempotencyKey on the insert so it rides the partial unique index
    // (issue_comments_issue_system_idempotency_idx) and use
    // ON CONFLICT DO NOTHING + a follow-up read to resolve to whichever row
    // actually won, mirroring the BLO-19037 dependabot-receipt pattern.
    let commentInserted = false;
    let commentId: string | null = null;
    if (externalKey) {
      const insertedRow = await tx
        .insert(issueComments)
        .values({
          companyId: issue.companyId,
          issueId: issue.id,
          authorType: "system",
          idempotencyKey: externalKey,
          body: buildPrReviewFeedbackComment(context),
          metadata: {
            kind: "github_pr_review_feedback",
            source: "github",
            externalKey,
            repoFullName: context.repoFullName,
            prNumber: context.prNumber,
            deliveryId,
          } as never,
        })
        .onConflictDoNothing()
        .returning({ id: issueComments.id })
        .then((rows) => rows[0] ?? null);

      if (insertedRow) {
        commentInserted = true;
        commentId = insertedRow.id;
      } else {
        // Lost the race (or this is a genuine redelivery): find the row that
        // won, via the idempotencyKey the unique index enforces on. Also
        // check the legacy metadata-only lookup for feedback comments
        // written before this dedup existed (no idempotencyKey set).
        commentId = await tx
          .select({ id: issueComments.id })
          .from(issueComments)
          .where(and(
            eq(issueComments.issueId, issue.id),
            or(
              eq(issueComments.idempotencyKey, externalKey),
              and(
                isNull(issueComments.idempotencyKey),
                sql`${issueComments.metadata}->>'kind' = 'github_pr_review_feedback'`,
                sql`${issueComments.metadata}->>'externalKey' = ${externalKey}`,
              ),
            ),
          ))
          .limit(1)
          .then((rows) => rows[0]?.id ?? null);
      }
    } else {
      commentInserted = true;
      commentId = await tx
        .insert(issueComments)
        .values({
          companyId: issue.companyId,
          issueId: issue.id,
          authorType: "system",
          body: buildPrReviewFeedbackComment(context),
          metadata: {
            kind: "github_pr_review_feedback",
            source: "github",
            externalKey: null,
            repoFullName: context.repoFullName,
            prNumber: context.prNumber,
            deliveryId,
          } as never,
        })
        .returning({ id: issueComments.id })
        .then((rows): string | null => rows[0]?.id ?? null);
    }

    let reopened = false;
    if (issue.status === "in_review" && effectiveAssigneeAgentId) {
      const executionState = markExecutionStateChangesRequested(issue.executionState);
      const patch: Partial<typeof issues.$inferInsert> = {
        status: "in_progress",
        assigneeAgentId: effectiveAssigneeAgentId,
        assigneeUserId: null,
        checkoutRunId: null,
        executionRunId: null,
        executionAgentNameKey: null,
        executionLockedAt: null,
        updatedAt: now,
      };
      if (executionState) {
        patch.executionState = executionState;
      }

      const updated = await tx
        .update(issues)
        .set(patch)
        .where(and(eq(issues.id, issue.id), eq(issues.status, "in_review")))
        .returning({ id: issues.id })
        .then((rows) => rows[0] ?? null);

      reopened = Boolean(updated);
    }

    return { reopened, commentId, commentInserted, assigneeAgentId: effectiveAssigneeAgentId };
  });

  return result;
}

// A formal "Changes Requested" review state is the blocking signal AC #5
// escalates on -- distinct from hasActionablePrReviewFeedback's broader body
// heuristics (which also catch findings embedded in an approved/commented
// review). Escalation is specifically for the formal blocking state, since
// that's the shape of the incident this issue describes (a Critical finding
// under a Changes Requested review).
function isBlockingReviewState(reviewState: string | null | undefined): boolean {
  const normalized = reviewState?.trim().toLowerCase().replace(/-/g, "_");
  return normalized === "changes_requested";
}

// Mirrors the issue-column-only branch of
// issue-execution-policy.ts's derivePersistedMonitorState: a monitor with no
// scheduled nextCheckAt but a prior trigger/attempt is `triggered` -- terminal,
// nothing re-arms it but the assignee (see BLO-19497 body). The webhook route
// doesn't load executionPolicy.monitor (the full derivation also needs the
// policy row, which isn't worth adding to this hot path), but the raw issue
// columns plus the already-loaded executionState.monitor.status are
// sufficient to detect this exact wedge, which is the one the incident and
// AC #5 are both about.
//
// Review finding (PR #1125, pullrequestreview-4888198804 / -4891307841):
// the raw columns alone treat ANY row with a historical
// monitorLastTriggeredAt/monitorAttemptCount as currently triggered, so a
// monitor that was explicitly cleared (cancelled, superseded, or resolved
// through the normal `cleared` transition -- see derivePersistedMonitorState)
// still reads as triggered here and can spuriously escalate a blocking
// review to a manager the assignee never needed. `cleared` in
// executionState.monitor is authoritative and must take precedence over the
// historical columns, exactly as derivePersistedMonitorState's own
// `fromState?.status === "cleared"` branch does before its `triggered`
// branch.
function isIssueMonitorTriggered(issue: {
  monitorNextCheckAt: Date | null;
  monitorLastTriggeredAt: Date | null;
  monitorAttemptCount: number;
  executionState?: Record<string, unknown> | null;
}): boolean {
  if (issue.monitorNextCheckAt) return false;
  const monitor = issue.executionState?.monitor as Record<string, unknown> | null | undefined;
  if (monitor?.status === "cleared") return false;
  return Boolean(issue.monitorLastTriggeredAt) || issue.monitorAttemptCount > 0;
}

// BLO-19497 AC #5: when a blocking review lands while the assignee's monitor
// is triggered/nextCheckAt-null (no live wake path), escalate to the
// assignee's manager instead of letting the finding sit unseen. Per CEO
// disposition on the issue thread: escalate to the assignee's manager via
// orgChainHealth.fullChain -- the first `running` ancestor, walking up. Not
// the board -- a missed review comment is an engineering-loop failure, not a
// governance decision.
async function escalateUnseenBlockingReviewFeedback(
  db: Db,
  heartbeat: ReturnType<typeof heartbeatService>,
  input: {
    issue: MatchedGithubIssue;
    assigneeAgentId: string;
    commentId: string | null;
    context: ResolvedEventContext;
    deliveryId: string | null;
  },
): Promise<{ escalated: boolean; managerAgentId: string | null }> {
  const companyAgentRows: AgentEligibilityAgent[] = await db
    .select({
      id: agents.id,
      companyId: agents.companyId,
      name: agents.name,
      status: agents.status,
      reportsTo: agents.reportsTo,
    })
    .from(agents)
    .where(eq(agents.companyId, input.issue.companyId));

  const assignee = companyAgentRows.find((agent) => agent.id === input.assigneeAgentId) ?? null;
  if (!assignee) return { escalated: false, managerAgentId: null };

  const manager = getAgentOrgChainHealth({ agent: assignee, agents: companyAgentRows })
    .fullChain
    .find((entry) => entry.relation === "ancestor" && entry.status === "running");
  if (!manager) return { escalated: false, managerAgentId: null };

  const dedupeToken =
    input.commentId ?? input.context.reviewUrl ?? input.context.eventUrl ?? input.deliveryId ?? "unknown";
  const idempotencyKey = `unseen_blocking_review_escalation:${input.issue.id}:${dedupeToken}`;
  if (await hasExistingWakeWithIdempotencyKey(db, manager.id, idempotencyKey)) {
    return { escalated: false, managerAgentId: manager.id };
  }

  // Review finding (PR #1125): a prior read-then-insert (SELECT for an
  // existing escalation comment by metadata.externalKey, then INSERT if none
  // was found) is a check-then-write race across paperclip-api's replicas --
  // two concurrent redeliveries of the same review event can both observe "no
  // existing comment" before either writes, double-posting the escalation.
  // Set idempotencyKey on the insert so it rides the already-deployed partial
  // unique index (issue_comments_issue_system_idempotency_idx on
  // issueId+idempotencyKey, scoped to system comments) and use
  // ON CONFLICT DO NOTHING to make the key authoritative in the database
  // rather than in application logic. No legacy metadata-only rows exist for
  // this comment kind (github_pr_review_feedback_escalation is new in this
  // PR), so unlike reopenInReviewIssueForActionablePrFeedback's dependabot
  // receipt there is no pre-idempotencyKey data to fall back to.
  const prLine =
    input.context.repoFullName && input.context.prNumber !== null
      ? [`- PR: ${input.context.repoFullName}#${input.context.prNumber}`]
      : [];
  await db
    .insert(issueComments)
    .values({
      companyId: input.issue.companyId,
      issueId: input.issue.id,
      authorType: "system",
      idempotencyKey,
      body: [
        "## Blocking review feedback escalated",
        "",
        `${assignee.name}'s monitor is \`triggered\` with no scheduled re-check -- no live wake path -- so this ` +
          "Changes Requested review is being escalated to its manager instead of left unseen.",
        "",
        `- Assignee: ${assignee.name}`,
        `- Escalated to: ${manager.name}`,
        ...prLine,
        ...(input.context.headSha ? [`- Reviewed head SHA: \`${input.context.headSha}\``] : []),
      ].join("\n"),
      metadata: {
        kind: "github_pr_review_feedback_escalation",
        source: "github",
        externalKey: idempotencyKey,
        escalatedToAgentId: manager.id,
        escalatedFromAgentId: assignee.id,
      } as never,
    })
    .onConflictDoNothing();

  await heartbeat.wakeup(manager.id, {
    source: "automation",
    triggerDetail: "system",
    reason: "unseen_blocking_review_feedback",
    idempotencyKey,
    payload: {
      issueId: input.issue.id,
      sourceAssigneeAgentId: assignee.id,
      prNumber: input.context.prNumber,
      repoFullName: input.context.repoFullName,
      headSha: input.context.headSha,
    },
    contextSnapshot: {
      issueId: input.issue.id,
      taskId: input.issue.id,
      wakeReason: "unseen_blocking_review_feedback",
      wakeSource: "automation",
      wakeTriggerDetail: "system",
      sourceAssigneeAgentId: assignee.id,
    },
  });

  return { escalated: true, managerAgentId: manager.id };
}

const IDEMPOTENT_REVIEWER_WAKE_STATUSES = [
  "queued",
  "claimed",
  "running",
  "scheduled",
  "deferred_issue_execution",
  "coalesced",
  // `completed` is deliberately EXCLUDED. For PR-review events that refresh
  // current-head expectations, a COMPLETED reviewer wake for an earlier head
  // must not block a future event: the reviewer reviews the first head once and
  // never re-reviews any later head, so `review/ally-complete` stays pending on
  // a stale head forever (observed 2026-07-11: a batch of PRs whose authors
  // pushed fixups after the first review sat permanently un-re-reviewed). This
  // is the same failure mode already called out below for
  // `dispatch_failed_exhausted` -- a fresh webhook event deserves its own
  // attempt. Rapid-push coalescing is preserved by taskKey-scoped coalescing in
  // enqueueWakeup.
  // BLO-14395: a wake that hit an unexpected dispatch failure is durably
  // tracked under these statuses (see wakeupWithDispatchRetry /
  // reconcileFailedWakeDispatches in heartbeat.ts). `dispatch_failed` defers
  // to the pending in-flight retry (reconciliation will pick it up within
  // 15m) and `dispatch_superseded` means a retry already resolved to a
  // business-rule outcome -- both are "already handled, don't re-dispatch".
  //
  // `dispatch_failed_exhausted` is deliberately EXCLUDED: including it here
  // would let one exhausted retry chain permanently block every future
  // same-reason event on that PR, since reconciliation never re-arms
  // eligibility for new events once a row is exhausted. A fresh webhook event
  // deserves its own attempt; the taskKey-scoped coalescing in enqueueWakeup
  // already prevents any real duplicate execution if the exhausted retry chain
  // and the fresh attempt ever raced.
  "dispatch_failed",
  // BLO-25726: `dispatch_retrying` is the same "pending in-flight retry" state
  // as `dispatch_failed` -- it is what a row is set to for the duration of one
  // reconciler re-dispatch. Omitting it would silently narrow this deferral:
  // before that status existed, a row being actively re-dispatched still read
  // as `dispatch_failed` and deferred here, so leaving it out would make a
  // webhook event arriving mid-dispatch enqueue a second wake. Its claim is
  // lease-bounded, so a crashed holder defers new events for at most that
  // lease -- the same bounded wait this list already accepts above.
  "dispatch_retrying",
  "dispatch_recovered",
  "dispatch_superseded",
];

// Terminal outcomes that mean "this exact request was already consumed or
// deliberately retired". They dedup ONLY for request-scoped keys, where the key
// cannot recur except as a GitHub redelivery of the same event (BLO-18953).
//
// Without this, replaying one `x-github-delivery` after its wake finished
// enqueued the work a second time — the `completed` exclusion above was written
// for stable PR+reason keys and silently defeated delivery scoping. Worse for
// `cancelled`: pull_request.converted_to_draft retires pending reviewer runs via
// cancelPendingRunsForTask, so a late replay of the earlier `ready_for_review`
// delivery resurrected reviewer work on a PR that is a draft again.
//
// `failed` and `dispatch_failed_exhausted` stay excluded on purpose: those never
// produced a review, so a redelivery is a legitimate second chance.
const TERMINAL_REQUEST_SCOPED_IDEMPOTENT_STATUSES = ["completed", "cancelled"];

function idempotentWakeStatuses(scope: WakeIdempotencyScope): string[] {
  return scope === "request"
    ? [...IDEMPOTENT_REVIEWER_WAKE_STATUSES, ...TERMINAL_REQUEST_SCOPED_IDEMPOTENT_STATUSES]
    : IDEMPOTENT_REVIEWER_WAKE_STATUSES;
}

function githubContextMetadata(context: ResolvedEventContext) {
  return {
    ...(context.prTitle ? { githubPrTitle: context.prTitle } : {}),
    ...(context.prUrl ? { githubPrUrl: context.prUrl } : {}),
    ...(context.eventUrl ? { githubEventUrl: context.eventUrl } : {}),
    ...(context.headSha ? { githubHeadSha: context.headSha } : {}),
    ...(context.commentUrl ? { githubCommentUrl: context.commentUrl } : {}),
    ...(context.reviewUrl ? { githubReviewUrl: context.reviewUrl } : {}),
    // BLO-9293: PR author login for the reviewer self-review-skip gate.
    // BLO-20886 AC3: also gates the author wake's "YOUR pull request"
    // possessive and its push instruction — owning-issue routing picks the
    // right ISSUE, but that issue's assignee is not necessarily the PR's
    // author (a `kkroo/blo-*` branch resolves to an agent's issue).
    ...(context.prAuthorLogin ? { githubPrAuthorLogin: context.prAuthorLogin } : {}),
    ...(context.identifiers.length > 0 ? { githubPaperclipIdentifiers: context.identifiers } : {}),
  };
}

export function githubWebhookRoutes(db: Db, config: GithubWebhookConfig) {
  const router = Router();

  router.post("/", async (req, res) => {
    if (!config.webhookSecret) {
      logger.warn("github webhook received but GITHUB_WEBHOOK_SECRET is not configured; refusing");
      res.status(503).json({ error: "github webhook not configured" });
      return;
    }

    const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;
    if (!rawBody) {
      res.status(400).json({ error: "rawBody missing — body parser middleware misconfigured" });
      return;
    }

    const signature = req.header("x-hub-signature-256");
    if (!verifyGithubSignature(rawBody, signature, config.webhookSecret)) {
      logger.warn(
        { signaturePresent: Boolean(signature) },
        "github webhook signature mismatch; rejecting",
      );
      res.status(401).json({ error: "invalid signature" });
      return;
    }

    const eventName = req.header("x-github-event") ?? "";
    const deliveryId = req.header("x-github-delivery") ?? null;
    const payload = (req.body ?? {}) as Record<string, unknown>;
    let reviewGateReceipt: Record<string, unknown> | null = null;
    const respond = (status: number, body: Record<string, unknown>) => {
      if (!res.headersSent) res.status(reviewGateReceipt ? 202 : status).json(reviewGateReceipt ?? body);
    };

    if (config.reviewGateAuthority?.repositories.length) {
      const gateDelivery = await enqueueGithubReviewGateDelivery({
        db,
        eventName,
        deliveryId,
        rawBody,
        payload,
        config: config.reviewGateAuthority,
      });
      if (gateDelivery.matched && !gateDelivery.queued) {
        logger.error(
          {
            event: eventName,
            deliveryId,
            repoFullName: gateDelivery.repoFullName,
            prNumber: gateDelivery.prNumber,
            reason: gateDelivery.reason,
          },
          "github review-gate delivery could not be persisted",
        );
        res.status(gateDelivery.reason === "delivery_id_payload_conflict" ? 409 : 503).json({
          error: "github review-gate delivery was not queued",
          reason: gateDelivery.reason,
        });
        return;
      }
      if (gateDelivery.matched) {
        if (gateDelivery.requiresRevocation && config.reviewGateAuthority.authorityEnabled) {
          const revocation = await activateGithubReviewGateDelivery(db, gateDelivery.deliveryDbId);
          if (!revocation.ok) {
            logger.error(
              {
                event: eventName,
                deliveryId,
                deliveryDbId: gateDelivery.deliveryDbId,
                reason: revocation.reason,
              },
              "github review-gate delivery persisted but pending revocation failed",
            );
            res.status(503).json({
              error: "github review-gate pending revocation failed",
              reason: revocation.reason,
            });
            return;
          }
        }
        logger.info(
          {
            event: eventName,
            deliveryId,
            repoFullName: gateDelivery.repoFullName,
            prNumber: gateDelivery.prNumber,
            deliveryDbId: gateDelivery.deliveryDbId,
            duplicate: gateDelivery.duplicate,
          },
          "github review-gate delivery queued durably",
        );
        reviewGateReceipt = {
          ok: true,
          reviewGateDeliveryQueued: true,
          deliveryId,
          duplicate: gateDelivery.duplicate,
        };
      }
    }

    if (!WAKE_DRIVING_EVENTS.has(eventName)) {
      // Acked but ignored. GitHub retries on non-2xx, and it would
      // hammer us if we 4xx'd every event we don't handle.
      respond(200, { ok: true, ignored: eventName });
      return;
    }

    let context = resolveEventContext(eventName, payload, {
      prReviewerBotLogin: config.prReviewerBotLogin,
      // BLO-18273/BLO-21618: surface both silent drops in this handler — an
      // agent request missing the marker, and a marker-bearing agent request
      // disqualified by an incidental heading match (see the two reasons on
      // `onSuppressedReviewRequest`). Neither produces a wake or an error
      // otherwise; this callback is the only trace either ever leaves.
      onSuppressedReviewRequest: (info) => {
        const message =
          info.reason === "marker_disqualified_by_heading"
            ? "github webhook reviewer wake skipped: @ally request carries a valid start-of-body " +
              "<!-- paperclip:review-request --> marker, but its body also contains a standalone Ally " +
              "consolidated-review heading, so the self-echo guard (BLO-15799/BLO-18865) treated it as the " +
              "reviewer's own output (BLO-21618); no review was requested"
            : "github webhook reviewer wake skipped: @ally request authored by the reviewer bot login carries no " +
              "start-of-body <!-- paperclip:review-request --> marker, so it is indistinguishable from the " +
              "reviewer's own output (BLO-18865/BLO-18273); no review was requested";
        logger.warn(
          {
            event: eventName,
            deliveryId,
            repoFullName: info.repoFullName,
            prNumber: info.prNumber,
            commentId: info.commentId,
            commentAuthorLogin: info.commentAuthorLogin,
            commentUrl: info.commentUrl,
            suppressionReason:
              info.reason === "marker_disqualified_by_heading"
                ? "reviewer_bot_authored_request_disqualified_by_heading"
                : "reviewer_bot_authored_request_missing_marker",
          },
          message,
        );
      },
      // BLO-23059: the paused-notice drop kills two wakes (reviewer counter-review
      // and PR author), so it is the higher-impact silent drop of the two and
      // needs the same structured trace. `info` at this level rather than
      // `warn`: unlike the missing-marker case there is nothing to fix — the
      // suppression is the intended steady state for as long as Code Review
      // stays unlinked, and the CEO recorded that decision on BLO-23059.
      onSuppressedReviewSubmission: (info) => {
        logger.info(
          {
            event: eventName,
            deliveryId,
            repoFullName: info.repoFullName,
            prNumber: info.prNumber,
            reviewAuthorLogin: info.reviewAuthorLogin,
            reviewState: info.reviewState,
            reviewUrl: info.reviewUrl,
            suppressionReason: "claude_code_review_service_notice",
          },
          "github webhook wakes skipped: claude[bot] submitted a formal review whose body is the " +
            "Claude Code Review paused/disabled org-settings notice, not findings (BLO-23059); " +
            "neither the reviewer counter-review wake nor the PR-author wake was enqueued",
        );
      },
    });

    // GitHub's issue_comment payload identifies the PR but does not include
    // `pull_request.head.sha`. Reviewer runs persist the head in their
    // contextSnapshot and the evidence gate compares against that exact value;
    // without this lookup a valid Ally comment review is recorded with no head
    // and can never satisfy the gate. Do this only for actionable review
    // comments, and never infer a SHA from comment prose.
    if (
      context &&
      eventName === "issue_comment" &&
      (context.wakeReason === "github_pr_review_requested" ||
        context.wakeReason === "github_pr_review_feedback") &&
      !context.headSha &&
      typeof context.prNumber === "number" &&
      context.repoFullName
    ) {
      const resolveHeadSha = config.resolvePrReviewHeadSha ?? githubFetchPrHeadSha;
      try {
        const headSha = await resolveHeadSha({
          repoFullName: context.repoFullName,
          prNumber: context.prNumber,
        });
        if (headSha) {
          context = { ...context, headSha };
        } else {
          logger.warn(
            {
              event: eventName,
              deliveryId,
              repoFullName: context.repoFullName,
              prNumber: context.prNumber,
              wakeReason: context.wakeReason,
            },
            "github webhook could not resolve current PR head for review comment; continuing without head context",
          );
        }
      } catch (err) {
        logger.warn(
          {
            err,
            event: eventName,
            deliveryId,
            repoFullName: context.repoFullName,
            prNumber: context.prNumber,
            wakeReason: context.wakeReason,
          },
          "github webhook PR-head lookup failed for review comment; continuing without head context",
        );
      }
    }

    // BLO-21078: fleet-wide visibility into workflow_run conclusions, so a
    // mass-cancellation wave (GitHub cancelling live runners mid-job across
    // unrelated PRs, as opposed to an ordinary per-PR `failure`) is a metric
    // instead of something only noticed by an author reading job conclusions.
    if (eventName === "workflow_run") {
      const workflowRun = payload.workflow_run as Record<string, unknown> | undefined;
      const repository = payload.repository as Record<string, unknown> | undefined;
      const repoFullName = readStringField(repository, "full_name");
      const headBranch = readStringField(workflowRun, "head_branch");
      const runIdValue = workflowRun?.id;
      const runId = typeof runIdValue === "number" ? runIdValue : null;
      const createdAt = Date.parse(readStringField(workflowRun, "created_at") ?? "");
      // Feed the supersession tracker off every action (requested/in_progress/
      // completed), not just `completed` — a superseding run's existence has
      // to be observed before the superseded run's own `completed` delivery
      // arrives, and that superseding run is very often still mid-flight (not
      // yet completed) at that moment.
      recordWorkflowRunSighting(repoFullName, headBranch, runId, createdAt);

      // `context` is only non-null here for a *completed* workflow_run (see
      // the `action !== "completed"` guard in resolveEventContext's
      // workflow_run case) — exactly the terminal event this counter wants
      // once per run.
      if (context) {
        const conclusion = readStringField(workflowRun, "conclusion");
        const updatedAt = Date.parse(readStringField(workflowRun, "updated_at") ?? "");
        const supersession =
          conclusion === "cancelled"
            ? classifyWorkflowRunSupersession(repoFullName, headBranch, runId, updatedAt)
            : "none";
        recordGithubWorkflowRunConclusion(conclusion, supersession);
      }
    }

    // BLO-27608: the review-OUTPUT counter. Every other GitHub review metric is
    // request-side and read healthy right through the ~8.6h fleet-wide review
    // blackout on 2026-08-12 (BLO-27123), because the runs really were enqueued
    // and dispatched — they died at the model call and produced no artifact.
    // This is the only signal that separates "a review came out" from "a run
    // started". Recorded off the signed payload, before and independent of every
    // wake decision below: the reviewer's own review is dropped as a self-echo
    // and a clean comment-shaped review resolves to no context at all, so
    // anything downstream of those would zero exactly the series we need.
    const postedReview = resolvePostedReviewObservation(
      eventName,
      payload,
      config.prReviewerBotLogin,
    );
    if (postedReview) {
      recordGithubReviewPosted({
        repo: postedReview.repoFullName,
        surface: postedReview.surface,
      });
      logger.info(
        {
          event: eventName,
          deliveryId,
          repoFullName: postedReview.repoFullName,
          prNumber: postedReview.prNumber,
          surface: postedReview.surface,
        },
        "github webhook observed a published reviewer review",
      );
    }

    // A consolidated review can arrive as a plain issue comment, which GitHub
    // does not reflect in reviewDecision. Run the opt-in status gate directly
    // from the signed payload, independent of Paperclip issue matching and the
    // author-wake decision. It remains detached so GitHub webhook acknowledgement
    // is never delayed by a GitHub API read/write.
    const commentReviewGateTrigger = resolvePrCommentReviewGateWebhookTrigger(
      eventName,
      payload,
      config.prReviewerBotLogin,
    );
    if (commentReviewGateTrigger) {
      // Build the input once and hand the SAME object to both branches, so the
      // injection seam observes the real argument — including `db`. When the
      // seam was called with the bare trigger, no webhook-level test could
      // assert that production actually supplies the serialization handle.
      const commentReviewGateInput = { ...commentReviewGateTrigger, db };
      const commentReviewGateCheck = config.runPrCommentReviewGateCheck
        ? config.runPrCommentReviewGateCheck(commentReviewGateInput)
        : runPrCommentReviewGateCheck(commentReviewGateInput);
      void commentReviewGateCheck
        .then((result) => {
          // The disabled default must be silent; otherwise every PR webhook in
          // a deployment that has not opted in would emit a warning.
          if (!result.posted && result.reason === "not_configured") return;
          if (!result.posted && result.retirementDeliveries) {
            void Promise.all(result.retirementDeliveries.map((delivery) =>
              enqueueGithubCommitStatusDelivery(db, {
                // Explicitly provenance-less: a retirement is triggered by the
                // webhook, not by an agent run, so there is no company or run
                // to attribute it to. Passing `null` rather than omitting the
                // keys is deliberate — the enqueue normalizes either shape, but
                // the omission read as an oversight to several reviewers and is
                // what the NULL semantics of preserveExistingDelivery rely on.
                companyId: null,
                sourceRunId: null,
                repoFullName: commentReviewGateTrigger.repoFullName,
                sha: delivery.sha,
                context: delivery.context,
                state: delivery.state,
                description: delivery.description,
                targetUrl: delivery.targetUrl,
                prNumber: commentReviewGateTrigger.prNumber,
                prUrl: commentReviewGateTrigger.prUrl,
                forceWrite: true,
              }),
            )).catch((err) => {
              logger.error(
                { err, event: eventName, deliveryId, ...commentReviewGateTrigger },
                "github webhook comment-review retired-context retry enqueue failed",
              );
            });
          }
          logger[result.posted ? "info" : "warn"](
            { deliveryId, event: eventName, ...commentReviewGateTrigger, result },
            "github webhook comment-review gate check completed",
          );
        })
        .catch((err) => {
          logger.warn(
            { err, deliveryId, event: eventName, ...commentReviewGateTrigger },
            "github webhook comment-review gate check failed (non-fatal)",
          );
        });
    }

    // A closed or newly-drafted PR cannot produce useful reviewer work. Retire
    // every queued or scheduled-retry run for its stable task scope so it does
    // not consume the reviewer's single external-lifecycle slot hours later.
    // Running reviews are left alone: they may already be posting a final
    // result, and forcibly deleting their Job would be more disruptive than
    // letting them finish.
    const reviewerRunsCancelled = await (async () => {
      const reviewerAgentIds = configuredPrReviewerAgentIds(config);
      const reviewerWorkRetired =
        context?.wakeReason === "github_pr_closed" ||
        context?.wakeReason === "github_pr_converted_to_draft";
      if (
        reviewerAgentIds.length === 0 ||
        !reviewerWorkRetired ||
        !context ||
        typeof context.prNumber !== "number"
      ) {
        return 0;
      }

      const reviewerContext = context;
      const reviewerPrNumber = reviewerContext.prNumber;
      if (typeof reviewerPrNumber !== "number") return 0;
      const reviewerTaskKey = buildPrReviewerTaskKey({
        ...reviewerContext,
        prNumber: reviewerPrNumber,
      });
      const heartbeat = heartbeatService(db, {
        pluginWorkerManager: config.pluginWorkerManager,
        ...config.heartbeatOptions,
      });
      const reason = `Cancelled because GitHub PR ${reviewerContext.repoFullName ?? "unknown"}#${reviewerPrNumber} ${
        reviewerContext.wakeReason === "github_pr_closed" ? "closed" : "became a draft"
      } before review dispatch`;
      let cancelled = 0;
      for (const reviewerAgentId of reviewerAgentIds) {
        cancelled += await heartbeat.cancelPendingRunsForTask(
          reviewerAgentId,
          reviewerTaskKey,
          reason,
        );
      }
      logger.info(
        {
          deliveryId,
          repoFullName: reviewerContext.repoFullName,
          prNumber: reviewerPrNumber,
          wakeReason: reviewerContext.wakeReason,
          reviewerTaskKey,
          reviewerCount: reviewerAgentIds.length,
          cancelled,
        },
        "github webhook retired pending reviewer runs for PR lifecycle transition",
      );
      return cancelled;
    })();

    // PR-review wake fires independently of the identifier-matching
    // issue-assignee wake below: it targets a dedicated reviewer agent so
    // PRs without a paperclip identifier in the branch/title/body still
    // get reviewed. We fire it once per delivery, only for the events
    // that should drive a review:
    //   - pull_request.opened          — new PR ready for first review
    //   - pull_request.reopened        — explicit retry / renewed review signal
    //   - pull_request.ready_for_review — draft promoted to ready
    //   - pull_request.synchronize     — author pushed a fixup after a review;
    //       reviewer runs are coalesced by the stable PR-scoped taskKey under
    //       the same per-agent lock used by close retirement, and duplicate
    //       wake requests are skipped by the PR+reason idempotency precheck, so
    //       rapid pushes don't fan out per push.
    //   - issue_comment.created with @ally — explicit operator re-review request.
    //       A Paperclip agent gets the same path by prefixing the comment with
    //       `<!-- paperclip:review-request -->` (BLO-18865); without that marker
    //       its comment is indistinguishable from the reviewer bot's own output
    //       by author login and is dropped.
    //   - pull_request_review.submitted — request a counter-review pass; the
    //       reviewer's OWN posted review is filtered as a self-echo (BLO-15799,
    //       see isReviewerSelfEchoReview).
    // (pull_request.closed/converted_to_draft retire pending work above;
    //  check_run/workflow_run are handled by the issue-assignee CI-completion
    //  path.)
    const reviewerWakeFired = await (async () => {
      const reviewerAgentIds = configuredPrReviewerAgentIds(config);
      if (reviewerAgentIds.length === 0) {
        if (shouldFirePrReviewerWake(context)) {
          logger.warn(
            {
              event: eventName,
              deliveryId,
              wakeReason: context.wakeReason,
              prNumber: context.prNumber,
              repoFullName: context.repoFullName,
            },
            "github webhook reviewer wake skipped: reviewer agent not configured",
          );
        }
        return false;
      }
      if (!shouldFirePrReviewerWake(context)) return false;
      // BLO-15799: don't enqueue a reviewer wake for the reviewer's own posted
      // review — that's a self-echo, not new review work (see
      // isReviewerSelfEchoReview). One log line so the suppression is
      // observable in production.
      if (isReviewerSelfEchoReview(context, config.prReviewerBotLogin)) {
        logger.info(
          {
            deliveryId,
            repoFullName: context.repoFullName,
            prNumber: context.prNumber,
            reviewAuthorLogin: context.reviewAuthorLogin,
          },
          "github webhook reviewer wake skipped: self-echo of the reviewer's own posted review",
        );
        return false;
      }
      try {
        const outcome = await attemptPrReviewerWake({
          db,
          config,
          context,
          eventName,
          deliveryId,
          reviewerAgentIds,
        });
        return outcome === "queued";
      } catch (err) {
        if (err instanceof PrReviewerUnavailableError) {
          let recorded = false;
          try {
            recorded = await persistContendedPrReviewerWake({
              db,
              context,
              eventName,
              deliveryId,
              reviewerAgentIds,
              taskKey: buildPrReviewerWakeupOptions(context, eventName, deliveryId).payload.taskKey,
              cause: "unavailable",
            });
          } catch (persistErr) {
            logger.error(
              {
                err: persistErr,
                agentIds: reviewerAgentIds,
                event: eventName,
                prNumber: context.prNumber,
                repoFullName: context.repoFullName,
              },
              "github webhook reviewer availability retry persistence failed",
            );
          }
          if (recorded) return false;
          logger.error(
            {
              agentIds: reviewerAgentIds,
              event: eventName,
              prNumber: context.prNumber,
              repoFullName: context.repoFullName,
            },
            "github webhook reviewer was temporarily unavailable and no durable retry could be recorded",
          );
          throw new HttpError(503, "PR reviewer is temporarily unavailable", {
            code: "pr_reviewer_unavailable",
          });
        }
        if (err instanceof PrReviewerTaskLockTimeoutError) {
          // BLO-21995: a concurrent delivery for this same PR held the scope for
          // the whole timeout. Nothing reached heartbeat, so there is no partial
          // state — the wake just needs to happen later. GitHub never redelivers
          // on its own, so dropping it here loses it permanently.
          const recorded = await persistContendedPrReviewerWake({
            db,
            context,
            eventName,
            deliveryId,
            reviewerAgentIds,
            taskKey: buildPrReviewerWakeupOptions(context, eventName, deliveryId).payload.taskKey,
          });
          if (recorded) {
            // Durable: the reconciler owns it from here. Answer 200 so GitHub
            // does not also queue this delivery for manual redelivery, which
            // would be a second replay racing our own.
            //
            // Not `true`: the response must not claim a run that only a later
            // reconciler pass will enqueue.
            return false;
          }
          // Nothing was recorded, so there is no worker that will ever retry
          // this. Fall back to the pre-BLO-21995 behaviour and fail the
          // delivery, which at least leaves it manually redeliverable in
          // GitHub's UI rather than silently lost behind a 200.
          logger.warn(
            {
              agentIds: reviewerAgentIds,
              event: eventName,
              prNumber: context.prNumber,
              repoFullName: context.repoFullName,
            },
            "github webhook reviewer lock timed out and no durable retry was recorded; "
              + "failing the delivery so it stays manually redeliverable. NOTE: this throw "
              + "escapes the whole route handler, so the Dependabot remediation wake and the "
              + "paperclip-identifier issue-assignee path are skipped for this delivery too — "
              + "neither contends for this lock. That collateral loss is accepted only because "
              + "this branch is the rare fallback after persistContendedPrReviewerWake failed.",
          );
          // Count the loss. Nothing else records it: the `received` counter is
          // incremented INSIDE the lock, so a lock-ACQUISITION timeout moves
          // neither `received` nor `queued` and this permanent drop is
          // invisible on the funnel it is supposed to appear in.
          recordGithubReviewRequestSuppressed({
            reason: context.wakeReason,
            cause: GITHUB_SUPPRESSION_CAUSE_REVIEWER_LOCK_CONTENDED,
          });
          throw new PrReviewerTaskLockContentionError();
        }
        logger.error(
          {
            err,
            agentIds: reviewerAgentIds,
            event: eventName,
            prNumber: context?.prNumber,
            repoFullName: context?.repoFullName,
          },
          "github webhook reviewer wake failed",
        );
        return false;
      }
    })();

    // Dependabot remediation wake. Like the reviewer wake, this targets a
    // dedicated agent and fires independently of paperclip identifiers (a
    // security advisory never references one). One wake per alert: `created`
    // is keyed on the alert alone, while `reintroduced`/`reopened` are scoped
    // to the delivery so a recurring regression can wake the agent again. The
    // wake always creates or reuses a scoped Paperclip issue first (BLO-16319)
    // so the run has a real PAPERCLIP_TASK_ID instead of an empty task.
    const dependabotWakeFired = await (async () => {
      if (eventName !== "dependabot_alert" || !config.dependabotAgentId) return false;
      const action = payload.action as string | undefined;
      if (!isActionableDependabotAlertAction(action) && !isTerminalDependabotAlertAction(action)) return false;

      const repository = payload.repository as Record<string, unknown> | undefined;
      const alertRepoFullName = (repository?.full_name as string | undefined) ?? null;

      const alert = resolveDependabotAlertContext(payload);
      if (!alert) {
        logger.error(
          { event: eventName, deliveryId, action, repoFullName: alertRepoFullName },
          "github webhook dependabot_alert payload missing/malformed alert fields",
        );
        const companyId = await getAgentCompanyId(db, config.dependabotAgentId);
        if (companyId) {
          await recordDependabotWebhookDiagnostic(db, {
            companyId,
            assigneeAgentId: config.dependabotAgentId,
            event: eventName,
            deliveryId,
            action,
            repoFullName: alertRepoFullName,
            reason: "The `alert` object was missing or its `number` field wasn't numeric.",
          });
        }
        return false;
      }

      if (!alertRepoFullName) {
        logger.error(
          { event: eventName, deliveryId, action, alertNumber: alert.alertNumber },
          "github webhook dependabot_alert payload missing repository.full_name",
        );
        const companyId = await getAgentCompanyId(db, config.dependabotAgentId);
        if (companyId) {
          await recordDependabotWebhookDiagnostic(db, {
            companyId,
            assigneeAgentId: config.dependabotAgentId,
            event: eventName,
            deliveryId,
            action,
            repoFullName: null,
            alertNumber: alert.alertNumber,
            reason: "The payload had no `repository.full_name`, so the alert can't be scoped to a repo.",
          });
        }
        return false;
      }

      const taskKey = `github-dependabot:${alertRepoFullName}#${alert.alertNumber}`;
      if (isTerminalDependabotAlertAction(alert.action)) {
        const companyId = await getAgentCompanyId(db, config.dependabotAgentId);
        if (!companyId) return false;
        await recordDependabotTerminalReceipt(db, {
          companyId,
          assigneeAgentId: config.dependabotAgentId,
          originId: taskKey,
          repoFullName: alertRepoFullName,
          alert,
          deliveryId,
        });
        return false;
      }

      const floor =
        DEPENDABOT_SEVERITY_RANK[config.dependabotMinSeverity ?? "high"] ?? DEPENDABOT_SEVERITY_RANK.high;
      if ((DEPENDABOT_SEVERITY_RANK[alert.severity] ?? -1) < floor) return false;

      const idempotencyKey =
        alert.action === "created"
          ? `${taskKey}:created`
          : `${taskKey}:${alert.action}:${deliveryId ?? "no-delivery"}`;
      try {
        // enqueueWakeup stores the idempotency key but does not enforce it, so
        // we pre-check like the run-liveness continuation path does. A prior
        // non-terminal wake for this exact alert+action means remediation is
        // already in flight — skip rather than spawn a duplicate run. (GitHub
        // 200-acks mean it won't retry, but manual replays or a re-scan can
        // redeliver the same alert.)
        const existingWake = await db
          .select({ id: agentWakeupRequests.id })
          .from(agentWakeupRequests)
          .where(
            and(
              eq(agentWakeupRequests.agentId, config.dependabotAgentId),
              eq(agentWakeupRequests.idempotencyKey, idempotencyKey),
              inArray(agentWakeupRequests.status, [
                "queued",
                "running",
                "deferred_issue_execution",
                "coalesced",
                "completed",
              ]),
            ),
          )
          .limit(1)
          .then((rows) => rows[0] ?? null);
        if (existingWake) return false;

        const companyId = await getAgentCompanyId(db, config.dependabotAgentId);
        if (!companyId) {
          logger.error(
            { agentId: config.dependabotAgentId, event: eventName, alertNumber: alert.alertNumber, repoFullName: alertRepoFullName },
            "github webhook dependabot wake failed: remediation agent has no company",
          );
          return false;
        }

        const issue = await resolveDependabotAlertIssue(db, {
          companyId,
          assigneeAgentId: config.dependabotAgentId,
          originId: taskKey,
          repoFullName: alertRepoFullName,
          alert,
          deliveryId,
        });

        // BLO-28981: the alert's newest row was cancelled, which this intake
        // reads as a standing decision to stop re-adjudicating it. The re-fire
        // is already recorded on that row; waking an agent here is exactly the
        // cost cancelling was meant to stop.
        if (issue.suppressed) {
          logger.info(
            {
              event: eventName,
              deliveryId,
              taskKey,
              issueId: issue.id,
              alertNumber: alert.alertNumber,
              repoFullName: alertRepoFullName,
            },
            "github webhook dependabot re-fire suppressed: alert issue is cancelled",
          );
          return false;
        }

        const heartbeat = heartbeatService(db, {
          pluginWorkerManager: config.pluginWorkerManager,
          ...config.heartbeatOptions,
        });
        await heartbeat.wakeup(config.dependabotAgentId, {
          source: "automation",
          triggerDetail: "system",
          reason: "github_dependabot_alert",
          payload: {
            taskKey,
            source: "github",
            event: eventName,
            deliveryId,
            repoFullName: alertRepoFullName,
            dependabotAlert: alert,
            issueId: issue.id,
          },
          contextSnapshot: {
            taskKey,
            issueId: issue.id,
            // BLO-28981: true when this landed on a previously-adjudicated row
            // that was reopened rather than a fresh one. The woken run can see
            // it is handling a repeat without first reading the comment thread.
            dependabotReopened: issue.reopened,
            wakeReason: "github_dependabot_alert",
            wakeSource: "automation",
            wakeTriggerDetail: "system",
            githubEvent: eventName,
            githubDeliveryId: deliveryId,
            githubRepoFullName: alertRepoFullName,
            dependabotAlertNumber: alert.alertNumber,
            dependabotAction: alert.action,
            dependabotSeverity: alert.severity,
            dependabotPackage: alert.packageName,
            dependabotEcosystem: alert.ecosystem,
            dependabotManifestPath: alert.manifestPath,
            dependabotGhsaId: alert.ghsaId,
            dependabotCveId: alert.cveId,
            dependabotSummary: alert.summary,
            dependabotVulnerableRange: alert.vulnerableRange,
            dependabotPatchedVersion: alert.patchedVersion,
            dependabotAlertUrl: alert.alertUrl,
          },
          idempotencyKey,
        });
        return true;
      } catch (err) {
        logger.error(
          {
            err,
            agentId: config.dependabotAgentId,
            event: eventName,
            alertNumber: alert.alertNumber,
            repoFullName: alertRepoFullName,
          },
          "github webhook dependabot wake failed",
        );
        return false;
      }
    })();

    if (!context) {
      respond(200, {
        ok: true,
        ignored: "no_paperclip_identifier",
        reviewerWakeFired,
        reviewerRunsCancelled,
        dependabotWakeFired,
      });
      return;
    }

    const pullRequestWorkProductExternalId =
      eventName === "pull_request" &&
      context.prNumber !== null &&
      context.repoFullName
        ? pullRequestExternalId(context.repoFullName, context.prNumber)
        : null;
    const previouslyLinkedPullRequestIssues = pullRequestWorkProductExternalId
      ? await db
        .select({
          id: issues.id,
          companyId: issues.companyId,
          identifier: issues.identifier,
          assigneeAgentId: issues.assigneeAgentId,
          status: issues.status,
          executionState: issues.executionState,
        })
        .from(issueWorkProducts)
        .innerJoin(
          issues,
          and(
            eq(issues.id, issueWorkProducts.issueId),
            eq(issues.companyId, issueWorkProducts.companyId),
          ),
        )
        .where(
          and(
            eq(issueWorkProducts.provider, "github"),
            eq(issueWorkProducts.type, "pull_request"),
            eq(issueWorkProducts.externalId, pullRequestWorkProductExternalId),
            sql`${issueWorkProducts.metadata}->>'source' = ${PULL_REQUEST_WORK_PRODUCT_METADATA_SOURCE}`,
            sql`${issueWorkProducts.sourceTrust}->>'promotedByActorType' = 'system'`,
            sql`${issueWorkProducts.sourceTrust}->>'promotedByActorId' = ${PULL_REQUEST_WORK_PRODUCT_SOURCE_TRUST_ACTOR_ID}`,
          ),
        )
      : [];

    if (context.identifiers.length === 0 && previouslyLinkedPullRequestIssues.length === 0) {
      respond(200, {
        ok: true,
        ignored: "no_paperclip_identifier",
        reviewerWakeFired,
        reviewerRunsCancelled,
        dependabotWakeFired,
      });
      return;
    }

    // Look up paperclip issues by identifier. Identifiers are unique
    // per company, so one parsed identifier may match multiple rows
    // across companies if two companies share a prefix. We drive a
    // wake for every match -- GitHub PRs can legitimately reference
    // identifiers across orgs.
    const matchedIssues = await db
      .select({
        id: issues.id,
        companyId: issues.companyId,
        identifier: issues.identifier,
        assigneeAgentId: issues.assigneeAgentId,
        status: issues.status,
        executionState: issues.executionState,
        monitorNextCheckAt: issues.monitorNextCheckAt,
        monitorLastTriggeredAt: issues.monitorLastTriggeredAt,
        monitorAttemptCount: issues.monitorAttemptCount,
      })
      .from(issues);
    const matched = matchedIssues.filter(
      (row) => row.identifier && context.identifiers.includes(row.identifier),
    );
    const pullRequestWorkProductTargets = [
      ...matched,
      ...previouslyLinkedPullRequestIssues,
    ].filter((row, index, rows) =>
      rows.findIndex((candidate) => candidate.companyId === row.companyId && candidate.id === row.id) === index
    );

    // Merged-PR forward-capture (BLO-9117). When a PR closes as merged, persist
    // the issue↔PR link for every matched issue (including terminal/unassigned
    // ones — a `done` issue's merged PR is exactly the merged-output we measure,
    // so this runs independently of whether a wake fires below). Best-effort:
    // a persist failure must never break the wake path. Keyed on the BLO- ref,
    // never on the PR author (the persisted row has no author column at all).
    if (
      eventName === "pull_request" &&
      context.prMerged === true &&
      context.prNumber !== null &&
      context.repoFullName
    ) {
      try {
        const recordInput: RecordMergedPullRequestInput = {
          repoFullName: context.repoFullName,
          prNumber: context.prNumber,
          headSha: context.headSha ?? null,
          mergedAt: context.prMergedAt ? new Date(context.prMergedAt) : null,
          additions: context.prAdditions ?? null,
          deletions: context.prDeletions ?? null,
          branch: context.prBranch ?? null,
          title: context.prTitle ?? null,
          body: context.prBody ?? null,
          matchedIssues: matched.map((m) => ({ id: m.id, companyId: m.companyId, identifier: m.identifier })),
        };
        const recorded = await recordMergedPullRequest(db, recordInput);
        // authored-LOC needs a pulls/{n}/files fetch — fire-and-forget so the
        // webhook stays inside GitHub's delivery timeout. Lost enrichment is
        // recovered by the reconciler (rows keep loc_enriched_at = null).
        for (const row of recorded) {
          void enrichAuthoredLocForRow(db, row).catch((err) => {
            logger.warn({ err, prNumber: row.prNumber, repoFullName: row.repoFullName }, "authored-LOC enrichment failed (will reconcile)");
          });
        }
      } catch (err) {
        logger.error(
          { err, prNumber: context.prNumber, repoFullName: context.repoFullName },
          "merged-PR forward-capture persist failed",
        );
      }
    }

    // PR work-product upsert (BLO-19566 AC4). Liveness/productivity accounting
    // is blind to PR progress unless the issue carries a first-class
    // `pull_request` work product: the productivity reviewer's own verdict
    // criteria ask for "a non-stale PR/MR link in the source issue's evidence",
    // and nothing was ever writing one. An agent shipping commits to an open PR
    // therefore read as zero progress (BLO-19541 misfired on exactly this).
    //
    // Runs for every PR event and every matched issue, including terminal and
    // unassigned ones -- the row is evidence about the PR, not a wake. Keyed on
    // repo#number so pushes update one row per issue instead of appending.
    // Best-effort: a persist failure must never break the wake path, mirroring
    // the merged-PR forward-capture above.
    let workProductsUpserted = 0;
    if (
      eventName === "pull_request" &&
      context.prNumber !== null &&
      context.repoFullName &&
      pullRequestWorkProductTargets.length > 0
    ) {
      const fields = buildPullRequestWorkProductFields({
        repoFullName: context.repoFullName,
        prNumber: context.prNumber,
        prTitle: context.prTitle ?? null,
        prUrl: context.prUrl ?? null,
        headSha: context.headSha ?? null,
        previousHeadSha: context.prPreviousHeadSha ?? null,
        prBranch: context.prBranch ?? null,
        prDraft: context.prDraft,
        prMerged: context.prMerged,
        prMergedAt: context.prMergedAt ?? null,
        prUpdatedAt: context.prUpdatedAt ?? null,
        action: context.prAction ?? "",
      });
      const workProducts = workProductService(db);
      for (const issue of pullRequestWorkProductTargets) {
        try {
          await workProducts.upsertByExternalId(
            issue.id,
            issue.companyId,
            { provider: "github", type: "pull_request", externalId: fields.externalId },
            {
              title: fields.title,
              url: fields.url,
              status: fields.status,
              metadata: fields.metadata,
              sourceTrust: fields.sourceTrust,
            },
          );
          workProductsUpserted += 1;
        } catch (err) {
          logger.error(
            {
              err,
              issueId: issue.id,
              identifier: issue.identifier,
              prNumber: context.prNumber,
              repoFullName: context.repoFullName,
            },
            "pull_request work product upsert failed",
          );
        }
      }
    }

    // PR→issue back-link (BLO-13353, #973 symptom-1). On PR open/reopen, post a
    // one-time comment linking the PR to its Paperclip issue(s) so a human
    // reading the PR can navigate back. Best-effort and idempotent: a hidden
    // marker on an existing comment suppresses re-posts; any failure (no creds,
    // no public URL, GitHub error) is logged and never breaks the wake path.
    // Mirrors the merged-PR forward-capture block above.
    let backLinked: string[] = [];
    if (
      config.postIssueBackLink !== false &&
      config.publicBaseUrl &&
      eventName === "pull_request" &&
      (context.wakeReason === "github_pr_opened" || context.wakeReason === "github_pr_reopened") &&
      context.prNumber !== null &&
      context.repoFullName &&
      matched.length > 0
    ) {
      try {
        const companyIds = [...new Set(matched.map((m) => m.companyId))];
        const prefixRows = await db
          .select({ id: companies.id, issuePrefix: companies.issuePrefix })
          .from(companies)
          .where(inArray(companies.id, companyIds));
        const prefixByCompany = new Map(prefixRows.map((r) => [r.id, r.issuePrefix ?? ""]));
        const entries = matched
          .filter((m): m is typeof m & { identifier: string } => Boolean(m.identifier))
          .map((m) => ({ identifier: m.identifier, issuePrefix: prefixByCompany.get(m.companyId) ?? "" }));
        if (entries.length > 0) {
          const existing = await githubListIssueCommentBodies({
            repoFullName: context.repoFullName,
            prNumber: context.prNumber,
          });
          // null => no creds / couldn't read: skip the write (never blind-post).
          if (existing !== null && !commentsContainBackLinkMarker(existing)) {
            const posted = await githubPostIssueComment({
              repoFullName: context.repoFullName,
              prNumber: context.prNumber,
              body: buildIssueBackLinkBody(config.publicBaseUrl, entries),
            });
            if (posted) backLinked = entries.map((e) => e.identifier);
          }
        }
      } catch (err) {
        logger.warn(
          { err, prNumber: context.prNumber, repoFullName: context.repoFullName },
          "PR→issue back-link post failed (non-fatal)",
        );
      }
    }

    if (matched.length === 0) {
      respond(200, {
        ok: true,
        ignored: "no_matching_issue",
        identifiers: context.identifiers,
        // BLO-23893: `reviewerWakeFired` is computed for EVERY delivery but
        // used to be reported only on the two `no_paperclip_identifier`
        // exits. That was invisible until the BLO-20886 owning-union fix
        // landed: a PR whose only ref is a lowercase branch (the BLO-21995
        // fixtures) no longer exits at that gate, so it reaches here instead
        // and the field silently vanished from the response. The reviewer
        // wake's outcome is a property of the delivery, not of which exit it
        // happens to take -- report it on every path that has computed it.
        reviewerWakeFired,
        reviewerRunsCancelled,
      });
      return;
    }
    const heartbeat = heartbeatService(db, {
      pluginWorkerManager: config.pluginWorkerManager,
      ...config.heartbeatOptions,
    });
    const wakes: Array<{ issueIdentifier: string | null; agentId: string }> = [];
    const skipped: Array<{ issueIdentifier: string | null; reason: string }> = [];
    const reopened: Array<{ issueIdentifier: string | null; commentId: string | null }> = [];
    const escalated: Array<{
      issueIdentifier: string | null;
      ownerAgentId: string | null;
      ownerType: "agent" | "board";
      cycles: number;
    }> = [];
    let recoveryInstance: ReturnType<typeof recoveryService> | null = null;
    const getRecovery = () =>
      (recoveryInstance ??= recoveryService(db, { enqueueWakeup: heartbeat.wakeup }));
    const actionableReviewFeedback = isActionableReviewFeedbackContext(context);

    // synchronize and converted_to_draft are reviewer-lifecycle signals. The
    // reviewer wake above is PR-scoped for task affinity/coalescing, while
    // synchronize idempotency is delivery-scoped so every push can refresh the
    // current head if a prior review is already running. The author-assignee
    // wake below is deliberately not driven by either event: the author just
    // pushed or drafted the PR, so waking them would be redundant. The author
    // still gets woken by check_run/workflow_run on terminal CI and by
    // review-submitted/@ally feedback, as before.
    const synchronizeReviewerOnly = context.wakeReason === "github_pr_synchronized";
    // BLO-18865: a marker-carrying agent review request deliberately does NOT
    // suppress the author wake, even though the requester is usually the PR
    // author and the wake is then redundant.
    //
    // The marker proves only that the shared Paperclip GitHub App posted it —
    // every agent shares that identity, so it carries no requester identity at
    // all. Suppressing on it would also drop the author's notification when a
    // MANAGER or a peer agent requests review on someone else's PR, which is
    // the case the notification exists for. Trading a real notification for a
    // redundant-wake saving is the wrong side of this issue: BLO-18865 exists
    // because dropped review signals strand work for hours.
    //
    // Do not re-add suppression here on the marker alone. It needs a trusted
    // requester identity (an outbound-comment record written by the run that
    // posted the comment) checked against the matched issue's assignee; the
    // marker's `agent=` attribute is self-asserted and is not that.
    //
    // Redundant self-wakes are already bounded: the author wake is
    // comment-scoped-idempotent (one per request comment, replays skipped as
    // duplicate_pr_author_wake), and the reason is "review requested", which
    // no agent treats as an instruction to request review again. That is the
    // same shape a human @ally request has always had.
    const suppressAuthorWake =
      synchronizeReviewerOnly || context.wakeReason === "github_pr_converted_to_draft";
    if (
      eventName === "pull_request" &&
      synchronizeReviewerOnly &&
      typeof context.prNumber !== "number"
    ) {
      logger.error(
        {
          deliveryId,
          repoFullName: context.repoFullName,
          wakeReason: context.wakeReason,
          prNumber: context.prNumber,
        },
        "github webhook synchronize reviewer-only context missing PR number; suppressing author wakes",
      );
    }

    // BLO-20886: an author-directed wake (prRole: "author", set below via
    // isPrWake) asserts ownership of the PR ("YOUR pull request") and, for
    // review-shaped reasons, instructs a push. Firing it for every issue in
    // `matched` -- which includes issues named only via an informational
    // `Related:` mention -- sent that directive to the assignee of an issue
    // with no relationship to the PR at all (observed live: PR #953 matched
    // BLO-19132 via `Refs:` and BLO-20810/BLO-20129/BLO-19079 via `Related:`;
    // the wake landed on BLO-20129's assignee). Restrict the author-wake loop
    // to the PR's OWNING issue(s) only -- resolveOwningPaperclipIdentifiers's
    // branch > title > labeled Fixes:/Closes:/Refs: rule. `matched` keeps its
    // full breadth for the back-link comment and merged-PR forward-capture
    // above, which are informational and correctly link every mentioned
    // issue. When no owning issue resolves (none found), the author wake is
    // dropped with a logged suppressionReason rather than falling through to
    // a lower-priority or unlabeled mention.
    const isPrWake = context.wakeReason.startsWith("github_pr_") && context.prNumber !== null;
    let authorWakeCandidates = matched;
    if (isPrWake) {
      const owning = context.owningIdentifiers ?? [];
      if (owning.length === 0) {
        authorWakeCandidates = [];
        if (matched.length > 0) {
          const suppressionReason = "no_owning_reference";
          skipped.push({ issueIdentifier: null, reason: suppressionReason });
          logger.info(
            {
              deliveryId,
              event: eventName,
              wakeReason: context.wakeReason,
              prNumber: context.prNumber,
              repoFullName: context.repoFullName,
              identifiers: context.identifiers,
              matchedIdentifiers: matched.map((m) => m.identifier),
              suppressionReason,
            },
            "github webhook suppressed author-directed PR wake: no confidently-resolved owning issue",
          );
        }
      } else {
        authorWakeCandidates = matched.filter((m) => m.identifier && owning.includes(m.identifier));
      }
    }

    for (const issue of suppressAuthorWake ? [] : authorWakeCandidates) {
      // Terminal-status issues don't need to wake -- the assignee
      // shouldn't reopen `done`/`cancelled` work just because a stale
      // CI ping arrived.
      if (issue.status === "done" || issue.status === "cancelled") {
        skipped.push({ issueIdentifier: issue.identifier, reason: "terminal_status" });
        continue;
      }

      let effectiveAssigneeAgentId = issue.assigneeAgentId;
      let wakeCommentId: string | null = null;
      let authorWakeIdempotencyKey: string | null = null;

      if (actionableReviewFeedback) {
        const reopen = await reopenInReviewIssueForActionablePrFeedback(db, issue, context, deliveryId);
        effectiveAssigneeAgentId = reopen.assigneeAgentId;
        wakeCommentId = reopen.commentId;
        if (reopen.reopened) {
          reopened.push({ issueIdentifier: issue.identifier, commentId: reopen.commentId });
        }
        // Self-review non-convergence escalation (BLO-13353 (b)): after N
        // actionable reopen cycles on a PR authored by the reviewer bot, hand
        // the issue up the chain of command instead of re-waking the author.
        // Best-effort — a failure here must never break the wake path.
        if (
          reopen.reopened &&
          context.prNumber !== null &&
          isSelfReviewedPr(context, config.prReviewerBotLogin ?? null)
        ) {
          try {
            const cycles = await countPrReviewFeedbackCycles(
              db,
              issue.id,
              context.repoFullName,
              context.prNumber,
            );
            const threshold =
              config.selfReviewEscalationThreshold ?? DEFAULT_SELF_REVIEW_ESCALATION_THRESHOLD;
            if (cycles >= threshold) {
              const result = await getRecovery().escalateStalledSelfReviewPr({
                issueId: issue.id,
                prNumber: context.prNumber,
                repoFullName: context.repoFullName,
                cycleCount: cycles,
              });
              escalated.push({
                issueIdentifier: issue.identifier,
                ownerAgentId: result.ownerAgentId,
                ownerType: result.ownerType,
                cycles,
              });
              // Hand-off done: the manager/board now owns unsticking this PR.
              // Don't also re-wake the author — that's the loop we're breaking.
              continue;
            }
          } catch (err) {
            logger.warn(
              { err, issueId: issue.id, prNumber: context.prNumber },
              "self-review non-convergence escalation failed (non-fatal)",
            );
          }
        }
        // BLO-19497 AC #5: a blocking review landing on an issue whose
        // assignee has no live wake path (monitor triggered, nextCheckAt
        // null) must not just sit in a comment nobody will read -- hand it to
        // the manager.
        //
        // Review finding (PR #1125): this used to be gated on
        // reopen.commentInserted, on the theory that redelivery of the same
        // review always re-finds commentInserted === false and so is
        // naturally deduped. That reasoning breaks the moment
        // escalateUnseenBlockingReviewFeedback itself fails transiently (its
        // own comment write or the manager wakeup throws) AFTER the feedback
        // comment above has already landed: every subsequent redelivery of
        // that same review permanently sees commentInserted === false and
        // this branch never runs again, so the escalation -- the whole point
        // of AC #5 -- silently never happens. Attempt escalation on every
        // delivery that meets the conditions instead, and let
        // escalateUnseenBlockingReviewFeedback's own idempotency (wake +
        // comment, both keyed on the same externalKey/idempotencyKey) decide
        // whether there is anything left to do.
        if (
          effectiveAssigneeAgentId &&
          isBlockingReviewState(context.reviewState) &&
          isIssueMonitorTriggered(issue)
        ) {
          try {
            const escalation = await escalateUnseenBlockingReviewFeedback(db, heartbeat, {
              issue,
              assigneeAgentId: effectiveAssigneeAgentId,
              commentId: reopen.commentId,
              context,
              deliveryId,
            });
            if (escalation.escalated) {
              escalated.push({
                issueIdentifier: issue.identifier,
                ownerAgentId: escalation.managerAgentId,
                ownerType: "agent",
                cycles: 0,
              });
            }
          } catch (err) {
            logger.warn(
              { err, issueId: issue.id, prNumber: context.prNumber },
              "unseen blocking review feedback escalation failed (non-fatal)",
            );
          }
        }
        if (effectiveAssigneeAgentId) {
          authorWakeIdempotencyKey = buildPrAuthorWakeIdempotencyKey(issue.id, context, deliveryId);
          if (await hasExistingWakeWithIdempotencyKey(db, effectiveAssigneeAgentId, authorWakeIdempotencyKey)) {
            skipped.push({ issueIdentifier: issue.identifier, reason: "duplicate_review_feedback" });
            continue;
          }
        }
      }

      if (!effectiveAssigneeAgentId) {
        skipped.push({ issueIdentifier: issue.identifier, reason: "unassigned" });
        continue;
      }
      // PR-shaped wakes carry an `prRole: "author"` marker so the
      // heartbeat directive flips from reviewer-shaped ("review this PR")
      // to author-shaped ("a reviewer just posted findings on YOUR PR").
      // Non-PR wakes (CI completion, etc.) leave prRole unset. (isPrWake is
      // hoisted above this loop -- see the authorWakeCandidates comment.)

      // BLO-13247: the actionableReviewFeedback branch above already
      // precheck-and-skips on its own idempotency key before this point, but
      // every OTHER PR-wake reason (opened/reopened/ready_for_review/a
      // non-actionable review_requested) fell through with an idempotencyKey
      // that was only ever passed to heartbeat.wakeup and never checked
      // first — enqueueWakeup stores the key but does not enforce it (same
      // gap the reviewer wake above guards against at
      // shouldFirePrReviewerWake). A single GitHub delivery processed twice
      // (observed: two heartbeatRuns created 19-45ms apart off the IDENTICAL
      // x-github-delivery id) fanned into two queued runs for the same
      // issue because nothing ever looked for the first one. Precheck here
      // too, mirroring buildPrReviewerWakeIdempotencyKey's comment-scoping
      // for github_pr_review_requested so a later distinct @ally comment can
      // still wake the author again.
      if (isPrWake && !authorWakeIdempotencyKey) {
        const prNumber = context.prNumber as number;
        const repo = context.repoFullName ?? "unknown";
        const { suffix, scope } = wakeIdempotencySuffix(
          context,
          deliveryId,
          AUTHOR_DELIVERY_SCOPED_WAKE_REASONS,
        );
        authorWakeIdempotencyKey = `pr_review_author:${issue.id}:${repo}:${prNumber}:${suffix}`;
        const existingPrAuthorWake = await db
          .select({ id: agentWakeupRequests.id })
          .from(agentWakeupRequests)
          .where(
            and(
              eq(agentWakeupRequests.agentId, effectiveAssigneeAgentId),
              eq(agentWakeupRequests.idempotencyKey, authorWakeIdempotencyKey),
              inArray(agentWakeupRequests.status, idempotentWakeStatuses(scope)),
            ),
          )
          .limit(1)
          .then((rows) => rows[0] ?? null);
        if (existingPrAuthorWake) {
          skipped.push({ issueIdentifier: issue.identifier, reason: "duplicate_pr_author_wake" });
          continue;
        }
      }

      const reviewBody = context.reviewBody ?? (actionableReviewFeedback ? prFeedbackBody(context) : null);
      const reviewAuthorLogin =
        context.reviewAuthorLogin ?? (actionableReviewFeedback ? prFeedbackAuthorLogin(context) : null);
      try {
        await heartbeat.wakeup(effectiveAssigneeAgentId, {
          source: "automation",
          triggerDetail: "system",
          reason: context.wakeReason,
          payload: {
            issueId: issue.id,
            ...(wakeCommentId ? { wakeCommentId } : {}),
            source: "github",
            event: eventName,
            deliveryId,
            prNumber: context.prNumber,
            repoFullName: context.repoFullName,
            prUrl: context.prUrl,
            eventUrl: context.eventUrl,
            headSha: context.headSha,
            paperclipIdentifiers: context.identifiers,
          },
          contextSnapshot: {
            issueId: issue.id,
            taskId: issue.id,
            wakeReason: context.wakeReason,
            wakeSource: "automation",
            wakeTriggerDetail: "system",
            commentSource: "github",
            githubEvent: eventName,
            githubDeliveryId: deliveryId,
            githubPrNumber: context.prNumber,
            githubRepoFullName: context.repoFullName,
            ...(wakeCommentId ? { wakeCommentId, commentId: wakeCommentId } : {}),
            ...githubContextMetadata(context),
            ...(actionableReviewFeedback && wakeCommentId
              ? { githubReviewFeedbackCommentId: wakeCommentId }
              : {}),
            ...(isPrWake ? { prRole: "author" as const } : {}),
            ...(reviewBody ? { githubPrReviewBody: reviewBody } : {}),
            ...(context.reviewState ? { githubPrReviewState: context.reviewState } : {}),
            ...(reviewAuthorLogin
              ? { githubPrReviewAuthorLogin: reviewAuthorLogin }
              : {}),
            ...(actionableReviewFeedback ? { githubReviewFeedbackActionable: true } : {}),
            // BLO-19522: carry the request comment onto the AUTHOR wake too,
            // not just the reviewer wake. The review-request directive says
            // who asked and shows the ask, which is the difference between
            // "a review was requested" (true, actionable by nobody) and the
            // feedback directive this path used to borrow.
            ...(context.wakeReason === "github_pr_review_requested" && context.commentBody
              ? { githubPrReviewRequestBody: context.commentBody }
              : {}),
            ...(context.wakeReason === "github_pr_review_requested" && context.commentAuthorLogin
              ? { githubPrReviewRequestAuthorLogin: context.commentAuthorLogin }
              : {}),
            // BLO-23395: inline the eviction-cause comment so the woken agent
            // doesn't have to fetch githubEventUrl just to learn why.
            ...(context.wakeReason === "github_pr_merge_queue_evicted" && context.commentBody
              ? { githubMergeQueueEvictionBody: context.commentBody }
              : {}),
          },
          // Coalesce rapid bursts on the same PR/event so a single review
          // submission can't fan into N author runs. Parallel to the
          // reviewer wake's `pr_review:<repo>:<num>:<reason>` key but
          // scoped by issue so two issues sharing a PR each get their own.
          // authorWakeIdempotencyKey is always set by this point when
          // isPrWake is true (either by the actionableReviewFeedback branch
          // or the precheck above).
          ...(isPrWake ? { idempotencyKey: authorWakeIdempotencyKey as string } : {}),
        });
        wakes.push({ issueIdentifier: issue.identifier, agentId: effectiveAssigneeAgentId });
      } catch (err) {
        logger.error(
          {
            err,
            issueId: issue.id,
            identifier: issue.identifier,
            agentId: effectiveAssigneeAgentId,
            event: eventName,
          },
          "github webhook wake failed",
        );
        skipped.push({ issueIdentifier: issue.identifier, reason: "wake_threw" });
      }
    }

    logger.info(
      {
        event: eventName,
        deliveryId,
        identifiers: context.identifiers,
        prNumber: context.prNumber,
        repoFullName: context.repoFullName,
        wakeCount: wakes.length,
        reopenedCount: reopened.length,
        skippedCount: skipped.length,
        escalatedCount: escalated.length,
      },
      "github webhook drove issue wakes",
    );

    respond(200, {
      ok: true,
      wakes,
      skipped,
      reopened,
      // BLO-23893: see the `no_matching_issue` exit above -- the reviewer
      // wake's outcome belongs on every response that computed it, not only
      // on the early-exit paths.
      reviewerWakeFired,
      reviewerRunsCancelled,
      ...(workProductsUpserted > 0 ? { workProductsUpserted } : {}),
      ...(backLinked.length ? { backLinked } : {}),
      ...(escalated.length ? { escalated } : {}),
    });
  });

  return router;
}

// Test-only re-exports.
export const __test_extractPaperclipIdentifiers = extractPaperclipIdentifiers;
export const __test_hasPrReviewerRequestMention = hasPrReviewerRequestMention;
export const __test_hasPrReviewerAgentRequestMarker = hasPrReviewerAgentRequestMarker;
export const __test_hasAllyConsolidatedReviewHeading = hasAllyConsolidatedReviewHeading;
export const __test_hasAllyConsolidatedReviewHeader = hasAllyConsolidatedReviewHeader;
export const __test_verifyGithubSignature = verifyGithubSignature;
export const __test_resolveEventContext = resolveEventContext;
export const __test_shouldFirePrReviewerWake = shouldFirePrReviewerWake;
export const __test_isReviewerSelfEchoReview = isReviewerSelfEchoReview;
export const __test_resolvePostedReviewObservation = resolvePostedReviewObservation;
export const __test_buildPrReviewerWakeIdempotencyKey = buildPrReviewerWakeIdempotencyKey;
export const __test_prReviewerWakeIdempotencyScope = prReviewerWakeIdempotencyScope;
export const __test_idempotentWakeStatuses = idempotentWakeStatuses;
export const __test_buildPrReviewerTaskKey = buildPrReviewerTaskKey;
export const __test_buildPrReviewerTaskLockKeys = buildPrReviewerTaskLockKeys;
export const __test_buildDependabotAlertIssueBody = buildDependabotAlertIssueBody;
export const __test_resolveDependabotAlertContext = resolveDependabotAlertContext;
export const __test_hasActionablePrReviewFeedback = hasActionablePrReviewFeedback;
export const __test_isClaudeCodeReviewServiceNotice = isClaudeCodeReviewServiceNotice;
export const __test_buildPrReviewFeedbackComment = buildPrReviewFeedbackComment;
export const __test_buildIssueBackLinkBody = buildIssueBackLinkBody;
export const __test_commentsContainBackLinkMarker = commentsContainBackLinkMarker;
export const __test_backLinkAbsoluteUrl = backLinkAbsoluteUrl;
export const __test_isSelfReviewedPr = isSelfReviewedPr;
export const __test_resolvePrCommentReviewGateWebhookTrigger = resolvePrCommentReviewGateWebhookTrigger;
