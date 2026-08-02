/**
 * Tests for the GitHub webhook receiver. Two layers:
 *   - Pure functions (identifier extraction, signature verification,
 *     event-context resolution) — no DB.
 *   - Full route integration (Express handler + DB + heartbeat wake).
 */
import { randomUUID } from "node:crypto";
import crypto from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issues,
  issueWorkProducts,
} from "@paperclipai/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  __test_backLinkAbsoluteUrl,
  __test_buildDependabotAlertIssueBody,
  __test_buildIssueBackLinkBody,
  __test_buildPrReviewerTaskKey,
  __test_buildPrReviewerWakeIdempotencyKey,
  __test_buildPrReviewFeedbackComment,
  __test_commentsContainBackLinkMarker,
  __test_extractPaperclipIdentifiers,
  __test_hasActionablePrReviewFeedback,
  __test_isReviewerSelfEchoReview,
  __test_isSelfReviewedPr,
  __test_hasPrReviewerRequestMention,
  __test_hasPrReviewerAgentRequestMarker,
  __test_hasAllyConsolidatedReviewHeading,
  __test_hasAllyConsolidatedReviewHeader,
  __test_idempotentWakeStatuses,
  __test_prReviewerWakeIdempotencyScope,
  __test_resolveDependabotAlertContext,
  __test_resolveEventContext,
  __test_shouldFirePrReviewerWake,
  __test_verifyGithubSignature,
  githubWebhookRoutes,
  type GithubWebhookConfig,
} from "../routes/github-webhook.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  GITHUB_REVIEW_REQUEST_DELIVERY_METRIC,
  GITHUB_REVIEW_REQUEST_SUPPRESSION_METRIC,
  __resetMetricsForTest,
  getMetricsRegistry,
} from "../services/metrics.js";

/**
 * Sum {@link GITHUB_REVIEW_REQUEST_DELIVERY_METRIC} across every `reason`
 * series for one funnel state (BLO-18859).
 */
async function deliveryCount(state: string): Promise<number> {
  const metric = getMetricsRegistry().getSingleMetric(GITHUB_REVIEW_REQUEST_DELIVERY_METRIC);
  if (!metric) throw new Error(`${GITHUB_REVIEW_REQUEST_DELIVERY_METRIC} is not registered`);
  const data = (await metric.get()) as {
    values: Array<{ labels: Record<string, string>; value: number }>;
  };
  return data.values
    .filter((entry) => entry.labels.state === state)
    .reduce((sum, entry) => sum + entry.value, 0);
}

/**
 * Sum {@link GITHUB_REVIEW_REQUEST_SUPPRESSION_METRIC} for one suppression
 * cause, or across all causes when omitted (BLO-18859 review follow-up).
 */
