/**
 * Auto-retarget wake for stacked children (BLO-36775).
 *
 * On a `delete_branch_on_merge` repo GitHub deletes the merged head branch and
 * auto-retargets every stacked child BEFORE the merged PR's own `closed`
 * delivery can enumerate `?base=<merged head>`. The BLO-29856 fan-out therefore
 * finds zero children and all that is left is a log line that cannot name
 * anyone — measured on `Blockcast/hang-mmt-fec` at ~3.5 firings/day, nearly all
 * of them merges with no stacked children at all.
 *
 * `pull_request.edited` + `changes.base.ref.from` names the child directly and
 * is immune to that race. These are route-level: they drive a signed delivery
 * through the real handler and assert on the `agent_wakeup_requests` row it
 * produces, because the thing under test is the wiring — the parse and directive
 * halves are already unit-covered in `stacked-pr-base-merge.test.ts`.
 *
 * Only the two GitHub reads are mocked. Everything else in `github-app-auth` is
 * the real module, so a stub cannot silently stand in for a code path.
 */
import { randomUUID } from "node:crypto";
import crypto from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  issues,
  issueWorkProducts,
} from "@paperclipai/db";
import { sql } from "drizzle-orm";

const mockResolveMergedBase = vi.hoisted(() => vi.fn());
const mockResolveMergeShape = vi.hoisted(() => vi.fn());
const mockListOpenPrsByBase = vi.hoisted(() => vi.fn());
const mockResolveBranchState = vi.hoisted(() => vi.fn());

vi.mock("../services/github-app-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/github-app-auth.js")>()),
  githubResolveMergedPullRequestForHeadRef: mockResolveMergedBase,
  githubResolveMergeHistoryShape: mockResolveMergeShape,
  githubListOpenPullRequestsByBase: mockListOpenPrsByBase,
  githubResolveBranchState: mockResolveBranchState,
}));

const { githubWebhookRoutes } = await import("../routes/github-webhook.js");
const { errorHandler } = await import("../middleware/index.js");
const { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } = await import(
  "./helpers/embedded-postgres.js"
);

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const REPO = "Blockcast/paperclip";
const CHILD_PR = 2100;
const BASE_PR = 2027;
const OLD_BASE_REF = "se/blo-29856-stacked-pr-base-merge-wake";

