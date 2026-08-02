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
  agents,
  agentWakeupRequests,
  companies,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { heartbeatService, type HeartbeatServiceOptions } from "../services/heartbeat.js";
import { issueService } from "../services/issues.js";
import {
  GITHUB_DEPENDABOT_ALERT_ORIGIN_KIND,
  GITHUB_DEPENDABOT_WEBHOOK_DIAGNOSTIC_ORIGIN_KIND,
  findOpenDependabotAlertIssue,
  recordDependabotWebhookDiagnostic,
} from "../services/dependabot-alert-issues.js";
import { logger } from "../middleware/logger.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { extractPaperclipIdentifiers } from "../services/paperclip-identifiers.js";
import {
  githubListIssueCommentBodies,
  githubPostIssueComment,
} from "../services/github-app-auth.js";
import { recoveryService } from "../services/recovery/service.js";
import { recordGithubReviewRequestDelivery } from "../services/metrics.js";
import {
  recordMergedPullRequest,
  enrichAuthoredLocForRow,
  type RecordMergedPullRequestInput,
} from "../services/issue-pull-requests.js";

type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type PrReviewerSelectionDb = Pick<Db | DbTransaction, "select">;

// Keep lock contention well below GitHub's webhook timeout. The winner holds
// one pooled connection while heartbeat commits through another; createDb's
// default pool satisfies the required minimum of two connections.
const PR_REVIEWER_TASK_LOCK_TIMEOUT_MS = 2_000;
const PR_REVIEWER_TASK_LOCK_RETRY_MS = 25;

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
   * are assigned to the least-loaded active reviewer. The singular option is
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