async function suppressionCount(cause?: string): Promise<number> {
  const metric = getMetricsRegistry().getSingleMetric(GITHUB_REVIEW_REQUEST_SUPPRESSION_METRIC);
  if (!metric) throw new Error(`${GITHUB_REVIEW_REQUEST_SUPPRESSION_METRIC} is not registered`);
  const data = (await metric.get()) as {
    values: Array<{ labels: Record<string, string>; value: number }>;
  };
  return data.values
    .filter((entry) => cause === undefined || entry.labels.cause === cause)
    .reduce((sum, entry) => sum + entry.value, 0);
}

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping GitHub webhook tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describe("github-webhook pure helpers", () => {
  it("extracts paperclip identifiers from branch / title / body", () => {
    expect(__test_extractPaperclipIdentifiers("fix/BLO-3182-webflow-blog")).toEqual(["BLO-3182"]);
    expect(__test_extractPaperclipIdentifiers(null, "Fix BLO-3182: missing handler", undefined)).toEqual(["BLO-3182"]);
    // Multiple in body, deduped.
    expect(__test_extractPaperclipIdentifiers("Closes BLO-3182 and PCL-44")).toEqual(["BLO-3182", "PCL-44"]);
    expect(__test_extractPaperclipIdentifiers("Closes BLO-3182/3183 and PC1A2-7/8")).toEqual([
      "BLO-3182",
      "BLO-3183",
      "PC1A2-7",
      "PC1A2-8",
    ]);
    // 4-letter prefixes match (XBLO is itself a valid identifier shape;
    // paperclip company prefixes can be 2-10 letters). The lookup
    // against issues.identifier disambiguates -- only real prefixes
    // turn into wakes.
    expect(__test_extractPaperclipIdentifiers("XBLO-3182")).toEqual(["XBLO-3182"]);
    // But mid-word matches don't fire.
    expect(__test_extractPaperclipIdentifiers("frontend-X-44")).toEqual([]);
    // Punctuation around match is fine.
    expect(__test_extractPaperclipIdentifiers("(BLO-3182): work")).toEqual(["BLO-3182"]);
  });

  it("rejects payloads with bad signatures and accepts ones with good signatures", () => {
    const secret = "test-webhook-secret-do-not-use-in-prod";
    const body = Buffer.from(JSON.stringify({ action: "completed" }), "utf8");
    const goodSig =
      "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");
    expect(__test_verifyGithubSignature(body, goodSig, secret)).toBe(true);
    expect(__test_verifyGithubSignature(body, "sha256=deadbeef", secret)).toBe(false);
    expect(__test_verifyGithubSignature(body, undefined, secret)).toBe(false);
    expect(__test_verifyGithubSignature(body, "sha1=" + goodSig.slice(7), secret)).toBe(false);
  });

  it("resolves wake context from a check_run.completed payload with PR head_branch", () => {
    const ctx = __test_resolveEventContext("check_run", {
      action: "completed",
      check_run: {
        head_branch: "fix/BLO-3182-webflow-blog",
        head_sha: "abc123",
        html_url: "https://github.com/Blockcast/paperclip/actions/runs/1/job/2",
        pull_requests: [{ number: 117, head: { ref: "fix/BLO-3182-webflow-blog" } }],
      },
      repository: { full_name: "Blockcast/paperclip" },
    });
    expect(ctx).toMatchObject({
      identifiers: ["BLO-3182"],
      wakeReason: "github_check_completed",
      prNumber: 117,
      repoFullName: "Blockcast/paperclip",
      prUrl: "https://github.com/Blockcast/paperclip/pull/117",
      eventUrl: "https://github.com/Blockcast/paperclip/actions/runs/1/job/2",
      headSha: "abc123",
    });
  });

  it("ignores non-completed check_run actions", () => {
    expect(
      __test_resolveEventContext("check_run", {
        action: "created",
        check_run: { head_branch: "fix/BLO-3182" },
      }),
    ).toBeNull();
  });

  it("resolves pull_request synchronize with PR-scoped task keys and delivery-scoped idempotency", () => {
    const ctx1 = __test_resolveEventContext("pull_request", {
      action: "synchronize",
      pull_request: {
        number: 318,
        title: "Fix BLO-3182 webflow blog",
        body: null,
        html_url: "https://github.com/Blockcast/paperclip/pull/318",
        head: { ref: "fix/BLO-3182", sha: "push2sha" },
      },
      repository: { full_name: "Blockcast/paperclip" },
    });
    const ctx2 = __test_resolveEventContext("pull_request", {
      action: "synchronize",
      pull_request: {
        number: 318,
        title: "Fix BLO-3182 webflow blog",
        body: null,
        html_url: "https://github.com/Blockcast/paperclip/pull/318",
        head: { ref: "fix/BLO-3182", sha: "push3sha" },
      },
      repository: { full_name: "Blockcast/paperclip" },
    });
    expect(ctx1).toMatchObject({
      identifiers: ["BLO-3182"],
      wakeReason: "github_pr_synchronized",
      prNumber: 318,
      repoFullName: "Blockcast/paperclip",
      headSha: "push2sha",
    });
    expect(ctx2).toMatchObject({
      wakeReason: "github_pr_synchronized",
      prNumber: 318,
      headSha: "push3sha",
    });
    expect(__test_shouldFirePrReviewerWake(ctx1)).toBe(true);
    expect(__test_shouldFirePrReviewerWake(ctx2)).toBe(true);
    if (!__test_shouldFirePrReviewerWake(ctx1) || !__test_shouldFirePrReviewerWake(ctx2)) {
      throw new Error("expected synchronize pull_request contexts with PR numbers");
    }
    // taskKey controls reviewer affinity and queued-run coalescing. The
    // idempotency key is delivery-scoped so a coalesced push cannot poison
    // every future synchronize event for the PR.
    expect(__test_buildPrReviewerTaskKey(ctx1)).toBe("pr_review:Blockcast/paperclip:318");
    expect(__test_buildPrReviewerTaskKey(ctx2)).toBe(__test_buildPrReviewerTaskKey(ctx1));
    expect(__test_buildPrReviewerWakeIdempotencyKey(ctx1, "delivery-push-2")).toBe(
      "pr_review:Blockcast/paperclip:318:github_pr_synchronized:delivery:delivery-push-2",
    );
    expect(__test_buildPrReviewerWakeIdempotencyKey(ctx2, "delivery-push-3")).toBe(
      "pr_review:Blockcast/paperclip:318:github_pr_synchronized:delivery:delivery-push-3",
    );
  });

  it("scopes terminal-status idempotency to request-scoped keys only (BLO-18953)", () => {
    const requestScoped = (action: string, reason: string) => {
      const ctx = __test_resolveEventContext("pull_request", {
        action,
        pull_request: {
          number: 991,
          title: "Fix BLO-3182 webflow blog",
          body: null,
          draft: false,
          html_url: "https://github.com/Blockcast/magma/pull/991",
          head: { ref: "fix/BLO-3182-webflow-blog", sha: "readysha" },
        },
        repository: { full_name: "Blockcast/magma" },
      });
      expect(ctx?.wakeReason).toBe(reason);
      return ctx as NonNullable<typeof ctx>;
    };

    // Delivery-scoped: the key can only recur as a redelivery, so a terminal
    // completed/cancelled row must dedup it.
    for (const [action, reason] of [
      ["ready_for_review", "github_pr_ready_for_review"],
      ["synchronize", "github_pr_synchronized"],
    ] as const) {
      const ctx = requestScoped(action, reason);
      expect(__test_prReviewerWakeIdempotencyScope(ctx, "delivery-1")).toBe("request");
    }

    // Stable PR+reason keys keep the original exclusion: a NEW event reuses the
    // key, so terminal statuses must not block it.
    const opened = requestScoped("opened", "github_pr_opened");
    expect(__test_prReviewerWakeIdempotencyScope(opened, "delivery-1")).toBe("stable");

    // A suffix with no per-event identity at all cannot distinguish two
    // distinct events, so it must NOT get the terminal-dedup rule.
    const noIdentity = requestScoped("ready_for_review", "github_pr_ready_for_review");
    expect(__test_prReviewerWakeIdempotencyScope(noIdentity, null)).toBe("stable");

    expect(__test_idempotentWakeStatuses("stable")).not.toContain("completed");
    expect(__test_idempotentWakeStatuses("stable")).not.toContain("cancelled");
    expect(__test_idempotentWakeStatuses("request")).toEqual(
      expect.arrayContaining(["completed", "cancelled", "queued", "running", "coalesced"]),
    );
    // A wake that never produced a review still deserves a fresh attempt.
    expect(__test_idempotentWakeStatuses("request")).not.toContain("failed");
    expect(__test_idempotentWakeStatuses("request")).not.toContain("dispatch_failed_exhausted");
  });

  it("does not build reviewer debounce keys for malformed PR contexts without a PR number", () => {
    const ctx = __test_resolveEventContext("pull_request", {
      action: "synchronize",
      pull_request: {
        title: "No paperclip link",
        body: null,
        html_url: "https://github.com/Blockcast/paperclip/pull/318",
        head: { ref: "refresh/no-identifier", sha: "push2sha" },
      },
      repository: { full_name: "Blockcast/paperclip" },
    });
    expect(ctx).toMatchObject({
      identifiers: [],
      wakeReason: "github_pr_synchronized",
      prNumber: null,
      repoFullName: "Blockcast/paperclip",
    });
    expect(__test_shouldFirePrReviewerWake(ctx)).toBe(false);
    expect(() => __test_buildPrReviewerWakeIdempotencyKey(ctx as never, "delivery-push-2")).toThrow(
      "PR reviewer wake idempotency key requires prNumber",
    );
  });

  it("resolves a wake reason for pull_request opened", () => {
    const ctx = __test_resolveEventContext("pull_request", {
      action: "opened",
      pull_request: {
        number: 200,
        title: "Fix BLO-3182 webflow blog",
        body: null,
        html_url: "https://github.com/Blockcast/paperclip/pull/200",
        head: { ref: "feat/BLO-3182", sha: "def456" },
      },
      repository: { full_name: "Blockcast/paperclip" },
    });
    expect(ctx).toMatchObject({
      identifiers: ["BLO-3182"],
      wakeReason: "github_pr_opened",
      prNumber: 200,
      prTitle: "Fix BLO-3182 webflow blog",
      prUrl: "https://github.com/Blockcast/paperclip/pull/200",
      eventUrl: "https://github.com/Blockcast/paperclip/pull/200",
      headSha: "def456",
    });
  });

  it("waits for ready_for_review before waking the reviewer for a draft PR", () => {
    const openedDraft = __test_resolveEventContext("pull_request", {
      action: "opened",
      pull_request: {
        number: 201,
        title: "Draft queue work",
        draft: true,
        html_url: "https://github.com/Blockcast/paperclip/pull/201",
        head: { ref: "draft/reviewer-queue", sha: "draft-sha" },
      },
      repository: { full_name: "Blockcast/paperclip" },
    });
    const ready = __test_resolveEventContext("pull_request", {
      action: "ready_for_review",
      pull_request: {
        number: 201,
        title: "Draft queue work",
        draft: false,
        html_url: "https://github.com/Blockcast/paperclip/pull/201",
        head: { ref: "draft/reviewer-queue", sha: "ready-sha" },
      },
      repository: { full_name: "Blockcast/paperclip" },
    });
    const converted = __test_resolveEventContext("pull_request", {
      action: "converted_to_draft",
      pull_request: {
        number: 201,
        title: "Draft queue work",
        draft: true,
        html_url: "https://github.com/Blockcast/paperclip/pull/201",
        head: { ref: "draft/reviewer-queue", sha: "draft-again-sha" },
      },
      repository: { full_name: "Blockcast/paperclip" },
    });

    expect(openedDraft).toMatchObject({ prDraft: true, wakeReason: "github_pr_opened" });
    expect(__test_shouldFirePrReviewerWake(openedDraft)).toBe(false);
    expect(ready).toMatchObject({ prDraft: false, wakeReason: "github_pr_ready_for_review" });
    expect(__test_shouldFirePrReviewerWake(ready)).toBe(true);
    expect(converted).toMatchObject({
      prDraft: true,
      wakeReason: "github_pr_converted_to_draft",
    });
    expect(__test_shouldFirePrReviewerWake(converted)).toBe(false);
  });

  it("scopes the ready_for_review idempotency key to the delivery so every toggle is a fresh request (BLO-18953)", () => {
    const readyAt = (sha: string) =>
      __test_resolveEventContext("pull_request", {
        action: "ready_for_review",
        pull_request: {
          number: 822,
          title: "Anchor review marker at byte 0",
          draft: false,
          html_url: "https://github.com/Blockcast/paperclip/pull/822",
          head: { ref: "cto/blo-18865", sha },
        },
        repository: { full_name: "Blockcast/paperclip" },
      });

    const firstToggle = readyAt("ea8697d1");
    const secondToggle = readyAt("3f6db574");
    if (
      !__test_shouldFirePrReviewerWake(firstToggle) ||
      !__test_shouldFirePrReviewerWake(secondToggle)
    ) {
      throw new Error("expected ready_for_review contexts to fire a reviewer wake");
    }

    // Keyed on repo+pr+reason alone, the first toggle's wake row — which lands
    // on the terminal `coalesced` status, an IDEMPOTENT_REVIEWER_WAKE_STATUS —
    // blocked every later toggle on the PR forever. Delivery scoping keeps each
    // deliberate draft->ready transition its own request.
    expect(__test_buildPrReviewerWakeIdempotencyKey(firstToggle, "delivery-ready-1")).toBe(
      "pr_review:Blockcast/paperclip:822:github_pr_ready_for_review:delivery:delivery-ready-1",
    );
    expect(__test_buildPrReviewerWakeIdempotencyKey(secondToggle, "delivery-ready-2")).not.toBe(
      __test_buildPrReviewerWakeIdempotencyKey(firstToggle, "delivery-ready-1"),
    );

    // A GitHub redelivery reuses the delivery id, so genuine retries still dedup.
    expect(__test_buildPrReviewerWakeIdempotencyKey(secondToggle, "delivery-ready-2")).toBe(
      __test_buildPrReviewerWakeIdempotencyKey(secondToggle, "delivery-ready-2"),
    );

    // The task key stays PR-scoped: it also scopes reviewer affinity, the task
    // lock, and the cancel-on-close sweep.
    expect(__test_buildPrReviewerTaskKey(secondToggle)).toBe(
      __test_buildPrReviewerTaskKey(firstToggle),
    );
  });

  it("extracts the PR author login from pull_request.opened for the self-review-skip gate (BLO-9293)", () => {
    const ctx = __test_resolveEventContext("pull_request", {
      action: "opened",
      pull_request: {
        number: 235,
        title: "Fix BLO-9293",
        body: null,
        html_url: "https://github.com/Blockcast/Network-Operator-Portal/pull/235",
        head: { ref: "fix/BLO-9293", sha: "9f3ac21" },
        user: { login: "allyblockcast[bot]" },
      },
      repository: { full_name: "Blockcast/Network-Operator-Portal" },
    });
    expect(ctx).toMatchObject({
      wakeReason: "github_pr_opened",
      prNumber: 235,
      prAuthorLogin: "allyblockcast[bot]",
    });
  });

  it("resolves pull_request reopened as a reviewer wake signal (BLO-7426)", () => {
    const ctx = __test_resolveEventContext("pull_request", {
      action: "reopened",
      pull_request: {
        number: 980,
        title: "Retry review for BLO-7426",
        body: null,
        head: { ref: "fix/BLO-7426-reopen-wake" },
      },
      repository: { full_name: "Blockcast/magma" },
    });
    expect(ctx).toMatchObject({
      identifiers: ["BLO-7426"],
      wakeReason: "github_pr_reopened",
      prNumber: 980,
      repoFullName: "Blockcast/magma",
    });
    expect(__test_shouldFirePrReviewerWake(ctx)).toBe(true);
    if (!ctx || !ctx.prNumber) {
      throw new Error("expected reopened pull_request context with PR number");
    }
    // @ts-expect-error – test fixture omits the prNumber field required by the narrow union
    expect(__test_buildPrReviewerWakeIdempotencyKey(ctx, "delivery-reopened")).toBe(
      "pr_review:Blockcast/magma:980:github_pr_reopened",
    );
  });

  it("treats @ally in a PR comment as an explicit reviewer wake request", () => {
    expect(__test_hasPrReviewerRequestMention("@ally re-review please")).toBe(true);
    expect(__test_hasPrReviewerRequestMention("cc @Ally after the fix")).toBe(true);
    expect(__test_hasPrReviewerRequestMention("@blockcast-ci-packages re-review please")).toBe(true);
    expect(__test_hasPrReviewerRequestMention("@allyblockcast please review")).toBe(true);
    expect(__test_hasPrReviewerRequestMention("cc @AllyBlockcast after the fix")).toBe(true);
    expect(__test_hasPrReviewerRequestMention("ally should not match without the tag")).toBe(false);
    expect(__test_hasPrReviewerRequestMention("email me at ops@ally.example")).toBe(false);

    const ctx = __test_resolveEventContext("issue_comment", {
      action: "created",
      issue: {
        number: 47,
        title: "BLO-6000 migrate auth",
        body: null,
        html_url: "https://github.com/Blockcast/Network-Operator-Portal/pull/47",
        pull_request: { url: "https://api.github.com/repos/Blockcast/Network-Operator-Portal/pulls/47" },
      },
      comment: {
        id: 123456,
        body: "@ally re-review requested. Auth branch is refreshed and Docker builder passed.",
        html_url: "https://github.com/Blockcast/Network-Operator-Portal/pull/47#issuecomment-123456",
        user: { login: "kkroo" },
      },
      repository: { full_name: "Blockcast/Network-Operator-Portal" },
    });

    expect(ctx).toMatchObject({
      identifiers: ["BLO-6000"],
      wakeReason: "github_pr_review_requested",
      prNumber: 47,
      repoFullName: "Blockcast/Network-Operator-Portal",
      commentId: 123456,
      commentAuthorLogin: "kkroo",
      commentBody: "@ally re-review requested. Auth branch is refreshed and Docker builder passed.",
      prUrl: "https://github.com/Blockcast/Network-Operator-Portal/pull/47",
      eventUrl: "https://github.com/Blockcast/Network-Operator-Portal/pull/47#issuecomment-123456",
      commentUrl: "https://github.com/Blockcast/Network-Operator-Portal/pull/47#issuecomment-123456",
    });
    if (!__test_shouldFirePrReviewerWake(ctx)) {
      throw new Error("expected @ally PR comment to fire a reviewer wake");
    }
    expect(__test_buildPrReviewerTaskKey(ctx)).toBe(
      "pr_review:Blockcast/Network-Operator-Portal:47",
    );
    expect(__test_buildPrReviewerWakeIdempotencyKey(ctx, "delivery-1")).toBe(
      "pr_review:Blockcast/Network-Operator-Portal:47:github_pr_review_requested:comment:123456",
    );
  });

  it("does not treat the reviewer bot's own comment as a review request, even when it mentions its own alias (BLO-13247 follow-up)", () => {
    // Observed live on Blockcast/paperclip#583: a template-completion nudge
    // that greets the bot by its own handle in the salutation, and
    // separately the bot's own explanatory reply quoting the alias as a
    // backtick-quoted example, each re-fired github_pr_review_requested --
    // an indefinite self-perpetuating loop on any bot-authored PR that gets
    // an automated reply mentioning the bot by name.
    expect(
      __test_resolveEventContext("issue_comment", {
        action: "created",
        issue: {
          number: 583,
          title: "BLO-13247 precheck idempotency key",
          pull_request: { url: "https://api.github.com/repos/Blockcast/paperclip/pulls/583" },
        },
        comment: {
          id: 1,
          body: "Hey @allyblockcast[bot]! Before this PR can be reviewed...",
          user: { login: "allyblockcast[bot]" },
        },
        repository: { full_name: "Blockcast/paperclip" },
      }),
    ).toBeNull();

    expect(
      __test_resolveEventContext("issue_comment", {
        action: "created",
        issue: {
          number: 583,
          title: "BLO-13247 precheck idempotency key",
          pull_request: { url: "https://api.github.com/repos/Blockcast/paperclip/pulls/583" },
        },
        comment: {
          id: 2,
          body: "The comment-scoped suffix is `comment:${commentId}`, so a later distinct `@ally` comment still wakes the author.",
          user: { login: "allyblockcast[bot]" },
        },
        repository: { full_name: "Blockcast/paperclip" },
      }),
    ).toBeNull();

    // Sanity check: the same body from a DIFFERENT author still fires the
    // reviewer-request wake -- this guard is author-scoped, not a
    // body-content change.
    const fromHuman = __test_resolveEventContext("issue_comment", {
      action: "created",
      issue: {
        number: 583,
        title: "BLO-13247 precheck idempotency key",
        pull_request: { url: "https://api.github.com/repos/Blockcast/paperclip/pulls/583" },
      },
      comment: {
        id: 3,
        body: "Hey @allyblockcast[bot]! Before this PR can be reviewed...",
        user: { login: "kkroo" },
      },
      repository: { full_name: "Blockcast/paperclip" },
    });
    expect(fromHuman).toMatchObject({ wakeReason: "github_pr_review_requested" });
  });

  it("treats a marker-prefixed reviewer-bot comment as an AGENT review request (BLO-18865)", () => {
    // Agents post PR comments through the Paperclip GitHub App, so the author
    // login is allyblockcast[bot] -- Ally's own identity. Before BLO-18865 the
    // author-scoped guard dropped every agent-issued @ally request, leaving
    // agents with no comment-based and no push-based way to get a re-review
    // (Blockcast/paperclip#814: two pushes + two @ally comments, nothing in
    // 2h19m). The explicit start-of-body marker restores that path.
    const agentRequest = __test_resolveEventContext("issue_comment", {
      action: "created",
      issue: {
        number: 814,
        title: "BLO-18797 creator + manager-chain issue authz",
        html_url: "https://github.com/Blockcast/paperclip/pull/814",
        pull_request: { url: "https://api.github.com/repos/Blockcast/paperclip/pulls/814" },
      },
      comment: {
        id: 4900000001,
        body: "<!-- paperclip:review-request -->\n@ally please re-review at head 2e6a1b71 — the active-run guard is restored.",
        html_url: "https://github.com/Blockcast/paperclip/pull/814#issuecomment-4900000001",
        user: { login: "allyblockcast[bot]" },
      },
      repository: { full_name: "Blockcast/paperclip" },
    });
    expect(agentRequest).toMatchObject({
      wakeReason: "github_pr_review_requested",
      prNumber: 814,
      commentAuthorLogin: "allyblockcast[bot]",
    });
    if (!__test_shouldFirePrReviewerWake(agentRequest)) {
      throw new Error("expected a marker-prefixed agent request to fire a reviewer wake");
    }
    // Comment-scoped idempotency: each distinct request comment gets its own
    // wake, so a later re-review request at a newer head is not swallowed.
    expect(__test_buildPrReviewerWakeIdempotencyKey(agentRequest, "delivery-agent-req")).toBe(
      "pr_review:Blockcast/paperclip:814:github_pr_review_requested:comment:4900000001",
    );

    // Marker may carry provenance attributes. It must still start at byte 0.
    const withAttributes = __test_resolveEventContext("issue_comment", {
      action: "created",
      issue: {
        number: 814,
        title: "BLO-18797 creator + manager-chain issue authz",
        pull_request: { url: "https://api.github.com/repos/Blockcast/paperclip/pulls/814" },
      },
      comment: {
        id: 4900000002,
        body: "<!--  paperclip:review-request agent=cto issue=BLO-18865  -->\nRe-review please, @ally.",
        user: { login: "allyblockcast[bot]" },
      },
      repository: { full_name: "Blockcast/paperclip" },
    });
    expect(withAttributes).toMatchObject({ wakeReason: "github_pr_review_requested" });
  });

  it("classifies agent and human review requests identically once the marker is present (BLO-18865)", () => {
    const request = (login: string, body: string) =>
      __test_resolveEventContext("issue_comment", {
        action: "created",
        issue: {
          number: 820,
          title: "BLO-18865 agent review requests",
          pull_request: { url: "https://api.github.com/repos/Blockcast/paperclip/pulls/820" },
        },
        comment: { id: 77, body, user: { login } },
        repository: { full_name: "Blockcast/paperclip" },
      });

    // The marker is an authorization to *fire the reviewer wake* -- nothing
    // more. It rides the shared Paperclip GitHub App identity, so it proves
    // no requester identity and the resolved context carries no
    // agent-vs-human discriminator for downstream code to branch on. An agent
    // request is therefore shaped exactly like a human one; in particular the
    // author wake is preserved for both (see suppressAuthorWake).
    const fromAgent = request(
      "allyblockcast[bot]",
      "<!-- paperclip:review-request -->\n@ally re-review please",
    );
    const fromHumanRequest = request("kkroo", "@ally re-review please");
    expect(fromAgent).toMatchObject({ wakeReason: "github_pr_review_requested" });
    expect(fromHumanRequest).toMatchObject({ wakeReason: "github_pr_review_requested" });
    expect(fromAgent).not.toHaveProperty("agentReviewRequest");
    expect(fromHumanRequest).not.toHaveProperty("agentReviewRequest");
  });

  it("reports a markerless reviewer-bot @ally request instead of dropping it silently (BLO-18273)", () => {
    // The markerless drop is the failure mode BLO-18273 was filed for: the
    // request is recognized as one, suppressed by the author guard, and leaves
    // NO trace -- so the requesting agent ends its run believing it handed off
    // and the PR waits forever. resolveEventContext still returns null (the
    // #583 loop must stay closed); it now reports the drop on the way out.
    const resolve = (body: string, login: string) => {
      const suppressed: unknown[] = [];
      const context = __test_resolveEventContext(
        "issue_comment",
        {
          action: "created",
          issue: {
            number: 1659,
            title: "BLO-18157 platform-sre backup RBAC",
            pull_request: { url: "https://api.github.com/repos/Blockcast/onprem-k8s/pulls/1659" },
          },
          comment: {
            id: 7001,
            body,
            user: { login },
            html_url: "https://github.com/Blockcast/onprem-k8s/pull/1659#issuecomment-7001",
          },
          repository: { full_name: "Blockcast/onprem-k8s" },
        },
        {
          prReviewerBotLogin: "allyblockcast[bot]",
          onSuppressedReviewRequest: (info) => suppressed.push(info),
        },
      );
      return { context, suppressed };
    };

    // The lost handoff: bot login, real ask, no marker.
    const dropped = resolve("@ally please review the RBAC scoping", "allyblockcast[bot]");
    expect(dropped.context).toBeNull();
    expect(dropped.suppressed).toHaveLength(1);
    expect(dropped.suppressed[0]).toMatchObject({
      repoFullName: "Blockcast/onprem-k8s",
      prNumber: 1659,
      commentId: 7001,
      commentAuthorLogin: "allyblockcast[bot]",
      commentUrl: "https://github.com/Blockcast/onprem-k8s/pull/1659#issuecomment-7001",
    });

    // With the marker it is a real request, so there is nothing to report.
    const honoured = resolve(
      "<!-- paperclip:review-request -->\n@ally please review the RBAC scoping",
      "allyblockcast[bot]",
    );
    expect(honoured.context).toMatchObject({ wakeReason: "github_pr_review_requested" });
    expect(honoured.suppressed).toHaveLength(0);

    // Ally's OWN output mentioning the alias is a correct suppression, not a
    // lost handoff. Reporting it would bury the real signal in #583-shaped
    // noise on every review Ally posts, so it must stay quiet.
    const selfEcho = resolve(
      "## Ally — Consolidated PR Review\n\nNo blocking findings; @ally ran 3 lenses.",
      "allyblockcast[bot]",
    );
    expect(selfEcho.context).toBeNull();
    expect(selfEcho.suppressed).toHaveLength(0);

    // The commitperclip template gate greets the bot by its LOGIN, not the
    // alias, and does so repeatedly on the same PR (a 2026-07-31 sweep found 7
    // on Blockcast/paperclip#812, 3 on #820). This is the original #583 body:
    // suppressing it is correct, so it must not be reported or the real signal
    // drowns. This is the case that decides bare-alias vs general mention.
    const gateNudge = resolve(
      "Hey @allyblockcast[bot]! Before this PR can be reviewed, a few things need attention:\n\n" +
        "**Missing or incomplete:**\n- [ ] Missing section: **## Thinking Path**\n",
      "allyblockcast[bot]",
    );
    expect(gateNudge.context).toBeNull();
    expect(gateNudge.suppressed).toHaveLength(0);

    // A human's markerless @ally was never suppressed, so it is not reported.
    const human = resolve("@ally please review the RBAC scoping", "kkroo");
    expect(human.context).toMatchObject({ wakeReason: "github_pr_review_requested" });
    expect(human.suppressed).toHaveLength(0);
  });

  it("keeps the #583 self-refire loop closed: a quoted or reviewer-output marker is not a request (BLO-18865)", () => {
    const botComment = (id: number, body: string) =>
      __test_resolveEventContext("issue_comment", {
        action: "created",
        issue: {
          number: 583,
          title: "BLO-13247 precheck idempotency key",
          pull_request: { url: "https://api.github.com/repos/Blockcast/paperclip/pulls/583" },
        },
        comment: { id, body, user: { login: "allyblockcast[bot]" } },
        repository: { full_name: "Blockcast/paperclip" },
      });

    // The #583 loop was driven by bot-authored bodies mentioning the alias
    // SOMEWHERE. The marker is anchored to offset 0, so Ally quoting the
    // marker back while explaining the request it is answering cannot re-arm
    // the trigger -- this is the case that would relight the loop.
    expect(
      botComment(
        10,
        "Thanks — for future runs, prefix the comment with `<!-- paperclip:review-request -->` and mention @ally.",
      ),
    ).toBeNull();

    // A fenced/indented marker is likewise mid-body, not a request.
    expect(botComment(11, "Example:\n\n    <!-- paperclip:review-request -->\n    @ally review\n")).toBeNull();

    // ...and the same example with NOTHING before it. Four leading spaces is a
    // Markdown indented code block -- the canonical way a reviewer renders
    // "here is the marker to use" -- so this is a quoted example too, but it
    // is the one an offset-0-modulo-whitespace anchor would misread as a real
    // request. Each such comment would mint a fresh comment-scoped
    // idempotency key, so nothing downstream would dedup the refire. This is
    // the #583 loop; the anchor is at literal byte 0 to keep it closed.
    expect(botComment(14, "    <!-- paperclip:review-request -->\n    @ally review\n")).toBeNull();
    expect(botComment(15, "\n<!-- paperclip:review-request -->\n@ally review\n")).toBeNull();
    expect(botComment(16, "> <!-- paperclip:review-request -->\n> @ally review\n")).toBeNull();

    // Even at offset 0, Ally's own review output is never a request: the
    // consolidated-review header disqualifies it regardless of the marker.
    expect(
      botComment(
        12,
        "<!-- paperclip:review-request -->\n## Ally — Consolidated PR Review\n\nSee findings below; @ally ran 3 lenses.",
      ),
    ).toBeNull();

    // And the original #583 bodies stay suppressed (no marker at all).
    expect(botComment(13, "Hey @allyblockcast[bot]! Before this PR can be reviewed...")).toBeNull();

    // ...but a real request that merely REFERS to a past review in prose is
    // still a request. The exclusion keys on Ally's own output shape (the
    // header on its own line), not on the phrase appearing anywhere, so
    // citing the review as context does not silently drop the ask.
    expect(
      botComment(
        17,
        "<!-- paperclip:review-request -->\n@ally re-review at head abc123 — your earlier Ally — Consolidated PR Review flagged the vault probe; that is fixed now.",
      ),
    ).not.toBeNull();

    // A quoted copy of the header is likewise context, not Ally's output.
    expect(
      botComment(
        18,
        "<!-- paperclip:review-request -->\n@ally re-review at head abc123. For context:\n\n> ## Ally — Consolidated PR Review\n> Fix I1 before merge.\n",
      ),
    ).not.toBeNull();
  });

  it("scopes the consolidated-review exclusion to Ally's own output shape (BLO-18865)", () => {
    // Ally's actual review opens with the header as a Markdown heading.
    expect(__test_hasAllyConsolidatedReviewHeading("## Ally — Consolidated PR Review\n\nFindings...")).toBe(true);
    expect(__test_hasAllyConsolidatedReviewHeading("# Ally - Consolidated PR Review")).toBe(true);
    expect(__test_hasAllyConsolidatedReviewHeading("###### Ally: Consolidated PR Review")).toBe(true);
    // Bold and bare-line variants stay excluded so a format change on Ally's
    // side cannot silently lapse this layer.
    expect(__test_hasAllyConsolidatedReviewHeading("**Ally — Consolidated PR Review**")).toBe(true);
    expect(__test_hasAllyConsolidatedReviewHeading("Ally — Consolidated PR Review\n\nFindings...")).toBe(true);
    // Still catches Ally echoing the marker at byte 0 -- the #583 layer.
    expect(
      __test_hasAllyConsolidatedReviewHeading(
        "<!-- paperclip:review-request -->\n## Ally — Consolidated PR Review\n\n@ally ran 3 lenses.",
      ),
    ).toBe(true);

    // A mid-line prose reference is a citation, not Ally's output.
    expect(
      __test_hasAllyConsolidatedReviewHeading("@ally re-review — your Ally — Consolidated PR Review flagged X"),
    ).toBe(false);
    // A blockquoted or indented copy is a quote, not Ally's output.
    expect(__test_hasAllyConsolidatedReviewHeading("> ## Ally — Consolidated PR Review")).toBe(false);
    expect(__test_hasAllyConsolidatedReviewHeading("    ## Ally — Consolidated PR Review")).toBe(false);
    expect(__test_hasAllyConsolidatedReviewHeading(null)).toBe(false);
    expect(__test_hasAllyConsolidatedReviewHeading(undefined)).toBe(false);

    // The WHOLE-body helper keeps its broader behaviour: it gates a different
    // call site (isActionablePrReviewComment), where a relayed review body must
    // still count as review feedback whoever forwarded it.
    expect(
      __test_hasAllyConsolidatedReviewHeader("@ally re-review — your Ally — Consolidated PR Review flagged X"),
    ).toBe(true);
    expect(__test_hasAllyConsolidatedReviewHeader("> ## Ally — Consolidated PR Review")).toBe(true);
  });

  it("anchors the agent review-request marker to literal byte 0 of the body (BLO-18865)", () => {
    expect(__test_hasPrReviewerAgentRequestMarker("<!-- paperclip:review-request -->\n@ally")).toBe(true);
    expect(__test_hasPrReviewerAgentRequestMarker("<!--paperclip:review-request-->")).toBe(true);
    expect(__test_hasPrReviewerAgentRequestMarker("<!-- PAPERCLIP:REVIEW-REQUEST agent=cto -->")).toBe(true);
    expect(__test_hasPrReviewerAgentRequestMarker("<!--\tpaperclip:review-request\t-->")).toBe(true);

    // NOT anchored at byte 0 -> not a marker. Leading whitespace is rejected
    // on purpose: 4 spaces makes the line a Markdown indented code block, so
    // an indented marker at body start is a rendered EXAMPLE, and accepting it
    // would let a reviewer-authored example re-arm the #583 refire loop.
    expect(__test_hasPrReviewerAgentRequestMarker("    <!-- paperclip:review-request -->")).toBe(false);
    expect(__test_hasPrReviewerAgentRequestMarker("\n<!-- paperclip:review-request -->")).toBe(false);
    expect(__test_hasPrReviewerAgentRequestMarker(" <!-- paperclip:review-request -->")).toBe(false);
    expect(__test_hasPrReviewerAgentRequestMarker("> <!-- paperclip:review-request -->")).toBe(false);
    expect(__test_hasPrReviewerAgentRequestMarker("please use <!-- paperclip:review-request -->")).toBe(false);

    // The token must end at whitespace or the closing `-->`, so a longer
    // lookalike token is not a match.
    expect(__test_hasPrReviewerAgentRequestMarker("<!-- paperclip:review-request-evil -->")).toBe(false);
    expect(__test_hasPrReviewerAgentRequestMarker("<!-- paperclip:review-requested -->")).toBe(false);
    expect(__test_hasPrReviewerAgentRequestMarker("<!-- paperclip:review -->")).toBe(false);
    expect(__test_hasPrReviewerAgentRequestMarker("@ally please review")).toBe(false);
    expect(__test_hasPrReviewerAgentRequestMarker(null)).toBe(false);
    expect(__test_hasPrReviewerAgentRequestMarker(undefined)).toBe(false);
  });

  it("suppresses only AUTOMATIC reviewer wakes on a draft PR, not explicit requests (BLO-18865)", () => {
    const draftCtx = (wakeReason: string) => ({ wakeReason, prNumber: 900, prDraft: true }) as never;
    // Automatic reasons stay suppressed while the PR is a draft: a push to a
    // draft must not spend a review pass per commit, so draft PRs are never
    // reviewed until marked ready.
    expect(__test_shouldFirePrReviewerWake(draftCtx("github_pr_opened"))).toBe(false);
    expect(__test_shouldFirePrReviewerWake(draftCtx("github_pr_synchronized"))).toBe(false);
    expect(__test_shouldFirePrReviewerWake(draftCtx("github_pr_reopened"))).toBe(false);
    expect(__test_shouldFirePrReviewerWake(draftCtx("github_pr_review_submitted"))).toBe(false);
    // An explicit ask is not churn and is honoured even on a draft. This
    // exemption is belt-and-braces today (resolveEventContext's issue_comment
    // branch does not populate prDraft, so the check is not reached that way);
    // it is asserted directly so populating prDraft later cannot silently
    // re-strand agents.
    expect(__test_shouldFirePrReviewerWake(draftCtx("github_pr_review_requested"))).toBe(true);
    expect(__test_shouldFirePrReviewerWake(draftCtx("github_pr_ready_for_review"))).toBe(true);
  });

  it("ignores issue comments that are not PR @ally review requests", () => {
    expect(
      __test_resolveEventContext("issue_comment", {
        action: "created",
        issue: {
          number: 47,
          title: "BLO-6000 migrate auth",
          pull_request: { url: "https://api.github.com/repos/Blockcast/Network-Operator-Portal/pulls/47" },
        },
        comment: { id: 123456, body: "Looks good to me", user: { login: "kkroo" } },
        repository: { full_name: "Blockcast/Network-Operator-Portal" },
      }),
    ).toBeNull();
    expect(
      __test_resolveEventContext("issue_comment", {
        action: "created",
        issue: { number: 47, title: "BLO-6000 not a PR" },
        comment: { id: 123456, body: "@ally re-review please", user: { login: "kkroo" } },
        repository: { full_name: "Blockcast/Network-Operator-Portal" },
      }),
    ).toBeNull();
  });

  it("treats an actionable Ally consolidated PR review comment as author feedback, not a reviewer request", () => {
    const ctx = __test_resolveEventContext("issue_comment", {
      action: "created",
      issue: {
        number: 269,
        title: "Fix PEN-1126 hosted vault follow-up",
        body: "Closes PEN-1126",
        html_url: "https://github.com/Blockcast/penstock-llm-proxy-core/pull/269",
        pull_request: { url: "https://api.github.com/repos/Blockcast/penstock-llm-proxy-core/pulls/269" },
      },
      comment: {
        id: 4784546377,
        body: "## Ally — Consolidated PR Review\n\n### Important Issues (1)\n\nI1: The vault health probe still points at the wrong route.\n\n### Recommended Action\n\nFix I1 before merge.",
        html_url: "https://github.com/Blockcast/penstock-llm-proxy-core/pull/269#issuecomment-4784546377",
        user: { login: "allyblockcast[bot]" },
      },
      repository: { full_name: "Blockcast/penstock-llm-proxy-core" },
    });

    expect(ctx).toMatchObject({
      identifiers: ["PEN-1126"],
      wakeReason: "github_pr_review_feedback",
      prNumber: 269,
      repoFullName: "Blockcast/penstock-llm-proxy-core",
      commentId: 4784546377,
      commentAuthorLogin: "allyblockcast[bot]",
    });
    expect(ctx ? __test_shouldFirePrReviewerWake(ctx) : true).toBe(false);
  });

  it("extracts review body / state / author from pull_request_review.submitted so the assignee wake can render it inline (BLO-6300)", () => {
    const ctx = __test_resolveEventContext("pull_request_review", {
      action: "submitted",
      pull_request: {
        number: 953,
        title: "feat(cdn): BLO-5269 aggregator",
        body: null,
        html_url: "https://github.com/Blockcast/magma/pull/953",
        head: { ref: "feat/BLO-5269", sha: "feedface" },
      },
      review: {
        body: "Critical: PushExtCDNCacheHitRates POSTs to a read-only serializer.",
        state: "commented",
        html_url: "https://github.com/Blockcast/magma/pull/953#pullrequestreview-99",
        user: { login: "ally" },
      },
      repository: { full_name: "Blockcast/magma" },
    });
    expect(ctx).toMatchObject({
      identifiers: ["BLO-5269"],
      wakeReason: "github_pr_review_submitted",
      prNumber: 953,
      repoFullName: "Blockcast/magma",
      reviewBody: "Critical: PushExtCDNCacheHitRates POSTs to a read-only serializer.",
      reviewState: "commented",
      reviewAuthorLogin: "ally",
      prUrl: "https://github.com/Blockcast/magma/pull/953",
      eventUrl: "https://github.com/Blockcast/magma/pull/953#pullrequestreview-99",
      reviewUrl: "https://github.com/Blockcast/magma/pull/953#pullrequestreview-99",
      headSha: "feedface",
    });
    expect(__test_shouldFirePrReviewerWake(ctx)).toBe(true);
  });

  it("flags the reviewer's own pull_request_review.submitted as a self-echo (BLO-15799)", () => {
    const reviewCtx = (login: string) =>
      __test_resolveEventContext("pull_request_review", {
        action: "submitted",
        pull_request: {
          number: 730,
          title: "Some PR",
          body: null,
          head: { ref: "some-branch", sha: "abc123" },
          user: { login: "codex" },
        },
        review: { body: "Consolidated review findings.", state: "commented", user: { login } },
        repository: { full_name: "Blockcast/paperclip" },
      });

    // Observed posting identities, current and historical.
    expect(__test_isReviewerSelfEchoReview(reviewCtx("allyblockcast[bot]")!, "allyblockcast[bot]")).toBe(true);
    expect(__test_isReviewerSelfEchoReview(reviewCtx("blockcast-ci-packages[bot]")!, "allyblockcast[bot]")).toBe(true);
    // The default posting identity applies when no login is configured.
    expect(__test_isReviewerSelfEchoReview(reviewCtx("allyblockcast[bot]")!, null)).toBe(true);
    // A custom configured posting identity is honored.
    expect(__test_isReviewerSelfEchoReview(reviewCtx("my-review-bot[bot]")!, "my-review-bot[bot]")).toBe(true);
    // Human reviews and OTHER bots' reviews are not self-echoes.
    expect(__test_isReviewerSelfEchoReview(reviewCtx("kkroo")!, "allyblockcast[bot]")).toBe(false);
    expect(__test_isReviewerSelfEchoReview(reviewCtx("coderabbitai[bot]")!, "allyblockcast[bot]")).toBe(false);
  });

  it("scopes the self-echo filter to github_pr_review_submitted, never other wake reasons (BLO-15799)", () => {
    // A pull_request.opened context (even one authored by the reviewer bot)
    // must never be treated as a self-echo — pr opened/synchronize/comment
    // wakes are untouched by the filter.
    const openedCtx = __test_resolveEventContext("pull_request", {
      action: "opened",
      pull_request: {
        number: 731,
        title: "Some PR",
        body: null,
        head: { ref: "some-branch" },
        user: { login: "allyblockcast[bot]" },
      },
      repository: { full_name: "Blockcast/paperclip" },
    });
    expect(openedCtx?.wakeReason).toBe("github_pr_opened");
    expect(__test_isReviewerSelfEchoReview(openedCtx!, "allyblockcast[bot]")).toBe(false);
  });

  it("truncates oversize review bodies to ~4KB with a marker so the contextSnapshot row stays small (BLO-6300)", () => {
    // 5000-byte body — 1KB over the 4096-byte cap.
    const longBody = "x".repeat(5000);
    const ctx = __test_resolveEventContext("pull_request_review", {
      action: "submitted",
      pull_request: {
        number: 953,
        title: "feat: BLO-5269",
        head: { ref: "feat/BLO-5269" },
      },
      review: {
        body: longBody,
        state: "commented",
        user: { login: "ally" },
      },
      repository: { full_name: "Blockcast/magma" },
    });
    expect(ctx?.reviewBody).toMatch(/…\(truncated\)$/);
    // 4096-byte body + truncation marker (~14 bytes), but always less than
    // the raw 5000 bytes — confirms we actually cut something.
    expect(ctx?.reviewBody?.length).toBeLessThan(5000);
  });

  it("returns null reviewBody when the reviewer submitted an empty body (state-only review)", () => {
    const ctx = __test_resolveEventContext("pull_request_review", {
      action: "submitted",
      pull_request: {
        number: 953,
        head: { ref: "feat/BLO-5269" },
      },
      review: {
        body: "",
        state: "approved",
        user: { login: "ally" },
      },
      repository: { full_name: "Blockcast/magma" },
    });
    expect(ctx?.reviewBody).toBeNull();
    expect(ctx?.reviewState).toBe("approved");
  });

  it("resolves a dependabot_alert.created payload into a remediation context", () => {
    const ctx = __test_resolveDependabotAlertContext({
      action: "created",
      alert: {
        number: 58,
        html_url: "https://github.com/Blockcast/paperclip/security/dependabot/58",
        dependency: {
          package: { ecosystem: "npm", name: "vitest" },
          manifest_path: "packages/mcp-gateway/package.json",
        },
        security_advisory: {
          ghsa_id: "GHSA-5xrq-8626-4rwp",
          cve_id: "CVE-2026-47429",
          summary: "When Vitest UI server is listening, arbitrary file can be read and executed",
          severity: "critical",
        },
        security_vulnerability: {
          package: { ecosystem: "npm", name: "vitest" },
          severity: "critical",
          vulnerable_version_range: "< 3.2.6",
          first_patched_version: { identifier: "3.2.6" },
        },
      },
      repository: { full_name: "Blockcast/paperclip" },
    });
    expect(ctx).toMatchObject({
      action: "created",
      alertNumber: 58,
      severity: "critical",
      packageName: "vitest",
      ecosystem: "npm",
      manifestPath: "packages/mcp-gateway/package.json",
      ghsaId: "GHSA-5xrq-8626-4rwp",
      cveId: "CVE-2026-47429",
      vulnerableRange: "< 3.2.6",
      patchedVersion: "3.2.6",
      alertUrl: "https://github.com/Blockcast/paperclip/security/dependabot/58",
    });
  });

  it("builds Dependabot alert instructions with separate remediation and dismissal paths", () => {
    const alert = __test_resolveDependabotAlertContext({
      action: "created",
      alert: {
        number: 58,
        html_url: "https://github.com/Blockcast/paperclip/security/dependabot/58",
        dependency: {
          package: { ecosystem: "npm", name: "vitest" },
          manifest_path: "packages/mcp-gateway/package.json",
        },
        security_advisory: {
          ghsa_id: "GHSA-5xrq-8626-4rwp",
          cve_id: "CVE-2026-47429",
          summary: "When Vitest UI server is listening, arbitrary file can be read and executed",
          severity: "critical",
        },
        security_vulnerability: {
          package: { ecosystem: "npm", name: "vitest" },
          severity: "critical",
          vulnerable_version_range: "< 3.2.6",
          first_patched_version: { identifier: "3.2.6" },
        },
      },
      repository: { full_name: "Blockcast/paperclip" },
    });
    expect(alert).not.toBeNull();

    const description = __test_buildDependabotAlertIssueBody({
      repoFullName: "Blockcast/paperclip",
      alert: alert!,
    });

    expect(description).toContain("Remediation path:");
    expect(description).toContain("Dismissal path:");
    expect(description).toContain("For the remediation path");
    expect(description).toContain("For the dismissal path");
    expect(description).toMatch(
      /^1\. The remediation PR merges into the default branch of `Blockcast\/paperclip`, AND the default-branch manifest `packages\/mcp-gateway\/package\.json` resolves vitest at 3\.2\.6 or newer\.$/m,
    );
  });

  it("resolves terminal dependabot alert actions for receipt recording", () => {
    for (const action of ["fixed", "dismissed", "auto_dismissed"]) {
      expect(
        __test_resolveDependabotAlertContext({
          action,
          alert: { number: 7, security_vulnerability: { severity: "critical" } },
        }),
      ).toMatchObject({ action, alertNumber: 7, severity: "critical" });
    }
  });

  it("returns null for dependabot payloads without a numeric alert number", () => {
    expect(__test_resolveDependabotAlertContext({ action: "created", alert: {} })).toBeNull();
    expect(__test_resolveDependabotAlertContext({ action: "created" })).toBeNull();
  });
});