describeEmbeddedPostgres("stacked-PR auto-retarget wake", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;
  const webhookSecret = "test-webhook-secret-do-not-use-in-prod";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-stacked-retarget-test-");
    db = createDb(tempDb.connectionString);
  });

  beforeEach(async () => {
    if (!db) return;
    await db.execute(sql.raw(
      `UPDATE "heartbeat_runs" SET status='failed', finished_at=NOW() WHERE status IN ('queued','running')`,
    ));
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
    mockResolveMergedBase.mockReset();
    mockResolveMergeShape.mockReset();
    mockListOpenPrsByBase.mockReset();
    mockResolveBranchState.mockReset();
    // Defaults describe the case this path exists for: the old base WAS merged,
    // and it was merged in the shape that makes a bare retarget wrong.
    mockResolveMergedBase.mockResolvedValue({
      outcome: "found",
      prNumber: BASE_PR,
      mergeCommitSha: "cafebabe",
    });
    mockResolveMergeShape.mockResolvedValue("rewritten");
    // The `closed` fan-out must find nothing unless a test says otherwise —
    // that is the whole premise of a `delete_branch_on_merge` repo.
    mockListOpenPrsByBase.mockResolvedValue({ pullRequests: [], truncated: false });
    mockResolveBranchState.mockResolvedValue("deleted");
  });

  afterAll(async () => {
    await db?.execute(sql.raw(
      `UPDATE "heartbeat_runs" SET status='failed', finished_at=NOW() WHERE status IN ('queued','running')`,
    ));
    await db?.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
    await tempDb?.cleanup();
  });

  function buildApp() {
    const app = express();
    app.use(express.json({
      verify: (req, _res, buf) => {
        (req as unknown as { rawBody: Buffer }).rawBody = buf;
      },
    }));
    app.use("/api/webhooks/github", githubWebhookRoutes(db, {
      webhookSecret,
      resolvePrReviewHeadSha: async () => null,
      runPrCommentReviewGateCheck: async () => ({
        posted: false as const,
        reason: "not_configured" as const,
      }),
      heartbeatOptions: {
        penstockAvailabilityGate: { checkAdapter: async () => ({ allow: true }), _resetForTesting: () => {} },
        skipQueuedRunDispatch: true,
      },
    }));
    app.use(errorHandler);
    return app;
  }

  async function seedCompany() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Test",
      issuePrefix: "BLO",
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
    return { companyId, agentId };
  }

  async function seedIssue(
    companyId: string,
    agentId: string | null,
    identifier: string,
    status = "in_progress",
  ) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: `Issue ${identifier}`,
      status,
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: Number(identifier.split("-")[1]),
      identifier,
    });
    return issueId;
  }

  /**
   * The webhook-written PR work product is the ONLY thing that links a PR back
   * to an issue for this path: the retargeted child's payload carries no
   * Paperclip identifier of its own, which is exactly the real shape.
   */
  async function linkPullRequest(companyId: string, issueId: string, prNumber: number) {
    await db.insert(issueWorkProducts).values({
      companyId,
      issueId,
      type: "pull_request",
      provider: "github",
      externalId: `${REPO}#${prNumber}`,
      title: `PR #${prNumber}`,
      url: `https://github.com/${REPO}/pull/${prNumber}`,
      status: "ready_for_review",
      metadata: { source: "github_pull_request_webhook", headSha: "child-head" },
      sourceTrust: {
        promotedByActorType: "system",
        promotedByActorId: "github_pull_request_webhook",
      },
    });
  }

  function post(app: express.Express, payload: Record<string, unknown>, deliveryId: string) {
    const body = JSON.stringify(payload);
    const signature =
      "sha256=" + crypto.createHmac("sha256", webhookSecret).update(Buffer.from(body, "utf8")).digest("hex");
    return request(app)
      .post("/api/webhooks/github")
      .set("x-github-event", "pull_request")
      .set("x-hub-signature-256", signature)
      .set("x-github-delivery", deliveryId)
      .set("content-type", "application/json")
      .send(body);
  }

  /** `pull_request.edited` as GitHub sends it for an auto-retarget. */
  function retargetPayload(overrides: { changes?: Record<string, unknown> } = {}) {
    return {
      action: "edited",
      // GitHub reports the PREVIOUS base here. `changes.base` is absent on every
      // other kind of edit (title, body), which is what makes it the signal.
      changes: "changes" in overrides
        ? overrides.changes
        : { base: { ref: { from: OLD_BASE_REF }, sha: { from: "0ldbase" } } },
      pull_request: {
        number: CHILD_PR,
        title: "Child PR with no paperclip identifier",
        body: null,
        html_url: `https://github.com/${REPO}/pull/${CHILD_PR}`,
        updated_at: "2026-09-26T10:00:00Z",
        draft: false,
        merged: false,
        base: { ref: "master" },
        head: { ref: "se/child", sha: "child-head" },
      },
      repository: { full_name: REPO },
    };
  }

  async function stackedWakes() {
    const rows = await db.select().from(agentWakeupRequests);
    return rows.filter((row) => row.reason === "github_stacked_pr_base_merged");
  }

  /**
   * Every wake this path ENQUEUED, matched on the idempotency key rather than on
   * `reason`.
   *
   * `reason` is not stable across the heartbeat service: when a run is already
   * queued for the same issue, the second wake is folded into it and the row is
   * rewritten to `reason: "issue_execution_same_name"`, `status: "coalesced"`.
   * That is correct — the agent wakes once and sees both — but it means counting
   * by `reason` reports a suppressed wake and a coalesced one identically, which
   * is precisely the distinction the two tests below exist to make.
   */
  async function stackedWakeKeys() {
    const rows = await db.select().from(agentWakeupRequests);
    return rows
      .map((row) => row.idempotencyKey)
      .filter((key): key is string => Boolean(key?.startsWith("stacked_pr_base_merged:")));
  }

  it("wakes the auto-retargeted child exactly once, naming the old base and demanding a rebase", async () => {
    const { companyId, agentId } = await seedCompany();
    const childIssue = await seedIssue(companyId, agentId, "BLO-36776");
    await linkPullRequest(companyId, childIssue, CHILD_PR);

    const res = await post(buildApp(), retargetPayload(), "retarget-1");
    expect(res.status).toBe(200);

    const wakes = await stackedWakes();
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.agentId).toBe(agentId);
    expect(wakes[0]?.payload).toMatchObject({
      issueId: childIssue,
      prNumber: CHILD_PR,
      mergedBaseRef: OLD_BASE_REF,
      mergedBasePrNumber: BASE_PR,
      mergeHistoryShape: "rewritten",
      detectedVia: "auto_retarget",
    });
    // The deliverable is the wording, not the row: "just retarget" is the trap.
    expect(String(wakes[0]?.payload?.directive)).toMatch(/rebase/i);
    expect(String(wakes[0]?.payload?.directive)).toMatch(/do not simply retarget/i);
    // The shape read must be anchored on the OLD base's merge commit, not on
    // anything in this delivery — the child has not merged.
    expect(mockResolveMergedBase).toHaveBeenCalledWith(
      expect.objectContaining({ repoFullName: REPO, headRef: OLD_BASE_REF }),
    );
    expect(mockResolveMergeShape).toHaveBeenCalledWith(
      expect.objectContaining({ mergeCommitSha: "cafebabe" }),
    );
  });

  it("does not wake on an edit that is not a retarget", async () => {
    // The mutation control for the `changes.base.ref.from` guard: strip that one
    // branch of the payload and this must go silent. A title edit is the common
    // `pull_request.edited` delivery, and waking on it would page an agent on
    // every PR rename in the repo.
    const { companyId, agentId } = await seedCompany();
    const childIssue = await seedIssue(companyId, agentId, "BLO-36777");
    await linkPullRequest(companyId, childIssue, CHILD_PR);

    const res = await post(
      buildApp(),
      retargetPayload({ changes: { title: { from: "Old title" } } }),
      "retarget-title-only",
    );
    expect(res.status).toBe(200);
    expect(await stackedWakes()).toHaveLength(0);
    expect(mockResolveMergedBase).not.toHaveBeenCalled();
  });

  it("does not wake when the old base was never merged", async () => {
    // A human retargeting by hand, or a branch deleted without merging, fires
    // the identical event. Neither orphans anything, and waking on them would
    // rebuild the false-positive rate this path exists to replace.
    mockResolveMergedBase.mockResolvedValue({ outcome: "none" });
    const { companyId, agentId } = await seedCompany();
    const childIssue = await seedIssue(companyId, agentId, "BLO-36778");
    await linkPullRequest(companyId, childIssue, CHILD_PR);

    const res = await post(buildApp(), retargetPayload(), "retarget-unmerged");
    expect(res.status).toBe(200);
    expect(await stackedWakes()).toHaveLength(0);
    expect(mockResolveMergeShape).not.toHaveBeenCalled();
  });

  it("does not wake, and does not break the delivery, when the lookup is unreadable", async () => {
    // Fails closed on the wake and loud in the log. An unreadable read is NOT
    // "nothing merged this branch"; coercing it to a wake would page on every
    // rate-limited delivery.
    mockResolveMergedBase.mockResolvedValue({ outcome: "error", reason: "rate_limited" });
    const { companyId, agentId } = await seedCompany();
    const childIssue = await seedIssue(companyId, agentId, "BLO-36779");
    await linkPullRequest(companyId, childIssue, CHILD_PR);

    const res = await post(buildApp(), retargetPayload(), "retarget-error");
    expect(res.status).toBe(200);
    expect(await stackedWakes()).toHaveLength(0);
  });

  it("refuses to recommend a bare retarget when the old base's merge shape is unreadable", async () => {
    mockResolveMergedBase.mockResolvedValue({
      outcome: "found",
      prNumber: BASE_PR,
      mergeCommitSha: null,
    });
    const { companyId, agentId } = await seedCompany();
    const childIssue = await seedIssue(companyId, agentId, "BLO-36780");
    await linkPullRequest(companyId, childIssue, CHILD_PR);

    const res = await post(buildApp(), retargetPayload(), "retarget-unknown-shape");
    expect(res.status).toBe(200);

    const wakes = await stackedWakes();
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.payload?.mergeHistoryShape).toBe("unknown");
    expect(String(wakes[0]?.payload?.directive)).toMatch(/verify before retargeting/i);
    expect(String(wakes[0]?.payload?.directive)).not.toMatch(/no rebase is required/i);
    // A missing merge commit is not a reason to call GitHub for a commit read.
    expect(mockResolveMergeShape).not.toHaveBeenCalled();
  });

  it("wakes a child reachable by BOTH the base-merge fan-out and the retarget exactly once", async () => {
    // The two paths are not provably exclusive — a branch deleted by hand after
    // the merge delivery lands hits both — and a GitHub redelivery of either is
    // always possible. Dedup is a property of the shared idempotency key, not a
    // coincidence of which path happened to run.
    const { companyId, agentId } = await seedCompany();
    const baseIssue = await seedIssue(companyId, agentId, "BLO-36781");
    const childIssue = await seedIssue(companyId, agentId, "BLO-36782");
    await linkPullRequest(companyId, childIssue, CHILD_PR);
    mockListOpenPrsByBase.mockResolvedValue({
      pullRequests: [
        { number: CHILD_PR, title: "child", url: null, headRef: "se/child" },
      ],
      truncated: false,
    });
    const app = buildApp();

    // 1. The base merges while its head branch still exists: the fan-out finds
    //    the child by `?base=` and wakes it.
    const merged = await post(app, {
      action: "closed",
      pull_request: {
        number: BASE_PR,
        title: `Base ${"BLO-36781"}`,
        body: null,
        html_url: `https://github.com/${REPO}/pull/${BASE_PR}`,
        updated_at: "2026-09-26T09:00:00Z",
        draft: false,
        merged: true,
        merged_at: "2026-09-26T09:00:00Z",
        merge_commit_sha: "cafebabe",
        base: { ref: "master" },
        head: { ref: OLD_BASE_REF, sha: "base-head" },
      },
      repository: { full_name: REPO },
    }, "both-closed");
    expect(merged.status).toBe(200);
    expect(await stackedWakes()).toHaveLength(1);

    // 2. The head branch is then deleted, GitHub auto-retargets the same child
    //    for the same base merge, and the second path must add nothing.
    const retargeted = await post(app, retargetPayload(), "both-edited");
    expect(retargeted.status).toBe(200);

    const wakes = await stackedWakes();
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.payload?.detectedVia).toBe("base_merge_fan_out");
    expect(baseIssue).toBeTruthy();
  });

  it("does not wake a terminal child issue", async () => {
    const { companyId, agentId } = await seedCompany();
    const childIssue = await seedIssue(companyId, agentId, "BLO-36783", "done");
    await linkPullRequest(companyId, childIssue, CHILD_PR);

    const res = await post(buildApp(), retargetPayload(), "retarget-done");
    expect(res.status).toBe(200);
    expect(await stackedWakes()).toHaveLength(0);
  });

  it("ignores a child PR that is not linked to any issue", async () => {
    const { companyId, agentId } = await seedCompany();
    await seedIssue(companyId, agentId, "BLO-36784");

    const res = await post(buildApp(), retargetPayload(), "retarget-unlinked");
    expect(res.status).toBe(200);
    expect(await stackedWakes()).toHaveLength(0);
  });

  /**
   * The idempotency key's two halves, driven through the `pull_request.closed`
   * fan-out (BLO-29856's path, which had no wiring assertion of its own).
   *
   * These are a matched pair on purpose and neither is meaningful alone. A key
   * that never dedups passes the second and fails the first; a key that dedups
   * on too little — dropping the base ref, say, and keying only on the child —
   * passes the first and fails the second, silently swallowing every later
   * orphaning of the same PR. Only both together pin it to "one wake per base
   * merge per child".
   */
  describe("base-merge fan-out wake identity", () => {
    async function seedLinkedChild(identifier: string) {
      const { companyId, agentId } = await seedCompany();
      const childIssue = await seedIssue(companyId, agentId, identifier);
      await linkPullRequest(companyId, childIssue, CHILD_PR);
      mockListOpenPrsByBase.mockResolvedValue({
        pullRequests: [{ number: CHILD_PR, title: "child", url: null, headRef: "se/child" }],
        truncated: false,
      });
      return { app: buildApp(), childIssue, agentId };
    }

    /**
     * `pull_request.closed` + `merged: true` for a base PR on `headRef`.
     *
     * The title carries a Paperclip identifier because a merged base PR in this
     * repo does: without one the delivery is dropped at the
     * `no_paperclip_identifier` gate before the fan-out runs, and a fixture that
     * omitted it would be testing the gate rather than the key.
     */
    function mergedPayload(prNumber: number, headRef: string, identifier: string) {
      return {
        action: "closed",
        pull_request: {
          number: prNumber,
          title: `Base ${identifier}`,
          body: null,
          html_url: `https://github.com/${REPO}/pull/${prNumber}`,
          updated_at: "2026-09-26T09:00:00Z",
          draft: false,
          merged: true,
          merged_at: "2026-09-26T09:00:00Z",
          merge_commit_sha: "cafebabe",
          base: { ref: "master" },
          head: { ref: headRef, sha: "base-head" },
        },
        repository: { full_name: REPO },
      };
    }

    it("wakes once, and a redelivery of the same merge adds nothing", async () => {
      const { app, childIssue, agentId } = await seedLinkedChild("BLO-36785");

      // GitHub redelivers on its own, and an operator can force one. Each
      // arrives with a fresh delivery id, so delivery-scoped dedup does not
      // cover this — only the (issue, PR, base ref) key does.
      const first = mergedPayload(BASE_PR, OLD_BASE_REF, "BLO-36790");
      expect((await post(app, first, "dedup-1")).status).toBe(200);
      expect((await post(app, first, "dedup-2")).status).toBe(200);

      // No SECOND ROW AT ALL — the precheck suppressed the enqueue outright.
      // Contrast the distinct-base case below, which does write a second row.
      expect(await stackedWakeKeys()).toHaveLength(1);
      const wakes = await stackedWakes();
      expect(wakes).toHaveLength(1);
      expect(wakes[0]?.agentId).toBe(agentId);
      expect(wakes[0]?.payload).toMatchObject({ issueId: childIssue, mergedBaseRef: OLD_BASE_REF });
    });

    it("wakes again when a DIFFERENT base merges under the same child", async () => {
      // A stack is deeper than two: the child gets re-based onto grandparent,
      // and that merging orphans it a second time. Suppressing this would make
      // the child silent for every merge after the first.
      const { app, childIssue } = await seedLinkedChild("BLO-36786");

      expect((await post(app, mergedPayload(BASE_PR, OLD_BASE_REF, "BLO-36791"), "distinct-1"))
        .status).toBe(200);
      expect((await post(app, mergedPayload(BASE_PR + 1, "se/another-base", "BLO-36792"), "distinct-2"))
        .status).toBe(200);

      // Two enqueued wakes, keyed apart by the base ref. The second is then
      // coalesced into the run the first queued (see `stackedWakeKeys`), so the
      // agent wakes once holding both — what must NOT happen is the second
      // being suppressed at the precheck, which is what the count pins.
      const keys = await stackedWakeKeys();
      expect(keys).toHaveLength(2);
      expect(new Set(keys)).toEqual(new Set([
        `stacked_pr_base_merged:${childIssue}:${REPO}:${CHILD_PR}:${OLD_BASE_REF}`,
        `stacked_pr_base_merged:${childIssue}:${REPO}:${CHILD_PR}:se/another-base`,
      ]));
    });
  });
});
