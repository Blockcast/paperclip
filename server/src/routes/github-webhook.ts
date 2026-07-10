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
import { type Db, agentWakeupRequests, companies, issueComments, issues } from "@paperclipai/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { heartbeatService, type HeartbeatServiceOptions } from "../services/heartbeat.js";
import { logger } from "../middleware/logger.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { extractPaperclipIdentifiers } from "../services/paperclip-identifiers.js";
import {
  githubListIssueCommentBodies,
  githubPostIssueComment,
} from "../services/github-app-auth.js";
import { recoveryService } from "../services/recovery/service.js";
import {
  recordMergedPullRequest,
  enrichAuthoredLocForRow,
  type RecordMergedPullRequestInput,
} from "../services/issue-pull-requests.js";

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
   * Agent ID that receives an additional wake on PR-shaped events
   * (`pull_request.opened`, `pull_request.reopened`,
   * `pull_request.ready_for_review`, `pull_request_review.submitted`). Drives automated PR review. The
   * reviewer wake fires independently of the issue-assignee wake and
   * does NOT require the PR branch/title/body to reference a paperclip
   * identifier. When null, only the legacy issue-assignee wake fires.
   */
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
   * Test/service override for heartbeat dispatch behavior. Production callers
   * normally leave this unset so queued webhook wakes dispatch immediately.
   */
  heartbeatOptions?: Pick<HeartbeatServiceOptions, "penstockAvailabilityGate" | "skipQueuedRunDispatch">;
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
  for (const bucket of text.matchAll(/\b(?:Critical|Important)\s+Issues\s*\((\d+)\)/gi)) {
    if (Number(bucket[1]) > 0) return true;
  }
  // Same headings without an explicit count still signal findings. Match the
  // uncounted heading itself so any zero-count bucket, even for the same label,
  // cannot mask a later uncounted findings section.
  if (/\b(?:Critical|Important)\s+Issues\b(?!\s*\()/i.test(text)) return true;
  if (/^[ \t]*decision[ \t]*:[ \t]*changes_requested[ \t]*$/im.test(text)) return true;
  if (/\bchanges\s+requested\b/i.test(text)) return true;
  if (/\brequest(?:ed|s)?\s+changes\b/i.test(text)) return true;
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
  options: { prReviewerBotLogin?: string | null } = {},
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
      const reviewerRequest = !commentAuthorIsReviewerBot && hasPrReviewerRequestMention(commentBody);
      const reviewFeedback = isActionablePrReviewComment(
        commentBody,
        commentAuthorLogin,
        options.prReviewerBotLogin,
      );
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
      // ready_for_review (draft -> ready), synchronize (author pushed a
      // fixup after an earlier review), closed (merged or abandoned).
      //
      // synchronize fires once per push. We don't fan out one reviewer run per
      // push: active reviewer runs are coalesced by the PR-scoped task key, and
      // duplicate wake rows are skipped by a stable PR+reason idempotency
      // precheck. Both are head-sha- and delivery-independent for synchronize.
      // See shouldFirePrReviewerWake / buildPrReviewerTaskKey /
      // buildPrReviewerWakeIdempotencyKey.
      if (
        action !== "opened" &&
        action !== "reopened" &&
        action !== "ready_for_review" &&
        action !== "synchronize" &&
        action !== "closed"
      ) return null;
      const pr = payload.pull_request as Record<string, unknown> | undefined;
      const collected = collectFromPullRequest(pr);
      const reasonByAction: Record<string, string> = {
        opened: "github_pr_opened",
        reopened: "github_pr_reopened",
        ready_for_review: "github_pr_ready_for_review",
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
  action: "created" | "reintroduced" | "reopened";
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

function resolveDependabotAlertContext(
  payload: Record<string, unknown>,
): DependabotAlertContext | null {
  const action = payload.action as string | undefined;
  // created: brand-new advisory match; reintroduced: a previously-fixed alert
  // came back (regression); reopened: a human reversed a dismissal. The
  // terminal actions (fixed / dismissed / auto_dismissed) need no work.
  if (action !== "created" && action !== "reintroduced" && action !== "reopened") return null;
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

function shouldFirePrReviewerWake(context: ResolvedEventContext | null): context is ResolvedEventContext & { prNumber: number } {
  if (!context || !context.wakeReason || typeof context.prNumber !== "number") return false;
  return new Set([
    "github_pr_opened",
    "github_pr_reopened",
    "github_pr_ready_for_review",
    "github_pr_synchronized",
    "github_pr_review_requested",
    "github_pr_review_submitted",
  ]).has(context.wakeReason);
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
  // Every other reason, including github_pr_synchronized, keys on
  // repo+prNumber+reason alone. This deliberately omits head sha and delivery
  // id so the idempotency precheck can skip duplicate pending/completed wake
  // requests for the same PR+reason. Active run coalescing is controlled by
  // buildPrReviewerTaskKey plus enqueueWakeup's same-task-scope logic.
  const commentScopedSuffix =
    context.wakeReason === "github_pr_review_requested"
      ? `${context.wakeReason}:comment:${context.commentId ?? deliveryId ?? "unknown"}`
      : context.wakeReason;
  return `pr_review:${repo}:${context.prNumber}:${commentScopedSuffix}`;
}

function buildPrReviewerTaskKey(context: ResolvedEventContext & { prNumber: number }) {
  const repo = context.repoFullName ?? "unknown";
  return `pr_review:${repo}:${context.prNumber}`;
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

function buildChangesRequestedComment(context: ResolvedEventContext): string {
  const sourceUrl = context.eventUrl ?? context.reviewUrl ?? context.commentUrl ?? context.prUrl;
  const reviewer = prFeedbackAuthorLogin(context);
  const body = prFeedbackBody(context);
  const lines = [
    "## Changes Requested",
    "",
    "GitHub review feedback requires another implementation pass.",
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
          body: buildChangesRequestedComment(context),
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
  "completed",
  // BLO-14395: a wake that hit an unexpected dispatch failure is durably
  // tracked under these statuses (see wakeupWithDispatchRetry /
  // reconcileFailedWakeDispatches in heartbeat.ts) -- a redelivery or a fresh
  // re-mention with the same idempotency key should defer to that pending
  // retry/reconciliation rather than re-running the full dispatch path.
  "dispatch_failed",
  "dispatch_recovered",
  "dispatch_superseded",
  "dispatch_failed_exhausted",
];

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
    });

    // PR-review wake fires independently of the identifier-matching
    // issue-assignee wake below: it targets a dedicated reviewer agent so
    // PRs without a paperclip identifier in the branch/title/body still
    // get reviewed. We fire it once per delivery, only for the events
    // that should drive a review:
    //   - pull_request.opened          — new PR ready for first review
    //   - pull_request.reopened        — explicit retry / renewed review signal
    //   - pull_request.ready_for_review — draft promoted to ready
    //   - pull_request.synchronize     — author pushed a fixup after a review;
    //       active reviewer runs are coalesced by the stable PR-scoped taskKey,
    //       and duplicate wake requests are skipped by the PR+reason
    //       idempotency precheck, so rapid pushes don't fan out per push.
    //   - issue_comment.created with @ally — explicit operator re-review request
    //   - pull_request_review.submitted — request a counter-review pass
    // (We deliberately skip pull_request.closed and check_run/workflow_run —
    //  those are post-merge signals or duplicate the CI-completion path.)
    const reviewerWakeFired = await (async () => {
      if (!config.prReviewerAgentId) return false;
      if (!shouldFirePrReviewerWake(context)) return false;
      try {
        const heartbeat = heartbeatService(db, {
          pluginWorkerManager: config.pluginWorkerManager,
          ...config.heartbeatOptions,
        });
        const reviewerTaskKey = buildPrReviewerTaskKey(context);
        // taskKey scopes active-run coalescing; idempotencyKey scopes duplicate
        // request rows for the same PR+reason before enqueueing.
        const idempotencyKey = buildPrReviewerWakeIdempotencyKey(context, deliveryId);
        const existingWake = await db
          .select({ id: agentWakeupRequests.id })
          .from(agentWakeupRequests)
          .where(
            and(
              eq(agentWakeupRequests.agentId, config.prReviewerAgentId),
              eq(agentWakeupRequests.idempotencyKey, idempotencyKey),
              inArray(agentWakeupRequests.status, IDEMPOTENT_REVIEWER_WAKE_STATUSES),
            ),
          )
          .limit(1)
          .then((rows) => rows[0] ?? null);
        if (existingWake) return false;
        await heartbeat.wakeup(config.prReviewerAgentId, {
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
        });
        return true;
      } catch (err) {
        logger.error(
          {
            err,
            agentId: config.prReviewerAgentId,
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
    // to the delivery so a recurring regression can wake the agent again.
    const dependabotWakeFired = await (async () => {
      if (eventName !== "dependabot_alert" || !config.dependabotAgentId) return false;
      const alert = resolveDependabotAlertContext(payload);
      if (!alert) return false;
      const floor =
        DEPENDABOT_SEVERITY_RANK[config.dependabotMinSeverity ?? "high"] ?? DEPENDABOT_SEVERITY_RANK.high;
      if ((DEPENDABOT_SEVERITY_RANK[alert.severity] ?? -1) < floor) return false;
      const repository = payload.repository as Record<string, unknown> | undefined;
      const alertRepoFullName = (repository?.full_name as string | undefined) ?? null;
      const taskKey = `github-dependabot:${alertRepoFullName ?? "unknown"}#${alert.alertNumber}`;
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
          },
          contextSnapshot: {
            taskKey,
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

    // pull_request.synchronize is a reviewer-only signal. The reviewer wake
    // above is PR-scoped: active runs coalesce on taskKey, and duplicate request
    // rows are skipped by the idempotency precheck. The author-assignee wake
    // below is deliberately not driven by synchronize: the assignee is the one
    // who just pushed, so waking them per push would be redundant and would fan
    // out one author run per push. The author still gets woken by
    // check_run/workflow_run on terminal CI and by review-submitted/@ally
    // feedback, as before.
    const synchronizeReviewerOnly = context.wakeReason === "github_pr_synchronized";
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

    for (const issue of synchronizeReviewerOnly ? [] : matched) {
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
        const suffix =
          context.wakeReason === "github_pr_review_requested"
            ? `${context.wakeReason}:comment:${context.commentId ?? deliveryId ?? "unknown"}`
            : context.wakeReason;
        authorWakeIdempotencyKey = `pr_review_author:${issue.id}:${repo}:${prNumber}:${suffix}`;
        const existingPrAuthorWake = await db
          .select({ id: agentWakeupRequests.id })
          .from(agentWakeupRequests)
          .where(
            and(
              eq(agentWakeupRequests.agentId, effectiveAssigneeAgentId),
              eq(agentWakeupRequests.idempotencyKey, authorWakeIdempotencyKey),
              inArray(agentWakeupRequests.status, IDEMPOTENT_REVIEWER_WAKE_STATUSES),
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
      ...(backLinked.length ? { backLinked } : {}),
      ...(escalated.length ? { escalated } : {}),
    });
  });

  return router;
}

// Test-only re-exports.
export const __test_extractPaperclipIdentifiers = extractPaperclipIdentifiers;
export const __test_hasPrReviewerRequestMention = hasPrReviewerRequestMention;
export const __test_verifyGithubSignature = verifyGithubSignature;
export const __test_resolveEventContext = resolveEventContext;
export const __test_shouldFirePrReviewerWake = shouldFirePrReviewerWake;
export const __test_buildPrReviewerWakeIdempotencyKey = buildPrReviewerWakeIdempotencyKey;
export const __test_buildPrReviewerTaskKey = buildPrReviewerTaskKey;
export const __test_resolveDependabotAlertContext = resolveDependabotAlertContext;
export const __test_hasActionablePrReviewFeedback = hasActionablePrReviewFeedback;
export const __test_buildIssueBackLinkBody = buildIssueBackLinkBody;
export const __test_commentsContainBackLinkMarker = commentsContainBackLinkMarker;
export const __test_backLinkAbsoluteUrl = backLinkAbsoluteUrl;
export const __test_isSelfReviewedPr = isSelfReviewedPr;