describeEmbeddedPostgres("github-webhook route", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;
  const webhookSecret = "test-webhook-secret-do-not-use-in-prod";
  const allowPenstockGate: NonNullable<GithubWebhookConfig["heartbeatOptions"]>["penstockAvailabilityGate"] = {
    checkAdapter: async () => ({ allow: true }),
    _resetForTesting: () => {},
  };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-github-webhook-test-");
    db = createDb(tempDb.connectionString);
  });

  beforeEach(async () => {
    if (!db) return;
    // These route tests default to skipQueuedRunDispatch, and several cases
    // intentionally seed queued/running rows to exercise coalescing. Finalize
    // test-owned rows directly so cleanup does not spend 30s waiting on
    // heartbeat runs that will never dispatch in this suite.
    await db.execute(sql.raw(
      `UPDATE "heartbeat_runs" SET status='failed', finished_at=NOW() WHERE status IN ('queued','running')`,
    ));
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
  }, 60_000);

  afterAll(async () => {
    await db.execute(sql.raw(
      `UPDATE "heartbeat_runs" SET status='failed', finished_at=NOW() WHERE status IN ('queued','running')`,
    ));
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
    await tempDb?.cleanup();
  }, 60_000);

  function buildApp(config: Pick<GithubWebhookConfig, "prReviewerAgentIds" | "prReviewerAgentId" | "prReviewerBotLogin" | "selfReviewEscalationThreshold" | "dependabotAgentId" | "dependabotMinSeverity" | "heartbeatOptions"> = {}) {
    const app = express();
    app.use(express.json({
      verify: (req, _res, buf) => {
        (req as unknown as { rawBody: Buffer }).rawBody = buf;
      },
    }));
    app.use("/api/webhooks/github", githubWebhookRoutes(db, {
      webhookSecret,
      ...config,
      heartbeatOptions: {
        penstockAvailabilityGate: allowPenstockGate,
        skipQueuedRunDispatch: true,
        ...config.heartbeatOptions,
      },
    }));
    return app;
  }

  function signedRequest(payload: Record<string, unknown>) {
    const body = JSON.stringify(payload);
    const signature =
      "sha256=" + crypto.createHmac("sha256", webhookSecret).update(Buffer.from(body, "utf8")).digest("hex");
    return { body, signature };
  }

  async function seedIssueWithIdentifier(identifier: string, opts?: { status?: string; assignee?: boolean }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = identifier.split("-")[0]!;
    await db.insert(companies).values({
      id: companyId,
      name: "Test",
      issuePrefix,
      defaultResponsibleUserId: "test-board-user",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "TestAgent",
      role: "engineer",
      status: "idle",
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Test issue",
      status: opts?.status ?? "in_progress",
      priority: "medium",
      assigneeAgentId: opts?.assignee === false ? null : agentId,
      issueNumber: Number(identifier.split("-")[1] ?? 1),
      identifier,
    });
    return { companyId, agentId, issueId };
  }

  async function seedCompanyAndAgent(opts?: { agentName?: string; companyStatus?: string }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Test",
      issuePrefix: "BLO",
      defaultResponsibleUserId: "test-board-user",
      requireBoardApprovalForNewAgents: false,
      ...(opts?.companyStatus ? { status: opts.companyStatus } : {}),
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: opts?.agentName ?? "TestAgent",
      role: "engineer",
      status: "idle",
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  it("rejects unsigned requests with 401", async () => {
    const app = buildApp();
    const { body, signature: _ } = signedRequest({ action: "completed", check_run: { head_branch: "fix/X-1" } });
    const res = await request(app)
      .post("/api/webhooks/github")
      .set("x-github-event", "check_run")
      .set("content-type", "application/json")
      .send(body);
    expect(res.status).toBe(401);
  });

  it("503s when the webhook secret is not configured", async () => {
    const app = express();
    app.use(express.json({ verify: (req, _res, buf) => {
      (req as unknown as { rawBody: Buffer }).rawBody = buf;
    }}));
    app.use("/api/webhooks/github", githubWebhookRoutes(db, { webhookSecret: null }));
    const res = await request(app)
      .post("/api/webhooks/github")
      .set("x-github-event", "check_run")
      .set("x-hub-signature-256", "sha256=anything")
      .set("content-type", "application/json")
      .send(Buffer.from("{}", "utf8"));
    expect(res.status).toBe(503);
  });

  it("ignores events not in the wake-driving set", async () => {
    const app = buildApp();
    const payload = { action: "opened", issue: {} };
    const { body, signature } = signedRequest(payload);
    const res = await request(app)
      .post("/api/webhooks/github")
      .set("x-github-event", "push")
      .set("x-hub-signature-256", signature)
      .set("content-type", "application/json")
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ignored: "push" });
  });

  it("skips terminal-status issues -- a stale CI ping shouldn't reopen done work", async () => {
    const { agentId } = await seedIssueWithIdentifier("BLO-3000", { status: "done" });
    const app = buildApp();
    const payload = {
      action: "completed",
      check_run: {
        head_branch: "fix/BLO-3000",
        pull_requests: [{ number: 50, head: { ref: "fix/BLO-3000" } }],
      },
      repository: { full_name: "Blockcast/paperclip" },
    };
    const { body, signature } = signedRequest(payload);
    const res = await request(app)
      .post("/api/webhooks/github")
      .set("x-github-event", "check_run")
      .set("x-hub-signature-256", signature)
      .set("content-type", "application/json")
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body.wakes).toHaveLength(0);
    expect(res.body.skipped).toEqual([
      { issueIdentifier: "BLO-3000", reason: "terminal_status" },
    ]);
    const wakes = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakes).toHaveLength(0);
  });

  it("acks events with no matching paperclip issue without erroring", async () => {
    const app = buildApp();
    const payload = {
      action: "completed",
      check_run: {
        head_branch: "fix/UNKNOWN-1234",
        pull_requests: [{ number: 1, head: { ref: "fix/UNKNOWN-1234" } }],
      },
    };
    const { body, signature } = signedRequest(payload);
    const res = await request(app)
      .post("/api/webhooks/github")
      .set("x-github-event", "check_run")
      .set("x-hub-signature-256", signature)
      .set("content-type", "application/json")
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ignored: "no_matching_issue", identifiers: ["UNKNOWN-1234"] });
  });

  it("leaves reviewer wakes queued when the webhook runs on the API tier", async () => {
    const { agentId } = await seedCompanyAndAgent({ agentName: "Ally" });
    const app = buildApp({
      prReviewerAgentId: agentId,
      heartbeatOptions: {
        paperclipNodeRole: "api",
        skipQueuedRunDispatch: false,
      },
    });
    const payload = {
      action: "opened",
      pull_request: {
        number: 977,
        title: "Fence API-tier reviewer dispatch",
        body: null,
        head: { ref: "fix/api-reviewer-dispatch-fence", sha: "api-fence-head" },
      },
      repository: { full_name: "Blockcast/paperclip" },
    };
    const { body, signature } = signedRequest(payload);
    const res = await request(app)
      .post("/api/webhooks/github")
      .set("x-github-event", "pull_request")
      .set("x-hub-signature-256", signature)
      .set("x-github-delivery", "delivery-api-reviewer-fence")
      .set("content-type", "application/json")
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ reviewerWakeFired: true });

    const runs = await db
      .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("queued");
  });

  // BLO-19566 AC4. Before this, nothing wrote a `pull_request` work product,
  // so productivity/liveness accounting -- whose own verdict criteria ask for
  // "a non-stale PR/MR link in the source issue's evidence" -- could never find
  // one, and an assignee pushing commits to an open PR read as zero progress.
  describe("pull_request work products", () => {
    function prPayload(opts: {
      action: string;
      identifier: string;
      number?: number;
      title?: string | null;
      draft?: boolean;
      merged?: boolean;
      headSha?: string;
    }) {
      return {
        action: opts.action,
        pull_request: {
          number: opts.number ?? 4242,
          title: opts.title === undefined ? `Fix ${opts.identifier}` : opts.title,
          body: null,
          html_url: `https://github.com/Blockcast/paperclip/pull/${opts.number ?? 4242}`,
          draft: opts.draft ?? false,
          merged: opts.merged ?? false,
          head: { ref: `fix/${opts.identifier.toLowerCase()}`, sha: opts.headSha ?? "head-one" },
        },
        repository: { full_name: "Blockcast/paperclip" },
      };
    }

    async function postPr(
      app: express.Express,
      payload: Record<string, unknown>,
      deliveryId: string,
    ) {
      const { body, signature } = signedRequest(payload);
      return request(app)
        .post("/api/webhooks/github")
        .set("x-github-event", "pull_request")
        .set("x-hub-signature-256", signature)
        .set("x-github-delivery", deliveryId)
        .set("content-type", "application/json")
        .send(body);
    }

    it("creates a pull_request work product on the referenced issue", async () => {
      const { issueId } = await seedIssueWithIdentifier("BLO-40001");
      const app = buildApp();

      const res = await postPr(app, prPayload({ action: "opened", identifier: "BLO-40001" }), "wp-opened");
      expect(res.status).toBe(200);

      const rows = await db
        .select()
        .from(issueWorkProducts)
        .where(eq(issueWorkProducts.issueId, issueId));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        type: "pull_request",
        provider: "github",
        externalId: "Blockcast/paperclip#4242",
        url: "https://github.com/Blockcast/paperclip/pull/4242",
        status: "ready_for_review",
        title: "Fix BLO-40001",
      });
      expect(rows[0]?.metadata).toMatchObject({
        source: "github_pull_request_webhook",
        sourceEventOrder: 10,
      });
    });

    it("updates the same row on a later push instead of appending one per event", async () => {
      const { issueId } = await seedIssueWithIdentifier("BLO-40002");
      const app = buildApp();

      await postPr(app, prPayload({ action: "opened", identifier: "BLO-40002", number: 4243 }), "wp-seq-1");
      const afterOpen = await db
        .select({ id: issueWorkProducts.id, updatedAt: issueWorkProducts.updatedAt })
        .from(issueWorkProducts)
        .where(eq(issueWorkProducts.issueId, issueId));
      expect(afterOpen).toHaveLength(1);

      await postPr(
        app,
        prPayload({ action: "synchronize", identifier: "BLO-40002", number: 4243, headSha: "head-two" }),
        "wp-seq-2",
      );

      const afterPush = await db
        .select()
        .from(issueWorkProducts)
        .where(eq(issueWorkProducts.issueId, issueId));
      // One PR, one row -- the identity excludes the head SHA on purpose.
      expect(afterPush).toHaveLength(1);
      expect(afterPush[0]?.id).toBe(afterOpen[0]?.id);
      expect(afterPush[0]?.metadata).toMatchObject({ headSha: "head-two", lastEventAction: "synchronize" });
      // updatedAt is what liveness reads as "the PR moved"; it must advance.
      expect(afterPush[0]!.updatedAt.getTime()).toBeGreaterThanOrEqual(afterOpen[0]!.updatedAt.getTime());
    });

    it("records the terminal state when the PR merges", async () => {
      const { issueId } = await seedIssueWithIdentifier("BLO-40003");
      const app = buildApp();

      await postPr(app, prPayload({ action: "opened", identifier: "BLO-40003", number: 4244 }), "wp-merge-1");
      await postPr(
        app,
        prPayload({ action: "closed", identifier: "BLO-40003", number: 4244, merged: true }),
        "wp-merge-2",
      );

      const rows = await db
        .select({ status: issueWorkProducts.status })
        .from(issueWorkProducts)
        .where(eq(issueWorkProducts.issueId, issueId));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe("merged");
    });

    it("does not let a stale synchronize event overwrite a terminal merge state", async () => {
      const { issueId } = await seedIssueWithIdentifier("BLO-40006");
      const app = buildApp();

      await postPr(app, prPayload({ action: "opened", identifier: "BLO-40006", number: 4247 }), "wp-order-1");
      await postPr(
        app,
        prPayload({
          action: "closed",
          identifier: "BLO-40006",
          number: 4247,
          merged: true,
          headSha: "merge-head",
        }),
        "wp-order-2",
      );
      await postPr(
        app,
        prPayload({
          action: "synchronize",
          identifier: "BLO-40006",
          number: 4247,
          headSha: "stale-sync-head",
        }),
        "wp-order-3",
      );

      const rows = await db
        .select({ status: issueWorkProducts.status, metadata: issueWorkProducts.metadata })
        .from(issueWorkProducts)
        .where(eq(issueWorkProducts.issueId, issueId));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe("merged");
      expect(rows[0]?.metadata).toMatchObject({
        headSha: "merge-head",
        lastEventAction: "closed",
        sourceEventOrder: 30,
      });
    });

    it("keeps updating a previously linked PR row after the identifier is removed", async () => {
      const { issueId } = await seedIssueWithIdentifier("BLO-40007");
      const app = buildApp();

      await postPr(app, prPayload({ action: "opened", identifier: "BLO-40007", number: 4248 }), "wp-link-1");
      const syncWithoutIdentifier = await postPr(
        app,
        prPayload({
          action: "synchronize",
          identifier: "no-ticket",
          number: 4248,
          title: "Retitled without paperclip id",
          headSha: "head-without-id",
        }),
        "wp-link-2",
      );
      expect(syncWithoutIdentifier.status).toBe(200);
      expect(syncWithoutIdentifier.body).toMatchObject({ ignored: "no_matching_issue" });

      let rows = await db
        .select({ status: issueWorkProducts.status, metadata: issueWorkProducts.metadata })
        .from(issueWorkProducts)
        .where(eq(issueWorkProducts.issueId, issueId));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe("ready_for_review");
      expect(rows[0]?.metadata).toMatchObject({
        headSha: "head-without-id",
        lastEventAction: "synchronize",
      });

      const closeWithoutIdentifier = await postPr(
        app,
        prPayload({
          action: "closed",
          identifier: "no-ticket",
          number: 4248,
          title: "Retitled without paperclip id",
          merged: true,
          headSha: "merge-without-id",
        }),
        "wp-link-3",
      );
      expect(closeWithoutIdentifier.status).toBe(200);
      expect(closeWithoutIdentifier.body).toMatchObject({ ignored: "no_matching_issue" });

      rows = await db
        .select({ status: issueWorkProducts.status, metadata: issueWorkProducts.metadata })
        .from(issueWorkProducts)
        .where(eq(issueWorkProducts.issueId, issueId));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe("merged");
      expect(rows[0]?.metadata).toMatchObject({
        headSha: "merge-without-id",
        lastEventAction: "closed",
        sourceEventOrder: 30,
      });
    });

    it("records a draft PR as draft rather than ready_for_review", async () => {
      const { issueId } = await seedIssueWithIdentifier("BLO-40004");
      const app = buildApp();

      await postPr(
        app,
        prPayload({ action: "opened", identifier: "BLO-40004", number: 4245, draft: true }),
        "wp-draft",
      );

      const rows = await db
        .select({ status: issueWorkProducts.status })
        .from(issueWorkProducts)
        .where(eq(issueWorkProducts.issueId, issueId));
      expect(rows[0]?.status).toBe("draft");
    });

    it("writes a row for an unassigned issue (evidence about the PR, not a wake)", async () => {
      const { issueId } = await seedIssueWithIdentifier("BLO-40005", { assignee: false });
      const app = buildApp();

      await postPr(app, prPayload({ action: "opened", identifier: "BLO-40005", number: 4246 }), "wp-unassigned");

      const rows = await db
        .select({ id: issueWorkProducts.id })
        .from(issueWorkProducts)
        .where(eq(issueWorkProducts.issueId, issueId));
      expect(rows).toHaveLength(1);
    });
  });

  it("does not coalesce reviewer PR wakes into a thin null-scope automation run (BLO-7457)", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({ agentName: "Ally" });
    const activeRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: activeRunId,
      companyId,
      agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "running",
      startedAt: new Date(),
      contextSnapshot: {
        wakeReason: "github_pr_opened",
        wakeSource: "automation",
        wakeTriggerDetail: "system",
      },
    });

    const app = buildApp({ prReviewerAgentId: agentId });
    const payload = {
      action: "opened",
      pull_request: {
        number: 976,
        title: "Migrate members page",
        body: null,
        head: { ref: "migration-blo-4959-members-page" },
      },
      repository: { full_name: "Blockcast/magma" },
    };
    const { body, signature } = signedRequest(payload);
    const res = await request(app)
      .post("/api/webhooks/github")
      .set("x-github-event", "pull_request")
      .set("x-hub-signature-256", signature)
      .set("x-github-delivery", "delivery-blo-7457")
      .set("content-type", "application/json")
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ignored: "no_paperclip_identifier",
      reviewerWakeFired: true,
    });

    const runs = await db
      .select({
        id: heartbeatRuns.id,
        status: heartbeatRuns.status,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(2);

    const activeRun = runs.find((run) => run.id === activeRunId);
    expect(activeRun?.contextSnapshot).toMatchObject({
      wakeReason: "github_pr_opened",
      wakeSource: "automation",
      wakeTriggerDetail: "system",
    });
    expect((activeRun?.contextSnapshot as Record<string, unknown> | undefined)?.githubPrNumber).toBeUndefined();

    const reviewerRun = runs.find((run) => run.id !== activeRunId);
    expect(reviewerRun?.status).toBe("queued");
    expect(reviewerRun?.contextSnapshot).toMatchObject({
      taskKey: "pr_review:Blockcast/magma:976",
      wakeReason: "github_pr_opened",
      wakeSource: "automation",
      wakeTriggerDetail: "system",
      commentSource: "github",
      githubEvent: "pull_request",
      githubDeliveryId: "delivery-blo-7457",
      githubPrNumber: 976,
      githubRepoFullName: "Blockcast/magma",
      reviewKind: "pr_review",
      prRole: "reviewer",
    });

    const wakes = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        payload: agentWakeupRequests.payload,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakes.map((wake) => wake.status)).not.toContain("coalesced");
    expect(wakes).toContainEqual(expect.objectContaining({
      status: "queued",
      reason: "github_pr_opened",
      payload: expect.objectContaining({
        taskKey: "pr_review:Blockcast/magma:976",
        source: "github",
        event: "pull_request",
        deliveryId: "delivery-blo-7457",
        prNumber: 976,
        repoFullName: "Blockcast/magma",
        reviewKind: "pr_review",
      }),
    }));
  });

  it("assigns PR review wakes to the least-loaded active reviewer", async () => {
    const { companyId, agentId: busyReviewerId } = await seedCompanyAndAgent({
      agentName: "Ally",
    });
    const idleReviewerId = randomUUID();
    await db.insert(agents).values({
      id: idleReviewerId,
      companyId,
      name: "Ally 2",
      role: "engineer",
      status: "idle",
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId: busyReviewerId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "queued",
      contextSnapshot: { taskKey: "pr_review:Blockcast/magma:975" },
    });

    const app = buildApp({ prReviewerAgentIds: [busyReviewerId, idleReviewerId] });
    const payload = {
      action: "opened",
      pull_request: {
        number: 976,
        title: "Load-balanced review",
        body: null,
        head: { ref: "review-pool" },
      },
      repository: { full_name: "Blockcast/magma" },
    };
    const { body, signature } = signedRequest(payload);
    const res = await request(app)
      .post("/api/webhooks/github")
      .set("x-github-event", "pull_request")
      .set("x-hub-signature-256", signature)
      .set("x-github-delivery", "delivery-review-pool-load")
      .set("content-type", "application/json")
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.reviewerWakeFired).toBe(true);
    const assigned = await db
      .select({ agentId: heartbeatRuns.agentId, contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, idleReviewerId));
    expect(assigned).toHaveLength(1);
    expect(assigned[0]?.contextSnapshot).toMatchObject({
      taskKey: "pr_review:Blockcast/magma:976",
      githubPrNumber: 976,
    });
  });

  it("uses a task-scoped tie-break when active reviewers have equal load", async () => {
    const { companyId, agentId: firstReviewerId } = await seedCompanyAndAgent({
      agentName: "Ally",
    });
    const secondReviewerId = randomUUID();
    await db.insert(agents).values({
      id: secondReviewerId,
      companyId,
      name: "Ally 2",
      role: "engineer",
      status: "idle",
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const app = buildApp({ prReviewerAgentIds: [firstReviewerId, secondReviewerId] });
    const payload = {
      action: "opened",
      pull_request: {
        number: 977,
        title: "Spread equal-load reviews",
        body: null,
        head: { ref: "review-pool-tie-break" },
      },
      repository: { full_name: "Blockcast/magma" },
    };
    const { body, signature } = signedRequest(payload);
    const res = await request(app)
      .post("/api/webhooks/github")
      .set("x-github-event", "pull_request")
      .set("x-hub-signature-256", signature)
      .set("x-github-delivery", "delivery-review-pool-tie-break")
      .set("content-type", "application/json")
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.reviewerWakeFired).toBe(true);
    const runs = await db
      .select({ agentId: heartbeatRuns.agentId })
      .from(heartbeatRuns)
      .where(inArray(heartbeatRuns.agentId, [firstReviewerId, secondReviewerId]));
    expect(runs).toEqual([{ agentId: secondReviewerId }]);
  });

  it("does not assign PR review wakes to a terminated reviewer", async () => {
    const { companyId, agentId: activeReviewerId } = await seedCompanyAndAgent({
      agentName: "Ally",
    });
    const terminatedReviewerId = randomUUID();
    await db.insert(agents).values({
      id: terminatedReviewerId,
      companyId,
      name: "Ally 2",
      role: "engineer",
      status: "terminated",
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId: activeReviewerId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "queued",
      contextSnapshot: { taskKey: "pr_review:Blockcast/magma:975" },
    });

    const app = buildApp({
      prReviewerAgentIds: [activeReviewerId, terminatedReviewerId],
    });
    const payload = {
      action: "opened",
      pull_request: {
        number: 976,
        title: "Active reviewer only",
        body: null,
        head: { ref: "review-pool-active" },
      },
      repository: { full_name: "Blockcast/magma" },
    };
    const { body, signature } = signedRequest(payload);
    const res = await request(app)
      .post("/api/webhooks/github")
      .set("x-github-event", "pull_request")
      .set("x-hub-signature-256", signature)
      .set("x-github-delivery", "delivery-review-pool-active")
      .set("content-type", "application/json")
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.reviewerWakeFired).toBe(true);
    const activeRuns = await db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, activeReviewerId));
    expect(activeRuns).toHaveLength(2);
    expect(activeRuns).toContainEqual(
      expect.objectContaining({
        contextSnapshot: expect.objectContaining({
          taskKey: "pr_review:Blockcast/magma:976",
        }),
      }),
    );
    const terminatedRuns = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, terminatedReviewerId));
    expect(terminatedRuns).toHaveLength(0);
  });

  it("dedupes a replayed reviewer delivery across the whole reviewer pool", async () => {
    const { companyId, agentId: firstReviewerId } = await seedCompanyAndAgent({
      agentName: "Ally",
    });
    const secondReviewerId = randomUUID();
    await db.insert(agents).values({
      id: secondReviewerId,
      companyId,
      name: "Ally 2",
      role: "engineer",
      status: "idle",
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const app = buildApp({ prReviewerAgentIds: [firstReviewerId, secondReviewerId] });
    const payload = {
      action: "opened",
      pull_request: {
        number: 976,
        title: "Pool-wide dedupe",
        body: null,
        head: { ref: "review-pool-dedupe" },
      },
      repository: { full_name: "Blockcast/magma" },
    };
    const { body, signature } = signedRequest(payload);
    const send = () =>
      request(app)
        .post("/api/webhooks/github")
        .set("x-github-event", "pull_request")
        .set("x-hub-signature-256", signature)
        .set("x-github-delivery", "delivery-review-pool-dedupe")
        .set("content-type", "application/json")
        .send(body);

    const first = await send();
    const replay = await send();

    expect(first.status).toBe(200);
    expect(first.body.reviewerWakeFired).toBe(true);
    expect(replay.status).toBe(200);
    expect(replay.body.reviewerWakeFired).toBe(false);
    const runs = await db
      .select({ agentId: heartbeatRuns.agentId })
      .from(heartbeatRuns)
      .where(inArray(heartbeatRuns.agentId, [firstReviewerId, secondReviewerId]));
    expect(runs).toHaveLength(1);
  });

  it("counts a review-request delivery as received+queued once, and does not count a deduped replay (BLO-18859)", async () => {
    __resetMetricsForTest();
    const { agentId: reviewerId } = await seedCompanyAndAgent({ agentName: "Ally" });

    const app = buildApp({ prReviewerAgentIds: [reviewerId] });
    const payload = {
      action: "opened",
      pull_request: {
        number: 18859,
        title: "Delivery funnel counters",
        body: null,
        head: { ref: "platform/blo-18859-github-delivery-metrics" },
      },
      repository: { full_name: "Blockcast/paperclip" },
    };
    const { body, signature } = signedRequest(payload);
    const send = () =>
      request(app)
        .post("/api/webhooks/github")
        .set("x-github-event", "pull_request")
        .set("x-hub-signature-256", signature)
        .set("x-github-delivery", "delivery-blo-18859-funnel")
        .set("content-type", "application/json")
        .send(body);

    const first = await send();
    expect(first.status).toBe(200);
    expect(first.body.reviewerWakeFired).toBe(true);

    // One delivery that cleared every gate and durably queued: both states move
    // together, and nothing was retried or lost.
    expect(await deliveryCount("received")).toBe(1);
    expect(await deliveryCount("queued")).toBe(1);
    expect(await deliveryCount("retried")).toBe(0);
    expect(await deliveryCount("dead_lettered")).toBe(0);

    const replay = await send();
    expect(replay.status).toBe(200);
    expect(replay.body.reviewerWakeFired).toBe(false);

    // The replay is suppressed by the idempotency gate, which is a correct
    // no-op — NOT a received delivery. Counting it would make `received` track
    // GitHub's redelivery behavior instead of intent-to-wake, and would show a
    // permanent received/queued gap on a healthy fleet.
    expect(await deliveryCount("received")).toBe(1);
    expect(await deliveryCount("queued")).toBe(1);
  });

  it("counts a scheduling-gate-declined wake as suppressed, not queued, and does not claim reviewerWakeFired (BLO-18859)", async () => {
    __resetMetricsForTest();
    // A paused company makes enqueueWakeup take its `company.inactive` branch:
    // it writes a status="skipped" row and resolves *null* rather than throwing.
    // The pre-fix code counted that as `queued`, so a review that never ran
    // rendered as a healthy received+queued delivery — the exact
    // false-success this test pins down.
    const { agentId: reviewerId } = await seedCompanyAndAgent({
      agentName: "Ally",
      companyStatus: "paused",
    });

    const app = buildApp({ prReviewerAgentIds: [reviewerId] });
    const payload = {
      action: "opened",
      pull_request: {
        number: 18860,
        title: "Suppressed delivery",
        body: null,
        head: { ref: "platform/blo-18859-suppressed" },
      },
      repository: { full_name: "Blockcast/paperclip" },
    };
    const { body, signature } = signedRequest(payload);
    const res = await request(app)
      .post("/api/webhooks/github")
      .set("x-github-event", "pull_request")
      .set("x-hub-signature-256", signature)
      .set("x-github-delivery", "delivery-blo-18859-suppressed")
      .set("content-type", "application/json")
      .send(body);

    expect(res.status).toBe(200);
    // The 200 body must not advertise a wake that produced no run.
    expect(res.body.reviewerWakeFired).toBe(false);

    // The delivery cleared every receiver-side gate, so `received` still counts
    // it — the loss happened downstream, which is what makes the
    // received-vs-queued gap meaningful.
    expect(await deliveryCount("received")).toBe(1);
    expect(await deliveryCount("queued")).toBe(0);
    expect(await deliveryCount("suppressed")).toBe(1);
    expect(await deliveryCount("retried")).toBe(0);
    expect(await deliveryCount("dead_lettered")).toBe(0);
    // End-to-end through the real route: the cause comes from the gate inside
    // enqueueWakeup, which the route cannot see — so this also pins that the
    // route no longer emits its own causeless `suppressed` increment (that would
    // read as 2 here and desync the two counters).
    expect(await suppressionCount("company.inactive")).toBe(1);
    expect(await suppressionCount()).toBe(1);

    // Ground the counter against the durable record: a skipped row, no run.
    const wakeRows = await db
      .select({ status: agentWakeupRequests.status, reason: agentWakeupRequests.reason })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, reviewerId));
    expect(wakeRows).toHaveLength(1);
    expect(wakeRows[0]!.status).toBe("skipped");
    expect(wakeRows[0]!.reason).toBe("company.inactive");
    const runs = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, reviewerId));
    expect(runs).toHaveLength(0);
  });

  it("keeps follow-up PR review wakes with the reviewer already handling that PR", async () => {
    const { companyId, agentId: firstReviewerId } = await seedCompanyAndAgent({
      agentName: "Ally",
    });
    const secondReviewerId = randomUUID();
    await db.insert(agents).values({
      id: secondReviewerId,
      companyId,
      name: "Ally 2",
      role: "engineer",
      status: "idle",
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const app = buildApp({ prReviewerAgentIds: [firstReviewerId, secondReviewerId] });
    const pullRequest = {
      number: 976,
      title: "Keep reviewer affinity",
      body: null,
      html_url: "https://github.com/Blockcast/magma/pull/976",
      head: { ref: "review-pool-affinity", sha: "first-head" },
    };
    const opened = signedRequest({
      action: "opened",
      pull_request: pullRequest,
      repository: { full_name: "Blockcast/magma" },
    });
    const openedRes = await request(app)
      .post("/api/webhooks/github")
      .set("x-github-event", "pull_request")
      .set("x-hub-signature-256", opened.signature)
      .set("x-github-delivery", "delivery-review-pool-affinity-opened")
      .set("content-type", "application/json")
      .send(opened.body);

    const synchronized = signedRequest({
      action: "synchronize",
      pull_request: {
        ...pullRequest,
        head: { ...pullRequest.head, sha: "second-head" },
      },
      repository: { full_name: "Blockcast/magma" },
    });
    const synchronizedRes = await request(app)
      .post("/api/webhooks/github")
      .set("x-github-event", "pull_request")
      .set("x-hub-signature-256", synchronized.signature)
      .set("x-github-delivery", "delivery-review-pool-affinity-synchronized")
      .set("content-type", "application/json")
      .send(synchronized.body);

    expect(openedRes.status).toBe(200);
    expect(openedRes.body.reviewerWakeFired).toBe(true);
    expect(synchronizedRes.status).toBe(200);
    expect(synchronizedRes.body.reviewerWakeFired).toBe(true);

    const runs = await db
      .select({
        agentId: heartbeatRuns.agentId,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
      .from(heartbeatRuns)
      .where(inArray(heartbeatRuns.agentId, [firstReviewerId, secondReviewerId]));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      agentId: firstReviewerId,
      contextSnapshot: expect.objectContaining({
        taskKey: "pr_review:Blockcast/magma:976",
        githubPrNumber: 976,
        githubHeadSha: "second-head",
      }),
    });

    const wakes = await db
      .select({
        agentId: agentWakeupRequests.agentId,
        status: agentWakeupRequests.status,
        idempotencyKey: agentWakeupRequests.idempotencyKey,
      })
      .from(agentWakeupRequests)
      .where(inArray(agentWakeupRequests.agentId, [firstReviewerId, secondReviewerId]));
    expect(wakes).toHaveLength(2);
    expect(wakes.every((wake) => wake.agentId === firstReviewerId)).toBe(true);
    expect(wakes).toContainEqual(expect.objectContaining({
      status: "coalesced",
      idempotencyKey:
        "pr_review:Blockcast/magma:976:github_pr_synchronized:delivery:delivery-review-pool-affinity-synchronized",
    }));
  });

  it("serializes concurrent first events for the same PR before assigning a reviewer", async () => {
    const { companyId, agentId: firstReviewerId } = await seedCompanyAndAgent({
      agentName: "Ally",
    });
    const secondReviewerId = randomUUID();
    const reviewerAgentIds = [firstReviewerId, secondReviewerId];
    await db.insert(agents).values({
      id: secondReviewerId,
      companyId,
      name: "Ally 2",
      role: "engineer",
      status: "idle",
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const taskKey = "pr_review:Blockcast/magma:978";
    let reportLockAcquired!: () => void;
    let releaseLock!: () => void;
    const lockAcquired = new Promise<void>((resolve) => {
      reportLockAcquired = resolve;
    });
    const releaseSignal = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const lockHolder = db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${taskKey}, 0))`,
      );
      reportLockAcquired();
      await releaseSignal;
    });
    await lockAcquired;

    const app = buildApp({ prReviewerAgentIds: reviewerAgentIds });
    const send = (action: "opened" | "synchronize", deliveryId: string, headSha: string) => {
      const signed = signedRequest({
        action,
        pull_request: {
          number: 978,
          title: "Serialize reviewer assignment",
          body: null,
          html_url: "https://github.com/Blockcast/magma/pull/978",
          head: { ref: "review-pool-concurrency", sha: headSha },
        },
        repository: { full_name: "Blockcast/magma" },
      });
      return request(app)
        .post("/api/webhooks/github")
        .set("x-github-event", "pull_request")
        .set("x-hub-signature-256", signed.signature)
        .set("x-github-delivery", deliveryId)
        .set("content-type", "application/json")
        .send(signed.body);
    };
    const responsesPromise = Promise.all([
      send("opened", "delivery-review-pool-concurrent-opened", "first-head"),
      send("synchronize", "delivery-review-pool-concurrent-sync", "second-head"),
    ]);

    try {
      const completedBeforeRelease = await Promise.race([
        responsesPromise.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 250)),
      ]);
      expect(completedBeforeRelease).toBe(false);
    } finally {
      releaseLock();
      await lockHolder;
    }

    const responses = await responsesPromise;
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(responses.every((response) => response.body.reviewerWakeFired === true)).toBe(true);

    const runs = await db
      .select({ agentId: heartbeatRuns.agentId })
      .from(heartbeatRuns)
      .where(inArray(heartbeatRuns.agentId, reviewerAgentIds));
    expect(runs).toHaveLength(1);

    const wakes = await db
      .select({ agentId: agentWakeupRequests.agentId })
      .from(agentWakeupRequests)
      .where(inArray(agentWakeupRequests.agentId, reviewerAgentIds));
    expect(wakes).toHaveLength(2);
    expect(new Set(wakes.map((wake) => wake.agentId))).toEqual(
      new Set([runs[0]?.agentId]),
    );
  });

  it("ignores a GitHub redelivery of a ready_for_review event whose wake already completed (BLO-18953)", async () => {
    const { companyId } = await seedIssueWithIdentifier("BLO-3182");
    const reviewerAgentId = randomUUID();
    await db.insert(agents).values({
      id: reviewerAgentId,
      companyId,
      name: "Ally",
      role: "engineer",
      status: "idle",
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const app = buildApp({ prReviewerAgentId: reviewerAgentId });
    const readyPayload = {
      action: "ready_for_review",
      pull_request: {
        number: 991,
        title: "Fix BLO-3182 webflow blog",
        body: null,
        draft: false,
        html_url: "https://github.com/Blockcast/magma/pull/991",
        head: { ref: "fix/BLO-3182-webflow-blog", sha: "readysha" },
      },
      repository: { full_name: "Blockcast/magma" },
    };
    const deliver = async () => {
      const signed = signedRequest(readyPayload);
      return request(app)
        .post("/api/webhooks/github")
        .set("x-github-event", "pull_request")
        .set("x-hub-signature-256", signed.signature)
        // GitHub reuses the delivery id when it retries or an operator replays.
        .set("x-github-delivery", "delivery-ready-replay")
        .set("content-type", "application/json")
        .send(signed.body);
    };

    const firstRes = await deliver();
    expect(firstRes.status).toBe(200);

    const idempotencyKey =
      "pr_review:Blockcast/magma:991:github_pr_ready_for_review:delivery:delivery-ready-replay";

    const reviewerWakes = async () =>
      db
        .select({ status: agentWakeupRequests.status, idempotencyKey: agentWakeupRequests.idempotencyKey })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.agentId, reviewerAgentId));

    expect(await reviewerWakes()).toEqual([{ status: "queued", idempotencyKey }]);

    // The run consumed the wake and finished. Before BLO-18953's second pass,
    // `completed` was excluded from the precheck for EVERY reason, so replaying
    // this delivery enqueued the already-consumed request all over again.
    await db
      .update(agentWakeupRequests)
      .set({ status: "completed", finishedAt: new Date() })
      .where(eq(agentWakeupRequests.idempotencyKey, idempotencyKey));

    const replayRes = await deliver();
    expect(replayRes.status).toBe(200);
    expect(await reviewerWakes()).toEqual([{ status: "completed", idempotencyKey }]);

    // Same rule for a request retired by pull_request.converted_to_draft: a late
    // replay must not resurrect reviewer work on a PR that is a draft again.
    await db
      .update(agentWakeupRequests)
      .set({ status: "cancelled" })
      .where(eq(agentWakeupRequests.idempotencyKey, idempotencyKey));

    const replayAfterCancel = await deliver();
    expect(replayAfterCancel.status).toBe(200);
    expect(await reviewerWakes()).toEqual([{ status: "cancelled", idempotencyKey }]);

    const reviewerRuns = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, reviewerAgentId));
    expect(reviewerRuns).toHaveLength(1);
  });

  it("dedupes rapid pull_request.synchronize pushes and suppresses only synchronize author wakes", async () => {
    const { companyId, agentId: authorAgentId } = await seedIssueWithIdentifier("BLO-3182");
    const reviewerAgentId = randomUUID();
    await db.insert(agents).values({
      id: reviewerAgentId,
      companyId,
      name: "Ally",
      role: "engineer",
      status: "idle",
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const app = buildApp({ prReviewerAgentId: reviewerAgentId });
    const synchronizePayload = (headSha: string) => ({
      action: "synchronize",
      pull_request: {
        number: 981,
        title: "Fix BLO-3182 webflow blog",
        body: null,
        html_url: "https://github.com/Blockcast/magma/pull/981",
        head: { ref: "fix/BLO-3182-webflow-blog", sha: headSha },
      },
      repository: { full_name: "Blockcast/magma" },
    });

    const first = signedRequest(synchronizePayload("push1sha"));
    const firstRes = await request(app)
      .post("/api/webhooks/github")
      .set("x-github-event", "pull_request")
      .set("x-hub-signature-256", first.signature)
      .set("x-github-delivery", "delivery-sync-1")
      .set("content-type", "application/json")
      .send(first.body);

    const second = signedRequest(synchronizePayload("push2sha"));
    const secondRes = await request(app)
      .post("/api/webhooks/github")
      .set("x-github-event", "pull_request")
      .set("x-hub-signature-256", second.signature)
      .set("x-github-delivery", "delivery-sync-2")
      .set("content-type", "application/json")
      .send(second.body);

    expect(firstRes.status).toBe(200);
    expect(secondRes.status).toBe(200);
    expect(firstRes.body.wakes).toEqual([]);
    expect(secondRes.body.wakes).toEqual([]);

    const reviewerWakes = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        idempotencyKey: agentWakeupRequests.idempotencyKey,
        payload: agentWakeupRequests.payload,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, reviewerAgentId));
    expect(reviewerWakes).toHaveLength(2);
    expect(reviewerWakes).toContainEqual(expect.objectContaining({
      status: "queued",
      reason: "github_pr_synchronized",
      idempotencyKey: "pr_review:Blockcast/magma:981:github_pr_synchronized:delivery:delivery-sync-1",
      payload: expect.objectContaining({
        taskKey: "pr_review:Blockcast/magma:981",
        source: "github",
        event: "pull_request",
        deliveryId: "delivery-sync-1",
        prNumber: 981,
        repoFullName: "Blockcast/magma",
        headSha: "push1sha",
        paperclipIdentifiers: ["BLO-3182"],
        reviewKind: "pr_review",
      }),
    }));
    expect(reviewerWakes).toContainEqual(expect.objectContaining({
      status: "coalesced",
      reason: "github_pr_synchronized",
      idempotencyKey: "pr_review:Blockcast/magma:981:github_pr_synchronized:delivery:delivery-sync-2",
    }));

    const reviewerRuns = await db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, reviewerAgentId));
    expect(reviewerRuns).toHaveLength(1);
    expect(reviewerRuns[0]?.contextSnapshot).toMatchObject({
      taskKey: "pr_review:Blockcast/magma:981",
      githubHeadSha: "push2sha",
      githubDeliveryId: "delivery-sync-2",
    });

    const authorWakesAfterSynchronize = await db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, authorAgentId));
    expect(authorWakesAfterSynchronize).toHaveLength(0);

    const ciPayload = {
      action: "completed",
      check_run: {
        head_branch: "fix/BLO-3182-webflow-blog",
        head_sha: "push2sha",
        html_url: "https://github.com/Blockcast/magma/actions/runs/1/job/2",
        pull_requests: [{ number: 981, head: { ref: "fix/BLO-3182-webflow-blog" } }],
      },
      repository: { full_name: "Blockcast/magma" },
    };
    const ci = signedRequest(ciPayload);
    const ciRes = await request(app)
      .post("/api/webhooks/github")
      .set("x-github-event", "check_run")
      .set("x-hub-signature-256", ci.signature)
      .set("x-github-delivery", "delivery-ci-after-sync")
      .set("content-type", "application/json")
      .send(ci.body);

    expect(ciRes.status).toBe(200);
    expect(ciRes.body.wakes).toEqual([{ issueIdentifier: "BLO-3182", agentId: authorAgentId }]);
    const authorWakesAfterCi = await db
      .select({
        reason: agentWakeupRequests.reason,
        payload: agentWakeupRequests.payload,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, authorAgentId));
    expect(authorWakesAfterCi).toHaveLength(1);
    expect(authorWakesAfterCi[0]).toMatchObject({
      reason: "github_check_completed",
      payload: expect.objectContaining({
        source: "github",
        event: "check_run",
        deliveryId: "delivery-ci-after-sync",
        prNumber: 981,
        repoFullName: "Blockcast/magma",
      }),
    });
  });

  it("cancels queued reviewer runs across the reviewer pool when the PR closes", async () => {
    const { companyId, agentId: firstReviewerId } = await seedCompanyAndAgent({
      agentName: "Ally",
    });
    const secondReviewerId = randomUUID();
    const reviewerAgentIds = [firstReviewerId, secondReviewerId];
    await db.insert(agents).values({
      id: secondReviewerId,
      companyId,
      name: "Ally 2",
      role: "engineer",
      status: "idle",
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const taskKey = "pr_review:Blockcast/paperclip:981";
    const wakeupIds = [randomUUID(), randomUUID()];
    const runIds = [randomUUID(), randomUUID()];

    await db.insert(agentWakeupRequests).values(
      wakeupIds.map((id, index) => ({
        id,
        companyId,
        agentId: reviewerAgentIds[index],
        source: "automation",
        triggerDetail: "system",
        reason: "github_pr_synchronized",
        status: "queued",
        runId: runIds[index],
      })),
    );
    await db.insert(heartbeatRuns).values(
      runIds.map((id, index) => ({
        id,
        companyId,
        agentId: reviewerAgentIds[index],
        invocationSource: "automation",
        triggerDetail: "system",
        status: "queued",
        wakeupRequestId: wakeupIds[index],
        contextSnapshot: {
          taskKey,
          reviewKind: "pr_review",
          wakeReason: "github_pr_synchronized",
          githubPrNumber: 981,
          githubRepoFullName: "Blockcast/paperclip",
        },
      })),
    );

    const app = buildApp({ prReviewerAgentIds: reviewerAgentIds });
    const payload = {
      action: "closed",
      pull_request: {
        number: 981,
        title: "Fix reviewer queue",
        body: null,
        html_url: "https://github.com/Blockcast/paperclip/pull/981",
        merged: true,
        head: { ref: "fix/reviewer-queue", sha: "head-sha" },
        user: { login: "codex" },
      },
      repository: { full_name: "Blockcast/paperclip" },
    };
    const { body, signature } = signedRequest(payload);
    const response = await request(app)
      .post("/api/webhooks/github")
      .set("x-github-event", "pull_request")
      .set("x-hub-signature-256", signature)
      .set("x-github-delivery", "delivery-pr-closed")
      .set("content-type", "application/json")
      .send(body);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      ignored: "no_paperclip_identifier",
      reviewerWakeFired: false,
      reviewerRunsCancelled: 2,
    });

    const runs = await db
      .select({ agentId: heartbeatRuns.agentId, status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(inArray(heartbeatRuns.agentId, reviewerAgentIds));
    const wakeups = await db
      .select({ agentId: agentWakeupRequests.agentId, status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(inArray(agentWakeupRequests.agentId, reviewerAgentIds));
    expect(new Set(runs.map((run) => run.agentId))).toEqual(new Set(reviewerAgentIds));
    expect(new Set(wakeups.map((wake) => wake.agentId))).toEqual(new Set(reviewerAgentIds));
    expect(runs.map((run) => run.status)).toEqual(["cancelled", "cancelled"]);
    expect(wakeups.map((wake) => wake.status)).toEqual(["cancelled", "cancelled"]);
  });

  it("cancels pending reviewer work when the PR becomes a draft", async () => {
    const { companyId, agentId: authorAgentId } = await seedIssueWithIdentifier("BLO-982");
    const reviewerAgentId = randomUUID();
    await db.insert(agents).values({
      id: reviewerAgentId,
      companyId,
      name: "Ally",
      role: "engineer",
      status: "idle",
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const taskKey = "pr_review:Blockcast/paperclip:982";
    const runId = randomUUID();

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: reviewerAgentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "scheduled_retry",
      scheduledRetryAt: new Date(Date.now() + 5 * 60 * 1000),
      scheduledRetryReason: "ccrotate_capacity",
      contextSnapshot: {
        taskKey,
        reviewKind: "pr_review",
        wakeReason: "github_pr_synchronized",
        githubPrNumber: 982,
        githubRepoFullName: "Blockcast/paperclip",
      },
    });

    const app = buildApp({ prReviewerAgentId: reviewerAgentId });
    const payload = {
      action: "converted_to_draft",
      pull_request: {
        number: 982,
        title: "BLO-982 Pause reviewer work",
        body: null,
        draft: true,
        html_url: "https://github.com/Blockcast/paperclip/pull/982",
        merged: false,
        head: { ref: "draft/reviewer-queue", sha: "head-sha" },
        user: { login: "codex" },
      },
      repository: { full_name: "Blockcast/paperclip" },
    };
    const { body, signature } = signedRequest(payload);
    const response = await request(app)
      .post("/api/webhooks/github")
      .set("x-github-event", "pull_request")
      .set("x-hub-signature-256", signature)
      .set("x-github-delivery", "delivery-pr-converted-to-draft")
      .set("content-type", "application/json")
      .send(body);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      wakes: [],
      reviewerRunsCancelled: 1,
    });

    const [run] = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId));
    expect(run?.status).toBe("cancelled");

    const authorWakes = await db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, authorAgentId));
    expect(authorWakes).toEqual([]);
  });

  it("does not permanently block reviewer wakes once a dispatch retry chain is exhausted (BLO-14395 regression)", async () => {
    const reviewerAgentId = randomUUID();
    const { companyId } = await seedCompanyAndAgent();
    await db.insert(agents).values({
      id: reviewerAgentId,
      companyId,
      name: "Ally",
      role: "engineer",
      status: "idle",
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const app = buildApp({ prReviewerAgentId: reviewerAgentId });
    const synchronizePayload = (headSha: string) => ({
      action: "synchronize",
      pull_request: {
        number: 630,
        title: "fix(heartbeat): wake-dispatch retry",
        body: null,
        html_url: "https://github.com/Blockcast/paperclip/pull/630",
        head: { ref: "fix/blo-14395-wake-dispatch-retry", sha: headSha },
      },
      repository: { full_name: "Blockcast/paperclip" },
    });

    // Simulate a prior synchronize event whose wake dispatch retried and
    // exhausted (5 attempts, all failed) under the old stable key. Fresh
    // synchronize deliveries must not be blocked by that stale row.
    const staleIdempotencyKey = "pr_review:Blockcast/paperclip:630:github_pr_synchronized";
    const freshIdempotencyKey =
      "pr_review:Blockcast/paperclip:630:github_pr_synchronized:delivery:delivery-post-exhaustion";
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId: reviewerAgentId,
      source: "github",
      reason: "github_pr_synchronized",
      idempotencyKey: staleIdempotencyKey,
      status: "dispatch_failed_exhausted",
      payload: { taskKey: "pr_review:Blockcast/paperclip:630" },
    });

    const fresh = signedRequest(synchronizePayload("freshsha"));
    const res = await request(app)
      .post("/api/webhooks/github")
      .set("x-github-event", "pull_request")
      .set("x-hub-signature-256", fresh.signature)
      .set("x-github-delivery", "delivery-post-exhaustion")
      .set("content-type", "application/json")
      .send(fresh.body);

    expect(res.status).toBe(200);

    const queuedWakes = await db
      .select({ status: agentWakeupRequests.status, payload: agentWakeupRequests.payload })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.agentId, reviewerAgentId),
          eq(agentWakeupRequests.idempotencyKey, freshIdempotencyKey),
          eq(agentWakeupRequests.status, "queued"),
        ),
      );
    expect(queuedWakes).toHaveLength(1);
    expect(queuedWakes[0]?.payload).toMatchObject({ headSha: "freshsha" });
  });

  it("re-reviews a PR after a fixup push even though the prior review completed (stale-head regression)", async () => {
    const reviewerAgentId = randomUUID();
    const { companyId } = await seedCompanyAndAgent();
    await db.insert(agents).values({
      id: reviewerAgentId,
      companyId,
      name: "Ally",
      role: "engineer",
      status: "idle",
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const app = buildApp({ prReviewerAgentId: reviewerAgentId });
    const synchronizePayload = (headSha: string) => ({
      action: "synchronize",
      pull_request: {
        number: 813,
        title: "feat: some change",
        body: null,
        html_url: "https://github.com/Blockcast/paperclip/pull/813",
        head: { ref: "feat/some-change", sha: headSha },
      },
      repository: { full_name: "Blockcast/paperclip" },
    });

    // A prior synchronize was reviewed to COMPLETION on an earlier head under
    // the old stable key. Fresh synchronize deliveries must not be blocked by
    // that stale row.
    const staleIdempotencyKey = "pr_review:Blockcast/paperclip:813:github_pr_synchronized";
    const freshIdempotencyKey =
      "pr_review:Blockcast/paperclip:813:github_pr_synchronized:delivery:delivery-fixup-after-completed-review";
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId: reviewerAgentId,
      source: "github",
      reason: "github_pr_synchronized",
      idempotencyKey: staleIdempotencyKey,
      status: "completed",
      payload: { taskKey: "pr_review:Blockcast/paperclip:813", headSha: "oldhead" },
    });

    // Author pushes a fixup; the review gate is now pending on the new head. A
    // completed review of the earlier head must NOT permanently block this
    // re-review (that was the stale-head bug: `completed` in
    // IDEMPOTENT_REVIEWER_WAKE_STATUSES).
    const fresh = signedRequest(synchronizePayload("newhead"));
    const res = await request(app)
      .post("/api/webhooks/github")
      .set("x-github-event", "pull_request")
      .set("x-hub-signature-256", fresh.signature)
      .set("x-github-delivery", "delivery-fixup-after-completed-review")
      .set("content-type", "application/json")
      .send(fresh.body);

    expect(res.status).toBe(200);

    const queuedWakes = await db
      .select({ status: agentWakeupRequests.status, payload: agentWakeupRequests.payload })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.agentId, reviewerAgentId),
          eq(agentWakeupRequests.idempotencyKey, freshIdempotencyKey),
          eq(agentWakeupRequests.status, "queued"),
        ),
      );
    expect(queuedWakes).toHaveLength(1);
    expect(queuedWakes[0]?.payload).toMatchObject({ headSha: "newhead" });
  });

  it("does not let a completed opened wake suppress a fresh delivery and still dedupes its replay", async () => {
    const reviewerAgentId = randomUUID();
    const { companyId } = await seedCompanyAndAgent();
    await db.insert(agents).values({
      id: reviewerAgentId,
      companyId,
      name: "Ally",
      role: "engineer",
      status: "idle",
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const idempotencyKey = "pr_review:Blockcast/magma:1368:github_pr_opened";
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId: reviewerAgentId,
      source: "github",
      reason: "github_pr_opened",
      idempotencyKey,
      status: "completed",
      payload: { taskKey: "pr_review:Blockcast/magma:1368" },
    });

    const app = buildApp({ prReviewerAgentId: reviewerAgentId });
    const payload = {
      action: "opened",
      pull_request: {
        number: 1368,
        title: "RELAY Wave 0",
        body: null,
        head: { ref: "relay-wave-0", sha: "opened-head-sha" },
      },
      repository: { full_name: "Blockcast/magma" },
    };
    const { body, signature } = signedRequest(payload);
    const sendDelivery = () =>
      request(app)
        .post("/api/webhooks/github")
        .set("x-github-event", "pull_request")
        .set("x-hub-signature-256", signature)
        .set("x-github-delivery", "delivery-opened-fresh")
        .set("content-type", "application/json")
        .send(body);

    const first = await sendDelivery();
    const duplicate = await sendDelivery();

    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      ignored: "no_paperclip_identifier",
      reviewerWakeFired: true,
    });
    expect(duplicate.status).toBe(200);
    expect(duplicate.body).toMatchObject({
      ignored: "no_paperclip_identifier",
      reviewerWakeFired: false,
    });

    const reviewerWakes = await db
      .select({ status: agentWakeupRequests.status, idempotencyKey: agentWakeupRequests.idempotencyKey })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, reviewerAgentId));
    expect(reviewerWakes.filter((wake) => wake.status === "queued")).toEqual([
      expect.objectContaining({ idempotencyKey }),
    ]);
  });

  it("still defers to a pending or resolved dispatch-retry row (dispatch_failed / dispatch_recovered / dispatch_superseded)", async () => {
    const reviewerAgentId = randomUUID();
    const { companyId } = await seedCompanyAndAgent();
    await db.insert(agents).values({
      id: reviewerAgentId,
      companyId,
      name: "Ally",
      role: "engineer",
      status: "idle",
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const app = buildApp({ prReviewerAgentId: reviewerAgentId });
    const openedPayload = (prNumber: number) => ({
      action: "opened",
      pull_request: {
        number: prNumber,
        title: "Some PR",
        body: null,
        head: { ref: "some-branch" },
      },
      repository: { full_name: "Blockcast/paperclip" },
    });

    let prNumber = 700;
    for (const status of ["dispatch_failed", "dispatch_recovered", "dispatch_superseded"] as const) {
      prNumber += 1;
      const idempotencyKey = `pr_review:Blockcast/paperclip:${prNumber}:github_pr_opened`;
      await db.insert(agentWakeupRequests).values({
        companyId,
        agentId: reviewerAgentId,
        source: "github",
        reason: "github_pr_opened",
        idempotencyKey,
        status,
        payload: { taskKey: `pr_review:Blockcast/paperclip:${prNumber}` },
      });

      const { body, signature } = signedRequest(openedPayload(prNumber));
      const res = await request(app)
        .post("/api/webhooks/github")
        .set("x-github-event", "pull_request")
        .set("x-hub-signature-256", signature)
        .set("x-github-delivery", `delivery-opened-${status}`)
        .set("content-type", "application/json")
        .send(body);
      expect(res.status).toBe(200);

      const queuedWakes = await db
        .select({ id: agentWakeupRequests.id })
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.agentId, reviewerAgentId),
            eq(agentWakeupRequests.idempotencyKey, idempotencyKey),
            eq(agentWakeupRequests.status, "queued"),
          ),
        );
      expect(queuedWakes).toHaveLength(0);
    }
  });

  it("drives a reviewer wake for pull_request.reopened even without a paperclip identifier (BLO-7426)", async () => {
    const { agentId } = await seedCompanyAndAgent({ agentName: "Ally" });
    const app = buildApp({ prReviewerAgentId: agentId });
    const payload = {
      action: "reopened",
      pull_request: {
        number: 980,
        title: "Retry reviewer wake",
        body: null,
        head: { ref: "retry-review" },
      },
      repository: { full_name: "Blockcast/magma" },
    };
    const { body, signature } = signedRequest(payload);
    const res = await request(app)
      .post("/api/webhooks/github")
      .set("x-github-event", "pull_request")
      .set("x-hub-signature-256", signature)
      .set("x-github-delivery", "delivery-blo-7426")
      .set("content-type", "application/json")
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ignored: "no_paperclip_identifier",
      reviewerWakeFired: true,
    });

    const runs = await db
      .select({
        status: heartbeatRuns.status,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      status: "queued",
      contextSnapshot: expect.objectContaining({
        taskKey: "pr_review:Blockcast/magma:980",
        wakeReason: "github_pr_reopened",
        wakeSource: "automation",
        wakeTriggerDetail: "system",
        commentSource: "github",
        githubEvent: "pull_request",
        githubDeliveryId: "delivery-blo-7426",
        githubPrNumber: 980,
        githubRepoFullName: "Blockcast/magma",
        reviewKind: "pr_review",
        prRole: "reviewer",
      }),
    });

    const wakes = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        payload: agentWakeupRequests.payload,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({
      status: "queued",
      reason: "github_pr_reopened",
      payload: expect.objectContaining({
        taskKey: "pr_review:Blockcast/magma:980",
        source: "github",
        event: "pull_request",
        deliveryId: "delivery-blo-7426",
        prNumber: 980,
        repoFullName: "Blockcast/magma",
        reviewKind: "pr_review",
      }),
    });
  });

  it("skips the reviewer wake for the reviewer's own review self-echo but still wakes for human and other-bot reviews (BLO-15799)", async () => {
    const { agentId } = await seedCompanyAndAgent({ agentName: "Ally" });
    const app = buildApp({ prReviewerAgentId: agentId, prReviewerBotLogin: "allyblockcast[bot]" });
    const reviewSubmittedPayload = (prNumber: number, reviewAuthorLogin: string) => ({
      action: "submitted",
      pull_request: {
        number: prNumber,
        title: "Some PR",
        body: null,
        html_url: `https://github.com/Blockcast/paperclip/pull/${prNumber}`,
        head: { ref: "some-branch", sha: "cafef00d" },
        user: { login: "codex" },
      },
      review: {
        body: "Consolidated review findings.",
        state: "commented",
        html_url: `https://github.com/Blockcast/paperclip/pull/${prNumber}#pullrequestreview-${prNumber}1`,
        user: { login: reviewAuthorLogin },
      },
      repository: { full_name: "Blockcast/paperclip" },
    });
    const send = async (payload: Record<string, unknown>, deliveryId: string) => {
      const { body, signature } = signedRequest(payload);
      return request(app)
        .post("/api/webhooks/github")
        .set("x-github-event", "pull_request_review")
        .set("x-hub-signature-256", signature)
        .set("x-github-delivery", deliveryId)
        .set("content-type", "application/json")
        .send(body);
    };

    // 1. GitHub echoes the reviewer's own just-posted review straight back as
    //    pull_request_review.submitted — the observed live loop: the echo run
    //    spun a full pod, held the single run slot 1-3 minutes, and exited as
    //    an "already reviewed this head" no-op. No wake may be enqueued.
    const selfEcho = await send(reviewSubmittedPayload(1012, "allyblockcast[bot]"), "delivery-self-echo");
    expect(selfEcho.status).toBe(200);
    expect(selfEcho.body).toMatchObject({
      ignored: "no_paperclip_identifier",
      reviewerWakeFired: false,
    });

    // 2. A human review on the SAME PR still wakes — the self-echo skip must
    //    not consume the PR+reason idempotency key.
    const humanReview = await send(reviewSubmittedPayload(1012, "kkroo"), "delivery-human-review");
    expect(humanReview.status).toBe(200);
    expect(humanReview.body).toMatchObject({
      ignored: "no_paperclip_identifier",
      reviewerWakeFired: true,
    });

    // 3. Another bot's review still wakes — the filter targets the reviewer's
    //    own posting identity, not bots in general.
    const otherBotReview = await send(reviewSubmittedPayload(1013, "coderabbitai[bot]"), "delivery-other-bot");
    expect(otherBotReview.status).toBe(200);
    expect(otherBotReview.body).toMatchObject({
      ignored: "no_paperclip_identifier",
      reviewerWakeFired: true,
    });

    const wakes = await db
      .select({
        reason: agentWakeupRequests.reason,
        idempotencyKey: agentWakeupRequests.idempotencyKey,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakes.map((wake) => wake.idempotencyKey).sort()).toEqual([
      "pr_review:Blockcast/paperclip:1012:github_pr_review_submitted",
      "pr_review:Blockcast/paperclip:1013:github_pr_review_submitted",
    ]);
    expect(wakes.every((wake) => wake.reason === "github_pr_review_submitted")).toBe(true);

    const runs = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(2);
  });

  it("dedupes replayed @ally PR comment reviewer wakes by comment-scoped idempotency key", async () => {
    const { agentId } = await seedCompanyAndAgent({ agentName: "Ally" });
    const app = buildApp({ prReviewerAgentId: agentId });
    const payload = {
      action: "created",
      issue: {
        number: 1193,
        title: "feat(tenants): restore admin capability and ASN APIs",
        body: null,
        html_url: "https://github.com/Blockcast/magma/pull/1193",
        pull_request: { url: "https://api.github.com/repos/Blockcast/magma/pulls/1193" },
        user: { login: "codex" },
      },
      comment: {
        id: 4746466885,
        body: "@ally please review tenant admin API auth and migration safety.",
        html_url: "https://github.com/Blockcast/magma/pull/1193#issuecomment-4746466885",
        user: { login: "kkroo" },
      },
      repository: { full_name: "Blockcast/magma" },
    };
    const { body, signature } = signedRequest(payload);

    const first = await request(app)
      .post("/api/webhooks/github")
      .set("x-github-event", "issue_comment")
      .set("x-hub-signature-256", signature)
      .set("x-github-delivery", "delivery-review-comment-1")
      .set("content-type", "application/json")
      .send(body);
    const replay = await request(app)
      .post("/api/webhooks/github")
      .set("x-github-event", "issue_comment")
      .set("x-hub-signature-256", signature)
      .set("x-github-delivery", "delivery-review-comment-2")
      .set("content-type", "application/json")
      .send(body);

    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      ignored: "no_paperclip_identifier",
      reviewerWakeFired: true,
    });
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({
      ignored: "no_paperclip_identifier",
      reviewerWakeFired: false,
    });

    const runs = await db
      .select({
        status: heartbeatRuns.status,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      status: "queued",
      contextSnapshot: expect.objectContaining({
        taskKey: "pr_review:Blockcast/magma:1193",
        wakeReason: "github_pr_review_requested",
        githubCommentId: 4746466885,
      }),
    });

    const wakes = await db
      .select({
        status: agentWakeupRequests.status,
        idempotencyKey: agentWakeupRequests.idempotencyKey,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({
      status: "queued",
      idempotencyKey: "pr_review:Blockcast/magma:1193:github_pr_review_requested:comment:4746466885",
    });
  });

  it("dedupes a duplicate GitHub delivery of the same @ally review-request comment on the author wake too (BLO-13247)", async () => {
    // BLO-13247: two heartbeatRuns were observed created 19-45ms apart for
    // the same issue, both carrying the IDENTICAL x-github-delivery id and
    // comment url -- the same delivery got processed twice, and unlike the
    // reviewer-wake path above (which prechecks its idempotency key before
    // inserting), the author-wake loop only ever passed its key to
    // heartbeat.wakeup without checking for an existing wake first. This
    // reproduces that duplicate-delivery shape against a matched issue (a
    // BLO- identifier in the PR title) so the author-wake loop actually
    // runs, not just the independent reviewer-wake path.
    const { agentId } = await seedIssueWithIdentifier("BLO-9001");
    const app = buildApp();
    const payload = {
      action: "created",
      issue: {
        number: 582,
        title: "fix(docker): wrap gh to read live GitHub App token (BLO-9001)",
        body: null,
        html_url: "https://github.com/Blockcast/paperclip/pull/582",
        pull_request: { url: "https://api.github.com/repos/Blockcast/paperclip/pulls/582" },
        user: { login: "allyblockcast[bot]" },
      },
      comment: {
        id: 4871387911,
        body: "@ally please review",
        html_url: "https://github.com/Blockcast/paperclip/pull/582#issuecomment-4871387911",
        user: { login: "kkroo" },
      },
      repository: { full_name: "Blockcast/paperclip" },
    };
    const { body, signature } = signedRequest(payload);

    const first = await request(app)
      .post("/api/webhooks/github")
      .set("x-github-event", "issue_comment")
      .set("x-hub-signature-256", signature)
      .set("x-github-delivery", "delivery-author-dupe-1")
      .set("content-type", "application/json")
      .send(body);
    const replay = await request(app)
      .post("/api/webhooks/github")
      .set("x-github-event", "issue_comment")
      .set("x-hub-signature-256", signature)
      .set("x-github-delivery", "delivery-author-dupe-2")
      .set("content-type", "application/json")
      .send(body);

    expect(first.status).toBe(200);
    expect(first.body.wakes).toEqual([{ issueIdentifier: "BLO-9001", agentId }]);
    expect(replay.status).toBe(200);
    expect(replay.body.wakes).toEqual([]);
    expect(replay.body.skipped).toContainEqual({
      issueIdentifier: "BLO-9001",
      reason: "duplicate_pr_author_wake",
    });

    const runs = await db
      .select({ status: heartbeatRuns.status, contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      status: "queued",
      contextSnapshot: expect.objectContaining({
        wakeReason: "github_pr_review_requested",
        prRole: "author",
      }),
    });

    const wakes = await db
      .select({ status: agentWakeupRequests.status, idempotencyKey: agentWakeupRequests.idempotencyKey })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({
      status: "queued",
      idempotencyKey: expect.stringContaining(
        ":Blockcast/paperclip:582:github_pr_review_requested:comment:4871387911",
      ),
    });
  });

  it("dedupes an @ally comment redelivery on the author wake after it completed or was cancelled (BLO-18953)", async () => {
    // Route-level companion to the reviewer redelivery test above. BLO-18953's
    // final pass made terminal-status dedup depend on the key's SCOPE, and the
    // author path shares that helper: its github_pr_review_requested key is
    // comment-scoped, i.e. request-scoped, so `completed` and `cancelled` must
    // dedup here too. __test_idempotentWakeStatuses pins the classification,
    // and the BLO-13247 test above only redelivers while the wake is still
    // `queued` -- neither proves the author dispatch threads the scope through
    // to its precheck, so that wiring could regress with both staying green.
    const { agentId } = await seedIssueWithIdentifier("BLO-9002");
    const app = buildApp();
    const commentPayload = (commentId: number) => ({
      action: "created",
      issue: {
        number: 846,
        title: "fix(github-webhook): dedup request-scoped redeliveries (BLO-9002)",
        body: null,
        html_url: "https://github.com/Blockcast/paperclip/pull/846",
        pull_request: { url: "https://api.github.com/repos/Blockcast/paperclip/pulls/846" },
        user: { login: "allyblockcast[bot]" },
      },
      comment: {
        id: commentId,
        body: "@ally please review",
        html_url: `https://github.com/Blockcast/paperclip/pull/846#issuecomment-${commentId}`,
        user: { login: "kkroo" },
      },
      repository: { full_name: "Blockcast/paperclip" },
    });
    const deliver = async (commentId: number, deliveryId: string) => {
      const signed = signedRequest(commentPayload(commentId));
      return request(app)
        .post("/api/webhooks/github")
        .set("x-github-event", "issue_comment")
        .set("x-hub-signature-256", signed.signature)
        .set("x-github-delivery", deliveryId)
        .set("content-type", "application/json")
        .send(signed.body);
    };
    const authorWakes = async () =>
      db
        .select({ status: agentWakeupRequests.status, idempotencyKey: agentWakeupRequests.idempotencyKey })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.agentId, agentId));
    const authorHeartbeatRuns = async () =>
      db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    const keyForComment = (commentId: number) =>
      expect.stringContaining(
        `:Blockcast/paperclip:846:github_pr_review_requested:comment:${commentId}`,
      );

    const first = await deliver(4900000021, "delivery-author-terminal-1");
    expect(first.status).toBe(200);
    expect(first.body.wakes).toEqual([{ issueIdentifier: "BLO-9002", agentId }]);
    expect(await authorWakes()).toEqual([
      { status: "queued", idempotencyKey: keyForComment(4900000021) },
    ]);

    // The author's run consumed the wake and finished. Replaying that one
    // delivery must not re-enqueue the request it already served.
    await db
      .update(agentWakeupRequests)
      .set({ status: "completed", finishedAt: new Date() })
      .where(eq(agentWakeupRequests.agentId, agentId));

    const afterCompleted = await deliver(4900000021, "delivery-author-terminal-2");
    expect(afterCompleted.status).toBe(200);
    expect(afterCompleted.body.wakes).toEqual([]);
    expect(afterCompleted.body.skipped).toContainEqual({
      issueIdentifier: "BLO-9002",
      reason: "duplicate_pr_author_wake",
    });
    expect(await authorWakes()).toEqual([
      { status: "completed", idempotencyKey: keyForComment(4900000021) },
    ]);

    // Same rule once the request has been retired to `cancelled`.
    await db
      .update(agentWakeupRequests)
      .set({ status: "cancelled" })
      .where(eq(agentWakeupRequests.agentId, agentId));

    const afterCancelled = await deliver(4900000021, "delivery-author-terminal-3");
    expect(afterCancelled.status).toBe(200);
    expect(afterCancelled.body.wakes).toEqual([]);
    expect(afterCancelled.body.skipped).toContainEqual({
      issueIdentifier: "BLO-9002",
      reason: "duplicate_pr_author_wake",
    });
    expect(await authorWakes()).toEqual([
      { status: "cancelled", idempotencyKey: keyForComment(4900000021) },
    ]);

    expect(await authorHeartbeatRuns()).toHaveLength(1);

    // The other half of the scope rule: terminal dedup must stay confined to
    // the redelivered event. A genuinely NEW @ally comment carries a new
    // comment id, so the precheck lets it through -- otherwise request-scoping
    // would inherit exactly the permanent block that stable keys suffer.
    //
    // Its wake lands `coalesced` rather than `queued` because the first run is
    // still sitting in `queued`, and merging into a not-yet-started run is the
    // benign case BLO-18953 deliberately preserved: that run reads live PR
    // state when it starts, so the request is served, not lost. The point here
    // is that a wake row for the new comment EXISTS at all -- under the old
    // stable-key rule the terminal row above would have suppressed it forever.
    const laterComment = await deliver(4900000022, "delivery-author-terminal-4");
    expect(laterComment.status).toBe(200);
    expect(laterComment.body.wakes).toEqual([{ issueIdentifier: "BLO-9002", agentId }]);
    expect(laterComment.body.skipped ?? []).not.toContainEqual({
      issueIdentifier: "BLO-9002",
      reason: "duplicate_pr_author_wake",
    });
    const wakesAfterLaterComment = await authorWakes();
    expect(wakesAfterLaterComment).toHaveLength(2);
    expect(wakesAfterLaterComment).toEqual(
      expect.arrayContaining([
        { status: "cancelled", idempotencyKey: keyForComment(4900000021) },
        { status: "coalesced", idempotencyKey: keyForComment(4900000022) },
      ]),
    );
    expect(await authorHeartbeatRuns()).toHaveLength(1);
  });

  it("drives the reviewer wake AND preserves the author wake for a marker-prefixed agent review request (BLO-18865)", async () => {
    // Route-level coverage for the marker path: the pure-helper tests stop at
    // context classification, so dispatch wiring could regress while they stay
    // green. Asserts the two counts that matter -- exactly one reviewer wake,
    // and the author wake still fires.
    //
    // The author wake is the regression guard. The marker rides the shared
    // Paperclip GitHub App identity, so the route cannot tell "the PR author
    // is asking for a re-review of its own work" from "a manager or peer agent
    // is asking for a review of someone else's PR". Suppressing the author
    // wake on the marker alone silently drops the notification in the second
    // case. Here the PR is authored by `codex` and the request arrives under
    // the app identity -- a third-party request -- and BLO-18865's assignee
    // must still be woken.
    const { companyId, agentId: authorAgentId } = await seedIssueWithIdentifier("BLO-18865");
    const reviewerAgentId = randomUUID();
    await db.insert(agents).values({
      id: reviewerAgentId,
      companyId,
      name: "Ally",
      role: "engineer",
      status: "idle",
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const app = buildApp({
      prReviewerAgentId: reviewerAgentId,
      prReviewerBotLogin: "allyblockcast[bot]",
    });

    const commentPayload = (commentId: number, body: string) => ({
      action: "created",
      issue: {
        number: 822,
        title: "fix(github-webhook): let agents request an Ally re-review (BLO-18865)",
        body: null,
        html_url: "https://github.com/Blockcast/paperclip/pull/822",
        pull_request: { url: "https://api.github.com/repos/Blockcast/paperclip/pulls/822" },
        user: { login: "codex" },
      },
      comment: {
        id: commentId,
        body,
        html_url: `https://github.com/Blockcast/paperclip/pull/822#issuecomment-${commentId}`,
        user: { login: "allyblockcast[bot]" },
      },
      repository: { full_name: "Blockcast/paperclip" },
    });
    const send = async (payload: Record<string, unknown>, deliveryId: string) => {
      const { body, signature } = signedRequest(payload);
      return request(app)
        .post("/api/webhooks/github")
        .set("x-github-event", "issue_comment")
        .set("x-hub-signature-256", signature)
        .set("x-github-delivery", deliveryId)
        .set("content-type", "application/json")
        .send(body);
    };

    const marked = await send(
      commentPayload(4900000010, "<!-- paperclip:review-request -->\n@ally please re-review at head ea8697d1."),
      "delivery-agent-marker",
    );
    expect(marked.status).toBe(200);
    // NB: the response only carries `reviewerWakeFired` on the
    // no_paperclip_identifier early-return. This PR's title matches BLO-18865,
    // so the reviewer wake is asserted against the DB below instead.
    expect(marked.body.wakes).toEqual([{ issueIdentifier: "BLO-18865", agentId: authorAgentId }]);

    // The same body INDENTED at byte 0 is a Markdown code block -- a rendered
    // example, not a request -- and must not re-arm the #583 refire loop. This
    // is the offset-zero anchor asserted through the route, not just the
    // helper: a fresh comment id means nothing downstream would dedup it.
    const indentedExample = await send(
      commentPayload(4900000011, "    <!-- paperclip:review-request -->\n    @ally review\n"),
      "delivery-indented-example",
    );
    expect(indentedExample.status).toBe(200);
    // Not a request and not review feedback, so resolveEventContext returns
    // null and the route short-circuits before any identifier matching --
    // which is why `reviewerWakeFired` is observable on this one.
    expect(indentedExample.body).toMatchObject({ reviewerWakeFired: false });
    expect(indentedExample.body.wakes ?? []).toEqual([]);

    // Exactly one reviewer wake, from the marked request only.
    const reviewerWakes = await db
      .select({ reason: agentWakeupRequests.reason, idempotencyKey: agentWakeupRequests.idempotencyKey })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, reviewerAgentId));
    expect(reviewerWakes).toHaveLength(1);
    expect(reviewerWakes[0]).toMatchObject({
      reason: "github_pr_review_requested",
      idempotencyKey:
        "pr_review:Blockcast/paperclip:822:github_pr_review_requested:comment:4900000010",
    });

    // ...and exactly one author wake, carrying the author role.
    const authorWakes = await db
      .select({ reason: agentWakeupRequests.reason })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, authorAgentId));
    expect(authorWakes).toHaveLength(1);
    expect(authorWakes[0]).toMatchObject({ reason: "github_pr_review_requested" });

    const authorRuns = await db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, authorAgentId));
    expect(authorRuns).toHaveLength(1);
    expect(authorRuns[0]).toMatchObject({
      contextSnapshot: expect.objectContaining({
        wakeReason: "github_pr_review_requested",
        prRole: "author",
      }),
    });
  });

  it("drives a wake on check_run.completed when the PR head_branch references a paperclip issue (CI completion)", async () => {
    const { agentId, issueId } = await seedIssueWithIdentifier("BLO-3182");
    const app = buildApp();
    const payload = {
      action: "completed",
      check_run: {
        head_branch: "fix/BLO-3182-webflow",
        pull_requests: [{ number: 117, head: { ref: "fix/BLO-3182-webflow" } }],
      },
      repository: { full_name: "Blockcast/paperclip" },
    };
    const { body, signature } = signedRequest(payload);
    const res = await request(app)
      .post("/api/webhooks/github")
      .set("x-github-event", "check_run")
      .set("x-hub-signature-256", signature)
      .set("x-github-delivery", "delivery-abc-123")
      .set("content-type", "application/json")
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body.wakes).toHaveLength(1);
    expect(res.body.wakes[0]).toMatchObject({
      issueIdentifier: "BLO-3182",
      agentId,
    });
    const wakes = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakes).toHaveLength(1);
    const payload0 = wakes[0]!.payload as Record<string, unknown>;
    expect(payload0).toMatchObject({
      issueId,
      source: "github",
      event: "check_run",
      deliveryId: "delivery-abc-123",
      prNumber: 117,
      repoFullName: "Blockcast/paperclip",
      prUrl: "https://github.com/Blockcast/paperclip/pull/117",
      paperclipIdentifiers: ["BLO-3182"],
    });
    expect(wakes[0]!.reason).toBe("github_check_completed");
  });

  it("coalesces GitHub check/suite/workflow completion bursts into one queued issue wake", async () => {
    const { agentId, issueId } = await seedIssueWithIdentifier("BLO-3182");
    const app = buildApp();
    const deliveries = [
      {
        event: "check_run",
        delivery: "delivery-check-run",
        payload: {
          action: "completed",
          check_run: {
            head_branch: "fix/BLO-3182-webflow",
            head_sha: "sha-check-run",
            html_url: "https://github.com/Blockcast/paperclip/actions/runs/1/job/2",
            pull_requests: [{ number: 117, head: { ref: "fix/BLO-3182-webflow" } }],
          },
          repository: { full_name: "Blockcast/paperclip" },
        },
      },
      {
        event: "check_suite",
        delivery: "delivery-check-suite",
        payload: {
          action: "completed",
          check_suite: {
            head_branch: "fix/BLO-3182-webflow",
            head_sha: "sha-check-suite",
            html_url: "https://github.com/Blockcast/paperclip/actions/runs/1",
            pull_requests: [{ number: 117, head: { ref: "fix/BLO-3182-webflow" } }],
          },
          repository: { full_name: "Blockcast/paperclip" },
        },
      },
      {
        event: "workflow_run",
        delivery: "delivery-workflow-run",
        payload: {
          action: "completed",
          workflow_run: {
            head_branch: "fix/BLO-3182-webflow",
            head_sha: "sha-workflow-run",
            html_url: "https://github.com/Blockcast/paperclip/actions/runs/2",
            display_title: "Fix BLO-3182 webflow",
            pull_requests: [{ number: 117, head: { ref: "fix/BLO-3182-webflow" } }],
          },
          repository: { full_name: "Blockcast/paperclip" },
        },
      },
    ];

    for (const delivery of deliveries) {
      const { body, signature } = signedRequest(delivery.payload);
      const res = await request(app)
        .post("/api/webhooks/github")
        .set("x-github-event", delivery.event)
        .set("x-hub-signature-256", signature)
        .set("x-github-delivery", delivery.delivery)
        .set("content-type", "application/json")
        .send(body);
      expect(res.status).toBe(200);
      expect(res.body.wakes).toEqual([{ issueIdentifier: "BLO-3182", agentId }]);
    }

    const runs = await db
      .select({
        status: heartbeatRuns.status,
        triggerDetail: heartbeatRuns.triggerDetail,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      status: "queued",
      triggerDetail: "system",
      contextSnapshot: expect.objectContaining({
        issueId,
        taskId: issueId,
        wakeReason: "github_workflow_completed",
        githubDeliveryId: "delivery-workflow-run",
        githubHeadSha: "sha-workflow-run",
        githubEvent: "workflow_run",
      }),
    });

    const wakes = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        coalescedCount: agentWakeupRequests.coalescedCount,
        payload: agentWakeupRequests.payload,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .orderBy(agentWakeupRequests.requestedAt);
    expect(wakes).toHaveLength(3);
    expect(wakes[0]).toMatchObject({
      status: "queued",
      reason: "github_workflow_completed",
      coalescedCount: 2,
      payload: expect.objectContaining({
        event: "workflow_run",
        deliveryId: "delivery-workflow-run",
        headSha: "sha-workflow-run",
      }),
    });
    expect(wakes.slice(1)).toEqual([
      expect.objectContaining({ status: "coalesced", reason: "github_state_change_queued_coalesced" }),
      expect.objectContaining({ status: "coalesced", reason: "github_state_change_queued_coalesced" }),
    ]);
  });

  it("reopens an in_review issue when Ally posts actionable PR feedback and ignores done siblings on the same PR", async () => {
    const { companyId, agentId, issueId } = await seedIssueWithIdentifier("PEN-1126", { status: "in_review" });
    await db.insert(issues).values({
      id: randomUUID(),
      companyId,
      title: "Already finished child",
      status: "done",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1124,
      identifier: "PEN-1124",
    });

    const app = buildApp({ prReviewerBotLogin: "allyblockcast[bot]" });
    const payload = {
      action: "created",
      issue: {
        number: 269,
        title: "Fix hosted vault onboarding",
        body: "Closes PEN-1126 and PEN-1124",
        html_url: "https://github.com/Blockcast/penstock-llm-proxy-core/pull/269",
        pull_request: { url: "https://api.github.com/repos/Blockcast/penstock-llm-proxy-core/pulls/269" },
        user: { login: "codex-bot" },
      },
      comment: {
        id: 4784546377,
        body: [
          "## Ally — Consolidated PR Review",
          "",
          "### Important Issues (1)",
          "",
          "I1: The vault health probe still points at the wrong route.",
          "",
          "### Recommended Action",
          "",
          "Fix I1 before merge.",
        ].join("\n"),
        html_url: "https://github.com/Blockcast/penstock-llm-proxy-core/pull/269#issuecomment-4784546377",
        user: { login: "allyblockcast[bot]" },
      },
      repository: { full_name: "Blockcast/penstock-llm-proxy-core" },
    };

    const { body, signature } = signedRequest(payload);
    const res = await request(app)
      .post("/api/webhooks/github")
      .set("x-github-event", "issue_comment")
      .set("x-hub-signature-256", signature)
      .set("x-github-delivery", "delivery-ally-feedback-1")
      .set("content-type", "application/json")
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.reopened).toEqual([
      { issueIdentifier: "PEN-1126", commentId: expect.any(String) },
    ]);
    expect(res.body.wakes).toEqual([
      { issueIdentifier: "PEN-1126", agentId },
    ]);
    expect(res.body.skipped).toContainEqual({
      issueIdentifier: "PEN-1124",
      reason: "terminal_status",
    });

    const [updatedIssue] = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId));
    expect(updatedIssue?.status).toBe("in_progress");

    const comments = await db
      .select({ id: issueComments.id, body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]!.body).toContain("## Changes Requested");
    expect(comments[0]!.body).toContain("https://github.com/Blockcast/penstock-llm-proxy-core/pull/269#issuecomment-4784546377");

    const wakes = await db
      .select({
        reason: agentWakeupRequests.reason,
        payload: agentWakeupRequests.payload,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({
      reason: "github_pr_review_feedback",
      payload: expect.objectContaining({
        issueId,
        wakeCommentId: comments[0]!.id,
        source: "github",
        event: "issue_comment",
        prNumber: 269,
        repoFullName: "Blockcast/penstock-llm-proxy-core",
      }),
    });

    const runs = await db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.contextSnapshot).toMatchObject({
      commentId: comments[0]!.id,
      wakeCommentId: comments[0]!.id,
      githubReviewFeedbackCommentId: comments[0]!.id,
    });

    const duplicateRes = await request(app)
      .post("/api/webhooks/github")
      .set("x-github-event", "issue_comment")
      .set("x-hub-signature-256", signature)
      .set("x-github-delivery", "delivery-ally-feedback-1")
      .set("content-type", "application/json")
      .send(body);
    expect(duplicateRes.status).toBe(200);
    expect(duplicateRes.body.skipped).toContainEqual({
      issueIdentifier: "PEN-1126",
      reason: "duplicate_review_feedback",
    });

    const commentsAfterDuplicate = await db
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId));
    expect(commentsAfterDuplicate).toHaveLength(1);
    const wakesAfterDuplicate = await db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakesAfterDuplicate).toHaveLength(1);
  });

  it("does not count same-number PR feedback cycles from other repos", async () => {
    const { companyId, agentId, issueId } = await seedIssueWithIdentifier("PEN-1126", { status: "in_review" });
    await db.insert(issueComments).values({
      companyId,
      issueId,
      authorType: "system",
      body: "Prior feedback from another repo with the same PR number.",
      metadata: {
        kind: "github_pr_review_feedback",
        repoFullName: "Blockcast/other-repo",
        prNumber: 269,
      } as never,
    });

    const app = buildApp({
      prReviewerBotLogin: "allyblockcast[bot]",
      selfReviewEscalationThreshold: 2,
    });
    const payload = {
      action: "created",
      issue: {
        number: 269,
        title: "Fix hosted vault onboarding",
        body: "Closes PEN-1126",
        html_url: "https://github.com/Blockcast/penstock-llm-proxy-core/pull/269",
        pull_request: { url: "https://api.github.com/repos/Blockcast/penstock-llm-proxy-core/pulls/269" },
        user: { login: "allyblockcast[bot]" },
      },
      comment: {
        id: 4784546378,
        body: "## Ally — Consolidated PR Review\n\n### Important Issues (1)\n\nFix before merge.",
        html_url: "https://github.com/Blockcast/penstock-llm-proxy-core/pull/269#issuecomment-4784546378",
        user: { login: "allyblockcast[bot]" },
      },
      repository: { full_name: "Blockcast/penstock-llm-proxy-core" },
    };

    const { body, signature } = signedRequest(payload);
    const res = await request(app)
      .post("/api/webhooks/github")
      .set("x-github-event", "issue_comment")
      .set("x-hub-signature-256", signature)
      .set("x-github-delivery", "delivery-ally-feedback-repo-scope")
      .set("content-type", "application/json")
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.escalated).toBeUndefined();
    expect(res.body.wakes).toEqual([{ issueIdentifier: "PEN-1126", agentId }]);
  });

  it("counts legacy PR feedback cycles without repo metadata for the same issue and PR", async () => {
    const { companyId, agentId, issueId } = await seedIssueWithIdentifier("PEN-1126", { status: "in_review" });
    await db.insert(issueComments).values({
      companyId,
      issueId,
      authorType: "system",
      body: "Prior feedback before repoFullName was persisted in metadata.",
      metadata: {
        kind: "github_pr_review_feedback",
        prNumber: 269,
      } as never,
    });

    const app = buildApp({
      prReviewerBotLogin: "allyblockcast[bot]",
      selfReviewEscalationThreshold: 2,
    });
    const payload = {
      action: "created",
      issue: {
        number: 269,
        title: "Fix hosted vault onboarding",
        body: "Closes PEN-1126",
        html_url: "https://github.com/Blockcast/penstock-llm-proxy-core/pull/269",
        pull_request: { url: "https://api.github.com/repos/Blockcast/penstock-llm-proxy-core/pulls/269" },
        user: { login: "allyblockcast[bot]" },
      },
      comment: {
        id: 4784546380,
        body: "## Ally — Consolidated PR Review\n\n### Important Issues (1)\n\nFix before merge.",
        html_url: "https://github.com/Blockcast/penstock-llm-proxy-core/pull/269#issuecomment-4784546380",
        user: { login: "allyblockcast[bot]" },
      },
      repository: { full_name: "Blockcast/penstock-llm-proxy-core" },
    };

    const { body, signature } = signedRequest(payload);
    const res = await request(app)
      .post("/api/webhooks/github")
      .set("x-github-event", "issue_comment")
      .set("x-hub-signature-256", signature)
      .set("x-github-delivery", "delivery-ally-feedback-legacy-repo-metadata")
      .set("content-type", "application/json")
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.escalated).toEqual([
      { issueIdentifier: "PEN-1126", ownerAgentId: null, ownerType: "board", cycles: 2 },
    ]);
    expect(res.body.wakes).toEqual([]);

    const authorWakes = await db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(authorWakes).toEqual([]);
  });

  it("escalates self-reviewed PR feedback at threshold without re-waking the assignee", async () => {
    const { agentId, issueId } = await seedIssueWithIdentifier("PEN-1126", { status: "in_review" });
    const app = buildApp({
      prReviewerBotLogin: "allyblockcast[bot]",
      selfReviewEscalationThreshold: 1,
    });
    const payload = {
      action: "created",
      issue: {
        number: 269,
        title: "Fix hosted vault onboarding",
        body: "Closes PEN-1126",
        html_url: "https://github.com/Blockcast/penstock-llm-proxy-core/pull/269",
        pull_request: { url: "https://api.github.com/repos/Blockcast/penstock-llm-proxy-core/pulls/269" },
        user: { login: "allyblockcast[bot]" },
      },
      comment: {
        id: 4784546379,
        body: "## Ally — Consolidated PR Review\n\n### Important Issues (1)\n\nFix before merge.",
        html_url: "https://github.com/Blockcast/penstock-llm-proxy-core/pull/269#issuecomment-4784546379",
        user: { login: "allyblockcast[bot]" },
      },
      repository: { full_name: "Blockcast/penstock-llm-proxy-core" },
    };

    const { body, signature } = signedRequest(payload);
    const res = await request(app)
      .post("/api/webhooks/github")
      .set("x-github-event", "issue_comment")
      .set("x-hub-signature-256", signature)
      .set("x-github-delivery", "delivery-ally-feedback-self-review-escalate")
      .set("content-type", "application/json")
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.escalated).toEqual([
      { issueIdentifier: "PEN-1126", ownerAgentId: null, ownerType: "board", cycles: 1 },
    ]);
    expect(res.body.wakes).toEqual([]);

    const actions = await db
      .select({ ownerType: issueRecoveryActions.ownerType, ownerAgentId: issueRecoveryActions.ownerAgentId })
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, issueId));
    expect(actions).toEqual([{ ownerType: "board", ownerAgentId: null }]);

    const authorWakes = await db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(authorWakes).toEqual([]);
  });

  function dependabotPayload(severity: string, action = "created", alertNumber = 58) {
    return {
      action,
      alert: {
        number: alertNumber,
        html_url: `https://github.com/Blockcast/paperclip/security/dependabot/${alertNumber}`,
        dependency: {
          package: { ecosystem: "npm", name: "vitest" },
          manifest_path: "packages/mcp-gateway/package.json",
        },
        security_advisory: {
          ghsa_id: "GHSA-5xrq-8626-4rwp",
          cve_id: "CVE-2026-47429",
          summary: "When Vitest UI server is listening, arbitrary file can be read and executed",
          severity,
        },
        security_vulnerability: {
          package: { ecosystem: "npm", name: "vitest" },
          severity,
          vulnerable_version_range: "< 3.2.6",
          first_patched_version: { identifier: "3.2.6" },
        },
      },
      repository: { full_name: "Blockcast/paperclip" },
    };
  }

  async function postDependabot(
    app: ReturnType<typeof buildApp>,
    payload: Record<string, unknown>,
    deliveryId = "delivery-dependabot-1",
  ) {
    const { body, signature } = signedRequest(payload);
    return request(app)
      .post("/api/webhooks/github")
      .set("x-github-event", "dependabot_alert")
      .set("x-hub-signature-256", signature)
      .set("x-github-delivery", deliveryId)
      .set("content-type", "application/json")
      .send(body);
  }

  it("drives a remediation wake for a critical dependabot alert", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({ agentName: "Release Engineer" });
    const app = buildApp({ dependabotAgentId: agentId });

    const res = await postDependabot(app, dependabotPayload("critical"));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ignored: "no_paperclip_identifier",
      dependabotWakeFired: true,
    });

    const runs = await db
      .select({ status: heartbeatRuns.status, contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
    const contextSnapshot = runs[0]!.contextSnapshot as Record<string, unknown>;
    expect(contextSnapshot).toMatchObject({
      taskKey: "github-dependabot:Blockcast/paperclip#58",
      wakeReason: "github_dependabot_alert",
      dependabotAlertNumber: 58,
      dependabotSeverity: "critical",
      dependabotPackage: "vitest",
      dependabotGhsaId: "GHSA-5xrq-8626-4rwp",
      dependabotCveId: "CVE-2026-47429",
      dependabotPatchedVersion: "3.2.6",
      dependabotManifestPath: "packages/mcp-gateway/package.json",
    });

    // BLO-16319: the wake must be scoped to a real, assigned Paperclip issue
    // so PAPERCLIP_TASK_ID and the task markdown are populated instead of an
    // empty task that falls back to whatever workspace was last used.
    const issueId = contextSnapshot.issueId as string | undefined;
    expect(typeof issueId).toBe("string");
    const [issue] = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.id, issueId!)));
    expect(issue).toBeTruthy();
    expect(issue!.status).toBe("todo");
    expect(issue!.assigneeAgentId).toBe(agentId);
    expect(issue!.originKind).toBe("github_dependabot_alert");
    expect(issue!.originId).toBe("github-dependabot:Blockcast/paperclip#58");
    expect(issue!.title).toContain("Blockcast/paperclip#58");
    expect(issue!.description).toContain("Blockcast/paperclip");
    expect(issue!.description).toContain("#58");
    expect(issue!.description).toContain("vitest");
    expect(issue!.description).toContain("GHSA-5xrq-8626-4rwp");
    expect(issue!.description).toContain("CVE-2026-47429");
    expect(issue!.description).toContain("critical");
    expect(issue!.description).toContain("< 3.2.6");
    expect(issue!.description).toContain("3.2.6");
    expect(issue!.description).toContain("packages/mcp-gateway/package.json");
    expect(issue!.description).toContain("security/dependabot/58");
  });

  // BLO-19113: the verifying signal used to be a single bullet holding a
  // three-branch disjunction, followed by a bare paragraph about the Dependabot
  // Alerts REST API. A downstream task author read that block, silently dropped
  // the merged-PR branch, and re-read the operational REST aside as an
  // evidentiary rule ("authenticated UI or webhook only") — a standard no agent
  // can satisfy. That misreading blocked an already-remediated high-severity CVE
  // for six days. These assertions pin the disambiguated wording so the
  // disjunction cannot be flattened back into prose.
  it("states the verifying signal as an explicit any-one-of checklist and scopes the REST note", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({ agentName: "Release Engineer" });
    const app = buildApp({ dependabotAgentId: agentId });

    const res = await postDependabot(app, dependabotPayload("critical"));
    expect(res.status).toBe(200);

    const [issue] = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "github_dependabot_alert")));
    const description = issue!.description!;

    // All three sufficient branches survive, each on its own numbered line.
    expect(description).toContain("Any ONE of the following is sufficient and complete evidence");
    expect(description).toMatch(/^1\. The remediation PR merges into the default branch/m);
    expect(description).toMatch(/^2\. .*shows `state: fixed`\.$/m);
    expect(description).toMatch(/^3\. .*shows `state: dismissed`/m);
    // Branch 1 names the concrete manifest + patched version, so it is actionable
    // without re-deriving anything from the alert page.
    expect(description).toMatch(
      /^1\. The remediation PR merges into the default branch of `Blockcast\/paperclip`, AND the default-branch manifest `packages\/mcp-gateway\/package\.json` resolves vitest at 3\.2\.6 or newer\.$/m,
    );

    // Acceptance criteria split remediation from dismissal instead of implying
    // the dismissal path also needs a merged PR.
    expect(description).toContain("Remediation path:");
    expect(description).toContain("Dismissal path:");
    expect(description).toContain("For the remediation path");
    expect(description).toContain("For the dismissal path");

    // The two sentences that directly refute the misreading.
    expect(description).toContain("Do NOT require a screenshot of the alert page");
    expect(description).toContain("never prerequisites");

    // The REST note is a separately-headed operational aside, not a rule about
    // which evidence counts.
    expect(description).toContain("## Note on the Dependabot Alerts REST API (operational, not evidentiary)");
    expect(description).toContain("403 Dependabot alerts are disabled for this repository");
    expect(description).toContain("It is NOT an evidentiary standard");
    expect(description).toContain("does not forbid the repository contents API or GraphQL");

    // The alert-state acceptance criterion must not read as an evidence demand.
    expect(description).toContain("observing it directly is optional");
  });

  it("does not wake below the severity floor (default high)", async () => {
    const { agentId } = await seedCompanyAndAgent({ agentName: "Release Engineer" });
    const app = buildApp({ dependabotAgentId: agentId });

    const res = await postDependabot(app, dependabotPayload("medium"));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ dependabotWakeFired: false });

    const runs = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(0);
  });

  it("honors a lowered severity floor", async () => {
    const { agentId } = await seedCompanyAndAgent({ agentName: "Release Engineer" });
    const app = buildApp({ dependabotAgentId: agentId, dependabotMinSeverity: "medium" });

    const res = await postDependabot(app, dependabotPayload("medium"));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ dependabotWakeFired: true });
  });

  it("acks dependabot alerts without waking when no remediation agent is configured", async () => {
    const app = buildApp();

    const res = await postDependabot(app, dependabotPayload("critical"));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ignored: "no_paperclip_identifier",
      dependabotWakeFired: false,
    });
  });

  it("dedupes a redelivered dependabot created alert via the idempotency key", async () => {
    const { agentId } = await seedCompanyAndAgent({ agentName: "Release Engineer" });
    const app = buildApp({ dependabotAgentId: agentId });

    await postDependabot(app, dependabotPayload("critical"), "delivery-1");
    const res2 = await postDependabot(app, dependabotPayload("critical"), "delivery-2");

    expect(res2.status).toBe(200);
    const wakes = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakes).toHaveLength(1);
  });

  it("reuses the open issue when a reintroduced alert redelivers for the same alert number", async () => {
    const { agentId } = await seedCompanyAndAgent({ agentName: "Release Engineer" });
    const app = buildApp({ dependabotAgentId: agentId });

    const created = await postDependabot(app, dependabotPayload("critical", "created"), "delivery-created");
    expect(created.body).toMatchObject({ dependabotWakeFired: true });

    const reintroduced = await postDependabot(
      app,
      dependabotPayload("critical", "reintroduced"),
      "delivery-reintroduced",
    );
    expect(reintroduced.body).toMatchObject({ dependabotWakeFired: true });

    // One issue per alert (BLO-16319 verifying signal: "replaying the fixture
    // yields a scoped issue ... that the Release Engineer can ... dedupe").
    const alertIssues = await db
      .select()
      .from(issues)
      .where(eq(issues.originKind, "github_dependabot_alert"));
    expect(alertIssues).toHaveLength(1);

    // The reintroduced wake shares the alert's taskKey with the still-queued
    // "created" run, so enqueueWakeup's generic task-scope coalescing
    // (coalescePendingTaskScopeWake) merges it into that one heartbeat run
    // rather than queuing a second -- the same de-duplication every other
    // taskKey-scoped wake gets. `dependabotWakeFired: true` above confirms
    // both deliveries were processed; what matters here is that the run(s)
    // that do exist all point at the single reused issue.
    const runs = await db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs.length).toBeGreaterThanOrEqual(1);
    for (const run of runs) {
      expect((run.contextSnapshot as Record<string, unknown>).issueId).toBe(alertIssues[0]!.id);
    }
  });

  it("records a terminal webhook receipt on the alert issue and closes it", async () => {
    const { agentId } = await seedCompanyAndAgent({ agentName: "Release Engineer" });
    const app = buildApp({ dependabotAgentId: agentId });

    await postDependabot(app, dependabotPayload("critical", "created"), "delivery-created");
    const terminal = await postDependabot(app, dependabotPayload("critical", "fixed"), "delivery-fixed");

    expect(terminal.status).toBe(200);
    expect(terminal.body).toMatchObject({ dependabotWakeFired: false });
    const [issue] = await db
      .select()
      .from(issues)
      .where(eq(issues.originId, "github-dependabot:Blockcast/paperclip#58"));
    expect(issue?.status).toBe("done");
    const receipts = await db
      .select()
      .from(issueComments)
      .where(
        and(
          eq(issueComments.issueId, issue!.id),
          sql`${issueComments.metadata}->>'kind' = 'github_dependabot_terminal_receipt'`,
        ),
      );
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.body).toContain("Action: `fixed`");
    expect(receipts[0]!.body).toContain("GitHub delivery: `delivery-fixed`");
    expect(receipts[0]!.body).toContain("no Dependabot REST or GraphQL query was used");
  });

  it("creates a durable closed receipt issue for an orphan terminal delivery", async () => {
    const { agentId } = await seedCompanyAndAgent({ agentName: "Release Engineer" });
    const app = buildApp({ dependabotAgentId: agentId });

    await postDependabot(app, dependabotPayload("high", "dismissed", 1591), "delivery-dismissed");
    await postDependabot(app, dependabotPayload("high", "dismissed", 1591), "delivery-dismissed");
    const [issue] = await db
      .select()
      .from(issues)
      .where(eq(issues.originId, "github-dependabot:Blockcast/paperclip#1591"));

    expect(issue?.status).toBe("done");
    expect(issue?.title).toContain("terminal receipt");
    expect(issue?.description).toContain("delivery-dismissed");
    const receiptIssues = await db
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.originId, "github-dependabot:Blockcast/paperclip#1591"));
    expect(receiptIssues).toHaveLength(1);
    const receipts = await db
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(sql`${issueComments.metadata}->>'kind' = 'github_dependabot_terminal_receipt'`);
    expect(receipts).toHaveLength(1);
  });

  it("records terminal receipts below the remediation severity floor", async () => {
    const { agentId } = await seedCompanyAndAgent({ agentName: "Release Engineer" });
    const app = buildApp({ dependabotAgentId: agentId });

    await postDependabot(app, dependabotPayload("medium", "fixed", 1592), "delivery-medium-fixed");
    const [issue] = await db
      .select()
      .from(issues)
      .where(eq(issues.originId, "github-dependabot:Blockcast/paperclip#1592"));

    expect(issue?.status).toBe("done");
  });

  it("records a durable diagnostic instead of silently dropping a malformed alert payload", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({ agentName: "Release Engineer" });
    const app = buildApp({ dependabotAgentId: agentId });

    const res = await postDependabot(
      app,
      { action: "created", alert: {}, repository: { full_name: "Blockcast/paperclip" } },
      "delivery-malformed",
    );

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ dependabotWakeFired: false });

    const runs = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(0);

    const diagnostics = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "github_dependabot_webhook_diagnostic")));
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.assigneeAgentId).toBe(agentId);
    expect(diagnostics[0]!.description).toContain("dependabot_alert");
    expect(diagnostics[0]!.description).toContain("delivery-malformed");
    expect(diagnostics[0]!.description).toContain("Blockcast/paperclip");
  });

  it("records a durable diagnostic when the alert payload has no repository", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({ agentName: "Release Engineer" });
    const app = buildApp({ dependabotAgentId: agentId });

    const payloadWithoutRepo: Record<string, unknown> = { ...dependabotPayload("critical") };
    delete payloadWithoutRepo.repository;
    const res = await postDependabot(app, payloadWithoutRepo, "delivery-no-repo");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ dependabotWakeFired: false });

    const diagnostics = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "github_dependabot_webhook_diagnostic")));
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.description).toContain("#58");
    expect(diagnostics[0]!.description).toContain("delivery-no-repo");
  });
});