// Narrow variant, used ONLY to disqualify an agent review request (BLO-18865).
//
// `hasAllyConsolidatedReviewHeader` scans the whole body, which is right at its
// other call site (isActionablePrReviewComment, where a body carrying the header
// counts as review feedback no matter who relayed it — a WIDENING use). Reusing
// it here was too broad in the opposite direction: a legitimate marked request
// that merely MENTIONS the review in prose ("your Ally — Consolidated PR Review
// flagged X") was silently dropped. A silently dropped review request is the
// exact failure this marker exists to fix, so the exclusion is scoped to the
// shape Ally's own output actually has: the header on its own line, as a
// Markdown heading or bold run.
//
// This keeps the #583 layer intact — Ally echoing the marker at byte 0 still
// carries its `## Ally — Consolidated PR Review` line and is still rejected —
// while a quoted (`> ## Ally — ...`) or indented copy reads as a quote, not as
// Ally's output, and no longer suppresses a real request. The heading/bold
// prefix is optional so a format change on Ally's side does not silently lapse
// the guard; only a mid-line prose reference is let through.
const ALLY_CONSOLIDATED_REVIEW_HEADING_PATTERN =
  /^[ \t]{0,3}(?:#{1,6}[ \t]+|\*\*[ \t]*)?Ally[ \t]*(?:—|–|-|:)[ \t]*Consolidated[ \t]+PR[ \t]+Review\b/im;

function hasAllyConsolidatedReviewHeading(body: string | null | undefined): boolean {
  return typeof body === "string" && ALLY_CONSOLIDATED_REVIEW_HEADING_PATTERN.test(body);
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
//      nothing. See ALLY_CONSOLIDATED_REVIEW_HEADING_PATTERN for why this is
//      matched on the heading shape rather than anywhere in the body.
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

// Negation cues that flip an otherwise-actionable bare phrase into a confirmation
// that nothing is required — e.g. Ally's COMMENTED, zero-finding review 4682219268
// on TC PR #1115 said "Clean. No changes requested from this lens", which the bare
// `changes\s+requested` phrase match flagged as actionable and bounced a fully
// approved PR back to the implementer (BLO-15942). Scanned in the text immediately
// preceding a match, bounded to NEGATION_LOOKBACK_WORDS words and stopping at
// sentence punctuation, so a genuine, later occurrence of the phrase elsewhere in
// the body still counts, and an unrelated earlier negation in the same long
// sentence (e.g. "The docs aren't complete, changes requested for section 3.")
// doesn't suppress it.
const NEGATION_CUE_REGEX =
  /\b(?:no|not|zero|none|never|without|isn't|aren't|doesn't|didn't|won't|cannot)\b/i;
const NEGATION_LOOKBACK_WORDS = 8;

// An uncounted "Critical Issues" / "Important Issues" findings section, matched
// only where it starts a line — optionally behind markdown heading (`###`),
// blockquote, bullet/ordered-list, or emphasis (`**`) decoration. See the call
// site in hasActionablePrReviewFeedback for why the anchor is load-bearing.
const UNCOUNTED_FINDINGS_HEADING_REGEX =
  /^[ \t]*(?:[#>]+[ \t]*)?(?:(?:[-*+]|\d+[.)])[ \t]+)?[*_]*(?:Critical|Important)[ \t]+Issues\b(?![*_]*[ \t]*\()/im;

// Returns true if `pattern` matches `text` at least once outside a negated context
// (see NEGATION_CUE_REGEX). Used for bare-phrase heuristics ("changes requested")
// that read very differently as "no changes requested" vs "please make the changes
// requested".
function hasNonNegatedMatch(text: string, pattern: RegExp): boolean {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const regex = new RegExp(pattern.source, flags);
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const preceding = text.slice(0, match.index);
    const sentenceStart = Math.max(preceding.lastIndexOf("."), preceding.lastIndexOf("\n")) + 1;
    const sentenceLocal = preceding.slice(sentenceStart);
    const lookback = sentenceLocal.trim().split(/\s+/).slice(-NEGATION_LOOKBACK_WORDS).join(" ");
    if (!NEGATION_CUE_REGEX.test(lookback)) return true;
    if (regex.lastIndex === match.index) regex.lastIndex += 1;
  }
  return false;
}

function hasActionablePrReviewFeedback(body: string | null | undefined, state?: string | null): boolean {
  const normalizedState = state?.trim().toLowerCase();
  if (normalizedState === "changes_requested" || normalizedState === "changes-requested") return true;
  if (typeof body !== "string") return false;
  const text = body.trim();
  if (!text) return false;

  // Ally's consolidated review buckets blocking findings under a severity
  // heading with a count, e.g. "### Critical Issues (1)" or "### Important
  // Issues (2)". Any bucket with a non-zero count is actionable. `matchAll`
  // (not `match`) so a zero-count bucket ("Critical Issues (0)") appearing
  // before a non-zero one doesn't mask it. NOTE: keep this list in sync with
  // the reviewer's severity taxonomy — a review that flags "Critical Issues"
  // must not slip through as non-actionable (the BLO-12541/#973 stall).
  for (const bucket of text.matchAll(/\b(?:Critical|Important)\s+Issues\b[*_]*\s*\((\d+)\)/gi)) {
    if (Number(bucket[1]) > 0) return true;
  }
  // Same headings without an explicit count still signal findings. Match the
  // uncounted heading itself so any zero-count bucket, even for the same label,
  // cannot mask a later uncounted findings section.
  //
  // Anchored to the start of a line (allowing markdown heading/list/emphasis
  // decoration) because an unanchored match also fires on ordinary prose that
  // says the opposite: Ally's APPROVED review on Network-Operator-Portal#591
  // read "Looks good. No Critical or Important issues found.", whose trailing
  // "Important issues" matched here and bounced a clean, approved PR back to
  // its author (BLO-19067). A real findings section is always its own heading
  // or list item, never mid-sentence.
  if (UNCOUNTED_FINDINGS_HEADING_REGEX.test(text)) return true;
  if (/^[ \t]*decision[ \t]*:[ \t]*changes_requested[ \t]*$/im.test(text)) return true;
  if (hasNonNegatedMatch(text, /\bchanges\s+requested\b/i)) return true;
  if (hasNonNegatedMatch(text, /\brequest(?:ed|s)?\s+changes\b/i)) return true;
  // Match "before merge" and its inflections ("before merging/merged/merges").
  // The bare `\bmerge\b` form silently missed "before merging" (#973).
  if (/\bRecommended\s+Action\b[\s\S]{0,400}\bfix\b[\s\S]{0,400}\bbefore\s+merg(?:e|es|ed|ing)\b/i.test(text)) return true;
  return false;
}

function isActionablePrReviewComment(
  body: string | null | undefined,
  authorLogin: string | null | undefined,
  configuredReviewerLogin: string | null | undefined,
): boolean {
  if (!hasActionablePrReviewFeedback(body)) return false;
  return isConfiguredPrReviewerAuthor(authorLogin, configuredReviewerLogin) || hasAllyConsolidatedReviewHeader(body);
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
  wakeReason: string;
  prNumber: number | null;
  repoFullName: string | null;
  prTitle?: string | null;
  prUrl?: string | null;
  eventUrl?: string | null;
  headSha?: string | null;
  // pull_request_review.submitted only — drives the author-facing directive
  // so the assignee wake's prompt carries the reviewer's findings without
  // needing a separate `gh pr view` shellout.
  reviewBody?: string | null;
  reviewState?: string | null;
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
  prAdditions?: number | null;
  prDeletions?: number | null;
  prBranch?: string | null;
  prBody?: string | null;
}

// Cap review body in contextSnapshot so the heartbeat-run row stays small.
// Author directive renders the truncation marker so the author knows to
// fetch the full body via `gh pr view`.
const REVIEW_BODY_MAX_BYTES = 4096;

function clampReviewBody(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (Buffer.byteLength(trimmed, "utf8") <= REVIEW_BODY_MAX_BYTES) return trimmed;
  // Byte-length truncation so UTF-8 multibyte characters don't split.
  const buf = Buffer.from(trimmed, "utf8");
  let cut = buf.subarray(0, REVIEW_BODY_MAX_BYTES).toString("utf8");
  // `toString("utf8")` replaces split surrogates with U+FFFD; strip a
  // trailing replacement char to avoid a visible glyph in the directive.
  if (cut.endsWith("�")) cut = cut.slice(0, -1);
  return `${cut}\n…(truncated)`;
}

function resolveEventContext(
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
    }) => void;
  } = {},
): ResolvedEventContext | null {
  const repository = payload.repository as Record<string, unknown> | undefined;
  const repoFullName = (repository?.full_name as string | undefined) ?? null;

  const collectFromPullRequest = (pr: Record<string, unknown> | undefined) => {
    if (!pr) {
      return {
        ids: [] as string[],
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
      if (
        !reviewerRequest &&
        !reviewFeedback &&
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
        });
      }
      if (!reviewerRequest && !reviewFeedback) return null;
      // BLO-9293: on a PR's issue_comment payload, `issue.user.login` is the PR
      // author (the comment author is `comment.user.login`, captured separately).
      const issueUser = issue.user as Record<string, unknown> | undefined;
      const prNumber = (issue.number as number | undefined) ?? null;
      const prUrl = githubPrUrl(repoFullName, prNumber, readStringField(issue, "html_url"));
      const commentUrl = readStringField(comment, "html_url");
      return {
        identifiers: extractPaperclipIdentifiers(
          issue.title as string | undefined,
          issue.body as string | undefined,
          commentBody,
        ),
        wakeReason: reviewerRequest ? "github_pr_review_requested" : "github_pr_review_feedback",
        prNumber,
        repoFullName,
        prTitle: (issue.title as string | undefined) ?? null,
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
      const reviewBody = clampReviewBody(review?.body as string | null | undefined);
      const reviewState = (review?.state as string | undefined) ?? null;
      const reviewUser = review?.user as Record<string, unknown> | undefined;
      const reviewAuthorLogin = (reviewUser?.login as string | undefined) ?? null;
      const reviewUrl = readStringField(review, "html_url");
      return {
        identifiers: collected.ids,
        wakeReason: "github_pr_review_submitted",
        prNumber: collected.number,
        repoFullName,
        prTitle: collected.title,
        prUrl: collected.url,
        eventUrl: reviewUrl ?? collected.url,
        headSha: collected.headSha,
        prAuthorLogin: collected.authorLogin,
        reviewBody,
        reviewState,
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
        wakeReason: reasonByAction[action] ?? "github_pull_request",
        prNumber: collected.number,
        repoFullName,
        prTitle: collected.title,
        prUrl: collected.url,
        eventUrl: collected.url,
        headSha: collected.headSha,
        prAuthorLogin: collected.authorLogin,
        prDraft: pr?.draft === true,
        // Merge metadata for forward-capture. additions/deletions are present
        // on the pull_request payload; per-file authored-LOC needs a follow-up
        // pulls/{n}/files fetch (enrichment), so it is not read here.
        prMerged: action === "closed" ? merged : undefined,
        prMergedAt: readStringField(pr, "merged_at"),
        prAdditions: typeof pr?.additions === "number" ? (pr.additions as number) : null,
        prDeletions: typeof pr?.deletions === "number" ? (pr.deletions as number) : null,
        prBranch: (head?.ref as string | undefined) ?? null,
        prBody: (pr?.body as string | undefined) ?? null,
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
    "This note is scoped to re-deriving the metadata fields above. It is NOT an evidentiary standard: it does not restrict which **Verifying signal** branch you may use, and it does not forbid the repository contents API or GraphQL.",
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

// Finds the open issue for this alert (originId is the stable
// `github-dependabot:<repo>#<alertNumber>` key), or creates one. A
// `reintroduced`/`reopened` redelivery for an alert that already has an open
// issue reuses it rather than spawning a duplicate remediation run — the
// Release Engineer sees one issue per alert to comment on and dedupe against,
// per BLO-16319's verifying signal.
async function resolveDependabotAlertIssue(
  db: Db,
  input: {
    companyId: string;
    assigneeAgentId: string;
    originId: string;
    repoFullName: string;
    alert: DependabotAlertContext;
  },
): Promise<{ id: string; identifier: string | null; reused: boolean }> {
  const existing = await findOpenDependabotAlertIssue(db, input.companyId, input.originId);
  if (existing) return { id: existing.id, identifier: existing.identifier, reused: true };

  const priority = DEPENDABOT_SEVERITY_TO_ISSUE_PRIORITY[input.alert.severity] ?? "medium";
  const title = `Dependabot ${input.alert.severity} alert: ${input.alert.packageName ?? "unknown package"} in ${input.repoFullName}#${input.alert.alertNumber}`;
  const description = buildDependabotAlertIssueBody({ repoFullName: input.repoFullName, alert: input.alert });

  try {
    const created = await issueService(db).create(input.companyId, {
      title,
      description,
      status: "todo",
      priority,
      assigneeAgentId: input.assigneeAgentId,
      originKind: GITHUB_DEPENDABOT_ALERT_ORIGIN_KIND,
      originId: input.originId,
      originFingerprint: input.originId,
    });
    return { id: created.id, identifier: created.identifier, reused: false };
  } catch (error) {
    if (!isUniqueDependabotAlertConflict(error)) throw error;
    const raced = await findOpenDependabotAlertIssue(db, input.companyId, input.originId);
    if (raced) return { id: raced.id, identifier: raced.identifier, reused: true };
    throw error;
  }
}

function buildDependabotTerminalReceipt(input: {
  repoFullName: string;
  alert: DependabotAlertContext;
  deliveryId: string | null;
}): string {
  const alertUrl =
    input.alert.alertUrl ??
    `https://github.com/${input.repoFullName}/security/dependabot/${input.alert.alertNumber}`;
  return [
    "[github-dependabot-receipt] Terminal Dependabot state received through the HMAC-verified GitHub webhook.",
    `- Repository: \`${input.repoFullName}\``,
    `- Alert: [#${input.alert.alertNumber}](${alertUrl})`,
    `- Action: \`${input.alert.action}\``,
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

  if (!issue) {
    issue = await issueService(db).create(input.companyId, {
      title: `Dependabot terminal receipt: ${input.repoFullName}#${input.alert.alertNumber} ${input.alert.action}`,
      description: [
        receiptBody,
        "",
        "## Acceptance criteria",
        `- Dependabot alert #${input.alert.alertNumber} is recorded in a terminal state from a permitted webhook delivery.`,
        "",
        "## Verifying signal",
        `- GitHub delivery \`${input.deliveryId ?? "unavailable"}\` is preserved in the system comment on this issue.`,
      ].join("\n"),
      status: "done",
      priority: DEPENDABOT_SEVERITY_TO_ISSUE_PRIORITY[input.alert.severity] ?? "medium",
      assigneeAgentId: input.assigneeAgentId,
      originKind: GITHUB_DEPENDABOT_ALERT_ORIGIN_KIND,
      originId: input.originId,
      originFingerprint: input.originId,
    });
  }

  const externalKey = `${input.originId}:${input.alert.action}:${input.deliveryId ?? "no-delivery"}`;
  const existingReceipt = await db
    .select({ id: issueComments.id })
    .from(issueComments)
    .where(
      and(
        eq(issueComments.issueId, issue.id),
        sql`${issueComments.metadata}->>'kind' = 'github_dependabot_terminal_receipt'`,
        sql`${issueComments.metadata}->>'externalKey' = ${externalKey}`,
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);

  if (!existingReceipt) {
    await db.insert(issueComments).values({
      companyId: input.companyId,
      issueId: issue.id,
      authorType: "system",
      body: receiptBody,
      metadata: {
        kind: "github_dependabot_terminal_receipt",
        source: "github",
        externalKey,
        repoFullName: input.repoFullName,
        alertNumber: input.alert.alertNumber,
        action: input.alert.action,
        deliveryId: input.deliveryId,
      } as never,
    });
  }

  if (issue.status !== "done") {
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
// affinity lookup (findActivePrReviewerForTask), the withPrReviewerTaskLock
// serialization, and the cancel-queued-runs-on-close sweep, all of which must
// stay stable across heads for one PR. Head-awareness for review requests lives
// in heartbeat's coalescing decision instead (BLO-18953).
function buildPrReviewerTaskKey(context: ResolvedEventContext & { prNumber: number }) {
  const repo = context.repoFullName ?? "unknown";
  return `pr_review:${repo}:${context.prNumber}`;
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
  configuredAgentIds: readonly string[],
  taskKey: string,
): Promise<string | null> {
  if (configuredAgentIds.length === 0) return null;

  const activeRows = await db
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(
        inArray(agents.id, [...configuredAgentIds]),
        inArray(agents.status, ["idle", "running"]),
      ),
    );
  const activeSet = new Set(activeRows.map((row) => row.id));
  const activeAgentIds = configuredAgentIds.filter((agentId) => activeSet.has(agentId));
  if (activeAgentIds.length === 0) return null;

  const loadRows = await db
    .select({ agentId: heartbeatRuns.agentId, count: sql<number>`count(*)::int` })
    .from(heartbeatRuns)
    .where(
      and(
        inArray(heartbeatRuns.agentId, activeAgentIds),
        inArray(heartbeatRuns.status, ["queued", "running"]),
      ),
    )
    .groupBy(heartbeatRuns.agentId);
  const loadByAgent = new Map(
    loadRows.map((row) => [row.agentId, Number(row.count)]),
  );
  const minimumLoad = Math.min(
    ...activeAgentIds.map((agentId) => loadByAgent.get(agentId) ?? 0),
  );
  const leastLoadedAgentIds = activeAgentIds.filter(
    (agentId) => (loadByAgent.get(agentId) ?? 0) === minimumLoad,
  );

  // Concurrent webhook deliveries can observe the same load snapshot. A
  // task-scoped tie-break spreads those PRs instead of biasing every tie to
  // the first configured reviewer, while duplicate events for one PR still
  // select the same reviewer and coalesce under that agent's task lock.
  const tieBreak = crypto.createHash("sha256").update(taskKey).digest().readUInt32BE(0);
  return leastLoadedAgentIds[tieBreak % leastLoadedAgentIds.length] ?? null;
}

async function findActivePrReviewerForTask(
  db: PrReviewerSelectionDb,
  configuredAgentIds: readonly string[],
  taskKey: string,
): Promise<string | null> {
  if (configuredAgentIds.length === 0) return null;

  return db
    .select({ agentId: heartbeatRuns.agentId })
    .from(heartbeatRuns)
    .innerJoin(agents, eq(agents.id, heartbeatRuns.agentId))
    .where(
      and(
        inArray(heartbeatRuns.agentId, [...configuredAgentIds]),
        inArray(heartbeatRuns.status, ["queued", "running"]),
        inArray(agents.status, ["idle", "running"]),
        eq(heartbeatRuns.contextTaskKey, taskKey),
      ),
    )
    .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id))
    .limit(1)
    .then((rows) => rows[0]?.agentId ?? null);
}

async function withPrReviewerTaskLock<T>(
  db: Db,
  taskKey: string,
  action: (tx: DbTransaction) => Promise<T>,
): Promise<T> {
  const deadline = Date.now() + PR_REVIEWER_TASK_LOCK_TIMEOUT_MS;

  while (true) {
    // Do not block a pooled connection while another request owns the lock:
    // the winner needs a second connection for heartbeat's enqueue transaction.
    const outcome = await db.transaction(async (tx) => {
      const rows = await tx.execute(
        sql`select pg_try_advisory_xact_lock(hashtextextended(${taskKey}, 0)) as acquired`,
      );
      const row = Array.isArray(rows) ? rows[0] : null;
      if (
        !row ||
        typeof row !== "object" ||
        (row as Record<string, unknown>).acquired !== true
      ) {
        return { acquired: false as const };
      }
      return { acquired: true as const, value: await action(tx) };
    });
    if (outcome.acquired) return outcome.value;
    if (Date.now() >= deadline) {
      throw new Error("timed out acquiring PR reviewer task assignment lock");
    }
    await new Promise((resolve) => setTimeout(resolve, PR_REVIEWER_TASK_LOCK_RETRY_MS));
  }
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
  return hasActionablePrReviewFeedback(context.reviewBody, context.reviewState);
}

function buildPrFeedbackExternalKey(context: ResolvedEventContext, deliveryId: string | null): string | null {
  if (context.commentId) return `github_issue_comment:${context.commentId}`;
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

async function reopenInReviewIssueForActionablePrFeedback(
  db: Db,
  issue: MatchedGithubIssue,
  context: ResolvedEventContext,
  deliveryId: string | null,
): Promise<{ reopened: boolean; commentId: string | null; assigneeAgentId: string | null }> {
  const returnAssigneeAgentId = readReturnAssigneeAgentId(issue.executionState);
  const effectiveAssigneeAgentId = returnAssigneeAgentId ?? issue.assigneeAgentId;
  if (issue.status !== "in_review" || !effectiveAssigneeAgentId) {
    return { reopened: false, commentId: null, assigneeAgentId: effectiveAssigneeAgentId };
  }

  const externalKey = buildPrFeedbackExternalKey(context, deliveryId);
  const now = new Date();
  const result = await db.transaction(async (tx) => {
    const existingComment = externalKey
      ? await tx
        .select({ id: issueComments.id })
        .from(issueComments)
        .where(and(
          eq(issueComments.issueId, issue.id),
          sql`${issueComments.metadata}->>'kind' = 'github_pr_review_feedback'`,
          sql`${issueComments.metadata}->>'externalKey' = ${externalKey}`,
        ))
        .limit(1)
        .then((rows) => rows[0] ?? null)
      : null;

    const commentId: string | null = existingComment
      ? existingComment.id
      : await tx
        .insert(issueComments)
        .values({
          companyId: issue.companyId,
          issueId: issue.id,
          authorType: "system",
          body: buildPrReviewFeedbackComment(context),
          metadata: {
            kind: "github_pr_review_feedback",
            source: "github",
            externalKey: externalKey ?? null,
            repoFullName: context.repoFullName,
            prNumber: context.prNumber,
            deliveryId,
          } as never,
        })
        .returning({ id: issueComments.id })
        .then((rows): string | null => rows[0]?.id ?? null);

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

    return { reopened: Boolean(updated), commentId, assigneeAgentId: effectiveAssigneeAgentId };
  });

  return result;
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

    if (!WAKE_DRIVING_EVENTS.has(eventName)) {
      // Acked but ignored. GitHub retries on non-2xx, and it would
      // hammer us if we 4xx'd every event we don't handle.
      res.status(200).json({ ok: true, ignored: eventName });
      return;
    }

    const payload = (req.body ?? {}) as Record<string, unknown>;
    const context = resolveEventContext(eventName, payload, {
      prReviewerBotLogin: config.prReviewerBotLogin,
      // BLO-18273: surface the one silent drop in this handler. An agent that
      // asks for review without the `<!-- paperclip:review-request -->` marker
      // gets no wake and no error; this is the only trace it ever leaves, so
      // it names the fix in the message rather than just the symptom.
      onSuppressedReviewRequest: (info) => {
        logger.warn(
          {
            event: eventName,
            deliveryId,
            repoFullName: info.repoFullName,
            prNumber: info.prNumber,
            commentId: info.commentId,
            commentAuthorLogin: info.commentAuthorLogin,
            commentUrl: info.commentUrl,
            suppressionReason: "reviewer_bot_authored_request_missing_marker",
          },
          "github webhook reviewer wake skipped: @ally request authored by the reviewer bot login carries no " +
            "start-of-body <!-- paperclip:review-request --> marker, so it is indistinguishable from the " +
            "reviewer's own output (BLO-18865/BLO-18273); no review was requested",
        );
      },
    });

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
        typeof context.prNumber !== "number"
      ) {
        return 0;
      }

      const reviewerTaskKey = buildPrReviewerTaskKey({
        ...context,
        prNumber: context.prNumber,
      });
      const heartbeat = heartbeatService(db, {
        pluginWorkerManager: config.pluginWorkerManager,
        ...config.heartbeatOptions,
      });
      const reason = `Cancelled because GitHub PR ${context.repoFullName ?? "unknown"}#${context.prNumber} ${
        context.wakeReason === "github_pr_closed" ? "closed" : "became a draft"
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
          repoFullName: context.repoFullName,
          prNumber: context.prNumber,
          wakeReason: context.wakeReason,
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
        return await withPrReviewerTaskLock(db, reviewerTaskKey, async (tx) => {
          // The wake insert commits through heartbeat's own transaction. Keep
          // this transaction-scoped lock held until that commit is visible so
          // concurrent first events for one PR re-check affinity instead of
          // assigning the same task to different reviewers.
          const existingWake = await tx
            .select({ id: agentWakeupRequests.id, status: agentWakeupRequests.status })
            .from(agentWakeupRequests)
            .where(
              and(
                inArray(agentWakeupRequests.agentId, reviewerAgentIds),
                eq(agentWakeupRequests.idempotencyKey, idempotencyKey),
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
            return false;
          }

          const reviewerAgentId =
            (await findActivePrReviewerForTask(tx, reviewerAgentIds, reviewerTaskKey)) ??
            (await selectPrReviewerAgentId(tx, reviewerAgentIds, reviewerTaskKey));
          if (!reviewerAgentId) {
            logger.warn(
              {
                configuredReviewerCount: reviewerAgentIds.length,
                event: eventName,
                prNumber: context.prNumber,
                repoFullName: context.repoFullName,
              },
              "github webhook reviewer wake skipped: no configured reviewer is active",
            );
            return false;
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
            return true;
          }
          // The terminal `suppressed` increment is NOT emitted here: the wake
          // path owns it, because only `enqueueWakeup` knows which gate
          // declined and the suppression metric's `cause` label needs that. The
          // same applies to an HttpError refusal, which never reaches this line
          // at all — it propagates to the catch below, and counting it here
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
          // Matches every other suppression gate in this closure, so the 200
          // response body cannot claim reviewerWakeFired for a wake that did
          // not produce a run.
          return false;
        });
      } catch (err) {
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
        });

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

    if (!context || context.identifiers.length === 0) {
      res.status(200).json({
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
      })
      .from(issues);
    const matched = matchedIssues.filter(
      (row) => row.identifier && context.identifiers.includes(row.identifier),
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
      res.status(200).json({
        ok: true,
        ignored: "no_matching_issue",
        identifiers: context.identifiers,
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

    for (const issue of suppressAuthorWake ? [] : matched) {
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
      // Non-PR wakes (CI completion, etc.) leave prRole unset.
      const isPrWake =
        context.wakeReason.startsWith("github_pr_") && context.prNumber !== null;

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

    res.status(200).json({
      ok: true,
      wakes,
      skipped,
      reopened,
      reviewerRunsCancelled,
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
export const __test_buildPrReviewerWakeIdempotencyKey = buildPrReviewerWakeIdempotencyKey;
export const __test_prReviewerWakeIdempotencyScope = prReviewerWakeIdempotencyScope;
export const __test_idempotentWakeStatuses = idempotentWakeStatuses;
export const __test_buildPrReviewerTaskKey = buildPrReviewerTaskKey;
export const __test_buildDependabotAlertIssueBody = buildDependabotAlertIssueBody;
export const __test_resolveDependabotAlertContext = resolveDependabotAlertContext;
export const __test_hasActionablePrReviewFeedback = hasActionablePrReviewFeedback;
export const __test_buildPrReviewFeedbackComment = buildPrReviewFeedbackComment;
export const __test_buildIssueBackLinkBody = buildIssueBackLinkBody;
export const __test_commentsContainBackLinkMarker = commentsContainBackLinkMarker;
export const __test_backLinkAbsoluteUrl = backLinkAbsoluteUrl;
export const __test_isSelfReviewedPr = isSelfReviewedPr;