describe("hasActionablePrReviewFeedback — reviewer taxonomy", () => {
  // Regression guard for the #973 / BLO-12541 stall: a same-identity self-review
  // arrives as an issue_comment (no formal `changes_requested` state), so the
  // author wake depends entirely on the body-text heuristic. The reviewer's
  // output had drifted to "Critical Issues" + "before merging", which the old
  // heuristic ("Important Issues" + "before merge") silently missed.
  it("treats a 'Critical Issues (N>0)' bucket as actionable", () => {
    const body = [
      "## Ally — Consolidated PR Review",
      "### Critical Issues (1)",
      "- probePort points at :3443 but the Service only listens on :443.",
      "### Recommended Action",
      "1. Fix the probePort mismatch (Critical) before merging.",
    ].join("\n");
    expect(__test_hasActionablePrReviewFeedback(body)).toBe(true);
  });

  it("matches the 'before merging' inflection in the recommended-action heuristic", () => {
    const body = "### Recommended Action\nFix the dial host before merging.";
    expect(__test_hasActionablePrReviewFeedback(body)).toBe(true);
  });

  it("still detects the legacy 'Important Issues' + 'before merge' format", () => {
    const body = "### Important Issues (1)\n\n### Recommended Action\nFix I1 before merge.";
    expect(__test_hasActionablePrReviewFeedback(body)).toBe(true);
  });

  it("does not mask a non-zero bucket that follows a zero-count bucket", () => {
    const body = "### Critical Issues (0)\n### Important Issues (2)\n- one\n- two";
    expect(__test_hasActionablePrReviewFeedback(body)).toBe(true);
  });

  it("does not mask an uncounted heading with another label's zero-count bucket", () => {
    const body = [
      "### Critical Issues (0)",
      "",
      "### Important Issues",
      "- Auth check bypasses validation.",
      "",
      "### Recommended Action",
      "Fix before shipping.",
    ].join("\n");
    expect(__test_hasActionablePrReviewFeedback(body)).toBe(true);
  });

  it("does not mask an uncounted heading with the same label's zero-count bucket", () => {
    const body = [
      "### Important Issues (0)",
      "",
      "### Important Issues",
      "- Retry logic can still drop the author wake.",
      "",
      "### Recommended Action",
      "Fix before shipping.",
    ].join("\n");
    expect(__test_hasActionablePrReviewFeedback(body)).toBe(true);
  });

  it("is not actionable when only zero-count severity buckets are present", () => {
    const body = "### Critical Issues (0)\n### Important Issues (0)\n\nLGTM, ship it.";
    expect(__test_hasActionablePrReviewFeedback(body)).toBe(false);
  });

  it("is not actionable when emphasized severity headings only carry zero counts", () => {
    const body = [
      "## Ally — Consolidated PR Review",
      "",
      "### **Critical Issues** (0)",
      "None.",
      "",
      "### **Important Issues** (0)",
      "None.",
      "",
      "### Recommended Action",
      "Merge when required CI passes.",
    ].join("\n");
    expect(__test_hasActionablePrReviewFeedback(body, "approved")).toBe(false);
  });

  it("still treats emphasized non-zero severity buckets as actionable", () => {
    const body = [
      "## Ally — Consolidated PR Review",
      "",
      "### **Critical Issues** (0)",
      "None.",
      "",
      "### **Important Issues** (1)",
      "- The retry remains stranded.",
      "",
      "### Recommended Action",
      "Fix before merge.",
    ].join("\n");
    expect(__test_hasActionablePrReviewFeedback(body, "commented")).toBe(true);
  });

  it("still short-circuits on a formal changes_requested review state", () => {
    expect(__test_hasActionablePrReviewFeedback("looks fine overall", "changes_requested")).toBe(true);
  });

  // Ally review on #654 (BLO-15942): the negation scan originally looked back to
  // the start of the sentence, so a negation cue far earlier in a long sentence
  // could mask a genuine, unrelated "changes requested" later in that same
  // sentence. Bounding the lookback to NEGATION_LOOKBACK_WORDS words shrinks that
  // false-negative window while still suppressing the close-proximity negations
  // (like "No changes requested...") this heuristic exists to catch.
  it("does not let a negation cue far earlier in a long sentence mask a later genuine match", () => {
    const body =
      "not one of these old fixture issues affected the merge outcome whatsoever, so changes requested here.";
    expect(__test_hasActionablePrReviewFeedback(body)).toBe(true);
  });

  it("still suppresses a negation cue close to the match within the same sentence", () => {
    const body = "Clean pass, no changes requested at this time.";
    expect(__test_hasActionablePrReviewFeedback(body)).toBe(false);
  });

  // BLO-19067: Ally's APPROVED review on Network-Operator-Portal#591 read
  // "Looks good. No Critical or Important issues found." The uncounted-heading
  // branch matched the trailing "Important issues" mid-sentence, classified a
  // clean approval as actionable, and bounced the PR back to its author.
  it("does not treat a prose denial of findings as an uncounted findings heading", () => {
    const body = [
      "## Ally — Consolidated PR Review",
      "",
      "Looks good. No Critical or Important issues found.",
      "",
      "### Recommended Action",
      "1. Merge after required CI completes.",
    ].join("\n");
    expect(__test_hasActionablePrReviewFeedback(body, "approved")).toBe(false);
  });

  it("still matches an uncounted findings heading behind list or emphasis decoration", () => {
    expect(__test_hasActionablePrReviewFeedback("- Important Issues\n- Auth check bypassed.")).toBe(true);
    expect(__test_hasActionablePrReviewFeedback("**Critical Issues**\nprobePort mismatch.")).toBe(true);
  });
});

describe("PR review feedback comment heading (BLO-19067)", () => {
  // The heading and the directive beneath it are the highest-salience text in
  // the wake this comment produces. Hardcoding them to the changes-requested
  // case told the author of an APPROVED PR to make another implementation
  // pass; the resulting no-op push invalidates the approval and restarts a
  // 2.2h CI suite.
  const reviewPayload = (state: string, body: string) => ({
    action: "submitted",
    pull_request: {
      number: 591,
      title: "fix(nop): dynamic-service card spacing",
      head: { ref: "fix/BLO-18833", sha: "1db166824d532cda20e321ebb26c6e4702e0dd32" },
    },
    review: {
      body,
      state,
      html_url: "https://github.com/Blockcast/Network-Operator-Portal/pull/591#pullrequestreview-1",
      user: { login: "allyblockcast" },
    },
    repository: { full_name: "Blockcast/Network-Operator-Portal" },
  });

  const commentFor = (state: string, body = "### Critical Issues (1)\n- probePort mismatch.") => {
    const ctx = __test_resolveEventContext("pull_request_review", reviewPayload(state, body));
    expect(ctx).not.toBeNull();
    return __test_buildPrReviewFeedbackComment(ctx!);
  };

  it("titles an APPROVED review as approved, with no implementation-pass directive", () => {
    const comment = commentFor("approved");
    expect(comment).toContain("## Review Approved");
    expect(comment).not.toContain("Changes Requested");
    expect(comment).not.toContain("requires another implementation pass");
    expect(comment).toContain("- State: approved");
  });

  it("titles a CHANGES_REQUESTED review as changes requested", () => {
    const comment = commentFor("changes_requested");
    expect(comment).toContain("## Changes Requested");
    expect(comment).toContain("requires another implementation pass");
    expect(comment).not.toContain("Review Approved");
  });

  it("distinguishes a COMMENTED review from both other states", () => {
    const comment = commentFor("commented");
    expect(comment).toContain("## Review Comments");
    expect(comment).not.toContain("Changes Requested");
    expect(comment).not.toContain("Review Approved");
    expect(comment).not.toContain("requires another implementation pass");
  });

  it("keeps the changes-requested wording when no review state is present", () => {
    // Body-heuristic path: an `issue_comment` review carries no formal state
    // and only reaches this builder when the body already carries findings.
    const ctx = __test_resolveEventContext("issue_comment", {
      action: "created",
      issue: {
        number: 591,
        pull_request: { url: "https://api.github.com/repos/Blockcast/Network-Operator-Portal/pulls/591" },
        user: { login: "codex-bot" },
      },
      comment: {
        id: 1,
        body: "### Important Issues (1)\n\nI1: wrong route.",
        html_url: "https://github.com/Blockcast/Network-Operator-Portal/pull/591#issuecomment-1",
        user: { login: "allyblockcast[bot]" },
      },
      repository: { full_name: "Blockcast/Network-Operator-Portal" },
    });
    expect(ctx).not.toBeNull();
    const comment = __test_buildPrReviewFeedbackComment(ctx!);
    expect(comment).toContain("## Changes Requested");
  });
});

describe("GitHub review state → stage signal mapping (BLO-15942)", () => {
  // Fixture derived from the real payload shape of Ally's review 4682219268 on
  // Blockcast/trafficcontrol#1115: a COMMENTED, zero-Critical/Important-finding
  // confirmation pass ("No changes requested from this lens"). The old heuristic's
  // bare `changes\s+requested` match fired on that negated phrase and emitted a
  // `## Changes Requested` system comment, bouncing a fully-approved deliverable
  // and deadlocking BLO-15813's review stage (only the mandate-bound reviewer
  // could act on it, and it correctly declined).
  const commentedZeroFindingsReviewPayload = {
    action: "submitted",
    pull_request: {
      number: 1115,
      title: "design(marketplace): location-vocabulary translator",
      head: { ref: "feat/BLO-15022", sha: "f88a7442e43f54b967b400a710bcfe943fc741da" },
    },
    review: {
      body: [
        "## Ally — Consolidated PR Review",
        "",
        "### Critical Issues (0)",
        "None.",
        "",
        "### Important Issues (0)",
        "None. Both of kkroo's blocking findings are correctly resolved in f88a7442e:",
        "",
        "### Recommended Action",
        "Clean. No changes requested from this lens - ready per kkroo's \"merge on full-CI green\" gate.",
      ].join("\n"),
      state: "commented",
      html_url: "https://github.com/Blockcast/trafficcontrol/pull/1115#pullrequestreview-4682219268",
      user: { login: "allyblockcast[bot]" },
    },
    repository: { full_name: "Blockcast/trafficcontrol" },
  };

  it("COMMENTED + zero-finding body maps to a neutral signal, not changes_requested", () => {
    const ctx = __test_resolveEventContext("pull_request_review", commentedZeroFindingsReviewPayload);
    expect(ctx?.reviewState).toBe("commented");
    expect(__test_hasActionablePrReviewFeedback(ctx?.reviewBody, ctx?.reviewState)).toBe(false);
  });

  it("CHANGES_REQUESTED maps to changes_requested even with an otherwise-clean body", () => {
    const ctx = __test_resolveEventContext("pull_request_review", {
      ...commentedZeroFindingsReviewPayload,
      review: { ...commentedZeroFindingsReviewPayload.review, state: "changes_requested" },
    });
    expect(__test_hasActionablePrReviewFeedback(ctx?.reviewBody, ctx?.reviewState)).toBe(true);
  });

  it("APPROVED does not map to changes_requested", () => {
    const ctx = __test_resolveEventContext("pull_request_review", {
      ...commentedZeroFindingsReviewPayload,
      review: {
        ...commentedZeroFindingsReviewPayload.review,
        state: "approved",
        body: "Approved — merge on full-CI green.",
      },
    });
    expect(__test_hasActionablePrReviewFeedback(ctx?.reviewBody, ctx?.reviewState)).toBe(false);
  });
});

describe("PR→issue back-link (BLO-13353)", () => {
  it("builds an absolute issue URL from the public base, prefix, and identifier", () => {
    expect(__test_backLinkAbsoluteUrl("https://paperclip.blockcast.net", "BLO", "BLO-12541")).toBe(
      "https://paperclip.blockcast.net/BLO/issues/BLO-12541",
    );
  });

  it("strips a trailing slash on the public base and falls back to 'company' prefix when blank", () => {
    expect(__test_backLinkAbsoluteUrl("https://paperclip.blockcast.net/", "", "PAP-1")).toBe(
      "https://paperclip.blockcast.net/company/issues/PAP-1",
    );
  });

  it("renders a marked, linked comment body for one issue", () => {
    const body = __test_buildIssueBackLinkBody("https://p.example", [
      { identifier: "BLO-12541", issuePrefix: "BLO" },
    ]);
    expect(body).toContain("<!-- paperclip-issue-backlink -->");
    expect(body).toContain("[BLO-12541](https://p.example/BLO/issues/BLO-12541)");
  });

  it("lists every matched issue when a PR maps to more than one", () => {
    const body = __test_buildIssueBackLinkBody("https://p.example", [
      { identifier: "BLO-1", issuePrefix: "BLO" },
      { identifier: "PAP-2", issuePrefix: "PAP" },
    ]);
    expect(body).toContain("[BLO-1](https://p.example/BLO/issues/BLO-1)");
    expect(body).toContain("[PAP-2](https://p.example/PAP/issues/PAP-2)");
  });

  it("detects the dedup marker so a re-post is suppressed, and ignores unmarked comments", () => {
    const posted = __test_buildIssueBackLinkBody("https://p.example", [
      { identifier: "BLO-1", issuePrefix: "BLO" },
    ]);
    expect(__test_commentsContainBackLinkMarker(["unrelated", posted])).toBe(true);
    expect(__test_commentsContainBackLinkMarker(["just a normal comment", "LGTM"])).toBe(false);
    expect(__test_commentsContainBackLinkMarker([])).toBe(false);
  });
});

describe("self-review non-convergence detection (BLO-13353)", () => {
  const ctx = (prAuthorLogin: string | null) =>
    ({ prAuthorLogin }) as unknown as Parameters<typeof __test_isSelfReviewedPr>[0];

  it("flags a PR authored by the reviewer bot as a self-review (case-insensitive)", () => {
    expect(__test_isSelfReviewedPr(ctx("allyblockcast[bot]"), "allyblockcast[bot]")).toBe(true);
    expect(__test_isSelfReviewedPr(ctx("AllyBlockcast[bot]"), "allyblockcast[bot]")).toBe(true);
  });

  it("does not flag a PR authored by someone other than the reviewer bot", () => {
    expect(__test_isSelfReviewedPr(ctx("some-human"), "allyblockcast[bot]")).toBe(false);
  });

  it("returns false when the author or reviewer-bot login is missing", () => {
    expect(__test_isSelfReviewedPr(ctx(null), "allyblockcast[bot]")).toBe(false);
    expect(__test_isSelfReviewedPr(ctx("allyblockcast[bot]"), null)).toBe(false);
    expect(__test_isSelfReviewedPr(ctx("allyblockcast[bot]"), "")).toBe(false);
  });
});
